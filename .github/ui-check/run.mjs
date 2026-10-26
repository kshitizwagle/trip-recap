// Phone check: iPhone (WebKit) and Pixel (Chromium) emulation, files the way phone pickers hand them over.
import {chromium, webkit, devices} from "playwright";
import {writeFileSync, mkdirSync} from "node:fs";
import {buildJpeg, buildTiff} from "../../frontend/src/lib/engine/test-fixtures.ts";

mkdirSync("shots", {recursive: true});
const stops = [
  ["2026:10:24 07:00:00", 27.6587525, 85.3247183],
  ["2026:10:24 08:10:00", 27.6128068, 85.264486],
  ["2026:10:24 09:00:00", 27.596667, 85.2204851],
];
// Android-style: no extension, empty MIME type.
const noExtension = stops.map(([time, lat, lon], i) => ({
  name: `100001234${i}`,
  mimeType: "",
  buffer: Buffer.from(buildJpeg(buildTiff({dateTimeOriginal: time, offsetTimeOriginal: "+05:45", latitude: lat, longitude: lon}))),
}));
// iOS-style: UUID names, JPEG, location stripped by the picker.
const stripped = stops.map(([time], i) => ({
  name: `4C9E2B1A-77D0-4E4B-9F0C-00000000000${i}.jpeg`,
  mimeType: "image/jpeg",
  buffer: Buffer.from(buildJpeg(buildTiff({dateTimeOriginal: time, offsetTimeOriginal: "+05:45"}))),
}));

const log = [];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  log.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

for (const [label, engine, device] of [["iphone", webkit, devices["iPhone 13"]], ["pixel", chromium, devices["Pixel 7"]]]) {
  const browser = await engine.launch();
  const page = await browser.newPage({...device});
  page.on("pageerror", (e) => log.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log.push(`${label} console: ${m.text()}`); });
  try {
    await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
    await page.waitForTimeout(800);
    // Tap the header button the way a thumb would; it must open a file chooser.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", {timeout: 10000}), page.getByText("Add media", {exact: true}).tap()]);
    check(`${label}: Add media opens the picker`, chooser.isMultiple(), `multiple=${chooser.isMultiple()}`);
    await chooser.setFiles(noExtension);
    await page.waitForFunction(() => /Ready/.test(document.body.innerText) || document.querySelectorAll(".editor-media-row").length >= 3, null, {timeout: 20000});
    await page.waitForTimeout(1500);
    const rows = await page.locator(".editor-media-row").allInnerTexts();
    const ready = rows.filter((row) => /GPS/.test(row) && !/no GPS/.test(row)).length;
    check(`${label}: extension-less files are read`, ready === 3, rows.map((r) => r.replace(/\s+/g, " ").slice(0, 70)).join(" | "));
    await page.screenshot({path: `shots/${label}-1-added.png`, fullPage: true});
    await page.locator("#analyze").tap();
    await page.waitForSelector(".map-canvas-frame", {timeout: 60000});
    await page.waitForTimeout(5000);
    check(`${label}: route builds`, true, await page.locator(".studio-title p").innerText());
    await page.screenshot({path: `shots/${label}-2-route.png`});

    // Second session: photos whose location the picker removed.
    const fresh = await browser.newPage({...device});
    await fresh.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
    await fresh.locator('input[type="file"]').last().setInputFiles(stripped);
    await fresh.waitForTimeout(2500);
    const note = await fresh.locator(".gps-note").innerText().catch(() => "");
    check(`${label}: missing-location note`, /None of these files have a location/.test(note), note.replace(/\s+/g, " ").slice(0, 120));
    await fresh.screenshot({path: `shots/${label}-3-no-gps.png`, fullPage: true});
    await fresh.locator("#start-point").fill("27.6587, 85.3247");
    await fresh.locator("#end-point").fill("27.4965, 85.0337");
    await fresh.locator("#analyze").tap();
    await fresh.waitForSelector(".map-canvas-frame", {timeout: 60000}).catch(() => {});
    check(`${label}: no-GPS photos + start/end build a route`, (await fresh.locator(".map-canvas-frame").count()) === 1, await fresh.locator(".studio-title p").innerText());
    check(`${label}: no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } catch (error) {
    check(`${label}: run`, false, error.message.split("\n")[0]);
    await page.screenshot({path: `shots/${label}-fail.png`, fullPage: true}).catch(() => {});
  }
  await browser.close();
}
log.unshift(`${failures} failure(s)`);
writeFileSync("shots/log.txt", log.join("\n"));
