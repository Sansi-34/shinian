// 走查第三步：诊断低对比 / 剪切 / 截断 / 标题，并做移动端 390 视口走查
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { PROBE } from './probe.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const page = await browser.newPage();
const report = [];
const p = (x) => { report.push(x); console.log(x); };
await page.setViewport({ width: 1280, height: 900 });

// 登录（账号已存在，重新登录）
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1500));

// ---------- A. 低对比诊断（/review 的筛选 chip） ----------
await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
const chipDiag = await page.evaluate(() => {
  const out = [];
  for (const sel of ['.filter-chip', '.review-filter-chip', '.review-range-preset']) {
    for (const el of [...document.querySelectorAll(sel)].slice(0, 8)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      let chain = [];
      let n = el;
      for (let i = 0; i < 4 && n; i++) {
        const c = getComputedStyle(n);
        chain.push(`${n.className || n.tagName}: bg=${c.backgroundColor} img=${c.backgroundImage.slice(0, 30)} color=${c.color}`);
        n = n.parentElement;
      }
      out.push({ text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 24), cls: el.className, color: cs.color, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height), chain });
    }
  }
  return out;
});
p('=== /review chip 实测 ===');
for (const c of chipDiag) p(JSON.stringify(c));

// ---------- B. 剪切诊断 ----------
const clipDiag = await page.evaluate(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = (walker.currentNode.nodeValue || '').trim();
    if (!t) continue;
    const el = walker.currentNode.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const overflowX = el.scrollWidth - el.clientWidth;
    const overflowY = el.scrollHeight - el.clientHeight;
    if (overflowX > 2 || overflowY > 2) {
      out.push({ t: t.slice(0, 30), cls: typeof el.className === 'string' ? el.className : el.tagName, ox: overflowX, oy: overflowY, h: el.clientHeight, sh: el.scrollHeight, overflow: cs.overflow, lh: cs.lineHeight, fs: cs.fontSize });
    }
  }
  return out.slice(0, 25);
});
p('\n=== /review 剪切实测 ===');
for (const c of clipDiag) p(JSON.stringify(c));

// ---------- C. 页面 <title> 是否随页面变化 ----------
const titles = [];
for (const path of ['/', '/search', '/topics', '/experiences', '/schedule', '/ask', '/graph', '/review', '/activity', '/settings/ai', '/kit']) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 500));
  titles.push(`${path} → ${await page.title()}`);
}
p('\n=== 每页 document.title ===\n' + titles.join('\n'));

// ---------- D. 造 15 条念头，验证左栏截断 ----------
await page.goto(BASE, { waitUntil: 'networkidle0' });
const seeded = await page.evaluate(async () => {
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? r.json() : { error: r.status };
  };
  const out = [];
  for (let i = 0; i < 15; i++) out.push(await post('/api/captures', { rawText: `压测念头 ${i + 1}：用来验证左栏会不会被截断，以及计数是否和列表条数一致。` }));
  return out.filter((x) => x.capture).length;
});
p(`\n=== 额外造了 ${seeded} 条念头 ===`);
await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
const leftDiag = await page.evaluate(() => {
  const items = document.querySelectorAll('.v2-leftItem');
  const count = document.querySelector('[class*="headCount"]');
  const more = [...document.querySelectorAll('a,button')].filter((e) => /查看全部|更多|全部念头/.test(e.innerText || '')).map((e) => e.innerText.trim());
  return { headCount: count ? count.innerText : null, rendered: items.length, hasSeeAll: more, lastText: items.length ? items[items.length - 1].innerText.replace(/\s+/g, ' ').slice(0, 40) : null };
});
p('[首页左栏] ' + JSON.stringify(leftDiag));
await page.screenshot({ path: `${OUT}/30-home-19captures-1280.png`, fullPage: true });
const searchDiag = await page.goto(BASE + '/search', { waitUntil: 'networkidle0' }).then(() => new Promise((r) => setTimeout(r, 700))).then(() =>
  page.evaluate(() => ({ headCount: document.querySelector('[class*="headCount"]')?.innerText, rendered: document.querySelectorAll('.v2-leftItem').length }))
);
p('[检索页左栏] ' + JSON.stringify(searchDiag));

// 长文本行是否溢出/换行过多
const longRow = await page.evaluate(PROBE);
fs.writeFileSync(`${OUT}/31-search-19captures.json`, JSON.stringify(longRow, null, 2), 'utf8');
await page.screenshot({ path: `${OUT}/31-search-19captures.png`, fullPage: true });

// ---------- E. 移动端 390 ----------
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const cookies = await page.cookies();
await m.setCookie(...cookies);
const mOut = [];
async function mProbe(tag, path) {
  await m.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  const info = await m.evaluate(PROBE);
  fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(info, null, 2), 'utf8');
  await m.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  mOut.push(`\n===== ${tag} :: ${info.url} =====`);
  mOut.push(`overflowX=${info.horizontalOverflow} scrollW=${info.scrollWidth} innerW=${info.viewport.w} scrollH=${info.scrollHeight}`);
  mOut.push('TEXT: ' + info.text.replace(/\n{2,}/g, '\n').slice(0, 700));
  if (info.tiny.length) mOut.push('SMALL-TARGET: ' + info.tiny.slice(0, 12).map((x) => `${x.label}${x.w}x${x.h}`).join(' | '));
  mOut.push('BUTTONS: ' + info.buttons.map((b) => b.label).slice(0, 20).join(' · '));
}
await mProbe('40-m-home-390', '/');
await mProbe('41-m-search-390', '/search');
await mProbe('42-m-capture-390', await page.evaluate(() => 0).then(async () => {
  const caps = await page.evaluate(async () => (await (await fetch('/api/captures')).json()).captures);
  return '/capture/' + caps[0].id;
}));
await mProbe('43-m-topics-390', '/topics');
await mProbe('44-m-ask-390', '/ask');
mOut.forEach(p);
fs.writeFileSync(`${OUT}/walk03.log.txt`, report.join('\n'), 'utf8');
await browser.close();
