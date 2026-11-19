// 走查第六步（续）：默认 09:30 结束 + 现在开始 → 是否静默生成跨日日程
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

const attId = await page.evaluate(async () => {
  const caps = (await (await fetch('/api/captures')).json()).captures;
  for (const c of caps) {
    const atts = (await (await fetch('/api/captures/' + c.id + '/attempts')).json()).attempts;
    if (atts.length) return atts[0].id;
  }
});
await page.goto(BASE + '/attempt/' + attId, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '排日程').click());
await new Promise((r) => setTimeout(r, 700));

// 点「现在」
await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button')].find((b) => b.innerText.trim() === '现在')?.click());
await new Promise((r) => setTimeout(r, 400));
const afterNow = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input, [class*="Modal"] input')].map((i) => `${i.getAttribute('aria-label')}=${i.value}`));
p('[点「现在」之后] ' + JSON.stringify(afterNow));

// 直接把开始时间改成 22:00，结束保持默认 09:30，保存
await page.evaluate(() => {
  const start = [...document.querySelectorAll('[role="dialog"] input, [class*="Modal"] input')].find((i) => (i.getAttribute('aria-label') || '').includes('开始时间'));
  if (start) {
    start.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(start, '22:00');
    start.dispatchEvent(new Event('input', { bubbles: true }));
    start.dispatchEvent(new Event('blur', { bubbles: true }));
  }
});
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button')].find((b) => b.innerText.trim() === '保存')?.click());
await new Promise((r) => setTimeout(r, 1500));
const modalAfter = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]');
  return dlg ? dlg.innerText.replace(/\n+/g, ' | ') : '(弹窗已关闭)';
});
p('\n[保存后弹窗] ' + modalAfter);

const scheds = await page.evaluate(async (id) => (await (await fetch('/api/attempts/' + id + '/schedules')).json()), attId);
p('\n[服务端日程] ' + JSON.stringify(scheds.schedules.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, status: s.status })), null, 1));
const dur = scheds.schedules[0] ? (new Date(scheds.schedules[0].endsAt) - new Date(scheds.schedules[0].startsAt)) / 3600000 : null;
p(`[时长] ${dur} 小时`);
await page.screenshot({ path: `${OUT}/72-schedule-crossday-result.png`, fullPage: true });
fs.writeFileSync(`${OUT}/walk06b.log.txt`, report.join('\n'), 'utf8');
await browser.close();
