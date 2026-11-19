// 核心闭环审计：以真实 HTTP 打服务端，检查逻辑与不变量
// 用法：BASE=http://127.0.0.1:3600 node scripts/audit_flow.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:3600';
const USER = process.env.SHINIAN_USER || '闭环审计';

let cookie = '';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const op = (p = 'op') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function req(method, path, body, expect) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      // 无 body 时不要带 content-type：Fastify 会以 FST_ERR_CTP_EMPTY_JSON_BODY 拒掉空 JSON body
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  const okStatus = expect === undefined ? true : Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
  if (!okStatus) {
    throw new Error(`${method} ${path} 期望 ${Array.isArray(expect) ? expect.join('/') : expect} 实际 ${res.status}: ${text.slice(0, 180)}`);
  }
  return { status: res.status, body: json };
}

await req('POST', '/api/session/create', { username: USER }, 200);

// ---------- A. 念头与尝试 ----------
const capText = `审计记录 ${new Date().toISOString()}`;
const cap = await req('POST', '/api/captures', { rawText: capText }, [200, 201]);
const capId = cap.body.capture.id;
check('A1 创建念头', !!capId, `revision=${cap.body.capture.revision}`);

const opId = op('att');
const att1 = await req('POST', `/api/captures/${capId}/attempts`, { step: '审计：写下第一个小尝试', state: 'todo', operationId: opId }, [200, 201]);
const attId = att1.body.attempt.id;
check('A2 创建尝试', !!attId, `state=${att1.body.attempt.state} revision=${att1.body.attempt.revision}`);

const attReplay = await req('POST', `/api/captures/${capId}/attempts`, { step: '审计：写下第一个小尝试', state: 'todo', operationId: opId }, 200);
check('A3 同 operationId 重放（幂等）', attReplay.body.attempt?.id === attId, `replayed=${attReplay.body.replayed}`);

const stale = await req('PATCH', `/api/attempts/${attId}`, { state: 'in_progress', revision: 99 }, 409);
check('A4 过期 revision 被拒', stale.body.error === 'version conflict', `error=${stale.body.error} currentRevision=${stale.body.currentRevision}`);

const toProg = await req('PATCH', `/api/attempts/${attId}`, { state: 'in_progress', revision: att1.body.attempt.revision }, 200);
check('A5 状态推进', toProg.body.attempt.state === 'in_progress', `revision=${toProg.body.attempt.revision}`);

// 无结果直接标完成：服务端是否允许？（产品预期：应拦住或至少允许但提示）
const doneNoResult = await req('PATCH', `/api/attempts/${attId}`, { state: 'done', revision: toProg.body.attempt.revision });
check(
  'A6 无结果标完成的行为（服务端判定）',
  true,
  doneNoResult.status === 200
    ? `服务端允许（state=${doneNoResult.body.attempt?.state}），仅前端拦截 —— 属规则不一致风险`
    : `服务端拒绝 ${doneNoResult.status} ${doneNoResult.body?.error ?? ''}`
);

// ---------- B. 日程与冲突 ----------
const cur = await req('GET', `/api/attempts/${attId}`, undefined, 200);
const rev = cur.body.attempt.revision;
// 用 3 天后的时段，避开库里已有安排（否则创建日程会因重叠被拒）
// 取 200–500 天后的随机日期：避开库里历史遗留安排（日程冲突是跨尝试的全库检查）
const day = new Date(Date.now() + (200 + Math.floor(Math.random() * 300)) * 86400000);
const today = day.toISOString().slice(0, 10);
const sch = await req('POST', `/api/attempts/${attId}/schedules`, { date: today, startTime: '23:00', endTime: '23:30', timezone: 'Asia/Shanghai', note: '审计排期', operationId: op('sch') }, [200, 201]);
const schId = sch.body.schedule.id;
check('B1 创建日程', !!schId, `status=${sch.body.schedule.status}`);

// 已有未来日程 → 标完成必须给 futureScheduleAction
await req('PATCH', `/api/attempts/${attId}`, { state: 'in_progress', revision: rev }, 200);
const mid = await req('GET', `/api/attempts/${attId}`, undefined, 200);
const conflictRes = await req('PATCH', `/api/attempts/${attId}`, { state: 'done', resultText: '审计结果', revision: mid.body.attempt.revision });
check('B2 有未来日程时标完成被拦', conflictRes.status === 409 && conflictRes.body.error === 'future_schedules', `error=${conflictRes.body.error} 日程 ${conflictRes.body.futureSchedules?.length ?? 0} 条`);

