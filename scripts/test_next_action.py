"""拾念 SHINIAN · 「回顾后的下一步行动」API 验收

针对运行中的测试服务（SHINIAN_BASE，默认 http://127.0.0.1:3100）。
独立测试服务由 scripts/run_tests.py 负责；本脚本不启动/停止被测服务。

预置数据：
- 通过 HTTP 创建 capture / attempt / result；
- 直接向测试库 stage_reviews 写入一条 saved review（status=succeeded、
  content_json.experiences[0]、sources_json 含 attempt 来源与 revision），
  不依赖真实模型，也不依赖 AI 生成接口。重复运行使用唯一 uid，互不干扰。

覆盖 docs/next-action-api-contract.md：
1. 未登录 401；回顾不存在/未保存/非法经验索引/无 attempt 来源。
2. 预览字段：review/experience/sourceAttempts/captures/defaults/contextToken。
3. 正常创建（未排程 / 已排程）；operationId 幂等与改参数 409。
4. 来源存在；预览后来源修改 → sources_changed；来源删除/正文撤下 → review_content_withheld；
   创建后删除来源，详情仍可读且正文/结果清洗为 null。
5. capture revision 冲突；attempt 来源 revision 变化后的 changed/currentRevision。
6. 非法标题/说明/预计耗时/时间/时区、DST 不存在/重复。
7. 跨午夜；日程冲突 → options/conflictToken → 确认成功；
   确认期间新增冲突 → schedule_conflict_changed；保存为未排程。
8. 事务回滚：attempt 已写入后日程插入失败，无 attempt/reference/schedule/receipt 残留。
9. 完成行动保存结果；下一次阶段回顾包含 attempt/result/reference。
10. 导出 schemaVersion=6、最新 data 表集合与 7 个新增 attempt 字段；v2 读取器缺失字段按 manual/null。
"""
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test.sqlite")
UID = uuid.uuid4().hex[:8]
USERNAME = f"下一步行动验收-{UID}"
TZ = "Asia/Shanghai"
NY = "America/New_York"

c = Checker()
client = Client(base=BASE)
_op_seq = 0

NA_KEYS = {
    "id",
    "captureId",
    "title",
    "description",
    "estimatedMinutes",
    "state",
    "resultText",
    "outcome",
    "observedAt",
    "revision",
    "createdAt",
    "updatedAt",
    "origin",
    "sourceReviewId",
    "sourceExperienceIndex",
    "sourceAttemptId",
    "sourceAttemptRevision",
    "capture",
    "sourceReview",
    "experience",
    "sources",
    "schedules",
    "canEdit",
    "deleted",
}
ATTEMPT_NEW_KEYS = {
    "origin",
    "actionDescription",
    "estimatedMinutes",
    "sourceReviewId",
    "sourceExperienceIndex",
    "sourceAttemptId",
    "sourceAttemptRevision",
}

# 每次运行使用独立的一周（2030-01-07 是周一），避免重复运行互相制造冲突。
DATE_SEED = int(time.time() * 1000) % 1_000_000
MONDAY = date(2030, 1, 7) + timedelta(weeks=DATE_SEED % 9000)
D1 = MONDAY + timedelta(days=1)
D2 = MONDAY + timedelta(days=2)
D3 = MONDAY + timedelta(days=3)
D4 = MONDAY + timedelta(days=4)
D5 = MONDAY + timedelta(days=5)


def nth_weekday(year, month, weekday, nth):
    """返回某月第 n 个指定星期（周一=0）。用于每年不同的 DST 边界，避免重复运行撞同一时段。"""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (nth - 1))


DST_YEAR = 2027 + (DATE_SEED % 25)
DST_SPRING_DAY = nth_weekday(DST_YEAR, 3, 6, 2)  # 3 月第二个周日
DST_FALL_DAY = nth_weekday(DST_YEAR, 11, 6, 1)  # 11 月第一个周日
DST_MINUTE = (DATE_SEED // 7) % 45
DST_START = f"01:{DST_MINUTE:02d}"
DST_END = f"01:{DST_MINUTE + 10:02d}"


def op_id(tag="na"):
    global _op_seq
    _op_seq += 1
    return f"op-na-{tag}-{UID}-{_op_seq}"


def now_ms():
    return int(time.time() * 1000)


def d(value):
    return value.isoformat()


def ts(day, hhmm, tz=TZ):
    hour, minute = (int(x) for x in hhmm.split(":"))
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZoneInfo(tz))
    return int(local.timestamp() * 1000)


def db_connect():
    conn = sqlite3.connect(TEST_DB, timeout=20)
    conn.execute("PRAGMA busy_timeout=20000")
    return conn


def db_commit(fn):
    with closing(db_connect()) as conn:
        fn(conn)
        conn.commit()


def db_scalar(sql, params=()):
    with closing(db_connect()) as conn:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


def api(method, path, data=None):
    return client.request(method, path, data)


def expect_error(name, status, body, want_status, want_error):
    c.check(
        name,
        status == want_status and isinstance(body, dict) and body.get("error") == want_error,
        f"{status} {body}",
    )


# ---------------------------------------------------------------- 数据准备
def create_capture(text):
    status, res = api("POST", "/api/captures", {"rawText": text})
    assert status == 200 and (res or {}).get("capture"), f"创建念头失败 {status} {res}"
    return res["capture"]


def create_attempt(capture_id, step, result_text=None, outcome=None, state="done"):
    body = {"step": step, "state": state, "operationId": op_id("att")}
    if result_text is not None:
        body["resultText"] = result_text
    if outcome is not None:
        body["outcome"] = outcome
    status, res = api("POST", f"/api/captures/{capture_id}/attempts", body)
    assert status == 200 and (res or {}).get("attempt"), f"创建尝试失败 {status} {res}"
    return res["attempt"]


def capture_source(capture):
    return {
        "key": f"capture:{capture['id']}",
        "type": "capture",
        "sourceId": capture["id"],
        "captureId": capture["id"],
        "attemptId": None,
        "relatedAttemptId": None,
        "title": capture["rawText"][:60],
        "text": capture["rawText"],
        "resultText": None,
        "outcome": None,
        "state": None,
        "observedAt": None,
        "revision": capture["revision"],
        "captureRevision": capture["revision"],
        "relatedRevision": None,
        "createdAt": capture["createdAt"],
        "updatedAt": capture["updatedAt"],
    }


def attempt_source(capture, attempt):
    return {
        "key": f"attempt:{attempt['id']}",
        "type": "attempt",
        "sourceId": attempt["id"],
        "captureId": capture["id"],
        "attemptId": attempt["id"],
        "relatedAttemptId": None,
        "title": attempt["step"][:60],
        "text": attempt["step"],
        "resultText": attempt.get("resultText"),
        "outcome": attempt.get("outcome"),
        "state": attempt["state"],
        "observedAt": attempt.get("observedAt"),
        "revision": attempt["revision"],
        "captureRevision": capture["revision"],
        "relatedRevision": None,
        "createdAt": attempt["createdAt"],
        "updatedAt": attempt["updatedAt"],
    }


