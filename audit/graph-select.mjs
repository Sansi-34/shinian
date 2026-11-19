import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/final';
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-gpu','--lang=zh-CN'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 900 });
await p.goto(BASE, { waitUntil: 'networkidle0' });
await p.waitForSelector('.login-card');
await p.click('.login-card input', { clickCount: 3 }); await p.keyboard.press('Backspace');
await p.type('.login-card input', '阿念');
await p.click('.login-card button[type="submit"]');
await new Promise(r => setTimeout(r, 1600));
await p.goto(BASE + '/graph', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));
// 点左栏第一个节点项（它是按钮，aria-label 形如 "念头：xxx，N 条连接"）
const clicked = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(e => /念头：|尝试：|经验：/.test(e.getAttribute('aria-label') || ''));
  if (!btn) return null;
  btn.click();
  return btn.getAttribute('aria-label');
});
await new Promise(r => setTimeout(r, 1200));
await p.screenshot({ path: OUT + '/graph-selected.png' });
const info = await p.evaluate(() => ({
  sub: document.querySelector('.gd-sub')?.innerText?.slice(0,80) ?? null,
  actions: [...document.querySelectorAll('.gd-actions .gd-btn, .gd-actions button')].map(x => x.innerText.trim()),
  heading: document.querySelector('.graph-detail')?.previousElementSibling?.innerText ?? null,
}));
console.log('clicked =', clicked);
console.log('info =', JSON.stringify(info));
await b.close();
