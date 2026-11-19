// 主动走查：第一次打开（空库）→ 登录 → 首页空态
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--font-render-hinting=none'],
});

const log = [];
function note(x) { log.push(x); console.log(x); }

async function dump(page, tag) {
  const info = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const btn = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((e) => e.offsetParent !== null || e.tagName === 'A')
      .map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('href') ? '[' + e.getAttribute('href') + ']' : ''}: ${clean(e.innerText) || e.getAttribute('aria-label') || '(无文字)'}`);
    const fields = [...document.querySelectorAll('input, textarea, select')].map(
      (e) => `${e.tagName.toLowerCase()} type=${e.type || ''} name=${e.name || ''} ph="${e.placeholder || ''}" label="${e.getAttribute('aria-label') || (e.labels && e.labels[0] ? e.labels[0].innerText : '')}"`
    );
    return { title: document.title, url: location.pathname + location.search, text: document.body.innerText, buttons: btn, fields };
  });
  fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(info, null, 2), 'utf8');
  note(`--- ${tag} ${info.url} ---`);
  note(info.text);
  note('[可点元素] ' + info.buttons.join(' | '));
  note('[表单] ' + info.fields.join(' | '));
}

// ---------- 桌面 ----------
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.screenshot({ path: `${OUT}/01-login-1280.png`, fullPage: true });
await dump(page, '01-login');

// 登录
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.screenshot({ path: `${OUT}/02-login-filled-1280.png`, fullPage: true });
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {}), page.click('.login-card button[type="submit"]')]);
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/03-home-empty-1280.png`, fullPage: true });
await dump(page, '03-home-empty');

// ---------- 移动 ----------
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.goto(BASE, { waitUntil: 'networkidle0' });
await m.screenshot({ path: `${OUT}/01-login-390.png`, fullPage: true });
// 复用桌面已建立的会话 cookie
const cookies = await page.cookies();
await m.setCookie(...cookies);
await m.goto(BASE, { waitUntil: 'networkidle0' });
await m.screenshot({ path: `${OUT}/03-home-empty-390.png`, fullPage: true });
await dump(m, '03-home-empty-390');

note('=== console errors ===');
note(JSON.stringify(errs, null, 2));
fs.writeFileSync(`${OUT}/walk01.log.txt`, log.join('\n'), 'utf8');
await browser.close();
