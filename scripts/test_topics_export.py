"""拾念 SHINIAN · 主题导出 / 备份恢复验收（QA 独立版）

只操作隔离主题库（默认 db/topics-e2e.sqlite，由 run_e2e_topics.ps1 启动的服务使用）。
绝不打开 db/shinian.sqlite 主库。

覆盖：
- schemaVersion = 7，data.topics / data.topicMembers 字段与 camelCase
- topic -> member / nextAttempt 引用在导出中一致
- Python sqlite3 直查 topics / topic_members
- scripts/backup.mjs + scripts/restore.mjs 后主题、成员、固定引用仍一致
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import datetime
import urllib.parse
from contextlib import closing
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAIN_DB = (ROOT / "db" / "shinian.sqlite").resolve()
BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3230").rstrip("/")
DB = Path(os.environ.get("SHINIAN_TOPICS_TEST_DB", str(ROOT / "db" / "topics-e2e.sqlite"))).resolve()
FAIL_PATH = Path(
    os.environ.get("SHINIAN_TOPIC_FAILURES", str(ROOT / "output" / "topics-e2e-failures.txt"))
)
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
TEMP_DIR = ROOT / "backups" / f"_test_topics_export_{STAMP}"
RESTORED = TEMP_DIR / "restored.sqlite"

c = Checker()


def fail(msg: str) -> None:
    print(f"FATAL {msg}")
    raise SystemExit(2)


def safe_test_db() -> None:
    if DB == MAIN_DB:
        fail(f"拒绝使用主库：{DB}")
    if "topics-e2e" not in DB.name.lower() and os.environ.get("SHINIAN_ALLOW_TOPICS_TEST_DB") != "1":
        fail(f"拒绝操作非主题隔离库：{DB}")
    if not DB.exists():
        fail(f"隔离数据库不存在：{DB}")


def request_json(client: Client, method: str, path: str, body=None):
    status, payload = client.request(method, path, body)
    return status, payload


def must(client: Client, method: str, path: str, body=None):
    status, payload = request_json(client, method, path, body)
    if status not in (200, 201):
        fail(f"{method} {path} -> {status} {json.dumps(payload, ensure_ascii=False)[:800]}")
    return payload


def sqlite_rows(path: Path, sql: str, params=()):
    with closing(sqlite3.connect(str(path), timeout=15)) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def sqlite_scalar(path: Path, sql: str, params=()):
    with closing(sqlite3.connect(str(path), timeout=15)) as conn:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


def run_node(args: list[str], timeout=120) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["node", *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return proc


def append_failures() -> None:
    if not c.failures:
        return
    FAIL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FAIL_PATH, "a", encoding="utf-8") as fh:
        fh.write("\n[test_topics_export.py]\n")
        for name, detail in c.failures:
            fh.write(f"- {name}: {detail}\n")


def main() -> int:
    safe_test_db()
    print("=" * 64)
    print("主题导出 / 备份恢复验收（schemaVersion 7）")
    print(f"BASE = {BASE}")
    print(f"DB   = {DB}")
    print("=" * 64)

    client = Client(base=BASE)
    try:
        client.login(f"主题导出验收 {int(time.time()) % 100000}")
    except Exception as err:  # noqa: BLE001
        fail(f"登录失败：{err}")

    uid = f"{STAMP}-{os.getpid()}"
    # ---------- 通过 API 种入最小主题 ----------
    cap_a = must(client, "POST", "/api/captures", {"rawText": f"导出主题成员 A {uid}"})["capture"]
    cap_b = must(client, "POST", "/api/captures", {"rawText": f"导出主题成员 B {uid}"})["capture"]
    att_done = must(
        client,
        "POST",
        f"/api/captures/{cap_a['id']}/attempts",
        {"step": f"导出已完成尝试 {uid}", "operationId": f"op-export-done-{uid}"},
    )["attempt"]
    att_done = must(
        client,
        "PATCH",
        f"/api/attempts/{att_done['id']}",
        {
            "state": "done",
            "resultText": f"导出结果 {uid}",
            "outcome": "success",
            "observedAt": int(time.time() * 1000) - 60_000,
            "revision": att_done["revision"],
        },
    )["attempt"]
    att_next = must(
        client,
        "POST",
        f"/api/captures/{cap_a['id']}/attempts",
        {"step": f"导出固定下一步 {uid}", "operationId": f"op-export-next-{uid}"},
    )["attempt"]

    exp = must(
        client,
        "POST",
        "/api/experiences",
        {
            "title": f"导出经验 {uid}",
            "understanding": f"导出经验的独立正文 {uid}",
            "conditions": "导出测试条件",
            "limitations": "",
            "by": "user",
            "modelBasis": None,
            "originKind": "attempt",
            "originAttemptId": att_done["id"],
            "contextCaptureId": cap_a["id"],
            "sourceKeys": [f"attempt:{att_done['id']}"],
            "operationId": f"op-export-exp-{uid}",
        },
    )["experience"]

    topic = must(
        client,
        "POST",
        "/api/topics",
        {
            "title": f"导出主题 {uid}",
            "exploringQuestion": f"导出主题问题 {uid}",
            "continueNote": f"导出主题继续备注 {uid}",
            "captureIds": [cap_a["id"], cap_b["id"], exp["id"]],
            "nextAttemptId": att_next["id"],
            "operationId": f"op-export-topic-{uid}",
        },
    )["topic"]
    topic_id = topic["id"]

    c.check("导出种子主题创建成功", bool(topic_id), str(topic))
    detail = must(client, "GET", f"/api/topics/{topic_id}")
    c.check(
        "主题详情成员数一致（2 念头 + 1 经验）",
        detail.get("topic", {}).get("memberCount") == 3
        and len(detail.get("members", {}).get("thoughts", [])) == 2
        and len(detail.get("members", {}).get("experiences", [])) == 1,
        json.dumps(detail, ensure_ascii=False)[:500],
    )
    c.check(
        "主题固定下一步指向未完成尝试",
        detail.get("topic", {}).get("nextAttempt", {}).get("id") == att_next["id"],
        json.dumps(detail.get("topic", {}).get("nextAttempt"), ensure_ascii=False),
    )

    # ---------- /api/export ----------
    status, payload = request_json(client, "GET", "/api/export")
    c.check("GET /api/export 返回 200", status == 200, str(status))
    if not isinstance(payload, dict):
        fail(f"导出响应不是 JSON 对象：{str(payload)[:300]}")
    c.check("schemaVersion 为 7", payload.get("schemaVersion") == 7, repr(payload.get("schemaVersion")))
    data = payload.get("data") or {}
    topics = data.get("topics")
    members = data.get("topicMembers")
    c.check("data.topics 是数组", isinstance(topics, list), type(topics).__name__)
    c.check("data.topicMembers 是数组", isinstance(members, list), type(members).__name__)
    exported_topic = next((row for row in topics or [] if row.get("id") == topic_id), None)
    c.check("导出包含种子主题", exported_topic is not None, str(topic_id))
    if exported_topic:
        expected_keys = {
            "id",
            "title",
            "exploringQuestion",
            "continueNote",
            "nextAttemptId",
            "nextAttemptClearedReason",
            "revision",
            "archivedAt",
            "createdAt",
            "updatedAt",
        }
        c.check(
            "导出主题字段为契约规定的 camelCase 集合",
            set(exported_topic.keys()) == expected_keys,
            repr(sorted(exported_topic.keys())),
        )
        c.check(
            "导出主题固定引用一致",
            exported_topic.get("nextAttemptId") == att_next["id"],
            repr(exported_topic.get("nextAttemptId")),
        )
    exported_members = [row for row in members or [] if row.get("topicId") == topic_id]
    c.check("导出包含 3 条主题成员", len(exported_members) == 3, str(len(exported_members)))
    c.check(
        "成员导出字段为 memberKind 且无 member_kind",
        all(
            set(row.keys()) == {"id", "topicId", "captureId", "memberKind", "createdAt"}
            and "member_kind" not in row
            for row in exported_members
        ),
        repr([sorted(row.keys()) for row in exported_members]),
    )
    c.check(
        "成员种类与捕获 kind 一致（2 thought + 1 experience）",
        sorted(row.get("memberKind") for row in exported_members)
        == ["experience", "thought", "thought"],
        repr([row.get("memberKind") for row in exported_members]),
    )
    for required in (
        "captures",
        "attempts",
        "attemptReferences",
        "captureLinks",
        "scheduleBlocks",
        "experienceNotes",
        "experienceSources",
        "experienceAttempts",
        "researchRuns",
        "researchSources",
    ):
        c.check(f"schema 6 既有字段 data.{required} 仍存在", required in data, repr(required))

    # ---------- Python sqlite3 直查 ----------
    tables = {
        row["name"]
        for row in sqlite_rows(DB, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    c.check("隔离库存在 topics 表", "topics" in tables, repr(sorted(tables)))
    c.check("隔离库存在 topic_members 表", "topic_members" in tables, repr(sorted(tables)))
    db_topic = sqlite_rows(DB, "SELECT * FROM topics WHERE id = ?", (topic_id,))
    c.check("SQLite topics 行存在", len(db_topic) == 1, str(len(db_topic)))
    if db_topic:
        c.check(
            "SQLite next_attempt_id 与 API 一致",
            db_topic[0].get("next_attempt_id") == att_next["id"],
            repr(db_topic[0].get("next_attempt_id")),
        )
    db_members = sqlite_rows(
        DB,
        "SELECT capture_id, member_kind FROM topic_members WHERE topic_id = ? ORDER BY capture_id",
        (topic_id,),
    )
    c.check("SQLite topic_members 行数为 3", len(db_members) == 3, str(len(db_members)))
    c.check(
        "SQLite member_kind 与捕获 kind 一致",
        sorted(row["member_kind"] for row in db_members) == ["experience", "thought", "thought"],
        repr([row["member_kind"] for row in db_members]),
    )
    dup_count = sqlite_scalar(
        DB,
        "SELECT COUNT(*) FROM (SELECT topic_id, capture_id, COUNT(*) c FROM topic_members "
        "WHERE topic_id = ? GROUP BY topic_id, capture_id HAVING c > 1)",
        (topic_id,),
    )
    c.check("主题成员无重复行", dup_count == 0, str(dup_count))

    # ---------- 备份 + 恢复 ----------
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    backup_proc = run_node(["scripts/backup.mjs", "--db", str(DB), "--out", str(TEMP_DIR)])
    c.check(
        "backup.mjs 退出码 0",
        backup_proc.returncode == 0,
        (backup_proc.stderr or backup_proc.stdout)[-500:],
    )
    backup_path = Path((backup_proc.stdout or "").strip().splitlines()[-1]) if backup_proc.stdout.strip() else None
    c.check(
        "backup.mjs 输出备份文件路径",
        bool(backup_path and backup_path.exists()),
        str(backup_path),
    )
    if backup_path and backup_path.exists():
        c.check(
            "备份库 integrity_check=ok",
            sqlite_scalar(backup_path, "PRAGMA integrity_check") == "ok",
            str(sqlite_scalar(backup_path, "PRAGMA integrity_check")),
        )
        restore_proc = run_node(
            ["scripts/restore.mjs", "--backup", str(backup_path), "--target", str(RESTORED)]
        )
        c.check(
            "restore.mjs 退出码 0",
            restore_proc.returncode == 0,
            (restore_proc.stderr or restore_proc.stdout)[-500:],
        )
        c.check("恢复目标存在", RESTORED.exists(), str(RESTORED))
        if RESTORED.exists():
            c.check(
                "恢复库 integrity_check=ok",
                sqlite_scalar(RESTORED, "PRAGMA integrity_check") == "ok",
                str(sqlite_scalar(RESTORED, "PRAGMA integrity_check")),
            )
            c.check(
                "恢复后主题行存在",
                sqlite_scalar(RESTORED, "SELECT COUNT(*) FROM topics WHERE id = ?", (topic_id,)) == 1,
                str(topic_id),
            )
            c.check(
                "恢复后固定引用一致",
                sqlite_scalar(
                    RESTORED, "SELECT next_attempt_id FROM topics WHERE id = ?", (topic_id,)
                )
                == att_next["id"],
                repr(
                    sqlite_scalar(
                        RESTORED, "SELECT next_attempt_id FROM topics WHERE id = ?", (topic_id,)
                    )
                ),
            )
            c.check(
                "恢复后成员关系一致",
                sqlite_scalar(
                    RESTORED,
                    "SELECT COUNT(*) FROM topic_members WHERE topic_id = ?",
                    (topic_id,),
                )
                == 3,
                "member count",
            )
            c.check(
                "恢复后原 capture/attempt/experience 仍在",
                sqlite_scalar(
                    RESTORED, "SELECT COUNT(*) FROM captures WHERE id IN (?,?,?)", (cap_a["id"], cap_b["id"], exp["id"])
                )
                == 3
                and sqlite_scalar(
                    RESTORED, "SELECT COUNT(*) FROM attempts WHERE id IN (?,?)",
                    (att_done["id"], att_next["id"]),
                )
                == 2,
                "capture/attempt rows",
            )
            c.check(
                "恢复后经验依据仍在",
                sqlite_scalar(
                    RESTORED,
                    "SELECT COUNT(*) FROM experience_sources WHERE experience_id = ? AND source_key = ?",
                    (exp["id"], f"attempt:{att_done['id']}"),
                )
                == 1,
                "experience source",
            )

    ok = c.report("主题导出 / 备份恢复验收")
    append_failures()
    if ok:
        shutil.rmtree(TEMP_DIR, ignore_errors=True)
    else:
        print(f"保留失败现场：{TEMP_DIR}")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"FATAL {exc}")
        traceback = __import__("traceback")
        traceback.print_exc()
        append_failures()
        sys.exit(2)
