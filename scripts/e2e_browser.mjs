// 拾念 SHINIAN v0.1 - 真实浏览器端到端验收（本机 Chrome 无头模式，手机宽度 390x844）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHINIAN_BASE || 'http://127.0.0.1:3000';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = 'shots';

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

async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((el) => el.textContent || '');
    if (t.includes(text)) {
      await h.click();
      return;
    }
  }
  throw new Error(`未找到可点击元素: ${selector} 含「${text}」`);
}

async function waitText(page, text, timeout = 15000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function fill(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 180000,
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
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

try {
  console.log('— 打开应用');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.login-card', { timeout: 10000 });
  check('首次访问进入本机登录页', true);
  await fill(page, '.login-card input', '浏览器验收');
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  check('登录后进入首页输入框', true);

  const CAP1 = 'PWM 低占空比时 LED 会闪';
  const CAP2 = '调光时想避免肉眼可见闪烁，需要选频率';
  const RESULT = '500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁';

  console.log('— 保存念头 1');
  await page.type('.capture-input', CAP1);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, CAP1);
  check('保存后列表出现念头', true);
  await page.screenshot({ path: `${SHOT_DIR}/01-home-saved.png`, fullPage: true });

  console.log('— 创建尝试 1');
  await clickText(page, '.card-main', CAP1);
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  if (!(await page.$('.attempt-form input[type="text"]'))) {
    await clickText(page, 'button', '自己写一步');
    await page.waitForSelector('.attempt-form input[type="text"]', { timeout: 10000 });
  }
  await page.type('.attempt-form input[type="text"]', '比较两种 PWM 频率');
  await clickText(page, '.attempt-form button', '创建尝试');
  await waitText(page, '比较两种 PWM 频率');
  check('念头详情创建尝试成功', true);

  console.log('— 记录结果 1');
  await clickText(page, '.card-main', '比较两种 PWM 频率');
  await page.waitForSelector('.result-form', { timeout: 10000 });
  await page.type('.result-form textarea', RESULT);
  await page.select('.result-form select', 'failure');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存');
  check('记录观察结果成功（已结束 + 失败）', true);
  await page.screenshot({ path: `${SHOT_DIR}/02-attempt-result.png`, fullPage: true });

  console.log('— 保存念头 2');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  await page.type('.capture-input', CAP2);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, CAP2);
  await clickText(page, '.card-main', CAP2);
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  if (!(await page.$('.attempt-form input[type="text"]'))) {
    await clickText(page, 'button', '自己写一步');
    await page.waitForSelector('.attempt-form input[type="text"]', { timeout: 10000 });
  }
  await page.type('.attempt-form input[type="text"]', '按旧结论选 2 kHz 试调光');
  await clickText(page, '.attempt-form button', '创建尝试');
  await waitText(page, '按旧结论选 2 kHz 试调光');
  check('创建第二条调光念头及尝试', true);

  console.log('— 搜索「闪烁」');
  await page.goto(BASE + '/search', { waitUntil: 'networkidle0' });
  await page.type('.search-bar input', '闪烁');
  await clickText(page, '.search-bar button', '搜索');
  await waitText(page, '尝试与结果');
  check('搜索「闪烁」显示旧观察摘要', await page.evaluate(() => document.body.innerText.includes('可见闪烁')));
  check('搜索显示匹配的念头原文', await page.evaluate(() => document.body.innerText.includes('调光时想避免肉眼可见闪烁')));
  await page.screenshot({ path: `${SHOT_DIR}/03-search.png`, fullPage: true });

  console.log('— 打开旧尝试并回源');
  await clickText(page, '.card-main', '比较两种 PWM 频率');
  await page.waitForSelector('.result-form', { timeout: 10000 });
  const resultValue = await page.$eval('.result-form textarea', (el) => el.value);
  check('从搜索打开旧尝试', resultValue.includes('500 Hz'), resultValue);
  await clickText(page, '.crumb a', CAP1);
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  check('从尝试回源原念头', await page.evaluate(() => document.body.innerText.includes('PWM 低占空比时 LED 会闪')));

  console.log('— 引用旧结果');
  await page.goto(BASE + '/search', { waitUntil: 'networkidle0' });
  await page.type('.search-bar input', '2 kHz');
  await clickText(page, '.search-bar button', '搜索');
  await waitText(page, '尝试与结果');
  await clickText(page, '.card-main', '按旧结论选 2 kHz 试调光');
  await page.waitForSelector('.attempt-page', { timeout: 10000 });
  await clickText(page, 'button', '＋ 引用已有结果');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.type('.modal .search-bar input', '闪烁');
  await clickText(page, '.modal .search-bar button', '搜索');
  await page.waitForSelector('.pick-item', { timeout: 10000 });
  await clickText(page, '.pick-item', '比较两种 PWM 频率');
  await page.waitForSelector('.modal .field input', { timeout: 10000 });
  await page.type('.modal .field input', '先按 2 kHz 继续验证调光');
  await clickText(page, '.modal button', '确认引用');
  await waitText(page, '引用时的结果');
  check('创建引用并可查看快照', true);

  console.log('— 编辑旧结果，检查更新提示');
  await page.goto(BASE + '/search', { waitUntil: 'networkidle0' });
  await page.type('.search-bar input', 'PWM');
  await clickText(page, '.search-bar button', '搜索');
  await waitText(page, '尝试与结果');
  await clickText(page, '.card-main', '比较两种 PWM 频率');
  await page.waitForSelector('.result-form', { timeout: 10000 });
  await fill(page, '.result-form textarea', RESULT + '（复测确认）');
  await page.select('.result-form select', 'success');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存');
  await page.goto(BASE + '/search', { waitUntil: 'networkidle0' });
  await page.type('.search-bar input', '2 kHz');
  await clickText(page, '.search-bar button', '搜索');
  await waitText(page, '尝试与结果');
  await clickText(page, '.card-main', '按旧结论选 2 kHz 试调光');
  await page.waitForSelector('.attempt-page', { timeout: 10000 });
  await waitText(page, '来源有更新');
  check('旧结果编辑后显示「来源有更新」提示', true);
  const snapshotOk = await page.evaluate(() =>
    document.body.innerText.includes('引用时的结果：500 Hz 时仍有可见闪烁，2 kHz 时肉眼未见闪烁')
  );
  check('引用处保留引用时的文本快照', snapshotOk);
  await page.screenshot({ path: `${SHOT_DIR}/04-reference-updated.png`, fullPage: true });

  console.log('— 刷新验证引用');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 10000 });
  await waitText(page, '引用时的结果');
  check('刷新后引用仍在', true);

  console.log('— 双浏览器版本冲突');
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 390, height: 844 });
  await pageB.bringToFront();
  await pageB.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await clickText(pageB, '.card-main', CAP1);
  await pageB.waitForSelector('.detail-title', { timeout: 10000 });
  await pageB.screenshot({ path: `${SHOT_DIR}/05-capture-detail.png`, fullPage: true });

  await page.bringToFront();
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await clickText(page, '.card-main', CAP1);
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  await clickText(page, 'button', '编辑');
  await fill(page, '.edit-block textarea', 'PWM 低占空比时 LED 会闪（A 已修改）');
  await clickText(page, 'button', '保存');
  await waitText(page, '（A 已修改）');

  await pageB.bringToFront();
  await pageB.waitForSelector('.detail-title', { timeout: 10000 });
  await clickText(pageB, 'button', '编辑');
  await fill(pageB, '.edit-block textarea', 'PWM 低占空比时 LED 会闪（B 的草稿）');
  await clickText(pageB, 'button', '保存');
  await pageB.waitForSelector('.conflict-banner', { timeout: 10000 });
  const draftKept = await pageB.$eval('.edit-block textarea', (el) => el.value.includes('B 的草稿'));
  check('双浏览器旧版本保存显示冲突提示', true);
  check('冲突时保留 B 未提交文字', draftKept);
  await pageB.screenshot({ path: `${SHOT_DIR}/06-conflict.png`, fullPage: true });
  await pageB.close();
  await page.bringToFront();

  console.log('— 删除预览');
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await page.type('.capture-input', '删除预览测试记录');
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, '删除预览测试记录');
  await clickText(page, '.card-main', '删除预览测试记录');
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  await clickText(page, 'button', '删除…');
  await page.waitForSelector('.modal', { timeout: 10000 });
  const modalText = await page.$eval('.modal', (el) => el.innerText);
  check('删除前显示影响范围', modalText.includes('条尝试') && modalText.includes('引用'), modalText.slice(0, 80));
  await clickText(page, '.modal button', '取消');

  console.log('— 导出数据');
  const downloadDir = path.resolve(SHOT_DIR, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  for (const f of fs.readdirSync(downloadDir)) fs.rmSync(path.join(downloadDir, f), { force: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await clickText(page, 'button', '导出数据');
  let exportFile = null;
  for (let i = 0; i < 75; i++) {
    const files = fs.readdirSync(downloadDir).filter((f) => f.endsWith('.json'));
    if (files.length > 0) {
      exportFile = path.join(downloadDir, files[0]);
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check('点击「导出数据」下载 JSON 文件', exportFile !== null, String(exportFile));
  if (exportFile) {
    const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    check(
      '导出文件包含 schemaVersion=6 与核心业务表',
      exported.schemaVersion === 6 &&
        exported.appVersion === '0.1.0' &&
        Array.isArray(exported.data?.captures) &&
        Array.isArray(exported.data?.attempts) &&
        Array.isArray(exported.data?.attemptReferences),
      JSON.stringify(Object.keys(exported))
    );
    check('导出文件包含本次浏览器流程的数据', exported.data.captures.some((c) => c.rawText.includes('PWM')));
  }

  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `${SHOT_DIR}/07-home-final.png`, fullPage: true });
  check('手机宽度下完成整条流程', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(60));
console.log(`浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(60));
process.exit(failed === 0 ? 0 : 1);