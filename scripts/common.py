"""拾念 SHINIAN v0.1 - API 测试公共工具（标准库实现，无第三方依赖）"""
import json
import urllib.request
import urllib.error
import urllib.parse
import http.cookiejar
import os

BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3000")


class Client:
    """带 cookie 的简单 HTTP 客户端，模拟一个浏览器会话"""

    def __init__(self, base=BASE):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def request(self, method, path, data=None):
        url = self.base + urllib.parse.quote(path, safe="/?=&%")
        body = None
        headers = {"Accept": "application/json"}
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=20) as res:
                raw = res.read().decode("utf-8")
                return res.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = raw
            return e.code, payload

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, data):
        return self.request("POST", path, data)

    def patch(self, path, data):
        return self.request("PATCH", path, data)

    def delete(self, path):
        return self.request("DELETE", path)

    def login(self, username="测试用户"):
        status, body = self.post("/api/session/create", {"username": username})
        assert status == 200, (status, body)
        return body


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []

    def check(self, name, cond, detail=""):
        if cond:
            self.passed += 1
            print(f"PASS  {name}")
        else:
            self.failed += 1
            self.failures.append((name, detail))
            print(f"FAIL  {name}  {detail}")

    def report(self, title):
        print("\n" + "=" * 60)
        print(f"{title}: {self.passed} passed, {self.failed} failed")
        if self.failures:
            print("Failures:")
            for name, detail in self.failures:
                print(f"  - {name}: {detail}")
        print("=" * 60)
        return self.failed == 0
