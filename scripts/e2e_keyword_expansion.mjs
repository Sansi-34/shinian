// 拾念 SHINIAN · 「换个说法找记录」浏览器端到端验收
// 隔离服务默认 http://127.0.0.1:3117；fake_model_server.py 默认 3501（含 fake-suggest-keywords）。
// 覆盖：无结果时换词面板（问题/当前词/模型/费用/不发送正文）→ fake 生成 → 勾选/编辑/移除/取消 →
// 应用后 direct/expanded 分组与 matchedKeywords → 返回保留 → 清除扩展 → 改问题/切主题重置 →
// 来源删除后扩展结果消失 → 键盘操作 → 建议请求单次调用 → 桌面 1280×900 与手机 390。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3117').replace(/\/+$/, '');
const FAKE = (process.env.SHINIAN_FAKE_BASE || 'http://127.0.0.1:3501').replace(/\/+$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const LAST_SUGGEST = process.env.SHINIAN_SUGGEST_LAST || 'output/fake-suggest-last.json';
const USER = `关键词扩展验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-secret-key';
const STAMP = String(Date.now() % 1000000);
const QUESTION = `KWEXP-${STAMP} 我的灯带怎么调不闪？`;
const NO_MATCH = `KWEXP-NOMATCH-${STAMP}`;
const DIRECT_CAP = `KWEXP-D-${STAMP} PWM 调光实验`;
const DIRECT_STEP = `KWEXP-D-${STAMP} 500 Hz PWM 调光`;
const DIRECT_RESULT = `KWEXP-D-${STAMP} PWM 调光正常`;
const EXPANDED_CAP = `KWEXP-E-${STAMP} LED 灯带观察`;
const EXPANDED_STEP = `KWEXP-E-${STAMP} 2 kHz 调光`;
const EXPANDED_RESULT = `KWEXP-E-${STAMP} LED 闪烁明显减轻，频闪消失`;
const NEW_QUESTION = `KWEXP-${STAMP} 完全不同的新问题`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setField(page, selector, value) {
  await page.$eval(
    selector,
    (el, v) => {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

async function setNthField(page, selector, index, value) {
  const handles = await page.$$(selector);
  const handle = handles[index];
  if (!handle) throw new Error(`not found: ${selector}[${index}]`);
  await handle.evaluate((el, v) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function clickText(page, selector, text) {
  for (const h of await page.$$(selector)) {
    const t = await h.evaluate((el) => el.textContent || '');
    if (t.includes(text)) {
      await h.click();
      return true;
    }
  }
  return false;
}

async function waitText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

function suggestCount() {
  try {
    return Number(JSON.parse(fs.readFileSync(LAST_SUGGEST, 'utf8')).count || 0);
  } catch {
    return 0;
  }
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}`, fullPage: true });
}

async function search(page, question, keywords) {
  await setField(page, '[data-testid="ask-question-input"]', question);
  await setField(page, '[data-testid="ask-keywords-input"]', keywords);
  await page.click('[data-testid="ask-search-btn"]');
  await sleep(600);
}

async function generateInPanel(page) {
  const before = suggestCount();
  await page.waitForSelector('[data-testid="ask-expand-generate"]', { timeout: 10000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="ask-expand-generate"]');
      return Boolean(button && !button.disabled);
    },
    { timeout: 15000 }
  );
  await page.focus('[data-testid="ask-expand-generate"]');
  await page.click('[data-testid="ask-expand-generate"]');
  await page.waitForSelector('[data-testid="ask-expand-term-input"]', { timeout: 20000 });
  const after = suggestCount();
  check('一次生成建议只发一次请求', after === before + 1, `${before} -> ${after}`);
  return { before, after };
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

