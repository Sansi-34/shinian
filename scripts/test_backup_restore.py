"""拾念 SHINIAN v0.2 —— 备份 / 恢复完整演练

覆盖：
1. 独立临时库 + 3401 端口启动应用，写入念头、尝试、结果、引用，归档一条，修改来源制造旧快照。
2. 写入已保存阶段回顾与 1 active + 1 cancelled 日程安排。
3. 运行 scripts/backup.mjs，校验文件、integrity_check、核心表、回顾表、schedule_blocks、迁移记录。
4. 运行 scripts/restore.mjs 恢复到新路径，用 3402 端口启动恢复库并逐项核对；
   恢复库中读取日程、修改备注、新增安排成功。
5. 旧库（仅 0000–0004）恢复后启动迁移自动补建 stage_reviews / schedule_blocks，
   并可在旧尝试上新增/修改日程（旧备份缺新表不判损坏）。
6. 失败情况：缺失备份、损坏备份、目标已存在、空库备份；失败后原库仍可读写。
7. 备份期间并发写入，校验快照一致性（integrity、引用 from/to、日程 attempt 外键、记录数区间）。

只使用 db/backup-*.sqlite 演练库，绝不打开 db/shinian.sqlite；只占用 3401/3402 端口。
"""
import datetime
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing

from common import Client, Checker

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node") or "node"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
MAIN_DB = os.path.join(ROOT, "db", "shinian.sqlite")

PORT_MAIN = 3401
PORT_RESTORED = 3402
BASE_MAIN = f"http://127.0.0.1:{PORT_MAIN}"
BASE_RESTORED = f"http://127.0.0.1:{PORT_RESTORED}"

STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
SRC_DB = os.path.join(ROOT, "db", "backup-src.sqlite")
RESTORED_DB = os.path.join(ROOT, "db", "backup-restored.sqlite")
EMPTY_SRC_DB = os.path.join(ROOT, "db", "backup-empty-src.sqlite")
EMPTY_RESTORED_DB = os.path.join(ROOT, "db", "backup-empty-restored.sqlite")
TARGET_EXISTS_DB = os.path.join(ROOT, "db", "backup-target-exists.sqlite")
BAD_BACKUP_DB = os.path.join(ROOT, "db", "backup-bad.sqlite")
SCHEMA_LESS_DB = os.path.join(ROOT, "db", "backup-schema-less.sqlite")
MISSING_BACKUP_DB = os.path.join(ROOT, "db", "backup-missing.sqlite")
OLD_DB = os.path.join(ROOT, "db", "backup-old-0004.sqlite")
OLD_RESTORED_DB = os.path.join(ROOT, "db", "backup-old-restored.sqlite")
TEST_OUT = os.path.join(ROOT, "backups", f"_test_backup_restore_{STAMP}")

TEST_DBS = [
    SRC_DB,
    RESTORED_DB,
    EMPTY_SRC_DB,
    EMPTY_RESTORED_DB,
    TARGET_EXISTS_DB,
    BAD_BACKUP_DB,
    SCHEMA_LESS_DB,
    MISSING_BACKUP_DB,
    OLD_DB,
    OLD_RESTORED_DB,
]

CORE_TABLES = ["captures", "attempts", "attempt_references", "accounts", "mutation_receipts"]
# 本轮新增表：备份/恢复必须保留；旧库（0000–0005）允许缺失，由启动迁移补建。
SCHEDULE_TABLE = "schedule_blocks"
REVIEW_TABLE = "stage_reviews"
RESEARCH_TABLES = ["research_runs", "research_sources", "github_settings"]

c = Checker()
servers = {}


# ---------------------------------------------------------------- 基础工具
def remove_db(path):
    """只删除明确的演练库路径（调用方保证不传主库）。"""
    assert os.path.abspath(path) != os.path.abspath(MAIN_DB), "拒绝删除主库"
    for suffix in ("", "-wal", "-shm"):
        target = path + suffix
        for attempt in range(12):
            try:
                os.remove(target)
                break
            except FileNotFoundError:
                break
            except PermissionError:
                # 服务刚退出时 Windows 可能短暂占用文件句柄
                if attempt == 11:
                    raise
                time.sleep(0.25)


def connect(path, timeout=15):
    conn = sqlite3.connect(path, timeout=timeout)
    conn.row_factory = sqlite3.Row
    return conn


def table_names(path):
    with closing(connect(path)) as conn:
        return {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def integrity_check(path):
    try:
        with closing(connect(path)) as conn:
            return conn.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.DatabaseError as err:
        return f"ERROR: {err}"


def scalar(path, sql, params=()):
    with closing(connect(path)) as conn:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


def counts(path):
    with closing(connect(path)) as conn:
        tables = {
            r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        result = {
            "captures": conn.execute("SELECT COUNT(*) FROM captures").fetchone()[0],
            "attempts": conn.execute("SELECT COUNT(*) FROM attempts").fetchone()[0],
            "references": conn.execute("SELECT COUNT(*) FROM attempt_references").fetchone()[0],
            "accounts": conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
            "receipts": conn.execute("SELECT COUNT(*) FROM mutation_receipts").fetchone()[0],
        }
        # 旧库没有该表时返回 None，避免把「旧备份缺新表」误判为损坏。
        result["schedules"] = (
            conn.execute("SELECT COUNT(*) FROM schedule_blocks").fetchone()[0]
            if "schedule_blocks" in tables
            else None
        )
        return result


def dump_table(path, table):
    with closing(connect(path)) as conn:
        columns = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
        order = columns[0]
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY {order}").fetchall()
        return columns, [tuple(r) for r in rows]


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_ready(proc, port, timeout=40):
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/api/session/check"
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"服务进程已退出（端口 {port}），退出码 {proc.returncode}")
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except urllib.error.HTTPError:
            return  # 401 表示已监听
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"服务未能在 {timeout}s 内就绪（端口 {port}）")


def start_server(name, port, db_path):
    assert os.path.abspath(db_path) != os.path.abspath(MAIN_DB)
    if port_in_use(port):
        raise RuntimeError(f"端口 {port} 已被占用，拒绝启动演练服务")
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["DATABASE_URL"] = db_path
    env["NODE_ENV"] = "test"
    proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready(proc, port)
    except Exception:
        # 启动失败也要清掉 tsx 派生的子进程，避免占用端口/数据库
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        else:
            proc.kill()
        raise
    servers[name] = {"proc": proc, "port": port}
    return proc


def stop_server(name):
    entry = servers.pop(name, None)
    if not entry:
        return
    proc = entry["proc"]
    port = entry["port"]
    # tsx 会再派生一个真正跑服务的子进程，只 terminate 父进程会留下孤儿进程占用数据库。
    # Windows 用 taskkill /T 终止整棵进程树；其它平台退回 terminate/kill。
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    else:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    # 等端口释放，避免下一步启动/清理遇到占用
    for _ in range(80):
        if not port_in_use(port):
            break
        time.sleep(0.1)


