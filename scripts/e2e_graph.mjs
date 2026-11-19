// 拾念 SHINIAN · 关联记录 + 全局/局部知识网浏览器验收
// 真实 Chrome，桌面 1280×900 与手机 390×844；隔离库 + 独立服务。
// 运行前：
//   $env:PORT="3500"; $env:DATABASE_URL="<repo>\db\e2e-graph.sqlite";
//   $env:SHINIAN_MASTER_KEY_FILE="<repo>\db\e2e-graph-master.key"; npm run serve
// 运行：
//   $env:SHINIAN_BASE="http://127.0.0.1:3500"; node scripts/e2e_graph.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = (process.env.SHINIAN_BASE || 'http://127.0.0.1:3500').replace(/\/$/, '');
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = process.env.SHINIAN_SHOT_DIR || 'shots';
const USER = `图谱验收-${Date.now() % 100000}`;
const STAMP = Date.now() % 1000000;
let passed = 0;
let failed = 0;
const failures = [];
const consoleErrors = [];

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

async function noHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
}

async function textWithFormValues(page, selector) {
  return page.$eval(selector, (el) => {
    const fields = Array.from(el.querySelectorAll('textarea, input, select'))
      .map((node) => node.value || '')
      .join('\n');
    return `${el.innerText}\n${fields}`;
  });
}

async function api(page, path, options = {}) {
  return page.evaluate(
    async (p, opt) => {
      const res = await fetch(p, {
        credentials: 'same-origin',
        headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opt,
        body: opt.body ? JSON.stringify(opt.body) : undefined,
      });
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body };
    },
    path,
    options
  );
}

function op(name) {
  return `e2eg-${STAMP}-${name}-${Math.random().toString(36).slice(2, 7)}`;
}

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const A_TEXT = `【图谱验收】A 旧念头：LED 低占空比闪烁 ${STAMP}`;
const B_TEXT = `【图谱验收】B 新念头：提高 PWM 频率后复测 ${STAMP}`;
const OLD_TEXT = `【图谱验收】很早以前的旧记录 ${STAMP}`;
const OLD_RESULT = `OLD-RESULT-${STAMP} 500Hz 时闪烁明显，2kHz 时肉眼不可见`;
const B_RESULT = `B-RESULT-${STAMP} 2kHz 下连续观察十分钟没有闪烁`;
const SAME_TEXT = `【图谱验收】同名记录 ${STAMP}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 300000,
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
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGE: ${e.message}`));
await page.setViewport({ width: 1280, height: 900 });

let A = null;
let B = null;
let A_ATT = null;
let B_ATT = null;
let OLD = null;
let OLD_ATT = null;
let ORPHAN = null;
let C = null;

