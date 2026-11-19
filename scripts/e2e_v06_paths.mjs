// 拾念 SHINIAN · v0.6 跨路径浏览器验收（Chrome 无头，1280×900 与 390×844）
//
// 前置服务：隔离服务默认 http://127.0.0.1:3115，数据库 db/v06-e2e.sqlite；
// fake_model_server.py 默认 127.0.0.1:3501（含 fake-ask*）。
// 运行：node scripts/e2e_v06_paths.mjs
//
// 路径 A（无模型）：念头 → 手动尝试 → 结果 → 整理成经验 → 搜索找回 → 参考它试一步 →
//                  记录新结果 → 经验详情看到后续实践 → 修订（旧理解与新增限制并存）
// 路径 B（fake-ask）：/ask 提问 → 勾选/核对/生成 → 打开原来源 → 返回 /ask 保留现场 →
//                    观点记成经验 → 经验详情再试一步（用户点击前不创建尝试）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3115').replace(/\/+$/, '');
const FAKE = (process.env.SHINIAN_FAKE_BASE || 'http://127.0.0.1:3501').replace(/\/+$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `v06路径验收 ${Date.now() % 100000}`;
const KEY = process.env.SHINIAN_FAKE_KEY || 'test-secret-key';
const STAMP = String(Date.now() % 1000000);
const A_CAPTURE = `V06A-${STAMP} 睡前把手机放到书桌上，比放枕边更容易停止刷手机`;
const A_STEP = `V06A-${STAMP} 睡前把手机放到书桌上`;
const A_RESULT = `V06A-${STAMP} 手机放书桌后十分钟内睡着了`;
const A_TITLE = `V06A-${STAMP} 睡前手机位置经验`;
const A_UNDERSTANDING = `V06A-${STAMP} 把手机放到书桌后，我更容易停止刷手机。`;
const A_LIMITATION = `V06A-${STAMP} 目前只有一次成功记录，还需要更多晚上验证。`;
const B_CAP = `V06B-${STAMP} PWM 调光闪烁记录`;
const B_STEP1 = `V06B-${STAMP} 500 Hz PWM 调光`;
const B_STEP2 = `V06B-${STAMP} 2 kHz PWM 调光`;
const B_RESULT1 = `V06B-${STAMP} 500 Hz 时仍有可见闪烁`;
const B_RESULT2 = `V06B-${STAMP} 2 kHz 时肉眼几乎不可见`;
const B_QUESTION = `V06B-${STAMP} PWM 闪烁怎么处理`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function clickText(page, selector, text) {
  for (const h of await page.$$(selector)) {
    const t = await h.evaluate((el) => el.textContent || '');
    if (t.includes(text)) {
      // 先滚到视口中间，避免固定头部遮住链接的点击坐标。
      await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await sleep(100);
      await h.click();
      return true;
    }
  }
  return false;
}

async function waitText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method: m, path: p, body: b }) => {
      const res = await fetch(p, {
        method: m,
        headers: b ? { 'Content-Type': 'application/json' } : undefined,
        body: b ? JSON.stringify(b) : undefined,
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, body: data };
    },
    { method, path, body }
  );
}