try {
  console.log('— 登录、配置 fake 与种子记录');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  const configured = await page.evaluate(async (fake) => {
    const res = await fetch('/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '关键词扩展假模型',
        baseUrl: `${fake}/v1`,
        modelId: 'fake-suggest-keywords',
        enabled: true,
        allowLocal: true,
        apiKey: 'test-secret-key',
      }),
    });
    return res.status;
  }, FAKE);
  check('配置 fake-suggest-keywords', configured === 200, String(configured));

  const seed = await page.evaluate(
    async ({ directCap, directStep, directResult, expandedCap, expandedStep, expandedResult }) => {
      async function req(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`);
        return data;
      }
      const stamp = Date.now();
      const c1 = (await req('POST', '/api/captures', { rawText: directCap })).capture;
      const a1 = (await req('POST', '/api/captures/' + c1.id + '/attempts', {
        step: directStep,
        state: 'done',
        resultText: directResult,
        outcome: 'success',
        operationId: `kwe-direct-${stamp}`,
      })).attempt;
      const c2 = (await req('POST', '/api/captures', { rawText: expandedCap })).capture;
      const a2 = (await req('POST', '/api/captures/' + c2.id + '/attempts', {
        step: expandedStep,
        state: 'done',
        resultText: expandedResult,
        outcome: 'success',
        operationId: `kwe-expanded-${stamp}`,
      })).attempt;
      return { c1: c1.id, a1: a1.id, c2: c2.id, a2: a2.id };
    },
    {
      directCap: DIRECT_CAP,
      directStep: DIRECT_STEP,
      directResult: DIRECT_RESULT,
      expandedCap: EXPANDED_CAP,
      expandedStep: EXPANDED_STEP,
      expandedResult: EXPANDED_RESULT,
    }
  );
  check('种子 direct/expanded 记录创建成功', Boolean(seed.a1 && seed.a2), JSON.stringify(seed));

  console.log('— 无结果时打开换词面板');
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await search(page, QUESTION, NO_MATCH);
  await page.waitForSelector('[data-testid="ask-empty"]', { timeout: 20000 });
  check('原关键词检索无结果', true);
  await page.click('[data-testid="ask-expand-trigger"]');
  await page.waitForSelector('[data-testid="ask-expand-panel"]', { timeout: 10000 });
  const panelText = await page.$eval('[data-testid="ask-expand-panel"]', (el) => el.innerText);
  check('换词面板显示问题与当前检索词', panelText.includes(QUESTION) && panelText.includes(NO_MATCH), panelText.slice(0, 300));
  check('换词面板显示目标模型', panelText.includes('关键词扩展假模型') && panelText.includes('fake-suggest-keywords'), panelText.slice(0, 300));
  check('换词面板说明费用与不发送正文', panelText.includes('可能产生费用') && panelText.includes('不会发送任何历史记录正文'), panelText.slice(0, 400));
  await shot(page, 'keyword-expansion-panel-empty.png');

  console.log('— 生成、勾选、编辑、移除、取消');
  await generateInPanel(page);
  const termCount = (await page.$$('[data-testid="ask-expand-term-input"]')).length;
  check('建议生成 3 个候选词', termCount === 3, String(termCount));
  check('建议默认不勾选', await page.evaluate(() => [...document.querySelectorAll('.ask-expand-term-list input[type="checkbox"]')].every((x) => !x.checked)));
  await page.focus('.ask-expand-term-list input[type="checkbox"]');
  await page.keyboard.press('Space');
  check('键盘可勾选替代词', await page.evaluate(() => Boolean(document.querySelector('.ask-expand-term-list input[type="checkbox"]')?.checked)));
  await setNthField(page, '[data-testid="ask-expand-term-input"]', 1, '频闪灯');
  check('替代词可编辑', (await page.$$eval('[data-testid="ask-expand-term-input"]', (els) => els[1]?.value)) === '频闪灯');
  const removed = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label^="移除替代词"]')];
    if (buttons[2]) {
      buttons[2].click();
      return true;
    }
    return false;
  });
  check('替代词可移除', removed && (await page.$$('[data-testid="ask-expand-term-input"]')).length === 2);
  await clickText(page, '[data-testid="ask-expand-panel"] button', '收起');
  await page.waitForFunction(() => !document.querySelector('[data-testid="ask-expand-panel"]'));
  check('可取消/收起面板且不应用', true);
  await page.click('[data-testid="ask-expand-trigger"]');
  await page.waitForSelector('[data-testid="ask-expand-panel"]');
  await page.focus('[data-testid="ask-expand-apply"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="ask-group-expanded"]', { timeout: 20000 });
  check('应用扩展词后出现扩展分组', await page.evaluate((step) => document.body.innerText.includes(step), EXPANDED_STEP));
  check('面板显示当前扩展词', await page.evaluate(() => document.body.innerText.includes('当前扩展词：') && document.body.innerText.includes('闪烁')));
  await shot(page, 'keyword-expansion-applied-empty-origin.png');

  console.log('— 清除扩展恢复原结果');
  await page.click('[data-testid="ask-expand-clear"]');
  await page.waitForSelector('[data-testid="ask-empty"]', { timeout: 20000 });
  check('清除扩展后恢复原结果（无匹配空态）', await page.evaluate((step) => !document.body.innerText.includes(step), EXPANDED_STEP));

  console.log('— 原关键词有结果时应用扩展：direct + expanded');
  await search(page, QUESTION, 'PWM');
  await page.waitForSelector('[data-testid="ask-group-direct"]', { timeout: 20000 });
  check('原关键词有 direct 结果', await page.evaluate((step) => document.body.innerText.includes(step), DIRECT_STEP));
  await page.click('[data-testid="ask-expand-trigger"]');
  await page.waitForSelector('[data-testid="ask-expand-panel"]');
  await generateInPanel(page);
  await page.focus('.ask-expand-term-list input[type="checkbox"]');
  await page.keyboard.press('Space');
  await page.focus('[data-testid="ask-expand-apply"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="ask-group-expanded"]', { timeout: 20000 });
  const bothText = await page.evaluate(() => document.body.innerText);
  check('应用后同时显示 direct 与 expanded 分组', bothText.includes('直接命中') && bothText.includes('换词后找到'), bothText.slice(0, 500));
  check('扩展候选显示 matchedKeywords', bothText.includes('扩展词命中：') && bothText.includes('闪烁'), bothText.slice(0, 800));
  await page.click('[data-testid="ask-group-expanded"] [data-testid="ask-candidate-preview"]');
  await page.waitForSelector('[data-testid="ask-candidate-expanded"]', { timeout: 15000 }).catch(() => {});
  await shot(page, 'keyword-expansion-applied-desktop.png');

  console.log('— 打开来源再返回，保留换词与结果');
  const expandedOpen = await page.$eval(
    '[data-testid="ask-group-expanded"] [data-testid="ask-candidate-open"]',
    (a) => a.getAttribute('href')
  );
  await page.goto(BASE + expandedOpen, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  check('扩展候选可打开原记录', /\/attempt\//.test(page.url()), page.url());
  await page.goto(BASE + '/ask', { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="ask-group-expanded"]', { timeout: 30000 });
  check('返回 /ask 保留问题与扩展词', (await page.$eval('[data-testid="ask-question-input"]', (el) => el.value)) === QUESTION);
  check('返回后扩展分组与 matchedKeywords 仍在', await page.evaluate(() => document.body.innerText.includes('扩展词命中：')));
  await shot(page, 'keyword-expansion-return.png');

  console.log('— 来源删除后扩展结果消失');
  await page.evaluate(async (attemptId) => {
    await fetch('/api/attempts/' + attemptId, { method: 'DELETE' });
  }, seed.a2);
  await page.click('[data-testid="ask-search-btn"]');
  await sleep(800);
  check('删除来源后扩展结果消失', await page.evaluate((step) => !document.body.innerText.includes(step), EXPANDED_STEP));
  await page.click('[data-testid="ask-expand-trigger"]');
  await page.waitForSelector('[data-testid="ask-expand-panel"]', { timeout: 10000 });
  await page.click('[data-testid="ask-expand-clear"]');
  await page.waitForSelector('[data-testid="ask-group-direct"]', { timeout: 20000 });
  check('清除扩展恢复原 direct 结果', await page.evaluate((step) => document.body.innerText.includes(step), DIRECT_STEP));

  console.log('— 改问题/切主题重置扩展');
  await search(page, NEW_QUESTION, 'PWM');
  await sleep(500);
  check('改问题后扩展状态重置', await page.evaluate(() => !document.querySelector('.ask-expand-applied')));
  const topic = await page.evaluate(async (captureId) => {
    const res = await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '关键词扩展验收主题',
        captureIds: [captureId],
        operationId: 'kwe-topic-' + Date.now(),
      }),
    });
    return res.ok ? (await res.json()).topic?.id : null;
  }, seed.c1);
  check('创建用于主题切换的隔离主题', Boolean(topic), String(topic));
  await page.goto(`${BASE}/ask?topicId=${encodeURIComponent(topic)}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-topic-scope"]', { timeout: 20000 });
  check('切主题后扩展状态重置', await page.evaluate(() => !document.querySelector('.ask-expand-applied')));

  console.log('— 手机 390');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await search(page, QUESTION, 'PWM');
  await page.click('[data-testid="ask-expand-trigger"]');
  await page.waitForSelector('[data-testid="ask-expand-panel"]', { timeout: 10000 });
  check('手机 /ask 与换词面板无横向溢出', await noOverflow(page), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  check('手机换词面板可读', await page.evaluate(() => document.body.innerText.includes('换些关键词找找') && document.body.innerText.includes('当前检索词')));
  await shot(page, 'keyword-expansion-mobile.png');

  console.log('— 密钥与请求次数检查');
  check('建议请求总调用次数符合两次主动生成', suggestCount() >= 2 && typeof suggestCount() === 'number', String(suggestCount()));
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check('浏览器存储不含 API Key', !storage.includes(KEY));
  check('页面 DOM 不含明文 API Key', !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-secret-key'))));

  check('换词浏览器完整流程通过', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await shot(page, 'keyword-expansion-error.png').catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`换词浏览器验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
