// 拾念 SHINIAN · 「问我的记录」浏览器端到端验收（QA 独立版）
// Chrome 无头，1280×900 与 390×844。
//
// 前置：
//   1) 目标服务已启动（默认 http://127.0.0.1:3212），使用独立库 db/ask-e2e.sqlite；
//   2) fake_model_server.py 已启动（默认 http://127.0.0.1:3501，含 fake-ask* 模型）；
//   3) 已执行 npm run build（脚本只检查 dist/client/index.html，不自动构建）。
// 推荐直接运行 scripts/run_ask_e2e_acceptance.ps1（一键拉起隔离服务 + 假模型并清理）。
//
// 数据全部通过 API 种子：A/A1、B/B1（引用 A1）、D（A→D capture_links）、E/E1（关键词干扰）、F/F1（无关）。
//
// 断言口径：若 UI 尚未实现某项需求，脚本按需求断言并如实 FAIL，不绕过、不改源码。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3212').replace(/\/+$/, '');
const FAKE = (process.env.SHINIAN_FAKE_BASE || 'http://127.0.0.1:3501').replace(/\/+$/, '');
const CHROME =
  process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const DB = process.env.SHINIAN_DB || process.env.DATABASE_URL || 'db/ask-e2e.sqlite';
const USER = `问答验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-ask-key';

const A_TEXT = 'LED 调光实验：低占空比时闪烁，先记录现象与条件';
const A1_STEP = '把 PWM 频率从 500 Hz 提到 2 kHz';
const A1_RESULT = '2 kHz、20% 占空比、5V USB 供电时，肉眼闪烁明显减轻。';
const B_TEXT = '后续对照实验记录';
const B1_STEP = '沿用上次参数复测';
const B1_RESULT = '肉眼几乎看不到变化；这次没有单独改供电。';
const D_TEXT = '电源噪声与调光稳定性';
const E_TEXT = 'LED 灯带收纳盒';
const E1_STEP = '整理 LED 灯带包装';
const E1_RESULT = '盒子放在抽屉第二层';
const F_TEXT = '周末整理相机照片';
const F1_STEP = '筛选十张照片';
const F1_RESULT = '挑了十张海边照片';
const QUESTION = '上次 LED 闪烁是怎么处理的';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const failures = [];
const todos = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`.trim());
    console.log(`FAIL  ${name}  ${detail}`);
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
  await sleep(300);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true });
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

async function setAiConfig(page, modelId) {
  return api(page, 'PUT', '/api/settings/ai', {
    name: '问答假模型',
    baseUrl: `${FAKE}/v1`,
    modelId,
    enabled: true,
    allowLocal: true,
    apiKey: KEY,
  });
}

async function fakeLastRecord() {
  const res = await fetch(`${FAKE}/__last`);
  const body = await res.json();
  return body?.request ?? null;
}

async function sourceCardTexts(page) {
  return page.$$eval('[data-testid="ask-source-card"]', (els) => els.map((el) => el.innerText));
}

async function findSourceCard(page, substr) {
  const handles = await page.$$('[data-testid="ask-source-card"]');
  for (const handle of handles) {
    const text = await handle.evaluate((el) => el.innerText);
    if (text.includes(substr)) return handle;
  }
  return null;
}

async function candidateTexts(page) {
  return page.$$eval('[data-testid="ask-candidate"]', (els) => els.map((el) => el.innerText));
}

async function selectedCount(page) {
  return page.$$eval(
    '[data-testid="ask-candidate-pick"]',
    (els) => els.filter((el) => el.checked).length
  );
}

/** 把某条候选的复选框设为指定状态；返回是否找到该候选。 */
async function setCandidateSelected(page, substr, want) {
  const handles = await page.$$('[data-testid="ask-candidate"]');
  for (const handle of handles) {
    const text = await handle.evaluate((el) => el.innerText);
    if (!text.includes(substr)) continue;
    const box = await handle.$('[data-testid="ask-candidate-pick"]');
    if (!box) return false;
    const checked = await box.evaluate((el) => el.checked);
    if (checked !== want) {
      await box.click();
      await sleep(180);
    }
    return true;
  }
  return false;
}

