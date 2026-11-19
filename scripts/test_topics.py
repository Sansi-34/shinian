# -*- coding: utf-8 -*-
"""拾念 SHINIAN · 「主题」验收测试

默认自启动隔离服务（db/test-topics.sqlite，端口 3220）与 fake model（3501）；
设置 SHINIAN_BASE 可复用已有服务（此时不清理数据库）。

覆盖：
- CRUD / 标题与说明 / 版本 CAS / operationId 幂等与冲突
- 成员唯一、经验加入两个主题、候选搜索与 type 过滤、cursor 分页
- 尝试聚合去重、排序、结果三态与 state 过滤
- next-attempt 校验、取消 attempt 清理、成员移除清理、删除 attempt 计数
- 删除 capture 清理 topic_members / next_attempt，主题保留
- delete-preview 不删除任何原记录，删除主题只删主题与成员关系
- 归档不级联成员、归档过滤
- 导出 schemaVersion 7 的 topics / topicMembers 字段
- 主题问答范围隔离、经验依据去重、越界 source 400、预览后成员变化 409
- 整库 SQLite 备份包含新表
"""
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

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
TEST_DB = os.environ.get("SHINIAN_TEST_DB", os.path.join(ROOT, "db", "test-topics.sqlite"))
DEFAULT_PORT = int(os.environ.get("SHINIAN_TOPICS_TEST_PORT", "3220"))

c = Checker()
client = Client(base=BASE)
uid = uuid.uuid4().hex[:8]
app_proc = None
app_log = None
fake_proc = None


def ms_now() -> int:
    return int(time.time() * 1000)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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


