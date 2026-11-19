"""拾念 SHINIAN · 「换个说法找记录」固定评测集运行器

自启动隔离服务（随机端口、db/keyword-eval.sqlite）与 fake_model_server.py。
对 scripts/keyword_expansion_eval_cases.json 的每条 case：
- 写记录（每个 case 用完即删，避免 case 间污染）
- 原始关键词 top5
- 固定 oracleExpandedTerms 的扩展检索 top5
- 可选调用 keyword-suggestions 记录耗时/usage（fake 或真实配置）
输出 JSON + Markdown 到 output/keyword-expansion-eval-<stamp>.{json,md}。

本脚本不根据模型输出修改 expectedRelevantIds；排名分数不作为正确率。
"""
import json
import os
import random
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
import http.cookiejar
import uuid
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
TSX = str(ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs")
CASES_PATH = ROOT / "scripts" / "keyword_expansion_eval_cases.json"
OUTPUT_DIR = Path(os.environ.get("SHINIAN_EVAL_OUTPUT_DIR") or (ROOT / "output"))
EVAL_DB = Path(os.environ.get("SHINIAN_EVAL_DB") or (ROOT / "db" / "keyword-eval.sqlite"))
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
MAIN_DB = Path(os.environ.get("SHINIAN_MAIN_DB") or (ROOT / "db" / "shinian.sqlite"))
MAIN_KEY = Path(os.environ.get("SHINIAN_MASTER_KEY_FILE") or (ROOT / "db" / "master.key"))
REAL_MODE = os.environ.get("SHINIAN_REAL_CONFIG") == "1" or os.environ.get("SHINIAN_EVAL_REAL") == "1"
SECRET_KEY = "test-secret-key"
BASE = ""
app_proc = None
app_log = None
fake_proc = None
_cookie_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookie_jar))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.15)
    return False


def start_fake():
    global fake_proc
    if port_open(FAKE_PORT):
        return
    fake_proc = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / "fake_model_server.py")],
        cwd=str(ROOT),
        env={**os.environ, "SHINIAN_FAKE_PORT": str(FAKE_PORT)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port(FAKE_PORT):
        raise RuntimeError("fake model server 未能启动")


def stop_fake():
    global fake_proc
    if fake_proc is None:
        return
    fake_proc.terminate()
    try:
        fake_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        fake_proc.kill()
    fake_proc = None


def start_app(master_key: Path, port: int):
    global app_proc, app_log
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["DATABASE_URL"] = str(EVAL_DB)
    env["SHINIAN_MASTER_KEY_FILE"] = str(master_key)
    env["SHINIAN_AI_TIMEOUT_MS"] = "30000" if REAL_MODE else "1200"
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = "800"
    app_log = open(ROOT / "db" / "keyword-eval-server.log", "ab")
    app_proc = subprocess.Popen(
        [NODE, TSX, str(ROOT / "src" / "server" / "index.ts")],
        cwd=str(ROOT),
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
    )
    if not wait_port(port):
        raise RuntimeError("评测隔离服务未能启动")


def stop_app():
    global app_proc, app_log
    if app_proc is None:
        return
    app_proc.terminate()
    try:
        app_proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        app_proc.kill()
    app_proc = None
    if app_log is not None:
        app_log.close()
        app_log = None


def api(method: str, path: str, body=None, timeout=20):
    import urllib.error

    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"} if data else {"Accept": "application/json"},
    )
    try:
        with _opener.open(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8")
            return res.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return exc.code, raw


def login():
    status, body = api("POST", "/api/session/create", {"username": f"关键词评测-{uuid.uuid4().hex[:6]}"})
    if status != 200:
        raise RuntimeError(f"登录失败 {status} {body}")


def parse_date(value):
    if not value:
        return int(time.time() * 1000)
    try:
        if len(value) == 10:
            dt = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000)


