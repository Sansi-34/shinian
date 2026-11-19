"""拾念 SHINIAN · 「参考旧经验，再试一步」验收测试

针对运行中的测试服务（SHINIAN_BASE，默认 http://127.0.0.1:3100）执行契约验收。
脚本自行启动/停止 scripts/fake_model_server.py（默认 127.0.0.1:3501）。

覆盖 docs/experience-api-contract.md：
- 候选检索（中英文、失败/未判定可选、空观察排除、建议查询词、命中原因）
- 选择 0/1/3/4、去重、预览真实内容、预览后版本变化
- 来源感知生成（1/3 条、模型编造来源、矛盾/信息不足、超时/认证）
- 采用后 attempt_references、重复采用、来源变化 409、删除清洗
- 旧无 context 记录兼容、手动流程/导出回归、密钥不泄露
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
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
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test.sqlite")
SERVER_LOG = os.environ.get("SHINIAN_TEST_LOG") or os.path.join(ROOT, "db", "test-server.log")

SECRET_KEY = "test-secret-key"
WRONG_KEY = "wrong-key-for-auth-test"
TW = int(os.environ.get("SHINIAN_AI_TIMEOUT_MS", "1200") or 1200)  # 生成超时（run_tests 设置 1200）

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
    return fake_get("/__last").get("request") or {}


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
    if not wait_port("127.0.0.1", FAKE_PORT, 20):
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


def save_settings(model="fake-success", api_key=None):
    payload = {
        "name": "经验测试模型",
        "baseUrl": f"{FAKE_BASE}/v1",
        "modelId": model,
        "enabled": True,
        "allowLocal": True,
    }
    if api_key is not None:
        payload["apiKey"] = api_key
    return client.request("PUT", "/api/settings/ai", payload)


def configure(model: str, api_key=None):
    st, res = save_settings(model=model, api_key=api_key)
    assert st == 200, f"保存配置失败 {st} {res}"
    return res


def create_capture(text: str):
    st, res = client.post("/api/captures", {"rawText": text})
    assert st == 200, f"创建念头失败 {st} {res}"
    return res["capture"]


def make_attempt(capture: dict, step: str, result=None, outcome="failure"):
    st, res = client.post(
        f"/api/captures/{capture['id']}/attempts",
        {"step": step, "state": "todo", "operationId": f"op-exp-{uuid.uuid4().hex[:12]}"},
    )
    assert st == 200, f"创建尝试失败 {st} {res}"
    attempt = res["attempt"]
    if result is not None:
        st, res = client.patch(
            f"/api/attempts/{attempt['id']}",
            {"resultText": result, "outcome": outcome, "revision": attempt["revision"]},
        )
        assert st == 200, f"记录结果失败 {st} {res}"
        attempt = res["attempt"]
    return attempt


def create_reference(from_attempt: dict, to_attempt: dict):
    st, res = client.post(
        f"/api/attempts/{from_attempt['id']}/references",
        {"toId": to_attempt["id"], "note": "候选加权用引用", "operationId": f"op-expref-{uuid.uuid4().hex[:12]}"},
    )
    assert st == 200, f"创建引用失败 {st} {res}"
    return res["reference"]


def candidates(capture_id: str, q=None, limit=None):
    path = f"/api/captures/{capture_id}/experience-candidates"
    params = {}
    if q is not None:
        params["q"] = q
    if limit is not None:
        params["limit"] = str(limit)
    if params:
        path += "?" + urllib.parse.urlencode(params)
    return client.get(path)


def preview(capture: dict, source_ids, constraint="", capture_revision=None):
    payload = {
        "captureRevision": capture["revision"] if capture_revision is None else capture_revision,
        "sourceAttemptIds": list(source_ids),
    }
    if constraint:
        payload["constraint"] = constraint
    return client.post(f"/api/captures/{capture['id']}/experience/preview", payload)


def start_generation(capture: dict, source_ids, token, constraint="", operation_id=None):
    payload = {
        "captureRevision": capture["revision"],
        "sourceAttemptIds": list(source_ids),
        "contextToken": token,
        "operationId": operation_id or f"op-expgen-{uuid.uuid4().hex[:12]}",
    }
    if constraint:
        payload["constraint"] = constraint
    return client.post(f"/api/captures/{capture['id']}/suggestions", payload)


def start_plain_generation(capture: dict, operation_id=None):
    return client.post(
        f"/api/captures/{capture['id']}/suggestions",
        {
            "captureRevision": capture["revision"],
            "operationId": operation_id or f"op-plaingen-{uuid.uuid4().hex[:12]}",
        },
    )


TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def wait_generation(gen_id: str, timeout: float = 25.0):
    if not gen_id:
        return 0, {"error": "missing_generation_id"}
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


def token_of(preview_res: dict) -> str:
    return (preview_res or {}).get("contextToken") or ""


def source_ids_of(gen: dict) -> set:
    return {s.get("attemptId") for s in (gen.get("sources") or [])}


def check_source_shape(label: str, gen: dict, expected_ids):
    sources = gen.get("sources") or []
    c.check(f"{label}：sources 数量与选择一致", len(sources) == len(expected_ids), f"{len(sources)} vs {len(expected_ids)}")
    c.check(f"{label}：sources attemptId 均在本次选择内", source_ids_of(gen) <= set(expected_ids), str(source_ids_of(gen)))
    c.check(
        f"{label}：每条来源有 note/attemptRevision/currentExists",
        all(
            isinstance(s.get("note"), str)
            and bool(s.get("note").strip())
            and isinstance(s.get("attemptRevision"), int)
            and s.get("currentExists") is True
            for s in sources
        ),
        str(sources),
    )
    c.check(f"{label}：sourcesChanged=false", gen.get("sourcesChanged") is False, str(gen.get("sourcesChanged")))
    c.check(f"{label}：contextInvalidated=false", gen.get("contextInvalidated") is False, str(gen.get("contextInvalidated")))


# ---------------------------------------------------------------- 主流程
def main() -> int:
    print(f"测试服务: {BASE}")
    print(f"测试库: {TEST_DB}")
    start_fake_server()

    body = client.login("经验测试用户")
    c.check("创建/登录本机账号", body.get("ok") is True, str(body))
    configure("fake-success", api_key=SECRET_KEY)

    # ============================================================ 1. 造旧经验数据
    print("\n### 1. 候选检索数据准备")
    cap_old = create_capture(f"PWM 低占空比时 LED 会闪（旧经验 {uid}）")
    att1 = make_attempt(cap_old, "比较两种 PWM 频率", "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁", "failure")
    att2 = make_attempt(cap_old, "测量不同占空比", "占空比低于 20% 时闪烁明显，其余区间稳定", "undetermined")
    att_empty = make_attempt(cap_old, "只写了步骤还没观察", None)
    cap_en = create_capture(f"英文项目：measure LED flicker with PWM（旧经验 {uid}）")
    att3 = make_attempt(cap_en, "Compare PWM frequency", "At 500 Hz the LED still flickers; 2 kHz is stable", "success")
    att4 = make_attempt(cap_en, "Low duty cycle test", "Low duty cycle causes visible flicker at 500 Hz", "failure")
    cap_arch = create_capture(f"归档的闪烁记录（旧经验 {uid}）")
    att_arch = make_attempt(cap_arch, "归档测量", f"归档结果：500 Hz 闪烁明显 ARCHTOKEN{uid}", "failure")
    st, res = client.post(f"/api/captures/{cap_arch['id']}/archive", {})
    c.check("归档旧经验念头", st == 200, f"{st} {res}")

    cap_cur = create_capture(f"想重新调 PWM 亮度，避免肉眼可见闪烁 {uid}")
    att_cur0 = make_attempt(cap_cur, "准备复用旧结论", None)
    create_reference(att_cur0, att1)
    c.check("建立当前念头尝试到旧结果的引用", True)

    # ============================================================ 2. 候选检索
    print("\n### 2. 候选检索")
    anon = Client(base=BASE)
    st, _ = anon.get(f"/api/captures/{cap_cur['id']}/experience-candidates")
    c.check("未登录访问候选返回 401", st == 401, str(st))

    st, res = candidates(cap_cur["id"])
    c.check("默认候选检索返回 200", st == 200, f"{st} {res}")
    sq = (res or {}).get("suggestedQuery") or ""
    c.check("默认返回 suggestedQuery", isinstance(sq, str) and bool(sq.strip()), repr(sq))
    c.check("suggestedQuery 不是整段原文", sq != cap_cur["rawText"], f"{sq!r} vs {cap_cur['rawText']!r}")
    c.check("默认 limit=12", (res or {}).get("limit") == 12, str((res or {}).get("limit")))
    c.check("候选响应 captureId 正确", (res or {}).get("captureId") == cap_cur["id"], str((res or {}).get("captureId")))

    st, res = candidates(cap_cur["id"], q="闪烁")
    ids = {x.get("id") for x in (res or {}).get("candidates", [])}
    by_id = {x.get("id"): x for x in (res or {}).get("candidates", [])}
    c.check("中文关键词命中结果文本", st == 200 and att1["id"] in ids, f"{st} {sorted(ids)}")
    c.check("失败结果可选", (by_id.get(att1["id"]) or {}).get("outcome") == "failure", str(by_id.get(att1["id"])))
    c.check("未判定结果可选", att2["id"] in ids and (by_id.get(att2["id"]) or {}).get("outcome") == "undetermined", str(ids))
    c.check("候选带真实结果文本", (by_id.get(att1["id"]) or {}).get("resultText") == att1["resultText"], str(by_id.get(att1["id"])))
    reasons = (by_id.get(att1["id"]) or {}).get("matchReasons") or []
    c.check("结果命中原因", "结果命中" in reasons, str(reasons))
    c.check("引用关系命中原因", "引用关系" in reasons, str(reasons))
    c.check(
        "matchReasons 不含相似度百分比",
        all("%" not in str(r) and "相似度" not in str(r) for r in reasons),
        str(reasons),
    )

    st, res = candidates(cap_cur["id"], q="占空比")
    ids = {x.get("id") for x in (res or {}).get("candidates", [])}
    c.check("中文关键词命中另一结果", att2["id"] in ids, str(ids))

    st, res = candidates(cap_cur["id"], q="FLICKER")
    ids = {x.get("id") for x in (res or {}).get("candidates", [])}
    c.check("英文关键词大小写不敏感", st == 200 and att3["id"] in ids and att4["id"] in ids, f"{st} {sorted(ids)}")

    st, res = candidates(cap_cur["id"], q="只写了步骤")
    ids = {x.get("id") for x in (res or {}).get("candidates", [])}
    c.check("空观察尝试被排除", att_empty["id"] not in ids, str(ids))

    st, res = candidates(cap_cur["id"], q="归档")
    arch_hit = next((x for x in (res or {}).get("candidates", []) if x.get("id") == att_arch["id"]), None)
    c.check("归档记录仍可出现并标注 captureArchived", arch_hit is not None and arch_hit.get("captureArchived") is True, str(arch_hit))

    st, res = candidates(cap_cur["id"], q="闪烁", limit=1)
    c.check("limit=1 生效", st == 200 and len((res or {}).get("candidates") or []) <= 1, str(res)[:200])

    st, res = candidates("cap-not-exist")
    c.check("候选检索不存在的念头 404", st == 404, f"{st} {res}")

    # ============================================================ 3. 预览
    print("\n### 3. 预览与 contextToken")
    st, res = preview(cap_cur, [], "十分钟")
    c.check("预览 0 条来源 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = preview(cap_cur, [att1["id"], att2["id"], att3["id"], att4["id"]], "十分钟")
    c.check("预览 4 条来源 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = preview(cap_cur, [att1["id"], att1["id"]], "十分钟")
    c.check("预览重复来源 400 invalid_sources", st == 400 and res.get("error") == "invalid_sources", f"{st} {res}")
    st, res = preview(cap_cur, [att_empty["id"]], "十分钟")
    c.check(
        "预览空观察来源 409 source_unavailable",
        st == 409 and res.get("error") == "source_unavailable" and att_empty["id"] in (res.get("sourceIds") or []),
        f"{st} {res}",
    )
    st, res = preview(cap_cur, ["att-does-not-exist"], "十分钟")
    c.check(
        "预览不存在来源 409 source_unavailable",
        st == 409 and res.get("error") == "source_unavailable" and "att-does-not-exist" in (res.get("sourceIds") or []),
        f"{st} {res}",
    )

    st, prev1 = preview(cap_cur, [att1["id"]], "只有十分钟")
    c.check("预览 1 条来源 200", st == 200, f"{st} {prev1}")
    c.check("预览返回当前念头真实内容", (prev1 or {}).get("capture", {}).get("rawText") == cap_cur["rawText"] and (prev1 or {}).get("capture", {}).get("revision") == cap_cur["revision"], str((prev1 or {}).get("capture")))
    c.check("预览回显补充限制", (prev1 or {}).get("constraint") == "只有十分钟", str((prev1 or {}).get("constraint")))
    c.check("预览返回目标配置", (prev1 or {}).get("config", {}).get("modelId") == "fake-success", str((prev1 or {}).get("config")))
    p_sources = (prev1 or {}).get("sources") or []
    c.check("预览来源为服务端真实内容", len(p_sources) == 1 and p_sources[0].get("attemptId") == att1["id"] and p_sources[0].get("resultText") == att1["resultText"], str(p_sources))
    c.check("预览来源快照版本正确", p_sources and p_sources[0].get("attemptRevision") == att1["revision"] and p_sources[0].get("captureRevision") == cap_old["revision"], str(p_sources))
    c.check("预览来源带所属念头文本", p_sources and p_sources[0].get("captureText") == cap_old["rawText"], str(p_sources))
    token1 = token_of(prev1)
    c.check("contextToken 为 64 位 hex", bool(token1) and len(token1) == 64 and all(ch in "0123456789abcdef" for ch in token1), token1[:20])

    st, prev3 = preview(cap_cur, [att1["id"], att2["id"], att3["id"]])
    c.check("预览 3 条来源 200", st == 200 and len((prev3 or {}).get("sources") or []) == 3, f"{st} {prev3}")
    token3 = token_of(prev3)
    c.check("1 条与 3 条来源 token 不同", token1 != token3, f"{token1} vs {token3}")

    st, prev_other_constraint = preview(cap_cur, [att1["id"]], "只有五分钟")
    c.check("补充限制变化后 token 不同", token_of(prev_other_constraint) != token1, token_of(prev_other_constraint))

    # 预览后 capture revision 变化
    cap_prev = create_capture(f"预览后版本变化 {uid}")
    att_prev = make_attempt(cap_prev, "预览来源尝试", "预览时的真实观察", "failure")
    st, prev_cap = preview(cap_prev, [att_prev["id"]])
    token_cap = token_of(prev_cap)
    st, res = client.patch(f"/api/captures/{cap_prev['id']}", {"rawText": f"预览后修改的原文 {uid}", "revision": 1})
    c.check("预览后修改念头版本", st == 200, f"{st} {res}")
    cap_prev = res["capture"]
    st, res = preview(cap_prev, [att_prev["id"]], capture_revision=1)
    c.check("用旧 revision 预览 409 version_conflict", st == 409 and res.get("error") == "version_conflict" and res.get("currentRevision") == 2, f"{st} {res}")
    st, res = client.post(
        f"/api/captures/{cap_prev['id']}/suggestions",
        {
            "captureRevision": 1,
            "sourceAttemptIds": [att_prev["id"]],
            "contextToken": token_cap,
            "operationId": f"op-capturechanged-{uid}",
        },
    )
    c.check(
        "预览后念头变化时生成 409 version_conflict/context_changed",
        st == 409 and res.get("error") in {"version_conflict", "context_changed"},
        f"{st} {res}",
    )

    # 预览后来源 revision 变化
    cap_srcver = create_capture(f"来源版本变化 {uid}")
    att_srcver = make_attempt(cap_srcver, "来源版本尝试", "来源版本观察 v1", "failure")
    st, prev_src = preview(cap_srcver, [att_srcver["id"]])
    token_src = token_of(prev_src)
    st, res = client.patch(
        f"/api/attempts/{att_srcver['id']}",
        {"resultText": "来源版本观察 v2", "outcome": "success", "revision": att_srcver["revision"]},
    )
    c.check("预览后修改来源 revision", st == 200, f"{st} {res}")
    st, prev_src2 = preview(cap_srcver, [att_srcver["id"]])
    c.check("来源 revision 变化后 token 不同", token_of(prev_src2) != token_src, f"{token_src} vs {token_of(prev_src2)}")
    st, res = client.post(
        f"/api/captures/{cap_srcver['id']}/suggestions",
        {
            "captureRevision": cap_srcver["revision"],
            "sourceAttemptIds": [att_srcver["id"]],
            "contextToken": token_src,
            "operationId": f"op-sourcechanged-{uid}",
        },
    )
    c.check("来源 revision 变化后生成 409 context_changed", st == 409 and res.get("error") == "context_changed", f"{st} {res}")

    # ============================================================ 4. 生成
    print("\n### 4. 来源感知生成")
    cap_gen = create_capture(f"结合旧经验重新试 PWM {uid}")

    configure("fake-experience", api_key=SECRET_KEY)
    st, prev = preview(cap_gen, [att1["id"]], "只有十分钟")
    st, res = start_generation(cap_gen, [att1["id"]], token_of(prev), "只有十分钟", f"op-exp1-{uid}")
    gen1 = (res or {}).get("generation") or {}
    c.check("带 1 条来源创建生成 202", st == 202 and gen1.get("status") == "pending", f"{st} {res}")
    st, res = wait_generation(gen1.get("id", ""))
    gen1 = (res or {}).get("generation") or {}
    c.check("fake-experience 生成成功", st == 200 and gen1.get("status") == "succeeded", f"{st} {gen1.get('status')} {gen1.get('errorCode')}")
    check_source_shape("fake-experience", gen1, [att1["id"]])
    sug1 = gen1.get("suggestion") or {}
    c.check("建议 sources 指向唯一选择来源", [s.get("attemptId") for s in (sug1.get("sources") or [])] == [att1["id"]], str(sug1.get("sources")))
    c.check("建议 step/why 提及旧结果", "旧结果" in str(sug1.get("step")) and "旧结果" in str(sug1.get("why")), str(sug1))
    c.check("生成公开对象回显 constraint", gen1.get("constraint") == "只有十分钟", str(gen1.get("constraint")))
    last = fake_last()
    last_body_text = json.dumps(last.get("body") or {}, ensure_ascii=False)
    c.check("生成 prompt 含本次来源稳定 ID", att1["id"] in last_body_text and f"[{att1['id']}]" in last_body_text, last_body_text[:300])
    c.check("生成 prompt 不含明文密钥", SECRET_KEY not in last_body_text, "leak")

    configure("fake-experience-3", api_key=SECRET_KEY)
    st, prev3g = preview(cap_gen, [att1["id"], att2["id"], att3["id"]])
    st, res = start_generation(cap_gen, [att1["id"], att2["id"], att3["id"]], token_of(prev3g), operation_id=f"op-exp3-{uid}")
    gen3 = (res or {}).get("generation") or {}
    st, res = wait_generation(gen3.get("id", ""))
    gen3 = (res or {}).get("generation") or {}
    c.check("fake-experience-3 生成成功", st == 200 and gen3.get("status") == "succeeded", f"{st} {gen3.get('status')} {gen3.get('errorCode')}")
    check_source_shape("fake-experience-3", gen3, [att1["id"], att2["id"], att3["id"]])
    c.check("fake-experience-3 建议返回 3 条来源", len((gen3.get("suggestion") or {}).get("sources") or []) == 3, str((gen3.get("suggestion") or {}).get("sources")))

    configure("fake-experience-bad-source", api_key=SECRET_KEY)
    st, prev_bad = preview(cap_gen, [att1["id"]])
    st, res = start_generation(cap_gen, [att1["id"]], token_of(prev_bad), operation_id=f"op-expbad-{uid}")
    gen_bad = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_bad.get("id", ""))
    gen_bad = (res or {}).get("generation") or {}
    c.check("模型编造来源 -> failed invalid_response", st == 200 and gen_bad.get("status") == "failed" and gen_bad.get("errorCode") == "invalid_response", f"{st} {gen_bad.get('status')} {gen_bad.get('errorCode')}")

    configure("fake-experience-contradict", api_key=SECRET_KEY)
    st, prev_con = preview(cap_gen, [att1["id"], att2["id"]], "两条旧结果")
    st, res = start_generation(cap_gen, [att1["id"], att2["id"]], token_of(prev_con), "两条旧结果", f"op-expcon-{uid}")
    gen_con = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_con.get("id", ""))
    gen_con = (res or {}).get("generation") or {}
    c.check("fake-experience-contradict 生成成功", st == 200 and gen_con.get("status") == "succeeded", f"{st} {gen_con.get('status')} {gen_con.get('errorCode')}")
    c.check("矛盾建议 why 说明矛盾", "矛盾" in str((gen_con.get("suggestion") or {}).get("why")), str((gen_con.get("suggestion") or {}).get("why")))
    c.check("矛盾建议 sources 为两条", len((gen_con.get("suggestion") or {}).get("sources") or []) == 2, str((gen_con.get("suggestion") or {}).get("sources")))

    configure("fake-experience-insufficient", api_key=SECRET_KEY)
    st, prev_ins1 = preview(cap_gen, [att1["id"]])
    st, res = start_generation(cap_gen, [att1["id"]], token_of(prev_ins1), operation_id=f"op-expins1-{uid}")
    gen_ins1 = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_ins1.get("id", ""))
    gen_ins1 = (res or {}).get("generation") or {}
    c.check("信息不足（1 来源）生成成功", st == 200 and gen_ins1.get("status") == "succeeded" and gen_ins1.get("kind") == "clarify", f"{st} {gen_ins1.get('status')} {gen_ins1.get('kind')}")
    c.check("信息不足允许 sources 为空", (gen_ins1.get("suggestion") or {}).get("sources") == [], str((gen_ins1.get("suggestion") or {}).get("sources")))
    st, prev_ins2 = preview(cap_gen, [att1["id"], att2["id"]])
    st, res = start_generation(cap_gen, [att1["id"], att2["id"]], token_of(prev_ins2), operation_id=f"op-expins2-{uid}")
    gen_ins2 = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_ins2.get("id", ""))
    gen_ins2 = (res or {}).get("generation") or {}
    ins_sources = (gen_ins2.get("suggestion") or {}).get("sources") or []
    c.check(
        "信息不足允许部分来源",
        st == 200 and gen_ins2.get("status") == "succeeded" and len(ins_sources) <= 2
        and {s.get("attemptId") for s in ins_sources} <= {att1["id"], att2["id"]},
        f"{st} {gen_ins2.get('status')} {ins_sources}",
    )

    configure("fake-experience-timeout", api_key=SECRET_KEY)
    st, prev_to = preview(cap_gen, [att1["id"]])
    st, res = start_generation(cap_gen, [att1["id"]], token_of(prev_to), operation_id=f"op-expto-{uid}")
    gen_to = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_to.get("id", ""), timeout=max(15.0, TW / 1000 + 8))
    gen_to = (res or {}).get("generation") or {}
    c.check("来源生成超时 -> failed timeout", st == 200 and gen_to.get("status") == "failed" and gen_to.get("errorCode") == "timeout", f"{st} {gen_to.get('status')} {gen_to.get('errorCode')}")

    configure("fake-experience-auth", api_key=WRONG_KEY)
    st, prev_auth = preview(cap_gen, [att1["id"]])
    st, res = start_generation(cap_gen, [att1["id"]], token_of(prev_auth), operation_id=f"op-expauth-{uid}")
    gen_auth = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_auth.get("id", ""))
    gen_auth = (res or {}).get("generation") or {}
    c.check("来源生成认证失败 -> failed auth", st == 200 and gen_auth.get("status") == "failed" and gen_auth.get("errorCode") == "auth", f"{st} {gen_auth.get('status')} {gen_auth.get('errorCode')}")

    configure("fake-experience-3", api_key=SECRET_KEY)

    # ============================================================ 5. 采用与引用
    print("\n### 5. 采用与 attempt_references")
    cap_adopt = create_capture(f"采用旧经验建议 {uid}")
    st, prev_adopt = preview(cap_adopt, [att1["id"], att2["id"]])
    st, res = start_generation(cap_adopt, [att1["id"], att2["id"]], token_of(prev_adopt), operation_id=f"op-expadopt-gen-{uid}")
    gen_adopt = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_adopt.get("id", ""))
    gen_adopt = (res or {}).get("generation") or {}
    edited = f"结合旧经验的最小验证步骤 {uid}"
    st, res = client.post(
        f"/api/generations/{gen_adopt.get('id')}/accept",
        {"step": edited, "operationId": f"op-expadopt-{uid}"},
    )
    attempt_new = (res or {}).get("attempt") or {}
    c.check("采用带来源建议成功", st == 200 and attempt_new.get("step") == edited and attempt_new.get("captureId") == cap_adopt["id"], f"{st} {res}")
    c.check("采用后 generation 绑定 attempt", (res.get("generation") or {}).get("adoptedAttemptId") == attempt_new.get("id"), str(res.get("generation")))

    st, refs = client.get(f"/api/attempts/{attempt_new.get('id')}/references")
    from_refs = (refs or {}).get("fromRefs") or []
    ref_by_target = {r.get("toAttemptId"): r for r in from_refs}
    c.check("新尝试建立 2 条来源引用", st == 200 and len(from_refs) == 2, f"{st} {refs}")
    c.check("引用指向正确来源", set(ref_by_target) == {att1["id"], att2["id"]}, str(set(ref_by_target)))
    for source_id in (att1["id"], att2["id"]):
        ref = ref_by_target.get(source_id) or {}
        expected = att1 if source_id == att1["id"] else att2
        c.check(
            f"引用 {source_id[-6:]} note/snapshot 正确",
            str(ref.get("note") or "").startswith("AI 建议引用：")
            and ref.get("snapshotResultText") == expected["resultText"]
            and ref.get("snapshotRevision") == expected["revision"],
            str(ref),
        )
    st, back = client.get(f"/api/attempts/{att1['id']}/references")
    c.check("旧尝试反向可见新引用", st == 200 and any(r.get("fromAttemptId") == attempt_new.get("id") for r in (back or {}).get("toRefs", [])), str(back)[:300])

    st, res = client.post(
        f"/api/generations/{gen_adopt.get('id')}/accept",
        {"step": edited, "operationId": f"op-expadopt-{uid}"},
    )
    c.check("同一 operationId 重复采用返回同一 Attempt", st == 200 and (res.get("attempt") or {}).get("id") == attempt_new.get("id"), f"{st} {res}")
    st, res = client.post(
        f"/api/generations/{gen_adopt.get('id')}/accept",
        {"step": edited, "operationId": f"op-expadopt-other-{uid}"},
    )
    c.check("不同 operationId 重复采用仍返回同一 Attempt", st == 200 and (res.get("attempt") or {}).get("id") == attempt_new.get("id"), f"{st} {res}")
    st, refs2 = client.get(f"/api/attempts/{attempt_new.get('id')}/references")
    c.check("重复采用不重复创建引用", len((refs2 or {}).get("fromRefs") or []) == 2, str(len((refs2 or {}).get("fromRefs") or [])))

    # 来源变化后采用 409 sources_changed
    cap_chg_src = create_capture(f"来源变化测试的来源念头 {uid}")
    att_chg = make_attempt(cap_chg_src, "会被修改的来源", f"变化前观察 CHGTOKEN{uid}", "failure")
    cap_chg = create_capture(f"来源变化后采用 {uid}")
    st, prev_chg = preview(cap_chg, [att_chg["id"]])
    st, res = start_generation(cap_chg, [att_chg["id"]], token_of(prev_chg), operation_id=f"op-expchg-gen-{uid}")
    gen_chg = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_chg.get("id", ""))
    gen_chg = (res or {}).get("generation") or {}
    st, res = client.patch(
        f"/api/attempts/{att_chg['id']}",
        {"resultText": f"变化后观察 CHGTOKEN{uid}", "outcome": "success", "revision": att_chg["revision"]},
    )
    c.check("修改来源后再采用前准备完成", st == 200, f"{st} {res}")
    st, before_attempts = client.get(f"/api/captures/{cap_chg['id']}/attempts")
    before_count = len((before_attempts or {}).get("attempts") or [])
    st, res = client.post(
        f"/api/generations/{gen_chg.get('id')}/accept",
        {"step": "不应创建的步骤", "operationId": f"op-expchg-accept-{uid}"},
    )
    c.check("来源变化后采用 409 sources_changed", st == 409 and res.get("error") == "sources_changed", f"{st} {res}")
    st, after_attempts = client.get(f"/api/captures/{cap_chg['id']}/attempts")
    c.check("来源变化后不创建新 Attempt", len((after_attempts or {}).get("attempts") or []) == before_count, f"{before_count} -> {len((after_attempts or {}).get('attempts') or [])}")
    st, gen_chg_now = client.get(f"/api/generations/{gen_chg.get('id')}")
    c.check("来源变化后 generation 未被 adopted", (gen_chg_now.get("generation") or {}).get("adoptedAttemptId") is None, str(gen_chg_now.get("generation")))

    # 来源所属念头 revision 变化后采用 409
    cap_chg2_src = create_capture(f"来源念头变化测试的来源念头 {uid}")
    att_chg2 = make_attempt(cap_chg2_src, "来源念头变化", f"来源念头观察 {uid}", "failure")
    cap_chg2 = create_capture(f"来源念头变化后采用 {uid}")
    st, prev_chg2 = preview(cap_chg2, [att_chg2["id"]])
    st, res = start_generation(cap_chg2, [att_chg2["id"]], token_of(prev_chg2), operation_id=f"op-expchg2-gen-{uid}")
    gen_chg2 = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_chg2.get("id", ""))
    gen_chg2 = (res or {}).get("generation") or {}
    st, res = client.patch(f"/api/captures/{cap_chg2_src['id']}", {"rawText": f"来源念头已修改 {uid}", "revision": cap_chg2_src["revision"]})
    c.check("修改来源所属念头 revision", st == 200, f"{st} {res}")
    st, res = client.post(
        f"/api/generations/{gen_chg2.get('id')}/accept",
        {"step": "不应创建的步骤", "operationId": f"op-expchg2-accept-{uid}"},
    )
    c.check("来源念头变化后采用 409 sources_changed", st == 409 and res.get("error") == "sources_changed", f"{st} {res}")

    # ============================================================ 6. 删除清洗
    print("\n### 6. 删除来源后的清洗")
    cap_src_del = create_capture(f"将被删除的来源念头 {uid}")
    del_a = make_attempt(cap_src_del, "来源 A", f"DELETE-SOURCE-A-{uid}", "failure")
    del_b = make_attempt(cap_src_del, "来源 B", f"DELETE-SOURCE-B-{uid}", "success")
    cap_del_gen = create_capture(f"引用将删除来源的生成 {uid}")
    configure("fake-experience-3", api_key=SECRET_KEY)
    st, prev_del = preview(cap_del_gen, [del_a["id"], del_b["id"]])
    st, res = start_generation(cap_del_gen, [del_a["id"], del_b["id"]], token_of(prev_del), operation_id=f"op-expdel-gen-{uid}")
    gen_del = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_del.get("id", ""))
    gen_del = (res or {}).get("generation") or {}
    c.check("删除前来源生成成功", st == 200 and gen_del.get("status") == "succeeded", f"{st} {gen_del.get('status')}")

    st, res = client.delete(f"/api/attempts/{del_a['id']}")
    c.check("删除来源尝试成功", st == 200, f"{st} {res}")
    st, res = client.get(f"/api/generations/{gen_del.get('id')}")
    gen_after_del = (res or {}).get("generation") or {}
    text_after_del = json.dumps(gen_after_del, ensure_ascii=False)
    deleted_entries = [s for s in (gen_after_del.get("sources") or []) if s.get("attemptId") == del_a["id"]]
    c.check("删除后 generation 仍可读", st == 200, f"{st} {res}")
    c.check("删除来源标记 deleted=true", bool(deleted_entries) and deleted_entries[0].get("deleted") is True, str(deleted_entries))
    c.check("删除来源不包含已删正文", f"DELETE-SOURCE-A-{uid}" not in text_after_del and not any(s.get("resultText") and f"DELETE-SOURCE-A-{uid}" in str(s.get("resultText")) for s in deleted_entries), text_after_del[:400])
    c.check("删除来源后 contextInvalidated=true", gen_after_del.get("contextInvalidated") is True, str(gen_after_del.get("contextInvalidated")))
    c.check("删除来源后 contextInvalidReason 非空", bool(gen_after_del.get("contextInvalidReason")), str(gen_after_del.get("contextInvalidReason")))
    c.check("删除来源后 sourcesChanged=true", gen_after_del.get("sourcesChanged") is True, str(gen_after_del.get("sourcesChanged")))
    st, before_attempts = client.get(f"/api/captures/{cap_del_gen['id']}/attempts")
    before_count = len((before_attempts or {}).get("attempts") or [])
    st, res = client.post(
        f"/api/generations/{gen_del.get('id')}/accept",
        {"step": "删除来源后不可采用", "operationId": f"op-expdel-accept-{uid}"},
    )
    c.check("删除来源后不可采用 409", st == 409, f"{st} {res}")
    st, after_attempts = client.get(f"/api/captures/{cap_del_gen['id']}/attempts")
    c.check("删除来源后采用不创建 Attempt", len((after_attempts or {}).get("attempts") or []) == before_count, f"{before_count} -> {len((after_attempts or {}).get('attempts') or [])}")

    # 删除来源所属念头
    cap_src_capture = create_capture(f"将被整条删除的来源念头 {uid}")
    del_cap_att = make_attempt(cap_src_capture, "整条删除来源", f"DELETE-CAPTURE-TOKEN-{uid}", "failure")
    cap_del_gen2 = create_capture(f"引用将删除念头来源的生成 {uid}")
    st, prev_del2 = preview(cap_del_gen2, [del_cap_att["id"]])
    st, res = start_generation(cap_del_gen2, [del_cap_att["id"]], token_of(prev_del2), operation_id=f"op-expdel2-gen-{uid}")
    gen_del2 = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_del2.get("id", ""))
    gen_del2 = (res or {}).get("generation") or {}
    st, res = client.delete(f"/api/captures/{cap_src_capture['id']}")
    c.check("删除来源所属念头", st == 200, f"{st} {res}")
    st, res = client.get(f"/api/generations/{gen_del2.get('id')}")
    gen_after_cap_del = (res or {}).get("generation") or {}
    text_after_cap_del = json.dumps(gen_after_cap_del, ensure_ascii=False)
    c.check("删除来源念头后 generation 仍可读", st == 200, f"{st} {res}")
    c.check("删除来源念头后不包含已删正文", f"DELETE-CAPTURE-TOKEN-{uid}" not in text_after_cap_del, text_after_cap_del[:400])
    c.check("删除来源念头后 contextInvalidated=true", gen_after_cap_del.get("contextInvalidated") is True, str(gen_after_cap_del.get("contextInvalidated")))

    # ============================================================ 7. 旧记录兼容
    print("\n### 7. 旧无 context 生成记录兼容")
    configure("fake-success", api_key=SECRET_KEY)
    cap_legacy = create_capture(f"旧流程无来源生成 {uid}")
    st, res = start_plain_generation(cap_legacy, f"op-legacy-{uid}")
    gen_legacy = (res or {}).get("generation") or {}
    st, res = wait_generation(gen_legacy.get("id", ""))
    gen_legacy = (res or {}).get("generation") or {}
    c.check("旧无来源生成成功（context null 路径）", st == 200 and gen_legacy.get("status") == "succeeded", f"{st} {gen_legacy.get('status')}")
    c.check("旧记录 sources=[]", gen_legacy.get("sources") == [], str(gen_legacy.get("sources")))
    c.check("旧记录 sourcesChanged=false", gen_legacy.get("sourcesChanged") is False, str(gen_legacy.get("sourcesChanged")))
    c.check("旧记录 contextInvalidated=false", gen_legacy.get("contextInvalidated") is False, str(gen_legacy.get("contextInvalidated")))
    c.check("旧记录建议 sources=[]", (gen_legacy.get("suggestion") or {}).get("sources") == [], str((gen_legacy.get("suggestion") or {}).get("sources")))
    st, res = client.post(
        f"/api/generations/{gen_legacy.get('id')}/accept",
        {"step": f"旧记录采用步骤 {uid}", "operationId": f"op-legacy-accept-{uid}"},
    )
    c.check("旧无 context 记录可正常采用", st == 200 and (res.get("attempt") or {}).get("step") == f"旧记录采用步骤 {uid}", f"{st} {res}")

    # ============================================================ 8. 手动流程/导出/密钥
    print("\n### 8. 回归与密钥")
    manual_text = f"手动回归 EXP-{uid}：PWM 低占空比时 LED 会闪"
    st, res = client.post("/api/captures", {"rawText": manual_text})
    cap_manual = res["capture"]
    st, res = client.post(
        f"/api/captures/{cap_manual['id']}/attempts",
        {"step": "手动回归尝试", "state": "todo", "operationId": f"op-expmanual-{uid}"},
    )
    att_manual = res["attempt"]
    st, res = client.patch(
        f"/api/attempts/{att_manual['id']}",
        {"state": "done", "resultText": f"手动回归结果 MANUALEXP{uid}", "outcome": "success", "revision": att_manual["revision"]},
    )
    c.check("现有手动流程仍可用", st == 200 and res.get("attempt", {}).get("outcome") == "success", f"{st} {res}")
    st, res = client.get(f"/api/search?q=MANUALEXP{uid}")
    c.check("手动流程搜索结果可找回", st == 200 and any(a.get("id") == att_manual["id"] for a in (res or {}).get("attempts", [])), str(res)[:300])

    st, export = client.get("/api/export")
    export_text = json.dumps(export, ensure_ascii=False)
    c.check("JSON 导出仍可用", st == 200 and isinstance(export, dict) and "captures" in (export.get("data") or {}), f"{st}")
    c.check("导出不含明文密钥", SECRET_KEY not in export_text and WRONG_KEY not in export_text, "leak")

    haystack = "\n".join(RESPONSE_TEXTS)
    c.check("所有响应不含明文密钥", SECRET_KEY not in haystack and WRONG_KEY not in haystack, "leak")
    log_path = os.environ.get("SHINIAN_TEST_LOG") or SERVER_LOG
    if os.path.isfile(log_path):
        with open(log_path, "rb") as fh:
            log_text = fh.read().decode("utf-8", "replace")
        c.check("服务日志不含明文密钥", SECRET_KEY not in log_text and WRONG_KEY not in log_text, "leak")

    ok = c.report("参考旧经验验收")
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
