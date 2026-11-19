"""拾念 SHINIAN v0.1 - 20 条中英混合记录 / 10 个检索目标与回源测试"""
import sys
import uuid
from common import Client, Checker

c = Checker()
uid = uuid.uuid4().hex[:6]
client = Client()
client.login("搜索测试用户")

# (念头原文, 尝试步骤, 尝试结果)
DATA = [
    ("PWM 低占空比时 LED 会闪", "比较两种 PWM 频率", "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁"),
    ("调光时想避免肉眼可见闪烁，需要选频率", "按旧结论选 2 kHz 试调光", "调光平滑，无可见闪烁"),
    ("Compare two PWM frequencies at 500Hz and 2kHz", "Measure LED with oscilloscope", "At 500 Hz flicker visible; 2 kHz looks steady"),
    ("LED flicker at low duty cycle", "Try different duty cycles", "Flicker starts below 10 percent duty cycle"),
    ("STM32 定时器配置死区时间", "调整 dead time 参数", "死区设为 1us 后桥臂不再直通"),
    ("I2C bus pull-up resistor calculation", "Test 4.7k pull-up", "Rise time improved with 4.7k pull-up at 400kHz"),
    ("串口波特率不匹配导致乱码", "逐档尝试波特率", "115200 与 9600 不一致时输出乱码，改为 115200 后正常"),
    ("UART baud rate mismatch garbage output", "Swap TX and RX wires", "Garbage was caused by baud mismatch, not wiring"),
    ("锂电池充电芯片发热严重", "降低充电电流", "电流从 1A 降到 0.5A 后芯片温度明显下降"),
    ("Li-ion charger gets hot during fast charge", "Measure board temperature", "Charger reached 70C at 1A; 45C at 0.5A"),
    ("MQTT 断线重连后消息重复", "开启 clean session", "clean session 打开后重连不再重复旧消息"),
    ("MQTT reconnect duplicate messages", "Set QoS to 1", "QoS1 reduced duplicates but retransmission still possible"),
    ("PID 参数整定震荡", "先调 P 再调 D", "P 过大导致震荡，加入 D 项后收敛"),
    ("PID tuning oscillation overshoot", "Reduce Kp by half", "Overshoot dropped from 30 percent to 8 percent"),
    ("ESP32 深度睡眠电流偏高", "断开板载 LED", "板载 LED 漏电，断开后睡眠电流降到 50uA"),
    ("ESP32 deep sleep current too high", "Disable unused peripherals", "Deep sleep current fell to 20uA after disabling peripherals"),
    ("PCB 地线噪声干扰 ADC", "改为单点接地", "单点接地后 ADC 读数波动从 20 LSB 降到 3 LSB"),
    ("PCB ground noise affects ADC readings", "Add ground plane stitching", "Ground stitching reduced noise by 15 LSB"),
    ("步进电机丢步", "降低加速度", "加速度降到 500 steps/s^2 后不再丢步"),
    ("Stepper motor missing steps at high speed", "Increase driver current", "Missing steps stopped at 1.2A driver current"),
]

created = []
for raw, step, result in DATA:
    st, res = client.post("/api/captures", {"rawText": f"{raw} [{uid}]"})
    assert st == 200, (st, res)
    cap = res["capture"]
    st, res = client.post(
        f"/api/captures/{cap['id']}/attempts",
        {"step": f"{step} [{uid}]", "state": "done", "operationId": f"op-{uuid.uuid4()}"},
    )
    assert st == 200, (st, res)
    att = res["attempt"]
    st, res = client.patch(
        f"/api/attempts/{att['id']}",
        {"resultText": f"{result} [{uid}]", "outcome": "undetermined", "revision": att["revision"]},
    )
    assert st == 200, (st, res)
    created.append((cap, res["attempt"]))

c.check("创建 20 条中英混合记录", len(created) == 20, f"got {len(created)}")

# 10 个检索目标：关键词 -> (期望类型, 期望记录在 DATA 中的索引, 期望来源字段)
TARGETS = [
    ("闪烁", "attempt_result", 0),
    ("PWM", "capture", 0),
    ("flicker", "attempt_result", 3),
    ("波特率", "capture", 6),
    ("baud", "attempt_result", 7),
    ("MQTT", "capture", 10),
    ("reconnect", "capture", 11),
    ("地线", "capture", 16),
    ("ground", "attempt_result", 17),
    ("stepper", "capture", 19),
]

for keyword, kind, idx in TARGETS:
    st, res = client.get(f"/api/search?q={keyword}")
    c.check(f"搜索「{keyword}」返回 200", st == 200, str(res))
    if kind == "capture":
        hit = next((x for x in res["captures"] if x["id"] == created[idx][0]["id"]), None)
        c.check(f"「{keyword}」命中预期念头", hit is not None, str([x['id'] for x in res['captures']]))
        if hit:
            st2, back = client.get(f"/api/captures/{hit['id']}")
            c.check(f"「{keyword}」回源打开念头", st2 == 200 and back["capture"]["id"] == created[idx][0]["id"])
    else:
        hit = next((x for x in res["attempts"] if x["id"] == created[idx][1]["id"]), None)
        c.check(f"「{keyword}」命中预期结果", hit is not None, str([x['id'] for x in res['attempts']]))
        if hit:
            st2, back = client.get(f"/api/attempts/{hit['id']}")
            c.check(
                f"「{keyword}」回源打开尝试与念头",
                st2 == 200 and back["attempt"]["id"] == created[idx][1]["id"] and back["capture"]["id"] == created[idx][0]["id"],
            )

ok = c.report("20 条混合记录搜索验收")
sys.exit(0 if ok else 1)