try {
  console.log('— 登录 & 空图');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  if (await page.$('.login-card')) {
    await page.type('.login-card input', USER);
    await page.click('.login-card button[type="submit"]');
    await page.waitForSelector('.capture-input', { timeout: 20000 });
  }
  await page.goto(`${BASE}/graph`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-page', { timeout: 20000 });
  check('空图显示明确空状态', Boolean(await page.$('[data-testid="graph-empty"]')));
  check('空图不报错', await page.evaluate(() => !document.body.innerText.includes('知识网络加载失败')));

  console.log('— 通过 API 造隔离验收数据');
  A = (await api(page, '/api/captures', { method: 'POST', body: { rawText: A_TEXT } })).body.capture;
  B = (await api(page, '/api/captures', { method: 'POST', body: { rawText: B_TEXT } })).body.capture;
  C = (await api(page, '/api/captures', { method: 'POST', body: { rawText: `【图谱验收】C 归档候选 ${STAMP}` } })).body.capture;
  ORPHAN = (await api(page, '/api/captures', { method: 'POST', body: { rawText: `【图谱验收】孤立念头 ${STAMP}` } })).body.capture;
  const s1 = (await api(page, '/api/captures', { method: 'POST', body: { rawText: SAME_TEXT } })).body.capture;
  await sleep(15);
  const s2 = (await api(page, '/api/captures', { method: 'POST', body: { rawText: SAME_TEXT } })).body.capture;
  check('同名记录 ID 不同', s1.id !== s2.id);

  A_ATT = (
    await api(page, `/api/captures/${A.id}/attempts`, {
      method: 'POST',
      body: {
        step: `A 的旧尝试：500Hz 对照 ${STAMP}`,
        state: 'done',
        resultText: `A-RESULT-${STAMP} 500Hz 闪烁明显`,
        outcome: 'failure',
        operationId: op('a-att'),
      },
    })
  ).body.attempt;
  B_ATT = (
    await api(page, `/api/captures/${B.id}/attempts`, {
      method: 'POST',
      body: {
        step: `B 的尝试：2kHz 复测 ${STAMP}`,
        state: 'done',
        resultText: B_RESULT,
        outcome: 'success',
        operationId: op('b-att'),
      },
    })
  ).body.attempt;
  await api(page, `/api/attempts/${B_ATT.id}`, {
    method: 'PATCH',
    body: {
      state: 'done',
      resultText: B_RESULT,
      outcome: 'success',
      sourceUrl: `https://example.com/shinian-b/${STAMP}`,
      revision: B_ATT.revision,
    },
  });
  B_ATT = (await api(page, `/api/attempts/${B_ATT.id}`)).body.attempt;
  await api(page, `/api/attempts/${B_ATT.id}/references`, {
    method: 'POST',
    body: { toId: A_ATT.id, note: '对照 A 的旧结果', operationId: op('ref') },
  });

  OLD = (await api(page, '/api/captures', { method: 'POST', body: { rawText: OLD_TEXT } })).body.capture;
  OLD_ATT = (
    await api(page, `/api/captures/${OLD.id}/attempts`, {
      method: 'POST',
      body: {
        step: `旧记录里的尝试 ${STAMP}`,
        state: 'done',
        resultText: OLD_RESULT,
        outcome: 'undetermined',
        operationId: op('old-att'),
      },
    })
  ).body.attempt;
  await api(page, `/api/attempts/${OLD_ATT.id}`, {
    method: 'PATCH',
    body: {
      state: 'done',
      resultText: OLD_RESULT,
      outcome: 'undetermined',
      sourceUrl: `https://example.com/shinian-old/${STAMP}`,
      revision: OLD_ATT.revision,
    },
  });
  OLD_ATT = (await api(page, `/api/attempts/${OLD_ATT.id}`)).body.attempt;

  // 制造超过全局图 240 条上限的数据；同时让图有一些真实的簇。
  const fillerIds = [];
  for (let i = 0; i < 246; i += 1) {
    const r = await api(page, '/api/captures', {
      method: 'POST',
      body: { rawText: `【图谱密度】记录 ${String(i).padStart(3, '0')} ${STAMP}` },
    });
    fillerIds.push(r.body.capture.id);
  }
  for (let i = 0; i < 12; i += 1) {
    const att = await api(page, `/api/captures/${fillerIds[i]}/attempts`, {
      method: 'POST',
      body: {
        step: `密度尝试 ${i} ${STAMP}`,
        state: 'done',
        resultText: `密度结果 ${i} ${STAMP}`,
        outcome: i % 3 === 0 ? 'failure' : 'success',
        operationId: op(`dense-${i}`),
      },
    });
    if (i > 0 && i % 2 === 0) {
      await api(page, `/api/captures/${fillerIds[i - 1]}/links`, {
        method: 'POST',
        body: { toCaptureId: fillerIds[i], note: `密度关联 ${i}`, operationId: op(`dense-link-${i}`) },
      });
    }
    if (att.body.attempt) {
      // 保留尝试，方便图谱里出现密集小点
    }
  }

  console.log('— 打开 A，建立 A → B 关联');
  await page.goto(`${BASE}/capture/${A.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-links-section', { timeout: 20000 });
  await page.click('[data-testid="capture-link-open"]');
  await page.waitForSelector('.link-composer input[type="search"]', { timeout: 10000 });
  await setField(page, '.link-composer input[type="search"]', 'B 新念头');
  await page.click('.link-composer form button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelector('.link-candidates')?.innerText.includes('B 新念头'),
    { timeout: 15000 }
  );
  const candidateText = await page.$eval('.link-candidates', (el) => el.innerText);
  check('候选列表显示短摘要和日期', candidateText.includes('B 新念头') && /\d{4}-\d{2}-\d{2}/.test(candidateText), candidateText.slice(0, 200));
  check('候选列表排除当前念头', !candidateText.includes('A 旧念头'));
  await clickText(page, '.link-candidate', 'B 新念头');
  await page.waitForSelector('.link-target', { timeout: 10000 });
  await setField(page, '.link-target input[type="text"]', '同一个闪烁问题的前后两条记录');
  await page.click('[data-testid="capture-link-submit"]');
  await waitText(page, '已建立关联', 15000);
  await page.waitForSelector('[data-testid="capture-link-row"][data-direction="out"]', { timeout: 10000 });
  const aRow = await page.$eval('[data-testid="capture-link-row"][data-direction="out"]', (el) => el.innerText);
  check('A 显示「关联到 B」', aRow.includes('B 新念头') && aRow.includes('同一个闪烁问题'), aRow);
  await page.screenshot({ path: `${SHOT_DIR}/graph-capture-links-desktop.png`, fullPage: true });

  console.log('— 打开 B，确认反链');
  await page.click('[data-testid="capture-link-row"][data-direction="out"] .capture-link-title');
  await page.waitForSelector('.capture-links-section', { timeout: 15000 });
  await page.waitForSelector('[data-testid="capture-link-row"][data-direction="in"]', { timeout: 10000 });
  const bRow = await page.$eval('[data-testid="capture-link-row"][data-direction="in"]', (el) => el.innerText);
  check('B 显示「被 A 关联」', bRow.includes('A 旧念头') && bRow.includes('同一个闪烁问题'), bRow);
  check('B 的引用区显示后来用过这条结果', (await page.$eval('.capture-references-section', (el) => el.innerText)).includes('后来哪里用过这条结果'));

  console.log('— 从 B 打开局部图，切换一跳/两跳');
  await page.click('[data-testid="capture-open-local-graph"]');
  await page.waitForSelector('.graph-focus-bar', { timeout: 25000 });
  await page.waitForFunction(() => document.body.innerText.includes('一跳'), { timeout: 15000 });
  const oneHopCount = await page.$$eval('.graph-node', (els) => els.length);
  check('局部图默认一跳并显示焦点', (await page.$eval('.graph-focus-bar', (el) => el.innerText)).includes('一跳'), await page.$eval('.graph-focus-bar', (el) => el.innerText));
  await page.screenshot({ path: `${SHOT_DIR}/graph-local-desktop.png`, fullPage: false });
  await clickText(page, '.graph-depth-toggle button', '两跳');
  await page.waitForFunction(() => document.querySelector('.graph-focus-bar')?.innerText.includes('两跳'), { timeout: 20000 });
  await sleep(900);
  const twoHopCount = await page.$$eval('.graph-node', (els) => els.length);
  check('两跳节点不少于一跳', twoHopCount >= oneHopCount, `${oneHopCount} -> ${twoHopCount}`);
  const twoHopPanels = await page.$eval('.graph-focus-bar', (el) => el.innerText);
  check('两跳标记写回 URL/界面', twoHopPanels.includes('两跳'), twoHopPanels);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-focus-bar', { timeout: 20000 });
  const reloadedBar = await page.$eval('.graph-focus-bar', (el) => el.innerText);
  check('刷新后按 URL 稳定 ID 恢复局部图', reloadedBar.includes('B 新念头') && reloadedBar.includes('两跳'), reloadedBar);

  console.log('— 沿边找到 B 的尝试，读到实际观察与来源');
  await page.waitForFunction(() => document.body.innerText.includes('B 的尝试'), { timeout: 20000 });
  const nodeClicked = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.graph-node'));
    const node = nodes.find((el) => (el.getAttribute('aria-label') || '').includes('B 的尝试'));
    if (!node) return false;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  check('局部图中可选中尝试节点', nodeClicked);
  await sleep(400);
  const panelText = await page.$eval('.graph-panel', (el) => el.innerText);
  check('节点详情显示实际观察', panelText.includes('B-RESULT'), panelText.slice(0, 400));
  check('节点详情显示来源链接', panelText.includes('example.com/shinian-b'), panelText.slice(0, 500));
  const sourceHref = await page.$eval('.graph-source-link a', (el) => el.href);
  check('来源链接可打开且带完整地址', sourceHref.includes('example.com/shinian-b'), sourceHref);
  await clickText(page, '.graph-actions .graph-open', '打开原记录');
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  const attemptPageText = await textWithFormValues(page, '.attempt-page');
  check('打开原记录能看到实际观察', attemptPageText.includes('B-RESULT'));
  check('原记录显示来源地址', attemptPageText.includes('example.com/shinian-b'), attemptPageText.slice(0, 500));

  console.log('— 全局图搜索超出上限的旧记录');
  await page.goto(`${BASE}/graph`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-page', { timeout: 20000 });
  const statsText = await page.$eval('.graph-readout-stats', (el) => el.innerText);
  check('全局图展示上限提示出现', (await page.$eval('.graph-page', (el) => el.innerText)).includes('全图仅显示最近'), statsText);
  await page.click('.graph-controls .graph-chip:nth-child(3)');
  await page.waitForSelector('.graph-search-form input', { timeout: 10000 });
  await setField(page, '.graph-search-form input', `OLD-RESULT-${STAMP}`);
  await page.click('.graph-search-form button[type="submit"]');
  await page.waitForSelector('.graph-search-result', { timeout: 20000 });
  const searchText = await page.$eval('.graph-search-results', (el) => el.innerText);
  check('搜索命中超出全局图上限的旧结果', searchText.includes('OLD-RESULT'), searchText.slice(0, 300));
  check('搜索结果标出尝试与所属念头', searchText.includes('尝试') && searchText.includes('属于'), searchText.slice(0, 300));
  await page.click('.graph-search-result');
  await page.waitForSelector('.graph-focus-bar', { timeout: 20000 });
  check('点选搜索结果定位到局部图', (await page.$eval('.graph-focus-bar', (el) => el.innerText)).includes('局部图'));
  const oldPanel = await page.$eval('.graph-panel', (el) => el.innerText);
  check('定位后的详情显示旧结果', oldPanel.includes('OLD-RESULT'), oldPanel.slice(0, 400));
  await clickText(page, '.graph-actions .graph-open', '打开原记录');
  await page.waitForSelector('.attempt-page', { timeout: 20000 });
  const oldPageText = await textWithFormValues(page, '.attempt-page');
  check('旧记录原页面可打开', oldPageText.includes('OLD-RESULT'), oldPageText.slice(0, 400));

  console.log('— 修改关联记录标题后链接仍有效');
  await page.goto(`${BASE}/capture/${A.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-links-section');
  await clickText(page, '.detail-head .row-actions button', '编辑');
  await page.waitForSelector('.capture-input');
  const NEW_A_TEXT = `${A_TEXT}（已改名）`;
  await setField(page, '.capture-input', NEW_A_TEXT);
  await clickText(page, '.row-actions button', '保存');
  await waitText(page, '已改名', 15000);
  await page.goto(`${BASE}/capture/${B.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="capture-link-row"][data-direction="in"]', { timeout: 10000 });
  const renamedRow = await page.$eval('[data-testid="capture-link-row"][data-direction="in"]', (el) => el.innerText);
  check('改名后反链仍指向同一条记录', renamedRow.includes('已改名'), renamedRow);
  check('改名后关联说明仍保留', renamedRow.includes('同一个闪烁问题'), renamedRow);

  console.log('— 解除关联，双方与图谱同步');
  await page.click('[data-testid="capture-link-row"][data-direction="in"] [data-testid="capture-link-remove"]');
  await waitText(page, '已解除来自', 15000);
  check('解除后 B 不再显示该反链', (await page.$$('[data-testid="capture-link-row"][data-direction="in"]')).length === 0);
  await page.goto(`${BASE}/capture/${A.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-links-section');
  check('解除后 A 不再显示正链', (await page.$$('[data-testid="capture-link-row"][data-direction="out"]')).length === 0);

  console.log('— 删除记录时关联同步清理');
  const cLink = await api(page, `/api/captures/${A.id}/links`, {
    method: 'POST',
    body: { toCaptureId: C.id, note: '删除测试', operationId: op('del-link') },
  });
  check('重新建立 A→C 关联', cLink.status === 200 && cLink.body.link?.id, JSON.stringify(cLink).slice(0, 300));
  const del = await api(page, `/api/captures/${C.id}`, { method: 'DELETE' });
  check('删除 C 时级联删除关联', del.status === 200 && del.body.deletedLinks === 1, JSON.stringify(del).slice(0, 300));
  await page.goto(`${BASE}/capture/${A.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-links-section');
  check('删除后 A 的关联列表同步更新', (await page.$eval('.capture-links-section', (el) => el.innerText)).includes('还没有主动关联的念头'));

  console.log('— 归档筛选、孤立节点、同名记录、重复关联');
  await api(page, `/api/captures/${ORPHAN.id}/archive`, { method: 'POST', body: {} });
  await page.goto(`${BASE}/graph`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-page', { timeout: 20000 });
  await clickText(page, '.graph-controls .graph-chip', '仅看当前');
  await page.waitForFunction(() => document.body.innerText.includes('已包含归档'), { timeout: 15000 });
  await sleep(500);
  check('归档开关可切换且图谱不报错', (await page.$eval('.graph-controls', (el) => el.innerText)).includes('已包含归档'));
  await page.click('.graph-controls .graph-chip:nth-child(3)');
  await page.waitForSelector('.graph-filter-check input', { timeout: 10000 });
  const beforeOrphan = await page.$$eval('.graph-node', (els) => els.length);
  await page.click('.graph-filter-check input');
  await sleep(500);
  const afterOrphan = await page.$$eval('.graph-node', (els) => els.length);
  check('孤立节点开关可操作', await page.$eval('.graph-filter-check input', (el) => el.checked));
  check('隐藏孤立节点后节点数量减少', afterOrphan < beforeOrphan, `${beforeOrphan} -> ${afterOrphan}`);
  check('筛选后边端点仍都可见', await page.evaluate(() => {
    const nodes = new Set(Array.from(document.querySelectorAll('.graph-node')).map((n) => n.getAttribute('transform')));
    return nodes.size > 0;
  }));
  await page.click('.graph-controls .graph-chip:nth-child(3)');

  console.log('— 失效链接明确提示');
  await page.goto(`${BASE}/graph?node=capture:cap-does-not-exist&depth=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-page', { timeout: 20000 });
  await page.waitForFunction(
    () => (document.querySelector('.graph-focus-missing')?.innerText || '').includes('已不存在'),
    { timeout: 20000 }
  );
  check('失效节点链接有明确提示', (await page.$eval('.graph-focus-missing', (el) => el.innerText)).includes('已不存在或不可见'));
  check('失效后仍可回到全图', await page.evaluate(() => document.body.innerText.includes('知识网络')));

  console.log('— 桌面全局截图');
  await api(page, `/api/captures/${A.id}/links`, {
    method: 'POST',
    body: { toCaptureId: B.id, note: '截图用的关联说明', operationId: op('shot-link') },
  });
  await page.goto(`${BASE}/graph`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-svg', { timeout: 20000 });
  await sleep(1400);
  await page.screenshot({ path: `${SHOT_DIR}/graph-global-desktop.png`, fullPage: false });

  console.log('— 手机宽度');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/graph`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-svg', { timeout: 20000 });
  await sleep(1200);
  check('手机全局图无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/graph-global-mobile.png`, fullPage: false });
  await page.click('.graph-controls .graph-chip:nth-child(3)');
  await page.waitForSelector('.graph-search-form input', { timeout: 10000 });
  await setField(page, '.graph-search-form input', 'B 新念头');
  await page.click('.graph-search-form button[type="submit"]');
  await page.waitForSelector('.graph-search-result', { timeout: 20000 });
  await page.click('.graph-search-result');
  await page.waitForSelector('.graph-focus-bar', { timeout: 20000 });
  check('手机可从搜索结果进入局部图', (await page.$eval('.graph-focus-bar', (el) => el.innerText)).includes('局部图'));
  await page.goto(`${BASE}/capture/${B.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.capture-links-section', { timeout: 20000 });
  check('手机念头详情无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/graph-capture-links-mobile.png`, fullPage: true });
  await page.goto(`${BASE}/graph?node=capture:${B.id}&depth=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-focus-bar', { timeout: 20000 });
  await sleep(900);
  check('手机局部图无横向溢出', await noHorizontalOverflow(page));
  await page.screenshot({ path: `${SHOT_DIR}/graph-local-mobile.png`, fullPage: false });
  const mobileText = await page.$eval('.graph-page', (el) => el.innerText);
  check('手机局部图仍能读到关系文字', mobileText.includes('关联到') || mobileText.includes('局部图'), mobileText.slice(0, 250));

  console.log('— 键盘可访问');
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/graph?node=capture:${B.id}&depth=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.graph-node[tabindex="0"]', { timeout: 20000 });
  const keyboardFocusable = await page.$$eval('.graph-node[tabindex="0"]', (els) => els.length > 0);
  check('图谱节点可通过 Tab 聚焦', keyboardFocusable);
  await page.evaluate(() => {
    const node = document.querySelector('.graph-node[tabindex="0"]');
    if (node) node.focus();
  });
  await page.keyboard.press('Enter');
  const focusedSelected = await page.evaluate(() => document.querySelectorAll('.graph-node[aria-pressed="true"]').length > 0);
  check('节点可用 Enter 选中', focusedSelected);

  console.log(`\n浏览器验收: ${passed} passed, ${failed} failed`);
  if (consoleErrors.length) {
    console.log('console errors:', consoleErrors.slice(0, 8));
  }
  if (failures.length) {
    console.log('failures:', failures);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('E2E 异常:', err);
  await page.screenshot({ path: `${SHOT_DIR}/graph-e2e-error.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
