// Remove-added-place check against the merged main build (tabbed UI).
import {chromium} from "playwright";
import {writeFileSync, mkdirSync} from "node:fs";
import {buildJpeg, buildTiff} from "../../frontend/src/lib/engine/test-fixtures.ts";
mkdirSync("shots", {recursive: true}); mkdirSync("media", {recursive: true});
const stops = [["01.jpg","2026:10:24 07:00:00",27.6587525,85.3247183],["02.jpg","2026:10:24 08:10:00",27.6128068,85.264486],["03.jpg","2026:10:24 09:00:00",27.596667,85.2204851]];
const files = stops.map(([n,t,la,lo]) => { writeFileSync(`media/${n}`, buildJpeg(buildTiff({dateTimeOriginal: t, offsetTimeOriginal: "+05:45", latitude: la, longitude: lo}))); return `media/${n}`; });
const log = [];
const browser = await chromium.launch({channel: "chrome"});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
page.on("console", (m) => { if (m.type() === "error") log.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
const names = () => page.locator(".editor-stop-name").allInnerTexts();
const st = () => page.locator("#status").innerText().catch(() => "");
try {
  await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
  await page.locator('input[type="file"]').first().setInputFiles(files);
  await page.waitForTimeout(2000);
  await page.locator("#analyze").click();
  await page.waitForSelector(".map-canvas-frame", {timeout: 60000});
  await page.locator("#tab-Route").click();
  await page.waitForTimeout(4000);
  log.push(`start: ${await names()}`);
  for (const q of ["Lumbini Palace Resort", "Kulekhani"]) {
    await page.locator("#add-stop").fill(q);
    await page.waitForTimeout(1500);
    await page.getByRole("button", {name: "Add to route"}).click();
    await page.waitForTimeout(8000);
    log.push(`added ${q}: ${await names()} :: ${await st()}`);
  }
  await page.screenshot({path: "shots/main-added.png"});
  const btns = page.getByRole("button", {name: "Remove from route"});
  log.push(`remove buttons: ${await btns.count()} disabled: ${await btns.evaluateAll((b) => b.map((x) => x.disabled || x.getAttribute("aria-disabled")))}`);
  await btns.last().click({timeout: 10000});
  await page.waitForTimeout(6000);
  log.push(`after remove last: ${await names()} :: ${await st()}`);
  await btns.nth(3).click({timeout: 10000}).catch((e) => log.push(`click 3 failed ${e.message.split("\n")[0]}`));
  await page.waitForTimeout(6000);
  log.push(`after remove idx3: ${await names()} :: ${await st()}`);
  await page.screenshot({path: "shots/main-removed.png"});
} catch (e) { log.push(`FAILED ${e.message}`); await page.screenshot({path: "shots/main-fail.png"}); }
writeFileSync("shots/log.txt", log.join("\n"));
await browser.close();
