# -*- coding: utf-8 -*-
"""拾念 SHINIAN · 主题 Markdown ZIP 导出验收（隔离库）。

自启动隔离服务（默认端口 3241 / db/topic-export-test.sqlite）。
覆盖：预览、范围、链接、稳定文件名、跨主题依据、删除来源、历史快照、
>20 尝试完整读取、路径安全、失败不改数据、scopeHash 409、JSON 导出回归。
"""
import io
import json
import os
import posixpath
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Client, Checker

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node") or "node"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
PORT = int(os.environ.get("SHINIAN_EXPORT_TEST_PORT", "3241"))
BASE = os.environ.get("SHINIAN_BASE", f"http://127.0.0.1:{PORT}").rstrip("/")
TEST_DB = os.environ.get("SHINIAN_EXPORT_TEST_DB", os.path.join(ROOT, "db", "topic-export-test.sqlite"))
MASTER_KEY = TEST_DB + ".master.key"
SERVER_LOG = TEST_DB + ".server.log"
KEEP = os.environ.get("SHINIAN_KEEP_TEST_ARTIFACTS") == "1"

c = Checker()
client = Client(base=BASE)
uid = uuid.uuid4().hex[:8]
proc = None
log_handle = None


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port: int, timeout: float = 25.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/session/check", timeout=1)
        except urllib.error.HTTPError:
            return
        except Exception:
            if proc and proc.poll() is not None:
                raise RuntimeError(f"服务进程已退出，日志：{SERVER_LOG}")
            time.sleep(0.25)
    raise RuntimeError(f"服务未能在 {port} 启动")