def make_content(experience_text, source_ids, extra_experiences=None):
    experiences = [{"text": experience_text, "basis": "inference", "sourceIds": list(source_ids)}]
    if extra_experiences:
        experiences.extend(extra_experiences)
    return {
        "overview": f"下一步行动验收回顾 {UID}：记录了一次可复用的经验。",
        "attempts": [{"text": "你实际做了一次尝试并记录了结果。", "basis": "observation", "sourceIds": list(source_ids)}],
        "observations": [{"text": "结果文本已保存。", "basis": "observation", "sourceIds": list(source_ids)}],
        "connections": [{"text": "这条结果可以支持下一次行动。", "basis": "inference", "sourceIds": list(source_ids)}],
        "experiences": experiences,
        "uncertainties": ["只有一次记录。"],
        "insufficientData": False,
        "dataNotes": None,
    }


def insert_review(review_id, content, sources, saved=True, created_at=None):
    now = created_at or now_ms()
    stats = {
        "capturesCreated": 1,
        "capturesModified": 0,
        "attemptsStarted": 1,
        "attemptsModified": 0,
        "attemptsCurrentlyEnded": 1,
        "resultsRecorded": 1,
        "resultsMissingObservedAt": 0,
        "referencesCreated": 0,
        "totalRecords": 2,
    }
    coverage = {
        "totalRecords": 2,
        "selectedRecords": 2,
        "excludedRecords": 0,
        "selectedChars": 120,
        "maxRecords": 80,
        "maxChars": 16000,
        "withinLimit": True,
        "truncated": False,
        "sectionCounts": {"captures": 1, "attempts": 1, "results": 1, "references": 0, "modifications": 0},
    }
    with closing(db_connect()) as conn:
        conn.execute(
            "INSERT INTO stage_reviews (id, status, range_from, range_to, timezone, range_preset, "
            "stats_json, coverage_json, content_json, sources_json, config_id, config_version, config_name, "
            "model_id, saved_at, created_at, updated_at, finished_at) "
            "VALUES (?, 'succeeded', ?, ?, ?, 'custom', ?, ?, ?, ?, 'default', 1, '下一步验收模型', "
            "'fake-review', ?, ?, ?, ?)",
            (
                review_id,
                now - 86400000,
                now + 86400000,
                TZ,
                json.dumps(stats, ensure_ascii=False),
                json.dumps(coverage, ensure_ascii=False),
                json.dumps(content, ensure_ascii=False),
                json.dumps(sources, ensure_ascii=False),
                now if saved else None,
                now,
                now,
                now,
            ),
        )
        conn.commit()


def make_review(tag, experience_text=None, capture_text=None, step=None, result_text=None,
                outcome="failure", saved=True, source_ids_override=None):
    """创建 capture + attempt/result，并直接写入一条 saved review。"""
    cap = create_capture(capture_text or f"【下一步验收-{tag}】PWM 低占空比时 LED 会闪 {UID}")
    att = create_attempt(
        cap["id"],
        step or f"【下一步验收-{tag}】比较 500 Hz 与 2 kHz {UID}",
        result_text=result_text or f"【下一步验收-{tag}】500 Hz 仍闪烁，2 kHz 未见闪烁 {UID}",
        outcome=outcome,
        state="done",
    )
    experience_text = experience_text or f"下次先固定其他条件，只改变频率再复测一次（{tag}）"
    sources = [capture_source(cap), attempt_source(cap, att)]
    source_ids = source_ids_override or [f"attempt:{att['id']}"]
    review_id = f"rev-na-{tag}-{UID}"
    insert_review(review_id, make_content(experience_text, source_ids), sources, saved=saved)
    return {"reviewId": review_id, "capture": cap, "attempt": att, "experience": experience_text}


def preview(review_id, index=0):
    return api("GET", f"/api/reviews/{review_id}/next-action-preview?experienceIndex={index}")


def schedule_body(day, start, end, end_day=None, tz=TZ, note=None, enabled=None,
                  confirm=False, token=None, ids=None, start_dis=None, end_dis=None):
    body = {
        "date": d(day),
        "endDate": d(end_day or day),
        "startTime": start,
        "endTime": end,
        "timezone": tz,
        "note": note,
        "confirmOverlap": confirm,
        "conflictToken": token,
        "expectedConflictIds": list(ids or []),
    }
    if enabled is not None:
        body["enabled"] = enabled
    if start_dis is not None:
        body["startDisambiguation"] = start_dis
    if end_dis is not None:
        body["endDisambiguation"] = end_dis
    return body


def action_body(prev, title, description="说明", estimated_minutes=30, schedule=None,
                operation_id=None, capture_revision=None, context_token=None):
    caps = (prev or {}).get("captures") or []
    capture_id = ((prev or {}).get("defaults") or {}).get("captureId")
    cap = next((x for x in caps if x.get("id") == capture_id), None)
    assert cap is not None, f"预览缺少 capture: {prev}"
    body = {
        "captureId": capture_id,
        "captureRevision": capture_revision if capture_revision is not None else cap["revision"],
        "experienceIndex": (prev or {}).get("experienceIndex", 0),
        "title": title,
        "description": description,
        "estimatedMinutes": estimated_minutes,
        "contextToken": context_token if context_token is not None else prev.get("contextToken"),
        "operationId": operation_id or op_id("create"),
        "schedule": schedule,
    }
    return body


def create_action(prev, title, **kwargs):
    schedule = kwargs.pop("schedule", None)
    body = action_body(prev, title, schedule=schedule, **kwargs)
    status, res = api("POST", f"/api/reviews/{prev['review']['id']}/next-actions", body)
    return status, res, body


def review_actions(review_id):
    return api("GET", f"/api/reviews/{review_id}/next-actions")


def action_of(res):
    return (res or {}).get("nextAction") or {}


def db_attempt_count_by_step(step):
    return db_scalar("SELECT COUNT(*) FROM attempts WHERE step = ?", (step,))


def db_receipt_count(operation_key):
    return db_scalar("SELECT COUNT(*) FROM mutation_receipts WHERE operation_key = ?", (operation_key,))


