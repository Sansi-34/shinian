"""给预览环境灌入演示数据（只写 preview.sqlite，绝不碰主库）。

用法：
    $env:SHINIAN_BASE="http://127.0.0.1:3001"; python db/_seed_preview.py
"""
import os
import sys
import random
import datetime

sys.path.insert(0, r"D:\联动日程表\scripts")
from common import Client  # noqa: E402

BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3001")
c = Client(BASE)
c.login("预览用户")

suffix = random.randint(10000, 99999)
op = lambda tag: f"seed-{tag}-{suffix}-{random.randint(1000, 9999)}"

def post(path, body):
    st, res = c.post(path, body)
    if st not in (200, 201):
        print(f"   ! POST {path} -> {st} {str(res)[:100]}")
    return res or {}

def patch(path, body):
    st, res = c.patch(path, body)
    if st not in (200, 201):
        print(f"   ! PATCH {path} -> {st} {str(res)[:100]}")
    return res or {}

def capture(text):
    return post("/api/captures", {"rawText": text}).get("capture", {})

def attempt(cap_id, step, minutes=20, state="todo"):
    return post(f"/api/captures/{cap_id}/attempts", {
        "step": step, "estimatedMinutes": minutes, "operationId": op("att"),
    }).get("attempt", {})

def result(att, text, outcome, state="done"):
    return patch(f"/api/attempts/{att['id']}", {
        "revision": att.get("revision", 1),
        "state": state, "resultText": text, "outcome": outcome,
    }).get("attempt", {})

print("— 造念头与尝试")
# 1. PWM 闪烁
c1 = capture("PWM 低占空比时 LED 会闪，人眼能看出来")
a1_1 = attempt(c1["id"], "比较 500Hz / 2kHz / 5kHz 三种 PWM 频率", 30)
result(a1_1, "500Hz 仍可见闪烁，2kHz 肉眼未见，5kHz 完全无感。结论：调光至少 2kHz。", "success")
a1_2 = attempt(c1["id"], "把占空比从 10% 提到 30% 再观察", 15)
result(a1_2, "30% 时闪烁减轻但快速转动视线仍能察觉", "failure")

# 2. 调光选频率
c2 = capture("调光时想避免肉眼可见闪烁，需要选对频率")
a2_1 = attempt(c2["id"], "按旧结论选 2kHz 试一次完整调光", 20)
result(a2_1, "2kHz 下从 5% 到 100% 全程无可见闪烁，调光曲线平滑。", "success")
# 留一个待开始的尝试，作为主题的「下次继续」
a2_2 = attempt(c2["id"], "用 2kHz 调光并记录功耗曲线", 25, state="todo")

# 3. ESP32 ADC 漂移
c3 = capture("ESP32 的 WiFi 和 ADC 同时用，读数会漂")
a3_1 = attempt(c3["id"], "关闭 WiFi 单独测 ADC 基准", 25)
result(a3_1, "关闭 WiFi 后漂移从 ±15LSB 降到 ±3LSB，确认是射频干扰。", "success")
a3_2 = attempt(c3["id"], "ADC 采样窗口内暂停 WiFi beacon", 40, state="in_progress")

# 4. 串口日志落文件
c4 = capture("串口日志想输出到文件，方便事后回看")
a4_1 = attempt(c4["id"], "用 idf.py monitor 重定向到文件", 10)
result(a4_1, "能落文件，但程序 panic 时最后几行会丢。", "undetermined")

# 5. 一键进 bootloader
c5 = capture("固件升级想做成按一下按钮就进 bootloader")
a5_1 = attempt(c5["id"], "加一个 GPIO 判断，启动时读取电平", 20)
result(a5_1, "可行，但按键需要 10k 上拉，否则悬空时会误进 bootloader。", "success")

# 6. USB-C 与电池切换掉电
c6 = capture("PCB 上 USB-C 供电和电池切换会有瞬间断电")
a6_1 = attempt(c6["id"], "并联电容做切换缓冲", 30)
result(a6_1, "并了 1000uF 仍掉电 80ms，MCU 还是会复位，不够。", "failure")

# 7. 低功耗唤醒 I2C 不响应
c7 = capture("低功耗模式下唤醒后 I2C 从设备不响应")
a7_1 = attempt(c7["id"], "唤醒后先延时 50ms 再初始化 I2C", 15, state="todo")

print("— 建立引用与关联")
# 2 的尝试引用 1 的尝试
post(f"/api/attempts/{a2_1['id']}/references", {
    "toId": a1_1["id"], "note": "沿用 2kHz 的结论", "operationId": op("ref"),
})
# 念头之间关联
post(f"/api/captures/{c1['id']}/links", {
    "toCaptureId": c2["id"], "note": "同属调光闪烁问题", "operationId": op("link"),
})

print("— 建主题")
# nextAttemptId 只能是未完成的尝试，用 in_progress 的那个
t1 = post("/api/topics", {
    "title": "PWM 调光闪烁",
    "captureIds": [c1["id"], c2["id"]],
    "nextAttemptId": a2_2["id"],
    "operationId": op("topic"),
})
t1 = (t1 or {}).get("topic", {}) if isinstance(t1, dict) else {}
t2 = post("/api/topics", {
    "title": "ESP32 稳定性",
    "captureIds": [c3["id"]],
    "operationId": op("topic"),
}).get("topic", {})

print("— 排日程")
today = datetime.date.today()
d1 = (today + datetime.timedelta(days=1)).isoformat()
d2 = (today + datetime.timedelta(days=2)).isoformat()
post(f"/api/attempts/{a3_2['id']}/schedules", {
    "date": d1, "startTime": "10:00", "endTime": "11:00",
    "timezone": "Asia/Shanghai", "note": "演示：暂停 beacon 测 ADC",
    "operationId": op("sch"),
})
post(f"/api/attempts/{a7_1['id']}/schedules", {
    "date": d2, "startTime": "14:30", "endTime": "15:15",
    "timezone": "Asia/Shanghai", "note": "演示：唤醒后延时初始化",
    "operationId": op("sch"),
})

print("— 归档一条")
post(f"/api/captures/{c6['id']}/archive", {})

print("\n灌入完成：")
st, lst = c.get("/api/captures?archived=include")
print(f"  念头 {len((lst or {}).get('captures') or [])} 条")
st, g = c.get("/api/graph")
print(f"  图谱节点 {len((g or {}).get('nodes') or [])} 个 / 连线 {len((g or {}).get('links') or [])} 条")
st, tp = c.get("/api/topics")
print(f"  主题 {len((tp or {}).get('topics') or [])} 个")
st, sch = c.get(f"/api/schedules?from={d1}&to={d2}")
print(f"  日程 {len((sch or {}).get('schedules') or [])} 条")