def start_server() -> None:
    global proc, log_handle
    if BASE != f"http://127.0.0.1:{PORT}":
        return
    for suffix in ("", "-wal", "-shm"):
        path = TEST_DB + suffix
        if os.path.exists(path):
            os.remove(path)
    if os.path.exists(MASTER_KEY):
        os.remove(MASTER_KEY)
    env = dict(os.environ)
    env["PORT"] = str(PORT)
    env["DATABASE_URL"] = TEST_DB
    env["SHINIAN_MASTER_KEY_FILE"] = MASTER_KEY
    log_handle = open(SERVER_LOG, "ab")
    proc = subprocess.Popen(
        [NODE, TSX, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    wait_port(PORT)


def stop_server() -> None:
    global proc, log_handle
    if proc:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
        proc = None
    if log_handle:
        log_handle.close()
        log_handle = None


def post(path: str, body: dict):
    status, res = client.post(path, body)
    if status not in (200, 201):
        raise AssertionError(f"POST {path} -> {status}: {res}")
    return res


def patch(path: str, body: dict):
    status, res = client.patch(path, body)
    if status != 200:
        raise AssertionError(f"PATCH {path} -> {status}: {res}")
    return res


def get(path: str):
    status, res = client.get(path)
    if status != 200:
        raise AssertionError(f"GET {path} -> {status}: {res}")
    return res


def export_request(topic_id: str, payload: dict):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/api/topics/{urllib.parse.quote(topic_id)}/export",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with client.opener.open(req, timeout=60) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw), dict(exc.headers)
        except json.JSONDecodeError:
            return exc.code, raw, dict(exc.headers)


def header_get(headers, key: str) -> str:
    for name, value in headers.items():
        if str(name).lower() == key.lower():
            return str(value)
    return ""


def zip_names(raw: bytes):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return archive.namelist()


def strip_fenced(text: str) -> str:
    lines = []
    in_fence = False
    fence_len = 0
    for line in text.split("\n"):
        match = re.match(r"^(`{3,})(.*)$", line)
        if match:
            run = len(match.group(1))
            if not in_fence:
                in_fence = True
                fence_len = run
            elif run >= fence_len:
                in_fence = False
                fence_len = 0
            continue
        if not in_fence:
            lines.append(line)
    return "\n".join(lines)


def link_targets(raw: bytes):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        missing = []
        for name in names:
            if not name.endswith(".md"):
                continue
            text = archive.read(name).decode("utf-8", "replace")
            body = strip_fenced(text)
            for match in re.finditer(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", body):
                target = urllib.parse.unquote(match.group(1))
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                target = target.split("#", 1)[0]
                if not target:
                    continue
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                if resolved not in names:
                    missing.append((name, target, resolved))
        return names, missing


def all_text(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        chunks = []
        for name in archive.namelist():
            if name.endswith((".md", ".json")):
                chunks.append(archive.read(name).decode("utf-8", "replace"))
        return "\n".join(chunks)


def db_counts() -> dict:
    tables = [
        "topics",
        "topic_members",
        "captures",
        "attempts",
        "attempt_references",
        "capture_links",
        "experience_notes",
        "experience_sources",
        "experience_attempts",
    ]
    conn = sqlite3.connect(TEST_DB)
    try:
        return {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    finally:
        conn.close()


def safe_names(names) -> bool:
    allowed = re.compile(
        r"^(主题索引\.md|README\.md|manifest\.json|records/(thoughts|experiences|attempts)/[A-Za-z0-9_-]+\.md)$"
    )
    for name in names:
        if "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
            return False
        if ".." in name.split("/") or "." in name.split("/"):
            return False
        rel = name.split("/", 1)[1] if "/" in name else name
        if not allowed.match(rel):
            return False
    return True


try:
    start_server()
    client.login("主题导出验收")
    c.check("隔离服务可登录", True)

    # ---------- 造数：两个主题、同名/特殊字符、跨主题依据、删除来源、归档、>20 尝试、历史采用 ----------
    special = f"【A1】特殊 [标题](../../x) `代码` 中文 {uid}\n```\n不应生成文件链接\n```"
    a1 = post("/api/captures", {"rawText": special})["capture"]
    same_name = f"【同名记录】{uid}"
    a2 = post("/api/captures", {"rawText": same_name})["capture"]
    b1 = post("/api/captures", {"rawText": f"【B1】主题外念头 UNIQUE_B1_SECRET_{uid}"})["capture"]
    b2 = post("/api/captures", {"rawText": same_name + f" UNIQUE_B2_SECRET_{uid}"})["capture"]

    a1_attempt_ids = []
    for index in range(60):
        attempt = post(
            f"/api/captures/{a1['id']}/attempts",
            {
                "step": f"【A1尝试 {index:02d}】{uid}",
                "state": "done" if index % 3 == 0 else "todo",
                "resultText": f"结果 {index:02d} {uid}" if index % 3 == 0 else None,
                "outcome": "undetermined" if index % 3 == 0 else None,
                "operationId": f"exp-att-{uid}-{index}",
            },
        )["attempt"]
        a1_attempt_ids.append(attempt["id"])
    a_main = a1_attempt_ids[0]
    a_pending = post(
        f"/api/captures/{a1['id']}/attempts",
        {"step": "【A1待继续】复测", "state": "todo", "operationId": f"exp-pending-{uid}"},
    )["attempt"]

    # 同主题引用：默认导出即可核对「当前结果」与「引用时快照」分开标注。
    post(
        f"/api/attempts/{a_pending['id']}/references",
        {"toId": a_main, "note": "同主题旧结果", "operationId": f"exp-inner-ref-{uid}"},
    )
    a_main_obj = get(f"/api/attempts/{a_main}")["attempt"]
    patch(
        f"/api/attempts/{a_main}",
        {
            "state": "done",
            "resultText": f"A_MAIN_RESULT_NEW_{uid}",
            "outcome": "undetermined",
            "revision": a_main_obj["revision"],
        },
    )

    b_main = post(
        f"/api/captures/{b1['id']}/attempts",
        {
            "step": f"【B1尝试】主题外观察 {uid}",
            "state": "done",
            "resultText": f"B1_RESULT_OLD_{uid}",
            "outcome": "success",
            "operationId": f"exp-b-main-{uid}",
        },
    )["attempt"]
    b_other = post(
        f"/api/captures/{b1['id']}/attempts",
        {
            "step": f"B1_OTHER_SECRET_{uid}",
            "state": "todo",
            "operationId": f"exp-b-other-{uid}",
        },
    )["attempt"]
    deleted = post(
        f"/api/captures/{b1['id']}/attempts",
        {
            "step": f"DELETED_SECRET_{uid}",
            "state": "done",
            "resultText": f"DELETED_RESULT_SECRET_{uid}",
            "operationId": f"exp-deleted-{uid}",
        },
    )["attempt"]

    # 引用：A1 尝试引用 B1 尝试；随后修改 B1 结果，保留旧快照。
    ref = post(
        f"/api/attempts/{a_main}/references",
        {"toId": b_main["id"], "note": "对照旧结果", "operationId": f"exp-ref-{uid}"},
    )["reference"]
    patch(
        f"/api/attempts/{b_main['id']}",
        {
            "state": "done",
            "resultText": f"B1_RESULT_NEW_{uid}",
            "outcome": "success",
            "revision": b_main["revision"],
        },
    )

    # 手动关联 A1 -> A2（A2 后归档）。
    post(
        f"/api/captures/{a1['id']}/links",
        {"toCaptureId": a2["id"], "note": "同一个主题", "operationId": f"exp-link-{uid}"},
    )

    # 经验：依据主题内尝试、跨主题尝试、跨主题念头、随后删除的来源。
    exp = post(
        "/api/experiences",
        {
            "title": f"【经验】频率与闪烁 {uid}",
            "understanding": f"我的理解：2kHz 比 500Hz 稳定。\n用户总结 {uid}",
            "conditions": "驱动板供电稳定时",
            "limitations": "未在不同 LED 上复现",
            "by": "model",
            "modelBasis": "observation",
            "originKind": "manual",
            "sourceKeys": [
                f"attempt:{a_main}",
                f"attempt:{b_main['id']}",
                f"capture:{b2['id']}",
                f"attempt:{deleted['id']}",
            ],
            "operationId": f"exp-exp-{uid}",
        },
    )["experience"]

    # 后续尝试采用经验（保存采用时版本），随后修改经验正文/标题。
    adopted = post(
        f"/api/experiences/{exp['id']}/attempts",
        {
            "captureId": a1["id"],
            "title": f"【采用经验再试】{uid}",
            "description": "按经验再试一次",
            "basisSourceKeys": [f"attempt:{b_main['id']}"],
            "operationId": f"exp-adopt-{uid}",
        },
    )["attempt"]
    exp_detail = get(f"/api/experiences/{exp['id']}")["experience"]
    exp_revision = exp_detail.get("revision", exp_detail.get("capture", {}).get("revision", 1))
    updated_exp = patch(
        f"/api/experiences/{exp['id']}",
        {
            "title": f"【经验已修订】频率与闪烁 {uid}",
            "understanding": f"当前正文：后来换了 LED 也成立。\n用户总结当前版 {uid}",
            "conditions": "驱动板供电稳定且 LED 批次一致",
            "limitations": "尚未测低温",
            "revision": exp_revision,
            "operationId": f"exp-update-{uid}",
        },
    )["experience"]
    c.check("经验修订后版本递增", updated_exp.get("revision", exp_revision + 1) > exp_revision)

    # 删除来源：触发经验来源清理。
    status, _ = client.delete(f"/api/attempts/{deleted['id']}")
    c.check("删除来源尝试成功", status == 200, str(status))
    exp_after_delete = get(f"/api/experiences/{exp['id']}")["experience"]
    sources_after = exp_after_delete.get("sources", [])
    deleted_sources = [item for item in sources_after if item.get("deleted")]
    c.check("经验详情标记已删除来源", len(deleted_sources) >= 1, str(sources_after)[:300])
    c.check(
        "经验详情不恢复已删除快照",
        f"DELETED_SECRET_{uid}" not in json.dumps(exp_after_delete, ensure_ascii=False),
    )

    # 归档 A2。
    post(f"/api/captures/{a2['id']}/archive", {})

    # 主题 A（导出目标）与主题 B（另一个主题）。
    topic_a = post(
        "/api/topics",
        {
            "title": f"【主题A】PWM 与闪烁 {uid}",
            "exploringQuestion": "频率与闪烁的关系？",
            "continueNote": "下次继续复测 2kHz",
            "captureIds": [a1["id"], a2["id"], exp["id"]],
            "nextAttemptId": a_pending["id"],
            "operationId": f"exp-topic-a-{uid}",
        },
    )["topic"]
    topic_b = post(
        "/api/topics",
        {
            "title": f"【主题B】外部依据 {uid}",
            "captureIds": [b1["id"], b2["id"]],
            "operationId": f"exp-topic-b-{uid}",
        },
    )["topic"]

    # ---------- 预览与默认导出 ----------
    status, preview = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": True, "includeBasisKeys": []},
    )
    c.check("默认预览 200", status == 200, str(status))
    c.check(
        "预览显示 >20 尝试完整计数",
        preview["scope"]["counts"]["attempts"] >= 61,
        str(preview["scope"]["counts"]),
    )
    c.check("预览显示归档统计", preview["scope"]["archived"]["members"] >= 1)
    c.check("预览显示文件清单", len(preview["scope"]["files"]) >= 60)
    c.check("预览显示未包含关联", preview["scope"]["omittedRelations"]["total"] >= 3)
    basis = preview["scope"]["basisCandidates"]
    c.check(
        "预览列出已删除来源占位且不可选",
        any(item["deleted"] and not item["selectable"] and item["title"] == "来源已删除" for item in basis),
        str(basis)[:300],
    )
    b_main_key = f"attempt:{b_main['id']}"
    c.check(
        "预览列出跨主题一跳依据",
        any(item["sourceKey"] == b_main_key and item["selectable"] for item in basis),
    )

    status, raw, headers = export_request(
        topic_a["id"],
        {"includeArchived": True, "includeBasisKeys": [], "expectedScopeHash": preview["scopeHash"]},
    )
    c.check("默认导出 ZIP 200", status == 200, str(status))
    c.check("导出 Content-Disposition 是 zip", ".zip" in header_get(headers, "Content-Disposition"))
    names = zip_names(raw)
    c.check("ZIP 路径安全且符合白名单", safe_names(names), str(names[:3]))
    root = names[0].split("/", 1)[0]
    record_files = [name for name in names if name.endswith(".md") and "records/" in name]
    c.check("每个实体只有一份文件", len(record_files) == len(set(record_files)))
    c.check(
        "超过一页的尝试完整导出",
        all(f"attempt-{attempt_id}.md" in "\n".join(names) for attempt_id in a1_attempt_ids),
        str(len(a1_attempt_ids)),
    )
    c.check(
        "文件名使用稳定 ID 而非标题",
        f"records/thoughts/thought-{a1['id']}.md" in "\n".join(names),
    )
    default_text = all_text(raw)
    c.check("默认不包含主题 B 正文", f"UNIQUE_B1_SECRET_{uid}" not in default_text)
    c.check("默认不包含主题 B 同名记录", f"UNIQUE_B2_SECRET_{uid}" not in default_text)
    c.check("默认不包含未勾选依据的后续尝试", f"B1_OTHER_SECRET_{uid}" not in default_text)
    c.check("已删除来源正文不进入包", f"DELETED_SECRET_{uid}" not in default_text)
    c.check("已删除来源结果快照不进入包", f"DELETED_RESULT_SECRET_{uid}" not in default_text)
    c.check("已删除来源只保留占位", "来源已删除" in default_text)
    c.check(
        "当前结果与引用时快照分别标注",
        "引用时快照" in default_text and "导出时当前内容" in default_text,
    )
    c.check(
        "历史采用与当前经验正文分别标注",
        "采用时经验版本" in default_text and "历史快照，不代表当前正文" in default_text,
    )
    c.check("未填写结果不显示为失败", "不能据此判断成败" in default_text)
    link_names, missing_links = link_targets(raw)
    c.check("所有生成链接都指向包内真实文件", len(missing_links) == 0, str(missing_links[:5]))

    # ---------- includeArchived=false ----------
    status, no_archived = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": False, "includeBasisKeys": []},
    )
    c.check("关闭归档预览 200", status == 200)
    c.check(
        "关闭归档后排除归档念头",
        no_archived["scope"]["counts"]["thoughts"] < preview["scope"]["counts"]["thoughts"],
        str(no_archived["scope"]["counts"]),
    )

    # ---------- 只追加用户勾选的一条一跳依据 ----------
    status, preview_basis = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": True, "includeBasisKeys": [b_main_key]},
    )
    c.check("勾选一跳依据预览 200", status == 200)
    c.check(
        "只增加一条依据文件",
        len(preview_basis["scope"]["files"]) == len(preview["scope"]["files"]) + 1,
        str(
            (
                len(preview["scope"]["files"]),
                len(preview_basis["scope"]["files"]),
            )
        ),
    )
    status, basis_raw, _ = export_request(
        topic_a["id"],
        {
            "includeArchived": True,
            "includeBasisKeys": [b_main_key],
            "expectedScopeHash": preview_basis["scopeHash"],
        },
    )
    c.check("追加依据导出 ZIP 200", status == 200)
    basis_text = all_text(basis_raw)
    c.check("追加依据后包含该尝试当前结果", f"B1_RESULT_NEW_{uid}" in basis_text)
    c.check("不递归追加它所属念头", f"UNIQUE_B1_SECRET_{uid}" not in basis_text)
    c.check("不递归追加它的其他尝试", f"B1_OTHER_SECRET_{uid}" not in basis_text)
    c.check("不递归追加另一条候选念头", f"UNIQUE_B2_SECRET_{uid}" not in basis_text)

    # ---------- scopeHash 与文件名稳定性 ----------
    before_counts = db_counts()
    status, conflict, _ = export_request(
        topic_a["id"],
        {"includeArchived": True, "includeBasisKeys": [], "expectedScopeHash": "0" * 64},
    )
    c.check("过期 scopeHash 返回 409", status == 409 and conflict.get("error") == "export_scope_changed")
    after_counts = db_counts()
    c.check("导出失败不修改业务数据", before_counts == after_counts, str((before_counts, after_counts)))

    a1_now = get(f"/api/captures/{a1['id']}")["capture"]
    patch(
        f"/api/captures/{a1['id']}",
        {"rawText": special + "（已改名）", "revision": a1_now["revision"]},
    )
    status, after_edit = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": True, "includeBasisKeys": []},
    )
    c.check("标题修改后预览 200", status == 200)
    c.check("标题修改使 scopeHash 变化", after_edit["scopeHash"] != preview["scopeHash"])
    c.check(
        "标题修改不改变记录文件名",
        [item["path"] for item in after_edit["scope"]["files"]]
        == [item["path"] for item in preview["scope"]["files"]],
    )
    status, conflict2, _ = export_request(
        topic_a["id"],
        {"includeArchived": True, "includeBasisKeys": [], "expectedScopeHash": preview["scopeHash"]},
    )
    c.check("标题修改后旧 hash 导出被拒绝", status == 409 and conflict2.get("error") == "export_scope_changed")

    # ---------- 请求校验与限制 ----------
    status, invalid = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": True, "includeBasisKeys": ["capture:does-not-exist"]},
    )
    c.check("无效依据 key 返回 400", status == 400 and invalid.get("error") == "invalid_request")
    status, too_many = client.post(
        f"/api/topics/{topic_a['id']}/export/preview",
        {"includeArchived": True, "includeBasisKeys": [f"attempt:x{i}" for i in range(201)]},
    )
    c.check("超过 200 条依据返回 400", status == 400 and too_many.get("error") == "invalid_request")

    # ---------- 原有 JSON 导出回归 ----------
    status, json_export = client.get("/api/export")
    c.check("原有 JSON 导出仍可用", status == 200, str(status))
    c.check(
        "JSON 导出仍含 topics/topicMembers",
        "topics" in json_export.get("data", {}) and "topicMembers" in json_export.get("data", {}),
    )

    # ---------- 无模型配置也能导出 ----------
    status, ai_settings = client.get("/api/settings/ai")
    c.check(
        "未配置模型时导出仍成功",
        status == 200 and ai_settings.get("configured") is False and preview["canExport"] is True,
        str(ai_settings)[:200],
    )

    # 保留示例 ZIP（只用合成数据）。
    sample_path = os.path.join(ROOT, "output", "shinian-topic-export-sample.zip")
    os.makedirs(os.path.dirname(sample_path), exist_ok=True)
    with open(sample_path, "wb") as handle:
        handle.write(raw)
    c.check("已保留合成示例 ZIP", os.path.getsize(sample_path) > 0, sample_path)

    ok = c.report("主题 Markdown ZIP 导出 API 验收")
    sys.exit(0 if ok else 1)
finally:
    stop_server()
    if not KEEP:
        for suffix in ("", "-wal", "-shm"):
            path = TEST_DB + suffix
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
