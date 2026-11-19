import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox","--disable-gpu","--lang=zh-CN"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
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
await page.evaluate(() => { const h=[...document.querySelectorAll("section h2")].find((x)=>(x.innerText||"").includes("来源念头")); h?.closest("button")?.click(); });
await sleep(700);
const info = await page.evaluate(() => {
  const h=[...document.querySelectorAll("section h2")].find((x)=>(x.innerText||"").includes("来源念头"));
  const sec=h.closest("section");
  const row=sec.querySelector("a");
  const spans=[...row.querySelectorAll("span")].map((s)=>{const r=s.getBoundingClientRect();const cs=getComputedStyle(s);return {cls:s.className, text:(s.innerText||"").slice(0,20), top:Math.round(r.top), h:Math.round(r.height), fs:cs.fontSize, color:cs.color, clamp:cs.webkitLineClamp};});
  return { rowRect: (()=>{const r=row.getBoundingClientRect();return {top:Math.round(r.top),h:Math.round(r.height)};})(), spans };
});
console.log(JSON.stringify(info,null,1));
const el = await page.$("section:has(h2)");
const sec = await page.evaluateHandle(() => [...document.querySelectorAll("section")].find((s)=>(s.querySelector("h2")?.innerText||"").includes("来源念头")));
await sec.asElement().screenshot({ path: "D:/联动日程表/audit/shots/after-attempt/11-source-row-detail.png" });
await browser.close();
