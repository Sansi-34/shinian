// 单页视口截图（避免 fullPage 超长导致看不了）
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-lead';
const target = process.env.TARGET || '/review';
const name = process.env.NAME || 'review-vp';
const scrollY = parseInt(process.env.SCROLL || '0', 10);

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
await page.goto(BASE + target, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));
if (scrollY) { await page.evaluate((y) => window.scrollTo(0, y), scrollY); await new Promise((r) => setTimeout(r, 500)); }
await page.screenshot({ path: `${OUT}/${name}.png` });
console.log('shot', name, target, 'scroll', scrollY);
await browser.close();
