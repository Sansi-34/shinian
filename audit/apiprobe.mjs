// 代码逻辑与接口边界体检：拿真实服务当对象，逐条打边界
const BASE = 'http://127.0.0.1:3111';
let cookie = '';
const out = [];
const p = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
const j = (x) => JSON.stringify(x).slice(0, 300);

// ---------- 0. 未登录访问 ----------
cookie = '';
const anon = await req('GET', '/api/captures');
p(`[鉴权] 未登录 GET /api/captures → ${anon.status} ${j(anon.body)}`);
await req('POST', '/api/session/create', { username: '质检员' });
p(`[鉴权] 登录后 cookie 长度 ${cookie.length}`);

// ---------- 1. LIKE 通配符 ----------
const mk = async (t) => (await req('POST', '/api/captures', { rawText: t })).body.capture;
const cA = await mk('质检样本：铝合金支架 A');
await mk('质检样本：塑料支架 B');
const sPercent = await req('GET', '/api/search?q=' + encodeURIComponent('%'));
const sUnder = await req('GET', '/api/search?q=' + encodeURIComponent('_'));
const sQuote = await req('GET', '/api/search?q=' + encodeURIComponent("' OR 1=1--"));
p(`[检索] q="%" → ${sPercent.status} 命中 captures=${sPercent.body?.captures?.length} attempts=${sPercent.body?.attempts?.length}`);
p(`[检索] q="_" → ${sUnder.status} 命中 captures=${sUnder.body?.captures?.length}`);
p(`[检索] q="' OR 1=1--" → ${sQuote.status} 命中 captures=${sQuote.body?.captures?.length}`);
const all = await req('GET', '/api/captures');
p(`[对照] 当前念头总数 ${all.body.captures.length}`);

// ---------- 2. 正文长度边界 ----------
const exact = 'x'.repeat(4000);
const over = 'x'.repeat(4001);
const r1 = await req('POST', '/api/captures', { rawText: exact });
const r2 = await req('POST', '/api/captures', { rawText: over });
const r3 = await req('POST', '/api/captures', { rawText: '   ' });
const r4 = await req('POST', '/api/captures', {});
p(`[长度] 4000 → ${r1.status}；4001 → ${r2.status} ${j(r2.body)}；空白 → ${r3.status}；缺字段 → ${r4.status}`);

// ---------- 3. 尝试状态机 ----------
const att = (await req('POST', `/api/captures/${cA.id}/attempts`, { step: '质检：试一下', state: 'todo', operationId: 'qa-op-1' })).body.attempt;
p(`[幂等] 同一 operationId 再建一次 → status=${(await req('POST', `/api/captures/${cA.id}/attempts`, { step: '质检：试一下', state: 'todo', operationId: 'qa-op-1' })).status}（应复用同一条 id=${att.id}）`);
const dupDiff = await req('POST', `/api/captures/${cA.id}/attempts`, { step: '质检：换了内容但复用同一 operationId', state: 'todo', operationId: 'qa-op-1' });
p(`[幂等冲突] 同 operationId 不同内容 → ${dupDiff.status} ${j(dupDiff.body)}`);

const cur = (await req('GET', `/api/attempts/${att.id}`)).body.attempt;
p(`[尝试] 初始 revision=${cur.revision} state=${cur.state} outcome=${cur.outcome}`);
const badOutcome = await req('PATCH', `/api/attempts/${att.id}`, { state: 'todo', outcome: 'success', revision: cur.revision });
p(`[状态机] todo + outcome=success → ${badOutcome.status} ${j(badOutcome.body)}`);
const stale = await req('PATCH', `/api/attempts/${att.id}`, { state: 'in_progress', revision: cur.revision + 99 });
p(`[CAS] 旧 revision 写入 → ${stale.status} ${j(stale.body)}`);
const noRevision = await req('PATCH', `/api/attempts/${att.id}`, { state: 'in_progress' });
p(`[CAS] 不带 revision 写入 → ${noRevision.status} ${j(noRevision.body)}`);
const doneNoResult = await req('PATCH', `/api/attempts/${att.id}`, { state: 'done', outcome: 'success', revision: cur.revision });
p(`[状态机] done 但无结果文本 → ${doneNoResult.status} ${j(doneNoResult.body)}`);

