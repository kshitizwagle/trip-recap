// End-to-end check of every control in the studio. Writes PASS/FAIL lines to shots/log.txt.
import {chromium} from "playwright";
import {writeFileSync, mkdirSync, statSync} from "node:fs";
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
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  log.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};
const browser = await chromium.launch({channel: "chrome"});
const page = await browser.newPage({viewport: {width: 1440, height: 900}, acceptDownloads: true});
page.on("console", (m) => { if (m.type() === "error") log.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));

const names = () => page.locator(".editor-stop-name").allInnerTexts();
const status = () => page.locator("#status").innerText().catch(() => "");
const summary = () => page.locator(".studio-title p").innerText();
const pressed = (group) => page.locator(`.grp[aria-label="${group}"] button[aria-pressed="true"]`).innerText();
const hud = () => page.locator("canvas.map-overlay").evaluate((c) => c.toDataURL("image/png").length);
async function waitIdle() {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.querySelector(".editor-stop-name:disabled") && !/Re-tracing/.test(document.querySelector("#status")?.textContent ?? ""), null, {timeout: 60000});
  await page.waitForTimeout(400);
}
async function addPlace(query, positionLabel) {
  await page.locator("#add-stop").fill(query);
  if (positionLabel) await page.locator("#add-stop-position").selectOption({label: positionLabel});
  await page.getByRole("button", {name: "Add to route"}).click();
  await waitIdle();
}
const stopRow = (name) => page.locator(".editor-stop").filter({has: page.locator(".editor-stop-name", {hasText: name})}).first();
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(name, false, `threw ${error.message.split("\n")[0]}`);
    await page.screenshot({path: `shots/fail-${name.replace(/\W+/g, "-")}.png`}).catch(() => {});
  }
}

await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
await page.waitForTimeout(800);
await page.screenshot({path: "shots/1-empty.png"});

await step("media: add files", async () => {
  await page.locator('input[type="file"]').first().setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll(".editor-media-row").length === 5, null, {timeout: 20000});
  check("media: add files", true, await summary());
});
await step("media: remove a file before building", async () => {
  await page.getByRole("button", {name: "Remove no-gps.jpg"}).click();
  await page.waitForTimeout(500);
  const rows = await page.locator(".editor-media-row").count();
  check("media: remove a file before building", rows === 4, `${rows} rows`);
  await page.locator('input[type="file"]').first().setInputFiles(["media/no-gps.jpg"]);
  await page.waitForFunction(() => document.querySelectorAll(".editor-media-row").length === 5);
});
await page.screenshot({path: "shots/2-media.png"});

await step("route: build", async () => {
  await page.locator("#analyze").click();
  await page.waitForSelector(".map-canvas-frame", {timeout: 60000});
  await page.waitForFunction(() => ![...document.querySelectorAll(".editor-stop-name")].some((n) => n.textContent === "Looking up…"), null, {timeout: 30000}).catch(() => {});
  check("route: build", (await page.locator(".map-canvas-frame").count()) === 1, await summary());
});
await step("layout: one screen", async () => {
  const box = await page.locator(".controls").nth(1).boundingBox();
  check("layout: one screen", box && box.y + box.height <= 900, `export row bottom ${box && Math.round(box.y + box.height)}`);
});
await page.waitForTimeout(3000);
await page.screenshot({path: "shots/3-playing.png"});

