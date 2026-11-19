// 最终复核（用最终代码）：三态 + 顺手把我上一轮测试写进结果里的「（实测）」清掉
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

const read = () =>
  page.evaluate(() => {
    const footer = document.querySelector('footer');
    const spans = footer ? [...footer.querySelectorAll('span')] : [];
    const saveBtn = [...document.querySelectorAll('.v2-form button')].find((b) =>
      /保存|仍然标记完成/.test(b.innerText || ''),
    );
    return {
      statusLeft: spans.length ? spans[0].innerText.trim() : null,
      statusRight: spans.length ? spans[spans.length - 1].innerText.trim() : null,
      saveDisabled: saveBtn ? saveBtn.disabled : null,
      result: document.querySelector('.v2-editor')?.value ?? null,
    };
  });

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
const s1 = await read();
p('① 进入页面未改动：' + JSON.stringify({ statusRight: s1.statusRight, saveDisabled: s1.saveDisabled, left: s1.statusLeft }));
await page.screenshot({ path: `${OUT}/01-loaded-no-change.png`, fullPage: true });

// 改一个字（用原生 setter 触发 React onChange）
await page.evaluate(() => {
  const ta = document.querySelector('.v2-editor');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value.replace('（实测）', '') + '（复核实测）');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(600);
const s2 = await read();
p('② 改一个字：' + JSON.stringify({ statusRight: s2.statusRight, saveDisabled: s2.saveDisabled }));
await page.screenshot({ path: `${OUT}/02-dirty-after-edit.png`, fullPage: true });

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.v2-form button')].find((b) => /^保存$/.test((b.innerText || '').trim()));
  btn?.click();
});
await sleep(2200);
const s3 = await read();
p('③ 保存后：' + JSON.stringify({ statusRight: s3.statusRight, saveDisabled: s3.saveDisabled, left: s3.statusLeft }));
await page.screenshot({ path: `${OUT}/03-saved.png`, fullPage: true });

// 收尾：把我写进去的测试尾巴清掉，恢复原始结果文本，保持数据干净
await page.evaluate(() => {
  const ta = document.querySelector('.v2-editor');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ta.value.replace('（复核实测）', ''));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(400);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.v2-form button')].find((b) => /^保存$/.test((b.innerText || '').trim()));
  btn?.click();
});
await sleep(2200);
const s4 = await read();
p('④ 清掉测试尾巴保存后：' + JSON.stringify({ statusRight: s4.statusRight, left: s4.statusLeft }));
p('   结果文本：' + JSON.stringify(s4.result));
p('errors: ' + (errs.length ? errs.join(' | ') : 'none'));

fs.writeFileSync(`${OUT}/report-final.txt`, log.join('\n'), 'utf8');
await browser.close();
