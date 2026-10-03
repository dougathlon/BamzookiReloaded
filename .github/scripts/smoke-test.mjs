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
// The hosted runner has no physical GPU. Firefox needs an X display and an
// explicit software-WebGL test profile; these preferences never enter the game.
const browser = await playwright[engine].launch({
  headless: engine !== "firefox",
  ...(engine === "firefox" ? { firefoxUserPrefs: {
    "webgl.force-enabled": true,
    "webgl.disable-fail-if-major-performance-caveat": true,
  } } : {}),
});
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
const fileCommand = async (name) => {
  await page.locator("#file-system-command").click();
  await page.getByRole("dialog", { name: "File / system" }).getByRole("button", { name, exact: true }).click();
};
const exportZook = async () => {
  const downloaded = page.waitForEvent("download");
  await fileCommand("Export");
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

try {
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#capability-error")).toBeHidden();
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

  await page.locator("#file-system-command").click();
  await page.locator("#save-zook").click();
  await expect(page.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");

  const originalBytes = await exportZook();
  const original = JSON.parse(originalBytes);
  await fileCommand("Save As");
  await expect(page.locator("#save-as-name")).toBeFocused();
  await accessibility("Save As");
  await shot("save-as");
  await page.locator("#save-as-confirm").click();
  await expect(page.locator("#save-as-status")).toContainText("Choose a different name");
  await page.locator("#save-as-name").fill("Cancelled copy");
  await page.keyboard.press("Escape");
  await expect(page.locator("#file-system-command")).toBeFocused();
  assert.equal(await exportZook(), originalBytes);
  checks.push("Save As: keyboard focus, unchanged-name rejection and byte-identical cancellation");

  await fileCommand("Save As");
  await page.locator("#save-as-name").fill("Failed copy");
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "zookIndex") {
        IDBObjectStore.prototype.put = originalPut;
        throw new DOMException("Simulated storage exhaustion", "QuotaExceededError");
      }
      return Reflect.apply(originalPut, this, key === undefined ? [value] : [value, key]);
    };
  });
  await page.locator("#save-as-confirm").click();
  await expect(page.locator("#save-as-status")).toContainText("storage is full");
  await expect(page.locator("#save-as-name")).toBeFocused();
  await page.locator("#save-as-cancel").click();
  assert.equal(await exportZook(), originalBytes);
  checks.push("Save As: interrupted storage leaves canonical editor bytes and original record intact");

  await fileCommand("Save As");
  await page.locator("#save-as-name").fill("Tutorial Walker copy");
  await page.keyboard.press("Enter");
  await expect(page.locator("#save-as-dialog")).toBeHidden();
  await expect(page.locator("#file-system-command")).toBeFocused();
  const copyBytes = await exportZook();
  const copy = JSON.parse(copyBytes);
  assert.deepEqual({ ...copy, checksum: original.checksum, metadata: { ...copy.metadata, name: original.metadata.name } }, original);
  assert.equal(copy.metadata.name, "Tutorial Walker copy");
  await page.locator("#undo-command").click();
  assert.equal(await exportZook(), originalBytes);
  await page.locator("#redo-command").click();
  assert.equal(await exportZook(), copyBytes);
  await page.getByLabel("Width", { exact: true }).fill("0.77");
  const changedCopyBytes = await exportZook();
  assert.notEqual(changedCopyBytes, copyBytes);
  await fileCommand("Save");
  await expect(page.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await expect(page.locator("#loader-list [role=option]")).toHaveCount(2);
  await page.locator("#loader-list [role=option]").filter({ hasText: "Tutorial Walker copy" }).click();
  await page.locator("#loader-open").click();
  assert.equal(await exportZook(), changedCopyBytes);
  await page.locator("#loader-command").click();
  await page.locator("#loader-list [role=option]").filter({ hasText: "Tutorial Walker" }).filter({ hasNotText: "copy" }).click();
  await page.locator("#loader-open").click();
  assert.equal(await exportZook(), originalBytes);
  checks.push("Save As: reversible name, independent subsequent Save, two-entry reload and byte-identical original");

  await module("simulator");
  const savedZook = page.locator("#simulator-zook-1 option").filter({ hasText: "Tutorial Walker — My Zooks (9 parts)" });
  await expect(savedZook).toHaveCount(1);
  await page.locator("#simulator-zook-1").selectOption(await savedZook.getAttribute("value"));
  await page.locator("#simulator-zook-2").selectOption("tutorial");
  checks.push("Saved My Zooks entry selectable independently from tutorial opponent");
  const contests = page.locator("#simulator-contest-list button");
  await expect(contests).toHaveCount(9);
  await accessibility("Simulator setup");
  const saved = [];
  for (let index = 0; index < 9; index += 1) {
    await contests.nth(index).click();
    const name = (await contests.nth(index).innerText()).replaceAll("\n", " ");
    for (const button of await page.locator("button[data-simulator-camera]").all()) await button.click();
    await page.locator("#simulator-start").click();
    await expect.poll(async () => await page.locator("#simulator-save-dialog").isVisible() ||
      Number.parseFloat(await page.locator("#simulator-time").innerText()) >= 0.5, { timeout: 40_000 }).toBe(true);
    if (index === 5 || index === 6) await shot(`contest-${index}`);
    if (await page.locator("#simulator-stop").isVisible()) {
      await page.locator("#simulator-stop").click({ timeout: 2000 }).catch(async (error) => {
        if (!await page.locator("#simulator-save-dialog").isVisible()) throw error;
      });
    }
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
    assert.ok(replay.participants.every(({ zook }) => zook.parts.length === 9));
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

  await module("zook-kit");
  await page.locator("#loader-command").click();
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  const storedOriginal = () => page.locator("#loader-list [role=option]")
    .filter({ hasText: "Tutorial Walker" }).filter({ hasNotText: "copy" });
  await storedOriginal().click();
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), originalBytes);
  await page.getByLabel("Width", { exact: true }).fill("0.81");
  const modifiedBytes = await exportZook();
  await fileCommand("New");
  await expect(page.locator("#loader-replace-cancel")).toBeFocused();
  await accessibility("Save before New or Open");
  await shot("save-before-replace");
  await page.keyboard.press("Escape");
  await expect(page.locator("#loader-new")).toBeFocused();
  await page.locator("#loader-close").click();
  assert.equal(await exportZook(), modifiedBytes);
  await fileCommand("New");
  await page.locator("#loader-replace-discard").click();
  await expect(page.locator("#new-zook-name")).toBeFocused();
  await accessibility("New Zook name");
  await shot("new-zook");
  await page.locator("#new-zook-name").fill("   ");
  await page.locator("#new-zook-confirm").click();
  await expect(page.locator("#new-zook-status")).toContainText("Enter a name");
  await expect(page.locator("#new-zook-name")).toHaveValue("   ");
  await expect(page.locator("#new-zook-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#loader-new")).toBeFocused();
  await page.locator("#loader-close").click();
  assert.equal(await exportZook(), modifiedBytes);
  checks.push("New: focused naming, invalid-name recovery and byte-identical cancellation at both prompts");

  await fileCommand("New");
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "zookIndex") {
        IDBObjectStore.prototype.put = originalPut;
        throw new DOMException("Simulated storage exhaustion", "QuotaExceededError");
      }
      return Reflect.apply(originalPut, this, key === undefined ? [value] : [value, key]);
    };
  });
  await page.locator("#loader-replace-save").click();
  await expect(page.locator("#loader-replace-status")).toContainText("storage is full");
  await expect(page.locator("#loader-replace-cancel")).toBeFocused();
  await expect(page.locator("#new-zook-dialog")).toBeHidden();
  await page.locator("#loader-replace-cancel").click();
  await page.locator("#loader-close").click();
  assert.equal(await exportZook(), modifiedBytes);
  checks.push("Save before New: storage failure prevents replacement and preserves dirty canonical bytes");

  await page.getByLabel("Width", { exact: true }).fill("0.82");
  const savedBeforeOpen = await exportZook();
  await page.locator("#loader-command").click();
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await page.locator("#loader-list [role=option]").filter({ hasText: "Tutorial Walker copy" }).click();
  await page.locator("#loader-open").click();
  await page.locator("#loader-replace-save").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), changedCopyBytes);
  await page.locator("#loader-command").click();
  await expect(page.locator("#loader-list [role=option]")).toHaveCount(2);
  await storedOriginal().click();
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), savedBeforeOpen);
  checks.push("Save before Open: original saved in place and captured copy target preserved through library refresh");

  await page.getByLabel("Width", { exact: true }).fill("0.83");
  const beforeFailedOpen = await exportZook();
  await fileCommand("Open");
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  await page.locator("#loader-desktop-input").setInputFiles({ name: "invalid.zook.json", mimeType: "application/json", buffer: Buffer.from("not-json") });
  await page.locator("#loader-replace-discard").click();
  await expect(page.locator("#loader-replace-confirm")).toBeHidden();
  await expect(page.locator("#zook-loader")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-close").click();
  assert.equal(await exportZook(), beforeFailedOpen);
  await page.locator("#undo-command").click();
  assert.equal(await exportZook(), savedBeforeOpen);
  checks.push("Open: invalid import after Don't Save preserves current bytes and undo history");

  await page.getByLabel("Width", { exact: true }).fill("0.84");
  const savedBeforeNew = await exportZook();
  await fileCommand("New");
  await page.locator("#loader-replace-save").click();
  await expect(page.locator("#new-zook-dialog")).toBeVisible();
  await page.locator("#new-zook-cancel").click();
  await page.locator("#loader-close").click();
  assert.equal(await exportZook(), savedBeforeNew);
  await fileCommand("New");
  await expect(page.locator("#new-zook-dialog")).toBeVisible();
  await expect(page.locator("#loader-replace-confirm")).toBeHidden();
  await page.locator("#new-zook-name").fill("  Cafe\u0301 Walker  ");
  await page.keyboard.press("Enter");
  await expect(page.locator("#zook-loader")).toBeHidden();
  const named = JSON.parse(await exportZook());
  assert.equal(named.metadata.name, "Café Walker");
  assert.equal(named.parts.length, 1);
  assert.deepEqual(named.metadata.lineage, []);
  assert.deepEqual(named.metadata.passportResults, []);
  await fileCommand("Save");
  await expect(page.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await expect(page.locator("#loader-list [role=option]")).toHaveCount(3);
  await expect(page.locator("#loader-list [role=option]").filter({ hasText: "Café Walker" })).toHaveCount(1);
  await storedOriginal().click();
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), savedBeforeNew);
  checks.push("New: save-then-cancel retains current Zook; normalized named creation saves separately and survives reload");
  assert.deepEqual(errors, [], "Browser console, script, network errors");
  console.log(`${engine}: ${checks.length} compiled-release checks passed.`);
} catch (error) {
  failures.push(error.message);
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, `${engine}-summary.json`), `${JSON.stringify({ engine, graphics: "software-rendered CI; not hardware performance or real Safari evidence", checks, failures, errors }, null, 2)}\n`);
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
