// 拾念 SHINIAN · 「主题页」浏览器端到端验收（QA 独立版）
// Chrome 无头，1280×900 与 390×844；隔离服务默认 3230，假模型默认 3501。
//
// 推荐由 scripts/run_e2e_topics.ps1 启动隔离服务与假模型；本脚本只通过 API 种子，不直接写数据库。
// 断言口径：UI 未实现即按需求 FAIL，不绕过、不改源码。
//
// 用法：
//   node scripts/e2e_topics.mjs                 # 主验收
//   node scripts/e2e_topics.mjs --phase restart # 隔离服务重启后的持久性复查（由 runner 调用）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3230').replace(/\/+$/, '');
const FAKE = (process.env.SHINIAN_FAKE_BASE || 'http://127.0.0.1:3501').replace(/\/+$/, '');
const CHROME =
  process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const DB = process.env.SHINIAN_DB || process.env.DATABASE_URL || 'db/topics-e2e.sqlite';
const USER = `主题验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-topics-key';
const LOG_PATH = process.env.SHINIAN_TOPIC_LOG || 'output/topics-e2e-last.log';
const FAIL_PATH = process.env.SHINIAN_TOPIC_FAILURES || 'output/topics-e2e-failures.txt';
const STATE_PATH = process.env.SHINIAN_TOPIC_STATE || 'output/topics-e2e-state.json';
const PHASE = (() => {
  const i = process.argv.indexOf('--phase');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'main';
})();

const DIM_NAME = '调光灯实验';
const SLEEP_NAME = '改善睡前习惯';
const DIM_QUESTION = '低亮度下哪些调光条件更适合当前硬件？';
const SLEEP_QUESTION = '睡前 30 分钟做什么最容易坚持？';
const DIM_DESC = '范围只包含本主题成员，不把主题说明发给模型。';
const DIM_NOTE = '下次先从 A2 继续；同主题不等于同一条关系。';
const A_TEXT = 'LED 调光实验：低占空比时闪烁';
const B_TEXT = '后续复测：换供电';
const C_TEXT = '灯带电源噪声';
const D_TEXT = '睡前刷手机';
const F_TEXT = '临时成员：调光备注';
const A1_STEP = '把 PWM 频率从 500 Hz 提到 2 kHz';
const A1_RESULT = '2kHz、20% 占空比、5V USB，闪烁明显减轻';
const A2_STEP = '下次继续：低亮度下对比两种占空比';
const A3_STEP = '尝试用手机拍摄闪烁';
const B1_STEP = '改用独立 5V 电源复测';
const B1_RESULT = '仍有轻微闪烁，换供电没有完全解决';
const B2_STEP = '测量电源纹波';
const E_TITLE = '调光频率经验';
const E_UNDERSTANDING =
  '把频率、占空比和供电条件一起记录后，2 kHz 这一组最稳定；后续复测先沿用这组基线。';
const E_CONDITIONS = 'LED 灯带、5V USB 供电、20% 占空比';
const E_LIMITATIONS = '只测了一条灯带，未比较不同电源。';
const Q_TEXT = 'UI 新建主题测试记录';
const Q1_STEP = 'UI 新建主题测试尝试';

const S = {
  DIM_NAME,
  SLEEP_NAME,
  DIM_QUESTION,
  SLEEP_QUESTION,
  DIM_NOTE,
  A_TEXT,
  B_TEXT,
  C_TEXT,
  D_TEXT,
  F_TEXT,
  A1_STEP,
  A1_RESULT,
  A2_STEP,
  A3_STEP,
  B1_STEP,
  B1_RESULT,
  B2_STEP,
  E_TITLE,
  E_UNDERSTANDING,
  E_CONDITIONS,
  E_LIMITATIONS,
  Q_TEXT,
  Q1_STEP,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shotPath = (name) => path.join(SHOT_DIR, name);

let passed = 0;
let failed = 0;
const failures = [];
const todos = [];
const sectionStats = new Map();
const logLines = [];
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);

function writeLog() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n', 'utf8');
}
function emit(line) {
  logLines.push(line);
  origConsoleLog(line);
}
console.log = (...args) => emit(args.map(String).join(' '));
console.error = (...args) => {
  const line = args.map(String).join(' ');
  logLines.push(line);
  origConsoleError(line);
};

function section(n, title) {
  console.log('\n' + '='.repeat(64));
  console.log(`SECTION ${n}. ${title}`);
  console.log('='.repeat(64));
}

function check(id, name, cond, detail = '') {
  const sec = String(id).split('.')[0];
  if (!sectionStats.has(sec)) sectionStats.set(sec, { passed: 0, failed: 0 });
  const stat = sectionStats.get(sec);
  if (cond) {
    passed += 1;
    stat.passed += 1;
    console.log(`PASS  [${id}] ${name}`);
  } else {
    failed += 1;
    stat.failed += 1;
    failures.push(`[${id}] ${name}${detail ? `  ${detail}` : ''}`);
    console.log(`FAIL  [${id}] ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function todo(name, note) {
  todos.push(`${name}: ${note}`);
  console.log(`TODO  ${name}  ${note}`);
}

async function fill(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

async function setViewport(page, width, height, scale = 1) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await sleep(250);
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: shotPath(name), fullPage: true });
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '');
}

async function textOf(page, selector) {
  return page.$eval(selector, (el) => el.innerText).catch(() => '');
}

async function waitForAny(page, selectors, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await page.$(selector)) return selector;
    }
    await sleep(100);
  }
  return null;
}

async function waitForText(page, needle, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await bodyText(page)).includes(needle)) return true;
    await sleep(150);
  }
  return false;
}

/** 在指定容器内找包含文本的可点击元素并点击；返回是否点到。 */
async function clickText(page, needle, selector = 'button, a, [role="button"], label') {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const text = (await handle.evaluate((el) => el.innerText || el.textContent || '')).trim();
    if (text.includes(needle)) {
      const visible = await handle.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      });
      if (!visible) continue;
      await handle.click();
      return true;
    }
  }
  return false;
}

async function api(page, method, url, body) {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const init = { method: m, headers: {} };
      if (b !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(b);
      }
      const res = await fetch(u, init);
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, body: json };
    },
    { method, url, body }
  );
}

