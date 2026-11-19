"""拾念 SHINIAN - 事件展示栏验收测试（复用运行中的测试服务）"""
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
c = Checker()
uid = uuid.uuid4().hex[:8]
client = Client(base=BASE)
client.login("动态测试")


def ok(cond, name, detail=""):
    c.check(name, bool(cond), detail)


# 未登录
anon = Client(base=BASE)
st, _ = anon.get("/api/activity")
ok(st == 401, "未登录访问动态返回 401", str(st))

# 基础响应结构
st, base = client.get("/api/activity?limit=10")
ok(st == 200 and isinstance(base, dict), "GET /api/activity 返回 200 JSON", str(st))
ok(isinstance(base.get("events"), list), "events 是数组")
ok(isinstance(base.get("stats"), dict), "stats 是对象")
ok(
    isinstance(base.get("filters"), list)
    and {f.get("type") for f in base.get("filters", [])} >= {
        "all", "capture", "attempt", "result", "reference", "ai"
    },
    "filters 覆盖全部动态类型",
    str(base.get("filters")),
)

# 创建一条独立的念头、两条尝试、结果和引用，验证事件聚合
text = f"动态展示验收 {uid}"
st, cap_res = client.post("/api/captures", {"rawText": text})
ok(st == 200, "创建验收念头", str(st))
cap = cap_res["capture"]

st, att_a_res = client.post(
    f"/api/captures/{cap['id']}/attempts",
    {"step": f"动态尝试 A {uid}", "operationId": f"act-a-{uid}"},
)
ok(st == 200, "创建尝试 A", str(st))
att_a = att_a_res["attempt"]

st, att_b_res = client.post(
    f"/api/captures/{cap['id']}/attempts",
    {"step": f"动态尝试 B {uid}", "operationId": f"act-b-{uid}"},
)
ok(st == 200, "创建尝试 B", str(st))
att_b = att_b_res["attempt"]

st, result_res = client.patch(
    f"/api/attempts/{att_b['id']}",
    {"resultText": f"动态结果 {uid}", "outcome": "failure", "revision": 1},
)
ok(st == 200, "记录尝试 B 的结果", str(st))

st, ref_res = client.post(
    f"/api/attempts/{att_b['id']}/references",
    {"toId": att_a["id"], "note": f"动态引用 {uid}", "operationId": f"act-ref-{uid}"},
)
ok(st == 200, "创建引用", str(st))

st, data = client.get("/api/activity?limit=200")
ok(st == 200, "刷新动态", str(st))
events = data.get("events") or []
match = [e for e in events if e.get("captureId") == cap["id"]]
actions = {e.get("action") for e in match}
ok(
    {"capture_created", "attempt_created", "attempt_result", "reference_created"} <= actions,
    "聚合出念头/尝试/结果/引用事件",
    str(actions),
)
ok(any(e.get("attemptId") == att_a["id"] and e.get("type") == "attempt" for e in match), "尝试 A 事件可回源")
ok(any(e.get("attemptId") == att_b["id"] and e.get("type") == "result" for e in match), "结果事件可回源")
ok(any(e.get("attemptId") == att_b["id"] and e.get("type") == "reference" for e in match), "引用事件可回源")
ok(all(isinstance(e.get("at"), int) and e.get("title") for e in events), "事件时间与标题完整")
ok(
    all(events[i]["at"] >= events[i + 1]["at"] for i in range(len(events) - 1)),
    "事件按时间倒序排列",
)

# 筛选、长度和统计
st, filtered = client.get("/api/activity?type=attempt&limit=5")
ok(st == 200 and all(e.get("type") == "attempt" for e in filtered.get("events", [])), "type=attempt 只返回尝试事件")
ok(len(filtered.get("events", [])) <= 5, "limit 生效")
st, limited = client.get("/api/activity?limit=2")
ok(len(limited.get("events", [])) == min(2, limited.get("total", 0)), "limit=2 返回不超过 2 条")
st, bad = client.get("/api/activity?type=unknown")
ok(st == 400, "非法 type 返回 400", str(st))
st, stats = client.get("/api/activity")
ok(stats.get("stats", {}).get("totalEvents", 0) >= len(match), "统计总数覆盖新事件")
ok(stats.get("stats", {}).get("attempts", 0) >= 2, "统计包含尝试")
ok(stats.get("stats", {}).get("results", 0) >= 1, "统计包含结果")

# 动态响应不应包含密钥；AI 事件若已由 test_ai 创建，只检查结构
raw = json.dumps(stats, ensure_ascii=False)
ok("test-secret-key" not in raw and "wrong-key-for-auth-test" not in raw, "动态响应不含测试密钥")
ai_events = [e for e in events if e.get("type") == "ai"]
if ai_events:
    ok(all(e.get("action") and e.get("title") for e in ai_events), "AI 动态结构完整")
    ok(any(e.get("action") in {"ai_adopted", "ai_succeeded", "ai_failed", "ai_cancelled", "ai_interrupted"} for e in ai_events), "AI 动态状态可读")
else:
    c.check("AI 动态（当前无 AI 记录，跳过）", True)

c.report("事件展示栏验收")
sys.exit(0 if c.failed == 0 else 1)
