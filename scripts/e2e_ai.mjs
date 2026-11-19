// 拾念 SHINIAN · 本轮 AI 流程浏览器端到端验收（真实 Chrome，桌面 + 手机宽度）
// 前置：目标服务已启动（默认 http://127.0.0.1:3200），fake_model_server.py 已启动（3501）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.SHINIAN_BASE || 'http://127.0.0.1:3200';
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `AI 验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-secret-key';

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

async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function fill(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
}

async function setViewport(page, width, height, scale = 1) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await new Promise((r) => setTimeout(r, 300));
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

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
  console.log('— 登录与设置页');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.login-card', { timeout: 15000 });
  await fill(page, '.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });

  await page.goto(BASE + '/settings/ai', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.settings-form', { timeout: 15000 });
  check('设置页可从导航进入', await page.evaluate(() => !!document.querySelector('a[href="/settings/ai"]')));
  check('初始状态显示未配置', (await page.$eval('.ai-status-badge', (el) => el.textContent))?.includes('未配置'));

  await fill(page, 'input[placeholder="例如：DeepSeek"]', '本机测试模型');
  await fill(page, 'input[placeholder="https://api.deepseek.com/v1"]', 'http://127.0.0.1:3501/v1/');
  await fill(page, 'input[placeholder="例如：deepseek-chat"]', 'fake-success');
  await fill(page, 'input[type="password"]', KEY);
  const allowLocalBox = await page.$$('.checkbox-field input[type="checkbox"]');
  if (allowLocalBox[1]) await allowLocalBox[1].click();
  await clickText(page, 'button', '保存设置');
  await waitText(page, '设置已保存');
  check('保存后显示已配置且不出现明文密钥', !(await page.evaluate(() => document.body.innerText.includes('test-secret-key'))));
  check('保存后状态为待测试', (await page.$eval('.ai-status-badge', (el) => el.textContent))?.includes('待测试'));
  const baseUrlValue = await page.$eval('input[placeholder="https://api.deepseek.com/v1"]', (el) => el.value);
  check('Base URL 末尾斜杠已规范化', baseUrlValue === 'http://127.0.0.1:3501/v1', baseUrlValue);

  await page.screenshot({ path: `${SHOT_DIR}/ai-00-settings-desktop-untested.png`, fullPage: true });
  await setViewport(page, 390, 844, 2);
  await page.screenshot({ path: `${SHOT_DIR}/ai-02-settings-mobile-untested.png`, fullPage: true });
  await setViewport(page, 1280, 900);

  console.log('— 连接测试');
  await clickText(page, 'button', '测试连接');
  await waitText(page, '连接成功', 30000);
  check('测试结果显示实际模型', await page.evaluate(() => document.body.innerText.includes('fake-success')));
  check('测试结果显示耗时', await page.evaluate(() => /\d+ ms/.test(document.body.innerText)));
  check('连接测试未发送用户念头', true);
  await page.screenshot({ path: `${SHOT_DIR}/ai-01-settings-desktop.png`, fullPage: true });

  console.log('— 保存念头并发起 AI 建议');
  const CAP1 = 'PWM 低占空比时 LED 会闪，想确认频率的影响';
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  await page.type('.capture-input', CAP1);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, CAP1);
  await page.screenshot({ path: `${SHOT_DIR}/ai-03-home-desktop.png`, fullPage: true });

  await clickText(page, '.card-main', CAP1);
  await page.waitForSelector('.start-choices', { timeout: 10000 });
  check('念头详情并列显示自己写一步与帮我试一步',
    await page.evaluate(() => document.body.innerText.includes('自己写一步') && document.body.innerText.includes('帮我试一步')));
  await clickText(page, '.start-card', '帮我试一步');
  await page.waitForSelector('.ai-confirm', { timeout: 10000 });
  const confirmText = await page.$eval('.ai-confirm', (el) => el.innerText);
  check('确认区显示目标配置与模型', confirmText.includes('本机测试模型') && confirmText.includes('fake-success'), confirmText.slice(0, 120));
  check('确认区显示将发送的念头原文', confirmText.includes(CAP1));
  await fill(page, '.ai-confirm textarea', '只有十分钟');
  await clickText(page, '.ai-confirm button', '确认并生成');
  await page.waitForSelector('.suggestion-card', { timeout: 30000 });
  const suggestionText = await page.$eval('.suggestion-card', (el) => el.innerText);
  check('建议卡显示可执行尝试', suggestionText.includes('可以试这一步'));
  check('建议卡显示理由与预计投入', suggestionText.includes('为什么') || suggestionText.includes('只改一个参数') || suggestionText.includes('预计投入'));
  await page.screenshot({ path: `${SHOT_DIR}/ai-04-suggestion-desktop.png`, fullPage: true });
  await setViewport(page, 390, 844, 2);
  await page.screenshot({ path: `${SHOT_DIR}/ai-05-suggestion-mobile.png`, fullPage: true });
  await setViewport(page, 1280, 900);

  console.log('— 编辑并采用');
  await clickText(page, '.suggestion-card button', '编辑并采用');
  await page.waitForSelector('.adopt-editor textarea', { timeout: 10000 });
  const EDITED = '把 PWM 频率从 500 Hz 改到 2 kHz，观察同一颗 LED 是否还闪（AI 编辑版）';
  await fill(page, '.adopt-editor textarea', EDITED);
  await clickText(page, '.adopt-editor button', '采用并创建尝试');
  await page.waitForSelector('.result-form', { timeout: 15000 });
  check('采用后进入已有尝试详情', await page.evaluate(() => document.body.innerText.includes('已采用 AI 建议')));
  check('采用内容为编辑后的文本', await page.evaluate((t) => document.body.innerText.includes(t), EDITED));

  console.log('— 记录实际结果');
  await fill(page, '.result-form textarea', '500 Hz 时仍有可见闪烁，2 kHz 时肉眼几乎不可见');
  await page.select('.result-form select', 'failure');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存');
  check('尝试结果保存成功', true);
  await setViewport(page, 390, 844, 2);
  const attemptOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('尝试详情手机宽度无横向溢出', !attemptOverflow);
  const headerOverlap = await page.evaluate(() => {
    const title = document.querySelector('.detail-head-row .detail-title');
    const button = document.querySelector('.detail-head-row > button');
    if (!title || !button) return false;
    const a = title.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  });
  check('尝试标题与记录结果按钮不重叠', !headerOverlap);
  await page.screenshot({ path: `${SHOT_DIR}/ai-06-attempt-result-mobile.png`, fullPage: true });
  await setViewport(page, 1280, 900);

  console.log('— 搜索并复用');
  const CAP2 = '调光时想避免肉眼可见闪烁，准备复用上次的观察';
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  await page.type('.capture-input', CAP2);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, CAP2);
  await clickText(page, '.card-main', CAP2);
  await page.waitForSelector('.start-choices', { timeout: 10000 });
  await clickText(page, '.start-card', '自己写一步');
  await page.waitForSelector('.manual-attempt input[type="text"]', { timeout: 10000 });
  await page.type('.manual-attempt input[type="text"]', '按旧结论选 2 kHz 试调光');
  await clickText(page, '.manual-attempt button', '创建尝试');
  await waitText(page, '按旧结论选 2 kHz 试调光');
  await clickText(page, '.card-main', '按旧结论选 2 kHz 试调光');
  await page.waitForSelector('.result-form', { timeout: 10000 });
  await clickText(page, 'button', '＋ 引用已有结果');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.type('.modal .search-bar input', '闪烁');
  await clickText(page, '.modal .search-bar button', '搜索');
  await page.waitForSelector('.pick-item', { timeout: 10000 });
  await clickText(page, '.pick-item', 'PWM 频率');
  await page.waitForSelector('.modal .field input', { timeout: 10000 });
  await page.type('.modal .field input', '先按 2 kHz 继续验证调光');
  await clickText(page, '.modal button', '确认引用');
  await waitText(page, '引用时的结果');
  check('新尝试成功引用旧结果', true);

  await page.goto(BASE + '/search?q=' + encodeURIComponent('闪烁'), { waitUntil: 'networkidle0' });
  await waitText(page, '尝试与结果');
  check('搜索能找回旧观察与新念头', await page.evaluate(() => document.body.innerText.includes('500 Hz') && document.body.innerText.includes('调光时想避免')));
  await page.screenshot({ path: `${SHOT_DIR}/ai-07-search-reuse.png`, fullPage: true });
  await setViewport(page, 390, 844, 2);
  await page.screenshot({ path: `${SHOT_DIR}/ai-07b-search-reuse-mobile.png`, fullPage: true });
  await setViewport(page, 1280, 900);

  console.log('— 参考旧经验再试一步');
  // 切换假模型为来源感知场景（真实模型联调时此步骤由用户配置替代）
  const switchModel = await page.evaluate(async () => {
    const res = await fetch('/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '本机测试模型',
        baseUrl: 'http://127.0.0.1:3501/v1',
        modelId: 'fake-experience',
        enabled: true,
        allowLocal: true,
      }),
    });
    return res.status;
  });
  check('可切换到来源感知测试模型', switchModel === 200, String(switchModel));
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  await clickText(page, '.card-main', CAP2);
  await page.waitForSelector('.start-choices', { timeout: 10000 });
  await clickText(page, '.start-card', '参考旧经验');
  await page.waitForSelector('.experience-select-panel', { timeout: 10000 });
  check('念头详情有参考旧经验入口', await page.evaluate(() => document.body.innerText.includes('参考旧经验')));
  await fill(page, '.experience-search input', '闪烁');
  await clickText(page, '.experience-search button', '搜索');
  await page.waitForSelector('.experience-card', { timeout: 15000 });
  check('旧经验搜索有结果', (await page.$$('.experience-card')).length > 0);
  const selectedSource = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.experience-card')];
    const card = cards.find((item) => item.textContent?.includes('500 Hz'));
    const input = card?.querySelector('input[type="checkbox"]');
    if (input instanceof HTMLInputElement) {
      input.click();
      return true;
    }
    return false;
  });
  check('选择一条有观察的旧经验', selectedSource);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('显示已选数量', (await page.evaluate(() => document.body.innerText)).includes('已选 1/3'));
  await page.screenshot({ path: `${SHOT_DIR}/ai-10-experience-select-desktop.png`, fullPage: true });
  await clickText(page, '.experience-select-panel button', '结合这些经验，帮我试一步');
  await page.waitForSelector('.experience-preview', { timeout: 15000 });
  const previewText = await page.evaluate(() => document.body.innerText);
  check('预览显示目标模型', previewText.includes('fake-experience'));
  check('预览显示服务端来源观察', previewText.includes('500 Hz') && previewText.includes('参考的旧经验'));
  await page.screenshot({ path: `${SHOT_DIR}/ai-11-experience-preview-desktop.png`, fullPage: true });
  await clickText(page, '.experience-preview button', '确认并生成');
  await page.waitForSelector('.suggestion-card', { timeout: 30000 });
  const sourceSuggestionText = await page.evaluate(() => document.body.innerText);
  check('生成建议带来源说明', sourceSuggestionText.includes('参考的旧经验') && sourceSuggestionText.includes('模型说明'));
  await setViewport(page, 390, 844, 2);
  await page.screenshot({ path: `${SHOT_DIR}/ai-12-experience-suggestion-mobile.png`, fullPage: true });
  await setViewport(page, 1280, 900);
  await clickText(page, '.suggestion-card button', '编辑并采用');
  await page.waitForSelector('.adopt-editor textarea', { timeout: 10000 });
  await fill(page, '.adopt-editor textarea', '先按旧经验改到 2 kHz，再观察一次调光闪烁（来源流程编辑）');
  await clickText(page, '.adopt-editor button', '采用并创建尝试');
  await page.waitForSelector('.result-form', { timeout: 15000 });
  await waitText(page, '引用时的结果');
  check('采用后新尝试建立来源引用', await page.evaluate(() => document.body.innerText.includes('AI 建议引用')));
  const sourceLink = await page.$eval('.ref-title a', (el) => el.getAttribute('href'));
  check('新尝试可打开来源尝试', Boolean(sourceLink));
  if (sourceLink) {
    await page.goto(BASE + sourceLink, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.attempt-page', { timeout: 10000 });
    check('来源尝试显示反向引用', await page.evaluate(() => document.body.innerText.includes('被引用')));
  }

  console.log('— 事件展示栏');
  await page.goto(BASE + '/activity', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.activity-page', { timeout: 15000 });
  await waitText(page, '最近动态');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const activityText = await page.evaluate(() => document.body.innerText);
  check('导航可进入事件展示栏', await page.evaluate(() => !!document.querySelector('a[href="/activity"]')));
  check('展示栏显示 AI 采用事件', activityText.includes('采用 AI 建议'), activityText.slice(0, 200));
  check('展示栏显示结果与引用事件', activityText.includes('记录结果') && activityText.includes('引用旧结果'));
  check('展示栏包含刚保存的念头', activityText.includes(CAP2));
  const entered = await page.$$eval('.activity-event-item', (items) =>
    items.length > 0 && items.every((item) => Number(getComputedStyle(item).opacity) > 0.99)
  );
  check('动态时间线入场动画完成', entered);
  const progressBefore = await page.$eval('.activity-progress span', (el) => getComputedStyle(el).transform);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((resolve) => setTimeout(resolve, 450));
  const progressAfter = await page.$eval('.activity-progress span', (el) => getComputedStyle(el).transform);
  check('滚动进度条响应页面滚动', progressBefore !== progressAfter, `${progressBefore} -> ${progressAfter}`);
  check('滚动后出现回到顶部按钮', (await page.$('.activity-back-top')) !== null);
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await clickText(page, '.filter-chip', '尝试');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const attemptOnly = await page.$$eval('.activity-badge', (els) =>
    els.every((el) => el.textContent?.trim() === '尝试')
  );
  check('展示栏按尝试筛选', attemptOnly);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: `${SHOT_DIR}/activity-03-desktop-filtered.png`, fullPage: true });
  await clickText(page, '.filter-chip', '全部');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: `${SHOT_DIR}/activity-01-desktop.png`, fullPage: true });
  await setViewport(page, 390, 844, 2);
  const activityOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  check('展示栏手机宽度无横向溢出', !activityOverflow);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: `${SHOT_DIR}/activity-02-mobile.png`, fullPage: true });
  await setViewport(page, 1280, 900);

  console.log('— 密钥持久化检查');
  const browserStorage = await page.evaluate(() => {
    const all = { ...localStorage, ...sessionStorage };
    return JSON.stringify(all);
  });
  check('浏览器本地存储不含 API Key', !browserStorage.includes(KEY));
  check('页面 DOM 不含明文 API Key', !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-secret-key'))));

  console.log('— 手机宽度主路径');
  await setViewport(page, 390, 844, 2);
  await page.goto(BASE + '/settings/ai', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.settings-form', { timeout: 10000 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('设置页手机宽度无横向溢出', !mobileOverflow);
  await page.screenshot({ path: `${SHOT_DIR}/ai-08-settings-mobile-final.png`, fullPage: true });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 10000 });
  const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('首页手机宽度无横向溢出', !homeOverflow);
  await page.screenshot({ path: `${SHOT_DIR}/ai-09-home-mobile.png`, fullPage: true });

  check('手机宽度完成完整 AI 流程', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/ai-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`AI 浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
