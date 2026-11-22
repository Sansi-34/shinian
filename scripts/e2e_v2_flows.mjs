// 拾念 SHINIAN · 全链路端到端浏览器回归验收（隔离 SQLite 库 + 模拟 OpenAI 兼容流式/非流式模型服务）
// 覆盖五条用户核心路径 + 桌面 1280×900 & 手机 390×844 双视口：
//   ① 无 AI 拍猫全流程：直记念头 → 尝试 → 填结果 → 整理成经验 → 搜「快门」→ 引用经验再试 → 修订经验后核对采用版本
//   ② AI 辅助记录：流式草案（含恶意 state:done 陷阱被服务端/前端拦截为 todo）→ 修改草案正文与步骤后保存 → 取消/流式中断/重试无丢输入、无重复记录
//   ③ 问我的记录与主题内问答：主题进 /ask?topic=… → 勾选子集 → 预览后修改来源触发 409 context_changed → 重新预览发送 → 核对引用未越界 → 点回原文再返回主题
//   ④ 图谱聚焦（含超全局 240 节点默认上限目标）：从问答（/graph?node=…）与经验（/graph?focus=…）跳入图谱 → 目标可见且选中 → 打开同一条原文 → 返回原阅读位置
//   ⑤ 阶段回顾与日程（只创建行动 vs 同时加入日程）+ 外部研究发起入口 + 主题导出 Markdown 预览 + 390px 手机视口防遮挡核验
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = process.cwd();
const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_PORT = Number(process.env.SHINIAN_E2E_V2_PORT || '3588');
const MOCK_PORT = Number(process.env.SHINIAN_E2E_MOCK_PORT || '3589');
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DB_PATH = path.join(ROOT, 'db', 'e2e-v2-flows.sqlite');
const KEY_PATH = path.join(ROOT, 'db', 'e2e-v2-flows.key');

let passed = 0;
let failed = 0;
const failures = [];
const pageErrors = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1) 内置隔离模拟模型服务（支持 SSE 流式、慢速取消、流式中断、Ask/Review 合法引用 JSON）
// ---------------------------------------------------------------------------
let mockAssistMode = 'normal'; // 'normal' | 'slow' | 'drop'
const mockRequests = [];

