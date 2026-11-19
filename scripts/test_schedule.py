"""拾念 SHINIAN v0.2 - 日程安排 API 验收（契约第 8 节最低集）

运行方式（与其它 API 套件一致，默认指向 3100 独立测试服务）：
    $env:SHINIAN_BASE='http://127.0.0.1:3100'
    python scripts/test_schedule.py

- 只通过 HTTP 访问目标测试服务；绝不直接触碰 db/shinian.sqlite，也不占用端口。
- 拒绝在默认主库端口 3000 上运行（除非显式 SHINIAN_ALLOW_MAIN_DB=1）。
- 所有数据使用唯一用户名前缀与「按 uid 偏移的未来周」日期，重复运行不互相冲突；
  测试结束会删除本脚本创建的念头（级联删除尝试与安排），减少残留。
- 时区固定显式 Asia/Shanghai；DST 场景固定 America/New_York。

覆盖：
1. 已有 Attempt 创建多个安排；字段/关联/排序；重复 operationId 幂等；同 ID 改参数 409。
2. 首页今日范围与周视图同一天数据一致（API 层面同一范围）。
3. 修改、取消、历史保留；双窗口 revision 冲突。
4. 相邻 10:00-11:00 / 11:00-12:00；重叠 409；确认后成功；确认期间冲突变化再次 409。
5. 跨午夜两天可见；周界周日/周一；切换 timezone 查询与格式化；默认 Asia/Shanghai；
   DST nonexistent / ambiguous；无效时间、结束早于开始。
6. done/cancelled 时未来安排 keep/cancel 行为与选择一致。
7. capture / attempt 删除预览计数与事务删除。
8. 导出 schemaVersion=6、scheduleBlocks、关联可读。
9. 既有手动闭环（capture -> attempt -> result）快速回归。
"""
import os
import sys
import time
import urllib.parse
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
PARSED = urllib.parse.urlparse(BASE)
PORT = PARSED.port or (443 if PARSED.scheme == "https" else 80)
if PORT == 3000 and os.environ.get("SHINIAN_ALLOW_MAIN_DB") != "1":
    print("拒绝在默认主服务端口 3000 上运行日程验收（会写入主库）。")
    print("请先启动独立测试服务，例如：")
    print('  $env:PORT="3100"; $env:DATABASE_URL="D:\\联动日程表\\db\\test.sqlite"; npm run serve')
    print("或直接 python scripts/run_tests.py。")
    sys.exit(2)

TZ = "Asia/Shanghai"
NY = "America/New_York"
c = Checker()
uid = uuid.uuid4().hex[:8]
USERNAME = f"日程验收-{uid}"

# 每个 uid 使用自己的一周（2027-01-04 是周一），避免重复运行互相制造「重叠」。
MONDAY = date(2027, 1, 4) + timedelta(weeks=int(uid[:2], 16) % 40)
D1 = MONDAY + timedelta(days=1)  # 周二
D2 = MONDAY + timedelta(days=2)  # 周三
D3 = MONDAY + timedelta(days=3)  # 周四
D4 = MONDAY + timedelta(days=4)  # 周五
D5 = MONDAY + timedelta(days=5)  # 周六
NEXT_WEEK = MONDAY + timedelta(days=7)
SUNDAY = MONDAY - timedelta(days=1)

SCHEDULE_KEYS = {
    "id",
    "attemptId",
    "startsAt",
    "endsAt",
    "timezone",
    "note",
    "status",
    "revision",
    "createdAt",
    "updatedAt",
    "cancelledAt",
    "attempt",
    "capture",
}
EXPORT_SCHEDULE_KEYS = {
    "id",
    "attemptId",
    "startsAt",
    "endsAt",
    "timezone",
    "note",
    "status",
    "revision",
    "createdAt",
    "updatedAt",
    "cancelledAt",
}

op_seq = 0


def op_id(tag="sched"):
    global op_seq
    op_seq += 1
    return f"op-{tag}-{uid}-{op_seq}"


def d(day):
    return day.isoformat()


def ts(day, hhmm, tz=TZ):
    """本地墙钟时间 -> UTC 毫秒（用于断言服务端解析结果）。"""
    hour, minute = (int(x) for x in hhmm.split(":"))
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZoneInfo(tz))
    return int(local.timestamp() * 1000)


def local_text(ms, tz=TZ):
    return datetime.fromtimestamp(ms / 1000, ZoneInfo(tz)).strftime("%Y-%m-%d %H:%M")


def body_fields(day, start, end, tz=TZ, note=None, end_day=None, **extra):
    body = {
        "date": d(day),
        "startTime": start,
        "endTime": end,
    }
    if tz is not None:
        body["timezone"] = tz
    if end_day is not None:
        body["endDate"] = d(end_day)
    if note is not None:
        body["note"] = note
    body.update({k: v for k, v in extra.items() if v is not None})
    return body


def create_sched(client, attempt_id, day, start, end, tz=TZ, note=None, end_day=None, operation_id=None, **extra):
    """POST 创建安排；返回 (status, body, operationId)。"""
    body = body_fields(day, start, end, tz=tz, note=note, end_day=end_day, **extra)
    body["operationId"] = operation_id or op_id()
    status, res = client.post(f"/api/attempts/{attempt_id}/schedules", body)
    return status, res, body["operationId"]


def range_query(client, from_day, to_day, tz=None):
    q = f"/api/schedules?from={urllib.parse.quote(d(from_day))}&to={urllib.parse.quote(d(to_day))}"
    if tz is not None:
        q += f"&timezone={urllib.parse.quote(tz)}"
    return client.get(q)


