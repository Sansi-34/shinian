// 拾念 SHINIAN · 「问我的记录」浏览器端到端验收（Chrome 无头，1280×900 与 390×844）
//
// 前置服务：
//   1) 目标服务已启动：默认 http://127.0.0.1:3201，独立库 db/e2e-ask.sqlite；
//   2) fake_model_server.py 已启动：默认 http://127.0.0.1:3501（含 fake-ask* 场景）；
//   3) 已构建 dist/client（本脚本不执行 npm run build）。
// 一键运行：scripts/run_e2e_ask.ps1（默认 3201 / 3501，隔离数据库并清理进程）。
//
// 交互按当前 AskPage 实现：检索 → 清空默认选择 → 勾两条 → 核对 → 「准备发送」→
// 「确认发送并生成」→ 回答/来源 → 打开原记录 → /ask/:id 详情 → 复用旧经验 →
// 编辑采用 → 手机 390 宽度无横向溢出。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3201').replace(/\/+$/, '');
const FAKE = (process.env.SHINIAN_FAKE_BASE || 'http://127.0.0.1:3501').replace(/\/+$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `问记录验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-secret-key';

const CAP1 = '问记录验收念头 A：PWM 调光时 LED 会闪';
const CAP2 = '问记录验收念头 B：想避免肉眼可见闪烁';
const STEP1 = '把 PWM 频率设为 500 Hz 调光';
const STEP2 = '把 PWM 频率改到 2 kHz 再调光';
const RESULT1 = '500 Hz 时仍有可见闪烁，这次调光失败';
const RESULT2 = '2 kHz 时肉眼几乎不可见，未再闪烁';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((el) => el.textContent || '');
    if (t.trim().includes(text)) {
      await h.click();
      return true;
    }
  }
  return false;
}

async function waitText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
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
  await new Promise((r) => setTimeout(r, 300));
}

function hrefOf(page, selector) {
  return page.$eval(selector, (el) => el.getAttribute('href'));
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

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

try {
  console.log('— 登录与模型配置');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await fill(page, '.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });

  const saved = await page.evaluate(
    async (baseUrl) => {
      const res = await fetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '问记录假模型',
          baseUrl: `${baseUrl}/v1`,
          modelId: 'fake-ask',
          enabled: true,
          allowLocal: true,
          apiKey: 'test-secret-key',
        }),
      });
      return res.status;
    },
    FAKE
  );
  check('配置问答假模型 fake-ask', saved === 200, String(saved));

  console.log('— 用 API 准备实际记录（2 个念头 / 2 个结果 / 1 条引用）');
  const ids = await page.evaluate(
    async ({ cap1, cap2, step1, step2, result1, result2 }) => {
      async function req(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
        return data;
      }
      const stamp = Date.now();
      const c1 = (await req('POST', '/api/captures', { rawText: cap1 })).capture;
      const a1 = (
        await req('POST', `/api/captures/${c1.id}/attempts`, {
          step: step1,
          state: 'todo',
          operationId: `e2e-ask-a1-${stamp}`,
        })
      ).attempt;
      const a1r = (
        await req('PATCH', `/api/attempts/${a1.id}`, {
          resultText: result1,
          outcome: 'failure',
          revision: a1.revision,
        })
      ).attempt;
      const c2 = (await req('POST', '/api/captures', { rawText: cap2 })).capture;
      const a2 = (
        await req('POST', `/api/captures/${c2.id}/attempts`, {
          step: step2,
          state: 'todo',
          operationId: `e2e-ask-a2-${stamp}`,
        })
      ).attempt;
      const a2r = (
        await req('PATCH', `/api/attempts/${a2.id}`, {
          resultText: result2,
          outcome: 'success',
          revision: a2.revision,
        })
      ).attempt;
      await req('POST', `/api/attempts/${a2r.id}/references`, {
        toId: a1r.id,
        note: '问记录验收：2 kHz 基于 500 Hz 的失败继续验证',
        operationId: `e2e-ask-ref-${stamp}`,
      });
      return { c1: c1.id, c2: c2.id, a1: a1r.id, a2: a2r.id };
    },
    { cap1: CAP1, cap2: CAP2, step1: STEP1, step2: STEP2, result1: RESULT1, result2: RESULT2 }
  );
  check(
    'API 创建 2 个念头、2 个有结果尝试与 1 条引用',
    Boolean(ids.a1 && ids.a2 && ids.c1 && ids.c2),
    JSON.stringify(ids)
  );

  console.log('— 进入问答页并检索');
  await page.goto(BASE + '/ask', { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  check('顶部导航或首页入口可进入 /ask', await page.evaluate(() => !!document.querySelector('a[href="/ask"]')));
  await fill(page, '[data-testid="ask-question-input"]', 'PWM 闪烁');
  await page.click('[data-testid="ask-search-btn"]');
  await page.waitForSelector('[data-testid="ask-candidate"]', { timeout: 25000 });
  await waitText(page, '候选记录');

  const candidateTexts = await page.$$eval('[data-testid="ask-candidate"]', (els) =>
    els.map((el) => el.innerText)
  );
  check(
    '检索结果包含两条尝试候选',
    candidateTexts.some((t) => t.includes(STEP1)) && candidateTexts.some((t) => t.includes(STEP2)),
    String(candidateTexts.length)
  );
  check(
    '候选显示类型/日期/摘要',
    candidateTexts.some(
      (t) => t.includes('尝试') && /(结果时间|记录时间)：/.test(t) && (t.includes('闪烁') || t.includes('PWM'))
    ),
    candidateTexts.slice(0, 2).join(' | ').slice(0, 300)
  );
  await page.screenshot({ path: `${SHOT_DIR}/ask-01-desktop-search.png`, fullPage: true });

  console.log('— 只勾选两条尝试并核对发送内容');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.ask-selection-actions button')].find((item) =>
      item.textContent.includes('清空')
    );
    if (btn) btn.click();
  });
  const picked = await page.evaluate(
    ({ s1, s2 }) => {
      let count = 0;
      for (const item of document.querySelectorAll('[data-testid="ask-candidate"]')) {
        const text = item.innerText || '';
        if (text.includes(s1) || text.includes(s2)) {
          const box = item.querySelector('[data-testid="ask-candidate-pick"]');
          if (box && !box.checked) {
            box.click();
            count += 1;
          }
        }
      }
      return count;
    },
    { s1: STEP1, s2: STEP2 }
  );
  check('清空默认选择后只勾选两条尝试', picked === 2, String(picked));
  await waitText(page, '已选 2 条', 10000);
  await page.click('[data-testid="ask-preview"]');
  await page.waitForSelector('[data-testid="ask-preview-panel"]', { timeout: 20000 });
  const previewText = await page.$eval('[data-testid="ask-preview-panel"]', (el) => el.innerText);
  const previewRecords = await page.$$eval('[data-testid="ask-preview-record"]', (els) =>
    els.map((el) => el.innerText)
  );
  check('核对面板显示 2 条发送记录', previewRecords.length === 2, String(previewRecords.length));
  check(
    '核对内容包含真实正文与结果',
    previewText.includes(STEP1) && previewText.includes(RESULT1) && previewText.includes(RESULT2),
    previewText.slice(0, 400)
  );
  check(
    '核对面板显示目标模型',
    previewText.includes('问记录假模型') && previewText.includes('fake-ask'),
    previewText.slice(0, 220)
  );
  await page.screenshot({ path: `${SHOT_DIR}/ask-02-desktop-preview.png`, fullPage: true });

  console.log('— 生成回答（两步发送确认）');
  await page.click('[data-testid="ask-generate-btn"]');
  const confirmSend = await page
    .waitForSelector('[data-testid="ask-confirm-send"]', { timeout: 5000 })
    .catch(() => null);
  check('生成前显示「确认发送」二次确认', Boolean(confirmSend));
  if (confirmSend) await confirmSend.click();
  await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 60000 });
  const answerText = await page.$eval('[data-testid="ask-answer"]', (el) => el.innerText);
  check('回答显示 observation', (await page.$$('[data-testid="ask-point-observation"]')).length >= 1);
  check('回答显示 inference', (await page.$$('[data-testid="ask-point-inference"]')).length >= 1);
  check(
    '回答显示模型名',
    answerText.includes('问记录假模型') && answerText.includes('fake-ask'),
    answerText.slice(0, 240)
  );
  check('回答来源卡数量匹配发送记录', (await page.$$('[data-testid="ask-source-card"]')).length === 2);
  check('来源卡提供打开原记录', (await page.$$('[data-testid="ask-open-source"]')).length >= 1);
  check('来源卡提供网络中查看', (await page.$$('[data-testid="ask-graph-link"]')).length >= 1);
  check(
    '来源卡提供用这条经验试一步',
    (await page.$$('[data-testid="ask-reuse-link"], [data-testid="experience-from-attempt"]')).length >= 1
  );
  await page.screenshot({ path: `${SHOT_DIR}/ask-03-desktop-answer.png`, fullPage: true });

  const detailHref = await page
    .$eval('a[href^="/ask/ask-"]', (el) => el.getAttribute('href'))
    .catch(() => null);
  const detailUrl = detailHref ? BASE + detailHref : null;

  console.log('— 打开来源原记录');
  const openHref = await hrefOf(page, '[data-testid="ask-open-source"]');
  await page.goto(BASE + openHref, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  const attemptUrl = page.url();
  const attemptText = await page.evaluate(() => document.body.innerText);
  check('「打开原记录」进入 /attempt/...', /\/attempt\//.test(attemptUrl), attemptUrl);
  check(
    '原尝试页看到实际结果',
    attemptText.includes('记录实际结果') &&
      (attemptText.includes(RESULT1) || attemptText.includes(RESULT2)),
    attemptText.slice(0, 300)
  );
  await page.screenshot({ path: `${SHOT_DIR}/ask-04-desktop-source-attempt.png`, fullPage: true });

  console.log('— /ask/:queryId 详情页与图谱链接');
  if (!detailUrl) {
    check('/ask/:queryId 详情链接存在', false, 'no detail href');
  } else {
    await page.goto(detailUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ask-detail', { timeout: 20000 });
    await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 30000 });
    const detailAnswer = await page.$eval('[data-testid="ask-answer"]', (el) => el.innerText);
    check('/ask/:queryId 详情页可直接打开', detailAnswer.length > 20, detailAnswer.slice(0, 160));
    check(
      '详情页回答包含 observation/inference',
      (await page.$$('[data-testid="ask-point-observation"]')).length >= 1 &&
        (await page.$$('[data-testid="ask-point-inference"]')).length >= 1
    );
    const graphHrefs = await page.$$eval('[data-testid="ask-graph-link"]', (els) =>
      els.map((el) => el.getAttribute('href') || '')
    );
    const graphOk =
      graphHrefs.length >= 1 &&
      graphHrefs.every((href) => {
        if (!href.startsWith('/graph?')) return false;
        const url = new URL(href, 'http://example.invalid');
        const value = url.searchParams.get('node') || url.searchParams.get('focus') || '';
        return /^(attempt|capture):/.test(value);
      });
    check('来源「在网络中查看」链接指向 /graph?node=（兼容 focus）', graphOk, graphHrefs.join(' | '));
  }

  console.log('— 从回答进入「用这条经验试一步」');
  const reuseHref = await hrefOf(
    page,
    '[data-testid="ask-reuse-link"], [data-testid="experience-from-attempt"]'
  );
  check(
    '复用链接指向 capture?experience=attempt',
    /\/capture\/[^?]+\?experience=/.test(reuseHref || ''),
    String(reuseHref)
  );
  await page.goto(BASE + reuseHref, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.experience-preview', { timeout: 30000 });
  const previewExperienceText = await page
    .$eval('.experience-preview', (el) => el.innerText)
    .catch(() => '');
  check(
    '进入念头详情并看到旧经验预览',
    previewExperienceText.includes('参考的旧经验') || previewExperienceText.includes('结合这些经验'),
    previewExperienceText.slice(0, 240)
  );
  check(
    '旧经验预览包含选中的尝试',
    previewExperienceText.includes(STEP1) || previewExperienceText.includes(STEP2),
    previewExperienceText.slice(0, 260)
  );

  const confirmedExperience = await clickText(page, '.experience-preview button', '确认并生成');
  check('点击结合旧经验生成', confirmedExperience);
  await page.waitForSelector('.suggestion-card', { timeout: 60000 });
  const suggestionText = await page.$eval('.suggestion-card', (el) => el.innerText).catch(() => '');
  check('生成下一步建议卡', suggestionText.length > 10, suggestionText.slice(0, 240));

  const adopted = await clickText(page, '.suggestion-card button', '编辑并采用');
  check('建议卡可编辑并采用', adopted);
  await page.waitForSelector('.adopt-editor textarea', { timeout: 15000 });
  await fill(page, '.adopt-editor textarea', '问记录验收：按旧经验只改一个变量再观察一次');
  await clickText(page, '.adopt-editor button', '采用并创建尝试');
  await page.waitForSelector('.result-form', { timeout: 20000 });
  check('采用后进入新尝试详情', /\/attempt\//.test(page.url()), page.url());

  console.log('— 手机 390 宽度');
  await setViewport(page, 390, 844, 2);
  await page.goto(BASE + '/ask', { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  check(
    '手机 /ask 无横向溢出',
    !(await hasHorizontalOverflow(page)),
    String(await page.evaluate(() => document.documentElement.scrollWidth))
  );
  await fill(page, '[data-testid="ask-question-input"]', 'PWM 闪烁');
  await page.click('[data-testid="ask-search-btn"]');
  await page.waitForSelector('[data-testid="ask-candidate"]', { timeout: 25000 });
  const mobileCandidates = await page.$$eval('[data-testid="ask-candidate"]', (els) =>
    els.map((el) => el.innerText)
  );
  check('手机候选可读', mobileCandidates.length > 0 && mobileCandidates[0].length > 10, String(mobileCandidates.length));
  check('手机候选无横向溢出', !(await hasHorizontalOverflow(page)));
  if (detailUrl) {
    await page.goto(detailUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 30000 });
    const mobileAnswer = await page.$eval('[data-testid="ask-answer"]', (el) => el.innerText);
    check('手机回答可读', mobileAnswer.length > 20, mobileAnswer.slice(0, 160));
    check('手机 /ask/:queryId 无横向溢出', !(await hasHorizontalOverflow(page)));
  }
  await page.screenshot({ path: `${SHOT_DIR}/ask-05-mobile-answer.png`, fullPage: true });

  console.log('— 密钥检查');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check('浏览器本地存储不含 API Key', !storage.includes(KEY));
  check(
    '页面 DOM 不含明文 API Key',
    !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-secret-key')))
  );

  check('完整问我的记录流程通过', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/ask-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`问我的记录浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
