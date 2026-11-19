"""拾念 SHINIAN · 「问我的记录」验收测试

默认自启动隔离服务（db/test-ask.sqlite + 自动空闲端口），也可设置 SHINIAN_BASE
复用 run_tests.py 启动的 3100 测试服务。脚本自行启动/停止
scripts/fake_model_server.py（默认 127.0.0.1:3501）。不会写入主库。

覆盖：
- 未登录 401；问题/关键词/来源/日期范围参数校验
- 隔离数据：2 个 capture、3 个 attempt（500 Hz 失败、2 kHz 成功、无结果）、真实引用
- 关键词命中、引用关系扩展、日期范围、空结果后改关键词、broad 检索
- 预览正文/coverage/contextToken；未配置模型仍可预览
- 未配置模型生成 409 ai_not_configured
- fake-ask 成功生成、observation/inference/condition、来源属于发送记录、app 生成链接
- 真实 prompt 只包含已选记录
- 证据不足、矛盾、编造来源、超时、取消
- operationId 回放与冲突
- 删除来源后的快照清洗与 answerInvalidated
- 结束恢复 AI 配置

运行要求：测试服务应使用 SHINIAN_AI_TIMEOUT_MS<=5000（run_tests.py 默认 1200），
否则 fake-ask-timeout 的 5 秒延迟会先返回合法建议而不会超时。
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
import urllib.parse
import urllib.request
import uuid
from contextlib import closing

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node") or "node"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
BASE = os.environ.get("SHINIAN_BASE", "").rstrip("/")
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
SECRET_KEY = "test-secret-key"
TEST_DB = os.environ.get("SHINIAN_TEST_DB", os.path.join(ROOT, "db", "test.sqlite"))
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}

c = Checker()
client = Client(base=BASE)
uid = uuid.uuid4().hex[:8]
fake_proc = None
app_proc = None
app_log = None


def ms_now() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- 被测服务（默认自启动隔离实例）
def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_test_server():
    """没有 SHINIAN_BASE 时自启动隔离服务，避免误连主库。"""
    global BASE, TEST_DB, app_proc, app_log
    if BASE:
        print(f"复用外部测试服务: {BASE}（DB: {TEST_DB}）")
        return
    TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test-ask.sqlite")
    # 只清理明确的测试库，绝不碰 db/shinian.sqlite
    if "test" not in os.path.basename(TEST_DB).lower():
        raise RuntimeError(f"拒绝自动删除非测试数据库：{TEST_DB}")
    master_key = os.path.join(ROOT, "db", "test-ask-master.key")
    log_path = os.path.join(ROOT, "db", "test-ask-server.log")
    for path in (TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm", master_key, log_path):
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    port = int(os.environ.get("SHINIAN_ASK_TEST_PORT") or free_port())
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["DATABASE_URL"] = TEST_DB
    env["SHINIAN_MASTER_KEY_FILE"] = master_key
    env["SHINIAN_AI_TIMEOUT_MS"] = os.environ.get("SHINIAN_AI_TIMEOUT_MS", "1200")
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = os.environ.get("SHINIAN_AI_TEST_TIMEOUT_MS", "800")
    app_log = open(log_path, "ab")
    app_proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
    )
    BASE = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            urllib.request.urlopen(BASE + "/api/session/check", timeout=1)
        except urllib.error.HTTPError:
            print(f"已启动隔离测试服务: {BASE}（DB: {TEST_DB}）")
            return
        except Exception:
            if app_proc.poll() is not None:
                raise RuntimeError(f"测试服务进程退出，日志见 {log_path}")
            time.sleep(0.2)
    raise RuntimeError(f"测试服务未能启动，日志见 {log_path}")


def stop_test_server():
    global app_proc, app_log
    if app_proc is None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(app_proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        app_proc.terminate()
    try:
        app_proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        app_proc.kill()
        app_proc.wait(timeout=5)
    app_proc = None
    if app_log is not None:
        app_log.close()
        app_log = None


# ---------------------------------------------------------------- 假模型服务
def port_open(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_port(host, port, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            return True
        time.sleep(0.15)
    return False


def fake_get(path):
    with urllib.request.urlopen(FAKE_BASE + path, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


def fake_last():
    return (fake_get("/__last").get("request") or {})


def fake_user_prompt():
    body = fake_last().get("body") or {}
    parts = []
    for message in body.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
    return "\n".join(parts)


def start_fake_server():
    global fake_proc
    if port_open("127.0.0.1", FAKE_PORT):
        try:
            health = fake_get("/__health")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"端口 {FAKE_PORT} 被占用且不是 fake model server：{exc}")
        if health.get("service") == "shinian-fake-model":
            print(f"复用已在运行的 fake model server: {FAKE_BASE}")
            return
        raise RuntimeError(f"端口 {FAKE_PORT} 被其他进程占用")
    fake_proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts", "fake_model_server.py")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port("127.0.0.1", FAKE_PORT):
        raise RuntimeError("fake model server 未能启动")
    print(f"已启动 fake model server: {FAKE_BASE}")


def stop_fake_server():
    global fake_proc
    if fake_proc is None:
        return
    fake_proc.terminate()
    try:
        fake_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        fake_proc.kill()
        fake_proc.wait(timeout=5)
    fake_proc = None


# ---------------------------------------------------------------- API 工具
UNSET = object()


def qs(path, **params):
    if "from_" in params:
        params["from"] = params.pop("from_")
    # quote_via=quote：空格编码为 %20，避免服务端把 '+' 当成字面加号
    return path + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def ask_candidates(question, keywords=UNSET, from_=UNSET, to=UNSET, limit=None):
    params = {"question": question}
    if keywords is not UNSET:
        params["keywords"] = keywords
    if from_ is not UNSET:
        params["from"] = from_
    if to is not UNSET:
        params["to"] = to
    if limit is not None:
        params["limit"] = limit
    return client.get(qs("/api/ask/candidates", **params))


def ask_preview(question, keywords, source_keys, from_=UNSET, to=UNSET):
    payload = {
        "question": question,
        "keywords": keywords,
        "sourceKeys": list(source_keys),
    }
    if from_ is not UNSET:
        payload["from"] = from_
    if to is not UNSET:
        payload["to"] = to
    return client.post("/api/ask/preview", payload)


def start_ask(
    question,
    keywords,
    source_keys,
    context_token,
    operation_id=None,
    from_=UNSET,
    to=UNSET,
):
    payload = {
        "question": question,
        "keywords": keywords,
        "sourceKeys": list(source_keys),
        "contextToken": context_token,
        "operationId": operation_id or f"op-ask-{uuid.uuid4().hex[:12]}",
    }
    if from_ is not UNSET:
        payload["from"] = from_
    if to is not UNSET:
        payload["to"] = to
    return client.post("/api/ask/queries", payload)


def wait_ask(query_id, timeout=20.0):
    deadline = time.time() + timeout
    last = None
    status = None
    while time.time() < deadline:
        status, res = client.get(f"/api/ask/queries/{query_id}")
        if status != 200:
            return status, res
        last = (res or {}).get("query")
        if last and last.get("status") in TERMINAL:
            return status, res
        time.sleep(0.2)
    return status or 200, {"query": last, "_poll_timeout": True}


def configure(model, api_key=SECRET_KEY, name="问记录测试模型"):
    status, res = client.request(
        "PUT",
        "/api/settings/ai",
        {
            "name": name,
            "baseUrl": f"{FAKE_BASE}/v1",
            "modelId": model,
            "enabled": True,
            "allowLocal": True,
            "apiKey": api_key,
        },
    )
    c.check(
        f"配置假模型 {model}",
        status == 200 and (res or {}).get("configured") is True,
        f"{status} {res}",
    )
    return res


def delete_ai():
    return client.delete("/api/settings/ai")


def create_capture(text):
    status, res = client.post("/api/captures", {"rawText": text})
    assert status == 200, f"创建念头失败 {status} {res}"
    c.check("创建念头成功", isinstance((res or {}).get("capture", {}).get("id"), str), str(res)[:200])
    return res["capture"]


def make_attempt(capture, step, result=None, outcome=None):
    status, res = client.post(
        f"/api/captures/{capture['id']}/attempts",
        {"step": step, "state": "todo", "operationId": f"op-ask-att-{uuid.uuid4().hex[:12]}"},
    )
    assert status == 200, f"创建尝试失败 {status} {res}"
    attempt = res["attempt"]
    if result is not None:
        status, res = client.patch(
            f"/api/attempts/{attempt['id']}",
            {"resultText": result, "outcome": outcome, "revision": attempt["revision"]},
        )
        assert status == 200, f"记录结果失败 {status} {res}"
        attempt = res["attempt"]
    c.check("创建尝试成功", isinstance(attempt.get("id"), str), str(attempt)[:200])
    return attempt


def create_reference(from_attempt, to_attempt, note):
    status, res = client.post(
        f"/api/attempts/{from_attempt['id']}/references",
        {
            "toId": to_attempt["id"],
            "note": note,
            "operationId": f"op-ask-ref-{uuid.uuid4().hex[:12]}",
        },
    )
    assert status == 200, f"创建引用失败 {status} {res}"
    c.check("创建真实引用成功", isinstance((res or {}).get("reference", {}).get("id"), str), str(res)[:200])
    return res["reference"]


def create_link(from_capture, to_capture, note=None):
    payload = {
        "toCaptureId": to_capture["id"],
        "operationId": f"op-ask-link-{uuid.uuid4().hex[:12]}",
    }
    if note:
        payload["note"] = note
    status, res = client.post(f"/api/captures/{from_capture['id']}/links", payload)
    assert status == 200, f"创建念头关联失败 {status} {res}"
    c.check("创建念头关联成功", isinstance((res or {}).get("link", {}).get("id"), str), str(res)[:200])
    return res["link"]


def db_usable():
    """只有同一测试服务提供了可读的测试库时才做直接 SQL 断言。"""
    if not TEST_DB or not os.path.exists(TEST_DB):
        return False
    try:
        with closing(sqlite3.connect(TEST_DB, timeout=5)) as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='record_queries'"
            ).fetchone()
        return row is not None
    except sqlite3.Error:
        return False


def db_query_row(query_id):
    if not db_usable():
        return None
    try:
        with closing(sqlite3.connect(TEST_DB, timeout=15)) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM record_queries WHERE id = ?", (query_id,)).fetchone()
            return dict(row) if row else None
    except sqlite3.Error as exc:  # noqa: BLE001 - 外部服务可能没有本地库
        print(f"SKIP  数据库断言不可用：{exc}")
        return None


def find_candidate(body, source_key):
    return next((x for x in (body or {}).get("candidates") or [] if x.get("sourceKey") == source_key), None)


def point_sources(answer):
    keys = []
    for point in (answer or {}).get("points") or []:
        keys.extend(point.get("sourceIds") or [])
    for item in (answer or {}).get("contradictions") or []:
        keys.extend(side.get("sourceId") for side in item.get("sides") or [])
    return keys


# ---------------------------------------------------------------- 主流程
def main():
    start_test_server()
    client.base = BASE
    print(f"测试服务: {BASE}")
    start_fake_server()

    now = ms_now()
    past_from = now - 3 * 3600 * 1000
    future_from = now + 3600 * 1000
    future_to = now + 2 * 3600 * 1000

    cap_a_text = (
        f"ASK PWM 调光闪烁记录 {uid}：想解决 LED 调光时肉眼可见闪烁。"
        f"ASKLINK-{uid}"
    )
    cap_b_text = f"ASKUNSELECTED-{uid} 无关念头：整理桌面。"
    step1 = f"ASK-{uid} 把 PWM 频率设为 500 Hz 调光"
    result1 = f"ASKHIT-{uid}：500 Hz 时 LED 仍然可见闪烁，这次调光失败。"
    step2 = f"ASK-{uid} 把 PWM 频率改到 2 kHz 再调光"
    result2 = f"2 kHz 时肉眼几乎不可见，未再闪烁（ASKOK-{uid}）。"
    step3 = f"ASKEMPTY-{uid} 没有写下结果的尝试"

    # ============================================================ 1. 未登录与参数校验
    print("\n### 1. 未登录与参数校验")
    anon = Client(base=BASE)
    st, _ = anon.get(qs("/api/ask/candidates", question="PWM 闪烁"))
    c.check("未登录 candidates 返回 401", st == 401, str(st))
    st, _ = anon.post(
        "/api/ask/preview",
        {"question": "PWM 闪烁", "keywords": "PWM", "sourceKeys": ["attempt:x"]},
    )
    c.check("未登录 preview 返回 401", st == 401, str(st))
    st, _ = anon.post(
        "/api/ask/queries",
        {
            "question": "PWM 闪烁",
            "keywords": "PWM",
            "sourceKeys": ["attempt:x"],
            "contextToken": "x",
            "operationId": "op-anon",
        },
    )
    c.check("未登录创建问答返回 401", st == 401, str(st))
    st, _ = anon.get("/api/ask/queries")
    c.check("未登录问答列表返回 401", st == 401, str(st))
    st, _ = anon.get("/api/ask/queries/ask-x")
    c.check("未登录问答详情返回 401", st == 401, str(st))
    st, _ = anon.post("/api/ask/queries/ask-x/cancel", {})
    c.check("未登录取消问答返回 401", st == 401, str(st))

    body = client.login(f"问记录测试用户-{uid}")
    c.check("创建/登录独立问记录测试账号", body.get("ok") is True, str(body))

    st, res = ask_candidates("   ")
    c.check("问题为空白返回 400 invalid_question", st == 400 and res.get("error") == "invalid_question", f"{st} {res}")
    st, res = ask_candidates("问" * 501)
    c.check("问题超过 500 字返回 400 invalid_question", st == 400 and res.get("error") == "invalid_question", f"{st} {res}")
    st, res = ask_candidates("PWM 闪烁", keywords="关" * 201)
    c.check("关键词超过 200 字返回 400 invalid_keywords", st == 400 and res.get("error") == "invalid_keywords", f"{st} {res}")
    st, res = ask_candidates("PWM 闪烁", from_=0, to=now)
    c.check("from=0 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = ask_candidates("PWM 闪烁", from_=now + 1000, to=now)
    c.check("to<=from 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = ask_candidates("PWM 闪烁", from_=8_640_000_000_000_001)
    c.check("超大 from 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")

    st, res = ask_preview("", "PWM", ["attempt:x"])
    c.check("preview 空问题返回 400 invalid_question", st == 400 and res.get("error") == "invalid_question", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "PWM", [])
    c.check("preview 空 sourceKeys 返回 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "PWM", ["not-a-key"])
    c.check("preview 非法来源格式返回 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "PWM", ["attempt:dup", "attempt:dup"])
    c.check("preview 重复来源返回 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "PWM", [f"attempt:x{i}" for i in range(9)])
    c.check("preview 超过 8 条来源返回 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "关" * 201, ["attempt:x"])
    c.check("preview 关键词过长返回 400 invalid_keywords", st == 400 and res.get("error") == "invalid_keywords", f"{st} {res}")
    st, res = ask_preview("PWM 闪烁", "PWM", ["attempt:x"], from_=future_to, to=future_from)
    c.check("preview 非法日期范围返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")

    st, res = client.post(
        "/api/ask/queries",
        {"question": "", "keywords": "PWM", "sourceKeys": ["attempt:x"], "contextToken": "x", "operationId": "op-empty"},
    )
    c.check("创建问答空问题返回 400 invalid_question", st == 400 and res.get("error") == "invalid_question", f"{st} {res}")
    st, res = client.post(
        "/api/ask/queries",
        {"question": "PWM 闪烁", "keywords": "PWM", "sourceKeys": ["attempt:x"], "contextToken": "x"},
    )
    c.check("创建问答缺 operationId 返回 400 invalid_request", st == 400 and res.get("error") == "invalid_request", f"{st} {res}")
    st, res = client.post(
        "/api/ask/queries",
        {"question": "PWM 闪烁", "keywords": "PWM", "sourceKeys": ["attempt:x"], "operationId": "op-no-token"},
    )
    c.check("创建问答缺 contextToken 返回 400 invalid_request", st == 400 and res.get("error") == "invalid_request", f"{st} {res}")
    st, res = client.post(
        "/api/ask/queries",
        {
            "question": "PWM 闪烁",
            "keywords": "PWM",
            "sourceKeys": ["attempt:x"],
            "contextToken": "x",
            "operationId": "op-bad-range",
            "from": future_to,
            "to": future_from,
        },
    )
    c.check("创建问答非法日期范围返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = client.post(
        "/api/ask/queries",
        {
            "question": "PWM 闪烁",
            "keywords": "PWM",
            "sourceKeys": ["bad-key"],
            "contextToken": "x",
            "operationId": "op-bad-src",
        },
    )
    c.check("创建问答非法来源返回 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")

    # ============================================================ 2. 隔离数据
    print("\n### 2. 创建隔离数据")
    cap_a = create_capture(cap_a_text)
    cap_b = create_capture(cap_b_text)
    att1 = make_attempt(cap_a, step1, result1, "failure")
    att2 = make_attempt(cap_a, step2, result2, "success")
    att3 = make_attempt(cap_b, step3, None)
    att4 = make_attempt(cap_b, f"ASKLINK-{uid} 引用伙伴尝试", None)
    att5 = make_attempt(cap_b, f"ASKTWO-{uid} 二跳尝试", None)
    ref = create_reference(att2, att1, f"ASKREF-{uid}：2 kHz 基于 500 Hz 的失败继续验证")
    create_reference(att1, att4, f"ASKLINKREF-{uid}：500 Hz 的这次尝试引用了伙伴尝试")
    create_reference(att5, att4, f"ASKTWOREF-{uid}：二跳尝试引用了伙伴尝试，不应被带入")

    cap_link_back = create_capture("链接反链伙伴：电源滤波记录")
    cap_link_out = create_capture("链接正链伙伴：接地处理记录")
    cap_link_child = create_capture("链接二跳伙伴：焊接检查记录")
    create_link(cap_link_back, cap_a, f"ASKLINK-{uid}：反链")
    create_link(cap_a, cap_link_out, f"ASKLINK-{uid}：正链")
    create_link(cap_link_child, cap_link_back, f"ASKTWO-{uid}：二跳")

    key1, key2, key3 = f"attempt:{att1['id']}", f"attempt:{att2['id']}", f"attempt:{att3['id']}"
    key4, key5 = f"attempt:{att4['id']}", f"attempt:{att5['id']}"
    cap_key_a, cap_key_b = f"capture:{cap_a['id']}", f"capture:{cap_b['id']}"
    cap_link_back_key = f"capture:{cap_link_back['id']}"
    cap_link_out_key = f"capture:{cap_link_out['id']}"
    cap_link_child_key = f"capture:{cap_link_child['id']}"
    c.check("隔离数据：2 个 capture 均已创建", cap_a.get("id") != cap_b.get("id"), f"{cap_a.get('id')} / {cap_b.get('id')}")
    c.check(
        "隔离数据：3 个 attempt 结果符合预期",
        att1.get("outcome") == "failure"
        and att2.get("outcome") == "success"
        and att3.get("resultText") in (None, "")
        and att1.get("resultText") == result1
        and att2.get("resultText") == result2,
        f"{att1.get('outcome')}/{att2.get('outcome')}/{att3.get('resultText')}",
    )
    c.check("隔离数据：引用记录已建立", isinstance(ref.get("id"), str), str(ref)[:200])

    # ============================================================ 3. 检索
    print("\n### 3. 检索候选")
    st, search = ask_candidates("我之前试过 PWM 闪烁吗", keywords=f"ASKHIT-{uid}", from_=past_from, to=future_to)
    c.check("关键词检索返回 200", st == 200, f"{st} total={(search or {}).get('total')}")
    c.check("检索回显 question/keywords", (search or {}).get("question") == "我之前试过 PWM 闪烁吗" and f"ASKHIT-{uid}" in ((search or {}).get("keywords") or []), str((search or {}).get("keywords")))
    total = (search or {}).get("total") or 0
    c.check("检索 total>=1", total >= 1, str(total))
    hit1 = find_candidate(search, key1)
    c.check("关键词命中的 attempt 出现在候选", hit1 is not None, str([x.get("sourceKey") for x in (search or {}).get("candidates") or []])[:300])
    if hit1:
        c.check("候选 type=attempt", hit1.get("type") == "attempt", str(hit1.get("type")))
        c.check("候选 snippet 含真实命中文本", f"ASKHIT-{uid}" in (hit1.get("snippet") or ""), str(hit1.get("snippet"))[:200])
        c.check("候选 date 为整数且 openHref 指向原尝试", isinstance(hit1.get("date"), int) and hit1.get("openHref") == f"/attempt/{att1['id']}", f"{hit1.get('date')} {hit1.get('openHref')}")
        c.check("候选 dateKind=observed", hit1.get("dateKind") == "observed", str(hit1.get("dateKind")))
        c.check("候选 title 为步骤", step1 in (hit1.get("title") or ""), str(hit1.get("title")))
        c.check("候选 matchReasons 含 结果命中", "结果命中" in (hit1.get("matchReasons") or []), str(hit1.get("matchReasons")))
        c.check("直接命中 matchKind=direct", hit1.get("matchKind") == "direct", str(hit1.get("matchKind")))
        c.check("候选 referenceCount>=1", (hit1.get("referenceCount") or 0) >= 1, str(hit1.get("referenceCount")))
    partner = find_candidate(search, key2)
    c.check("引用关系扩展带出 partner", partner is not None, str([x.get("sourceKey") for x in (search or {}).get("candidates") or []])[:300])
    if partner:
        c.check("partner matchReasons 含 引用关系", "引用关系" in (partner.get("matchReasons") or []), str(partner.get("matchReasons")))
        c.check("partner matchKind=relation", partner.get("matchKind") == "relation", str(partner.get("matchKind")))
        c.check(
            "partner 反向引用原因可解释",
            "引用了这次尝试" in (partner.get("matchReasons") or []),
            str(partner.get("matchReasons")),
        )
        c.check("partner referenceCount>=1", (partner.get("referenceCount") or 0) >= 1, str(partner.get("referenceCount")))
    referrer = find_candidate(search, key4)
    c.check(
        "被这次尝试引用的一跳伙伴出现",
        referrer is not None
        and referrer.get("matchKind") == "relation"
        and "被这次尝试引用" in (referrer.get("matchReasons") or []),
        str(referrer),
    )
    c.check("二跳引用 att5 不出现", find_candidate(search, key5) is None, "att5 不应被递归带入")
    c.check("未命中的无关念头不出现在结果", find_candidate(search, cap_key_b) is None, "cap_b leaked")
    c.check("未命中的无结果尝试不出现在结果", find_candidate(search, key3) is None, "att3 leaked")

    # 直接命中整体排在关系扩展之前
    direct_indexes = [
        i for i, item in enumerate((search or {}).get("candidates") or []) if item.get("matchKind") == "direct"
    ]
    relation_indexes = [
        i for i, item in enumerate((search or {}).get("candidates") or []) if item.get("matchKind") == "relation"
    ]
    c.check(
        "候选直接命中排在关系扩展之前",
        bool(direct_indexes) and bool(relation_indexes) and max(direct_indexes) < min(relation_indexes),
        f"direct={direct_indexes} relation={relation_indexes}",
    )

    # capture_links 正链/反链一跳扩展
    # 用本测试唯一词，避免全量库大量 PWM 记录把链接伙伴挤出 limit=50
    st, link_search = ask_candidates("链接一跳关系检查", keywords=f"ASKLINK-{uid}", limit=50)
    cap_hit = find_candidate(link_search, cap_key_a)
    cap_back_hit = find_candidate(link_search, cap_link_back_key)
    cap_out_hit = find_candidate(link_search, cap_link_out_key)
    c.check("capture 直接命中", cap_hit is not None and cap_hit.get("matchKind") == "direct", str(cap_hit))
    c.check(
        "capture 反链一跳扩展",
        cap_back_hit is not None
        and cap_back_hit.get("matchKind") == "relation"
        and "通过链接找到" in (cap_back_hit.get("matchReasons") or []),
        str(cap_back_hit),
    )
    c.check(
        "capture 正链一跳扩展",
        cap_out_hit is not None
        and cap_out_hit.get("matchKind") == "relation"
        and "通过链接找到" in (cap_out_hit.get("matchReasons") or []),
        str(cap_out_hit),
    )
    c.check(
        "capture 二跳不出现",
        find_candidate(link_search, cap_link_child_key) is None,
        "capture 二跳不应被递归带入",
    )

    st, suggested = ask_candidates("PWM 闪烁")
    c.check("未传 keywords 时返回建议关键词", st == 200 and "PWM" in ((suggested or {}).get("keywords") or []), str((suggested or {}).get("keywords")))
    c.check("suggestedKeywords 与 keywords 一致", (suggested or {}).get("suggestedKeywords") == " ".join((suggested or {}).get("keywords") or []), str((suggested or {}).get("suggestedKeywords")))

    # Lead 指定的关键词反例：不能把整句当唯一检索词
    keyword_cases = [
        ("上次 LED 闪烁是怎么处理的", ["LED", "闪烁"]),
        ("两次调光实验的结果为什么不同？", ["调光实验"]),
        ("这条经验后来在哪次尝试中用过？", []),
        ("我上次试过哪些办法？哪种没用？", []),
        ("我在哪次尝试里比较过 PWM 频率？", ["PWM", "频率"]),
        ("我在哪次尝试里比较过PWM频率？", ["PWM", "频率"]),
    ]
    for question, expected in keyword_cases:
        st, kw = ask_candidates(question)
        c.check(
            f"自动关键词不整句: {question}",
            st == 200 and (kw or {}).get("keywords") == expected,
            f"实际 {(kw or {}).get('keywords')}，期望 {expected}",
        )

    st, broad = ask_candidates("我最近记录了什么", keywords="", limit=50)
    broad_keys = {x.get("sourceKey") for x in (broad or {}).get("candidates") or []}
    c.check("broad（关键词为空）返回记录", st == 200 and (broad or {}).get("total", 0) >= 5, str((broad or {}).get("total")))
    c.check(
        "broad 覆盖本次 2 个念头与 3 个尝试",
        {cap_key_a, cap_key_b, key1, key2, key3} <= broad_keys,
        str(sorted(broad_keys))[:500],
    )
    bcap = find_candidate(broad, cap_key_a)
    c.check("broad capture 带最近记录原因", bcap is not None and "最近记录" in (bcap.get("matchReasons") or []), str((bcap or {}).get("matchReasons")))

    st, ranged = ask_candidates("PWM 闪烁", keywords="", from_=past_from, to=future_to, limit=50)
    c.check("日期范围包含本次记录", st == 200 and {cap_key_a, key1, key2} <= {x.get("sourceKey") for x in (ranged or {}).get("candidates") or []}, str((ranged or {}).get("total")))
    st, future_only = ask_candidates("PWM 闪烁", keywords="", from_=future_from, to=future_to)
    c.check("未来日期范围过滤掉本次记录", st == 200 and (future_only or {}).get("total") == 0, str((future_only or {}).get("total")))

    # 精确边界：from 含、to 不含；observedAt 为尝试日期
    boundary_cap = create_capture("日期边界精确测试")
    boundary_from = now - 20 * 24 * 3600 * 1000
    boundary_to = boundary_from + 3 * 24 * 3600 * 1000
    boundary_attempts = []
    for index, observed_at in enumerate(
        [boundary_from - 1, boundary_from, boundary_to - 1, boundary_to]
    ):
        item = make_attempt(boundary_cap, f"ASKBOUND-{uid} 样本 {index}", None)
        status, patched = client.patch(
            f"/api/attempts/{item['id']}",
            {"revision": item["revision"], "observedAt": observed_at},
        )
        assert status == 200, f"更新边界尝试时间失败 {status} {patched}"
        boundary_attempts.append(patched["attempt"])
    st, boundary = ask_candidates(
        "日期边界",
        keywords=f"ASKBOUND-{uid}",
        from_=boundary_from,
        to=boundary_to,
    )
    boundary_keys = {x.get("sourceKey") for x in (boundary or {}).get("candidates") or []}
    expected_boundary = {
        f"attempt:{boundary_attempts[1]['id']}",
        f"attempt:{boundary_attempts[2]['id']}",
    }
    c.check(
        "日期范围精确左闭右开",
        st == 200 and boundary_keys == expected_boundary,
        f"got={boundary_keys} expected={expected_boundary}",
    )
    c.check(
        "日期边界候选 dateKind=observed",
        all(item.get("dateKind") == "observed" for item in (boundary or {}).get("candidates") or []),
        str([item.get("dateKind") for item in (boundary or {}).get("candidates") or []]),
    )

    missing_token = f"ASKNONE-{uid}"
    st, none = ask_candidates("完全不存在的问题", keywords=missing_token)
    c.check("无匹配关键词 total=0 且 candidates 为空", st == 200 and (none or {}).get("total") == 0 and (none or {}).get("candidates") == [], f"{st} {(none or {}).get('total')}")
    st, again = ask_candidates("完全不存在的问题", keywords=f"ASKHIT-{uid}")
    c.check("改关键词后重新有结果", st == 200 and (again or {}).get("total", 0) >= 1, str((again or {}).get("total")))

    # 候选只返回真实存在、未删除的记录
    temp_cap = create_capture(f"ASKDEL-{uid} 临时候选念头")
    temp_att = make_attempt(temp_cap, f"ASKDEL-{uid} 临时候选尝试", "临时结果")
    st, temp_found = ask_candidates("临时删除过滤", keywords=f"ASKDEL-{uid}")
    temp_keys = {item.get("sourceKey") for item in (temp_found or {}).get("candidates") or []}
    temp_att_key = f"attempt:{temp_att['id']}"
    temp_cap_key = f"capture:{temp_cap['id']}"
    c.check("删除前尝试和念头都在候选中", temp_att_key in temp_keys and temp_cap_key in temp_keys, str(sorted(temp_keys)))
    status, _ = client.delete(f"/api/attempts/{temp_att['id']}")
    c.check("删除候选尝试成功", status == 200, str(status))
    st, after_att = ask_candidates("临时删除过滤", keywords=f"ASKDEL-{uid}")
    after_att_keys = {item.get("sourceKey") for item in (after_att or {}).get("candidates") or []}
    c.check("已删除尝试不再成为候选", temp_att_key not in after_att_keys, str(sorted(after_att_keys)))
    status, _ = client.delete(f"/api/captures/{temp_cap['id']}")
    c.check("删除候选念头成功", status == 200, str(status))
    st, after_cap = ask_candidates("临时删除过滤", keywords=f"ASKDEL-{uid}")
    c.check("已删除念头不再成为候选", (after_cap or {}).get("total") == 0, str((after_cap or {}).get("total")))

    # ============================================================ 4. 预览
    print("\n### 4. 预览发送内容")
    status, _ = delete_ai()
    c.check("删除 AI 配置成功", status == 200, str(status))
    status, settings = client.get("/api/settings/ai")
    c.check("删除后 AI 未配置", status == 200 and settings.get("configured") is False and settings.get("config") is None, f"{status} {settings}")

    st, prev = ask_preview("PWM 闪烁调光时应该注意什么", "PWM", [key1, key2])
    c.check("未配置模型时也能预览", st == 200, f"{st} {prev}")
    prev_records = (prev or {}).get("records") or []
    c.check("预览返回 2 条记录", len(prev_records) == 2, str([r.get("sourceKey") for r in prev_records]))
    by_key = {r.get("sourceKey"): r for r in prev_records}
    c.check(
        "预览记录带真实正文与结果",
        by_key.get(key1, {}).get("text") == step1
        and by_key.get(key1, {}).get("resultText") == result1
        and by_key.get(key2, {}).get("resultText") == result2,
        str(prev_records)[:500],
    )
    c.check("预览记录带所属念头正文", all((r.get("captureText") or "").startswith("ASK PWM") for r in prev_records), str([r.get("captureText") for r in prev_records])[:300])
    coverage = (prev or {}).get("coverage") or {}
    c.check(
        "coverage.selectedRecords=2",
        coverage.get("selectedRecords") == 2,
        str(coverage),
    )
    c.check(
        "coverage selectedChars>0 且 withinLimit=true",
        isinstance(coverage.get("selectedChars"), int)
        and coverage.get("selectedChars") > 0
        and coverage.get("maxRecords") == 8
        and coverage.get("maxChars") == 12000
        and coverage.get("withinLimit") is True,
        str(coverage),
    )
    token = (prev or {}).get("contextToken")
    c.check("contextToken 为 64 位 hex", isinstance(token, str) and len(token) == 64 and all(ch in "0123456789abcdef" for ch in token), str(token)[:30])
    c.check("未配置时 preview.config=null", (prev or {}).get("config") is None, str((prev or {}).get("config")))
    c.check(
        "未配置时 preview.ai.configured=false",
        (prev or {}).get("ai", {}).get("configured") is False and (prev or {}).get("ai", {}).get("enabled") is False,
        str((prev or {}).get("ai")),
    )

    st, cap_prev = ask_preview("PWM 闪烁", "PWM", [cap_key_b])
    c.check(
        "预览 capture 返回正文且 resultText=null",
        st == 200
        and len((cap_prev or {}).get("records") or []) == 1
        and (cap_prev or {}).get("records", [{}])[0].get("type") == "capture"
        and (cap_prev or {}).get("records", [{}])[0].get("text") == cap_b_text
        and (cap_prev or {}).get("records", [{}])[0].get("resultText") is None,
        f"{st} {str(cap_prev)[:400]}",
    )
    st, unavailable = ask_preview("PWM 闪烁", "PWM", ["attempt:att-not-exist"])
    c.check("预览不存在来源返回 409 sources_unavailable", st == 409 and unavailable.get("error") == "sources_unavailable", f"{st} {unavailable}")

    # ============================================================ 5. 未配置生成
    print("\n### 5. 未配置模型生成")
    st, res = start_ask("PWM 闪烁调光时应该注意什么", "PWM", [key1, key2], token, operation_id=f"op-noai-{uid}")
    c.check("未配置模型创建问答返回 409 ai_not_configured", st == 409 and res.get("error") == "ai_not_configured", f"{st} {res}")
    c.check("未配置错误带说明", isinstance(res.get("message"), str) and bool(res.get("message")), str(res)[:200])

    # ============================================================ 6. 合法生成
    print("\n### 6. 配置 fake-ask 并生成")
    configure("fake-ask", name="问记录假模型")
    st, settings = client.get("/api/settings/ai")
    c.check("配置后 settings.modelId=fake-ask", st == 200 and settings.get("config", {}).get("modelId") == "fake-ask", f"{st} {settings}")

    st, candidates_ai = ask_candidates("PWM 闪烁", keywords="PWM")
    c.check(
        "候选接口显示 AI 已配置/启用",
        st == 200
        and (candidates_ai or {}).get("ai", {}).get("configured") is True
        and (candidates_ai or {}).get("ai", {}).get("enabled") is True
        and (candidates_ai or {}).get("ai", {}).get("config", {}).get("modelId") == "fake-ask",
        str((candidates_ai or {}).get("ai")),
    )

    st, prev2 = ask_preview("PWM 闪烁调光时应该注意什么", "PWM", [key1, key2])
    c.check("配置后预览返回 config", st == 200 and (prev2 or {}).get("config", {}).get("modelId") == "fake-ask", f"{st} {(prev2 or {}).get('config')}")
    c.check("配置变化后 contextToken 变化", (prev2 or {}).get("contextToken") != token, "token unchanged")
    token2 = (prev2 or {}).get("contextToken")

    st, created = start_ask(
        "PWM 闪烁调光时应该注意什么",
        "PWM",
        [key1, key2],
        token2,
        operation_id=f"op-legal-{uid}",
    )
    c.check(
        "合法生成返回 202 pending 且 replayed=false",
        st == 202 and (created or {}).get("query", {}).get("status") == "pending" and (created or {}).get("replayed") is False,
        f"{st} {created}",
    )
    legal_id = (created or {}).get("query", {}).get("id")
    c.check("创建响应带问答 id", isinstance(legal_id, str) and legal_id.startswith("ask-"), str(legal_id))
    st, detail = wait_ask(legal_id or "")
    legal = (detail or {}).get("query") or {}
    c.check("fake-ask 生成成功", st == 200 and legal.get("status") == "succeeded", f"{st} {legal.get('status')} {legal.get('errorCode')}")
    answer = legal.get("answer") or {}
    c.check("回答 summary 非空", isinstance(answer.get("summary"), str) and bool(answer.get("summary").strip()), str(answer.get("summary"))[:120])
    points = answer.get("points") or []
    observations = [p for p in points if p.get("basis") == "observation"]
    inferences = [p for p in points if p.get("basis") == "inference"]
    c.check("回答 points>=2", len(points) >= 2, str(len(points)))
    c.check("回答含 observation", len(observations) >= 1, str([p.get("basis") for p in points]))
    c.check("回答含 inference", len(inferences) >= 1, str([p.get("basis") for p in points]))
    if observations:
        obs = observations[0]
        c.check("observation.condition 非空", isinstance(obs.get("condition"), str) and bool(obs.get("condition").strip()), str(obs.get("condition")))
        c.check(
            "observation 文本来自发送记录的结果或步骤",
            any((r.get("resultText") and r["resultText"] in obs.get("text", "")) or (r.get("text") and r["text"] in obs.get("text", "")) for r in prev_records),
            str(obs.get("text"))[:200],
        )
    c.check(
        "所有 point sourceIds 都属于发送记录",
        all(set(p.get("sourceIds") or []) <= {key1, key2} for p in points),
        str([p.get("sourceIds") for p in points]),
    )
    c.check(
        "contradiction sides 也属于发送记录",
        all(set(side.get("sourceId") for side in item.get("sides") or []) <= {key1, key2} for item in answer.get("contradictions") or []),
        str(answer.get("contradictions")),
    )
    sources = legal.get("sources") or []
    c.check("sources 覆盖全部发送记录", {s.get("sourceKey") for s in sources} == {key1, key2}, str([s.get("sourceKey") for s in sources]))
    c.check(
        "sources 初始 exists=true/deleted=false",
        all(s.get("exists") is True and s.get("deleted") is False for s in sources),
        str(sources)[:400],
    )
    c.check(
        "sources.openHref 由 app 生成",
        all(isinstance(s.get("openHref"), str) and s["openHref"].startswith("/attempt/") for s in sources),
        str([s.get("openHref") for s in sources]),
    )
    def graph_focus_ok(source):
        href = source.get("graphHref")
        if not isinstance(href, str) or not href.startswith("/graph?"):
            return False
        query = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        values = query.get("node") or []
        return "focus" not in query and any(
            urllib.parse.unquote(value) == source.get("sourceKey") for value in values
        )

    c.check(
        "sources.graphHref 统一使用 /graph?node=来源键",
        all(graph_focus_ok(s) for s in sources),
        str([s.get("graphHref") for s in sources]),
    )
    c.check("回答记录目标模型 fake-ask", legal.get("config", {}).get("modelId") == "fake-ask", str(legal.get("config")))
    c.check("回答带 usage 与 durationMs", isinstance(legal.get("usage"), dict) and isinstance(legal.get("durationMs"), int), f"{legal.get('usage')} {legal.get('durationMs')}")
    c.check("回答带 createdAt/finishedAt", isinstance(legal.get("createdAt"), int) and isinstance(legal.get("finishedAt"), int), f"{legal.get('createdAt')} {legal.get('finishedAt')}")
    c.check("成功后 canCancel=false", legal.get("canCancel") is False, str(legal.get("canCancel")))

    st, detail2 = client.get(f"/api/ask/queries/{legal_id}")
    legal2 = (detail2 or {}).get("query") or {}
    c.check(
        "GET 详情与创建结果一致",
        st == 200
        and legal2.get("id") == legal_id
        and legal2.get("status") == "succeeded"
        and legal2.get("answer", {}).get("summary") == answer.get("summary")
        and len(legal2.get("sources") or []) == 2,
        f"{st} {str(legal2)[:300]}",
    )

    st, listing = client.get("/api/ask/queries?limit=50")
    listed = next((x for x in (listing or {}).get("queries") or [] if x.get("id") == legal_id), None)
    c.check(
        "最近列表包含本次问答",
        st == 200
        and listed is not None
        and listed.get("status") == "succeeded"
        and listed.get("sourceCount") == 2
        and listed.get("summary") == answer.get("summary")
        and listed.get("insufficientEvidence") is False,
        f"{st} {listed}",
    )

    prompt = fake_user_prompt()
    c.check("真实 prompt 含「用户的问题：」", "用户的问题：" in prompt, prompt[:160])
    c.check("真实 prompt 含两条已选记录稳定键", f"[{key1}]" in prompt and f"[{key2}]" in prompt, prompt[:400])
    c.check("真实 prompt 含已选记录正文", step1 in prompt and step2 in prompt and result1 in prompt and result2 in prompt, prompt[:600])
    c.check("真实 prompt 不含未选念头正文", cap_b_text not in prompt and f"ASKUNSELECTED-{uid}" not in prompt, "unselected capture leaked")
    c.check("真实 prompt 不含未选无结果尝试", step3 not in prompt and f"ASKEMPTY-{uid}" not in prompt, "unselected attempt leaked")
    c.check(
        "preview.selectedChars 与真实 user prompt 长度一致",
        isinstance(coverage.get("selectedChars"), int) and len(prompt) == coverage.get("selectedChars"),
        f"{len(prompt)} vs {coverage.get('selectedChars')}",
    )
    c.check("真实 prompt 不含明文密钥", SECRET_KEY not in prompt, "leak")

    # 来源编辑：只 changed，不 invalidated；快照正文保持发送时内容
    status, edited_res = client.patch(
        f"/api/attempts/{att2['id']}",
        {"revision": att2["revision"], "resultText": result2 + "（已编辑）", "outcome": "success"},
    )
    c.check("编辑合法问答的来源成功", status == 200, f"{status} {edited_res}")
    if status == 200:
        att2 = edited_res["attempt"]
    st, edited_detail = client.get(f"/api/ask/queries/{legal_id}")
    edited_query = (edited_detail or {}).get("query") or {}
    edited_source = next(
        (s for s in edited_query.get("sources") or [] if s.get("sourceKey") == key2), None
    )
    c.check("来源编辑后 changed=true", edited_source is not None and edited_source.get("changed") is True, str(edited_source))
    c.check("来源编辑后 deleted=false", edited_source is not None and edited_source.get("deleted") is False, str(edited_source))
    c.check("来源编辑不触发 answerInvalidated", edited_query.get("answerInvalidated") is False, str(edited_query.get("answerInvalidated")))
    c.check("来源编辑不隐藏观点", edited_query.get("hiddenPointCount") == 0, str(edited_query.get("hiddenPointCount")))
    c.check(
        "来源编辑后仍展示发送时快照正文",
        edited_source is not None and edited_source.get("resultText") == result2,
        str(edited_source.get("resultText") if edited_source else None),
    )
    st, context_changed = start_ask(
        "PWM 闪烁调光时应该注意什么",
        "PWM",
        [key1, key2],
        token2,
        operation_id=f"op-context-changed-{uid}",
    )
    c.check(
        "预览后来源版本变化返回 409 context_changed",
        st == 409 and context_changed.get("error") == "context_changed",
        f"{st} {context_changed}",
    )

    # ============================================================ 7. 证据不足
    print("\n### 7. 证据不足")
    configure("fake-ask-insufficient")
    st, ins_prev = ask_preview("没有结果的尝试说明了什么", "", [cap_key_b, key3])
    c.check("无证据预览返回 capture 与空结果 attempt", st == 200 and len((ins_prev or {}).get("records") or []) == 2, f"{st} {str(ins_prev)[:300]}")
    st, ins_created = start_ask(
        "没有结果的尝试说明了什么",
        "",
        [cap_key_b, key3],
        (ins_prev or {}).get("contextToken"),
        operation_id=f"op-insufficient-{uid}",
    )
    c.check("证据不足问答返回 202", st == 202, f"{st} {ins_created}")
    ins_id = (ins_created or {}).get("query", {}).get("id")
    st, ins_detail = wait_ask(ins_id or "")
    ins = (ins_detail or {}).get("query") or {}
    c.check("证据不足问答成功", st == 200 and ins.get("status") == "succeeded", f"{st} {ins.get('status')} {ins.get('errorCode')}")
    ins_answer = ins.get("answer") or {}
    c.check("insufficientEvidence=true", ins_answer.get("insufficientEvidence") is True, str(ins_answer.get("insufficientEvidence")))
    c.check("证据不足 missing 非空", isinstance(ins_answer.get("missing"), list) and len(ins_answer.get("missing") or []) > 0, str(ins_answer.get("missing")))
    c.check("证据不足 points 为空", ins_answer.get("points") == [], str(ins_answer.get("points")))
    c.check("证据不足 contradictions 为空", ins_answer.get("contradictions") == [], str(ins_answer.get("contradictions")))
    c.check("证据不足 summary 非空", isinstance(ins_answer.get("summary"), str) and bool(ins_answer.get("summary").strip()), str(ins_answer.get("summary"))[:120])
    c.check("证据不足来源包含 capture 与空结果 attempt", {s.get("sourceKey") for s in ins.get("sources") or []} == {cap_key_b, key3}, str([s.get("sourceKey") for s in ins.get("sources") or []]))

    # ============================================================ 8. 矛盾
    print("\n### 8. 矛盾来源")
    configure("fake-ask-contradiction")
    st, con_prev = ask_preview("两次 PWM 结果为什么不一样", "PWM", [key1, key2])
    st, con_created = start_ask(
        "两次 PWM 结果为什么不一样",
        "PWM",
        [key1, key2],
        (con_prev or {}).get("contextToken"),
        operation_id=f"op-contradiction-{uid}",
    )
    c.check("矛盾问答返回 202", st == 202, f"{st} {con_created}")
    con_id = (con_created or {}).get("query", {}).get("id")
    st, con_detail = wait_ask(con_id or "")
    con = (con_detail or {}).get("query") or {}
    c.check("矛盾问答成功", st == 200 and con.get("status") == "succeeded", f"{st} {con.get('status')} {con.get('errorCode')}")
    con_answer = con.get("answer") or {}
    contradictions = con_answer.get("contradictions") or []
    c.check("contradictions 至少 1 条", len(contradictions) >= 1, str(len(contradictions)))
    if contradictions:
        sides = contradictions[0].get("sides") or []
        c.check("矛盾 sides 恰好 2 个", len(sides) == 2, str(sides))
        c.check("矛盾 text 非空", isinstance(contradictions[0].get("text"), str) and bool(contradictions[0].get("text").strip()), str(contradictions[0].get("text"))[:120])
        c.check("每个 side condition 非空", all(isinstance(s.get("condition"), str) and s.get("condition").strip() for s in sides), str(sides))
        c.check("每个 side sourceId 合法", all(s.get("sourceId") in {key1, key2} for s in sides), str(sides))
        c.check("两个 side 指向不同来源", len({s.get("sourceId") for s in sides}) == 2, str(sides))

    # ============================================================ 9. 编造来源
    print("\n### 9. 模型编造来源")
    configure("fake-ask-bad-source")
    st, bad_prev = ask_preview("PWM 闪烁", "PWM", [key1, key2])
    st, bad_created = start_ask(
        "PWM 闪烁",
        "PWM",
        [key1, key2],
        (bad_prev or {}).get("contextToken"),
        operation_id=f"op-bad-{uid}",
    )
    bad_id = (bad_created or {}).get("query", {}).get("id")
    st, bad_detail = wait_ask(bad_id or "")
    bad = (bad_detail or {}).get("query") or {}
    c.check("编造来源问答 failed", st == 200 and bad.get("status") == "failed", f"{st} {bad.get('status')}")
    c.check("编造来源 errorCode=invalid_response", bad.get("errorCode") == "invalid_response", str(bad.get("errorCode")))
    c.check("编造来源 answer=null", bad.get("answer") is None, str(bad.get("answer"))[:200])
    c.check("编造来源 errorMessage 非空", isinstance(bad.get("errorMessage"), str) and bool(bad.get("errorMessage").strip()), str(bad.get("errorMessage"))[:120])

    # ============================================================ 10. 超时
    print("\n### 10. 模型超时")
    configure("fake-ask-timeout")
    st, to_prev = ask_preview("PWM 闪烁超时", "PWM", [key1, key2])
    st, to_created = start_ask(
        "PWM 闪烁超时",
        "PWM",
        [key1, key2],
        (to_prev or {}).get("contextToken"),
        operation_id=f"op-timeout-{uid}",
    )
    c.check("超时场景创建返回 202 pending", st == 202 and (to_created or {}).get("query", {}).get("status") == "pending", f"{st} {str(to_created)[:200]}")
    to_id = (to_created or {}).get("query", {}).get("id")
    st, to_detail = wait_ask(to_id or "", timeout=15.0)
    to = (to_detail or {}).get("query") or {}
    c.check("超时问答结束为 failed", st == 200 and to.get("status") == "failed", f"{st} {to.get('status')}")
    c.check("超时 errorCode=timeout", to.get("errorCode") == "timeout", str(to.get("errorCode")))
    c.check("超时 answer=null", to.get("answer") is None, str(to.get("answer"))[:200])
    c.check("超时 durationMs 为整数", isinstance(to.get("durationMs"), int) and to.get("durationMs") >= 0, str(to.get("durationMs")))
    c.check("超时带 finishedAt", isinstance(to.get("finishedAt"), int), str(to.get("finishedAt")))

    # ============================================================ 11. 取消
    print("\n### 11. 取消")
    st, cancel_prev = ask_preview("PWM 闪烁取消", "PWM", [key1, key2])
    st, cancel_created = start_ask(
        "PWM 闪烁取消",
        "PWM",
        [key1, key2],
        (cancel_prev or {}).get("contextToken"),
        operation_id=f"op-cancel-{uid}",
    )
    cancel_id = (cancel_created or {}).get("query", {}).get("id")
    c.check("取消场景创建返回 202 pending", st == 202 and (cancel_created or {}).get("query", {}).get("status") == "pending", f"{st} {str(cancel_created)[:200]}")

    st2, cancel2_created = start_ask(
        "PWM 闪烁取消",
        "PWM",
        [key1, key2],
        (cancel_prev or {}).get("contextToken"),
        operation_id=f"op-cancel2-{uid}",
    )
    c.check("第二个慢任务进入 pending", st2 == 202, f"{st2} {cancel2_created}")
    st3, too_many = start_ask(
        "PWM 闪烁取消",
        "PWM",
        [key1, key2],
        (cancel_prev or {}).get("contextToken"),
        operation_id=f"op-cancel3-{uid}",
    )
    c.check(
        "pending 达到 2 时第三个返回 429 too_many_queries",
        st3 == 429 and too_many.get("error") == "too_many_queries",
        f"{st3} {too_many}",
    )
    if st2 == 202:
        status2, cancel2_res = client.post(
            f"/api/ask/queries/{cancel2_created['query']['id']}/cancel", {}
        )
        c.check(
            "第二个慢任务可取消",
            status2 == 200,
            f"{status2} {cancel2_res}",
        )
    status, cancel_res = client.post(f"/api/ask/queries/{cancel_id}/cancel", {})
    cancel_query = (cancel_res or {}).get("query") or {}
    c.check(
        "POST cancel 立即返回 cancelled",
        status == 200 and cancel_query.get("status") == "cancelled" and cancel_query.get("errorCode") == "cancelled",
        f"{status} {str(cancel_res)[:300]}",
    )
    c.check("取消后 canCancel=false", cancel_query.get("canCancel") is False, str(cancel_query.get("canCancel")))
    time.sleep(1.6)
    status, later = client.get(f"/api/ask/queries/{cancel_id}")
    c.check("等待 1.6s 后仍为 cancelled（不复活）", status == 200 and (later or {}).get("query", {}).get("status") == "cancelled", f"{status} {str(later)[:200]}")
    status, recancel = client.post(f"/api/ask/queries/{cancel_id}/cancel", {})
    c.check("已结束再 cancel 返回 409 not_cancellable", status == 409 and recancel.get("error") == "not_cancellable", f"{status} {recancel}")

    # ============================================================ 12. operationId 回放
    print("\n### 12. operationId 回放与冲突")
    configure("fake-ask")
    st, replay_prev = ask_preview("PWM 闪烁回放", "PWM", [key1, key2])
    replay_token = (replay_prev or {}).get("contextToken")
    replay_op = f"op-replay-{uid}"
    st, replay_created = start_ask(
        "PWM 闪烁回放", "PWM", [key1, key2], replay_token, operation_id=replay_op
    )
    c.check("回放场景首次创建 202", st == 202, f"{st} {replay_created}")
    replay_id = (replay_created or {}).get("query", {}).get("id")
    st, replay_detail = wait_ask(replay_id or "")
    c.check("回放场景首次生成成功", st == 200 and (replay_detail or {}).get("query", {}).get("status") == "succeeded", str((replay_detail or {}).get("query", {}).get("status")))
    st, replayed = start_ask(
        "PWM 闪烁回放", "PWM", [key1, key2], replay_token, operation_id=replay_op
    )
    c.check(
        "相同 operationId/payload 回放返回 200 replayed=true",
        st == 200 and (replayed or {}).get("replayed") is True and (replayed or {}).get("query", {}).get("id") == replay_id,
        f"{st} {str(replayed)[:300]}",
    )
    c.check("回放返回已成功的同一问答", (replayed or {}).get("query", {}).get("status") == "succeeded", str((replayed or {}).get("query", {}).get("status")))
    st, conflict = start_ask(
        "换一个完全不同的问题", "PWM", [key1, key2], replay_token, operation_id=replay_op
    )
    c.check(
        "相同 operationId 不同 payload 返回 409 operation_key_conflict",
        st == 409 and conflict.get("error") == "operation_key_conflict",
        f"{st} {conflict}",
    )

    # ============================================================ 13. 来源删除
    print("\n### 13. 来源被删除")
    c.check("删除前准备：合法问答仍为成功", legal.get("status") == "succeeded", str(legal.get("status")))

    # 单来源问答：删除后所有 point 都失去来源，便于精确断言 hiddenPointCount
    configure("fake-ask")
    st, del_prev = ask_preview("只含一条来源的删除检查", "PWM", [key1])
    st, del_created = start_ask(
        "只含一条来源的删除检查",
        "PWM",
        [key1],
        (del_prev or {}).get("contextToken"),
        operation_id=f"op-del-single-{uid}",
    )
    c.check("单来源删除测试问答创建 202", st == 202, f"{st} {del_created}")
    del_id = (del_created or {}).get("query", {}).get("id")
    st, del_detail_before = wait_ask(del_id or "")
    c.check(
        "单来源删除测试问答生成成功",
        st == 200 and (del_detail_before or {}).get("query", {}).get("status") == "succeeded",
        str((del_detail_before or {}).get("query", {}).get("status")),
    )

    status, _ = client.delete(f"/api/attempts/{att1['id']}")
    c.check("删除被引用来源 attempt 成功", status == 200, str(status))
    st, deleted_detail = client.get(f"/api/ask/queries/{legal_id}")
    deleted = (deleted_detail or {}).get("query") or {}
    deleted_sources = {s.get("sourceKey"): s for s in deleted.get("sources") or []}
    src1 = deleted_sources.get(key1) or {}
    src2 = deleted_sources.get(key2) or {}
    c.check("删除来源后问答详情仍可打开", st == 200, str(st))
    c.check("被删除来源 deleted=true/exists=false", src1.get("deleted") is True and src1.get("exists") is False, str(src1))
    c.check("被删除来源 title=来源已删除", src1.get("title") == "来源已删除", str(src1.get("title")))
    c.check("被删除来源 text/resultText 为 null", src1.get("text") is None and src1.get("resultText") is None, str(src1)[:300])
    c.check("被删除来源 openHref/graphHref 为 null", src1.get("openHref") is None and src1.get("graphHref") is None, str(src1)[:300])
    c.check("其他来源仍可打开", src2.get("deleted") is False and isinstance(src2.get("openHref"), str) and src2.get("openHref") == f"/attempt/{att2['id']}", str(src2)[:300])
    c.check("answerInvalidated=true", deleted.get("answerInvalidated") is True, str(deleted.get("answerInvalidated")))
    c.check("answerInvalidReason 非空", isinstance(deleted.get("answerInvalidReason"), str) and bool(deleted.get("answerInvalidReason").strip()), str(deleted.get("answerInvalidReason"))[:120])
    c.check(
        "回答里保留的 point 不再引用已删除来源",
        all(key1 not in (p.get("sourceIds") or []) for p in deleted.get("answer", {}).get("points") or []),
        str(deleted.get("answer", {}).get("points"))[:300],
    )

    st, del_detail = client.get(f"/api/ask/queries/{del_id}")
    del_query = (del_detail or {}).get("query") or {}
    c.check(
        "完全失去来源的 points 全部隐藏并计数",
        del_query.get("hiddenPointCount") == 2
        and (del_query.get("answer") or {}).get("points") == []
        and isinstance((del_query.get("answer") or {}).get("summary"), str),
        f"hidden={del_query.get('hiddenPointCount')} points={(del_query.get('answer') or {}).get('points')}",
    )
    if db_usable():
        row_del = db_query_row(del_id or "")
        c.check("数据库存在该问答行", row_del is not None, str(del_id))
        if row_del:
            snapshots = json.loads(row_del.get("sources_json") or "[]")
            c.check(
                "数据库 sources_json 正文已清空",
                len(snapshots) == 1
                and snapshots[0].get("deleted") is True
                and snapshots[0].get("text") == ""
                and snapshots[0].get("resultText") is None
                and snapshots[0].get("captureText") == "",
                str(snapshots)[:400],
            )
            c.check("数据库 answer_json 仍保留模型正文", bool(row_del.get("answer_json")), "answer_json 不应被删除")
    else:
        print("SKIP  外部服务未提供同一测试库，跳过 sources_json 直接断言")

    st, list_after_delete = client.get("/api/ask/queries?limit=50")
    listed_del = next((x for x in (list_after_delete or {}).get("queries") or [] if x.get("id") == legal_id), None)
    c.check("列表标记 deletedSourceCount=1", listed_del is not None and listed_del.get("deletedSourceCount") == 1, str(listed_del))
    st, unavailable_after = ask_preview("PWM 闪烁", "PWM", [key1])
    c.check(
        "删除来源后再次预览返回 409 sources_unavailable",
        st == 409 and unavailable_after.get("error") == "sources_unavailable",
        f"{st} {unavailable_after}",
    )

    # capture 来源删除：snapshot 正文与所属念头正文都清空
    cap_del = create_capture("待删除的 capture 来源：整理旧记录")
    cap_del_key = f"capture:{cap_del['id']}"
    st, cap_prev = ask_preview("capture 来源删除检查", "整理", [cap_del_key])
    st, cap_created = start_ask(
        "capture 来源删除检查",
        "整理",
        [cap_del_key],
        (cap_prev or {}).get("contextToken"),
        operation_id=f"op-del-capture-{uid}",
    )
    c.check("capture 来源问答创建 202", st == 202, f"{st} {cap_created}")
    cap_query_id = (cap_created or {}).get("query", {}).get("id")
    st, cap_before = wait_ask(cap_query_id or "")
    c.check(
        "capture 来源问答生成成功",
        st == 200 and (cap_before or {}).get("query", {}).get("status") == "succeeded",
        str((cap_before or {}).get("query", {}).get("status")),
    )
    status, _ = client.delete(f"/api/captures/{cap_del['id']}")
    c.check("删除 capture 来源成功", status == 200, str(status))
    st, cap_detail = client.get(f"/api/ask/queries/{cap_query_id}")
    cap_query = (cap_detail or {}).get("query") or {}
    cap_src = (cap_query.get("sources") or [{}])[0]
    c.check(
        "删除 capture 后来源清洗并隐藏观点",
        cap_src.get("deleted") is True
        and cap_src.get("text") is None
        and cap_query.get("answerInvalidated") is True
        and cap_query.get("hiddenPointCount") == 2,
        f"{cap_src} hidden={cap_query.get('hiddenPointCount')}",
    )
    if db_usable():
        row_cap = db_query_row(cap_query_id or "")
        c.check("数据库存在 capture 问答行", row_cap is not None, str(cap_query_id))
        if row_cap:
            cap_snapshot = (json.loads(row_cap.get("sources_json") or "[]") or [{}])[0]
            c.check(
                "capture sources_json 正文与念头正文清空",
                cap_snapshot.get("deleted") is True
                and cap_snapshot.get("text") == ""
                and cap_snapshot.get("captureText") == "",
                str(cap_snapshot)[:300],
            )
    else:
        print("SKIP  外部服务未提供同一测试库，跳过 capture sources_json 直接断言")

    # ============================================================ 14. 恢复配置
    print("\n### 14. 恢复 AI 配置")
    status, _ = delete_ai()
    c.check("测试结束删除 AI 配置成功", status == 200, str(status))
    st, settings_end = client.get("/api/settings/ai")
    c.check("测试结束 AI 恢复为未配置", st == 200 and settings_end.get("configured") is False, f"{st} {settings_end}")

    ok = c.report("问我的记录验收")
    return 0 if ok else 1


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # noqa: BLE001 - 测试脚本需要打印真实异常
        print(f"\nERROR 测试执行异常：{exc}")
        traceback.print_exc()
        exit_code = 1
    finally:
        # 即使中途失败也清理本次配置，避免影响后续套件（同一会话即可）
        try:
            client.delete("/api/settings/ai")
        except Exception:  # noqa: BLE001
            pass
        stop_fake_server()
        stop_test_server()
    sys.exit(exit_code)