def new_capture(client, text):
    status, res = client.post("/api/captures", {"rawText": text})
    c.check(f"创建念头：{text[:24]}", status == 200 and (res or {}).get("capture"), f"{status} {res}")
    return (res or {}).get("capture") or {}


def new_attempt(client, capture_id, step, state="todo"):
    status, res = client.post(
        f"/api/captures/{capture_id}/attempts",
        {"step": step, "state": state, "operationId": op_id("att")},
    )
    c.check(f"创建尝试：{step[:24]}", status == 200 and (res or {}).get("attempt"), f"{status} {res}")
    return (res or {}).get("attempt") or {}


def schedule_of(res):
    return (res or {}).get("schedule") or {}


def error_code(res):
    return (res or {}).get("error") if isinstance(res, dict) else None


def section(title):
    print(f"\n— {title}")


# =====================================================================
# 0. 登录与环境
# =====================================================================
print(f"日程验收目标：{BASE}（唯一用户 {USERNAME}）")
client = Client(base=BASE)
body = client.login(USERNAME)
c.check("创建/登录唯一本机账号", body.get("ok") is True, str(body))
c.check("目标不是主库端口 3000（或已显式允许）", PORT != 3000 or os.environ.get("SHINIAN_ALLOW_MAIN_DB") == "1")

created_capture_ids = []

# =====================================================================
# 1. 已有 Attempt 创建多个安排；幂等；同 ID 改参数 409
# =====================================================================
section("1. 创建多个安排 / operationId 幂等 / 参数冲突")
cap = new_capture(client, f"【日程验收-{uid}】PWM 低占空比时 LED 会闪")
created_capture_ids.append(cap.get("id"))
att = new_attempt(client, cap["id"], f"比较两种 PWM 频率【日程验收-{uid}】")

status, res, op1 = create_sched(client, att["id"], D1, "10:00", "11:00", note="先跑一次实验")
c.check("创建第 1 个安排返回 2xx", status in (200, 201), f"{status} {res}")
s1 = schedule_of(res)
c.check("创建响应包含 schedule 且 replayed 不为 true", bool(s1.get("id")) and not bool((res or {}).get("replayed")), str(res))
c.check("安排字段与契约 §4 完全一致", set(s1.keys()) == SCHEDULE_KEYS, str(sorted(s1.keys())))
c.check("安排关联正确", s1.get("attemptId") == att["id"] and (s1.get("attempt") or {}).get("id") == att["id"] and (s1.get("capture") or {}).get("id") == cap["id"])
c.check("安排解析为 Asia/Shanghai 10:00-11:00", s1.get("startsAt") == ts(D1, "10:00") and s1.get("endsAt") == ts(D1, "11:00"), f"{s1.get('startsAt')} / {ts(D1, '10:00')}")
c.check("安排初始 status=active, revision=1, cancelledAt=null", s1.get("status") == "active" and s1.get("revision") == 1 and s1.get("cancelledAt") is None)
c.check("安排记录创建时区", s1.get("timezone") == TZ)
c.check("安排 note 保存并 trim", s1.get("note") == "先跑一次实验", repr(s1.get("note")))
time.sleep(0.05)

status, res, op2 = create_sched(client, att["id"], D1, "14:00", "15:00", note="第二个安排")
c.check("同一 Attempt 可创建第 2 个安排", status in (200, 201), f"{status} {res}")
s2 = schedule_of(res)

status, listing = client.get(f"/api/attempts/{att['id']}/schedules")
c.check("Attempt 日程列表返回 200", status == 200, str(listing))
schedules = (listing or {}).get("schedules") or []
c.check("Attempt 日程列表包含 2 条", len(schedules) == 2, str([x.get("id") for x in schedules]))
c.check("Attempt 日程列表按 startsAt 升序", [x["startsAt"] for x in schedules] == sorted(x["startsAt"] for x in schedules), str([x["startsAt"] for x in schedules]))
c.check("Attempt 日程列表返回 serverNow", isinstance((listing or {}).get("serverNow"), int), str((listing or {}).get("serverNow")))

# 重复 operationId + 相同规范化参数 → replay
same = body_fields(D1, "10:00", "11:00", note="先跑一次实验")
same["operationId"] = op1
status, res = client.post(f"/api/attempts/{att['id']}/schedules", same)
c.check("重复 operationId 相同参数返回成功", status in (200, 201), f"{status} {res}")
c.check("重复 operationId 返回同一条安排", schedule_of(res).get("id") == s1.get("id"), str(res))
c.check("重复 operationId 标记 replayed=true", (res or {}).get("replayed") is True, str(res))
status, listing = client.get(f"/api/attempts/{att['id']}/schedules")
c.check("重复提交后仍只有 2 条安排", len((listing or {}).get("schedules") or []) == 2, str(len((listing or {}).get("schedules") or [])))

# 同一 operationId 不存在的额外参数（不同 note）→ 409
changed = body_fields(D1, "10:00", "11:00", note="改过的备注")
changed["operationId"] = op1
status, res = client.post(f"/api/attempts/{att['id']}/schedules", changed)
c.check("同一 operationId 改参数返回 409", status == 409, f"{status} {res}")
c.check("同一 operationId 改参数错误码 operation_key_conflict", error_code(res) == "operation_key_conflict", str(res))

# operationId 缺失
status, res = client.post(
    f"/api/attempts/{att['id']}/schedules",
    body_fields(D1, "16:00", "17:00"),
)
c.check("缺少 operationId 返回 400", status == 400, f"{status} {res}")

