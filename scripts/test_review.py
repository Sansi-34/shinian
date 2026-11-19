"""拾念 SHINIAN · 「阶段回顾」验收测试

针对运行中的测试服务（SHINIAN_BASE，默认 http://127.0.0.1:3100）执行契约验收。
脚本自行启动/停止 scripts/fake_model_server.py（默认 127.0.0.1:3501），
不启动/停止被测服务本身（3100 由 run_tests.py 负责）。

覆盖 docs/review-api-contract.md §9.1：
- 未登录 401、非法范围/时区/preset、空数据、statDefinitions 完整
- Asia/Shanghai 日界 from-1/from/to-1/to 精确包含/排除，跨日、跨月
- 修改旧记录：attemptsStarted 不变、attemptsModified 增加、结果数不重复
- 缺少 observedAt 的结果单独计数
- >80 条预览超限 / 生成 409；>500 条 range 截断
- 预览排除记录后，返回与真实 prompt 都不含未选内容
- 未配置模型、模型编造来源、合法来源、取消
- 保存/重复保存/列表/详情/来源修改/来源删除/所属念头删除
- 导出 schemaVersion=6 与 stageReviews；旧 schemaVersion=1/v2 兼容
- 密钥不出现在回顾响应、导出与测试服务日志
"""
import json
import os
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
from datetime import datetime, timedelta, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("SHINIAN_BASE", "http://127.0.0.1:3100").rstrip("/")
TEST_DB = os.environ.get("SHINIAN_TEST_DB") or os.path.join(ROOT, "db", "test.sqlite")
SERVER_LOG = os.environ.get("SHINIAN_TEST_LOG") or os.path.join(ROOT, "db", "test-server.log")
FAKE_PORT = int(os.environ.get("SHINIAN_FAKE_PORT", "3501"))
FAKE_BASE = f"http://127.0.0.1:{FAKE_PORT}"
SECRET_KEY = "test-secret-key"
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}

c = Checker()
client = Client(base=BASE)
uid = uuid.uuid4().hex[:8]
RESPONSE_TEXTS = []
_orig_request = client.request


def recorded_request(method, path, data=None):
    status, res = _orig_request(method, path, data)
    try:
        RESPONSE_TEXTS.append(json.dumps(res, ensure_ascii=False))
    except (TypeError, ValueError):
        RESPONSE_TEXTS.append(str(res))
    return status, res


client.request = recorded_request

fake_proc = None

# ---------------------------------------------------------------- 时间工具
SH_TZ = timezone(timedelta(hours=8))


def ms(year, month, day, hour=0, minute=0, second=0):
    return int(datetime(year, month, day, hour, minute, second, tzinfo=SH_TZ).timestamp() * 1000)


def iso_of(value):
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ---------------------------------------------------------------- 假模型服务
def port_open(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_port(host, port, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(host, port):
            return True
        time.sleep(0.15)
    return False


def fake_get(path):
    with urllib.request.urlopen(FAKE_BASE + path, timeout=5) as res:
        return json.loads(res.read().decode("utf-8"))


def fake_last():
    return (fake_get("/__last").get("request") or {})


def fake_user_prompt():
    body = fake_last().get("body") or {}
    parts = []
    for message in body.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        parts.append(item["text"])
    return "\n".join(parts)


def start_fake_server():
    global fake_proc
    if port_open("127.0.0.1", FAKE_PORT):
        try:
            health = fake_get("/__health")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"端口 {FAKE_PORT} 被占用且不是 fake model server：{exc}")
        if health.get("service") == "shinian-fake-model":
            print(f"复用已在运行的 fake model server: {FAKE_BASE}")
            return
        raise RuntimeError(f"端口 {FAKE_PORT} 被其他进程占用")
    fake_proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "scripts", "fake_model_server.py")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not wait_port("127.0.0.1", FAKE_PORT):
        raise RuntimeError("fake model server 未能启动")
    print(f"已启动 fake model server: {FAKE_BASE}")


def stop_fake_server():
    global fake_proc
    if fake_proc is None:
        return
    fake_proc.terminate()
    try:
        fake_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        fake_proc.kill()
        fake_proc.wait(timeout=5)
    fake_proc = None


# ---------------------------------------------------------------- API 工具
def q(path, **params):
    # `from` 是 Python 关键字：调用方用 from_= 传入，这里还原为契约参数名
    if "from_" in params:
        params["from"] = params.pop("from_")
    return path + "?" + urllib.parse.urlencode(params)


def range_response(frm, to, preset="custom", timezone_name="Asia/Shanghai"):
    return client.get(
        q("/api/review/range", from_=frm, to=to, timezone=timezone_name, preset=preset)
    )


def preview_response(frm, to, include_keys, preset="custom"):
    return client.post(
        "/api/review/preview",
        {
            "from": frm,
            "to": to,
            "timezone": "Asia/Shanghai",
            "preset": preset,
            "includeKeys": list(include_keys),
        },
    )


def start_review(frm, to, include_keys, preset="custom", operation_id=None, context_token=None):
    token = context_token
    if token is None:
        st, prev = preview_response(frm, to, include_keys, preset)
        assert st == 200, f"预览失败 {st} {prev}"
        token = prev.get("contextToken")
    op = operation_id or f"op-review-{uuid.uuid4().hex[:12]}"
    status, res = client.post(
        "/api/reviews",
        {
            "from": frm,
            "to": to,
            "timezone": "Asia/Shanghai",
            "preset": preset,
            "includeKeys": list(include_keys),
            "contextToken": token,
            "operationId": op,
        },
    )
    return status, res


def wait_review(review_id, timeout=30.0):
    deadline = time.time() + timeout
    last = None
    status = None
    while time.time() < deadline:
        status, res = client.get(f"/api/reviews/{review_id}")
        if status != 200:
            return status, res
        last = (res or {}).get("review")
        if last and last.get("status") in TERMINAL:
            return status, res
        time.sleep(0.25)
    return status or 200, {"review": last, "_poll_timeout": True}


def configure(model, api_key=SECRET_KEY):
    status, res = client.request(
        "PUT",
        "/api/settings/ai",
        {
            "name": "回顾测试模型",
            "baseUrl": f"{FAKE_BASE}/v1",
            "modelId": model,
            "enabled": True,
            "allowLocal": True,
            "apiKey": api_key,
        },
    )
    c.check(f"配置假模型 {model}", status == 200 and (res or {}).get("configured") is True, f"{status} {res}")
    return res


# ---------------------------------------------------------------- 数据库工具
def db_connect():
    conn = sqlite3.connect(TEST_DB, timeout=20)
    conn.execute("PRAGMA busy_timeout=20000")
    return conn


def insert_capture(conn, capture_id, text, created_at, updated_at=None, revision=1, archived_at=None):
    conn.execute(
        "INSERT INTO captures (id, raw_text, revision, created_at, updated_at, archived_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (capture_id, text, revision, created_at, updated_at if updated_at is not None else created_at, archived_at),
    )


def insert_attempt(
    conn,
    attempt_id,
    capture_id,
    step,
    created_at,
    updated_at=None,
    state="todo",
    result_text=None,
    outcome=None,
    observed_at=None,
    revision=1,
    source_url=None,
):
    conn.execute(
        "INSERT INTO attempts (id, capture_id, step, state, result_text, outcome, source_url, "
        "observed_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            attempt_id,
            capture_id,
            step,
            state,
            result_text,
            outcome,
            source_url,
            observed_at,
            revision,
            created_at,
            updated_at if updated_at is not None else created_at,
        ),
    )