// Playback controls
await step("playback: pause/play", async () => {
  await page.locator("#play").click();
  const paused = await page.locator("#play").innerText();
  const t1 = await page.locator(".clock").innerText();
  await page.waitForTimeout(1500);
  const t2 = await page.locator(".clock").innerText();
  await page.locator("#play").click();
  await page.waitForTimeout(1500);
  const t3 = await page.locator(".clock").innerText();
  check("playback: pause/play", paused === "Play" && t1 === t2 && t3 !== t2, `${paused} ${t1} ${t2} ${t3}`);
});
await step("playback: restart", async () => {
  await page.waitForTimeout(1500);
  await page.locator("#restart").click();
  await page.waitForTimeout(250);
  const t = await page.locator(".clock").innerText();
  check("playback: restart", t === "0:00", t);
});
await step("playback: scrub", async () => {
  await page.locator("#play").click();
  await page.locator(".scrub input").fill("500");
  await page.waitForTimeout(400);
  const t = await page.locator(".clock").innerText();
  check("playback: scrub", t !== "0:00", t);
  await page.locator("#play").click();
});
for (const [group, options] of [["Map", ["Light", "Street", "Satellite", "Dark"]], ["Speed", ["½×", "2×", "1×"]], ["Frame", ["16:9", "1:1", "9:16"]], ["Marker", ["🛵", "🚗", "🏍️", "🚲", "Arrow"]], ["Quality", ["720p", "1440p", "1080p"]], ["FPS", ["60", "30"]]]) {
  for (const option of options) {
    await step(`${group}: ${option}`, async () => {
      await page.locator(`.grp[aria-label="${group}"]`).getByRole("button", {name: option, exact: true}).click();
      await page.waitForTimeout(group === "Map" ? 2500 : 400);
      check(`${group}: ${option}`, (await pressed(group)) === option);
      if (group === "Map" || group === "Frame") await page.screenshot({path: `shots/4-${group}-${option.replace(/\W/g, "")}.png`});
    });
  }
}
await step("frame: stage ratio", async () => {
  await page.locator('.grp[aria-label="Frame"]').getByRole("button", {name: "16:9"}).click();
  await page.waitForTimeout(500);
  const box = await page.locator(".map-canvas-frame").boundingBox();
  check("frame: stage ratio", Math.abs(box.width / box.height - 16 / 9) < 0.02, `${Math.round(box.width)}x${Math.round(box.height)}`);
  await page.locator('.grp[aria-label="Frame"]').getByRole("button", {name: "9:16"}).click();
});
await step("speed: 2× runs faster", async () => {
  await page.locator('.grp[aria-label="Speed"]').getByRole("button", {name: "2×"}).click();
  await page.locator("#restart").click();
  await page.waitForTimeout(2000);
  const t = await page.locator(".clock").innerText();
  check("speed: 2× runs faster", t >= "0:03", t);
  await page.locator('.grp[aria-label="Speed"]').getByRole("button", {name: "1×"}).click();
});

// Stops drawer
await page.locator(".drawer summary", {hasText: "Stops"}).click();
const original = await names();
check("stops: listed", original.length === 4, original.join(", "));

await step("stops: move down", async () => {
  await page.getByRole("button", {name: "Move down"}).first().click();
  await waitIdle();
  const after = await names();
  check("stops: move down", after[0] === original[1] && after[1] === original[0], after.join(", "));
});
await step("stops: move up", async () => {
  await page.getByRole("button", {name: "Move up"}).nth(0).click();
  await waitIdle();
  const after = await names();
  check("stops: move up", after.join() === original.join(), after.join(", "));
});
await step("stops: add at end", async () => {
  await addPlace("Lumbini Palace Resort");
  const after = await names();
  check("stops: add at end", after.length === 5 && after[4] === "Lumbini Palace Resort", `${after.join(", ")} :: ${await status()}`);
});
await page.screenshot({path: "shots/5-added.png"});
await step("stops: remove added (end)", async () => {
  await stopRow("Lumbini Palace Resort").getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const after = await names();
  check("stops: remove added (end)", after.length === 4 && !after.includes("Lumbini Palace Resort"), `${after.join(", ")} :: ${await status()}`);
});
await step("stops: add at start", async () => {
  await addPlace("Patan Durbar Square", "At the start");
  const after = await names();
  check("stops: add at start", after.length === 5 && after[0] === "Patan Durbar Square", `${after.join(", ")} :: ${await status()}`);
});
await step("stops: add in middle", async () => {
  const before = await names();
  await addPlace("Kulekhani", `After 02 · ${before[1]}`);
  const after = await names();
  check("stops: add in middle", after.length === 6 && after[2] === "Kulekhani", `${after.join(", ")} :: ${await status()}`);
});
await step("stops: move added down", async () => {
  await stopRow("Kulekhani").getByRole("button", {name: "Move down"}).click();
  await waitIdle();
  const after = await names();
  check("stops: move added down", after[3] === "Kulekhani", after.join(", "));
});
await step("stops: rename added", async () => {
  await page.locator(".editor-stop-name", {hasText: "Kulekhani"}).click();
  await page.locator(".editor-stop-input").fill("Kulekhani Dam");
  await page.keyboard.press("Enter");
  await waitIdle();
  const after = await names();
  check("stops: rename added", after.includes("Kulekhani Dam"), after.join(", "));
});
await step("stops: rename recorded point", async () => {
  const before = await names();
  await page.locator(".editor-stop-name", {hasText: before[1]}).first().click();
  await page.locator(".editor-stop-input").fill("Home");
  await page.keyboard.press("Enter");
  await waitIdle();
  check("stops: rename recorded point", (await names())[1] === "Home", (await names()).join(", "));
});
await step("stops: clear rename restores name", async () => {
  await page.locator(".editor-stop-name", {hasText: /^Home$/}).click();
  await page.locator(".editor-stop-input").fill("");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const after = await names();
  check("stops: clear rename restores name", after[1] !== "Home" && after[1] !== "Looking up…", after.join(", "));
});
await step("stops: remove added (start)", async () => {
  await stopRow("Patan Durbar Square").getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const after = await names();
  check("stops: remove added (start)", after.length === 4 && !after.includes("Patan Durbar Square"), after.join(", "));
});
await step("stops: remove added (renamed, middle)", async () => {
  await stopRow("Kulekhani Dam").getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const after = await names();
  check("stops: remove added (renamed, middle)", after.length === 3 && !after.some((n) => n.startsWith("Kulekhani")), after.join(", "));
});
await step("stops: add same place twice, remove both", async () => {
  await addPlace("Lumbini Palace Resort");
  await addPlace("Lumbini Palace Resort");
  const twice = await names();
  await stopRow("Lumbini Palace Resort").getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const once = await names();
  await stopRow("Lumbini Palace Resort").getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const none = await names();
  check("stops: add same place twice, remove both", twice.length === 5 && once.length === 4 && none.length === 3, `${twice.length}/${once.length}/${none.length} :: ${none.join(", ")}`);
});
await step("stops: remove recorded point", async () => {
  const before = await names();
  await stopRow(before[0]).getByRole("button", {name: "Remove from route"}).click();
  await waitIdle();
  const after = await names();
  check("stops: remove recorded point", after.length === 2 && after[0] === before[1], after.join(", "));
});
await page.screenshot({path: "shots/6-edited.png", fullPage: true});