# 不存在的 Attempt
status, res, _ = create_sched(client, "att-does-not-exist", D1, "18:00", "19:00")
c.check("不存在的 Attempt 创建安排返回 404", status == 404, f"{status} {res}")

# =====================================================================
# 2. 首页今日列表 / 周视图一致（同一范围）
# =====================================================================
section("2. 日视图与周视图同范围数据一致")
status, week = range_query(client, MONDAY, NEXT_WEEK)
c.check("周范围查询返回 200", status == 200, f"{status} {week}")
range_echo = (week or {}).get("range") or {}
c.check("范围回显 from/to/timezone 正确", range_echo.get("from") == d(MONDAY) and range_echo.get("to") == d(NEXT_WEEK) and range_echo.get("timezone") == TZ, str(range_echo))
c.check(
    "范围边界 fromAt/toAt 为上海本地零点",
    range_echo.get("fromAt") == ts(MONDAY, "00:00") and range_echo.get("toAt") == ts(NEXT_WEEK, "00:00"),
    f"{range_echo.get('fromAt')} / {ts(MONDAY, '00:00')}",
)
c.check("范围回显 ISO 与 epoch 一致", range_echo.get("fromIso", "").endswith("Z") and range_echo.get("toIso", "").endswith("Z"), str(range_echo))
week_ids = [x["id"] for x in (week or {}).get("schedules") or []]
c.check("周视图包含本 Attempt 的 2 条安排", s1["id"] in week_ids and s2["id"] in week_ids, str(week_ids))

status, day_res = range_query(client, D1, D1 + timedelta(days=1))
c.check("日范围查询返回 200", status == 200, f"{status} {day_res}")
day_ids = [x["id"] for x in (day_res or {}).get("schedules") or []]
day_from = ((day_res or {}).get("range") or {}).get("fromAt")
day_to = ((day_res or {}).get("range") or {}).get("toAt")
week_in_day = [x["id"] for x in (week or {}).get("schedules") or [] if day_from <= x["startsAt"] < day_to]
c.check("日视图与周视图对同一天返回同一组安排", day_ids == week_in_day, f"day={day_ids} week_filtered={week_in_day}")
day_times = [(x["id"], x["startsAt"], x["endsAt"]) for x in (day_res or {}).get("schedules") or []]
week_times = [(x["id"], x["startsAt"], x["endsAt"]) for x in (week or {}).get("schedules") or [] if x["id"] in day_ids]
c.check("日视图与周视图时间一致", sorted(day_times) == sorted(week_times), f"{day_times} vs {week_times}")

status, res = client.get("/api/schedules?to=2027-01-01")
c.check("缺少 from 的范围查询返回 400 invalid_range", status == 400 and error_code(res) == "invalid_range", f"{status} {res}")
status, res = client.get("/api/schedules?from=2027-01-02&to=2027-01-01")
c.check("to <= from 返回 400 invalid_range", status == 400 and error_code(res) == "invalid_range", f"{status} {res}")
status, res = client.get("/api/schedules?from=2027-01-01&to=2027-04-01")
c.check("跨度超过 62 天返回 400 range_too_large", status == 400 and error_code(res) == "range_too_large", f"{status} {res}")
status, res = client.get("/api/schedules?from=2027-01-01&to=2027-01-02&timezone=Mars/Olympus")
c.check("范围查询非法时区返回 400 invalid_timezone", status == 400 and error_code(res) == "invalid_timezone", f"{status} {res}")

# =====================================================================
# 3. 修改 / 取消 / 历史保留 / revision 双窗口冲突
# =====================================================================
section("3. 修改、取消、历史保留与 revision 冲突")
status, res = client.patch(f"/api/schedules/{s1['id']}", {**body_fields(D1, "10:30", "11:30", note="改到 10:30"), "revision": s1["revision"]})
c.check("修改安排时间/备注返回 200", status == 200, f"{status} {res}")
s1v2 = schedule_of(res)
c.check("修改后 revision 递增", s1v2.get("revision") == s1["revision"] + 1, str(s1v2.get("revision")))
c.check("修改后时间已更新", s1v2.get("startsAt") == ts(D1, "10:30") and s1v2.get("endsAt") == ts(D1, "11:30"))
c.check("修改后备注已更新", s1v2.get("note") == "改到 10:30")

# 第二个窗口仍拿着旧 revision
status, res = client.patch(f"/api/schedules/{s1['id']}", {**body_fields(D1, "09:00", "10:00"), "revision": s1["revision"]})
c.check("旧 revision 提交返回 409 revision_conflict", status == 409 and error_code(res) == "revision_conflict", f"{status} {res}")
c.check("revision 冲突响应带 current 最新对象", ((res or {}).get("current") or {}).get("revision") == s1v2["revision"], str((res or {}).get("current")))
c.check("revision 冲突不覆盖已保存内容", (res or {}).get("current", {}).get("startsAt") == ts(D1, "10:30"))

# 取消第二个安排
status, res = client.post(f"/api/schedules/{s2['id']}/cancel", {"revision": s2["revision"]})
c.check("取消安排返回 200", status == 200, f"{status} {res}")
s2c = schedule_of(res)
c.check("取消后 status=cancelled 且 cancelledAt 非空", s2c.get("status") == "cancelled" and isinstance(s2c.get("cancelledAt"), int), str(s2c))
c.check("取消后 revision 递增", s2c.get("revision") == s2["revision"] + 1, str(s2c.get("revision")))