/** 只保留 wanted 指定的候选被勾选（其余全部取消）。 */
async function selectOnly(page, wanted) {
  const handles = await page.$$('[data-testid="ask-candidate"]');
  for (const handle of handles) {
    const text = await handle.evaluate((el) => el.innerText);
    const should = wanted.some((item) => text.includes(item));
    const box = await handle.$('[data-testid="ask-candidate-pick"]');
    if (!box) continue;
    const checked = await box.evaluate((el) => el.checked);
    if (checked !== should) {
      await box.click();
      await sleep(120);
    }
  }
}

/** 找到候选卡片里的展开/预览控件（兼容 testid 与中文按钮文案）。 */
async function findExpandControl(candidateHandle) {
  const direct = await candidateHandle.$(
    '[data-testid="ask-candidate-preview"], [data-testid="ask-candidate-expand"], [data-testid="ask-candidate-toggle"], [aria-expanded]'
  );
  if (direct) return direct;
  const buttons = await candidateHandle.$$('button');
  for (const button of buttons) {
    const text = await button.evaluate((el) => (el.textContent || '').trim());
    if (/展开|预览|详情/.test(text)) return button;
  }
  return null;
}

async function search(page, question, keywords) {
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await fill(page, '[data-testid="ask-question-input"]', question);
  if (keywords !== undefined) {
    await fill(page, '[data-testid="ask-keywords-input"]', keywords);
  }
  await page.click('[data-testid="ask-search-btn"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="ask-candidate"]') ||
      document.querySelector('[data-testid="ask-empty"]'),
    { timeout: 30000 }
  );
  await sleep(300);
}

