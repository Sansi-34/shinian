"""拾念 SHINIAN v0.1 - 一致性测试

覆盖：
- 两个浏览器（两个 cookie 会话）编辑同一对象，旧版本 409 且返回最新内容
- 并发重复提交同一操作 ID 只创建一条
- 归档/恢复与筛选
- 删除被引用来源：新尝试完整保留、引用按预览处理、无检索残留
"""
import sys
import uuid
import threading
from common import Client, Checker

c = Checker()
uid = uuid.uuid4().hex[:6]

A = Client()
B = Client()
A.login("同一用户")
B.login("同一用户")

# ---------- 双浏览器可见性 ----------
st, res = A.post("/api/captures", {"rawText": f"双设备可见性测试 {uid}"})
cap = res["capture"]
st, res = B.get("/api/captures")
c.check("设备 A 新建后设备 B 刷新可见", st == 200 and any(x["id"] == cap["id"] for x in res["captures"]))

# ---------- 版本冲突 ----------
st, res = B.get(f"/api/captures/{cap['id']}")
b_rev = res["capture"]["revision"]
st, res = A.patch(f"/api/captures/{cap['id']}", {"rawText": f"A 的新内容 {uid}", "revision": b_rev})
c.check("设备 A 先保存成功", st == 200, str(res))
st, res = B.patch(f"/api/captures/{cap['id']}", {"rawText": f"B 的旧草稿 {uid}", "revision": b_rev})
c.check("设备 B 用旧版本保存返回 409", st == 409, f"{st} {res}")
c.check("409 返回最新内容供核对", res.get("currentRawText") == f"A 的新内容 {uid}", str(res))
c.check("409 返回最新 revision", res.get("currentRevision") == b_rev + 1, str(res))

# B 采用最新版本后重试成功（不静默覆盖，而是显式重试）
st, res = B.patch(f"/api/captures/{cap['id']}", {"rawText": f"B 确认后的内容 {uid}", "revision": b_rev + 1})
c.check("设备 B 查看最新后重试成功", st == 200, str(res))

# ---------- 并发重复提交同一操作 ID ----------
st, res = A.post("/api/captures", {"rawText": f"并发去重测试 {uid}"})
cap2 = res["capture"]
op = f"op-concurrent-{uid}"
results = []


def submit():
    cl = Client()
    cl.login("同一用户")
    results.append(
        cl.post(
            f"/api/captures/{cap2['id']}/attempts",
            {"step": "并发提交同一个尝试", "state": "todo", "operationId": op},
        )
    )


threads = [threading.Thread(target=submit) for _ in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()

st, res = A.get(f"/api/captures/{cap2['id']}/attempts")
c.check("并发重复提交只产生一条尝试", len(res["attempts"]) == 1, f"count={len(res['attempts'])}")
c.check(
    "并发请求全部成功或可回放",
    all(r[0] in (200, 409) for r in results),
    str([r[0] for r in results]),
)

# ---------- 归档/恢复 ----------
st, res = A.post(f"/api/captures/{cap['id']}/archive", {})
c.check("归档成功", st == 200 and res["capture"]["archivedAt"] is not None)
st, res = A.get("/api/captures")
c.check("默认列表不含已归档", all(x["id"] != cap["id"] for x in res["captures"]))
st, res = A.get("/api/captures?archived=1")
c.check("已归档筛选可找回", any(x["id"] == cap["id"] for x in res["captures"]))
st, res = A.post(f"/api/captures/{cap['id']}/restore", {})
c.check("归档后可恢复", st == 200 and res["capture"]["archivedAt"] is None)

# ---------- 删除被引用来源 ----------
st, res = A.post("/api/captures", {"rawText": f"被引用的旧来源 {uid}-SRCKEY"})
src_cap = res["capture"]
st, res = A.post(
    f"/api/captures/{src_cap['id']}/attempts",
    {"step": "旧来源尝试", "state": "done", "operationId": f"op-src-{uid}"},
)
src_att = res["attempt"]
st, res = A.patch(
    f"/api/attempts/{src_att['id']}",
    {"resultText": "旧来源结果 SRCKEY", "outcome": "failure", "revision": src_att["revision"]},
)

st, res = A.post("/api/captures", {"rawText": f"新尝试的念头 {uid}"})
dst_cap = res["capture"]
st, res = A.post(
    f"/api/captures/{dst_cap['id']}/attempts",
    {"step": "新尝试引用旧来源", "state": "in_progress", "operationId": f"op-dst-{uid}"},
)
dst_att = res["attempt"]
st, res = A.post(
    f"/api/attempts/{dst_att['id']}/references",
    {"toId": src_att["id"], "note": "准备复用旧结论", "operationId": f"op-ref-del-{uid}"},
)
c.check("建立删除前引用", st == 200)

st, preview = A.get(f"/api/captures/{src_cap['id']}/delete-preview")
c.check(
    "删除预览显示影响范围",
    st == 200 and preview["attemptCount"] == 1 and preview["referencesToAttempts"] == 1,
    str(preview),
)

st, res = A.delete(f"/api/captures/{src_cap['id']}")
c.check("删除来源成功", st == 200, str(res))
c.check("删除返回处理的引用数", res.get("deletedReferences") == 1, str(res))

st, res = A.get(f"/api/attempts/{dst_att['id']}")
c.check("新尝试仍然完整", st == 200 and res["attempt"]["step"] == "新尝试引用旧来源")
st, res = A.get(f"/api/attempts/{dst_att['id']}/references")
c.check("引用已按预览清理", len(res["fromRefs"]) == 0, str(res))
st, res = A.get(f"/api/attempts/{src_att['id']}")
c.check("被删除的尝试不可再打开", st == 404)
st, res = A.get(f"/api/search?q=SRCKEY")
c.check("删除后无检索残留", st == 200 and len(res["captures"]) == 0 and len(res["attempts"]) == 0, str(res))

# ---------- 删除尝试（作为被引用来源） ----------
st, res = A.post("/api/captures", {"rawText": f"尝试删除测试 {uid}"})
t_cap = res["capture"]
st, res = A.post(f"/api/captures/{t_cap['id']}/attempts", {"step": "被引用的中间尝试", "state": "done", "operationId": f"op-t1-{uid}"})
t1 = res["attempt"]
st, res = A.post(f"/api/captures/{t_cap['id']}/attempts", {"step": "引用方尝试", "state": "todo", "operationId": f"op-t2-{uid}"})
t2 = res["attempt"]
st, res = A.post(f"/api/attempts/{t2['id']}/references", {"toId": t1["id"], "operationId": f"op-tref-{uid}"})
c.check("尝试间引用建立", st == 200)
st, res = A.delete(f"/api/attempts/{t1['id']}")
c.check("删除被引用的尝试", st == 200 and res.get("deletedReferences") == 1, str(res))
st, res = A.get(f"/api/attempts/{t2['id']}/references")
c.check("删除尝试后引用清理", len(res["fromRefs"]) == 0, str(res))

ok = c.report("一致性验收")
sys.exit(0 if ok else 1)