def insert_reference(conn, ref_id, from_id, to_id, created_at, note=None, snapshot_text=None, snapshot_revision=1):
    conn.execute(
        "INSERT INTO attempt_references (id, from_attempt_id, to_attempt_id, revision, note, "
        "snapshot_result_text, snapshot_revision, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
        (ref_id, from_id, to_id, note, snapshot_text, snapshot_revision, created_at),
    )


def db_commit(fn):
    with closing(db_connect()) as conn:
        fn(conn)
        conn.commit()


def capture_key(capture_id):
    return f"capture:{capture_id}"


def attempt_key(attempt_id):
    return f"attempt:{attempt_id}"


def reference_key(reference_id):
    return f"reference:{reference_id}"


# ---------------------------------------------------------------- 断言工具
STAT_KEYS = [
    "capturesCreated",
    "capturesModified",
    "attemptsStarted",
    "attemptsModified",
    "attemptsCurrentlyEnded",
    "resultsRecorded",
    "resultsMissingObservedAt",
    "referencesCreated",
    "totalRecords",
]


def check_stat_definitions(label, body):
    defs = (body or {}).get("statDefinitions")
    c.check(f"{label}：statDefinitions 为 9 项", isinstance(defs, list) and len(defs) == 9, str(defs)[:300])
    if not isinstance(defs, list):
        return
    keys = [d.get("key") for d in defs if isinstance(d, dict)]
    c.check(f"{label}：statDefinitions 覆盖全部统计字段", set(keys) == set(STAT_KEYS), str(keys))
    c.check(
        f"{label}：statDefinitions 每项带 label/definition/value",
        all(
            isinstance(d.get("label"), str) and d.get("label").strip()
            and isinstance(d.get("definition"), str) and d.get("definition").strip()
            and isinstance(d.get("value"), int)
            for d in defs
        ),
        str(defs)[:300],
    )
    stats = (body or {}).get("stats") or {}
    c.check(
        f"{label}：statDefinitions.value 与 stats 一致",
        all(d.get("value") == stats.get(d.get("key")) for d in defs if isinstance(d, dict)),
        str([(d.get("key"), d.get("value"), stats.get(d.get("key"))) for d in defs])[:500],
    )
    c.check(
        f"{label}：统计口径不含历史推断措辞",
        all("完成了几次" not in (d.get("definition") or "") and "结束了几次" not in (d.get("definition") or "") for d in defs),
        str([d.get("definition") for d in defs])[:300],
    )


def check_sections(label, body, expected):
    sections = (body or {}).get("sections") or {}
    c.check(
        f"{label}：sections 五个分组齐全",
        set(sections.keys()) == {"captures", "attempts", "results", "references", "modifications"},
        str(list(sections.keys())),
    )
    for name, keys in expected.items():
        c.check(f"{label}：sections.{name} 精确", set(sections.get(name) or []) == set(keys), str(sections.get(name)))


def record_map(body):
    return {(r or {}).get("key"): r for r in ((body or {}).get("records") or [])}


def check_record_exists(label, body, key):
    rec = record_map(body).get(key)
    c.check(f"{label}：记录 {key} 存在", rec is not None, str(sorted(record_map(body).keys()))[:300])
    return rec