/** 通过 API 预览 + 创建问答，并轮询到完成态；返回 AskPublic。 */
async function apiCreateQuery(page, { question, keywords, sourceKeys }) {
  return page.evaluate(
    async ({ question: q, keywords: k, sourceKeys: keys }) => {
      const previewRes = await fetch('/api/ask/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, keywords: k, sourceKeys: keys }),
      });
      const preview = await previewRes.json();
      if (!previewRes.ok) {
        return { error: 'preview', status: previewRes.status, body: preview };
      }
      const createdRes = await fetch('/api/ask/queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          keywords: k,
          sourceKeys: keys,
          contextToken: preview.contextToken,
          operationId: `e2e-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }),
      });
      const created = await createdRes.json();
      if (!createdRes.ok) {
        return { error: 'create', status: createdRes.status, body: created };
      }
      let query = created.query;
      const deadline = Date.now() + 25000;
      while (query.status === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const pollRes = await fetch(`/api/ask/queries/${query.id}`);
        const poll = await pollRes.json();
        query = poll.query;
      }
      return { query };
    },
    { question, keywords, sourceKeys }
  );
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

console.log('='.repeat(64));
console.log('「问我的记录」浏览器端到端验收（QA 独立版）');
console.log(`BASE = ${BASE}`);
console.log(`DB   = ${DB}`);
console.log(`FAKE = ${FAKE}`);
console.log(`SHOTS= ${path.resolve(SHOT_DIR)}`);
console.log('='.repeat(64));

if (!fs.existsSync('dist/client/index.html')) {
  console.error('缺少 dist/client/index.html：请先执行 npm run build，再运行本验收。');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
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
let savedQueryId = null;

try {
  console.log('\n— 登录与模型配置');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await fill(page, '.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  check('本机登录成功', true);

  const ai = await setAiConfig(page, 'fake-ask');
  check(
    '配置 fake-ask（3501 / allowLocal / test-ask-key）',
    ai.status === 200,
    JSON.stringify(ai.body).slice(0, 200)
  );

  console.log('\n— 通过 API 种入固定场景');
  ids = await page.evaluate(
    async ({
      A_TEXT: aText,
      A1_STEP: a1Step,
      A1_RESULT: a1Result,
      B_TEXT: bText,
      B1_STEP: b1Step,
      B1_RESULT: b1Result,
      D_TEXT: dText,
      E_TEXT: eText,
      E1_STEP: e1Step,
      E1_RESULT: e1Result,
      F_TEXT: fText,
      F1_STEP: f1Step,
      F1_RESULT: f1Result,
    }) => {
      const unique = () => Math.random().toString(36).slice(2, 10);
      async function request(url, method, body) {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
        }
        return json;
      }
      async function createCapture(rawText) {
        const res = await request('/api/captures', 'POST', { rawText });
        return res.capture.id;
      }
      async function createAttempt(captureId, step, result, outcome, observedAt) {
        const created = await request(`/api/captures/${captureId}/attempts`, 'POST', {
          step,
          operationId: `e2e-att-${unique()}`,
        });
        const row = created.attempt;
        const updated = await request(`/api/attempts/${row.id}`, 'PATCH', {
          state: 'done',
          resultText: result,
          outcome,
          observedAt,
          revision: row.revision,
        });
        return updated.attempt;
      }

      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

      const a = await createCapture(aText);
      const a1 = await createAttempt(a, a1Step, a1Result, 'success', tenDaysAgo);
      const b = await createCapture(bText);
      const b1 = await createAttempt(b, b1Step, b1Result, 'undetermined', threeDaysAgo);
      const d = await createCapture(dText);
      const e = await createCapture(eText);
      const e1 = await createAttempt(
        e,
        e1Step,
        e1Result,
        'success',
        Date.now() - 20 * 24 * 60 * 60 * 1000
      );
      const f = await createCapture(fText);
      const f1 = await createAttempt(
        f,
        f1Step,
        f1Result,
        'success',
        Date.now() - 30 * 24 * 60 * 60 * 1000
      );

      await request(`/api/attempts/${b1.id}/references`, 'POST', {
        toId: a1.id,
        note: '沿用上次的 2 kHz 观察',
        operationId: `e2e-ref-${unique()}`,
      });
      await request(`/api/captures/${a}/links`, 'POST', {
        toCaptureId: d,
        note: '同一组调光观察',
        operationId: `e2e-link-${unique()}`,
      });

      return {
        a,
        a1: a1.id,
        b,
        b1: b1.id,
        d,
        e,
        e1: e1.id,
        f,
        f1: f1.id,
      };
    },
    {
      A_TEXT,
      A1_STEP,
      A1_RESULT,
      B_TEXT,
      B1_STEP,
      B1_RESULT,
      D_TEXT,
      E_TEXT,
      E1_STEP,
      E1_RESULT,
      F_TEXT,
      F1_STEP,
      F1_RESULT,
    }
  );
  check(
    '种子数据创建完成（A/A1、B/B1、D、E/E1、F/F1）',
    Boolean(
      ids?.a &&
        ids?.a1 &&
        ids?.b &&
        ids?.b1 &&
        ids?.d &&
        ids?.e &&
        ids?.e1 &&
        ids?.f &&
        ids?.f1
    ),
    JSON.stringify(ids)
  );

  const refs = await api(page, 'GET', `/api/attempts/${ids.a1}/references`);
  const refsText = JSON.stringify(refs.body ?? {});
  check('种子关系已建立（B1→A1 引用、A→D 念头链接）', refsText.includes(ids.b1), refsText.slice(0, 240));
  const links = await api(page, 'GET', `/api/captures/${ids.a}/links`);
  check(
    'A→D capture_links 已建立',
    (links.body?.out ?? []).some((item) => item.toCaptureId === ids.d),
    JSON.stringify(links.body?.counts ?? links.body).slice(0, 200)
  );

  console.log('\n— 1) 检索：直接命中与关系扩展');
  await search(page, QUESTION);
  const keywordValue = await page.$eval('[data-testid="ask-keywords-input"]', (el) => el.value);
  console.log(`      实际检索关键词：${keywordValue || '(空 / 浏览模式)'}`);
  let texts = await candidateTexts(page);
  console.log(`      候选 ${texts.length} 条：${texts.map((t) => t.split('\n')[0]).join(' | ')}`);

  check('打开 /ask 并展示候选列表', texts.length > 0, String(texts.length));
  check('直接命中念头 A', texts.some((t) => t.includes(A_TEXT)));
  check('直接命中尝试 A1', texts.some((t) => t.includes(A1_STEP)));
  const b1Text = texts.find((t) => t.includes(B1_STEP)) ?? '';
  const dText = texts.find((t) => t.includes(D_TEXT)) ?? '';
  check(
    '关系组包含 B1（被 A1 引用）',
    Boolean(b1Text) && /引用关系|引用/.test(b1Text),
    b1Text.slice(0, 160)
  );
  check(
    '关系组包含 D（通过念头链接）',
    Boolean(dText) && /关联|链接|关系/.test(dText),
    dText.slice(0, 160)
  );
  check('E 命中关键词但为无关候选（可排除）', texts.some((t) => t.includes(E1_STEP) || t.includes(E_TEXT)));
  check(
    'F 完全无关，不出现在候选中',
    !texts.some((t) => t.includes(F_TEXT) || t.includes(F1_STEP) || t.includes(F1_RESULT))
  );

  // 关系组按 data-testid 直接断言（matchKind 由 UI 分为 direct / relation 两组）。
  const directGroupText = await page
    .$eval('[data-testid="ask-group-direct"]', (el) => el.innerText)
    .catch(() => null);
  const relationGroupText = await page
    .$eval('[data-testid="ask-group-relation"]', (el) => el.innerText)
    .catch(() => null);
  check(
    '直接命中组（ask-group-direct）包含 A 与 A1',
    Boolean(directGroupText) && directGroupText.includes(A_TEXT) && directGroupText.includes(A1_STEP),
    (directGroupText ?? '(无 ask-group-direct)').slice(0, 200)
  );
  check(
    '关系组（ask-group-relation）包含 B1 与 D',
    Boolean(relationGroupText) && relationGroupText.includes(B1_STEP) && relationGroupText.includes(D_TEXT),
    (relationGroupText ?? '(无 ask-group-relation)').slice(0, 200)
  );
  await shot(page, 'ask-01-candidates-desktop.png');

  console.log('\n— 2) 候选展开预览、勾选/移除与发送预览');
  const candidates = await page.$$('[data-testid="ask-candidate"]');
  const expandable = [];
  for (const handle of candidates) {
    expandable.push((await findExpandControl(handle)) !== null);
  }
  check(
    '每个候选都有展开预览入口',
    expandable.length > 0 && expandable.every(Boolean),
    `${expandable.filter(Boolean).length}/${expandable.length}`
  );

  let expandOpened = false;
  const firstExpand = candidates[0] ? await findExpandControl(candidates[0]) : null;
  if (firstExpand) {
    await firstExpand.click();
    await sleep(500);
    expandOpened = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="ask-candidate-expanded"]');
      return Boolean(panel && panel.offsetParent !== null && (panel.innerText || '').trim().length > 0);
    });
  }
  check('候选可展开预览内容', expandOpened, firstExpand ? '面板未出现' : '无展开控件');

  // 先确保 E/E1 被选中，再取消，验证「勾选 / 移除」都可用。
  await setCandidateSelected(page, E1_STEP, true);
  await setCandidateSelected(page, E_TEXT, true);
  const eSelected = await page.evaluate(
    ({ e1, e }) => {
      const items = [...document.querySelectorAll('[data-testid="ask-candidate"]')];
      const find = (s) => items.find((el) => (el.innerText || '').includes(s));
      const box = (el) => el?.querySelector('[data-testid="ask-candidate-pick"]');
      return Boolean(box(find(e1))?.checked && box(find(e))?.checked);
    },
    { e1: E1_STEP, e: E_TEXT }
  );
  check('可勾选 E/E1 候选', eSelected);

  await setCandidateSelected(page, E1_STEP, false);
  await setCandidateSelected(page, E_TEXT, false);
  const eUnselected = await page.evaluate(
    ({ e1, e }) => {
      const items = [...document.querySelectorAll('[data-testid="ask-candidate"]')];
      const find = (s) => items.find((el) => (el.innerText || '').includes(s));
      const box = (el) => el?.querySelector('[data-testid="ask-candidate-pick"]');
      return Boolean(!box(find(e1))?.checked && !box(find(e))?.checked);
    },
    { e1: E1_STEP, e: E_TEXT }
  );
  check('可取消 E/E1 候选', eUnselected);

  await selectOnly(page, [A1_STEP, B1_STEP, D_TEXT]);
  const pickedCount = await selectedCount(page);
  check('仅保留 A1/B1/D 三条证据', pickedCount === 3, `已选 ${pickedCount} 条`);

  await page.click('[data-testid="ask-preview"]');
  await page.waitForSelector('[data-testid="ask-preview-panel"]', { timeout: 20000 });
  const previewRecords = await page.$$eval('[data-testid="ask-preview-record"]', (els) =>
    els.map((el) => el.innerText)
  );
  const previewText = await page.$eval('[data-testid="ask-preview-panel"]', (el) => el.innerText);
  check('发送预览记录数与勾选一致', previewRecords.length === 3, String(previewRecords.length));
  check(
    '预览包含 A1/B1/D 正文',
    previewRecords.some((t) => t.includes(A1_STEP) && t.includes(A1_RESULT)) &&
      previewRecords.some((t) => t.includes(B1_STEP) && t.includes(B1_RESULT)) &&
      previewRecords.some((t) => t.includes(D_TEXT)),
    previewRecords.map((t) => t.slice(0, 40)).join(' | ')
  );
  check(
    '预览不含 E/E1/F 文本',
    !previewText.includes(E_TEXT) &&
      !previewText.includes(E1_STEP) &&
      !previewText.includes(E1_RESULT) &&
      !previewText.includes(F_TEXT) &&
      !previewText.includes(F1_STEP) &&
      !previewText.includes(F1_RESULT)
  );
  await shot(page, 'ask-02-preview-desktop.png');

  console.log('\n— 3) 生成回答、来源 chip 与来源卡片');
  await page.click('[data-testid="ask-generate-btn"]');
  // 新版 UI 为两步确认：先「核对无误，准备发送」，再「确认发送并生成」。
  const confirmSend = await page
    .waitForSelector('[data-testid="ask-confirm-send"]', { timeout: 5000 })
    .catch(() => null);
  if (confirmSend) await confirmSend.click();
  await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 60000 });
  const answerText = await page.$eval('[data-testid="ask-answer"]', (el) => el.innerText);
  check('回答出现并展示摘要', answerText.length > 20, answerText.slice(0, 120));
  const observationChips = await page.$$eval(
    '[data-testid="ask-point-observation"] .ask-source-chip',
    (els) => els.length
  );
  check('至少一个 observation point 带来源 chip', observationChips > 0, String(observationChips));
  const answerSourceCards = (await sourceCardTexts(page)).length;
  check('来源卡片数匹配已发送记录数', answerSourceCards === 3, String(answerSourceCards));
  await shot(page, 'ask-03-answer-desktop.png');

  const queryHref = await page
    .$eval('.ask-query-links a[href^="/ask/"]', (el) => el.getAttribute('href'))
    .catch(() => null);
  savedQueryId = queryHref ? queryHref.split('/').pop() : null;
  if (!savedQueryId) {
    const recent = await api(page, 'GET', '/api/ask/queries?limit=5');
    const match = (recent.body?.queries ?? []).find(
      (item) => item.question === QUESTION && item.status === 'succeeded'
    );
    savedQueryId = match?.id ?? null;
  }
  check('可定位本次已保存的问答 ID', Boolean(savedQueryId), String(savedQueryId));

  console.log('\n— 4) 打开原记录、返回恢复、局部图');
  let card = await findSourceCard(page, A1_STEP);
  check('来源卡片可定位 A1', Boolean(card));
  if (card) {
    const openLink = await card.$('[data-testid="ask-open-source"]');
    check('来源卡片提供「打开原记录」', Boolean(openLink));
    if (openLink) {
      await openLink.click();
      await page.waitForFunction(
        (id) => location.pathname === `/attempt/${id}`,
        { timeout: 20000 },
        ids.a1
      );
      check('打开原记录进入 /attempt/<A1>', page.url().includes(`/attempt/${ids.a1}`), page.url());
      await page.goBack();
      await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
      await sleep(600);

      const questionRestored = await page
        .$eval('[data-testid="ask-question-input"]', (el) => el.value)
        .catch(() => '');
      check('返回 /ask 后问题仍在', questionRestored.includes('LED'), questionRestored);
      const answerRestored = await page
        .waitForSelector('[data-testid="ask-answer"]', { timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (!answerRestored) {
        todo(
          '返回后恢复回答',
          '当前 UI 未用 sessionStorage 保存问答状态，返回后回答丢失（需实现后此断言才会 PASS）'
        );
      }
      check('返回 /ask 后回答仍在（sessionStorage）', answerRestored);
      const a1Selected = await page.evaluate((step) => {
        const item = [...document.querySelectorAll('[data-testid="ask-candidate"]')].find((el) =>
          (el.innerText || '').includes(step)
        );
        return Boolean(item?.querySelector('[data-testid="ask-candidate-pick"]')?.checked);
      }, A1_STEP);
      check('返回 /ask 后已选证据至少含 A1', a1Selected);
    }
  }

  // 详情页始终展示回答，后续来源操作从详情页进行（列表页无持久状态时也能继续）。
  await page.goto(`${BASE}/ask/${savedQueryId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 20000 });
  card = await findSourceCard(page, A1_STEP);
  check('详情页来源卡片可定位 A1', Boolean(card));
  if (card) {
    const graphLink = await card.$('[data-testid="ask-graph-link"]');
    check('来源卡片提供「在局部图中查看」', Boolean(graphLink));
    if (graphLink) {
      const label = await graphLink.evaluate((el) => (el.textContent || '').trim());
      check('局部图入口文案为「在网络中查看」或「在局部图中查看」', label.includes('网络') || label.includes('局部图'), label);
      await graphLink.click();
      await page.waitForFunction(() => location.pathname === '/graph', { timeout: 20000 });
      const graphUrl = page.url();
      check('「在局部图中查看」使用 /graph?node=', /[?&]node=/.test(graphUrl), graphUrl);
      const focusBar = await page
        .waitForSelector('.graph-focus-bar', { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      const barText = focusBar ? await page.$eval('.graph-focus-bar', (el) => el.innerText) : '';
      check('局部关系条出现且中心是 A1', focusBar && barText.includes(A1_STEP), barText);
      await shot(page, 'ask-04-graph-focus.png');
      await page.goBack();
      await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 20000 });
    }
  }

  console.log('\n— 5) 用这条经验试一步（不自动创建尝试）');
  card = await findSourceCard(page, A1_STEP);
  if (card) {
    const reuseLink = await card.$('[data-testid="ask-reuse-link"]');
    check('来源卡片提供「用这条经验试一步」', Boolean(reuseLink));
    if (reuseLink) {
      await reuseLink.click();
      await page.waitForFunction(
        ({ cap, att }) =>
          location.pathname === `/capture/${cap}` &&
          new URLSearchParams(location.search).get('experience') === att,
        { timeout: 20000 },
        { cap: ids.a, att: ids.a1 }
      );
      check(
        '进入 /capture/<A>?experience=<A1>',
        page.url().includes(`/capture/${ids.a}`) && page.url().includes(`experience=${ids.a1}`),
        page.url()
      );
      const previewShown = await page
        .waitForSelector('.experience-preview, .experience-select-panel', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      const pageText = await page.evaluate(() => document.body.innerText);
      check(
        '出现旧经验预览且带 A1 结果',
        previewShown && (pageText.includes(A1_RESULT) || pageText.includes('参考的旧经验')),
        pageText.slice(0, 160)
      );
      const attempts = await api(page, 'GET', `/api/captures/${ids.a}/attempts`);
      check(
        '打开旧经验预览不会自动创建尝试',
        (attempts.body?.attempts ?? []).length === 1,
        String((attempts.body?.attempts ?? []).length)
      );
    }
  }

  console.log('\n— 6) 手机 390×844：候选页与证据选择');
  await setViewport(page, 390, 844, 2);
  await search(page, QUESTION);
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  check('手机候选页无横向溢出', !mobileOverflow);
  await shot(page, 'ask-mobile-candidates.png');

  const mobileBoxes = await page.$$('[data-testid="ask-candidate-pick"]');
  check('手机候选页 checkbox 可点', mobileBoxes.length > 0, String(mobileBoxes.length));
  let uncheckedOne = false;
  let checkedOne = false;
  if (mobileBoxes.length > 0) {
    const before = await selectedCount(page);
    const firstChecked = await page.evaluateHandle(() =>
      [...document.querySelectorAll('[data-testid="ask-candidate-pick"]')].find((el) => el.checked)
    );
    const firstCheckedEl = firstChecked.asElement();
    if (firstCheckedEl) {
      await firstCheckedEl.click();
      await sleep(200);
      const afterUncheck = await selectedCount(page);
      uncheckedOne = afterUncheck === before - 1;
    }
    const firstUnchecked = await page.evaluateHandle(() =>
      [...document.querySelectorAll('[data-testid="ask-candidate-pick"]')].find((el) => !el.checked)
    );
    const firstUncheckedEl = firstUnchecked.asElement();
    if (firstUncheckedEl) {
      await firstUncheckedEl.click();
      await sleep(200);
      const afterCheck = await selectedCount(page);
      checkedOne = afterCheck >= 1;
    } else {
      checkedOne = (await selectedCount(page)) >= 1;
    }
  }
  check('手机端至少取消一条证据', uncheckedOne);
  check('手机端至少勾选一条证据', checkedOne);
  check(
    '手机端「核对发送内容」按钮可点',
    await page.$eval('[data-testid="ask-preview"]', (el) => !el.disabled)
  );
  await page.click('[data-testid="ask-preview"]');
  const mobilePreview = await page
    .waitForSelector('[data-testid="ask-preview-panel"]', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('手机端可打开发送预览', mobilePreview);
  const mobilePreviewOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  check('手机预览面板无横向溢出', !mobilePreviewOverflow);

  console.log('\n— 7) 负面场景');
  await setViewport(page, 1280, 900);
  const lastBefore = await fakeLastRecord();
  const queriesBefore = await api(page, 'GET', '/api/ask/queries?limit=50');
  await search(page, '请帮我找量子拓扑绝缘体的实验记录', '量子拓扑绝缘体');
  const emptyShown = await page.$('[data-testid="ask-empty"]');
  check('无匹配查询显示空态', Boolean(emptyShown));
  await sleep(1200);
  const lastAfter = await fakeLastRecord();
  const queriesAfter = await api(page, 'GET', '/api/ask/queries?limit=50');
  const emptyLeaked = JSON.stringify(lastAfter?.body ?? {}).includes('量子拓扑绝缘体');
  check(
    '无匹配查询不触发模型请求',
    !emptyLeaked,
    `${lastBefore?.receivedAt ?? 'null'} -> ${lastAfter?.receivedAt ?? 'null'}`
  );
  check(
    '无匹配查询不创建问答任务',
    (queriesBefore.body?.queries ?? []).length === (queriesAfter.body?.queries ?? []).length,
    `${(queriesBefore.body?.queries ?? []).length} -> ${(queriesAfter.body?.queries ?? []).length}`
  );

  // 来源更新：修改 A1 后，已保存问答详情应标记「来源有更新」
  const a1Before = await api(page, 'GET', `/api/attempts/${ids.a1}`);
  const a1Row = a1Before.body?.attempt;
  if (a1Row) {
    const patched = await api(page, 'PATCH', `/api/attempts/${ids.a1}`, {
      state: 'done',
      resultText: `${A1_RESULT}（补充：环境亮度未变）`,
      outcome: 'success',
      observedAt: a1Row.observedAt,
      revision: a1Row.revision,
    });
    check('来源更新请求成功', patched.status === 200, String(patched.status));
  }
  await page.goto(`${BASE}/ask/${savedQueryId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-source-card"]', { timeout: 20000 });
  const updatedText = await page.evaluate(() => document.body.innerText);
  check('来源更新后 /ask/:id 显示「来源有更新」', updatedText.includes('来源有更新'));

  // 来源删除：用 F1 创建一条独立问答，再删除来源，详情应显示已删除且不回显正文
  const fQuery = await apiCreateQuery(page, {
    question: '这条照片整理记录做了什么',
    keywords: '照片',
    sourceKeys: [`attempt:${ids.f1}`],
  });
  check(
    '可创建用于删除场景的问答',
    Boolean(fQuery?.query?.id),
    JSON.stringify(fQuery).slice(0, 200)
  );
  if (fQuery?.query?.id) {
    const del = await api(page, 'DELETE', `/api/attempts/${ids.f1}`);
    check('删除来源尝试成功', del.status === 200, String(del.status));
    await page.goto(`${BASE}/ask/${fQuery.query.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="ask-source-card"]', { timeout: 20000 });
    const deletedCards = await sourceCardTexts(page);
    const pageText = await page.evaluate(() => document.body.innerText);
    check('来源删除后显示「来源已删除」', pageText.includes('来源已删除'));
    check(
      '来源删除后来源卡片不显示正文',
      deletedCards.every((text) => !text.includes(F1_RESULT) && !text.includes(F1_STEP)),
      deletedCards.join(' | ').slice(0, 200)
    );
  }

  // 伪造 sourceId：格式非法必须 400 invalid_sources
  const forged = await api(page, 'POST', '/api/ask/preview', {
    question: '伪造来源测试',
    keywords: 'LED',
    sourceKeys: ['attempt:bad id/<script>'],
  });
  check(
    '伪造 sourceId preview 返回 400 invalid_sources',
    forged.status === 400 && forged.body?.error === 'invalid_sources',
    `${forged.status} ${JSON.stringify(forged.body).slice(0, 160)}`
  );
  const missing = await api(page, 'POST', '/api/ask/preview', {
    question: '不存在来源测试',
    keywords: 'LED',
    sourceKeys: ['attempt:att-not-exist-e2e'],
  });
  check(
    '不存在的合法 sourceId 返回 409 sources_unavailable',
    missing.status === 409 && missing.body?.error === 'sources_unavailable',
    `${missing.status} ${JSON.stringify(missing.body).slice(0, 160)}`
  );

  // 模型返回非法 JSON：任务失败，但来源仍展示、可浏览
  const badConfig = await setAiConfig(page, 'fake-ask-invalid-json');
  check('切换到 fake-ask-invalid-json', badConfig.status === 200, String(badConfig.status));
  const badQuery = await apiCreateQuery(page, {
    question: '闪烁那次记录了什么结果',
    keywords: '闪烁',
    sourceKeys: [`attempt:${ids.a1}`],
  });
  check(
    'invalid-json 任务进入失败态',
    badQuery?.query?.status === 'failed',
    `${badQuery?.query?.status} ${badQuery?.query?.errorCode ?? ''}`
  );
  if (badQuery?.query?.id) {
    await page.goto(`${BASE}/ask/${badQuery.query.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="ask-source-card"]', { timeout: 20000 }).catch(() => {});
    const failText = await page.evaluate(() => document.body.innerText);
    const failCards = await sourceCardTexts(page);
    check('生成失败仍显示失败说明', /没有完成|生成失败/.test(failText), failText.slice(0, 160));
    check(
      '生成失败仍显示来源且可浏览',
      failCards.length >= 1 && failCards.some((text) => text.includes(A1_STEP)),
      String(failCards.length)
    );
  }

  console.log('\n— 8) 密钥不外泄');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check('浏览器本地存储不含 API Key', !storage.includes(KEY));
  check(
    '页面 DOM 不含明文 API Key',
    !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-ask-key')))
  );
} catch (err) {
  failed += 1;
  failures.push(String(err && err.stack ? err.stack.split('\n')[0] : err));
  console.error('E2E ERROR:', err);
  await shot(page, 'ask-error.png').catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`RESULT ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const item of failures) console.log(`  - ${item}`);
}
if (todos.length) {
  console.log('TODO（UI 尚未实现，脚本按需求断言并失败）:');
  for (const item of todos) console.log(`  - ${item}`);
}
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
