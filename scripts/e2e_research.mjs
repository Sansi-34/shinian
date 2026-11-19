// 拾念 SHINIAN · 「研究一下」浏览器端到端验收（真实 Chrome，桌面 1280×900 + 手机 390×844）
// 前置：
//   fake_github_server.py 已启动（3510）；fake_model_server.py 已启动（3501）
//   独立 E2E 服务已启动（默认 http://127.0.0.1:3300），SHINIAN_GITHUB_API_BASE=http://127.0.0.1:3510
//   已配置模型 fake-research-success
// 运行：
//   $env:SHINIAN_BASE="http://127.0.0.1:3300"; node scripts/e2e_research.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3300').replace(/\/$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `研究验收-${Date.now() % 100000}`;
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

async function waitText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

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

async function findCandidateButton(page, text) {
  const cards = await page.$$('.candidate-card');
  for (const card of cards) {
    const t = await card.evaluate((el) => el.innerText);
    if (!t.includes(text)) continue;
    const btn = await card.$('.candidate-select');
    if (!btn) return false;
    const disabled = await btn.evaluate((el) => el.disabled);
    if (disabled) return false;
    await btn.click();
    return true;
  }
  return false;
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
const TODAY = dateKey(0);
const CAP = `【研究演示】想在 ESP32-S3 上做离线唤醒词“小念” ${STAMP}`;
const QUERY = 'wake word';
const ADOPT_TITLE = `【研究演示】烧录最小示例并测唤醒 ${STAMP}`;

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
  console.log('— 登录并保存一个想法');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 20000 });
  await page.type('.capture-input', CAP);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, CAP, 20000);
  check('保存想法成功', await page.evaluate((t) => document.body.innerText.includes(t), CAP));

  console.log('— 打开念头详情并进入「研究一下」');
  await clickText(page, '.card-main', CAP);
  await page.waitForSelector('.start-choices', { timeout: 20000 });
  check('念头详情展示研究入口', await page.evaluate(() => document.body.innerText.includes('研究一下')));
  await clickText(page, '.start-card', '研究一下');
  await page.waitForSelector('.research-form', { timeout: 15000 });
  await page.screenshot({ path: `${SHOT_DIR}/research-01-entry-desktop.png`, fullPage: true });
  check('研究表单默认带入念头原文', await page.$eval('.research-form textarea', (el) => el.value.includes('离线唤醒词')));

  console.log('— 编辑研究问题与限制并预览');
  await setField(page, '.research-form textarea', `在 ESP32-S3 上实现离线唤醒词“小念”，有哪些开源项目可以参考？${STAMP}`);
  await page.evaluate((values) => {
    const inputs = Array.from(document.querySelectorAll('.research-form input'));
    values.forEach((value, index) => {
      if (!inputs[index]) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, [
    '离线识别“小念”并触发动作',
    'ESP32-S3 + MAX9814，Windows + PlatformIO',
    'C/C++',
    '两周',
    '离线运行、许可证清晰',
    QUERY,
  ]);
  await clickText(page, 'button', '预览将发送的内容');
  await waitText(page, '发起前确认', 20000);
  const previewText = await page.$eval('.research-preview', (el) => el.innerText);
  check('预览显示 GitHub 检索词', previewText.includes(QUERY), previewText.slice(0, 200));
  check('预览显示数量限制', previewText.includes('候选 ≤ 10') && previewText.includes('深入 ≤ 3'));
  check('预览显示模型状态', previewText.includes('将使用'));
  check('预览显示 GitHub 凭据方式', previewText.includes('匿名公开读取') || previewText.includes('Token'));
  await page.screenshot({ path: `${SHOT_DIR}/research-02-preview-desktop.png`, fullPage: true });

  console.log('— 确认发起并选择候选');
  await clickText(page, '.research-preview button', '确认并发起研究');
  await page.waitForSelector('.research-page', { timeout: 20000 });
  await page.waitForSelector('.candidate-list', { timeout: 30000 });
  const candidateText = await page.$eval('.candidate-list', (el) => el.innerText);
  check('候选列表展示仓库、语言与许可证', candidateText.includes('octo/') && candidateText.includes('主要语言'));
  check('候选展示归档状态与元数据更新时间', candidateText.includes('已归档') && candidateText.includes('非代码提交时间'));
  await page.screenshot({ path: `${SHOT_DIR}/research-03-candidates-desktop.png`, fullPage: true });

  const picked =
    (await findCandidateButton(page, 'octo/no-license-demo')) &&
    (await findCandidateButton(page, 'octo/partial-fail-demo'));
  check('可以选择两个候选深入读取', picked);
  await page.waitForFunction(
    () => document.body.innerText.includes('已选 2/3'),
    { timeout: 10000 }
  );
  check('选择计数与按钮文案随实际选择变化', await page.evaluate(() => document.body.innerText.includes('深入比较这 2 个')));
  await clickText(page, '.select-bar button', '深入比较这 2 个');

  console.log('— 等待资料与对比');
  await waitText(page, '已获取的资料', 40000);
  await waitText(page, '对比结果', 40000);
  check('展示资料缺失与模型对比', await page.evaluate(() => document.body.innerText.includes('资料缺失') && document.body.innerText.includes('模型推断')));
  check('展示证据图例区分声明/事实/推断/待测试', await page.evaluate(() => document.body.innerText.includes('仓库作者的声明') && document.body.innerText.includes('待实际测试')));
  check('展示来源链接与获取时间', await page.evaluate(() => document.body.innerText.includes('获取于') && document.body.innerText.includes('https://github.com/')));
  const citations = await page.$$('.source-chip');
  check('关键判断附近提供来源入口', citations.length > 0);
  if (citations[0]) {
    await citations[0].click();
    await new Promise((r) => setTimeout(r, 300));
    check('点击引用可展开并跳到来源', await page.evaluate(() => Array.from(document.querySelectorAll('.source-excerpt')).some((el) => el.innerText.length > 0)));
  }
  check('展示本次用量', await page.evaluate(() => document.body.innerText.includes('本次用量') && document.body.innerText.includes('GitHub 请求')));
  await page.screenshot({ path: `${SHOT_DIR}/research-04-result-desktop.png`, fullPage: true });

  console.log('— 保存研究');
  await clickText(page, 'button', '保存研究');
  await waitText(page, '研究已保存', 20000);
  check('研究保存成功并显示保存时间', await page.evaluate(() => document.body.innerText.includes('已保存于')));

  console.log('— 手机宽度查看研究');
  await setViewport(page, 390, 844, 2);
  await new Promise((r) => setTimeout(r, 500));
  check('手机宽度无横向溢出', await noHorizontalOverflow(page));
  check('手机宽度仍可看到来源与实验操作', await page.evaluate(() => document.body.innerText.includes('已获取的资料') && document.body.innerText.includes('编辑并试一步')));
  await page.screenshot({ path: `${SHOT_DIR}/research-05-result-mobile.png` });
  await page.evaluate(() => {
    const target = document.querySelector('#comparison');
    if (target) window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - 12));
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${SHOT_DIR}/research-05b-comparison-mobile.png` });
  await setViewport(page, 1280, 900);

  console.log('— 编辑并采用一个小实验');
  await clickText(page, '.experiment-card button', '编辑并试一步');
  await page.waitForSelector('.adopt-form', { timeout: 15000 });
  await setField(page, '.adopt-form input', ADOPT_TITLE);
  await setField(page, '.adopt-form textarea', '按 README 最小示例编译烧录到 ESP32-S3，记录依赖安装耗时、首次报错与能否识别“小念”。');
  const minuteInput = await page.$('.adopt-form input[inputmode="numeric"]');
  if (minuteInput) await setField(page, '.adopt-form input[inputmode="numeric"]', '30');
  await clickText(page, '.adopt-form button', '采用并创建尝试');
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  check('采用后进入现有尝试详情', await page.evaluate((t) => document.body.innerText.includes(t), ADOPT_TITLE));
  check('尝试详情保留来源研究', await page.evaluate(() => document.body.innerText.includes('来源研究') || document.body.innerText.includes('研究')));
  check('尝试带来源念头与研究关联', await page.evaluate(() => document.body.innerText.includes('研究一下') || document.body.innerText.includes('来源研究')));

  console.log('— 安排时间并记录实际结果');
  if (await clickTestId(page, 'schedule-add')) {
    await page.waitForSelector('[data-testid="schedule-date"]', { timeout: 10000 });
    await setField(page, '[data-testid="schedule-date"]', TODAY);
    await setField(page, '[data-testid="schedule-start"]', '21:00');
    await setField(page, '[data-testid="schedule-end"]', '22:00');
    await setField(page, '[data-testid="schedule-note"]', '研究演示：先跑通最小示例');
    await clickTestId(page, 'schedule-save');
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
    check('安排时间成功', await page.evaluate(() => document.body.innerText.includes('安排已保存')));
  } else {
    check('尝试详情可打开「安排时间」', false);
  }
  await setField(page, '.result-form textarea', '最小示例编译通过并烧录成功，但默认模型没有识别“小念”，需要下一步训练自定义唤醒词。');
  await page.select('.result-form select', 'undetermined');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存', 20000);
  check('记录实际结果成功', await page.evaluate(() => document.body.innerText.includes('结果已保存')));
  check(
    '结果评价保存为「未判定」',
    await page.$eval('.result-form select', (el) => el.value === 'undetermined')
  );
  await page.screenshot({ path: `${SHOT_DIR}/research-06-attempt-desktop.png`, fullPage: true });

  console.log('— 手机宽度查看尝试');
  await setViewport(page, 390, 844, 2);
  await new Promise((r) => setTimeout(r, 500));
  check('手机宽度尝试页无横向溢出', await noHorizontalOverflow(page));
  check('手机宽度仍可看到来源研究与结果', await page.evaluate(() => document.body.innerText.includes('来源研究') && document.body.innerText.includes('结果')));
  await page.screenshot({ path: `${SHOT_DIR}/research-07-attempt-mobile.png` });

  console.log('— 返回研究列表');
  await setViewport(page, 1280, 900);
  await page.goto(`${BASE}/research`, { waitUntil: 'networkidle0' });
  await waitText(page, '已保存的研究', 20000);
  check('研究列表包含已保存研究', await page.evaluate((s) => document.body.innerText.includes(s), String(STAMP)));
  await page.screenshot({ path: `${SHOT_DIR}/research-08-index-desktop.png`, fullPage: true });
} catch (err) {
  failed++;
  failures.push(`异常 ${err.message}`);
  console.log(`FAIL  异常  ${err.stack || err.message}`);
  try {
    await page.screenshot({ path: `${SHOT_DIR}/research-failure.png`, fullPage: true });
  } catch {}
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(60));
console.log(`研究一下浏览器验收: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(60));
process.exit(failed === 0 ? 0 : 1);
