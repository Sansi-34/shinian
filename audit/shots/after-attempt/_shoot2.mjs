// 补充取证：状态切换的脏检查 / 还原归零 / 纸张主题与窄屏下的危险按钮
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-attempt';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
await page.setViewport({ width: 1280, height: 900 });

const status = () =>
  page.evaluate(() => {
    const footer = document.querySelector('footer');
    const spans = footer ? [...footer.querySelectorAll('span')] : [];
    const right = spans.length ? spans[spans.length - 1].innerText.trim() : '(none)';
    const saveBtn = [...document.querySelectorAll('.v2-form button')].find((b) =>
      /保存|仍然标记完成/.test(b.innerText || ''),
    );
    return { right, saveDisabled: saveBtn ? saveBtn.disabled : null };
  });

await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '阿念');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('开启拾念之旅'))?.click());
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
}

await page.goto(BASE + '/attempt/att-1795078914914-9w4eto', { waitUntil: 'networkidle0' });
await page.waitForSelector('.v2-editor');
await sleep(800);
p('进入页面：' + JSON.stringify(await status()));

// 只点「状态」分段，不动文本
await page.evaluate(() => {
  const seg = [...document.querySelectorAll('.v2-form [role="group"]')][0];
  const btn = [...seg.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '未开始');
  btn?.click();
});
await sleep(500);
p('点了状态分段（未开始）：' + JSON.stringify(await status()));
await page.screenshot({ path: `${OUT}/05-dirty-by-state.png`, fullPage: true });

// 还原
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.v2-form button')].find((b) => (b.innerText || '').trim() === '还原');
  btn?.click();
});
await sleep(500);
p('还原后：' + JSON.stringify(await status()));
await page.screenshot({ path: `${OUT}/06-revert-clean.png`, fullPage: true });

// 纸张主题
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('footer button')].find((b) => /主题/.test(b.innerText || ''));
  btn?.click();
});
await sleep(700);
const paper = await page.evaluate(() => {
  const del = [...document.querySelectorAll('.v2-captureHead button')].find((b) => (b.innerText || '').includes('删除'));
  const cs = del ? getComputedStyle(del) : null;
  const r = del ? del.getBoundingClientRect() : null;
  const footer = document.querySelector('footer');
  const spans = footer ? [...footer.querySelectorAll('span')] : [];
  return {
    theme: document.querySelector('.v2-root')?.getAttribute('data-v2-theme'),
    delColor: cs ? cs.color : null,
    delBorder: cs ? cs.borderTopColor : null,
    delRight: r ? Math.round(r.right) : null,
    statusBar: spans.length ? spans[spans.length - 1].innerText.trim() : null,
  };
});
p('纸张主题：' + JSON.stringify(paper));
await page.screenshot({ path: `${OUT}/07-paper-theme.png`, fullPage: true });

// 窄屏 390：看动作区换行
await page.setViewport({ width: 390, height: 844 });
await sleep(600);
await page.screenshot({ path: `${OUT}/08-mobile-390.png`, fullPage: true });

p('errors: ' + (errs.length ? errs.join(' | ') : 'none'));
fs.writeFileSync(`${OUT}/report2.txt`, log.join('\n'), 'utf8');
await browser.close();
