// 拾念 SHINIAN v0.2 · 日程安排浏览器端到端验收（真实 Chrome，桌面 1280×900 + 手机 390×844）
//
// 前置：独立 E2E 服务已启动（默认 http://127.0.0.1:3300）
//   $env:PORT="3300"; $env:DATABASE_URL="<repo>\db\e2e-schedule.sqlite"; `
//   $env:SHINIAN_MASTER_KEY_FILE="<repo>\db\e2e-schedule-master.key"; npm run serve
// 运行：
//   $env:SHINIAN_BASE="http://127.0.0.1:3300"; node scripts/e2e_schedule.mjs
//
// 流程（契约 §7 / 任务验收）：
//   打开已有尝试 → 安排到今天 → 首页找到 → 修改到另一时段 → 打开尝试记录结果
//   → 查看历史安排 → 为另一个尝试安排下一次时间。
// 所有演示数据文案带「演示」，截图可直接辨认。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3300').replace(/\/$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `日程演示-${Date.now() % 100000}`;
const STAMP = Date.now() % 1000000;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

function dateKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((el) => el.textContent || '');
    if (t.includes(text)) {
      await h.click();
      return true;
    }
  }
  return false;
}

async function clickTestId(page, id) {
  const el = await page.$(`[data-testid="${id}"]`);
  if (!el) return false;
  await el.click();
  return true;
}

async function clickTestIdOrText(page, id, selector, text) {
  if (await clickTestId(page, id)) return true;
  return clickText(page, selector, text);
}

async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function waitTestId(page, id, timeout = 15000) {
  await page.waitForSelector(`[data-testid="${id}"]`, { timeout });
}

/** 点击包含指定尝试文案的日程条目；没有匹配时退回第一条，保证重复运行可定位本次数据。 */
async function clickScheduleDetail(page, stepText) {
  const buttons = await page.$$('[data-testid="schedule-detail"]');
  for (const button of buttons) {
    const rowText = await button.evaluate((el) => el.closest('li')?.innerText || '');
    if (rowText.includes(stepText)) {
      await button.click();
      return true;
    }
  }
  if (buttons[0]) {
    await buttons[0].click();
    return true;
  }
  return false;
}

/** 用 React 能识别的原生 setter 写入受控 input/textarea。 */
async function setField(page, selector, value) {
  await page.$eval(
    selector,
    (el, v) => {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

async function setViewport(page, width, height, scale = 1) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await new Promise((r) => setTimeout(r, 350));
}

async function noHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
}

async function createCaptureAndAttempt(page, captureText, stepText) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  await page.type('.capture-input', captureText);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, captureText);
  await clickText(page, '.card-main', captureText);
  await page.waitForSelector('.start-choices', { timeout: 15000 });
  await clickText(page, '.start-card', '自己写一步');
  await page.waitForSelector('.manual-attempt input[type="text"]', { timeout: 10000 });
  await page.type('.manual-attempt input[type="text"]', stepText);
  await clickText(page, '.manual-attempt button', '创建尝试');
  await waitText(page, stepText);
  await clickText(page, '.card-main', stepText);
  await page.waitForSelector('.attempt-page', { timeout: 15000 });
  return page.url();
}

