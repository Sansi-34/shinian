"""真实 GitHub + 真实模型的研究联调（只读公开仓库，使用已配置的模型）。

运行前提：
  1. 服务已启动，且未设置 SHINIAN_GITHUB_API_BASE（走官方 https://api.github.com）。
  2. db 中已配置可用模型；没有配置时脚本会在预览阶段明确退出。
  3. 建议在数据库副本上运行，避免把联调记录写进日常库。

用法：
  $env:SHINIAN_BASE="http://127.0.0.1:3200"
  python scripts/live_research_check.py
"""
import json
import os
import sys
import time
import uuid

from common import Client

BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3200").rstrip("/")
QUESTION = "在 ESP32-S3 上实现离线唤醒词“小念”，有哪些开源项目可以直接参考？优先 C/C++、可离线、许可证清晰。"
CONSTRAINTS = {
    "goal": "用麦克风采集，离线识别“小念”唤醒词并触发后续动作",
    "environment": "ESP32-S3-DevKitC、MAX9814 麦克风、Windows + PlatformIO/Arduino",
    "language": "C/C++ 优先",
    "timeBudget": "两周内完成一个可复现的小实验",
    "requirements": "离线运行、许可证清晰、有可运行示例；不接受必须联网的云服务",
}


def fail(msg, body=None):
    print(f"FAIL  {msg}")
    if body is not None:
        print(json.dumps(body, ensure_ascii=False, indent=2)[:4000])
    sys.exit(1)


def wait_for(client, research_id, statuses, timeout=240):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, body = client.get(f"/api/research/{research_id}")
        if status != 200:
            fail(f"读取研究失败 HTTP {status}", body)
        last = body["research"]
        print(f"  · {last['status']} · 候选 {len(last.get('candidates') or [])} · 来源 {len(last.get('sources') or [])}")
        if last["status"] in statuses:
            return last
        time.sleep(1.0)
    fail(f"等待 {timeout}s 未进入 {statuses}，最后状态 {last and last['status']}", last)


