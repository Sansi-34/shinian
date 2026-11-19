"""拾念 SHINIAN · 「问我的记录」真实模型人工核对脚本

前置：目标服务使用隔离数据库并已复制主库的 ai_settings（含可用真实模型），
fake_model_server 不需要启动。默认地址 http://127.0.0.1:3202。

脚本创建一组隔离记录（500 Hz 失败 / 2 kHz 成功 / 真实引用），
检索、预览、生成，并把回答与来源写入 output/live-ask-result.json 供人工核对。

核对重点：
- 是否保留 500 Hz / 20% 占空比等失败条件；
- 是否把「几乎看不到」夸大为「完全没有」；
- 是否把模型推断写成用户实际观察；
- 所有来源 ID 是否属于本次发送记录。
"""
import json
import os
import sys
import time
import urllib.parse
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Client

BASE = os.environ.get("SHINIAN_LIVE_ASK_BASE", "http://127.0.0.1:3202").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "output", "live-ask-result.json")
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}

client = Client(base=BASE)
uid = uuid.uuid4().hex[:6]


def must(status, body, label):
    if status not in (200, 201, 202):
        raise RuntimeError(f"{label} failed: {status} {body}")
    return body


def main():
    client.login(f"问答真实核对 {uid}")
    cap1 = must(*client.post("/api/captures", {"rawText": "PWM 调光：低占空比时 LED 会闪"}), "create capture 1")["capture"]
    att1 = must(
        *client.post(
            f"/api/captures/{cap1['id']}/attempts",
            {
                "step": "500 Hz PWM，20% 占空比，室温 25°C 调光",
                "state": "done",
                "resultText": "500 Hz、20% 占空比时肉眼可见闪烁；把占空比降到 5% 后闪烁更明显。",
                "outcome": "failure",
                "operationId": f"live-ask-a1-{uid}",
            },
        ),
        "create attempt 1",
    )["attempt"]
    cap2 = must(*client.post("/api/captures", {"rawText": "PWM 调光想避免肉眼可见闪烁"}), "create capture 2")["capture"]
    att2 = must(
        *client.post(
            f"/api/captures/{cap2['id']}/attempts",
            {
                "step": "2 kHz PWM，20% 占空比",
                "state": "done",
                "resultText": "2 kHz、20% 占空比时肉眼几乎看不到闪烁；连续观察 10 分钟仍有轻微频闪感，未用相机验证。",
                "outcome": "success",
                "operationId": f"live-ask-a2-{uid}",
            },
        ),
        "create attempt 2",
    )["attempt"]
    must(
        *client.post(
            f"/api/attempts/{att2['id']}/references",
            {
                "toId": att1["id"],
                "note": "沿用 500 Hz 的观察，只把频率改到 2 kHz，占空比保持 20%。",
                "operationId": f"live-ask-ref-{uid}",
            },
        ),
        "create reference",
    )

    question = "我以前试过哪些 PWM 调光办法？哪次失败了，当时条件是什么？两次得出的结论有什么不同？"
    status, search = client.get(
        "/api/ask/candidates?"
        + urllib.parse.urlencode(
            {"question": question, "keywords": "PWM 调光 闪烁"},
            quote_via=urllib.parse.quote,
        )
    )
    must(status, search, "search")
    keys = [f"attempt:{att1['id']}", f"attempt:{att2['id']}"]
    status, preview = client.post(
        "/api/ask/preview",
        {"question": question, "keywords": "PWM 调光 闪烁", "sourceKeys": keys},
    )
    must(status, preview, "preview")
    if not preview["ai"]["configured"] or not preview["ai"]["enabled"]:
        raise RuntimeError("目标服务没有可用的真实模型配置")
    status, created = client.post(
        "/api/ask/queries",
        {
            "question": question,
            "keywords": "PWM 调光 闪烁",
            "sourceKeys": keys,
            "contextToken": preview["contextToken"],
            "operationId": f"live-ask-query-{uid}",
        },
    )
    body = must(status, created, "create query")
    query_id = body["query"]["id"]
    deadline = time.time() + 90
    query = body["query"]
    while time.time() < deadline:
        status, data = client.get(f"/api/ask/queries/{query_id}")
        must(status, data, "get query")
        query = data["query"]
        if query["status"] in TERMINAL:
            break
        time.sleep(1.5)
    if query["status"] != "succeeded":
        print(f"FAIL 真实模型问答未成功：{query['status']} {query.get('errorCode')} {query.get('errorMessage')}")
        print(json.dumps(query, ensure_ascii=False, indent=2))
        return 1

    payload = {
        "question": question,
        "sentSourceKeys": keys,
        "previewChars": preview["coverage"]["selectedChars"],
        "model": preview["config"],
        "query": query,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    answer = query["answer"]
    print("=" * 70)
    print("真实模型回答：")
    print(answer["summary"])
    for point in answer["points"]:
        print(f"- [{point['basis']}] {point['text']}")
        if point.get("condition"):
            print(f"  条件：{point['condition']}")
        print(f"  来源：{', '.join(point['sourceIds'])}")
    for item in answer["contradictions"]:
        print(f"- [矛盾] {item['text']}")
        for side in item["sides"]:
            print(f"  {side['sourceId']} 条件：{side['condition']}")
    print("missing:", answer["missing"])
    print("insufficient:", answer["insufficientEvidence"])
    print("来源：")
    for source in query["sources"]:
        print(f"- {source['sourceKey']} 存在={source['exists']} 可打开={source['openHref']}")
    print(f"已写入 {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {exc}")
        sys.exit(1)