function extractIds(text, re) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(re)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function startMockModelServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-shinian-model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      mockRequests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sysText = messages.map((m) => (m.role === 'system' ? String(m.content || '') : '')).join('\n');
      const userText = messages.map((m) => (m.role === 'user' ? String(m.content || '') : '')).join('\n');
      const isStream = Boolean(body.stream);

      // 流式：首页「问 AI · 辅助记录」
      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const sendChunk = (deltaText, finish = null) => {
          const payload = {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: deltaText ? { content: deltaText } : {},
                finish_reason: finish,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        if (mockAssistMode === 'drop') {
          sendChunk('已收到你的想法，先分析一半…');
          setTimeout(() => {
            // 模拟网络流式中断：直接粗暴断开连接，不发 [DONE]
            res.destroy();
          }, 120);
          return;
        }

        if (mockAssistMode === 'slow') {
          sendChunk('正在慢慢思考第一段分析…');
          const t1 = setTimeout(() => {
            if (!res.writableEnded) sendChunk('第二段补充中…');
          }, 1800);
          const t2 = setTimeout(() => {
            if (!res.writableEnded) {
              sendChunk('第三段结束。', 'stop');
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 6000);
          req.on('close', () => {
            clearTimeout(t1);
            clearTimeout(t2);
          });
          return;
        }

        // normal：故意在 <shinian_draft> 中塞入一个带 state:"done" 和 resultText 的陷阱，检验服务端与前端双重守门
        const draftJson = JSON.stringify({
          autoOpen: true,
          captureText: '模型整理的初始念头：室内弱光拍猫快门与补光对比',
          attempts: [
            {
              step: '模型建议步骤：把台灯挪近 50cm，快门保持 1/250 再拍五张',
              state: 'done',
              resultText: '模型擅自编造的实测结果（严禁入库！）',
              outcome: 'success',
            },
          ],
        });
        const chunks = [
          '可以试试拉近光源距离并提高 ISO 上限，',
          '同时保持 1/250 快门控制动态模糊。\n',
          `<shinian_draft>\n${draftJson}\n</shinian_draft>`,
        ];
        let idx = 0;
        const timer = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(timer);
            return;
          }
          if (idx < chunks.length) {
            sendChunk(chunks[idx]);
            idx += 1;
          } else {
            clearInterval(timer);
            sendChunk('', 'stop');
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 40);
        return;
      }

      // 非流式：连接测试 / 问我的记录 / 阶段回顾
      let content = 'OK';
      if (sysText.includes('阶段回顾') || userText.includes('回顾范围') || sysText.includes('insufficientData')) {
        const keys = extractIds(userText, /\[(attempt:[A-Za-z0-9_-]+|capture:[A-Za-z0-9_-]+)\]/g);
        const attKeys = keys.filter((k) => k.startsWith('attempt:'));
        const primary = attKeys[0] || keys[0] || '';
        content = JSON.stringify({
          overview: '这段时间你围绕室内拍猫清晰度做了实际快门对比测试。',
          attempts: primary
            ? [{ text: '你实际完成了快门对比测试并记下真实观察。', basis: 'observation', sourceIds: [primary] }]
            : [],
          observations: primary
            ? [{ text: '记录显示快门提到 1/250 后猫走动清晰了，但画面变暗。', basis: 'observation', sourceIds: [primary] }]
            : [],
          connections: [],
          experiences: primary
            ? [
                {
                  text: '建议在补光或靠窗自然光条件下复测 1/250 快门以改善亮度。',
                  basis: 'inference',
                  sourceIds: [primary],
                },
              ]
            : [],
          uncertainties: ['目前样本集中在单一灯光环境，尚需自然光对照。'],
          insufficientData: false,
          dataNotes: null,
        });
      } else if (sysText.includes('insufficientEvidence') || userText.includes('用户问题')) {
        const keys = extractIds(userText, /\[(attempt:[A-Za-z0-9_-]+|capture:[A-Za-z0-9_-]+)\]/g);
        const primary = keys[0];
        content = JSON.stringify({
          summary: '根据你勾选的记录，提高快门速度可以减少拍猫模糊，但会导致画面偏暗。',
          points: primary
            ? [
                {
                  text: '在室内台灯下将快门调到 1/250，猫走动时变清楚了，但画面变暗。',
                  basis: 'observation',
                  condition: '同一盏室内灯、各拍五张',
                  sourceIds: [primary],
                },
                {
                  text: '在更明亮的自然光下复用较高快门，可能兼顾清晰度与亮度。',
                  basis: 'inference',
                  condition: '需靠窗自然光验证',
                  sourceIds: [primary],
                },
              ]
            : [],
          contradictions: [],
          missing: ['缺少不同光照条件下的亮度对比。'],
          insufficientEvidence: !primary,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 60, completion_tokens: 80, total_tokens: 140 },
        })
      );
    });
  });

  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function startAppServer() {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm', KEY_PATH]) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: DB_PATH,
      SHINIAN_MASTER_KEY_FILE: KEY_PATH,
      SHINIAN_AI_TIMEOUT_MS: '8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d.toString()));
  child.stderr.on('data', (d) => (logs += d.toString()));

  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/session/check`);
      if (r.status === 200 || r.status === 401) return { child, getLogs: () => logs };
    } catch {
      /* waiting */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('App server failed to start:\n' + logs);
}

async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function clickByText(page, selector, text, timeout = 15000) {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((n) => (n.textContent || '').trim().includes(t)),
    { timeout },
    selector,
    text
  );
  const els = await page.$$(selector);
  for (const el of els) {
    const content = await el.evaluate((n) => (n.textContent || '').trim());
    if (content.includes(text)) {
      await el.click();
      return true;
    }
  }
  return false;
}

async function setReactValue(page, selector, value) {
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
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

async function apiInPage(page, urlPath, options = {}) {
  return page.evaluate(
    async ({ p, opts }) => {
      const r = await fetch('/api' + p, {
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts,
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    },
    { p: urlPath, opts: options }
  );
}

// ---------------------------------------------------------------------------
// 2) 主测试编排
// ---------------------------------------------------------------------------
let mockServer = null;
let appHandle = null;
let browser = null;

try {
  mockServer = await startMockModelServer();
  appHandle = await startAppServer();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.setViewport({ width: 1280, height: 900 });

  // 登录隔离实例
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  if (await page.$('.login-card input')) {
    await setReactValue(page, '.login-card input', '拍猫验收账号');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      page.click('.login-card button[type="submit"]'),
    ]);
  }
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(600);

  // =========================================================================
  // 路径 ①：无 AI 拍猫全流程闭环
  // =========================================================================
  console.log('\n=== ① 无 AI 拍猫全流程 ===');
  const defaultModeText = await page.evaluate(() => document.body.innerText);
  check('①-1 无 AI 时首页自动落到「直记念头」模式', defaultModeText.includes('当前模式：直记念头'));

  const catCaptureText = '为什么我在室内拍猫总是糊？';
  await setReactValue(page, 'textarea[aria-label*="输入框"]', catCaptureText);
  await page.click('button[aria-label*="发送"]');
  await waitText(page, '已将这条念头保存到本地记录库');
  check('①-2 首页直记拍猫念头成功', true);

  // 刷新后打开刚才的念头详情
  await page.reload({ waitUntil: 'networkidle2' });
  await waitText(page, catCaptureText);
  await clickByText(page, 'a.v2-leftItem', catCaptureText);
  await page.waitForFunction(() => location.pathname.startsWith('/capture/'));
  const catCaptureId = await page.evaluate(() => location.pathname.split('/')[2]);
  check('①-3 刷新后能找回并打开拍猫念头详情', Boolean(catCaptureId), catCaptureId);

  // 发起第一次尝试
  await clickByText(page, 'button', '自己写一步');
  const attemptStep1 = '同一盏灯下，快门从 1/60 调到 1/250，各拍五张。';
  await setReactValue(page, 'textarea[aria-label="新尝试步骤"]', attemptStep1);
  await clickByText(page, 'button', '创建尝试');
  await waitText(page, attemptStep1);
  const beforeResultText = await page.evaluate(() => document.body.innerText);
  check('①-4 未填结果时如实显示未开始/待记录而非失败', beforeResultText.includes('未开始') && beforeResultText.includes('结果待记录'));

  // 进入尝试详情填写结果
  await clickByText(page, 'a', attemptStep1);
  await page.waitForFunction(() => location.pathname.startsWith('/attempt/'));
  const attempt1Id = await page.evaluate(() => location.pathname.split('/')[2]);
  await clickByText(page, 'button[role="radio"], button[aria-pressed]', '已完成');
  const result1Text = '猫走动时清楚了，但画面变暗了。';
  await setReactValue(page, 'textarea[aria-label="结果文本"]', result1Text);
  await clickByText(page, 'button', '达成');
  await clickByText(page, 'button', '保存');
  await waitText(page, '已保存');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('textarea[aria-label="结果文本"]');
  const reloadedResultVal = await page.$eval('textarea[aria-label="结果文本"]', (el) => el.value);
  check('①-5 刷新后尝试结果与状态持久化一致', reloadedResultVal === result1Text, reloadedResultVal);

  // 无 AI 直接从尝试详情「整理成经验」
  await page.waitForSelector('[data-testid="attempt-to-experience"]');
  await page.click('[data-testid="attempt-to-experience"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  await setReactValue(page, '[data-testid="experience-title"]', '室内高快门拍猫防糊经验');
  await setReactValue(
    page,
    '[data-testid="experience-understanding"]',
    '提高快门到 1/250 可明显减轻室内拍猫动态模糊，但进光量减少会使画面变暗。'
  );
  await setReactValue(
    page,
    '[data-testid="experience-editor"] textarea[placeholder*="普通工作日"]',
    '室内单一台灯照明，拍走动中的猫'
  );
  await setReactValue(page, '[data-testid="experience-limitations"]', '样本仅五张，未测自然光和高 ISO 噪点');
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '已整理为经验');
  await clickByText(page, 'a', '打开经验详情');
  await page.waitForFunction(() => location.pathname.startsWith('/experience/'));
  const catExpId = await page.evaluate(() => location.pathname.split('/')[2]);
  await waitText(page, '室内单一台灯照明');
  check('①-6 无 AI 从有结果尝试整理成经验并含条件/限制/来源', Boolean(catExpId));

  // 搜索「快门」找回原始结果
  await page.goto(BASE + '/search?q=' + encodeURIComponent('快门'), { waitUntil: 'networkidle2' });
  await waitText(page, '猫走动时清楚了');
  check('①-7 搜「快门」命中原始尝试结果', true);

  // 回到经验详情，点「参考它，试一步」发起第二次尝试
  await page.goto(BASE + '/experience/' + catExpId, { waitUntil: 'networkidle2' });
  await page.click('[data-testid="experience-try"]');
  await page.waitForSelector('[data-testid="experience-create-attempt"]');
  await setReactValue(page, '.experience-try-form input[type="text"]', '靠窗自然光下用 1/250 快门复测拍猫');
  await page.click('[data-testid="experience-create-attempt"]');
  await waitText(page, '已创建这次尝试');
  const expData1 = await apiInPage(page, `/experiences/${catExpId}`);
  const attempt2Id = expData1.data.experience?.attempts?.[0]?.id;
  check('①-8 从经验发起第二次尝试成功', Boolean(attempt2Id), String(attempt2Id));

  // 修订经验为第 2 版
  await page.click('[data-testid="experience-edit"]');
  await page.waitForSelector('[data-testid="experience-editor"]');
  await setReactValue(
    page,
    '[data-testid="experience-understanding"]',
    '第2版修订：提高快门到 1/250 可防动态模糊，室内弱光需配合靠窗自然光或补光。'
  );
  await page.click('[data-testid="experience-save"]');
  await waitText(page, '第 2 版');

  // 打开第二次尝试详情：核对清楚看出采用的是第 1 版（且提示已修订至第 2 版）
  await page.goto(BASE + '/attempt/' + attempt2Id, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="attempt-experience-version"]');
  const versionBanner = await page.$eval('[data-testid="attempt-experience-version"]', (el) => el.textContent || '');
  check(
    '①-9 修订经验后，第二次尝试仍清楚展示采用时为第 1 版且现已修订至第 2 版',
    versionBanner.includes('第 1 版') && versionBanner.includes('第 2 版'),
    versionBanner
  );

  // =========================================================================
  // 配置本地模拟模型服务，用于路径 ② ③ ④ ⑤
  // =========================================================================
  const saveAiRes = await apiInPage(page, '/settings/ai', {
    method: 'PUT',
    body: JSON.stringify({
      name: '本地模拟模型',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      modelId: 'mock-shinian-model',
      apiKey: 'mock-test-key-123456',
      enabled: true,
      allowLocal: true,
    }),
  });
  check('前置：配置本地隔离模拟模型成功', saveAiRes.status === 200, JSON.stringify(saveAiRes));

  // =========================================================================
  // 路径 ②：AI 辅助记录（草案编辑保存 + 恶意 state:done 拦截 + 取消 + 流式中断 + 重试）
  // =========================================================================
  console.log('\n=== ② AI 辅助记录与流式健壮性 ===');
  mockAssistMode = 'normal';
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await sleep(500);
  await setReactValue(page, 'textarea[aria-label*="输入框"]', '帮我想想室内弱光拍猫怎么既不糊又不暗？');
  await page.click('button[aria-label*="发送"]');
  await page.waitForSelector('textarea[aria-label="草案念头正文"]', { timeout: 15000 });

  // 确认草案中不包含模型编造的结果，且步骤可编辑
  const draftStepVal = await page.$eval('input[aria-label="编辑第 1 条建议尝试"]', (el) => el.value);
  const pageTextDraft = await page.evaluate(() => document.body.innerText);
  check(
    '②-1 模型建议的恶意 state:done / resultText 已被拦截，不显示成用户观察结果',
    !pageTextDraft.includes('模型擅自编造的实测结果') && pageTextDraft.includes('待尝试'),
    draftStepVal
  );

  // 修改念头正文和尝试步骤其中一句再保存
  const editedCapture = '用户手动改过的念头：室内弱光拍猫补光与快门方案';
  const editedStep = '用户手动改过的步骤：把补光灯调到 50% 亮度再拍五张';
  await setReactValue(page, 'textarea[aria-label="草案念头正文"]', editedCapture);
  await setReactValue(page, 'input[aria-label="编辑第 1 条建议尝试"]', editedStep);
  await clickByText(page, 'button', '一键保存到记录库');
  await waitText(page, '打开念头详情');

  const capsAfterDraft = await apiInPage(page, '/captures?archived=0');
  const savedCap = (capsAfterDraft.data.captures || []).find((c) => c.rawText === editedCapture);
  let savedAtt = null;
  if (savedCap) {
    const attsRes = await apiInPage(page, `/captures/${savedCap.id}/attempts`);
    savedAtt = (attsRes.data.attempts || [])[0] || null;
  }
  check(
    '②-2 草案修改后入库为修改后的文字，且尝试 state=todo、resultText=null',
    Boolean(savedCap && savedAtt && savedAtt.step === editedStep && savedAtt.state === 'todo' && savedAtt.resultText === null),
    JSON.stringify({ savedCap: savedCap?.rawText, savedAtt })
  );

  // 测试流式取消（停止生成）
  mockAssistMode = 'slow';
  const cancelPrompt = '流式取消测试：拍猫补光色温怎么选？';
  await setReactValue(page, 'textarea[aria-label*="输入框"]', cancelPrompt);
  await page.click('button[aria-label*="发送"]');
  await waitText(page, '正在慢慢思考第一段分析');
  await clickByText(page, 'button', '停止生成');
  await waitText(page, '已取消生成');
  check('②-3 流式生成中途取消保留已输出内容与提示，不丢输入', true);

  // 测试流式中断（连接中途断开）与重试
  mockAssistMode = 'drop';
  const dropPrompt = '流式中断测试：弱光拍猫白平衡偏移怎么办？';
  await setReactValue(page, 'textarea[aria-label*="输入框"]', dropPrompt);
  await page.click('button[aria-label*="发送"]');
  await waitText(page, '流式回复在完成前中断');
  check('②-4 流式中断后保留上下文并给出明确中断提示', true);

  // 切回正常模式点击「重答」重试
  mockAssistMode = 'normal';
  const capsCountBeforeRetry = (await apiInPage(page, '/captures?archived=0')).data.captures.length;
  const retryBtns = await page.$$('button');
  for (let i = retryBtns.length - 1; i >= 0; i -= 1) {
    const txt = await retryBtns[i].evaluate((n) => (n.textContent || '').trim());
    if (txt === '重答' || txt === '重试') {
      await retryBtns[i].click();
      break;
    }
  }
  await waitText(page, '可以试试拉近光源距离并提高 ISO 上限');
  const capsCountAfterRetry = (await apiInPage(page, '/captures?archived=0')).data.captures.length;
  check('②-5 流式中断后重试成功，且未产生多余重复入库记录', capsCountAfterRetry === capsCountBeforeRetry);

  // =========================================================================
  // 路径 ③：问自己的记录（从主题发起 + 只勾选子集 + 409 context_changed + 点回原文再返回主题）
  // =========================================================================
  console.log('\n=== ③ 主题内问答、引用边界与预览后来源变更 ===');
  const topicRes = await apiInPage(page, '/topics', {
    method: 'POST',
    body: JSON.stringify({
      name: '室内拍猫清晰度专题',
      exploringQuestion: '室内拍猫快门和灯光怎么配？',
      operationId: 'e2e-topic-1',
    }),
  });
  const topicId = topicRes.data.topic?.id;
  await apiInPage(page, `/topics/${topicId}/members`, {
    method: 'POST',
    body: JSON.stringify({ captureIds: [catCaptureId, catExpId], operationId: 'e2e-tm-1' }),
  });
  // 同时创建一个不在该主题内、但包含「快门」字样的外部干扰念头，用于核实主题范围隔离
  await apiInPage(page, '/captures', {
    method: 'POST',
    body: JSON.stringify({ rawText: '主题外干扰记录：快门线蓝牙配对失败' }),
  });

  // 从主题详情点「就这个主题提问 →」
  await page.goto(BASE + '/topics/' + topicId, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="topic-ask-link"]');
  await page.click('[data-testid="topic-ask-link"]');
  await page.waitForSelector('[data-testid="ask-topic-banner"]');
  check('③-1 从主题详情进入主题内问答并展示主题范围横幅', page.url().includes(`topic=${topicId}`), page.url());

  // 检索主题内候选，验证主题外干扰念头未混入
  await setReactValue(page, 'input[aria-label="关键词"]', '快门');
  await clickByText(page, 'button', '找相关记录');
  await waitText(page, '选作依据的记录');
  const askCandText = await page.evaluate(() => document.body.innerText);
  check(
    '③-2 主题内检索仅命中主题成员，不包含主题外干扰记录',
    askCandText.includes('快门') && !askCandText.includes('主题外干扰记录')
  );

  // 只勾选第一条（带结果的拍猫尝试 attempt1），取消其余勾选，然后预览
  const pickCheckboxes = await page.$$('label.v2-askPick input[type="checkbox"]');
  for (let i = 0; i < pickCheckboxes.length; i += 1) {
    const labelText = await pickCheckboxes[i].evaluate((el) => el.closest('label')?.textContent || '');
    const checked = await pickCheckboxes[i].evaluate((el) => el.checked);
    const shouldPick = labelText.includes('1/250') && labelText.includes('已有结果');
    if (checked !== shouldPick) await pickCheckboxes[i].click();
  }
  await clickByText(page, 'button', '预览并发送');
  await waitText(page, '发送前确认');

  // 模拟预览后，选中的拍猫尝试结果发生了编辑变化！
  const att1Latest = (await apiInPage(page, `/attempts/${attempt1Id}`)).data.attempt;
  await apiInPage(page, `/attempts/${attempt1Id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      state: 'done',
      resultText: '猫走动时清楚了，但画面变暗了。（预览后补充：ISO 自动拉到了 3200）',
      outcome: 'success',
      revision: att1Latest.revision,
    }),
  });

  // 此时点击发送，应命中服务端 409 context_changed，并出现重新预览按钮
  await clickByText(page, 'button', '发送给模型');
  await page.waitForSelector('[data-testid="ask-context-changed"]', { timeout: 10000 });
  check('③-3 预览后来源变化触发 409 context_changed 并保留勾选引导重新预览', true);

  // 点「重新预览最新依据」后再次发送
  await clickByText(page, '[data-testid="ask-context-changed"] button', '重新预览最新依据');
  await waitText(page, '发送前确认');
  await clickByText(page, 'button', '发送给模型');
  await page.waitForSelector('[data-testid="ask-point-source-link"]', { timeout: 15000 });

  const askResultText = await page.evaluate(() => document.body.innerText);
  check(
    '③-4 回答区分观察/推断且依据记录仅包含本次勾选的 1 条来源',
    askResultText.includes('记录中的观察') &&
      askResultText.includes('模型推断') &&
      (await page.$$('[data-testid="ask-source-item"]')).length === 1
  );

  // 保存问答详情 ID 以便稍后跳图谱测试
  const askListRes = await apiInPage(page, '/ask/queries?limit=5');
  const latestAskId = askListRes.data.queries?.[0]?.id;

  // 点观点里的来源 chip 跳回原文，再点「← 返回主题」回到原主题
  await page.click('[data-testid="ask-point-source-link"]');
  await page.waitForFunction(() => location.pathname.startsWith('/attempt/'));
  await page.waitForFunction(
    () => (document.querySelector('textarea[aria-label="结果文本"]')?.value || '').includes('ISO 自动拉到了 3200'),
    { timeout: 15000 }
  );
  await clickByText(page, 'a.v2-returnLink', '返回主题');
  await page.waitForFunction((tid) => location.pathname === `/topics/${tid}`, {}, topicId);
  check('③-5 问答回答点回原文并一键返回原主题，未丢失阅读上下文', true);

  // =========================================================================
  // 路径 ④：图谱聚焦（/graph?node=… & /graph?focus=… + 超出全局默认 240 节点范围！）
  // =========================================================================
  console.log('\n=== ④ 图谱聚焦（含超出 240 默认全局范围目标） ===');
  // 批量写入 255 条更新的干扰念头，把最初的拍猫念头/尝试/经验挤出全局图默认 240 节点上限
  await page.evaluate(async () => {
    const batch = [];
    for (let i = 0; i < 255; i += 1) {
      batch.push(
        fetch('/api/captures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawText: `全局图截断占位念头 #${i}` }),
        })
      );
      if (batch.length >= 25) {
        await Promise.all(batch.splice(0, batch.length));
      }
    }
    if (batch.length) await Promise.all(batch);
  });

  const globalGraph = await apiInPage(page, '/graph');
  const inGlobal = (globalGraph.data.nodes || []).some((n) => n.id === `attempt:${attempt1Id}`);
  check(
    '④-1 构造超限数据：全局图已截断且默认不再包含早期拍猫尝试节点',
    Boolean(globalGraph.data.meta?.truncated) && !inGlobal,
    `truncated=${globalGraph.data.meta?.truncated}, inGlobal=${inGlobal}`
  );

  // 4A) 从问答详情页点击「在图谱中查看」（/graph?node=attempt:...）
  await page.goto(BASE + '/ask/' + latestAskId, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="ask-open-graph"]');
  const askGraphHref = await page.$eval('[data-testid="ask-open-graph"]', (el) => el.getAttribute('href') || '');
  await page.click('[data-testid="ask-open-graph"]');
  await page.waitForSelector('[data-testid="graph-focus-bar"]', { timeout: 15000 });
  await page.waitForFunction(
    (targetId) => {
      const cy = window.__cy;
      if (!cy) return false;
      const el = cy.getElementById(targetId);
      return el.length === 1 && el.selected();
    },
    { timeout: 15000 },
    `attempt:${attempt1Id}`
  );
  const rightOpenBtn1 = await page.$('[data-testid="graph-open-record"]');
  check(
    '④-2 从问答（/graph?node=…）进入图谱：超范围目标节点可见、已选中且可打开原文',
    askGraphHref.includes('node=') && Boolean(rightOpenBtn1),
    askGraphHref
  );
  await page.click('[data-testid="graph-open-record"]');
  await page.waitForFunction((aid) => location.pathname === `/attempt/${aid}`, {}, attempt1Id);
  check('④-3 图谱右栏打开的目标记录精确指向同一条原文尝试', true);

  // 4B) 从经验详情页点击依据的「在局部图中查看」（/graph?focus=attempt:...）
  await page.goto(BASE + '/experience/' + catExpId, { waitUntil: 'networkidle2' });
  await waitText(page, '在局部图中查看');
  const expFocusHref = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => (x.textContent || '').includes('在局部图中查看'));
    return a?.getAttribute('href') || '';
  });
  await clickByText(page, 'a', '在局部图中查看');
  await page.waitForSelector('[data-testid="graph-focus-bar"]', { timeout: 15000 });
  await page.waitForFunction(
    (targetId) => {
      const cy = window.__cy;
      if (!cy) return false;
      const el = cy.getElementById(targetId);
      return el.length === 1 && el.selected();
    },
    { timeout: 15000 },
    `attempt:${attempt1Id}`
  );
  check('④-4 从经验来源（/graph?focus=…）进入图谱：超范围目标节点可见且已被选中', expFocusHref.includes('focus='), expFocusHref);
  // 点击「返回刚才阅读的位置」回到原经验详情页
  await page.click('[data-testid="graph-return-link"]');
  await page.waitForFunction((eid) => location.pathname === `/experience/${eid}`, {}, catExpId);
  check('④-5 从图谱点击返回链接回到原经验阅读位置', true);

  // =========================================================================
  // 路径 ⑤：阶段回顾（只创建行动 vs 同时加入日程）+ 外部研究入口 + 主题导出 + 390px 手机端验证
  // =========================================================================
  console.log('\n=== ⑤ 阶段回顾与日程、外部研究、主题导出与 390px 手机视口 ===');
  await page.goto(BASE + '/review', { waitUntil: 'networkidle2' });
  await waitText(page, '念头日程表');
  check('⑤-1 周期回顾页近 12 个月念头日程表热力图正常渲染', true);

  // 通过 API 生成并保存一次回顾（底层用我们的模拟模型），然后在真实 UI 回顾详情页走两种创建下一步
  const nowMs = Date.now();
  const fromMs = nowMs - 7 * 86400_000;
  const toMs = nowMs + 86400_000;
  const revRangeRes = await apiInPage(
    page,
    `/review/range?from=${fromMs}&to=${toMs}&timezone=Asia%2FShanghai&preset=7d`
  );
  // 优先包含拍猫念头和尝试，确保生成的回顾经验基于拍猫记录
  const allRevKeys = (revRangeRes.data.records || []).map((r) => r.key);
  const catPreferredKeys = allRevKeys.filter(
    (k) => k === `capture:${catCaptureId}` || k === `attempt:${attempt1Id}` || k.startsWith('attempt:')
  );
  const pickedRevKeys = [...new Set([...catPreferredKeys, ...allRevKeys])].slice(0, 10);
  const revPreviewRes = await apiInPage(page, '/review/preview', {
    method: 'POST',
    body: JSON.stringify({
      from: fromMs,
      to: toMs,
      preset: '7d',
      timezone: 'Asia/Shanghai',
      includeKeys: pickedRevKeys,
    }),
  });
  const revCreateRes = await apiInPage(page, '/reviews', {
    method: 'POST',
    body: JSON.stringify({
      from: fromMs,
      to: toMs,
      preset: '7d',
      timezone: 'Asia/Shanghai',
      includeKeys: pickedRevKeys,
      contextToken: revPreviewRes.data.contextToken,
      operationId: 'e2e-rev-gen-1',
    }),
  });
  const reviewId = revCreateRes.data.review?.id;
  for (let i = 0; i < 30; i += 1) {
    const st = await apiInPage(page, `/reviews/${reviewId}`);
    if (st.data.review?.status && st.data.review.status !== 'pending') break;
    await sleep(300);
  }
  await apiInPage(page, `/reviews/${reviewId}/save`, {
    method: 'POST',
    body: JSON.stringify({ operationId: 'e2e-rev-save-1' }),
  });

  // 打开回顾详情页，先走「只创建行动」
  await page.goto(BASE + '/review/' + reviewId, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="next-action-start"]', { timeout: 15000 });
  await page.click('[data-testid="next-action-start"]');
  await page.waitForSelector('[data-testid="next-action-editor"]');
  // 取消勾选「加入日程」
  const schedCheck = await page.$('[data-testid="next-action-schedule-toggle"]');
  if (schedCheck && (await schedCheck.evaluate((el) => el.checked))) {
    await schedCheck.click();
  }
  await setReactValue(page, '[data-testid="next-action-title"]', '仅行动测试：自然光下再拍五张猫');
  await page.click('[data-testid="next-action-save"]');
  await page.waitForSelector('[data-testid="next-action-attempt"]');
  const actionOnlyId = await page.$eval(
    '[data-testid="next-action-attempt"]',
    (el) => (el.getAttribute('href') || '').split('/')[2] || ''
  );
  const actionOnlySch = await apiInPage(page, `/attempts/${actionOnlyId}/schedules`);
  check(
    '⑤-2 阶段回顾「只创建行动」成功且不创建日程',
    Boolean(actionOnlyId) && (actionOnlySch.data.schedules || []).length === 0
  );

  // 关闭弹窗，再走「同时加入日程」
  await clickByText(page, '[data-testid="next-action-editor"] button', '返回回顾');
  await sleep(200);
  await page.click('[data-testid="next-action-start"]');
  await page.waitForSelector('[data-testid="next-action-editor"]');
  const schedCheck2 = await page.$('[data-testid="next-action-schedule-toggle"]');
  if (schedCheck2 && !(await schedCheck2.evaluate((el) => el.checked))) {
    await schedCheck2.click();
  }
  // 选择属于专题的拍猫念头（如果下拉框里有的话），以便后续核对主题详情联动
  await page.evaluate((cid) => {
    const sel = document.querySelector('[data-testid="next-action-capture"]');
    if (sel && [...sel.options].some((o) => o.value === cid)) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, cid);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, catCaptureId);
  await setReactValue(page, '[data-testid="next-action-title"]', '带日程行动：下午靠窗拍猫对比');
  await page.click('[data-testid="next-action-save"]');
  await page.waitForSelector('[data-testid="next-action-attempt"]');
  const actionSchedId = await page.$eval(
    '[data-testid="next-action-attempt"]',
    (el) => (el.getAttribute('href') || '').split('/')[2] || ''
  );

  // 去日程页确认出现该日程，点击进入同一条尝试详情并填结果
  await page.goto(BASE + '/schedule', { waitUntil: 'networkidle2' });
  await waitText(page, '带日程行动：下午靠窗拍猫对比');
  await clickByText(page, 'a', '带日程行动：下午靠窗拍猫对比');
  await page.waitForFunction((aid) => location.pathname === `/attempt/${aid}`, {}, actionSchedId);
  await clickByText(page, 'button[role="radio"], button[aria-pressed]', '已完成');
  const schedResult = '靠窗自然光 1/250 快门清晰且亮度正常。';
  await setReactValue(page, 'textarea[aria-label="结果文本"]', schedResult);
  await clickByText(page, 'button', '达成');
  await clickByText(page, 'button', '保存');
  // 因为该尝试挂着未来日程，服务端要求明确决定保留或取消未来安排
  const futureDialog = await page
    .waitForSelector('[data-testid="attempt-future-schedules"]', { timeout: 5000 })
    .catch(() => null);
  if (futureDialog) {
    await clickByText(page, '[data-testid="attempt-future-schedules"] button', '保留安排并保存');
  }
  await waitText(page, '已保存');
  // 核对主题页、日程页、尝试详情指向同一条记录且结果已同步
  await page.goto(BASE + '/topics/' + topicId, { waitUntil: 'networkidle2' });
  const topicTextAfter = await page.evaluate(() => document.body.innerText);
  check(
    '⑤-3 「同时加入日程」经日程进入同一尝试填结果后，主题/日程/尝试详情一致联动',
    topicTextAfter.includes(schedResult),
    actionSchedId
  );

  // 主题导出 Markdown 预览入口检查
  await page.click('[data-testid="topic-export-open"]');
  await page.waitForSelector('[data-testid="topic-export-summary"]', { timeout: 10000 });
  check('⑤-4 主题详情可打开「导出 Markdown（ZIP）」并正常加载范围预览', true);

  // 外部研究发起入口检查（/research 与 /capture/:id）
  await page.goto(BASE + '/research', { waitUntil: 'networkidle2' });
  await page.click('[data-testid="research-empty-start"]');
  await waitText(page, '选择一条念头发起 GitHub 研究');
  await clickByText(page, 'button', '选这条');
  await waitText(page, '研究问题');
  check('⑤-5 /research 与念头页均可正常唤起 GitHub 外部研究范围确认面板', true);

  // ⑤-5b 回归：研究详情页在后端长时间 status/updatedAt 不变时，前端必须持续轮询直至完成（防止 1 次后卡死）
  let pollHits = 0;
  await page.setRequestInterception(true);
  const pollHandler = (req) => {
    if (req.url().endsWith('/api/research/mock-poll-stuck') && req.method() === 'GET') {
      pollHits += 1;
      const finished = pollHits >= 4;
      const body = {
        research: {
          id: 'mock-poll-stuck',
          captureId: catCaptureId,
          captureRevision: 1,
          question: '轮询稳定性验证问题',
          constraints: { goal: null, environment: null, language: null, timeBudget: null, requirements: null },
          search: { mode: 'keyword', query: 'mock', repos: [], display: 'mock' },
          status: finished ? 'succeeded' : 'fetching',
          revision: finished ? 3 : 2,
          createdAt: 1700000000000,
          updatedAt: finished ? 1700000005000 : 1700000000000,
          savedAt: null,
          saved: false,
          canSave: finished,
          canRetrySearch: false,
          canRetryFetch: false,
          canRetryGenerate: false,
          errorCode: null,
          errorDetail: null,
          candidates: [],
          candidatesTotal: 1,
          candidatesRate: null,
          candidateFailures: [],
          selectedCandidateIds: ['owner/demo'],
          sources: [],
          result: finished
            ? {
                summary: '轮询持续成功，已拿到最终对比结论。',
                projects: [],
                experiments: [],
                limitations: [],
                insufficient: false,
              }
            : null,
          attempts: [],
          config: { id: 'default', name: '本地模拟模型', modelId: 'mock-cat-model', configVersion: 1 },
          usage: null,
          stats: null,
          limits: { maxCandidates: 10, maxSelected: 3, maxReadmeChars: 8000, concurrency: 2 },
        },
        ai: { enabled: true },
        github: { hasToken: false },
      };
      req.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
      return;
    }
    req.continue();
  };
  page.on('request', pollHandler);
  await page.goto(BASE + '/research/mock-poll-stuck', { waitUntil: 'domcontentloaded' });
  await waitText(page, '轮询持续成功，已拿到最终对比结论。', 15000);
  page.off('request', pollHandler);
  await page.setRequestInterception(false);
  check(
    '⑤-5b 研究详情页在 status/updatedAt 连续多轮不变后仍持续轮询直至完成',
    pollHits >= 4,
    `pollHits=${pollHits}`
  );

  // 390×844 手机视口核验：尝试详情保存按钮 & 整理成经验弹窗保存按钮均不被遮挡、无横向溢出
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE + '/attempt/' + attempt1Id, { waitUntil: 'networkidle2' });
  await sleep(400);
  const mobileGeo = await page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth > window.innerWidth + 2;
    const saveBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
    saveBtn?.scrollIntoView({ block: 'center' });
    const r = saveBtn?.getBoundingClientRect();
    const tabbar = document.querySelector('aside[aria-label="主导航"]')?.getBoundingClientRect();
    return {
      docOverflow,
      saveVisible: Boolean(r && r.bottom <= (tabbar?.top ?? window.innerHeight) + 2 && r.top >= 0),
      r,
      tabTop: tabbar?.top,
    };
  });
  check('⑤-6 390px 手机视口下尝试详情无横向溢出且保存按钮不被底栏遮挡', !mobileGeo.docOverflow && mobileGeo.saveVisible, JSON.stringify(mobileGeo));

  await page.click('[data-testid="attempt-to-experience"]');
  await page.waitForSelector('[data-testid="experience-save"]');
  const mobileModalGeo = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="experience-save"]');
    const r = btn?.getBoundingClientRect();
    return { inViewport: Boolean(r && r.bottom <= window.innerHeight && r.top >= 0), r, vh: window.innerHeight };
  });
  check('⑤-7 390px 手机视口下「整理成经验」弹窗底部保存按钮粘性可达、不跑出屏幕', mobileModalGeo.inViewport, JSON.stringify(mobileModalGeo));

  check('全程无未捕获前端运行时异常 (pageerror)', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  failed += 1;
  failures.push('未捕获异常: ' + (err?.stack || String(err)));
  console.error('FATAL:', err);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (appHandle?.child) appHandle.child.kill();
  if (mockServer) mockServer.close();
  // 等待短暂释放文件锁后清理隔离临时测试库
  await sleep(300);
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm', KEY_PATH]) {
    try {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(`\n============================================================`);
console.log(`V2 全链路回归验收: ${passed} passed, ${failed} failed`);
console.log(`============================================================`);
if (failures.length > 0) {
  console.log('失败明细:');
  for (const f of failures) console.log(' -', f);
}
process.exit(failed === 0 ? 0 : 1);