status, res = client.post(f"/api/schedules/{s2['id']}/cancel", {"revision": s2c["revision"]})
c.check("重复取消同一安排返回 409", status == 409, f"{status} {res}")
c.check("重复取消错误码为 already_cancelled 或 revision_conflict", error_code(res) in ("already_cancelled", "revision_conflict"), str(res))

status, res = client.patch(f"/api/schedules/{s2['id']}", {**body_fields(D1, "12:00", "13:00"), "revision": s2c["revision"]})
c.check("已取消安排不可修改（409）", status == 409, f"{status} {res}")

status, listing = client.get(f"/api/attempts/{att['id']}/schedules")
hist = (listing or {}).get("schedules") or []
c.check("历史保留：Attempt 列表含 cancelled 安排", any(x["id"] == s2["id"] and x["status"] == "cancelled" for x in hist), str([(x["id"], x["status"]) for x in hist]))
status, day_res = range_query(client, D1, D1 + timedelta(days=1))
range_ids = [x["id"] for x in (day_res or {}).get("schedules") or []]
c.check("范围查询只返回 active（不含已取消）", s2["id"] not in range_ids and s1["id"] in range_ids, str(range_ids))

# =====================================================================
# 4. 相邻 / 重叠 / 确认 / 确认期间冲突变化
# =====================================================================
section("4. 相邻时段、重叠确认与确认后冲突变化")
cap2 = new_capture(client, f"【日程验收-{uid}】相邻与重叠测试")
created_capture_ids.append(cap2.get("id"))
att2 = new_attempt(client, cap2["id"], f"重叠验证尝试【日程验收-{uid}】")

status, res, _ = create_sched(client, att2["id"], D2, "10:00", "11:00", note="相邻 A")
c.check("相邻安排 A 10:00-11:00 创建成功", status in (200, 201), f"{status} {res}")
adj_a = schedule_of(res)
status, res, _ = create_sched(client, att2["id"], D2, "11:00", "12:00", note="相邻 B")
c.check("相邻安排 B 11:00-12:00 创建成功（边界不重叠）", status in (200, 201), f"{status} {res}")
adj_b = schedule_of(res)

status, res, op_conf = create_sched(client, att2["id"], D2, "10:30", "11:30", note="重叠候选")
c.check("重叠安排返回 409 schedule_conflict", status == 409 and error_code(res) == "schedule_conflict", f"{status} {res}")
conflicts = (res or {}).get("conflicts") or []
conflict_ids = [x.get("id") for x in conflicts]
c.check("冲突列表包含两条相邻安排", set(conflict_ids) == {adj_a.get("id"), adj_b.get("id")}, str(conflict_ids))
token = (res or {}).get("conflictToken")
c.check("冲突响应带 conflictToken", isinstance(token, str) and len(token) >= 16, repr(token))
c.check("冲突响应 requiresConfirmation=true", (res or {}).get("requiresConfirmation") is True, str(res))

body = body_fields(D2, "10:30", "11:30", note="重叠候选")
body.update({"operationId": op_conf, "confirmOverlap": True, "conflictToken": token, "expectedConflictIds": conflict_ids})
status, res = client.post(f"/api/attempts/{att2['id']}/schedules", body)
c.check("明确确认后重叠安排创建成功", status in (200, 201), f"{status} {res}")
overlap_ok = schedule_of(res)
c.check("确认创建后与冲突对象共存", overlap_ok.get("status") == "active" and overlap_ok.get("startsAt") == ts(D2, "10:30"), str(overlap_ok))
status, listing = client.get(f"/api/attempts/{att2['id']}/schedules")
c.check("确认后 Attempt 共 3 条 active 安排", sum(1 for x in (listing or {}).get("schedules") or [] if x["status"] == "active") == 3, str([(x["id"], x["status"]) for x in (listing or {}).get("schedules") or []]))

# 确认期间冲突对象被移动（同一秒内修改 revision）
section("4b. 确认 token 之后冲突对象变化 → 再次 409")
cap3 = new_capture(client, f"【日程验收-{uid}】确认 token 失效测试")
created_capture_ids.append(cap3.get("id"))
att3 = new_attempt(client, cap3["id"], f"token 失效尝试【日程验收-{uid}】")
status, res, _ = create_sched(client, att3["id"], D3, "09:00", "10:00", note="原冲突块")
conflict_block = schedule_of(res)

status, res, op_stale = create_sched(client, att3["id"], D3, "09:30", "10:30", note="待确认块")
c.check("首次重叠返回 409", status == 409 and error_code(res) == "schedule_conflict", f"{status} {res}")
stale_token = (res or {}).get("conflictToken")
stale_ids = [x.get("id") for x in (res or {}).get("conflicts") or []]

# 同一秒内移动冲突块：revision 从 1 -> 2，仍然与待确认块重叠
status, res = client.patch(
    f"/api/schedules/{conflict_block['id']}",
    {**body_fields(D3, "09:15", "10:15", note="冲突块已移动"), "revision": conflict_block["revision"]},
)
c.check("确认前移动冲突块成功", status == 200 and schedule_of(res).get("revision") == conflict_block["revision"] + 1, f"{status} {res}")
moved = schedule_of(res)

