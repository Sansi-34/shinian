"""拾念 SHINIAN v0.1 - 测试编排

- 使用独立测试数据库 db/test.sqlite，与用户数据分离
- 在 3100 端口启动独立测试服务
- 依次运行 test_api.py / test_search.py / test_consistency.py /
  test_ai.py / test_experience.py / test_review.py / test_next_action.py /
  test_schedule.py / test_activity.py / test_research.py / test_ask.py /
  test_experience_note.py / test_keyword_expansion.py
- 重启服务后验证数据持久化（记录、引用、日程安排、下一步行动、pending 生成被标记为 interrupted）
"""
import http.cookiejar
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_DB = os.path.join(ROOT, "db", "test.sqlite")
TEST_MASTER_KEY = os.path.join(ROOT, "db", "test-master.key")
TEST_LOG = os.path.join(ROOT, "db", "test-server.log")
PORT = os.environ.get("SHINIAN_TEST_PORT", "3100")
BASE = f"http://127.0.0.1:{PORT}"
# 只跑手动闭环（跳过后续迭代的 AI 套件），供本阶段回归使用
MANUAL_ONLY = os.environ.get("SHINIAN_TEST_MANUAL_ONLY") == "1"

proc = None
log_handle = None


def start_server():
    global proc, log_handle
    env = dict(os.environ)
    env["PORT"] = PORT
    env["DATABASE_URL"] = TEST_DB
    env["SHINIAN_MASTER_KEY_FILE"] = TEST_MASTER_KEY
    # 契约 §9：测试服务使用较短的模型超时，fake-timeout 的 5s 延迟才能变成可断言的 timeout
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = env.get("SHINIAN_AI_TEST_TIMEOUT_MS", "800")
    env["SHINIAN_AI_TIMEOUT_MS"] = env.get("SHINIAN_AI_TIMEOUT_MS", "1200")
    env["SHINIAN_GITHUB_API_BASE"] = env.get("SHINIAN_GITHUB_API_BASE", "http://127.0.0.1:3510")
    env["SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS"] = env.get("SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS", "600")
    env["SHINIAN_RESEARCH_MODEL_TIMEOUT_MS"] = env.get("SHINIAN_RESEARCH_MODEL_TIMEOUT_MS", "1200")
    node = "node"
    tsx = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
    log_handle = open(TEST_LOG, "ab")
    proc = subprocess.Popen(
        [node, tsx, os.path.join(ROOT, "src", "server", "index.ts")],
        cwd=ROOT,
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
    )
    for _ in range(80):
        try:
            urllib.request.urlopen(BASE + "/api/session/check", timeout=1)
        except urllib.error.HTTPError:
            return
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError(f"测试服务进程已退出，日志见 {TEST_LOG}")
            time.sleep(0.25)
    raise RuntimeError(f"测试服务未能启动，日志见 {TEST_LOG}")


def stop_server():
    global proc, log_handle
    if proc:
        if os.name == "nt":
            # tsx 在 Windows 上会派生子 node 进程，按进程树结束以释放端口与数据库句柄
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        proc = None
    if log_handle is not None:
        log_handle.close()
        log_handle = None


def run(script):
    env = dict(os.environ)
    env["SHINIAN_BASE"] = BASE
    env["SHINIAN_TEST_DB"] = TEST_DB
    env["SHINIAN_TEST_LOG"] = TEST_LOG
    env["SHINIAN_MASTER_KEY_FILE"] = TEST_MASTER_KEY
    env["SHINIAN_AI_TEST_TIMEOUT_MS"] = env.get("SHINIAN_AI_TEST_TIMEOUT_MS", "800")
    env["SHINIAN_AI_TIMEOUT_MS"] = env.get("SHINIAN_AI_TIMEOUT_MS", "1200")
    env["SHINIAN_GITHUB_API_BASE"] = env.get("SHINIAN_GITHUB_API_BASE", "http://127.0.0.1:3510")
    env["SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS"] = env.get("SHINIAN_RESEARCH_GITHUB_TIMEOUT_MS", "600")
    env["SHINIAN_RESEARCH_MODEL_TIMEOUT_MS"] = env.get("SHINIAN_RESEARCH_MODEL_TIMEOUT_MS", "1200")
    env["PYTHONIOENCODING"] = "utf-8"
    print(f"\n### 运行 {script}")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", script)], cwd=ROOT, env=env)
    return r.returncode == 0


