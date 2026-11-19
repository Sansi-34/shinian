"""拾念 SHINIAN · 研究一下（GitHub 开源项目调研）验收测试

对运行中的测试服务（SHINIAN_BASE，默认 http://127.0.0.1:3100）执行：
- GitHub 固定响应：正常/限流/超时/404/认证失败/空结果/非法 JSON/部分仓库失败
- 研究发起预览、确认、幂等创建、取消、刷新、重试
- 来源 URL/获取时间/仓库/路径/分支/sha/摘录、缺失标注、许可证未知
- 模型真实调用（fake-research-*）：正常对比、来源不足、编造来源被拒绝
- 小实验采用：版本检查、幂等、重复采用同一尝试
- 保存/重开/删除研究的关联规则、导出 schemaVersion 6
- 外部 README 恶意指令不扩大权限、Token 不进入模型请求

脚本自行启动/停止 scripts/fake_github_server.py（3510）与 fake_model_server.py（3501）。
"""
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
GH_PORT = int(os.environ.get("SHINIAN_FAKE_GITHUB_PORT", "3510"))
GH_BASE = f"http://127.0.0.1:{GH_PORT}"
MODEL_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
MODEL_BASE = f"http://127.0.0.1:{MODEL_PORT}"
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test.sqlite")

client = Client(base=BASE)
c = Checker()
uid = uuid.uuid4().hex[:8]
gh_proc = None
model_proc = None


# ---------------------------------------------------------------- 进程与工具
def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_health(base: str, service: str, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/__health", timeout=1) as res:
                data = json.loads(res.read().decode())
                if data.get("service") == service:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def start_servers():
    global gh_proc, model_proc
    if not port_open(GH_PORT):
        gh_proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "scripts", "fake_github_server.py")],
            cwd=ROOT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if not port_open(MODEL_PORT):
        model_proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "scripts", "fake_model_server.py")],
            cwd=ROOT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    assert wait_health(GH_BASE, "shinian-fake-github"), "fake github 未启动"
    assert wait_health(MODEL_BASE, "shinian-fake-model"), "fake model 未启动"


def stop_servers():
    for proc in (gh_proc, model_proc):
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


def gh_requests():
    with urllib.request.urlopen(f"{GH_BASE}/__requests", timeout=5) as res:
        return json.loads(res.read().decode())["requests"]


def model_last():
    with urllib.request.urlopen(f"{MODEL_BASE}/__last", timeout=5) as res:
        return json.loads(res.read().decode())["request"]


def configure_ai(model="fake-research-success", api_key="fake-key"):
    payload = {
        "name": "研究测试模型",
        "baseUrl": f"{MODEL_BASE}/v1",
        "modelId": model,
        "apiKey": api_key,
        "enabled": True,
        "allowLocal": True,
    }
    st, res = client.request("PUT", "/api/settings/ai", payload)
    assert st == 200, (st, res)
    return res


def create_capture(text: str):
    st, res = client.post("/api/captures", {"rawText": text})
    assert st == 200, (st, res)
    return res["capture"]


def error_code(body):
    return (body or {}).get("research", {}).get("errorCode") or (body or {}).get("error")


def preview(capture, question=None, search=None, constraints=None):
    st, res = client.post(
        f"/api/captures/{capture['id']}/research/preview",
        {
            "captureRevision": capture["revision"],
            "question": question if question is not None else capture["rawText"],
            "constraints": constraints or {},
            "search": search or {"mode": "keyword", "query": "offline wake word"},
        },
    )
    assert st == 200, (st, res)
    return res


def start_research(capture, prev, operation_id=None):
    return client.post(
        f"/api/captures/{capture['id']}/research",
        {
            "captureRevision": prev["capture"]["revision"],
            "question": prev["question"],
            "constraints": prev["constraints"],
            "search": prev["search"],
            "contextToken": prev["contextToken"],
            "operationId": operation_id or f"op-research-{uuid.uuid4().hex}",
        },
    )