body = body_fields(D3, "09:30", "10:30", note="待确认块")
body.update({"operationId": op_stale, "confirmOverlap": True, "conflictToken": stale_token, "expectedConflictIds": stale_ids})
status, res = client.post(f"/api/attempts/{att3['id']}/schedules", body)
c.check("旧 token 确认返回 409 schedule_conflict_changed", status == 409 and error_code(res) == "schedule_conflict_changed", f"{status} {res}")
latest_conflicts = (res or {}).get("conflicts") or []
c.check("再次 409 返回最新冲突对象与 revision", any(x.get("id") == moved["id"] and x.get("revision") == moved["revision"] for x in latest_conflicts), str(latest_conflicts))
new_token = (res or {}).get("conflictToken")
c.check("再次 409 返回新的 conflictToken", isinstance(new_token, str) and new_token != stale_token, f"{new_token!r} vs {stale_token!r}")

body = body_fields(D3, "09:30", "10:30", note="待确认块")
body.update({"operationId": op_stale, "confirmOverlap": True, "conflictToken": new_token, "expectedConflictIds": [x.get("id") for x in latest_conflicts]})
status, res = client.post(f"/api/attempts/{att3['id']}/schedules", body)
c.check("使用新 token 再次确认成功", status in (200, 201), f"{status} {res}")

# =====================================================================
# 5. 跨午夜 / 周界 / 时区 / DST / 无效输入
# =====================================================================
section("5. 跨午夜、周界、时区与 DST")
cap4 = new_capture(client, f"【日程验收-{uid}】时间边界测试")
created_capture_ids.append(cap4.get("id"))
att4 = new_attempt(client, cap4["id"], f"时间边界尝试【日程验收-{uid}】")

status, res, _ = create_sched(client, att4["id"], D1, "23:00", "01:00", end_day=D2, note="跨午夜")
c.check("跨午夜安排创建成功", status in (200, 201), f"{status} {res}")
midnight = schedule_of(res)
c.check("跨午夜跨度 2 小时", midnight.get("endsAt", 0) - midnight.get("startsAt", 0) == 2 * 3600 * 1000, str(midnight))
c.check("跨午夜 startsAt 解析正确", midnight.get("startsAt") == ts(D1, "23:00") and midnight.get("endsAt") == ts(D2, "01:00"), f"{midnight.get('startsAt')} / {midnight.get('endsAt')}")

status, day1 = range_query(client, D1, D2)
status2, day2 = range_query(client, D2, D3)
ids1 = [x["id"] for x in (day1 or {}).get("schedules") or []]
ids2 = [x["id"] for x in (day2 or {}).get("schedules") or []]
c.check("跨午夜安排出现在第一天范围", midnight["id"] in ids1, str(ids1))
c.check("跨午夜安排出现在第二天范围", midnight["id"] in ids2, str(ids2))

# 周界：周日 23:00-23:30 与周一 00:30-01:00
status, res, _ = create_sched(client, att4["id"], SUNDAY, "23:00", "23:30", note="周日")
c.check("周日晚安排创建成功", status in (200, 201), f"{status} {res}")
sun_block = schedule_of(res)
status, res, _ = create_sched(client, att4["id"], MONDAY, "00:30", "01:00", note="周一")
c.check("周一凌晨安排创建成功", status in (200, 201), f"{status} {res}")
mon_block = schedule_of(res)

status, prev_week = range_query(client, SUNDAY - timedelta(days=6), MONDAY)
prev_ids = [x["id"] for x in (prev_week or {}).get("schedules") or []]
c.check("包含周日的一周返回周日安排", sun_block["id"] in prev_ids, str(prev_ids))
c.check("包含周日的一周不返回周一凌晨安排", mon_block["id"] not in prev_ids, str(prev_ids))
status, this_week = range_query(client, MONDAY, NEXT_WEEK)
this_ids = [x["id"] for x in (this_week or {}).get("schedules") or []]
c.check("周一开始的一周返回周一凌晨安排", mon_block["id"] in this_ids, str(this_ids))
c.check("周一开始的一周不返回上周日安排", sun_block["id"] not in this_ids, str(this_ids))

# 时区切换：同一 UTC 块按纽约时区格式化（EDT/EST 由 zoneinfo 计算，不硬编码偏移）
status, res, _ = create_sched(client, att4["id"], D4, "10:00", "11:00", note="上海上午")
c.check("上海时区安排创建成功", status in (200, 201), f"{status} {res}")
sh_block = schedule_of(res)
c.check("上海 10:00 对应 UTC 02:00", sh_block.get("startsAt") == ts(D4, "10:00", TZ), str(sh_block.get("startsAt")))
expected_ny = datetime(D4.year, D4.month, D4.day, 10, 0, tzinfo=ZoneInfo(TZ)).astimezone(ZoneInfo(NY)).strftime("%Y-%m-%d %H:%M")
c.check(
    "按纽约时区格式化落在前一天晚上（zoneinfo 期望值）",
    local_text(sh_block["startsAt"], NY) == expected_ny,
    f"{local_text(sh_block['startsAt'], NY)} != {expected_ny}",
)
status, ny_prev = range_query(client, D4 - timedelta(days=1), D4, NY)
ny_prev_ids = [x["id"] for x in (ny_prev or {}).get("schedules") or []]
c.check("纽约时区前一天范围包含该安排", sh_block["id"] in ny_prev_ids, str(ny_prev_ids))
status, ny_same = range_query(client, D4, D4 + timedelta(days=1), NY)
ny_same_ids = [x["id"] for x in (ny_same or {}).get("schedules") or []]
c.check("纽约时区当天范围不包含该安排", sh_block["id"] not in ny_same_ids, str(ny_same_ids))
c.check("返回对象的 timezone 保持创建时区（不随查询时区改变）", next((x.get("timezone") for x in (ny_prev or {}).get("schedules") or [] if x["id"] == sh_block["id"]), None) == TZ)

