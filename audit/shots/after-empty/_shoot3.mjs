// 补充取证：纸张主题下的空态 + 移动端经验/研究空态
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-empty';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.setRequestInterception(true);
let emptyExperiences = false;
page.on('request', (req) => {
  if (emptyExperiences && req.method() === 'GET' && /\/api\/experiences(\?|$)/.test(req.url())) {
    return req.respond({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ experiences: [] }) });
  }
  return req.continue();
});

const go = async (path) => {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await sleep(700);
};

await page.setViewport({ width: 1280, height: 900 });
await go('/');
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '阿念');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('开启拾念之旅'));
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
}

// ---- 纸张主题：日程空态 ----
await page.evaluate(() => localStorage.setItem('shinian.v2-theme', 'paper'));
await go('/schedule');
const paper = await page.evaluate(() => {
  const el = document.querySelector('.v2-empty');
  const cs = (q) => {
    const n = document.querySelector(q);
    return n ? getComputedStyle(n) : null;
  };
  const t = cs('.v2-empty-title');
  const x = cs('.v2-empty-text');
  const c = cs('.v2-empty-cta');
  const m = cs('.v2-empty-mark');
  const r = el.getBoundingClientRect();
  return {
    theme: document.querySelector('.v2-root')?.getAttribute('data-v2-theme'),
    emptyTop: Math.round(r.top),
    emptyH: Math.round(r.height),
    centerOffset: Math.round(r.top + r.height / 2 - innerHeight / 2),
    title: t && { color: t.color, fontSize: t.fontSize },
    text: x && { color: x.color },
    cta: c && { color: c.color, bg: c.backgroundColor, border: c.borderTopColor },
    mark: m && { border: m.borderTopStyle + ' ' + m.borderTopColor, bg: m.backgroundColor },
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
  };
});
console.log('PAPER', JSON.stringify(paper));
await page.screenshot({ path: `${OUT}/paper-empty-schedule-1280x900.png`, fullPage: true });

// ---- 回到暗色，移动端经验 / 研究空态 ----
await page.evaluate(() => localStorage.setItem('shinian.v2-theme', 'dark'));
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
emptyExperiences = true;
await go('/experiences');
await page.screenshot({ path: `${OUT}/empty-experiences-390x844.png`, fullPage: true });
emptyExperiences = false;
await go('/research');
await page.screenshot({ path: `${OUT}/empty-research-390x844.png`, fullPage: true });

console.log('errors: ' + (errs.length ? errs.join(' | ') : 'none'));
await browser.close();
