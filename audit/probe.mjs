// 共享探针：把页面上的「可测量事实」挖出来（不依赖肉眼看图）
export const PROBE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  };
  const rgb = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return rgb(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrast = (fg, bg) => {
    const L1 = lum(fg), L2 = lum(bg);
    return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
  };
  const root = document.body;
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = clean(walker.currentNode.nodeValue);
    if (!t) continue;
    const el = walker.currentNode.parentElement;
    if (!el || seen.has(el) || !vis(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const fg = rgb(cs.color);
    const bg = effBg(el);
    const r = el.getBoundingClientRect();
    texts.push({
      t: t.slice(0, 80),
      tag: el.tagName.toLowerCase(),
      fs: parseFloat(cs.fontSize),
      fw: cs.fontWeight,
      color: cs.color,
      contrast: fg ? contrast(fg, bg) : null,
      x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height),
      clipped: el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2,
      sel: el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : el.tagName.toLowerCase(),
    });
  }
  const lowContrast = texts.filter((x) => x.contrast !== null && x.contrast < 4.5 && x.fs < 24).slice(0, 40);
  const clipped = texts.filter((x) => x.clipped && x.w > 0).slice(0, 20);
  const tiny = [...document.querySelectorAll('button, a, [role="button"], input, select')].filter(vis).map((el) => {
    const r = el.getBoundingClientRect();
    return { label: clean(el.innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase() };
  }).filter((x) => x.h < 44 || x.w < 44);
  const heads = [...document.querySelectorAll('h1,h2,h3,h4')].filter(vis).map((el) => {
    const cs = getComputedStyle(el);
    return { t: clean(el.innerText).slice(0, 60), tag: el.tagName.toLowerCase(), fs: parseFloat(cs.fontSize), fw: cs.fontWeight, y: Math.round(el.getBoundingClientRect().y + window.scrollY) };
  });
  const buttons = [...document.querySelectorAll('button, a, [role="button"]')].filter(vis).map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { label: clean(el.innerText).slice(0, 60) || el.getAttribute('aria-label') || '(无文字)', cls: typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 2).join('.') : '', bg: cs.backgroundColor, color: cs.color, y: Math.round(r.y + window.scrollY) };
  });
  const unlabeled = [...document.querySelectorAll('input, textarea, select, button')].filter(vis).filter((el) => {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') return !clean(el.innerText) && !el.getAttribute('aria-label');
    return !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('placeholder') && !el.getAttribute('title');
  }).map((el) => el.tagName.toLowerCase() + ':' + (el.type || '') + ':' + (el.name || ''));
  return {
    url: location.pathname + location.search,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    text: document.body.innerText,
    texts,
    lowContrast,
    clipped,
    tiny,
    heads,
    buttons,
    unlabeled,
  };
})()`;

export function mkLogger(dir, fs) {
  return function log(tag, obj) {
    fs.writeFileSync(`${dir}/${tag}.json`, JSON.stringify(obj, null, 2), 'utf8');
    return obj;
  };
}