# 默认时区
status, res, _ = create_sched(client, att4["id"], D4, "08:00", "09:00", note="默认时区", tz=None)
c.check("省略 timezone 创建成功", status in (200, 201), f"{status} {res}")
default_block = schedule_of(res)
c.check("省略 timezone 默认为 Asia/Shanghai", default_block.get("timezone") == TZ and default_block.get("startsAt") == ts(D4, "08:00"), str(default_block))
status, default_range = range_query(client, D4, D4 + timedelta(days=1), tz=None)
c.check("省略 timezone 的范围查询默认 Asia/Shanghai", ((default_range or {}).get("range") or {}).get("timezone") == TZ, str((default_range or {}).get("range")))

# DST nonexistent: America/New_York 2026-03-08 02:30 不存在
status, res, _ = create_sched(client, att4["id"], date(2026, 3, 8), "02:30", "03:30", tz=NY, note="DST 不存在")
c.check("DST 不存在时间返回 400 nonexistent_local_time", status == 400 and error_code(res) == "nonexistent_local_time", f"{status} {res}")
c.check("不存在时间响应带 zone/local/message", (res or {}).get("zone") == NY and "2026-03-08 02:30" in str((res or {}).get("local")) and bool((res or {}).get("message")), str(res))

# DST ambiguous: America/New_York 2026-11-01 01:30 重复
status, res, _ = create_sched(client, att4["id"], date(2026, 11, 1), "01:30", "02:30", tz=NY, note="DST 重复")
c.check("DST 重复时间未指定消歧返回 400 ambiguous_local_time", status == 400 and error_code(res) == "ambiguous_local_time", f"{status} {res}")
c.check("重复时间响应带 zone/local/choices", (res or {}).get("zone") == NY and "2026-11-01 01:30" in str((res or {}).get("local")) and set((res or {}).get("choices") or []) == {"earlier", "later"}, str(res))

status, res, _ = create_sched(
    client, att4["id"], date(2026, 11, 1), "01:30", "01:45", tz=NY, note="DST earlier",
    startDisambiguation="earlier", endDisambiguation="earlier",
)
c.check("DST earlier 显式消歧创建成功", status in (200, 201), f"{status} {res}")
dst_earlier = schedule_of(res)
status, res, _ = create_sched(
    client, att4["id"], date(2026, 11, 1), "01:30", "01:45", tz=NY, note="DST later",
    startDisambiguation="later", endDisambiguation="later",
)
c.check("DST later 显式消歧创建成功", status in (200, 201), f"{status} {res}")
dst_later = schedule_of(res)
c.check("DST earlier/later 起点相差 1 小时", dst_later.get("startsAt", 0) - dst_earlier.get("startsAt", 0) == 3600 * 1000, f"{dst_earlier.get('startsAt')} -> {dst_later.get('startsAt')}")

# 无效日期 / 时间 / 结束早于开始 / 非法时区
invalid_date_body = {
    "date": "2026-02-30",
    "startTime": "10:00",
    "endTime": "11:00",
    "timezone": TZ,
    "operationId": op_id("invalid"),
}
status, res = client.post(f"/api/attempts/{att4['id']}/schedules", invalid_date_body)
c.check("无效日期返回 400 invalid_schedule_time", status == 400 and error_code(res) == "invalid_schedule_time", f"{status} {res}")
status, res, _ = create_sched(client, att4["id"], D1, "25:00", "26:00")
c.check("无效时间返回 400 invalid_schedule_time", status == 400 and error_code(res) == "invalid_schedule_time", f"{status} {res}")
status, res, _ = create_sched(client, att4["id"], D1, "12:00", "11:00")
c.check("结束早于开始返回 400 invalid_schedule_time", status == 400 and error_code(res) == "invalid_schedule_time", f"{status} {res}")
status, res, _ = create_sched(client, att4["id"], D1, "12:00", "12:00")
c.check("结束等于开始返回 400 invalid_schedule_time", status == 400 and error_code(res) == "invalid_schedule_time", f"{status} {res}")
status, res, _ = create_sched(client, att4["id"], D1, "12:00", "13:00", tz="Mars/Olympus")
c.check("非法时区返回 400 invalid_timezone", status == 400 and error_code(res) == "invalid_timezone", f"{status} {res}")
status, res, _ = create_sched(client, att4["id"], D1, "12:00", "13:00", note="备" * 301)
c.check("备注超过 300 字返回 400", status == 400, f"{status} {res}")

# =====================================================================
# 6. done/cancelled 时未来安排 keep/cancel
# =====================================================================
section("6. Attempt 结束时未来安排的 keep / cancel")
status, probe = client.get(f"/api/attempts/{att['id']}/schedules")
server_now = (probe or {}).get("serverNow") or int(time.time() * 1000)
future_day = (datetime.fromtimestamp(server_now / 1000, ZoneInfo(TZ)) + timedelta(days=3)).date()

cap5 = new_capture(client, f"【日程验收-{uid}】结束尝试的未来安排 keep")
created_capture_ids.append(cap5.get("id"))
att5 = new_attempt(client, cap5["id"], f"keep 尝试【日程验收-{uid}】", state="in_progress")
status, res, _ = create_sched(client, att5["id"], future_day, "10:00", "11:00", note="未来 keep")
c.check("keep 场景未来安排创建成功", status in (200, 201), f"{status} {res}")
keep_block = schedule_of(res)

