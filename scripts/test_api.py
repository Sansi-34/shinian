"""拾念 SHINIAN v0.1 - 主流程验收测试

覆盖任务书验收路径：
1. 保存「PWM 低占空比时 LED 会闪」
2. 创建尝试「比较两种 PWM 频率」
3. 记录实际观察
4. 创建另一条调光相关念头及尝试
5. 搜索「闪烁」找到旧结果并打开原念头
6. 把旧结果引用到新尝试，填写复用说明
7. 编辑旧结果，检查引用文本和来源更新提示
8. 刷新（重新 GET）后记录和引用仍在
"""
import sys
import uuid
from common import Client, Checker

c = Checker()
uid = uuid.uuid4().hex[:6]

# ---------- 会话 ----------
client = Client()
body = client.login("验收用户")
c.check("创建/登录本机账号", body.get("ok") is True, str(body))

# ---------- 1. 保存念头 ----------
status, res = client.post("/api/captures", {"rawText": "PWM 低占空比时 LED 会闪"})
c.check("保存念头返回 200", status == 200, str(res))
cap1 = res["capture"]
c.check("念头原文保存正确", cap1["rawText"] == "PWM 低占空比时 LED 会闪")
c.check("念头 revision = 1", cap1["revision"] == 1)

# ---------- 2. 尝试 ----------
op_attempt = f"op-att-{uid}"
status, res = client.post(
    f"/api/captures/{cap1['id']}/attempts",
    {"step": "比较两种 PWM 频率", "state": "todo", "operationId": op_attempt},
)
c.check("创建尝试返回 200", status == 200, str(res))
att1 = res["attempt"]
c.check("尝试关联原念头", att1["captureId"] == cap1["id"])

# 重复提交（同一操作 ID）
status, res = client.post(
    f"/api/captures/{cap1['id']}/attempts",
    {"step": "比较两种 PWM 频率", "state": "todo", "operationId": op_attempt},
)
c.check("重复提交同一操作 ID 返回同一尝试", status == 200 and res["attempt"]["id"] == att1["id"], str(res))

status, list_res = client.get(f"/api/captures/{cap1['id']}/attempts")
c.check("重复提交只产生一条尝试", len(list_res["attempts"]) == 1, str(list_res))

# 同一操作 ID 不同内容 → 拒绝
status, res = client.post(
    f"/api/captures/{cap1['id']}/attempts",
    {"step": "完全不同的内容", "state": "todo", "operationId": op_attempt},
)
c.check("同一操作 ID 不同内容被拒绝 (409)", status == 409, f"{status} {res}")