def create_case_records(case):
    """返回 {localId: apiId} 与创建顺序，结束后反向删除。"""
    created = []
    id_map = {}
    captures = {}
    for record in case.get("records") or []:
        if record.get("type") == "capture":
            status, body = api("POST", "/api/captures", {"rawText": record["text"]})
            if status != 200:
                raise RuntimeError(f"创建 capture 失败 {status} {body}")
            cap = body["capture"]
            created.append(("capture", cap["id"]))
            captures[record["localId"]] = cap
            id_map[record["localId"]] = cap["id"]
    for record in case.get("records") or []:
        if record.get("type") != "attempt":
            continue
        parent = captures.get(record.get("captureLocalId"))
        if parent is None:
            status, body = api("POST", "/api/captures", {"rawText": f"{case['id']} 默认念头"})
            parent = body["capture"]
            created.append(("capture", parent["id"]))
            captures[record.get("captureLocalId") or "default"] = parent
        step = record.get("step") or ""
        condition = record.get("condition")
        if condition:
            step = f"{step}（条件：{condition}）"
        attempted = {
            "step": step,
            "state": "done",
            "resultText": record.get("result") or "",
            "outcome": record.get("outcome") or "undetermined",
            "observedAt": parse_date(record.get("date")),
            "operationId": f"eval-{case['id']}-{uuid.uuid4().hex[:8]}",
        }
        status, body = api("POST", f"/api/captures/{parent['id']}/attempts", attempted)
        if status not in (200, 201):
            raise RuntimeError(f"创建 attempt 失败 {status} {body}")
        attempt = body["attempt"]
        created.append(("attempt", attempt["id"]))
        id_map[record["localId"]] = attempt["id"]
    return id_map, created


def delete_records(created):
    for kind, ident in reversed(created):
        api("DELETE", f"/api/{'captures' if kind == 'capture' else 'attempts'}/{ident}")


def search_top5(question, keywords, expanded=None):
    params = {
        "question": question,
        "keywords": " ".join(keywords),
        "limit": "5",
    }
    if expanded:
        params["expanded"] = expanded
    status, body = api(
        "GET",
        "/api/ask/candidates?"
        + urllib.parse.urlencode(params, quote_via=urllib.parse.quote, doseq=True),
    )
    if status != 200:
        return status, body
    candidates = []
    for item in (body or {}).get("candidates") or []:
        candidates.append(
            {
                "id": item.get("id"),
                "sourceKey": item.get("sourceKey"),
                "matchKind": item.get("matchKind"),
                "matchedKeywords": item.get("matchedKeywords") or [],
                "title": item.get("title"),
                "snippet": item.get("snippet"),
            }
        )
    return status, {"total": body.get("total"), "expandedKeywords": body.get("expandedKeywords") or [], "candidates": candidates}