status, res = client.patch(
    f"/api/attempts/{att5['id']}",
    {"state": "done", "resultText": "完成 keep 场景", "outcome": "success", "revision": att5["revision"]},
)
c.check("未带 futureScheduleAction 结束尝试返回 409 future_schedules", status == 409 and error_code(res) == "future_schedules", f"{status} {res}")
c.check("future_schedules 响应列出未来安排", any(x.get("id") == keep_block["id"] for x in (res or {}).get("futureSchedules") or []), str((res or {}).get("futureSchedules")))
c.check("future_schedules 响应带 currentRevision", (res or {}).get("currentRevision") == att5["revision"], str((res or {}).get("currentRevision")))

status, res = client.patch(
    f"/api/attempts/{att5['id']}",
    {"state": "done", "resultText": "完成 keep 场景", "outcome": "success", "revision": att5["revision"], "futureScheduleAction": "keep"},
)
c.check("futureScheduleAction=keep 保存成功", status == 200, f"{status} {res}")
c.check("keep 返回 cancelledScheduleCount=0", (res or {}).get("cancelledScheduleCount") == 0, str(res))
att5 = (res or {}).get("attempt") or att5
c.check("keep 后尝试 state=done", att5.get("state") == "done", str(att5))
status, listing = client.get(f"/api/attempts/{att5['id']}/schedules")
c.check("keep 后未来安排仍为 active", any(x["id"] == keep_block["id"] and x["status"] == "active" for x in (listing or {}).get("schedules") or []), str((listing or {}).get("schedules")))

cap6 = new_capture(client, f"【日程验收-{uid}】结束尝试的未来安排 cancel")
created_capture_ids.append(cap6.get("id"))
att6 = new_attempt(client, cap6["id"], f"cancel 尝试【日程验收-{uid}】", state="in_progress")
status, res, _ = create_sched(client, att6["id"], future_day, "14:00", "15:00", note="未来 cancel")
c.check("cancel 场景未来安排创建成功", status in (200, 201), f"{status} {res}")
cancel_block = schedule_of(res)
status, res = client.patch(
    f"/api/attempts/{att6['id']}",
    {"state": "cancelled", "revision": att6["revision"], "futureScheduleAction": "cancel"},
)
c.check("futureScheduleAction=cancel 保存成功", status == 200, f"{status} {res}")
c.check("cancel 返回 cancelledScheduleCount=1", (res or {}).get("cancelledScheduleCount") == 1, str(res))
c.check("cancel 后尝试 state=cancelled", ((res or {}).get("attempt") or {}).get("state") == "cancelled", str(res))
status, listing = client.get(f"/api/attempts/{att6['id']}/schedules")
cancelled_rows = [x for x in (listing or {}).get("schedules") or [] if x["id"] == cancel_block["id"]]
c.check("cancel 后未来安排变为 cancelled 且保留历史", bool(cancelled_rows) and cancelled_rows[0]["status"] == "cancelled" and isinstance(cancelled_rows[0].get("cancelledAt"), int), str(cancelled_rows))

# futureScheduleAction 仅对 done/cancelled 生效
cap7 = new_capture(client, f"【日程验收-{uid}】进行中不受 futureScheduleAction 影响")
created_capture_ids.append(cap7.get("id"))
att7 = new_attempt(client, cap7["id"], f"进行中尝试【日程验收-{uid}】")
status, res, _ = create_sched(client, att7["id"], future_day, "16:00", "17:00", note="进行中安排")
c.check("进行中场景安排创建成功", status in (200, 201), f"{status} {res}")
att7_block = schedule_of(res)
status, res = client.patch(
    f"/api/attempts/{att7['id']}",
    {"state": "in_progress", "revision": att7["revision"], "futureScheduleAction": "cancel"},
)
c.check("进行中状态忽略 futureScheduleAction", status == 200, f"{status} {res}")
status, listing = client.get(f"/api/attempts/{att7['id']}/schedules")
c.check("进行中状态安排未被取消", any(x["id"] == att7_block["id"] and x["status"] == "active" for x in (listing or {}).get("schedules") or []), str((listing or {}).get("schedules")))

# =====================================================================
# 7. 删除预览与删除计数
# =====================================================================
section("7. Capture / Attempt 删除预览与事务删除")
cap8 = new_capture(client, f"【日程验收-{uid}】删除计数测试")
created_capture_ids.append(cap8.get("id"))
att8 = new_attempt(client, cap8["id"], f"删除计数尝试【日程验收-{uid}】")
status, res, _ = create_sched(client, att8["id"], D5, "09:00", "10:00", note="保留 active")
c.check("删除测试 active 安排创建成功", status in (200, 201), f"{status} {res}")
del_active = schedule_of(res)
status, res, _ = create_sched(client, att8["id"], D5, "11:00", "12:00", note="取消后计数")
c.check("删除测试第 2 条安排创建成功", status in (200, 201), f"{status} {res}")
del_cancel = schedule_of(res)
status, res = client.post(f"/api/schedules/{del_cancel['id']}/cancel", {"revision": del_cancel["revision"]})
c.check("删除测试第 2 条安排已取消", status == 200, f"{status} {res}")

status, preview = client.get(f"/api/attempts/{att8['id']}/delete-preview")
c.check("Attempt 删除预览返回 200", status == 200, str(preview))
c.check("Attempt 删除预览 scheduleCount=2（含 cancelled）", (preview or {}).get("scheduleCount") == 2, str(preview))
c.check("Attempt 删除预览 activeScheduleCount=1", (preview or {}).get("activeScheduleCount") == 1, str(preview))
c.check("Attempt 删除预览引用计数为 0", (preview or {}).get("referencesFromAttempts") == 0 and (preview or {}).get("referencesToAttempts") == 0, str(preview))

