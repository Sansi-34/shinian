"""拾念 SHINIAN · AI 辅助流程验收测试

针对运行中的测试服务（SHINIAN_BASE，默认 http://127.0.0.1:3100）执行契约验收。
脚本自行启动/停止 scripts/fake_model_server.py（默认 127.0.0.1:3501）。

覆盖 docs/ai-api-contract.md §5/§6/§9：
- 未配置模型时的手动闭环不回归
- 设置保存/密钥加密/主密钥/测试过期/清除配置
- Base URL 规范化与本地地址/重定向策略
- 连接测试成功/认证失败/超时/格式不支持/模型不可用
- 三类建议、无效输出、超时/认证失败
- 采用/重复采用/过期采用/不可采用
- 并发、取消、迟到响应、幂等重复点击
- latest 恢复、删除关联、密钥不泄露、24 条场景
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
from contextlib import closing

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test.sqlite")
SERVER_LOG = os.environ.get("SHINIAN_TEST_LOG") or os.path.join(ROOT, "db", "test-server.log")
SCENARIOS_PATH = os.path.join(ROOT, "scripts", "ai_scenarios.json")
NODE = shutil.which("node") or "node"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")

SECRET_KEY = "test-secret-key"
SECRET_KEY_2 = "test-secret-key-2"
WRONG_KEY = "wrong-key-for-auth-test"
SECRETS = [("primary", SECRET_KEY), ("replacement", SECRET_KEY_2), ("wrong", WRONG_KEY)]

AI_TIMEOUT_MS = int(os.environ.get("SHINIAN_AI_TIMEOUT_MS", "60000") or 60000)
AI_TEST_TIMEOUT_MS = int(os.environ.get("SHINIAN_AI_TEST_TIMEOUT_MS", "20000") or 20000)

c = Checker()
client = Client(base=BASE)
uid = uuid.uuid4().hex[:8]

RESPONSE_TEXTS = []
_orig_request = client.request


def recorded_request(method, path, data=None):
    status, res = _orig_request(method, path, data)
    try:
        RESPONSE_TEXTS.append(json.dumps(res, ensure_ascii=False))
    except (TypeError, ValueError):
        RESPONSE_TEXTS.append(str(res))
    return status, res


client.request = recorded_request

fake_proc = None
fake_owned = False


# ---------------------------------------------------------------- 基础工具
def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_port(host: str, port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            return True
        time.sleep(0.15)
    return False


def fake_get(path: str):
    with urllib.request.urlopen(FAKE_BASE + path, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


def fake_last():
    payload = fake_get("/__last")
    return payload.get("request")


def start_fake_server():
    """启动假模型服务。若 3501 已有同款服务则复用（不杀不是自己启动的进程）。"""
    global fake_proc, fake_owned
    if port_open("127.0.0.1", FAKE_PORT):
        try:
            health = fake_get("/__health")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"端口 {FAKE_PORT} 已被占用且不是 fake model server：{exc}")
        if health.get("service") == "shinian-fake-model":
            print(f"复用已在运行的 fake model server: {FAKE_BASE}")
            return
        raise RuntimeError(f"端口 {FAKE_PORT} 已被其他进程占用")
    fake_proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts", "fake_model_server.py")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port("127.0.0.1", FAKE_PORT, 20):
        raise RuntimeError("fake model server 未能启动")
    fake_owned = True
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


def db_rows(sql: str, params=()):
    if not os.path.exists(TEST_DB):
        return []
    with closing(sqlite3.connect(TEST_DB, timeout=15)) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def db_scalar(sql: str, params=(), default=None):
    rows = db_rows(sql, params)
    return rows[0].get("v") if rows else default


def db_file_bytes() -> bytes:
    chunks = []
    for suffix in ("", "-wal", "-shm"):
        path = TEST_DB + suffix
        if os.path.exists(path):
            with open(path, "rb") as fh:
                chunks.append(fh.read())
    return b"".join(chunks)


def master_key_file() -> str:
    env_path = os.environ.get("SHINIAN_MASTER_KEY_FILE")
    if env_path:
        return env_path if os.path.isabs(env_path) else os.path.join(ROOT, env_path)
    test_default = os.path.join(ROOT, "db", "test-master.key")
    if os.path.exists(test_default):
        return test_default
    return os.path.join(ROOT, "db", "master.key")


def save_settings(model="fake-success", api_key=None, base_url=None, allow_local=True, name="测试模型"):
    payload = {
        "name": name,
        "baseUrl": base_url if base_url is not None else f"{FAKE_BASE}/v1",
        "modelId": model,
        "enabled": True,
        "allowLocal": allow_local,
    }
    if api_key is not None:
        payload["apiKey"] = api_key
    return client.request("PUT", "/api/settings/ai", payload)


def configure(model: str, api_key=None, allow_local=True):
    st, res = save_settings(model=model, api_key=api_key, allow_local=allow_local)
    assert st == 200, f"保存配置失败 {st} {res}"
    return res


def create_capture(text: str):
    st, res = client.post("/api/captures", {"rawText": text})
    assert st == 200, f"创建念头失败 {st} {res}"
    return res["capture"]


def suggest(capture: dict, constraint=None, operation_id=None):
    payload = {
        "captureRevision": capture["revision"],
        "operationId": operation_id or f"op-gen-{uuid.uuid4().hex[:12]}",
    }
    if constraint is not None and constraint != "":
        payload["constraint"] = constraint
    return client.post(f"/api/captures/{capture['id']}/suggestions", payload)


TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def wait_generation(gen_id: str, timeout: float = 25.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        st, res = client.get(f"/api/generations/{gen_id}")
        if st != 200:
            return st, res
        last = (res or {}).get("generation")
        if last and last.get("status") in TERMINAL:
            return st, res
        time.sleep(0.25)
    return 200, {"generation": last, "_poll_timeout": True}


def check_generation_shape(label: str, gen: dict):
    required = {
        "id",
        "captureId",
        "captureRevision",
        "inputText",
        "constraint",
        "configId",
        "configVersion",
        "configName",
        "modelId",
        "status",
        "kind",
        "suggestion",
        "errorCode",
        "errorMessage",
        "usage",
        "durationMs",
        "adoptedAttemptId",
        "adoptedAt",
        "dismissedAt",
        "isExpired",
        "createdAt",
        "finishedAt",
    }
    c.check(f"{label}：公开对象字段齐全", required <= set(gen.keys()), str(sorted(required - set(gen.keys()))))
    usage = gen.get("usage") or {}
    c.check(
        f"{label}：usage 三项均为整数",
        all(isinstance(usage.get(k), int) for k in ("inputTokens", "outputTokens", "totalTokens")),
        str(usage),
    )
    c.check(f"{label}：durationMs 为非负整数", isinstance(gen.get("durationMs"), int) and gen["durationMs"] >= 0, str(gen.get("durationMs")))
    c.check(f"{label}：isExpired=false", gen.get("isExpired") is False, str(gen.get("isExpired")))


# ---------------------------------------------------------------- 独立日志检查（无 SHINIAN_TEST_LOG 时）
def independent_log_check() -> str:
    """启动一个独立 3199 实例，制造配置/测试/生成请求，返回其日志文本。"""
    port = 3199
    if port_open("127.0.0.1", port):
        raise RuntimeError(f"独立日志检查端口 {port} 被占用")
    db_path = os.path.join(ROOT, "db", "ai-logcheck.sqlite")
    key_path = os.path.join(ROOT, "db", "ai-logcheck-master.key")
    log_path = os.path.join(ROOT, "db", "ai-logcheck-server.log")
    for path in (db_path, db_path + "-wal", db_path + "-shm", key_path, log_path):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    env = dict(os.environ)
    env.update(
        {
            "PORT": str(port),
            "DATABASE_URL": db_path,
            "SHINIAN_MASTER_KEY_FILE": key_path,
            "SHINIAN_AI_TEST_TIMEOUT_MS": "800",
            "SHINIAN_AI_TIMEOUT_MS": "1200",
        }
    )
    log_handle = open(log_path, "wb")
    proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    try:
        ready = False
        for _ in range(100):
            if proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/session/check", timeout=1)
                ready = True
                break
            except urllib.error.HTTPError:
                ready = True
                break
            except Exception:
                time.sleep(0.2)
        if not ready:
            raise RuntimeError("独立日志检查服务未能启动")
        cl = Client(base=f"http://127.0.0.1:{port}")
        cl.login("日志检查用户")
        st, res = cl.request(
            "PUT",
            "/api/settings/ai",
            {
                "name": "日志检查",
                "baseUrl": f"{FAKE_BASE}/v1",
                "modelId": "fake-success",
                "apiKey": "log-fallback-secret-key",
                "allowLocal": True,
                "enabled": True,
            },
        )
        if st != 200:
            raise RuntimeError(f"独立日志检查保存配置失败 {st} {res}")
        cl.post("/api/settings/ai/test", {})
        cap = cl.post("/api/captures", {"rawText": "独立日志检查念头"})[1]["capture"]
        cl.post(
            f"/api/captures/{cap['id']}/suggestions",
            {"captureRevision": cap["revision"], "operationId": "op-logcheck"},
        )
        time.sleep(0.5)
    finally:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        log_handle.close()
        time.sleep(0.2)

    with open(log_path, "rb") as fh:
        text = fh.read().decode("utf-8", "replace")
    for path in (db_path, db_path + "-wal", db_path + "-shm", key_path):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    return text


# ---------------------------------------------------------------- 主流程
def main() -> int:
    global fake_owned
    print(f"测试服务: {BASE}")
    print(f"测试库: {TEST_DB}")
    print(f"服务日志: {SERVER_LOG}")
    c.check("测试环境已设置 AI 测试超时（<=5s）", 0 < AI_TEST_TIMEOUT_MS <= 5000, f"SHINIAN_AI_TEST_TIMEOUT_MS={AI_TEST_TIMEOUT_MS}")
    c.check("测试环境已设置 AI 生成超时（<=5s）", 0 < AI_TIMEOUT_MS <= 5000, f"SHINIAN_AI_TIMEOUT_MS={AI_TIMEOUT_MS}")

    start_fake_server()

    body = client.login("AI 测试用户")
    c.check("创建/登录本机账号", body.get("ok") is True, str(body))

    # 确保从未配置状态开始
    client.delete("/api/settings/ai")

    # ============================================================ a. 未配置手动闭环
    print("\n### a. 未配置模型时的手动闭环")
    st, res = client.get("/api/settings/ai")
    c.check("GET 未配置返回 200", st == 200, f"{st} {res}")
    c.check("未配置时 configured=false / config=null", res.get("configured") is False and res.get("config") is None, str(res))
    c.check("未配置仍返回 masterKey/limits", isinstance(res.get("masterKey"), dict) and res.get("limits", {}).get("maxCaptureChars") == 4000, str(res))

    manual_text = f"手动闭环-{uid}：PWM 低占空比时 LED 会闪"
    cap_manual = create_capture(manual_text)
    c.check("未配置时可保存念头", cap_manual["rawText"] == manual_text and cap_manual["revision"] == 1)
    st, res = client.post(
        f"/api/captures/{cap_manual['id']}/attempts",
        {"step": "手动比较两种 PWM 频率", "state": "todo", "operationId": f"op-manual-{uid}"},
    )
    c.check("未配置时可创建尝试", st == 200 and res.get("attempt", {}).get("captureId") == cap_manual["id"], f"{st} {res}")
    att_manual = res["attempt"]
    st, res = client.patch(
        f"/api/attempts/{att_manual['id']}",
        {
            "state": "done",
            "resultText": f"手动结果 MANUALTOKEN{uid}：2 kHz 肉眼未见闪烁",
            "outcome": "success",
            "revision": att_manual["revision"],
        },
    )
    c.check("未配置时可记录结果", st == 200 and res.get("attempt", {}).get("outcome") == "success", f"{st} {res}")
    st, res = client.get(f"/api/search?q=MANUALTOKEN{uid}")
    c.check(
        "未配置时搜索能找回结果与念头",
        st == 200 and any(a["id"] == att_manual["id"] for a in res.get("attempts", [])),
        str(res)[:300],
    )

    # ============================================================ b. 设置与密钥
    print("\n### b. 保存配置 / 密钥加密 / 测试过期 / 清除配置")
    st, res = save_settings(api_key=SECRET_KEY)
    c.check("首次保存配置返回 200", st == 200, f"{st} {res}")
    config = res.get("config") or {}
    version1 = config.get("configVersion")
    c.check(
        "保存后 configured=true 且规则字段正确",
        res.get("configured") is True
        and config.get("baseUrl") == f"{FAKE_BASE}/v1"
        and config.get("modelId") == "fake-success"
        and config.get("allowLocal") is True
        and config.get("hasApiKey") is True,
        str(config),
    )
    c.check(
        "设置响应不含明文 API Key / ciphertext / fingerprint 字段",
        SECRET_KEY not in json.dumps(res, ensure_ascii=False)
        and "apiKey" not in json.dumps(res, ensure_ascii=False)
        and "api_key_ciphertext" not in json.dumps(res, ensure_ascii=False)
        and "api_key_fingerprint" not in json.dumps(res, ensure_ascii=False),
        json.dumps(res, ensure_ascii=False)[:400],
    )

    key_path = master_key_file()
    c.check("主密钥文件存在", os.path.isfile(key_path), key_path)
    if os.path.isfile(key_path):
        key_text = open(key_path, "r", encoding="utf-8").read().strip()
        c.check("主密钥为 64 位小写 hex", len(key_text) == 64 and all(ch in "0123456789abcdef" for ch in key_text), key_text[:12] + "...")
    st, res = client.get("/api/settings/ai")
    c.check(
        "GET 返回 masterKey.exists=true 且路径一致",
        res.get("masterKey", {}).get("exists") is True and res.get("masterKey", {}).get("path") == key_path,
        str(res.get("masterKey")),
    )

    rows = db_rows("SELECT api_key_ciphertext AS c, api_key_fingerprint AS f FROM ai_settings WHERE id='default'")
    c.check("数据库中存在 default 配置", len(rows) == 1, str(rows))
    if rows:
        ciphertext = rows[0]["c"] or ""
        fingerprint = rows[0]["f"] or ""
        c.check("api_key_ciphertext 为 v1 格式密文", ciphertext.startswith("v1.") and len(ciphertext.split(".")) == 4, ciphertext[:20])
        c.check("数据库密文不含明文 key", SECRET_KEY not in ciphertext, ciphertext[:20])
        c.check("api_key_fingerprint 为 16 位 hex 且不是明文", len(fingerprint) == 16 and all(ch in "0123456789abcdef" for ch in fingerprint.lower()), fingerprint)
    blob = db_file_bytes()
    c.check("数据库文件（含 WAL）不含明文 key", SECRET_KEY.encode("utf-8") not in blob, f"db bytes={len(blob)}")

    st, res = client.post("/api/settings/ai/test", {})
    c.check("保存后连接测试成功", st == 200 and res.get("test", {}).get("status") == "success", f"{st} {res}")
    st, res = client.get("/api/settings/ai")
    c.check("刚测试完 stale=false", res.get("config", {}).get("test", {}).get("stale") is False, str(res.get("config", {}).get("test")))

    st, res = save_settings(api_key=SECRET_KEY_2)
    version2 = (res.get("config") or {}).get("configVersion")
    c.check("替换密钥后 configVersion 递增", st == 200 and isinstance(version2, int) and version2 > (version1 or 0), f"{version1} -> {version2}")
    st, res = client.get("/api/settings/ai")
    c.check("替换密钥后旧测试 stale=true", res.get("config", {}).get("test", {}).get("stale") is True, str(res.get("config", {}).get("test")))

    st, res = client.delete("/api/settings/ai")
    c.check("清除配置返回 ok", st == 200 and res.get("ok") is True, f"{st} {res}")
    st, res = client.get("/api/settings/ai")
    c.check("清除后 configured=false", st == 200 and res.get("configured") is False and res.get("config") is None, f"{st} {res}")
    cap_reject = create_capture(f"清除配置后生成应被拒绝 {uid}")
    st, res = suggest(cap_reject, operation_id=f"op-noconfig-{uid}")
    c.check("清除配置后生成被拒绝 409 ai_not_configured", st == 409 and res.get("error") == "ai_not_configured", f"{st} {res}")

    st, res = save_settings(api_key=SECRET_KEY)
    c.check("恢复配置成功", st == 200 and res.get("configured") is True, f"{st} {res}")

    # ============================================================ c. Base URL 策略
    print("\n### c. Base URL 规范化与本地/重定向策略")
    variants = [
        (f"{FAKE_BASE}/v1/", f"{FAKE_BASE}/v1", "末尾斜杠"),
        (f"{FAKE_BASE}", f"{FAKE_BASE}/v1", "缺少 /v1"),
        (f"{FAKE_BASE}//v1//", f"{FAKE_BASE}/v1", "重复斜杠"),
        (f"{FAKE_BASE}/v1/chat/completions", f"{FAKE_BASE}/v1", "带 /chat/completions"),
    ]
    for raw_url, expected, label in variants:
        st, res = save_settings(base_url=raw_url)
        got = (res.get("config") or {}).get("baseUrl")
        c.check(f"Base URL 规范化：{label}", st == 200 and got == expected, f"{raw_url} -> {got} ({st} {res})")

    invalid_cases = [
        ("ftp://127.0.0.1:3501/v1", True, "非法协议"),
        ("http://user:pass@127.0.0.1:3501/v1", True, "URL 带凭据"),
        (f"{FAKE_BASE}/v1?x=1", True, "URL 带 query"),
        (f"{FAKE_BASE}/v1#frag", True, "URL 带 fragment"),
    ]
    for raw_url, allow_local, label in invalid_cases:
        st, res = save_settings(base_url=raw_url, allow_local=allow_local)
        accepted_codes = {"invalid_settings", "invalid_url", "local_not_allowed"}
        c.check(
            f"保存拒绝：{label}（400）",
            st == 400 and str(res.get("error", "")) in accepted_codes,
            f"{st} {res}",
        )
    st, res = save_settings(base_url=f"{FAKE_BASE}/v1", allow_local=False)
    c.check("未允许本机时 127.0.0.1 被拒绝（400）", st == 400, f"{st} {res}")
    st, res = save_settings(base_url=f"{FAKE_BASE}/v1", allow_local=True)
    c.check("拒绝后已有配置未被破坏", st == 200 and (res.get("config") or {}).get("baseUrl") == f"{FAKE_BASE}/v1", str(res))

    st, res = save_settings(base_url="http://localhost:3501/v1", allow_local=True)
    c.check(
        "允许本机后 localhost 通过",
        st == 200 and (res.get("config") or {}).get("baseUrl") == "http://localhost:3501/v1",
        f"{st} {res}",
    )
    save_settings(base_url=f"{FAKE_BASE}/v1", allow_local=True)

    st, res = save_settings(model="fake-redirect")
    c.check("切换到 fake-redirect 配置", st == 200, f"{st} {res}")
    st, res = client.post("/api/settings/ai/test", {})
    c.check(
        "重定向被拒绝：errorCode=redirect_blocked",
        st == 200 and res.get("test", {}).get("status") == "failure" and res.get("test", {}).get("errorCode") == "redirect_blocked",
        f"{st} {res}",
    )
    save_settings(model="fake-success")

    # ============================================================ d. 连接测试
    print("\n### d. 连接测试")
    cap_not_sent = create_capture(f"连接测试不应发送的念头-{uid}")
    gen_count_before = db_scalar("SELECT COUNT(*) AS v FROM ai_generations", default=-1)

    st, res = save_settings(model="fake-success", api_key=SECRET_KEY)
    st, res = client.post("/api/settings/ai/test", {})
    test_success = res.get("test") or {}
    c.check(
        "连接测试成功：testedAt/modelId/durationMs/status",
        st == 200
        and test_success.get("status") == "success"
        and isinstance(test_success.get("testedAt"), int)
        and test_success.get("modelId") == "fake-success"
        and isinstance(test_success.get("durationMs"), int)
        and test_success.get("durationMs") >= 0
        and test_success.get("stale") is False,
        f"{st} {test_success}",
    )
    c.check("连接测试响应包含 config（同 GET）", isinstance(res.get("config"), dict) and res["config"].get("modelId") == "fake-success", str(res.get("config")))

    last = fake_last() or {}
    last_body = last.get("body") or {}
    last_text = json.dumps(last_body, ensure_ascii=False)
    messages = last_body.get("messages") or []
    system_text = "\n".join(str(m.get("content")) for m in messages if m.get("role") == "system")
    user_text = "\n".join(str(m.get("content")) for m in messages if m.get("role") == "user")
    c.check("连接测试请求为 POST /v1/chat/completions", last.get("method") == "POST" and last.get("path") == "/v1/chat/completions", str(last.get("path")))
    c.check("连接测试使用固定 system 文案", "你是连接测试助手。" in system_text, system_text[:100])
    c.check("连接测试使用固定 user 文案", "请只回复：连接正常" in user_text, user_text[:100])
    c.check("连接测试不发送用户念头原文", cap_not_sent["rawText"] not in last_text, last_text[:200])
    gen_count_after = db_scalar("SELECT COUNT(*) AS v FROM ai_generations", default=-2)
    c.check("连接测试不写生成记录", gen_count_before == gen_count_after, f"{gen_count_before} -> {gen_count_after}")

    st, res = save_settings(model="fake-auth", api_key=WRONG_KEY)
    st, res = client.post("/api/settings/ai/test", {})
    c.check(
        "认证失败：errorCode=auth",
        st == 200 and res.get("test", {}).get("status") == "failure" and res.get("test", {}).get("errorCode") == "auth",
        f"{st} {res}",
    )
    c.check("认证失败详情不含明文 key", WRONG_KEY not in json.dumps(res, ensure_ascii=False), str(res)[:300])

    st, res = save_settings(model="fake-timeout", api_key=SECRET_KEY)
    st, res = client.post("/api/settings/ai/test", {})
    test_timeout = res.get("test") or {}
    c.check(
        "超时：errorCode=timeout",
        st == 200 and test_timeout.get("status") == "failure" and test_timeout.get("errorCode") == "timeout",
        f"{st} {test_timeout}",
    )
    c.check("超时耗时不少于测试超时阈值的一半", isinstance(test_timeout.get("durationMs"), int) and test_timeout["durationMs"] >= AI_TEST_TIMEOUT_MS // 2, str(test_timeout.get("durationMs")))

    st, res = save_settings(model="fake-invalid-json")
    st, res = client.post("/api/settings/ai/test", {})
    c.check(
        "格式不支持：errorCode=invalid_response",
        st == 200 and res.get("test", {}).get("status") == "failure" and res.get("test", {}).get("errorCode") == "invalid_response",
        f"{st} {res}",
    )

    st, res = save_settings(model="fake-model-missing")
    st, res = client.post("/api/settings/ai/test", {})
    c.check(
        "模型不可用：errorCode=model_unavailable",
        st == 200 and res.get("test", {}).get("status") == "failure" and res.get("test", {}).get("errorCode") == "model_unavailable",
        f"{st} {res}",
    )

    st, res = save_settings(model="fake-success", api_key=SECRET_KEY)
    st, res = client.post("/api/settings/ai/test", {})
    c.check("恢复 fake-success 后连接测试再次成功", st == 200 and res.get("test", {}).get("status") == "success", f"{st} {res}")

    # ============================================================ e. 生成三类建议与失败
    print("\n### e. 生成建议：三类 / 无效输出 / 认证 / 超时")
    cap_exec = create_capture(f"技术项目：想给树莓派接温湿度传感器 {uid}")
    st, res = suggest(cap_exec, operation_id=f"op-exec-{uid}")
    gen_exec = (res or {}).get("generation") or {}
    c.check("创建生成返回 202 且 status=pending", st == 202 and gen_exec.get("status") == "pending", f"{st} {res}")
    st, res = wait_generation(gen_exec.get("id", ""))
    gen_exec = (res or {}).get("generation") or {}
    c.check("fake-success 生成成功", st == 200 and gen_exec.get("status") == "succeeded", f"{st} {gen_exec.get('status')}")
    c.check(
        "executable 建议：kind/step/why/question",
        gen_exec.get("kind") == "executable"
        and isinstance(gen_exec.get("suggestion"), dict)
        and isinstance(gen_exec["suggestion"].get("step"), str)
        and gen_exec["suggestion"]["step"].strip()
        and gen_exec["suggestion"].get("question") is None,
        str(gen_exec.get("suggestion")),
    )
    check_generation_shape("fake-success", gen_exec)

    cap_defer = create_capture(f"最近每天加班，嵌入式课程先放一放 {uid}")
    configure("fake-defer")
    st, res = suggest(cap_defer, constraint="时间不足", operation_id=f"op-defer-{uid}")
    gen_defer = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_defer.get("id", ""))
    gen_defer = (res or {}).get("generation") or {}
    c.check(
        "fake-defer 生成成功且 kind=defer、step=null",
        st == 200 and gen_defer.get("status") == "succeeded" and gen_defer.get("kind") == "defer" and (gen_defer.get("suggestion") or {}).get("step") is None,
        f"{st} {gen_defer.get('status')} {gen_defer.get('suggestion')}",
    )
    c.check("defer 的 question 为 null", (gen_defer.get("suggestion") or {}).get("question") is None, str(gen_defer.get("suggestion")))

    cap_clarify = create_capture(f"想拍雨夜街灯但不知道从哪里开始 {uid}")
    configure("fake-clarify")
    st, res = suggest(cap_clarify, constraint="信息不够", operation_id=f"op-clarify-{uid}")
    gen_clarify = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_clarify.get("id", ""))
    gen_clarify = (res or {}).get("generation") or {}
    c.check(
        "fake-clarify 生成成功且 kind=clarify、question 非空",
        st == 200
        and gen_clarify.get("status") == "succeeded"
        and gen_clarify.get("kind") == "clarify"
        and isinstance((gen_clarify.get("suggestion") or {}).get("question"), str)
        and (gen_clarify.get("suggestion") or {}).get("question").strip(),
        f"{st} {gen_clarify.get('status')} {gen_clarify.get('suggestion')}",
    )
    c.check(
        "clarify 的 step/estimatedMinutes 为 null",
        (gen_clarify.get("suggestion") or {}).get("step") is None
        and (gen_clarify.get("suggestion") or {}).get("estimatedMinutes") is None,
        str(gen_clarify.get("suggestion")),
    )

    cap_invalid = create_capture(f"无效输出测试 {uid}")
    configure("fake-invalid-shape")
    st, res = suggest(cap_invalid, operation_id=f"op-invalid-{uid}")
    gen_invalid = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_invalid.get("id", ""))
    gen_invalid = (res or {}).get("generation") or {}
    c.check(
        "fake-invalid-shape -> failed invalid_response",
        st == 200 and gen_invalid.get("status") == "failed" and gen_invalid.get("errorCode") == "invalid_response",
        f"{st} {gen_invalid.get('status')} {gen_invalid.get('errorCode')}",
    )
    c.check("invalid_response 有可读 errorMessage", bool(gen_invalid.get("errorMessage")), str(gen_invalid.get("errorMessage")))

    cap_auth = create_capture(f"生成认证失败测试 {uid}")
    configure("fake-auth", api_key=WRONG_KEY)
    st, res = suggest(cap_auth, operation_id=f"op-genauth-{uid}")
    gen_auth = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_auth.get("id", ""))
    gen_auth = (res or {}).get("generation") or {}
    c.check(
        "生成认证失败 -> failed auth",
        st == 200 and gen_auth.get("status") == "failed" and gen_auth.get("errorCode") == "auth",
        f"{st} {gen_auth.get('status')} {gen_auth.get('errorCode')}",
    )

    cap_timeout = create_capture(f"生成超时测试 {uid}")
    configure("fake-timeout", api_key=SECRET_KEY)
    st, res = suggest(cap_timeout, operation_id=f"op-gentimeout-{uid}")
    gen_timeout = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_timeout.get("id", ""), timeout=max(15.0, AI_TIMEOUT_MS / 1000 + 8))
    gen_timeout = (res or {}).get("generation") or {}
    c.check(
        "生成超时 -> failed timeout",
        st == 200 and gen_timeout.get("status") == "failed" and gen_timeout.get("errorCode") == "timeout",
        f"{st} {gen_timeout.get('status')} {gen_timeout.get('errorCode')}",
    )
    c.check("生成超时耗时已记录", isinstance(gen_timeout.get("durationMs"), int) and gen_timeout["durationMs"] >= AI_TIMEOUT_MS // 2, str(gen_timeout.get("durationMs")))

    configure("fake-success", api_key=SECRET_KEY)

    # ============================================================ f. 采用
    print("\n### f. 采用建议")
    edited_step = f"编辑后的最小步骤-{uid}：先量一次 PWM 频率"
    st, res = client.post(
        f"/api/generations/{gen_exec.get('id')}/accept",
        {"step": edited_step, "operationId": f"op-adopt-{uid}"},
    )
    adopted_attempt = (res or {}).get("attempt") or {}
    adopted_gen = (res or {}).get("generation") or {}
    c.check("采用 executable 成功并创建尝试", st == 200 and adopted_attempt.get("step") == edited_step, f"{st} {res}")
    c.check("采用创建的是 todo 尝试", adopted_attempt.get("state") == "todo" and adopted_attempt.get("captureId") == cap_exec["id"], str(adopted_attempt))
    c.check(
        "采用后 generation 记录 adoptedAttemptId/adoptedAt",
        adopted_gen.get("adoptedAttemptId") == adopted_attempt.get("id") and isinstance(adopted_gen.get("adoptedAt"), int),
        str(adopted_gen),
    )

    st, res = client.post(
        f"/api/generations/{gen_exec.get('id')}/accept",
        {"step": edited_step, "operationId": f"op-adopt-{uid}"},
    )
    c.check(
        "同一 operationId 重复采用返回同一尝试",
        st == 200 and (res.get("attempt") or {}).get("id") == adopted_attempt.get("id") and res.get("replayed") is True,
        f"{st} {res}",
    )
    st, res = client.post(
        f"/api/generations/{gen_exec.get('id')}/accept",
        {"step": edited_step, "operationId": f"op-adopt-other-{uid}"},
    )
    c.check(
        "不同 operationId 重复采用仍返回同一尝试",
        st == 200 and (res.get("attempt") or {}).get("id") == adopted_attempt.get("id"),
        f"{st} {res}",
    )

    st, res = client.post(
        f"/api/generations/{gen_defer.get('id')}/accept",
        {"step": "任意步骤", "operationId": f"op-adopt-defer-{uid}"},
    )
    c.check("defer 采用被拒绝 409 not_adoptable", st == 409 and res.get("error") == "not_adoptable", f"{st} {res}")
    st, res = client.post(
        f"/api/generations/{gen_clarify.get('id')}/accept",
        {"step": "任意步骤", "operationId": f"op-adopt-clarify-{uid}"},
    )
    c.check("clarify 采用被拒绝 409 not_adoptable", st == 409 and res.get("error") == "not_adoptable", f"{st} {res}")

    cap_expired = create_capture(f"过期采用测试 {uid}")
    st, res = suggest(cap_expired, operation_id=f"op-genexp-{uid}")
    gen_expired = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_expired.get("id", ""))
    gen_expired = (res or {}).get("generation") or {}
    new_text = f"过期采用测试：原文已修改 {uid}"
    st, res = client.patch(f"/api/captures/{cap_expired['id']}", {"rawText": new_text, "revision": cap_expired["revision"]})
    c.check("修改原文使建议过期", st == 200 and res.get("capture", {}).get("revision") == cap_expired["revision"] + 1, f"{st} {res}")
    st, res = client.get(f"/api/generations/{gen_expired.get('id')}")
    c.check("原文修改后旧建议 isExpired=true", st == 200 and res.get("generation", {}).get("isExpired") is True, f"{st} {res}")
    st, res = client.post(
        f"/api/generations/{gen_expired.get('id')}/accept",
        {"step": "过期后的步骤", "operationId": f"op-adopt-exp-{uid}"},
    )
    c.check(
        "采用过期建议 409 suggestion_expired 并返回最新原文",
        st == 409
        and res.get("error") == "suggestion_expired"
        and res.get("currentRevision") == cap_expired["revision"] + 1
        and res.get("currentRawText") == new_text,
        f"{st} {res}",
    )

    # ============================================================ g. 并发 / 取消
    print("\n### g. 并发、取消与幂等点击")
    configure("fake-timeout", api_key=SECRET_KEY)
    cap_pending = create_capture(f"并发 pending 测试 {uid}")
    st, res = suggest(cap_pending, operation_id=f"op-conc-a-{uid}")
    gen_pending = (res or {}).get("generation") or {}
    c.check("慢模型创建生成返回 202 pending", st == 202 and gen_pending.get("status") == "pending", f"{st} {res}")
    st, res = suggest(cap_pending, operation_id=f"op-conc-b-{uid}")
    c.check(
        "同一念头 pending 时第二次 POST 409 generation_in_progress",
        st == 409 and res.get("error") == "generation_in_progress" and res.get("generationId") == gen_pending.get("id"),
        f"{st} {res}",
    )
    st, res = client.post(f"/api/generations/{gen_pending.get('id')}/cancel", {})
    cancelled = (res or {}).get("generation") or {}
    c.check(
        "取消后状态为 cancelled/errorCode=cancelled",
        st == 200 and cancelled.get("status") == "cancelled" and cancelled.get("errorCode") == "cancelled",
        f"{st} {cancelled}",
    )
    print("等待 fake-timeout 迟到响应（>5s）…")
    time.sleep(6.0)
    st, res = client.get(f"/api/generations/{gen_pending.get('id')}")
    late = res.get("generation") or {}
    c.check("迟到响应不能把已取消生成改回 succeeded", st == 200 and late.get("status") == "cancelled", f"{st} {late.get('status')}")

    # 全局并发上限：两个 pending 时第三个 429
    configure("fake-timeout", api_key=SECRET_KEY)
    cap_limit1 = create_capture(f"全局并发上限 A {uid}")
    cap_limit2 = create_capture(f"全局并发上限 B {uid}")
    st1, res1 = suggest(cap_limit1, operation_id=f"op-limit1-{uid}")
    st2, res2 = suggest(cap_limit2, operation_id=f"op-limit2-{uid}")
    gen1 = (res1 or {}).get("generation") or {}
    gen2 = (res2 or {}).get("generation") or {}
    st3, res3 = suggest(create_capture(f"全局并发上限 C {uid}"), operation_id=f"op-limit3-{uid}")
    c.check(
        "全局 pending>=2 时第三个生成 429 too_many_generations",
        st1 == 202 and st2 == 202 and st3 == 429 and res3.get("error") == "too_many_generations",
        f"{st1}/{st2}/{st3} {res3}",
    )
    for gid in (gen1.get("id"), gen2.get("id")):
        if gid:
            client.post(f"/api/generations/{gid}/cancel", {})

    # 重复点击同一 operationId：返回同一 generation
    configure("fake-success", api_key=SECRET_KEY)
    cap_dup = create_capture(f"重复点击幂等测试 {uid}")
    dup_op = f"op-dup-{uid}"
    st, res = suggest(cap_dup, operation_id=dup_op)
    first_gen = (res or {}).get("generation") or {}
    st2, res2 = suggest(cap_dup, operation_id=dup_op)
    second_gen = (res2 or {}).get("generation") or {}
    c.check(
        "重复点击同一 operationId 返回同一 generation（replayed）",
        st == 202 and st2 in (200, 202) and second_gen.get("id") == first_gen.get("id") and res2.get("replayed") is True,
        f"{st}/{st2} {res2}",
    )
    wait_generation(first_gen.get("id", ""))

    # ============================================================ h. 刷新 / latest / dismiss
    print("\n### h. 刷新恢复与 latest")
    st, res = client.get(f"/api/generations/{first_gen.get('id')}")
    c.check("按 ID 读取生成用于刷新恢复", st == 200 and res.get("generation", {}).get("id") == first_gen.get("id"), f"{st} {res}")

    cap_latest = create_capture(f"latest 恢复测试 {uid}")
    st, res = suggest(cap_latest, operation_id=f"op-latest-a-{uid}")
    gen_latest_a = (res or {}).get("generation") or {}
    wait_generation(gen_latest_a.get("id", ""))
    st, res = suggest(cap_latest, operation_id=f"op-latest-b-{uid}")
    gen_latest_b = (res or {}).get("generation") or {}
    wait_generation(gen_latest_b.get("id", ""))
    st, res = client.get(f"/api/captures/{cap_latest['id']}/suggestions/latest")
    latest = (res or {}).get("generation") or {}
    c.check("latest 返回最近一条建议", st == 200 and latest.get("id") == gen_latest_b.get("id"), f"{st} {latest.get('id')}")

    st, res = client.post(f"/api/generations/{gen_latest_b.get('id')}/dismiss", {})
    c.check("暂时放下返回 dismissedAt", st == 200 and isinstance(res.get("generation", {}).get("dismissedAt"), int), f"{st} {res}")
    st, res = client.get(f"/api/captures/{cap_latest['id']}/suggestions/latest")
    c.check(
        "dismiss 后 latest 回退到上一条未放下的建议",
        st == 200 and (res.get("generation") or {}).get("id") == gen_latest_a.get("id"),
        f"{st} {res}",
    )
    st, res = client.post(f"/api/generations/{gen_latest_a.get('id')}/dismiss", {})
    c.check("放下上一条建议", st == 200, f"{st} {res}")
    st, res = client.get(f"/api/captures/{cap_latest['id']}/suggestions/latest")
    c.check("全部 dismiss 后 latest 返回 null", st == 200 and res.get("generation") is None, f"{st} {res}")
    st, res = client.get(f"/api/generations/{gen_latest_b.get('id')}")
    c.check("dismiss 后仍可按 ID 读取", st == 200 and res.get("generation", {}).get("dismissedAt") is not None, f"{st} {res}")
    st, res = client.post(f"/api/generations/{gen_latest_b.get('id')}/dismiss", {})
    c.check("重复 dismiss 同样成功（幂等）", st == 200, f"{st} {res}")

    st, res = client.get(f"/api/captures/{cap_manual['id']}/suggestions/latest")
    c.check("没有生成记录的念头 latest 返回 null", st == 200 and res.get("generation") is None, f"{st} {res}")

    st, res = client.get("/api/generations/gen-does-not-exist")
    c.check("不存在的 generation 返回 404", st == 404, f"{st} {res}")

    # ============================================================ i. 删除念头
    print("\n### i. 删除念头与生成关联")
    delete_token = f"DELTOKEN{uid}"
    cap_delete = create_capture(f"{delete_token} 想整理旧照片")
    st, res = suggest(cap_delete, operation_id=f"op-del-gen1-{uid}")
    gen_del1 = (res or {}).get("generation") or {}
    wait_generation(gen_del1.get("id", ""))
    st, res = client.post(
        f"/api/generations/{gen_del1.get('id')}/accept",
        {"step": f"删除前采用的步骤 {uid}", "operationId": f"op-del-adopt-{uid}"},
    )
    del_attempt = (res or {}).get("attempt") or {}
    st, res = suggest(cap_delete, operation_id=f"op-del-gen2-{uid}")
    gen_del2 = (res or {}).get("generation") or {}
    wait_generation(gen_del2.get("id", ""))

    st, res = client.get(f"/api/captures/{cap_delete['id']}/delete-preview")
    c.check(
        "delete-preview 返回 generationCount=2 且 attemptCount=1",
        st == 200 and res.get("generationCount") == 2 and res.get("attemptCount") == 1,
        f"{st} {res}",
    )
    st, res = client.delete(f"/api/captures/{cap_delete['id']}")
    c.check(
        "删除返回 deletedGenerations=2",
        st == 200 and res.get("deletedGenerations") == 2,
        f"{st} {res}",
    )
    st, res = client.get(f"/api/generations/{gen_del1.get('id')}")
    c.check("删除后 generation 404", st == 404, f"{st} {res}")
    st, res = client.get(f"/api/generations/{gen_del2.get('id')}")
    c.check("删除后第二条 generation 404", st == 404, f"{st} {res}")
    st, res = client.get(f"/api/attempts/{del_attempt.get('id')}")
    c.check("删除后采用创建的 attempt 404", st == 404, f"{st} {res}")
    st, res = client.get(f"/api/search?q={delete_token}")
    c.check(
        "删除后搜索无念头/尝试残留",
        st == 200 and res.get("captures") == [] and res.get("attempts") == [],
        str(res)[:300],
    )
    remaining = db_scalar("SELECT COUNT(*) AS v FROM ai_generations WHERE capture_id = ?", (cap_delete["id"],), default=-1)
    c.check("数据库中该念头生成记录已清除", remaining == 0, str(remaining))

    # ============================================================ j. 密钥不泄露
    print("\n### j. 密钥不泄露")
    haystack = "\n".join(RESPONSE_TEXTS)
    leaked = [label for label, secret in SECRETS if secret and secret in haystack]
    c.check("所有设置/生成/错误响应不含明文密钥", not leaked, str(leaked))

    st, export_res = client.get("/api/export")
    export_text = json.dumps(export_res, ensure_ascii=False)
    leaked_export = [label for label, secret in SECRETS if secret and secret in export_text]
    c.check("GET /api/export 全文不含明文密钥", st == 200 and not leaked_export, f"{st} {leaked_export}")

    log_paths = []
    for candidate in (os.environ.get("SHINIAN_TEST_LOG"), SERVER_LOG):
        if candidate and os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
            log_paths.append(candidate)
    log_paths = list(dict.fromkeys(log_paths))
    if log_paths:
        log_text = ""
        for path in log_paths:
            with open(path, "rb") as fh:
                log_text += fh.read().decode("utf-8", "replace")
        log_leaks = [label for label, secret in SECRETS if secret and secret in log_text]
        c.check(f"服务日志不含明文密钥（{len(log_paths)} 个文件）", not log_leaks, f"logs={log_paths} leaks={log_leaks}")
    else:
        print("未提供 SHINIAN_TEST_LOG，启动独立实例检查日志…")
        try:
            log_text = independent_log_check()
            log_leaks = [label for label, secret in SECRETS if secret and secret in log_text]
            log_leaks += ["fallback"] if "log-fallback-secret-key" in log_text else []
            c.check("独立实例服务日志不含明文密钥", not log_leaks, str(log_leaks))
        except Exception as exc:  # noqa: BLE001
            c.check("独立实例服务日志不含明文密钥", False, repr(exc))

    # ============================================================ k. 场景覆盖
    print("\n### k. 场景样例（fake-scenario）")
    with open(SCENARIOS_PATH, "r", encoding="utf-8") as fh:
        scenarios = json.load(fh)
    categories = {s.get("category") for s in scenarios}
    constraints = {s.get("constraint") for s in scenarios}
    kinds = {s.get("expectedKind") for s in scenarios}
    c.check("场景数量 >= 20", len(scenarios) >= 20, str(len(scenarios)))
    c.check("覆盖技术项目/摄影/阅读/生活兴趣四类", {"技术项目", "摄影", "阅读", "生活兴趣"} <= categories, str(categories))
    c.check("覆盖时间不足/暂时不想行动/信息不够三类", {"时间不足", "暂时不想行动", "信息不够"} <= constraints, str(constraints))
    c.check("expectedKind 仅为 executable/defer/clarify", kinds <= {"executable", "defer", "clarify"}, str(kinds))
    c.check("三种 expectedKind 均出现", {"executable", "defer", "clarify"} <= kinds, str(kinds))

    configure("fake-scenario", api_key=SECRET_KEY)
    scenario_failures = []
    for scenario in scenarios:
        cap = create_capture(scenario["text"])
        st, res = suggest(cap, constraint=scenario.get("constraint") or None, operation_id=f"op-sc-{scenario['id']}-{uid}")
        gen = (res or {}).get("generation") or {}
        if st != 202:
            scenario_failures.append(f"{scenario['id']}: HTTP {st} {str(res)[:120]}")
            continue
        st, res = wait_generation(gen.get("id", ""), timeout=20)
        gen = (res or {}).get("generation") or {}
        suggestion = gen.get("suggestion") or {}
        ok = gen.get("status") == "succeeded" and gen.get("kind") == scenario["expectedKind"]
        if ok and scenario["expectedKind"] == "executable":
            ok = isinstance(suggestion.get("step"), str) and bool(suggestion["step"].strip())
        if ok and scenario["expectedKind"] == "clarify":
            ok = isinstance(suggestion.get("question"), str) and bool(suggestion["question"].strip())
        if ok and scenario["expectedKind"] == "defer":
            ok = suggestion.get("step") is None
        c.check(f"场景 {scenario['id']}（{scenario['category']}/{scenario['constraint'] or '无限制'}）kind={scenario['expectedKind']}", ok,
                f"status={gen.get('status')} kind={gen.get('kind')} suggestion={suggestion}")
        if not ok:
            scenario_failures.append(scenario["id"])
    c.check("20+ 场景全部符合 expectedKind", not scenario_failures, str(scenario_failures))

    configure("fake-success", api_key=SECRET_KEY)

    ok = c.report("AI 功能验收")
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
        stop_fake_server()
    sys.exit(exit_code)
