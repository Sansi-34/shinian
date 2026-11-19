"""拾念 SHINIAN · 本地假模型服务（仅测试用）

标准库实现，监听 127.0.0.1:3501：
- POST /v1/chat/completions  按请求 JSON 的 model 字段返回不同场景
- GET  /__health             健康检查
- GET  /__last               读取最后一次请求（method/path/headers/body）

约定见 docs/ai-api-contract.md §9。不得打印请求正文或任何密钥。
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENARIOS_PATH = os.path.join(ROOT, "scripts", "ai_scenarios.json")
SERVICE = "shinian-fake-model"

_lock = threading.Lock()
_last_request = None
_suggest_request_count = 0
# 用于区分多个假模型进程写同一个落盘文件；测试不能假设 count 跨进程连续。
_SERVER_ID = f"fake-{os.getpid()}-{time.time_ns()}"
SUGGEST_LAST_PATH = os.path.join(ROOT, "output", "fake-suggest-last.json")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _suggestion_executable() -> dict:
    return {
        "kind": "executable",
        "step": "把 PWM 频率从 500 Hz 改到 2 kHz，观察同一颗 LED 是否还闪。",
        "why": "只改一个参数，能直接验证你记下的闪烁条件。",
        "estimatedMinutes": 5,
        "question": None,
        "sources": [],
    }


def _suggestion_defer() -> dict:
    return {
        "kind": "defer",
        "step": None,
        "why": "你提到现在时间或精力有限，先记着就好，不必勉强开始。",
        "estimatedMinutes": None,
        "question": None,
        "sources": [],
    }


def _suggestion_clarify() -> dict:
    return {
        "kind": "clarify",
        "step": None,
        "why": "还差一个关键信息，才能给出具体、低负担的一步。",
        "estimatedMinutes": None,
        "question": "你更想先从哪个具体场景或目标开始？",
        "sources": [],
    }


def _scenario_suggestion(scenario: dict) -> dict:
    kind = scenario.get("expectedKind")
    text = str(scenario.get("text") or "").strip()
    short = text[:18]
    if kind == "executable":
        return {
            "kind": "executable",
            "step": f"先为「{short}」做一个 10 分钟的最小尝试，只完成第一步。",
            "why": "从最小的一步开始，能立刻知道这件事是否值得继续。",
            "estimatedMinutes": 10,
            "question": None,
            "sources": [],
        }
    if kind == "defer":
        return {
            "kind": "defer",
            "step": None,
            "why": "你现在的时间或状态不适合行动，先把念头留在这里。",
            "estimatedMinutes": None,
            "question": None,
            "sources": [],
        }
    return {
        "kind": "clarify",
        "step": None,
        "why": "信息还不够，先确认一个关键点再动手。",
        "estimatedMinutes": None,
        "question": f"关于「{short}」，你更想先达成哪个具体小目标？",
        "sources": [],
    }


def _source_ids(body: dict) -> list:
    """从 user prompt 中解析服务端列出的来源 ID，保序去重。"""
    text = _user_text(body)
    ids = re.findall(r"\[(att-[A-Za-z0-9._:-]+)\]", text)
    if not ids:
        ids = re.findall(r"\b(att-[A-Za-z0-9._:-]+)\b", text)
    return list(dict.fromkeys(ids))


def _experience_suggestion(model: str, body: dict) -> dict:
    ids = _source_ids(body)
    if model == "fake-experience-bad-source":
        return {
            "kind": "executable",
            "step": "先按一条旧结果复现最小条件，观察当前念头是否仍然出现。",
            "why": "旧结果提示过这个方向，先做一次最小验证。",
            "estimatedMinutes": 5,
            "question": None,
            "sources": [
                {
                    "attemptId": "att-not-selected-by-model",
                    "note": "模型编造了一条本次未选择的来源。",
                }
            ],
        }
    if model == "fake-experience-insufficient":
        chosen = [] if len(ids) <= 1 else ids[:1]
        return {
            "kind": "clarify",
            "step": None,
            "why": "旧结果只提供了部分线索，还需要确认一个关键条件。",
            "estimatedMinutes": None,
            "question": "你更想先复用旧结果里的哪个条件来试？",
            "sources": [
                {"attemptId": sid, "note": "这条旧结果只覆盖了部分条件。"}
                for sid in chosen
            ],
        }
    if model == "fake-experience-contradict":
        chosen = ids[:2]
        if len(chosen) >= 2:
            why = (
                "两条旧结果的结论互相矛盾，"
                "先用一次小对照确认哪条更接近当前情况。"
            )
        else:
            why = "旧结果与当前情况可能不一致，先做一次最小对照验证。"
        return {
            "kind": "executable",
            "step": "按两条旧结果分别复现一次最小条件，对照观察差异。",
            "why": why,
            "estimatedMinutes": 10,
            "question": None,
            "sources": [
                {"attemptId": sid, "note": "这条旧结果与另一条存在矛盾，作为对照。"}
                for sid in chosen
            ],
        }
    chosen = ids[:3] if model == "fake-experience-3" else ids[:1]
    if chosen:
        first = chosen[0]
        step = "先复用旧结果里的最小条件，只改一个变量再观察。"
        why = "旧结果提供了可对照的观察，这次先做一次最小验证。"
        if len(chosen) > 1:
            why = f"结合 {len(chosen)} 条旧结果，先复用最接近当前情况的一条做最小验证。"
    else:
        step = "先做一次 5 分钟的最小尝试，记录当前观察。"
        why = "还没有可用的旧结果，先建立一个最小基线。"
    return {
        "kind": "executable",
        "step": step,
        "why": why,
        "estimatedMinutes": 5,
        "question": None,
        "sources": [
            {"attemptId": sid, "note": "这条旧结果与当前念头相关，可作为对照。"}
            for sid in chosen
        ],
    }


REVIEW_KEY_RE = re.compile(r"\[((?:capture|attempt|reference):[A-Za-z0-9._:-]+)\]")


def _review_keys(body: dict) -> list:
    """从 user prompt 解析 [capture:/attempt:/reference:...] 稳定键，保序去重。"""
    text = _user_text(body)
    return list(dict.fromkeys(REVIEW_KEY_RE.findall(text)))


def _review_content(model: str, body: dict) -> dict:
    keys = _review_keys(body)
    attempt_keys = [k for k in keys if k.startswith("attempt:")]
    capture_keys = [k for k in keys if k.startswith("capture:")]
    if model == "fake-review-insufficient" or not keys:
        return {
            "overview": "这段时间可用的记录太少，无法形成可靠的阶段回顾。",
            "attempts": [],
            "observations": [],
            "connections": [],
            "experiences": [],
            "uncertainties": ["记录不足，无法判断这段时间的尝试与结果之间是否存在稳定联系。"],
            "insufficientData": True,
            "dataNotes": None,
        }
    primary = attempt_keys[0] if attempt_keys else keys[0]
    observation_key = attempt_keys[0] if attempt_keys else (capture_keys[0] if capture_keys else keys[0])
    attempts = [
        {
            "text": (
                "你记录并实际进行了一次尝试，步骤与结果都来自这条记录。"
                if attempt_keys
                else "你记录了一个念头，它是本次回顾中可用的事实。"
            ),
            "basis": "observation",
            "sourceIds": [primary],
        }
    ]
    observations = [
        {
            "text": (
                "记录中写下了这次尝试的结果与当时的评价。"
                if attempt_keys
                else "记录中写下了这个念头的内容与创建时间。"
            ),
            "basis": "observation",
            "sourceIds": [observation_key],
        }
    ]
    connections = [
        {
            "text": "这条结果可能提示当前做法与观察到的现象之间存在关联，但仍需更多记录验证。",
            "basis": "inference",
            "sourceIds": [observation_key],
        }
    ]
    experiences = [
        {
            "text": "下次可以只改变一个条件，再记录一次结果，便于对照。",
            "basis": "inference",
            "sourceIds": [primary],
        }
    ]
    if model == "fake-review-bad-source":
        connections.append(
            {
                "text": "这条关联引用了本次未发送的记录。",
                "basis": "inference",
                "sourceIds": ["attempt:att-not-selected"],
            }
        )
    return {
        "overview": "这段时间你记录了自己的念头与尝试；下面只根据本次发送的记录做简短回顾。",
        "attempts": attempts,
        "observations": observations,
        "connections": connections,
        "experiences": experiences,
        "uncertainties": ["目前只有少量记录，不能说明长期效果或能力变化。"],
        "insufficientData": False,
        "dataNotes": None,
    }


ASK_PROMPT_MARKER = "用户的问题："
ASK_KEY_RE = re.compile(r"\[((?:attempt|capture):[A-Za-z0-9._:-]+)\]")
ASK_RECORD_HEADER_RE = re.compile(r"^\[((?:attempt|capture):[A-Za-z0-9._:-]+)\]\s*(尝试|念头)｜(.*)$")
ASK_CONDITION_RE = re.compile(r"(?<![A-Za-z0-9.])(\d+(?:\.\d+)?\s*(?:kHz|KHz|Hz|MHz|GHz|ms|分钟|小时|%|％))")


def _ask_keys(body: dict) -> list:
    """从问答 user prompt 解析 [attempt:/capture:] 稳定键，保序去重。"""
    return list(dict.fromkeys(ASK_KEY_RE.findall(_user_text(body))))


def _ask_records(body: dict) -> list:
    """解析 prompt 中服务端列出的记录块（忽略末尾引用关系行）。"""
    records = []
    current = None
    for raw_line in _user_text(body).splitlines():
        line = raw_line.strip()
        if line.startswith("明确引用关系"):
            current = None
            continue
        header = ASK_RECORD_HEADER_RE.match(line)
        if header:
            current = {
                "key": header.group(1),
                "type": "attempt" if header.group(2) == "尝试" else "capture",
                "header": header.group(3),
                "step": "",
                "result": "",
                "capture": "",
                "text": "",
            }
            records.append(current)
            continue
        if current is None:
            continue
        if line.startswith("步骤："):
            current["step"] = line[len("步骤："):].strip()
        elif line.startswith("结果："):
            current["result"] = line[len("结果："):].strip()
        elif line.startswith("所属念头："):
            current["capture"] = line[len("所属念头："):].strip()
        elif line.startswith("正文："):
            current["text"] = line[len("正文："):].strip()
    for record in records:
        if record["result"] == "（没有记录结果）":
            record["result"] = ""
    return records


def _ask_condition(record: dict) -> str:
    """从记录原文提取最具体的条件；提取不到时如实写记录中的步骤。"""
    text = f"{record.get('step') or ''} {record.get('result') or ''} {record.get('text') or ''}"
    found = list(dict.fromkeys(match.group(1).strip() for match in ASK_CONDITION_RE.finditer(text)))
    if found:
        return "记录中写到的条件：" + "、".join(found[:4])
    step = (record.get("step") or record.get("header") or "").strip()
    if step:
        return "记录中的步骤：" + step[:120]
    return "记录未写条件"


def _ask_primary_record(records: list):
    """优先第一条写下结果的 attempt；否则第一条 capture；再否则第一条记录。"""
    for record in records:
        if record["type"] == "attempt" and record["result"]:
            return record
    for record in records:
        if record["type"] == "capture" and (record["text"] or record["capture"]):
            return record
    return records[0] if records else None


def _ask_content(model: str, body: dict) -> str:
    records = _ask_records(body)
    keys = [record["key"] for record in records] or _ask_keys(body)
    if model == "fake-ask-invalid-json":
        return "这不是 JSON，也没有问答字段，只是一段普通说明文字。"
    if model == "fake-ask-insufficient" or not records:
        return json.dumps(
            {
                "summary": "现有记录不足以回答这个问题。",
                "points": [],
                "contradictions": [],
                "missing": [
                    "缺少记录下实际结果的内容，无法确认做法是否有效。",
                    "缺少当时的条件（频率、时长、环境或具体做法）。",
                    "缺少后续对照或重复记录，无法判断结果是否稳定。",
                ],
                "insufficientEvidence": True,
            },
            ensure_ascii=False,
        )
    if model == "fake-ask-bad-source":
        return json.dumps(
            {
                "summary": "这条回答引用了本次未发送的记录。",
                "points": [
                    {
                        "text": "记录里写下了与问题相关的一次尝试结果。",
                        "basis": "observation",
                        "condition": "记录未写条件",
                        "sourceIds": ["attempt:att-not-sent"],
                    }
                ],
                "contradictions": [],
                "missing": [],
                "insufficientEvidence": False,
            },
            ensure_ascii=False,
        )
    attempts = [record for record in records if record["type"] == "attempt"]
    if model in {"fake-ask-contradiction", "fake-ask-contradict"}:
        if len(attempts) >= 2:
            first, second = attempts[0], attempts[1]
            first_text = first["result"] or first["step"] or "记录了这次尝试"
            second_text = second["result"] or second["step"] or "记录了这次尝试"
            return json.dumps(
                {
                    "summary": "两条记录对同类做法的结果不一致，需要再做一次对照确认。",
                    "points": [],
                    "contradictions": [
                        {
                            "text": (
                                f"一条记录写下「{first_text[:80]}」，"
                                f"另一条写下「{second_text[:80]}」，两者结论不一致。"
                            ),
                            "sides": [
                                {"sourceId": first["key"], "condition": _ask_condition(first)},
                                {"sourceId": second["key"], "condition": _ask_condition(second)},
                            ],
                        }
                    ],
                    "missing": [],
                    "insufficientEvidence": False,
                },
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "summary": "可用于对照的尝试不足两条，无法比较结论。",
                "points": [],
                "contradictions": [],
                "missing": ["缺少两条针对同类做法的尝试记录，无法形成矛盾对照。"],
                "insufficientEvidence": True,
            },
            ensure_ascii=False,
        )

    primary = _ask_primary_record(records)
    question = ""
    for line in _user_text(body).splitlines():
        if line.strip().startswith(ASK_PROMPT_MARKER):
            question = line.strip()[len(ASK_PROMPT_MARKER):].strip()
            break
    if primary is None:
        observation = "记录列表里没有可读内容。"
        condition = "记录未写条件"
        source_id = keys[0]
    elif primary["type"] == "attempt":
        result = primary["result"]
        step = primary["step"]
        if result:
            observation = f"记录中写下的结果是：{result[:180]}"
        else:
            observation = f"记录中写下的步骤是：{step[:180] or '（空）'}，没有写下结果。"
        condition = _ask_condition(primary)
        source_id = primary["key"]
    else:
        body_text = primary["text"] or primary["capture"] or primary["header"]
        observation = f"记录中写下的念头正文是：{body_text[:180]}"
        condition = "记录未写条件（只有念头正文）"
        source_id = primary["key"]
    if question:
        summary = f"关于「{question[:60]}」，{observation[:120]}"
    else:
        summary = observation[:160]
    return json.dumps(
        {
            "summary": summary,
            "points": [
                {
                    "text": observation,
                    "basis": "observation",
                    "condition": condition,
                    "sourceIds": [source_id],
                },
                {
                    "text": "这条结果可能提示该做法与观察到的现象有关，但记录本身不足以说明原因或长期效果。",
                    "basis": "inference",
                    "condition": None,
                    "sourceIds": [source_id],
                },
            ],
            "contradictions": [],
            "missing": [],
            "insufficientEvidence": False,
        },
        ensure_ascii=False,
    )


def _research_map(body: dict) -> dict:
    """从研究 prompt 解析「仓库 → 来源 ID 列表」。"""
    text = _user_text(body)
    result = {}
    current = None
    for line in text.splitlines():
        header = re.match(r"=== 仓库：([^ ]+) ===", line.strip())
        if header:
            current = header.group(1)
            result.setdefault(current, [])
            continue
        if current:
            for sid in re.findall(r"\[(src-\d+)\]", line):
                if sid not in result[current]:
                    result[current].append(sid)
    return result


def _research_content(model: str, body: dict) -> dict:
    repo_map = _research_map(body)
    if model == "fake-research-insufficient" or not repo_map:
        return {
            "summary": "暂时无法判断：可用资料不足，无法可靠比较这些仓库。",
            "projects": [],
            "experiments": [],
            "insufficient": True,
            "limitations": ["候选资料不足，无法核实硬件兼容性与运行效果。"],
        }
    projects = []
    experiments = []
    for index, (repo, ids) in enumerate(repo_map.items()):
        if not ids:
            continue
        primary = ids[0]
        secondary = ids[1] if len(ids) > 1 else ids[0]
        projects.append(
            {
                "repo": repo,
                "summary": f"{repo} 提供了与研究问题相关的一个开源实现；具体能力只按本次资料判断。",
                "matches": [
                    {
                        "text": "仓库元数据或 README 提到了与研究问题相关的实现方向。",
                        "sourceIds": [primary],
                    }
                ],
                "gaps": [
                    {
                        "text": "资料没有明确说明在你的硬件环境下可直接运行。",
                        "sourceIds": [secondary],
                    }
                ],
                "unknowns": ["实际运行效果与资源占用尚未测试。"],
                "licenseNote": "许可证以 GitHub 检测结果为准；依赖许可证与具体使用方式仍需单独确认。",
            }
        )
        if index == 0:
            bad = "src-not-sent" if model == "fake-research-bad-source" else primary
            experiments.append(
                {
                    "title": f"用最小例子运行 {repo}",
                    "description": "先只跑仓库自带的最小示例，记录安装耗时、报错和能否启动。",
                    "estimatedMinutes": 25,
                    "repo": repo,
                    "sourceIds": [bad],
                    "verifies": "验证这个仓库在你的环境里能否完成一次最小运行。",
                }
            )
    return {
        "summary": "这些仓库提供了可比较的开源实现；下面只根据本次获取的资料做判断。",
        "projects": projects,
        "experiments": experiments[:3],
        "insufficient": False,
        "limitations": ["没有实际运行，硬件兼容性和性能仍未验证。"],
    }


def _keyword_suggestion_content(model: str, body: dict) -> str:
    if model == "fake-suggest-keywords-invalid-json":
        return "这不是 JSON，也没有 terms 字段。"
    if model == "fake-suggest-keywords-invalid-shape":
        return json.dumps({"terms": "不是数组"}, ensure_ascii=False)
    if model == "fake-suggest-keywords-empty":
        return json.dumps({"terms": []}, ensure_ascii=False)
    if model == "fake-suggest-keywords-five":
        return json.dumps({"terms": ["闪烁", "LED", "频闪", "调光", "频率"]}, ensure_ascii=False)
    if model == "fake-suggest-keywords-six":
        return json.dumps(
            {"terms": ["闪烁", "LED", "频闪", "调光", "频率", "占空比"]},
            ensure_ascii=False,
        )
    if model == "fake-suggest-keywords-empty-term":
        return json.dumps({"terms": [""]}, ensure_ascii=False)
    if model == "fake-suggest-keywords-overlong":
        return json.dumps({"terms": ["长" * 41]}, ensure_ascii=False)
    if model == "fake-suggest-keywords-total-overlong":
        return json.dumps({"terms": ["甲" * 40, "乙" * 40, "丙" * 40, "丁" * 10]}, ensure_ascii=False)
    return json.dumps({"terms": ["闪烁", "LED", "频闪"]}, ensure_ascii=False)


def _write_suggest_last(record: dict, model: str) -> None:
    global _suggest_request_count
    with _lock:
        _suggest_request_count += 1
        count = _suggest_request_count
    try:
        os.makedirs(os.path.dirname(SUGGEST_LAST_PATH), exist_ok=True)
        with open(SUGGEST_LAST_PATH, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "count": count,
                    "serverId": _SERVER_ID,
                    "model": model,
                    "receivedAt": record.get("receivedAt"),
                    "request": {
                        "method": record.get("method"),
                        "path": record.get("path"),
                        "body": record.get("body"),
                    },
                },
                fh,
                ensure_ascii=False,
            )
    except OSError:
        # 输出目录不可写不影响模型响应；测试可通过 /__last 读取最后一次请求。
        pass


def _content_for(model: str, body: dict) -> str:
    if model.startswith("fake-suggest-keywords"):
        return _keyword_suggestion_content(model, body)
    if model.startswith("fake-ask"):
        # 「问我的记录」请求靠 user prompt 里的「用户的问题：」识别；
        # 其余 prompt（例如从问答进入「用这条经验试一步」的念头原文）仍返回普通建议，
        # 便于浏览器端到端走完整闭环。带旧经验时补一条真实来源，满足 executable 语义校验。
        if ASK_PROMPT_MARKER in _user_text(body):
            return _ask_content(model, body)
        suggestion = _suggestion_executable()
        ids = _source_ids(body)
        if ids:
            suggestion["sources"] = [
                {"attemptId": ids[0], "note": "这条旧经验与当前念头相关，可作为对照。"}
            ]
        return json.dumps(suggestion, ensure_ascii=False)
    if model.startswith("fake-research"):
        if model == "fake-research-invalid":
            return "这不是 JSON，也没有研究字段。"
        return json.dumps(_research_content(model, body), ensure_ascii=False)
    if model in {"fake-review", "fake-review-insufficient", "fake-review-bad-source", "fake-review-timeout"}:
        return json.dumps(_review_content(model, body), ensure_ascii=False)
    if model == "fake-review-invalid-json":
        return "这是一段普通文本，不是 JSON，也没有回顾字段。"
    if model == "fake-success":
        return json.dumps(_suggestion_executable(), ensure_ascii=False)
    if model == "fake-defer":
        return json.dumps(_suggestion_defer(), ensure_ascii=False)
    if model == "fake-clarify":
        return json.dumps(_suggestion_clarify(), ensure_ascii=False)
    if model == "fake-invalid-json":
        return "抱歉，这里不是 JSON，只是一段普通说明文字。"
    if model == "fake-invalid-shape":
        # 合法 JSON，但 clarify 不应带 step / estimatedMinutes，语义校验必须失败
        return json.dumps(
            {
                "kind": "clarify",
                "step": "先做一步",
                "why": "想先确认方向。",
                "estimatedMinutes": 5,
                "question": None,
                "sources": [],
            },
            ensure_ascii=False,
        )
    if model in {
        "fake-experience",
        "fake-experience-3",
        "fake-experience-bad-source",
        "fake-experience-contradict",
        "fake-experience-insufficient",
    }:
        return json.dumps(_experience_suggestion(model, body), ensure_ascii=False)
    if model == "fake-scenario":
        scenarios = _load_scenarios()
        user_text = _user_text(body)
        matched = None
        for scenario in sorted(scenarios, key=lambda s: len(str(s.get("text") or "")), reverse=True):
            text = str(scenario.get("text") or "")
            if text and text in user_text:
                matched = scenario
                break
        if matched is None:
            return json.dumps(_suggestion_clarify(), ensure_ascii=False)
        return json.dumps(_scenario_suggestion(matched), ensure_ascii=False)
    # fake-timeout 的迟到响应也返回一份合法建议
    return json.dumps(_suggestion_executable(), ensure_ascii=False)


def _load_scenarios() -> list:
    try:
        with open(SCENARIOS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _user_text(body: dict) -> str:
    parts = []
    for message in body.get("messages") or []:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict):
                    if isinstance(part.get("text"), str):
                        parts.append(part["text"])
    return "\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    server_version = "ShinianFakeModel/1.0"
    protocol_version = "HTTP/1.1"

    # 不打印请求行 / 请求正文 / 请求头，避免密钥进入测试输出
    def log_message(self, format, *args):  # noqa: A002 - 覆盖标准库签名
        return

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 - 标准库接口
        if self.path == "/__health":
            self._send_json(200, {"ok": True, "service": SERVICE, "port": PORT})
            return
        if self.path == "/__last":
            with _lock:
                current = _last_request
            self._send_json(200, {"request": current})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - 标准库接口
        global _last_request
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": {"message": "invalid json body"}})
            return

        record = {
            "method": self.command,
            "path": self.path,
            "headers": {str(k): str(v) for k, v in self.headers.items()},
            "body": body,
            "receivedAt": _now_ms(),
        }
        with _lock:
            _last_request = record

        model = str(body.get("model") or "")
        if model.startswith("fake-suggest-keywords"):
            _write_suggest_last(record, model)
        if model in {"fake-auth", "fake-experience-auth"}:
            self._send_json(401, {"error": {"message": "invalid api key"}})
            return
        if model == "fake-model-missing":
            self._send_json(404, {"error": {"message": "model not found"}})
            return
        if model == "fake-redirect":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{PORT + 1}/v1/chat/completions")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if model == "fake-invalid-json":
            # 200 但整个响应体不是合法 JSON：连接测试与生成都必须归类 invalid_response
            raw = "这不是合法的 JSON 响应体，只是一段普通文本。".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if model in {
            "fake-timeout",
            "fake-experience-timeout",
            "fake-review-timeout",
            "fake-research-timeout",
            "fake-ask-timeout",
            "fake-suggest-keywords-timeout",
        }:
            # 契约要求延迟 5s；客户端可能先超时断开，写回失败是预期情况
            time.sleep(5.0)
        elif model not in {
            "fake-success",
            "fake-defer",
            "fake-clarify",
            "fake-invalid-json",
            "fake-invalid-shape",
            "fake-scenario",
            "fake-experience",
            "fake-experience-3",
            "fake-experience-bad-source",
            "fake-experience-contradict",
            "fake-experience-insufficient",
            "fake-review",
            "fake-review-insufficient",
            "fake-review-bad-source",
            "fake-review-invalid-json",
            "fake-review-timeout",
        } and not model.startswith("fake-research") and not model.startswith("fake-ask") and not model.startswith("fake-suggest-keywords"):
            self._send_json(404, {"error": {"message": f"unknown fake model: {model}"}})
            return

        content = _content_for(model, body)
        payload = {
            "id": f"chatcmpl-fake-{_now_ms()}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200},
        }
        try:
            self._send_json(200, payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # 客户端已取消，忽略迟到响应
            pass


class FakeModelServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    try:
        server = FakeModelServer((HOST, PORT), Handler)
    except OSError as exc:
        print(f"fake model server 无法监听 {HOST}:{PORT}: {exc}", file=sys.stderr)
        return 2
    print(f"fake model server listening on http://{HOST}:{PORT} (scenarios: {SCENARIOS_PATH})")
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