def run_node(args, timeout=180):
    p = subprocess.run(
        [NODE] + args,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return p.returncode, p.stdout, p.stderr


def run_backup(db_path, out_dir):
    return run_node(["scripts/backup.mjs", "--db", db_path, "--out", out_dir])


def run_restore(backup_path, target_path=None):
    args = ["scripts/restore.mjs", "--backup", backup_path]
    if target_path is not None:
        args += ["--target", target_path]
    return run_node(args)


def single_stdout_line(stdout):
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    return lines[0] if len(lines) == 1 else None


def migration_names():
    folder = os.path.join(ROOT, "drizzle", "migrations")
    return sorted(f for f in os.listdir(folder) if f.endswith(".sql"))


def insert_saved_stage_review(db_path, capture, attempt, reference):
    """在源库插入一条合法的已保存阶段回顾，供备份/恢复核对。"""
    review_id = f"rev-backup-{STAMP}"
    range_from = int(capture["createdAt"]) - 86400000
    range_to = int(capture["createdAt"]) + 86400000
    saved_at = int(capture["createdAt"]) + 2000
    stats = {
        "capturesCreated": 1,
        "capturesModified": 0,
        "attemptsStarted": 1,
        "attemptsModified": 0,
        "attemptsCurrentlyEnded": 1,
        "resultsRecorded": 1,
        "resultsMissingObservedAt": 0,
        "referencesCreated": 1,
        "totalRecords": 3,
    }
    coverage = {
        "totalRecords": 3,
        "selectedRecords": 3,
        "excludedRecords": 0,
        "selectedChars": 180,
        "maxRecords": 80,
        "maxChars": 16000,
        "withinLimit": True,
        "truncated": False,
        "sectionCounts": {"captures": 1, "attempts": 1, "results": 1, "references": 1, "modifications": 0},
    }
    content = {
        "overview": "备份恢复测试概览：一条念头、一次尝试和一条引用。",
        "attempts": [{"text": "你实际比较了两种 PWM 频率。", "basis": "observation", "sourceIds": [f"attempt:{attempt['id']}"]}],
        "observations": [{"text": "500 Hz 时仍有可见闪烁。", "basis": "observation", "sourceIds": [f"attempt:{attempt['id']}"]}],
        "connections": [{"text": "引用把旧结果带到了新尝试。", "basis": "inference", "sourceIds": [f"reference:{reference['id']}"]}],
        "experiences": [{"text": "下次可先固定其他条件。", "basis": "inference", "sourceIds": [f"attempt:{attempt['id']}"]}],
        "uncertainties": ["只有一次记录。"],
        "insufficientData": False,
        "dataNotes": None,
    }
    sources = [
        {
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
        },
        {
            "key": f"attempt:{attempt['id']}",
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
        {
            "key": f"reference:{reference['id']}",
            "type": "reference",
            "sourceId": reference["id"],
            "captureId": capture["id"],
            "attemptId": reference["fromAttemptId"],
            "relatedAttemptId": reference["toAttemptId"],
            "title": "引用旧结果",
            "text": reference.get("note") or "",
            "resultText": reference.get("snapshotResultText"),
            "outcome": None,
            "state": None,
            "observedAt": None,
            "revision": reference["revision"],
            "captureRevision": capture["revision"],
            "relatedRevision": attempt["revision"],
            "createdAt": reference["createdAt"],
            "updatedAt": reference["createdAt"],
        },
    ]
    with closing(connect(db_path)) as conn:
        conn.execute(
            "INSERT INTO stage_reviews (id, status, range_from, range_to, timezone, range_preset, "
            "stats_json, coverage_json, content_json, sources_json, config_id, config_version, config_name, "
            "model_id, saved_at, created_at, updated_at, finished_at) "
            "VALUES (?, 'succeeded', ?, ?, 'Asia/Shanghai', 'custom', ?, ?, ?, ?, 'default', 1, '备份验证模型', "
            "'fake-backup', ?, ?, ?, ?)",
            (
                review_id,
                range_from,
                range_to,
                json.dumps(stats, ensure_ascii=False),
                json.dumps(coverage, ensure_ascii=False),
                json.dumps(content, ensure_ascii=False),
                json.dumps(sources, ensure_ascii=False),
                saved_at,
                saved_at - 1000,
                saved_at - 1000,
                saved_at,
            ),
        )
        conn.commit()
    return review_id, stats, coverage, content, sources, saved_at


def create_legacy_0004_database(path):
    """创建一个只应用 0000–0004 迁移、含旧业务数据的备份库（模拟旧版本备份）。"""
    remove_db(path)
    folder = os.path.join(ROOT, "drizzle", "migrations")
    files = [f for f in migration_names() if f < "0005"]
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(
            "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        for name in files:
            with open(os.path.join(folder, name), "r", encoding="utf-8") as fh:
                sql = fh.read()
            for stmt in sql.split("--> statement-breakpoint"):
                stmt = stmt.strip()
                if stmt:
                    conn.execute(stmt)
            conn.execute(
                "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
                (name, 1700000000000 + len(files)),
            )
        now_ms = 1700000000000
        conn.execute(
            "INSERT INTO accounts (id, username, created_at) VALUES ('user-old-backup', '旧库升级用户', ?)",
            (now_ms,),
        )
        conn.execute(
            "INSERT INTO captures (id, raw_text, revision, created_at, updated_at, archived_at) "
            "VALUES ('cap-old-backup', '旧库里的念头：PWM 低占空比时 LED 会闪', 1, ?, ?, NULL)",
            (now_ms, now_ms),
        )
        conn.execute(
            "INSERT INTO attempts (id, capture_id, step, state, result_text, outcome, source_url, "
            "observed_at, revision, created_at, updated_at) "
            "VALUES ('att-old-backup', 'cap-old-backup', '旧库里的尝试：比较频率', 'done', "
            "'旧库里的结果：500 Hz 仍闪烁', 'failure', NULL, ?, 1, ?, ?)",
            (now_ms + 1000, now_ms + 1000, now_ms + 1000),
        )
        conn.execute(
            "INSERT INTO attempt_references (id, from_attempt_id, to_attempt_id, revision, note, "
            "snapshot_result_text, snapshot_revision, created_at) "
            "VALUES ('ref-old-backup', 'att-old-backup', 'att-old-backup', 1, NULL, NULL, 1, ?)",
            (now_ms + 2000,),
        )
        conn.commit()


# ---------------------------------------------------------------- 并发写线程
class Writer(threading.Thread):
    """持续通过 HTTP 写入 念头→尝试→尝试→引用，仅供备份并发演练。"""

    def __init__(self, base, tag):
        super().__init__(daemon=True)
        self.base = base
        self.tag = tag
        self.stop_event = threading.Event()
        self.intervals = []
        self.errors = []
        self.iterations = 0
        self.client = Client(base)
        self.client.login("并发写用户")

    def run(self):
        i = 0
        while not self.stop_event.is_set():
            t0 = time.monotonic()
            try:
                status, res = self.client.post(
                    "/api/captures", {"rawText": f"并发写入 {i} [{self.tag}]"}
                )
                if status != 200:
                    raise RuntimeError(f"capture {status} {res}")
                cap = res["capture"]
                status, res = self.client.post(
                    f"/api/captures/{cap['id']}/attempts",
                    {
                        "step": f"并发尝试 A {i} [{self.tag}]",
                        "state": "done",
                        "resultText": f"并发结果 A {i} [{self.tag}]",
                        "operationId": f"conc-a-{self.tag}-{i}",
                    },
                )
                if status != 200:
                    raise RuntimeError(f"attemptA {status} {res}")
                a1 = res["attempt"]
                status, res = self.client.post(
                    f"/api/captures/{cap['id']}/attempts",
                    {
                        "step": f"并发尝试 B {i} [{self.tag}]",
                        "state": "todo",
                        "operationId": f"conc-b-{self.tag}-{i}",
                    },
                )
                if status != 200:
                    raise RuntimeError(f"attemptB {status} {res}")
                a2 = res["attempt"]
                status, res = self.client.post(
                    f"/api/attempts/{a2['id']}/references",
                    {
                        "toId": a1["id"],
                        "note": f"并发引用 {i} [{self.tag}]",
                        "operationId": f"conc-r-{self.tag}-{i}",
                    },
                )
                if status != 200:
                    raise RuntimeError(f"reference {status} {res}")
                self.intervals.append((t0, time.monotonic()))
                self.iterations += 1
                i += 1
            except Exception as err:  # 终止瞬间的请求失败记录但不阻断
                self.errors.append(repr(err))
                time.sleep(0.02)


# ---------------------------------------------------------------- 主流程
def main():
    c.check(
        "演练库均不是主库 db/shinian.sqlite",
        all(os.path.abspath(p) != os.path.abspath(MAIN_DB) for p in TEST_DBS),
    )

    for port in (PORT_MAIN, PORT_RESTORED):
        if port_in_use(port):
            print(f"FAIL  端口 {port} 已被占用；演练不会触碰其它端口，终止。")
            return 2

    for path in TEST_DBS:
        remove_db(path)
    shutil.rmtree(TEST_OUT, ignore_errors=True)

    # =========================================================== 1. 造数据
    print("\n### 1. 启动 3401 演练服务并写入数据")
    start_server("main", PORT_MAIN, SRC_DB)
    client = Client(BASE_MAIN)
    body = client.login("备份演练用户")
    c.check("3401 服务就绪并可登录", body.get("ok") is True, str(body))

    status, res = client.post("/api/captures", {"rawText": "PWM 低占空比时 LED 会闪 [backup-test]"})
    c.check("创建念头 A", status == 200, str(res))
    cap_a = res["capture"]

    status, res = client.post(
        f"/api/captures/{cap_a['id']}/attempts",
        {
            "step": "比较两种 PWM 频率 [backup-test]",
            "state": "done",
            "resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]",
            "outcome": "failure",
            "operationId": f"bt-att-a-{STAMP}",
        },
    )
    c.check("创建尝试 A1", status == 200, str(res))
    att_a1 = res["attempt"]
    observed_at = 1700000000123
    status, res = client.patch(
        f"/api/attempts/{att_a1['id']}",
        {
            "state": "done",
            "resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]",
            "outcome": "failure",
            "observedAt": observed_at,
            "revision": att_a1["revision"],
        },
    )
    c.check("记录 A1 结果与固定 observedAt", status == 200, str(res))
    c.check("A1 observedAt 精确写入", res["attempt"]["observedAt"] == observed_at)
    att_a1 = res["attempt"]
    c.check("A1 revision 递增到 2", att_a1["revision"] == 2)

    status, res = client.post("/api/captures", {"rawText": "调光时想避免肉眼可见闪烁 [backup-test]"})
    c.check("创建念头 B", status == 200)
    cap_b = res["capture"]

    status, res = client.post(
        f"/api/captures/{cap_a['id']}/links",
        {
            "toCaptureId": cap_b["id"],
            "note": "同一个闪烁问题的前后记录 [backup-test]",
            "operationId": f"bt-link-{STAMP}",
        },
    )
    c.check("创建念头关联 A→B", status == 200, str(res))
    cap_link = (res or {}).get("link") or {}
    c.check("关联使用稳定 ID", bool(cap_link.get("id")), str(cap_link))

    status, res = client.post(
        f"/api/captures/{cap_b['id']}/attempts",
        {"step": "按旧结论选 2 kHz 试调光 [backup-test]", "state": "in_progress", "operationId": f"bt-att-b-{STAMP}"},
    )
    c.check("创建尝试 B1", status == 200)
    att_b1 = res["attempt"]

    status, res = client.post(
        f"/api/attempts/{att_b1['id']}/references",
        {
            "toId": att_a1["id"],
            "note": "先按 2 kHz 继续验证调光 [backup-test]",
            "operationId": f"bt-ref-{STAMP}",
        },
    )
    c.check("创建引用 B1 → A1", status == 200, str(res))
    ref = res["reference"]
    c.check("引用快照版本 = 2", ref["snapshotRevision"] == 2)
    c.check(
        "引用快照文本 = v1",
        ref["snapshotResultText"] == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]",
        str(ref),
    )

    status, res = client.patch(
        f"/api/attempts/{att_a1['id']}",
        {
            "resultText": "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]（复测确认）[snap-v2]",
            "outcome": "success",
            "revision": att_a1["revision"],
        },
    )
    c.check("修改来源结果制造旧快照", status == 200, str(res))
    att_a1 = res["attempt"]
    c.check("A1 revision 递增到 3", att_a1["revision"] == 3)

    status, res = client.get(f"/api/attempts/{att_b1['id']}/references")
    live_ref = res["fromRefs"][0]
    c.check("备份前 updatedSinceSnapshot = true", live_ref["source"]["updatedSinceSnapshot"] is True)

    status, res = client.post(f"/api/captures/{cap_a['id']}/archive", {})
    c.check("归档念头 A", status == 200 and res["capture"]["archivedAt"] is not None, str(res))

    status, res = client.get("/api/captures")
    c.check("默认列表不含已归档 A", all(x["id"] != cap_a["id"] for x in res["captures"]))
    status, res = client.get("/api/captures?archived=1")
    c.check("archived=1 列表含 A", any(x["id"] == cap_a["id"] for x in res["captures"]))

    # ---------- 阶段回顾：直接写入一条合法已保存记录（不依赖假模型） ----------
    review_id, review_stats, review_coverage, review_content, review_sources, review_saved_at = insert_saved_stage_review(
        SRC_DB, cap_a, att_a1, ref
    )
    c.check("源库 stage_reviews 表已创建", "stage_reviews" in table_names(SRC_DB))
    c.check(
        "源库已写入 1 条已保存回顾",
        scalar(SRC_DB, "SELECT COUNT(*) FROM stage_reviews WHERE saved_at IS NOT NULL") == 1,
        str(scalar(SRC_DB, "SELECT COUNT(*) FROM stage_reviews")),
    )

    # ---------- 日程安排：通过 API 创建 1 条 active + 1 条 cancelled ----------
    status, res = client.post(
        f"/api/attempts/{att_b1['id']}/schedules",
        {
            "date": "2027-06-20",
            "startTime": "10:00",
            "endTime": "11:00",
            "timezone": "Asia/Shanghai",
            "note": "备份演练：未来安排",
            "operationId": f"bt-sch-a-{STAMP}",
        },
    )
    c.check("源库创建日程 A（active）", status in (200, 201), f"{status} {res}")
    backup_schedule_a = (res or {}).get("schedule") or {}
    status, res = client.post(
        f"/api/attempts/{att_b1['id']}/schedules",
        {
            "date": "2027-06-21",
            "startTime": "14:00",
            "endTime": "15:00",
            "timezone": "Asia/Shanghai",
            "note": "备份演练：待取消安排",
            "operationId": f"bt-sch-b-{STAMP}",
        },
    )
    c.check("源库创建日程 B", status in (200, 201), f"{status} {res}")
    backup_schedule_b = (res or {}).get("schedule") or {}
    status, res = client.post(
        f"/api/schedules/{backup_schedule_b['id']}/cancel",
        {"revision": backup_schedule_b.get("revision")},
    )
    c.check(
        "源库取消日程 B",
        status == 200 and ((res or {}).get("schedule") or {}).get("status") == "cancelled",
        f"{status} {res}",
    )
    backup_schedule_b = (res or {}).get("schedule") or backup_schedule_b
    c.check("源库 schedule_blocks 表已创建", SCHEDULE_TABLE in table_names(SRC_DB), str(sorted(table_names(SRC_DB))))
    c.check(
        "源库有 2 条日程（1 active + 1 cancelled）",
        scalar(SRC_DB, "SELECT COUNT(*) FROM schedule_blocks") == 2
        and scalar(SRC_DB, "SELECT COUNT(*) FROM schedule_blocks WHERE status='active'") == 1,
        str(scalar(SRC_DB, "SELECT COUNT(*) FROM schedule_blocks")),
    )

    live_counts = counts(SRC_DB)
    c.check(
        "源库业务计数符合预期",
        live_counts["captures"] == 2 and live_counts["attempts"] == 2 and live_counts["references"] == 1,
        str(live_counts),
    )

    # ---------- 完整下一步行动：attempt + reference + schedule ----------
    status, res = client.get(f"/api/reviews/{review_id}/next-action-preview?experienceIndex=0")
    c.check("源库已保存回顾可预览下一步行动", status == 200, f"{status} {str(res)[:400]}")
    next_preview = res or {}
    next_defaults = next_preview.get("defaults") or {}
    next_capture = next(
        (x for x in next_preview.get("captures") or [] if x.get("id") == next_defaults.get("captureId")),
        None,
    )
    next_action_schedule_day = "2027-06-23"
    status, res = client.post(
        f"/api/reviews/{review_id}/next-actions",
        {
            "captureId": next_defaults.get("captureId"),
            "captureRevision": (next_capture or {}).get("revision"),
            "experienceIndex": 0,
            "title": "备份演练：按回顾经验复测 2 kHz",
            "description": "固定其他条件，只改变频率。",
            "estimatedMinutes": 20,
            "contextToken": next_preview.get("contextToken"),
            "operationId": f"bt-next-action-{STAMP}",
            "schedule": {
                "date": next_action_schedule_day,
                "endDate": next_action_schedule_day,
                "startTime": "09:00",
                "endTime": "09:30",
                "timezone": "Asia/Shanghai",
                "note": "备份演练：下一步行动日程",
            },
        },
    )
    c.check("源库创建完整下一步行动（201）", status == 201, f"{status} {str(res)[:500]}")
    next_action = (res or {}).get("nextAction") or {}
    next_action_id = next_action.get("id")
    next_action_schedule = (next_action.get("schedules") or [{}])[0]
    c.check(
        "下一步行动字段/来源/日程正确",
        next_action.get("origin") == "review_next_action"
        and next_action.get("sourceReviewId") == review_id
        and next_action.get("sourceExperienceIndex") == 0
        and next_action.get("sourceAttemptId") == att_a1["id"]
        and next_action.get("sourceAttemptRevision") == att_a1["revision"]
        and next_action.get("description") == "固定其他条件，只改变频率。"
        and next_action.get("estimatedMinutes") == 20
        and len(next_action.get("schedules") or []) == 1,
        str(next_action)[:500],
    )
    live_counts = counts(SRC_DB)
    c.check(
        "源库业务计数含下一步行动（attempt+reference+schedule）",
        live_counts["captures"] == 2
        and live_counts["attempts"] == 3
        and live_counts["references"] == 2
        and live_counts["schedules"] == 3,
        str(live_counts),
    )
    c.check(
        "源库下一步行动来源引用已建立",
        scalar(
            SRC_DB,
            "SELECT COUNT(*) FROM attempt_references WHERE from_attempt_id = ? AND to_attempt_id = ? "
            "AND snapshot_revision = ?",
            (next_action_id, att_a1["id"], att_a1["revision"]),
        )
        == 1,
        str(next_action_id),
    )
    c.check(
        "源库下一步行动日程已建立",
        scalar(
            SRC_DB,
            "SELECT COUNT(*) FROM schedule_blocks WHERE id = ? AND attempt_id = ? AND status = 'active'",
            (next_action_schedule.get("id"), next_action_id),
        )
        == 1,
        str(next_action_schedule),
    )

    # =========================================================== 2. 备份
    print("\n### 2. 在线备份（3401 服务保持运行，WAL 未 checkpoint）")
    rc, stdout, stderr = run_backup(SRC_DB, TEST_OUT)
    c.check("backup.mjs 退出码 0", rc == 0, stderr[-800:])
    backup_path = single_stdout_line(stdout)
    c.check("stdout 只有一行且为备份路径", backup_path is not None, repr(stdout))
    if backup_path is None:
        backup_path = os.path.join(TEST_OUT, "missing.sqlite")
    c.check("stdout 路径为绝对路径", os.path.isabs(backup_path), backup_path)
    c.check("备份文件存在", os.path.isfile(backup_path))
    name = os.path.basename(backup_path)
    pattern_ok = (
        name.startswith("shinian-backup-")
        and name.endswith(".sqlite")
        and len(name) == len("shinian-backup-YYYYMMDD-HHmmss.sqlite")
    )
    c.check("文件名含时间戳（shinian-backup-YYYYMMDD-HHmmss.sqlite）", pattern_ok, name)
    c.check("备份文件非空", os.path.getsize(backup_path) > 0)
    c.check("备份 integrity_check = ok", integrity_check(backup_path) == "ok")
    backup_tables = table_names(backup_path)
    c.check("备份含全部核心表", all(t in backup_tables for t in CORE_TABLES), str(sorted(backup_tables)))
    c.check("备份含 _migrations 表", "_migrations" in backup_tables)
    c.check("备份含 stage_reviews 表", "stage_reviews" in backup_tables, str(sorted(backup_tables)))
    c.check("备份含 schedule_blocks 表", SCHEDULE_TABLE in backup_tables, str(sorted(backup_tables)))
    c.check("备份含 GitHub 研究表", all(t in backup_tables for t in RESEARCH_TABLES), str(sorted(backup_tables)))
    c.check(
        "备份包含已保存阶段回顾",
        scalar(backup_path, "SELECT COUNT(*) FROM stage_reviews WHERE id = ? AND saved_at IS NOT NULL", (review_id,)) == 1,
    )
    c.check(
        "备份包含 3 条日程且时间/状态正确",
        scalar(backup_path, "SELECT COUNT(*) FROM schedule_blocks") == 3
        and scalar(
            backup_path,
            "SELECT COUNT(*) FROM schedule_blocks WHERE id = ? AND starts_at = ? AND ends_at = ? AND status = 'active'",
            (backup_schedule_a.get("id"), backup_schedule_a.get("startsAt"), backup_schedule_a.get("endsAt")),
        )
        == 1
        and scalar(
            backup_path,
            "SELECT COUNT(*) FROM schedule_blocks WHERE id = ? AND status = 'cancelled' AND cancelled_at IS NOT NULL",
            (backup_schedule_b.get("id"),),
        )
        == 1,
        str(scalar(backup_path, "SELECT COUNT(*) FROM schedule_blocks")),
    )
    backup_attempt_columns = {
        r[1] for r in connect(backup_path).execute("PRAGMA table_info(attempts)").fetchall()
    }
    c.check(
        "备份 attempts 含下一步行动 7 个新增列",
        {
            "origin",
            "action_description",
            "estimated_minutes",
            "source_review_id",
            "source_experience_index",
            "source_attempt_id",
            "source_attempt_revision",
        }
        <= backup_attempt_columns,
        str(sorted(backup_attempt_columns)),
    )
    c.check(
        "备份保留下一步行动 attempt 字段",
        scalar(
            backup_path,
            "SELECT COUNT(*) FROM attempts WHERE id = ? AND origin = 'review_next_action' "
            "AND action_description = '固定其他条件，只改变频率。' AND estimated_minutes = 20 "
            "AND source_review_id = ? AND source_experience_index = 0 "
            "AND source_attempt_id = ? AND source_attempt_revision = ?",
            (next_action_id, review_id, att_a1["id"], att_a1["revision"]),
        )
        == 1,
        str(next_action_id),
    )
    c.check(
        "备份保留下一步行动来源引用与日程",
        scalar(
            backup_path,
            "SELECT COUNT(*) FROM attempt_references WHERE from_attempt_id = ? AND to_attempt_id = ?",
            (next_action_id, att_a1["id"]),
        )
        == 1
        and scalar(
            backup_path,
            "SELECT COUNT(*) FROM schedule_blocks WHERE id = ? AND attempt_id = ? AND status = 'active'",
            (next_action_schedule.get("id"), next_action_id),
        )
        == 1,
        f"{next_action_id} / {next_action_schedule.get('id')}",
    )
    stored_migrations = [
        r[0] for r in connect(backup_path).execute("SELECT name FROM _migrations ORDER BY name").fetchall()
    ]
    c.check(
        "备份迁移记录齐全且可识别",
        len(stored_migrations) >= 3 and all(m in migration_names() for m in stored_migrations),
        str(stored_migrations),
    )
    c.check(
        "备份迁移记录含 0008_research",
        any("0008_research" in name for name in stored_migrations),
        str(stored_migrations),
    )
    backup_counts = counts(backup_path)
    c.check("备份记录数与源库一致", backup_counts == live_counts, f"{backup_counts} vs {live_counts}")
    print(f"  备份文件: {backup_path} ({os.path.getsize(backup_path)} 字节)")
    print(f"  备份计数: {backup_counts}")

    # =========================================================== 3. 同秒命名
    print("\n### 3. 同秒冲突追加 -1，且不覆盖已有文件")
    collision_dir = os.path.join(TEST_OUT, "collision")
    os.makedirs(collision_dir, exist_ok=True)
    collision_ok = False
    collision_detail = ""
    for _ in range(8):
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        placeholder = os.path.join(collision_dir, f"shinian-backup-{stamp}.sqlite")
        if os.path.exists(placeholder):
            time.sleep(0.05)
            continue
        with open(placeholder, "wb") as f:
            f.write(b"PLACEHOLDER-DO-NOT-OVERWRITE")
        try:
            rc2, stdout2, stderr2 = run_backup(SRC_DB, collision_dir)
            produced = single_stdout_line(stdout2)
            if rc2 == 0 and produced and os.path.basename(produced) == f"shinian-backup-{stamp}-1.sqlite":
                with open(placeholder, "rb") as f:
                    untouched = f.read() == b"PLACEHOLDER-DO-NOT-OVERWRITE"
                collision_ok = untouched and os.path.isfile(produced)
                collision_detail = os.path.basename(produced)
                break
            collision_detail = f"rc={rc2} out={produced!r} err={stderr2[-300:]!r}"
        finally:
            if not collision_ok:
                try:
                    os.remove(placeholder)
                except FileNotFoundError:
                    pass
            # 清理跨秒产生的额外备份
            for f in os.listdir(collision_dir):
                if f != os.path.basename(placeholder) and f.startswith("shinian-backup-"):
                    try:
                        os.remove(os.path.join(collision_dir, f))
                    except OSError:
                        pass
        if collision_ok:
            break
    c.check("同秒备份生成 -1 后缀且占位文件未被覆盖", collision_ok, collision_detail)

    # =========================================================== 4. 恢复并比对
    print("\n### 4. 恢复到一个全新路径，并逐表比对")
    rc, stdout, stderr = run_restore(backup_path, RESTORED_DB)
    c.check("restore.mjs 退出码 0", rc == 0, stderr[-1200:])
    restored_path = single_stdout_line(stdout)
    c.check("restore stdout 只有目标绝对路径", restored_path == os.path.abspath(RESTORED_DB), repr(stdout))
    c.check("恢复目标文件存在", os.path.isfile(RESTORED_DB))
    c.check("恢复目标 integrity_check = ok", integrity_check(RESTORED_DB) == "ok")
    restored_tables = table_names(RESTORED_DB)
    c.check("恢复目标含全部核心表", all(t in restored_tables for t in CORE_TABLES))
    c.check("恢复目标含 _migrations 表", "_migrations" in restored_tables)
    c.check("恢复目标含 stage_reviews 表", "stage_reviews" in restored_tables, str(sorted(restored_tables)))
    c.check("恢复目标含 schedule_blocks 表", SCHEDULE_TABLE in restored_tables, str(sorted(restored_tables)))
    c.check("恢复目标含 GitHub 研究表", all(t in restored_tables for t in RESEARCH_TABLES), str(sorted(restored_tables)))
    c.check(
        "恢复目标包含已保存阶段回顾",
        scalar(RESTORED_DB, "SELECT COUNT(*) FROM stage_reviews WHERE id = ? AND saved_at IS NOT NULL", (review_id,)) == 1,
    )
    c.check(
        "恢复目标包含 3 条日程（2 active + 1 cancelled）",
        scalar(RESTORED_DB, "SELECT COUNT(*) FROM schedule_blocks") == 3
        and scalar(RESTORED_DB, "SELECT COUNT(*) FROM schedule_blocks WHERE status = 'active'") == 2
        and scalar(RESTORED_DB, "SELECT COUNT(*) FROM schedule_blocks WHERE status = 'cancelled'") == 1,
        str(scalar(RESTORED_DB, "SELECT COUNT(*) FROM schedule_blocks")),
    )
    tables_identical = True
    diff_detail = ""
    compare_tables = CORE_TABLES + ["_migrations"]
    if "stage_reviews" in restored_tables:
        compare_tables.append("stage_reviews")
    if SCHEDULE_TABLE in restored_tables:
        compare_tables.append(SCHEDULE_TABLE)
    for table in compare_tables:
        if dump_table(backup_path, table) != dump_table(RESTORED_DB, table):
            tables_identical = False
            diff_detail = table
            break
    c.check("备份与恢复库业务表 + 迁移表 + 回顾表 + 日程表逐行一致", tables_identical, diff_detail)
    print(f"  恢复文件: {RESTORED_DB} ({os.path.getsize(RESTORED_DB)} 字节)")

    # =========================================================== 5. 恢复库 API 核对
    print("\n### 5. 启动 3402 恢复库，核对原文/状态/结果/observedAt/归档/引用快照")
    start_server("restored", PORT_RESTORED, RESTORED_DB)
    rc_client = Client(BASE_RESTORED)
    body = rc_client.login("备份演练用户")
    c.check("3402 恢复库可登录（accounts 已恢复）", body.get("ok") is True, str(body))

    status, res = rc_client.get(f"/api/reviews/{review_id}")
    restored_review = (res or {}).get("review") or {}
    c.check("恢复后阶段回顾详情可读", status == 200 and restored_review.get("id") == review_id, f"{status} {res}")
    c.check(
        "恢复后回顾 range/content/savedAt 保留",
        restored_review.get("status") == "succeeded"
        and restored_review.get("savedAt") == review_saved_at
        and restored_review.get("range", {}).get("from") == review_saved_at - 2000 - 86400000
        and restored_review.get("range", {}).get("to") == review_saved_at - 2000 + 86400000
        and (restored_review.get("content") or {}).get("overview") == review_content["overview"],
        str(restored_review)[:500],
    )
    c.check(
        "恢复后回顾 sources 完整且来源存在",
        len(restored_review.get("sources") or []) == len(review_sources)
        and all(s.get("exists") is True and s.get("deleted") is False for s in restored_review.get("sources") or []),
        str(restored_review.get("sources"))[:400],
    )
    status, listing = rc_client.get("/api/reviews?limit=50")
    c.check(
        "恢复后已保存回顾出现在列表",
        status == 200 and any(x.get("id") == review_id for x in (listing or {}).get("reviews") or []),
        f"{status} {listing}",
    )

    # ---------- 恢复后下一步行动 / 来源 / 日程 / 导出 ----------
    status, res = rc_client.get(f"/api/next-actions/{next_action_id}")
    restored_action = (res or {}).get("action") or {}
    c.check(
        "恢复后下一步行动详情可读",
        status == 200 and restored_action.get("id") == next_action_id,
        f"{status} {str(res)[:500]}",
    )
    c.check(
        "恢复后行动标题/说明/耗时/来源字段保留",
        restored_action.get("title") == "备份演练：按回顾经验复测 2 kHz"
        and restored_action.get("description") == "固定其他条件，只改变频率。"
        and restored_action.get("estimatedMinutes") == 20
        and restored_action.get("origin") == "review_next_action"
        and restored_action.get("sourceReviewId") == review_id
        and restored_action.get("sourceExperienceIndex") == 0
        and restored_action.get("sourceAttemptId") == att_a1["id"]
        and restored_action.get("sourceAttemptRevision") == att_a1["revision"],
        str(restored_action)[:600],
    )
    c.check(
        "恢复后行动来源尝试仍存在且未删除",
        len(restored_action.get("sources") or []) == 1
        and (restored_action.get("sources") or [{}])[0].get("attemptId") == att_a1["id"]
        and (restored_action.get("sources") or [{}])[0].get("deleted") is False
        and (restored_action.get("sources") or [{}])[0].get("changed") is False,
        str(restored_action.get("sources"))[:400],
    )
    status, res = rc_client.get(f"/api/reviews/{review_id}/next-actions")
    c.check(
        "恢复后回顾行动列表包含下一步行动",
        status == 200 and any(x.get("id") == next_action_id for x in (res or {}).get("actions") or []),
        f"{status} {str(res)[:400]}",
    )
    status, res = rc_client.get(f"/api/attempts/{next_action_id}/references")
    restored_action_refs = (res or {}).get("fromRefs") or []
    c.check(
        "恢复后行动来源引用与快照版本保留",
        status == 200
        and len(restored_action_refs) == 1
        and restored_action_refs[0].get("toAttemptId") == att_a1["id"]
        and restored_action_refs[0].get("snapshotRevision") == att_a1["revision"],
        f"{status} {str(res)[:500]}",
    )
    status, res = rc_client.get(f"/api/attempts/{next_action_id}/schedules")
    restored_action_schedules = (res or {}).get("schedules") or []
    c.check(
        "恢复后行动日程保留（active 且时间一致）",
        status == 200
        and len(restored_action_schedules) == 1
        and restored_action_schedules[0].get("id") == next_action_schedule.get("id")
        and restored_action_schedules[0].get("startsAt") == next_action_schedule.get("startsAt")
        and restored_action_schedules[0].get("endsAt") == next_action_schedule.get("endsAt")
        and restored_action_schedules[0].get("status") == "active"
        and restored_action_schedules[0].get("timezone") == "Asia/Shanghai",
        f"{status} {str(res)[:500]}",
    )
    status, res = rc_client.get(f"/api/captures/{cap_a['id']}/links")
    restored_links = (res or {}).get("out") or []
    c.check(
        "恢复后念头关联 A→B 完整保留（稳定 ID / 方向 / 说明）",
        status == 200
        and any(
            x.get("id") == cap_link.get("id")
            and x.get("toCaptureId") == cap_b["id"]
            and x.get("note") == "同一个闪烁问题的前后记录 [backup-test]"
            for x in restored_links
        ),
        f"{status} {str(res)[:500]}",
    )
    status, res = rc_client.get(f"/api/captures/{cap_b['id']}/links")
    restored_backlinks = (res or {}).get("in") or []
    c.check(
        "恢复后反链 A→B 仍从同一关系读取",
        status == 200 and any(x.get("id") == cap_link.get("id") for x in restored_backlinks),
        f"{status} {str(res)[:500]}",
    )
    status, export_res = rc_client.get("/api/export")
    restored_export = export_res or {}
    restored_attempts = {
        x.get("id"): x for x in ((restored_export.get("data") or {}).get("attempts") or [])
    }
    restored_export_action = restored_attempts.get(next_action_id) or {}
    c.check(
        "恢复库导出 schemaVersion>=6、行动字段完整且经验三表存在",
        status == 200
        and restored_export.get("schemaVersion") in (6, 7)
        and isinstance((restored_export.get("data") or {}).get("experienceNotes"), list)
        and isinstance((restored_export.get("data") or {}).get("experienceSources"), list)
        and isinstance((restored_export.get("data") or {}).get("experienceAttempts"), list)
        and restored_export_action.get("origin") == "review_next_action"
        and restored_export_action.get("actionDescription") == "固定其他条件，只改变频率。"
        and restored_export_action.get("estimatedMinutes") == 20
        and restored_export_action.get("sourceReviewId") == review_id
        and restored_export_action.get("sourceExperienceIndex") == 0
        and restored_export_action.get("sourceAttemptId") == att_a1["id"]
        and restored_export_action.get("sourceAttemptRevision") == att_a1["revision"],
        f"{status} {str(restored_export_action)[:600]}",
    )
    exported_links = (restored_export.get("data") or {}).get("captureLinks") or []
    c.check(
        "恢复库导出的 captureLinks 含 A→B 关联",
        any(
            x.get("id") == cap_link.get("id")
            and x.get("fromCaptureId") == cap_a["id"]
            and x.get("toCaptureId") == cap_b["id"]
            for x in exported_links
        ),
        str(exported_links)[:500],
    )

    # ---------- 恢复后日程读取 / 改备注 / 新增安排 ----------
    status, res = rc_client.get(f"/api/attempts/{att_b1['id']}/schedules")
    restored_schedules = (res or {}).get("schedules") or []
    c.check(
        "恢复后日程列表可读且含 2 条（含 cancelled 历史）",
        status == 200 and len(restored_schedules) == 2,
        f"{status} {res}",
    )
    restored_a = next((x for x in restored_schedules if x.get("id") == backup_schedule_a.get("id")), None)
    restored_b = next((x for x in restored_schedules if x.get("id") == backup_schedule_b.get("id")), None)
    c.check(
        "恢复后日程时间/时区/关联保持不变",
        bool(restored_a)
        and restored_a.get("startsAt") == backup_schedule_a.get("startsAt")
        and restored_a.get("endsAt") == backup_schedule_a.get("endsAt")
        and restored_a.get("timezone") == "Asia/Shanghai"
        and (restored_a.get("attempt") or {}).get("id") == att_b1["id"]
        and (restored_a.get("capture") or {}).get("id") == cap_b["id"],
        str(restored_a),
    )
    c.check(
        "恢复后 cancelled 日程状态保留",
        bool(restored_b) and restored_b.get("status") == "cancelled" and isinstance(restored_b.get("cancelledAt"), int),
        str(restored_b),
    )
    status, res = rc_client.patch(
        f"/api/schedules/{backup_schedule_a['id']}",
        {
            "date": "2027-06-20",
            "startTime": "10:00",
            "endTime": "11:00",
            "timezone": "Asia/Shanghai",
            "note": "恢复库修改备注成功",
            "revision": (restored_a or {}).get("revision"),
        },
    )
    c.check(
        "恢复库可修改日程备注且 revision 递增",
        status == 200
        and ((res or {}).get("schedule") or {}).get("note") == "恢复库修改备注成功"
        and ((res or {}).get("schedule") or {}).get("revision") == (restored_a or {}).get("revision", 0) + 1,
        f"{status} {res}",
    )
    status, res = rc_client.post(
        f"/api/attempts/{att_b1['id']}/schedules",
        {
            "date": "2027-06-22",
            "startTime": "09:00",
            "endTime": "10:00",
            "timezone": "Asia/Shanghai",
            "note": "恢复库新增安排",
            "operationId": f"bt-sch-restored-{STAMP}",
        },
    )
    c.check("恢复库可新增日程安排", status in (200, 201), f"{status} {res}")
    status, res = rc_client.get(f"/api/attempts/{att_b1['id']}/schedules")
    c.check(
        "恢复库新增后日程共 3 条",
        status == 200 and len((res or {}).get("schedules") or []) == 3,
        f"{status} {(res or {}).get('schedules')}",
    )

    status, res = rc_client.get(f"/api/captures/{cap_a['id']}")
    c.check("恢复后念头 A 存在", status == 200, str(res))
    c.check("念头 A 原文一致", res["capture"]["rawText"] == "PWM 低占空比时 LED 会闪 [backup-test]")
    c.check("念头 A 归档状态保留", res["capture"]["archivedAt"] is not None)

    status, res = rc_client.get(f"/api/captures/{cap_b['id']}")
    c.check("恢复后念头 B 原文一致", status == 200 and res["capture"]["rawText"] == "调光时想避免肉眼可见闪烁 [backup-test]")

    status, res = rc_client.get(f"/api/attempts/{att_a1['id']}")
    c.check("恢复后尝试 A1 存在", status == 200, str(res))
    a1 = res["attempt"]
    c.check(
        "A1 结果文本为修改后的 v2",
        a1["resultText"] == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]（复测确认）[snap-v2]",
        a1["resultText"],
    )
    c.check("A1 状态 done 保留", a1["state"] == "done")
    c.check("A1 评价 success 保留", a1["outcome"] == "success")
    c.check("A1 observedAt 精确保留", a1["observedAt"] == observed_at)
    c.check("A1 revision = 3 保留", a1["revision"] == 3)

    status, res = rc_client.get(f"/api/attempts/{att_b1['id']}")
    c.check("恢复后尝试 B1 状态 in_progress 保留", status == 200 and res["attempt"]["state"] == "in_progress")

    status, res = rc_client.get(f"/api/attempts/{att_b1['id']}/references")
    c.check("恢复后 B1 的 fromRefs 有 1 条", status == 200 and len(res["fromRefs"]) == 1, str(res))
    r = res["fromRefs"][0] if res["fromRefs"] else {}
    c.check("引用方向 from/to 正确", r.get("fromAttemptId") == att_b1["id"] and r.get("toAttemptId") == att_a1["id"], str(r))
    c.check(
        "引用 snapshotResultText 保持旧快照 v1",
        r.get("snapshotResultText") == "500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁 [snap-v1]",
        str(r.get("snapshotResultText")),
    )
    c.check("引用 snapshotRevision = 2", r.get("snapshotRevision") == 2)
    c.check("引用 note 保留", r.get("note") == "先按 2 kHz 继续验证调光 [backup-test]")
    c.check("引用提示 updatedSinceSnapshot = true", r.get("source", {}).get("updatedSinceSnapshot") is True)
    c.check("引用 source.revision = 3", r.get("source", {}).get("revision") == 3)
    c.check(
        "引用 source.resultText 为最新 v2",
        str(r.get("source", {}).get("resultText", "")).endswith("[snap-v2]"),
    )

    status, res = rc_client.get(f"/api/attempts/{att_a1['id']}/references")
    c.check(
        "反向引用可查（A1 的 toRefs 含 B1）",
        status == 200 and any(x["fromAttemptId"] == att_b1["id"] for x in res["toRefs"]),
    )

    status, res = rc_client.get("/api/captures")
    c.check("恢复后默认列表不含归档 A", all(x["id"] != cap_a["id"] for x in res["captures"]))
    status, res = rc_client.get("/api/captures?archived=1")
    c.check("恢复后 archived=1 列表含 A", any(x["id"] == cap_a["id"] for x in res["captures"]))

    # 恢复库继续使用：新念头 → 新尝试 → 引用旧结果 → 修改结果
    status, res = rc_client.post("/api/captures", {"rawText": "恢复后新增念头 [backup-test]"})
    c.check("恢复库可创建新念头", status == 200, str(res))
    cap_new = res["capture"]
    status, res = rc_client.post(
        f"/api/captures/{cap_new['id']}/attempts",
        {"step": "恢复后新增尝试 [backup-test]", "state": "todo", "operationId": f"bt-new-att-{STAMP}"},
    )
    c.check("恢复库可创建新尝试", status == 200, str(res))
    att_new = res["attempt"]
    status, res = rc_client.post(
        f"/api/attempts/{att_new['id']}/references",
        {"toId": att_a1["id"], "note": "恢复后复用旧结果", "operationId": f"bt-new-ref-{STAMP}"},
    )
    c.check("恢复库可引用旧结果", status == 200, str(res))
    c.check("恢复库新引用快照 revision = 3", res["reference"]["snapshotRevision"] == 3)
    status, res = rc_client.patch(
        f"/api/attempts/{att_new['id']}",
        {"state": "done", "resultText": "恢复后写入结果 [backup-test]", "outcome": "success", "revision": att_new["revision"]},
    )
    c.check("恢复库可写结果", status == 200 and res["attempt"]["revision"] == att_new["revision"] + 1, str(res))
    status, res = rc_client.get(f"/api/attempts/{att_new['id']}")
    c.check("恢复库新结果可读回", status == 200 and res["attempt"]["resultText"] == "恢复后写入结果 [backup-test]")
    status, res = rc_client.get("/api/search?q=%E5%A4%8D%E6%B5%8B%E7%A1%AE%E8%AE%A4")  # 复测确认
    c.check(
        "恢复库搜索命中 A1（索引/数据可用）",
        status == 200 and any(x["id"] == att_a1["id"] for x in res["attempts"]),
        str(res)[:300],
    )
    stop_server("restored")

    # =========================================================== 6. 失败情况
    print("\n### 6. 失败情况：缺失/损坏/目标已存在/空库")
    rc, stdout, stderr = run_restore(MISSING_BACKUP_DB, os.path.join(ROOT, "db", "backup-missing-target.sqlite"))
    c.check("缺失备份 -> 非零退出", rc != 0, f"rc={rc}")
    c.check("缺失备份 -> 明确报错", "不存在" in stderr or "not found" in stderr.lower(), stderr[-400:])
    c.check(
        "缺失备份 -> 未创建目标",
        not os.path.exists(os.path.join(ROOT, "db", "backup-missing-target.sqlite")),
    )

    rc, stdout, stderr = run_node(["scripts/restore.mjs"])
    c.check("缺少 --backup 参数 -> 非零退出并提示用法", rc != 0 and "--backup" in stderr, stderr[-300:])

    with open(BAD_BACKUP_DB, "wb") as f:
        f.write(b"THIS IS NOT A SQLITE DATABASE\n" * 256)
    rc, stdout, stderr = run_restore(BAD_BACKUP_DB, os.path.join(ROOT, "db", "backup-bad-target.sqlite"))
    c.check("损坏备份 -> 非零退出", rc != 0, f"rc={rc}")
    c.check(
        "损坏备份 -> 报错包含校验/无法打开",
        "校验失败" in stderr or "无法作为 SQLite" in stderr or "not a database" in stderr,
        stderr[-400:],
    )
    c.check(
        "损坏备份 -> 未留下目标文件",
        not os.path.exists(os.path.join(ROOT, "db", "backup-bad-target.sqlite")),
    )

    with closing(sqlite3.connect(SCHEMA_LESS_DB)) as conn:
        conn.execute("CREATE TABLE only_one (id INTEGER PRIMARY KEY)")
        conn.commit()
    rc, stdout, stderr = run_restore(SCHEMA_LESS_DB, os.path.join(ROOT, "db", "backup-schema-less-target.sqlite"))
    c.check("缺少核心表的 SQLite 备份 -> 非零退出", rc != 0 and "核心业务表" in stderr, stderr[-400:])

    with open(TARGET_EXISTS_DB, "wb") as f:
        f.write(b"KEEP-ORIGINAL-CONTENT")
    before_hash = file_sha256(TARGET_EXISTS_DB)
    rc, stdout, stderr = run_restore(backup_path, TARGET_EXISTS_DB)
    c.check("目标已存在 -> 非零退出", rc != 0, f"rc={rc}")
    c.check("目标已存在 -> 明确提示不覆盖", "已存在" in stderr and "拒绝覆盖" in stderr, stderr[-500:])
    c.check(
        "目标已存在 -> 提示换路径/先移动或删除",
        "请换一个新路径，或先移动/删除已有文件后重试" in stderr,
        stderr[-500:],
    )
    c.check("目标已存在 -> 原文件内容完全未变", file_sha256(TARGET_EXISTS_DB) == before_hash)
    c.check("目标已存在 -> 未产生 -wal/-shm", not os.path.exists(TARGET_EXISTS_DB + "-wal"))

    # 空库：启动一次让迁移建表，不写业务数据
    start_server("empty_src", PORT_RESTORED, EMPTY_SRC_DB)
    stop_server("empty_src")
    empty_counts = counts(EMPTY_SRC_DB)
    c.check(
        "空库（仅迁移建表）无业务记录",
        empty_counts["captures"] == 0 and empty_counts["attempts"] == 0 and empty_counts["references"] == 0,
        str(empty_counts),
    )
    empty_out = os.path.join(TEST_OUT, "empty")
    rc, stdout, stderr = run_backup(EMPTY_SRC_DB, empty_out)
    empty_backup = single_stdout_line(stdout)
    c.check("空数据库备份成功", rc == 0 and empty_backup and os.path.isfile(empty_backup), stderr[-400:])
    c.check("空数据库备份 integrity ok", bool(empty_backup) and integrity_check(empty_backup) == "ok")
    c.check("空数据库备份含核心表与迁移", bool(empty_backup) and set(CORE_TABLES) <= table_names(empty_backup))
    c.check(
        "空数据库备份含 schedule_blocks 空表",
        bool(empty_backup)
        and SCHEDULE_TABLE in table_names(empty_backup)
        and scalar(empty_backup, "SELECT COUNT(*) FROM schedule_blocks") == 0,
        str(table_names(empty_backup) if empty_backup else None),
    )
    c.check(
        "空数据库备份记录数为 0",
        bool(empty_backup) and counts(empty_backup)["captures"] == 0 and counts(empty_backup)["attempts"] == 0,
    )
    rc, stdout, stderr = run_restore(empty_backup, EMPTY_RESTORED_DB)
    c.check("空数据库备份可恢复", rc == 0 and os.path.isfile(EMPTY_RESTORED_DB), stderr[-500:])
    start_server("empty_restored", PORT_RESTORED, EMPTY_RESTORED_DB)
    empty_client = Client(BASE_RESTORED)
    body = empty_client.login("空库恢复用户")
    c.check("空库恢复后可登录", body.get("ok") is True, str(body))
    status, res = empty_client.get("/api/captures")
    c.check("空库恢复后无记录", status == 200 and res["captures"] == [], str(res))
    status, res = empty_client.post("/api/captures", {"rawText": "空库恢复后新建 [backup-test]"})
    c.check("空库恢复后可继续写入", status == 200, str(res))
    stop_server("empty_restored")

    # =========================================================== 旧库（仅 0000–0004）升级兼容
    print("\n### 旧库（仅 0000–0004）恢复后启动迁移自动加表")
    create_legacy_0004_database(OLD_DB)
    c.check("旧库备份不含 stage_reviews 表", "stage_reviews" not in table_names(OLD_DB), str(sorted(table_names(OLD_DB))))
    c.check("旧库备份不含 schedule_blocks 表", SCHEDULE_TABLE not in table_names(OLD_DB), str(sorted(table_names(OLD_DB))))
    c.check(
        "旧库备份含 0000–0004 迁移记录",
        len([r[0] for r in connect(OLD_DB).execute("SELECT name FROM _migrations ORDER BY name").fetchall()]) == 5,
        str([r[0] for r in connect(OLD_DB).execute("SELECT name FROM _migrations ORDER BY name").fetchall()]),
    )
    rc, stdout, stderr = run_restore(OLD_DB, OLD_RESTORED_DB)
    c.check("旧库备份可被 restore.mjs 恢复", rc == 0 and os.path.isfile(OLD_RESTORED_DB), stderr[-600:])
    start_server("old_restored", PORT_RESTORED, OLD_RESTORED_DB)
    old_client = Client(BASE_RESTORED)
    body = old_client.login("旧库升级用户")
    c.check("旧库恢复后原账号可登录", body.get("ok") is True, str(body))
    c.check("旧库恢复启动后自动创建 stage_reviews 表", "stage_reviews" in table_names(OLD_RESTORED_DB), str(sorted(table_names(OLD_RESTORED_DB))))
    old_attempt_columns = {
        r[1] for r in connect(OLD_RESTORED_DB).execute("PRAGMA table_info(attempts)").fetchall()
    }
    c.check(
        "旧库迁移 0007 后 attempts 新增 7 列均存在",
        {
            "origin",
            "action_description",
            "estimated_minutes",
            "source_review_id",
            "source_experience_index",
            "source_attempt_id",
            "source_attempt_revision",
        }
        <= old_attempt_columns,
        str(sorted(old_attempt_columns)),
    )
    c.check(
        "旧库迁移记录包含 0007_next_actions.sql",
        any(
            "0007_next_actions" in str(r[0])
            for r in connect(OLD_RESTORED_DB)
            .execute("SELECT name FROM _migrations ORDER BY name")
            .fetchall()
        ),
        str(
            [
                r[0]
                for r in connect(OLD_RESTORED_DB)
                .execute("SELECT name FROM _migrations ORDER BY name")
                .fetchall()
            ]
        ),
    )
    old_attempt_row = connect(OLD_RESTORED_DB).execute(
        "SELECT origin, action_description, estimated_minutes, source_review_id, "
        "source_experience_index, source_attempt_id, source_attempt_revision "
        "FROM attempts WHERE id = 'att-old-backup'"
    ).fetchone()
    c.check(
        "旧库既有尝试迁移后 origin=manual 且新增字段为 null",
        bool(old_attempt_row)
        and old_attempt_row["origin"] == "manual"
        and old_attempt_row["action_description"] is None
        and old_attempt_row["estimated_minutes"] is None
        and old_attempt_row["source_review_id"] is None
        and old_attempt_row["source_experience_index"] is None
        and old_attempt_row["source_attempt_id"] is None
        and old_attempt_row["source_attempt_revision"] is None,
        str(dict(old_attempt_row) if old_attempt_row else None),
    )
    c.check(
        "旧备份缺失 schedule_blocks 不被判损坏，启动后迁移补建空表",
        SCHEDULE_TABLE in table_names(OLD_RESTORED_DB)
        and scalar(OLD_RESTORED_DB, "SELECT COUNT(*) FROM schedule_blocks") == 0,
        str(sorted(table_names(OLD_RESTORED_DB))),
    )
    c.check(
        "旧库新表为空（不影响旧数据）",
        scalar(OLD_RESTORED_DB, "SELECT COUNT(*) FROM stage_reviews") == 0,
        str(scalar(OLD_RESTORED_DB, "SELECT COUNT(*) FROM stage_reviews")),
    )
    status, res = old_client.get("/api/captures/cap-old-backup")
    c.check("旧库升级后旧念头完整", status == 200 and res.get("capture", {}).get("rawText") == "旧库里的念头：PWM 低占空比时 LED 会闪", f"{status} {res}")
    status, res = old_client.get("/api/attempts/att-old-backup")
    c.check(
        "旧库升级后旧尝试与结果完整",
        status == 200
        and res.get("attempt", {}).get("resultText") == "旧库里的结果：500 Hz 仍闪烁"
        and res.get("attempt", {}).get("outcome") == "failure",
        f"{status} {res}",
    )
    status, res = old_client.post(
        "/api/attempts/att-old-backup/schedules",
        {
            "date": "2027-06-25",
            "startTime": "09:00",
            "endTime": "10:00",
            "timezone": "Asia/Shanghai",
            "note": "旧库升级后新增日程",
            "operationId": f"bt-old-sch-{STAMP}",
        },
    )
    c.check("旧库升级后可新增日程安排", status in (200, 201), f"{status} {res}")
    old_schedule = (res or {}).get("schedule") or {}
    status, res = old_client.patch(
        f"/api/schedules/{old_schedule.get('id')}",
        {
            "date": "2027-06-25",
            "startTime": "09:00",
            "endTime": "10:00",
            "timezone": "Asia/Shanghai",
            "note": "旧库升级后修改备注",
            "revision": old_schedule.get("revision"),
        },
    )
    c.check(
        "旧库升级后可修改日程备注",
        status == 200 and ((res or {}).get("schedule") or {}).get("note") == "旧库升级后修改备注",
        f"{status} {res}",
    )
    status, res = old_client.get("/api/attempts/att-old-backup/schedules")
    c.check(
        "旧库升级后日程列表可读",
        status == 200 and any(x.get("id") == old_schedule.get("id") for x in (res or {}).get("schedules") or []),
        f"{status} {res}",
    )
    status, res = old_client.get("/api/reviews?limit=50")
    c.check("旧库升级后回顾列表可用且为空", status == 200 and res.get("total") == 0 and res.get("reviews") == [], f"{status} {res}")
    stop_server("old_restored")

    # 失败操作后原库仍可读写
    status, res = client.post("/api/captures", {"rawText": "失败用例后仍可写 [backup-test]"})
    c.check("失败用例后原库仍可新建念头", status == 200, str(res))
    cap_after_fail = res["capture"]
    status, res = client.post(
        f"/api/captures/{cap_after_fail['id']}/attempts",
        {"step": "失败用例后仍可写尝试 [backup-test]", "operationId": f"bt-after-fail-{STAMP}"},
    )
    c.check("失败用例后原库仍可新建尝试", status == 200, str(res))
    status, res = client.get(f"/api/captures/{cap_after_fail['id']}")
    c.check("失败用例后原库仍可读回", status == 200 and res["capture"]["rawText"] == "失败用例后仍可写 [backup-test]")

    # =========================================================== 7. 备份期间并发写入
    print("\n### 7. 备份期间并发写入，验证一致快照")
    status, res = client.post("/api/captures", {"rawText": "并发备份压力数据 [backup-test]"})
    pressure_cap = res["capture"]
    bulk_rows = 1500
    payload = "压力数据" * 2000  # 约 8000 字符 / 行，撑大页面数，让备份持续足够久
    now_ms = int(time.time() * 1000)
    with closing(sqlite3.connect(SRC_DB, timeout=20)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executemany(
            "INSERT INTO attempts (id, capture_id, step, state, result_text, outcome, source_url, "
            "observed_at, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    f"bulk-{STAMP}-{i}",
                    pressure_cap["id"],
                    f"压力步骤 {i}",
                    "done",
                    payload,
                    "undetermined",
                    None,
                    now_ms,
                    1,
                    now_ms,
                    now_ms,
                )
                for i in range(bulk_rows)
            ],
        )
        conn.commit()
    c.check("并发演练前已写入大批量数据", counts(SRC_DB)["attempts"] >= bulk_rows, str(counts(SRC_DB)))

    writer = Writer(BASE_MAIN, f"w{STAMP}")
    writer.start()
    time.sleep(0.4)
    pre_counts = counts(SRC_DB)
    concurrent_out = os.path.join(TEST_OUT, "concurrent")
    backup_start = time.monotonic()
    rc, stdout, stderr = run_backup(SRC_DB, concurrent_out)
    backup_end = time.monotonic()
    writer.stop_event.set()
    writer.join(timeout=30)
    post_counts = counts(SRC_DB)
    concurrent_backup = single_stdout_line(stdout)

    c.check("并发写入线程完成了写入", writer.iterations > 0, f"iterations={writer.iterations} errors={writer.errors[:2]}")
    c.check("备份期间确有写入发生（时间窗重叠）", any(iv[0] < backup_end and iv[1] > backup_start for iv in writer.intervals),
            f"backup=[{backup_start:.3f},{backup_end:.3f}] first={writer.intervals[:1]}")
    c.check("并发备份退出码 0", rc == 0, stderr[-800:])
    c.check("并发备份文件存在", bool(concurrent_backup) and os.path.isfile(concurrent_backup))
    c.check("并发备份 integrity_check = ok", bool(concurrent_backup) and integrity_check(concurrent_backup) == "ok")
    c.check(
        "并发备份核心表齐全",
        bool(concurrent_backup) and set(CORE_TABLES) <= table_names(concurrent_backup),
    )
    c.check(
        "并发备份含 schedule_blocks 且日程仍在",
        bool(concurrent_backup)
        and SCHEDULE_TABLE in table_names(concurrent_backup)
        and scalar(concurrent_backup, "SELECT COUNT(*) FROM schedule_blocks") >= 2,
        str(table_names(concurrent_backup) if concurrent_backup else None),
    )

    if concurrent_backup and os.path.isfile(concurrent_backup):
        conc_counts = counts(concurrent_backup)
        c.check(
            "并发备份记录数位于备份前/后之间（某一时刻快照）",
            pre_counts["captures"] <= conc_counts["captures"] <= post_counts["captures"]
            and pre_counts["attempts"] <= conc_counts["attempts"] <= post_counts["attempts"]
            and pre_counts["references"] <= conc_counts["references"] <= post_counts["references"],
            f"pre={pre_counts} backup={conc_counts} post={post_counts}",
        )
        with closing(connect(concurrent_backup)) as conn:
            fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
            orphan_from = conn.execute(
                "SELECT COUNT(*) FROM attempt_references r "
                "LEFT JOIN attempts a ON a.id = r.from_attempt_id WHERE a.id IS NULL"
            ).fetchone()[0]
            orphan_to = conn.execute(
                "SELECT COUNT(*) FROM attempt_references r "
                "LEFT JOIN attempts a ON a.id = r.to_attempt_id WHERE a.id IS NULL"
            ).fetchone()[0]
            orphan_schedules = conn.execute(
                "SELECT COUNT(*) FROM schedule_blocks s "
                "LEFT JOIN attempts a ON a.id = s.attempt_id WHERE a.id IS NULL"
            ).fetchone()[0]
            ref_total = conn.execute("SELECT COUNT(*) FROM attempt_references").fetchone()[0]
        c.check("并发备份 foreign_key_check 无错误", len(fk_errors) == 0, str(fk_errors[:3]))
        c.check("并发备份引用 from 均存在", orphan_from == 0, f"orphan_from={orphan_from}")
        c.check("并发备份引用 to 均存在", orphan_to == 0, f"orphan_to={orphan_to}")
        c.check("并发备份日程 attempt 均存在", orphan_schedules == 0, f"orphan_schedules={orphan_schedules}")
        c.check("并发备份包含引用记录", ref_total >= 1, f"refs={ref_total}")
        c.check(
            "并发写入使记录数增长",
            post_counts["captures"] > pre_counts["captures"] and post_counts["attempts"] > pre_counts["attempts"],
            f"pre={pre_counts} post={post_counts}",
        )
        print(
            f"  并发备份: {concurrent_backup} ({os.path.getsize(concurrent_backup)} 字节, "
            f"耗时 {backup_end - backup_start:.2f}s, 写入迭代 {writer.iterations})"
        )
        print(f"  计数 pre={pre_counts} backup={conc_counts} post={post_counts}")

    # 并发备份后原库仍可读写
    status, res = client.post("/api/captures", {"rawText": "并发备份后原库可写 [backup-test]"})
    c.check("并发备份后原库仍可写", status == 200, str(res))
    status, res = client.get("/api/captures")
    c.check("并发备份后原库仍可读", status == 200 and len(res["captures"]) > 0)

    # =========================================================== 统计
    print("\n" + "-" * 60)
    print(f"演练产物目录: {TEST_OUT}")
    print(f"演练源库: {SRC_DB}")
    print(f"恢复库: {RESTORED_DB}")
    ok = c.report("备份/恢复演练")
    return 0 if ok else 1


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # 未预期异常也要保证服务停止
        print(f"FAIL  演练异常终止: {exc!r}")
        import traceback

        traceback.print_exc()
        exit_code = 1
    finally:
        for name in list(servers):
            try:
                stop_server(name)
            except Exception:
                pass
        if exit_code == 0 and not os.environ.get("SHINIAN_KEEP_TEST_ARTIFACTS"):
            try:
                for path in TEST_DBS:
                    remove_db(path)
                shutil.rmtree(TEST_OUT, ignore_errors=True)
                print("演练库与临时备份已清理（设置 SHINIAN_KEEP_TEST_ARTIFACTS=1 可保留）。")
            except Exception as err:
                print(f"警告: 演练通过，但清理临时文件失败: {err!r}")
        elif exit_code != 0:
            print("演练失败，已保留临时库与备份以便排查。")
    sys.exit(exit_code)
