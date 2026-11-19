"""拾念 SHINIAN v0.1 - JSON 导出功能测试

自包含：
- 使用独立测试库（默认 db/export-test.sqlite，绝不使用 db/shinian.sqlite）
- 在独立端口（默认 3400）自行启动/停止 Fastify 服务
- 支持 SHINIAN_BASE 覆盖 base（端口从 base 推导），SHINIAN_EXPORT_TEST_DB 覆盖数据库路径

覆盖：
- 未登录导出 401
- 空数据库导出
- 中文/换行/引号/反斜杠/emoji/<script> 往返
- 归档 archivedAt
- 交叉引用与来源编辑后的旧快照
- 内部数据（账号/回执/Cookie 等）排除
- 下载响应头
- 导出后原库仍可读写
"""
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 3400
BASE = os.environ.get("SHINIAN_BASE", f"http://127.0.0.1:{DEFAULT_PORT}").rstrip("/")
PARSED = urllib.parse.urlparse(BASE)
HOST = PARSED.hostname or "127.0.0.1"
PORT = PARSED.port or (443 if PARSED.scheme == "https" else 80)
TEST_DB = os.environ.get(
    "SHINIAN_EXPORT_TEST_DB", os.path.join(ROOT, "db", "export-test.sqlite")
)
SERVER_LOG = os.path.join(ROOT, "db", "export-test-server.log")
NODE = os.environ.get("NODE", "node")
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
FORBIDDEN_PORTS = {3000, 3100, 3200}

CAPTURE_KEYS = {"id", "rawText", "revision", "createdAt", "updatedAt", "archivedAt", "kind"}
ATTEMPT_KEYS = {
    "id",
    "captureId",
    "step",
    "state",
    "resultText",
    "outcome",
    "sourceUrl",
    "observedAt",
    "revision",
    "createdAt",
    "updatedAt",
    # schemaVersion=3：下一步行动新增字段
    "origin",
    "actionDescription",
    "estimatedMinutes",
    "sourceReviewId",
    "sourceExperienceIndex",
    "sourceAttemptId",
    "sourceAttemptRevision",
    # schemaVersion=4：研究来源关联字段
    "sourceResearchId",
    "sourceResearchExperimentIndex",
    "researchSuggestedJson",
    "researchSourceIdsJson",
}
REFERENCE_KEYS = {
    "id",
    "fromAttemptId",
    "toAttemptId",
    "revision",
    "note",
    "snapshotResultText",
    "snapshotRevision",
    "createdAt",
}
REVIEW_EXPORT_KEYS = {
    "id",
    "status",
    "rangeFrom",
    "rangeTo",
    "timezone",
    "preset",
    "stats",
    "coverage",
    "content",
    "sources",
    "configName",
    "modelId",
    "savedAt",
    "createdAt",
    "contentInvalidatedAt",
    "contentInvalidReason",
}
SCHEDULE_EXPORT_KEYS = {
    "id",
    "attemptId",
    "startsAt",
    "endsAt",
    "timezone",
    "note",
    "status",
    "revision",
    "createdAt",
    "updatedAt",
    "cancelledAt",
}

SPECIAL_TEXT = (
    '中文第一行：引号 "双引号"、\'单引号\'、反斜杠 \\、制表\t与换行\n'
    '第二行：emoji 😀🚀 <script>alert("x")</script> & <b>粗体</b>'
)
ARCHIVED_TEXT = "归档测试：这条会被归档 😴"
SOURCE_ORIGINAL = 'B 的原始结果第一行\n第二行 "引号"、反斜杠 \\、emoji 😀'
SOURCE_UPDATED = "B 的结果已更新（v2）：旧快照应保持不变"
NOTE_TEXT = "这次先复用 B 的结论\n注意：来源更新后仍查看旧快照"
SOURCE_URL = "https://example.com/lab?q=闪烁&x=1"

proc = None
log_handle = None


def port_is_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def remove_db_files(retries: int = 30) -> None:
    """删除测试库；Windows 上进程刚退出时文件句柄可能延迟释放。"""
    for suffix in ("", "-wal", "-shm"):
        path = TEST_DB + suffix
        for attempt in range(retries):
            if not os.path.exists(path):
                break
            try:
                os.remove(path)
                break
            except PermissionError:
                if attempt == retries - 1:
                    raise
                time.sleep(0.1)


def start_server() -> None:
    global proc, log_handle
    env = dict(os.environ)
    env["PORT"] = str(PORT)
    env["HOST"] = HOST
    env["DATABASE_URL"] = TEST_DB
    env["SESSION_SECRET"] = f"export-test-secret-{uuid.uuid4().hex[:10]}"
    log_handle = open(SERVER_LOG, "wb")
    proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError(
                f"测试服务进程提前退出（code={proc.returncode}），日志见 {SERVER_LOG}"
            )
        try:
            urllib.request.urlopen(BASE + "/api/session/check", timeout=1)
        except urllib.error.HTTPError:
            return  # 401 说明服务已就绪
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"测试服务未能启动，日志见 {SERVER_LOG}")