// ---------- 4. 日程边界 ----------
const mkSched = (b) => req('POST', `/api/attempts/${att.id}/schedules`, { timezone: 'Asia/Shanghai', operationId: 'qa-sch-' + Math.random(), ...b });
const s1 = await mkSched({ date: '2026-12-01', startTime: '22:00', endTime: '09:30' });
p(`[日程] 跨日 22:00→09:30 → ${s1.status} ${j(s1.body)}`);
const s2 = await mkSched({ date: '2026-12-02', startTime: '10:00', endTime: '10:00' });
p(`[日程] 零时长 10:00→10:00 → ${s2.status} ${j(s2.body)}`);
const s3 = await mkSched({ date: '2026-12-03', startTime: '09:00', endTime: '08:00' });
p(`[日程] 结束早于开始 → ${s3.status} ${j(s3.body)}`);
const s4 = await mkSched({ date: '2026-12-04', startTime: '25:99', endTime: '10:00' });
p(`[日程] 非法时间 25:99 → ${s4.status} ${j(s4.body)}`);
const s5 = await mkSched({ date: '2026-02-30', startTime: '10:00', endTime: '11:00' });
p(`[日程] 不存在的日期 2026-02-30 → ${s5.status} ${j(s5.body)}`);
const s6 = await mkSched({ date: '2026-12-05', startTime: '10:00', endTime: '11:00' });
p(`[日程] 正常创建 → ${s6.status}`);
const s6b = await mkSched({ date: '2026-12-05', startTime: '10:30', endTime: '11:30' });
p(`[日程] 重叠但无 confirmOverlap → ${s6b.status} ${j(s6b.body)}`);
const range = await req('GET', `/api/schedules?from=2026-01-01&to=2026-12-31&timezone=Asia%2FShanghai`);
p(`[日程查询] 364 天范围 → ${range.status} ${j(range.body).slice(0, 120)}`);
const badTz = await req('GET', `/api/schedules?from=2026-12-01&to=2026-12-02&timezone=Mars%2FOlympus`);
p(`[日程查询] 非法时区 → ${badTz.status} ${j(badTz.body)}`);

// ---------- 5. 回顾范围 ----------
const rv = await req('POST', '/api/reviews', { fromDate: '2025-01-01', toDate: '2026-12-31', timezone: 'Asia/Shanghai' });
p(`[回顾] 730 天范围 → ${rv.status} ${j(rv.body)}`);

// ---------- 6. 问记录长度 ----------
const ask = await req('POST', '/api/ask/queries', { question: 'x'.repeat(501), timezone: 'Asia/Shanghai' });
p(`[问记录] 501 字问题 → ${ask.status} ${j(ask.body)}`);

// ---------- 7. 主题 / 经验 边界 ----------
const tp = await req('POST', '/api/topics', { name: '质检主题', operationId: 'qa-topic-1' });
p(`[主题] 创建 → ${tp.status} ${j(tp.body)}`);
const tpEmpty = await req('POST', '/api/topics', { name: '   ', operationId: 'qa-topic-2' });
p(`[主题] 空名称 → ${tpEmpty.status} ${j(tpEmpty.body)}`);
const tpDup = await req('POST', '/api/topics', { name: '质检主题', operationId: 'qa-topic-1' });
p(`[主题] 幂等重放 → ${tpDup.status}`);

const expNoSrc = await req('POST', '/api/experiences', { title: '质检经验', body: '正文', operationId: 'qa-exp-1', sources: [] });
p(`[经验] 无来源 → ${expNoSrc.status} ${j(expNoSrc.body)}`);

// ---------- 8. 导出 ----------
const exp = await req('GET', '/api/export');
p(`[导出] status=${exp.status} schemaVersion=${exp.body?.schemaVersion} keys=${exp.status === 200 ? Object.keys(exp.body).join(',') : '-'}`);

// ---------- 9. 图谱 ----------
const g = await req('GET', '/api/graph');
p(`[图谱] status=${g.status} nodes=${g.body?.nodes?.length} edges=${g.body?.edges?.length} truncated=${g.body?.truncated}`);
const gBig = await req('GET', '/api/graph?limit=100000');
p(`[图谱] limit=100000 → ${gBig.status} nodes=${gBig.body?.nodes?.length}`);

// ---------- 10. 删除级联 ----------
const delPrev = await req('GET', `/api/captures/${cA.id}/delete-preview`);
p(`[删除预览] ${delPrev.status} ${j(delPrev.body)}`);
const delNoRev = await req('DELETE', `/api/captures/${cA.id}`);
p(`[删除] 无 revision → ${delNoRev.status} ${j(delNoRev.body)}`);

require = null;
const fs = await import('node:fs');
fs.writeFileSync('D:/联动日程表/audit/api-probe.log.txt', out.join('\n'), 'utf8');