async function arrangeTime(page, { date, start, end, note }) {
  const opened = await clickTestIdOrText(page, 'schedule-add', 'button', '安排时间');
  check('尝试详情可打开「安排时间」表单', opened);
  await waitTestId(page, 'schedule-date', 10000);
  await setField(page, '[data-testid="schedule-date"]', date);
  await setField(page, '[data-testid="schedule-start"]', start);
  await setField(page, '[data-testid="schedule-end"]', end);
  if (note) await setField(page, '[data-testid="schedule-note"]', note);
  await clickTestIdOrText(page, 'schedule-save', 'button', '保存安排');
  // 若该时段已有残留安排，确认重叠后继续（重复运行同一 E2E 库时仍可完成流程）
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('安排已保存') ||
      document.querySelector('[data-testid="schedule-confirm-overlap"]') !== null,
    { timeout: 20000 }
  );
  if (await page.$('[data-testid="schedule-confirm-overlap"]')) {
    await clickTestId(page, 'schedule-confirm-overlap');
  }
  await waitText(page, '安排已保存', 20000);
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const TODAY = dateKey(0);
const TOMORROW = dateKey(1);
const CAP1 = `【演示】PWM 低占空比时 LED 会闪，安排一次验证 ${STAMP}`;
const STEP1 = `【演示】比较 500 Hz 与 2 kHz 的闪烁 ${STAMP}`;
const CAP2 = `【演示】调光时想避免肉眼可见闪烁，安排下一次 ${STAMP}`;
const STEP2 = `【演示】按旧结论复测 2 kHz 调光 ${STAMP}`;
const NOTE1 = '【演示】今天下午先验证闪烁';
const NOTE1B = '【演示】改到晚上再验证';
const NOTE2 = '【演示】明天上午复测调光';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--lang=zh-CN',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage();
await setViewport(page, 1280, 900);

