"""拾念 SHINIAN v0.1 - 主库交付前核对（静态页面、来源检查、验收数据、重启持久化）"""
import json
import re
import sys
import urllib.request
import urllib.error
from common import Client

BASE = "http://127.0.0.1:3000"
passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


# 静态页面
with urllib.request.urlopen(BASE + "/", timeout=10) as res:
    html = res.read().decode()
check("首页返回 HTML", res.status == 200 and '<div id="root">' in html, html[:100])
m = re.search(r'src="(/assets/[^"]+\.js)"', html)
check("首页引用构建后的 JS", m is not None, html)
if m:
    with urllib.request.urlopen(BASE + m.group(1), timeout=10) as res:
        js = res.read()
    check("JS 资源可访问", res.status == 200 and len(js) > 10000)

# 未登录访问
try:
    urllib.request.urlopen(BASE + "/api/captures", timeout=5)
    check("未登录访问 API 被拒绝", False)
except urllib.error.HTTPError as e:
    check("未登录访问 API 被拒绝 (401)", e.code == 401, str(e.code))

# 来源检查（跨站写请求）
req = urllib.request.Request(
    BASE + "/api/captures",
    data=json.dumps({"rawText": "x"}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "Origin": "http://evil.example"},
)
try:
    urllib.request.urlopen(req, timeout=5)
    check("跨站写请求被拒绝", False)
except urllib.error.HTTPError as e:
    check("跨站写请求被拒绝 (403)", e.code == 403, str(e.code))

# 验收数据
client = Client(BASE)
client.login("本地用户")

_, caps = client.get("/api/captures")
texts = [c["rawText"] for c in caps["captures"]]
check("存在验收念头 1", "PWM 低占空比时 LED 会闪" in texts, str(texts))
check("存在验收念头 2", "调光时想避免肉眼可见闪烁，需要选频率" in texts, str(texts))

_, s = client.get("/api/search?q=%E9%97%AA%E7%83%81")  # 闪烁
check("搜索「闪烁」命中旧观察", any("可见闪烁" in (a["resultText"] or "") for a in s["attempts"]))
att_hit = next(a for a in s["attempts"] if "可见闪烁" in (a["resultText"] or ""))
_, src = client.get(f"/api/attempts/{att_hit['id']}")
check("旧观察可回源原念头", src["capture"]["rawText"] == "PWM 低占空比时 LED 会闪")

_, atts2 = client.get(f"/api/captures/{src['capture']['id']}/attempts")
att1 = next(a for a in atts2["attempts"] if a["step"] == "比较两种 PWM 频率")
check("旧尝试存在且结果正确", att1["resultText"] == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁")

# 新尝试引用
cap2 = next(c for c in caps["captures"] if c["rawText"] == "调光时想避免肉眼可见闪烁，需要选频率")
_, atts = client.get(f"/api/captures/{cap2['id']}/attempts")
att2 = next(a for a in atts["attempts"] if a["step"] == "按旧结论选 2 kHz 试调光")
_, refs = client.get(f"/api/attempts/{att2['id']}/references")
check("新尝试有引用来源", any(r["toAttemptId"] == att1["id"] for r in refs["fromRefs"]))
_, refs_back = client.get(f"/api/attempts/{att1['id']}/references")
check("旧尝试能看到被引用", any(r["fromAttemptId"] == att2["id"] for r in refs_back["toRefs"]))
check("引用快照文本保存", refs["fromRefs"][0]["snapshotResultText"] == att1["resultText"])
check("复用说明保存", refs["fromRefs"][0]["note"] == "先按 2 kHz 继续验证调光")

print("\n" + "=" * 60)
print(f"主库核对: {passed} passed, {failed} failed")
print("=" * 60)
sys.exit(0 if failed == 0 else 1)