status, preview = client.get(f"/api/captures/{cap8['id']}/delete-preview")
c.check("Capture 删除预览返回 scheduleCount=2", status == 200 and (preview or {}).get("scheduleCount") == 2, f"{status} {preview}")

status, res = client.delete(f"/api/attempts/{att8['id']}")
c.check("删除 Attempt 返回 200", status == 200, f"{status} {res}")
c.check("删除 Attempt 响应 deletedSchedules=2", (res or {}).get("deletedSchedules") == 2, str(res))
status, res = client.get(f"/api/attempts/{att8['id']}/schedules")
c.check("已删除 Attempt 的日程不可再查（404）", status == 404, f"{status} {res}")

cap9 = new_capture(client, f"【日程验收-{uid}】删除 Capture 级联日程")
created_capture_ids.append(cap9.get("id"))
att9 = new_attempt(client, cap9["id"], f"级联删除尝试【日程验收-{uid}】")
status, res, _ = create_sched(client, att9["id"], D5, "13:00", "14:00", note="随念头删除")
c.check("Capture 级联场景安排创建成功", status in (200, 201), f"{status} {res}")
status, res = client.delete(f"/api/captures/{cap9['id']}")
c.check("删除 Capture 返回 200", status == 200, f"{status} {res}")
c.check("删除 Capture 响应 deletedSchedules=1", (res or {}).get("deletedSchedules") == 1, str(res))
status, res = client.get(f"/api/attempts/{att9['id']}/schedules")
c.check("Capture 删除后其 Attempt 的日程不可再查（404）", status == 404, f"{status} {res}")
if cap9.get("id") in created_capture_ids:
    created_capture_ids.remove(cap9.get("id"))

# =====================================================================
# 8. 导出 schemaVersion=3 / scheduleBlocks / 关联
# =====================================================================
section("8. 导出 v2 与 scheduleBlocks")
status, export = client.get("/api/export")
c.check("导出接口返回 200", status == 200, f"{status} {str(export)[:200]}")
c.check("导出 schemaVersion>=6（v0.6 经验/主题导出）", (export or {}).get("schemaVersion") in (6, 7), repr((export or {}).get("schemaVersion")))
data = (export or {}).get("data") or {}
blocks = data.get("scheduleBlocks")
c.check("导出 data.scheduleBlocks 为数组", isinstance(blocks, list), str(type(blocks)))
block_map = {b.get("id"): b for b in blocks or []}
for label, blk in (("第 1 条 active", s1v2), ("已取消", s2c), ("跨午夜", midnight), ("DST earlier", dst_earlier)):
    c.check(f"导出包含{label}安排", blk.get("id") in block_map, str(blk.get("id")))
c.check("导出安排字段与契约 §5.8 完全一致", all(set(b.keys()) == EXPORT_SCHEDULE_KEYS for b in blocks or []), str([sorted(b.keys()) for b in (blocks or [])[:3]]))
exported_s1 = block_map.get(s1v2["id"]) or {}
c.check("导出保留时间/时区/备注/revision", exported_s1.get("startsAt") == s1v2["startsAt"] and exported_s1.get("timezone") == TZ and exported_s1.get("note") == "改到 10:30" and exported_s1.get("revision") == s1v2["revision"], str(exported_s1))
exported_s2 = block_map.get(s2c["id"]) or {}
c.check("导出保留 cancelled 状态与取消时间", exported_s2.get("status") == "cancelled" and isinstance(exported_s2.get("cancelledAt"), int), str(exported_s2))
attempt_ids = {a.get("id") for a in data.get("attempts") or []}
capture_ids = {x.get("id") for x in data.get("captures") or []}
c.check("导出所有安排 attemptId 均可关联到 attempts", all(b.get("attemptId") in attempt_ids for b in blocks or []), str([b.get("attemptId") for b in blocks or [] if b.get("attemptId") not in attempt_ids]))
att_capture = {a.get("id"): a.get("captureId") for a in data.get("attempts") or []}
c.check("导出安排经 attempt 关联到 captures", all(att_capture.get(b.get("attemptId")) in capture_ids for b in blocks or []), "orphan")

# =====================================================================
# 9. 既有手动闭环快速回归
# =====================================================================
section("9. 既有手动闭环回归（capture → attempt → result）")
cap10 = new_capture(client, f"【日程验收-{uid}】手动闭环回归")
created_capture_ids.append(cap10.get("id"))
att10 = new_attempt(client, cap10["id"], f"手动闭环尝试【日程验收-{uid}】", state="in_progress")
status, res = client.patch(
    f"/api/attempts/{att10['id']}",
    {"state": "done", "resultText": "手动闭环结果：观察正常", "outcome": "success", "revision": att10["revision"]},
)
c.check("手动闭环记录结果成功", status == 200 and ((res or {}).get("attempt") or {}).get("state") == "done", f"{status} {res}")
status, res = client.get(f"/api/attempts/{att10['id']}")
c.check("手动闭环结果可读回", status == 200 and ((res or {}).get("attempt") or {}).get("resultText") == "手动闭环结果：观察正常", f"{status} {res}")

# =====================================================================
# 清理（尽力而为，失败不影响结果统计）
# =====================================================================
section("清理")
for cap_id in created_capture_ids:
    if cap_id:
        try:
            client.delete(f"/api/captures/{cap_id}")
        except Exception:  # noqa: BLE001 - 清理失败只记录
            print(f"WARN 清理念头失败：{cap_id}")

ok = c.report("日程安排验收")
sys.exit(0 if ok else 1)