def stop_server() -> None:
    global proc, log_handle
    if proc is not None:
        # tsx CLI 在 Windows 上会派生子 node 进程，按进程树结束，确保端口与数据库句柄释放
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        proc = None
    for _ in range(50):
        if not port_is_open(HOST, PORT):
            break
        time.sleep(0.1)
    if log_handle is not None:
        log_handle.close()
        log_handle = None


def raw_get(client: Client, path: str):
    """GET 原始字节 + 响应头（保留 cookie），用于下载类接口。"""
    req = urllib.request.Request(
        client.base + path,
        method="GET",
        headers={"Accept": "application/json, */*"},
    )
    try:
        with client.opener.open(req, timeout=20) as res:
            headers = {k.lower(): v for k, v in res.headers.items()}
            return res.status, headers, res.read()
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in e.headers.items()}
        return e.code, headers, e.read()


def call_export(client: Client):
    """返回 (status, headers, text)；严格按 UTF-8 解码。"""
    status, headers, raw = raw_get(client, "/api/export")
    text = raw.decode("utf-8")  # 解码失败即测试失败
    return status, headers, text


def insert_stage_review_fixtures(capture: dict, attempt: dict):
    """直接插入一条已保存、一条失败的 stage_reviews，保持导出测试不依赖假模型。

    已保存行带完整 stats/coverage/content/sources；失败行未保存且没有内容，
    用于断言导出只包含已保存回顾。
    """
    saved_id = f"rev-export-saved-{capture['id']}"
    failed_id = f"rev-export-failed-{capture['id']}"
    range_from = int(capture["createdAt"]) - 86400000
    range_to = int(capture["createdAt"]) + 86400000
    saved_at = int(capture["createdAt"]) + 1000
    created_at = int(capture["createdAt"]) + 500
    capture_key = f"capture:{capture['id']}"
    attempt_key = f"attempt:{attempt['id']}"
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
    content = {
        "overview": "导出测试概览：这段时间记录了一条念头和一次尝试。",
        "attempts": [{"text": "你实际记录了一次来源尝试。", "basis": "observation", "sourceIds": [attempt_key]}],
        "observations": [{"text": "结果文本在导出中应完整保留。", "basis": "observation", "sourceIds": [attempt_key]}],
        "connections": [{"text": "这条结果与念头相关。", "basis": "inference", "sourceIds": [capture_key]}],
        "experiences": [{"text": "下次可复用这条结果。", "basis": "inference", "sourceIds": [attempt_key]}],
        "uncertainties": ["只有一次记录。"],
        "insufficientData": False,
        "dataNotes": None,
    }
    sources = [
        {
            "key": capture_key,
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
        },
        {
            "key": attempt_key,
            "type": "attempt",
            "sourceId": attempt["id"],
            "captureId": capture["id"],
            "attemptId": attempt["id"],
            "relatedAttemptId": None,
            "title": attempt["step"][:60],
            "text": attempt["step"],
            "resultText": attempt["resultText"],
            "outcome": attempt["outcome"],
            "state": attempt["state"],
            "observedAt": attempt.get("observedAt"),
            "revision": attempt["revision"],
            "captureRevision": capture["revision"],
            "relatedRevision": None,
            "createdAt": attempt["createdAt"],
            "updatedAt": attempt["updatedAt"],
        },
    ]
    with closing(sqlite3.connect(TEST_DB, timeout=20)) as conn:
        conn.execute(
            "INSERT INTO stage_reviews (id, status, range_from, range_to, timezone, range_preset, "
            "stats_json, coverage_json, content_json, sources_json, config_id, config_version, config_name, "
            "model_id, saved_at, created_at, updated_at, finished_at) "
            "VALUES (?, 'succeeded', ?, ?, 'Asia/Shanghai', 'custom', ?, ?, ?, ?, 'default', 1, '导出验证模型', "
            "'fake-export', ?, ?, ?, ?)",
            (
                saved_id,
                range_from,
                range_to,
                json.dumps(stats, ensure_ascii=False),
                json.dumps(coverage, ensure_ascii=False),
                json.dumps(content, ensure_ascii=False),
                json.dumps(sources, ensure_ascii=False),
                saved_at,
                created_at,
                created_at,
                created_at,
            ),
        )
        conn.execute(
            "INSERT INTO stage_reviews (id, status, range_from, range_to, timezone, range_preset, "
            "error_code, error_detail, created_at, updated_at, finished_at) "
            "VALUES (?, 'failed', ?, ?, 'Asia/Shanghai', 'custom', 'invalid_response', '导出测试失败行', ?, ?, ?)",
            (failed_id, range_from, range_to, created_at + 1, created_at + 1, created_at + 1),
        )
        conn.commit()
    return saved_id, failed_id, saved_at, stats, coverage, content, sources