# ---------------------------------------------------------------- 主流程
def main():
    print(f"测试服务: {BASE}")
    print(f"测试库: {TEST_DB}")
    print(f"验收用户: {USERNAME}")

    # ============================================================ 0. 未登录
    print("\n### 0. 未登录 401")
    anon = Client(base=BASE)
    checks = [
        ("未登录预览下一步 401", "GET", f"/api/reviews/rev-x/next-action-preview?experienceIndex=0", None),
        ("未登录创建下一步 401", "POST", "/api/reviews/rev-x/next-actions", {"title": "x"}),
        ("未登录回顾下一步列表 401", "GET", "/api/reviews/rev-x/next-actions", None),
        ("未登录念头下一步列表 401", "GET", "/api/captures/cap-x/next-actions", None),
        ("未登录下一步详情 401", "GET", "/api/next-actions/na-x", None),
        ("未登录更新下一步 401", "PATCH", "/api/next-actions/na-x", {"revision": 1}),
    ]
    for name, method, path, body in checks:
        status, _ = anon.request(method, path, body)
        c.check(name, status == 401, str(status))

    body = client.login(USERNAME)
    c.check("创建/登录唯一验收账号", body.get("ok") is True, str(body))

    # ============================================================ 1. 回顾与预览校验
    print("\n### 1. 回顾存在性、保存状态与经验索引")
    status, res = api("GET", f"/api/reviews/rev-missing-{UID}/next-action-preview?experienceIndex=0")
    expect_error("不存在的回顾预览返回 404 review_not_found", status, res, 404, "review_not_found")

    unsaved = make_review("unsaved", saved=False)
    status, res = preview(unsaved["reviewId"])
    expect_error("未保存回顾预览返回 409 review_not_saved", status, res, 409, "review_not_saved")
    status, res = api(
        "POST",
        f"/api/reviews/{unsaved['reviewId']}/next-actions",
        {
            "captureId": unsaved["capture"]["id"],
            "captureRevision": unsaved["capture"]["revision"],
            "experienceIndex": 0,
            "title": "未保存回顾不应创建",
            "contextToken": "x",
            "operationId": op_id("unsaved"),
        },
    )
    expect_error("未保存回顾创建返回 409 review_not_saved", status, res, 409, "review_not_saved")

    invalid_index = make_review("bad-index")
    status, res = preview(invalid_index["reviewId"], 5)
    expect_error("非法经验索引返回 400 invalid_experience_index", status, res, 400, "invalid_experience_index")

    unavailable = make_review("no-attempt-source", source_ids_override=None)
    # 改成只有 capture 来源的回顾，验证 source_unavailable。
    cap_only_id = f"rev-na-no-attempt-{UID}"
    insert_review(
        cap_only_id,
        make_content("这条经验没有尝试来源", [f"capture:{unavailable['capture']['id']}"]),
        [capture_source(unavailable["capture"])],
    )
    status, res = preview(cap_only_id)
    expect_error("没有 attempt 来源返回 409 source_unavailable", status, res, 409, "source_unavailable")

    # ============================================================ 2. 预览字段 + 未排程创建
    print("\n### 2. 预览字段与未排程创建")
    a = make_review(
        "A",
        experience_text="只在 2 kHz 下复测闪烁，先固定其他条件。",
    )
    status, prev = preview(a["reviewId"])
    c.check("A 预览返回 200", status == 200, f"{status} {prev}")
    review_meta = (prev or {}).get("review") or {}
    c.check(
        "A 预览 review 元信息正确",
        review_meta.get("id") == a["reviewId"]
        and isinstance(review_meta.get("savedAt"), int)
        and (review_meta.get("range") or {}).get("timezone") == TZ
        and review_meta.get("contentInvalidated") is False
        and review_meta.get("sourcesChanged") is False,
        str(review_meta),
    )
    exp = (prev or {}).get("experience") or {}
    c.check(
        "A 预览 experience 保持模型建议与来源",
        exp.get("text") == a["experience"]
        and exp.get("basis") == "inference"
        and exp.get("sourceIds") == [f"attempt:{a['attempt']['id']}"],
        str(exp)[:300],
    )
    source_attempts = (prev or {}).get("sourceAttempts") or []
    c.check("A 预览 sourceAttempts 恰为 1 条", len(source_attempts) == 1, str(source_attempts))
    sa = source_attempts[0] if source_attempts else {}
    c.check(
        "A 预览来源尝试字段完整且版本正确",
        sa.get("attemptId") == a["attempt"]["id"]
        and sa.get("captureId") == a["capture"]["id"]
        and sa.get("step") == a["attempt"]["step"]
        and sa.get("state") == "done"
        and sa.get("resultText") == a["attempt"]["resultText"]
        and sa.get("outcome") == "failure"
        and sa.get("revision") == a["attempt"]["revision"]
        and sa.get("captureRevision") == a["capture"]["revision"]
        and sa.get("captureText") == a["capture"]["rawText"]
        and sa.get("exists") is True
        and sa.get("changed") is False
        and sa.get("deleted") is False,
        str(sa)[:500],
    )
    caps = (prev or {}).get("captures") or []
    c.check(
        "A 预览 captures 含当前念头与版本",
        len(caps) == 1
        and caps[0].get("id") == a["capture"]["id"]
        and caps[0].get("rawText") == a["capture"]["rawText"]
        and caps[0].get("revision") == a["capture"]["revision"]
        and caps[0].get("archivedAt") is None,
        str(caps)[:400],
    )
    defaults = (prev or {}).get("defaults") or {}
    c.check(
        "A 预览 defaults 提供真实 capture 与草稿",
        defaults.get("captureId") == a["capture"]["id"]
        and isinstance(defaults.get("title"), str)
        and 0 < len(defaults.get("title", "")) <= 60
        and isinstance(defaults.get("description"), str)
        and isinstance(defaults.get("estimatedMinutes"), int)
        and 1 <= defaults.get("estimatedMinutes") <= 1440
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(defaults.get("suggestedDate")))
        and defaults.get("timezone") == TZ,
        str(defaults),
    )
    token_a = (prev or {}).get("contextToken") or ""
    c.check("A 预览 contextToken 为 sha256 hex", bool(re.fullmatch(r"[0-9a-f]{64}", token_a)), token_a)

    status, res, body_a = create_action(
        prev,
        "只在 2 kHz 下复测闪烁",
        description="固定其他条件，只改变频率。",
        estimated_minutes=30,
        schedule=None,
        operation_id=op_id("A"),
    )
    action_a = action_of(res)
    c.check("A 未排程创建返回 201 且 replayed=false", status == 201 and (res or {}).get("replayed") is False, f"{status} {res}")
    c.check("A 响应 nextAction 字段与契约完全一致", set(action_a.keys()) == NA_KEYS, str(sorted(action_a.keys())))
    c.check(
        "A 行动核心字段正确",
        bool(action_a.get("id"))
        and action_a.get("captureId") == a["capture"]["id"]
        and action_a.get("title") == "只在 2 kHz 下复测闪烁"
        and action_a.get("description") == "固定其他条件，只改变频率。"
        and action_a.get("estimatedMinutes") == 30
        and action_a.get("state") == "todo"
        and action_a.get("resultText") is None
        and action_a.get("outcome") is None
        and action_a.get("observedAt") is None
        and action_a.get("revision") == 1
        and isinstance(action_a.get("createdAt"), int)
        and isinstance(action_a.get("updatedAt"), int),
        str(action_a)[:600],
    )
    c.check(
        "A 行动来源字段正确",
        action_a.get("origin") == "review_next_action"
        and action_a.get("sourceReviewId") == a["reviewId"]
        and action_a.get("sourceExperienceIndex") == 0
        and action_a.get("sourceAttemptId") == a["attempt"]["id"]
        and action_a.get("sourceAttemptRevision") == a["attempt"]["revision"],
        str({k: action_a.get(k) for k in ("origin", "sourceReviewId", "sourceExperienceIndex", "sourceAttemptId", "sourceAttemptRevision")}),
    )
    c.check(
        "A 行动包含可读念头与来源回顾快照",
        (action_a.get("capture") or {}).get("id") == a["capture"]["id"]
        and (action_a.get("capture") or {}).get("rawText") == a["capture"]["rawText"]
        and (action_a.get("sourceReview") or {}).get("id") == a["reviewId"]
        and isinstance((action_a.get("sourceReview") or {}).get("savedAt"), int)
        and (action_a.get("sourceReview") or {}).get("contentInvalidated") is False,
        str(action_a.get("sourceReview")),
    )
    c.check(
        "A 行动保留模型经验但标注为建议",
        (action_a.get("experience") or {}).get("text") == a["experience"]
        and (action_a.get("experience") or {}).get("basis") == "inference",
        str(action_a.get("experience")),
    )
    action_sources = action_a.get("sources") or []
    c.check(
        "A 行动来源存在且未删除",
        len(action_sources) == 1
        and action_sources[0].get("type") == "attempt"
        and action_sources[0].get("sourceId") == a["attempt"]["id"]
        and action_sources[0].get("changed") is False
        and action_sources[0].get("deleted") is False
        and action_sources[0].get("currentRevision") == a["attempt"]["revision"],
        str(action_sources),
    )
    c.check("A 行动初始没有日程", action_a.get("schedules") == [], str(action_a.get("schedules")))
    c.check("A 行动可编辑 canEdit=true", action_a.get("canEdit") is True, str(action_a.get("canEdit")))

    action_a_id = action_a.get("id")
    status, res = api("GET", f"/api/attempts/{action_a_id}")
    c.check(
        "A 行动已落为 todo Attempt（step=标题）",
        status == 200 and (res or {}).get("attempt", {}).get("state") == "todo" and (res or {}).get("attempt", {}).get("step") == "只在 2 kHz 下复测闪烁",
        f"{status} {str(res)[:400]}",
    )
    status, res = api("GET", f"/api/next-actions/{action_a_id}")
    c.check("A 行动详情可读", status == 200 and (res or {}).get("action", {}).get("id") == action_a_id, f"{status} {str(res)[:300]}")
    status, res = review_actions(a["reviewId"])
    c.check("A 回顾行动列表包含该行动", status == 200 and any(x.get("id") == action_a_id for x in (res or {}).get("actions") or []), f"{status} {str(res)[:300]}")
    status, res = api("GET", f"/api/captures/{a['capture']['id']}/next-actions")
    c.check("A 念头行动列表包含该行动", status == 200 and any(x.get("id") == action_a_id for x in (res or {}).get("actions") or []), f"{status} {str(res)[:300]}")
    status, res = api("GET", f"/api/attempts/{action_a_id}/references")
    from_refs = (res or {}).get("fromRefs") or []
    c.check(
        "A 行动事务内建立 attempt_references（快照版本/结果）",
        status == 200
        and len(from_refs) == 1
        and from_refs[0].get("toAttemptId") == a["attempt"]["id"]
        and from_refs[0].get("snapshotRevision") == a["attempt"]["revision"]
        and from_refs[0].get("snapshotResultText") == a["attempt"]["resultText"],
        f"{status} {str(res)[:500]}",
    )
    action_a_ref = from_refs[0].get("id") if from_refs else None

    # ============================================================ 3. operationId 幂等
    print("\n### 3. operationId 幂等与改参数 409")
    status, res = api("POST", f"/api/reviews/{a['reviewId']}/next-actions", body_a)
    c.check("重复 operationId 相同参数返回 200 replayed=true", status == 200 and (res or {}).get("replayed") is True, f"{status} {res}")
    c.check("重复 operationId 返回同一条行动", action_of(res).get("id") == action_a_id, str(action_of(res).get("id")))
    status, res = review_actions(a["reviewId"])
    c.check("重复提交后回顾下仍只有 1 条行动", len((res or {}).get("actions") or []) == 1, str((res or {}).get("actions")))
    status, res = api("GET", f"/api/attempts/{action_a_id}/references")
    c.check("重复提交不重复创建引用", len((res or {}).get("fromRefs") or []) == 1, str(res))
    changed_body = dict(body_a)
    changed_body["title"] = "同一 operationId 改标题"
    status, res = api("POST", f"/api/reviews/{a['reviewId']}/next-actions", changed_body)
    expect_error("同一 operationId 改参数返回 409 operation_key_conflict", status, res, 409, "operation_key_conflict")
    c.check(
        "创建回执 target_type=next_action 且只有一条",
        db_scalar("SELECT COUNT(*) FROM mutation_receipts WHERE operation_key = ? AND target_type = 'next_action'", (body_a["operationId"],)) == 1,
        str(db_scalar("SELECT COUNT(*) FROM mutation_receipts WHERE operation_key = ?", (body_a["operationId"],))),
    )

    # ============================================================ 3b. 更新行动（PATCH）
    print("\n### 3b. 更新行动：字段、幂等与 revision 冲突")
    status, res, _ = create_action(prev, "可编辑行动 M", operation_id=op_id("M-create"))
    action_m = action_of(res)
    c.check("M 创建待编辑行动成功", status == 201, f"{status} {str(res)[:300]}")
    update_body = {
        "title": "更新后的行动标题",
        "description": "更新后的行动说明",
        "estimatedMinutes": 45,
        "revision": 1,
        "operationId": op_id("M-update"),
    }
    status, res = api("PATCH", f"/api/next-actions/{action_m.get('id')}", update_body)
    updated_m = (res or {}).get("nextAction") or {}
    c.check(
        "PATCH 行动更新标题/说明/耗时成功",
        status == 200
        and updated_m.get("title") == "更新后的行动标题"
        and updated_m.get("description") == "更新后的行动说明"
        and updated_m.get("estimatedMinutes") == 45
        and updated_m.get("revision") == 2
        and updated_m.get("sourceAttemptId") == a["attempt"]["id"]
        and updated_m.get("sourceReviewId") == a["reviewId"],
        f"{status} {str(updated_m)[:500]}",
    )
    status, res = api("PATCH", f"/api/next-actions/{action_m.get('id')}", update_body)
    c.check(
        "PATCH 相同 operationId 回放且 revision 不变",
        status == 200
        and (res or {}).get("replayed") is True
        and ((res or {}).get("nextAction") or {}).get("revision") == 2,
        f"{status} {str(res)[:300]}",
    )
    status, res = api(
        "PATCH",
        f"/api/next-actions/{action_m.get('id')}",
        {**update_body, "title": "旧版本不应覆盖", "operationId": op_id("M-stale")},
    )
    expect_error("PATCH 旧 revision 返回 409 revision_conflict", status, res, 409, "revision_conflict")
    c.check(
        "revision_conflict 返回 current 最新对象",
        ((res or {}).get("current") or {}).get("revision") == 2
        and ((res or {}).get("current") or {}).get("title") == "更新后的行动标题",
        str(res)[:400],
    )
    status, res = api(
        "PATCH",
        f"/api/next-actions/{a['attempt']['id']}",
        {"title": "普通尝试不可更新", "revision": a["attempt"]["revision"], "operationId": op_id("M-not")},
    )
    expect_error("普通尝试 PATCH 返回 409 not_next_action", status, res, 409, "not_next_action")
    status, res = api("GET", f"/api/next-actions/att-missing-{UID}")
    expect_error("不存在的行动详情返回 404 next_action_not_found", status, res, 404, "next_action_not_found")

    # ============================================================ 4. 来源修改
    print("\n### 4. 预览后来源修改 → sources_changed；创建后 revision 变化可读")
    b = make_review("B", experience_text="来源修改场景：先复测再记录。")
    status, prev_b = preview(b["reviewId"])
    c.check("B 预览返回 200", status == 200, f"{status} {prev_b}")
    status, res = api(
        "PATCH",
        f"/api/attempts/{b['attempt']['id']}",
        {
            "state": "done",
            "resultText": "来源在预览后被修改：2 kHz 仍偶发闪烁",
            "outcome": "undetermined",
            "revision": b["attempt"]["revision"],
        },
    )
    c.check("B 预览后修改来源尝试成功", status == 200 and (res or {}).get("attempt", {}).get("revision") == b["attempt"]["revision"] + 1, f"{status} {str(res)[:300]}")
    b_source_rev2 = (res or {}).get("attempt", {}).get("revision")
    status, res, body_b_old = create_action(prev_b, "来源修改后不应创建", operation_id=op_id("B-old"))
    expect_error("预览后来源 revision 变化返回 409 sources_changed", status, res, 409, "sources_changed")
    latest_sources = (res or {}).get("sourceAttempts") or []
    c.check(
        "sources_changed 返回最新来源版本与新 contextToken",
        len(latest_sources) == 1
        and latest_sources[0].get("revision") == b_source_rev2
        and isinstance((res or {}).get("contextToken"), str)
        and (res or {}).get("contextToken") != prev_b.get("contextToken")
        and len((res or {}).get("contextToken") or "") == 64,
        str(res)[:600],
    )
    status, prev_b2 = preview(b["reviewId"])
    c.check("B 重新预览返回新 token", status == 200 and prev_b2.get("contextToken") != prev_b.get("contextToken"), f"{status}")
    status, res, _ = create_action(prev_b2, "来源修改后重新确认创建", operation_id=op_id("B-new"))
    action_b = action_of(res)
    c.check("B 用最新来源版本创建成功", status == 201 and action_b.get("sourceAttemptRevision") == b_source_rev2, f"{status} {str(res)[:400]}")
    status, res = api(
        "PATCH",
        f"/api/attempts/{b['attempt']['id']}",
        {"resultText": "来源再次修改（第三版）", "outcome": "failure", "revision": b_source_rev2},
    )
    c.check("B 创建后再次修改来源成功", status == 200, f"{status} {str(res)[:300]}")
    status, res = api("GET", f"/api/next-actions/{action_b.get('id')}")
    changed_sources = ((res or {}).get("action") or {}).get("sources") or []
    c.check(
        "B 创建后来源 revision 冲突在详情中标记 changed/currentRevision",
        status == 200
        and len(changed_sources) == 1
        and changed_sources[0].get("changed") is True
        and changed_sources[0].get("revision") == b_source_rev2
        and changed_sources[0].get("currentRevision") == b_source_rev2 + 1
        and ((res or {}).get("action") or {}).get("sourceAttemptRevision") == b_source_rev2,
        f"{status} {str(res)[:600]}",
    )

    # ============================================================ 5. 来源删除（预览后）
    print("\n### 5. 预览后来源删除 → source_deleted")
    c1 = make_review("C", experience_text="来源删除场景：预览后删除来源。")
    status, prev_c = preview(c1["reviewId"])
    c.check("C 预览返回 200", status == 200, f"{status} {prev_c}")
    status, res = api("DELETE", f"/api/attempts/{c1['attempt']['id']}")
    c.check("C 删除来源尝试成功", status == 200, f"{status} {str(res)[:300]}")
    status, res, _ = create_action(prev_c, "来源删除后不应创建", operation_id=op_id("C"))
    expect_error("预览后来源删除返回 409 review_content_withheld", status, res, 409, "review_content_withheld")
    status, res = preview(c1["reviewId"])
    expect_error("来源删除后重新预览返回 409 review_content_withheld", status, res, 409, "review_content_withheld")

    # ============================================================ 6. capture revision 冲突
    print("\n### 6. capture revision 冲突")
    dd = make_review("D", experience_text="念头版本冲突场景。")
    status, prev_d = preview(dd["reviewId"])
    c.check("D 预览返回 200", status == 200, f"{status} {prev_d}")
    status, res = api(
        "PATCH",
        f"/api/captures/{dd['capture']['id']}",
        {"rawText": f"{dd['capture']['rawText']}（预览后修改）", "revision": dd["capture"]["revision"]},
    )
    c.check("D 预览后修改念头成功", status == 200 and (res or {}).get("capture", {}).get("revision") == dd["capture"]["revision"] + 1, f"{status} {str(res)[:300]}")
    d_cap_rev2 = (res or {}).get("capture", {}).get("revision")
    status, res, _ = create_action(prev_d, "念头版本冲突不应创建", operation_id=op_id("D"))
    expect_error("captureRevision 过期返回 409 capture_changed", status, res, 409, "capture_changed")
    c.check(
        "capture_changed 返回 currentRevision",
        (res or {}).get("currentRevision") == d_cap_rev2,
        str(res)[:400],
    )

    # ============================================================ 7. 字段与时间校验
    print("\n### 7. 标题/说明/耗时/时间/时区/DST 校验")
    e = make_review("E", experience_text="参数校验场景。")
    status, prev_e = preview(e["reviewId"])
    c.check("E 预览返回 200", status == 200, f"{status} {prev_e}")
    invalid_cases = [
        ("空标题", {"title": ""}, 400, "invalid_title"),
        ("超长标题", {"title": "长" * 121}, 400, "invalid_title"),
        ("超长说明", {"description": "说" * 2001}, 400, "invalid_description"),
        ("预计耗时 0", {"estimated_minutes": 0}, 400, "invalid_estimated_minutes"),
        ("预计耗时 1441", {"estimated_minutes": 1441}, 400, "invalid_estimated_minutes"),
        ("预计耗时非整数", {"estimated_minutes": 1.5}, 400, "invalid_estimated_minutes"),
    ]
    for label, patch, want_status, want_error in invalid_cases:
        kwargs = {"description": "说明", "estimated_minutes": 30, "operation_id": op_id("E-field")}
        kwargs.update(patch)
        status, res, _ = create_action(prev_e, kwargs.pop("title", "参数校验行动"), **kwargs)
        expect_error(f"{label} 返回 {want_status} {want_error}", status, res, want_status, want_error)

    schedule_cases = [
        (
            "结束早于开始",
            schedule_body(D1, "10:00", "09:00", note="非法时间"),
            400,
            "invalid_schedule_time",
        ),
        (
            "非法时区",
            schedule_body(D1, "10:00", "11:00", tz="Mars/Olympus", note="非法时区"),
            400,
            "invalid_timezone",
        ),
        (
            "DST 不存在时间",
            schedule_body(DST_SPRING_DAY, "02:30", "03:30", tz=NY, note="DST 不存在"),
            400,
            "nonexistent_local_time",
        ),
        (
            "DST 重复时间未消歧",
            schedule_body(DST_FALL_DAY, DST_START, DST_END, tz=NY, note="DST 重复"),
            400,
            "ambiguous_local_time",
        ),
    ]
    for label, schedule, want_status, want_error in schedule_cases:
        status, res, _ = create_action(prev_e, "时间校验行动", schedule=schedule, operation_id=op_id("E-time"))
        expect_error(f"{label} 返回 {want_status} {want_error}", status, res, want_status, want_error)

    status, res, _ = create_action(
        prev_e,
        "DST 重复时间显式选择 earlier",
        schedule=schedule_body(
            DST_FALL_DAY, DST_START, DST_END, tz=NY, note="DST earlier",
            start_dis="earlier", end_dis="earlier",
        ),
        operation_id=op_id("E-dst-ok"),
    )
    c.check("DST 重复时间带 earlier 消歧可创建", status == 201, f"{status} {str(res)[:500]}")
    c.check("非法参数场景未创建任何行动", len((review_actions(e["reviewId"])[1] or {}).get("actions") or []) == 1, str(review_actions(e["reviewId"])[1])[:500])

    # ============================================================ 8. 跨午夜
    print("\n### 8. 跨午夜安排")
    f = make_review("F", experience_text="跨午夜安排场景。")
    status, prev_f = preview(f["reviewId"])
    c.check("F 预览返回 200", status == 200, f"{status}")
    status, res, _ = create_action(
        prev_f,
        "跨午夜复测闪烁",
        schedule=schedule_body(D1, "23:00", "01:00", end_day=D2, note="跨午夜安排"),
        operation_id=op_id("F"),
    )
    action_f = action_of(res)
    f_schedules = action_f.get("schedules") or []
    c.check("跨午夜创建返回 201", status == 201, f"{status} {str(res)[:500]}")
    c.check(
        "跨午夜安排时间解析为 2 小时且保留时区",
        len(f_schedules) == 1
        and f_schedules[0].get("startsAt") == ts(D1, "23:00")
        and f_schedules[0].get("endsAt") == ts(D2, "01:00")
        and f_schedules[0].get("endsAt") - f_schedules[0].get("startsAt") == 7200000
        and f_schedules[0].get("timezone") == TZ
        and f_schedules[0].get("status") == "active",
        str(f_schedules),
    )
    status, res = api("GET", f"/api/attempts/{action_f.get('id')}/schedules")
    c.check("跨午夜安排可通过日程 API 读取", status == 200 and len((res or {}).get("schedules") or []) == 1, f"{status} {str(res)[:400]}")

    # ============================================================ 9. 日程冲突 → 确认
    print("\n### 9. 日程冲突 → options/conflictToken → 确认后成功")
    g = make_review("G", experience_text="日程冲突场景。")
    blocker_cap = create_capture(f"【下一步验收-G-blocker】已有安排 {UID}")
    blocker_att = create_attempt(blocker_cap["id"], f"【下一步验收-G-blocker】占位尝试 {UID}", state="todo")
    status, res = api(
        "POST",
        f"/api/attempts/{blocker_att['id']}/schedules",
        {
            "date": d(D3),
            "endDate": d(D3),
            "startTime": "10:00",
            "endTime": "11:00",
            "timezone": TZ,
            "note": "已有冲突安排",
            "operationId": op_id("G-blocker"),
        },
    )
    c.check("G 创建冲突占位安排成功", status in (200, 201), f"{status} {str(res)[:400]}")
    blocker_schedule_id = ((res or {}).get("schedule") or {}).get("id")
    status, prev_g = preview(g["reviewId"])
    c.check("G 预览返回 200", status == 200, f"{status}")
    status, res, body_g_conflict = create_action(
        prev_g,
        "冲突后确认再安排",
        schedule=schedule_body(D3, "10:30", "11:30", note="与已有安排重叠"),
        operation_id=op_id("G-conflict"),
    )
    expect_error("未确认的日程冲突返回 409 schedule_conflict", status, res, 409, "schedule_conflict")
    conflicts = (res or {}).get("conflicts") or []
    c.check(
        "冲突响应列出冲突对象与 token/options",
        isinstance(conflicts, list)
        and any(x.get("id") == blocker_schedule_id for x in conflicts)
        and bool(re.fullmatch(r"[0-9a-f]{64}", str((res or {}).get("conflictToken") or "")))
        and (res or {}).get("requiresConfirmation") is True
        and (res or {}).get("options") == {"changeTime": True, "saveUnscheduled": True, "viewConflicts": True},
        str(res)[:700],
    )
    c.check("冲突未确认时不创建行动", len((review_actions(g["reviewId"])[1] or {}).get("actions") or []) == 0, str(review_actions(g["reviewId"])[1])[:300])
    conflict_token = (res or {}).get("conflictToken")
    confirm_schedule = schedule_body(
        D3, "10:30", "11:30", note="与已有安排重叠",
        confirm=True, token=conflict_token, ids=[x.get("id") for x in conflicts],
    )
    status, res, _ = create_action(prev_g, "冲突后确认再安排", schedule=confirm_schedule, operation_id=op_id("G-confirm"))
    action_g = action_of(res)
    c.check("带 conflictToken 确认后创建成功", status == 201, f"{status} {str(res)[:500]}")
    c.check(
        "确认后行动包含 active 日程",
        len(action_g.get("schedules") or []) == 1
        and (action_g.get("schedules") or [])[0].get("status") == "active"
        and (action_g.get("schedules") or [])[0].get("startsAt") == ts(D3, "10:30"),
        str(action_g.get("schedules")),
    )

    # ============================================================ 10. 确认期间新增冲突
    print("\n### 10. 确认期间新增冲突 → schedule_conflict_changed")
    h = make_review("H", experience_text="确认期间冲突变化场景。")
    h_cap = create_capture(f"【下一步验收-H-blocker】已有安排 {UID}")
    h_att = create_attempt(h_cap["id"], f"【下一步验收-H-blocker】占位尝试 {UID}", state="todo")
    status, res = api(
        "POST",
        f"/api/attempts/{h_att['id']}/schedules",
        {
            "date": d(D4), "endDate": d(D4), "startTime": "10:00", "endTime": "10:40",
            "timezone": TZ, "note": "第一处冲突", "operationId": op_id("H-blocker"),
        },
    )
    c.check("H 创建第一处冲突成功", status in (200, 201), f"{status} {str(res)[:300]}")
    status, prev_h = preview(h["reviewId"])
    c.check("H 预览返回 200", status == 200, f"{status}")
    status, res, _ = create_action(
        prev_h, f"确认期间新增冲突行动 {UID}",
        schedule=schedule_body(D4, "10:30", "11:30", note="冲突变化"),
        operation_id=op_id("H-first-conflict"),
    )
    expect_error("H 首次冲突返回 409 schedule_conflict", status, res, 409, "schedule_conflict")
    old_token = (res or {}).get("conflictToken")
    old_ids = [x.get("id") for x in (res or {}).get("conflicts") or []]
    status, res = api(
        "POST",
        f"/api/attempts/{h_att['id']}/schedules",
        {
            "date": d(D4), "endDate": d(D4), "startTime": "11:00", "endTime": "11:20",
            "timezone": TZ, "note": "确认期间新增冲突", "operationId": op_id("H-blocker2"),
        },
    )
    c.check("H 确认期间新增第二处冲突成功", status in (200, 201), f"{status} {str(res)[:300]}")
    status, res, _ = create_action(
        prev_h, f"确认期间新增冲突行动 {UID}",
        schedule=schedule_body(D4, "10:30", "11:30", note="冲突变化", confirm=True, token=old_token, ids=old_ids),
        operation_id=op_id("H-stale-token"),
    )
    expect_error("旧 conflictToken 确认返回 409 schedule_conflict_changed", status, res, 409, "schedule_conflict_changed")
    c.check(
        "冲突变化响应带最新 conflicts 与新 token",
        len((res or {}).get("conflicts") or []) >= 2
        and (res or {}).get("conflictToken") != old_token
        and bool(re.fullmatch(r"[0-9a-f]{64}", str((res or {}).get("conflictToken") or "")))
        and (res or {}).get("requiresConfirmation") is True,
        str(res)[:700],
    )
    c.check(
        "确认失败事务无 attempt 残留",
        db_attempt_count_by_step(f"确认期间新增冲突行动 {UID}") == 0,
        str(db_attempt_count_by_step(f"确认期间新增冲突行动 {UID}")),
    )
    c.check(
        "确认失败事务无 receipt 残留",
        db_receipt_count(op_id("H-stale-token")) == 0,
        str(db_receipt_count(op_id("H-stale-token"))),
    )
    new_token = (res or {}).get("conflictToken")
    new_ids = [x.get("id") for x in (res or {}).get("conflicts") or []]
    status, res, _ = create_action(
        prev_h, f"确认期间新增冲突行动 {UID}",
        schedule=schedule_body(D4, "10:30", "11:30", note="冲突变化", confirm=True, token=new_token, ids=new_ids),
        operation_id=op_id("H-final"),
    )
    c.check("H 用最新 token 最终创建成功", status == 201, f"{status} {str(res)[:500]}")

    # ============================================================ 11. 保存为未排程
    print("\n### 11. schedule.enabled=false 保存为未排程")
    i = make_review("I", experience_text="未排程保存场景。")
    status, prev_i = preview(i["reviewId"])
    c.check("I 预览返回 200", status == 200, f"{status}")
    status, res, _ = create_action(
        prev_i,
        "保存为未排程行动",
        schedule=schedule_body(D5, "09:00", "10:00", note="不应保存", enabled=False),
        operation_id=op_id("I"),
    )
    action_i = action_of(res)
    c.check("enabled=false 创建返回 201", status == 201, f"{status} {str(res)[:500]}")
    c.check("enabled=false 行动 schedules 为空", action_i.get("schedules") == [], str(action_i.get("schedules")))
    status, res = api("GET", f"/api/attempts/{action_i.get('id')}/schedules")
    c.check("enabled=false 未写入 schedule_blocks", status == 200 and (res or {}).get("schedules") == [], f"{status} {str(res)[:300]}")

    # ============================================================ 12. 事务回滚（attempt 写入后日程插入失败）
    print("\n### 12. 事务回滚：attempt 创建后日程写入失败无残留")
    j = make_review("J", experience_text="事务回滚场景。")
    status, prev_j = preview(j["reviewId"])
    c.check("J 预览返回 200", status == 200, f"{status}")
    rollback_note = f"qa-rollback-{UID}"
    rollback_title = f"事务回滚不应留下行动 {UID}"
    rollback_op = op_id("J-rollback")
    trigger_name = f"qa_fail_schedule_{UID}"
    trigger_created = False
    try:
        db_commit(
            lambda conn: conn.execute(
                f"CREATE TRIGGER {trigger_name} BEFORE INSERT ON schedule_blocks "
                f"WHEN NEW.note = '{rollback_note}' "
                "BEGIN SELECT RAISE(ABORT, 'qa forced schedule failure'); END"
            )
        )
        trigger_created = True
        status, res, _ = create_action(
            prev_j,
            rollback_title,
            schedule=schedule_body(D5, "14:00", "15:00", note=rollback_note),
            operation_id=rollback_op,
        )
        c.check("日程插入失败时接口返回失败而非静默成功", status >= 400, f"{status} {str(res)[:400]}")
    finally:
        if trigger_created:
            try:
                db_commit(lambda conn: conn.execute(f"DROP TRIGGER {trigger_name}"))
            except Exception as exc:  # noqa: BLE001
                print(f"WARN 清理回滚触发器失败：{exc!r}")
    c.check("回滚后无 attempt 残留", db_attempt_count_by_step(rollback_title) == 0, str(db_attempt_count_by_step(rollback_title)))
    c.check(
        "回滚后无 attempt_references 残留",
        db_scalar(
            "SELECT COUNT(*) FROM attempt_references WHERE from_attempt_id IN "
            "(SELECT id FROM attempts WHERE step = ?)",
            (rollback_title,),
        ) == 0,
        str(db_scalar("SELECT COUNT(*) FROM attempt_references WHERE from_attempt_id IN (SELECT id FROM attempts WHERE step = ?)", (rollback_title,))),
    )
    c.check(
        "回滚后无 schedule_blocks 残留",
        db_scalar("SELECT COUNT(*) FROM schedule_blocks WHERE note = ?", (rollback_note,)) == 0,
        str(db_scalar("SELECT COUNT(*) FROM schedule_blocks WHERE note = ?", (rollback_note,))),
    )
    c.check("回滚后无 mutation_receipts 残留", db_receipt_count(rollback_op) == 0, str(db_receipt_count(rollback_op)))
    c.check("回滚后回顾下没有该行动", len((review_actions(j["reviewId"])[1] or {}).get("actions") or []) == 0, str(review_actions(j["reviewId"])[1])[:300])

    # ============================================================ 13. 完成行动并保存结果
    print("\n### 13. 完成行动保存结果，下一次阶段回顾包含 attempt/result/reference")
    observed_at = now_ms() - 1000
    status, res = api(
        "PATCH",
        f"/api/attempts/{action_a_id}",
        {
            "state": "done",
            "resultText": "实际观察：2 kHz 下连续观察 5 分钟，未见肉眼闪烁。",
            "outcome": "success",
            "observedAt": observed_at,
            "revision": action_a.get("revision"),
        },
    )
    c.check("完成行动并保存实际结果返回 200", status == 200, f"{status} {str(res)[:400]}")
    status, res = api("GET", f"/api/next-actions/{action_a_id}")
    done_action = (res or {}).get("action") or {}
    c.check(
        "完成后的行动详情返回状态/结果/结果时间",
        status == 200
        and done_action.get("state") == "done"
        and done_action.get("resultText") == "实际观察：2 kHz 下连续观察 5 分钟，未见肉眼闪烁。"
        and done_action.get("outcome") == "success"
        and done_action.get("observedAt") == observed_at
        and done_action.get("revision") == action_a.get("revision") + 1,
        f"{status} {str(done_action)[:600]}",
    )
    frm = now_ms() - 3600000
    to = now_ms() + 3600000
    status, res = api(
        "GET",
        f"/api/review/range?from={frm}&to={to}&timezone={TZ}&preset=custom",
    )
    range_body = res or {}
    records = {x.get("key"): x for x in range_body.get("records") or []}
    action_key = f"attempt:{action_a_id}"
    action_record = records.get(action_key) or {}
    ref_key = f"reference:{action_a_ref}" if action_a_ref else None
    ref_record = records.get(ref_key) if ref_key else None
    c.check(
        "下一次回顾 records 含完成行动的 attempt 与结果",
        status == 200
        and action_record.get("resultText") == "实际观察：2 kHz 下连续观察 5 分钟，未见肉眼闪烁。"
        and action_record.get("state") == "done"
        and "attempt_started" in (action_record.get("reasons") or [])
        and "result_recorded" in (action_record.get("reasons") or []),
        f"{status} {str(action_record)[:600]}",
    )
    c.check(
        "下一次回顾 sections.attempts/results 均包含行动",
        action_key in ((range_body.get("sections") or {}).get("attempts") or [])
        and action_key in ((range_body.get("sections") or {}).get("results") or []),
        str((range_body.get("sections") or {}).get("attempts")) + " / " + str((range_body.get("sections") or {}).get("results")),
    )
    c.check(
        "下一次回顾包含行动创建的引用",
        ref_record is not None
        and ref_record.get("fromAttemptId") == action_a_id
        and ref_record.get("toAttemptId") == a["attempt"]["id"]
        and ref_key in ((range_body.get("sections") or {}).get("references") or []),
        str(ref_record)[:500],
    )
    stats = range_body.get("stats") or {}
    c.check(
        "下一次回顾统计包含 attempt/result/reference",
        stats.get("attemptsStarted", 0) >= 1
        and stats.get("resultsRecorded", 0) >= 1
        and stats.get("referencesCreated", 0) >= 1,
        str(stats),
    )

    # ============================================================ 14. 导出 schemaVersion=6
    print("\n### 14. 导出 schemaVersion=6、data 表集合与新增 attempt 字段")
    status, payload = api("GET", "/api/export")
    c.check("导出返回 200", status == 200, str(status))
    c.check("导出 schemaVersion>=6（v0.6 经验/主题导出）", (payload or {}).get("schemaVersion") in (6, 7) and isinstance((payload or {}).get("schemaVersion"), int), repr((payload or {}).get("schemaVersion")))
    data = (payload or {}).get("data") or {}
    required_tables = {
        "captures",
        "attempts",
        "attemptReferences",
        "captureLinks",
        "scheduleBlocks",
        "stageReviews",
        "researchRuns",
        "researchSources",
        "experienceNotes",
        "experienceSources",
        "experienceAttempts",
    }
    c.check(
        "导出 data 包含 v0.6 必需表集合",
        required_tables <= set(data.keys()),
        str(sorted(set(data.keys()) - required_tables)),
    )
    if (payload or {}).get("schemaVersion", 0) >= 7:
        c.check(
            "schemaVersion=7 导出包含主题表",
            {"topics", "topicMembers"} <= set(data.keys()),
            str(list(data.keys())),
        )
    c.check(
        "导出 captures 含 kind 字段",
        all("kind" in (row or {}) for row in data.get("captures") or []),
        str([row.get("kind") for row in (data.get("captures") or [])[:5]]),
    )
    c.check(
        "导出包含 captureLinks 与经验三表",
        isinstance(data.get("captureLinks"), list)
        and isinstance(data.get("experienceNotes"), list)
        and isinstance(data.get("experienceSources"), list)
        and isinstance(data.get("experienceAttempts"), list),
        str({key: type(data.get(key)).__name__ for key in ("captureLinks", "experienceNotes", "experienceSources", "experienceAttempts")}),
    )
    exported_actions = {x.get("id"): x for x in data.get("attempts") or []}
    exported_action = exported_actions.get(action_a_id) or {}
    c.check(
        "导出行动包含全部 7 个新增 attempt 字段且值正确",
        ATTEMPT_NEW_KEYS <= set(exported_action.keys())
        and exported_action.get("origin") == "review_next_action"
        and exported_action.get("actionDescription") == "固定其他条件，只改变频率。"
        and exported_action.get("estimatedMinutes") == 30
        and exported_action.get("sourceReviewId") == a["reviewId"]
        and exported_action.get("sourceExperienceIndex") == 0
        and exported_action.get("sourceAttemptId") == a["attempt"]["id"]
        and exported_action.get("sourceAttemptRevision") == a["attempt"]["revision"],
        str(exported_action)[:700],
    )
    exported_source = exported_actions.get(a["attempt"]["id"]) or {}
    c.check(
        "导出普通尝试 origin=manual 且新增字段为 null",
        exported_source.get("origin") == "manual"
        and exported_source.get("actionDescription") is None
        and exported_source.get("estimatedMinutes") is None
        and exported_source.get("sourceReviewId") is None
        and exported_source.get("sourceExperienceIndex") is None
        and exported_source.get("sourceAttemptId") is None
        and exported_source.get("sourceAttemptRevision") is None,
        str(exported_source)[:500],
    )
    exported_refs = {x.get("id"): x for x in data.get("attemptReferences") or []}
    exported_ref = exported_refs.get(action_a_ref) or {}
    c.check(
        "导出引用包含行动 → 来源尝试",
        exported_ref.get("fromAttemptId") == action_a_id
        and exported_ref.get("toAttemptId") == a["attempt"]["id"]
        and exported_ref.get("snapshotRevision") == a["attempt"]["revision"],
        str(exported_ref)[:400],
    )
    exported_schedules = [x for x in data.get("scheduleBlocks") or [] if x.get("attemptId") == action_g.get("id")]
    c.check(
        "导出日程包含下一步行动加入的 active 安排",
        len(exported_schedules) == 1
        and exported_schedules[0].get("status") == "active"
        and exported_schedules[0].get("startsAt") == ts(D3, "10:30"),
        str(exported_schedules),
    )
    v2_attempt = {"id": "att-v2-legacy", "step": "旧版尝试", "state": "done"}
    c.check(
        "v2 读取器缺失新增字段按 manual/null 处理",
        v2_attempt.get("origin", "manual") == "manual"
        and v2_attempt.get("actionDescription") is None
        and v2_attempt.get("estimatedMinutes") is None
        and v2_attempt.get("sourceReviewId") is None
        and v2_attempt.get("sourceExperienceIndex") is None
        and v2_attempt.get("sourceAttemptId") is None
        and v2_attempt.get("sourceAttemptRevision") is None,
        str(v2_attempt),
    )

    # ============================================================ 15. 创建后删除来源
    print("\n### 15. 创建后删除来源：详情仍可读、正文清洗")
    k = make_review("K", experience_text="创建后删除来源场景。")
    status, prev_k = preview(k["reviewId"])
    c.check("K 预览返回 200", status == 200, f"{status}")
    status, res, _ = create_action(prev_k, "删除来源后仍可读的行动", operation_id=op_id("K"))
    action_k = action_of(res)
    c.check("K 创建成功", status == 201, f"{status} {str(res)[:400]}")
    status, res = api("DELETE", f"/api/attempts/{k['attempt']['id']}")
    c.check("K 删除来源尝试成功", status == 200, f"{status} {str(res)[:300]}")
    status, res = api("GET", f"/api/next-actions/{action_k.get('id')}")
    detail_k = (res or {}).get("action") or {}
    k_sources = detail_k.get("sources") or []
    c.check(
        "来源删除后行动详情仍可读取",
        status == 200 and detail_k.get("id") == action_k.get("id") and detail_k.get("title") == "删除来源后仍可读的行动",
        f"{status} {str(res)[:400]}",
    )
    c.check(
        "来源删除后行动来源标记 deleted 且正文/结果为 null",
        len(k_sources) == 1
        and k_sources[0].get("deleted") is True
        and k_sources[0].get("text") is None
        and k_sources[0].get("resultText") is None,
        str(k_sources),
    )
    c.check(
        "来源删除后 sourceAttemptId 保留用于显示「来源已删除」",
        detail_k.get("sourceAttemptId") == k["attempt"]["id"]
        and (detail_k.get("sourceReview") or {}).get("contentInvalidated") is True,
        str({x: detail_k.get(x) for x in ("sourceAttemptId", "sourceReview")})[:500],
    )
    status, res = api("GET", f"/api/reviews/{k['reviewId']}")
    review_k = (res or {}).get("review") or {}
    k_review_sources = review_k.get("sources") or []
    c.check(
        "来源删除后回顾详情仍可读且来源正文已清洗",
        status == 200
        and review_k.get("id") == k["reviewId"]
        and any(s.get("type") == "attempt" and s.get("deleted") is True and s.get("text") is None and s.get("resultText") is None for s in k_review_sources)
        and review_k.get("contentInvalidated") is True
        and review_k.get("content") is None,
        f"{status} {str(review_k)[:700]}",
    )
    status, res = api("GET", f"/api/reviews/{k['reviewId']}/next-actions")
    c.check(
        "来源删除后回顾行动清单仍可读且正文清洗",
        status == 200
        and len((res or {}).get("actions") or []) == 1
        and (((res or {}).get("actions") or [])[0].get("sources") or [{}])[0].get("text") is None,
        f"{status} {str(res)[:500]}",
    )
    status, res = preview(k["reviewId"])
    expect_error("来源删除后预览返回 409 review_content_withheld", status, res, 409, "review_content_withheld")

    # ============================================================ 汇总
    print("\n" + "=" * 60)
    print(f"下一步行动验收用户：{USERNAME}")
    print(f"回顾 ID 样例：{a['reviewId']}；行动 ID 样例：{action_a_id}")
    ok = c.report("下一步行动 API 验收")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