// Options drawer
await page.locator(".drawer summary", {hasText: "Media & options"}).click();
for (const level of ["Exact", "Town", "Region", "Area"]) {
  await step(`place names: ${level}`, async () => {
    await page.locator('.grp[aria-label="Place names"]').getByRole("button", {name: level}).click();
    await page.waitForTimeout(4000);
    check(`place names: ${level}`, (await pressed("Place names")) === level, (await names()).join(", "));
  });
}
await step("rebuild: return to start", async () => {
  await page.getByLabel("Return to the start").check();
  await page.locator("#analyze").click();
  await page.waitForSelector("#analyze:not(:disabled)", {timeout: 60000});
  await page.waitForTimeout(1500);
  const after = await names();
  check("rebuild: return to start", after.length >= 5, `${after.length} stops :: ${await summary()}`);
  await page.getByLabel("Return to the start").uncheck();
});
await step("rebuild: start point", async () => {
  await page.locator("#start-point").fill("Lalitpur");
  await page.waitForTimeout(1500);
  await page.locator("#analyze").click();
  await page.waitForSelector("#analyze:not(:disabled)", {timeout: 60000});
  await page.waitForTimeout(1500);
  const after = await names();
  check("rebuild: start point", after.length === 5, `${after.join(", ")}`);
  await page.locator("#start-point").fill("");
});
for (const file of ["trip.json", "route.geojson", "timeline.json"]) {
  await step(`download ${file}`, async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", {name: file}).click()]);
    await dl.saveAs(`shots/${file}`);
    check(`download ${file}`, statSync(`shots/${file}`).size > 50, `${statSync(`shots/${file}`).size} bytes`);
  });
}
await step("media: discard after building", async () => {
  await page.getByRole("button", {name: "Remove no-gps.jpg"}).click();
  await page.waitForTimeout(800);
  check("media: discard after building", (await page.locator(".editor-media-row").count()) === 4 && (await page.locator(".map-canvas-frame").count()) === 0, await summary());
  await page.locator("#analyze").click();
  await page.waitForSelector(".map-canvas-frame", {timeout: 60000});
});

// Export
await step("export: cancel", async () => {
  await page.locator("#render").click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", {name: "Cancel"}).click();
  await page.waitForSelector("#render", {timeout: 20000});
  check("export: cancel", true, await status());
});
await step("export: 720p 60fps 1:1", async () => {
  await page.locator('.grp[aria-label="Frame"]').getByRole("button", {name: "1:1"}).click();
  await page.locator('.grp[aria-label="Quality"]').getByRole("button", {name: "720p"}).click();
  await page.locator('.grp[aria-label="FPS"]').getByRole("button", {name: "60"}).click();
  await page.locator("#render").click();
  await page.waitForSelector("#video-download", {timeout: 900000});
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#video-download").click()]);
  await dl.saveAs("shots/export.mp4");
  check("export: 720p 60fps 1:1", statSync("shots/export.mp4").size > 10000, await page.locator(".exp-status").innerText());
});
await page.screenshot({path: "shots/7-exported.png"});

const phone = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 2});
phone.on("pageerror", (e) => log.push(`phone pageerror: ${e.message}`));
await phone.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle"});
await phone.locator('input[type="file"]').first().setInputFiles(files);
await phone.waitForTimeout(1500);
await phone.locator("#analyze").click();
await phone.waitForSelector(".map-canvas-frame", {timeout: 60000});
await phone.waitForTimeout(5000);
await phone.screenshot({path: "shots/8-phone.png"});
check("phone: no horizontal scroll", await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

log.unshift(`${failures} failure(s)`);
writeFileSync("shots/log.txt", log.join("\n"));
await browser.close();
