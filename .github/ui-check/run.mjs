import {chromium} from "playwright";
import {writeFileSync, mkdirSync} from "node:fs";
import {buildJpeg, buildTiff} from "../../frontend/src/lib/engine/test-fixtures.ts";

mkdirSync("shots", {recursive: true});
mkdirSync("media", {recursive: true});
const stops = [
  ["01-home.jpg", "2026:10:24 07:00:00", 27.6587525, 85.3247183],
  ["02-pharping.jpg", "2026:10:24 08:10:00", 27.6128068, 85.264486],
  ["03-fakhel.jpg", "2026:10:24 09:00:00", 27.596667, 85.2204851],
  ["04-bhainse.jpg", "2026:10:24 11:30:00", 27.4964506, 85.0337392],
];
const files = stops.map(([name, time, lat, lon]) => {
  const path = `media/${name}`;
  writeFileSync(path, buildJpeg(buildTiff({dateTimeOriginal: time, offsetTimeOriginal: "+05:45", latitude: lat, longitude: lon})));
  return path;
});
writeFileSync("media/no-gps.jpg", buildJpeg(buildTiff({dateTimeOriginal: "2026:10:24 10:00:00"})));
files.push("media/no-gps.jpg");

const log = [];
const browser = await chromium.launch({channel: "chrome"});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
page.on("console", (m) => { if (m.type() === "error") log.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
try {
await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
await page.waitForTimeout(800);
await page.screenshot({path: "shots/1-empty-desktop.png"});

await page.locator('input[type="file"]').first().setInputFiles(files);
await page.waitForFunction(() => document.querySelectorAll(".editor-media-row").length === 5);
await page.waitForTimeout(1500);
await page.screenshot({path: "shots/2-media-added.png"});

await page.locator("#analyze").click();
await page.waitForSelector(".map-canvas-frame", {timeout: 60000});
await page.waitForTimeout(6000);
await page.screenshot({path: "shots/3-route-playing.png"});
await page.waitForTimeout(9000);
await page.screenshot({path: "shots/3b-route-later.png"});
log.push(`summary: ${await page.locator(".studio-title p").innerText().catch(() => "none")}`);
await page.locator(".drawer summary").first().click();
log.push(`stops: ${await page.locator(".editor-stop-name").allInnerTexts().catch(() => [])}`);
// reorder: move the first stop down
await page.getByRole("button", {name: "Move down"}).first().click();
await page.waitForTimeout(5000);
log.push(`after reorder: ${await page.locator(".editor-stop-name").allInnerTexts().catch(() => [])} :: ${await page.locator("#status").innerText().catch(() => "")}`);
// add a place by search
await page.locator("#add-stop").fill("Lumbini Palace Resort");
await page.waitForTimeout(2500);
await page.getByRole("button", {name: "Add to route"}).click();
await page.waitForTimeout(8000);
log.push(`after add: ${await page.locator(".editor-stop-name").allInnerTexts().catch(() => [])} :: ${await page.locator("#status").innerText().catch(() => "")}`);
await page.screenshot({path: "shots/3c-edited.png", fullPage: true});
await page.getByRole("button", {name: "16:9"}).click();
await page.getByRole("button", {name: "Light"}).click();
await page.waitForTimeout(5000);
await page.screenshot({path: "shots/3d-wide-light.png"});
await page.getByRole("button", {name: "Dark"}).click();
log.push(`webcodecs: ${await page.evaluate(() => "VideoEncoder" in window)}`);
await page.locator("#render").click();
try {
  await page.waitForSelector("#video-download", {timeout: 900000});
  log.push(`export: ${await page.locator("#video-download").innerText()}`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#video-download").click()]);
  await dl.saveAs("shots/export.mp4");
} catch (error) {
  log.push(`export failed: ${error.message} :: ${await page.locator("#status").innerText().catch(() => "")}`);
}
await page.screenshot({path: "shots/4-export.png"});

const phone = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 2});
await phone.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
await phone.waitForTimeout(800);
await phone.screenshot({path: "shots/5-empty-phone.png", fullPage: true});
await phone.locator('input[type="file"]').first().setInputFiles(files);
await phone.waitForTimeout(1500);
await phone.locator("#analyze").click();
await phone.waitForSelector(".map-canvas-frame", {timeout: 60000});
await phone.waitForTimeout(6000);
await phone.screenshot({path: "shots/6-route-phone.png"});
} catch (error) {
  log.push(`FAILED: ${error.message}`);
  await page.screenshot({path: "shots/fail.png", fullPage: true}).catch(() => {});
}
writeFileSync("shots/log.txt", log.join("\n"));
await browser.close();