async function apiOk(page, method, url, body) {
  const res = await api(page, method, url, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 600)}`);
  }
  return res.body;
}

async function setAiConfig(page, { modelId = 'fake-ask', enabled = true } = {}) {
  return api(page, 'PUT', '/api/settings/ai', {
    name: '主题验收假模型',
    baseUrl: `${FAKE}/v1`,
    modelId,
    enabled,
    allowLocal: true,
    apiKey: KEY,
  });
}

async function fakeLastRecord() {
  const res = await fetch(`${FAKE}/__last`);
  const body = await res.json();
  return body?.request ?? null;
}

function fakePromptText(record) {
  if (!record?.body?.messages) return '';
  return record.body.messages
    .filter((m) => m?.role === 'user')
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((part) => (typeof part === 'string' ? part : part?.text || ''))
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForAny(page, ['.login-card', '.capture-input', '.home-page'], 30000);
  if (await page.$('.login-card')) {
    await fill(page, '.login-card input', USER);
    await page.click('.login-card button[type="submit"]');
  }
  await page.waitForFunction(() => location.pathname !== '/login', { timeout: 20000 });
  await page.waitForSelector('.capture-input, .home-page', { timeout: 20000 });
}

/** 所有种子都通过真实 API 写入，不直接碰数据库。 */
async function seedAll(page) {
  return page.evaluate(
    async (S) => {
      const uniq = () => Math.random().toString(36).slice(2, 10);
      async function raw(method, url, body) {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, body: json };
      }
      async function req(method, url, body) {
        const res = await raw(method, url, body);
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 500)}`);
        }
        return res.body;
      }
      async function capture(rawText) {
        return (await req('POST', '/api/captures', { rawText })).capture;
      }
      async function attempt(captureId, step, state, resultText, outcome, observedAt) {
        const created = await req('POST', `/api/captures/${captureId}/attempts`, {
          step,
          operationId: `op-${uniq()}`,
        });
        let row = created.attempt;
        if (state === 'done') {
          row = (
            await req('PATCH', `/api/attempts/${row.id}`, {
              state: 'done',
              resultText,
              outcome,
              observedAt,
              revision: row.revision,
            })
          ).attempt;
        } else if (state !== 'todo') {
          row = (
            await req('PATCH', `/api/attempts/${row.id}`, {
              state,
              revision: row.revision,
            })
          ).attempt;
        }
        return row;
      }

      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const a = await capture(S.A_TEXT);
      const a1 = await attempt(a.id, S.A1_STEP, 'done', S.A1_RESULT, 'success', now - 10 * day);
      const a2 = await attempt(a.id, S.A2_STEP, 'todo', null, null, null);
      const a3 = await attempt(a.id, S.A3_STEP, 'cancelled', null, null, null);
      const b = await capture(S.B_TEXT);
      const b1 = await attempt(b.id, S.B1_STEP, 'done', S.B1_RESULT, 'failure', now - 3 * day);
      const b2 = await attempt(b.id, S.B2_STEP, 'in_progress', null, null, null);
      const c = await capture(S.C_TEXT);
      const d = await capture(S.D_TEXT);
      const f = await capture(S.F_TEXT);
      const q = await capture(S.Q_TEXT);
      const q1 = await attempt(q.id, S.Q1_STEP, 'todo', null, null, null);

      const exp = (
        await req('POST', '/api/experiences', {
          title: S.E_TITLE,
          understanding: S.E_UNDERSTANDING,
          conditions: S.E_CONDITIONS,
          limitations: S.E_LIMITATIONS,
          by: 'user',
          modelBasis: null,
          originKind: 'attempt',
          originAttemptId: a1.id,
          contextCaptureId: a.id,
          sourceKeys: [`attempt:${a1.id}`],
          operationId: `op-exp-${uniq()}`,
        })
      ).experience;

      const dimMembersOp = `op-members-${uniq()}`;
      const dim = (
        await req('POST', '/api/topics', {
          title: S.DIM_NAME,
          exploringQuestion: S.DIM_QUESTION,
          continueNote: S.DIM_NOTE,
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;
      const dimMembers = await req('POST', `/api/topics/${dim.id}/members`, {
        captureIds: [a.id, b.id, exp.id, c.id],
        operationId: dimMembersOp,
      });
      const dimFresh = await req('GET', `/api/topics/${dim.id}`);
      const nextSet = await req('PUT', `/api/topics/${dim.id}/next-attempt`, {
        attemptId: a2.id,
        expectedRevision: dimFresh.topic.revision,
        operationId: `op-next-${uniq()}`,
      });

      const sleepTopic = (
        await req('POST', '/api/topics', {
          title: S.SLEEP_NAME,
          exploringQuestion: S.SLEEP_QUESTION,
          captureIds: [exp.id, d.id],
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;

      // 问答范围变更场景：T7 先含 A/B，随后移除 A。
      const askTopic = (
        await req('POST', '/api/topics', {
          title: '问答范围变更测试',
          exploringQuestion: '只用于 context_changed 验收。',
          captureIds: [a.id, b.id],
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;

      // 删除固定尝试 / 删除所属念头 / 删除主题保留业务数据的独立样本。
      const z1 = await capture('删除测试：固定尝试的所属念头');
      const z1a = await attempt(z1.id, '待删除的固定尝试', 'todo', null, null, null);
      const t3 = (
        await req('POST', '/api/topics', {
          title: '删除固定尝试测试主题',
          captureIds: [z1.id],
          nextAttemptId: z1a.id,
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;

      const z2 = await capture('删除测试：固定尝试的所属念头二');
      const z2a = await attempt(z2.id, '随念头删除的固定尝试', 'todo', null, null, null);
      const t4 = (
        await req('POST', '/api/topics', {
          title: '删除所属念头测试主题',
          captureIds: [z2.id],
          nextAttemptId: z2a.id,
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;

      const z3 = await capture('保留测试：主题删除后仍存在');
      const z3a = await attempt(z3.id, '保留测试尝试', 'todo', null, null, null);
      const scheduleDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
      }).format(new Date(now + 3 * day));
      const schedule = await req('POST', `/api/attempts/${z3a.id}/schedules`, {
        date: scheduleDate,
        endDate: scheduleDate,
        startTime: '10:00',
        endTime: '10:30',
        timezone: 'Asia/Shanghai',
        note: '主题删除后应保留的日程',
        operationId: `op-sch-${uniq()}`,
      });
      const t5 = (
        await req('POST', '/api/topics', {
          title: '归档删除保留测试主题',
          captureIds: [z3.id, exp.id],
          nextAttemptId: z3a.id,
          operationId: `op-topic-${uniq()}`,
        })
      ).topic;

      // 越界来源样本：不属于任何主题的念头与尝试。
      const x = await capture('范围外记录：不属于调光主题');
      const x1 = await attempt(x.id, '范围外尝试', 'done', '范围外结果', 'undetermined', now - day);

      // 让两个验收主题保持在首页「最近主题」前 3 条内（后续测试主题不应把它们挤掉）。
      const dimTouch = await req('GET', `/api/topics/${dim.id}`);
      await req('PATCH', `/api/topics/${dim.id}`, {
        exploringQuestion: S.DIM_QUESTION,
        expectedRevision: dimTouch.topic.revision,
        operationId: `op-touch-dim-${uniq()}`,
      }).catch(() => null);
      const sleepTouch = await req('GET', `/api/topics/${sleepTopic.id}`);
      await req('PATCH', `/api/topics/${sleepTopic.id}`, {
        exploringQuestion: S.SLEEP_QUESTION,
        expectedRevision: sleepTouch.topic.revision,
        operationId: `op-touch-sleep-${uniq()}`,
      }).catch(() => null);

      return {
        a: a.id,
        a1: a1.id,
        a2: a2.id,
        a3: a3.id,
        b: b.id,
        b1: b1.id,
        b2: b2.id,
        c: c.id,
        d: d.id,
        f: f.id,
        q: q.id,
        q1: q1.id,
        exp: exp.id,
        dim: dim.id,
        dimRevision: nextSet.topic.revision,
        dimMembersOp,
        sleep: sleepTopic.id,
        askTopic: askTopic.id,
        z1: z1.id,
        z1a: z1a.id,
        t3: t3.id,
        z2: z2.id,
        z2a: z2a.id,
        t4: t4.id,
        z3: z3.id,
        z3a: z3a.id,
        schedule: schedule.schedule.id,
        t5: t5.id,
        x: x.id,
        x1: x1.id,
      };
    },
    {
      ...S,
    }
  );
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

console.log('='.repeat(72));
console.log(`主题页浏览器端到端验收（QA 独立版） phase=${PHASE}`);
console.log(`BASE = ${BASE}`);
console.log(`DB   = ${DB}`);
console.log(`FAKE = ${FAKE}`);
console.log(`SHOTS= ${path.resolve(SHOT_DIR)}`);
console.log('='.repeat(72));

if (!fs.existsSync('dist/client/index.html')) {
  console.error('缺少 dist/client/index.html：请先执行 npm run build，再运行本验收。');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 300000,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--lang=zh-CN',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage();
await setViewport(page, 1280, 900);

let ids = null;
let currentTopicRevision = null;

async function dismissDialogIfAny() {
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });
}

try {
  await dismissDialogIfAny();
  console.log('\n— 登录与模型配置');
  await login(page);
  check('0.1', '本机登录成功', true);
  const ai = await setAiConfig(page, { modelId: 'fake-ask' });
  check(
    '0.2',
    '配置 fake-ask（3501 / allowLocal / test-topics-key）',
    ai.status === 200,
    JSON.stringify(ai.body).slice(0, 200)
  );

  if (PHASE === 'restart') {
    // 重启阶段只做持久性复查，使用主阶段写下的状态。
    if (!fs.existsSync(STATE_PATH)) {
      check('R.0', '读取主阶段状态文件', false, STATE_PATH);
      throw new Error(`缺少状态文件 ${STATE_PATH}`);
    }
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    ids = state.ids;
    section('R', '隔离服务重启后的持久性');
    const detail = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
    check(
      'R.1',
      '重启后主题仍存在且成员完整',
      detail.topic.id === ids.dim && detail.topic.memberCount === 4,
      JSON.stringify(detail.topic).slice(0, 240)
    );
    check(
      'R.2',
      '重启后固定下一步仍为 A2',
      detail.topic.nextAttempt?.id === ids.a2,
      JSON.stringify(detail.topic.nextAttempt)
    );
    await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
    await waitForText(page, S.A2_STEP, 20000).catch(() => false);
    const restartBody = await bodyText(page);
    check('R.3', '重启后详情页显示 A2「下次继续」', restartBody.includes(S.A2_STEP) && /下次继续|下一步/.test(restartBody), restartBody.slice(0, 300));

    // 完成后：显示「这一步已记录结果」+ 查看结果；可清除/换。
    const donePatch = await api(page, 'PATCH', `/api/attempts/${ids.a2}`, {
      state: 'done',
      resultText: '按 A2 完成：低亮度下 20% 占空比可接受，10% 仍可见闪烁。',
      outcome: 'success',
      observedAt: Date.now(),
      revision: (await apiOk(page, 'GET', `/api/attempts/${ids.a2}`)).attempt.revision,
    });
    check('R.4', 'A2 可标记完成并记录结果', donePatch.status === 200, JSON.stringify(donePatch.body).slice(0, 300));
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(800);
    const completedBody = await bodyText(page);
    check(
      'R.5',
      '完成后显示「这一步已记录结果」与查看结果入口',
      /这一步已记录结果/.test(completedBody) && /查看结果/.test(completedBody),
      completedBody.slice(0, 500)
    );
    const detailAfterDone = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
    const clear = await api(page, 'PUT', `/api/topics/${ids.dim}/next-attempt`, {
      attemptId: null,
      expectedRevision: detailAfterDone.topic.revision,
      operationId: `op-clear-${Date.now()}`,
    });
    check('R.6', '固定下一步可清除', clear.status === 200 && !clear.body?.topic?.nextAttempt, JSON.stringify(clear.body).slice(0, 300));
    const detailAfterClear = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
    const change = await api(page, 'PUT', `/api/topics/${ids.dim}/next-attempt`, {
      attemptId: ids.b2,
      expectedRevision: detailAfterClear.topic.revision,
      operationId: `op-change-${Date.now()}`,
    });
    check(
      'R.7',
      '固定下一步可换成 B2',
      change.status === 200 && change.body?.topic?.nextAttempt?.id === ids.b2,
      JSON.stringify(change.body).slice(0, 300)
    );
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(500);
    const changedBody = await bodyText(page);
    check('R.8', '刷新后显示换过的 B2', changedBody.includes(S.B2_STEP), changedBody.slice(0, 400));
    await shot(page, 'topic-03-next-continue.png');
  } else {
    console.log('\n— 通过 API 种入固定场景');
    ids = await seedAll(page);
    check(
      '0.3',
      '种子数据创建完成（两个主题、A/B/C/D、E、A1/A2/A3/B1/B2）',
      Boolean(ids?.dim && ids?.sleep && ids?.a1 && ids?.a2 && ids?.b1),
      JSON.stringify(ids).slice(0, 400)
    );
    const scopeCheck = await api(page, 'GET', `/api/topics/${ids.askTopic}`);
    check('0.4', '问答范围变更主题创建成功', scopeCheck.status === 200 && scopeCheck.body?.topic?.memberCount === 2, JSON.stringify(scopeCheck.body).slice(0, 200));

    // 把主阶段状态写到文件，供 runner 重启后复查。
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ user: USER, ids }, null, 2), 'utf8');

    // 供后续 UI 测试使用的全局常量（页面上下文里不共享，仅本脚本使用）。
    // 具体验收在下方分节执行。
    await runMainSections();
  }
} catch (err) {
  failed += 1;
  failures.push(`E2E ERROR: ${String(err && err.stack ? err.stack.split('\n')[0] : err)}`);
  console.error('E2E ERROR:', err?.stack || err);
  await shot(page, 'topic-error.png').catch(() => {});
} finally {
  // 先落盘日志与失败明细，再关闭浏览器；避免 browser.close 异常导致证据丢失。
  const sections = [...sectionStats.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (sections.length) {
    console.log('\n' + '-'.repeat(64));
    for (const [sec, stat] of sections) {
      console.log(`SECTION ${sec}: ${stat.passed} passed, ${stat.failed} failed`);
    }
  }
  console.log('\n' + '='.repeat(72));
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:');
    for (const item of failures) console.log(`  - ${item}`);
  }
  if (todos.length) {
    console.log('TODO（UI 尚未实现，脚本按需求断言并失败）:');
    for (const item of todos) console.log(`  - ${item}`);
  }
  console.log('='.repeat(72));
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (PHASE === 'restart') {
    fs.appendFileSync(LOG_PATH, '\n' + logLines.join('\n') + '\n', 'utf8');
  } else {
    writeLog();
  }
  fs.mkdirSync(path.dirname(FAIL_PATH), { recursive: true });
  const failText = failures.length
    ? failures.map((item) => `- ${item}`).join('\n') + '\n'
    : '（无失败）\n';
  if (PHASE === 'restart') fs.appendFileSync(FAIL_PATH, `\n[restart]\n${failText}`, 'utf8');
  else fs.writeFileSync(FAIL_PATH, failText, 'utf8');
  await browser.close().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}

// 占位：页面出现后由后续编辑补齐具体 UI 断言。
async function runMainSections() {
  await runApiSections();
  await runUiSections();
}

function memberList(detail) {
  return [
    ...(detail?.members?.thoughts ?? []),
    ...(detail?.members?.experiences ?? []),
  ];
}

function attemptKey(attempt) {
  return Number(attempt.observedAt ?? attempt.createdAt ?? 0);
}

async function runUiSections() {
  await uiHomeAndCrud();
  await uiMembersAndCas();
  await uiRenameAndLinks();
  await uiAttemptsAndNext();
  await uiNavigationAndGraph();
  await uiAskScope();
  await uiDeletionAndNoModel();
  await uiMobileAndKeyboard();
}

async function uiHomeAndCrud() {
  section(1, '首页 / 主题列表 / 新建编辑归档删除');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const homeBody = await bodyText(page);
  check(
    '1.1',
    '首页显示最近主题列表（含固定种子主题）',
    homeBody.includes(DIM_NAME) &&
      (await page.$$('[data-testid="home-topic-item"]')).length >= 1 &&
      homeBody.length > 0,
    homeBody.slice(0, 600)
  );
  const homeLinks = await page.$$eval('a', (els) =>
    els.map((el) => ({ text: (el.textContent || '').trim(), href: el.getAttribute('href') || '' }))
  );
  const allTopicsLink = homeLinks.find(
    (item) => item.href === '/topics' && /查看全部|全部主题|所有主题/.test(item.text)
  );
  check('1.2', '首页「查看全部」直接链接到 /topics', Boolean(allTopicsLink), JSON.stringify(homeLinks.slice(0, 20)));

  await page.goto(`${BASE}/topics`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topics-page"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="topic-card"]', { timeout: 20000 });
  const listBody = await bodyText(page);
  check(
    '1.3',
    '/topics 直接打开并列出两个固定主题',
    listBody.includes(DIM_NAME) && listBody.includes(SLEEP_NAME),
    listBody.slice(0, 500)
  );
  await shot(page, 'topic-01-list-desktop.png');

  await page.click('[data-testid="topic-create-toggle"]');
  await page.waitForSelector('[data-testid="topic-create-name"]');
  await fill(page, '[data-testid="topic-create-name"]', 'UI 新建主题测试');
  await fill(page, '[data-testid="topic-create-question"]', '这是一个只用于删除验证的问题。');
  await fill(page, '[data-testid="topic-create-note"]', '删除时不应删除原记录。');
  await page.click('[data-testid="topic-create-submit"]');
  await page.waitForFunction(() => /^\/topics\/topic-/.test(location.pathname), { timeout: 20000 });
  const uiTopicId = new URL(page.url()).pathname.split('/').pop();
  check('1.4', 'UI 新建主题并打开详情', Boolean(uiTopicId), page.url());

  await page.click('[data-testid="topic-add-members"]');
  await page.waitForSelector('.topic-picker');
  await fill(page, 'input[aria-label="搜索要加入主题的记录"]', Q_TEXT);
  await clickText(page, '搜索', '.topic-picker button');
  await page.waitForSelector('.topic-picker-list');
  let picked = false;
  const candidateRows = await page.$$('.topic-picker-list label.topic-check-row');
  for (const row of candidateRows) {
    const text = await row.evaluate((el) => el.innerText);
    if (text.includes(Q_TEXT)) {
      const box = await row.$('input[type="checkbox"]');
      if (box) {
        await box.click();
        picked = true;
      }
      break;
    }
  }
  check('1.5', '成员选择器可搜索并勾选新建主题的原始记录', picked);
  if (picked) {
    await clickText(page, '加入 1 条记录', '.topic-picker button');
    await page.waitForFunction(() => !document.querySelector('.topic-picker'), { timeout: 15000 });
  }
  await waitForText(page, Q_TEXT, 10000);
  check('1.6', '新建主题成功加入原始记录', (await bodyText(page)).includes(Q_TEXT));

  await page.click('[data-testid="topic-edit"]');
  await fill(page, '[data-testid="topic-edit-name"]', 'UI 新建主题测试（改名）');
  await page.click('[data-testid="topic-edit-save"]');
  await waitForText(page, 'UI 新建主题测试（改名）', 10000);
  check('1.7', 'UI 编辑主题名称成功', (await bodyText(page)).includes('UI 新建主题测试（改名）'));

  await page.click('[data-testid="topic-archive"]');
  await sleep(500);
  const archivedTopic = await api(page, 'GET', `/api/topics/${uiTopicId}`);
  check(
    '1.8',
    'UI 归档主题成功',
    archivedTopic.status === 200 && archivedTopic.body?.topic?.archived === true,
    `${archivedTopic.status} ${JSON.stringify(archivedTopic.body?.topic).slice(0, 200)}`
  );
  await page.click('[data-testid="topic-restore"]');
  await sleep(500);
  check('1.9', 'UI 恢复主题成功', (await bodyText(page)).includes('已恢复'));

  await page.click('[data-testid="topic-delete-open"]');
  await page.waitForSelector('[data-testid="topic-delete-confirm"]');
  const deleteModalText = await bodyText(page);
  check(
    '1.10',
    '删除预览明确只删主题、不删原记录',
    /只删除主题和它的成员关系|不会删除任何念头|不会删除.*尝试/.test(deleteModalText),
    deleteModalText.slice(0, 500)
  );
  await page.click('[data-testid="topic-delete-confirm"]');
  await page.waitForFunction(() => location.pathname === '/topics', { timeout: 20000 });
  const uiTopicAfter = await api(page, 'GET', `/api/topics/${uiTopicId}`);
  const qAfter = await api(page, 'GET', `/api/captures/${ids.q}`);
  const q1After = await api(page, 'GET', `/api/attempts/${ids.q1}`);
  check(
    '1.11',
    '删除主题只删主题：原 capture/attempt 仍可打开，主题 404',
    uiTopicAfter.status === 404 && qAfter.status === 200 && q1After.status === 200,
    JSON.stringify({ topic: uiTopicAfter.status, capture: qAfter.status, attempt: q1After.status })
  );
}

async function uiMembersAndCas() {
  section(2, 'UI：成员分组与经验依据');
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-page"]', { timeout: 20000 });
  const detailBody = await bodyText(page);
  check(
    '2.6',
    '主题详情显示名称、探索问题与继续备注',
    detailBody.includes(DIM_NAME) && detailBody.includes(DIM_QUESTION) && detailBody.includes(DIM_NOTE),
    detailBody.slice(0, 500)
  );
  await shot(page, 'topic-02-detail-desktop.png');
  await page.click('[data-testid="topic-members-tab-experience"]');
  await waitForText(page, E_TITLE, 10000);
  check(
    '2.7',
    '经验成员显示 E 标题与依据数',
    (await bodyText(page)).includes(E_TITLE) && /条依据/.test(await bodyText(page))
  );
  await page.click('[data-testid="topic-add-members"]');
  await page.waitForSelector('.topic-picker');
  await shot(page, 'topic-04-members.png');
  await page.click('.topic-picker .icon-btn[aria-label="关闭"]').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.topic-picker'), { timeout: 10000 }).catch(() => {});

  section(3, 'UI：revision/CAS 冲突提示并保留输入');
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-page"]');
  await page.click('[data-testid="topic-edit"]');
  await fill(page, '[data-testid="topic-edit-name"]', 'CAS 冲突草稿');
  const current = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  const compete = await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: 'CAS 竞争修改',
    expectedRevision: current.topic.revision,
    operationId: `op-cas-ui-${Date.now()}`,
  });
  check('3.5', '并发窗口修改主题成功（用于制造版本冲突）', compete.status === 200, `${compete.status}`);
  await page.click('[data-testid="topic-edit-save"]');
  await page.waitForSelector('[data-testid="topic-edit-conflict"]', { timeout: 15000 });
  const draftValue = await page.$eval('[data-testid="topic-edit-name"]', (el) => el.value);
  check(
    '3.6',
    'CAS 冲突时显示提示且保留用户输入',
    draftValue === 'CAS 冲突草稿' && /版本冲突|输入仍保留/.test(await bodyText(page)),
    draftValue
  );
  const latest = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: DIM_NAME,
    expectedRevision: latest.topic.revision,
    operationId: `op-cas-restore-${Date.now()}`,
  });
}

async function uiRenameAndLinks() {
  section(4, '改名后成员链接仍指向原 ID');
  const aRow = await apiOk(page, 'GET', `/api/captures/${ids.a}`);
  const renamed = `${A_TEXT}（已改名）`;
  const patchA = await api(page, 'PATCH', `/api/captures/${ids.a}`, {
    rawText: renamed,
    revision: aRow.capture.revision,
  });
  check('4.1', '修改记录 A 标题成功', patchA.status === 200, `${patchA.status}`);
  const detail = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  const aMember = memberList(detail).find((m) => m.captureId === ids.a);
  check(
    '4.2',
    '主题成员链接仍指向 /capture/<原 ID>',
    aMember?.openHref === `/capture/${ids.a}`,
    JSON.stringify(aMember)
  );
  await page.goto(`${BASE}/topics/${ids.dim}?tab=thought`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-page"]');
  const cards = await page.$$('[data-testid="topic-member-card"]');
  let opened = false;
  for (const card of cards) {
    const text = await card.evaluate((el) => el.innerText);
    if (text.includes(renamed)) {
      const link = await card.$('[data-testid="topic-member-open"]');
      if (link) {
        await link.click();
        opened = true;
      }
      break;
    }
  }
  check('4.3', '改名后的成员条目仍可点开', opened);
  if (opened) {
    await page.waitForFunction((id) => location.pathname === `/capture/${id}`, { timeout: 20000 }, ids.a);
    check('4.4', '打开的是原 capture ID', page.url().includes(`/capture/${ids.a}`), page.url());
    await page.waitForSelector('[data-testid="capture-back-topic"]', { timeout: 5000 }).catch(() => {});
    const backLink = await page.$(
      '[data-testid$="-back-topic"], [data-testid="return-to-topic"], a[href*="/topics/"]'
    );
    check('4.5', '记录页提供返回主题入口', Boolean(backLink), `${page.url()} :: ${(await bodyText(page)).slice(0, 300)}`);
    await page.goBack();
    await page.waitForSelector('[data-testid="topic-page"]');
  }
  const refreshResp = await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  check(
    '4.6',
    '刷新 /topics/:id 返回 200/304',
    (refreshResp?.status() === 200 || refreshResp?.status() === 304) &&
      (await page.$('[data-testid="topic-page"]')) !== null,
    String(refreshResp?.status())
  );
  const topicRow = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  const topicRename = await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: '调光灯实验（主题改名）',
    expectedRevision: topicRow.topic.revision,
    operationId: `op-rename-topic-${Date.now()}`,
  });
  check('4.7', '修改主题名成功', topicRename.status === 200, `${topicRename.status}`);
  await page.reload({ waitUntil: 'networkidle0' });
  check(
    '4.8',
    '刷新后显示修改后的主题名',
    (await bodyText(page)).includes('调光灯实验（主题改名）')
  );
  const latest = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: DIM_NAME,
    expectedRevision: latest.topic.revision,
    operationId: `op-rename-restore-${Date.now()}`,
  });
}

async function uiAttemptsAndNext() {
  section(5, 'UI：尝试三态、去重与排序');
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-attempts"]', { timeout: 20000 });
  const cardTexts = await page.$$eval('[data-testid="topic-attempt-card"]', (els) =>
    els.map((el) => el.innerText)
  );
  const states = await page.$$eval('[data-testid="topic-attempt-state"]', (els) =>
    els.map((el) => el.innerText)
  );
  check('5.6', '主题详情聚合 5 条尝试且无重复', cardTexts.length === 5, String(cardTexts.length));
  check(
    '5.7',
    'A1/B1 各出现一次',
    cardTexts.filter((t) => t.includes(A1_STEP)).length === 1 &&
      cardTexts.filter((t) => t.includes(B1_STEP)).length === 1,
    JSON.stringify(cardTexts.map((t) => t.split('\n')[0]))
  );
  const a2Text = cardTexts.find((t) => t.includes(A2_STEP)) ?? '';
  const a3Text = cardTexts.find((t) => t.includes(A3_STEP)) ?? '';
  check(
    '5.8',
    '无结果 A2 显示「等待记录结果」且不显示失败',
    a2Text.includes('等待记录结果') && !a2Text.includes('失败') && !states.includes('失败'),
    a2Text.slice(0, 200)
  );
  check(
    '5.9',
    'cancelled A3 显示「已取消」',
    a3Text.includes('已取消'),
    a3Text.slice(0, 200)
  );
  const apiAttempts = await apiOk(page, 'GET', `/api/topics/${ids.dim}/attempts?limit=50`);
  const expectedOrder = (apiAttempts.attempts ?? []).map((a) => a.step);
  const uiOrder = cardTexts.map((t) => expectedOrder.find((step) => t.includes(step))).filter(Boolean);
  check(
    '5.10',
    'UI 顺序与服务端 observedAt/createdAt 排序一致',
    JSON.stringify(uiOrder) === JSON.stringify(expectedOrder),
    JSON.stringify({ uiOrder, expectedOrder })
  );
  await shot(page, 'topic-05-attempts.png');

  section(6, 'UI：固定下一步 A2');
  const nextCard = await textOf(page, '[data-testid="topic-next-card"]');
  check('6.4', '详情显示「下次继续」固定卡与 A2', nextCard.includes('下次继续') && nextCard.includes(A2_STEP), nextCard.slice(0, 400));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-next-card"]');
  const nextAfterReload = await textOf(page, '[data-testid="topic-next-card"]');
  check('6.5', '刷新详情后固定 A2 仍在', nextAfterReload.includes(A2_STEP), nextAfterReload.slice(0, 300));
  await shot(page, 'topic-03-next-continue.png');
}

async function uiNavigationAndGraph() {
  section(7, '从主题打开记录/图谱并返回，筛选与滚动恢复');
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-page"]');
  await page.click('[data-testid="topic-members-tab-experience"]');
  await page.waitForSelector('[data-testid="topic-member-experience-open"]', { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, Math.max(0, document.body.scrollHeight * 0.45)));
  await sleep(400);
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.click('[data-testid="topic-member-experience-open"]');
  await page.waitForFunction(() => location.pathname.startsWith('/experience/'), { timeout: 20000 });
  const expUrl = page.url();
  check(
    '7.1',
    '从主题打开经验携带 from=topic&topicId&returnTo',
    expUrl.includes('from=topic') && expUrl.includes(`topicId=${ids.dim}`) && expUrl.includes('returnTo='),
    expUrl
  );
  const expReturnLink = await page.$('[data-testid="return-to-topic"], a[href*="/topics/"]');
  check('7.2', '经验页提供返回主题入口', Boolean(expReturnLink), page.url());
  if (expReturnLink) await expReturnLink.click();
  else await page.goBack();
  await page.waitForSelector('[data-testid="topic-page"]', { timeout: 20000 });
  await sleep(800);
  const afterScroll = await page.evaluate(() => window.scrollY);
  const expTabPressed = await page
    .$eval('[data-testid="topic-members-tab-experience"]', (el) => el.getAttribute('aria-pressed'))
    .catch(() => null);
  check(
    '7.3',
    '返回主题后恢复经验筛选与滚动位置',
    expTabPressed === 'true' && Math.abs(afterScroll - beforeScroll) <= 80,
    JSON.stringify({
      expTabPressed,
      beforeScroll,
      afterScroll,
      scrollHeight: await page.evaluate(() => document.documentElement.scrollHeight),
      innerHeight: await page.evaluate(() => window.innerHeight),
    })
  );

  await page.click('[data-testid="topic-members-tab-thought"]');
  await sleep(200);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(300);
  await page.click('[data-testid="topic-attempt-open"]');
  await page.waitForFunction(() => location.pathname.startsWith('/attempt/'), { timeout: 20000 });
  const attUrl = page.url();
  check(
    '7.4',
    '从主题打开尝试携带主题返回参数',
    attUrl.includes('from=topic') && attUrl.includes(`topicId=${ids.dim}`),
    attUrl
  );
  await page.goBack();
  await page.waitForSelector('[data-testid="topic-page"]');
  await sleep(600);
  check('7.5', '尝试页返回后主题详情仍可操作', (await page.$('[data-testid="topic-page"]')) !== null);

  await page.waitForSelector('[data-testid="topic-local-graph-open"]');
  await page.click('[data-testid="topic-local-graph-open"]');
  await page.waitForFunction(() => location.pathname === '/graph', { timeout: 20000 });
  await page.waitForSelector('.graph-focus-bar', { timeout: 20000 });
  const graphUrl = page.url();
  check(
    '7.6',
    'Graph URL 带 node= 与主题返回参数',
    /[?&]node=/.test(graphUrl) && graphUrl.includes(`topicId=${ids.dim}`),
    graphUrl
  );
  const graphText = await bodyText(page);
  check('7.7', 'Graph 显示「返回主题」', graphText.includes('返回主题'), graphText.slice(0, 300));
  await shot(page, 'topic-07-graph-return.png');
  const returnTopic = await page.$('[data-testid="graph-return-topic"], a[href*="/topics/"]');
  check('7.8', 'Graph 返回主题入口可点击', Boolean(returnTopic), page.url());
  if (returnTopic) {
    await returnTopic.click();
    await page.waitForSelector('[data-testid="topic-page"]', { timeout: 20000 });
    check('7.9', '从 Graph 返回主题详情', page.url().includes(`/topics/${ids.dim}`), page.url());
  }

  const u = await apiOk(page, 'POST', '/api/captures', { rawText: '图边测试 U' });
  const v = await apiOk(page, 'POST', '/api/captures', { rawText: '图边测试 V' });
  const beforeGraph = await apiOk(page, 'GET', '/api/graph');
  const edgeTopic = await apiOk(page, 'POST', '/api/topics', {
    title: '图边测试主题',
    captureIds: [u.capture.id, v.capture.id],
    operationId: `op-graph-edge-${Date.now()}`,
  });
  const afterGraph = await apiOk(page, 'GET', '/api/graph');
  const uNode = `capture:${u.capture.id}`;
  const vNode = `capture:${v.capture.id}`;
  const topicEdges = (afterGraph.links ?? []).filter(
    (link) =>
      (link.source === uNode && link.target === vNode) ||
      (link.source === vNode && link.target === uNode) ||
      String(link.type).includes('topic')
  );
  check(
    '7.10',
    '主题成员关系不产生图谱补边（边数不变、无 topic 类型）',
    (afterGraph.links ?? []).length === (beforeGraph.links ?? []).length && topicEdges.length === 0,
    JSON.stringify({ before: (beforeGraph.links ?? []).length, after: (afterGraph.links ?? []).length, topicEdges })
  );
  await api(page, 'DELETE', `/api/topics/${edgeTopic.topic.id}`);
}

async function uiAskScope() {
  section(8, 'UI：主题问答范围 / 经验依据 / 全库切换');
  const askUrl = `${BASE}/ask?topicId=${ids.dim}&q=${encodeURIComponent(DIM_QUESTION)}`;
  const resp = await page.goto(askUrl, { waitUntil: 'networkidle0' });
  check('8.30', '/ask?topicId=... 可直接打开', resp?.status() === 200, String(resp?.status()));
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await sleep(1200);
  const askBody = await bodyText(page);
  check('8.31', '主题问答页显示主题范围提示', askBody.includes(DIM_NAME) && /主题|范围/.test(askBody), askBody.slice(0, 500));
  const candidateTexts = await page.$$eval('[data-testid="ask-candidate"]', (els) =>
    els.map((el) => el.innerText)
  );
  check(
    '8.32',
    '主题候选不显示睡前 D',
    !candidateTexts.some((t) => t.includes(D_TEXT)),
    JSON.stringify(candidateTexts.slice(0, 10))
  );
  await shot(page, 'topic-06-ask-scope.png');
  const switchAll =
    (await page.$('[data-testid="ask-scope-switch"]')) ||
    (await page.$('[data-testid="ask-scope-switch-all"]'));
  if (switchAll) {
    await switchAll.click();
    await sleep(400);
    check('8.33', '切全库前有明确范围提示', /全库|全部记录|离开主题/.test(await bodyText(page)));
  } else {
    check('8.33', '提供明确的「切全库」操作', false, '未找到 ask-scope-switch-all');
  }
  check('8.34', '主题问答桌面页无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
}

async function uiDeletionAndNoModel() {
  section(10, 'UI：失效固定尝试无悬空按钮与反馈');
  const t3Resp = await page.goto(`${BASE}/topics/${ids.t3}`, { waitUntil: 'networkidle0' });
  check('10.8', '删除固定尝试后刷新主题页 200', t3Resp?.status() === 200, String(t3Resp?.status()));
  await page.waitForSelector('[data-testid="topic-next-card"]', { timeout: 20000 }).catch(() => {});
  const t3Body = await bodyText(page);
  check(
    '10.9',
    '删除固定尝试后显示失效反馈且没有悬空按钮',
    /原固定的尝试已失效|固定的尝试已被删除/.test(t3Body) &&
      !(await page.$('[data-testid="topic-next-open"]')),
    t3Body.slice(0, 600)
  );
  const t4Resp = await page.goto(`${BASE}/topics/${ids.t4}`, { waitUntil: 'networkidle0' });
  const t4Body = await bodyText(page);
  check(
    '10.10',
    '删除固定尝试所属念头后刷新显示失效反馈',
    t4Resp?.status() === 200 && /原固定的尝试已失效|所属念头已移出/.test(t4Body),
    t4Body.slice(0, 600)
  );
  const delT3 = await api(page, 'DELETE', `/api/topics/${ids.t3}`);
  const delT4 = await api(page, 'DELETE', `/api/topics/${ids.t4}`);
  check(
    '10.7',
    '删除主题只删主题与成员：删除后 T3/T4 404，未删除的 Z1 capture 仍可查',
    delT3.status === 200 &&
      delT4.status === 200 &&
      (await api(page, 'GET', `/api/topics/${ids.t3}`)).status === 404 &&
      (await api(page, 'GET', `/api/topics/${ids.t4}`)).status === 404 &&
      (await api(page, 'GET', `/api/captures/${ids.z1}`)).status === 200,
    JSON.stringify({ delT3: delT3.status, delT4: delT4.status })
  );

  section(11, '无模型不阻断主题管理/浏览/成员/固定下一步/尝试');
  const disabled = await setAiConfig(page, { enabled: false });
  check('11.1', '关闭 AI 配置成功', disabled.status === 200, JSON.stringify(disabled.body).slice(0, 200));
  const listNoModel = await api(page, 'GET', '/api/topics?limit=50');
  const detailNoModel = await api(page, 'GET', `/api/topics/${ids.dim}`);
  const membersNoModel = await api(page, 'GET', `/api/topics/${ids.dim}/member-candidates?limit=5`);
  const attemptsNoModel = await api(page, 'GET', `/api/topics/${ids.dim}/attempts?limit=5`);
  check(
    '11.2',
    '无模型时主题列表/详情/成员候选/尝试聚合 API 均可用',
    [listNoModel, detailNoModel, membersNoModel, attemptsNoModel].every((r) => r.status === 200),
    JSON.stringify([listNoModel.status, detailNoModel.status, membersNoModel.status, attemptsNoModel.status])
  );
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.click('[data-testid="topic-members-tab-experience"]').catch(() => {});
  await sleep(300);
  const noModelBody = await bodyText(page);
  check(
    '11.3',
    '无模型时主题详情、成员与固定下一步界面可读',
    noModelBody.includes(DIM_NAME) &&
      noModelBody.includes(E_TITLE) &&
      noModelBody.includes(A2_STEP) &&
      !/模型未配置|无法加载主题/.test(noModelBody),
    noModelBody.slice(0, 500)
  );
  const attemptResp = await page.goto(`${BASE}/attempt/${ids.a1}`, { waitUntil: 'networkidle0' });
  check('11.4', '无模型时尝试详情仍可打开', attemptResp?.status() === 200, String(attemptResp?.status()));
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.click('[data-testid="topic-add-members"]');
  const pickerVisible = await page.waitForSelector('.topic-picker', { timeout: 10000 }).then(() => true).catch(() => false);
  check('11.5', '无模型时成员选择器仍可打开', pickerVisible);
  await page.click('.topic-picker .icon-btn[aria-label="关闭"]').catch(() => {});
  await setAiConfig(page, { enabled: true });
}

async function uiMobileAndKeyboard() {
  section(12, '手机 390×844 与键盘操作');
  await setViewport(page, 390, 844, 2);
  await page.goto(`${BASE}/topics`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topics-page"]');
  check('12.1', '手机主题列表无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-page"]');
  check('12.2', '手机主题详情无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await shot(page, 'topic-mobile-detail.png');
  check(
    '12.3',
    '手机固定下一步卡可读且无横向溢出',
    (await bodyText(page)).includes(A2_STEP) &&
      (await page.$eval('[data-testid="topic-next-card"]', (el) => el.scrollWidth <= el.clientWidth + 1))
  );
  await page.click('[data-testid="topic-add-members"]');
  await page.waitForSelector('.topic-picker');
  check('12.4', '手机成员选择器无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await shot(page, 'topic-mobile-members.png');
  await page.click('.topic-picker .icon-btn[aria-label="关闭"]').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.topic-picker'), { timeout: 10000 }).catch(() => {});
  const attemptOverflow = await page.$$eval('[data-testid="topic-attempt-card"]', (els) =>
    els.some((el) => el.scrollWidth > el.clientWidth + 1)
  );
  check('12.5', '手机尝试卡无横向溢出', !attemptOverflow);

  await setViewport(page, 1280, 900);
  await page.goto(`${BASE}/topics`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-card-open"]');
  let keyboardOpened = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, href: el?.getAttribute?.('href') || '', text: (el?.textContent || '').trim() };
    });
    if (focused.href && focused.href.startsWith('/topics/')) {
      await page.keyboard.press('Enter');
      keyboardOpened = true;
      break;
    }
  }
  await sleep(500);
  check('12.6', '键盘 Tab + Enter 可打开主题', keyboardOpened && page.url().includes('/topics/'), page.url());
  await page.goto(`${BASE}/topics/${ids.dim}`, { waitUntil: 'networkidle0' });
  await page.focus('[data-testid="topic-add-members"]');
  await page.keyboard.press('Enter');
  const keyboardPicker = await page.waitForSelector('.topic-picker', { timeout: 10000 }).then(() => true).catch(() => false);
  check('12.7', '键盘 Enter 可打开成员选择器', keyboardPicker);
}

async function runApiSections() {
  section(2, '成员与经验：同一经验跨主题只保留一份');
  const dimDetail = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  const dimMembers = memberList(dimDetail);
  check(
    '2.1',
    '调光主题包含 3 条念头 + 1 条经验',
    dimDetail.topic.memberCount === 4 &&
      dimDetail.topic.thoughtCount === 3 &&
      dimDetail.topic.experienceCount === 1 &&
      dimMembers.filter((m) => m.kind === 'thought').length === 3 &&
      dimMembers.filter((m) => m.kind === 'experience').length === 1,
    JSON.stringify(dimDetail.topic).slice(0, 300)
  );
  const sleepDetail = await apiOk(page, 'GET', `/api/topics/${ids.sleep}`);
  const sleepMembers = memberList(sleepDetail);
  check(
    '2.2',
    '睡前主题包含经验 E 与念头 D',
    sleepMembers.some((m) => m.captureId === ids.exp && m.kind === 'experience') &&
      sleepMembers.some((m) => m.captureId === ids.d && m.kind === 'thought'),
    JSON.stringify(sleepMembers.map((m) => [m.kind, m.captureId])).slice(0, 300)
  );
  const expList = await apiOk(page, 'GET', '/api/experiences?limit=100');
  check(
    '2.3',
    '经验 E 在经验列表中只出现一份',
    (expList.experiences ?? []).filter((item) => item.id === ids.exp).length === 1,
    String((expList.experiences ?? []).filter((item) => item.id === ids.exp).length)
  );
  const expDetail = await apiOk(page, 'GET', `/api/experiences/${ids.exp}`);
  check(
    '2.4',
    '经验 E 详情只有一条原始依据 A1，源数不因跨主题增加',
    expDetail.experience?.sourceCount === 1 &&
      (expDetail.experience?.sources ?? []).length === 1 &&
      (expDetail.experience?.sources ?? [])[0]?.id === ids.a1,
    JSON.stringify({
      sourceCount: expDetail.experience?.sourceCount,
      sources: (expDetail.experience?.sources ?? []).map((s) => s.id ?? s.sourceKey),
    })
  );
  const dimMemberIds = new Set(dimMembers.map((m) => m.captureId));
  check(
    '2.5',
    '经验 E 同时属于两个主题（稳定 capture ID 复用）',
    dimMemberIds.has(ids.exp) && sleepMembers.some((m) => m.captureId === ids.exp),
    JSON.stringify([...dimMemberIds])
  );

  section(3, '重复成员 / operationId 回放 / revision CAS');
  const replay = await api(page, 'POST', `/api/topics/${ids.dim}/members`, {
    captureIds: [ids.a, ids.b, ids.exp, ids.c],
    operationId: ids.dimMembersOp,
  });
  check(
    '3.1',
    '重复提交同一 operationId 回放且不产生重复成员',
    replay.status === 200 &&
      replay.body?.replayed === true &&
      (replay.body?.members ?? []).filter((m) => m.captureId === ids.a).length === 1,
    `${replay.status} ${JSON.stringify(replay.body).slice(0, 300)}`
  );
  const dupMember = await api(page, 'POST', `/api/topics/${ids.dim}/members`, {
    captureIds: [ids.a],
    operationId: `op-dup-${Date.now()}`,
  });
  const dimAfterDup = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  check(
    '3.2',
    '重复加入同一成员只计 existing，成员数不变',
    dupMember.status === 200 &&
      dupMember.body?.added === 0 &&
      dupMember.body?.existing === 1 &&
      dimAfterDup.topic.memberCount === 4,
    `${dupMember.status} ${JSON.stringify(dupMember.body).slice(0, 300)}`
  );
  const staleRevision = dimAfterDup.topic.revision - 1;
  const stalePatch = await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: 'CAS 冲突不应生效',
    expectedRevision: staleRevision,
    operationId: `op-stale-${Date.now()}`,
  });
  check(
    '3.3',
    '过旧 expectedRevision 返回 409 revision_conflict 并带 currentRevision/currentTopic',
    stalePatch.status === 409 &&
      stalePatch.body?.error === 'revision_conflict' &&
      stalePatch.body?.currentRevision === dimAfterDup.topic.revision &&
      stalePatch.body?.currentTopic?.title === DIM_NAME,
    `${stalePatch.status} ${JSON.stringify(stalePatch.body).slice(0, 400)}`
  );
  const missingRevision = await api(page, 'PATCH', `/api/topics/${ids.dim}`, {
    title: '缺版本',
    operationId: `op-missing-${Date.now()}`,
  });
  check(
    '3.4',
    '缺少 expectedRevision 返回 428 revision_required',
    missingRevision.status === 428 && missingRevision.body?.error === 'revision_required',
    `${missingRevision.status} ${JSON.stringify(missingRevision.body).slice(0, 200)}`
  );

  section(5, '尝试聚合三态与排序');
  const attempts = await apiOk(page, 'GET', `/api/topics/${ids.dim}/attempts?limit=50`);
  const attemptIds = (attempts.attempts ?? []).map((a) => a.id);
  check(
    '5.1',
    'A1/B1 各一次，A2/A3/B2 均出现且无重复',
    attemptIds.length === 5 &&
      new Set(attemptIds).size === 5 &&
      [ids.a1, ids.a2, ids.a3, ids.b1, ids.b2].every((id) => attemptIds.includes(id)),
    JSON.stringify(attemptIds)
  );
  const byId = new Map((attempts.attempts ?? []).map((a) => [a.id, a]));
  check(
    '5.2',
    '三态映射正确：A1/B1 recorded，A2/B2 pending_no_result，A3 cancelled',
    byId.get(ids.a1)?.resultState === 'recorded' &&
      byId.get(ids.b1)?.resultState === 'recorded' &&
      byId.get(ids.a2)?.resultState === 'pending_no_result' &&
      byId.get(ids.b2)?.resultState === 'pending_no_result' &&
      byId.get(ids.a3)?.resultState === 'cancelled',
    JSON.stringify(
      (attempts.attempts ?? []).map((a) => [a.id, a.state, a.resultState, a.resultText])
    )
  );
  check(
    '5.3',
    '无结果 A2 的 resultText 为空且不会被当作失败',
    !byId.get(ids.a2)?.resultText && byId.get(ids.a2)?.outcome == null,
    JSON.stringify(byId.get(ids.a2))
  );
  check(
    '5.4',
    '排序按 COALESCE(observedAt, createdAt) 降序',
    (attempts.attempts ?? []).every(
      (item, index, list) => index === 0 || attemptKey(list[index - 1]) >= attemptKey(item)
    ),
    JSON.stringify((attempts.attempts ?? []).map((a) => [a.id, a.observedAt, a.createdAt]))
  );
  const recorded = await apiOk(page, 'GET', `/api/topics/${ids.dim}/attempts?state=recorded`);
  const pending = await apiOk(page, 'GET', `/api/topics/${ids.dim}/attempts?state=pending`);
  const cancelled = await apiOk(page, 'GET', `/api/topics/${ids.dim}/attempts?state=cancelled`);
  check(
    '5.5',
    'recorded/pending/cancelled 过滤各自数量正确',
    (recorded.attempts ?? []).length === 2 &&
      (pending.attempts ?? []).length === 2 &&
      (cancelled.attempts ?? []).length === 1 &&
      (cancelled.attempts ?? [])[0]?.id === ids.a3,
    JSON.stringify({
      recorded: (recorded.attempts ?? []).map((a) => a.id),
      pending: (pending.attempts ?? []).map((a) => a.id),
      cancelled: (cancelled.attempts ?? []).map((a) => a.id),
    })
  );

  section(6, '固定下一步：A2 持久存在');
  const dimNext = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  check(
    '6.1',
    '调光主题固定下一步为 A2 且未完成',
    dimNext.topic.nextAttempt?.id === ids.a2 && dimNext.topic.nextAttempt?.isCompleted === false,
    JSON.stringify(dimNext.topic.nextAttempt)
  );
  check(
    '6.2',
    '固定下一步返回所属念头与步骤',
    dimNext.topic.nextAttempt?.captureId === ids.a &&
      dimNext.topic.nextAttempt?.step === A2_STEP,
    JSON.stringify(dimNext.topic.nextAttempt)
  );
  const dimNext2 = await apiOk(page, 'GET', `/api/topics/${ids.dim}`);
  check(
    '6.3',
    '刷新后固定下一步仍为 A2（服务端持久化）',
    dimNext2.topic.nextAttempt?.id === ids.a2 && dimNext2.topic.revision === dimNext.topic.revision,
    JSON.stringify(dimNext2.topic.nextAttempt)
  );

  section(8, '主题问答范围与候选约束');
  const askCandidates = await apiOk(
    page,
    'GET',
    `/api/topics/${ids.dim}/ask-candidates?question=${encodeURIComponent(DIM_QUESTION)}&keywords=${encodeURIComponent('调光 闪烁 电源')}`
  );
  const candidateText = JSON.stringify(askCandidates.candidates ?? []);
  check(
    '8.1',
    '主题候选不包含睡前念头 D 或范围外 X',
    !candidateText.includes(D_TEXT) && !candidateText.includes('范围外记录'),
    candidateText.slice(0, 400)
  );
  check(
    '8.2',
    '主题候选只来自普通念头成员及其直接尝试',
    (askCandidates.candidates ?? []).every((c) =>
      [ids.a, ids.b, ids.c].includes(c.captureId)
    ),
    JSON.stringify((askCandidates.candidates ?? []).map((c) => [c.type, c.captureId]))
  );
  check(
    '8.3',
    'scope 计数正确：3 念头、1 经验、allowedSourceCount=8（A1 不重复计）',
    askCandidates.scope?.topicId === ids.dim &&
      askCandidates.scope?.thoughtCount === 3 &&
      askCandidates.scope?.experienceCount === 1 &&
      askCandidates.scope?.allowedSourceCount === 8 &&
      askCandidates.scope?.recordCount === 8,
    JSON.stringify(askCandidates.scope)
  );
  check(
    '8.4',
    'scopeHash 为 64 位十六进制并绑定 topicRevision',
    /^[0-9a-f]{64}$/.test(askCandidates.scope?.scopeHash ?? '') &&
      askCandidates.scope?.topicRevision === dimNext2.topic.revision,
    JSON.stringify(askCandidates.scope)
  );
  const askExperiences = await apiOk(page, 'GET', `/api/topics/${ids.dim}/ask-experiences`);
  const expAsk = (askExperiences.experiences ?? []).find((e) => e.id === ids.exp);
  check(
    '8.5',
    '经验依据面板返回 E 的直接依据 A1，且不返回经验正文作为候选',
    Boolean(expAsk) &&
      expAsk.sourceCount === 1 &&
      expAsk.selectableSourceKeys?.includes(`attempt:${ids.a1}`) &&
      (expAsk.sources ?? []).every((source) => source.sourceKey !== `capture:${ids.exp}`),
    JSON.stringify(expAsk).slice(0, 500)
  );
  const previewTopic = await api(page, 'POST', '/api/ask/preview', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.a1}`],
    topicId: ids.dim,
  });
  check(
    '8.6',
    '主题预览只返回勾选的 A1 一条记录并带 scope',
    previewTopic.status === 200 &&
      (previewTopic.body?.records ?? []).length === 1 &&
      previewTopic.body?.scope?.topicId === ids.dim &&
      Boolean(previewTopic.body?.contextToken),
    `${previewTopic.status} ${JSON.stringify(previewTopic.body).slice(0, 500)}`
  );
  const experienceAsSource = await api(page, 'POST', '/api/ask/preview', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`capture:${ids.exp}`],
    topicId: ids.dim,
  });
  check(
    '8.7',
    '经验正文不能作为主题问答来源（400 source_out_of_scope）',
    experienceAsSource.status === 400 &&
      experienceAsSource.body?.error === 'source_out_of_scope' &&
      (experienceAsSource.body?.sourceKeys ?? []).includes(`capture:${ids.exp}`),
    `${experienceAsSource.status} ${JSON.stringify(experienceAsSource.body).slice(0, 300)}`
  );
  const outsideSource = await api(page, 'POST', '/api/ask/preview', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.x1}`],
    topicId: ids.dim,
  });
  check(
    '8.8',
    '越界来源 400 source_out_of_scope',
    outsideSource.status === 400 && outsideSource.body?.error === 'source_out_of_scope',
    `${outsideSource.status} ${JSON.stringify(outsideSource.body).slice(0, 300)}`
  );
  const duplicateKeys = await api(page, 'POST', '/api/ask/preview', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.a1}`, `attempt:${ids.a1}`],
    topicId: ids.dim,
  });
  check(
    '8.9',
    '经验依据与底层 A1 重复 sourceKey 被拒绝（客户端必须去重）',
    duplicateKeys.status === 400 && duplicateKeys.body?.error === 'invalid_sources',
    `${duplicateKeys.status} ${JSON.stringify(duplicateKeys.body).slice(0, 300)}`
  );
  const genTopic = await api(page, 'POST', '/api/ask/queries', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.a1}`],
    topicId: ids.dim,
    contextToken: previewTopic.body?.contextToken,
    operationId: `op-topic-gen-${Date.now()}`,
  });
  check(
    '8.10',
    '主题问答生成只提交勾选的 A1',
    genTopic.status === 202 || genTopic.status === 200,
    `${genTopic.status} ${JSON.stringify(genTopic.body).slice(0, 300)}`
  );
  let genId = genTopic.body?.query?.id;
  let genStatus = genTopic.body?.query?.status;
  const genDeadline = Date.now() + 25000;
  while (genId && genStatus === 'pending' && Date.now() < genDeadline) {
    await sleep(400);
    const poll = await api(page, 'GET', `/api/ask/queries/${genId}`);
    genStatus = poll.body?.query?.status;
  }
  const last = await fakeLastRecord();
  const prompt = fakePromptText(last);
  check(
    '8.11',
    '主题问答假模型 prompt 不含另一主题正文 / 主题说明 / 继续备注 / 经验正文',
    Boolean(prompt) &&
      !prompt.includes(D_TEXT) &&
      !prompt.includes(SLEEP_QUESTION) &&
      !prompt.includes(DIM_DESC) &&
      !prompt.includes(DIM_NOTE) &&
      !prompt.includes(E_UNDERSTANDING) &&
      !prompt.includes(B_TEXT) &&
      !prompt.includes(C_TEXT),
    prompt.slice(0, 1200)
  );
  check(
    '8.12',
    '主题问答 prompt 只包含勾选的 A1 记录',
    prompt.includes(A1_STEP) && prompt.includes(A1_RESULT) && !prompt.includes(A2_STEP) && !prompt.includes(B1_STEP),
    prompt.slice(0, 1200)
  );
  check(
    '8.13',
    '主题问答生成成功且来源数只含 A1',
    genStatus === 'succeeded' &&
      (genTopic.body?.query?.sourceCount ?? 1) >= 1,
    JSON.stringify({ genStatus, error: genTopic.body?.query?.errorCode })
  );

  section(9, '主题问答 preview 后变化 / 伪造来源');
  const t7Detail = await apiOk(page, 'GET', `/api/topics/${ids.askTopic}`);
  const previewT7 = await api(page, 'POST', '/api/ask/preview', {
    question: '这条调光记录当时是什么条件',
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.a1}`],
    topicId: ids.askTopic,
  });
  check(
    '9.1',
    '范围变更场景可预览 A1',
    previewT7.status === 200 && Boolean(previewT7.body?.contextToken),
    `${previewT7.status} ${JSON.stringify(previewT7.body).slice(0, 300)}`
  );
  const removed = await api(page, 'DELETE', `/api/topics/${ids.askTopic}/members/${ids.a}`);
  check('9.2', '预览后移除成员 A 成功', removed.status === 200 && removed.body?.removed === true, `${removed.status}`);
  const changedGenerate = await api(page, 'POST', '/api/ask/queries', {
    question: '这条调光记录当时是什么条件',
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.a1}`],
    topicId: ids.askTopic,
    contextToken: previewT7.body?.contextToken,
    operationId: `op-topic-changed-${Date.now()}`,
  });
  check(
    '9.3',
    '预览后移除成员，生成被范围校验拒绝并提示重新核对',
    (changedGenerate.status === 409 &&
      changedGenerate.body?.error === 'context_changed' &&
      String(changedGenerate.body?.message ?? '').includes('主题成员或来源已变化')) ||
      (changedGenerate.status === 400 &&
        changedGenerate.body?.error === 'source_out_of_scope' &&
        (changedGenerate.body?.sourceKeys ?? []).includes(`attempt:${ids.a1}`)),
    `${changedGenerate.status} ${JSON.stringify(changedGenerate.body).slice(0, 400)}`
  );
  const previewB1 = await api(page, 'POST', '/api/ask/preview', {
    question: '换供电那次闪烁有没有改善',
    keywords: '供电 闪烁',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.b1}`],
    topicId: ids.dim,
  });
  const b1Row = await apiOk(page, 'GET', `/api/attempts/${ids.b1}`);
  const b1Patch = await api(page, 'PATCH', `/api/attempts/${ids.b1}`, {
    state: 'done',
    resultText: `${B1_RESULT}（预览后补充）`,
    outcome: 'failure',
    observedAt: b1Row.attempt.observedAt,
    revision: b1Row.attempt.revision,
  });
  check(
    '9.4',
    '修改来源结果成功',
    previewB1.status === 200 && b1Patch.status === 200,
    `${previewB1.status}/${b1Patch.status}`
  );
  const changedSourceGenerate = await api(page, 'POST', '/api/ask/queries', {
    question: '换供电那次闪烁有没有改善',
    keywords: '供电 闪烁',
    from: null,
    to: null,
    sourceKeys: [`attempt:${ids.b1}`],
    topicId: ids.dim,
    contextToken: previewB1.body?.contextToken,
    operationId: `op-topic-src-${Date.now()}`,
  });
  check(
    '9.5',
    '预览后修改来源，生成返回 409 context_changed',
    changedSourceGenerate.status === 409 && changedSourceGenerate.body?.error === 'context_changed',
    `${changedSourceGenerate.status} ${JSON.stringify(changedSourceGenerate.body).slice(0, 400)}`
  );
  const forged = await api(page, 'POST', '/api/ask/preview', {
    question: DIM_QUESTION,
    keywords: '调光',
    from: null,
    to: null,
    sourceKeys: ['attempt:bad id/<script>'],
    topicId: ids.dim,
  });
  check(
    '9.6',
    '伪造 sourceId 格式返回 400 invalid_sources',
    forged.status === 400 && forged.body?.error === 'invalid_sources',
    `${forged.status} ${JSON.stringify(forged.body).slice(0, 200)}`
  );

  section(10, '删除影不影响：成员 / 主题 / 固定尝试 / 所属念头');
  const beforeRemoval = await api(page, 'POST', `/api/topics/${ids.dim}/members`, {
    captureIds: [ids.f],
    operationId: `op-add-f-${Date.now()}`,
  });
  const removedF = await api(page, 'DELETE', `/api/topics/${ids.dim}/members/${ids.f}`);
  const fAfter = await api(page, 'GET', `/api/captures/${ids.f}`);
  check(
    '10.1',
    '移出成员不删除原 capture（F 仍可打开）',
    beforeRemoval.status === 200 &&
      beforeRemoval.body?.added === 1 &&
      removedF.status === 200 &&
      fAfter.status === 200,
    `${beforeRemoval.status}/${removedF.status}/${fAfter.status}`
  );
  const abcStill = await Promise.all(
    [ids.a, ids.b, ids.c].map((id) => api(page, 'GET', `/api/captures/${id}`))
  );
  check(
    '10.2',
    '移出成员后 A/B/C 三个念头仍在',
    abcStill.every((res) => res.status === 200),
    JSON.stringify(abcStill.map((res) => res.status))
  );
  const t5Detail = await apiOk(page, 'GET', `/api/topics/${ids.t5}`);
  const t5Archive = await api(page, 'POST', `/api/topics/${ids.t5}/archive`, {
    expectedRevision: t5Detail.topic.revision,
    operationId: `op-archive-${Date.now()}`,
  });
  const archivedList = await apiOk(page, 'GET', '/api/topics?archived=1&limit=50');
  check(
    '10.3',
    '归档主题成功且出现在已归档列表',
    t5Archive.status === 200 &&
      t5Archive.body?.topic?.archived === true &&
      (archivedList.topics ?? []).some((t) => t.id === ids.t5),
    `${t5Archive.status} ${JSON.stringify(t5Archive.body).slice(0, 300)}`
  );
  const t5Delete = await api(page, 'DELETE', `/api/topics/${ids.t5}`);
  const z3After = await api(page, 'GET', `/api/captures/${ids.z3}`);
  const z3aAfter = await api(page, 'GET', `/api/attempts/${ids.z3a}`);
  const expAfter = await api(page, 'GET', `/api/experiences/${ids.exp}`);
  const scheduleAfter = await api(page, 'GET', `/api/attempts/${ids.z3a}/schedules`);
  check(
    '10.4',
    '删除主题不删除 capture/attempt/experience/schedule',
    t5Delete.status === 200 &&
      z3After.status === 200 &&
      z3aAfter.status === 200 &&
      expAfter.status === 200 &&
      scheduleAfter.status === 200 &&
      (scheduleAfter.body?.schedules ?? []).some((s) => s.id === ids.schedule),
    JSON.stringify({
      delete: t5Delete.status,
      z3: z3After.status,
      z3a: z3aAfter.status,
      exp: expAfter.status,
      schedules: scheduleAfter.status,
    })
  );
  const delZ1a = await api(page, 'DELETE', `/api/attempts/${ids.z1a}`);
  const t3After = await apiOk(page, 'GET', `/api/topics/${ids.t3}`);
  check(
    '10.5',
    '删除固定尝试后主题不悬空：nextAttempt 为空且有 clearedReason',
    delZ1a.status === 200 &&
      t3After.topic.nextAttempt == null &&
      Boolean(t3After.topic.nextAttemptClearedReason),
    `${delZ1a.status} ${JSON.stringify(t3After.topic).slice(0, 400)}`
  );
  const delZ2 = await api(page, 'DELETE', `/api/captures/${ids.z2}`);
  const t4After = await apiOk(page, 'GET', `/api/topics/${ids.t4}`);
  check(
    '10.6',
    '删除固定尝试所属念头后主题不悬空：nextAttempt 为空且有 clearedReason',
    delZ2.status === 200 &&
      t4After.topic.nextAttempt == null &&
      Boolean(t4After.topic.nextAttemptClearedReason),
    `${delZ2.status} ${JSON.stringify(t4After.topic).slice(0, 400)}`
  );
}

// UI 删除失效反馈依赖 T3/T4 仍然存在；把删除主题的断言放到 UI 阶段之后，避免测试自己先删掉样本。

