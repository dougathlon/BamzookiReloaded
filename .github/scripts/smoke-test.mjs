import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

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
const hologramPixels = async (panel, name, parts) => {
  const preview = panel.locator(".zook-hologram");
  await expect(preview).toHaveAttribute("data-hologram-state", "ready");
  const canvas = preview.getByRole("img", { name: `3D construction preview of ${name}, ${parts} ${parts === 1 ? "part" : "parts"}`, exact: true });
  await expect(canvas).toBeVisible();
  const pixels = await canvas.evaluate((element) => {
    const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    for (let index = 0; index < data.length; index += 16) colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    return { width: element.width, height: element.height, colors: colors.size, png: element.toDataURL() };
  });
  assert.equal(pixels.width, 512);
  assert.equal(pixels.height, 384);
  assert.ok(pixels.colors > 50, "Hologram must contain rendered geometry, not an empty canvas");
  return createHash("sha256").update(pixels.png).digest("hex");
};

// Test-only fixtures start from a canonical export. Added scores are integers;
// all other numeric values already have the export's canonical precision.
const sortingFixture = (base, name, passportResults) => {
  const { checksum: _checksum, ...document } = structuredClone(base);
  document.metadata = { ...document.metadata, name, creator: "Automated sorting fixture; not a gameplay achievement", passportResults };
  const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : value;
  return JSON.stringify(ordered({ ...document, checksum: createHash("sha256").update(JSON.stringify(ordered(document))).digest("hex") }));
};