async function attemptCount(page, captureId) {
  const res = await api(page, 'GET', `/api/captures/${captureId}/attempts`);
  return (res.body?.attempts || []).length;
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}`, fullPage: true });
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

try {
  console.log('— 登录与首页初始状态');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });

  await page.waitForSelector('[data-testid="home-continue-attempts"]', { timeout: 20000 });
  check('首页出现「继续已有尝试」入口', true);
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('现在没有进行中的尝试') ||
      Boolean(document.querySelector('[data-testid="home-continue-item"]')),
    { timeout: 20000 }
  );
  check(
    '无进行中尝试时显示明确空状态',
    await page.evaluate(() => document.body.innerText.includes('现在没有进行中的尝试'))
  );
  await page.waitForFunction(() => document.body.innerText.includes('还没有经验'), { timeout: 20000 });
  const emptyEntryText = await page.evaluate(() => document.body.innerText);
  check(
    '首页经验空状态展示两条入口文案',
    emptyEntryText.includes('从已有结果的尝试整理') &&
      emptyEntryText.includes('从问答观点整理') &&
      (await page.$$('.home-experience-entry')).length === 2,
    emptyEntryText.slice(0, 320)
  );
  await shot(page, 'v06-home-empty.png');

  console.log('— 首页加载失败不显示成空记录');
  await page.setRequestInterception(true);
  const abortExperiences = (req) => {
    if (req.url().includes('/api/experiences')) req.abort();
    else req.continue();
  };
  page.on('request', abortExperiences);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="home-experiences-error"]', { timeout: 20000 });
  const errorHomeText = await page.evaluate(() => document.body.innerText);
  check(
    '经验加载失败显示错误态而不是空记录',
    errorHomeText.includes('重试') && !errorHomeText.includes('还没有经验。可以从两处开始'),
    errorHomeText.slice(0, 260)
  );
  await shot(page, 'v06-home-error.png');
  page.off('request', abortExperiences);
  await page.setRequestInterception(false);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-input', { timeout: 15000 });

  console.log('— 路径 A：念头 → 手动尝试 → 结果');
  await page.type('.capture-input', A_CAPTURE);
  await page.click('[data-testid="home-capture-submit"]');
  await waitText(page, A_CAPTURE);
  await clickText(page, '.card-main', A_CAPTURE);
  await page.waitForSelector('.detail-title', { timeout: 15000 });
  const captureUrl = page.url();
  const captureId = captureUrl.split('/capture/')[1];
  check('打开念头详情', Boolean(captureId), captureUrl);
  const beforeManual = await attemptCount(page, captureId);
  check('打开念头时没有自动创建尝试', beforeManual === 0, String(beforeManual));
  await clickText(page, 'button', '自己写一步');
  await page.waitForSelector('.attempt-form input[type="text"]', { timeout: 10000 });
  await page.type('.attempt-form input[type="text"]', A_STEP);
  await clickText(page, '.attempt-form button', '创建尝试');
  await page.waitForSelector('[data-testid="attempt-created-note"]', { timeout: 15000 });
  check('点击创建后才出现尝试成功提示', true);
  const afterManual = await attemptCount(page, captureId);
  check('用户点击创建后恰好创建 1 条尝试', afterManual === beforeManual + 1, `${beforeManual} -> ${afterManual}`);
  await shot(page, 'v06-path-a-create-attempt.png');

  console.log('— 首页「继续已有尝试」入口');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="home-continue-item"]', { timeout: 20000 });
  check(
    '首页继续已有尝试显示刚创建的尝试',
    await page.evaluate((step) => document.body.innerText.includes(step), A_STEP)
  );
  await shot(page, 'v06-home-continue.png');
  await page.click('[data-testid="home-continue-item"] a');
  await page.waitForSelector('[data-testid="attempt-result-text"]', { timeout: 15000 });
  check('首页继续链接可打开尝试详情', /\/attempt\//.test(page.url()), page.url());

  console.log('— 路径 A：记录结果 → 整理成经验');
  await setField(page, '[data-testid="attempt-result-text"]', A_RESULT);
  await setField(page, '[data-testid="attempt-result-outcome"]', 'success');
  await page.click('[data-testid="attempt-save-result"]');
  await waitText(page, '结果已保存');
  check('手动尝试记录结果成功', true);
  await page.waitForSelector('[data-testid="experience-note-from-attempt"]', { timeout: 15000 });
  await page.click('[data-testid="experience-note-from-attempt"]');
  await page.waitForSelector('[data-testid="experience-editor"]', { timeout: 10000 });
  await setField(page, '[data-testid="experience-title"]', A_TITLE);
  await setField(page, '[data-testid="experience-understanding"]', A_UNDERSTANDING);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '已保存为经验');
  check('尝试详情整理成经验成功', true);
  await clickText(page, 'a', '打开经验');
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 15000 });
  const experienceUrl = page.url();
  const experienceId = experienceUrl.split('/experience/')[1];
  check('进入经验详情', Boolean(experienceId), experienceUrl);
  await shot(page, 'v06-path-a-experience.png');

  console.log('— 路径 A：搜索找回经验 → 参考它试一步');
  await page.goto(`${BASE}/search?q=${encodeURIComponent(A_TITLE)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="search-filter-experience"]', { timeout: 15000 });
  await page.click('[data-testid="search-filter-experience"]');
  await waitText(page, A_TITLE);
  check(
    '搜索找回经验并显示匹配原因',
    await page.evaluate((title) => document.body.innerText.includes(title) && document.body.innerText.includes('匹配：'), A_TITLE)
  );
  await clickText(page, '.card-main', A_TITLE);
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 15000 });
  const beforeTry = await attemptCount(page, captureId);
  await page.click('[data-testid="experience-try"]');
  await page.waitForSelector('[data-testid="experience-create-attempt"]', { timeout: 10000 });
  const beforeCreateClick = await attemptCount(page, captureId);
  check('打开「参考它，试一步」面板不会自动创建尝试', beforeCreateClick === beforeTry, `${beforeTry} -> ${beforeCreateClick}`);
  await page.click('[data-testid="experience-create-attempt"]');
  await page.waitForSelector('a[href^="/attempt/"]', { timeout: 15000 });
  const afterTry = await attemptCount(page, captureId);
  check('用户点击创建后才创建新尝试', afterTry === beforeTry + 1, `${beforeTry} -> ${afterTry}`);
  await clickText(page, 'a', '去记录结果');
  await page.waitForSelector('[data-testid="attempt-result-text"]', { timeout: 15000 });
  const newResult = `V06A-${STAMP} 第二次按书桌做法，十分钟内睡着`;
  await setField(page, '[data-testid="attempt-result-text"]', newResult);
  await setField(page, '[data-testid="attempt-result-outcome"]', 'success');
  await page.click('[data-testid="attempt-save-result"]');
  await waitText(page, '结果已保存');
  check('参考经验创建的新尝试可以记录结果', true);

  console.log('— 路径 A：经验详情看到后续实践并修订');
  await page.goto(`${BASE}/experience/${experienceId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="experience-revise-from-attempt"]', { timeout: 15000 });
  check(
    '经验详情看到后续实践结果',
    await page.evaluate((r) => document.body.innerText.includes(r), newResult)
  );
  check(
    '后续尝试保留采用时版本',
    await page.evaluate(() => /采用时第\s+\d+\s+版/.test(document.body.innerText))
  );
  await page.click('[data-testid="experience-revise-from-attempt"]');
  await page.waitForSelector('[data-testid="experience-editor"]', { timeout: 10000 });
  check(
    '修订面板展示这次实践结果',
    await page.evaluate((r) => document.body.innerText.includes(r), newResult)
  );
  await setField(page, '[data-testid="experience-limitations"]', A_LIMITATION);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '经验已更新');
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 15000 });
  check(
    '修订后旧理解与新限制并存',
    await page.evaluate(
      ({ u, l }) => document.body.innerText.includes(u) && document.body.innerText.includes(l),
      { u: A_UNDERSTANDING, l: A_LIMITATION }
    )
  );
  await shot(page, 'v06-path-a-revised.png');

  console.log('— 路径 B：配置 fake-ask 并准备问答数据');
  const savedAi = await page.evaluate(async (fake) => {
    const res = await fetch('/api/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'v06 问答假模型',
        baseUrl: `${fake}/v1`,
        modelId: 'fake-ask',
        enabled: true,
        allowLocal: true,
        apiKey: 'test-secret-key',
      }),
    });
    return res.status;
  }, FAKE);
  check('配置 fake-ask 模型', savedAi === 200, String(savedAi));

  const seedB = await page.evaluate(
    async ({ capText, step1, step2, result1, result2 }) => {
      async function req(method, path, body) {
        const res = await fetch(path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`);
        return data;
      }
      const stamp = Date.now();
      const cap = (await req('POST', '/api/captures', { rawText: capText })).capture;
      const a1 = (
        await req('POST', `/api/captures/${cap.id}/attempts`, {
          step: step1,
          state: 'done',
          resultText: result1,
          outcome: 'failure',
          operationId: `v06b-a1-${stamp}`,
        })
      ).attempt;
      const a2 = (
        await req('POST', `/api/captures/${cap.id}/attempts`, {
          step: step2,
          state: 'done',
          resultText: result2,
          outcome: 'success',
          operationId: `v06b-a2-${stamp}`,
        })
      ).attempt;
      await req('POST', `/api/attempts/${a2.id}/references`, {
        toId: a1.id,
        note: 'v06 路径 B：2 kHz 基于 500 Hz',
        operationId: `v06b-ref-${stamp}`,
      });
      return { captureId: cap.id, a1: a1.id, a2: a2.id, count: 2 };
    },
    { capText: B_CAP, step1: B_STEP1, step2: B_STEP2, result1: B_RESULT1, result2: B_RESULT2 }
  );
  check('路径 B 准备 2 条有结果尝试与引用', Boolean(seedB.a1 && seedB.a2), JSON.stringify(seedB));

  console.log('— 路径 B：/ask 检索 → 核对 → 生成');
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await setField(page, '[data-testid="ask-question-input"]', B_QUESTION);
  await setField(page, '[data-testid="ask-keywords-input"]', `V06B-${STAMP}`);
  await page.click('[data-testid="ask-search-btn"]');
  await page.waitForSelector('[data-testid="ask-candidate"]', { timeout: 25000 });
  await page.evaluate(() => {
    const clear = [...document.querySelectorAll('.ask-selection-actions button')].find((b) =>
      b.textContent.includes('清空')
    );
    if (clear) clear.click();
  });
  await waitText(page, '已选 0 条', 5000);
  const picked = await page.evaluate(() => {
    let n = 0;
    // 当前隔离库只有 B 的两条 attempt 与一个所属 capture；取前两条“尝试”候选。
    for (const item of document.querySelectorAll('[data-testid="ask-candidate"]')) {
      const text = item.innerText || '';
      if (text.includes('尝试') && n < 2) {
        const box = item.querySelector('[data-testid="ask-candidate-pick"]');
        if (box && !box.checked) {
          box.click();
          n += 1;
        }
      }
    }
    return n;
  });
  check('路径 B 只勾选两条尝试候选', picked === 2, String(picked));
  await waitText(page, '已选 2 条', 10000);
  await page.click('[data-testid="ask-preview"]');
  await page.waitForSelector('[data-testid="ask-preview-panel"]', { timeout: 20000 });
  check(
    '路径 B 核对面板展示 2 条发送记录',
    (await page.$$('[data-testid="ask-preview-record"]')).length === 2
  );
  await page.click('[data-testid="ask-generate-btn"]');
  const confirm = await page
    .waitForSelector('[data-testid="ask-confirm-send"]', { timeout: 5000 })
    .catch(() => null);
  check('路径 B 生成前有二次确认', Boolean(confirm));
  if (confirm) await confirm.click();
  await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 60000 });
  check(
    '路径 B 问答显示 observation/inference',
    (await page.$$('[data-testid="ask-point-observation"]')).length >= 1 &&
      (await page.$$('[data-testid="ask-point-inference"]')).length >= 1
  );
  check('路径 B 问答来源卡为 2 条', (await page.$$('[data-testid="ask-source-card"]')).length === 2);
  await shot(page, 'v06-path-b-ask-answer.png');
  const countAfterAsk = await attemptCount(page, seedB.captureId);
  check('问答生成不会自动创建尝试', countAfterAsk === seedB.count, `${seedB.count} -> ${countAfterAsk}`);

  console.log('— 路径 B：打开原来源 → 返回 /ask 保留现场');
  const sourceHref = await page.$eval('[data-testid="ask-open-source"]', (a) => a.getAttribute('href'));
  await page.goto(BASE + sourceHref, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  check('路径 B 打开原来源尝试', /\/attempt\//.test(page.url()), page.url());
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="ask-answer"]', { timeout: 30000 });
  check(
    '返回 /ask 保留问题',
    (await page.$eval('[data-testid="ask-question-input"]', (el) => el.value)) === B_QUESTION
  );
  check(
    '返回 /ask 保留已选证据',
    (await page.$eval('.ask-selected-count', (el) => el.innerText)).includes('已选 2 条')
  );
  check('返回 /ask 保留回答', (await page.$$('[data-testid="ask-point-save-experience"]')).length >= 1);

  console.log('— 路径 B：问答观点记成经验 → 经验详情再试一步');
  await page.click('[data-testid="ask-point-save-experience"]');
  await page.waitForSelector('[data-testid="experience-editor"]', { timeout: 15000 });
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '已保存为经验');
  check('问答观点保存为经验', true);
  await clickText(page, 'a', '打开并继续修订');
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 15000 });
  const bExperienceUrl = page.url();
  const bExperienceId = bExperienceUrl.split('/experience/')[1];
  check('进入问答观点保存的经验详情', Boolean(bExperienceId), bExperienceUrl);
  await shot(page, 'v06-path-b-experience.png');

  const beforeBExperience = await attemptCount(page, seedB.captureId);
  await page.click('[data-testid="experience-try"]');
  await page.waitForSelector('[data-testid="experience-create-attempt"]', { timeout: 10000 });
  const panelB = await attemptCount(page, seedB.captureId);
  check('经验详情打开试一步面板不会自动创建尝试', panelB === beforeBExperience, `${beforeBExperience} -> ${panelB}`);
  await page.click('[data-testid="experience-create-attempt"]');
  await page.waitForSelector('a[href^="/attempt/"]', { timeout: 15000 });
  const afterB = await attemptCount(page, seedB.captureId);
  check('用户点击后路径 B 才创建新尝试', afterB === beforeBExperience + 1, `${beforeBExperience} -> ${afterB}`);

  console.log('— 手机 390 宽度');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="home-continue-attempts"]', { timeout: 20000 });
  check('手机首页无横向溢出', await noOverflow(page), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  check(
    '手机首页继续尝试入口可读',
    await page.evaluate(() => document.body.innerText.includes('继续已有尝试'))
  );
  await shot(page, 'v06-mobile-home.png');
  await page.goto(`${BASE}/experience/${experienceId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 20000 });
  check('手机经验详情无横向溢出', await noOverflow(page), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  check(
    '手机经验详情可读',
    await page.evaluate((u) => document.body.innerText.includes(u), A_UNDERSTANDING)
  );
  await shot(page, 'v06-mobile-experience.png');
  await page.goto(`${BASE}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="ask-page"]', { timeout: 20000 });
  check('手机 /ask 无横向溢出', await noOverflow(page), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  await shot(page, 'v06-mobile-ask.png');

  console.log('— 密钥存储检查');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  check('浏览器存储不含明文 API Key', !storage.includes(KEY));
  check(
    '页面 DOM 不含明文 API Key',
    !(await page.evaluate(() => document.documentElement.innerHTML.includes('test-secret-key')))
  );

  check('v0.6 路径 A/B 完整流程通过', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/v06-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`v0.6 路径浏览器验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
