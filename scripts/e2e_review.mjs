// 拾念 SHINIAN · 阶段回顾浏览器端到端验收（Chrome 无头，1280×900 与 390×844）
// 前置：目标服务已启动（默认 http://127.0.0.1:3200），fake_model_server.py 已启动（3501）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.SHINIAN_BASE || 'http://127.0.0.1:3200';
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `回顾验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-secret-key';

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

const CAP1 = '回顾验收念头 A：PWM 低占空比时 LED 会闪';
const CAP2 = '回顾验收念头 B：调光时想避免肉眼可见闪烁';
const STEP1 = '比较两种 PWM 频率';
const STEP2 = '按旧结论选 2 kHz 试调光';
const RESULT1 = '500 Hz 时仍有可见闪烁，2 kHz 时肉眼几乎不可见';
const RESULT2 = '按 2 kHz 调光后肉眼未见闪烁，仍需更长时间确认';

try {
  console.log('— 登录与模型配置');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await fill(page, '.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });

  const saved = await page.evaluate(async () => {
    const res = await fetch('/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '回顾假模型',
        baseUrl: 'http://127.0.0.1:3501/v1',
        modelId: 'fake-review',
        enabled: true,
        allowLocal: true,
        apiKey: 'test-secret-key',
      }),
    });
    return res.status;
  });
  check('配置回顾假模型 fake-review', saved === 200, String(saved));

  console.log('— 准备实际记录（念头 / 尝试 / 结果 / 引用）');
  async function saveCapture(text) {
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.capture-input', { timeout: 10000 });
    await page.type('.capture-input', text);
    await page.click('[data-testid="home-capture-submit"]');
    await waitText(page, text);
  }

  async function createAttempt(captureText, step, result, outcome) {
    await clickText(page, '.card-main', captureText);
    await page.waitForSelector('.detail-title', { timeout: 10000 });
    if (!(await page.$('.attempt-form input[type="text"]'))) {
      await clickText(page, 'button', '自己写一步');
      await page.waitForSelector('.attempt-form input[type="text"]', { timeout: 10000 });
    }
    await page.type('.attempt-form input[type="text"]', step);
    await clickText(page, '.attempt-form button', '创建尝试');
    await waitText(page, step);
    await clickText(page, '.card-main', step);
    await page.waitForSelector('.result-form', { timeout: 15000 });
    await page.type('.result-form textarea', result);
    await page.select('.result-form select', outcome);
    await clickText(page, '.result-form button', '保存结果');
    await waitText(page, '结果已保存');
  }

  await saveCapture(CAP1);
  await createAttempt(CAP1, STEP1, RESULT1, 'failure');
  await saveCapture(CAP2);
  await createAttempt(CAP2, STEP2, RESULT2, 'success');

  // 用现有「引用已有结果」建立一次经验引用
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  await clickText(page, '.card-main', CAP2);
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  await clickText(page, '.card-main', STEP2);
  await page.waitForSelector('.result-form', { timeout: 15000 });
  await clickText(page, 'button', '＋ 引用已有结果');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.type('.modal .search-bar input', '闪烁');
  await clickText(page, '.modal .search-bar button', '搜索');
  await page.waitForSelector('.pick-item', { timeout: 10000 });
  await clickText(page, '.pick-item', 'PWM');
  await page.waitForSelector('.modal .field input', { timeout: 10000 });
  await page.type('.modal .field input', '回顾验收：先按旧观察继续验证');
  await clickText(page, '.modal button', '确认引用');
  await waitText(page, '引用时的结果');
  check('建立一次经验引用', true);

  console.log('— 回顾页：范围与实际记录');
  await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-page', { timeout: 20000 });
  await waitText(page, '阶段回顾');
  check('导航可进入回顾页', await page.evaluate(() => !!document.querySelector('a[href="/review"]')));
  check('默认展示最近 7 天', await page.evaluate(() => document.body.innerText.includes('最近 7 天')));

  const statsText = await page.$eval('.review-stats', (el) => el.innerText);
  check('统计卡显示记录的念头/开始尝试/写下结果/新建引用',
    /记录的念头/.test(statsText) && /开始尝试/.test(statsText) && /写下结果/.test(statsText) && /新建引用/.test(statsText),
    statsText.slice(0, 200));
  check('统计口径可展开解释', await page.$('.review-stats-toggle') !== null);
  const recordsText = await page.$eval('.review-record-list', (el) => el.innerText);
  check('实际记录包含两条念头与两条尝试',
    recordsText.includes(CAP1) && recordsText.includes(CAP2) && recordsText.includes(STEP1) && recordsText.includes(STEP2),
    recordsText.slice(0, 240));
  check('引用记录出现在列表中', recordsText.includes('回顾验收：先按旧观察继续验证'));

  // 统计口径展开
  await clickText(page, '.review-stats-wrap button', '统计口径');
  await new Promise((r) => setTimeout(r, 400));
  check('统计口径可展开解释', await page.$('.review-stat-defs') !== null);
  const defsText = await page.evaluate(() => document.body.innerText);
  check('口径说明区分创建/结果/修改时间',
    defsText.includes('创建时间') && defsText.includes('结果记录时间') && defsText.includes('最后修改时间'),
    defsText.slice(0, 120));
  await page.screenshot({ path: `${SHOT_DIR}/review-01-desktop-range.png`, fullPage: true });

  console.log('— 生成 AI 回顾（含排除一条记录）');
  await clickText(page, '.review-ai-card button', '帮我回顾');
  await page.waitForSelector('.review-composer', { timeout: 15000 });
  const composerText = await page.$eval('.review-composer', (el) => el.innerText);
  check('确认区显示目标模型', composerText.includes('回顾假模型') && composerText.includes('fake-review'), composerText.slice(0, 160));
  check('确认区显示时间范围',
    composerText.includes('起（含）') && composerText.includes('（不含）') && composerText.includes('统计'),
    composerText.slice(0, 200));

  // 排除一条记录（取消勾选第一个复选框）
  const unchecked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.review-composer-item input[type="checkbox"]')];
    if (!boxes.length) return false;
    boxes[0].click();
    return true;
  });
  check('可以排除一条记录', unchecked);
  await new Promise((r) => setTimeout(r, 600));
  const summaryText = await page.$eval('.review-composer-summary', (el) => el.innerText);
  check('显示本次将发送与未选数量', /将发送\s*\d+\s*条/.test(summaryText) && /未选/.test(summaryText), summaryText.slice(0, 160));

  await clickText(page, '.review-composer button', '生成回顾');
  await page.waitForSelector('.review-content', { timeout: 60000 });
  const contentText = await page.$eval('.review-content', (el) => el.innerText);
  check('回顾显示总览', contentText.includes('总览') || contentText.length > 40, contentText.slice(0, 120));
  check('回顾区分观察与推断', contentText.includes('记录中的观察') && contentText.includes('模型推断'), contentText.slice(0, 200));
  const sourceLinks = await page.$$('.review-content .review-source');
  check('回顾条目带可点击来源', sourceLinks.length > 0, String(sourceLinks.length));
  await page.screenshot({ path: `${SHOT_DIR}/review-02-desktop-generated.png`, fullPage: true });

  console.log('— 打开来源');
  const href = await page.$eval('.review-content .review-source', (el) => el.getAttribute('href'));
  const reviewUrl = page.url();
  await page.goto(BASE + href, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 15000 });
  check('来源可打开原始尝试', await page.evaluate(() => document.body.innerText.includes('记录实际结果')));
  await page.goto(reviewUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-content', { timeout: 20000 });

  console.log('— 保存回顾与重复保存');
  await clickText(page, '.review-save', '保存回顾');
  await waitText(page, '已保存', 20000);
  check('保存后显示已保存', true);
  const dupSave = await page.evaluate(async () => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('review');
    if (!id) return null;
    const res = await fetch(`/api/reviews/${id}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: `e2e-dup-${id}` }),
    });
    const body = await res.json();
    return { status: res.status, savedAt: body.review?.savedAt, replayed: body.replayed };
  });
  check('重复保存返回同一 savedAt 且 replayed=true',
    dupSave && dupSave.status === 200 && dupSave.replayed === true && typeof dupSave.savedAt === 'number',
    JSON.stringify(dupSave));
  await page.evaluate(() => {
    document.querySelector('.review-saved-items .review-saved-item')?.click();
  });
  await page.waitForSelector('.review-detail-range', { timeout: 20000 });
  const detailText = await page.$eval('.review-detail', (el) => el.innerText);
  check('详情显示当时时间范围与来源', /Asia\/Shanghai/.test(detailText) && detailText.includes('来源'), detailText.slice(0, 200));
  await page.screenshot({ path: `${SHOT_DIR}/review-03-desktop-saved.png`, fullPage: true });

  console.log('— 从经验进入下一次尝试');
  // 下一步建议改用来源感知假模型（切换必须发生在预览之前，否则预览令牌会因配置版本变化而失效）
  await page.evaluate(async () => {
    await fetch('/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '回顾假模型',
        baseUrl: 'http://127.0.0.1:3501/v1',
        modelId: 'fake-experience',
        enabled: true,
        allowLocal: true,
        apiKey: 'test-secret-key',
      }),
    });
  });
  const started = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.review-experience-action button')];
    const target = btns.find((b) => (b.textContent || '').includes('参考这条经验，再试一步'));
    if (!target) return false;
    target.click();
    return true;
  });
  check('经验项提供「参考这条经验，再试一步」', started);
  await page.waitForSelector('.review-experience-list', { timeout: 10000 });
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.review-experience-capture')];
    items[0]?.click();
  });
  await page.waitForSelector('.experience-preview, .experience-select-panel', { timeout: 20000 });
  const previewText = await page.evaluate(() => document.body.innerText);
  check('跳转念头详情并带入旧经验预览', previewText.includes('参考的旧经验') || previewText.includes('来源'), previewText.slice(0, 160));
  await page.screenshot({ path: `${SHOT_DIR}/review-04-desktop-experience-preview.png`, fullPage: true });

  const confirmed = await clickText(page, 'button', '确认并生成');
  check('确认后生成下一步建议', confirmed);
  await page.waitForSelector('.suggestion-card', { timeout: 60000 });
  await clickText(page, '.suggestion-card button', '编辑并采用');
  await page.waitForSelector('.adopt-editor textarea', { timeout: 15000 });
  await fill(page, '.adopt-editor textarea', '回顾验收：按旧经验只改一个变量再观察一次');
  await clickText(page, '.adopt-editor button', '采用并创建尝试');
  await page.waitForSelector('.result-form', { timeout: 20000 });
  await waitText(page, '引用时的结果');
  check('采用后建立引用并进入尝试详情', true);
  await page.screenshot({ path: `${SHOT_DIR}/review-05-desktop-next-attempt.png`, fullPage: true });

  console.log('— 手机宽度');
  await setViewport(page, 390, 844, 2);
  await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-page', { timeout: 20000 });
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  check('回顾页手机宽度无横向溢出', !mobileOverflow);
  await page.screenshot({ path: `${SHOT_DIR}/review-06-mobile-range.png`, fullPage: true });
  const savedMobile = await page.$('.review-saved-item');
  check('手机宽度可打开已保存回顾', savedMobile !== null);
  if (savedMobile) {
    await savedMobile.click();
    await page.waitForSelector('.review-detail', { timeout: 20000 });
    const detailOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    check('回顾详情手机宽度无横向溢出', !detailOverflow);
    await page.screenshot({ path: `${SHOT_DIR}/review-07-mobile-detail.png`, fullPage: true });
  }

  console.log('— 密钥检查');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check('浏览器本地存储不含 API Key', !storage.includes(KEY));
  check('页面 DOM 不含明文 API Key', !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-secret-key'))));

  check('完整回顾流程通过', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/review-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`阶段回顾浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
