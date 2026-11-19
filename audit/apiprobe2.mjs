// 第二次接口体检：枚举校验缺失、统计口径、重叠 token、主题下一步
const BASE = 'http://127.0.0.1:3111';
let cookie = '';
const out = [];
const p = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const sh = (x, n = 220) => JSON.stringify(x).slice(0, n);

await req('POST', '/api/session/create', { username: '质检员' });

// ---------- A. 枚举校验 ----------
const cap = (await req('POST', '/api/captures', { rawText: '枚举校验样本：尝试状态机' })).body.capture;
const a1 = await req('POST', `/api/captures/${cap.id}/attempts`, { step: '非法 state', state: 'banana', operationId: 'qa-enum-1' });
p(`[创建] state='banana' → ${a1.status} state=${a1.body?.attempt?.state}`);
const id1 = a1.body?.attempt?.id;
const a2 = await req('PATCH', `/api/attempts/${id1}`, { outcome: 'banana', revision: 1 });
p(`[更新] outcome='banana' → ${a2.status} outcome=${a2.body?.attempt?.outcome}`);
const a3 = await req('PATCH', `/api/attempts/${id1}`, { state: 'done', revision: a2.body?.attempt?.revision });
p(`[更新] state=done 且无 resultText → ${a3.status} state=${a3.body?.attempt?.state} resultText=${a3.body?.attempt?.resultText} outcome=${a3.body?.attempt?.outcome}`);

// 结论污染：state != done 却带 outcome，且带 resultText
const cap2 = (await req('POST', '/api/captures', { rawText: '口径样本：未完成但写了结果' })).body.capture;
const b1 = await req('POST', `/api/captures/${cap2.id}/attempts`, { step: '口径样本尝试', state: 'todo', resultText: '我写了结果但状态还是未开始', outcome: 'success', operationId: 'qa-num-1' });
p(`[口径] 创建时 state=todo + resultText + outcome=success → ${b1.status} ${sh(b1.body?.attempt)}`);

// ---------- B. 列表检索通配符 ----------
const lp = await req('GET', '/api/captures?q=' + encodeURIComponent('%'));
const lp2 = await req('GET', '/api/captures?q=' + encodeURIComponent('支架'));
p(`[列表检索] q=% → ${lp.status} 返回 ${lp.body?.captures?.length} 条；q=支架 → ${lp2.status} 返回 ${lp2.body?.captures?.length} 条`);

// ---------- C. 重叠确认 token ----------
const base = { timezone: 'Asia/Shanghai' };
const s1 = await req('POST', `/api/attempts/${id1}/schedules`, { ...base, date: '2026-12-10', startTime: '10:00', endTime: '11:00', operationId: 'qa-c-1' });
const clash = await req('POST', `/api/attempts/${id1}/schedules`, { ...base, date: '2026-12-10', startTime: '10:30', endTime: '11:30', operationId: 'qa-c-2' });
p(`[重叠] 二次创建 → ${clash.status} error=${clash.body?.error} token=${(clash.body?.conflictToken || '').slice(0, 12)}…`);
const badToken = await req('POST', `/api/attempts/${id1}/schedules`, { ...base, date: '2026-12-10', startTime: '10:30', endTime: '11:30', operationId: 'qa-c-2', confirmOverlap: true, conflictToken: 'forged', expectedConflictIds: [] });
p(`[重叠] 伪造 token 强行写入 → ${badToken.status} ${sh(badToken.body)}`);
const goodToken = await req('POST', `/api/attempts/${id1}/schedules`, { ...base, date: '2026-12-10', startTime: '10:30', endTime: '11:30', operationId: 'qa-c-2', confirmOverlap: true, conflictToken: clash.body?.conflictToken, expectedConflictIds: (clash.body?.conflicts || []).map((c) => c.id) });
p(`[重叠] 正确 token 写入 → ${goodToken.status}`);

// ---------- D. 主题 next_attempt 只能固定本主题的未完成尝试 ----------
const tp = (await req('POST', '/api/topics', { name: '质检主题B', operationId: 'qa-t2' })).body.topic;
const foreignAttempt = b1.body.attempt.id;
const setNext = await req('PATCH', `/api/topics/${tp.id}`, { revision: 1, nextAttemptId: foreignAttempt });
p(`[主题] 把不属于本主题的尝试设为下一步 → ${setNext.status} ${sh(setNext.body, 160)}`);

// ---------- E. 问记录：未配置模型的错误形状 ----------
const askCreate = await req('POST', '/api/ask/queries', { question: '我之前试过什么？', timezone: 'Asia/Shanghai', sourceIds: [] });
p(`[问记录] 未配置模型时创建 → ${askCreate.status} ${sh(askCreate.body, 260)}`);

// ---------- F. 回顾：口径是否被「未完成但有结果」污染 ----------
const nowMs = Date.now();
const day = 86400000;
const prev = await req('GET', `/api/reviews/preview?from=${nowMs - day}&to=${nowMs + day}&timezone=Asia%2FShanghai`);
p(`[回顾] preview → ${prev.status}`);
if (prev.status === 200) {
  p('[回顾] stats = ' + JSON.stringify(prev.body?.stats ?? prev.body).slice(0, 400));
  const items = prev.body?.items ?? prev.body?.records ?? [];
  p('[回顾] 条目数 = ' + (Array.isArray(items) ? items.length : 'n/a'));
  const s = JSON.stringify(prev.body);
  p('[回顾] 是否包含「未开始但成功」的尝试：' + (s.includes('口径样本尝试') ? '是' : '否'));
}

const fs = await import('node:fs');
fs.writeFileSync('D:/联动日程表/audit/api-probe2.log.txt', out.join('\n'), 'utf8');
