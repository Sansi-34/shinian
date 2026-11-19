// 最终回归：全部改动页面的视口截图 + 关键测量
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/final';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const log = [];
const p = (x) => { log.push(x); console.log(x); };
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1800));

const capId = await page.evaluate(async () => (await (await fetch('/api/captures')).json()).captures[0].id);
const pages = [
  ['home', '/'],
  ['capture', '/capture/' + capId],
  ['attempt', '/attempt/att-1795078914914-9w4eto'],
  ['topics', '/topics'],
  ['experiences', '/experiences'],
  ['schedule', '/schedule'],
  ['research', '/research'],
  ['review', '/review'],
  ['activity', '/activity'],
  ['graph', '/graph'],
];
for (const [name, path] of pages) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1100));
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

// —— 关键断言 ——
const checks = {};
await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
checks.home = await page.evaluate(() => ({
  seeAll: document.querySelector('.v2-leftMore')?.textContent.trim() ?? null,
  ghostLinks: [...document.querySelectorAll('.v2-ghosts a')].map((a) => a.getAttribute('href')),
  rowClamp: (() => {
    const t = document.querySelector('[class*="titleText"]');
    return t ? getComputedStyle(t).webkitLineClamp : null;
  })(),
}));
await page.goto(BASE + '/experiences', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
checks.experiences = await page.evaluate(() => {
  const empty = document.querySelector('[class*="v2-empty"]');
  return { hasEmpty: !!empty, emptyText: empty ? empty.innerText.replace(/\s+/g, ' ').slice(0, 80) : null };
});
await page.goto(BASE + '/graph', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));
checks.graph = await page.evaluate(() => ({
  sub: document.querySelector('.gd-sub')?.innerText?.slice(0, 60) ?? null,
  actions: [...document.querySelectorAll('.gd-actions .gd-btn')].map((b) => b.innerText.trim()),
  hint: document.querySelector('[class*="graph-empty"], .gd-hint')?.innerText?.slice(0, 60) ?? null,
}));
p('checks = ' + JSON.stringify(checks, null, 1));
p('errors = ' + JSON.stringify(errs));
fs.writeFileSync(`${OUT}/report.txt`, log.join('\n'), 'utf8');
await browser.close();
