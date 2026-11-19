"""拾念 SHINIAN · 「问我的记录」真实模型质量样例（合成数据，人工核对用）。

前置：
- 目标服务使用隔离数据库，并已复制主库的可用 ai_settings 与对应 master key；
- 默认地址 http://127.0.0.1:3205，可用 SHINIAN_LIVE_ASK_BASE 覆盖。

本脚本追加两组对照数据：
1. 同频不同供电/环境：用于「两次调光实验为什么不同」；
2. 后续复用旧观察：用于「这条经验后来在哪次尝试中用过」。
每组都只把用户明确选择的真实来源发给模型，输出到 output/live-ask-quality.json，
不会发送未选记录，也不会写回任何业务记录。
"""
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Client

BASE = os.environ.get("SHINIAN_LIVE_ASK_BASE", "http://127.0.0.1:3205").rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "output", "live-ask-quality.json")
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
UID = uuid.uuid4().hex[:8]
client = Client(base=BASE)


def must(status, body, label):
    if status not in (200, 201, 202):
        raise RuntimeError(f"{label} failed: {status} {body}")
    return body


def wait_query(query_id, timeout=120):
    deadline = time.time() + timeout
    query = None
    while time.time() < deadline:
        status, body = client.get(f"/api/ask/queries/{query_id}")
        must(status, body, "get query")
        query = body["query"]
        if query["status"] in TERMINAL:
            return query
        time.sleep(1.5)
    return query


def run_query(label, question, keywords, source_keys):
    status, preview = client.post(
        "/api/ask/preview",
        {"question": question, "keywords": keywords, "sourceKeys": source_keys},
    )
    preview = must(status, preview, "preview")
    if not preview["ai"]["configured"] or not preview["ai"]["enabled"]:
        raise RuntimeError("目标服务没有可用的真实模型配置")
    status, created = client.post(
        "/api/ask/queries",
        {
            "question": question,
            "keywords": keywords,
            "sourceKeys": source_keys,
            "contextToken": preview["contextToken"],
            "operationId": f"live-quality-{label}-{UID}",
        },
    )
    created = must(status, created, "create query")
    query = wait_query(created["query"]["id"])
    if query["status"] != "succeeded":
        raise RuntimeError(
            f"{label} 未成功：{query['status']} {query.get('errorCode')} {query.get('errorMessage')}"
        )
    sent = set(source_keys)
    for point in query["answer"]["points"]:
        for source_id in point["sourceIds"]:
            if source_id not in sent:
                raise RuntimeError(f"{label} 出现未发送来源：{source_id}")
    for contradiction in query["answer"]["contradictions"]:
        for side in contradiction["sides"]:
            if side["sourceId"] not in sent:
                raise RuntimeError(f"{label} 矛盾侧出现未发送来源：{side['sourceId']}")
    return {
        "label": label,
        "question": question,
        "keywords": keywords,
        "sentSourceKeys": source_keys,
        "previewChars": preview["coverage"]["selectedChars"],
        "model": preview["config"],
        "query": query,
    }


def find_attempt(result_fragment):
    status, body = client.get("/api/captures")
    must(status, body, "list captures")
    for capture in body.get("captures", []):
        status, attempts = client.get(f"/api/captures/{capture['id']}/attempts")
        must(status, attempts, "list attempts")
        for attempt in attempts.get("attempts", []):
            if result_fragment in (attempt.get("resultText") or ""):
                return capture, attempt
    raise RuntimeError(f"未找到基础样例：{result_fragment}")


def main():
    # 先登录；这是隔离库，账号只用于本轮合成样例。
    client.login(f"问答真实质量 {UID}")

    base_capture, base_attempt = find_attempt("2 kHz、20% 占空比")

    # 场景 2：同频、不同供电 + 同时改变环境。记录本身无法拆分供电/环境的影响。
    cap2 = must(
        *client.post(
            "/api/captures",
            {"rawText": "调光复测记录：同一频率换供电后再观察"},
        ),
        "create contradiction capture",
    )["capture"]
    att2 = must(
        *client.post(
            f"/api/captures/{cap2['id']}/attempts",
            {
                "step": "2 kHz、20% 占空比，改用 3.7V 锂电池并把桌面从窗边移到室内",
                "state": "done",
                "resultText": "同频下仍有轻微闪烁；这次同时换了供电和桌面位置，无法判断是哪一项造成差异。",
                "outcome": "undetermined",
                "operationId": f"live-quality-b1-{UID}",
            },
        ),
        "create contradiction attempt",
    )["attempt"]
    must(
        *client.post(
            f"/api/attempts/{att2['id']}/references",
            {
                "toId": base_attempt["id"],
                "note": "沿用 2 kHz 与 20% 占空比，只改变供电和观察位置",
                "operationId": f"live-quality-ref-b-{UID}",
            },
        ),
        "create contradiction reference",
    )

    # 场景 3：后续一次真实应用旧观察的尝试。
    cap3 = must(
        *client.post(
            "/api/captures",
            {"rawText": "把调光频率经验用到台灯上"},
        ),
        "create reuse capture",
    )["capture"]
    att3 = must(
        *client.post(
            f"/api/captures/{cap3['id']}/attempts",
            {
                "step": "按 2 kHz、20% 占空比设置台灯调光",
                "state": "done",
                "resultText": "连续两晚使用未见肉眼闪烁；只观察了短时效果，尚未做相机验证。",
                "outcome": "success",
                "operationId": f"live-quality-c1-{UID}",
            },
        ),
        "create reuse attempt",
    )["attempt"]
    must(
        *client.post(
            f"/api/attempts/{att3['id']}/references",
            {
                "toId": base_attempt["id"],
                "note": "沿用 2 kHz、20% 占空比这条旧观察",
                "operationId": f"live-quality-ref-c-{UID}",
            },
        ),
        "create reuse reference",
    )

    results = []
    results.append(
        run_query(
            "contradiction",
            "两次调光实验的结果为什么不同？请把各自条件写清楚。",
            "2 kHz 供电 闪烁",
            [f"attempt:{base_attempt['id']}", f"attempt:{att2['id']}"],
        )
    )
    results.append(
        run_query(
            "reuse",
            "这条经验后来在哪次尝试中用过？",
            "2 kHz 调光",
            [f"attempt:{base_attempt['id']}", f"attempt:{att3['id']}"],
        )
    )

    payload = {
        "baseAttempt": f"attempt:{base_attempt['id']}",
        "contradictionAttempt": f"attempt:{att2['id']}",
        "reuseAttempt": f"attempt:{att3['id']}",
        "results": results,
        "generatedAt": int(time.time() * 1000),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    for result in results:
        print("=" * 72)
        print(result["label"], result["question"])
        print("模型：", result["model"])
        answer = result["query"]["answer"]
        print("摘要：", answer["summary"])
        for point in answer["points"]:
            print(f"- [{point['basis']}] {point['text']}")
            if point.get("condition"):
                print(f"  条件：{point['condition']}")
            print(f"  来源：{', '.join(point['sourceIds'])}")
        for contradiction in answer["contradictions"]:
            print(f"- [矛盾] {contradiction['text']}")
            for side in contradiction["sides"]:
                print(f"  {side['sourceId']} 条件：{side['condition']}")
        print("不足：", answer["missing"])
        print("证据不足：", answer["insufficientEvidence"])
        print("来源：", [(s["sourceKey"], s["exists"], s["openHref"]) for s in result["query"]["sources"]])
    print(f"\n已写入 {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {exc}")
        sys.exit(1)
