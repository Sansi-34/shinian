// 尝试详情页 · 脏检查三态取证（A/B/C 三个改动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-attempt';
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const p = (s) => {
  log.push(s);
  console.log(s);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200));
});
await page.setViewport({ width: 1280, height: 900 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await sleep(500);
}

async function readState(tag) {
  const info = await page.evaluate(() => {
    const footer = document.querySelector('footer');
    const spans = footer ? [...footer.querySelectorAll('span')] : [];
    const rightSpan = spans.length ? spans[spans.length - 1] : null;
    const statusText = rightSpan ? rightSpan.innerText.trim() : '(none)';
    const statusStyle = rightSpan ? getComputedStyle(rightSpan) : null;

    const saveBtn = [...document.querySelectorAll('.v2-form button')].find(
      (b) => /保存|仍然标记完成|保存中/.test(b.innerText || ''),
    );
    const saveStyle = saveBtn ? getComputedStyle(saveBtn) : null;

    // 头部动作区
    const head = document.querySelector('.v2-captureHead .v2-captureActions');
    const headBtns = head
      ? [...head.children].map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12),
            tag: el.tagName.toLowerCase(),
            left: Math.round(r.left),
            right: Math.round(r.right),
            color: cs.color,
            borderColor: cs.borderTopColor,
          };
        })
      : [];

    // 记录结果模块的说明文字
    const hint = [...document.querySelectorAll('.v2-form .v2-hint')].find((e) =>
      (e.innerText || '').includes('保存后用于阶段回顾统计'),
    );
    let hintBox = null;
    if (hint) {
      const r = hint.getBoundingClientRect();
      const cs = getComputedStyle(hint);
      const s = saveBtn.getBoundingClientRect();
      hintBox = {
        fontSize: cs.fontSize,
        color: cs.color,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        belowButton: r.top >= s.bottom - 1,
        deltaTop: Math.round(r.top - s.top),
      };
    }

    return {
      url: location.pathname,
      statusText,
      statusFontSize: statusStyle ? statusStyle.fontSize : null,
      statusColor: statusStyle ? statusStyle.color : null,
      saveDisabled: saveBtn ? saveBtn.disabled : null,
      saveLabel: saveBtn ? saveBtn.innerText.trim() : null,
      saveOpacity: saveStyle ? saveStyle.opacity : null,
      headBtns,
      hint: hintBox,
      revisionHint: (document.querySelector('footer')?.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  });
  p(`\n===== ${tag} =====`);
  p(JSON.stringify(info, null, 2));
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  return info;
}

// ---------- 登录 ----------
await go('/');
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '阿念');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('开启拾念之旅'));
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
  p('已登录');
} else {
  p('已处于登录态');
}

// ---------- 进入尝试详情 ----------
await go('/attempt/att-1795078914914-9w4eto');
await page.waitForSelector('.v2-editor', { timeout: 20000 });
await sleep(800);
const s1 = await readState('01-loaded-no-change');

// ---------- 改一个字 ----------
await page.click('.v2-editor');
await page.keyboard.down('Control');
await page.keyboard.press('End');
await page.keyboard.up('Control');
await page.type('.v2-editor', '（实测）', { delay: 30 });
await sleep(600);
const s2 = await readState('02-dirty-after-edit');

// ---------- 保存 ----------
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.v2-form button')].find((b) => /^保存$/.test((b.innerText || '').trim()));
  btn?.click();
});
await sleep(2000);
const s3 = await readState('03-saved');

// ---------- 还原后再看是否回到「无改动 / 已保存」 ----------
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.v2-form button')].find((b) => (b.innerText || '').trim() === '还原');
  btn?.click();
});
await sleep(500);
const s4 = await readState('04-after-revert');

p('\n===== 汇总 =====');
p(`01 进入未改：status="${s1.statusText}" saveDisabled=${s1.saveDisabled}`);
p(`02 改一个字：status="${s2.statusText}" saveDisabled=${s2.saveDisabled}`);
p(`03 保存后：  status="${s3.statusText}" saveDisabled=${s3.saveDisabled} saveLabel="${s3.saveLabel}"`);
p(`04 还原后：  status="${s4.statusText}"`);
p('header 顺序：' + JSON.stringify(s1.headBtns));
p('hint：' + JSON.stringify(s2.hint));
p('errors: ' + (errs.length ? errs.join(' | ') : 'none'));

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ s1, s2, s3, s4, errs }, null, 2), 'utf8');
fs.writeFileSync(`${OUT}/report.txt`, log.join('\n'), 'utf8');

await browser.close();
