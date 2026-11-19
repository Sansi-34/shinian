"""拾念 SHINIAN v0.1 - 在主库写入任务书要求的验收示例（可重复执行）

示例：
- 念头「PWM 低占空比时 LED 会闪」
- 尝试「比较两种 PWM 频率」+ 观察「500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁」
- 念头「调光时想避免肉眼可见闪烁，需要选频率」+ 尝试「按旧结论选 2 kHz 试调光」
- 新尝试引用旧结果，复用说明「先按 2 kHz 继续验证调光」
"""
import sys
import uuid
from common import Client

BASE = "http://127.0.0.1:3000"
client = Client(BASE)
client.login("本地用户")

CAP1 = "PWM 低占空比时 LED 会闪"
CAP2 = "调光时想避免肉眼可见闪烁，需要选频率"
STEP1 = "比较两种 PWM 频率"
STEP2 = "按旧结论选 2 kHz 试调光"
RESULT1 = "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁"


def find_capture(text):
    _, res = client.get("/api/captures")
    for c in res["captures"]:
        if c["rawText"] == text:
            return c
    return None


def find_attempt(capture_id, step):
    _, res = client.get(f"/api/captures/{capture_id}/attempts")
    for a in res["attempts"]:
        if a["step"] == step:
            return a
    return None


cap1 = find_capture(CAP1)
if not cap1:
    _, res = client.post("/api/captures", {"rawText": CAP1})
    cap1 = res["capture"]
    print("created capture 1")

att1 = find_attempt(cap1["id"], STEP1)
if not att1:
    _, res = client.post(
        f"/api/captures/{cap1['id']}/attempts",
        {"step": STEP1, "state": "done", "operationId": "acceptance-att-1"},
    )
    att1 = res["attempt"]
    print("created attempt 1")

if not att1.get("resultText"):
    _, res = client.patch(
        f"/api/attempts/{att1['id']}",
        {"resultText": RESULT1, "outcome": "failure", "revision": att1["revision"]},
    )
    att1 = res["attempt"]
    print("recorded result 1")

cap2 = find_capture(CAP2)
if not cap2:
    _, res = client.post("/api/captures", {"rawText": CAP2})
    cap2 = res["capture"]
    print("created capture 2")

att2 = find_attempt(cap2["id"], STEP2)
if not att2:
    _, res = client.post(
        f"/api/captures/{cap2['id']}/attempts",
        {"step": STEP2, "state": "in_progress", "operationId": "acceptance-att-2"},
    )
    att2 = res["attempt"]
    print("created attempt 2")

_, refs = client.get(f"/api/attempts/{att2['id']}/references")
if not any(r["toAttemptId"] == att1["id"] for r in refs["fromRefs"]):
    _, res = client.post(
        f"/api/attempts/{att2['id']}/references",
        {"toId": att1["id"], "note": "先按 2 kHz 继续验证调光", "operationId": "acceptance-ref-1"},
    )
    print("created reference")

print("验收示例已就绪")
print(f"capture1={cap1['id']} attempt1={att1['id']}")
print(f"capture2={cap2['id']} attempt2={att2['id']}")