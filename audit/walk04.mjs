// 走查第四步：精确对比度（alpha 合成）+ 390 视口几何 + 更多菜单 + 主题系统
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const report = [];
const p = (x) => { report.push(x); console.log(x); };

const CONTRAST = `(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    let stack = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      n = n.parentElement;
    }
    stack.push(parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 });
    stack.push({ r: 255, g: 255, b: 255, a: 1 });
    let base = stack[stack.length - 1];
    for (let i = stack.length - 2; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (w.nextNode()) {
    const t = (w.currentNode.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length < 2) continue;
    const el = w.currentNode.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = bgOf(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
    const fs = parseFloat(cs.fontSize);
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    out.push({ t: t.slice(0, 40), cls: typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 2).join('.') : el.tagName, fs, fw, color: cs.color, ratio, need: large ? 3 : 4.5, failAA: ratio < (large ? 3 : 4.5) });
  }
  return out.filter((x) => x.failAA).sort((a, b) => a.ratio - b.ratio);
})()`;

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1500));

for (const path of ['/', '/search', '/topics', '/experiences', '/schedule', '/ask', '/review', '/activity', '/settings/ai', '/graph']) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));
  const fails = await page.evaluate(CONTRAST);
  p(`\n### ${path} AA 不达标 ${fails.length} 处`);
  for (const f of fails.slice(0, 12)) p(`  ${f.ratio} <${f.need} | ${f.fs}px/${f.fw} | .${f.cls} | "${f.t}" | ${f.color}`);
}

// ---------- 更多菜单 ----------
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await page.click('button[aria-label="更多"]');
await new Promise((r) => setTimeout(r, 400));
const more = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((e) => `${e.innerText.trim()} → ${e.getAttribute('href')}`));
p('\n=== 更多菜单 ===\n' + more.join('\n'));
const railItems = await page.evaluate(() => [...document.querySelectorAll('aside[aria-label="主导航"] a, aside[aria-label="主导航"] button')].map((e) => `${e.getAttribute('aria-label')} → ${e.getAttribute('href') || '(button)'}`));
p('=== 左侧图标栏 ===\n' + railItems.join('\n'));
await page.screenshot({ path: `${OUT}/50-more-menu-1280.png`, fullPage: false });

// ---------- 主题系统：两套？ ----------
const beforeTheme = await page.evaluate(() => ({ html: document.documentElement.getAttribute('data-theme'), v2: document.querySelector('.v2-root')?.getAttribute('data-v2-theme'), ls: JSON.stringify(localStorage) }));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /纸张主题|暗色主题/.test(x.innerText));
  b && b.click();
});
await new Promise((r) => setTimeout(r, 400));
const afterV2 = await page.evaluate(() => ({ html: document.documentElement.getAttribute('data-theme'), v2: document.querySelector('.v2-root')?.getAttribute('data-v2-theme'), ls: JSON.stringify(localStorage) }));
await page.goto(BASE + '/ask', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
const onLegacy = await page.evaluate(() => {
  const t = document.querySelector('.gz-theme-toggle');
  return { toggleText: t ? t.innerText.trim() : null, html: document.documentElement.getAttribute('data-theme'), body: getComputedStyle(document.body).backgroundColor, v2: document.querySelector('.v2-root')?.getAttribute('data-v2-theme') ?? '(no v2 root)', ls: JSON.stringify(localStorage) };
});
await page.screenshot({ path: `${OUT}/51-ask-after-v2-theme-change-1280.png`, fullPage: false });
p('\n=== 主题系统 ===\nV2 前: ' + JSON.stringify(beforeTheme) + '\nV2 后: ' + JSON.stringify(afterV2) + '\n切到旧页 /ask: ' + JSON.stringify(onLegacy));

// 旧页切主题后再回 V2
await page.evaluate(() => document.querySelector('.gz-theme-toggle')?.click());
await new Promise((r) => setTimeout(r, 400));
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
const backV2 = await page.evaluate(() => ({ html: document.documentElement.getAttribute('data-theme'), v2: document.querySelector('.v2-root')?.getAttribute('data-v2-theme'), bg: getComputedStyle(document.querySelector('.v2-root')).backgroundColor }));
p('旧页切主题后回 V2: ' + JSON.stringify(backV2));

// ---------- 390 几何 ----------
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await m.setCookie(...(await page.cookies()));
for (const path of ['/', '/search', '/capture?x=1']) {
  if (path.includes('capture')) continue;
  await m.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));
  const geo = await m.evaluate(() => {
    const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const rail = rect('aside[aria-label="主导航"]');
    const center = rect('main');
    const inp = rect('.v2-compose input') || rect('.v2-searchBox input');
    const left = rect('nav[aria-label="记录"], nav[aria-label="全部念头"]');
    const leftVisible = left && getComputedStyle(document.querySelector('nav[aria-label="记录"], nav[aria-label="全部念头"]')).display !== 'none';
    // 内容是否被图标栏压住
    const overlap = rail && center ? Math.max(0, rail.x + rail.w - center.x) : null;
    const segs = [...document.querySelectorAll('main button')].slice(0, 6).map((e) => { const r = e.getBoundingClientRect(); return `${e.innerText.trim().slice(0, 6)}:${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    return { rail, center, inp, leftVisible, overlap, segs, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  });
  p(`\n=== 390 ${path} 几何 ===\n` + JSON.stringify(geo, null, 1));
}
await m.screenshot({ path: `${OUT}/52-m-home-390.png`, fullPage: false });
await m.goto(BASE + '/search', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
await m.screenshot({ path: `${OUT}/53-m-search-390.png`, fullPage: false });

// 键盘 Tab 顺序（桌面）
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
const tabs = [];
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('Tab');
  tabs.push(await page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'none';
    const label = (a.getAttribute('aria-label') || a.innerText || a.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return `${a.tagName.toLowerCase()}「${label}」`;
  }));
}
p('\n=== Tab 顺序（首页前 14 步）===\n' + tabs.join(' → '));

fs.writeFileSync(`${OUT}/walk04.log.txt`, report.join('\n'), 'utf8');
await browser.close();
