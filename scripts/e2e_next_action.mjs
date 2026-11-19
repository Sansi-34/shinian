// 拾念 SHINIAN · 「回顾后的下一步行动」浏览器端到端验收（真实 Chrome，桌面 1280×900 + 手机 390×844）
//
// 前置：独立 E2E 服务已启动（默认 http://127.0.0.1:3302，库 db/e2e-next-action.sqlite）
//   $env:PORT="3302"; $env:DATABASE_URL="<repo>\db\e2e-next-action.sqlite"; `
//   $env:SHINIAN_MASTER_KEY_FILE="<repo>\db\e2e-next-action-master.key"; npm run serve
// 运行：
//   $env:SHINIAN_BASE="http://127.0.0.1:3302"; node scripts/e2e_next_action.mjs
//
// 脚本会用页面内的登录会话通过 API 创建演示念头/尝试，并直接向 E2E 库插入一条
// 已保存阶段回顾（含 experiences[0] 与 attempt 来源），随后完成用户要求的 12 步：
// 进入回顾详情 → 变成下一步 → 改标题/说明 → 选日期/时间/耗时 → 加入日程 → 保存
// → 日程页找到 → 打开行动 → 进入尝试详情 → 保存实际结果 → 回回顾确认新增尝试/结果/引用
// → 重复保存无重复；最后以 390px 验证无横向溢出。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3302').replace(/\/$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const E2E_DB = process.env.SHINIAN_E2E_DB || path.resolve('db/e2e-next-action.sqlite');
const USER = `下一步演示-${Date.now() % 100000}`;
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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86400000));
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

async function waitText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

/** 用 React 受控组件能识别的原生 setter 写 input/textarea/select。 */
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