def suggestion_call(case, model_configured: bool):
    started = time.perf_counter()
    status, settings = api("GET", "/api/settings/ai")
    config = (settings or {}).get("config") or {}
    config_version = int(config.get("configVersion") or 1)
    status, body = api(
        "POST",
        "/api/ask/keyword-suggestions",
        {
            "question": case["question"],
            "keywords": case["originalKeywords"],
            "operationId": f"eval-suggest-{case['id']}-{uuid.uuid4().hex[:8]}",
            "configVersion": config_version,
        },
        timeout=60,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if status != 200:
        return {
            "status": status,
            "terms": None,
            "usage": None,
            "durationMs": elapsed_ms,
            "calls": 0 if status in (404, 405) else 1,
            "unverified": True,
            "reason": f"keyword-suggestions 不可用/失败：HTTP {status} {str(body)[:200]}",
        }
    return {
        "status": status,
        "terms": body.get("terms") or [],
        "usage": body.get("usage"),
        "durationMs": body.get("durationMs", elapsed_ms),
        "calls": 1,
        "unverified": False,
        "reason": None,
    }


def term_hits(record, term):
    text = " ".join(
        str(record.get(key) or "")
        for key in ("text", "step", "result", "condition")
    ).lower()
    return term.lower() in text


def evaluate_case(case, suggestion_model_configured: bool):
    id_map, created = create_case_records(case)
    try:
        expected_ids = {id_map[local] for local in case.get("expectedRelevantIds") or [] if local in id_map}
        t0 = time.perf_counter()
        status, original = search_top5(case["question"], case["originalKeywords"])
        original_duration_ms = int((time.perf_counter() - t0) * 1000)
        t1 = time.perf_counter()
        status2, expanded = search_top5(
            case["question"], case["originalKeywords"], case.get("oracleExpandedTerms") or []
        )
        expanded_duration_ms = int((time.perf_counter() - t1) * 1000)
        expanded_effective = bool(
            status2 == 200
            and (
                (expanded or {}).get("expandedKeywords")
                or not (case.get("oracleExpandedTerms") or [])
            )
        )
        orig_candidates = (original or {}).get("candidates") or [] if status == 200 else []
        exp_candidates = (expanded or {}).get("candidates") or [] if status2 == 200 else []
        orig_ids = [item["id"] for item in orig_candidates]
        exp_ids = [item["id"] for item in exp_candidates]
        orig_relevant = [ident for ident in orig_ids if ident in expected_ids]
        exp_relevant = [ident for ident in exp_ids if ident in expected_ids]
        new_irrelevant = [ident for ident in exp_ids if ident not in expected_ids and ident not in orig_ids]
        all_records = case.get("records") or []
        meaning_changing = []
        for term in case.get("oracleExpandedTerms") or []:
            hit_expected = any(term_hits(rec, term) for rec in all_records if id_map.get(rec.get("localId")) in expected_ids)
            hit_other = any(term_hits(rec, term) for rec in all_records if id_map.get(rec.get("localId")) not in expected_ids)
            if hit_other and not hit_expected:
                meaning_changing.append(term)
        suggestion = suggestion_call(case, suggestion_model_configured)

        # 用真实/假模型返回的建议再检索一次，评测“采用建议”的召回效果；
        # oracleExpandedTerms 用于固定评测检索引擎本身。
        model_terms = suggestion.get("terms") if suggestion_model_configured else None
        model_expanded = None
        if isinstance(model_terms, list):
            try:
                model_status, model_expanded = search_top5(
                    case["question"], case["originalKeywords"], model_terms
                )
                model_candidates = (model_expanded or {}).get("candidates") or []
                model_ids = [item["id"] for item in model_candidates]
                model_relevant = [ident for ident in model_ids if ident in expected_ids]
                model_new_irrelevant = [
                    ident for ident in model_ids if ident not in expected_ids and ident not in orig_ids
                ]
                model_meaning_changing = []
                for term in model_terms:
                    hit_expected = any(
                        term_hits(rec, term)
                        for rec in all_records
                        if id_map.get(rec.get("localId")) in expected_ids
                    )
                    hit_other = any(
                        term_hits(rec, term)
                        for rec in all_records
                        if id_map.get(rec.get("localId")) not in expected_ids
                    )
                    if hit_other and not hit_expected:
                        model_meaning_changing.append(term)
                model_suggestion_effect = {
                    "status": model_status,
                    "top5": model_candidates,
                    "relevantHits": len(model_relevant),
                    "improved": len(model_relevant) > len(orig_relevant),
                    "missedExpectedCount": len(expected_ids - set(model_ids)),
                    "newIrrelevantCount": len(model_new_irrelevant),
                    "newIrrelevantIds": model_new_irrelevant,
                    "meaningChangingTerms": model_meaning_changing,
                    "expandedKeywordsEcho": (model_expanded or {}).get("expandedKeywords") or [],
                }
            except Exception as exc:  # noqa: BLE001
                model_suggestion_effect = {"error": repr(exc), "unverified": True}
        else:
            model_suggestion_effect = None

        return {
            "id": case["id"],
            "category": case["category"],
            "question": case["question"],
            "originalKeywords": case["originalKeywords"],
            "oracleExpandedTerms": case.get("oracleExpandedTerms") or [],
            "expectedRelevantIds": sorted(expected_ids),
            "originalStatus": status,
            "expandedStatus": status2,
            "originalDurationMs": original_duration_ms,
            "expandedDurationMs": expanded_duration_ms,
            "originalTop5": orig_candidates,
            "expandedTop5": exp_candidates,
            "originalRelevantHits": len(orig_relevant),
            "expandedRelevantHits": len(exp_relevant),
            "improved": len(exp_relevant) > len(orig_relevant),
            "missedExpectedCount": len(expected_ids - set(exp_ids)),
            "newIrrelevantCount": len(new_irrelevant),
            "newIrrelevantIds": new_irrelevant,
            "meaningChangingTerms": meaning_changing,
            "expandedKeywordsEcho": (expanded or {}).get("expandedKeywords") if status2 == 200 else None,
            "expandedEffective": expanded_effective,
            "modelSuggestion": suggestion,
            "modelSuggestionEffect": model_suggestion_effect,
            "notes": case.get("notes") or "",
            "unverified": status != 200 or status2 != 200 or not expanded_effective,
        }
    finally:
        delete_records(created)


def copy_main_config():
    """把主库授权的 AI 配置复制到隔离库（密文与主密钥保持一致）。"""
    if not MAIN_DB.exists() or not MAIN_KEY.exists():
        return False, "主库或主密钥不存在"
    try:
        with sqlite3.connect(MAIN_DB) as source:
            source.row_factory = sqlite3.Row
            row = source.execute("SELECT * FROM ai_settings LIMIT 1").fetchone()
        if row is None:
            return False, "主库没有已授权 AI 配置"
        with sqlite3.connect(EVAL_DB) as target:
            columns = [item[1] for item in target.execute("PRAGMA table_info(ai_settings)").fetchall()]
            values = [row[column] if column in row.keys() else None for column in columns]
            placeholders = ",".join("?" for _ in columns)
            target.execute(
                f"INSERT OR REPLACE INTO ai_settings ({','.join(columns)}) VALUES ({placeholders})",
                values,
            )
            target.commit()
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, repr(exc)


def main():
    global BASE
    cases_doc = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    cases = cases_doc["cases"]
    if len(cases) < 24:
        raise RuntimeError(f"评测集至少需要 24 条，实际 {len(cases)}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    start_fake()
    port = free_port()
    eval_master = ROOT / "db" / "keyword-eval-master.key"
    for path in (EVAL_DB, Path(str(EVAL_DB) + "-wal"), Path(str(EVAL_DB) + "-shm"), eval_master):
        if path.exists():
            path.unlink()
    real_config_ok = False
    real_config_reason = None
    if REAL_MODE:
        start_app(MAIN_KEY if MAIN_KEY.exists() else eval_master, port)
        BASE = f"http://127.0.0.1:{port}"
        # 先完成迁移，再复制主库配置并重启。
        stop_app()
        real_config_ok, real_config_reason = copy_main_config()
        start_app(MAIN_KEY if MAIN_KEY.exists() else eval_master, port)
    else:
        start_app(eval_master, port)
    BASE = f"http://127.0.0.1:{port}"
    login()
    if REAL_MODE:
        if not real_config_ok:
            suggestion_model_configured = False
        else:
            status, settings = api("GET", "/api/settings/ai")
            suggestion_model_configured = status == 200 and bool((settings or {}).get("configured"))
    else:
        status, _ = api(
            "PUT",
            "/api/settings/ai",
            {
                "name": "关键词评测假模型",
                "baseUrl": f"{FAKE_BASE}/v1",
                "modelId": "fake-suggest-keywords",
                "enabled": True,
                "allowLocal": True,
                "apiKey": SECRET_KEY,
            },
        )
        suggestion_model_configured = status == 200

    started_at = time.time()
    results = []
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']} ({case['category']})")
        try:
            results.append(evaluate_case(case, suggestion_model_configured))
        except Exception as exc:  # noqa: BLE001 - 单条 case 失败要进入报告
            results.append(
                {
                    "id": case.get("id"),
                    "category": case.get("category"),
                    "question": case.get("question"),
                    "error": repr(exc),
                    "unverified": True,
                }
            )

    groups = {}
    for category in ("direct", "paraphrase", "no_relevant", "distractor"):
        group = [item for item in results if item.get("category") == category]
        effects = [item.get("modelSuggestionEffect") or {} for item in group]
        groups[category] = {
            "cases": len(group),
            "improvedCases": sum(1 for item in group if item.get("improved")),
            "originalRelevantHits": sum(item.get("originalRelevantHits", 0) for item in group),
            "expandedRelevantHits": sum(item.get("expandedRelevantHits", 0) for item in group),
            "newIrrelevantCount": sum(item.get("newIrrelevantCount", 0) for item in group),
            "meaningChangingTerms": sorted(
                {term for item in group for term in item.get("meaningChangingTerms") or []}
            ),
            "modelSuggestionImprovedCases": sum(
                1 for item in effects if isinstance(item, dict) and item.get("improved") is True
            ),
            "modelSuggestionRelevantHits": sum(
                int(item.get("relevantHits") or 0)
                for item in effects
                if isinstance(item, dict)
            ),
            "modelSuggestionNewIrrelevantCount": sum(
                int(item.get("newIrrelevantCount") or 0)
                for item in effects
                if isinstance(item, dict)
            ),
            "modelSuggestionMeaningChangingTerms": sorted(
                {
                    term
                    for item in effects
                    if isinstance(item, dict)
                    for term in item.get("meaningChangingTerms") or []
                }
            ),
            "unverifiedCases": sum(1 for item in group if item.get("unverified")),
        }
    unverified = (
        not suggestion_model_configured
        or any(item.get("unverified") for item in results)
        or any((item.get("modelSuggestion") or {}).get("unverified") for item in results)
    )
    report = {
        "schema": "keyword-expansion-eval-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "real" if REAL_MODE else "fake",
        "casesFile": str(CASES_PATH),
        "caseCount": len(cases),
        "unverified": unverified,
        "unverifiedReasons": [
            reason
            for reason in [
                None if suggestion_model_configured else ("真实配置不可用：" + (real_config_reason or "未配置")),
                None if all(item.get("originalStatus") == 200 for item in results if "originalStatus" in item) else "candidates 原检索不可用",
                None if all(item.get("expandedEffective") for item in results if "expandedEffective" in item) else "candidates expanded 参数未生效或不可用",
            ]
            if reason
        ],
        "note": "固定 expectedRelevantIds；不将排名分数当正确率；oracleExpandedTerms 为人工替代表达。",
        "groups": groups,
        "cases": results,
        "elapsedSeconds": round(time.time() - started_at, 2),
    }
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = OUTPUT_DIR / f"keyword-expansion-eval-{stamp}.json"
    md_path = OUTPUT_DIR / f"keyword-expansion-eval-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# 「换个说法找记录」固定评测报告",
        "",
        f"- 生成时间：{report['generatedAt']}",
        f"- 模式：{report['mode']}；案例数：{len(cases)}",
        f"- unverified：{str(unverified).lower()}",
        f"- 说明：{report['note']}；「模型建议效果」是用模型返回的 terms 重新检索后的结果。",
        "",
        "| 分组 | 案例 | Oracle 改善 | 原检索相关命中 | Oracle 扩展后相关命中 | Oracle 新增无关 | 模型建议改善 | 模型建议相关命中 | 模型新增无关 | 模型改变原意 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for category, group in groups.items():
        lines.append(
            f"| {category} | {group['cases']} | {group['improvedCases']} | {group['originalRelevantHits']} | "
            f"{group['expandedRelevantHits']} | {group['newIrrelevantCount']} | "
            f"{group['modelSuggestionImprovedCases']} | {group['modelSuggestionRelevantHits']} | "
            f"{group['modelSuggestionNewIrrelevantCount']} | "
            f"{'、'.join(group['modelSuggestionMeaningChangingTerms']) or '无'} |"
        )
    lines.extend(["", "## 逐条结果", ""])
    for item in results:
        if item.get("error"):
            lines.append(f"- `{item['id']}` ERROR {item['error']}")
            continue
        effect = item.get("modelSuggestionEffect") or {}
        effect_text = (
            f"；模型 {effect.get('relevantHits')} → 改善 {str(effect.get('improved')).lower()}；"
            f"模型新增无关 {effect.get('newIrrelevantCount')}；模型改变原意："
            f"{'、'.join(effect.get('meaningChangingTerms') or []) or '无'}"
            if isinstance(effect, dict) and effect.get("status") is not None
            else ""
        )
        lines.append(
            f"- `{item['id']}` [{item['category']}] 原 {item['originalRelevantHits']} → Oracle 扩展 "
            f"{item['expandedRelevantHits']}；新增无关 {item['newIrrelevantCount']}；"
            f"改变原意：{'、'.join(item['meaningChangingTerms']) or '无'}{effect_text}"
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(md_path), "unverified": unverified}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR 关键词评测失败：{exc}")
        traceback.print_exc()
    finally:
        try:
            if BASE:
                api("DELETE", "/api/settings/ai")
        except Exception:  # noqa: BLE001
            pass
        stop_app()
        stop_fake()
    sys.exit(exit_code)
