"""拾念 SHINIAN · 「沉淀一条经验」第一版 API 验收

针对已运行且已应用 0011 迁移的隔离测试库（SHINIAN_BASE / SHINIAN_TEST_DB）。
覆盖：
1. 问我的记录单条观点 → 草稿只带该观点实际来源 → 保存（模型出处保留）。
2. 有结果的尝试 → 手动整理经验（不调用模型）。
3. 保存/读取/重复提交（operationId 幂等）。
4. 搜索、手动关联/反链、局部图关系。
5. 修改标题不破坏链接；revision 冲突保留 current。
6. 参考经验创建尝试只创建一次；记录结果后经验详情可见。
7. 修订经验保留旧尝试的采用版本；系统不自动裁决旧理解。
8. 来源更新提示、来源删除清理正文快照与待修订标记。
9. 删除经验不删除来源；后续尝试保留结果，仅清经验快照。
10. 导出 schemaVersion=6 与三张经验表；搜索不泄露已删来源正文。
"""
import json
import os
import sqlite3
import sys
import time
import uuid

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Checker, Client  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('SHINIAN_BASE', 'http://127.0.0.1:3110').rstrip('/')
TEST_DB = os.environ.get('SHINIAN_TEST_DB') or os.path.join(ROOT, 'db', 'verify-experience-note.sqlite')
UID = uuid.uuid4().hex[:8]
USERNAME = f'经验验收-{UID}'

c = Checker()
client = Client(base=BASE)


def op(tag):
    return f'op-{tag}-{UID}-{uuid.uuid4().hex[:6]}'


def db():
    conn = sqlite3.connect(TEST_DB)
    conn.row_factory = sqlite3.Row
    return conn


def create_capture(text):
    st, res = client.post('/api/captures', {'rawText': text})
    assert st == 200, (st, res)
    return res['capture']


def create_attempt(capture_id, step, result=None, outcome=None, state='todo'):
    body = {'step': step, 'state': state, 'operationId': op('att')}
    if result is not None:
        body['resultText'] = result
        body['outcome'] = outcome
    st, res = client.post(f'/api/captures/{capture_id}/attempts', body)
    assert st == 200, (st, res)
    return res['attempt']


def save_result(attempt, text, outcome='success'):
    st, res = client.patch(
        f"/api/attempts/{attempt['id']}",
        {
            'resultText': text,
            'outcome': outcome,
            'observedAt': int(time.time() * 1000),
            'revision': attempt['revision'],
            'state': 'done',
        },
    )
    assert st == 200, (st, res)
    return res['attempt']


def create_experience(body):
    return client.post('/api/experiences', body)


