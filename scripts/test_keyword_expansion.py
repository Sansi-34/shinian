"""拾念 SHINIAN · 「换个说法找记录」API/边界验收

默认自启动隔离服务（随机端口、db/keyword-expansion-test.sqlite）与 fake model。
覆盖：未登录、无模型、主动生成一次调用、空数组/5项/6项/空词/超长/非法结构、
operationId 幂等与冲突、配置版本、主题 scopeHash、超时、expanded 检索去重、
direct/expanded 标记、范围限制、来源修改/删除。

接口尚未就绪时（POST /api/ask/keyword-suggestions 404/405）打印 TODO 并跳过对应断言，
仍执行 candidates expanded 相关测试；不影响现有套件。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.parse
import uuid
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
TSX = str(ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs")
BASE = os.environ.get("SHINIAN_BASE", "").rstrip("/")
TEST_DB = Path(os.environ.get("SHINIAN_TEST_DB") or (ROOT / "db" / "keyword-expansion-test.sqlite"))
FAKE_PORT = int(os.environ.get("SHINIAN_KEYWORD_FAKE_PORT", "3512"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
SECRET_KEY = "test-secret-key"
UID = uuid.uuid4().hex[:8]
SUGGEST_LAST = ROOT / "output" / "fake-suggest-last.json"

c = Checker()
client = None
app_proc = None
app_log = None
fake_proc = None
app_started = False
SUGGEST_AVAILABLE = True


def op(tag):
    return f"op-kw-{tag}-{UID}-{uuid.uuid4().hex[:6]}"


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port, timeout=25):
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
    try:
        SUGGEST_LAST.unlink()
    except OSError:
        pass
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


def start_app():
    global app_proc, app_log, BASE, app_started
    if BASE:
        print(f"复用外部测试服务: {BASE}")
        return
    if "test" not in TEST_DB.name.lower():
        raise RuntimeError(f"拒绝使用非测试数据库：{TEST_DB}")
    port = free_port()
    master_key = ROOT / "db" / "keyword-expansion-test-master.key"
    if not app_started:
        for path in (TEST_DB, Path(str(TEST_DB) + "-wal"), Path(str(TEST_DB) + "-shm"), master_key):
            if path.exists():
                path.unlink()
        app_started = True
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["DATABASE_URL"] = str(TEST_DB)
    env["SHINIAN_MASTER_KEY_FILE"] = str(master_key)
    env["SHINIAN_AI_TIMEOUT_MS"] = "1200"
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = "800"
    app_log = open(ROOT / "db" / "keyword-expansion-test-server.log", "ab")
    app_proc = subprocess.Popen(
        [NODE, TSX, str(ROOT / "src" / "server" / "index.ts")],
        cwd=str(ROOT),
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
    )
    BASE = f"http://127.0.0.1:{port}"
    if not wait_port(port):
        raise RuntimeError("隔离服务未能启动")


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


def current_config_version():
    status, settings = client.get("/api/settings/ai")
    config = (settings or {}).get("config") or {}
    return int(config.get("configVersion") or 1)


def suggest(question, keywords, operation_id=None, topic_id=None, config_version=None, scope_hash=None):
    body = {
        "question": question,
        "keywords": keywords,
        "operationId": operation_id or op("suggest"),
        "configVersion": current_config_version() if config_version is None else config_version,
    }
    if topic_id:
        body["topicId"] = topic_id
    if scope_hash:
        body["scopeHash"] = scope_hash
    return client.post("/api/ask/keyword-suggestions", body)


def configure(model):
    return client.request(
        "PUT",
        "/api/settings/ai",
        {
            "name": "关键词扩展假模型",
            "baseUrl": f"{FAKE_BASE}/v1",
            "modelId": model,
            "enabled": True,
            "allowLocal": True,
            "apiKey": SECRET_KEY,
        },
    )


def suggestion_error_code(body):
    if not isinstance(body, dict):
        return None
    return body.get("errorCode") or body.get("error") or body.get("code")


def last_suggest_file():
    try:
        return json.loads(SUGGEST_LAST.read_text(encoding="utf-8"))
    except Exception:
        return {}


def suggest_snapshot():
    data = last_suggest_file()
    return {"count": int(data.get("count") or 0), "serverId": data.get("serverId")}


def create_capture(text):
    status, body = client.post("/api/captures", {"rawText": text})
    assert status == 200, (status, body)
    return body["capture"]


def create_attempt(capture, step, result, outcome="success", observed_at=None):
    status, body = client.post(
        f"/api/captures/{capture['id']}/attempts",
        {
            "step": step,
            "state": "done",
            "resultText": result,
            "outcome": outcome,
            "observedAt": observed_at or int(time.time() * 1000),
            "operationId": op("attempt"),
        },
    )
    assert status in (200, 201), (status, body)
    return body["attempt"]


def candidates(question, keywords, expanded=None, from_=None, to=None, extra=None):
    params = {"question": question, "keywords": keywords, "limit": "20"}
    if expanded is not None:
        params["expanded"] = expanded if isinstance(expanded, list) else [expanded]
    if from_ is not None:
        params["from"] = from_
    if to is not None:
        params["to"] = to
    if extra:
        params.update(extra)
    return client.get(
        "/api/ask/candidates?"
        + urllib.parse.urlencode(params, quote_via=urllib.parse.quote, doseq=True)
    )


def main():
    global client, SUGGEST_AVAILABLE
    start_fake()
    start_app()
    client = Client(base=BASE)
    status, login = client.post("/api/session/create", {"username": f"关键词扩展验收-{UID}"})
    c.check("登录成功", status == 200 and login.get("ok"), f"{status} {login}")

    anonymous = Client(base=BASE)
    st, _ = anonymous.post(
        "/api/ask/keyword-suggestions",
        {"question": "PWM 闪烁", "keywords": ["PWM"], "operationId": op("anon")},
    )
    c.check("未登录生成检索词建议返回 401", st == 401, str(st))

    status, _ = client.delete("/api/settings/ai")
    c.check("清除 AI 配置成功", status == 200, str(status))
    st, body = suggest("PWM 闪烁", ["PWM"])
    if st in (404, 405):
        SUGGEST_AVAILABLE = False
        print("TODO  POST /api/ask/keyword-suggestions 尚未注册；建议相关断言跳过，candidates expanded 继续。")
    else:
        c.check("未配置模型生成建议返回 409 ai_not_configured", st == 409 and suggestion_error_code(body) == "ai_not_configured", f"{st} {body}")

    st, body = suggest("", ["PWM"])
    c.check("建议问题为空返回 400 invalid_question", st == 400 and suggestion_error_code(body) == "invalid_question", f"{st} {body}")
    st, body = suggest("PWM 闪烁", "关" * 201)
    c.check("建议关键词超长返回 400 invalid_keywords", st == 400 and suggestion_error_code(body) == "invalid_keywords", f"{st} {body}")
    st, body = client.post(
        "/api/ask/keyword-suggestions",
        {"question": "PWM 闪烁", "keywords": ["PWM"], "operationId": op("bad-version"), "configVersion": 0},
    )
    c.check("建议 configVersion 非法返回 400 invalid_request", st == 400 and suggestion_error_code(body) == "invalid_request", f"{st} {body}")

    # 原检索即使未配置模型也可以使用。
    cap = create_capture(f"KW-{UID} LED 调光实验，记录 PWM 频率条件")
    att = create_attempt(cap, f"KW-{UID} 把 PWM 调到 2 kHz", f"KW-{UID} 肉眼不可见")
    st, base_search = candidates(f"KW-{UID} PWM 闪烁", f"KW-{UID} PWM")
    c.check("无模型时原检索仍可用", st == 200 and any(x.get("id") == att["id"] for x in (base_search or {}).get("candidates") or []), f"{st} {str(base_search)[:300]}")

    # 配置 fake normal
    status, _ = configure("fake-suggest-keywords")
    c.check("配置 fake-suggest-keywords", status == 200, str(status))
    # 先让当前 fake 进程写一次落盘文件，避免多个 fake 进程共用同一文件时 count 不连续。
    warm_status, _warm = suggest("测试当前假模型进程", ["PWM"], operation_id=op("warmup"))
    c.check("建议 warmup 成功", warm_status == 200, str(warm_status))
    before = suggest_snapshot()
    op1 = op("normal")
    st, suggestion = suggest("PWM 闪烁怎么调", ["PWM"], operation_id=op1)
    if SUGGEST_AVAILABLE:
        c.check("正常建议返回 200", st == 200, f"{st} {suggestion}")
        if st == 200:
            c.check("正常建议返回 terms 数组", isinstance(suggestion.get("terms"), list) and len(suggestion.get("terms")) >= 1, str(suggestion))
            c.check("建议响应字段齐全", isinstance(suggestion.get("config"), dict) and isinstance(suggestion.get("usage"), dict) and isinstance(suggestion.get("durationMs"), int) and isinstance(suggestion.get("generatedAt"), int), str(suggestion)[:500])
            c.check("建议 usage 三项为整数", all(isinstance((suggestion.get("usage") or {}).get(k), int) for k in ("inputTokens", "outputTokens", "totalTokens")), str(suggestion.get("usage")))
            c.check("建议 terms 不超过 5 项且每项 40 字内", len(suggestion["terms"]) <= 5 and all(0 < len(t) <= 40 for t in suggestion["terms"]), str(suggestion.get("terms")))
            last = last_suggest_file()
            c.check(
                "fake 收到建议请求并落盘",
                last.get("serverId") == before.get("serverId") and int(last.get("count") or 0) == before.get("count", 0) + 1,
                f"{last.get('serverId')} {last.get('count')} before={before}",
            )
            request = (last.get("request") or {}).get("body") or {}
            messages_text = json.dumps(request.get("messages") or [], ensure_ascii=False)
            c.check("建议请求只包含 question 与 keywords（不发送记录正文）", set(request.keys()) <= {"model", "messages", "temperature", "max_tokens", "stream", "response_format", "maxOutputTokens"} and "KW-" not in json.dumps(request, ensure_ascii=False), str(request.keys()))
            c.check(
                "建议 prompt 含问题与检索词且不含记录正文",
                "PWM 闪烁怎么调" in messages_text
                and "PWM" in messages_text
                and f"KW-{UID}" not in messages_text,
                messages_text[:300],
            )
            # 重复 operationId
            st, replay = suggest("PWM 闪烁怎么调", ["PWM"], operation_id=op1)
            c.check("相同 operationId 回放 replayed=true", st == 200 and replay.get("replayed") is True, f"{st} {str(replay)[:300]}")
            c.check(
                "回放不增加模型调用次数",
                last.get("serverId") == before.get("serverId") and int(last.get("count") or 0) == before.get("count", 0) + 1,
                f"{last.get('serverId')} {last.get('count')} before={before}",
            )
            st, conflict = suggest("完全不同的问题", ["PWM"], operation_id=op1)
            c.check("同一 operationId 不同 payload 返回冲突", st == 409, f"{st} {conflict}")
            # 配置版本变化
            old_version = (suggestion.get("config") or {}).get("configVersion")
            status, _ = configure("fake-suggest-keywords-empty")
            c.check("切换建议模型配置成功", status == 200, str(status))
            st, changed = suggest("配置版本检查", ["测试"], operation_id=op("config-version"))
            c.check("配置版本变化后新请求返回新 configVersion", st == 200 and (changed.get("config") or {}).get("configVersion") != old_version, f"{st} {changed.get('config')} old={old_version}")
            st, stale = suggest("旧配置版本请求", ["测试"], operation_id=op("stale-version"), config_version=old_version)
            c.check("旧 configVersion 请求返回 409 config_changed", st == 409 and suggestion_error_code(stale) == "config_changed", f"{st} {stale}")

    # 各种模型输出场景
    scenario_expect = [
        ("fake-suggest-keywords-empty", "空数组", "ok"),
        ("fake-suggest-keywords-five", "5 项", "ok"),
        ("fake-suggest-keywords-six", "6 项", "error"),
        ("fake-suggest-keywords-empty-term", "空词", "error"),
        ("fake-suggest-keywords-overlong", "超长单项", "error"),
        ("fake-suggest-keywords-total-overlong", "合计超长", "error"),
        ("fake-suggest-keywords-invalid-json", "非法 JSON", "error"),
        ("fake-suggest-keywords-invalid-shape", "非法结构", "error"),
    ]
    for model, label, expected in scenario_expect:
        configure(model)
        st, body = suggest(f"场景 {label}", ["测试"], operation_id=op(f"scenario-{label}"))
        if not SUGGEST_AVAILABLE:
            continue
        if st in (404, 405):
            SUGGEST_AVAILABLE = False
            print(f"TODO  接口未注册，跳过场景 {label}")
            break
        if expected == "ok":
            c.check(f"{label}返回 200 且 terms 合法", st == 200 and isinstance(body.get("terms"), list) and len(body["terms"]) <= 5, f"{st} {str(body)[:300]}")
        else:
            c.check(f"{label}被拒绝", st != 200 and suggestion_error_code(body) in {"invalid_response", "ai_invalid_response", "bad_response"}, f"{st} {str(body)[:300]}")

    # 主题 scopeHash 变化
    if SUGGEST_AVAILABLE:
        configure("fake-suggest-keywords")
        status, topic_body = client.post(
            "/api/topics",
            {
                "title": f"KW-{UID} 主题",
                "captureIds": [cap["id"]],
                "operationId": op("topic"),
            },
        )
        if status in (200, 201):
            topic = topic_body.get("topic") or topic_body
            topic_id = topic.get("id")
            status, first = suggest("主题范围问题", ["PWM"], operation_id=op("topic-first"), topic_id=topic_id)
            first_scope = ((first or {}).get("topic") or {}).get("scopeHash")
            cap2 = create_capture(f"KW-{UID} 主题第二念头")
            client.post(f"/api/topics/{topic_id}/members", {"captureIds": [cap2["id"]], "operationId": op("topic-add")})
            status, second = suggest("主题范围问题", ["PWM"], operation_id=op("topic-second"), topic_id=topic_id)
            second_scope = ((second or {}).get("topic") or {}).get("scopeHash")
            c.check("主题 scopeHash 随成员变化", bool(first_scope) and bool(second_scope) and first_scope != second_scope, f"{first_scope} -> {second_scope}")
            st, stale_scope = suggest(
                "主题范围问题",
                ["PWM"],
                operation_id=op("topic-stale"),
                topic_id=topic_id,
                scope_hash=first_scope,
            )
            c.check("旧 scopeHash 返回 409 topic_scope_changed", st == 409 and suggestion_error_code(stale_scope) == "topic_scope_changed", f"{st} {stale_scope}")
        else:
            print(f"TODO  主题创建不可用，跳过 scopeHash 测试：{status} {str(topic_body)[:200]}")

    # 扩展检索：direct / expanded / 去重 / 范围 / 来源变化
    exp_cap = create_capture(f"KWE-{UID} 调光实验")
    exp_att = create_attempt(
        exp_cap,
        f"KWE-{UID} 2 kHz 调光",
        f"KWE-{UID} KWEXPANDED-{UID} 肉眼不可见",
    )
    st, original = candidates(f"KWE-{UID} 闪烁", f"KWNO-{UID}")
    c.check("扩展前原词不命中该记录", st == 200 and not any(x.get("id") == exp_att["id"] for x in (original or {}).get("candidates") or []), f"{st}")
    st, expanded = candidates(
        f"KWE-{UID} 闪烁",
        f"KWNO-{UID}",
        expanded=[f"KWEXPANDED-{UID}", f"KWEXPANDED-{UID}", f"KWNO-{UID}"],
    )
    exp_candidate = next((x for x in (expanded or {}).get("candidates") or [] if x.get("id") == exp_att["id"]), None)
    if st == 200 and (expanded or {}).get("expandedKeywords") is not None:
        c.check("expanded 结果标记 matchKind=expanded", exp_candidate is not None and exp_candidate.get("matchKind") == "expanded", str(exp_candidate))
        c.check("expanded 去重且不重复原关键词", (expanded.get("expandedKeywords") or []).count(f"KWEXPANDED-{UID}") == 1 and f"KWNO-{UID}" not in (expanded.get("expandedKeywords") or []), str(expanded.get("expandedKeywords")))
        c.check("expanded 结果带 matchedKeywords 与扩展原因", bool(exp_candidate) and f"KWEXPANDED-{UID}" in (exp_candidate.get("matchedKeywords") or []) and any("扩展词命中" in reason for reason in exp_candidate.get("matchReasons") or []), str(exp_candidate)[:400])
        future = int(time.time() * 1000) + 86400000
        st, out_of_range = candidates(f"KWE-{UID} 闪烁", f"KWNO-{UID}", expanded=[f"KWEXPANDED-{UID}"], from_=future, to=future + 3600000)
        c.check("扩展检索不越出日期范围", st == 200 and not (out_of_range or {}).get("candidates"), f"{st} {str(out_of_range)[:200]}")
    else:
        print(f"TODO  candidates expanded 参数尚未生效：{st} {str(expanded)[:200]}")

    st, _ = client.patch(
        f"/api/attempts/{exp_att['id']}",
        {"resultText": f"KWE-{UID} 修改后结果", "outcome": "failure", "revision": 1, "state": "done"},
    )
    c.check("扩展来源可修改", st == 200, str(st))
    status, _ = client.delete(f"/api/attempts/{exp_att['id']}")
    c.check("扩展来源可删除", status == 200, str(status))
    st, after_delete = candidates(f"KWE-{UID} 闪烁", f"KWNO-{UID}", expanded=[f"KWEXPANDED-{UID}"])
    c.check("来源删除后扩展检索无残留", st == 200 and not any(x.get("id") == exp_att["id"] for x in (after_delete or {}).get("candidates") or []), f"{st}")

    # 超时
    if SUGGEST_AVAILABLE:
        configure("fake-suggest-keywords-timeout")
        started = time.time()
        st, timeout_body = suggest("超时检查", ["测试"], operation_id=op("timeout"))
        elapsed = time.time() - started
        c.check("建议超时被明确归类", st != 200 and suggestion_error_code(timeout_body) == "timeout", f"{st} {str(timeout_body)[:300]} elapsed={elapsed:.1f}")
        c.check("建议超时不会返回合法 terms", not isinstance((timeout_body or {}).get("terms"), list), str(timeout_body)[:200])
        # 等 fake 的 5s 迟到响应过去，再确认它没有污染下一次建议。
        time.sleep(5.2)
        configure("fake-suggest-keywords")
        st, after_timeout = suggest("超时后的下一次建议", ["测试"], operation_id=op("timeout-next"))
        c.check("超时后的迟到响应不污染下一次建议", st == 200 and isinstance(after_timeout.get("terms"), list), f"{st} {str(after_timeout)[:300]}")
        print("TODO  当前 keyword-suggestions 无 cancel 端点；取消/客户端断开由超时与请求关闭路径覆盖，若后端新增 cancel 再补断言。")

    status, _ = client.delete("/api/settings/ai")
    c.check("测试结束清除 AI 配置", status == 200, str(status))
    ok = c.report("关键词扩展 API 验收")
    return 0 if ok else 1


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR 执行异常：{exc}")
        traceback.print_exc()
    finally:
        try:
            if client:
                client.delete("/api/settings/ai")
        except Exception:  # noqa: BLE001
            pass
        stop_app()
        stop_fake()
    sys.exit(exit_code)
