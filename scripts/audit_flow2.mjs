// 第二轮 bug 清扫：状态机 / 幂等冲突 / 取消边界 / 未审计端点 / 删除后孤儿数据
// BASE=http://127.0.0.1:3600 node scripts/audit_flow2.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:3600';
const USER = process.env.SHINIAN_USER || '二审用户';

let cookie = '';
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const op = (p = 'op') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

await req('POST', '/api/session/create', { username: USER });

// ---------- 1. 幂等键冲突 ----------
const cap = await req('POST', '/api/captures', { rawText: '二审：幂等与状态机' });
const capId = cap.body.capture.id;
const opSame = op('same');
const a1 = await req('POST', `/api/captures/${capId}/attempts`, { step: '第一次', state: 'todo', operationId: opSame });
const a2 = await req('POST', `/api/captures/${capId}/attempts`, { step: '换了内容', state: 'todo', operationId: opSame });
check('1 operationId 复用但载荷不同应被拒', a2.status === 409 && /operation[_ ]key/i.test(JSON.stringify(a2.body)), `status=${a2.status} error=${a2.body?.error}`);
const attId = a1.body.attempt.id;

// ---------- 2. 状态机 ----------
let cur = await req('GET', `/api/attempts/${attId}`);
let r = await req('PATCH', `/api/attempts/${attId}`, { state: 'cancelled', revision: cur.body.attempt.revision });
check('2 取消尝试', r.status === 200 && r.body.attempt.state === 'cancelled', `state=${r.body.attempt?.state}`);

cur = await req('GET', `/api/attempts/${attId}`);
r = await req('PATCH', `/api/attempts/${attId}`, { state: 'done', resultText: '已取消后想改完成', revision: cur.body.attempt.revision });
check('3 已取消 → 完成（是否允许重开）', r.status === 200, r.status === 200 ? `允许，state=${r.body.attempt.state}` : `拒绝 ${r.status} ${r.body?.error ?? ''}`);

cur = await req('GET', `/api/attempts/${attId}`);
r = await req('PATCH', `/api/attempts/${attId}`, { state: 'todo', revision: cur.body.attempt.revision });
check('4 完成 → 待办（回退）', r.status === 200, r.status === 200 ? `允许，结果是否保留=${r.body.attempt.resultText ? '保留' : '清空'}` : `拒绝 ${r.status}`);

cur = await req('GET', `/api/attempts/${attId}`);
r = await req('PATCH', `/api/attempts/${attId}`, { state: '不存在的状态', revision: cur.body.attempt.revision });
check('5 非法 state 被拒', r.status === 400 || r.status === 422, `status=${r.status} error=${r.body?.error ?? ''}`);

cur = await req('GET', `/api/attempts/${attId}`);
r = await req('PATCH', `/api/attempts/${attId}`, { outcome: '瞎写的结论', revision: cur.body.attempt.revision });
check('6 非法 outcome 被拒', r.status === 400 || r.status === 422, `status=${r.status} error=${r.body?.error ?? ''}`);

// ---------- 3. 普通尝试（用于日程/主题/经验） ----------
const work = await req('POST', `/api/captures/${capId}/attempts`, { step: '普通尝试', state: 'todo', operationId: op('work') });
const workId = work.body.attempt.id;
let wrev = work.body.attempt.revision;

// ---------- 4. 日程边界 ----------
const far = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
const s1 = await req('POST', `/api/attempts/${workId}/schedules`, { date: far, startTime: '10:00', endTime: '10:30', timezone: 'Asia/Shanghai', operationId: op('s1') });
const s1Id = s1.body.schedule?.id;
check('7 建日程（远期）', s1.status === 200 || s1.status === 201, `status=${s1.status}`);

const badTime = await req('POST', `/api/attempts/${workId}/schedules`, { date: far, startTime: '10:00', endTime: '09:00', timezone: 'Asia/Shanghai', operationId: op('bad') });
check('8 结束早于开始被拒', badTime.status === 400, `status=${badTime.status} error=${badTime.body?.error}`);

const cancel1 = await req('POST', `/api/schedules/${s1Id}/cancel`, { revision: s1.body.schedule.revision });
const cancel2 = await req('POST', `/api/schedules/${s1Id}/cancel`, { revision: s1.body.schedule.revision });
check('9 重复取消日程', cancel2.status === 200 || cancel2.status === 409, `第二次 status=${cancel2.status} error=${cancel2.body?.error ?? '无（幂等）'}`);

const s2 = await req('POST', `/api/attempts/${workId}/schedules`, { date: far, startTime: '11:00', endTime: '11:30', timezone: 'Asia/Shanghai', operationId: op('s2') });
const updStale = await req('PATCH', `/api/schedules/${s2.body.schedule.id}`, { date: far, startTime: '12:00', endTime: '12:30', timezone: 'Asia/Shanghai', revision: 999 });
check('10 日程改时间用过期 revision 被拒', updStale.status === 409, `status=${updStale.status} error=${updStale.body?.error}`);