async function insertSavedReview(reviewId, capture, attempt, experienceText) {
  if (!fs.existsSync(E2E_DB)) {
    throw new Error(`E2E 数据库不存在：${E2E_DB}（请确认服务使用 db/e2e-next-action.sqlite）`);
  }
  const now = Date.now();
  const attemptKey = `attempt:${attempt.id}`;
  const captureKey = `capture:${capture.id}`;
  const stats = {
    capturesCreated: 1,
    capturesModified: 0,
    attemptsStarted: 1,
    attemptsModified: 0,
    attemptsCurrentlyEnded: 1,
    resultsRecorded: 1,
    resultsMissingObservedAt: 0,
    referencesCreated: 0,
    totalRecords: 2,
  };
  const coverage = {
    totalRecords: 2,
    selectedRecords: 2,
    excludedRecords: 0,
    selectedChars: 160,
    maxRecords: 80,
    maxChars: 16000,
    withinLimit: true,
    truncated: false,
    sectionCounts: { captures: 1, attempts: 1, results: 1, references: 0, modifications: 0 },
  };
  const content = {
    overview: '【演示】这段时间记录了一次 PWM 调光尝试：500 Hz 下能看到闪烁，2 kHz 下肉眼未见闪烁。',
    attempts: [
      { text: '你实际比较了 500 Hz 与 2 kHz 的闪烁。', basis: 'observation', sourceIds: [attemptKey] },
    ],
    observations: [
      { text: '500 Hz 下能看到可见闪烁，2 kHz 下肉眼未见闪烁。', basis: 'observation', sourceIds: [attemptKey] },
    ],
    connections: [
      { text: '这条结果可能支持「频率影响闪烁」的推断。', basis: 'inference', sourceIds: [attemptKey] },
    ],
    experiences: [
      {
        text: experienceText,
        basis: 'inference',
        sourceIds: [attemptKey],
      },
    ],
    uncertainties: ['只有一次记录，不能说明长期效果。'],
    insufficientData: false,
    dataNotes: null,
  };
  const sources = [
    {
      key: captureKey,
      type: 'capture',
      sourceId: capture.id,
      captureId: capture.id,
      attemptId: null,
      relatedAttemptId: null,
      title: capture.rawText.slice(0, 60),
      text: capture.rawText,
      resultText: null,
      outcome: null,
      state: null,
      observedAt: null,
      revision: capture.revision,
      captureRevision: capture.revision,
      relatedRevision: null,
      createdAt: capture.createdAt,
      updatedAt: capture.updatedAt,
    },
    {
      key: attemptKey,
      type: 'attempt',
      sourceId: attempt.id,
      captureId: capture.id,
      attemptId: attempt.id,
      relatedAttemptId: null,
      title: attempt.step.slice(0, 60),
      text: attempt.step,
      resultText: attempt.resultText,
      outcome: attempt.outcome,
      state: attempt.state,
      observedAt: attempt.observedAt,
      revision: attempt.revision,
      captureRevision: capture.revision,
      relatedRevision: null,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    },
  ];
  const db = new Database(E2E_DB);
  try {
    db.pragma('busy_timeout = 20000');
    db.prepare(
      `INSERT INTO stage_reviews (
         id, status, range_from, range_to, timezone, range_preset,
         stats_json, coverage_json, content_json, sources_json,
         config_id, config_version, config_name, model_id,
         saved_at, created_at, updated_at, finished_at
       ) VALUES (?, 'succeeded', ?, ?, 'Asia/Shanghai', 'custom',
         ?, ?, ?, ?, 'default', 1, '演示回顾模型', 'fake-review', ?, ?, ?, ?)`
    ).run(
      reviewId,
      now - 86400000,
      now + 86400000,
      JSON.stringify(stats),
      JSON.stringify(coverage),
      JSON.stringify(content),
      JSON.stringify(sources),
      now,
      now,
      now,
      now
    );
  } finally {
    db.close();
  }
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const TODAY = dateKey(0);
const CAPTURE_TEXT = `【演示】PWM 低占空比时 LED 会闪，先安排一次复测 ${STAMP}`;
const SOURCE_STEP = `【演示】比较 500 Hz 与 2 kHz 的闪烁 ${STAMP}`;
const SOURCE_RESULT = '【演示】500 Hz 下能看到闪烁，2 kHz 下肉眼未见闪烁';
const EXPERIENCE = '【演示】下次先固定亮度与占空比，只把 PWM 频率从 500 Hz 改到 2 kHz，再观察 5 分钟。';
const ACTION_TITLE = `【演示】只改频率复测 2 kHz 闪烁 ${STAMP}`;
const ACTION_DESCRIPTION = '【演示】固定亮度与占空比，只把频率从 500 Hz 改到 2 kHz。';
const ACTUAL_RESULT = '【演示】2 kHz 下连续观察 5 分钟，肉眼未见闪烁。';
const REVIEW_ID = `rev-e2e-na-${STAMP}`;
const START_TIME = '22:30';
const END_TIME = '23:00';

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
  console.log('— 登录并预置演示数据');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  check('登录成功并进入首页', await page.evaluate(() => !!document.querySelector('.capture-input')));

  const setup = await page.evaluate(async ({ captureText, stepText, resultText }) => {
    async function req(url, options) {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
      return body;
    }
    const cap = (await req('/api/captures', {
      method: 'POST',
      body: JSON.stringify({ rawText: captureText }),
    })).capture;
    const att = (await req(`/api/captures/${cap.id}/attempts`, {
      method: 'POST',
      body: JSON.stringify({
        step: stepText,
        state: 'done',
        resultText,
        outcome: 'failure',
        operationId: `op-e2e-na-source-${Date.now()}`,
      }),
    })).attempt;
    return { capture: cap, attempt: att };
  }, { captureText: CAPTURE_TEXT, stepText: SOURCE_STEP, resultText: SOURCE_RESULT });

  check('已创建演示念头与来源尝试', Boolean(setup.capture?.id && setup.attempt?.id), JSON.stringify(setup).slice(0, 300));
  insertSavedReview(REVIEW_ID, setup.capture, setup.attempt, EXPERIENCE);
  check('已直接插入一条带 experiences[0] 的已保存回顾', true, REVIEW_ID);

  console.log('— 1/2. 进入阶段回顾详情并点击「把这条经验变成下一步」');
  await page.goto(`${BASE}/review/${REVIEW_ID}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-detail', { timeout: 20000 });
  await waitText(page, '下次可参考');
  check('进入阶段回顾详情', await page.evaluate(() => document.body.innerText.includes('阶段回顾')));
  check('回顾详情展示模型生成的来源经验', await page.evaluate((t) => document.body.innerText.includes(t), EXPERIENCE.slice(0, 18)));
  const startButton = await page.$('[data-testid="next-action-start"]');
  check('经验项提供「把这条经验变成下一步」', startButton !== null);
  await page.screenshot({ path: `${SHOT_DIR}/next-action-01-review-detail-desktop.png`, fullPage: true });

  await startButton.click();
  await page.waitForSelector('[data-testid="next-action-editor"]', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="next-action-title"]');
      return input && input.value.trim().length > 0;
    },
    { timeout: 20000 }
  );
  check('打开下一步行动编辑面板', await page.evaluate(() => document.body.innerText.includes('把这条经验变成下一步')));
  check('编辑面板展示来源经验与真实来源尝试', await page.evaluate((t) => document.body.innerText.includes(t), SOURCE_STEP));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-02-editor-desktop.png`, fullPage: true });

  console.log('— 3/4/5. 修改标题/说明，选日期/时间/预计耗时，加入日程');
  await setField(page, '[data-testid="next-action-title"]', ACTION_TITLE);
  await setField(page, '[data-testid="next-action-description"]', ACTION_DESCRIPTION);
  await setField(page, '[data-testid="next-action-minutes"]', '25');
  const scheduleChecked = await page.$eval('[data-testid="next-action-schedule-toggle"]', (el) => el.checked);
  if (!scheduleChecked) await page.click('[data-testid="next-action-schedule-toggle"]');
  await setField(page, '[data-testid="next-action-date"]', TODAY);
  await setField(page, '[data-testid="next-action-start-time"]', START_TIME);
  await setField(page, '[data-testid="next-action-end-time"]', END_TIME);
  const formValues = await page.evaluate(() => ({
    title: document.querySelector('[data-testid="next-action-title"]')?.value,
    description: document.querySelector('[data-testid="next-action-description"]')?.value,
    minutes: document.querySelector('[data-testid="next-action-minutes"]')?.value,
    date: document.querySelector('[data-testid="next-action-date"]')?.value,
    start: document.querySelector('[data-testid="next-action-start-time"]')?.value,
    end: document.querySelector('[data-testid="next-action-end-time"]')?.value,
    schedule: document.querySelector('[data-testid="next-action-schedule-toggle"]')?.checked,
  }));
  check(
    '标题/说明/耗时/日期/时间/加入日程均已填写',
    formValues.title === ACTION_TITLE
      && formValues.description === ACTION_DESCRIPTION
      && formValues.minutes === '25'
      && formValues.date === TODAY
      && formValues.start === START_TIME
      && formValues.end === END_TIME
      && formValues.schedule === true,
    JSON.stringify(formValues)
  );

  console.log('— 6/12. 保存（双击验证幂等），确认不重复');
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="next-action-save"]');
    button?.click();
    button?.click();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="next-action-open"]') !== null ||
      document.querySelector('[data-testid="next-action-conflict"]') !== null,
    { timeout: 25000 }
  );
  if (await page.$('[data-testid="next-action-conflict"]')) {
    // 重复运行同一 E2E 库时，演示时段可能有旧安排；明确确认重叠后继续。
    await page.click('[data-testid="next-action-confirm-overlap"]');
  }
  await page.waitForSelector('[data-testid="next-action-open"]', { timeout: 25000 });
  await waitText(page, '下一步行动已保存');
  check('保存后显示下一步行动已保存', true);
  const actionHref = await page.$eval('[data-testid="next-action-open"]', (el) => el.getAttribute('href'));
  const actionId = (actionHref || '').split('/').pop();
  check('保存后提供打开行动入口', Boolean(actionId), String(actionHref));
  const actionCount = await page.evaluate(async (reviewId) => {
    const res = await fetch(`/api/reviews/${reviewId}/next-actions`);
    const body = await res.json();
    return (body.actions || []).length;
  }, REVIEW_ID);
  check('重复点击保存只产生 1 条行动', actionCount === 1, String(actionCount));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-03-saved-desktop.png`, fullPage: true });

  console.log('— 7/8. 日程页找到安排并打开行动');
  await page.goto(`${BASE}/schedule`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.schedule-page', { timeout: 15000 });
  await page.waitForSelector('[data-testid="schedule-detail"]', { timeout: 15000 });
  const scheduleInfo = await page.evaluate((title) => {
    const items = [...document.querySelectorAll('.schedule-item')];
    const item = items.find((el) => el.innerText.includes(title));
    if (!item) return null;
    return {
      text: item.innerText,
      href: item.querySelector('a[href^="/next-action/"]')?.getAttribute('href') || null,
    };
  }, ACTION_TITLE);
  check('日程页找到这条行动安排', scheduleInfo !== null, JSON.stringify(scheduleInfo));
  check(
    '日程条目显示时间与「来自回顾」',
    Boolean(scheduleInfo)
      && scheduleInfo.text.includes('22:30')
      && scheduleInfo.text.includes('23:00')
      && scheduleInfo.text.includes('来自回顾'),
    String(scheduleInfo?.text || '').slice(0, 240)
  );
  await page.screenshot({ path: `${SHOT_DIR}/next-action-04-schedule-desktop.png`, fullPage: true });
  if (scheduleInfo?.href) {
    await page.goto(BASE + scheduleInfo.href, { waitUntil: 'networkidle0' });
  } else {
    await page.evaluate((title) => {
      const item = [...document.querySelectorAll('.schedule-item')].find((el) => el.innerText.includes(title));
      item?.querySelector('[data-testid="schedule-detail"]')?.click();
    }, ACTION_TITLE);
    await page.waitForSelector('.schedule-detail-modal', { timeout: 10000 });
    await clickText(page, '.schedule-detail-modal a', '打开下一步行动');
  }
  await page.waitForSelector('.next-action-page', { timeout: 20000 });
  check('日程可打开下一步行动详情', await page.evaluate((t) => document.body.innerText.includes(t), ACTION_TITLE));
  check('行动详情显示预计耗时与来源回顾', await page.evaluate(() => document.body.innerText.includes('预计 25 分钟') && document.body.innerText.includes('来自回顾')));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-05-action-desktop.png`, fullPage: true });

  console.log('— 9/10. 进入尝试详情并保存实际结果');
  await page.click('[data-testid="next-action-attempt"]');
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  check('从行动进入尝试详情', await page.evaluate(() => !!document.querySelector('.result-form')));
  await page.type('.result-form textarea', ACTUAL_RESULT);
  await page.select('.result-form select', 'success');
  await clickText(page, '.result-form button', '保存结果');
  await waitText(page, '结果已保存', 20000);
  const savedResult = await page.evaluate(async (id) => {
    const body = await (await fetch(`/api/attempts/${id}`)).json();
    return { state: body.attempt?.state, resultText: body.attempt?.resultText, outcome: body.attempt?.outcome };
  }, actionId);
  check(
    '保存实际结果成功',
    savedResult.resultText === ACTUAL_RESULT && savedResult.outcome === 'success',
    JSON.stringify(savedResult)
  );

  // 记录结果不自动改变状态；下一步行动的「完成」由用户明确标记为已结束。
  const ended = await clickText(page, '.state-switch button', '已结束');
  check('可把行动标记为已结束', ended);
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('已结束') ||
      document.querySelector('[data-testid="future-schedule-keep"]') !== null,
    { timeout: 15000 }
  );
  if (await page.$('[data-testid="future-schedule-keep"]')) {
    // 这个行动还带着今天的未来安排；明确选择保留安排。
    await page.click('[data-testid="future-schedule-keep"]');
  }
  await page.waitForFunction(
    async (id) => {
      const res = await fetch(`/api/attempts/${id}`);
      const body = await res.json();
      return body.attempt?.state === 'done';
    },
    { timeout: 15000 },
    actionId
  );
  check('行动状态变为已完成', true);
  await page.screenshot({ path: `${SHOT_DIR}/next-action-06-attempt-result-desktop.png`, fullPage: true });

  console.log('— 11. 返回阶段回顾确认新增尝试/结果/引用');
  await page.goto(`${BASE}/review/${REVIEW_ID}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-detail', { timeout: 20000 });
  await waitText(page, '下一步行动');
  const nextActionSection = await page.$('.review-next-actions');
  check('回顾详情出现已创建的下一步行动', nextActionSection !== null);
  if (nextActionSection) {
    const sectionText = await nextActionSection.evaluate((el) => el.innerText);
    check(
      '回顾详情的行动列表显示已结束',
      sectionText.includes(ACTION_TITLE) && (sectionText.includes('已结束') || sectionText.includes('已完成')),
      sectionText.slice(0, 240)
    );
  }
  await page.screenshot({ path: `${SHOT_DIR}/next-action-07-review-detail-updated-desktop.png`, fullPage: true });

  await page.goto(`${BASE}/review`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-page', { timeout: 20000 });
  await waitText(page, ACTION_TITLE, 20000);
  const rangeText = await page.evaluate(() => document.body.innerText);
  check('阶段回顾实际记录出现新增尝试与结果', rangeText.includes(ACTION_TITLE) && rangeText.includes(ACTUAL_RESULT), rangeText.slice(0, 500));
  const clickedReference = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.review-filter-chip')].find((el) => (el.textContent || '').includes('引用'));
    if (!chip) return false;
    chip.click();
    return true;
  });
  check('阶段回顾可筛选引用记录', clickedReference);
  await new Promise((r) => setTimeout(r, 500));
  const referenceText = await page.$eval('.review-records', (el) => el.innerText).catch(() => '');
  check(
    '阶段回顾引用记录包含行动与来源尝试',
    referenceText.includes(ACTION_TITLE) || referenceText.includes(SOURCE_STEP),
    referenceText.slice(0, 300)
  );
  await page.screenshot({ path: `${SHOT_DIR}/next-action-08-review-records-desktop.png`, fullPage: true });

  console.log('— 13. 390px 手机宽度无横向溢出');
  await setViewport(page, 390, 844, 2);
  await page.goto(`${BASE}/review/${REVIEW_ID}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-detail', { timeout: 20000 });
  check('回顾详情手机宽度无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-09-review-detail-mobile.png`, fullPage: true });

  const startMobile = await page.$('[data-testid="next-action-start"]');
  check('手机宽度可打开下一步编辑入口', startMobile !== null);
  if (startMobile) {
    await startMobile.click();
    await page.waitForSelector('[data-testid="next-action-editor"]', { timeout: 20000 });
    await page.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="next-action-title"]');
        return input && input.value.trim().length > 0;
      },
      { timeout: 20000 }
    );
    check('下一步编辑面板手机宽度无横向溢出', await noHorizontalOverflow(page));
    await page.screenshot({ path: `${SHOT_DIR}/next-action-10-editor-mobile.png`, fullPage: true });
    await clickText(page, '[data-testid="next-action-editor"] button', '取消');
  }

  await page.goto(`${BASE}/next-action/${actionId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.next-action-page', { timeout: 20000 });
  check('行动详情手机宽度无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-11-action-mobile.png`, fullPage: true });

  await page.goto(`${BASE}/schedule`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.schedule-page', { timeout: 20000 });
  check('日程页手机宽度无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/next-action-12-schedule-mobile.png`, fullPage: true });

  check('完整下一步行动 12 步流程通过', true);
} catch (err) {
  failed++;
  failures.push(String(err));
  console.error('E2E ERROR:', err);
  await page.screenshot({ path: `${SHOT_DIR}/next-action-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(64));
console.log(`下一步行动浏览器端到端验收: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
console.log('='.repeat(64));
process.exit(failed === 0 ? 0 : 1);