# ---------------------------------------------------------------- 主流程
def main():
    print(f"测试服务: {BASE}")
    print(f"测试库: {TEST_DB}")
    start_fake_server()

    def conn_check(name, fn):
        try:
            fn()
            c.check(name, True)
        except Exception as exc:  # noqa: BLE001
            c.check(name, False, repr(exc))

    # ============================================================ 1. 未登录与参数校验
    print("\n### 1. 未登录与参数校验")
    anon = Client(base=BASE)
    valid_range = q(
        "/api/review/range",
        from_=ms(2026, 9, 10),
        to=ms(2026, 9, 11),
        timezone="Asia/Shanghai",
        preset="custom",
    )
    st, _ = anon.get(valid_range)
    c.check("未登录 range 返回 401", st == 401, str(st))
    st, _ = anon.get("/api/reviews")
    c.check("未登录回顾列表返回 401", st == 401, str(st))
    st, _ = anon.get("/api/reviews/rev-x")
    c.check("未登录回顾详情返回 401", st == 401, str(st))
    st, _ = anon.post(
        "/api/review/preview",
        {"from": ms(2026, 9, 10), "to": ms(2026, 9, 11), "timezone": "Asia/Shanghai", "includeKeys": ["capture:x"]},
    )
    c.check("未登录 preview 返回 401", st == 401, str(st))
    st, _ = anon.post(
        "/api/reviews",
        {
            "from": ms(2026, 9, 10),
            "to": ms(2026, 9, 11),
            "timezone": "Asia/Shanghai",
            "includeKeys": ["capture:x"],
            "contextToken": "x",
            "operationId": "op-anon",
        },
    )
    c.check("未登录创建回顾返回 401", st == 401, str(st))
    st, _ = anon.post("/api/reviews/rev-x/save", {})
    c.check("未登录保存回顾返回 401", st == 401, str(st))
    st, _ = anon.post("/api/reviews/rev-x/cancel", {})
    c.check("未登录取消回顾返回 401", st == 401, str(st))

    body = client.login(f"回顾测试用户-{uid}")
    c.check("创建/登录独立回顾测试账号", body.get("ok") is True, str(body))

    st, res = client.get("/api/review/range?" + urllib.parse.urlencode({"to": ms(2026, 9, 11), "timezone": "Asia/Shanghai"}))
    c.check("缺 from 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = range_response(0, ms(2026, 9, 11))
    c.check("from=0 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = range_response(ms(2026, 9, 11), ms(2026, 9, 11))
    c.check("to<=from 返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = range_response(ms(2025, 1, 1), ms(2026, 1, 3))
    c.check("跨度超过 366 天返回 400 invalid_range", st == 400 and res.get("error") == "invalid_range", f"{st} {res}")
    st, res = range_response(ms(2026, 9, 10), ms(2026, 9, 11), timezone_name="Not/AZone")
    c.check("非法时区返回 400 invalid_timezone", st == 400 and res.get("error") == "invalid_timezone", f"{st} {res}")
    st, res = range_response(ms(2026, 9, 10), ms(2026, 9, 11), timezone_name="A" * 81)
    c.check("超长时区返回 400 invalid_timezone", st == 400 and res.get("error") == "invalid_timezone", f"{st} {res}")
    st, res = range_response(ms(2026, 9, 10), ms(2026, 9, 11), preset="1d")
    c.check("非法 preset 返回 400 invalid_preset", st == 400 and res.get("error") == "invalid_preset", f"{st} {res}")

    # 空数据范围：使用远早于所有测试数据的区间
    EMPTY_FROM, EMPTY_TO = ms(2019, 1, 1), ms(2019, 1, 2)
    st, empty = range_response(EMPTY_FROM, EMPTY_TO)
    c.check("空数据 range 返回 200", st == 200, f"{st} {empty}")
    empty_stats = (empty or {}).get("stats") or {}
    c.check("空数据 stats 全为 0", all(empty_stats.get(k) == 0 for k in STAT_KEYS), str(empty_stats))
    c.check("空数据 records 为空", (empty or {}).get("records") == [], str((empty or {}).get("records"))[:200])
    check_sections("空数据", empty, {k: [] for k in ("captures", "attempts", "results", "references", "modifications")})
    check_stat_definitions("空数据", empty)
    c.check(
        "空数据 coverage 完整",
        (empty or {}).get("coverage", {}).get("totalRecords") == 0
        and (empty or {}).get("coverage", {}).get("uniqueKeys") == 0
        and (empty or {}).get("coverage", {}).get("truncated") is False
        and (empty or {}).get("coverage", {}).get("maxRangeRecords") == 500,
        str((empty or {}).get("coverage")),
    )
    c.check(
        "range 返回 limits.maxRecords/maxChars/maxRangeDays",
        (empty or {}).get("limits") == {"maxRecords": 80, "maxChars": 16000, "maxRangeDays": 366},
        str((empty or {}).get("limits")),
    )

    # ============================================================ 2. 时间边界
    print("\n### 2. Asia/Shanghai 时间边界")
    DAY_FROM, DAY_TO = ms(2026, 9, 10), ms(2026, 9, 11)
    base_cap = f"cap-rv-bound-base-{uid}"
    base_atts = []
    boundary_ids = {}

    def seed_day_boundary(conn):
        insert_capture(conn, base_cap, f"边界测试基础念头 {uid}", DAY_FROM - 10 * 86400000)
        for i in range(4):
            aid = f"att-rv-bound-base-{uid}-{i}"
            base_atts.append(aid)
            insert_attempt(conn, aid, base_cap, f"边界基础尝试 {i}", DAY_FROM - 9 * 86400000, result_text=f"基础结果 {i}")
        points = {
            "before": (DAY_FROM - 1, "from-1"),
            "from": (DAY_FROM, "from"),
            "to_minus": (DAY_TO - 1, "to-1"),
            "to": (DAY_TO, "to"),
        }
        for tag, (at, _label) in points.items():
            cid = f"cap-rv-day-{tag}-{uid}"
            boundary_ids[f"cap_{tag}"] = cid
            insert_capture(conn, cid, f"日界念头 {tag} {uid}", at)
        for tag in ("from", "to_minus", "to"):
            aid = f"att-rv-day-{tag}-{uid}"
            boundary_ids[f"att_{tag}"] = aid
            insert_attempt(conn, aid, base_cap, f"日界尝试 {tag} {uid}", points[tag][0])
        for i, tag in enumerate(("before", "from", "to_minus", "to")):
            rid = f"ref-rv-day-{tag}-{uid}"
            boundary_ids[f"ref_{tag}"] = rid
            insert_reference(
                conn,
                rid,
                base_atts[i],
                base_atts[(i + 1) % 4],
                points[tag][0],
                note=f"日界引用 {tag}",
                snapshot_text=f"基础结果 {i}",
            )

    conn_check("写入日界测试记录", lambda: db_commit(seed_day_boundary))

    st, day = range_response(DAY_FROM, DAY_TO)
    c.check("日界 range 返回 200", st == 200, f"{st} {day}")
    c.check(
        "range 精确回显 from/to/timezone/preset",
        (day or {}).get("range", {}).get("from") == DAY_FROM
        and (day or {}).get("range", {}).get("to") == DAY_TO
        and (day or {}).get("range", {}).get("timezone") == "Asia/Shanghai"
        and (day or {}).get("range", {}).get("preset") == "custom"
        and (day or {}).get("range", {}).get("endExclusive") is True,
        str((day or {}).get("range")),
    )
    c.check(
        "fromIso/toIso 为精确 UTC 边界",
        (day or {}).get("range", {}).get("fromIso") == iso_of(DAY_FROM)
        and (day or {}).get("range", {}).get("toIso") == iso_of(DAY_TO),
        f"{(day or {}).get('range', {}).get('fromIso')} / {(day or {}).get('range', {}).get('toIso')}",
    )
    c.check(
        "fromLocal/toLocal 按 Asia/Shanghai 格式化",
        (day or {}).get("range", {}).get("fromLocal") == "2026-09-10 00:00"
        and (day or {}).get("range", {}).get("toLocal") == "2026-09-11 00:00",
        f"{(day or {}).get('range', {}).get('fromLocal')} / {(day or {}).get('range', {}).get('toLocal')}",
    )
    day_stats = (day or {}).get("stats") or {}
    c.check(
        "日界统计：from 含、to 不含",
        day_stats.get("capturesCreated") == 2 and day_stats.get("attemptsStarted") == 2 and day_stats.get("referencesCreated") == 2,
        str(day_stats),
    )
    c.check("日界统计：totalRecords=6", day_stats.get("totalRecords") == 6, str(day_stats))
    check_sections(
        "日界",
        day,
        {
            "captures": [capture_key(boundary_ids["cap_from"]), capture_key(boundary_ids["cap_to_minus"])],
            "attempts": [attempt_key(boundary_ids["att_from"]), attempt_key(boundary_ids["att_to_minus"])],
            "results": [],
            "references": [reference_key(boundary_ids["ref_from"]), reference_key(boundary_ids["ref_to_minus"])],
            "modifications": [],
        },
    )
    c.check(
        "日界记录不含 from-1 / to 两点",
        all(
            key in record_map(day)
            for key in (
                capture_key(boundary_ids["cap_from"]),
                capture_key(boundary_ids["cap_to_minus"]),
                attempt_key(boundary_ids["att_from"]),
                attempt_key(boundary_ids["att_to_minus"]),
            )
        )
        and capture_key(boundary_ids["cap_before"]) not in record_map(day)
        and capture_key(boundary_ids["cap_to"]) not in record_map(day)
        and attempt_key(boundary_ids["att_to"]) not in record_map(day),
        str(sorted(record_map(day).keys())),
    )
    check_stat_definitions("日界", day)

    # 跨日
    CD_FROM, CD_TO = ms(2026, 10, 5, 23), ms(2026, 10, 6, 1)
    cd_ids = {}

    def seed_cross_day(conn):
        for tag, at in (
            ("before", CD_FROM - 1),
            ("from", CD_FROM),
            ("to_minus", CD_TO - 1),
            ("to", CD_TO),
        ):
            cid = f"cap-rv-cd-{tag}-{uid}"
            cd_ids[tag] = cid
            insert_capture(conn, cid, f"跨日边界 {tag} {uid}", at)

    conn_check("写入跨日边界记录", lambda: db_commit(seed_cross_day))
    st, cross_day = range_response(CD_FROM, CD_TO)
    c.check("跨日 range 返回 200", st == 200, f"{st} {cross_day}")
    c.check(
        "跨日 fromLocal/toLocal 跨过午夜",
        (cross_day or {}).get("range", {}).get("fromLocal") == "2026-10-05 23:00"
        and (cross_day or {}).get("range", {}).get("toLocal") == "2026-10-06 01:00",
        str((cross_day or {}).get("range")),
    )
    c.check(
        "跨日边界只包含 from 与 to-1",
        set(record_map(cross_day).keys()) == {capture_key(cd_ids["from"]), capture_key(cd_ids["to_minus"])}
        and (cross_day or {}).get("stats", {}).get("capturesCreated") == 2,
        f"{sorted(record_map(cross_day).keys())} / {(cross_day or {}).get('stats')}",
    )

    # 跨月
    CM_FROM, CM_TO = ms(2026, 10, 31, 22), ms(2026, 11, 1, 2)
    cm_ids = {}

    def seed_cross_month(conn):
        for tag, at in (
            ("before", CM_FROM - 1),
            ("from", CM_FROM),
            ("to_minus", CM_TO - 1),
            ("to", CM_TO),
        ):
            cid = f"cap-rv-cm-{tag}-{uid}"
            cm_ids[tag] = cid
            insert_capture(conn, cid, f"跨月边界 {tag} {uid}", at)

    conn_check("写入跨月边界记录", lambda: db_commit(seed_cross_month))
    st, cross_month = range_response(CM_FROM, CM_TO)
    c.check("跨月 range 返回 200", st == 200, f"{st} {cross_month}")
    c.check(
        "跨月 fromLocal/toLocal 跨过月份",
        (cross_month or {}).get("range", {}).get("fromLocal") == "2026-10-31 22:00"
        and (cross_month or {}).get("range", {}).get("toLocal") == "2026-11-01 02:00",
        str((cross_month or {}).get("range")),
    )
    c.check(
        "跨月边界只包含 from 与 to-1",
        set(record_map(cross_month).keys()) == {capture_key(cm_ids["from"]), capture_key(cm_ids["to_minus"])}
        and (cross_month or {}).get("stats", {}).get("capturesCreated") == 2,
        f"{sorted(record_map(cross_month).keys())} / {(cross_month or {}).get('stats')}",
    )

    # ============================================================ 3. 修改旧记录
    print("\n### 3. 修改旧记录与统计口径")
    # 修改时间取「当前时刻」，范围必须覆盖今天；使用固定 2026-11 日期会在跨日后过期。
    NOW_MS = int(time.time() * 1000)
    MOD_FROM, MOD_TO = NOW_MS - 3 * 86400000, NOW_MS + 86400000
    old_cap = f"cap-rv-mod-old-{uid}"
    old_att = f"att-rv-mod-old-{uid}"
    old_created = MOD_FROM - 10 * 86400000
    old_observed = MOD_FROM - 11 * 86400000

    def seed_old(conn):
        insert_capture(conn, old_cap, f"修改前旧念头 {uid}", old_created)
        insert_attempt(
            conn,
            old_att,
            old_cap,
            f"修改前旧尝试 {uid}",
            old_created,
            state="done",
            result_text=f"修改前旧结果 {uid}",
            outcome="failure",
            observed_at=old_observed,
        )

    conn_check("写入范围前的旧尝试", lambda: db_commit(seed_old))

    st, before_mod = range_response(MOD_FROM, MOD_TO)
    c.check("修改前 range 返回 200", st == 200, f"{st} {before_mod}")
    before_stats = (before_mod or {}).get("stats") or {}

    status, res = client.patch(
        f"/api/attempts/{old_att}",
        {"state": "done", "resultText": f"编辑后的旧结果 {uid}", "outcome": "success", "revision": 1},
    )
    c.check("PATCH 修改旧尝试成功", status == 200 and res.get("attempt", {}).get("revision") == 2, f"{status} {res}")
    c.check(
        "编辑旧结果保留原 observedAt（不刷新为现在）",
        res.get("attempt", {}).get("observedAt") == old_observed,
        str(res.get("attempt", {}).get("observedAt")),
    )
    status, res = client.patch(f"/api/captures/{old_cap}", {"rawText": f"修改后的旧念头 {uid}", "revision": 1})
    c.check("PATCH 修改旧念头成功", status == 200 and res.get("capture", {}).get("revision") == 2, f"{status} {res}")

    st, after_mod = range_response(MOD_FROM, MOD_TO)
    c.check("修改后 range 返回 200", st == 200, f"{st} {after_mod}")
    after_stats = (after_mod or {}).get("stats") or {}
    c.check(
        "修改旧尝试不增加 attemptsStarted",
        after_stats.get("attemptsStarted") == before_stats.get("attemptsStarted"),
        f"{before_stats.get('attemptsStarted')} -> {after_stats.get('attemptsStarted')}",
    )
    c.check(
        "修改旧尝试使 attemptsModified +1",
        after_stats.get("attemptsModified") == before_stats.get("attemptsModified", 0) + 1,
        f"{before_stats.get('attemptsModified')} -> {after_stats.get('attemptsModified')}",
    )
    c.check(
        "修改旧结果不增加 resultsRecorded",
        after_stats.get("resultsRecorded") == before_stats.get("resultsRecorded"),
        f"{before_stats.get('resultsRecorded')} -> {after_stats.get('resultsRecorded')}",
    )
    c.check(
        "修改旧念头使 capturesModified +1",
        after_stats.get("capturesModified") == before_stats.get("capturesModified", 0) + 1,
        f"{before_stats.get('capturesModified')} -> {after_stats.get('capturesModified')}",
    )
    c.check(
        "修改只是记录变更：totalRecords +2",
        after_stats.get("totalRecords") == before_stats.get("totalRecords", 0) + 2,
        f"{before_stats.get('totalRecords')} -> {after_stats.get('totalRecords')}",
    )
    mod_rec = record_map(after_mod)
    c.check(
        "修改记录出现在 modifications 且原因正确",
        attempt_key(old_att) in (after_mod or {}).get("sections", {}).get("modifications", [])
        and capture_key(old_cap) in (after_mod or {}).get("sections", {}).get("modifications", [])
        and "attempt_modified" in (mod_rec.get(attempt_key(old_att)) or {}).get("reasons", [])
        and "capture_modified" in (mod_rec.get(capture_key(old_cap)) or {}).get("reasons", []),
        str((after_mod or {}).get("sections")),
    )
    c.check(
        "修改记录保留旧 observedAt",
        (mod_rec.get(attempt_key(old_att)) or {}).get("observedAt") == old_observed,
        str((mod_rec.get(attempt_key(old_att)) or {}).get("observedAt")),
    )

    # ============================================================ 4. 缺少结果时间
    print("\n### 4. 有结果但缺少 observedAt 的单独计数")
    PM_FROM, PM_TO = ms(2026, 7, 1), ms(2026, 7, 2)
    pm_cap = f"cap-rv-pm-{uid}"
    pm_unknown = f"att-rv-pm-unknown-{uid}"
    pm_known = f"att-rv-pm-known-{uid}"

    def seed_partial(conn):
        insert_capture(conn, pm_cap, f"部分结果测试 {uid}", PM_FROM - 86400000)
        insert_attempt(
            conn,
            pm_unknown,
            pm_cap,
            f"有结果无时间 {uid}",
            PM_FROM + 3600000,
            state="done",
            result_text=f"结果文本但没有观察时间 {uid}",
            outcome="undetermined",
            observed_at=None,
        )
        insert_attempt(
            conn,
            pm_known,
            pm_cap,
            f"有结果有时间 {uid}",
            PM_FROM + 2 * 3600000,
            state="done",
            result_text=f"结果文本且有观察时间 {uid}",
            outcome="success",
            observed_at=PM_FROM + 2 * 3600000,
        )

    conn_check("写入部分缺少结果时间的尝试", lambda: db_commit(seed_partial))
    st, partial = range_response(PM_FROM, PM_TO)
    c.check("部分结果 range 返回 200", st == 200, f"{st} {partial}")
    pstats = (partial or {}).get("stats") or {}
    c.check("部分结果：attemptsStarted=2", pstats.get("attemptsStarted") == 2, str(pstats))
    c.check("部分结果：resultsRecorded 只计 1 条", pstats.get("resultsRecorded") == 1, str(pstats))
    c.check("部分结果：resultsMissingObservedAt=1", pstats.get("resultsMissingObservedAt") == 1, str(pstats))
    prec = record_map(partial)
    c.check(
        "无 observedAt 的尝试带 result_time_unknown 原因",
        "result_time_unknown" in (prec.get(attempt_key(pm_unknown)) or {}).get("reasons", []),
        str((prec.get(attempt_key(pm_unknown)) or {}).get("reasons")),
    )
    c.check(
        "有 observedAt 的尝试带 result_recorded 原因",
        "result_recorded" in (prec.get(attempt_key(pm_known)) or {}).get("reasons", []),
        str((prec.get(attempt_key(pm_known)) or {}).get("reasons")),
    )
    c.check(
        "两条结果都进入 sections.results",
        set((partial or {}).get("sections", {}).get("results") or []) == {attempt_key(pm_unknown), attempt_key(pm_known)},
        str((partial or {}).get("sections", {}).get("results")),
    )

    # ============================================================ 5. 未配置模型
    print("\n### 5. 未配置模型")
    status, _ = client.delete("/api/settings/ai")
    c.check("DELETE /api/settings/ai 成功", status == 200, str(status))
    status, settings = client.get("/api/settings/ai")
    c.check("删除后 AI 未配置", status == 200 and settings.get("configured") is False and settings.get("config") is None, f"{status} {settings}")

    st, day_no_ai = range_response(DAY_FROM, DAY_TO)
    c.check(
        "未配置模型 range 仍可用且 config=null",
        st == 200
        and day_no_ai.get("ai", {}).get("configured") is False
        and day_no_ai.get("ai", {}).get("config") is None
        and day_no_ai.get("stats", {}).get("totalRecords") == 6,
        f"{st} {day_no_ai}",
    )
    include_day = [capture_key(boundary_ids["cap_from"]), attempt_key(boundary_ids["att_from"])]
    st, prev_no_ai = preview_response(DAY_FROM, DAY_TO, include_day)
    c.check(
        "未配置模型 preview 仍可用且 config=null",
        st == 200
        and prev_no_ai.get("config") is None
        and prev_no_ai.get("ai", {}).get("configured") is False
        and len(prev_no_ai.get("records") or []) == 2,
        f"{st} {prev_no_ai}",
    )
    st, res = start_review(DAY_FROM, DAY_TO, include_day, context_token=prev_no_ai.get("contextToken"))
    c.check("未配置模型创建回顾返回 409 ai_not_configured", st == 409 and res.get("error") == "ai_not_configured", f"{st} {res}")

    # ============================================================ 6. 合法生成
    print("\n### 6. 配置模型与合法来源生成")
    configure("fake-review")
    status, settings = client.get("/api/settings/ai")
    c.check(
        "配置后 settings 返回 fake-review",
        status == 200 and settings.get("config", {}).get("modelId") == "fake-review",
        f"{status} {settings}",
    )

    GEN_FROM, GEN_TO = ms(2026, 5, 1), ms(2026, 5, 2)
    gen_cap1 = f"cap-rv-gen-1-{uid}"
    gen_cap2 = f"cap-rv-gen-2-{uid}"
    gen_att1 = f"att-rv-gen-1-{uid}"
    gen_att2 = f"att-rv-gen-2-{uid}"
    gen_ref = f"ref-rv-gen-{uid}"
    gen_text1 = f"GEN-CAP-TOKEN-{uid}"
    gen_result = f"GEN-RESULT-TOKEN-{uid}"

    def seed_gen(conn):
        insert_capture(conn, gen_cap1, gen_text1, GEN_FROM + 3600000)
        insert_attempt(
            conn,
            gen_att1,
            gen_cap1,
            f"生成来源尝试一 {uid}",
            GEN_FROM + 2 * 3600000,
            state="done",
            result_text=gen_result,
            outcome="failure",
            observed_at=GEN_FROM + 2 * 3600000,
        )
        insert_capture(conn, gen_cap2, f"GEN-CAP2-TOKEN-{uid}", GEN_FROM + 3 * 3600000)
        insert_attempt(conn, gen_att2, gen_cap2, f"生成来源尝试二 {uid}", GEN_FROM + 4 * 3600000)
        insert_reference(
            conn,
            gen_ref,
            gen_att2,
            gen_att1,
            GEN_FROM + 5 * 3600000,
            note=f"生成来源引用 {uid}",
            snapshot_text=gen_result,
        )

    conn_check("写入合法生成来源数据", lambda: db_commit(seed_gen))
    st, gen_range = range_response(GEN_FROM, GEN_TO)
    c.check("生成范围 range 返回 5 条记录", st == 200 and len(gen_range.get("records") or []) == 5, f"{st} {len((gen_range or {}).get('records') or [])}")
    gen_keys = [r["key"] for r in gen_range.get("records") or []]
    st, gen_prev = preview_response(GEN_FROM, GEN_TO, gen_keys)
    c.check(
        "合法预览 selectedChars>0 且 withinLimit=true",
        st == 200 and gen_prev.get("coverage", {}).get("selectedChars", 0) > 0 and gen_prev.get("coverage", {}).get("withinLimit") is True,
        str((gen_prev or {}).get("coverage")),
    )
    gen_token = gen_prev.get("contextToken")
    c.check("contextToken 为 64 位 hex", isinstance(gen_token, str) and len(gen_token) == 64 and all(ch in "0123456789abcdef" for ch in gen_token), str(gen_token)[:30])
    st, res = start_review(GEN_FROM, GEN_TO, gen_keys, context_token=gen_token, operation_id=f"op-gen-legal-{uid}")
    c.check("合法生成创建返回 202", st == 202 and (res or {}).get("review", {}).get("status") == "pending" and res.get("replayed") is False, f"{st} {res}")
    legal_id = (res or {}).get("review", {}).get("id")
    st, res = wait_review(legal_id or "")
    legal = (res or {}).get("review") or {}
    c.check("fake-review 生成成功", st == 200 and legal.get("status") == "succeeded", f"{st} {legal.get('status')} {legal.get('errorCode')}")
    content = legal.get("content") or {}
    c.check("成功回顾 overview 非空", isinstance(content.get("overview"), str) and bool(content.get("overview").strip()), str(content.get("overview"))[:100])
    sections_content = ("attempts", "observations", "connections", "experiences")
    c.check(
        "成功回顾四区块非空",
        all(isinstance(content.get(name), list) and len(content.get(name)) > 0 for name in sections_content),
        str({name: len(content.get(name) or []) for name in sections_content}),
    )
    items = [item for name in sections_content for item in (content.get(name) or [])]
    c.check(
        "每条 item 有 basis 与 sourceIds",
        all(
            isinstance(item.get("text"), str) and item.get("text").strip()
            and item.get("basis") in {"observation", "inference"}
            and isinstance(item.get("sourceIds"), list) and len(item.get("sourceIds")) > 0
            for item in items
        ),
        str(items)[:400],
    )
    c.check(
        "每条 item.sourceIds 都属于本次 includeKeys",
        all(set(item.get("sourceIds") or []) <= set(gen_keys) for item in items),
        str([item.get("sourceIds") for item in items])[:400],
    )
    c.check(
        "sources 覆盖全部发送记录且 exists=true",
        set(s.get("key") for s in legal.get("sources") or []) == set(gen_keys)
        and all(s.get("exists") is True and s.get("deleted") is False for s in legal.get("sources") or []),
        str(legal.get("sources"))[:400],
    )
    c.check("成功回顾 canSave=true", legal.get("canSave") is True, str(legal.get("canSave")))
    prompt = fake_user_prompt()
    c.check("生成 prompt 含本次来源稳定键", all(f"[{k}]" in prompt for k in gen_keys), prompt[:300])
    c.check(
        "生成 prompt 含“一次练习”边界说明",
        "一次练习" in json.dumps(fake_last().get("body") or {}, ensure_ascii=False),
        prompt[:300],
    )
    c.check("生成 prompt 不含明文密钥", SECRET_KEY not in prompt, "leak")

    # ============================================================ 7. 预览排除
    print("\n### 7. 预览排除未选记录")
    EX_FROM, EX_TO = ms(2026, 6, 1), ms(2026, 6, 2)
    ex_ids = {}
    ex_texts = {}

    def seed_ex(conn):
        for i in range(1, 6):
            cid = f"cap-rv-ex-{i}-{uid}"
            text = f"EX-KEEP-{i}-TOKEN-{uid}" if i <= 2 else f"EX-SKIP-{i}-TOKEN-{uid}"
            ex_ids[i] = cid
            ex_texts[i] = text
            insert_capture(conn, cid, text, EX_FROM + i * 3600000)

    conn_check("写入预览排除数据", lambda: db_commit(seed_ex))
    st, ex_range = range_response(EX_FROM, EX_TO)
    ex_all = [r["key"] for r in ex_range.get("records") or []]
    c.check("预览排除 range 返回 5 条", st == 200 and len(ex_all) == 5, f"{st} {len(ex_all)}")
    selected_ex = [capture_key(ex_ids[1]), capture_key(ex_ids[2])]
    st, ex_prev = preview_response(EX_FROM, EX_TO, selected_ex)
    c.check("预览排除返回 200", st == 200, f"{st} {ex_prev}")
    c.check(
        "preview.records 只含选中的 2 条",
        set(r["key"] for r in ex_prev.get("records") or []) == set(selected_ex),
        str([r["key"] for r in ex_prev.get("records") or []])[:300],
    )
    c.check(
        "preview coverage 计数正确",
        ex_prev.get("coverage", {}).get("totalRecords") == 5
        and ex_prev.get("coverage", {}).get("selectedRecords") == 2
        and ex_prev.get("coverage", {}).get("excludedRecords") == 3
        and ex_prev.get("coverage", {}).get("selectedChars", 0) > 0
        and ex_prev.get("coverage", {}).get("withinLimit") is True,
        str(ex_prev.get("coverage")),
    )
    c.check(
        "preview sectionCounts 只反映选中记录",
        (ex_prev.get("coverage", {}).get("sectionCounts") or {}).get("captures") == 2
        and (ex_prev.get("coverage", {}).get("sectionCounts") or {}).get("attempts") == 0,
        str(ex_prev.get("coverage", {}).get("sectionCounts")),
    )
    st, res = start_review(EX_FROM, EX_TO, selected_ex, context_token=ex_prev.get("contextToken"), operation_id=f"op-ex-{uid}")
    c.check("排除后生成返回 202", st == 202, f"{st} {res}")
    ex_id = (res or {}).get("review", {}).get("id")
    st, res = wait_review(ex_id or "")
    ex_review = (res or {}).get("review") or {}
    c.check("排除后生成成功", st == 200 and ex_review.get("status") == "succeeded", f"{st} {ex_review.get('status')} {ex_review.get('errorCode')}")
    c.check(
        "GET 详情 sources 只含选中记录",
        set(s.get("key") for s in ex_review.get("sources") or []) == set(selected_ex),
        str([s.get("key") for s in ex_review.get("sources") or []]),
    )
    try:
        ex_prompt = fake_user_prompt()
        c.check(
            "真实 prompt 含选中正文",
            all(ex_texts[1] in ex_prompt and ex_texts[2] in ex_prompt for _ in [0]),
            ex_prompt[:300],
        )
        c.check(
            "真实 prompt 不含未选记录正文",
            all(ex_texts[i] not in ex_prompt for i in (3, 4, 5)),
            ex_prompt[:300],
        )
        c.check(
            "preview.selectedChars 与真实 user prompt 长度一致",
            len(ex_prompt) == ex_prev.get("coverage", {}).get("selectedChars"),
            f"{len(ex_prompt)} vs {ex_prev.get('coverage', {}).get('selectedChars')}",
        )
    except Exception as exc:  # noqa: BLE001 - /__last 不可用时按约定跳过并记录
        print(f"SKIP  /__last 不可用，跳过 prompt 断言：{exc!r}")
        c.check("prompt 排除断言（/__last 不可用，跳过）", True)

    # ============================================================ 8. 大量记录
    print("\n### 8. 大量记录限制")
    LARGE_FROM, LARGE_TO = ms(2026, 3, 1), ms(2026, 3, 2)
    large_cap = f"cap-rv-large-{uid}"

    def seed_large(conn):
        insert_capture(conn, large_cap, f"大量记录父念头 {uid}", LARGE_FROM - 86400000)
        rows = []
        for i in range(81):
            aid = f"att-rv-large-{uid}-{i:03d}"
            at = LARGE_FROM + i * 60000
            rows.append((aid, large_cap, f"大量尝试 {i:03d} {uid}", "todo", None, None, None, None, 1, at, at))
        conn.executemany(
            "INSERT INTO attempts (id, capture_id, step, state, result_text, outcome, source_url, "
            "observed_at, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )

    conn_check("写入 81 条尝试", lambda: db_commit(seed_large))
    st, large_range = range_response(LARGE_FROM, LARGE_TO)
    large_keys = [r["key"] for r in large_range.get("records") or []]
    c.check("81 条范围 records=81", st == 200 and len(large_keys) == 81, f"{st} {len(large_keys)}")
    st, large_prev = preview_response(LARGE_FROM, LARGE_TO, large_keys)
    c.check(
        "81 条预览 withinLimit=false",
        st == 200
        and large_prev.get("coverage", {}).get("selectedRecords") == 81
        and large_prev.get("coverage", {}).get("withinLimit") is False
        and large_prev.get("coverage", {}).get("maxRecords") == 80,
        f"{st} {large_prev.get('coverage')}",
    )
    st, res = start_review(LARGE_FROM, LARGE_TO, large_keys, context_token=large_prev.get("contextToken"), operation_id=f"op-large-{uid}")
    c.check(
        "81 条生成返回 409 review_too_large",
        st == 409
        and res.get("error") == "review_too_large"
        and res.get("recordCount") == 81
        and res.get("maxRecords") == 80,
        f"{st} {res}",
    )

    TRUNC_FROM, TRUNC_TO = ms(2026, 2, 1), ms(2026, 2, 2)
    trunc_cap = f"cap-rv-trunc-{uid}"

    def seed_trunc(conn):
        insert_capture(conn, trunc_cap, f"截断父念头 {uid}", TRUNC_FROM - 86400000)
        rows = []
        for i in range(501):
            aid = f"att-rv-trunc-{uid}-{i:03d}"
            at = TRUNC_FROM + i * 1000
            rows.append((aid, trunc_cap, f"截断尝试 {i:03d} {uid}", "todo", None, None, None, None, 1, at, at))
        conn.executemany(
            "INSERT INTO attempts (id, capture_id, step, state, result_text, outcome, source_url, "
            "observed_at, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )

    conn_check("写入 501 条尝试", lambda: db_commit(seed_trunc))
    st, trunc = range_response(TRUNC_FROM, TRUNC_TO)
    c.check(
        "501 条 range 截断为最近 500 条且 truncated=true",
        st == 200
        and (trunc.get("coverage", {}).get("totalRecords") == 501)
        and (trunc.get("coverage", {}).get("uniqueKeys") == 501)
        and (trunc.get("coverage", {}).get("truncated") is True)
        and (trunc.get("coverage", {}).get("maxRangeRecords") == 500)
        and len(trunc.get("records") or []) == 500,
        f"{st} {trunc.get('coverage')} len={len((trunc or {}).get('records') or [])}",
    )

    # ============================================================ 9. 编造来源与重试
    print("\n### 9. 模型编造来源与重试")
    configure("fake-review-bad-source")
    st, bad_prev = preview_response(GEN_FROM, GEN_TO, gen_keys)
    st, res = start_review(GEN_FROM, GEN_TO, gen_keys, context_token=bad_prev.get("contextToken"), operation_id=f"op-bad-{uid}")
    bad_id = (res or {}).get("review", {}).get("id")
    st, res = wait_review(bad_id or "")
    bad_review = (res or {}).get("review") or {}
    c.check(
        "编造来源 -> failed invalid_response",
        st == 200 and bad_review.get("status") == "failed" and bad_review.get("errorCode") == "invalid_response",
        f"{st} {bad_review.get('status')} {bad_review.get('errorCode')} {bad_review.get('errorMessage')}",
    )
    c.check("失败回顾 content 为空", bad_review.get("content") is None, str(bad_review.get("content"))[:200])

    configure("fake-review")
    st, retry_prev = preview_response(GEN_FROM, GEN_TO, gen_keys)
    st, res = start_review(GEN_FROM, GEN_TO, gen_keys, context_token=retry_prev.get("contextToken"), operation_id=f"op-retry-{uid}")
    retry_id = (res or {}).get("review", {}).get("id")
    st, res = wait_review(retry_id or "")
    retry_review = (res or {}).get("review") or {}
    c.check("切回 fake-review 后新 operationId 重试成功", st == 200 and retry_review.get("status") == "succeeded", f"{st} {retry_review.get('status')} {retry_review.get('errorCode')}")

    # ============================================================ 10. 取消
    print("\n### 10. 取消中/已结束")
    configure("fake-review-timeout")
    st, to_prev = preview_response(GEN_FROM, GEN_TO, gen_keys)
    st, res = start_review(GEN_FROM, GEN_TO, gen_keys, context_token=to_prev.get("contextToken"), operation_id=f"op-timeout-{uid}")
    to_id = (res or {}).get("review", {}).get("id")
    c.check("超时场景创建回顾返回 202 pending", st == 202 and (res or {}).get("review", {}).get("status") == "pending", f"{st} {res}")
    status, cancel_res = client.post(f"/api/reviews/{to_id}/cancel", {})
    c.check(
        "POST cancel 立即返回 cancelled",
        status == 200
        and (cancel_res or {}).get("review", {}).get("status") == "cancelled"
        and (cancel_res or {}).get("review", {}).get("errorCode") == "cancelled",
        f"{status} {cancel_res}",
    )
    time.sleep(1.5)
    status, res = client.get(f"/api/reviews/{to_id}")
    c.check("等待 1.5s 后仍为 cancelled（不复活）", status == 200 and res.get("review", {}).get("status") == "cancelled", f"{status} {res}")
    status, res = client.post(f"/api/reviews/{to_id}/cancel", {})
    c.check("已结束再 cancel 返回 409 not_cancellable", status == 409 and res.get("error") == "not_cancellable", f"{status} {res}")
    status, res = client.post(f"/api/reviews/{to_id}/save", {})
    c.check("取消的回顾不可保存 409 not_savable", status == 409 and res.get("error") == "not_savable", f"{status} {res}")

    # ============================================================ 11. 保存/列表/详情/来源变化
    print("\n### 11. 保存、列表、详情与来源变化")
    status, save_res = client.post(f"/api/reviews/{legal_id}/save", {"operationId": f"op-save-{uid}"})
    saved_review = (save_res or {}).get("review") or {}
    saved_at = saved_review.get("savedAt")
    c.check("首次保存成功且 savedAt 为整数", status == 200 and isinstance(saved_at, int) and saved_at > 0 and save_res.get("replayed") is False, f"{status} {save_res}")
    status, save2 = client.post(f"/api/reviews/{legal_id}/save", {"operationId": f"op-save-{uid}"})
    c.check(
        "重复保存返回同一 savedAt 且 replayed=true",
        status == 200 and (save2 or {}).get("review", {}).get("savedAt") == saved_at and save2.get("replayed") is True,
        f"{status} {save2}",
    )
    status, listing = client.get("/api/reviews?limit=50")
    items = (listing or {}).get("reviews") or []
    listed = next((x for x in items if x.get("id") == legal_id), None)
    c.check(
        "已保存回顾出现在列表且字段完整",
        status == 200
        and listed is not None
        and listed.get("savedAt") == saved_at
        and isinstance(listed.get("overview"), str) and bool(listed.get("overview"))
        and listed.get("sourceCount") == 5
        and isinstance(listed.get("stats"), dict),
        f"{status} {listed}",
    )
    status, detail = client.get(f"/api/reviews/{legal_id}")
    c.check(
        "GET 详情返回保存的回顾",
        status == 200
        and detail.get("review", {}).get("id") == legal_id
        and detail.get("review", {}).get("savedAt") == saved_at
        and detail.get("review", {}).get("content", {}).get("overview") == content.get("overview"),
        f"{status}",
    )
    c.check(
        "保存后来源初始 changed=false/deleted=false",
        all(s.get("changed") is False and s.get("deleted") is False for s in detail.get("review", {}).get("sources") or []),
        str(detail.get("review", {}).get("sources"))[:400],
    )

    # 导出（在修改/删除来源之前，保证内容与来源完整）
    status, export = client.get("/api/export")
    export_text = json.dumps(export, ensure_ascii=False)
    export_reviews = (export.get("data") or {}).get("stageReviews")
    exported = next((r for r in export_reviews or [] if r.get("id") == legal_id), None) if isinstance(export_reviews, list) else None
    c.check(
        "导出 schemaVersion>=6（v0.6 经验/主题导出）",
        status == 200 and export.get("schemaVersion") in (6, 7),
        f"{status} {export.get('schemaVersion')}",
    )
    c.check("导出 data.stageReviews 为数组", isinstance(export_reviews, list), str(type(export_reviews)))
    c.check(
        "导出包含已保存回顾的 range/content/sources/stats/coverage",
        exported is not None
        and exported.get("status") == "succeeded"
        and exported.get("rangeFrom") == GEN_FROM
        and exported.get("rangeTo") == GEN_TO
        and exported.get("timezone") == "Asia/Shanghai"
        and exported.get("preset") == "custom"
        and isinstance(exported.get("stats"), dict)
        and isinstance(exported.get("coverage"), dict)
        and isinstance(exported.get("content"), dict) and bool(exported["content"].get("overview"))
        and isinstance(exported.get("sources"), list) and len(exported["sources"]) == 5
        and exported.get("savedAt") == saved_at,
        str(exported)[:500],
    )
    c.check("导出 stageReviews 只含已保存回顾", all(r.get("savedAt") is not None for r in export_reviews or []), str([r.get("savedAt") for r in export_reviews or []]))
    legacy = {"schemaVersion": 1, "data": {"captures": [], "attempts": [], "attemptReferences": []}}
    c.check("旧 schemaVersion=1 导出对象仍可解析（无 stageReviews 视为空）", (legacy["data"].get("stageReviews") or []) == [], str(legacy))

    status, res = client.patch(
        f"/api/attempts/{gen_att1}",
        {"resultText": f"GEN-RESULT-EDITED-{uid}", "outcome": "success", "revision": 1},
    )
    c.check("PATCH 修改回顾来源尝试", status == 200 and res.get("attempt", {}).get("revision") == 2, f"{status} {res}")
    status, detail = client.get(f"/api/reviews/{legal_id}")
    rev = (detail or {}).get("review") or {}
    src_changed = next((s for s in rev.get("sources") or [] if s.get("key") == attempt_key(gen_att1)), None)
    c.check(
        "来源修改后 changed=true / sourcesChanged=true",
        status == 200 and (src_changed or {}).get("changed") is True and rev.get("sourcesChanged") is True,
        f"{status} {src_changed} / {rev.get('sourcesChanged')}",
    )
    c.check(
        "来源修改后 currentRevision 反映新版本",
        (src_changed or {}).get("currentRevision") == 2 and (src_changed or {}).get("revision") == 1,
        str(src_changed),
    )

    status, _ = client.delete(f"/api/attempts/{gen_att1}")
    c.check("删除回顾来源尝试成功", status == 200, str(status))
    status, detail = client.get(f"/api/reviews/{legal_id}")
    rev = (detail or {}).get("review") or {}
    deleted_src = next((s for s in rev.get("sources") or [] if s.get("key") == attempt_key(gen_att1)), None)
    deleted_ref = next((s for s in rev.get("sources") or [] if s.get("key") == reference_key(gen_ref)), None)
    detail_text = json.dumps(rev, ensure_ascii=False)
    c.check("删除来源后详情仍可打开", status == 200, str(status))
    c.check(
        "删除来源标记 deleted=true / exists=false",
        (deleted_src or {}).get("deleted") is True and (deleted_src or {}).get("exists") is False,
        str(deleted_src),
    )
    c.check(
        "删除来源的 title/resultText 为 null",
        (deleted_src or {}).get("title") is None and (deleted_src or {}).get("resultText") is None,
        str(deleted_src),
    )
    c.check("删除来源后 contentInvalidated=true", rev.get("contentInvalidated") is True and bool(rev.get("contentInvalidReason")), str(rev.get("contentInvalidated")))
    c.check("关联引用来源也被清洗", (deleted_ref or {}).get("deleted") is True, str(deleted_ref))
    c.check(
        "接口全文不出现已删除观察文本",
        gen_result not in detail_text and f"GEN-RESULT-EDITED-{uid}" not in detail_text,
        detail_text[:500],
    )
    c.check(
        "删除来源后模型回顾正文撤下为 null（contentInvalidated=true）",
        rev.get("content") is None and rev.get("contentInvalidated") is True,
        str(rev.get("content"))[:200],
    )

    # 删除所属念头
    DEL_FROM, DEL_TO = ms(2026, 4, 1), ms(2026, 4, 2)
    del_cap = f"cap-rv-del-{uid}"
    del_att = f"att-rv-del-{uid}"
    del_cap_token = f"DEL-CAP-TOKEN-{uid}"
    del_result_token = f"DEL-RESULT-TOKEN-{uid}"

    def seed_del(conn):
        insert_capture(conn, del_cap, del_cap_token, DEL_FROM + 3600000)
        insert_attempt(
            conn,
            del_att,
            del_cap,
            f"将删除的尝试 {uid}",
            DEL_FROM + 2 * 3600000,
            state="done",
            result_text=del_result_token,
            outcome="failure",
            observed_at=DEL_FROM + 2 * 3600000,
        )

    conn_check("写入待删除念头数据", lambda: db_commit(seed_del))
    configure("fake-review")
    del_keys = [capture_key(del_cap), attempt_key(del_att)]
    st, del_prev = preview_response(DEL_FROM, DEL_TO, del_keys)
    st, res = start_review(DEL_FROM, DEL_TO, del_keys, context_token=del_prev.get("contextToken"), operation_id=f"op-delcap-{uid}")
    del_review_id = (res or {}).get("review", {}).get("id")
    st, res = wait_review(del_review_id or "")
    del_review = (res or {}).get("review") or {}
    c.check("删除念头前回顾生成成功", st == 200 and del_review.get("status") == "succeeded", f"{st} {del_review.get('status')} {del_review.get('errorCode')}")
    status, _ = client.delete(f"/api/captures/{del_cap}")
    c.check("删除回顾来源所属念头成功", status == 200, str(status))
    status, detail = client.get(f"/api/reviews/{del_review_id}")
    rev = (detail or {}).get("review") or {}
    detail_text = json.dumps(rev, ensure_ascii=False)
    sources = rev.get("sources") or []
    c.check("删除念头后详情仍可打开", status == 200, str(status))
    c.check(
        "删除念头后 capture/attempt 来源均 deleted=true",
        len(sources) == 2 and all(s.get("deleted") is True and s.get("exists") is False for s in sources),
        str(sources),
    )
    c.check(
        "删除念头后来源 title/resultText 为 null",
        all(s.get("title") is None and s.get("resultText") is None for s in sources),
        str(sources),
    )
    c.check("删除念头后 contentInvalidated=true", rev.get("contentInvalidated") is True and bool(rev.get("contentInvalidReason")), str(rev.get("contentInvalidated")))
    c.check("删除念头后模型回顾正文撤下为 null", rev.get("content") is None, str(rev.get("content"))[:200])
    c.check(
        "删除念头后接口不出现已删除正文",
        del_cap_token not in detail_text and del_result_token not in detail_text,
        detail_text[:500],
    )

    # 删除后的导出/列表仍可读，失败/未保存记录不导出
    status, export2 = client.get("/api/export")
    export2_text = json.dumps(export2, ensure_ascii=False)
    export2_reviews = (export2.get("data") or {}).get("stageReviews") or []
    ids2 = {r.get("id") for r in export2_reviews}
    c.check(
        "导出仍包含已保存回顾且不包含 failed/未保存记录",
        status == 200 and legal_id in ids2 and bad_id not in ids2 and retry_id not in ids2 and to_id not in ids2,
        f"{status} ids={sorted(ids2)}",
    )
    c.check("导出不出现已删除来源正文", del_result_token not in export2_text and gen_result not in export2_text, "leak")
    status, listing2 = client.get("/api/reviews?limit=50")
    c.check(
        "来源删除后列表仍可读且标记 contentInvalidated",
        status == 200 and any(x.get("id") == legal_id and x.get("contentInvalidated") is True for x in (listing2.get("reviews") or [])),
        f"{status} {listing2.get('reviews')}",
    )

    # ============================================================ 12. 其他错误与密钥
    print("\n### 12. 非法 keys、未知 ID 与密钥")
    st, res = preview_response(DAY_FROM, DAY_TO, [])
    c.check("includeKeys 空返回 400 invalid_keys", st == 400 and res.get("error") == "invalid_keys", f"{st} {res}")
    st, res = preview_response(DAY_FROM, DAY_TO, [capture_key(boundary_ids["cap_from"]), capture_key(boundary_ids["cap_from"])])
    c.check("includeKeys 重复返回 400 invalid_keys", st == 400 and res.get("error") == "invalid_keys", f"{st} {res}")
    st, res = preview_response(DAY_FROM, DAY_TO, ["capture:not-in-range"])
    c.check(
        "includeKeys 含范围外 key 返回 409 records_changed 并带 missingKeys",
        st == 409 and res.get("error") == "records_changed" and "capture:not-in-range" in (res.get("missingKeys") or []),
        f"{st} {res}",
    )

    status, res = client.get("/api/reviews/rev-does-not-exist")
    c.check("未知回顾 id 详情返回 404 review_not_found", status == 404 and res.get("error") == "review_not_found", f"{status} {res}")
    status, res = client.post("/api/reviews/rev-does-not-exist/save", {})
    c.check("未知回顾 id 保存返回 404 review_not_found", status == 404 and res.get("error") == "review_not_found", f"{status} {res}")
    status, res = client.post("/api/reviews/rev-does-not-exist/cancel", {})
    c.check("未知回顾 id 取消返回 404 review_not_found", status == 404 and res.get("error") == "review_not_found", f"{status} {res}")

    haystack = "\n".join(RESPONSE_TEXTS)
    c.check("所有回顾响应不含明文密钥", SECRET_KEY not in haystack, "leak")
    if os.path.isfile(SERVER_LOG):
        with open(SERVER_LOG, "rb") as fh:
            log_text = fh.read().decode("utf-8", "replace")
        c.check("测试服务日志不含明文密钥", SECRET_KEY not in log_text, "leak")

    ok = c.report("阶段回顾验收")
    return 0 if ok else 1


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # noqa: BLE001 - 测试脚本需要打印真实异常
        print(f"\nERROR 测试执行异常：{exc}")
        traceback.print_exc()
        exit_code = 1
    finally:
        stop_fake_server()
    sys.exit(exit_code)
