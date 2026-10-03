import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(process.env.BROWSER_TEST_RUNTIME
  ? path.join(path.resolve(process.env.BROWSER_TEST_RUNTIME), "package.json") : import.meta.url);
const playwright = require("playwright");
const { expect } = require("playwright/test");
const { default: AxeBuilder } = require("@axe-core/playwright");
const engine = process.env.BROWSER_TEST_ENGINE ?? "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported browser test engine");
const output = path.resolve(process.env.BROWSER_TEST_OUTPUT ?? "browser-results");
const site = await realpath("site");
const prefix = "/BamzookiReloaded/";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".txt": "text/plain" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (!pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const file = await realpath(path.resolve(site, pathname.slice(prefix.length) || "index.html"));
    if (!file.startsWith(`${site}${path.sep}`) || !(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(output, { recursive: true });
const browser = await playwright[engine].launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const failures = [];
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
});
await context.route("**/*", (route) => {
  const url = route.request().url();
  if (url.startsWith(origin) || /^(?:blob|data):/.test(url)) return route.continue();
  errors.push("Unexpected external network request");
  return route.abort();
});
const shot = (name) => page.screenshot({ path: path.join(output, `${engine}-${name}.png`), fullPage: true });
const module = async (name) => {
  await page.locator("#modules-command").click();
  await page.locator(`#module-launcher [data-suite-module="${name}"]`).click();
  await expect(page.locator(".shell")).toHaveAttribute("data-module", name);
};
const accessibility = async (name) => {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const violations = results.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) }));
  assert.deepEqual(violations, [], `${name} accessibility checks`);
  checks.push(`${name}: automated accessibility`);
};

try {
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".publication-disclaimer")).toContainText("not affiliated with or endorsed by the BBC or Gameware");
  await accessibility("Loader");
  await shot("loader");
  await page.locator("#loader-tutorial").click();
  await expect(page.locator("#part-summary")).toHaveText("9 parts");
  await page.locator("#mode-test").click();
  await page.locator("#test-target-x").fill("2");
  await page.locator("#test-target-z").fill("3");
  await page.locator("#test-target-set").click();
  await expect(page.locator("#test-target-value")).not.toHaveText("Not placed");
  await shot("tutorial-test");
  await page.locator("#mode-select").click();
  checks.push("Tutorial Walker: nine articulated parts, Test target, Select return");

  await module("simulator");
  await page.locator("#simulator-zook-1").selectOption("tutorial");
  await page.locator("#simulator-zook-2").selectOption("tutorial");
  const contests = page.locator("#simulator-contest-list button");
  await expect(contests).toHaveCount(9);
  await accessibility("Simulator setup");
  const saved = [];
  for (let index = 0; index < 9; index += 1) {
    await contests.nth(index).click();
    const name = (await contests.nth(index).innerText()).replaceAll("\n", " ");
    await page.locator("#simulator-start").click();
    await expect.poll(async () => Number.parseFloat(await page.locator("#simulator-time").innerText()), { timeout: 40_000 }).toBeGreaterThanOrEqual(0.5);
    for (const button of await page.locator("button[data-simulator-camera]").all()) await button.click();
    if (index === 5 || index === 6) await shot(`contest-${index}`);
    if (await page.locator("#simulator-stop").isVisible()) await page.locator("#simulator-stop").click();
    await expect(page.locator("#simulator-save-dialog")).toBeVisible();
    if ([3, 5, 6].includes(index)) {
      const title = `Browser check ${index}`;
      await page.locator("#simulator-replay-name").fill(title);
      await page.locator("#simulator-save").click();
      saved.push({ title, index });
    } else await page.locator("#simulator-dont-save").click();
    await expect(page.locator("#simulator-save-dialog")).toBeHidden();
    await expect(page.locator("#simulator-start")).toBeEnabled();
    checks.push(`${name}: countdown, live physics, four cameras, Stop, save/discard`);
  }

  await module("motion-player");
  for (const { title, index } of saved) {
    const option = page.locator("#motion-replay-library option").filter({ hasText: title });
    await expect(option).toHaveCount(1);
    await page.locator("#motion-replay-library").selectOption(await option.getAttribute("value"));
    await page.locator("#motion-load").click();
    await expect(page.locator("#motion-replay-title")).toHaveText(title);
    await page.locator("#motion-loop").check();
    await page.locator("#motion-play").click();
    await expect(page.locator("#motion-play")).toHaveText("Pause");
    await page.locator("#motion-play").click();
    await page.locator("#motion-timeline").press("End");
    for (const button of await page.locator("button[data-motion-camera]").all()) await button.click();
    if (index === 6) await shot("arena-replay");
    const downloaded = page.waitForEvent("download");
    await page.locator("#motion-export").click();
    const stream = await (await downloaded).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const replay = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(replay.schemaVersion, 2);
    assert.equal(replay.participants.length, 2);
    const count = replay.arena.movingObjectIds.length + replay.arena.dynamicObjectIds.length;
    assert.equal(count, index === 3 ? 1 : index === 5 ? 58 : 61);
    assert.ok(replay.durationTicks >= 30);
    assert.ok(replay.keyframes.every((frame) => frame.arenaPoses.length === count));
    assert.notDeepEqual(replay.keyframes.at(-1).arenaPoses, replay.keyframes[0].arenaPoses);
    checks.push(`${title}: persisted arena replay, transport, scrub, cameras, complete exported object tracks`);
  }
  await accessibility("Motion Player");
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await module("motion-player");
  await expect(page.locator("#motion-replay-library option")).toHaveCount(3);
  checks.push("Replay library survives a browser-page reload");
  assert.deepEqual(errors, [], "Browser console, script, network errors");
  console.log(`${engine}: ${checks.length} compiled-release checks passed.`);
} catch (error) {
  failures.push(error.message);
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, `${engine}-summary.json`), `${JSON.stringify({ engine, checks, failures, errors }, null, 2)}\n`);
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