def main() -> int:
    if PARSED.scheme != "http" or HOST not in ("127.0.0.1", "localhost"):
        print(f"仅支持本机 http base，当前 SHINIAN_BASE={BASE}")
        return 2
    if PORT in FORBIDDEN_PORTS:
        print(f"端口 {PORT} 属于主服务/既有测试服务，导出测试拒绝使用")
        return 2
    if not os.path.exists(TSX):
        print(f"找不到 tsx：{TSX}")
        return 2
    if port_is_open(HOST, PORT):
        print(f"端口 {PORT} 已被占用，请先停止占用进程（测试不会触碰 3000/3100/3200）")
        return 2

    db_dir = os.path.dirname(TEST_DB)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    remove_db_files()
    if os.path.exists(SERVER_LOG):
        os.remove(SERVER_LOG)

    checker = Checker()
    success = False
    client = Client(base=BASE)
    uid = uuid.uuid4().hex[:8]
    username = f"导出测试用户-{uid}"
    op_attempt_b = f"op-export-attb-{uid}"
    op_attempt_a = f"op-export-atta-{uid}"
    op_reference = f"op-export-ref-{uid}"

    try:
        print(f"启动测试服务 {BASE}（数据库 {TEST_DB}）")
        start_server()

        # ---------- 未登录导出 401 ----------
        anon = Client(base=BASE)
        status, headers, raw = raw_get(anon, "/api/export")
        anon_text = raw.decode("utf-8", "replace")
        try:
            anon_body = json.loads(anon_text)
        except json.JSONDecodeError:
            anon_body = None
        checker.check("未登录导出返回 401", status == 401, f"{status} {anon_text[:200]}")
        checker.check(
            "未登录导出返回可理解的 JSON 错误",
            isinstance(anon_body, dict) and bool(anon_body.get("error")),
            anon_text[:200],
        )
        checker.check(
            "未登录错误不泄露内部细节",
            "sqlite" not in anon_text.lower() and "stack" not in anon_text.lower(),
            anon_text[:200],
        )

        # ---------- 登录与空库导出 ----------
        login_body = client.login(username)
        checker.check("创建/登录本机账号", login_body.get("ok") is True, str(login_body))

        status, headers, text = call_export(client)
        checker.check("空数据库可导出（200）", status == 200, f"{status} {text[:200]}")
        empty_payload = json.loads(text)
        checker.check(
            "顶层字段完整且仅含 schemaVersion/appVersion/exportedAt/data",
            set(empty_payload.keys()) == {"schemaVersion", "appVersion", "exportedAt", "data"},
            str(list(empty_payload.keys())),
        )
        checker.check(
            "schemaVersion 为数字 6+（当前 7）",
            empty_payload.get("schemaVersion") in (6, 7)
            and isinstance(empty_payload.get("schemaVersion"), int),
            repr(empty_payload.get("schemaVersion")),
        )
        checker.check(
            "appVersion 为 0.1.0",
            empty_payload.get("appVersion") == "0.1.0",
            repr(empty_payload.get("appVersion")),
        )
        exported_at = empty_payload.get("exportedAt")
        try:
            parsed_at = datetime.fromisoformat(str(exported_at).replace("Z", "+00:00"))
            iso_ok = (
                isinstance(exported_at, str)
                and re.fullmatch(
                    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", exported_at
                )
                is not None
                and parsed_at.tzinfo is not None
            )
        except ValueError:
            iso_ok = False
        checker.check("exportedAt 为带时区的 ISO 8601 字符串", iso_ok, repr(exported_at))
        empty_data = empty_payload.get("data") or {}
        checker.check(
            "空库 data 含全部已登记业务表",
            set(empty_data.keys())
            == {
                "captures",
                "attempts",
                "attemptReferences",
                "captureLinks",                "stageReviews",
                "scheduleBlocks",
                "researchRuns",
                "researchSources",
                "experienceNotes",
                "experienceSources",
                "experienceAttempts",
                "topics",
                "topicMembers",
            },
            str(list(empty_data.keys())),
        )
        checker.check("空库 captures 为空数组", empty_data.get("captures") == [], str(empty_data.get("captures")))
        checker.check("空库 attempts 为空数组", empty_data.get("attempts") == [], str(empty_data.get("attempts")))
        checker.check(
            "空库 attemptReferences 为空数组",
            empty_data.get("attemptReferences") == [],
            str(empty_data.get("attemptReferences")),
        )
        checker.check("空库 stageReviews 为空数组", empty_data.get("stageReviews") == [], str(empty_data.get("stageReviews")))
        checker.check("空库 scheduleBlocks 为空数组", empty_data.get("scheduleBlocks") == [], str(empty_data.get("scheduleBlocks")))

        # ---------- 准备数据 ----------
        status, res = client.post("/api/captures", {"rawText": SPECIAL_TEXT})
        checker.check("保存特殊字符念头（200）", status == 200, f"{status} {res}")
        cap_special = res["capture"]
        checker.check("服务端原样保存特殊字符", cap_special["rawText"] == SPECIAL_TEXT, repr(cap_special["rawText"]))

        status, res = client.post("/api/captures", {"rawText": ARCHIVED_TEXT})
        checker.check("保存待归档念头（200）", status == 200, f"{status} {res}")
        cap_archived = res["capture"]
        status, res = client.post(f"/api/captures/{cap_archived['id']}/archive", {})
        checker.check("归档念头成功", status == 200 and res["capture"]["archivedAt"] is not None, f"{status} {res}")
        cap_archived = res["capture"]

        status, res = client.post(
            f"/api/captures/{cap_special['id']}/attempts",
            {
                "step": "来源尝试 B：测量闪烁",
                "state": "done",
                "resultText": SOURCE_ORIGINAL,
                "outcome": "failure",
                "sourceUrl": SOURCE_URL,
                "operationId": op_attempt_b,
            },
        )
        checker.check("创建来源尝试 B（200）", status == 200, f"{status} {res}")
        attempt_b = res["attempt"]
        checker.check("来源尝试 B 初始 revision=1", attempt_b["revision"] == 1, str(attempt_b["revision"]))

        status, res = client.post(
            f"/api/captures/{cap_archived['id']}/attempts",
            {
                "step": "引用尝试 A：复用 B 的结论",
                "state": "in_progress",
                "operationId": op_attempt_a,
            },
        )
        checker.check("创建引用尝试 A（200）", status == 200, f"{status} {res}")
        attempt_a = res["attempt"]

        status, res = client.post(
            f"/api/attempts/{attempt_a['id']}/references",
            {"toId": attempt_b["id"], "note": NOTE_TEXT, "operationId": op_reference},
        )
        checker.check("创建 A → B 引用（200）", status == 200, f"{status} {res}")
        reference = res["reference"]
        checker.check(
            "引用保存快照文本与版本",
            reference["snapshotResultText"] == SOURCE_ORIGINAL
            and reference["snapshotRevision"] == attempt_b["revision"],
            str(reference),
        )

        # 编辑来源：快照应保持不变
        status, res = client.get(f"/api/attempts/{attempt_b['id']}")
        current_b = res["attempt"]
        status, res = client.patch(
            f"/api/attempts/{attempt_b['id']}",
            {
                "state": "done",
                "resultText": SOURCE_UPDATED,
                "outcome": "success",
                "revision": current_b["revision"],
            },
        )
        checker.check(
            "编辑来源尝试结果成功（revision 递增）",
            status == 200 and res["attempt"]["revision"] == 2,
            f"{status} {res}",
        )
        attempt_b_latest = res["attempt"]

        # ---------- 写入阶段回顾导出样本（直接插库，避免依赖假模型） ----------
        review_saved_id, review_failed_id, review_saved_at, review_stats, review_coverage, review_content, review_sources = (
            insert_stage_review_fixtures(cap_special, res["attempt"])
        )
        checker.check(
            "已准备一条 saved 与一条 failed 阶段回顾",
            bool(review_saved_id and review_failed_id),
            f"{review_saved_id} / {review_failed_id}",
        )

        # ---------- 日程导出样本（schemaVersion=2 的 scheduleBlocks） ----------
        schedule_day = "2027-06-15"
        status, res = client.post(
            f"/api/attempts/{attempt_a['id']}/schedules",
            {
                "date": schedule_day,
                "startTime": "09:00",
                "endTime": "10:00",
                "timezone": "Asia/Shanghai",
                "note": "导出日程 A：active",
                "operationId": f"op-export-sch-a-{uid}",
            },
        )
        checker.check("创建导出用日程 A（200/201）", status in (200, 201), f"{status} {res}")
        schedule_a = (res or {}).get("schedule") or {}
        status, res = client.post(
            f"/api/attempts/{attempt_a['id']}/schedules",
            {
                "date": schedule_day,
                "startTime": "11:00",
                "endTime": "12:00",
                "timezone": "Asia/Shanghai",
                "note": "导出日程 B：cancelled",
                "operationId": f"op-export-sch-b-{uid}",
            },
        )
        checker.check("创建导出用日程 B（200/201）", status in (200, 201), f"{status} {res}")
        schedule_b = (res or {}).get("schedule") or {}
        status, res = client.post(
            f"/api/schedules/{schedule_b['id']}/cancel",
            {"revision": schedule_b.get("revision")},
        )
        checker.check("取消导出用日程 B", status == 200 and (res or {}).get("schedule", {}).get("status") == "cancelled", f"{status} {res}")
        schedule_b = (res or {}).get("schedule") or schedule_b

        # ---------- 下一步行动（schemaVersion=3 的 7 个 attempt 字段） ----------
        status, res = client.get(
            f"/api/reviews/{review_saved_id}/next-action-preview?experienceIndex=0"
        )
        checker.check("已保存回顾可预览下一步行动", status == 200, f"{status} {str(res)[:400]}")
        preview_body = res or {}
        defaults = preview_body.get("defaults") or {}
        preview_capture = next(
            (x for x in preview_body.get("captures") or [] if x.get("id") == defaults.get("captureId")),
            None,
        )
        checker.check("下一步预览返回真实 capture 与 contextToken", bool(preview_capture) and bool(preview_body.get("contextToken")), str(preview_body)[:500])
        next_action_schedule_day = "2027-06-16"
        status, res = client.post(
            f"/api/reviews/{review_saved_id}/next-actions",
            {
                "captureId": defaults.get("captureId"),
                "captureRevision": (preview_capture or {}).get("revision"),
                "experienceIndex": 0,
                "title": "【导出】下一步行动：复测 2 kHz 闪烁",
                "description": "固定其他条件，只改变频率。",
                "estimatedMinutes": 25,
                "contextToken": preview_body.get("contextToken"),
                "operationId": f"op-export-next-action-{uid}",
                "schedule": {
                    "date": next_action_schedule_day,
                    "endDate": next_action_schedule_day,
                    "startTime": "09:30",
                    "endTime": "10:00",
                    "timezone": "Asia/Shanghai",
                    "note": "导出下一步日程",
                },
            },
        )
        checker.check("创建导出用下一步行动（201）", status == 201, f"{status} {res}")
        next_action = (res or {}).get("nextAction") or {}
        next_action_id = next_action.get("id")
        next_action_schedule = (next_action.get("schedules") or [{}])[0]
        checker.check(
            "下一步行动来源字段与日程正确",
            next_action.get("origin") == "review_next_action"
            and next_action.get("sourceReviewId") == review_saved_id
            and next_action.get("sourceExperienceIndex") == 0
            and next_action.get("sourceAttemptId") == attempt_b_latest["id"]
            and next_action.get("sourceAttemptRevision") == attempt_b_latest["revision"]
            and next_action.get("description") == "固定其他条件，只改变频率。"
            and next_action.get("estimatedMinutes") == 25
            and len(next_action.get("schedules") or []) == 1,
            str(next_action)[:500],
        )

        # ---------- 下载响应头 ----------
        status, headers, text = call_export(client)
        content_type = headers.get("content-type", "")
        disposition = headers.get("content-disposition", "")
        checker.check("带数据导出返回 200", status == 200, str(status))
        checker.check(
            "Content-Type 含 application/json 与 charset=utf-8",
            "application/json" in content_type.lower() and "charset=utf-8" in content_type.lower(),
            content_type,
        )
        checker.check("Content-Disposition 含 attachment", "attachment" in disposition.lower(), disposition)
        checker.check(
            "下载文件名为 shinian-export-YYYYMMDD-HHmmss.json",
            re.search(r'filename="shinian-export-\d{8}-\d{6}\.json"', disposition) is not None,
            disposition,
        )
        checker.check("响应采用 no-store 缓存策略", "no-store" in headers.get("cache-control", "").lower(), headers.get("cache-control", ""))
        checker.check("响应体可按 UTF-8 严格解码", isinstance(text, str) and len(text) > 0)

        payload = json.loads(text)
        data = payload["data"]
        captures = data["captures"]
        attempts = data["attempts"]
        references = data["attemptReferences"]

        cap_map = {c["id"]: c for c in captures}
        att_map = {a["id"]: a for a in attempts}
        ref_map = {r["id"]: r for r in references}

        checker.check("导出包含 2 条念头", len(captures) == 2, str(len(captures)))
        checker.check("导出包含 3 条尝试（含下一步行动）", len(attempts) == 3, str(len(attempts)))
        checker.check("导出包含 2 条引用（含下一步来源引用）", len(references) == 2, str(len(references)))
        checker.check(
            "captures 字段与要求完全一致",
            all(set(c.keys()) == CAPTURE_KEYS for c in captures),
            str([sorted(c.keys()) for c in captures]),
        )
        checker.check(
            "attempts 字段与要求完全一致",
            all(set(a.keys()) == ATTEMPT_KEYS for a in attempts),
            str([sorted(a.keys()) for a in attempts]),
        )
        exported_next = att_map.get(next_action_id)
        checker.check(
            "导出下一步行动 7 个新增字段值与来源正确",
            exported_next is not None
            and exported_next.get("origin") == "review_next_action"
            and exported_next.get("actionDescription") == "固定其他条件，只改变频率。"
            and exported_next.get("estimatedMinutes") == 25
            and exported_next.get("sourceReviewId") == review_saved_id
            and exported_next.get("sourceExperienceIndex") == 0
            and exported_next.get("sourceAttemptId") == attempt_b_latest["id"]
            and exported_next.get("sourceAttemptRevision") == attempt_b_latest["revision"],
            str(exported_next)[:600],
        )
        exported_source_b = att_map.get(attempt_b_latest["id"])
        checker.check(
            "导出普通尝试缺失新语义时视为 origin=manual / 其余 null",
            exported_source_b is not None
            and exported_source_b.get("origin") == "manual"
            and exported_source_b.get("actionDescription") is None
            and exported_source_b.get("estimatedMinutes") is None
            and exported_source_b.get("sourceReviewId") is None
            and exported_source_b.get("sourceExperienceIndex") is None
            and exported_source_b.get("sourceAttemptId") is None
            and exported_source_b.get("sourceAttemptRevision") is None,
            str(exported_source_b)[:500],
        )
        checker.check(
            "attemptReferences 字段与要求完全一致",
            all(set(r.keys()) == REFERENCE_KEYS for r in references),
            str([sorted(r.keys()) for r in references]),
        )

        # ---------- 中文/换行/特殊字符往返 ----------
        exported_special = cap_map.get(cap_special["id"])
        checker.check(
            "中文/换行/特殊字符完整往返",
            exported_special is not None and exported_special["rawText"] == SPECIAL_TEXT,
            repr(exported_special["rawText"]) if exported_special else "missing",
        )
        checker.check(
            "特殊字符内容逐项保留（引号/反斜杠/emoji/script/换行）",
            exported_special is not None
            and '"双引号"' in exported_special["rawText"]
            and "\\" in exported_special["rawText"]
            and "😀🚀" in exported_special["rawText"]
            and "<script>alert(\"x\")</script>" in exported_special["rawText"]
            and "\n" in exported_special["rawText"],
            repr(exported_special["rawText"]) if exported_special else "missing",
        )

        # ---------- 归档 ----------
        exported_archived = cap_map.get(cap_archived["id"])
        checker.check(
            "归档记录 archivedAt 为非空时间戳",
            exported_archived is not None
            and isinstance(exported_archived["archivedAt"], int)
            and exported_archived["archivedAt"] > 0,
            str(exported_archived.get("archivedAt") if exported_archived else None),
        )
        checker.check(
            "未归档记录 archivedAt 为 null",
            exported_special is not None and exported_special["archivedAt"] is None,
            str(exported_special.get("archivedAt") if exported_special else None),
        )

        # ---------- 尝试字段 ----------
        exported_b = att_map.get(attempt_b["id"])
        exported_a = att_map.get(attempt_a["id"])
        checker.check(
            "来源尝试 B 字段正确且为编辑后的最新值",
            exported_b is not None
            and exported_b["captureId"] == cap_special["id"]
            and exported_b["step"] == "来源尝试 B：测量闪烁"
            and exported_b["state"] == "done"
            and exported_b["resultText"] == SOURCE_UPDATED
            and exported_b["outcome"] == "success"
            and exported_b["sourceUrl"] == SOURCE_URL
            and isinstance(exported_b["observedAt"], int)
            and exported_b["revision"] == 2,
            str(exported_b),
        )
        checker.check(
            "引用尝试 A 字段正确（无结果的进行中尝试）",
            exported_a is not None
            and exported_a["captureId"] == cap_archived["id"]
            and exported_a["step"] == "引用尝试 A：复用 B 的结论"
            and exported_a["state"] == "in_progress"
            and exported_a["resultText"] is None
            and exported_a["outcome"] is None
            and exported_a["revision"] == 1,
            str(exported_a),
        )

        # ---------- 交叉引用与旧快照 ----------
        exported_ref = ref_map.get(reference["id"])
        checker.check(
            "引用 fromAttemptId/toAttemptId 正确",
            exported_ref is not None
            and exported_ref["fromAttemptId"] == attempt_a["id"]
            and exported_ref["toAttemptId"] == attempt_b["id"],
            str(exported_ref),
        )
        checker.check(
            "引用快照文本保持引用时内容（来源编辑后不变）",
            exported_ref is not None and exported_ref["snapshotResultText"] == SOURCE_ORIGINAL,
            repr(exported_ref.get("snapshotResultText") if exported_ref else None),
        )
        checker.check(
            "引用 snapshotRevision 固定为引用时版本 1",
            exported_ref is not None and exported_ref["snapshotRevision"] == 1,
            str(exported_ref.get("snapshotRevision") if exported_ref else None),
        )
        checker.check(
            "引用 note 完整往返",
            exported_ref is not None and exported_ref["note"] == NOTE_TEXT,
            repr(exported_ref.get("note") if exported_ref else None),
        )
        exported_next_ref = next(
            (
                r
                for r in references
                if r.get("fromAttemptId") == next_action_id
                and r.get("toAttemptId") == attempt_b["id"]
            ),
            None,
        )
        checker.check(
            "导出下一步行动的来源引用正确且带来源版本快照",
            exported_next_ref is not None
            and exported_next_ref.get("snapshotRevision") == attempt_b_latest["revision"]
            and exported_next_ref.get("snapshotResultText") == attempt_b_latest["resultText"],
            str(exported_next_ref),
        )
        checker.check(
            "来源已更新但导出中快照仍为旧文本",
            exported_ref is not None
            and exported_b is not None
            and exported_ref["snapshotResultText"] != exported_b["resultText"]
            and exported_ref["snapshotRevision"] != exported_b["revision"],
            "snapshot != latest",
        )

        # ---------- 阶段回顾导出（schemaVersion=4） ----------
        stage_reviews = data.get("stageReviews")
        checker.check("带数据导出 schemaVersion>=6", payload.get("schemaVersion") in (6, 7), repr(payload.get("schemaVersion")))
        checker.check("data.stageReviews 为数组", isinstance(stage_reviews, list), str(type(stage_reviews)))
        checker.check("导出只包含 1 条已保存阶段回顾", len(stage_reviews or []) == 1, str([r.get("id") for r in stage_reviews or []]))
        exported_review = next((r for r in stage_reviews or [] if r.get("id") == review_saved_id), None)
        checker.check(
            "导出回顾字段与契约一致",
            exported_review is not None and set(exported_review.keys()) == REVIEW_EXPORT_KEYS,
            str(sorted(exported_review.keys()) if exported_review else None),
        )
        checker.check(
            "导出回顾 range/status/savedAt 正确",
            exported_review is not None
            and exported_review.get("status") == "succeeded"
            and exported_review.get("rangeFrom") == int(cap_special["createdAt"]) - 86400000
            and exported_review.get("rangeTo") == int(cap_special["createdAt"]) + 86400000
            and exported_review.get("timezone") == "Asia/Shanghai"
            and exported_review.get("preset") == "custom"
            and exported_review.get("savedAt") == review_saved_at
            and exported_review.get("configName") == "导出验证模型"
            and exported_review.get("modelId") == "fake-export",
            str(exported_review)[:400],
        )
        checker.check(
            "导出回顾 stats/coverage 完整",
            exported_review is not None
            and exported_review.get("stats") == review_stats
            and exported_review.get("coverage") == review_coverage,
            str(exported_review.get("stats") if exported_review else None)[:300],
        )
        checker.check(
            "导出回顾 content 四区块与 overview 完整",
            exported_review is not None
            and exported_review.get("content") == review_content
            and bool((exported_review.get("content") or {}).get("overview"))
            and all(
                isinstance((exported_review.get("content") or {}).get(name), list)
                for name in ("attempts", "observations", "connections", "experiences")
            ),
            str((exported_review or {}).get("content"))[:400],
        )
        checker.check(
            "导出回顾 sources 完整且不含失败/未保存记录",
            exported_review is not None
            and exported_review.get("sources") == review_sources
            and len(exported_review.get("sources") or []) == 2
            and all(r.get("id") != review_failed_id for r in stage_reviews or []),
            str((exported_review or {}).get("sources"))[:300],
        )
        # 旧版导出对象仍可被解析：无 stageReviews 时视为空，不报错
        legacy_payload = json.loads(
            '{"schemaVersion": 1, "appVersion": "0.1.0", '
            '"exportedAt": "2025-01-01T00:00:00.000Z", '
            '"data": {"captures": [], "attempts": [], "attemptReferences": []}}'
        )
        checker.check(
            "旧 schemaVersion=1 导出对象可解析（stageReviews 视为空）",
            legacy_payload.get("schemaVersion") == 1
            and ((legacy_payload.get("data") or {}).get("stageReviews") or []) == [],
            str(legacy_payload)[:300],
        )

        # ---------- 日程导出（schemaVersion=2 的 scheduleBlocks） ----------
        schedule_blocks = data.get("scheduleBlocks")
        checker.check("data.scheduleBlocks 为数组", isinstance(schedule_blocks, list), str(type(schedule_blocks)))
        checker.check("导出包含 3 条日程安排（含下一步行动）", len(schedule_blocks or []) == 3, str([b.get("id") for b in schedule_blocks or []]))
        checker.check(
            "导出日程字段与契约 §5.8 完全一致",
            all(set(b.keys()) == SCHEDULE_EXPORT_KEYS for b in schedule_blocks or []),
            str([sorted(b.keys()) for b in schedule_blocks or []]),
        )
        exported_schedules = {b.get("id"): b for b in schedule_blocks or []}
        ex_a = exported_schedules.get(schedule_a.get("id")) or {}
        ex_b = exported_schedules.get(schedule_b.get("id")) or {}
        checker.check(
            "导出日程 A 时间/时区/备注/revision 正确",
            ex_a.get("attemptId") == attempt_a["id"]
            and ex_a.get("startsAt") == schedule_a.get("startsAt")
            and ex_a.get("endsAt") == schedule_a.get("endsAt")
            and ex_a.get("timezone") == "Asia/Shanghai"
            and ex_a.get("note") == "导出日程 A：active"
            and ex_a.get("status") == "active"
            and ex_a.get("revision") == schedule_a.get("revision")
            and ex_a.get("cancelledAt") is None,
            str(ex_a),
        )
        checker.check(
            "导出日程 B 保留 cancelled 状态与取消时间",
            ex_b.get("status") == "cancelled"
            and isinstance(ex_b.get("cancelledAt"), int)
            and ex_b.get("revision") == schedule_b.get("revision"),
            str(ex_b),
        )
        checker.check(
            "导出日程按 startsAt, id 升序",
            [(b.get("startsAt"), b.get("id")) for b in schedule_blocks or []]
            == sorted((b.get("startsAt"), b.get("id")) for b in schedule_blocks or []),
            str([(b.get("startsAt"), b.get("id")) for b in schedule_blocks or []]),
        )
        ex_next_schedule = exported_schedules.get(next_action_schedule.get("id")) or {}
        checker.check(
            "导出下一步行动日程归属行动且时间正确",
            ex_next_schedule.get("attemptId") == next_action_id
            and ex_next_schedule.get("startsAt") == next_action_schedule.get("startsAt")
            and ex_next_schedule.get("endsAt") == next_action_schedule.get("endsAt")
            and ex_next_schedule.get("note") == "导出下一步日程"
            and ex_next_schedule.get("status") == "active",
            str(ex_next_schedule),
        )
        checker.check(
            "导出日程顺序为 A、B、下一步行动（时间先后）",
            [b.get("id") for b in schedule_blocks or []]
            == [schedule_a.get("id"), schedule_b.get("id"), next_action_schedule.get("id")],
            str([b.get("id") for b in schedule_blocks or []]),
        )
        checker.check(
            "导出日程 attemptId 均可关联到 attempts 与 captures",
            all(
                b.get("attemptId") in att_map
                and att_map[b["attemptId"]]["captureId"] in cap_map
                for b in schedule_blocks or []
            ),
            str([b.get("attemptId") for b in schedule_blocks or []]),
        )
        # v1 读取器忽略未知 scheduleBlocks；v2 读取器对缺失 scheduleBlocks 按 [] 处理
        checker.check(
            "旧 schemaVersion=1 导出缺少 scheduleBlocks 时按空数组处理",
            ((legacy_payload.get("data") or {}).get("scheduleBlocks") or []) == [],
            str(legacy_payload)[:300],
        )
        legacy_v2 = json.loads(
            '{"schemaVersion": 2, "appVersion": "0.1.0", '
            '"exportedAt": "2025-01-01T00:00:00.000Z", '
            '"data": {"captures": [], "attempts": [], "attemptReferences": [], "stageReviews": []}}'
        )
        checker.check(
            "v2 读取器对缺失 scheduleBlocks/stageReviews 的旧文件按空数组处理",
            ((legacy_v2.get("data") or {}).get("scheduleBlocks") or []) == []
            and ((legacy_v2.get("data") or {}).get("stageReviews") or []) == [],
            str(legacy_v2),
        )
        v2_attempt = {"id": "att-v2-legacy", "step": "旧版尝试", "state": "done"}
        checker.check(
            "v2 导出的 attempt 缺少新增字段时按 origin=manual / 其余 null 读取",
            v2_attempt.get("origin", "manual") == "manual"
            and v2_attempt.get("actionDescription") is None
            and v2_attempt.get("estimatedMinutes") is None
            and v2_attempt.get("sourceReviewId") is None
            and v2_attempt.get("sourceExperienceIndex") is None
            and v2_attempt.get("sourceAttemptId") is None
            and v2_attempt.get("sourceAttemptRevision") is None,
            str(v2_attempt),
        )

        # ---------- 一致视图：引用端点都存在 ----------
        checker.check(
            "导出视图自洽：所有尝试都指向已导出的念头",
            all(a["captureId"] in cap_map for a in attempts),
            str([a["captureId"] for a in attempts]),
        )
        checker.check(
            "导出视图自洽：所有引用端点都指向已导出的尝试",
            all(r["fromAttemptId"] in att_map and r["toAttemptId"] in att_map for r in references),
            str(references),
        )

        # ---------- 内部数据排除 ----------
        cookie_value = next((ck.value for ck in client.jar if ck.name == "shinian_sid"), "")
        secret_tokens = {
            "账号用户名": username,
            "创建尝试 B 操作 ID": op_attempt_b,
            "创建尝试 A 操作 ID": op_attempt_a,
            "创建引用操作 ID": op_reference,
            "会话 Cookie 值": cookie_value,
            "会话 Cookie 名": "shinian_sid",
            "账号字段": "username",
            "回执字段": "operationKey",
            "回执指纹": "requestFingerprint",
            "回执响应": "responseJson",
        }
        leaks = [label for label, token in secret_tokens.items() if token and token in text]
        checker.check("导出内容不含账号/操作回执/Cookie 等内部数据", not leaks, str(leaks))

        internal_tables = ["accounts", "mutation_receipts", "source_links", "_migrations"]
        leaked_tables = [name for name in internal_tables if name in text]
        checker.check("导出内容不含内部表名", not leaked_tables, str(leaked_tables))

        # ---------- 导出后原库仍可读写 ----------
        status, res = client.get("/api/captures")
        status_archived, res_archived = client.get("/api/captures?archived=1")
        checker.check(
            "导出后原库可读（未归档 1 条 + 已归档 1 条）",
            status == 200
            and len(res.get("captures", [])) == 1
            and status_archived == 200
            and len(res_archived.get("captures", [])) == 1,
            f"{status} {res} / {status_archived} {res_archived}",
        )
        status, res = client.post("/api/captures", {"rawText": f"导出后新增记录 {uid}"})
        checker.check("导出后原库可写（新增记录 200）", status == 200, f"{status} {res}")
        new_cap = res.get("capture") or {}
        status, res = client.get("/api/captures")
        checker.check(
            "导出后新增记录可读回",
            status == 200 and any(c["id"] == new_cap.get("id") for c in res.get("captures", [])),
            f"{status} {res}",
        )
        status, headers, text2 = call_export(client)
        payload2 = json.loads(text2)
        checker.check(
            "再次导出包含导出后新增的记录",
            status == 200
            and any(c["id"] == new_cap.get("id") for c in payload2["data"]["captures"]),
            f"{status}",
        )
        checker.check("导出未改写或清空数据库文件", os.path.exists(TEST_DB) and os.path.getsize(TEST_DB) > 0)

        success = checker.report("JSON 导出功能")
    except Exception as exc:  # noqa: BLE001 - 测试脚本需要打印真实异常
        print(f"\nERROR 测试执行异常：{exc}")
        traceback.print_exc()
        success = False
    finally:
        stop_server()
        if success:
            try:
                remove_db_files()
                if os.path.exists(SERVER_LOG):
                    os.remove(SERVER_LOG)
            except PermissionError as exc:
                print(f"WARN 测试通过，但临时文件清理失败（可手动删除）：{exc}")
        else:
            print(f"测试数据库与日志保留用于排查：{TEST_DB} / {SERVER_LOG}")

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
