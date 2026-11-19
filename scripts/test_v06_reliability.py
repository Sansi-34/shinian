"""拾念 SHINIAN · v0.6 路径数据可靠性验收

默认自启动隔离服务（随机空闲端口 + db/v06-reliability.sqlite），
也可设置 SHINIAN_BASE 复用已有测试服务。脚本自行启动/停止 fake_model_server.py。

覆盖：
- 路径 A：手动尝试 → 经验保存；operationId 重放、详情重复读取、编辑 409、
  来源更新提示、经验修订后旧尝试 adoptedVersion、来源删除后的搜索/导出清洗
- 路径 B：fake-ask 问答 → 问答观点保存经验；operationId 重放、问答刷新读取
- 自启动模式下重启同一数据库：经验/问答仍在，导出 schemaVersion=6
- 结束时恢复 AI 配置并清理自启动进程
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node") or "node"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
BASE = os.environ.get("SHINIAN_BASE", "").rstrip("/")
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "v06-reliability.sqlite")
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
SECRET_KEY = "test-secret-key"
UID = uuid.uuid4().hex[:8]
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}

c = Checker()
client = None
app_proc = None
app_log = None
app_port = None
app_started = False
fake_proc = None


def op(tag):
    return f"op-v06-{tag}-{UID}-{uuid.uuid4().hex[:6]}"


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_open(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_port(host, port, timeout=25.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            return True
        time.sleep(0.15)
    return False


def start_app():
    global app_proc, app_log, app_port, BASE, TEST_DB, app_started
    if BASE:
        print(f"复用外部测试服务: {BASE}")
        return
    if "test" not in os.path.basename(TEST_DB).lower() and "reliability" not in TEST_DB.lower():
        raise RuntimeError(f"拒绝使用非测试数据库：{TEST_DB}")
    app_port = free_port()
    master_key = os.path.join(ROOT, "db", "v06-reliability-master.key")
    if not app_started:
        for path in (TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm", master_key):
            if os.path.exists(path):
                os.remove(path)
        app_started = True
    env = dict(os.environ)
    env["PORT"] = str(app_port)
    env["DATABASE_URL"] = TEST_DB
    env["SHINIAN_MASTER_KEY_FILE"] = master_key
    env["SHINIAN_AI_TIMEOUT_MS"] = "1200"
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = "800"
    app_log = open(os.path.join(ROOT, "db", "v06-reliability-server.log"), "ab")
    app_proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=app_log,
        stderr=subprocess.STDOUT,
    )
    BASE = f"http://127.0.0.1:{app_port}"
    if not wait_port("127.0.0.1", app_port):
        raise RuntimeError("v0.6 可靠性测试服务未能启动")


def stop_app():
    global app_proc, app_log, BASE
    if app_proc is None:
        return
    app_proc.terminate()
    try:
        app_proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        app_proc.kill()
        app_proc.wait(timeout=5)
    app_proc = None
    BASE = ""
    if app_log is not None:
        app_log.close()
        app_log = None


def start_fake():
    global fake_proc
    if port_open("127.0.0.1", FAKE_PORT):
        return
    fake_proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts", "fake_model_server.py")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port("127.0.0.1", FAKE_PORT):
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
        fake_proc.wait(timeout=5)
    fake_proc = None


def q(path, **params):
    if "from_" in params:
        params["from"] = params.pop("from_")
    return path + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def new_client():
    cli = Client(base=BASE)
    status, body = cli.post("/api/session/create", {"username": f"v06可靠性-{UID}"})
    assert status == 200 and body.get("ok"), (status, body)
    return cli


def create_capture(cli, text):
    status, res = cli.post("/api/captures", {"rawText": text})
    assert status == 200, (status, res)
    return res["capture"]


def create_attempt(cli, capture_id, step, result, outcome, observed_at=None):
    status, res = cli.post(
        f"/api/captures/{capture_id}/attempts",
        {
            "step": step,
            "state": "done",
            "resultText": result,
            "outcome": outcome,
            "observedAt": observed_at or int(time.time() * 1000),
            "operationId": op("attempt"),
        },
    )
    assert status in (200, 201), (status, res)
    return res["attempt"]


def save_result(cli, attempt, text, outcome="success"):
    status, res = cli.patch(
        f"/api/attempts/{attempt['id']}",
        {
            "resultText": text,
            "outcome": outcome,
            "observedAt": int(time.time() * 1000),
            "revision": attempt["revision"],
            "state": "done",
        },
    )
    assert status == 200, (status, res)
    return res["attempt"]


def wait_query(cli, query_id, timeout=25.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, res = cli.get(f"/api/ask/queries/{query_id}")
        if status != 200:
            return status, res
        last = (res or {}).get("query")
        if last and last.get("status") in TERMINAL:
            return status, res
        time.sleep(0.2)
    return 200, {"query": last, "_poll_timeout": True}


def create_experience(cli, payload):
    return cli.post("/api/experiences", payload)


def main():
    global client
    start_fake()
    start_app()
    client = new_client()
    print(f"测试服务: {BASE}")
    print(f"测试库: {TEST_DB}")

    cap_a_text = f"V06REL-A-{UID} 睡前把手机放到书桌上"
    cap_a = create_capture(client, cap_a_text)
    att_a = create_attempt(
        client,
        cap_a["id"],
        f"V06REL-A-{UID} 睡前把手机放到书桌上",
        f"V06REL-A-{UID} 十分钟内睡着了",
        "success",
    )

    # ============================================================ 1. 路径 A 经验幂等与修订
    print("\n### 1. 路径 A：经验保存、幂等、编辑冲突、修订")
    exp_payload = {
        "title": f"V06REL-A-{UID} 睡前手机位置经验",
        "understanding": f"V06REL-A-{UID} 把手机放到书桌后更容易停止刷手机。",
        "conditions": "普通工作日晚上",
        "limitations": "只有一次成功记录，仍需验证。",
        "by": "user",
        "originKind": "attempt",
        "originAttemptId": att_a["id"],
        "contextCaptureId": cap_a["id"],
        "sourceKeys": [f"attempt:{att_a['id']}"],
        "operationId": op("exp-a"),
    }
    st, saved = create_experience(client, exp_payload)
    exp_a = (saved or {}).get("experience") or {}
    c.check("路径 A 经验保存返回 201", st == 201 and bool(exp_a.get("id")), f"{st} {str(saved)[:300]}")
    st2, replay = create_experience(client, exp_payload)
    c.check(
        "路径 A 同一 operationId 重放返回同一经验",
        st2 in (200, 201) and (replay or {}).get("experience", {}).get("id") == exp_a.get("id") and replay.get("replayed") is True,
        f"{st2} {str(replay)[:300]}",
    )
    st, detail1 = client.get(f"/api/experiences/{exp_a['id']}")
    st2, detail2 = client.get(f"/api/experiences/{exp_a['id']}")
    c.check(
        "刷新/重复读取经验详情稳定",
        st == 200 and st2 == 200 and detail1.get("experience", {}).get("revision") == detail2.get("experience", {}).get("revision"),
        f"{st} {st2}",
    )
    exp_rev = detail1["experience"]["revision"]
    st, updated = client.patch(
        f"/api/experiences/{exp_a['id']}",
        {
            "title": f"V06REL-A-{UID} 睡前手机位置经验（改标题）",
            "understanding": detail1["experience"]["understanding"],
            "conditions": detail1["experience"]["conditions"],
            "limitations": detail1["experience"]["limitations"],
            "sourceKeys": [f"attempt:{att_a['id']}"],
            "revision": exp_rev,
            "operationId": op("exp-a-edit"),
        },
    )
    c.check("路径 A 经验编辑成功", st == 200 and updated.get("experience", {}).get("revision") == exp_rev + 1, f"{st} {str(updated)[:300]}")
    st, stale = client.patch(
        f"/api/experiences/{exp_a['id']}",
        {
            "title": "旧版本不应写入",
            "understanding": "冲突",
            "sourceKeys": [f"attempt:{att_a['id']}"],
            "revision": exp_rev,
            "operationId": op("exp-a-stale"),
        },
    )
    c.check("旧 revision 编辑返回 409 与 current", st == 409 and (stale or {}).get("current", {}).get("title", "").endswith("（改标题）"), f"{st} {str(stale)[:300]}")

    # 来源更新提示
    st, updated_att = client.patch(
        f"/api/attempts/{att_a['id']}",
        {
            "resultText": f"V06REL-A-{UID} 十分钟内睡着（补充：中途醒了一次）",
            "outcome": "success",
            "observedAt": att_a["observedAt"],
            "revision": att_a["revision"],
            "state": "done",
        },
    )
    c.check("路径 A 来源尝试可更新", st == 200, f"{st} {str(updated_att)[:200]}")
    st, changed = client.get(f"/api/experiences/{exp_a['id']}")
    changed_exp = changed.get("experience") or {}
    c.check(
        "来源更新后经验提示 changedSourceCount",
        st == 200 and changed_exp.get("changedSourceCount") == 1,
        str(changed_exp.get("changedSourceCount")),
    )

    # 从经验创建尝试 + operationId 幂等
    basis = [f"attempt:{att_a['id']}"]
    try_payload = {
        "captureId": cap_a["id"],
        "title": f"V06REL-A-{UID} 再试一次睡前放书桌",
        "description": "按经验再试一个普通工作日晚上。",
        "basisSourceKeys": basis,
        "experienceRevision": changed_exp.get("revision"),
        "operationId": op("try-a"),
    }
    st, try1 = client.post(f"/api/experiences/{exp_a['id']}/attempts", try_payload)
    try_attempt = (try1 or {}).get("attempt") or {}
    c.check("路径 A 从经验创建尝试返回 201", st == 201 and bool(try_attempt.get("id")), f"{st} {str(try1)[:300]}")
    st, try2 = client.post(f"/api/experiences/{exp_a['id']}/attempts", try_payload)
    c.check(
        "同一 operationId 重复创建只创建一次尝试",
        st in (200, 201) and (try2 or {}).get("attempt", {}).get("id") == try_attempt.get("id") and try2.get("replayed") is True,
        f"{st} {str(try2)[:300]}",
    )
    st, att_detail = client.get(f"/api/attempts/{try_attempt['id']}")
    ref = (att_detail or {}).get("experienceRef") or {}
    c.check(
        "新尝试保留采用时经验版本与理解",
        st == 200 and ref.get("experienceId") == exp_a["id"] and ref.get("adoptedVersion") == changed_exp.get("revision") and bool(ref.get("adoptedUnderstanding")),
        str(ref)[:400],
    )
    try_attempt = save_result(client, try_attempt, f"V06REL-A-{UID} 第二次十分钟内睡着", "success")

    # 修订经验，旧尝试 adoptedVersion 不变
    st, before_revise = client.get(f"/api/experiences/{exp_a['id']}")
    before = before_revise["experience"]
    old_revision = before["revision"]
    old_understanding = before["understanding"]
    st, revised = client.patch(
        f"/api/experiences/{exp_a['id']}",
        {
            "title": before["title"],
            "understanding": old_understanding + " 第二次也十分钟内停下，但仍只验证了两个晚上。",
            "conditions": before["conditions"],
            "limitations": "两次都有效，样本仍然很少。",
            "sourceKeys": [s["sourceKey"] for s in before["sources"]],
            "revision": old_revision,
            "operationId": op("exp-a-revise"),
        },
    )
    revised_exp = (revised or {}).get("experience") or {}
    kept = next((a for a in revised_exp.get("attempts") or [] if a.get("id") == try_attempt["id"]), None)
    c.check(
        "经验修订后旧尝试仍保留 adoptedVersion",
        st == 200 and kept is not None and kept.get("adoptedVersion") == old_revision and kept.get("adoptedUnderstanding") == ref.get("adoptedUnderstanding"),
        f"{st} {str(kept)[:400]}",
    )
    c.check(
        "经验修订后新旧理解并存",
        "十分钟内" in (revised_exp.get("understanding") or "") and "两个晚上" in (revised_exp.get("understanding") or ""),
        str(revised_exp.get("understanding"))[:300],
    )

    # ============================================================ 2. 路径 B 问答与观点经验
    print("\n### 2. 路径 B：fake-ask 问答、刷新、问答观点保存幂等")
    status, _ = client.request(
        "PUT",
        "/api/settings/ai",
        {
            "name": "v06 可靠性假模型",
            "baseUrl": f"{FAKE_BASE}/v1",
            "modelId": "fake-ask",
            "enabled": True,
            "allowLocal": True,
            "apiKey": SECRET_KEY,
        },
    )
    c.check("路径 B 配置 fake-ask", status == 200, str(status))
    cap_b = create_capture(client, f"V06REL-B-{UID} PWM 调光闪烁记录")
    b1 = create_attempt(client, cap_b["id"], f"V06REL-B-{UID} 500 Hz PWM", f"V06REL-B-{UID} 500 Hz 仍闪烁", "failure")
    b2 = create_attempt(client, cap_b["id"], f"V06REL-B-{UID} 2 kHz PWM", f"V06REL-B-{UID} 2 kHz 不可见", "success")
    client.post(
        f"/api/attempts/{b2['id']}/references",
        {"toId": b1["id"], "note": "v06 可靠性：2 kHz 基于 500 Hz", "operationId": op("ref-b")},
    )
    st, preview = client.post(
        "/api/ask/preview",
        {
            "question": f"V06REL-B-{UID} PWM 闪烁怎么处理",
            "keywords": f"V06REL-B-{UID}",
            "sourceKeys": [f"attempt:{b1['id']}", f"attempt:{b2['id']}"],
        },
    )
    c.check("路径 B 预览返回 200", st == 200 and len((preview or {}).get("records") or []) == 2, f"{st} {str(preview)[:300]}")
    ask_body = {
        "question": f"V06REL-B-{UID} PWM 闪烁怎么处理",
        "keywords": f"V06REL-B-{UID}",
        "sourceKeys": [f"attempt:{b1['id']}", f"attempt:{b2['id']}"],
        "contextToken": (preview or {}).get("contextToken"),
        "operationId": op("ask-b"),
    }
    st, ask_created = client.post("/api/ask/queries", ask_body)
    ask_id = (ask_created or {}).get("query", {}).get("id")
    c.check("路径 B 创建问答返回 202", st == 202 and bool(ask_id), f"{st} {str(ask_created)[:300]}")
    st, replay_ask = client.post("/api/ask/queries", ask_body)
    c.check(
        "同一 operationId 问答回放返回同一 query",
        st == 200 and (replay_ask or {}).get("replayed") is True and (replay_ask or {}).get("query", {}).get("id") == ask_id,
        f"{st} {str(replay_ask)[:300]}",
    )
    st, ask_detail = wait_query(client, ask_id or "")
    ask_query = (ask_detail or {}).get("query") or {}
    c.check("路径 B 问答生成成功", st == 200 and ask_query.get("status") == "succeeded", f"{st} {ask_query.get('status')} {ask_query.get('errorCode')}")
    st, ask_again = client.get(f"/api/ask/queries/{ask_id}")
    c.check(
        "刷新读取问答详情稳定",
        st == 200 and (ask_again or {}).get("query", {}).get("answer", {}).get("summary") == ask_query.get("answer", {}).get("summary"),
        f"{st}",
    )
    st, draft_res = client.get(f"/api/ask/queries/{ask_id}/experience-draft?pointIndex=0")
    draft = (draft_res or {}).get("draft") or {}
    c.check("问答观点草稿可读取", st == 200 and bool(draft.get("sources")), f"{st} {str(draft_res)[:300]}")
    ask_exp_payload = {
        "title": f"V06REL-B-{UID} 问答观点经验",
        "understanding": draft.get("understanding") or f"V06REL-B-{UID} 问答观点整理",
        "conditions": draft.get("conditions"),
        "limitations": draft.get("limitations"),
        "by": "model",
        "modelBasis": draft.get("modelBasis"),
        "originKind": "ask",
        "originQueryId": ask_id,
        "originPointIndex": 0,
        "contextCaptureId": cap_b["id"],
        "sourceKeys": [s["sourceKey"] for s in draft.get("sources") or []],
        "operationId": op("exp-b"),
    }
    st, ask_exp_saved = create_experience(client, ask_exp_payload)
    ask_exp = (ask_exp_saved or {}).get("experience") or {}
    c.check("路径 B 问答观点保存经验返回 201", st == 201 and bool(ask_exp.get("id")), f"{st} {str(ask_exp_saved)[:300]}")
    st, ask_exp_replay = create_experience(client, ask_exp_payload)
    c.check(
        "问答经验同一 operationId 重放返回同一经验",
        st in (200, 201) and (ask_exp_replay or {}).get("experience", {}).get("id") == ask_exp.get("id") and ask_exp_replay.get("replayed") is True,
        f"{st} {str(ask_exp_replay)[:300]}",
    )

    # ============================================================ 3. 来源删除与搜索/导出
    print("\n### 3. 来源删除后的页面数据/搜索/导出")
    deleted_token = f"V06REL-A-{UID} 十分钟内睡着（补充：中途醒了一次）"
    status, _ = client.delete(f"/api/attempts/{att_a['id']}")
    c.check("删除路径 A 来源尝试成功", status == 200, str(status))
    st, after_delete = client.get(f"/api/experiences/{exp_a['id']}")
    after_exp = (after_delete or {}).get("experience") or {}
    deleted_src = next((s for s in after_exp.get("sources") or [] if s.get("id") == att_a["id"]), None)
    c.check(
        "来源删除后经验标记 deleted 且正文不泄露",
        st == 200 and deleted_src is not None and deleted_src.get("deleted") is True and deleted_src.get("resultText") is None,
        str(deleted_src)[:400],
    )
    st, search = client.get("/api/search?q=" + urllib.parse.quote(deleted_token))
    c.check(
        "来源删除后搜索不返回已删正文",
        st == 200
        and not (search or {}).get("experiences")
        and not (search or {}).get("captures")
        and not (search or {}).get("attempts"),
        str(search)[:300],
    )
    st, export = client.get("/api/export")
    export_text = json.dumps(export, ensure_ascii=False)
    c.check("导出 schemaVersion>=6（当前 7）", st == 200 and export.get("schemaVersion") in (6, 7), f"{st} {export.get('schemaVersion')}")
    c.check("导出不包含已删来源正文", deleted_token not in export_text, "leak")
    notes = (export.get("data") or {}).get("experienceNotes") or []
    c.check(
        "导出包含路径 A/B 经验与问答来源清洗后的记录",
        any(x.get("captureId") == exp_a["id"] for x in notes)
        and any(x.get("captureId") == ask_exp.get("id") for x in notes),
        str([x.get("captureId") for x in notes]),
    )

    # ============================================================ 4. 重启服务后数据仍在
    print("\n### 4. 重启服务后数据仍在")
    if app_proc is not None:
        stop_app()
        time.sleep(1)
        start_app()
    else:
        print("SKIP  外部服务模式不执行进程重启，仅复用同一服务读取")
    client = new_client()
    st, exp_a_after = client.get(f"/api/experiences/{exp_a['id']}")
    c.check("重启后路径 A 经验仍在", st == 200 and (exp_a_after or {}).get("experience", {}).get("id") == exp_a["id"], f"{st}")
    st, exp_b_after = client.get(f"/api/experiences/{ask_exp['id']}")
    c.check("重启后路径 B 经验仍在", st == 200 and (exp_b_after or {}).get("experience", {}).get("id") == ask_exp["id"], f"{st}")
    st, ask_after = client.get(f"/api/ask/queries/{ask_id}")
    c.check(
        "重启后问答仍在且状态成功",
        st == 200 and (ask_after or {}).get("query", {}).get("status") == "succeeded",
        f"{st} {(ask_after or {}).get('query', {}).get('status')}",
    )
    st, export_after = client.get("/api/export")
    c.check("重启后导出 schemaVersion>=6（当前 7）", st == 200 and (export_after or {}).get("schemaVersion") in (6, 7), f"{st} {(export_after or {}).get('schemaVersion')}")

    # ============================================================ 5. 恢复配置
    status, _ = client.delete("/api/settings/ai")
    c.check("测试结束删除 AI 配置", status == 200, str(status))

    ok = c.report("v0.6 路径数据可靠性验收")
    return 0 if ok else 1


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR 测试执行异常：{exc}")
        traceback.print_exc()
        exit_code = 1
    finally:
        if client is not None:
            try:
                client.delete("/api/settings/ai")
            except Exception:  # noqa: BLE001
                pass
        stop_app()
        stop_fake()
    sys.exit(exit_code)
