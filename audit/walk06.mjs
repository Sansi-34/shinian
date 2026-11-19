// 走查第六步：排日程默认结束时间陷阱 + 断网时登录页表现
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'] });
const report = [];
const p = (x) => { report.push(x); console.log(x); };
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.login-card');
await page.click('.login-card input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('.login-card input', '阿念');
await page.click('.login-card button[type="submit"]');
await new Promise((r) => setTimeout(r, 1500));

const attId = await page.evaluate(async () => {
  const caps = (await (await fetch('/api/captures')).json()).captures;
  for (const c of caps) {
    const atts = (await (await fetch('/api/captures/' + c.id + '/attempts')).json()).attempts;
    if (atts.length) return atts[0].id;
  }
});
await page.goto(BASE + '/attempt/' + attId, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '排日程').click());
await new Promise((r) => setTimeout(r, 700));

// 打开日期选择器，选今天，时间填 22:00
const schedUi = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]');
  return {
    dlgText: dlg ? dlg.innerText.replace(/\n+/g, ' | ') : '(no dialog)',
    inputs: [...document.querySelectorAll('[role="dialog"] input, [class*="Modal"] input')].map((i) => `${i.type}|${i.value}|${i.placeholder}|${i.getAttribute('aria-label')}`),
    buttons: [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button')].map((b) => b.innerText.trim()),
  };
});
p('=== 排日程弹窗初始状态 ===\n' + JSON.stringify(schedUi, null, 1));
await page.screenshot({ path: `${OUT}/70-schedule-modal-initial.png` });

// 点日期按钮 → 看日历 → 选今天 → 设置时间 22:00
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button')].find((x) => /未设置日期|设置日期/.test(x.innerText));
  b && b.click();
});
await new Promise((r) => setTimeout(r, 600));
const calText = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"], [class*="Modal"]');
  return dlg ? dlg.innerText.replace(/\n+/g, ' | ') : '';
});
p('\n=== 日历展开后 ===\n' + calText);
await page.screenshot({ path: `${OUT}/71-schedule-calendar.png` });

// 用键盘在日期时间控件里输入（DateField 自绘）
const dateInputs = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] input, [class*="Modal"] input')].map((i) => `${i.type}|${i.value}|${i.getAttribute('aria-label')}`));
p('[输入框] ' + JSON.stringify(dateInputs));

fs.writeFileSync(`${OUT}/walk06.log.txt`, report.join('\n'), 'utf8');
await browser.close();
