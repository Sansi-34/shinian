import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox","--disable-gpu","--lang=zh-CN"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1:5181/", { waitUntil: "networkidle0" });
if (await page.$(".login-card")) {
  await page.click(".login-card input", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(".login-card input", "阿念");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b)=> (b.innerText||"").includes("开启拾念之旅"))?.click());
  await page.waitForFunction(() => !document.querySelector(".login-card"), { timeout: 20000 });
}
await page.goto("http://127.0.0.1:5181/attempt/att-1795078914914-9w4eto", { waitUntil: "networkidle0" });
await page.waitForSelector(".v2-editor");
await sleep(800);
// 折叠态：先截图标题行
await page.evaluate(() => window.scrollTo(0, 0));
const collapsed = await page.evaluate(() => {
  const h=[...document.querySelectorAll("section h2")].find((x)=>(x.innerText||"").includes("来源念头"));
  const sec=h.closest("section"); const r=sec.getBoundingClientRect();
  return { top:Math.round(r.top), h:Math.round(r.height), title:h.innerText, count: h.closest("button")?.querySelector("span[class*=count]")?.innerText ?? null };
});
console.log("collapsed", JSON.stringify(collapsed));
await page.screenshot({ path: "D:/联动日程表/audit/shots/after-attempt/12-collapsed-closeup.png", clip: { x: 60, y: Math.max(0, collapsed.top - 60), width: 920, height: collapsed.h + 70 } });
await page.evaluate(() => { const h=[...document.querySelectorAll("section h2")].find((x)=>(x.innerText||"").includes("来源念头")); h.closest("button").click(); });
await sleep(700);
const open = await page.evaluate(() => {
  const h=[...document.querySelectorAll("section h2")].find((x)=>(x.innerText||"").includes("来源念头"));
  const sec=h.closest("section"); const r=sec.getBoundingClientRect();
  return { top:Math.round(r.top), h:Math.round(r.height) };
});
await page.screenshot({ path: "D:/联动日程表/audit/shots/after-attempt/13-open-closeup.png", clip: { x: 60, y: Math.max(0, open.top - 60), width: 920, height: open.h + 70 } });
await browser.close();
