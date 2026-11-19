// 复核：「来源念头」模块（标题、无 count、展开后那一条链接）
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

await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '阿念');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('开启拾念之旅'))?.click(),
  );
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
}

await page.goto(BASE + '/attempt/att-1795078914914-9w4eto', { waitUntil: 'networkidle0' });
await page.waitForSelector('.v2-editor');
await sleep(900);

// 模块标题与 count
const modules = await page.evaluate(() =>
  [...document.querySelectorAll('section h2')].map((h) => {
    const head = h.closest('button');
    return {
      title: h.innerText.trim(),
      count: head?.querySelector('span[class*="count"]')?.innerText ?? null,
      expanded: head?.getAttribute('aria-expanded'),
    };
  }),
);
p('模块列表：' + JSON.stringify(modules));
p('状态栏：' + (await page.evaluate(() => {
  const f = document.querySelector('footer');
  const s = [...f.querySelectorAll('span')];
  return s[s.length - 1].innerText.trim();
})));

// 折叠态截图（整页）
await page.screenshot({ path: `${OUT}/09-source-module-collapsed.png`, fullPage: true });

// 展开
await page.evaluate(() => {
  const h = [...document.querySelectorAll('section h2')].find((x) => (x.innerText || '').includes('来源念头'));
  h?.closest('button')?.click();
});
await sleep(700);
const rowInfo = await page.evaluate(() => {
  const h = [...document.querySelectorAll('section h2')].find((x) => (x.innerText || '').includes('来源念头'));
  const sec = h?.closest('section');
  const link = sec?.querySelector('a');
  return {
    expanded: h?.closest('button')?.getAttribute('aria-expanded'),
    text: (sec?.innerText || '').replace(/\s+/g, ' ').trim(),
    href: link?.getAttribute('href') ?? null,
    pillCount: sec ? sec.querySelectorAll('[class*="pill"], span').length : null,
  };
});
p('展开后：' + JSON.stringify(rowInfo));
await page.screenshot({ path: `${OUT}/10-source-module-open.png`, fullPage: true });

p('errors: ' + (errs.length ? errs.join(' | ') : 'none'));
fs.writeFileSync(`${OUT}/report-source-module.txt`, log.join('\n'), 'utf8');
await browser.close();
