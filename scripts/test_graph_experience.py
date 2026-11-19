"""知识网络经验找回与本地会话的接口验收（需先启动隔离服务并运行 seed_graph_experience.mjs）。

用法：
  python scripts/test_graph_experience.py http://127.0.0.1:3201

覆盖：登录会话、未登录拒绝、错误 Host、跨站 Origin、搜索旧结果、一跳关系、双向引用。
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3201").rstrip("/")
CHECKS = []


def check(name, condition, detail=""):
    CHECKS.append((name, bool(condition), detail))
    print(("PASS" if condition else "FAIL") + " " + name + ((" · " + detail) if detail else ""))


def request(path, method="GET", body=None, cookie=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if cookie:
        req.add_header("Cookie", "shinian_sid=" + cookie)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None), resp.headers
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw
        return exc.code, parsed, exc.headers


status, payload, headers = request("/api/session/create", "POST", {"username": "YPL"})
cookie = headers.get("Set-Cookie", "").split("shinian_sid=")[-1].split(";")[0]
check("登录签发会话", status == 200 and bool(cookie), str(status))

status, _, _ = request("/api/graph")
check("未登录拒绝全图", status == 401, str(status))

status, _, _ = request("/api/graph", headers={"Host": "evil.example"})
check("错误 Host 被拒绝", status == 403, str(status))

status, _, _ = request(
    "/api/session/create",
    "POST",
    {"username": "YPL"},
    headers={"Origin": "http://evil.example"},
)
check("跨站 Origin 写请求被拒绝", status == 403, str(status))

status, search, _ = request("/api/graph/search?q=ADC&archived=0&limit=20", cookie=cookie)
hit = (search or {}).get("results", [{}])[0].get("node", {})
check("搜索命中旧失败结果", status == 200 and hit.get("id") == "attempt:att-old", str(status))
check("搜索展示实际观察与所属念头", hit.get("outcome") == "failure" and hit.get("captureLabel"), "")

status, focus, _ = request("/api/graph/focus?node=attempt%3Aatt-old", cookie=cookie)
ids = {node["id"] for node in (focus or {}).get("nodes", [])}
links = {(link["source"], link["target"], link["type"]) for link in (focus or {}).get("links", [])}
check("按稳定 ID 载入一跳局部图", status == 200 and "attempt:att-old" in ids, str(status))
check(
    "旧结果能看到被后续尝试引用",
    ("attempt:att-new", "attempt:att-old", "references") in links,
    str(len(links)),
)
check(
    "局部图保留实际观察与来源",
    any(n["id"] == "attempt:att-old" and n.get("resultText") and n.get("sourceUrl") for n in (focus or {}).get("nodes", [])),
    "",
)

status, _, _ = request("/api/graph/focus?node=bad-id", cookie=cookie)
check("非法节点 ID 返回 400", status == 400, str(status))

status, _, _ = request("/api/graph/focus?node=attempt%3Anot-found", cookie=cookie)
check("不可见节点返回 404", status == 404, str(status))

status, _, _ = request("/api/session/destroy", "POST", {}, cookie=cookie)
status_after, _, _ = request("/api/graph", cookie=cookie)
check("退出后旧会话失效", status == 200 and status_after == 401, f"{status}/{status_after}")

failed = [name for name, ok, _ in CHECKS if not ok]
print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
sys.exit(1 if failed else 0)
