// V2 外壳回归检查（不需要视觉模型，纯几何与命中测试）
// 覆盖两类真实事故：
//   1) 旧外壳 .app 的 padding 把 V2 根节点内缩 → 纸张主题下四周露出黑边
//   2) 底部状态栏压住图标栏按钮 → 命中测试落到别的元素，点不动
// 用法：BASE=http://127.0.0.1:3600 node scripts/check_v2_shell.mjs
import puppeteer from 'puppeteer-core';

const CHROME = process.env.SHINIAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.SHINIAN_USER || '外壳自检';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(BASE + '/v2', { waitUntil: 'networkidle2' });
if (await page.$('.login-card input')) {
  await page.type('.login-card input', USER);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
    page.click('.login-card button[type="submit"]'),
  ]);
  await page.goto(BASE + '/v2', { waitUntil: 'networkidle2' });
}

for (const theme of ['paper', 'dark']) {
  await page.evaluate((t) => {
    try {
      localStorage.setItem('shinian.v2-theme', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 700));
  console.log(`== ${theme} ==`);

  const geo = await page.evaluate(() => {
    const root = document.querySelector('.v2-root');
    const r = root.getBoundingClientRect();
    const rail = document.querySelector('aside').getBoundingClientRect();
    const bar = document.querySelector('footer').getBoundingClientRect();
    const rootBg = getComputedStyle(root).backgroundColor;
    // 期望值不写死：把 --bg token 落到一个临时元素上取实际渲染值
    const probe = document.createElement('div');
    probe.style.background = 'var(--bg)';
    root.appendChild(probe);
    const tokenBg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      root: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      railBottom: Math.round(rail.bottom),
      barTop: Math.round(bar.top),
      barLeft: Math.round(bar.left),
      rootBg,
      tokenBg,
      vw: innerWidth,
      vh: innerHeight,
    };
  });

  check('V2 根节点从 (0,0) 铺满视口', geo.root.x === 0 && geo.root.y === 0 && geo.root.w === geo.vw && geo.root.h === geo.vh, JSON.stringify(geo.root));
  check('状态栏与图标栏不重叠', geo.railBottom <= geo.barTop + 1, `rail.bottom=${geo.railBottom} bar.top=${geo.barTop}`);
  check('状态栏铺满底边', geo.barLeft === 0, `bar.left=${geo.barLeft}`);
  check('根节点背景 = 当前主题的 --bg（不被旧外壳底色覆盖）', geo.rootBg === geo.tokenBg, `root=${geo.rootBg} token=${geo.tokenBg}`);

  const hits = await page.evaluate(() =>
    [...document.querySelectorAll('aside a, aside button')].map((el) => {
      const r = el.getBoundingClientRect();
      const c = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { label: el.getAttribute('aria-label') || el.textContent.trim(), ok: !!c && (c === el || el.contains(c)) };
    })
  );
  const bad = hits.filter((h) => !h.ok).map((h) => h.label);
  check(`图标栏 ${hits.length} 颗按钮命中自身`, bad.length === 0, bad.length ? '被遮挡：' + bad.join(',') : '');
}

await browser.close();
console.log(`\n==== 结果：${pass} passed / ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