def start_test_server():
    global BASE, TEST_DB, app_proc, app_log
    if BASE:
        print(f"复用外部测试服务: {BASE}（DB: {TEST_DB}）")
        return
    TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test-topics.sqlite")
    if "test" not in os.path.basename(TEST_DB).lower():
        raise RuntimeError(f"拒绝自动删除非测试数据库：{TEST_DB}")
    master_key = os.path.join(ROOT, "db", "test-topics-master.key")
    log_path = os.path.join(ROOT, "db", "test-topics-server.log")
    for path in (TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm", master_key, log_path):
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    port = DEFAULT_PORT
    if port_open("127.0.0.1", port):
        raise RuntimeError(f"端口 {port} 已被占用；请先停止或设置 SHINIAN_TOPICS_TEST_PORT")
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["DATABASE_URL"] = TEST_DB
    env["SHINIAN_MASTER_KEY_FILE"] = master_key
    env["SHINIAN_AI_TIMEOUT_MS"] = os.environ.get("SHINIAN_AI_TIMEOUT_MS", "3000")
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
            import urllib.request
            import urllib.error

            urllib.request.urlopen(BASE + "/api/session/check", timeout=1)
        except urllib.error.HTTPError:
            print(f"已启动隔离测试服务: {BASE}（DB: {TEST_DB}）")
            global client
            client = Client(base=BASE)
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


def fake_get(path):
    import urllib.request

    with urllib.request.urlopen(FAKE_BASE + path, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


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


def call(method, path, data=None):
    return client.request(method, path, data)


def check(name, cond, detail=""):
    c.check(name, bool(cond), detail)


def expect_status(name, resp, status):
    got, body = resp
    check(name, got == status, f"status={got}, body={json.dumps(body, ensure_ascii=False)[:400]}")
    return body


def expect_error(name, resp, status, error):
    body = expect_status(name, resp, status)
    check(f"{name} error={error}", isinstance(body, dict) and body.get("error") == error, repr(body))
    return body


def create_capture(text):
    st, body = call("POST", "/api/captures", {"rawText": text})
    assert st == 200, (st, body)
    return body["capture"]["id"]


def create_attempt(capture_id, step, state="todo", result=None, outcome=None, observed_at=None):
    op = f"att-{uid}-{uuid.uuid4().hex[:8]}"
    payload = {"step": step, "state": state, "operationId": op}
    if result is not None:
        payload["resultText"] = result
    if outcome is not None:
        payload["outcome"] = outcome
    st, body = call("POST", f"/api/captures/{capture_id}/attempts", payload)
    assert st == 200, (st, body)
    attempt = body["attempt"]
    if observed_at is not None:
        st2, body2 = call(
            "PATCH",
            f"/api/attempts/{attempt['id']}",
            {
                "revision": attempt["revision"],
                "state": state,
                "resultText": result,
                "outcome": outcome,
                "observedAt": observed_at,
            },
        )
        assert st2 == 200, (st2, body2)
        attempt = body2["attempt"]
    return attempt


def create_experience(title, understanding, source_keys, origin_attempt=None, context_capture=None):
    op = f"exp-{uid}-{uuid.uuid4().hex[:8]}"
    payload = {
        "title": title,
        "understanding": understanding,
        "conditions": "",
        "limitations": "",
        "by": "user",
        "originKind": "attempt" if origin_attempt else "manual",
        "originAttemptId": origin_attempt,
        "contextCaptureId": context_capture,
        "sourceKeys": source_keys,
        "operationId": op,
    }
    st, body = call("POST", "/api/experiences", payload)
    assert st == 201, (st, body)
    return body["experience"]["id"]


def create_topic(payload):
    body = dict(payload)
    body.setdefault("operationId", f"topic-{uid}-{uuid.uuid4().hex[:8]}")
    return call("POST", "/api/topics", body)


def topic_detail(topic_id):
    st, body = call("GET", f"/api/topics/{topic_id}")
    assert st == 200, (st, body)
    return body


def topic_revision(topic_id):
    return topic_detail(topic_id)["topic"]["revision"]


def run():
    start_fake_server()
    start_test_server()
    client.login(f"主题测试-{uid}")

    # ---------------------------------------------------------------- 0. 未登录
    anonymous = Client(base=BASE)
    expect_error("未登录 GET /api/topics 401", anonymous.get("/api/topics"), 401, "unauthenticated")

    # ---------------------------------------------------------------- 1. 基础数据
    cap_a = create_capture("PWM 低占空比时 LED 会闪，500 Hz 下肉眼可见")
    cap_b = create_capture("2 kHz 下 LED 不闪")
    cap_c = create_capture("周末整理书架")
    cap_d = create_capture("阳台植物浇水：土壤干了再浇")
    cap_e = create_capture("PWM 占空比固定在 30%")
    check("基础 capture 创建", all([cap_a, cap_b, cap_c, cap_d, cap_e]))

    a1 = create_attempt(cap_a, "把 PWM 频率从 500 Hz 改到 2 kHz 再观察", "todo")
    a2 = create_attempt(
        cap_a,
        "比较 2 kHz 与 500 Hz 的闪烁",
        "done",
        result="2 kHz 时肉眼未见闪烁",
        outcome="success",
        observed_at=ms_now() - 5000,
    )
    a3 = create_attempt(cap_a, "取消的尝试", "cancelled")
    b1 = create_attempt(cap_b, "只记录状态，没有写结果", "done")
    d1 = create_attempt(
        cap_d,
        "土壤干透后浇水",
        "done",
        result="土壤干了才浇水，植物状态更好",
        outcome="success",
        observed_at=ms_now() - 60000,
    )
    c1 = create_attempt(cap_c, "整理书架第一层", "todo")

    e1 = create_experience(
        "土壤干了再浇水",
        "等表土干透再浇，避免积水。",
        [f"attempt:{d1['id']}"],
        origin_attempt=d1["id"],
        context_capture=cap_d,
    )
    e2 = create_experience(
        "降到 2 kHz 可减少可见闪烁",
        "记录里 2 kHz 时肉眼未见闪烁；只改频率，不宣称因果。",
        [f"attempt:{a2['id']}"],
        origin_attempt=a2["id"],
        context_capture=cap_a,
    )
    check("经验创建用于主题成员", bool(e1 and e2))

    # ---------------------------------------------------------------- 2. 创建主题
    st, t1_body = create_topic(
        {
            "title": "PWM 调光实验",
            "exploringQuestion": "不同频率下 LED 是否闪烁？",
            "continueNote": "先记录 500 Hz 与 2 kHz 的对照。",
            "captureIds": [cap_a, cap_b, e2],
            "nextAttemptId": a1["id"],
        }
    )
    expect_status("POST /api/topics 创建主题 201", (st, t1_body), 201)
    t1 = t1_body["topic"]["id"]
    check("主题返回 title/name 双字段", t1_body["topic"]["title"] == "PWM 调光实验" and t1_body["topic"]["name"] == "PWM 调光实验")
    check("主题 memberCount/thoughtCount/experienceCount", (t1_body["topic"]["memberCount"], t1_body["topic"]["thoughtCount"], t1_body["topic"]["experienceCount"]) == (3, 2, 1), repr(t1_body["topic"]))
    check("主题 nextAttempt 摘要", t1_body["topic"]["nextAttempt"]["id"] == a1["id"] and t1_body["topic"]["nextAttempt"]["isCompleted"] is False)
    check("主题成员分组", len(t1_body["members"]["thoughts"]) == 2 and len(t1_body["members"]["experiences"]) == 1)
    check("主题 memberList 扁平兼容", len(t1_body["memberList"]) == 3)
    exp_member = next((m for m in t1_body["memberList"] if m["kind"] == "experience"), None)
    check("经验成员额外字段", bool(exp_member and exp_member.get("sourceCount") == 1 and exp_member.get("derivationBy") == "user" and exp_member.get("hasPracticeResult") is True))

    st, t2_body = create_topic(
        {
            "title": "阳台植物",
            "captureIds": [cap_d, e1, cap_c],
            "nextAttemptId": c1["id"],
        }
    )
    expect_status("创建第二个主题 201", (st, t2_body), 201)
    t2 = t2_body["topic"]["id"]
    st, t3_body = create_topic({"title": "临时主题", "captureIds": [cap_a], "nextAttemptId": a1["id"]})
    expect_status("创建第三个主题 201", (st, t3_body), 201)
    t3 = t3_body["topic"]["id"]
    st, t4_body = create_topic({"title": "待删除 capture 主题", "captureIds": [cap_c], "nextAttemptId": c1["id"]})
    expect_status("创建第四个主题 201", (st, t4_body), 201)
    t4 = t4_body["topic"]["id"]

    # 创建校验
    expect_error("创建主题空标题 400", create_topic({"title": ""}), 400, "invalid_title")
    expect_error("创建主题标题超长 400", create_topic({"title": "x" * 121}), 400, "invalid_title")
    expect_error("创建主题缺 operationId 400", call("POST", "/api/topics", {"title": "x"}), 400, "invalid_operation_id")
    expect_error(
        "创建主题 nextAttempt 非成员 400",
        create_topic({"title": "坏下一步", "captureIds": [cap_b], "nextAttemptId": a1["id"]}),
        400,
        "invalid_next_attempt",
    )
    bad_next = expect_error(
        "创建主题 nextAttempt 已完成 400",
        create_topic({"title": "坏下一步2", "captureIds": [cap_a], "nextAttemptId": a2["id"]}),
        400,
        "invalid_next_attempt",
    )
    check("已完成 nextAttempt reason", bad_next.get("reason") == "attempt_completed", repr(bad_next))
    missing = expect_error(
        "创建主题 capture 不存在 400",
        create_topic({"title": "坏成员", "captureIds": ["cap-does-not-exist"]}),
        400,
        "capture_not_found",
    )
    check("capture_not_found 附带缺失 ID", missing.get("captureIds") == ["cap-does-not-exist"], repr(missing))

    # ---------------------------------------------------------------- 3. 列表与查询
    st, list_body = call("GET", "/api/topics")
    expect_status("GET /api/topics 200", (st, list_body), 200)
    check("主题列表默认不含归档且分页字段完整", isinstance(list_body.get("topics"), list) and list_body.get("total") == 4 and list_body.get("limit") == 20 and list_body.get("offset") == 0 and "hasMore" in list_body and "nextCursor" in list_body, repr(list_body))
    check("主题列表按 updated_at DESC", all(list_body["topics"][i]["updatedAt"] >= list_body["topics"][i + 1]["updatedAt"] for i in range(len(list_body["topics"]) - 1)))
    st, q_body = call("GET", "/api/topics?q=PWM")
    check("主题 q 搜索命中", st == 200 and any(t["id"] == t1 for t in q_body["topics"]))
    st, q_body2 = call("GET", "/api/topics?q=不存在的关键词")
    check("主题 q 空结果 200", st == 200 and q_body2["total"] == 0 and q_body2["topics"] == [])
    st, page1 = call("GET", "/api/topics?limit=2")
    check("主题 cursor 首页", st == 200 and len(page1["topics"]) == 2 and page1["hasMore"] is True and page1["nextCursor"])
    st, page2 = call("GET", f"/api/topics?limit=2&cursor={page1['nextCursor']}")
    check("主题 cursor 第二页无重复", st == 200 and not ({t["id"] for t in page1["topics"]} & {t["id"] for t in page2["topics"]}))

    # ---------------------------------------------------------------- 4. 详情 / PATCH / CAS / 幂等
    st, detail = call("GET", f"/api/topics/{t1}")
    expect_status("GET /api/topics/:id 200", (st, detail), 200)
    check("详情包含 thoughts/experiences/memberList", len(detail["members"]["thoughts"]) == 2 and len(detail["members"]["experiences"]) == 1 and len(detail["memberList"]) == 3)
    check("详情 nextAttempt href/step", detail["topic"]["nextAttempt"]["href"].startswith("/attempt/") and detail["topic"]["nextAttempt"]["step"])
    expect_error("详情不存在 404", call("GET", "/api/topics/topic-missing"), 404, "topic_not_found")

    patch_payload = {
        "title": "PWM 频率对照",
        "exploringQuestion": "不同频率下 LED 是否闪烁？",
        "continueNote": "先只改频率。",
        "expectedRevision": 1,
        "operationId": "op-patch-1",
    }
    st, patched = call("PATCH", f"/api/topics/{t1}", patch_payload)
    expect_status("PATCH 主题 200", (st, patched), 200)
    check("PATCH 成功 revision+1", patched["topic"]["revision"] == 2 and patched["topic"]["title"] == "PWM 频率对照")
    st, replay = call("PATCH", f"/api/topics/{t1}", patch_payload)
    check("PATCH 同 operationId 回放", st == 200 and replay.get("replayed") is True and replay["topic"]["revision"] == 2, repr(replay))
    expect_error(
        "PATCH 同 operationId 不同请求 409",
        call("PATCH", f"/api/topics/{t1}", {**patch_payload, "title": "另一个标题"}),
        409,
        "operation_key_conflict",
    )
    conflict = expect_error(
        "PATCH 旧 revision 409",
        call("PATCH", f"/api/topics/{t1}", {"title": "旧版本", "expectedRevision": 1, "operationId": "op-patch-stale"}),
        409,
        "revision_conflict",
    )
    check("revision_conflict 带 currentRevision/currentTopic", conflict.get("currentRevision") == 2 and conflict.get("currentTopic", {}).get("id") == t1, repr(conflict))
    st, cleared = call(
        "PATCH",
        f"/api/topics/{t1}",
        {"exploringQuestion": "", "continueNote": None, "expectedRevision": 2, "operationId": "op-patch-clear"},
    )
    check("PATCH 可清空说明", st == 200 and cleared["topic"]["exploringQuestion"] is None and cleared["topic"]["continueNote"] is None and cleared["topic"]["revision"] == 3, repr(cleared))
    expect_error(
        "PATCH 标题超长 400",
        call("PATCH", f"/api/topics/{t1}", {"title": "x" * 121, "expectedRevision": 3, "operationId": "op-patch-long"}),
        400,
        "invalid_title",
    )
    expect_error(
        "PATCH 缺 expectedRevision 428",
        call("PATCH", f"/api/topics/{t1}", {"title": "无版本", "operationId": "op-patch-norev"}),
        428,
        "revision_required",
    )

    # ---------------------------------------------------------------- 5. 归档 / 恢复
    before_archive = topic_detail(t3)["topic"]
    st, archived = call("POST", f"/api/topics/{t3}/archive", {})
    check("归档可省略 expectedRevision", st == 200 and archived["topic"]["archived"] is True and archived["topic"]["revision"] == before_archive["revision"] + 1, repr(archived))
    after_archive = topic_detail(t3)["topic"]
    check("归档不级联成员", after_archive["memberCount"] == before_archive["memberCount"] and after_archive["thoughtCount"] == before_archive["thoughtCount"])
    st, archived_list = call("GET", "/api/topics?archived=1")
    check("归档列表包含主题", st == 200 and any(t["id"] == t3 for t in archived_list["topics"]))
    st, active_list = call("GET", "/api/topics?archived=0")
    check("默认列表排除归档", all(t["id"] != t3 for t in active_list["topics"]))
    st, restored = call("POST", f"/api/topics/{t3}/restore", {"expectedRevision": after_archive["revision"], "operationId": "op-restore-1"})
    check("恢复主题 200", st == 200 and restored["topic"]["archived"] is False)
    st, replay_restore = call("POST", f"/api/topics/{t3}/restore", {"expectedRevision": after_archive["revision"], "operationId": "op-restore-1"})
    check("恢复 operationId 回放", st == 200 and replay_restore.get("replayed") is True)
    expect_error("归档非法 archived 参数 400", call("GET", "/api/topics?archived=yes"), 400, "invalid_archived")

    # ---------------------------------------------------------------- 6. 成员候选
    st, cand = call("GET", f"/api/topics/{t1}/member-candidates?q=" + "浇水")
    expect_status("成员候选搜索 200", (st, cand), 200)
    check("成员候选包含经验与念头", {x["kind"] for x in cand["candidates"]} >= {"thought", "experience"}, repr(cand))
    check("成员候选不返回 attempt", all(not x["captureId"].startswith("att-") for x in cand["candidates"]))
    check("成员候选 alreadyMember=false", all(x["alreadyMember"] is False for x in cand["candidates"]))
    st, cand_exp = call("GET", f"/api/topics/{t1}/member-candidates?type=experience&limit=30")
    check("成员候选 type=experience 过滤", st == 200 and all(x["kind"] == "experience" for x in cand_exp["candidates"]))
    st, cand_page1 = call("GET", f"/api/topics/{t1}/member-candidates?limit=1")
    check("成员候选 cursor 首页", st == 200 and len(cand_page1["candidates"]) == 1 and cand_page1["nextCursor"])
    st, cand_page2 = call("GET", f"/api/topics/{t1}/member-candidates?limit=1&cursor={cand_page1['nextCursor']}")
    check("成员候选 cursor 第二页", st == 200 and cand_page2["candidates"] and cand_page2["candidates"][0]["captureId"] != cand_page1["candidates"][0]["captureId"])
    check("成员候选响应字段", cand_page1["query"] == "" and cand_page1["type"] == "all" and cand_page1["limit"] == 1)

    # ---------------------------------------------------------------- 7. 成员增删与多主题经验
    st, added = call(
        "POST",
        f"/api/topics/{t1}/members",
        {"captureIds": [e1, cap_d, e1], "operationId": "op-members-1"},
    )
    expect_status("添加成员 200", (st, added), 200)
    check("添加成员 added/existing", added.get("added") == 2 and added.get("existing") == 0 and added.get("skipped") == 0, repr(added))
    check("添加成员 addedIds 去重", sorted(added.get("addedIds") or []) == sorted([e1, cap_d]), repr(added))
    check("添加成员返回全部 members", len(added.get("members") or []) == 5)
    st, added_replay = call(
        "POST",
        f"/api/topics/{t1}/members",
        {"captureIds": [e1, cap_d, e1], "operationId": "op-members-1"},
    )
    check("添加成员幂等回放", st == 200 and added_replay.get("replayed") is True)
    expect_error(
        "添加成员同 operationId 不同请求 409",
        call("POST", f"/api/topics/{t1}/members", {"captureIds": [e1], "operationId": "op-members-1"}),
        409,
        "operation_key_conflict",
    )
    st, already = call(
        "POST",
        f"/api/topics/{t1}/members",
        {"captureIds": [e1], "operationId": "op-members-existing"},
    )
    check("重复成员不报错", st == 200 and already.get("added") == 0 and already.get("existing") == 1 and already.get("skippedIds") == [e1])
    expect_error(
        "添加不存在 capture 400",
        call("POST", f"/api/topics/{t1}/members", {"captureIds": ["cap-missing"], "operationId": "op-members-missing"}),
        400,
        "capture_not_found",
    )
    st, cap_topics = call("GET", f"/api/captures/{e1}/topics")
    check("经验同时属于两个主题", st == 200 and {x["id"] for x in cap_topics["topics"]} >= {t1, t2}, repr(cap_topics))
    check("capture topics 含 memberKind/memberCreatedAt", all(x.get("memberKind") == "experience" and x.get("memberCreatedAt") for x in cap_topics["topics"]))
    st, cap_add = call(
        "POST",
        f"/api/captures/{cap_e}/topics",
        {"topicIds": [t1, t3], "operationId": "op-capture-topics-1"},
    )
    check("记录详情加入多个主题", st == 200 and cap_add.get("added") == 2 and len(cap_add.get("topics") or []) == 2, repr(cap_add))
    st, cap_add_replay = call(
        "POST",
        f"/api/captures/{cap_e}/topics",
        {"topicIds": [t1, t3], "operationId": "op-capture-topics-1"},
    )
    check("记录加入主题幂等回放", st == 200 and cap_add_replay.get("replayed") is True)
    st, cap_e_topics = call("GET", f"/api/captures/{cap_e}/topics")
    check("记录主题列表包含两个主题", st == 200 and len(cap_e_topics["topics"]) == 2)

    # 归档 capture 不级联删除主题/成员；归档主题仍出现在记录详情中
    before_cap_archive = topic_detail(t1)["topic"]
    st, cap_archived = call("POST", f"/api/captures/{cap_d}/archive", {})
    check("归档 capture 200", st == 200 and cap_archived["capture"]["archivedAt"] is not None)
    after_cap_archive = topic_detail(t1)
    archived_member = next((m for m in after_cap_archive["memberList"] if m["captureId"] == cap_d), None)
    check("归档 capture 不级联主题成员", after_cap_archive["topic"]["memberCount"] == before_cap_archive["memberCount"] and archived_member and archived_member["archived"] is True, repr(archived_member))
    call("POST", f"/api/captures/{cap_d}/restore", {})
    t3_detail = topic_detail(t3)["topic"]
    st, t3_archived = call("POST", f"/api/topics/{t3}/archive", {"expectedRevision": t3_detail["revision"], "operationId": "op-archive-t3-2"})
    check("归档主题 200", st == 200)
    st, cap_e_topics_archived = call("GET", f"/api/captures/{cap_e}/topics")
    check("记录详情含已归档主题", st == 200 and any(x["id"] == t3 and x["archived"] is True for x in cap_e_topics_archived["topics"]), repr(cap_e_topics_archived))
    t3_detail2 = topic_detail(t3)["topic"]
    call("POST", f"/api/topics/{t3}/restore", {"expectedRevision": t3_detail2["revision"]})

    # ---------------------------------------------------------------- 8. 尝试聚合
    st, all_attempts = call("GET", f"/api/topics/{t1}/attempts?limit=50")
    expect_status("主题尝试聚合 200", (st, all_attempts), 200)
    ids = [x["id"] for x in all_attempts["attempts"]]
    check("尝试聚合去重", len(ids) == len(set(ids)))
    check("尝试聚合数量", len(ids) == 5, f"ids={ids}, total={all_attempts.get('total')}")
    states = {x["id"]: x["resultState"] for x in all_attempts["attempts"]}
    check("resultState 三态存在", set(states.values()) == {"recorded", "pending_no_result", "cancelled"}, repr(states))
    check("recorded 判定", states.get(a2["id"]) == "recorded" and states.get(d1["id"]) == "recorded")
    check("pending_no_result 判定", states.get(a1["id"]) == "pending_no_result" and states.get(b1["id"]) == "pending_no_result")
    check("cancelled 判定", states.get(a3["id"]) == "cancelled")
    dates = [x["observedAt"] if x["observedAt"] is not None else x["createdAt"] for x in all_attempts["attempts"]]
    check("尝试排序 COALESCE(observed_at,created_at) DESC", dates == sorted(dates, reverse=True), repr(dates))
    st, recorded = call("GET", f"/api/topics/{t1}/attempts?state=recorded")
    check("state=recorded 过滤", st == 200 and all(x["resultState"] == "recorded" for x in recorded["attempts"]))
    st, pending = call("GET", f"/api/topics/{t1}/attempts?state=pending")
    check("state=pending 过滤", st == 200 and all(x["resultState"] == "pending_no_result" for x in pending["attempts"]))
    st, cancelled = call("GET", f"/api/topics/{t1}/attempts?state=cancelled")
    check("state=cancelled 过滤", st == 200 and all(x["resultState"] == "cancelled" for x in cancelled["attempts"]))
    expect_error("非法 state 400", call("GET", f"/api/topics/{t1}/attempts?state=done"), 400, "invalid_attempt_state")
    st, att_page1 = call("GET", f"/api/topics/{t1}/attempts?limit=2")
    check("尝试 cursor 首页", st == 200 and len(att_page1["attempts"]) == 2 and att_page1["nextCursor"] and att_page1["hasMore"] is True)
    st, att_page2 = call("GET", f"/api/topics/{t1}/attempts?limit=2&cursor={att_page1['nextCursor']}")
    check("尝试 cursor 第二页无重复", st == 200 and not ({x["id"] for x in att_page1["attempts"]} & {x["id"] for x in att_page2["attempts"]}))
    expect_error("主题不存在时尝试 404", call("GET", "/api/topics/topic-missing/attempts"), 404, "topic_not_found")

    # ---------------------------------------------------------------- 9. next-attempt 校验与清理
    rev = topic_revision(t1)
    st, next_set = call(
        "PUT",
        f"/api/topics/{t1}/next-attempt",
        {"attemptId": a1["id"], "expectedRevision": rev, "operationId": "op-next-1"},
    )
    check("PUT next-attempt 设置成功", st == 200 and next_set["topic"]["nextAttempt"]["id"] == a1["id"] and next_set.get("clearedReason") is None)
    rev = next_set["topic"]["revision"]
    bad = expect_error(
        "next-attempt 已完成 400",
        call("PUT", f"/api/topics/{t1}/next-attempt", {"attemptId": a2["id"], "expectedRevision": rev, "operationId": "op-next-done"}),
        400,
        "invalid_next_attempt",
    )
    check("已完成 reason", bad.get("reason") == "attempt_completed")
    bad = expect_error(
        "next-attempt 非成员 400",
        call("PUT", f"/api/topics/{t1}/next-attempt", {"attemptId": c1["id"], "expectedRevision": rev, "operationId": "op-next-outside"}),
        400,
        "invalid_next_attempt",
    )
    check("非成员 reason", bad.get("reason") == "not_thought_member")
    bad = expect_error(
        "next-attempt 已取消 400",
        call("PUT", f"/api/topics/{t1}/next-attempt", {"attemptId": a3["id"], "expectedRevision": rev, "operationId": "op-next-cancelled"}),
        400,
        "invalid_next_attempt",
    )
    check("已取消 reason", bad.get("reason") == "attempt_cancelled")
    st, next_null = call(
        "PUT",
        f"/api/topics/{t1}/next-attempt",
        {"attemptId": None, "expectedRevision": rev, "operationId": "op-next-null"},
    )
    check("PUT next-attempt 清空", st == 200 and next_null["topic"]["nextAttempt"] is None)
    rev = next_null["topic"]["revision"]
    st, next_set2 = call(
        "PUT",
        f"/api/topics/{t1}/next-attempt",
        {"attemptId": a1["id"], "expectedRevision": rev, "operationId": "op-next-2"},
    )
    check("PUT next-attempt 重新设置", st == 200 and next_set2["topic"]["nextAttempt"]["id"] == a1["id"])

    # 取消固定中的 attempt 自动清空主题
    st, cancel_body = call(
        "PATCH",
        f"/api/attempts/{a1['id']}",
        {"revision": a1["revision"], "state": "cancelled"},
    )
    expect_status("PATCH attempt 取消 200", (st, cancel_body), 200)
    check("取消 attempt 返回 clearedTopicNext", cancel_body.get("clearedTopicNext", 0) >= 1, repr(cancel_body))
    t1_after_cancel = topic_detail(t1)["topic"]
    check("取消 attempt 后主题 nextAttempt 清空", t1_after_cancel["nextAttempt"] is None)
    check("取消 attempt 不影响其他记录", call("GET", f"/api/attempts/{a1['id']}")[0] == 200)
    # 恢复 a1 为 todo 供后面再次固定
    st, reopened = call(
        "PATCH",
        f"/api/attempts/{a1['id']}",
        {"revision": cancel_body["attempt"]["revision"], "state": "todo", "resultText": None},
    )
    check("恢复 attempt 为 todo", st == 200)

    # 移出成员清空固定
    rev3 = topic_revision(t3)
    st, set3 = call(
        "PUT",
        f"/api/topics/{t3}/next-attempt",
        {"attemptId": a1["id"], "expectedRevision": rev3, "operationId": "op-next-t3"},
    )
    check("第三个主题设置固定", st == 200 and set3["topic"]["nextAttempt"]["id"] == a1["id"])
    st, removed = call("DELETE", f"/api/topics/{t3}/members/{cap_a}")
    check("移出成员返回 removed/clearedNext", st == 200 and removed.get("removed") is True and removed.get("clearedNext") is True and removed.get("clearedNextAttempt") is True, repr(removed))
    check("移出成员后固定清空", removed["topic"]["nextAttemptId"] is None)
    check("移出成员不删除 capture", call("GET", f"/api/captures/{cap_a}")[0] == 200)
    expect_error("重复移出成员 404", call("DELETE", f"/api/topics/{t3}/members/{cap_a}"), 404, "member_not_found")

    # ---------------------------------------------------------------- 10. 删除 attempt 计数
    st, p5 = call("POST", f"/api/captures/{cap_a}/attempts", {"step": "删除我", "state": "todo", "operationId": "op-p5"})
    p5_id = p5["attempt"]["id"]
    rev_ask_t1 = topic_revision(t1)
    st, set_p5 = call(
        "PUT",
        f"/api/topics/{t1}/next-attempt",
        {"attemptId": p5_id, "expectedRevision": rev_ask_t1, "operationId": "op-next-p5"},
    )
    check("设置待删除 attempt 为固定", st == 200 and set_p5["topic"]["nextAttempt"]["id"] == p5_id)
    st, del_att = call("DELETE", f"/api/attempts/{p5_id}")
    check("删除 attempt 返回 unfixedTopicCount", st == 200 and del_att.get("unfixedTopicCount") == 1, repr(del_att))
    check("删除 attempt 后主题固定清空", topic_detail(t1)["topic"]["nextAttempt"] is None)

    # ---------------------------------------------------------------- 11. 删除 capture 清理
    st, del_cap = call("DELETE", f"/api/captures/{cap_c}")
    expect_status("删除 capture 200", (st, del_cap), 200)
    check("删除 capture 返回 topic 清理计数", del_cap.get("deletedTopicMembers", 0) >= 2 and del_cap.get("clearedTopicNext", 0) >= 2, repr(del_cap))
    t2_after = topic_detail(t2)["topic"]
    check("删除 capture 后主题保留且成员减少", t2_after["memberCount"] == 2 and t2_after["nextAttempt"] is None)
    t4_after = topic_detail(t4)["topic"]
    check("删除 capture 后另一主题也保留", t4_after["memberCount"] == 0 and t4_after["nextAttempt"] is None)
    expect_error("删除后 capture 404", call("GET", f"/api/captures/{cap_c}"), 404, "capture not found")

    # ---------------------------------------------------------------- 12. delete-preview / 删除主题
    st, preview = call("GET", f"/api/topics/{t2}/delete-preview")
    expect_status("delete-preview 200", (st, preview), 200)
    check("delete-preview 计数", preview.get("memberCount") == 2 and preview.get("thoughtCount") == 1 and preview.get("experienceCount") == 1, repr(preview))
    check("delete-preview 保留计数", preview.get("preserved", {}).get("captures") == 2 and "attempts" in preview.get("preserved", {}) and "experienceSources" in preview.get("preserved", {}))
    check("delete-preview fixedAttemptId 字段", "fixedAttemptId" in preview and preview["fixedAttemptId"] is None, repr(preview.get("fixedAttemptId")))
    check("delete-preview 不删除原记录", call("GET", f"/api/captures/{cap_d}")[0] == 200 and call("GET", f"/api/attempts/{d1['id']}")[0] == 200)
    st, del_topic = call("DELETE", f"/api/topics/{t2}")
    check("DELETE topic 只删主题与成员", st == 200 and del_topic.get("deletedMembers") == 2, repr(del_topic))
    expect_error("删除后主题 404", call("GET", f"/api/topics/{t2}"), 404, "topic_not_found")
    check("删除主题不删 capture/attempt/experience", call("GET", f"/api/captures/{cap_d}")[0] == 200 and call("GET", f"/api/attempts/{d1['id']}")[0] == 200 and call("GET", f"/api/experiences/{e1}")[0] == 200)
    check("删除主题不影响另一主题中的同一条经验", any(m["captureId"] == e1 for m in topic_detail(t1)["members"]["experiences"]))

    # ---------------------------------------------------------------- 13. 主题问答范围
    cap_p1 = create_capture("蓝莓施肥记录：每周一次复合肥")
    cap_p2 = create_capture("薄荷浇水记录：每天浇水")
    cap_p3 = create_capture("蓝莓光照记录：放在南阳台")
    p1 = create_attempt(cap_p1, "每周一次复合肥", "done", result="每周一次肥料，叶片更绿", outcome="success", observed_at=ms_now() - 10000)
    p2 = create_attempt(cap_p2, "每天浇水", "done", result="每天浇水，根部腐烂", outcome="failure", observed_at=ms_now() - 20000)
    e3 = create_experience(
        "蓝莓施肥频率经验",
        "经验正文不应作为证据出现QQQ。",
        [f"attempt:{p1['id']}"],
        origin_attempt=p1["id"],
        context_capture=cap_p1,
    )
    e4 = create_experience(
        "薄荷浇水经验",
        "经验正文不应作为证据出现WWW。",
        [f"capture:{cap_p2}"],
        context_capture=cap_p2,
    )
    st, ask_topic1_body = create_topic(
        {
            "title": "蓝莓施肥主题XYZ",
            "exploringQuestion": "肥料频率有什么影响？",
            "continueNote": "这段继续说明不应进入模型ABC",
            "captureIds": [cap_p1, e3],
        }
    )
    expect_status("创建问答主题1 201", (st, ask_topic1_body), 201)
    qt1 = ask_topic1_body["topic"]["id"]
    st, ask_topic2_body = create_topic({"title": "薄荷浇水主题", "captureIds": [cap_p2]})
    expect_status("创建问答主题2 201", (st, ask_topic2_body), 201)
    qt2 = ask_topic2_body["topic"]["id"]

    st, ask_cand1 = call("GET", f"/api/topics/{qt1}/ask-candidates?question=肥料&keywords=肥料")
    expect_status("主题 ask-candidates 200", (st, ask_cand1), 200)
    cand_ids = {x["captureId"] for x in ask_cand1["candidates"]}
    check("主题 ask-candidates 只含本主题念头", cand_ids <= {cap_p1} and all(x["matchKind"] == "direct" for x in ask_cand1["candidates"]), repr(cand_ids))
    check("主题 ask-candidates 不扩展主题外", cap_p2 not in cand_ids and p2["id"] not in {x["id"] for x in ask_cand1["candidates"]})
    check("主题 ask-candidates topic/scope 兼容字段", ask_cand1.get("topic", {}).get("id") == qt1 and ask_cand1.get("scope", {}).get("topicName") == "蓝莓施肥主题XYZ" and ask_cand1["scope"].get("recordCount") == ask_cand1["scope"].get("allowedSourceCount"), repr(ask_cand1.get("scope")))
    st, ask_cand2 = call("GET", f"/api/topics/{qt2}/ask-candidates?question=浇水&keywords=浇水")
    check("第二个主题候选隔离", st == 200 and {x["captureId"] for x in ask_cand2["candidates"]} <= {cap_p2})

    # 没有模型配置时仍可预览（手动流程）
    st, preview_ok = call(
        "POST",
        "/api/ask/preview",
        {"question": "肥料频率有什么影响？", "keywords": "肥料", "sourceKeys": [f"attempt:{p1['id']}"], "topicId": qt1},
    )
    expect_status("主题 preview 未配置模型仍可 200", (st, preview_ok), 200)
    check("主题 preview 返回 scope", preview_ok.get("scope", {}).get("topicId") == qt1 and len(preview_ok.get("contextToken", "")) == 64, repr(preview_ok.get("scope")))
    old_token = preview_ok["contextToken"]
    expect_error(
        "主题 preview 越界 source 400",
        call("POST", "/api/ask/preview", {"question": "跨主题", "keywords": "", "sourceKeys": [f"attempt:{p2['id']}"], "topicId": qt1}),
        400,
        "source_out_of_scope",
    )
    expect_error(
        "经验正文不能作为 source 400",
        call("POST", "/api/ask/preview", {"question": "经验正文", "keywords": "", "sourceKeys": [f"capture:{e3}"], "topicId": qt1}),
        400,
        "source_out_of_scope",
    )
    expect_error(
        "伪造 sourceId 400",
        call("POST", "/api/ask/preview", {"question": "伪造", "keywords": "", "sourceKeys": ["attempt:att-fake"], "topicId": qt1}),
        400,
        "source_out_of_scope",
    )
    st, preview_thought = call(
        "POST",
        "/api/ask/preview",
        {"question": "蓝莓", "keywords": "", "sourceKeys": [f"capture:{cap_p1}"], "topicId": qt1},
    )
    check("thought capture 在范围内", st == 200 and preview_thought.get("scope", {}).get("topicId") == qt1)
    st, ask_exp = call("GET", f"/api/topics/{qt1}/ask-experiences")
    expect_status("主题 ask-experiences 200", (st, ask_exp), 200)
    check("ask-experiences 返回经验", len(ask_exp.get("experiences", [])) == 1 and ask_exp["experiences"][0]["id"] == e3, repr(ask_exp))
    check("ask-experiences 依据去重", ask_exp["experiences"][0]["selectableSourceKeys"] == [f"attempt:{p1['id']}"], repr(ask_exp["experiences"][0]))
    check("ask-experiences topic 兼容字段", ask_exp.get("topic", {}).get("id") == qt1 and ask_exp.get("topic", {}).get("name") == "蓝莓施肥主题XYZ")
    # 加入经验 e4（依据 cap_p2）到主题1，验证经验依据可选用但不进入候选
    st, add_e4 = call("POST", f"/api/topics/{qt1}/members", {"captureIds": [e4], "operationId": "op-qt1-e4"})
    check("经验加入问答主题", st == 200 and add_e4["added"] == 1)
    st, scope_after = call("GET", f"/api/topics/{qt1}/ask-candidates?question=蓝莓&keywords=蓝莓")
    check("经验依据 cap 不进入候选", st == 200 and all(x["captureId"] != cap_p2 for x in scope_after["candidates"]))
    st, ask_exp2 = call("GET", f"/api/topics/{qt1}/ask-experiences")
    exp_ids = {x["id"] for x in ask_exp2.get("experiences", [])}
    check("两个经验成员均返回", exp_ids == {e3, e4}, repr(exp_ids))
    e4_exp = next(x for x in ask_exp2["experiences"] if x["id"] == e4)
    check("经验依据 capture 可选", e4_exp["selectableSourceKeys"] == [f"capture:{cap_p2}"], repr(e4_exp))
    st, preview_e4 = call(
        "POST",
        "/api/ask/preview",
        {"question": "薄荷依据", "keywords": "", "sourceKeys": [f"capture:{cap_p2}"], "topicId": qt1},
    )
    check("经验依据 capture 在 allowed scope", st == 200, repr(preview_e4))
    check("allowedSourceCount 去重", ask_cand1["scope"]["allowedSourceCount"] == 2, repr(ask_cand1["scope"]))

    # 配置模型后生成；预览后成员变化 -> 409
    st, cfg = call(
        "PUT",
        "/api/settings/ai",
        {"name": "fake", "baseUrl": f"http://127.0.0.1:{FAKE_PORT}/v1", "modelId": "fake-ask", "apiKey": "test-key", "enabled": True, "allowLocal": True},
    )
    check("配置 fake 模型", st == 200, repr(cfg))
    st, changed_gen = call(
        "POST",
        "/api/ask/queries",
        {
            "question": "肥料频率有什么影响？",
            "keywords": "肥料",
            "sourceKeys": [f"attempt:{p1['id']}"],
            "topicId": qt1,
            "contextToken": old_token,
            "operationId": "op-ask-old",
        },
    )
    expect_status("预览后成员变化生成 409", (st, changed_gen), 409)
    check("context_changed 说明主题成员/来源变化", "主题成员" in str(changed_gen.get("message", "")) and "来源" in str(changed_gen.get("message", "")), repr(changed_gen))
    # 新预览 -> 生成成功
    st, preview_new = call(
        "POST",
        "/api/ask/preview",
        {"question": "肥料频率有什么影响？", "keywords": "肥料", "sourceKeys": [f"attempt:{p1['id']}"], "topicId": qt1},
    )
    check("新预览成功", st == 200 and preview_new.get("scope", {}).get("topicRevision") > preview_ok["scope"]["topicRevision"])
    st, gen = call(
        "POST",
        "/api/ask/queries",
        {
            "question": "肥料频率有什么影响？",
            "keywords": "肥料",
            "sourceKeys": [f"attempt:{p1['id']}"],
            "topicId": qt1,
            "contextToken": preview_new["contextToken"],
            "operationId": "op-ask-new",
        },
    )
    check("主题问答生成 202", st == 202 and gen.get("query", {}).get("status") == "pending" and gen.get("scope", {}).get("topicId") == qt1, repr(gen)[:500])
    query_id = gen["query"]["id"]
    final_query = None
    deadline = time.time() + 20
    while time.time() < deadline:
        st, qbody = call("GET", f"/api/ask/queries/{query_id}")
        if st == 200 and qbody["query"]["status"] not in ("pending",):
            final_query = qbody["query"]
            break
        time.sleep(0.25)
    check("主题问答完成", final_query is not None and final_query["status"] == "succeeded", repr(final_query)[:500] if final_query else "timeout")
    if final_query:
        check("主题问答来源仅本主题", {s["sourceKey"] for s in final_query["sources"]} == {f"attempt:{p1['id']}"}, repr(final_query.get("sources")))
        user_prompt = ""
        try:
            last = fake_get("/__last").get("request") or {}
            for message in (last.get("body") or {}).get("messages") or []:
                if message.get("role") == "user":
                    content = message.get("content")
                    if isinstance(content, str):
                        user_prompt += content
                    elif isinstance(content, list):
                        user_prompt += "\n".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
        except Exception:
            pass
        check("fake model 仍识别用户问题", "用户的问题：" in user_prompt, user_prompt[:200])
        check("prompt 不含主题说明", "这段继续说明不应进入模型ABC" not in user_prompt and "蓝莓施肥主题XYZ" not in user_prompt)
        check("prompt 不含经验正文", "经验正文不应作为证据出现QQQ" not in user_prompt and "经验正文不应作为证据出现WWW" not in user_prompt)
        check("prompt 只含确认来源", f"attempt:{p1['id']}" in user_prompt and f"attempt:{p2['id']}" not in user_prompt)

    # 普通问答仍可用（不带 topicId）
    st, plain_preview = call("POST", "/api/ask/preview", {"question": "浇水", "keywords": "浇水", "sourceKeys": [f"attempt:{p2['id']}"]})
    check("普通问答 preview 不受主题影响", st == 200 and "scope" not in plain_preview)

    # ---------------------------------------------------------------- 14. 导出 schema 7
    st, export = call("GET", "/api/export")
    expect_status("导出 200", (st, export), 200)
    check("导出 schemaVersion=7", export.get("schemaVersion") == 7, repr(export.get("schemaVersion")))
    data = export.get("data") or {}
    check("导出 data.topics 存在", isinstance(data.get("topics"), list) and len(data["topics"]) >= 4, repr(len(data.get("topics") or [])))
    check("导出 data.topicMembers 存在", isinstance(data.get("topicMembers"), list) and len(data["topicMembers"]) > 0)
    topic_keys = set((data["topics"][0] if data.get("topics") else {}).keys())
    check("导出 topic 字段 camelCase", {"id", "title", "exploringQuestion", "continueNote", "nextAttemptId", "revision", "archivedAt", "createdAt", "updatedAt"} <= topic_keys, repr(topic_keys))
    member_keys = set((data["topicMembers"][0] if data.get("topicMembers") else {}).keys())
    check("导出 topicMember 字段", member_keys == {"id", "topicId", "captureId", "memberKind", "createdAt"}, repr(member_keys))
    check("导出不含内部回执", "mutationReceipts" not in data and "recordQueries" not in data)
    check("导出保留 schema 6 数据", all(key in data for key in ["captures", "attempts", "captureLinks", "scheduleBlocks", "stageReviews", "researchRuns", "experienceNotes", "experienceSources", "experienceAttempts"]))

    # ---------------------------------------------------------------- 15. 整库备份包含新表
    if not BASE.startswith("http://127.0.0.1:3000") and os.path.exists(TEST_DB):
        backup_path = os.path.join(ROOT, "db", "test-topics-backup.sqlite")
        if os.path.exists(backup_path):
            os.remove(backup_path)
        with sqlite3.connect(TEST_DB) as src, sqlite3.connect(backup_path) as dst:
            src.backup(dst)
        with sqlite3.connect(backup_path) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            topic_count = conn.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
            member_count = conn.execute("SELECT COUNT(*) FROM topic_members").fetchone()[0]
        check("整库备份包含 topics/topic_members", {"topics", "topic_members"} <= tables, repr(sorted(tables)))
        check("整库备份行数与导出一致", topic_count == len(data.get("topics") or []) and member_count == len(data.get("topicMembers") or []), f"db={topic_count}/{member_count}, export={len(data.get('topics') or [])}/{len(data.get('topicMembers') or [])}")
        try:
            os.remove(backup_path)
        except OSError:
            pass

    # ---------------------------------------------------------------- 16. 删除最后一个主题后 capture 仍在
    st, del_t1 = call("DELETE", f"/api/topics/{t1}")
    check("删除最后一个测试主题", st == 200 and del_t1.get("deletedMembers", 0) >= 1)
    check("删除主题后 capture 仍可读", call("GET", f"/api/captures/{cap_a}")[0] == 200 and call("GET", f"/api/experiences/{e2}")[0] == 200)


def main():
    try:
        run()
    finally:
        stop_test_server()
        stop_fake_server()
    ok = c.report("主题后端验收")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