def wait_status(research_id, statuses, timeout=25.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        st, res = client.get(f"/api/research/{research_id}")
        assert st == 200, (st, res)
        last = res["research"]
        if last["status"] in statuses:
            return last
        time.sleep(0.25)
    raise AssertionError(f"研究未进入状态 {statuses}，最后一次：{last and last['status']} {last and last.get('errorCode')}")


def select(research_id, ids):
    return client.post(f"/api/research/{research_id}/select", {"candidateIds": ids})


# ---------------------------------------------------------------- 测试
def test_settings_and_token():
    client.delete("/api/settings/github")
    st, res = client.get("/api/settings/github")
    c.check("读取 GitHub 设置", st == 200 and res["hasToken"] is False, f"{st} {res}")
    c.check("固定官方/测试 API 基址", res.get("apiBase") == GH_BASE, str(res.get("apiBase")))

    token = f"ghp_fake_{uid}_abcdefghij"
    st, res = client.request("PUT", "/api/settings/github", {"token": token})
    c.check("保存 GitHub Token", st == 200 and res["hasToken"] is True, f"{st} {res}")

    st, res = client.post("/api/settings/github/test", {})
    c.check(
        "测试 Token 返回账号与额度",
        st == 200 and res["login"] == "fake-octocat" and isinstance(res["rate"]["remaining"], int),
        f"{st} {res}",
    )

    try:
        with sqlite3.connect(TEST_DB, timeout=10) as conn:
            row = conn.execute("SELECT token_ciphertext FROM github_settings WHERE id='default'").fetchone()
        encrypted = row[0] if row else ""
    except Exception as exc:  # noqa: BLE001
        encrypted = f"ERR {exc}"
    c.check("Token 加密保存且不落明文", token not in str(encrypted) and str(encrypted).startswith("v1."), str(encrypted)[:40])

    st, res = client.delete("/api/settings/github")
    c.check("清除 Token", st == 200 and res["hasToken"] is False, f"{st} {res}")

    cap = create_capture(f"匿名读取测试 {uid}")
    prev = preview(cap, search={"mode": "repositories", "repos": ["octo/archived-demo"]})
    c.check("匿名读取时预览标注无 Token", prev["github"]["hasToken"] is False, str(prev["github"]))
    st, created = start_research(cap, prev)
    c.check("匿名读取启动研究", st == 202, f"{st} {created}")
    run = wait_status(created["research"]["id"], {"candidates", "failed"})
    c.check("匿名读取仓库成功", run["status"] == "candidates" and len(run["candidates"]) == 1, f"{run['status']} {run.get('errorCode')}")

    # 恢复 Token 供后续断言「Token 只发送给 GitHub」
    client.request("PUT", "/api/settings/github", {"token": token})


def test_preview_and_validation():
    cap = create_capture(f"研究预览测试 {uid}")
    prev = preview(
        cap,
        question="想在本机做离线语音唤醒，哪个仓库最合适？",
        constraints={
            "goal": "离线语音唤醒",
            "environment": "Windows 11 / RTX 5060",
            "language": "Python",
            "timeBudget": "周末 4 小时",
            "requirements": "不依赖云端 API",
        },
    )
    c.check("预览返回研究问题", prev["question"].startswith("想在本机"), prev["question"])
    c.check("预览返回限制", prev["constraints"]["environment"].startswith("Windows"), str(prev["constraints"]))
    c.check("预览显示 GitHub 检索词", "GitHub 搜索：" in prev["searchDisplay"], prev["searchDisplay"])
    c.check(
        "预览显示数量限制",
        prev["limits"]["maxCandidates"] == 10 and prev["limits"]["maxSelected"] == 3,
        str(prev["limits"]),
    )
    c.check("预览返回 contextToken", isinstance(prev["contextToken"], str) and len(prev["contextToken"]) > 20, "missing")

    st, res = client.post(
        f"/api/captures/{cap['id']}/research/preview",
        {
            "captureRevision": cap["revision"],
            "question": "x",
            "constraints": {},
            "search": {"mode": "repositories", "repos": ["https://example.com/evil/repo"]},
        },
    )
    c.check("拒绝非 GitHub 仓库地址", st == 400 and res.get("field") == "repos", f"{st} {res}")

    st, res = client.post(
        f"/api/captures/{cap['id']}/research/preview",
        {
            "captureRevision": cap["revision"],
            "question": "x",
            "constraints": {},
            "search": {"mode": "keyword", "query": ""},
        },
    )
    c.check("拒绝空检索词", st == 400, f"{st} {res}")

    prev2 = preview(cap)
    st, res = client.post(
        f"/api/captures/{cap['id']}/research",
        {
            "captureRevision": prev2["capture"]["revision"],
            "question": prev2["question"],
            "constraints": prev2["constraints"],
            "search": prev2["search"],
            "contextToken": "wrong-token",
            "operationId": f"op-bad-{uid}",
        },
    )
    c.check("拒绝错误的预览令牌", st == 409 and res.get("error") == "context_changed", f"{st} {res}")

    op = f"op-idem-{uid}"
    st1, first = start_research(cap, prev2, op)
    st2, second = start_research(cap, prev2, op)
    c.check("重复 operationId 返回同一研究", st1 == 202 and st2 == 200 and first["research"]["id"] == second["research"]["id"], f"{st1}/{st2} {second}")
    c.check("重复请求标记 replayed", second.get("replayed") is True, str(second.get("replayed")))
    wait_status(first["research"]["id"], {"candidates", "failed"})


def test_main_flow():
    cap = create_capture(f"离线语音唤醒研究 {uid}")
    prev = preview(cap, search={"mode": "keyword", "query": "offline wake word"})
    st, created = start_research(cap, prev)
    c.check("发起关键词研究", st == 202, f"{st} {created}")
    run_id = created["research"]["id"]
    run = wait_status(run_id, {"candidates"})
    c.check("候选最多 10 个", len(run["candidates"]) <= 10, str(len(run["candidates"])))
    by_name = {item["fullName"]: item for item in run["candidates"]}
    c.check("候选包含归档状态", by_name.get("octo/archived-demo", {}).get("archived") is True, str(by_name.get("octo/archived-demo")))
    c.check("候选包含主要语言", by_name.get("octo/archived-demo", {}).get("language") == "Python", str(by_name.get("octo/archived-demo")))
    c.check("候选包含许可证检测", by_name.get("octo/no-license-demo", {}).get("license") is None, str(by_name.get("octo/no-license-demo")))
    c.check("候选包含取得时间", isinstance(run["candidatesFetchedAt"], int), str(run["candidatesFetchedAt"]))
    c.check("候选包含推送/更新字段", by_name.get("octo/archived-demo", {}).get("pushedAt") == "2024-03-02T10:00:00Z", str(by_name.get("octo/archived-demo", {}).get("pushedAt")))

    ids = ["octo/archived-demo", "octo/no-license-demo", "octo/noreadme-demo"]
    st, res = select(run_id, ids)
    c.check("选择 3 个候选", st == 202, f"{st} {res}")
    run = wait_status(run_id, {"succeeded", "failed"}, timeout=30)
    c.check("研究生成成功", run["status"] == "succeeded", f"{run['status']} {run.get('errorCode')} {run.get('errorDetail')}")
    c.check("保存了 3 个仓库的资料", len({s['repoFullName'] for s in run["sources"]}) == 3, str(len(run["sources"])))
    kinds = {s["kind"] for s in run["sources"]}
    c.check("资料覆盖元数据/README/许可证/发布", kinds == {"repo_meta", "readme", "license", "releases"}, str(kinds))
    readme = [s for s in run["sources"] if s["repoFullName"] == "octo/archived-demo" and s["kind"] == "readme"][0]
    c.check("README 来源 URL", readme["url"].startswith("https://github.com/octo/archived-demo"), readme["url"])
    c.check("README 来源获取时间", isinstance(readme["fetchedAt"], int), str(readme["fetchedAt"]))
    c.check("README 文件路径与分支", readme["filePath"] == "README.md" and readme["refName"] == "main", f"{readme['filePath']}/{readme['refName']}")
    c.check("README 文件 sha", (readme["commitSha"] or "").startswith("readme-sha-"), str(readme["commitSha"]))
    c.check("README 摘录长度受限", len(readme["excerpt"]) <= 4200, str(len(readme["excerpt"])))
    license_missing = [s for s in run["sources"] if s["repoFullName"] == "octo/no-license-demo" and s["kind"] == "license"][0]
    c.check("无许可证明确标注", license_missing["status"] == "missing" and "未检测到" in license_missing["excerpt"], str(license_missing)[:200])
    readme_missing = [s for s in run["sources"] if s["repoFullName"] == "octo/noreadme-demo" and s["kind"] == "readme"][0]
    c.check("无 README 明确标注", readme_missing["status"] == "missing" and "404" in (readme_missing["errorDetail"] or ""), str(readme_missing)[:160])

    result = run["result"]
    c.check("对比覆盖所选仓库", len(result["projects"]) == 3, str(len(result["projects"])))
    c.check("对比含小实验", len(result["experiments"]) >= 1, str(len(result["experiments"])))
    c.check("模型用量已记录", run["usage"] and run["usage"]["totalTokens"] > 0, str(run["usage"]))
    c.check("模型配置快照", run["config"]["modelId"] == "fake-research-success", str(run["config"]))
    c.check("实际用量含 GitHub 请求统计", run["stats"] and run["stats"]["github"]["requests"] >= 13, str(run["stats"]))
    valid_sources = set(run["sentSourceIds"])
    cited = set()
    for project in result["projects"]:
        for citation in project["matches"] + project["gaps"]:
            cited.update(citation["sourceIds"])
    for experiment in result["experiments"]:
        cited.update(experiment["sourceIds"])
    c.check("模型引用均属于本次实际发送资料", cited <= valid_sources and len(cited) > 0, f"{sorted(cited)} vs {sorted(valid_sources)}")

    # 保存与重开
    st, res = client.post(f"/api/research/{run_id}/save", {})
    c.check("保存研究", st == 200 and res["savedAt"] > 0, f"{st} {res}")
    st, res = client.get(f"/api/research/{run_id}")
    c.check("重开研究保持来源", len(res["research"]["sources"]) == len(run["sources"]), str(len(res["research"]["sources"])))
    st, res = client.get("/api/research?saved=1&limit=20")
    c.check("已保存研究出现在列表", any(item["id"] == run_id for item in res["research"]), str(len(res["research"])))

    # 采用小实验（编辑版）
    exp = result["experiments"][0]
    op = f"op-accept-{uid}"
    st, res = client.post(
        f"/api/research/{run_id}/experiments/0/accept",
        {
            "title": f"编辑后的实验：{exp['title']}"[:120],
            "description": "先跑仓库最小示例，记录安装耗时和第一个报错。",
            "estimatedMinutes": 20,
            "expectedRevision": run["revision"],
            "operationId": op,
        },
    )
    c.check("采用小实验创建尝试", st in (200, 201) and res["attempt"]["origin"] == "research_experiment", f"{st} {res}")
    attempt_id = res["attempt"]["id"]
    st, again = client.post(
        f"/api/research/{run_id}/experiments/0/accept",
        {
            "title": f"编辑后的实验：{exp['title']}"[:120],
            "description": "先跑仓库最小示例，记录安装耗时和第一个报错。",
            "estimatedMinutes": 20,
            "expectedRevision": run["revision"],
            "operationId": op,
        },
    )
    c.check("重复采用返回同一尝试", again["attempt"]["id"] == attempt_id and again["replayed"] is True, str(again))
    st, third = client.post(
        f"/api/research/{run_id}/experiments/0/accept",
        {
            "title": "另一个标题",
            "description": "另一次采用",
            "estimatedMinutes": 30,
            "expectedRevision": run["revision"],
            "operationId": f"op-accept-b-{uid}",
        },
    )
    c.check("同一建议重复采用仍返回同一尝试", third["attempt"]["id"] == attempt_id, str(third))

    st, stale_body = client.post(
        f"/api/research/{run_id}/experiments/1/accept",
        {
            "title": "过期版本采用",
            "description": "x",
            "estimatedMinutes": 10,
            "expectedRevision": run["revision"] - 1,
            "operationId": f"op-stale-{uid}",
        },
    )
    c.check("采用前检查研究版本", st == 409 and stale_body.get("error") == "version_conflict", f"{st} {stale_body}")

    st, attempt_research = client.get(f"/api/attempts/{attempt_id}/research")
    c.check(
        "尝试关联来源研究",
        st == 200
        and attempt_research["research"]["exists"] is True
        and attempt_research["research"]["suggestion"]["sourceIds"],
        str(attempt_research)[:300],
    )
    st, attempt_detail = client.get(f"/api/attempts/{attempt_id}")
    c.check("尝试详情保留采用内容", attempt_detail["attempt"]["researchSuggestedJson"] is not None, str(attempt_detail["attempt"].keys()))

    return run_id, attempt_id


def test_rate_limit_and_errors():
    # 限流
    cap = create_capture(f"限流测试 {uid}")
    prev = preview(cap, search={"mode": "keyword", "query": "rate-limit-test"})
    st, created = start_research(cap, prev)
    run = wait_status(created["research"]["id"], {"failed"})
    c.check("限流错误码准确", run["errorCode"] == "rate_limited", str(run["errorCode"]))
    c.check("限流原因含额度", "额度" in (run["errorDetail"] or ""), run["errorDetail"])
    c.check("限流记录重置时间", isinstance(run["candidateFailures"][0]["resetAt"], int), str(run["candidateFailures"]))
    c.check("限流后无候选可重试检索", run["canRetrySearch"] is True, str(run["canRetrySearch"]))

    # 空结果
    cap2 = create_capture(f"空结果测试 {uid}")
    prev2 = preview(cap2, search={"mode": "keyword", "query": "empty-test"})
    st, created2 = start_research(cap2, prev2)
    run2 = wait_status(created2["research"]["id"], {"failed"})
    c.check("空结果错误码", run2["errorCode"] == "no_candidates", str(run2["errorCode"]))

    # 超时
    cap3 = create_capture(f"超时测试 {uid}")
    prev3 = preview(cap3, search={"mode": "keyword", "query": "timeout-test"})
    st, created3 = start_research(cap3, prev3)
    run3 = wait_status(created3["research"]["id"], {"failed"}, timeout=12)
    c.check("GitHub 超时归类", run3["errorCode"] == "timeout", str(run3["errorCode"]))

    # 非法 JSON
    cap4 = create_capture(f"非法响应测试 {uid}")
    prev4 = preview(cap4, search={"mode": "keyword", "query": "broken-json-test"})
    st, created4 = start_research(cap4, prev4)
    run4 = wait_status(created4["research"]["id"], {"failed"})
    c.check("非法 JSON 归类", run4["errorCode"] == "invalid_response", str(run4["errorCode"]))

    # 认证失败
    cap5 = create_capture(f"认证失败测试 {uid}")
    prev5 = preview(cap5, search={"mode": "keyword", "query": "auth-test"})
    st, created5 = start_research(cap5, prev5)
    run5 = wait_status(created5["research"]["id"], {"failed"})
    c.check("GitHub 认证失败归类", run5["errorCode"] == "auth", str(run5["errorCode"]))

    # 404 仓库
    cap6 = create_capture(f"404 仓库测试 {uid}")
    prev6 = preview(cap6, search={"mode": "repositories", "repos": ["octo/notfound-demo"]})
    st, created6 = start_research(cap6, prev6)
    run6 = wait_status(created6["research"]["id"], {"failed"})
    c.check("404 仓库错误归类", run6["errorCode"] == "not_found", str(run6["errorCode"]))


def test_partial_failure_and_cancel():
    cap = create_capture(f"部分失败测试 {uid}")
    prev = preview(
        cap,
        search={"mode": "repositories", "repos": ["octo/archived-demo", "octo/notfound-demo", "octo/partial-fail-demo"]},
    )
    st, created = start_research(cap, prev)
    run_id = created["research"]["id"]
    wait_status(run_id, {"candidates"})
    st, res = select(run_id, ["octo/archived-demo", "octo/partial-fail-demo"])
    c.check("选择可用候选（跳过候选阶段失败仓库）", st == 202, f"{st} {res}")
    run = wait_status(run_id, {"succeeded", "failed"}, timeout=30)
    c.check("部分失败仍保留有效资料并生成", run["status"] == "succeeded", f"{run['status']} {run['errorCode']}")
    c.check("候选阶段失败仓库被记录", any(item["fullName"] == "octo/notfound-demo" for item in run["candidateFailures"]), str(run["candidateFailures"]))
    c.check("部分失败仓库保留其他资料", any(s["repoFullName"] == "octo/partial-fail-demo" and s["kind"] == "repo_meta" and s["status"] == "ok" for s in run["sources"]), "missing meta")
    c.check("部分失败 README 标注缺失", any(s["repoFullName"] == "octo/partial-fail-demo" and s["kind"] == "readme" and s["status"] == "missing" for s in run["sources"]), "readme not missing")
    c.check("部分失败后仍可重试失败资料", run["canRetryFetch"] is True, str(run["canRetryFetch"]))

    before = len(run["sources"])
    st, res = client.post(
        f"/api/research/{run_id}/retry",
        {"action": "fetch", "repoIds": ["octo/partial-fail-demo"]},
    )
    c.check("重试部分失败仓库", st == 202, f"{st} {res}")
    run2 = wait_status(run_id, {"succeeded", "failed"}, timeout=30)
    c.check(
        "重试后保留已取得资料",
        len(run2["sources"]) >= before and run2["status"] == "succeeded",
        f"{run2['status']} {len(run2['sources'])}",
    )

    # 取消：搜索超时后立即取消，迟到响应不得重新激活
    cap2 = create_capture(f"取消测试 {uid}")
    prev2 = preview(cap2, search={"mode": "keyword", "query": "timeout-test"})
    st, created2 = start_research(cap2, prev2)
    run_id2 = created2["research"]["id"]
    time.sleep(0.15)
    st, res = client.post(f"/api/research/{run_id2}/cancel", {})
    c.check("取消研究", st == 200 and res["research"]["status"] == "cancelled", f"{st} {res}")
    time.sleep(2.0)
    st, res = client.get(f"/api/research/{run_id2}")
    c.check("迟到响应不会重新激活取消任务", res["research"]["status"] == "cancelled", res["research"]["status"])
    c.check("取消后无新资料来源", len(res["research"]["sources"]) == 0, str(len(res["research"]["sources"])))


def test_model_failures_and_untrusted():
    # 模型编造来源
    configure_ai("fake-research-bad-source")
    cap = create_capture(f"编造来源测试 {uid}")
    prev = preview(cap, search={"mode": "repositories", "repos": ["octo/archived-demo"]})
    st, created = start_research(cap, prev)
    run_id = created["research"]["id"]
    wait_status(run_id, {"candidates"})
    select(run_id, ["octo/archived-demo"])
    run = wait_status(run_id, {"failed"}, timeout=30)
    c.check("编造来源被服务端拒绝", run["errorCode"] == "ai_failed" and "未发送" in (run["errorDetail"] or ""), f"{run['errorCode']} {run['errorDetail']}")
    c.check("生成失败仍保留来源", len(run["sources"]) >= 3, str(len(run["sources"])))
    c.check("生成失败可重试生成", run["canRetryGenerate"] is True, str(run["canRetryGenerate"]))

    # 来源不足
    configure_ai("fake-research-insufficient")
    cap2 = create_capture(f"资料不足测试 {uid}")
    prev2 = preview(cap2, search={"mode": "repositories", "repos": ["octo/noreadme-demo"]})
    st, created2 = start_research(cap2, prev2)
    run2_id = created2["research"]["id"]
    wait_status(run2_id, {"candidates"})
    select(run2_id, ["octo/noreadme-demo"])
    run2 = wait_status(run2_id, {"succeeded", "failed"}, timeout=30)
    c.check("资料不足允许暂时无法判断", run2["status"] == "succeeded" and run2["result"]["insufficient"] is True, f"{run2['status']} {run2.get('result')}")

    # 恶意 README：只作为不可信资料进入模型，不扩大权限
    configure_ai("fake-research-success")
    start_index = len(gh_requests())
    cap3 = create_capture(f"恶意 README 测试 {uid}")
    prev3 = preview(cap3, search={"mode": "repositories", "repos": ["octo/inject-demo"]})
    st, created3 = start_research(cap3, prev3)
    run3_id = created3["research"]["id"]
    wait_status(run3_id, {"candidates"})
    select(run3_id, ["octo/inject-demo"])
    run3 = wait_status(run3_id, {"succeeded", "failed"}, timeout=30)
    c.check("恶意 README 不影响研究完成", run3["status"] == "succeeded", f"{run3['status']} {run3['errorCode']}")
    readme3 = [s for s in run3["sources"] if s["kind"] == "readme"][0]
    c.check("恶意指令按外部资料保存", "SYSTEM INSTRUCTION" in readme3["excerpt"], readme3["excerpt"][:80])
    c.check("模型输出未执行恶意指令", "APPROVED" not in json.dumps(run3["result"], ensure_ascii=False), json.dumps(run3["result"], ensure_ascii=False)[:200])

    last = model_last()
    system_text = "\n".join(
        str(m.get("content")) for m in (last.get("body") or {}).get("messages") or [] if m.get("role") == "system"
    )
    c.check("系统提示把资料标记为不可信", "不可信" in system_text, system_text[:80])
    auth_header = {str(k).lower(): str(v) for k, v in (last.get("headers") or {}).items()}.get("authorization", "")
    c.check("GitHub Token 未发送给模型", "ghp_fake" not in auth_header and "ghp_fake" not in json.dumps(last["body"], ensure_ascii=False), auth_header[:60])
    c.check("模型请求只带模型密钥", auth_header.startswith("Bearer fake-key"), auth_header[:40])

    new_requests = gh_requests()[start_index:]
    allowed = all(r["path"].startswith("/repos/") or r["path"] == "/__requests" for r in new_requests)
    c.check("外部资料不能发起任意网络请求", allowed, str([r["path"] for r in new_requests])[:160])

    # AI 未配置：资料仍可查看，重试生成可成功
    client.delete("/api/settings/ai")
    cap4 = create_capture(f"无模型资料测试 {uid}")
    prev4 = preview(cap4, search={"mode": "repositories", "repos": ["octo/archived-demo"]})
    st, created4 = start_research(cap4, prev4)
    run4_id = created4["research"]["id"]
    wait_status(run4_id, {"candidates"})
    select(run4_id, ["octo/archived-demo"])
    run4 = wait_status(run4_id, {"failed"}, timeout=25)
    c.check("无模型时明确提示", run4["errorCode"] == "ai_not_configured", str(run4["errorCode"]))
    c.check("无模型时资料仍可查看", len(run4["sources"]) >= 3, str(len(run4["sources"])))
    c.check("无模型时可稍后重试生成", run4["canRetryGenerate"] is True, str(run4["canRetryGenerate"]))
    configure_ai("fake-research-success")
    st, res = client.post(f"/api/research/{run4_id}/retry", {"action": "generate", "repoIds": []})
    c.check("配置模型后重试生成", st == 202, f"{st} {res}")
    run4b = wait_status(run4_id, {"succeeded", "failed"}, timeout=30)
    c.check("重试后生成成功", run4b["status"] == "succeeded", f"{run4b['status']} {run4b.get('errorDetail')}")


def test_delete_and_export(saved_run_id, adopted_attempt_id):
    # 删除研究：尝试保留，来源标记已删除
    st, res = client.delete(f"/api/research/{saved_run_id}")
    c.check("删除研究", st == 200 and res["keptAttempts"] >= 1, f"{st} {res}")
    st, res = client.get(f"/api/research/{saved_run_id}")
    c.check("研究删除后不可打开", st == 404, f"{st} {res}")
    st, res = client.get(f"/api/attempts/{adopted_attempt_id}/research")
    c.check(
        "来源研究删除后尝试仍保留采用内容",
        st == 200 and res["research"]["deleted"] is True and res["research"]["suggestion"]["sourceIds"],
        str(res)[:300],
    )
    st, res = client.get(f"/api/attempts/{adopted_attempt_id}")
    c.check("尝试本身仍在", st == 200 and res["attempt"]["id"] == adopted_attempt_id, str(st))

    # 删除念头：研究级联删除
    cap = create_capture(f"删除念头研究测试 {uid}")
    prev = preview(cap, search={"mode": "repositories", "repos": ["octo/noreadme-demo"]})
    st, created = start_research(cap, prev)
    run_id = created["research"]["id"]
    wait_status(run_id, {"candidates"})
    st, preview_del = client.get(f"/api/captures/{cap['id']}/delete-preview")
    c.check("删除预览含研究数量", preview_del.get("researchCount", 0) >= 1, str(preview_del))
    st, res = client.delete(f"/api/captures/{cap['id']}")
    c.check("删除念头", st == 200, f"{st} {res}")
    st, res = client.get(f"/api/research/{run_id}")
    c.check("念头删除后研究级联删除", st == 404, f"{st} {res}")

    # 导出 schemaVersion 4 与新增数据
    st, res = client.get("/api/export")
    c.check("导出成功", st == 200, str(st))
    c.check("导出 schemaVersion>=6（v0.6 经验/主题导出）", res.get("schemaVersion") in (6, 7), str(res.get("schemaVersion")))
    data = res.get("data") or {}
    c.check("导出包含研究任务", isinstance(data.get("researchRuns"), list), str(type(data.get("researchRuns"))))
    c.check("导出包含研究资料", isinstance(data.get("researchSources"), list), str(type(data.get("researchSources"))))
    c.check(
        "导出尝试保留研究关联字段",
        any(a.get("sourceResearchId") == saved_run_id for a in data.get("attempts") or []),
        "no attempt link",
    )


def main():
    start_servers()
    try:
        client.login("研究测试用户")
        test_settings_and_token()
        test_preview_and_validation()
        test_rate_limit_and_errors()
        test_model_failures_and_untrusted()
        saved_run_id, attempt_id = test_main_flow()
        test_partial_failure_and_cancel()
        test_delete_and_export(saved_run_id, attempt_id)
    except Exception:
        traceback.print_exc()
        c.check("测试脚本未抛出异常", False)
    finally:
        stop_servers()
    success = c.report("研究一下（GitHub 调研）")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