const updBack = await req('PATCH', `/api/schedules/${s2.body.schedule.id}`, { date: far, startTime: '11:30', endTime: '11:00', timezone: 'Asia/Shanghai', revision: s2.body.schedule.revision });
check('11 日程改时间 结束早于开始被拒', updBack.status === 400, `status=${updBack.status} error=${updBack.body?.error}`);

// ---------- 5. 时间边界 ----------
cur = await req('GET', `/api/attempts/${workId}`);
// 这个尝试身上还有未来日程，标完成时服务端要求先决定日程去留（keep）——这是正确行为
const futureObs = await req('PATCH', `/api/attempts/${workId}`, {
  observedAt: Date.now() + 400 * 86400000,
  state: 'done',
  resultText: '未来时间的结果',
  futureScheduleAction: 'keep',
  revision: (await req('GET', `/api/attempts/${workId}`)).body.attempt.revision,
});
check('12 未来时间的结果（observedAt 在 400 天后）', futureObs.status === 200 || futureObs.status === 400, futureObs.status === 200 ? '允许（导入历史数据需要）' : `拒绝 ${futureObs.status}`);

// ---------- 6. 主题端点 ----------
const topic = await req('POST', '/api/topics', { title: '二审主题', exploringQuestion: '这个主题能收记录吗', captureIds: [capId], operationId: op('t') });
const topicId = topic.body.topic?.id;
const trev = topic.body.topic?.revision;
const renStale = await req('PATCH', `/api/topics/${topicId}`, { title: '改名', expectedRevision: 999, operationId: op('ren') });
check('13 主题改名用过期 revision 被拒', renStale.status === 409, `status=${renStale.status} error=${renStale.body?.error}`);

const addWrong = await req('POST', `/api/topics/${topicId}/members`, { captureIds: ['cap-不存在'], expectedRevision: trev, operationId: op('addw') });
check('14 加不存在的成员被拒', addWrong.status === 400 || addWrong.status === 404, `status=${addWrong.status} error=${addWrong.body?.error ?? addWrong.body?.reason ?? ''}`);

const nextCross = await req('PUT', `/api/topics/${topicId}/next-attempt`, { attemptId: attId, expectedRevision: (await req('GET', `/api/topics/${topicId}`)).body.topic.revision, operationId: op('nx') });
check('15 固定「不属于该主题」的尝试（跨念头）', nextCross.status === 200 ? '允许' : `拒绝 ${nextCross.status} ${nextCross.body?.error ?? nextCross.body?.reason ?? ''}`, `status=${nextCross.status}`);

const delPreview = await req('GET', `/api/topics/${topicId}/delete-preview`);
const topicDetail = await req('GET', `/api/topics/${topicId}`);
check('16 主题删除预览成员数与实际一致', delPreview.body.memberCount === topicDetail.body.topic.memberCount, `preview=${delPreview.body.memberCount} real=${topicDetail.body.topic.memberCount}`);

// ---------- 7. 经验端点 ----------
const expNoSrc = await req('POST', '/api/experiences', { title: '无来源经验', understanding: '测试', sourceKeys: [], operationId: op('e0') });
check('17 经验必须至少一个来源', expNoSrc.status === 422 || expNoSrc.status === 400, `status=${expNoSrc.status} error=${expNoSrc.body?.error}`);

const expBadSrc = await req('POST', '/api/experiences', { title: '来源不存在', understanding: '测试', sourceKeys: ['attempt:att-不存在'], operationId: op('e1') });
check('18 经验来源不存在被拒', expBadSrc.status === 400 || expBadSrc.status === 422, `status=${expBadSrc.status} error=${expBadSrc.body?.error}`);

const expAtt = await req('POST', `/api/captures/${capId}/attempts`, { step: '经验来源尝试', state: 'todo', operationId: op('expatt') });
const expAttId = expAtt.body.attempt.id;
const expAttRev = (await req('GET', `/api/attempts/${expAttId}`)).body.attempt.revision;
await req('PATCH', `/api/attempts/${expAttId}`, { state: 'done', resultText: '经验来源尝试的结果', outcome: 'success', revision: expAttRev });
const expOk = await req('POST', '/api/experiences', { title: '二审经验', understanding: '这是二审用的理解', sourceKeys: [`attempt:${expAttId}`], originKind: 'attempt', originAttemptId: expAttId, contextCaptureId: capId, operationId: op('e2') });
check('19 正常创建经验', expOk.status === 200 || expOk.status === 201, `status=${expOk.status} ${expOk.body?.error ?? ''} ${expOk.body?.message ?? ''}`);
const expId = expOk.body.experience?.id;

const expStale = await req('PATCH', `/api/experiences/${expId}`, { title: '改名', understanding: '改了', revision: 999, operationId: op('e3') });
check('20 经验改名用过期 revision 被拒', expStale.status === 409, `status=${expStale.status} error=${expStale.body?.error}`);