def main():
    client = Client(BASE)
    client.login(f"研究真实联调-{uuid.uuid4().hex[:8]}")

    status, body = client.get("/api/settings/ai")
    if status != 200:
        fail(f"读取 AI 设置失败 HTTP {status}", body)
    if not body.get("configured") or not (body.get("config") or {}).get("enabled"):
        print("SKIP  未配置可用模型。GitHub 读取与资料展示仍可验证，真实模型生成待完成。")
        return 2

    status, cap = client.post(
        "/api/captures",
        {"rawText": "想在 ESP32-S3 上做一个离线唤醒词“小念”，用 MAX9814 麦克风采集，两周内先跑通一个最小示例。"},
    )
    if status != 200:
        fail(f"保存念头失败 HTTP {status}", cap)
    capture = cap["capture"]
    print(f"念头 {capture['id']} revision={capture['revision']}")

    preview_payload = {
        "captureRevision": capture["revision"],
        "question": QUESTION,
        "constraints": CONSTRAINTS,
        "search": {"mode": "keyword", "query": "esp32 offline wake word keyword spotting"},
    }
    status, preview = client.post(f"/api/captures/{capture['id']}/research/preview", preview_payload)
    if status != 200:
        fail(f"研究预览失败 HTTP {status}", preview)
    print(f"检索：{preview['searchDisplay']}")
    print(f"预计 GitHub 请求 {preview['estimatedGithubRequests']} 次，模型调用 {preview['modelCalls']} 次")
    print(f"模型：{preview['ai']['config']['name']} / {preview['ai']['config']['modelId']}")

    status, started = client.post(
        f"/api/captures/{capture['id']}/research",
        {
            "captureRevision": preview["capture"]["revision"],
            "question": preview["question"],
            "constraints": preview["constraints"],
            "search": preview["search"],
            "contextToken": preview["contextToken"],
            "operationId": f"op-live-{uuid.uuid4().hex}",
        },
    )
    if status not in (200, 202):
        fail(f"发起研究失败 HTTP {status}", started)
    research = started["research"]
    print(f"研究 {research['id']} 状态 {research['status']}")

    research = wait_for(client, research["id"], {"candidates", "failed"}, timeout=90)
    if research["status"] == "failed":
        fail(f"检索失败 {research.get('errorCode')}", research)
    candidates = [c for c in research["candidates"] if not c["archived"]]
    if not candidates:
        fail("没有可用候选", research)
    print("\n候选：")
    for c in research["candidates"]:
        print(f"  - {c['fullName']} · {c['language'] or '未知'} · ★{c['stars']} · 归档={c['archived']} · {(c['description'] or '')[:70]}")
    chosen = [c["id"] for c in candidates[:2]]
    status, selected = client.post(f"/api/research/{research['id']}/select", {"candidateIds": chosen})
    if status not in (200, 202):
        fail(f"选择候选失败 HTTP {status}", selected)
    print(f"\n深入读取：{[c['fullName'] for c in candidates[:2]]}")

    research = wait_for(client, research["id"], {"succeeded", "failed"}, timeout=300)
    if research["status"] == "failed":
        fail(f"研究失败 {research.get('errorCode')} {research.get('errorDetail')}", research)

    result = research["result"]
    print("\n=== 模型对比 ===")
    print(result["summary"])
    for project in result["projects"]:
        print(f"\n[{project['repo']}] {project['summary']}")
        print(f"  许可证：{project['licenseNote']}")
        for item in project["matches"]:
            print(f"  匹配：{item['text']}  ← {', '.join(item['sourceIds'])}")
        for item in project["gaps"]:
            print(f"  缺口：{item['text']}  ← {', '.join(item['sourceIds'])}")
        for unknown in project["unknowns"]:
            print(f"  未核实：{unknown}")
    print("\n小实验：")
    for i, exp in enumerate(result["experiments"]):
        print(f"  [{i}] {exp['title']} · {exp['estimatedMinutes']} 分钟 · {exp['repo']} · {exp['verifies']}")
        print(f"      {exp['description']}")

    print("\n=== 资料与用量 ===")
    for source in research["sources"]:
        print(f"  · {source['repoFullName']} / {source['kind']} / {source['status']} / {source['url']} / {source['excerpt'][:60]!r}")
    print(f"GitHub 请求：{research['stats']['github']}")
    print(f"模型用量：{research['usage']}，耗时 {research['durationMs']} ms，prompt {research['stats']['promptChars']} 字符")
    print(f"错误/失败项：candidateFailures={research['candidateFailures']} failed={research['failed']}")

    status, saved = client.post(f"/api/research/{research['id']}/save", {})
    if status != 200:
        fail(f"保存研究失败 HTTP {status}", saved)
    print(f"已保存 savedAt={saved['savedAt']}")

    status, accepted = client.post(
        f"/api/research/{research['id']}/experiments/0/accept",
        {
            "title": f"实机跑通：{result['experiments'][0]['title']}"[:120],
            "description": "按仓库 README 的最小示例编译烧录到 ESP32-S3，记录安装依赖耗时、首次报错与能否识别“小念”。",
            "estimatedMinutes": 30,
            "expectedRevision": research["revision"],
            "operationId": f"op-live-accept-{uuid.uuid4().hex}",
        },
    )
    if status not in (200, 201):
        fail(f"采用实验失败 HTTP {status}", accepted)
    print(f"已创建尝试 {accepted['attempt']['id']}，origin={accepted['attempt']['origin']}")

    out = {
        "captureId": capture["id"],
        "researchId": research["id"],
        "attemptId": accepted["attempt"]["id"],
        "result": result,
        "sources": research["sources"],
        "usage": research["usage"],
        "stats": research["stats"],
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "output", f"live-research-{int(time.time())}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f"\n结果已写入 {os.path.abspath(out_path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