def insert_pending_generation():
    """在重启前直接插入一条 pending 生成，用于验证启动时中断恢复。

    返回 generation id；失败返回 None（由 persistence_check 报 FAIL）。
    """
    try:
        with sqlite3.connect(TEST_DB, timeout=15) as conn:
            row = conn.execute(
                "SELECT id, revision, raw_text FROM captures ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if not row:
                print("WARN 重启前没有可用念头，跳过 pending 插入")
                return None
            capture_id, revision, raw_text = row
            now_ms = int(time.time() * 1000)
            gen_id = f"gen-restart-pending-{now_ms}"
            conn.execute(
                """
                INSERT INTO ai_generations (
                    id, capture_id, capture_revision, capture_text, constraint_text,
                    config_id, config_version, config_name, base_url, model_id,
                    status, kind, suggestion_json, error_code, error_detail,
                    usage_json, duration_ms, adopted_attempt_id, adopted_at,
                    dismissed_at, operation_id, operation_fingerprint,
                    created_at, updated_at, finished_at
                ) VALUES (?, ?, ?, ?, NULL, 'default', 1, '重启测试',
                          'http://127.0.0.1:3501/v1', 'fake-success',
                          'pending', NULL, NULL, NULL, NULL,
                          NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, NULL)
                """,
                (gen_id, capture_id, revision, raw_text, gen_id, now_ms, now_ms),
            )
            conn.commit()
            print(f"已插入重启前 pending 生成：{gen_id}（capture={capture_id}）")
            return gen_id
    except Exception as exc:  # noqa: BLE001 - 失败要作为测试结果上报
        print(f"WARN 插入 pending 生成失败：{exc!r}")
        return None


def insert_pending_research():
    """重启前插入一条 generating 研究，重启后应变为 interrupted。"""
    try:
        with sqlite3.connect(TEST_DB, timeout=15) as conn:
            row = conn.execute(
                "SELECT id, revision, raw_text FROM captures ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if not row:
                print("WARN 重启前没有可用念头，跳过研究中断插入")
                return None
            capture_id, revision, raw_text = row
            now_ms = int(time.time() * 1000)
            research_id = f"res-restart-{now_ms}"
            conn.execute(
                """
                INSERT INTO research_runs (
                    id, capture_id, capture_revision, capture_text, question,
                    constraints_json, search_mode, search_query, repo_inputs_json,
                    status, limits_json, candidates_json, selected_candidate_ids_json,
                    sent_source_ids_json, result_json, config_id, config_version,
                    config_name, model_id, usage_json, duration_ms, stats_json,
                    error_code, error_detail, failed_json, operation_id,
                    operation_fingerprint, context_token, revision, saved_at,
                    created_at, updated_at, finished_at
                ) VALUES (?, ?, ?, ?, '重启研究中断检查', NULL,
                          'keyword', 'restart-check', NULL, 'generating', '{}', NULL,
                          '[]', '[]', NULL, 'default', 1, '重启测试', 'fake-research-success',
                          NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, 1, NULL,
                          ?, ?, NULL)
                """,
                (research_id, capture_id, revision, raw_text, research_id, now_ms, now_ms),
            )
            conn.commit()
            print(f"已插入重启前 generating 研究：{research_id}（capture={capture_id}）")
            return research_id
    except Exception as exc:  # noqa: BLE001
        print(f"WARN 插入 pending 研究失败：{exc!r}")
        return None


def insert_restart_schedule():
    """重启前通过 API 建一条唯一日程，重启后核对仍在（日程表持久化）。

    返回 {attemptId, scheduleId, startsAt, endsAt, note}；失败返回 None。
    """
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def req(method, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        r = urllib.request.Request(
            BASE + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with opener.open(r, timeout=15) as res:
            return json.loads(res.read().decode())

    try:
        req("POST", "/api/session/create", {"username": "测试用户"})
        caps = req("GET", "/api/captures")["captures"]
        attempt_id = None
        for cap in caps:
            attempts = req("GET", f"/api/captures/{cap['id']}/attempts")["attempts"]
            if attempts:
                attempt_id = attempts[0]["id"]
                break
        if attempt_id is None:
            cap = req("POST", "/api/captures", {"rawText": "重启日程持久化检查念头"})["capture"]
            attempt_id = req(
                "POST",
                f"/api/captures/{cap['id']}/attempts",
                {
                    "step": "重启日程持久化检查尝试",
                    "state": "todo",
                    "operationId": f"op-restart-schedule-attempt-{int(time.time() * 1000)}",
                },
            )["attempt"]["id"]
        note = f"重启持久化检查-{int(time.time() * 1000)}"
        schedule = req(
            "POST",
            f"/api/attempts/{attempt_id}/schedules",
            {
                "date": "2030-01-05",
                "startTime": "10:00",
                "endTime": "11:00",
                "timezone": "Asia/Shanghai",
                "note": note,
                "operationId": f"op-restart-schedule-{int(time.time() * 1000)}",
            },
        )["schedule"]
        print(
            f"已创建重启前日程：{schedule['id']}（attempt={attempt_id}, "
            f"startsAt={schedule['startsAt']}, note={note}）"
        )
        return {
            "attemptId": attempt_id,
            "scheduleId": schedule["id"],
            "startsAt": schedule["startsAt"],
            "endsAt": schedule["endsAt"],
            "note": note,
        }
    except Exception as exc:  # noqa: BLE001 - 失败要作为测试结果上报
        print(f"WARN 创建重启前日程失败：{exc!r}")
        return None


def find_restart_next_action():
    """重启前定位一条带来源引用 + active 日程的下一步行动，重启后核对。

    返回 {actionId,title,sourceReviewId,sourceAttemptId,scheduleId,startsAt,endsAt}。
    完整套件中 test_next_action.py 已留下这些数据；若没有，则在完整模式下
    从已保存回顾直接创建一条（不依赖模型），保证持久化检查可执行。
    """
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def req(method, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        r = urllib.request.Request(
            BASE + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with opener.open(r, timeout=15) as res:
            return json.loads(res.read().decode())

    try:
        req("POST", "/api/session/create", {"username": "测试用户"})
        reviews = (req("GET", "/api/reviews?limit=50") or {}).get("reviews") or []
        for review in reviews:
            review_id = review.get("id")
            if not review_id:
                continue
            try:
                actions = (req("GET", f"/api/reviews/{review_id}/next-actions") or {}).get("actions") or []
            except Exception:
                continue
            for action in actions:
                action_id = action.get("id")
                if not action_id or not action.get("sourceAttemptId"):
                    continue
                schedules = (req("GET", f"/api/attempts/{action_id}/schedules") or {}).get("schedules") or []
                active = [x for x in schedules if x.get("status") == "active"]
                refs = (req("GET", f"/api/attempts/{action_id}/references") or {}).get("fromRefs") or []
                if active and refs:
                    return {
                        "actionId": action_id,
                        "title": action.get("title"),
                        "sourceReviewId": review_id,
                        "sourceAttemptId": action.get("sourceAttemptId"),
                        "scheduleId": active[0].get("id"),
                        "startsAt": active[0].get("startsAt"),
                        "endsAt": active[0].get("endsAt"),
                    }
        if MANUAL_ONLY:
            return None
        print("WARN 未找到可复用的下一步行动，尝试从已保存回顾创建一条")
        for review in reviews:
            review_id = review.get("id")
            if not review_id:
                continue
            try:
                preview = req("GET", f"/api/reviews/{review_id}/next-action-preview?experienceIndex=0")
                defaults = preview.get("defaults") or {}
                capture = next(
                    (x for x in preview.get("captures") or [] if x.get("id") == defaults.get("captureId")),
                    None,
                )
                if not capture:
                    continue
                created = req(
                    "POST",
                    f"/api/reviews/{review_id}/next-actions",
                    {
                        "captureId": defaults.get("captureId"),
                        "captureRevision": capture.get("revision"),
                        "experienceIndex": 0,
                        "title": "重启持久化检查下一步行动",
                        "description": "重启后核对来源引用与日程。",
                        "estimatedMinutes": 15,
                        "contextToken": preview.get("contextToken"),
                        "operationId": f"op-restart-na-{int(time.time() * 1000)}",
                        "schedule": {
                            "date": "2031-01-10",
                            "endDate": "2031-01-10",
                            "startTime": "09:00",
                            "endTime": "09:30",
                            "timezone": "Asia/Shanghai",
                            "note": "重启持久化检查下一步日程",
                        },
                    },
                )
                action = created.get("nextAction") or {}
                schedule = (action.get("schedules") or [{}])[0]
                return {
                    "actionId": action.get("id"),
                    "title": action.get("title"),
                    "sourceReviewId": review_id,
                    "sourceAttemptId": action.get("sourceAttemptId"),
                    "scheduleId": schedule.get("id"),
                    "startsAt": schedule.get("startsAt"),
                    "endsAt": schedule.get("endsAt"),
                }
            except Exception:
                continue
        return None
    except Exception as exc:  # noqa: BLE001 - 失败要作为测试结果上报
        print(f"WARN 准备重启前下一步行动失败：{exc!r}")
        return None


def persistence_check(pending_gen_id=None, restart_schedule=None, restart_next_action=None, pending_research_id=None):
    """重启后核对：登录、列表、引用关系仍在；如提供 pending 生成，再核对中断恢复。"""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def req(method, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        r = urllib.request.Request(
            BASE + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with opener.open(r, timeout=10) as res:
            return json.loads(res.read().decode())

    req("POST", "/api/session/create", {"username": "测试用户"})
    caps = req("GET", "/api/captures")
    ok = len(caps["captures"]) >= 20
    found_ref = False
    for c in caps["captures"]:
        atts = req("GET", f"/api/captures/{c['id']}/attempts")
        for a in atts["attempts"]:
            refs = req("GET", f"/api/attempts/{a['id']}/references")
            if len(refs["fromRefs"]) > 0 or len(refs["toRefs"]) > 0:
                found_ref = True
    print(
        f"PASS  重启后记录仍在（{len(caps['captures'])} 条念头）"
        if ok
        else f"FAIL  重启后记录缺失（{len(caps['captures'])}）"
    )
    print("PASS  重启后引用关系仍在" if found_ref else "FAIL  重启后引用关系缺失")

    schedule_ok = False
    if restart_schedule:
        try:
            data = req("GET", f"/api/attempts/{restart_schedule['attemptId']}/schedules")
            rows = data.get("schedules") or []
            row = next((x for x in rows if x.get("id") == restart_schedule["scheduleId"]), None)
            schedule_ok = (
                row is not None
                and row.get("startsAt") == restart_schedule["startsAt"]
                and row.get("endsAt") == restart_schedule["endsAt"]
                and row.get("note") == restart_schedule["note"]
                and row.get("status") == "active"
                and row.get("timezone") == "Asia/Shanghai"
            )
            detail = str(row)[:300] if row else f"missing in {len(rows)} rows"
        except Exception as exc:  # noqa: BLE001
            detail = repr(exc)
        print(
            f"PASS  重启后日程仍在（{restart_schedule['scheduleId']}）"
            if schedule_ok
            else f"FAIL  重启后日程缺失或不一致（{detail}）"
        )
    else:
        print("FAIL  重启前未创建日程，无法验证日程持久化")

    next_action_ok = False
    if restart_next_action:
        action_id = restart_next_action["actionId"]
        detail = ""
        try:
            action = (req("GET", f"/api/next-actions/{action_id}") or {}).get("action") or {}
            action_ok = (
                action.get("id") == action_id
                and action.get("title") == restart_next_action["title"]
                and action.get("origin") == "review_next_action"
                and action.get("sourceReviewId") == restart_next_action["sourceReviewId"]
                and action.get("sourceAttemptId") == restart_next_action["sourceAttemptId"]
            )
            refs = (req("GET", f"/api/attempts/{action_id}/references") or {}).get("fromRefs") or []
            ref_ok = any(
                x.get("toAttemptId") == restart_next_action["sourceAttemptId"] for x in refs
            )
            schedules = (req("GET", f"/api/attempts/{action_id}/schedules") or {}).get("schedules") or []
            schedule = next(
                (x for x in schedules if x.get("id") == restart_next_action["scheduleId"]), None
            )
            schedule_ok_next = (
                schedule is not None
                and schedule.get("startsAt") == restart_next_action["startsAt"]
                and schedule.get("endsAt") == restart_next_action["endsAt"]
                and schedule.get("status") == "active"
            )
            next_action_ok = action_ok and ref_ok and schedule_ok_next
            detail = (
                f"action={action_ok} ref={ref_ok} schedule={schedule_ok_next} "
                f"status={action.get('state')} title={action.get('title')!r}"
            )
        except Exception as exc:  # noqa: BLE001
            detail = repr(exc)
        print(
            f"PASS  重启后下一步行动/引用/日程仍在（{action_id}）"
            if next_action_ok
            else f"FAIL  重启后下一步行动/引用/日程缺失或不一致（{detail}）"
        )
    elif MANUAL_ONLY:
        print("SKIP  手动模式未验证下一步行动持久化")
    else:
        print("FAIL  重启前未准备下一步行动，无法验证其持久化")

    research_ok = False
    if pending_research_id:
        try:
            data = req("GET", f"/api/research/{pending_research_id}")
            research = data.get("research") or {}
            research_ok = (
                research.get("status") == "interrupted"
                and research.get("errorCode") == "interrupted"
                and isinstance(research.get("finishedAt"), int)
            )
            detail = f"{research.get('status')}/{research.get('errorCode')}"
        except Exception as exc:  # noqa: BLE001
            detail = repr(exc)
        print(
            f"PASS  重启后未完成研究变为 interrupted（{detail}）"
            if research_ok
            else f"FAIL  重启后研究未正确中断（{detail}）"
        )
    elif MANUAL_ONLY:
        print("SKIP  手动模式未验证研究中断恢复")
    else:
        print("FAIL  重启前未插入 pending 研究，无法验证中断恢复")

    if MANUAL_ONLY:
        return ok and found_ref and schedule_ok

    interrupted_ok = False
    if pending_gen_id:
        try:
            data = req("GET", f"/api/generations/{pending_gen_id}")
            gen = data.get("generation") or {}
            interrupted_ok = (
                gen.get("status") == "interrupted"
                and gen.get("errorCode") == "interrupted"
                and isinstance(gen.get("finishedAt"), int)
                and "服务重启" in str(gen.get("errorMessage") or "")
            )
            detail = f"{gen.get('status')}/{gen.get('errorCode')}/{gen.get('errorMessage')}"
        except Exception as exc:  # noqa: BLE001
            detail = repr(exc)
        print(
            f"PASS  重启后 pending 生成变为 interrupted（{detail}）"
            if interrupted_ok
            else f"FAIL  重启后 pending 生成未正确中断（{detail}）"
        )
    else:
        print("FAIL  重启前未插入 pending 生成，无法验证中断恢复")
    return ok and found_ref and schedule_ok and next_action_ok and interrupted_ok and research_ok


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "db"), exist_ok=True)
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    for suffix in ("-wal", "-shm"):
        p = TEST_DB + suffix
        if os.path.exists(p):
            os.remove(p)
    if os.path.exists(TEST_MASTER_KEY):
        os.remove(TEST_MASTER_KEY)
    if os.path.exists(TEST_LOG):
        os.remove(TEST_LOG)

    all_ok = True
    try:
        print(f"启动测试服务 {BASE}（数据库 {TEST_DB}）")
        print(f"测试主密钥：{TEST_MASTER_KEY}")
        print(f"测试服务日志：{TEST_LOG}")
        start_server()
        all_ok &= run("test_api.py")
        all_ok &= run("test_search.py")
        all_ok &= run("test_consistency.py")
        if MANUAL_ONLY:
            print("\n### 跳过后续迭代的 AI 套件（SHINIAN_TEST_MANUAL_ONLY=1）")
        else:
            all_ok &= run("test_ai.py")
            all_ok &= run("test_experience.py")
            all_ok &= run("test_review.py")
        all_ok &= run("test_next_action.py")
        all_ok &= run("test_schedule.py")
        all_ok &= run("test_activity.py")
        all_ok &= run("test_research.py")
        all_ok &= run("test_ask.py")
        all_ok &= run("test_experience_note.py")
        all_ok &= run("test_keyword_expansion.py")

        print("\n### 重启服务，验证持久化")
        pending_gen_id = None if MANUAL_ONLY else insert_pending_generation()
        restart_schedule = insert_restart_schedule()
        restart_next_action = find_restart_next_action()
        pending_research_id = insert_pending_research()
        stop_server()
        time.sleep(1)
        start_server()
        all_ok &= persistence_check(
            pending_gen_id, restart_schedule, restart_next_action, pending_research_id
        )
    finally:
        stop_server()

    print(f"\n测试服务日志保留于：{TEST_LOG}")
    print("\n" + "=" * 60)
    print("全部测试通过 (OK)" if all_ok else "存在失败项 (FAILED)")
    print("=" * 60)
    sys.exit(0 if all_ok else 1)