def main():
    anonymous = Client(base=BASE)
    st_anon, _ = anonymous.get('/api/experiences')
    c.check('未登录时经验列表返回 401', st_anon == 401, st_anon)

    st, login = client.post('/api/session/create', {'username': USERNAME})
    c.check('登录成功', st == 200 and login.get('ok'), f'{st} {login}')

    # ---- 前置数据：一条念头 + 两个结果不同的尝试 ----
    capture = create_capture('睡前把手机放到书桌上，比放在枕边更容易停止刷手机。')
    helpful_text = f'手机放书桌后十分钟内睡着了-{UID}'
    failed_text = f'临时工作消息，还是刷了很久-{UID}'
    helpful = create_attempt(capture['id'], '睡前把手机放到书桌上', helpful_text, 'success', 'done')
    failed = create_attempt(capture['id'], '睡前把手机放在枕边', failed_text, 'failure', 'done')
    other_capture = create_capture(f'另一条相关念头-{UID}')

    # ---- 1. 问我的记录单条观点 → 草稿 ----
    query_id = f'q-{UID}'
    answer = {
        'summary': '从两次记录看，手机位置会影响睡前刷手机的时长。',
        'points': [
            {
                'text': '把手机放到书桌上后，我更快停止刷手机。',
                'basis': 'observation',
                'condition': '普通工作日晚上',
                'sourceIds': [f'attempt:{helpful["id"]}'],
            },
            {
                'text': '手机放远一点可能减少刷手机。',
                'basis': 'inference',
                'condition': None,
                'sourceIds': [f'capture:{capture["id"]}'],
            },
        ],
        'contradictions': [],
        'missing': [],
        'insufficientEvidence': False,
    }
    now = int(time.time() * 1000)
    with db() as conn:
        conn.execute(
            """INSERT INTO record_queries
               (id, question, keywords, range_from, range_to, status, answer_json, sources_json,
                config_id, config_version, config_name, model_id, created_at, updated_at, finished_at)
               VALUES (?, ?, ?, NULL, NULL, 'succeeded', ?, '[]', NULL, NULL, NULL, NULL, ?, ?, ?)""",
            (query_id, f'睡前刷手机 {UID}', '手机 睡前', json.dumps(answer, ensure_ascii=False), now, now, now),
        )
        conn.commit()

    st, draft = client.get(f'/api/ask/queries/{query_id}/experience-draft?pointIndex=0')
    d = draft.get('draft', {}) if isinstance(draft, dict) else {}
    c.check('问答观点草稿可读取', st == 200, f'{st} {draft}')
    c.check(
        '问答草稿只预填该观点实际引用的来源',
        [s['sourceKey'] for s in d.get('sources', [])] == [f'attempt:{helpful["id"]}'],
        json.dumps(d.get('sources'), ensure_ascii=False),
    )
    c.check('问答草稿保留模型出处与观点类型', d.get('by') == 'model' and d.get('modelBasis') == 'observation', d.get('by'))
    c.check('问答草稿带 queryId 与观点索引', d.get('originQueryId') == query_id and d.get('originPointIndex') == 0, d.get('originQueryId'))

    st, bad = client.get(f'/api/ask/queries/{query_id}/experience-draft?pointIndex=99')
    c.check('越界观点索引返回明确错误', st in (400, 404) and bad.get('error') == 'point_not_found', f'{st} {bad}')

    # ---- 1b. 保存问答经验（模型整理） ----
    ask_payload = {
        'title': '手机放到书桌上更容易停下来',
        'understanding': '把手机放到书桌上，比放在枕边更容易停止刷手机；这是一条模型整理的观点，仍待核对。',
        'conditions': '普通工作日晚上',
        'limitations': '只有一次结果，不能概括成普遍有效。',
        'by': 'model',
        'modelBasis': 'observation',
        'originKind': 'ask',
        'originQueryId': query_id,
        'originPointIndex': 0,
        'contextCaptureId': capture['id'],
        'sourceKeys': [f'attempt:{helpful["id"]}'],
        'operationId': op('exp-ask'),
    }
    st, saved = create_experience(ask_payload)
    exp_ask = saved.get('experience', {}) if isinstance(saved, dict) else {}
    c.check('从问答保存经验返回 201', st == 201, f'{st} {saved}')
    c.check('保存后保留「由模型推断整理」出处', exp_ask.get('derivation', {}).get('by') == 'model' and exp_ask['derivation'].get('modelBasis') == 'observation', exp_ask.get('derivation'))
    c.check('保存后至少关联一条可访问来源', exp_ask.get('sourceCount') == 1 and exp_ask['sources'][0]['exists'], exp_ask.get('sources'))
    c.check('问答整理回执记录 queryId/pointIndex', exp_ask.get('derivation', {}).get('originQueryId') == query_id and exp_ask['derivation'].get('originPointIndex') == 0, exp_ask.get('derivation'))
    c.check('有真实结果时不显示「尚无实践结果支持」', exp_ask.get('hasPracticeResult') is True, exp_ask.get('hasPracticeResult'))

    # 重复提交同一 operation 只创建一次
    st2, replay = create_experience(ask_payload)
    c.check('重复提交同一操作返回同一经验', st2 in (200, 201) and replay['experience']['id'] == exp_ask['id'] and replay.get('replayed') is True, f'{st2} {replay.get("replayed")}')
    with db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM captures WHERE kind='experience' AND id=?", (exp_ask['id'],)
        ).fetchone()['n']
    c.check('重复提交未产生第二条经验', count == 1, count)

    # 来源不可用/无来源观点场景
    st, no_source = create_experience({**ask_payload, 'sourceKeys': [], 'operationId': op('empty')})
    c.check('没有可用来源时拒绝保存（422）', st == 422 and no_source.get('error') == 'source_required', f'{st} {no_source}')

    # ---- 2. 从有结果的尝试手动整理（不需模型） ----
    st, att_draft = client.get(f'/api/attempts/{failed["id"]}/experience-draft')
    ad = att_draft.get('draft', {}) if isinstance(att_draft, dict) else {}
    c.check('尝试草稿展示实际结果且不预填理解', st == 200 and ad.get('by') == 'user' and ad.get('understanding') == '' and ad.get('sources', [{}])[0].get('resultText') == failed_text, f'{st} {ad}')
    attempt_payload = {
        'title': '临时工作消息会打断睡前放下手机',
        'understanding': '如果晚上还有临时工作消息，把手机放远也未必能马上停止刷手机。',
        'conditions': '晚上没有临时工作消息时',
        'limitations': '这是一次反例，需要再试。',
        'by': 'user',
        'originKind': 'attempt',
        'originAttemptId': failed['id'],
        'contextCaptureId': capture['id'],
        'sourceKeys': [f'attempt:{failed["id"]}'],
        'operationId': op('exp-att'),
    }
    st, exp2 = create_experience(attempt_payload)
    e2 = exp2.get('experience', {}) if isinstance(exp2, dict) else {}
    c.check('从尝试保存经验返回 201', st == 201, f'{st} {exp2}')
    c.check('尝试经验由用户整理、不冒充模型', e2.get('derivation', {}).get('by') == 'user', e2.get('derivation'))

    # ---- 3. 搜索、链接、反链、局部图 ----
    st, search = client.get(f'/api/experiences/search?q=手机')
    hits = search.get('hits', []) if isinstance(search, dict) else []
    ask_hit = next((h for h in hits if h['id'] == exp_ask['id']), None)
    c.check('经验搜索命中标题', st == 200 and ask_hit is not None, f'{st} {hits[:2]}')
    if ask_hit:
        c.check('搜索展示摘要与命中原因', bool(ask_hit.get('snippet')) and bool(ask_hit.get('matchReason')), ask_hit)

    st, top_search = client.get('/api/search?q=' + '书桌')
    c.check('总搜索返回 experiences 分组', st == 200 and any(x['id'] == exp_ask['id'] for x in top_search.get('experiences', [])), f'{st} {str(top_search)[:200]}')

    st, link = client.post(
        f"/api/captures/{exp_ask['id']}/links",
        {'toCaptureId': other_capture['id'], 'note': '同一晚的观察', 'operationId': op('link')},
    )
    c.check('经验可与念头建立手动关联', st in (200, 201), f'{st} {link}')
    st, exp_links = client.get(f"/api/captures/{exp_ask['id']}/links")
    c.check('经验正链返回关联目标', st == 200 and exp_links['out'][0]['capture']['id'] == other_capture['id'], exp_links)
    st, rev_links = client.get(f"/api/captures/{other_capture['id']}/links")
    c.check('被关联方反链指向经验详情', st == 200 and rev_links['in'][0]['capture']['id'] == exp_ask['id'] and rev_links['in'][0]['capture']['href'] == f"/experience/{exp_ask['id']}", rev_links)
    c.check('反链带经验 kind/title', rev_links['in'][0]['capture']['kind'] == 'experience' and rev_links['in'][0]['capture']['title'], rev_links['in'][0]['capture'])

    st, graph = client.get(f'/api/graph?focus=experience:{exp_ask["id"]}')
    node = next((n for n in graph.get('nodes', []) if n['id'] == f'experience:{exp_ask["id"]}'), None)
    c.check('局部图包含经验节点与稳定 href', st == 200 and node is not None and node['href'] == f'/experience/{exp_ask["id"]}', node)
    edge = next((l for l in graph.get('links', []) if l['type'] == 'evidence' and l['source'] == f'experience:{exp_ask["id"]}' and l['target'] == f'attempt:{helpful["id"]}'), None)
    c.check('局部图用 evidence 区分依据关系', edge is not None and edge['label'] == '依据这条记录', edge)
    related_edge = next((l for l in graph.get('links', []) if l['type'] == 'related' and {l['source'], l['target']} == {f'experience:{exp_ask["id"]}', f'capture:{other_capture["id"]}'}), None)
    c.check('手动关联进入局部图 related，而不是依据', related_edge is not None, related_edge)

    # ---- 4. 修改标题不破坏链接；revision 冲突 ----
    st, updated = client.patch(
        f"/api/experiences/{exp_ask['id']}",
        {
            'title': '睡前把手机放到书桌上（修订标题）',
            'understanding': exp_ask['understanding'],
            'conditions': exp_ask['conditions'],
            'limitations': exp_ask['limitations'],
            'sourceKeys': [s['sourceKey'] for s in exp_ask['sources']],
            'revision': exp_ask['revision'],
            'operationId': op('update'),
        },
    )
    c.check('修改标题成功', st == 200 and updated['experience']['title'].endswith('（修订标题）'), f'{st} {updated}')
    c.check('修改后 revision 增加', updated['experience']['revision'] == exp_ask['revision'] + 1, updated['experience']['revision'])
    st, after_title = client.get(f"/api/captures/{exp_ask['id']}/links")
    c.check('修改标题后已有链接仍有效', st == 200 and after_title['out'][0]['capture']['id'] == other_capture['id'], after_title)
    st, stale = client.patch(
        f"/api/experiences/{exp_ask['id']}",
        {
            'title': '冲突版本不应写入',
            'understanding': '冲突',
            'sourceKeys': [s['sourceKey'] for s in exp_ask['sources']],
            'revision': exp_ask['revision'],
            'operationId': op('stale'),
        },
    )
    c.check('旧 revision 保存返回 409 与 current', st == 409 and stale.get('current', {}).get('title', '').endswith('（修订标题）'), f'{st} {stale}')

    # ---- 5. 参考经验，再试一步 ----
    basis = [s['sourceKey'] for s in updated['experience']['sources'] if s['type'] == 'attempt']
    try_payload = {
        'captureId': capture['id'],
        'title': f'再试一次：睡前放书桌-{UID}',
        'description': '按经验再试一个普通工作日晚上。',
        'basisSourceKeys': basis,
        'experienceRevision': updated['experience']['revision'],
        'operationId': op('try'),
    }
    st, try1 = client.post(f"/api/experiences/{exp_ask['id']}/attempts", try_payload)
    c.check('从经验创建尝试返回 201', st == 201, f'{st} {try1}')
    try_attempt = try1.get('attempt', {}) if isinstance(try1, dict) else {}
    c.check('新尝试只引用用户勾选的原始尝试', bool(basis), basis)
    st, try2 = client.post(f"/api/experiences/{exp_ask['id']}/attempts", try_payload)
    c.check('重复提交同一操作只创建一次尝试', st in (200, 201) and try2['attempt']['id'] == try_attempt['id'] and try2.get('replayed') is True, f'{st} {try2}')
    with db() as conn:
        n = conn.execute('SELECT COUNT(*) AS n FROM attempts WHERE step=?', (try_payload['title'],)).fetchone()['n']
        nref = conn.execute(
            'SELECT COUNT(*) AS n FROM attempt_references WHERE from_attempt_id=?', (try_attempt['id'],)
        ).fetchone()['n']
    c.check('重复提交未创建第二条尝试', n == 1, n)
    c.check('勾选的依据进入既有引用关系', nref == len(basis), (nref, basis))

    st, detail = client.get(f"/api/attempts/{try_attempt['id']}")
    ref = detail.get('experienceRef') or {}
    c.check('尝试详情带采用时的经验版本', st == 200 and ref.get('experienceId') == exp_ask['id'] and ref.get('adoptedVersion') == updated['experience']['revision'], ref)
    c.check('尝试详情保留采用时标题与理解', ref.get('adoptedTitle') == updated['experience']['title'] and bool(ref.get('adoptedUnderstanding')), ref)

    # 记录结果
    try_attempt = save_result(try_attempt, f'这次也有帮助，但需要二十分钟-{UID}', 'success')
    st, exp_detail = client.get(f"/api/experiences/{exp_ask['id']}")
    exp_now = exp_detail['experience']
    seen = next((a for a in exp_now['attempts'] if a['id'] == try_attempt['id']), None)
    c.check('经验详情能看到后续尝试与结果', st == 200 and seen is not None and seen['resultText'] == try_attempt['resultText'], seen)
    c.check('后续尝试保留采用时版本', seen is not None and seen['adoptedVersion'] == updated['experience']['revision'], seen and seen.get('adoptedVersion'))

    # 修订经验，补反例，不自动改写
    old_understanding = exp_now['understanding']
    st, revised = client.patch(
        f"/api/experiences/{exp_ask['id']}",
        {
            'title': exp_now['title'],
            'understanding': old_understanding + ' 但有一次仍刷了二十分钟，说明放远只降低了概率。',
            'conditions': exp_now['conditions'],
            'limitations': '两次结果不一致；一次十分钟内停下，一次仍用了二十分钟。',
            'sourceKeys': [s['sourceKey'] for s in exp_now['sources']],
            'revision': exp_now['revision'],
            'operationId': op('revise'),
        },
    )
    c.check('根据结果修订经验成功', st == 200, f'{st} {revised}')
    exp_revised = revised['experience']
    kept = next((a for a in exp_revised['attempts'] if a['id'] == try_attempt['id']), None)
    c.check('修订后旧尝试仍保留采用时理解与版本', kept is not None and kept['adoptedVersion'] == updated['experience']['revision'] and kept['adoptedUnderstanding'] == updated['experience']['understanding'], kept)
    c.check('新旧理解同时保留，系统未自动裁决', '二十分钟' in exp_revised['understanding'] and '十分钟' in exp_revised['understanding'], exp_revised['understanding'])
    st, ref_after = client.get(f"/api/attempts/{try_attempt['id']}")
    c.check('尝试详情提示经验已更新但保留当时版本', ref_after['experienceRef']['changed'] is True and ref_after['experienceRef']['currentVersion'] == exp_revised['revision'], ref_after.get('experienceRef'))

    # ---- 6. 来源更新提示 ----
    st, changed_attempt = client.patch(
        f"/api/attempts/{helpful['id']}",
        {
            'resultText': helpful_text + '（补充：中途醒了一次）',
            'outcome': 'success',
            'observedAt': helpful['observedAt'],
            'revision': helpful['revision'],
            'state': 'done',
        },
    )
    c.check('来源尝试可被修改', st == 200, f'{st} {changed_attempt}')
    st, with_change = client.get(f"/api/experiences/{exp_ask['id']}")
    changed_src = next((s for s in with_change['experience']['sources'] if s['id'] == helpful['id']), None)
    c.check('来源更新后详情提示建议核对', changed_src is not None and changed_src['changed'] is True and with_change['experience']['changedSourceCount'] == 1, changed_src)

    # 保存时刷新快照，changed 消失（设计选择，文档说明）
    st, refreshed = client.patch(
        f"/api/experiences/{exp_ask['id']}",
        {
            'title': with_change['experience']['title'],
            'understanding': with_change['experience']['understanding'],
            'conditions': with_change['experience']['conditions'],
            'limitations': with_change['experience']['limitations'],
            'sourceKeys': [s['sourceKey'] for s in with_change['experience']['sources']],
            'revision': with_change['experience']['revision'],
            'operationId': op('refresh-sources'),
        },
    )
    c.check('保存时刷新来源快照', st == 200 and refreshed['experience']['changedSourceCount'] == 0, refreshed['experience']['changedSourceCount'])

    # ---- 7. 来源删除：预览、清洗、待修订 ----
    st, preview = client.get(f"/api/attempts/{helpful['id']}/delete-preview")
    affected = preview.get('affectedExperiences', []) if isinstance(preview, dict) else []
    hit = next((x for x in affected if x['id'] == exp_ask['id']), None)
    c.check('删除来源预览列出受影响经验', st == 200 and hit is not None, f'{st} {preview}')
    c.check('用户撰写正文不会被自动清空（预览说明保留）', hit is not None and hit['willClearUnderstanding'] is False, hit)

    st, deleted = client.delete(f"/api/attempts/{helpful['id']}")
    c.check('删除来源尝试成功', st == 200, f'{st} {deleted}')
    st, after_del = client.get(f"/api/experiences/{exp_ask['id']}")
    exp_del = after_del['experience']
    src = next((s for s in exp_del['sources'] if s['id'] == helpful['id']), None)
    c.check('来源删除后列表显示已删除', src is not None and src['deleted'] is True and src['resultText'] is None and src['text'] == '', src)
    c.check('来源删除后经验标记待修订并说明正文保留', exp_del['needsRevision'] is True and bool(exp_del['revisionReason']) and exp_del['understanding'] != '', (exp_del['needsRevision'], exp_del['revisionReason']))
    c.check('来源删除后不泄露旧结果正文', helpful_text not in json.dumps(after_del, ensure_ascii=False), '泄露')
    st, leak_search = client.get(f'/api/search?q={helpful_text}')
    leak_payload = json.dumps(
        {k: v for k, v in leak_search.items() if k != 'query'}, ensure_ascii=False
    )
    c.check('顶级搜索不再返回被删来源正文', helpful_text not in leak_payload, leak_payload[:400])

    # ---- 8. 删除经验不删除来源，后续尝试保留结果 ----
    st, delprev = client.get(f"/api/experiences/{exp_ask['id']}/delete-preview")
    c.check('经验删除预览列出来源/尝试/链接', st == 200 and delprev['sourceCount'] >= 1 and delprev['attemptCount'] >= 1 and delprev['linkCount'] >= 1, delprev)
    st, delete_exp = client.delete(f"/api/captures/{exp_ask['id']}")
    c.check('删除经验成功', st == 200, f'{st} {delete_exp}')
    st, gone = client.get(f"/api/experiences/{exp_ask['id']}")
    c.check('删除后经验详情 404', st == 404, f'{st} {gone}')
    st, src_cap = client.get(f"/api/captures/{capture['id']}")
    c.check('删除经验不删除原始念头/来源', st == 200, f'{st} {src_cap}')
    st, try_after_del = client.get(f"/api/attempts/{try_attempt['id']}")
    c.check(
        '后续尝试及其结果保留，只清经验快照',
        st == 200
        and try_after_del['attempt']['resultText'] == try_attempt['resultText']
        and try_after_del['experienceRef']['deleted'] is True
        and try_after_del['experienceRef']['adoptedTitle'] == '来源经验已删除',
        try_after_del.get('experienceRef'),
    )

    # ---- 9b. 模型整理正文在来源被删时保守清空；无结果来源明确标记 ----
    cap_m = create_capture(f'模型整理来源删除测试-{UID}')
    att_m = create_attempt(cap_m['id'], f'模型来源尝试-{UID}', f'模型来源结果-{UID}', 'success', 'done')
    q_m = f'qm-{UID}'
    ans_m = {
        'summary': '测试',
        'points': [
            {'text': f'模型观点-{UID}', 'basis': 'observation', 'condition': None, 'sourceIds': [f'attempt:{att_m["id"]}']},
            {'text': f'仅有念头支撑的推断-{UID}', 'basis': 'inference', 'condition': None, 'sourceIds': [f'capture:{cap_m["id"]}']},
        ],
        'contradictions': [], 'missing': [], 'insufficientEvidence': False,
    }
    with db() as conn:
        conn.execute(
            """INSERT INTO record_queries
               (id, question, keywords, status, answer_json, sources_json, created_at, updated_at, finished_at)
               VALUES (?, ?, ?, 'succeeded', ?, '[]', ?, ?, ?)""",
            (q_m, '模型来源删除', '模型', json.dumps(ans_m, ensure_ascii=False), now, now, now),
        )
        conn.commit()
    st, model_exp = create_experience({
        'title': f'模型整理的经验-{UID}',
        'understanding': f'这是模型从记录整理的正文-{UID}',
        'conditions': '', 'limitations': '',
        'by': 'model', 'modelBasis': 'observation',
        'originKind': 'ask', 'originQueryId': q_m, 'originPointIndex': 0,
        'contextCaptureId': cap_m['id'],
        'sourceKeys': [f'attempt:{att_m["id"]}'],
        'operationId': op('exp-model-clear'),
    })
    c.check('模型整理经验保存成功', st == 201, f'{st} {model_exp}')
    st, infer_exp = create_experience({
        'title': f'只有念头的推断-{UID}',
        'understanding': f'只有念头，没有实际结果-{UID}',
        'by': 'model', 'modelBasis': 'inference',
        'originKind': 'ask', 'originQueryId': q_m, 'originPointIndex': 1,
        'contextCaptureId': cap_m['id'],
        'sourceKeys': [f'capture:{cap_m["id"]}'],
        'operationId': op('exp-inference'),
    })
    c.check('只有念头来源可保存但明确无实践结果', st == 201 and infer_exp['experience']['hasPracticeResult'] is False, infer_exp)

    st, _ = client.delete(f"/api/attempts/{att_m['id']}")
    st, cleared = client.get(f"/api/experiences/{model_exp['experience']['id']}")
    cleared_exp = cleared.get('experience', {})
    c.check(
        '模型整理正文在来源删除后保守清空并标记待修订',
        st == 200 and cleared_exp.get('understanding') == '' and cleared_exp['needsRevision'] is True,
        cleared_exp.get('revisionReason'),
    )
    c.check(
        '模型来源删除后正文快照不再泄露',
        f'模型来源结果-{UID}' not in json.dumps(cleared, ensure_ascii=False),
        '泄露',
    )

    # ---- 10. 导出 ----
    st, export = client.get('/api/export')
    c.check('导出返回 schemaVersion>=6（v0.6 经验/主题导出）', st == 200 and export.get('schemaVersion') in (6, 7), export.get('schemaVersion'))
    c.check('导出包含经验三表', st == 200 and all(k in export.get('data', {}) for k in ('experienceNotes', 'experienceSources', 'experienceAttempts')), list(export.get('data', {}).keys()))
    c.check('导出 captures 带 kind', st == 200 and any(row.get('kind') == 'experience' for row in export['data']['captures']), 'kind')

    # 归档/恢复
    st, a = client.post(f"/api/captures/{e2['id']}/archive", {})
    st, listed_arch = client.get('/api/experiences?archived=only')
    c.check('归档后仅归档列表可见', st == 200 and any(x['id'] == e2['id'] for x in listed_arch['experiences']), f'{st} {listed_arch}')
    st, r = client.post(f"/api/captures/{e2['id']}/restore", {})
    st, listed_active = client.get('/api/experiences')
    c.check('恢复后回到默认列表', st == 200 and any(x['id'] == e2['id'] for x in listed_active['experiences']), f'{st} {listed_active}')

    return c.report('经验笔记 API 验收')


if __name__ == '__main__':
    ok = main()
    sys.exit(0 if ok else 1)