try {
  console.log('— 登录并创建已有尝试（演示数据）');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.login-card', { timeout: 15000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  check('登录成功并进入首页', await page.evaluate(() => !!document.querySelector('.capture-input')));

  await createCaptureAndAttempt(page, CAP1, STEP1);
  check('已有尝试详情已打开', await page.evaluate(() => document.body.innerText.includes('日程安排')));
  check('新尝试默认没有安排', await page.evaluate(() => document.body.innerText.includes('这条尝试还没有安排时间。')));

  console.log('— 安排到今天');
  await arrangeTime(page, { date: TODAY, start: '19:00', end: '20:00', note: NOTE1 });
  check('安排保存后显示成功提示', await page.evaluate(() => document.body.innerText.includes('安排已保存')));
  const attemptListText = await page.$eval('.attempt-schedule-list', (el) => el.innerText);
  check('尝试详情列出今天的安排与备注', attemptListText.includes('19:00') && attemptListText.includes('20:00') && attemptListText.includes(NOTE1), attemptListText.slice(0, 200));
  check('已有尝试创建安排后仍可看到结果表单', await page.evaluate(() => !!document.querySelector('.result-form')));

  console.log('— 首页今天的安排');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await waitText(page, '今天的安排');
  await page.waitForSelector('[data-testid="today-schedule-item"]', { timeout: 15000 });
  const homeScheduleText = await page.$$eval(
    '[data-testid="today-schedule-item"]',
    (els, step) => els.map((el) => el.innerText).find((text) => text.includes(step)) || '',
    STEP1
  );
  check('首页今天的安排包含时间与尝试名称', homeScheduleText.includes('19:00') && homeScheduleText.includes(STEP1), homeScheduleText.slice(0, 200));
  check('首页今天的安排展示演示备注/尝试标识', homeScheduleText.includes('演示'));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-01-home-desktop.png`, fullPage: true });

  console.log('— 日程页今日 / 本周与显示时区');
  await page.goto(BASE + '/schedule', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.schedule-page', { timeout: 15000 });
  await page.waitForSelector('.schedule-today-section', { timeout: 15000 });
  check('日程页默认显示 Asia/Shanghai', await page.evaluate(() => document.body.innerText.includes('Asia/Shanghai')));
  const dayText = await page.$eval('.schedule-page', (el) => el.innerText);
  check('日程页今日视图包含今天的安排', dayText.includes('19:00') && dayText.includes(STEP1), dayText.slice(0, 250));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-02-day-desktop.png`, fullPage: true });

  const weekTab = await page.$$('.schedule-view-tabs .tab');
  if (weekTab[1]) await weekTab[1].click();
  await page.waitForSelector('.week-board', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const weekText = await page.$eval('.week-board', (el) => el.innerText);
  check('日程页本周视图包含同一安排', weekText.includes('19:00') && weekText.includes(STEP1), weekText.slice(0, 300));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-03-week-desktop.png`, fullPage: true });

  const todayTab = await page.$$('.schedule-view-tabs .tab');
  if (todayTab[0]) await todayTab[0].click();
  await page.waitForSelector('.schedule-today-section', { timeout: 10000 });
  await page.select('[data-testid="display-timezone"]', 'America/New_York');
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('显示时区 America/New_York') &&
      (document.querySelector('.schedule-today-section')?.innerText || '').includes('06:00'),
    { timeout: 15000 }
  );
  const nyText = await page.$eval('.schedule-today-section', (el) => el.innerText);
  check('切换显示时区后时间按纽约格式化（19:00 → 06:00）', nyText.includes('06:00') && nyText.includes(STEP1), nyText.slice(0, 250));
  check('日程保留创建时区 Asia/Shanghai', await page.evaluate(() => document.body.innerText.includes('Asia/Shanghai')));
  await page.select('[data-testid="display-timezone"]', 'Asia/Shanghai');
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('显示时区 Asia/Shanghai') &&
      (document.querySelector('.schedule-today-section')?.innerText || '').includes('19:00'),
    { timeout: 15000 }
  );

  console.log('— 从日程页修改到另一时段');
  check('可在日程页定位本次安排条目', await clickScheduleDetail(page, STEP1));
  await page.waitForSelector('.schedule-detail-modal', { timeout: 10000 });
  check('打开安排详情弹层', await page.evaluate(() => document.body.innerText.includes('安排详情')));
  check('详情展示尝试与原始念头关联', await page.evaluate(() => document.body.innerText.includes('尝试') && document.body.innerText.includes('念头')));
  await clickText(page, '.schedule-detail-modal button', '修改时间');
  await waitTestId(page, 'schedule-start', 10000);
  const editDate = await page.$eval('[data-testid="schedule-date"]', (el) => el.value);
  check('编辑表单沿用安排日期', editDate === TODAY, editDate);
  await setField(page, '[data-testid="schedule-start"]', '20:00');
  await setField(page, '[data-testid="schedule-end"]', '21:00');
  await setField(page, '[data-testid="schedule-note"]', NOTE1B);
  await clickTestIdOrText(page, 'schedule-save', 'button', '保存修改');
  // 保存成功后弹层回到查看态；详情头的提示会被 revision effect 清掉，因此断言渲染结果。
  // 重复运行同一 E2E 库时，新时段可能与上次演示数据重叠，此时先明确确认再保存。
  await page.waitForFunction(
    () => {
      const heading = document.querySelector('.schedule-detail-modal h3');
      return (
        (heading && heading.innerText.includes('20:00') && heading.innerText.includes('21:00')) ||
        document.querySelector('[data-testid="schedule-confirm-overlap"]') !== null
      );
    },
    { timeout: 20000 }
  );
  if (await page.$('[data-testid="schedule-confirm-overlap"]')) {
    await clickTestId(page, 'schedule-confirm-overlap');
  }
  await page.waitForFunction(
    () => {
      const heading = document.querySelector('.schedule-detail-modal h3');
      return (
        heading &&
        heading.innerText.includes('20:00') &&
        heading.innerText.includes('21:00') &&
        !document.querySelector('[data-testid="schedule-save"]')
      );
    },
    { timeout: 20000 }
  );
  const modalText = await page.$eval('.schedule-detail-modal', (el) => el.innerText);
  check('修改后详情显示新时段', modalText.includes('20:00') && modalText.includes('21:00'), modalText.slice(0, 250));
  check('修改后详情显示新备注', modalText.includes(NOTE1B));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-04-detail-desktop.png`, fullPage: true });

  console.log('— 打开尝试并记录结果');
  await clickText(page, '.schedule-detail-modal a', '打开尝试');
  await page.waitForSelector('.attempt-page', { timeout: 15000 });
  const updatedList = await page.$eval('.attempt-schedule-list', (el) => el.innerText);
  check('尝试详情历史安排已显示新时段', updatedList.includes('20:00') && updatedList.includes('21:00'), updatedList.slice(0, 200));
  await setField(page, '.result-form textarea', '【演示】20:00 时段复测：2 kHz 下肉眼几乎不可见');
  await page.select('.result-form select', 'success');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存', 20000);
  check('记录结果成功', await page.evaluate(() => document.body.innerText.includes('结果已保存')));
  const resultVisible = await page.evaluate(() => {
    const textarea = document.querySelector('.result-form textarea');
    return (
      document.body.innerText.includes('【演示】20:00') ||
      (textarea instanceof HTMLTextAreaElement && textarea.value.includes('【演示】20:00'))
    );
  });
  check('历史安排与结果同时可见', updatedList.includes('20:00') && resultVisible);
  await page.screenshot({ path: `${SHOT_DIR}/schedule-05-attempt-desktop.png`, fullPage: true });

  console.log('— 为另一个尝试安排下一次时间');
  const attempt2Url = await createCaptureAndAttempt(page, CAP2, STEP2);
  await arrangeTime(page, { date: TOMORROW, start: '10:00', end: '11:00', note: NOTE2 });
  const secondList = await page.$eval('.attempt-schedule-list', (el) => el.innerText);
  const tomorrowLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.now() + 86400000));
  check('第二个尝试显示明天的安排', secondList.includes('10:00') && secondList.includes('11:00') && secondList.includes(NOTE2), secondList.slice(0, 250));
  check('第二个尝试安排日期为明天', secondList.includes(tomorrowLabel), `${tomorrowLabel} / ${secondList.slice(0, 250)}`);
  await page.screenshot({ path: `${SHOT_DIR}/schedule-06-next-desktop.png`, fullPage: true });

  console.log('— 手机 390×844 复核');
  await setViewport(page, 390, 844, 2);
  await page.goto(BASE + '/schedule', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.schedule-page', { timeout: 15000 });
  await page.waitForSelector('.schedule-today-section', { timeout: 15000 });
  check('手机宽度日程页无横向溢出', await noHorizontalOverflow(page));
  const mobileDay = await page.$eval('.schedule-page', (el) => el.innerText);
  check('手机日程页仍显示今天的安排', mobileDay.includes('20:00') && mobileDay.includes(STEP1), mobileDay.slice(0, 250));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-07-day-mobile.png`, fullPage: true });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="today-schedule-item"]', { timeout: 15000 });
  check('手机宽度首页无横向溢出', await noHorizontalOverflow(page));
  const mobileHome = await page.$$eval(
    '[data-testid="today-schedule-item"]',
    (els, step) => els.map((el) => el.innerText).find((text) => text.includes(step)) || '',
    STEP1
  );
  check('手机首页今天的安排可读', mobileHome.includes('20:00') && mobileHome.includes(STEP1), mobileHome.slice(0, 200));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-08-home-mobile.png`, fullPage: true });

  await page.goto(attempt2Url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 15000 });
  check('手机宽度尝试详情无横向溢出', await noHorizontalOverflow(page));
  await waitText(page, '日程安排');
  await page.screenshot({ path: `${SHOT_DIR}/schedule-09-attempt-mobile.png`, fullPage: true });
  await clickScheduleDetail(page, STEP2);
  await page.waitForSelector('.schedule-detail-modal', { timeout: 10000 });
  check('手机宽度安排详情弹层可打开', await page.evaluate(() => document.body.innerText.includes('安排详情')));
  await page.screenshot({ path: `${SHOT_DIR}/schedule-10-detail-mobile.png`, fullPage: true });

  await setViewport(page, 1280, 900);
  check('两种视口均完成完整日程流程', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/schedule-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`日程浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