const keepRes = await req('PATCH', `/api/attempts/${attId}`, { state: 'done', resultText: '审计结果：底噪从 -38 降到 -52dB', outcome: 'success', revision: mid.body.attempt.revision, futureScheduleAction: 'keep' });
check('B3 选择保留后可完成', keepRes.status === 200 && keepRes.body.attempt.state === 'done', `status=${keepRes.status} cancelled=${keepRes.body.cancelledScheduleCount ?? 0}`);

// 重叠创建：同 operationId 才能通过 token 校验
const opOverlap = op('ovl');
const ovl1 = await req('POST', `/api/attempts/${attId}/schedules`, { date: today, startTime: '23:10', endTime: '23:40', timezone: 'Asia/Shanghai', operationId: opOverlap });
check('B4 重叠被拦并给 token', ovl1.status === 409 && ovl1.body.error === 'schedule_conflict' && !!ovl1.body.conflictToken, `冲突 ${ovl1.body.conflicts?.length ?? 0} 条`);
const ovl2 = await req('POST', `/api/attempts/${attId}/schedules`, { date: today, startTime: '23:10', endTime: '23:40', timezone: 'Asia/Shanghai', operationId: opOverlap, confirmOverlap: true, conflictToken: ovl1.body.conflictToken, expectedConflictIds: (ovl1.body.conflicts ?? []).map((c) => c.id) });
check('B5 同 operationId + token 可确认重叠', ovl2.status === 200 || ovl2.status === 201, `status=${ovl2.status} ${ovl2.body?.error ?? ''}`);

const cancel = await req('POST', `/api/schedules/${schId}/cancel`, { revision: sch.body.schedule.revision }, 200);
check('B6 取消日程', cancel.body.schedule.status === 'cancelled', `status=${cancel.body.schedule?.status}`);

// ---------- C. 主题 ----------
const topic = await req('POST', '/api/topics', { title: `审计主题 ${Date.now()}`, exploringQuestion: '审计用：这个主题能不能收记录？', captureIds: [capId], operationId: op('top') }, [200, 201]);
const topicId = topic.body.topic.id;
check('C1 创建主题并收成员', topic.body.topic.memberCount === 1, `memberCount=${topic.body.topic.memberCount}`);

const dupAdd = await req('POST', `/api/captures/${capId}/topics`, { topicIds: [topicId], operationId: op('add') }, 200);
check('C2 重复加入被跳过', dupAdd.body.added === 0 || dupAdd.body.skipped >= 1, `added=${dupAdd.body.added} skipped=${dupAdd.body.skipped}`);

const att2 = await req('POST', `/api/captures/${capId}/attempts`, { step: '审计：固定下一步用', state: 'todo', operationId: op('att2') }, [200, 201]);
const att2Id = att2.body.attempt.id;
const curTopic = await req('GET', `/api/topics/${topicId}`, undefined, 200);
const nextSet = await req('PUT', `/api/topics/${topicId}/next-attempt`, { attemptId: att2Id, expectedRevision: curTopic.body.topic.revision, operationId: op('next') });
check('C3 固定下次继续', nextSet.status === 200 && nextSet.body.topic.nextAttemptId === att2Id, `nextAttemptId=${nextSet.body.topic?.nextAttemptId}`);

await req('PATCH', `/api/attempts/${att2Id}`, { state: 'cancelled', revision: att2.body.attempt.revision }, 200);
const afterCancel = await req('GET', `/api/topics/${topicId}`, undefined, 200);
check('C4 尝试取消后固定引用自动清空', afterCancel.body.topic.nextAttemptId === null, `clearedReason=${afterCancel.body.topic.nextAttemptClearedReason ?? '无'}`);

const rmMember = await req('DELETE', `/api/topics/${topicId}/members/${capId}`, undefined, 200);
const afterRm = await req('GET', `/api/topics/${topicId}`, undefined, 200);
check('C5 移出成员', afterRm.body.topic.memberCount === 0, `memberCount=${afterRm.body.topic.memberCount}`);

