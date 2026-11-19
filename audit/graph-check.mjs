// 知识图谱页视觉走查：登录 → /graph → 选中节点 / 局部图 → 截图 + 关键元素度量
// 用法：node audit/graph-check.mjs <tag> <WxH> <mode: plain|select|local> [search]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const TAG = process.argv[2] || 'before';
const VIEW = process.argv[3] || '1280x900';
const MODE = process.argv[4] || 'select';
const NEEDLE = process.argv[5] || '';
const [vw, vh] = VIEW.split('x').map(Number);
const OUT = 'D:/联动日程表/audit/shots/after-graph';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) errs.push(`HTTP ${r.status()} ${r.url()}`);
});
await page.setViewport({ width: vw, height: vh });

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await sleep(700);
}

await go('/');
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '走查');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.innerText || '').includes('开启拾念之旅')
    );
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
}

await go('/graph');
await sleep(1800);

if (MODE === 'select') {
  const clicked = await page.evaluate((needle) => {
    const nodes = [...document.querySelectorAll('.graph-node')];
    const pick =
      (needle && nodes.find((n) => (n.getAttribute('aria-label') || '').includes(needle))) ||
      nodes.find((n) => n.classList.contains('graph-node-capture') && !n.classList.contains('dim')) ||
      nodes[0];
    if (!pick) return null;
    const r = pick.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const opts = { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 };
    pick.dispatchEvent(new PointerEvent('pointerdown', opts));
    pick.dispatchEvent(new PointerEvent('pointerup', opts));
    pick.dispatchEvent(new MouseEvent('click', opts));
    return { label: pick.getAttribute('aria-label'), x: Math.round(x), y: Math.round(y) };
  }, NEEDLE);
  await sleep(900);
  console.log('CLICKED:', JSON.stringify(clicked));
}

if (MODE === 'local') {
  const target = await page.evaluate(async () => {
    const res = await fetch('/api/graph', { credentials: 'include' });
    const data = await res.json();
    const lonely = data.nodes.filter((n) => n.type === 'capture' && n.degree === 0);
    const pick = lonely[0] || data.nodes[0];
    return pick?.id ?? null;
  });
  if (target) {
    await go(`/graph?node=${encodeURIComponent(target)}&depth=1`);
    await sleep(1400);
  }
}

if (MODE === 'body') {
  // 选一条「正文比标题长」的记录：验证副标题/正文的拆分
  const target = await page.evaluate(async () => {
    const res = await fetch('/api/graph', { credentials: 'include' });
    const data = await res.json();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const pick = data.nodes
      .filter((n) => norm(n.detail).length > norm(n.label).length + 8)
      .sort((a, b) => norm(b.detail).length - norm(a.detail).length)[0];
    return pick?.id ?? null;
  });
  if (target) {
    await go(`/graph?focus=${encodeURIComponent(target)}`);
    await sleep(1200);
  }
}

const shot = `${OUT}/${TAG}-${MODE}-${VIEW}.png`;
await page.screenshot({ path: shot, fullPage: false });

const info = await page.evaluate(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const style = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const btnCss = ['background-color', 'color', 'border', 'border-radius', 'font-size', 'min-height', 'padding'];
  const actions = [...document.querySelectorAll('.graph-panel .graph-actions > *')].map((el) => ({
    tag: el.tagName,
    cls: el.className,
    text: (el.innerText || '').trim(),
    box: rect(el),
    css: style(el, btnCss),
  }));
  const strayButtons = [...document.querySelectorAll('.graph-panel .graph-center-btn')].map((el) => ({
    text: (el.innerText || '').trim(),
    box: rect(el),
    parent: el.parentElement?.className,
  }));
  const h2 = document.querySelector('.graph-panel h2');
  const sub = document.querySelector('.graph-panel .gd-sub');
  const body = document.querySelector('.graph-panel .graph-detail');
  const hint = document.querySelector('.gd-canvas-hint');
  const scopeEl = document.querySelector('.gd-scope');
  const names = ['--ink', '--ink-2', '--ink-3', '--line', '--line-2', '--raise', '--raise-2', '--accent', '--accent-soft', '--hover', '--fs-title', '--r-1', '--r-2'];
  const vars = {};
  if (scopeEl) {
    const cs = getComputedStyle(scopeEl);
    for (const n of names) vars[n] = cs.getPropertyValue(n).trim();
  }
  return {
    url: location.href,
    nodeCount: document.querySelectorAll('.graph-node').length,
    panelText: (document.querySelector('.graph-panel')?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 800),
    title: { text: h2?.innerText, box: rect(h2), css: style(h2, ['font-size', 'color', 'font-weight']) },
    sub: { text: sub?.innerText, box: rect(sub), css: style(sub, ['font-size', 'color', 'line-height']) },
    body: { text: body?.innerText, box: rect(body), css: style(body, ['font-size', 'color', 'line-height']) },
    duplicateTitle: h2 && sub ? h2.innerText.trim() === sub.innerText.trim() : null,
    actions,
    strayButtons,
    hint: hint
      ? { text: hint.innerText, box: rect(hint), css: style(hint, ['pointer-events', 'color', 'font-size', 'opacity', 'position', 'z-index']) }
      : null,
    hintHitTest: hint
      ? (() => {
          const r = hint.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { tag: el?.tagName, cls: typeof el?.className === 'string' ? el.className : String(el?.className?.baseVal ?? '') };
        })()
      : null,
    stageBox: rect(document.querySelector('.graph-stage')),
    scopeVars: vars,
  };
});

fs.writeFileSync(`${OUT}/${TAG}-${MODE}-${VIEW}.json`, JSON.stringify(info, null, 2), 'utf8');
console.log('SHOT:', shot);
console.log(JSON.stringify(info, null, 2));
if (errs.length) console.log('ERRORS:', errs.slice(0, 10));
await browser.close();