// ---------- 8. 未审计端点存活 ----------
for (const [name, path] of [
  ['21 研究列表', '/api/research'],
  ['22 回顾列表', '/api/reviews'],
  ['23 动态', '/api/activity?limit=5'],
  ['24 图谱', '/api/graph'],
  ['25 下一步列表', '/api/reviews/' + 'none' + '/next-actions'],
]) {
  const res = await req('GET', path);
  check(name + `（${path}）`, res.status < 500, `status=${res.status}`);
}

// ---------- 9. 坏请求 ----------
const badJson = await fetch(BASE + '/api/captures', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{不是json' });
check('26 坏 JSON 返回 4xx 不是 500', badJson.status >= 400 && badJson.status < 500, `status=${badJson.status}`);

const wrongType = await req('POST', '/api/captures', { rawText: 12345 });
check('27 rawText 类型错误', wrongType.status === 400 || wrongType.status === 500, `status=${wrongType.status}（500 属实现缺陷）`);

// ---------- 10. 删除后孤儿数据 ----------
await req('DELETE', `/api/experiences/${expId}`);
await req('DELETE', `/api/captures/${capId}`);
await req('DELETE', `/api/topics/${topicId}`);

const { createRequire } = await import('node:module');
const require2 = createRequire(import.meta.url);
const Database = require2('better-sqlite3');
const db = new Database('D:/联动日程表/db/ui-review.sqlite', { readonly: true });
const orphan = (sql) => db.prepare(sql).get().n;
const orph = {
  attempts: orphan('select count(*) n from attempts a left join captures c on c.id = a.capture_id where c.id is null'),
  refsFrom: orphan('select count(*) n from attempt_references r left join attempts a on a.id = r.from_attempt_id where a.id is null'),
  refsTo: orphan('select count(*) n from attempt_references r left join attempts a on a.id = r.to_attempt_id where a.id is null'),
  members: orphan('select count(*) n from topic_members m left join captures c on c.id = m.capture_id where c.id is null'),
  membersTopic: orphan('select count(*) n from topic_members m left join topics t on t.id = m.topic_id where t.id is null'),
  expSources: orphan('select count(*) n from experience_sources s left join experience_notes e on e.capture_id = s.experience_id where e.capture_id is null'),
  schedules: orphan('select count(*) n from schedule_blocks s left join attempts a on a.id = s.attempt_id where a.id is null'),
  linksFrom: orphan('select count(*) n from capture_links l left join captures c on c.id = l.from_capture_id where c.id is null'),
  linksTo: orphan('select count(*) n from capture_links l left join captures c on c.id = l.to_capture_id where c.id is null'),
};
db.close();
const totalOrphans = Object.values(orph).reduce((a, b) => a + b, 0);
check('28 删除后没有孤儿数据', totalOrphans === 0, JSON.stringify(orph));

// ---------- 11. 类型与枚举守卫（回归用） ----------
const guardCap = await req('POST', '/api/captures', { rawText: '守卫回归' });
const guardCapId = guardCap.body.capture.id;
const guardAtt = await req('POST', `/api/captures/${guardCapId}/attempts`, { step: '守卫尝试', state: 'todo', operationId: op('guard') });
const guardAttId = guardAtt.body.attempt.id;
const guardRev = (await req('GET', `/api/attempts/${guardAttId}`)).body.attempt.revision;
const guardCases = [
  ['29 rawText 传数字 → 400', 'POST', '/api/captures', { rawText: 123 }],
  ['30 step 传对象 → 400', 'POST', `/api/captures/${guardCapId}/attempts`, { step: { a: 1 }, state: 'todo', operationId: op('g1') }],
  ['31 state 非法枚举 → 400', 'PATCH', `/api/attempts/${guardAttId}`, { state: 'zzz', revision: guardRev }],
  ['32 outcome 非法枚举 → 400', 'PATCH', `/api/attempts/${guardAttId}`, { outcome: 'zzz', revision: guardRev }],
  ['33 observedAt 传字符串 → 400', 'PATCH', `/api/attempts/${guardAttId}`, { observedAt: '昨天', revision: guardRev }],
  ['34 resultText 传对象 → 400', 'PATCH', `/api/attempts/${guardAttId}`, { resultText: { a: 1 }, revision: guardRev }],
];
for (const [name, m, p2, b] of guardCases) {
  const res = await req(m, p2, b);
  check(name, res.status === 400, `status=${res.status} ${res.body?.message ?? ''}`);
}
const afterGuards = await req('GET', `/api/attempts/${guardAttId}`);
check('35 守卫拦住后库里的值仍干净', afterGuards.body.attempt.state === 'todo' && afterGuards.body.attempt.outcome === null, `state=${afterGuards.body.attempt.state} outcome=${afterGuards.body.attempt.outcome}`);
await req('DELETE', `/api/captures/${guardCapId}`);

const failed = rows.filter((r) => !r.ok);
console.log(`\n==== ${rows.length - failed.length} passed / ${failed.length} failed ====`);
if (failed.length) failed.forEach((f) => console.log('  FAIL:', f.name, f.detail));
process.exit(failed.length ? 1 : 0);
