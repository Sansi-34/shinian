// 走查第五步：不可读徽章、键盘成本、空保存、离线错误态、加入主题死循环
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const report = [];
const p = (x) => { report.push(x); console.log(x); };
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1500));

// ---------- 1. 徽章实测 ----------
await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 900));
const badges = await page.evaluate(() => [...document.querySelectorAll('.badge')].slice(0, 8).map((e) => {
  const cs = getComputedStyle(e);
  return { cls: e.className, text: e.innerText.trim(), color: cs.color, bg: cs.backgroundColor, fs: cs.fontSize };
}));
p('=== /review 徽章实测 ===\n' + badges.map((b) => JSON.stringify(b)).join('\n'));
await page.screenshot({ path: `${OUT}/60-review-badges-1280.png`, fullPage: true });

// ---------- 2. 键盘成本：到「记一句」输入框要按几次 Tab ----------
await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 700));
let steps = 0;
let reached = '';
for (let i = 0; i < 60; i++) {
  await page.keyboard.press('Tab');
  steps++;
  reached = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'none';
    return (a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  });
  if (reached === '记录一句') break;
}
p(`\n=== 键盘：从地址栏按 Tab ${steps} 次到达「记一句」输入框 ===`);

// ---------- 3. 空保存是否产生新版本 ----------
const ids = await page.evaluate(async () => {
  const caps = (await (await fetch('/api/captures')).json()).captures;
  const withAttempt = [];
  for (const c of caps) {
    const atts = (await (await fetch('/api/captures/' + c.id + '/attempts')).json()).attempts;
    for (const a of atts) withAttempt.push(a.id);
  }
  return withAttempt[0];
});
await page.goto(BASE + '/attempt/' + ids, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
const revBefore = await page.evaluate(async (id) => (await (await fetch('/api/attempts/' + id)).json()).attempt.revision, ids);
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '保存').click());
await new Promise((r) => setTimeout(r, 1200));
const revAfter = await page.evaluate(async (id) => (await (await fetch('/api/attempts/' + id)).json()).attempt.revision, ids);
p(`\n=== 未做任何修改点「保存」：revision ${revBefore} → ${revAfter} ===`);

// ---------- 4. 加入主题：空态死循环 ----------
const capId = await page.evaluate(async () => (await (await fetch('/api/captures')).json()).captures[0].id);
await page.goto(BASE + '/capture/' + capId, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '加入主题').click());
await new Promise((r) => setTimeout(r, 900));
const modalText = await page.evaluate(() => document.querySelector('[class*="Modal"]')?.innerText ?? document.querySelector('[role="dialog"]')?.innerText ?? '(未找到弹窗)');
p('\n=== 「加入主题」弹窗内容 ===\n' + modalText);
await page.screenshot({ path: `${OUT}/61-topic-modal-empty-1280.png` });
// 弹窗里有没有新建入口？
const modalBtns = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button')].map((b) => b.innerText.trim()));
p('[弹窗按钮] ' + JSON.stringify(modalBtns));

// ---------- 5. 离线 / 服务不可用时的反馈 ----------
await page.setRequestInterception(true);
const block = (req) => {
  if (req.url().includes('/api/')) req.abort();
  else req.continue();
};
page.on('request', block);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 2500));
const offline = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 600));
p('\n=== API 全断时的首页 ===\n' + offline);
await page.screenshot({ path: `${OUT}/62-home-api-down-1280.png`, fullPage: true });
page.off('request', block);
await page.setRequestInterception(false);

// ---------- 6. /kit 仍在生产？ ----------
await page.goto(BASE + '/kit', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
p('\n=== /kit ===\n' + (await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 400))));

fs.writeFileSync(`${OUT}/walk05.log.txt`, report.join('\n'), 'utf8');
await browser.close();
