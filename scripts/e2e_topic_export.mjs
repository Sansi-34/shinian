// 拾念 SHINIAN · 主题 Markdown ZIP 浏览器端到端验收（自启动隔离服务）
// 运行：node scripts/e2e_topic_export.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PORT = Number(process.env.SHINIAN_TOPIC_EXPORT_E2E_PORT || 3242);
const BASE = process.env.SHINIAN_BASE || `http://127.0.0.1:${PORT}`;
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DB = process.env.SHINIAN_TOPIC_EXPORT_E2E_DB || path.join(ROOT, 'db', 'topic-export-e2e.sqlite');
const MASTER_KEY = `${DB}.master.key`;
const LOG = `${DB}.server.log`;
const DOWNLOADS = path.resolve('shots', 'topic-export-e2e-downloads');
const SHOTS = 'shots';
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitServer(base, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${base}/api/session/check`);
      if (res.status === 401 || res.ok) return;
    } catch {
      // 服务尚未就绪
    }
    await sleep(300);
  }
  throw new Error(`隔离服务未能启动：${base}`);
}

function startServer() {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  if (fs.existsSync(MASTER_KEY)) fs.rmSync(MASTER_KEY, { force: true });
  const env = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: DB,
    SHINIAN_MASTER_KEY_FILE: MASTER_KEY,
  };
  const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server/index.ts'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
  return server;
}

function stopServer(server) {
  if (!server || server.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
for (const name of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, name), { force: true });

const server = BASE === `http://127.0.0.1:${PORT}` ? startServer() : null;
let browser;

try {
  await waitServer(BASE);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      externalRequests.push(url);
    }
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  if (await page.$('.login-card')) {
    await page.type('.login-card input', '主题导出E2E');
    await page.click('.login-card button[type="submit"]');
    await page.waitForSelector('.capture-input', { timeout: 20000 });
  }

  const seed = await page.evaluate(async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    async function apiPost(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`${url}: ${res.status} ${JSON.stringify(data)}`);
      return data;
    }
    const a1 = (await apiPost('/api/captures', { rawText: `【E2E A1】特殊 [标题](../../x) 中文 ${stamp}` })).capture;
    const a2 = (await apiPost('/api/captures', { rawText: `【E2E 同名归档】${stamp}` })).capture;
    const b1 = (await apiPost('/api/captures', { rawText: `【E2E B1】另一个主题 ${stamp}` })).capture;
    const b2 = (await apiPost('/api/captures', { rawText: `【E2E 同名归档】${stamp} B2` })).capture;
    const a1Attempt = (
      await apiPost(`/api/captures/${a1.id}/attempts`, {
        step: `【E2E A1尝试】${stamp}`,
        state: 'done',
        resultText: `真实观察 ${stamp}`,
        outcome: 'undetermined',
        operationId: `e2e-a1-att-${stamp}`,
      })
    ).attempt;
    const b1Attempt = (
      await apiPost(`/api/captures/${b1.id}/attempts`, {
        step: `【E2E B1依据】${stamp}`,
        state: 'done',
        resultText: `跨主题依据结果 ${stamp}`,
        outcome: 'success',
        operationId: `e2e-b1-att-${stamp}`,
      })
    ).attempt;
    const exp = (
      await apiPost('/api/experiences', {
        title: `【E2E 经验】${stamp}`,
        understanding: `我的理解 ${stamp}`,
        conditions: '条件',
        limitations: '限制',
        sourceKeys: [`attempt:${b1Attempt.id}`, `capture:${b2.id}`],
        operationId: `e2e-exp-${stamp}`,
      })
    ).experience;
    await apiPost(`/api/captures/${a2.id}/archive`, {});
    const topicA = (
      await apiPost('/api/topics', {
        title: `【E2E 主题A】${stamp}`,
        exploringQuestion: '要验证什么？',
        continueNote: '继续',
        captureIds: [a1.id, a2.id, exp.id],
        operationId: `e2e-topic-a-${stamp}`,
      })
    ).topic;
    const topicB = (
      await apiPost('/api/topics', {
        title: `【E2E 主题B】${stamp}`,
        captureIds: [b1.id, b2.id],
        operationId: `e2e-topic-b-${stamp}`,
      })
    ).topic;
    return { topicAId: topicA.id, topicBId: topicB.id, stamp };
  });
  check('浏览器内准备两个主题与跨主题依据', Boolean(seed.topicAId && seed.topicBId));

  await page.goto(`${BASE}/topics/${seed.topicAId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-export-open"]', { timeout: 20000 });
  await page.click('[data-testid="topic-export-open"]');
  await page.waitForSelector('[data-testid="topic-export-panel"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="topic-export-summary"]', { timeout: 20000 });
  await sleep(900);
  const panelText = await page.$eval('[data-testid="topic-export-panel"]', (el) => el.innerText);
  check('预览显示念头/经验/尝试/文件数', panelText.includes('念头') && panelText.includes('尝试') && panelText.includes('文件数'), panelText.slice(0, 200));
  check('预览显示独立副本说明', panelText.includes('独立副本'));
  check('预览显示一跳依据候选', panelText.includes('可追加的一跳直接依据'));
  await page.click('[data-testid="topic-export-files-toggle"]');
  await sleep(300);
  const fileDetailsOpen = await page.$eval('[data-testid="topic-export-files"]', (el) => el.open);
  check('文件清单可展开', fileDetailsOpen === true);
  await page.screenshot({ path: path.join(SHOTS, 'topic-export-e2e-preview-desktop.png') });

  const boxes = await page.$$('.topic-export-basis input[type="checkbox"]:not([disabled])');
  check('至少有一条可选一跳依据', boxes.length >= 1, String(boxes.length));
  if (boxes.length) {
    await boxes[0].click();
    await sleep(1200);
  }
  await page.click('[data-testid="topic-export-confirm"]');
  let desktopZip = null;
  for (let index = 0; index < 100; index += 1) {
    const files = fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith('.zip'));
    if (files.length) {
      desktopZip = path.join(DOWNLOADS, files[0]);
      break;
    }
    await sleep(200);
  }
  check('桌面下载生成 ZIP', Boolean(desktopZip && fs.statSync(desktopZip).size > 0), String(desktopZip));
  await page.screenshot({ path: path.join(SHOTS, 'topic-export-e2e-downloaded-desktop.png') });

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/topics/${seed.topicAId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="topic-export-open"]', { timeout: 20000 });
  await page.click('[data-testid="topic-export-open"]');
  await page.waitForSelector('[data-testid="topic-export-panel"]', { timeout: 20000 });
  await sleep(700);
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
  check('手机预览无横向溢出', mobileOverflow);
  const confirmVisible = await page.$eval('[data-testid="topic-export-confirm"]', (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height >= 44;
  });
  check('手机下载按钮可见且触控高度足够', confirmVisible);
  await page.screenshot({ path: path.join(SHOTS, 'topic-export-e2e-preview-mobile.png') });
  await page.click('[data-testid="topic-export-confirm"]');
  let mobileZipCount = 0;
  for (let index = 0; index < 100; index += 1) {
    mobileZipCount = fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith('.zip')).length;
    if (mobileZipCount >= 2) break;
    await sleep(200);
  }
  check('手机也能完成下载', mobileZipCount >= 2, String(mobileZipCount));

  check('导出流程无未捕获页面错误', pageErrors.length === 0, pageErrors.join(' | '));
  check('导出流程未发起外部网络请求', externalRequests.length === 0, externalRequests.slice(0, 3).join(' | '));

  console.log(`\n主题导出浏览器 E2E: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('failures:', failures);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('E2E 异常:', error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  stopServer(server);
}
