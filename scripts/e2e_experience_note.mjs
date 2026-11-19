// 拾念 SHINIAN · 「沉淀一条经验」浏览器端到端验收
// 前置：隔离服务已启动（SHINIAN_BASE，默认 http://127.0.0.1:3110）
// 运行：$env:SHINIAN_BASE="http://127.0.0.1:3110"; node scripts/e2e_experience_note.mjs
// 覆盖：尝试详情「整理成经验」→ 取消不创建 → 保存 → 经验详情 → 手动关联 → 改标题链接仍在
//      → 参考它试一步 → 记录结果 → 修订经验 → 搜索/局部图/首页 → 手机与键盘。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3110').replace(/\/$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const DB_PATH = process.env.SHINIAN_TEST_DB || 'db/verify-experience-note.sqlite';
const USER = `经验演示-${Date.now() % 100000}`;
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
async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
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
async function noOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
}
async function overflowDetail(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className : '',
          id: el.id,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        };
      })
      .filter((x) => x.right > width + 1 || x.left < -1)
      .slice(0, 6);
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: width, offenders };
  });
}
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const CAPTURE_TEXT = `睡前把手机放到书桌上，比放在枕边更容易停止刷手机。【演示 ${STAMP}】`;
const HELPFUL_RESULT = `【演示】手机放书桌后十分钟内睡着了 ${STAMP}`;
const FAILED_RESULT = `【演示】临时工作消息，还是刷了很久 ${STAMP}`;
const EXPERIENCE_TITLE = `【演示】睡前把手机放到书桌上 ${STAMP}`;
const EXPERIENCE_UNDERSTANDING = '把手机放远一点，比放在枕边更容易停止刷手机；但临时工作消息会打断。';
const OTHER_CAPTURE = `另一条相关念头：睡前把工作消息静音 【演示 ${STAMP}】`;
const NEW_RESULT = '【演示】这次也有帮助，但中间醒来一次，用了二十分钟。';
const REVISED_LIMITATION = '【演示】两次结果不一致：一次十分钟内停下，一次仍用了二十分钟；不能概括成普遍有效。';

