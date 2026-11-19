// 输入法（IME）组合态回车是否会误提交 —— 中文用户的高频路径
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1800));

const count = async () => page.evaluate(async () => (await (await fetch('/api/captures')).json()).captures.length);
const before = await count();

// 模拟：中文输入法还在候选态（isComposing=true）时按回车
const dispatched = await page.evaluate(() => {
  const input = document.querySelector('.v2-compose input');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '输入法候选态里的半成品文字');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  input.dispatchEvent(ev);
  return { isComposing: ev.isComposing, defaultPrevented: ev.defaultPrevented };
});
await new Promise((r) => setTimeout(r, 1500));
const after = await count();
console.log('[IME] 事件属性 ' + JSON.stringify(dispatched));
console.log(`[IME] 念头数 before=${before} after=${after} → ${after > before ? '组合态回车仍然提交了（误提交）' : '未提交（有保护）'}`);

// 对照：检索页同样没有守卫
const s = await page.evaluate(() => {
  const i = document.querySelector('.v2-searchBox input');
  if (!i) return 'no search input';
  return 'search input 存在，onKeyDown 无 isComposing 守卫（代码位置 SearchV2Page.tsx:169）';
});
console.log('[搜索] ' + s);
await browser.close();