try {
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#capability-error")).toBeHidden();
  await expect(page.locator(".publication-disclaimer")).toContainText("not affiliated with or endorsed by the BBC or Gameware");
  await accessibility("Loader");
  await shot("loader");
  const originalOrders = {
    sprint: ["Spider", "Leapsa", "Scrabber", "Ant", "Wormthing", "Twigger"],
    "block-push": ["Spider", "Leapsa", "Wormthing", "Ant", "Scrabber", "Twigger"],
    hurdles: ["Spider", "Leapsa", "Twigger", "Wormthing", "Scrabber", "Ant"],
    "high-jump": ["Twigger", "Leapsa", "Spider", "Ant", "Scrabber", "Wormthing"],
    lap: ["Spider", "Leapsa", "Ant", "Scrabber", "Twigger", "Wormthing"],
  };
  for (const [slug, names] of Object.entries(originalOrders)) {
    await page.locator("#loader-sort").selectOption(`classic31.trial.${slug}`);
    const options = await page.locator("#loader-list [role=option]").allTextContents();
    assert.ok(options.every((text, index) => text.startsWith(names[index])));
    await expect(page.locator('#loader-list [aria-selected="true"]')).toContainText("Ant");
    await expect(page.locator("#loader-sort-note")).toContainText("Historical metadata only");
  }
  await page.locator("#loader-list").focus();
  await page.keyboard.press("Home");
  await expect(page.locator('#loader-list [aria-selected="true"]')).toContainText("Spider");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('#loader-list [aria-selected="true"]')).toContainText("Leapsa");
  await accessibility("Loader result sorting");
  await shot("loader-results");
  await page.locator("#loader-tab-achievement").click();
  await expect(page.locator("#loader-preview dt")).toHaveText(["Sprint", "Block-Push", "Hurdles", "High jump", "Lap"]);
  await expect(page.locator("#loader-preview")).toContainText("Confirmed shipped example table");
  checks.push("Examples: confirmed source-table boundary and exact five-trial order/spelling");
  await page.locator("#loader-sort").selectOption("original");
  checks.push("Loader: all five historical result orders, retained selection and sorted keyboard navigation");
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
  await page.locator("#passport-command").click();
  await page.locator("#passport-tab-hologram").click();
  const passportPixels = await hologramPixels(page.locator("#passport-panel"), "Tutorial Walker", 9);
  await page.locator("#passport-tab-hologram").press("Tab");
  await expect(page.locator("#passport-panel")).toBeFocused();
  await accessibility("Passport Hologram");
  await shot("passport-hologram");
  for (let index = 0; index < 3; index += 1) {
    await page.locator("#passport-tab-history").click();
    await expect(page.locator("#passport-panel canvas")).toHaveCount(0);
    await page.locator("#passport-tab-hologram").click();
    assert.equal(await hologramPixels(page.locator("#passport-panel"), "Tutorial Walker", 9), passportPixels);
  }
  await page.locator("#passport-tab-history").click();
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      CanvasRenderingContext2D.prototype.drawImage = original;
      throw new Error("Simulated Hologram copy failure");
    };
  });
  await page.locator("#passport-tab-hologram").click();
  await expect(page.locator("#passport-panel .zook-hologram")).toHaveAttribute("data-hologram-state", "error");
  await expect(page.locator("#passport-panel")).toContainText("the Zook is unchanged");
  await page.locator("#passport-tab-hologram").click();
  assert.equal(await hologramPixels(page.locator("#passport-panel"), "Tutorial Walker", 9), passportPixels);
  await page.keyboard.press("Escape");
  await expect(page.locator("#passport-command")).toBeFocused();
  await expect(page.locator("#passport-panel canvas")).toHaveCount(0);
  assert.equal(await exportZook(), originalBytes);
  checks.push("Passport Hologram: bounded rendered pixels, keyboard focus, repeatable tab disposal, copy-failure recovery and unchanged canonical bytes");
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

  await page.locator("#loader-command").click();
  await page.locator("#loader-tab-hologram").click();
  const savedPixels = await hologramPixels(page.locator("#loader-preview"), "Tutorial Walker", 9);
  await accessibility("Saved Zook Hologram");
  await shot("loader-hologram");
  await page.locator("#loader-list [role=option]").filter({ hasText: "Tutorial Walker copy" }).click();
  assert.notEqual(await hologramPixels(page.locator("#loader-preview"), "Tutorial Walker copy", 9), savedPixels);
  await page.getByRole("button", { name: "Examples", exact: true }).click();
  await expect(page.locator("#loader-preview")).toContainText("legacy Zook body is not decoded");
  await expect(page.locator("#loader-preview canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await page.locator("#loader-list [role=option]").filter({ hasText: "Tutorial Walker" }).filter({ hasNotText: "copy" }).click();
  assert.equal(await hologramPixels(page.locator("#loader-preview"), "Tutorial Walker", 9), savedPixels);
  await module("motion-player");
  await expect(page.locator("#loader-preview canvas")).toHaveCount(0);
  await module("zook-kit");
  await hologramPixels(page.locator("#loader-preview"), "Tutorial Walker", 9);
  await page.locator("#loader-close").click();
  await expect(page.locator("#loader-preview canvas")).toHaveCount(0);
  assert.equal(await exportZook(), originalBytes);
  checks.push("Loader Hologram: saved selection renders its own geometry without opening, source/module/close disposal and preserved editor bytes");

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

  const result = (trialKey, value, unit = "cm/sec", resultClass = "provisional-play") => ({ trialKey, value, unit, resultClass });
  const fixtures = [
    sortingFixture({ ...named, metadata: { ...named.metadata, createdAt: "classic31:shipped-example", lineage: ["classic31.example.ant"] } }, "Sort Alpha", [result("classic31.trial.sprint", 30, "cm/sec", "historical-metadata"), result("classic31.provisional-play.v1.sprint", 100), result("classic31.provisional-play.v2.sprint", 5), result("classic31.provisional-play.v2.lap", 50, "sec")]),
    sortingFixture(named, "Sort Beta", [result("classic31.trial.sprint", 10, "cm/sec", "historical-metadata"), result("classic31.provisional-play.v2.sprint", 20), result("classic31.provisional-play.v2.lap", 30, "sec")]),
    sortingFixture(named, "Sort Gamma", [result("classic31.trial.sprint", 40, "m/sec", "historical-metadata"), result("classic31.trial.block-push", 99, "cm"), result("classic31.trial.high-jump", -1, "cm", "historical-metadata"), result("classic31.provisional-play.v1.sprint", 120), result("classic31.provisional-play.v2.sprint", 500, "cm/sec", "historical-metadata"), result("classic31.provisional-play.v3.sprint", 999)]),
  ];
  for (const fixture of fixtures) {
    await page.locator("#loader-command").click();
    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await page.locator("#loader-desktop-input").setInputFiles({ name: "sort-check.zook.json", mimeType: "application/json", buffer: Buffer.from(fixture) });
    await expect(page.locator("#zook-loader")).toBeHidden();
    await fileCommand("Save");
    await expect(page.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");
  }
  const savedFixtureBytes = await exportZook();
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("bamzooki-original-v31");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("zookIndex", "readwrite");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore("zookIndex");
        const request = store.getAll();
        request.onsuccess = () => {
          const alpha = request.result.find(({ name }) => name === "Sort Alpha");
          store.put({ ...alpha, passportResults: [{ trialKey: "classic31.provisional-play.v2.sprint", value: 999, unit: "cm/sec", resultClass: "provisional-play" }] });
        };
      });
    } finally { db.close(); }
  });
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await expect(page.locator("#loader-list [role=option]")).toHaveCount(6);
  await page.locator("#loader-list [role=option]").filter({ hasText: "Sort Alpha" }).click();
  await page.locator("#loader-tab-achievement").click();
  const sortedNames = async () => page.locator("#loader-list [role=option] strong").allTextContents();
  for (const [key, first] of [
    ["classic31.trial.sprint", ["Sort Alpha", "Sort Beta"]],
    ["classic31.provisional-play.v1.sprint", ["Sort Gamma", "Sort Alpha"]],
    ["classic31.provisional-play.v2.sprint", ["Sort Beta", "Sort Alpha"]],
    ["classic31.provisional-play.v2.lap", ["Sort Beta", "Sort Alpha"]],
  ]) {
    await page.locator("#loader-sort").selectOption(key);
    assert.deepEqual((await sortedNames()).slice(0, 2), first);
    await expect(page.locator('#loader-list [aria-selected="true"]')).toContainText("Sort Alpha");
    await expect(page.locator("#loader-tab-achievement")).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.locator("#loader-preview")).toContainText("Provisional Play v2");
  await expect(page.locator("#loader-preview")).toContainText("Legacy Provisional v1");
  await expect(page.locator("#loader-sort-note")).toContainText("Lowest first");
  await page.locator("#loader-tab-achievement").press("Tab");
  await expect(page.locator("#loader-preview")).toBeFocused();
  await accessibility("My Zooks result sorting");
  await shot("my-zooks-results");
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await expect(page.locator("#loader-sort")).toHaveValue("classic31.provisional-play.v2.lap");
  await expect(page.locator('#loader-list [aria-selected="true"]')).toContainText("Sort Alpha");
  await page.getByRole("button", { name: "Examples", exact: true }).click();
  await expect(page.locator("#loader-sort")).toHaveValue("original");
  await expect(page.locator("#loader-sort optgroup")).toHaveCount(1);
  await page.getByRole("button", { name: "Website Zooks", exact: true }).click();
  await expect(page.locator("#loader-sort")).toBeDisabled();
  await page.evaluate(() => {
    const nativeDigest = SubtleCrypto.prototype.digest;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    window.sortingReadGate = { release, blocked: false };
    SubtleCrypto.prototype.digest = function (...args) {
      SubtleCrypto.prototype.digest = nativeDigest;
      window.sortingReadGate.blocked = true;
      return Promise.all([Reflect.apply(nativeDigest, this, args), held]).then(([digest]) => digest);
    };
  });
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sortingReadGate.blocked)).toBe(true);
  await page.locator("#loader-list [role=option]").filter({ hasText: "Sort Gamma" }).click();
  await expect(page.locator("#loader-preview")).toContainText("5 retained record(s)");
  await expect(page.locator("#loader-list")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#loader-open")).toBeDisabled();
  await page.evaluate(() => { window.sortingReadGate.release(); delete window.sortingReadGate; });
  await expect(page.locator("#loader-list")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), savedFixtureBytes);
  checks.push("My Zooks: saved/reloaded score sets, stable selection and refresh, source reset, wrong-unit/class/version exclusion, forged-index rejection, held-validation Open guard and unchanged canonical bytes");

  await page.locator("#passport-command").click();
  await page.locator("#passport-tab-achievement").click();
  const achievementRow = (name) => page.locator(".passport-achievements li").filter({ has: page.getByText(name, { exact: true }) });
  await expect(achievementRow("Sprint")).toContainText("unit m/sec conflicts with evidenced cm/sec");
  await expect(achievementRow("Sprint")).toContainText("Namespaced Provisional record has conflicting metadata");
  await expect(achievementRow("Block-Push")).toContainText("declared class conflicts");
  await expect(achievementRow("High jump")).toContainText("invalid value");
  await expect(page.locator("#passport-panel")).toContainText("classic31.provisional-play.v3.sprint");
  await expect(page.locator("#passport-panel")).not.toContainText("Confirmed shipped metadata");
  await shot("passport-conflicting-records");
  await page.locator("#passport-close").click();
  assert.equal(await exportZook(), savedFixtureBytes);
  checks.push("Passport: wrong-unit/class/negative records remain uninterpreted; future records and canonical bytes preserved");

  await page.locator("#loader-command").click();
  await page.locator("#loader-list [role=option]").filter({ hasText: "Sort Alpha" }).click();
  await expect(page.locator("#loader-list")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  const declaredBytes = await exportZook();
  assert.equal(declaredBytes, fixtures[0]);
  await page.locator("#passport-command").click();
  await page.locator("#passport-tab-general").click();
  await expect(page.getByRole("textbox", { name: "Creation record" })).toHaveValue("Original-example stand-in (declared)");
  await expect(page.locator("#passport-panel")).toContainText("Imports do not verify authorship");
  await accessibility("Passport declared identity");
  await page.locator("#passport-tab-history").click();
  await expect(page.locator("#passport-panel")).toContainText("Original-example stand-in (declared)");
  await expect(page.locator("#passport-panel")).toContainText("classic31.example.ant");
  await expect(page.locator("#passport-panel")).toContainText("document-supplied");
  await accessibility("Passport declared lineage");
  await page.locator("#passport-tab-achievement").click();
  await expect(achievementRow("Sprint")).toContainText("30.0 cm/sec — declared historical metadata; not independently verified");
  await expect(achievementRow("Sprint")).toContainText("5.0 cm/sec — Provisional Play best");
  await expect(achievementRow("Sprint")).toContainText("100.0 cm/sec — preserved legacy Provisional v1");
  await expect(page.locator("#passport-panel")).not.toContainText("Confirmed shipped metadata");
  await page.locator("#passport-tab-achievement").press("Tab");
  await expect(page.locator("#passport-panel")).toBeFocused();
  await accessibility("Passport declared achievements");
  await shot("passport-declared-records");
  await page.keyboard.press("Escape");
  await expect(page.locator("#passport-command")).toBeFocused();
  assert.equal(await exportZook(), declaredBytes);
  checks.push("Passport: declared creation/lineage and separated result versions are never authenticated; canonical exports unchanged");
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
