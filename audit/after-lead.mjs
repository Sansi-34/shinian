// Lead 侧回归截图：把我已改完的部分按原角度重拍，用于前后对比
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-lead';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const log = [];
const p = (x) => { log.push(x); console.log(x); };

// 登录
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.screenshot({ path: `${OUT}/01-login.png`, fullPage: true });
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 2000));

async function shot(tag, path, wait = 900, full = true) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: full });
  p(`shot ${tag} ← ${path}`);
}

// 1. 首页（有 18 条数据）：主操作、左栏、幽灵胶囊、查看全部
await shot('02-home', '/');
const homeCheck = await page.evaluate(() => {
  const inp = document.querySelector('.v2-compose input');
  const cs = inp ? getComputedStyle(inp) : null;
  const more = document.querySelector('.v2-leftMore');
  const chips = [...document.querySelectorAll('.v2-ghosts a, .v2-ghosts button')].map((e) => `${e.tagName}:${e.getAttribute('href') || 'button'}`);
  return {
    inputBorder: cs ? `${cs.borderTopWidth} ${cs.borderTopColor}` : null,
    inputBg: cs ? cs.backgroundColor : null,
    leftMore: more ? more.textContent.trim() : null,
    ghostChips: chips,
  };
});
p('[首页] ' + JSON.stringify(homeCheck));

// 2. 尝试详情（干净状态栏？）
await shot('03-attempt', '/attempt/att-1795078914914-9w4eto');
const status = await page.evaluate(() => document.querySelector('[class*="StatusBar"]')?.innerText?.replace(/\s+/g, ' ') ?? '');
p('[尝试页状态栏] ' + status);

// 3. 念头详情 + 加入主题弹窗（浮层 token 关键验证）
const capId = await page.evaluate(async () => (await (await fetch('/api/captures')).json()).captures[0].id);
await page.goto(BASE + '/capture/' + capId, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '加入主题')?.click());
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/04-topic-modal.png` });
const modal = await page.evaluate(() => {
  const panel = document.querySelector('[role="dialog"]');
  if (!panel) return 'no dialog';
  const cs = getComputedStyle(panel);
  const inner = panel.parentElement;
  const ics = inner ? getComputedStyle(inner) : null;
  const primary = [...panel.querySelectorAll('button')].find((b) => /加入/.test(b.innerText));
  const pcs = primary ? getComputedStyle(primary) : null;
  return {
    panelBg: cs.backgroundColor, panelColor: cs.color, panelBorder: cs.borderTopColor,
    overlayBg: ics ? ics.backgroundColor : null,
    panelInsideV2: !!panel.closest('.v2-root'),
    primaryBg: pcs ? pcs.backgroundColor : null,
    primaryColor: pcs ? pcs.color : null,
    primaryText: primary ? primary.innerText.trim() : null,
  };
});
p('[弹窗] ' + JSON.stringify(modal));

// 4. 阶段回顾（徽章 + 统计卡）
await shot('05-review', '/review', 1200);
const badges = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.badge')].slice(0, 6).map((e) => {
    const cs = getComputedStyle(e);
    return `${e.innerText.trim()} | color=${cs.color} bg=${cs.backgroundColor}`;
  });
  const card = document.querySelector('.stat-card.review-stat');
  const label = card?.querySelector('.stat-label');
  return { badges: b, labelH: label ? Math.round(label.getBoundingClientRect().height) : null, labelText: label?.innerText };
});
p('[回顾] ' + JSON.stringify(badges));

// 5. 更多菜单（去重 + 遮罩）
await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 700));
await page.click('button[aria-label="更多"]');
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${OUT}/06-more-menu.png` });
const more = await page.evaluate(() => ({
  items: [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.innerText.trim()),
  hasScrim: !!document.querySelector('[class*="moreScrim"]'),
}));
p('[更多菜单] ' + JSON.stringify(more));

// 6. 主题页（新建入口）
await shot('07-topics', '/topics');
const topics = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('button, a')].find((e) => /新建主题/.test(e.innerText));
  return chip ? chip.tagName + ':' + chip.innerText.trim() : 'no create entry';
});
p('[主题页] ' + topics);

// 7. 灰度对比：ink-3 对比度复核
await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
const contrast = await page.evaluate(() => {
  const el = document.querySelector('.v2-leftMeta') || document.querySelector('.v2-groupNote');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { color: cs.color, size: cs.fontSize };
});
p('[ink-3 实际色] ' + JSON.stringify(contrast));

fs.writeFileSync(`${OUT}/report.txt`, log.join('\n'), 'utf8');
await browser.close();