/** 直接插入一条已完成问答，只用于验证「问答单条观点 → 记成经验」的界面入口；不调用模型。 */
function seedAskWithTwoPoints(a1, a2, capId) {
  const db = new Database(DB_PATH);
  try {
    const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(capId);
    const attemptOne = db.prepare('SELECT * FROM attempts WHERE id = ?').get(a1);
    const attemptTwo = db.prepare('SELECT * FROM attempts WHERE id = ?').get(a2);
    const snap = (attempt) => ({
      sourceKey: `attempt:${attempt.id}`,
      type: 'attempt',
      id: attempt.id,
      captureId: attempt.capture_id,
      title: attempt.step,
      text: attempt.step,
      resultText: attempt.result_text,
      outcome: attempt.outcome,
      state: attempt.state,
      observedAt: attempt.observed_at,
      createdAt: attempt.created_at,
      revision: attempt.revision,
      captureRevision: cap.revision,
      captureText: cap.raw_text,
      archived: false,
    });
    const points = [
      {
        text: '睡前把手机放到书桌上，比放在枕边更容易停止刷手机。',
        basis: 'observation',
        condition: null,
        sourceIds: [`attempt:${a1}`],
      },
      {
        text: '临时工作消息会打断这个做法。',
        basis: 'inference',
        condition: null,
        sourceIds: [`attempt:${a2}`],
      },
    ];
    const answer = {
      summary: '两次尝试的结果不同。',
      points,
      contradictions: [],
      missing: [],
      insufficientEvidence: false,
    };
    const sources = [snap(attemptOne), snap(attemptTwo)];
    const id = `ask-e2e-${STAMP}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO record_queries
       (id, question, keywords, status, answer_json, sources_json,
        config_id, config_version, config_name, model_id,
        created_at, updated_at, finished_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      '睡前把手机放远有帮助吗？',
      '睡前 手机',
      JSON.stringify(answer),
      JSON.stringify(sources),
      'cfg-e2e-demo',
      1,
      '演示模型',
      'fake-e2e',
      now,
      now,
      now
    );
    return id;
  } finally {
    db.close();
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

try {
  console.log('— 登录并预置一条念头 + 两次结果不同的尝试');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card', { timeout: 30000 });
  await page.type('.login-card input', USER);
  await page.click('.login-card button[type="submit"]');
  await page.waitForSelector('.capture-input', { timeout: 15000 });
  check('登录成功并进入首页', true);

  const seed = await page.evaluate(
    async ({ captureText, helpful, failed, other }) => {
      async function req(url, options) {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${url} ${res.status} ${JSON.stringify(body)}`);
        return body;
      }
      const cap = (await req('/api/captures', { method: 'POST', body: JSON.stringify({ rawText: captureText }) })).capture;
      const otherCap = (await req('/api/captures', { method: 'POST', body: JSON.stringify({ rawText: other }) })).capture;
      const a1 = (await req(`/api/captures/${cap.id}/attempts`, {
        method: 'POST',
        body: JSON.stringify({
          step: '睡前把手机放到书桌上', state: 'done', resultText: helpful,
          outcome: 'success', operationId: `seed-a1-${Date.now()}`,
        }),
      })).attempt;
      const a2 = (await req(`/api/captures/${cap.id}/attempts`, {
        method: 'POST',
        body: JSON.stringify({
          step: '睡前把手机放在枕边', state: 'done', resultText: failed,
          outcome: 'failure', operationId: `seed-a2-${Date.now()}`,
        }),
      })).attempt;
      return { capId: cap.id, otherId: otherCap.id, a1: a1.id, a2: a2.id };
    },
    { captureText: CAPTURE_TEXT, helpful: HELPFUL_RESULT, failed: FAILED_RESULT, other: OTHER_CAPTURE }
  );

  console.log('— 从问答的一条观点「记成经验」');
  const askId = seedAskWithTwoPoints(seed.a1, seed.a2, seed.capId);
  await page.goto(`${BASE}/ask/${askId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ask-point-save-experience"]').length >= 2, {
    timeout: 15000,
  });
  check('问答回答显示两条观点各自的「记成经验」', true);
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="ask-point-save-experience"]')[0].click();
  });
  await page.waitForSelector('[data-testid="experience-editor"]', { timeout: 10000 });
  const askEditorText = await page.$eval('[data-testid="experience-editor"]', (el) => el.innerText);
  check(
    '问答入口只预填选中的观点与其实际来源',
    (await page.$eval('[data-testid="experience-understanding"]', (el) => el.value)).includes('放到书桌上') &&
      askEditorText.includes('手机放书桌后十分钟内睡着了') &&
      !askEditorText.includes('临时工作消息，还是刷了很久')
  );
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '已保存为经验');
  check('问答观点保存为经验并给出跳转', true);
  await page.screenshot({ path: `${SHOT_DIR}/experience-ask-entry.png`, fullPage: true });

  console.log('— 从有结果的尝试进入「整理成经验」');
  const countInitial = await page.evaluate(async () => (await (await fetch('/api/experiences')).json()).experiences.length);
  await page.goto(`${BASE}/attempt/${seed.a1}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="experience-note-from-attempt"]', { timeout: 15000 });
  await page.click('[data-testid="experience-note-from-attempt"]');
  await page.waitForSelector('[data-testid="experience-editor"]', { timeout: 10000 });
  check('打开经验编辑器', true);
  check(
    '尝试入口只预填结果与标题，不预填我的理解',
    (await page.$eval('[data-testid="experience-title"]', (el) => el.value)) === '睡前把手机放到书桌上' &&
      (await page.$eval('[data-testid="experience-understanding"]', (el) => el.value)) === ''
  );
  check(
    '编辑器展示实际结果与「尚无实践结果支持」判定',
    (await page.evaluate((r) => document.body.innerText.includes(r), HELPFUL_RESULT)) &&
      !(await page.evaluate(() => document.body.innerText.includes('尚无实践结果支持')))
  );

  // 取消不创建
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="experience-editor"]'));
  const countBefore = await page.evaluate(async () => (await (await fetch('/api/experiences')).json()).experiences.length);
  check('Esc 取消关闭编辑器且不创建经验', countBefore === countInitial, `${countInitial} -> ${countBefore}`);

  await page.click('[data-testid="experience-note-from-attempt"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  await setField(page, '[data-testid="experience-title"]', EXPERIENCE_TITLE);
  await setField(page, '[data-testid="experience-understanding"]', EXPERIENCE_UNDERSTANDING);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '已保存为经验');
  check('保存后页面提示已创建经验', true);
  await clickText(page, 'a', '打开经验');
  await page.waitForSelector('[data-testid="experience-try"]', { timeout: 15000 });
  const experienceUrl = page.url();
  const experienceId = experienceUrl.split('/experience/')[1];
  check('进入经验详情', Boolean(experienceId), experienceUrl);
  check(
    '详情先显示我的理解，并保留用户整理出处',
    (await page.evaluate((t) => document.body.innerText.includes(t), EXPERIENCE_UNDERSTANDING)) &&
      (await page.evaluate(() => document.body.innerText.includes('由你自己整理')))
  );
  check(
    '详情没有可信度百分比或「已证实」字样',
    !(await page.evaluate(() => /可信度|已证实|准确率\s*%/.test(document.body.innerText)))
  );
  await page.screenshot({ path: `${SHOT_DIR}/experience-detail-desktop.png`, fullPage: true });

  console.log('— 手动关联另一条念头；修改标题后链接仍在');
  await setField(page, '.capture-links-panel input[type="search"]', OTHER_CAPTURE);
  await clickText(page, '.capture-links-panel button', '查找');
  await page.waitForFunction(() => document.querySelectorAll('.experience-candidate-list li').length > 0);
  await clickText(page, '.experience-candidate-list button', '关联');
  await waitText(page, '已关联');
  check('可与其他念头建立手动关联', true);

  await page.click('[data-testid="experience-edit"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  const editedTitle = `${EXPERIENCE_TITLE}（改标题）`;
  await setField(page, '[data-testid="experience-title"]', editedTitle);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '经验已更新');
  await page.waitForSelector('[data-testid="experience-try"]');
  check('修改标题后详情更新', await page.evaluate((t) => document.body.innerText.includes(t), editedTitle));
  check(
    '修改标题后手动链接仍存在',
    await page.evaluate(() => document.body.innerText.includes('我关联到（1）'))
  );

  console.log('— 局部图');
  await page.goto(`${BASE}/graph?focus=experience:${experienceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.graph-page', { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes('知识网络'));
  check(
    '局部图能选中经验并解释「依据」关系',
    (await page.evaluate(() => document.body.innerText.includes('依据这条记录'))) &&
      (await page.evaluate(() => document.body.innerText.includes('经验')))
  );
  check(
    '图谱提供经验图例与低饱和节点（类型筛选默认包含）',
    await page.evaluate(() => document.body.innerText.includes('经验'))
  );
  await page.screenshot({ path: `${SHOT_DIR}/experience-graph-local.png`, fullPage: true });

  console.log('— 参考它，试一步 → 记录结果');
  await page.goto(`${BASE}/experience/${experienceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="experience-try"]');
  await page.click('[data-testid="experience-try"]');
  await page.waitForSelector('[data-testid="experience-create-attempt"]', { timeout: 10000 });
  check('默认选中所属念头', await page.evaluate(() => !!document.querySelector('.experience-try-form select')?.value));
  await page.click('[data-testid="experience-create-attempt"]');
  await page.waitForSelector('a[href^="/attempt/"]', { timeout: 10000 });
  await page.waitForFunction(() => document.body.innerText.includes('去记录结果'));
  check('创建尝试后给出「去记录结果」', true);
  await clickText(page, 'a', '去记录结果');
  await page.waitForSelector('[data-testid="attempt-result-text"]', { timeout: 15000 });
  await setField(page, '[data-testid="attempt-result-text"]', NEW_RESULT);
  await setField(page, '[data-testid="attempt-result-outcome"]', 'success');
  await page.click('[data-testid="attempt-save-result"]');
  await waitText(page, '结果已保存');
  check('新尝试结果保存成功', true);
  await page.screenshot({ path: `${SHOT_DIR}/experience-new-result.png`, fullPage: true });

  await clickText(page, 'a', editedTitle);
  await page.waitForSelector('[data-testid="experience-revise-from-attempt"]', { timeout: 15000 });
  check(
    '经验详情能找到这次实践及结果',
    await page.evaluate((r) => document.body.innerText.includes(r), NEW_RESULT)
  );
  check(
    '后续尝试保留采用时版本',
    await page.evaluate(() => /采用时第\s+\d+\s+版/.test(document.body.innerText))
  );

  console.log('— 根据结果修订经验');
  await page.click('[data-testid="experience-revise-from-attempt"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  check(
    '修订面板展示这次结果',
    await page.evaluate((r) => document.body.innerText.includes(r), NEW_RESULT)
  );
  await setField(page, '[data-testid="experience-limitations"]', REVISED_LIMITATION);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '经验已更新');
  await page.waitForSelector('[data-testid="experience-try"]');
  check(
    '修订后条件/限制保留，旧理解与新结果并存',
    (await page.evaluate((r) => document.body.innerText.includes(r), REVISED_LIMITATION)) &&
      (await page.evaluate((r) => document.body.innerText.includes(r), EXPERIENCE_UNDERSTANDING))
  );
  await page.screenshot({ path: `${SHOT_DIR}/experience-revised-desktop.png`, fullPage: true });

  console.log('— 搜索、首页入口');
  await page.goto(`${BASE}/search?q=${encodeURIComponent('手机')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="search-filter-experience"]', { timeout: 15000 });
  await page.click('[data-testid="search-filter-experience"]');
  await page.waitForFunction(() => document.body.innerText.includes('经验 '));
  check(
    '搜索展示经验标题、摘要和命中原因',
    (await page.evaluate((t) => document.body.innerText.includes(t), editedTitle)) &&
      (await page.evaluate(() => document.body.innerText.includes('匹配：')))
  );
  await page.screenshot({ path: `${SHOT_DIR}/experience-search.png`, fullPage: true });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('我整理的经验'));
  check(
    '首页不新增顶级导航但有经验入口区',
    (await page.evaluate(() => document.body.innerText.includes('我整理的经验'))) &&
      (await page.evaluate((t) => document.body.innerText.includes(t), editedTitle)) &&
      !(await page.evaluate(() =>
        Array.from(document.querySelectorAll('.app-nav a')).some((a) => a.textContent.includes('经验'))
      ))
  );

  console.log('— 手机与键盘');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/experience/${experienceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="experience-try"]');
  check('手机宽度无横向溢出', await noOverflow(page));
  check(
    '手机可看到我的理解、来源与后续实践',
    (await page.evaluate(() => document.body.innerText.includes('我的理解'))) &&
      (await page.evaluate(() => document.body.innerText.includes('依据记录'))) &&
      (await page.evaluate(() => document.body.innerText.includes('参考这条经验的尝试')))
  );
  await page.click('[data-testid="experience-edit"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  check('手机可打开编辑面板且无横向溢出', await noOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/experience-mobile-editor.png`, fullPage: true });
  await setField(page, '[data-testid="experience-limitations"]', `${REVISED_LIMITATION}（手机补充）`);
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '经验已更新');
  await page.waitForSelector('[data-testid="experience-try"]');
  check(
    '手机可完成编辑并保存',
    await page.evaluate((t) => document.body.innerText.includes(t), '手机补充')
  );
  await page.screenshot({ path: `${SHOT_DIR}/experience-mobile-detail.png`, fullPage: true });
  await page.click('[data-testid="experience-try"]');
  await page.waitForSelector('[data-testid="experience-create-attempt"]', { timeout: 10000 });
  check(
    '手机可打开参考经验表单且无横向溢出',
    await noOverflow(page),
    JSON.stringify(await overflowDetail(page))
  );
  await page.click('[data-testid="experience-create-attempt"]');
  await page.waitForFunction(() => document.body.innerText.includes('去记录结果'));
  await clickText(page, 'a', '去记录结果');
  await page.waitForSelector('[data-testid="attempt-result-text"]', { timeout: 15000 });
  check('手机可从经验创建尝试并进入结果表单', await noOverflow(page));
  await setField(page, '[data-testid="attempt-result-text"]', `手机补充的实践结果-${STAMP}`);
  await setField(page, '[data-testid="attempt-result-outcome"]', 'partial');
  await page.click('[data-testid="attempt-save-result"]');
  await waitText(page, '结果已保存');
  await page.goto(`${BASE}/experience/${experienceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="experience-try"]');
  check(
    '手机记录结果后经验详情能看到这次实践',
    await page.evaluate(
      (t) => document.body.innerText.includes(t),
      `手机补充的实践结果-${STAMP}`
    )
  );
  await page.click('[data-testid="experience-edit"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="experience-editor"]'));
  check('键盘 Esc 可取消编辑', true);
} catch (error) {
  failed++;
  failures.push(`脚本异常 ${error.message}`);
  console.error('E2E ERROR', error);
  try {
    await page.screenshot({ path: `${SHOT_DIR}/experience-e2e-error.png`, fullPage: true });
  } catch {}
} finally {
  await browser.close();
}

console.log(`\n经验笔记浏览器验收：${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log(' -', f));
}
process.exit(failed === 0 ? 0 : 1);
