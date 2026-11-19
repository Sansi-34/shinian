// 拾念 SHINIAN · 首页 V2.0 浏览器验收
// 覆盖：五层信息优先级、真实数据、四种状态、CommandSearch、知识预览、离线提示、
//       1280/1440/390 布局无横向溢出、键盘可达与减少动效。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3116').replace(/\/+$/, '');
const OUT = process.env.SHINIAN_SHOT_DIR || 'shots/home-v2';
const USER = `V2验收 ${Date.now() % 100000}`;
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; fails.push(`${name} ${detail}`); console.log(`FAIL  ${name} ${detail}`); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});

async function login(page, name = USER) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', name);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 20000 });
}

const browserPage = await browser.newPage();
await browserPage.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

try {
  console.log('— 首次使用（空数据）');
  await login(browserPage);
  await browserPage.waitForFunction(() => document.body.innerText.includes('从一条念头开始'), { timeout: 20000 });
  const firstText = await browserPage.evaluate(() => document.body.innerText);
  check('空数据出现明确首次使用引导', firstText.includes('从一条念头开始') && firstText.includes('写一条念头'));
  check('空态不显示虚假统计', !/\d+\s*%/.test(firstText));
  await browserPage.screenshot({ path: `${OUT}/01-first-use-1280.png`, fullPage: true });

  // 五层优先级顺序在有真实数据时检查（首用态次要区块被有意折叠，几何位置不具可比性）。
  console.log('— 保存真实数据并验证不造演示内容');
  await browserPage.type('.capture-input', 'V2 验收念头：把常用命令写成快捷操作');
  await browserPage.click('.capture-box button[type="submit"]');
  await browserPage.waitForFunction(() => document.body.innerText.includes('V2 验收念头'), { timeout: 20000 });
  const seeded = await browserPage.evaluate(async () => {
    const post = async (url, body) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${url} ${r.status} ${await r.text()}`);
      return r.json();
    };
    const cap = await post('/api/captures', { rawText: 'V2 验收：PWM 低亮度闪烁' });
    const att = await post(`/api/captures/${cap.capture.id}/attempts`, { step: 'V2 验收：把频率提到 2kHz', state: 'todo', operationId: crypto.randomUUID() });
    return { captureId: cap.capture.id, attemptId: att.attempt.id };
  });
  await browserPage.reload({ waitUntil: 'networkidle0' });
  await browserPage.waitForSelector('[data-testid="home-continue-item"]', { timeout: 20000 });
  const haveText = await browserPage.evaluate(() => document.body.innerText);
  check('继续探索显示真实尝试', haveText.includes('V2 验收：把频率提到 2kHz'));
  check('最近念头显示真实念头', haveText.includes('V2 验收念头'));

  console.log('— 五层优先级顺序（有数据态）');
  const order = await browserPage.evaluate(() => {
    const y = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : -1; };
    return { capture: y('.capture-box'), continueY: y('.home-continue'), recentY: y('.recent-thoughts'), knowledgeY: y('.knowledge-preview'), aiY: y('.ai-help') };
  });
  check('快速捕捉在最前', order.capture >= 0 && order.capture < order.continueY, JSON.stringify(order));
  check('继续探索在最近念头前', order.continueY < order.recentY, JSON.stringify(order));
  check('最近念头在知识联系前', order.recentY < order.knowledgeY, JSON.stringify(order));
  check('AI 帮助在最后', order.aiY > order.knowledgeY, JSON.stringify(order));
  await browserPage.screenshot({ path: `${OUT}/02-daily-1280.png`, fullPage: true });

  console.log('— CommandSearch 统一搜索与快捷面板');
  await browserPage.evaluate(() => document.activeElement?.blur?.());
  await browserPage.keyboard.press('Slash');
  const slashFocus = await browserPage.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
  check('斜杠键聚焦搜索框', slashFocus.includes('搜索'), slashFocus);
  await browserPage.keyboard.press('Escape');
  await browserPage.keyboard.down('Control'); await browserPage.keyboard.press('KeyK'); await browserPage.keyboard.up('Control');
  await browserPage.waitForSelector('.command-palette', { timeout: 5000 });
  check('Ctrl+K 打开快捷操作面板', true);
  await browserPage.screenshot({ path: `${OUT}/03-command-palette.png` });
  await browserPage.keyboard.press('Escape');
  check('Esc 关闭快捷面板', (await browserPage.$('.command-palette')) === null);

  console.log('— 按需 AI 面板');
  await browserPage.click('.ai-help-toggle');
  await browserPage.waitForSelector('#home-context-panel', { timeout: 5000 });
  check('AI 面板按需展开', true);
  await browserPage.click('.ai-help-toggle');

  console.log('— 知识联系（真实关系或空态）');
  await browserPage.waitForSelector('.knowledge-preview', { timeout: 5000 });
  const knowledge = await browserPage.evaluate(() => ({
    text: document.querySelector('.knowledge-preview')?.innerText || '',
    items: document.querySelectorAll('.knowledge-item').length,
  }));
  check('知识预览有真实关系或明确空态', knowledge.items > 0 || knowledge.text.includes('还没有已建立的知识关系'), knowledge.text.slice(0, 200));
  check('知识预览不显示随机百分比', !/\d+%/.test(knowledge.text));

  console.log('— 离线状态');
  await browserPage.setOfflineMode(true);
  await browserPage.evaluate(() => window.dispatchEvent(new Event('offline')));
  await browserPage.waitForSelector('.offline-banner', { timeout: 5000 });
  check('离线显示明确提示且仍可记录', (await browserPage.$('.capture-input')) !== null);
  await browserPage.screenshot({ path: `${OUT}/04-offline-1280.png`, fullPage: true });
  await browserPage.setOfflineMode(false);
  await browserPage.evaluate(() => window.dispatchEvent(new Event('online')));

  console.log('— 1440 与 390 布局');
  for (const [w, h, label] of [[1440, 900, '05-1440'], [390, 844, '06-mobile-390']]) {
    await browserPage.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const layout = await browserPage.evaluate(() => ({
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      captureVisible: !!document.querySelector('.capture-input'),
    }));
    check(`${w}px 无横向溢出且输入框可见`, layout.noOverflow && layout.captureVisible, JSON.stringify(layout));
    await browserPage.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
  }

  console.log('— 减少动效');
  await browserPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await browserPage.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const spinDur = await browserPage.evaluate(() => {
    const el = document.createElement('div'); el.className = 'spinner'; document.body.appendChild(el);
    const d = getComputedStyle(el).animationDuration; el.remove(); return d;
  });
  check('减少动效下动画时长被压缩', parseFloat(spinDur) < 0.1, spinDur);
  await browserPage.emulateMediaFeatures([]);

  console.log('\n结果:', pass, 'passed,', fail, 'failed');
  if (fails.length) console.log('失败项:\n' + fails.join('\n'));
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