# ---------- 3. 记录结果 ----------
status, res = client.patch(
    f"/api/attempts/{att1['id']}",
    {
        "state": "done",
        "resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁",
        "outcome": "failure",
        "revision": att1["revision"],
    },
)
c.check("记录结果返回 200", status == 200, str(res))
att1 = res["attempt"]
c.check("结果文本正确", att1["resultText"] == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁")
c.check("状态与结果分开保存（已结束 + 失败）", att1["state"] == "done" and att1["outcome"] == "failure")
c.check("结果时间已记录", att1["observedAt"] is not None)
c.check("结果编辑后 revision 递增", att1["revision"] == 2)

# 版本冲突：用旧 revision 再改
status, res = client.patch(
    f"/api/attempts/{att1['id']}",
    {"resultText": "旧版本写入", "revision": 1},
)
c.check("旧版本提交返回 409", status == 409, f"{status} {res}")

# 重新读取（模拟刷新）
status, res = client.get(f"/api/attempts/{att1['id']}")
c.check("刷新后读取结果仍在", status == 200 and res["attempt"]["resultText"] == att1["resultText"])
c.check("尝试能取回原念头", res["capture"]["id"] == cap1["id"])

# ---------- 4. 另一条调光相关念头及尝试 ----------
status, res = client.post("/api/captures", {"rawText": "调光时想避免肉眼可见闪烁，需要选频率"})
cap2 = res["capture"]
c.check("保存第二条调光念头", status == 200)

op_attempt2 = f"op-att2-{uid}"
status, res = client.post(
    f"/api/captures/{cap2['id']}/attempts",
    {"step": "按旧结论选 2 kHz 试调光", "state": "in_progress", "operationId": op_attempt2},
)
att2 = res["attempt"]
c.check("创建新尝试", status == 200)

# ---------- 5. 搜索「闪烁」 ----------
status, res = client.get("/api/search?q=%E9%97%AA%E7%83%81")  # 闪烁
c.check("搜索「闪烁」返回 200", status == 200, str(res))
cap_ids = [x["id"] for x in res["captures"]]
att_ids = [x["id"] for x in res["attempts"]]
c.check("搜索命中旧结果（尝试）", att1["id"] in att_ids, str(att_ids))
# 原文「PWM 低占空比时 LED 会闪」不含「闪烁」；「闪烁」命中第二条调光念头原文
c.check("搜索命中包含关键词的另一条念头原文", cap2["id"] in cap_ids, str(cap_ids))
hit = next((x for x in res["attempts"] if x["id"] == att1["id"]), None)
c.check("命中项标注匹配字段为结果", hit and hit["matchField"] == "attempt.resultText", str(hit))
c.check("命中项带结果摘要", hit and "闪烁" in hit["snippet"], str(hit))
c.check("命中项可回源到原念头", hit and hit["captureId"] == cap1["id"])

# 打开原念头与尝试
status, res = client.get(f"/api/captures/{hit['captureId']}")
c.check("搜索回源打开原念头", status == 200 and res["capture"]["id"] == cap1["id"])
status, res = client.get(f"/api/attempts/{hit['id']}")
c.check("搜索回源打开旧尝试", status == 200 and res["attempt"]["id"] == att1["id"])

# ---------- 6. 引用旧结果 ----------
op_ref = f"op-ref-{uid}"
status, res = client.post(
    f"/api/attempts/{att2['id']}/references",
    {"toId": att1["id"], "note": "先按 2 kHz 继续验证调光", "operationId": op_ref},
)
c.check("创建引用返回 200", status == 200, str(res))
ref1 = res["reference"]
c.check("引用保存来源 ID", ref1["toAttemptId"] == att1["id"])
c.check("引用保存来源版本", ref1["snapshotRevision"] == att1["revision"])
c.check("引用保存当时结果文本", ref1["snapshotResultText"] == att1["resultText"])
c.check("引用保存复用说明", ref1["note"] == "先按 2 kHz 继续验证调光")

# 重复提交同一操作 ID
status, res = client.post(
    f"/api/attempts/{att2['id']}/references",
    {"toId": att1["id"], "note": "先按 2 kHz 继续验证调光", "operationId": op_ref},
)
c.check("重复引用提交不产生新记录", status == 200 and res["reference"]["id"] == ref1["id"], str(res))

# 新操作 ID 重复引用 → 409
status, res = client.post(
    f"/api/attempts/{att2['id']}/references",
    {"toId": att1["id"], "note": "再次引用", "operationId": f"{op_ref}-b"},
)
c.check("重复引用被拒绝 (409)", status == 409, f"{status} {res}")

# 自引用 → 400
status, res = client.post(
    f"/api/attempts/{att2['id']}/references",
    {"toId": att2["id"], "note": "自引用", "operationId": f"{op_ref}-self"},
)
c.check("自引用被拒绝 (400)", status == 400, f"{status} {res}")

# 双向可查
status, res = client.get(f"/api/attempts/{att2['id']}/references")
c.check("新尝试可看到引用来源", any(r["toAttemptId"] == att1["id"] for r in res["fromRefs"]))
status, res = client.get(f"/api/attempts/{att1['id']}/references")
c.check("旧尝试可看到被谁引用", any(r["fromAttemptId"] == att2["id"] for r in res["toRefs"]))

# ---------- 7. 编辑旧结果，检查快照与更新提示 ----------
status, res = client.get(f"/api/attempts/{att1['id']}")
old_rev = res["attempt"]["revision"]
status, res = client.patch(
    f"/api/attempts/{att1['id']}",
    {"resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁（复测确认）", "outcome": "success", "revision": old_rev},
)
c.check("编辑旧结果成功", status == 200, str(res))

status, res = client.get(f"/api/attempts/{att2['id']}/references")
ref = next(r for r in res["fromRefs"] if r["toAttemptId"] == att1["id"])
c.check("引用文本保持引用时的快照", ref["snapshotResultText"] == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁")
c.check("来源有更新提示为 true", ref["source"]["updatedSinceSnapshot"] is True)
c.check("来源当前文本为最新", ref["source"]["resultText"].endswith("（复测确认）"))

# ---------- 8. 刷新/重启后仍在（本脚本内先做刷新） ----------
status, res = client.get("/api/captures")
c.check("刷新列表仍能读取记录", status == 200 and len(res["captures"]) >= 2)
status, res = client.get(f"/api/attempts/{att2['id']}/references")
c.check("刷新后引用仍在", len(res["fromRefs"]) == 1)

ok = c.report("主流程验收")
sys.exit(0 if ok else 1)