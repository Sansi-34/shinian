// 空态取证（第二轮）：三页空态是否居中，以及「有数据时空态块不出现」
// 经验页当前库里有 4 条数据，所以用请求拦截把 /api/experiences 打成空数组来检查空态；
// 日程 / 研究本来是空的，反过来用假数据检查「有数据时不出现空态块」。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5181';
const OUT = 'D:/联动日程表/audit/shots/after-empty';
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const p = (s) => {
  log.push(s);
  console.log(s);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.setRequestInterception(true);
// mode: 'real' | 'empty-experiences' | 'fake-schedule' | 'fake-research'
let mode = 'real';
page.on('request', (req) => {
  const url = req.url();
  const json = (obj) => req.respond({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) });
  if (req.method() === 'GET' && /\/api\/experiences(\?|$)/.test(url) && mode === 'empty-experiences') {
    return json({ experiences: [] });
  }
  if (req.method() === 'GET' && /\/api\/schedules(\?|$)/.test(url) && mode === 'fake-schedule') {
    const day = new Date();
    day.setDate(day.getDate() + 1);
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0).toISOString();
    return json({
      schedules: [
        { id: 'fake-1', startsAt: at, endsAt: null, status: 'active', note: '假数据行（自测用）', attemptId: null, attempt: null, capture: null },
      ],
    });
  }
  if (req.method() === 'GET' && /\/api\/research(\?|$)/.test(url) && mode === 'fake-research') {
    return json({
      research: [
        {
          id: 'fake-1',
          question: '假数据行：某个问题（自测用）',
          status: 'succeeded',
          createdAt: new Date().toISOString(),
          summary: '这是自测用的假摘要，只用来确认有数据时空态块不会出现。',
          errorCode: null,
        },
      ],
    });
  }
  return req.continue();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await sleep(700);
}

// ---------- 登录 ----------
await page.setViewport({ width: 1280, height: 900 });
await go('/');
if (await page.$('.login-card')) {
  await page.click('.login-card input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('.login-card input', '阿念');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('开启拾念之旅'));
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 20000 });
  p('已登录');
} else {
  p('已处于登录态');
}

async function probe(tag) {
  const info = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const center = document.querySelector('main');
    const empty = document.querySelector('.v2-empty');
    const mark = document.querySelector('.v2-empty-mark');
    const title = document.querySelector('.v2-empty-title');
    const text = document.querySelector('.v2-empty-text');
    const cta = document.querySelector('.v2-empty-cta');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const emptyR = rect(empty);
    const rows = document.querySelectorAll('a[class*="row"], [class*="Row"][href]');
    return {
      url: location.pathname,
      viewport: { w: innerWidth, h: innerHeight },
      centerRect: rect(center),
      hasEmpty: !!empty,
      emptyRect: emptyR,
      emptyCenterOffset: emptyR ? Math.round(emptyR.top + emptyR.h / 2 - innerHeight / 2) : null,
      markBorder: mark ? cs(mark).borderTopStyle + ' ' + cs(mark).borderTopColor : null,
      title: title ? { text: title.innerText.trim(), fontSize: cs(title).fontSize, color: cs(title).color } : null,
      text: text ? { text: text.innerText.trim(), fontSize: cs(text).fontSize, color: cs(text).color } : null,
      cta: cta ? { text: cta.innerText.replace(/\s+/g, ' ').trim(), href: cta.getAttribute('href'), color: cs(cta).color, bg: cs(cta).backgroundColor, radius: cs(cta).borderRadius } : null,
      linkCount: document.querySelectorAll('a').length,
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
      docHeight: document.documentElement.scrollHeight,
    };
  });
  p(`\n===== ${tag} =====`);
  p(JSON.stringify(info, null, 2));
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  return info;
}

const results = {};

// ---------- 桌面 1280×900：真实数据态 ----------
await page.setViewport({ width: 1280, height: 900 });
mode = 'real';
await go('/experiences');
results['real-experiences-1280x900'] = await probe('real-experiences-1280x900');
await go('/schedule');
results['real-schedule-1280x900'] = await probe('empty-schedule-1280x900');
await go('/research');
results['real-research-1280x900'] = await probe('empty-research-1280x900');

// ---------- 桌面：经验页空态（接口打空）----------
mode = 'empty-experiences';
await go('/experiences');
results['empty-experiences-1280x900'] = await probe('empty-experiences-1280x900');

// ---------- 桌面：日程 / 研究「有数据」态 ----------
mode = 'fake-schedule';
await go('/schedule');
results['data-schedule-1280x900'] = await probe('data-schedule-1280x900');
mode = 'fake-research';
await go('/research');
results['data-research-1280x900'] = await probe('data-research-1280x900');

// ---------- 移动 390×844 ----------
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
mode = 'empty-experiences';
await go('/experiences');
results['empty-experiences-390x844'] = await probe('empty-experiences-390x844');
mode = 'real';
await go('/schedule');
results['empty-schedule-390x844'] = await probe('empty-schedule-390x844');
await go('/research');
results['empty-research-390x844'] = await probe('empty-research-390x844');

p('\n===== 汇总 =====');
for (const k of Object.keys(results)) {
  const i = results[k];
  p(`${k}: 有空态=${i.hasEmpty} 中心偏差=${i.emptyCenterOffset}px 标题="${i.title?.text ?? '-'}" CTA="${i.cta?.text ?? '-'}"→${i.cta?.href ?? '-'} 文档高=${i.docHeight}`);
}
p('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));

fs.writeFileSync(`${OUT}/report2.json`, JSON.stringify({ results, errs }, null, 2), 'utf8');
fs.writeFileSync(`${OUT}/report2.txt`, log.join('\n'), 'utf8');
await browser.close();