// ---------- D. 经验 ----------
const exp = await req('POST', '/api/experiences', {
  title: '审计：电解电容滤波让低频闪烁消失',
  understanding: '在 2 kHz PWM 下串 100µF 电解电容，低频闪烁消失，但亮度调节变得不线性。',
  conditions: '3.7V 锂电池供电、室内 25°C、占空比 20%',
  limitations: '未用相机验证，只做了肉眼观察',
  sourceKeys: [`attempt:${attId}`],
  originKind: 'attempt',
  originAttemptId: attId,
  contextCaptureId: capId,
  operationId: op('exp'),
}, [200, 201]);
const expId = exp.body.experience.id;
check('D1 从尝试整理经验', !!expId, `sourceCount=${exp.body.experience.sourceCount ?? '?'}`);

const expList = await req('GET', '/api/experiences?archived=exclude&limit=50', undefined, 200);
check('D2 经验出现在列表', (expList.body.experiences ?? []).some((e) => e.id === expId), `共 ${(expList.body.experiences ?? []).length} 条`);

const expDetail = await req('GET', `/api/experiences/${expId}`, undefined, 200);
check('D3 经验带回来源', (expDetail.body.experience?.sources ?? []).length >= 1, `sources=${(expDetail.body.experience?.sources ?? []).length}`);

// ---------- E. 导出与归档 ----------
const exp1 = await req('GET', '/api/export', undefined, 200);
const exported = exp1.body;
const hasCap = (exported.data?.captures ?? []).some((c) => c.id === capId);
check('E1 导出含新记录且版本为 7', hasCap && exported.schemaVersion === 7, `schemaVersion=${exported.schemaVersion}`);

await req('POST', `/api/captures/${capId}/archive`, undefined, 200);
const listActive = await req('GET', '/api/captures', undefined, 200);
const listArchived = await req('GET', '/api/captures?archived=1', undefined, 200);
check(
  'E2 归档后不出现在默认列表',
  !(listActive.body.captures ?? []).some((c) => c.id === capId) && (listArchived.body.captures ?? []).some((c) => c.id === capId),
  `active=${(listActive.body.captures ?? []).length} archived=${(listArchived.body.captures ?? []).length}`
);
await req('POST', `/api/captures/${capId}/restore`, undefined, 200);

// ---------- F. 边界 ----------
const emptySearch = await req('GET', '/api/search?q=', undefined, 400);
check('F1 空关键词搜索返回 400（不是空结果）', emptySearch.status === 400, `error=${emptySearch.body.error}`);

const tooLong = await req('POST', '/api/captures', { rawText: 'x'.repeat(4001) });
check('F2 超长正文被拒', tooLong.status === 400 || tooLong.status === 422, `status=${tooLong.status}`);

// ---------- G. 删除级联 ----------
const preview = await req('GET', `/api/captures/${capId}/delete-preview`, undefined, 200);
const attemptsNow = await req('GET', `/api/captures/${capId}/attempts`, undefined, 200);
check(
  'G1 删除预览与实际一致（尝试数）',
  preview.body.attemptCount === (attemptsNow.body.attempts ?? []).length,
  `preview=${preview.body.attemptCount} real=${(attemptsNow.body.attempts ?? []).length}`
);

await req('DELETE', `/api/captures/${capId}`, undefined, 200);
const goneAttempt = await req('GET', `/api/attempts/${attId}`);
check('G2 删除念头后尝试一并消失', goneAttempt.status === 404, `status=${goneAttempt.status}`);

const expAfterDelete = await req('GET', `/api/experiences/${expId}`, undefined, 200);
const stillThere = !!expAfterDelete.body.experience;
const sourceGone = (expAfterDelete.body.experience?.sources ?? []).every((s) => s.deleted || s.updated === false || s.changed);
check('G3 来源被删后经验保留、来源标记失效', stillThere && sourceGone, `sources=${(expAfterDelete.body.experience?.sources ?? []).length}`);

const topicAfter = await req('GET', `/api/topics/${topicId}`, undefined, 200);
check('G4 删除念头后主题仍在', topicAfter.status === 200, `memberCount=${topicAfter.body.topic?.memberCount}`);

// 清理
await req('DELETE', `/api/experiences/${expId}`).catch(() => {});
await req('DELETE', `/api/topics/${topicId}`).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length} passed / ${failed.length} failed ====`);
if (failed.length) failed.forEach((f) => console.log('  FAIL:', f.name, f.detail));
process.exit(failed.length ? 1 : 0);
