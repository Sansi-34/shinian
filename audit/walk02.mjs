// 走查第二步：核心任务闭环（记念头 → 试一步 → 记结果）+ 空态与死入口取证
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { PROBE } from './probe.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });
await page.setViewport({ width: 1280, height: 900 });

const report = [];
function p(line) { report.push(line); console.log(line); }

async function probe(tag, shot = true) {
  const info = await page.evaluate(PROBE);
  fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(info, null, 2), 'utf8');
  if (shot) await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  p(`\n===== ${tag} :: ${info.url} =====`);
  p(`viewport ${info.viewport.w}x${info.viewport.h} scrollW=${info.scrollWidth} overflowX=${info.horizontalOverflow} scrollH=${info.scrollHeight}`);
  p('TEXT: ' + info.text.replace(/\n{2,}/g, '\n').slice(0, 1400));
  if (info.lowContrast.length) p('LOW-CONTRAST: ' + info.lowContrast.map((x) => `"${x.t}"(${x.fs}px/${x.contrast})`).join(' | '));
  if (info.clipped.length) p('CLIPPED: ' + info.clipped.map((x) => `"${x.t}"`).join(' | '));
  if (info.tiny.length) p('SMALL-TARGET(<44px): ' + info.tiny.map((x) => `${x.label}${x.w}x${x.h}`).join(' | '));
  if (info.unlabeled.length) p('UNLABELED: ' + info.unlabeled.join(' | '));
  p('BUTTONS: ' + info.buttons.map((b) => `${b.label}[${b.cls}]`).join(' · '));
  return info;
}

async function clickText(text, tag = '') {
  const ok = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
    const hit = els.find((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().includes(t));
    if (!hit) return false;
    hit.scrollIntoView({ block: 'center' });
    hit.click();
    return true;
  }, text);
  if (!ok) p(`!! 点不到「${text}」${tag ? ' @' + tag : ''}`);
  await new Promise((r) => setTimeout(r, 900));
  return ok;
}

async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
}

// ---------- 登录 ----------
await go('/');
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await clickText('开启拾念之旅');
await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
await probe('10-home-fresh');

// ---------- 死入口：三颗 GhostChip ----------
const beforeUrl = page.url();
await clickText('我整理的经验');
const afterExp = page.url();
await clickText('我的主题');
const afterTopic = page.url();
await clickText('今日日程');
const afterSched = page.url();
p(`\n[死入口取证] url before=${beforeUrl} after经验=${afterExp} after主题=${afterTopic} after日程=${afterSched}`);
const ghostInfo = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.v2-ghosts button')];
  return btns.map((b) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { t: b.innerText.replace(/\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), cursor: cs.cursor, bg: cs.backgroundColor, disabled: b.disabled };
  });
});
p('[GhostChip] ' + JSON.stringify(ghostInfo));

// ---------- 记念头（核心任务第 1 步，走 UI） ----------
const longThought =
  '想给桌面加一个「开机就显示今天该做什么」的小面板：现在每天要先打开拾念，才知道昨天记的尝试还差哪一步没做。如果能直接贴在桌面上，犹豫的时间会少一点。';
await page.type('.v2-compose input', longThought);
await new Promise((r) => setTimeout(r, 300));
await clickText('记下');
await new Promise((r) => setTimeout(r, 1200));
const afterSave = await page.evaluate(() => document.body.innerText);
p('\n[保存念头后] ' + (afterSave.includes('开机就显示') ? '列表已出现' : '列表未出现'));
await probe('11-home-after-capture');

// 再加两条短念头
for (const t of ['把常用命令写成便签贴在桌面上', '试试每天早上先写三句话再开电脑']) {
  await page.click('.v2-compose input');
  await page.type('.v2-compose input', t);
  await clickText('记下');
  await new Promise((r) => setTimeout(r, 900));
}

// ---------- 进入念头详情 ----------
await clickText('开机就显示', 'home-left');
await new Promise((r) => setTimeout(r, 800));
const capProbe = await probe('12-capture-detail');

// ---------- 自己写一步 ----------
await clickText('自己写一步');
await new Promise((r) => setTimeout(r, 400));
await page.type('.v2-writer textarea', '先找三个桌面常驻面板工具，各看 10 分钟');
await clickText('创建尝试');
await new Promise((r) => setTimeout(r, 1200));
await probe('13-capture-with-attempt');

// ---------- 进入尝试详情 ----------
await clickText('先找三个桌面常驻面板工具');
await new Promise((r) => setTimeout(r, 1000));
const attProbe = await probe('14-attempt-detail');

// 未做任何修改时，状态栏说什么
const statusBarText = await page.evaluate(() => document.querySelector('[class*="StatusBar"]')?.innerText ?? document.body.innerText.slice(-200));
p('\n[尝试页状态栏·未修改] ' + JSON.stringify(statusBarText));

// ---------- 记结果 ----------
await page.click('.v2-editor');
await page.type('.v2-editor', '看了 Rainmeter、Ubuntu 的 Conky、Window 自带便签。前两个都要装东西，最后一个是手动的。');
await clickText('已完成');
await new Promise((r) => setTimeout(r, 300));
await clickText('达成');
await new Promise((r) => setTimeout(r, 300));
await clickText('保存');
await new Promise((r) => setTimeout(r, 1200));
const savedInfo = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 900), status: document.querySelector('[class*="StatusBar"]')?.innerText ?? '' }));
p('\n[保存结果后] status=' + JSON.stringify(savedInfo.status));
await probe('15-attempt-saved');

// 保存后状态栏是否回落到“已保存/未修改”
p('\n[保存后状态栏全文] ' + JSON.stringify(await page.evaluate(() => document.querySelector('[class*="StatusBar"]')?.innerText ?? '')));

// ---------- 主题 / 经验 / 日程 / 问记录 空态与入口 ----------
await go('/topics');
await probe('20-topics-empty');
await go('/experiences');
await probe('21-experiences-empty');
await go('/schedule');
await probe('22-schedule-empty');
await go('/ask');
await probe('23-ask');
await go('/graph');
await probe('24-graph');
await go('/settings/ai');
await probe('25-settings-ai');
await go('/review');
await probe('26-review');
await go('/activity');
await probe('27-activity');

p('\n===== 网络/脚本错误 =====\n' + errs.join('\n'));
fs.writeFileSync(`${OUT}/walk02.log.txt`, report.join('\n'), 'utf8');
await browser.close();
