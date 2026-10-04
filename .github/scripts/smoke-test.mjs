import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const require = createRequire(process.env.BROWSER_TEST_RUNTIME
  ? path.join(path.resolve(process.env.BROWSER_TEST_RUNTIME), "package.json") : import.meta.url);
const playwright = require("playwright");
const { expect } = require("playwright/test");
const { default: AxeBuilder } = require("@axe-core/playwright");
const engine = process.env.BROWSER_TEST_ENGINE ?? "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported browser test engine");
const suite = process.env.BROWSER_TEST_SUITE;
assert.ok(["contests", "editor", "trial-focus", "storage", "browser-recovery", "input-ownership"].includes(suite), "Unsupported browser test suite");
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
let visibilityExecutable;
if (suite === "input-ownership") {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Native window verification is confined to isolated hosted CI");
  const browserRuntimeRequire = createRequire(require.resolve("playwright/package.json"));
  assert.equal(require("playwright/package.json").version, "1.62.1", "Revalidate visibility adapters after a test-runtime upgrade");
  assert.equal(browserRuntimeRequire("playwright-core/package.json").version, "1.62.1", "The active browser driver must match the pinned runtime");
  if (engine === "firefox") {
    // Juggler has no protocol switch for its forced-active docshell. Adapt only
    // its two foreground defaults in a disposable copy, not the browser cache.
    const executable = playwright.firefox.executablePath();
    const adapterRoot = await mkdtemp(path.join(tmpdir(), "bamzooki-visibility-"));
    const browserCopy = path.join(adapterRoot, "firefox");
    await cp(path.dirname(executable), browserCopy, { recursive: true });
    visibilityExecutable = path.join(browserCopy, path.basename(executable));
    execFileSync("python3", ["-c", String.raw`
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
matches = []
for archive in (root / "omni.ja", root / "browser" / "omni.ja"):
    if not archive.is_file():
        continue
    with zipfile.ZipFile(archive) as source:
        for entry in source.namelist():
            if entry.endswith("juggler/content/content/main.js"):
                matches.append((archive, entry, source.read(entry)))
assert len(matches) == 1, "Expected one pinned Juggler content initializer"
archive, entry, original = matches[0]
adapted = original
for before in (b"docShell.overrideHasFocus = true;", b"docShell.forceActiveState = true;"):
    assert adapted.count(before) == 1, "Pinned Juggler foreground default changed"
    adapted = adapted.replace(before, before.replace(b"true;", b"false;"))
replacement = archive.with_suffix(".visibility-adapter")
with zipfile.ZipFile(archive) as source, zipfile.ZipFile(replacement, "w") as target:
    for info in source.infolist():
        target.writestr(info, adapted if info.filename == entry else source.read(info))
with zipfile.ZipFile(archive) as source, zipfile.ZipFile(replacement) as target:
    assert source.namelist() == target.namelist(), "Adapter changed archive membership"
    for name in source.namelist():
        assert target.read(name) == (adapted if name == entry else source.read(name)), "Unexpected browser archive change"
replacement.replace(archive)
print("Disposable Firefox adapter: only Juggler foreground defaults disabled")
`, browserCopy], { stdio: "inherit", timeout: 30_000 });
  }
}
// The hosted runner has no physical GPU. Firefox needs an X display and an
// explicit software-WebGL test profile. The visibility suite also needs a
// headed Chromium software driver; neither setting enters the game.
const browser = await playwright[engine].launch({
  headless: engine !== "firefox" && suite !== "input-ownership",
  ...(visibilityExecutable ? { executablePath: visibilityExecutable } : {}),
  ...(engine === "chromium" && suite === "input-ownership"
    ? { args: ["--use-gl=angle", "--use-angle=swiftshader"] } : {}),
  ...(engine === "firefox" ? { firefoxUserPrefs: {
    "webgl.force-enabled": true,
    "webgl.disable-fail-if-major-performance-caveat": true,
    ...(suite === "input-ownership" ? { "layout.testing.top-level-always-active": false } : {}),
  } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const failures = [];
const checks = [];
const errors = [];
const journeyStartedAt = Date.now();
const reportProgress = (stage) => console.log(
  `${engine}: ${stage}; ${checks.length} completed checks; ${Math.round((Date.now() - journeyStartedAt) / 1000)}s elapsed`,
);
const recordCheck = (name) => {
  checks.push(name);
  reportProgress(name);
};
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
const shot = async (name) => {
  reportProgress(`Screenshot ${name}: start`);
  // Control text updates before the canvas's next render; observe two frames
  // so a newly selected camera and its captured scene describe the same state.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, `${engine}-${name}.png`), fullPage: true });
  reportProgress(`Screenshot ${name}: saved`);
};
const module = async (name) => {
  await page.locator("#modules-command").click();
  await page.locator(`#module-launcher [data-suite-module="${name}"]`).click();
  // Module activation closes the chooser only after its asynchronous library
  // refresh. The shell label alone can precede validated replay availability.
  await page.locator("#module-launcher").waitFor({ state: "hidden" });
  await expect(page.locator(".shell")).toHaveAttribute("data-module", name);
};
const accessibility = async (name) => {
  reportProgress(`${name}: accessibility start`);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const violations = results.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) }));
  assert.deepEqual(violations, [], `${name} accessibility checks`);
  recordCheck(`${name}: automated accessibility`);
};
const keyboardFocus = async (control) => {
  await expect(control).toBeFocused();
  const focus = await control.evaluate(element => {
    const style = getComputedStyle(element);
    return { id: element.id, visible: element.matches(":focus-visible"), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  assert.ok(focus.visible && focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) >= 2,
    `Keyboard focus must have a visible outline: ${JSON.stringify(focus)}`);
};
const keyboardNavigate = async (control) => {
  // Programmatic locator focus after a pointer click does not establish the
  // same focus-visible modality as actual keyboard navigation in every engine.
  await expect(control).toBeEnabled();
  if (await control.evaluate(element => element === document.activeElement && !element.matches(":focus-visible"))) {
    await page.keyboard.press("Shift+Tab");
  }
  const trail = [];
  for (let index = 0; index < 120; index += 1) {
    const state = await control.evaluate(element => {
      const active = document.activeElement;
      return { reached: element === active, active: active?.id || active?.tagName || "none",
        documentFocused: document.hasFocus(), activeFocused: active?.matches(":focus") ?? false,
        activeDisabled: active?.matches(":disabled") ?? false,
        reverse: active !== null && active !== document.body && Boolean(element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    if (state.reached) {
      await keyboardFocus(control);
      return;
    }
    const key = state.reverse ? "Shift+Tab" : "Tab";
    trail.push({ ...state, key });
    await page.keyboard.press(key);
    // Observe the next rendering opportunity before issuing another native
    // traversal key; a tight protocol loop is not a human keyboard journey.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  throw new Error(`Keyboard action is unreachable after 120 Tab steps: ${JSON.stringify(trail.slice(-20))}`);
};
const keyboardActivate = async (control) => {
  await keyboardNavigate(control);
  await page.keyboard.press("Enter");
};

const trialFocusJourney = async () => {
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-tutorial").click();
  await expect(page.locator("#part-summary")).toHaveText("9 parts");
  await page.locator("#mode-test").click();
  await page.locator("#test-trial").selectOption("classic31.trial.block-push");
  const run = page.locator("#provisional-trial-run");
  const stop = page.locator("#provisional-trial-stop");
  const reset = page.locator("#provisional-trial-reset");
  const retain = page.locator("#provisional-trial-retain");
  const status = page.locator("#provisional-trial-status");
  await keyboardActivate(run);
  await expect(status).toContainText("Running Block-Push");
  await keyboardFocus(stop);
  await page.keyboard.press("Enter");
  await expect(status).toContainText("no retainable result");
  await keyboardFocus(run);
  await keyboardActivate(reset);
  await expect(status).toContainText("reset and ready");
  await keyboardFocus(reset);
  recordCheck("Trial focus: keyboard Run, Stop and Reset hand off to an enabled, visibly focused control");

  await keyboardActivate(run);
  await keyboardFocus(stop);
  // This is an ordinary twenty-second fixed-tick trial, not a diagnostics jump.
  // Keep the existing full-contest completion ceiling on software rendering.
  await expect(status).toContainText("Result ready:", { timeout: 120_000 });
  await keyboardFocus(retain);
  await shot("trial-result-focus");
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Retained:");
  await expect(retain).toBeDisabled();
  await keyboardFocus(run);
  recordCheck("Trial focus: ordinary automatic completion focuses Retain and retaining returns focus to Run");

  await keyboardActivate(run);
  await expect(status).toContainText("Running Block-Push");
  await keyboardFocus(stop);
  await keyboardNavigate(page.locator("#camera-follow"));
  await expect(status).toContainText("Retained:", { timeout: 120_000 });
  await expect(stop).toBeDisabled();
  await keyboardFocus(page.locator("#camera-follow"));
  await shot("trial-nonstealing-focus");
  recordCheck("Trial focus: repeated automatic completion leaves a different keyboard-owned control focused");
  // Retained results belong only to this unsaved CI document; never press Save.
};

const attachmentFocusPreflight = async () => {
  // Isolate native pointer -> reverse-Tab behavior before the long replay route.
  // These disposable pages never save a creature or access the player's data.
  const probe = await context.newPage();
  probe.setDefaultTimeout(20_000);
  const observations = [];
  const instrument = async () => probe.evaluate(() => {
    const events = [];
    window.addEventListener("keydown", event => {
      events.push({ key: event.key, code: event.code, shift: event.shiftKey,
        prevented: event.defaultPrevented, trusted: event.isTrusted,
        target: event.target.id || event.target.tagName });
      if (events.length > 16) events.shift();
    });
    window.focusProbeEvents = events;
  });
  const observe = async label => observations.push({ label, ...await probe.evaluate(() => {
    const selection = getSelection();
    const nodeLabel = node => node?.nodeType === Node.TEXT_NODE
      ? `text:${node.parentElement?.id || node.parentElement?.tagName}`
      : node?.id || node?.nodeName || null;
    return { active: document.activeElement?.id, focused: document.hasFocus(),
      selection: { anchor: nodeLabel(selection?.anchorNode), offset: selection?.anchorOffset,
        focus: nodeLabel(selection?.focusNode), collapsed: selection?.isCollapsed },
      events: [...window.focusProbeEvents] };
  }) });
  try {
    for (const variant of ["native", "prevent-shift", "unselectable", "passive-label"]) {
      await probe.setContent('<input id="previous" type="number"><button id="apply">Apply position and facing</button><button id="next">Next</button>');
      await probe.evaluate(variant => {
        const button = document.querySelector("#apply");
        button.addEventListener("click", () => {
          button.disabled = true;
          requestAnimationFrame(() => { button.disabled = false; button.focus(); });
        });
        if (variant === "prevent-shift") window.addEventListener("keydown", event => {
          if (event.code === "ShiftLeft") event.preventDefault();
        }, { once: true });
        if (variant === "unselectable") button.style.setProperty("-webkit-user-select", "none");
        if (variant === "passive-label") {
          const label = document.createElement("span");
          label.textContent = button.textContent;
          label.style.pointerEvents = "none";
          button.replaceChildren(label);
        }
      }, variant);
      await instrument();
      await probe.locator("#previous").fill("-25");
      await probe.locator("#apply").click();
      await expect(probe.locator("#apply")).toBeEnabled({ timeout: 20_000 });
      await observe(`${variant}: pointer Apply`);
      await probe.keyboard.press("Shift+Tab");
      await observe(`${variant}: reverse Tab`);
      if (variant === "passive-label") await expect(probe.locator("#previous")).toBeFocused();
    }
    await probe.goto(`${origin}${prefix}`);
    await expect(probe.locator("#app")).toHaveAttribute("aria-busy", "false");
    await probe.locator("#loader-open").click();
    await expect(probe.locator("#zook-loader")).toBeHidden();
    await probe.locator("#mode-add").click();
    await probe.getByRole("button", { name: "Left", exact: true }).click();
    await expect(probe.locator("#part-summary")).toHaveText("2 parts");
    await instrument();
    await probe.locator("#attachment-facing-roll").fill("-24");
    await probe.keyboard.press("Tab");
    await expect(probe.locator("#attachment-apply")).toBeFocused();
    await probe.keyboard.press("Enter");
    await expect(probe.locator("#attachment-apply")).toBeEnabled({ timeout: 20_000 });
    await expect(probe.locator("#attachment-apply")).toBeFocused();
    await probe.locator("#attachment-facing-roll").fill("-25");
    await probe.locator("#attachment-apply").click();
    await expect(probe.locator("#attachment-apply")).toBeEnabled({ timeout: 20_000 });
    await observe("game: pointer Apply");
    await probe.keyboard.press("Shift+Tab");
    await observe("game: reverse Tab");
    await expect(probe.locator("#attachment-facing-roll")).toBeFocused();
    recordCheck("Attachment preflight: keyboard Apply retains focus and pointer Apply permits native reverse Tab to Roll");
  } finally {
    await writeFile(path.join(output, `${engine}-attachment-focus.json`), `${JSON.stringify(observations, null, 2)}\n`);
    await probe.screenshot({ path: path.join(output, `${engine}-attachment-focus.png`) }).catch(() => {});
    await probe.close();
  }
};
const fileCommand = async (name, target = page) => {
  await target.locator("#file-system-command").click();
  await target.getByRole("dialog", { name: "File / system" }).getByRole("button", { name, exact: true }).click();
};
const exportZook = async (target = page) => {
  const downloaded = target.waitForEvent("download");
  await fileCommand("Export", target);
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const exportReplay = async () => {
  const downloaded = page.waitForEvent("download");
  await page.locator("#motion-export").click();
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const cameraGestures = async (kind) => {
  const simulator = kind === "simulator";
  const canvas = page.locator(simulator ? "#simulator-arena-canvas" : "#motion-canvas");
  const previews = page.locator(simulator ? "#simulator-camera-preview-canvas" : "#motion-camera-preview-canvas");
  const neutralControl = page.locator("#modules-command");
  const button = (id) => page.locator(`[data-${simulator ? "simulator" : "motion"}-camera="camera-${id}"]`);
  const observations = [];
  const pixels = async (element, name) => {
    // Compare the same focus/hover state; the canvas focus ring and miniature
    // button overlays are intentional accessibility UI, not camera movement.
    await neutralControl.focus();
    await neutralControl.hover();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const buffer = await element.screenshot({
      ...(name === undefined ? {} : { path: path.join(output, `${engine}-${kind}-${name}.png`) }),
      // Motion labels overlay the canvas. Chromium can repaint their rounded
      // edges differently after a label update; compare the camera image only.
      // Full-page screenshots retain the original, unmodified DOM labels.
      style: "#motion-main-label, #motion-stage-tick, #motion-stage-participants { visibility: hidden !important; }",
    });
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (name !== undefined) {
      observations.push({ name, hash, surface: await element.evaluate((canvas) => ({
        width: canvas.width, height: canvas.height,
        rect: canvas.getBoundingClientRect().toJSON(),
        scrollTop: canvas.closest(".module-surface").scrollTop,
        tick: document.querySelector("#motion-time").textContent,
        focus: document.activeElement.id,
      })) });
      await writeFile(path.join(output, `${engine}-${kind}-camera-observations.json`),
        JSON.stringify(observations, null, 2));
    }
    return hash;
  };
  const drag = async (element, zoom) => {
    await element.scrollIntoViewIfNeeded();
    const bounds = await element.boundingBox();
    assert.ok(bounds, "Camera surface must be measurable");
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x + 24, y + 8, { steps: 3 });
    if (zoom) await page.mouse.wheel(0, -120);
    await page.mouse.up({ button: "right" });
  };
  await button(1).click();
  await canvas.press("Home");
  const mainDefault = await pixels(canvas, "main-default");
  await drag(canvas, false);
  const mainRotated = await pixels(canvas);
  assert.notEqual(mainRotated, mainDefault, "Main right-drag must visibly rotate the view");
  await canvas.hover();
  await page.mouse.wheel(0, -120);
  assert.notEqual(await pixels(canvas), mainRotated, "Main wheel must visibly zoom without a held button");
  await shot(`${kind}-main-camera-adjusted`);
  await canvas.press("Home");
  assert.equal(await pixels(canvas, "main-after-home"), mainDefault, "Home must restore the exact default main view");
  const miniatureDefault = await pixels(previews);
  await button(3).hover();
  await page.mouse.wheel(0, -100);
  assert.equal(await pixels(previews), miniatureDefault, "Unmodified miniature wheel must not zoom");
  await drag(button(3), true);
  await expect(button(1)).toHaveAttribute("aria-pressed", "true");
  assert.equal(await pixels(canvas, "main-after-miniature"), mainDefault, "Non-selected miniature must not change the main view");
  assert.notEqual(await pixels(previews), miniatureDefault, "Miniature right-drag/wheel must change its view");
  await shot(`${kind}-miniature-camera-adjusted`);
  await button(3).press("Home");
  assert.equal(await pixels(previews), miniatureDefault, "Miniature Home must restore exact default views");
  await button(2).click();
  const autoFit = await pixels(canvas);
  await canvas.hover();
  await page.mouse.wheel(0, -120);
  await button(2).hover();
  await page.mouse.down({ button: "right" });
  await page.mouse.wheel(0, -120);
  await page.mouse.up({ button: "right" });
  await button(2).press("+");
  assert.equal(await pixels(canvas), autoFit, "Camera 2 must keep its automatic distance on every zoom input");
  await canvas.press("ArrowLeft");
  assert.notEqual(await pixels(canvas), autoFit, "Camera 2 must still support focused keyboard orbit");
  await canvas.press("Home");
  assert.equal(await pixels(canvas), autoFit, "Camera 2 orbit resets exactly");
  await button(1).click();
  recordCheck(`${kind}: main/miniature right-drag and wheel, independent views, Camera 2 auto-fit, keyboard orbit and exact Home reset`);
};
const replayTimelineGestures = async () => {
  const timeline = page.locator("#motion-timeline");
  const play = page.locator("#motion-play");
  const loop = page.locator("#motion-loop");
  await loop.check();
  await timeline.press("Home");
  await timeline.scrollIntoViewIfNeeded();
  const bounds = await timeline.boundingBox();
  assert.ok(bounds, "Replay timeline must be measurable");
  const x = bounds.x + bounds.width / 2;
  const holdAtMiddle = async () => {
    await page.mouse.move(x, bounds.y + bounds.height - 8);
    await page.mouse.down();
    await page.mouse.move(x, bounds.y + bounds.height / 2, { steps: 4 });
    await expect(play).toHaveText("Play");
    const value = await timeline.inputValue();
    assert.ok(Number(value) > 0 && Number(value) < Number(await timeline.getAttribute("max")),
      "Dragging must select an interior authoritative sample");
    await page.waitForTimeout(250);
    await expect(timeline).toHaveValue(value);
    return value;
  };
  const chosen = await holdAtMiddle();
  await page.mouse.move(x + 60, bounds.y + bounds.height / 2);
  await page.mouse.up();
  await expect(play).toHaveText("Pause");
  await expect.poll(() => timeline.inputValue()).not.toBe(chosen);
  await shot("motion-player-timeline-release-playing");
  await timeline.press("Home");
  await expect(timeline).toHaveValue("0");
  await expect(play).toHaveText("Play");
  const interrupted = await holdAtMiddle();
  await page.locator("#motion-eject").press("Enter");
  await expect(page.locator("#motion-eject-menu")).toBeVisible();
  await page.mouse.up();
  await page.locator("#motion-eject-resume").click();
  await expect(play).toHaveText("Play");
  await expect(timeline).toHaveValue(interrupted);
  await loop.uncheck();
  await page.mouse.click(x, bounds.y + 1);
  await expect(timeline).toHaveValue(await timeline.getAttribute("max"));
  await expect(play).toHaveText("Play");
  await loop.check();
  await page.mouse.click(x, bounds.y + 1);
  await expect(play).toHaveText("Pause");
  await expect.poll(() => timeline.inputValue()).not.toBe(await timeline.getAttribute("max"));
  await timeline.press("Home");
  await expect(play).toHaveText("Play");
  recordCheck("Motion Player: exact held sample, release continues, keyboard stays paused, modal cancels resume and endpoints honor Loop");
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

// Synthetic compatibility fixtures exercise old browser profiles, not original replays.
const priorHurdlesFixture = (base, version) => {
  const bands = [
    ["narrow-cubes", [47, 48, 49, 51, 52, 53, 54, 55, 56, 57, 58]],
    ["capsules", [80, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92]],
    ["broad-cubes", [22, 71, 72, 73, 74, 75, 76, 77, 79]],
    ["spheres", [10, 11, 12, 13, 14, 16, 17, 18, 19]],
    ["cylinders", [23, 24, 25, 26, 27, 28, 29, 30, 31]],
  ];
  const ids = new Map(bands.flatMap(([name, members]) => members.map((id, index) =>
    [`hurdles-agent-${id}`, `hurdles-${name}-${String(index + 1).padStart(2, "0")}`])));
  const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : value;
  const signed = (value) => {
    const { checksum: _checksum, ...payload } = value;
    return { ...payload, checksum: createHash("sha256").update(JSON.stringify(ordered(payload))).digest("hex") };
  };
  const replay = structuredClone(base);
  // These fixtures test profile routing at the start pose. The real v4
  // recording above keeps every sample through automatic completion.
  replay.keyframes = replay.keyframes.slice(0, 2);
  assert.equal(replay.keyframes.length, 2);
  replay.durationTicks = replay.keyframes.at(-1).tick;
  replay.commands = replay.commands.filter(({ command }) => command.tick <= replay.durationTicks);
  replay.title = `Synthetic Hurdles browser profile v${version}`;
  replay.arena.profileId = `classic31-provisional-super-hurdles-play-v${version}`;
  if (version <= 2) {
    replay.arena.movingObjectIds = [...ids.values()].sort((a, b) => a.localeCompare(b));
    replay.keyframes = replay.keyframes.map((frame) => signed({
      ...frame, arenaPoses: frame.arenaPoses.map((pose) => ({ ...pose, id: ids.get(pose.id) })).sort((a, b) => a.id.localeCompare(b.id)),
    }));
  }
  return JSON.stringify(ordered(signed(replay)));
};

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => v.map(value => value / Math.hypot(...v));
const projectEditorPoint = (box, point) => {
  const eye = [5.4, 3.6, 6.6], target = [0, 0.65, 0];
  const back = normalize(eye.map((value, index) => value - target[index]));
  const right = normalize(cross([0, 1, 0], back)), up = cross(back, right);
  const relative = point.map((value, index) => value - eye[index]);
  const depth = -dot(relative, back), tangent = Math.tan(17 * Math.PI / 180);
  assert.ok(depth > 0);
  return { x: box.x + box.width / 2 + dot(relative, right) * box.height / (2 * depth * tangent),
    y: box.y + box.height / 2 - dot(relative, up) * box.height / (2 * depth * tangent) };
};
const partWorldPoint = (document, id, local) => {
  let point = [...local];
  for (let part = document.parts.find(p => p.id === id); part; part = document.parts.find(p => p.id === part.parentId)) {
    const { translation: t, rotation: q, scale: s } = part.localTransform;
    const v = point.map((value, index) => value * [s.x, s.y, s.z][index]);
    const first = cross([q.x, q.y, q.z], v), second = cross([q.x, q.y, q.z], first);
    point = v.map((value, index) => value + 2 * q.w * first[index] + 2 * second[index] + [t.x, t.y, t.z][index]);
  }
  return point;
};
const startBoundsDrag = async (model, partId, axis, increase = 0.5) => {
  const dimensions = ["widthMeters", "heightMeters", "lengthMeters"];
  const part = model.parts.find(p => p.id === partId);
  const start = [0, 0, 0]; start[axis] = part.selection.halfExtentsMeters[["x", "y", "z"][axis]] * 1.04;
  const end = [...start]; end[axis] += increase * 1.04 / 2;
  const box = await page.locator("#game-canvas").boundingBox();
  const from = projectEditorPoint(box, partWorldPoint(model, partId, start));
  const to = projectEditorPoint(box, partWorldPoint(model, partId, end));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await expect(page.locator("#build-status")).toContainText(`Reshaping ${["Width", "Height", "Length"][axis]}`);
  await page.mouse.move(to.x, to.y, { steps: 3 });
  const input = page.locator(`#shape-${["width", "height", "length"][axis]}`);
  await expect.poll(async () => Math.abs(Number(await input.inputValue()) - part.shape[dimensions[axis]] - increase)).toBeLessThan(0.03);
};

const prepareLibraryJourney = async () => {
  await attachmentFocusPreflight();
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
  recordCheck("Examples: confirmed source-table boundary and exact five-trial order/spelling");
  await page.locator("#loader-sort").selectOption("original");
  recordCheck("Loader: all five historical result orders, retained selection and sorted keyboard navigation");
  await page.locator("#loader-tutorial").click();
  await expect(page.locator("#part-summary")).toHaveText("9 parts");
  await page.locator("#mode-test").click();
  await page.locator("#test-target-x").fill("2");
  await page.locator("#test-target-z").fill("3");
  await page.locator("#test-target-set").click();
  await expect(page.locator("#test-target-value")).not.toHaveText("Not placed");
  await shot("tutorial-test");
  await page.locator("#mode-select").click();
  recordCheck("Tutorial Walker: nine articulated parts, Test target, Select return");

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
  recordCheck("Passport Hologram: bounded rendered pixels, keyboard focus, repeatable tab disposal, copy-failure recovery and unchanged canonical bytes");
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
  recordCheck("Save As: keyboard focus, unchanged-name rejection and byte-identical cancellation");

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
  recordCheck("Save As: interrupted storage leaves canonical editor bytes and original record intact");

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
  recordCheck("Save As: reversible name, independent subsequent Save, two-entry reload and byte-identical original");

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
  recordCheck("Loader Hologram: saved selection renders its own geometry without opening, source/module/close disposal and preserved editor bytes");
  return { originalBytes, changedCopyBytes };
};

const contestReplayJourney = async ({ originalBytes }) => {
  await module("simulator");
  const savedZook = page.locator("#simulator-zook-1 option").filter({ hasText: "Tutorial Walker — My Zooks (9 parts)" });
  await expect(savedZook).toHaveCount(1);
  await page.locator("#simulator-zook-1").selectOption(await savedZook.getAttribute("value"));
  await page.locator("#simulator-zook-2").selectOption("tutorial");
  recordCheck("Saved My Zooks entry selectable independently from tutorial opponent");
  const contests = page.locator("#simulator-contest-list button");
  await expect(contests).toHaveCount(9);
  await accessibility("Simulator setup");
  await cameraGestures("simulator");
  const saved = [];
  for (let index = 0; index < 9; index += 1) {
    await contests.nth(index).click();
    const name = (await contests.nth(index).innerText()).replaceAll("\n", " ");
    for (const button of await page.locator("button[data-simulator-camera]").all()) await button.click();
    if (index === 8) {
      await expect(page.locator("#simulator-scene-evidence")).toContainText("49 visible solid obstacle records retain their individual");
      await page.locator('button[data-simulator-camera="camera-3"]').click();
      await shot("hurdles-individual-setup");
    }
    if (index === 0) {
      await page.locator("#simulator-start").press("Enter");
      await expect(page.locator("#simulator-stop")).toBeFocused();
      recordCheck("Simulator: keyboard Start hands focus to enabled Stop");
    } else await page.locator("#simulator-start").click();
    await expect.poll(async () => await page.locator("#simulator-save-dialog").isVisible() ||
      Number.parseFloat(await page.locator("#simulator-time").innerText()) >= 0.5, { timeout: 40_000 }).toBe(true);
    if (index === 5 || index === 6 || index === 8) await shot(`contest-${index}`);
    if ([5, 6, 8].includes(index)) {
      reportProgress(`${name}: waiting for automatic contest completion`);
      await expect(page.locator("#simulator-save-dialog")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator("#simulator-save-status")).toContainText("No winner is assigned");
      await shot(`contest-${index}-automatic-end`);
    }
    if (await page.locator("#simulator-stop").isVisible()) {
      await page.locator("#simulator-stop").click().catch(async (error) => {
        if (!await page.locator("#simulator-save-dialog").isVisible()) throw error;
      });
    }
    await expect(page.locator("#simulator-save-dialog")).toBeVisible();
    await expect(page.locator("#simulator-replay-name")).toHaveValue(
      `${name.replace(/ Round [12]$/, "")} — Tutorial Walker Vs Tutorial Walker`,
    );
    if ([3, 5, 6, 8].includes(index)) {
      const title = `Browser check ${index}`;
      await page.locator("#simulator-replay-name").fill(title);
      await page.locator("#simulator-save").click();
      saved.push({ title, index });
    } else await page.locator("#simulator-dont-save").click();
    await expect(page.locator("#simulator-save-dialog")).toBeHidden();
    await expect(page.locator("#simulator-start")).toBeEnabled();
    recordCheck(`${name}: countdown, live physics, four cameras, Stop, save/discard`);
  }

  await module("motion-player");
  await page.locator("#motion-refresh").press("Enter");
  // Refresh revalidates full recordings. Use the ordinary action budget, not
  // the matcher's shorter default; hardware timing is a separate gate.
  await expect(page.locator("#motion-refresh")).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator("#motion-refresh")).toBeFocused();
  recordCheck("Motion Player: asynchronous Refresh returns operation-owned keyboard focus");
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
    await expect(page.locator("#motion-timeline")).toHaveValue(await page.locator("#motion-timeline").getAttribute("max"));
    await page.locator("#motion-timeline").press("Home");
    await expect(page.locator("#motion-timeline")).toHaveValue("0");
    await page.locator("#motion-timeline").press("End");
    await expect(page.locator("#motion-timeline")).toHaveValue(await page.locator("#motion-timeline").getAttribute("max"));
    for (const button of await page.locator("button[data-motion-camera]").all()) await button.click();
    if (index === 6) await shot("arena-replay");
    if (index === 8) await shot("hurdles-individual-replay");
    const replayBytes = await exportReplay();
    if (index === 3) {
      await cameraGestures("motion-player");
      await replayTimelineGestures();
      assert.equal(await exportReplay(), replayBytes, "Camera and timeline manipulation must not change any exported replay byte");
    }
    const replay = JSON.parse(replayBytes);
    assert.equal(replay.schemaVersion, 2);
    assert.equal(replay.participants.length, 2);
    assert.ok(replay.participants.every(({ zook }) => zook.parts.length === 9));
    const count = replay.arena.movingObjectIds.length + replay.arena.dynamicObjectIds.length;
    assert.equal(count, index === 3 ? 1 : index === 5 ? 58 : index === 8 ? 49 : 61);
    if (index === 5 || index === 6) {
      assert.equal(replay.arena.profileId, index === 5 ? "classic31-provisional-marbles-play-v3" : "classic31-provisional-smash-play-v3");
    }
    if (index === 8) {
      assert.equal(replay.arena.profileId, "classic31-provisional-super-hurdles-play-v4");
      assert.ok(replay.arena.movingObjectIds.every((id) => /^hurdles-agent-\d+$/.test(id)));
      const cylinder25 = replay.keyframes[0].arenaPoses.find(({ id }) => id === "hurdles-agent-25");
      assert.equal(cylinder25.translation.y, Math.fround(Math.fround(0.3 * 0.08) + Math.fround(-1.5 * 0.08)));
      const canvasHash = async () => {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return createHash("sha256").update(await page.locator("#motion-canvas").screenshot()).digest("hex");
      };
      await page.locator("#motion-loop").uncheck();
      await page.locator("#motion-timeline").press("Home");
      await page.locator('button[data-motion-camera="camera-3"]').click();
      await expect(page.locator("#motion-timeline")).toHaveValue("0");
      await shot("hurdles-current-profile-start");
      const currentPixels = await canvasHash();
      let legacyPixels;
      for (const version of [1, 2, 3, 4]) {
        if (version === 4) {
          await page.locator("#motion-replay-library").selectOption(await option.getAttribute("value"));
          await page.locator("#motion-load").click();
        } else {
          const data = priorHurdlesFixture(replay, version);
          await page.locator("#motion-open-input").setInputFiles({ name: "compatibility.bamz-replay.json", mimeType: "application/json", buffer: Buffer.from(data) });
        }
        // Camera controls are disabled until validation, storage and refresh
        // complete. Use normal actionability before inspecting the new title.
        await page.locator('button[data-motion-camera="camera-3"]').click();
        await expect(page.locator("#motion-replay-title")).toHaveText(version === 4 ? title : `Synthetic Hurdles browser profile v${version}`);
        await page.locator("#motion-timeline").press("Home");
        await expect(page.locator("#motion-timeline")).toHaveValue("0");
        reportProgress(`Hurdles profile v${version}: rendered geometry comparison`);
        if (version === 1) {
          legacyPixels = await canvasHash();
          assert.notEqual(legacyPixels, currentPixels, "Legacy Hurdles geometry must differ from the current course");
          await shot("hurdles-legacy-replay");
        } else {
          if (version === 3) await shot("hurdles-prior-profile-start");
          assert.equal(await canvasHash(), version === 2 ? legacyPixels : currentPixels,
            `Hurdles profile v${version} must render the expected geometry at tick zero`);
        }
      }
      assert.equal(replay.outcome, null);
      assert.ok(replay.keyframes.every((frame) => frame.participants.every(({ snapshot }) =>
        snapshot.bodies.every(({ translation }) => Object.values(translation).every((value) => Math.abs(value) <= 1000)))));
      recordCheck("Hurdles: automatic end, bounded replay and same-scene v4/v1/v2/v3/v4 geometry switches");
    }
    assert.ok(replay.durationTicks >= 30);
    assert.ok(replay.keyframes.every((frame) => frame.arenaPoses.length === count));
    assert.notDeepEqual(replay.keyframes.at(-1).arenaPoses, replay.keyframes[0].arenaPoses);
    recordCheck(`${title}: persisted arena replay, transport, scrub, cameras, complete exported object tracks`);
  }
  await accessibility("Motion Player");
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await module("motion-player");
  await expect(page.locator("#motion-replay-library option")).toHaveCount(7);
  recordCheck("Replay library survives a browser-page reload");
  await reopenSavedOriginal(originalBytes);
  recordCheck("Contest/replay handoff: return to Zook Kit opens the byte-identical saved original");
};

const reopenSavedOriginal = async (originalBytes) => {
  await module("zook-kit");
  await page.locator("#loader-command").click();
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  const storedOriginal = () => page.locator("#loader-list [role=option]")
    .filter({ hasText: "Tutorial Walker" }).filter({ hasNotText: "copy" });
  await storedOriginal().click();
  await page.locator("#loader-open").click();
  await expect(page.locator("#zook-loader")).toBeHidden();
  assert.equal(await exportZook(), originalBytes);
  return storedOriginal;
};

const editorFileJourney = async ({ originalBytes, changedCopyBytes }) => {
  const storedOriginal = await reopenSavedOriginal(originalBytes);
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
  recordCheck("New: focused naming, invalid-name recovery and byte-identical cancellation at both prompts");

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
  recordCheck("Save before New: storage failure prevents replacement and preserves dirty canonical bytes");

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
  recordCheck("Save before Open: original saved in place and captured copy target preserved through library refresh");

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
  recordCheck("Open: invalid import after Don't Save preserves current bytes and undo history");

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
  recordCheck("New: save-then-cancel retains current Zook; normalized named creation saves separately and survives reload");

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
  recordCheck("My Zooks: saved/reloaded score sets, stable selection and refresh, source reset, wrong-unit/class/version exclusion, forged-index rejection, held-validation Open guard and unchanged canonical bytes");

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
  recordCheck("Passport: wrong-unit/class/negative records remain uninterpreted; future records and canonical bytes preserved");

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
  recordCheck("Passport: declared creation/lineage and separated result versions are never authenticated; canonical exports unchanged");

  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-close").click();
  const rootBefore = await exportZook();
  const rootModel = JSON.parse(rootBefore);
  await startBoundsDrag(rootModel, rootModel.rootPartId, 0, 0);
  await page.mouse.up();
  assert.equal(await exportZook(), rootBefore);
  await expect(page.locator("#undo-command")).toBeDisabled();
  for (const axis of [0, 1, 2]) {
    await startBoundsDrag(rootModel, rootModel.rootPartId, axis);
    await expect(page.locator("#undo-command")).toBeDisabled();
    if (axis === 0) await shot("bounds-reshape-preview");
    await page.mouse.up();
    await expect(page.locator("#editor-announcement")).toHaveText("Reshape blob complete");
    const committed = await exportZook();
    assert.notEqual(committed, rootBefore);
    await page.locator("#undo-command").press("Enter");
    await expect(page.locator("#undo-command")).toBeDisabled();
    await expect(page.locator("#redo-command")).toBeFocused();
    assert.equal(await exportZook(), rootBefore);
    await page.locator("#redo-command").press("Enter");
    await expect(page.locator("#undo-command")).toBeFocused();
    assert.equal(await exportZook(), committed);
    await page.locator("#undo-command").press("Enter");
  }
  recordCheck("Bounds reshape: all three root axes, synchronized preview, one-command Undo and byte-identical Redo");
  for (const cancellation of ["escape", "focus", "capture", "resize"]) {
    const canvas = page.locator("#game-canvas");
    await canvas.evaluate(element => element.addEventListener("pointerdown", event => {
      element.dataset.testPointer = String(event.pointerId);
    }, { once: true }));
    await startBoundsDrag(rootModel, rootModel.rootPartId, 0);
    if (cancellation === "escape") await page.keyboard.press("Escape");
    if (cancellation === "focus") await page.locator("#passport-command").focus();
    if (cancellation === "capture") await canvas.evaluate(element => element.releasePointerCapture(Number(element.dataset.testPointer)));
    if (cancellation === "resize") await page.setViewportSize({ width: 1200, height: 900 });
    await page.mouse.up();
    await expect(page.locator("#shape-width"), `Bounds proposal must cancel after ${cancellation}`).toHaveValue("1");
    await expect(page.getByRole("dialog", { name: "File / system" })).toBeHidden();
    assert.equal(await exportZook(), rootBefore);
    if (cancellation === "resize") await page.setViewportSize({ width: 1280, height: 900 });
  }
  recordCheck("Bounds reshape: Escape, external focus, actual capture loss and resize cancel without changing canonical bytes");
  await page.locator("#mode-add").click();
  await keyboardActivate(page.getByRole("button", { name: "Left", exact: true }));
  await keyboardFocus(page.locator("#part-select"));
  await page.locator("#mode-add").click();
  await page.locator("#placement-parent").selectOption("p0002");
  await keyboardActivate(page.getByRole("button", { name: "Below", exact: true }));
  await keyboardFocus(page.locator("#part-select"));
  await shot("keyboard-placement-focus");
  await page.locator("#part-select").selectOption("p0002");
  await page.locator("#attachment-facing-roll").fill("-24");
  await keyboardActivate(page.locator("#attachment-apply"));
  await expect(page.locator("#editor-announcement")).toHaveText("Adjust position and facing complete");
  await keyboardFocus(page.locator("#attachment-apply"));
  // Retain the mixed pointer-to-keyboard route as well as keyboard-only Apply.
  await page.locator("#attachment-facing-roll").fill("-25");
  await page.locator("#attachment-apply").click();
  await expect(page.locator("#attachment-apply")).toBeEnabled({ timeout: 20_000 });
  await keyboardActivate(page.locator("#mirror-command"));
  await expect(page.locator("#part-summary")).toHaveText("5 parts");
  await keyboardFocus(page.locator("#part-select"));
  await page.locator("#part-select").selectOption("p0003");
  const nestedBefore = await exportZook(), nestedModel = JSON.parse(nestedBefore);
  await startBoundsDrag(nestedModel, "p0003", 2, 0.4);
  await shot("bounds-reshape-mirrored-preview");
  await page.mouse.up();
  await expect(page.locator("#editor-announcement")).toHaveText("Reshape blob complete");
  const nestedAfter = await exportZook(), reshaped = JSON.parse(nestedAfter);
  const nestedSelected = nestedModel.parts.find(part => part.id === "p0003");
  for (const part of nestedModel.parts) {
    const current = reshaped.parts.find(other => other.id === part.id);
    assert.deepEqual(current.localTransform, part.localTransform);
    assert.deepEqual(current.motion, part.motion);
    if (part.mirrorGroupId === nestedSelected.mirrorGroupId) assert.ok(current.shape.lengthMeters > part.shape.lengthMeters + 0.3);
    else assert.deepEqual(current.shape, part.shape);
  }
  await page.locator("#undo-command").click();
  assert.equal(await exportZook(), nestedBefore);
  await page.locator("#redo-command").click();
  assert.equal(await exportZook(), nestedAfter);
  await accessibility("Bounds reshape editor");
  recordCheck("Bounds reshape: rotated nested mirror partners, unchanged transforms/paths and exact Undo/Redo");
  await keyboardActivate(page.locator("#copy-command"));
  await keyboardFocus(page.locator("#placement-parent"));
  await expect(page.locator("#mode-add")).toHaveAttribute("aria-pressed", "true");
  await shot("keyboard-copy-focus");
  await page.locator("#mode-select").press("Enter");
  assert.equal(await exportZook(), nestedAfter, "Cancelling Copy must preserve the exact construction");
  await keyboardActivate(page.locator("#delete-command"));
  await expect(page.locator("#editor-announcement")).toHaveText("Selected branch deleted");
  await keyboardFocus(page.locator("#part-select"));
  const deleted = JSON.parse(await exportZook());
  assert.ok(deleted.parts.length < reshaped.parts.length, "Delete must remove the selected branch");
  await page.locator("#undo-command").press("Enter");
  assert.equal(await exportZook(), nestedAfter, "Undo must restore exact branch bytes after Delete");
  recordCheck("Branch actions: visible keyboard focus after Mirror, Copy and Delete; cancelled Copy and undone Delete preserve exact bytes");
  await page.locator("#part-select").selectOption("p0003");
  await page.locator("#motion-mode").selectOption({ label: "Single part movement" });
  await keyboardActivate(page.locator("#tutorial-triangle"));
  await expect(page.locator("#motion-point-select option")).toHaveCount(3);
  await page.locator("#motion-point-x").fill("0.2");
  await keyboardActivate(page.locator("#motion-point-apply"));
  await keyboardFocus(page.locator("#motion-point-apply"));
  const motionAfterApply = JSON.parse(await exportZook()).parts.map(({ id, motion }) => ({ id, motion }));
  await keyboardActivate(page.locator("#motion-point-insert"));
  await expect(page.locator("#motion-point-select option")).toHaveCount(4);
  await keyboardFocus(page.locator("#motion-point-insert"));
  await keyboardActivate(page.locator("#motion-point-remove"));
  await expect(page.locator("#motion-point-select option")).toHaveCount(3);
  await expect(page.locator("#motion-point-remove")).toBeDisabled();
  await keyboardFocus(page.locator("#motion-point-select"));
  await shot("keyboard-path-focus");
  assert.deepEqual(JSON.parse(await exportZook()).parts.map(({ id, motion }) => ({ id, motion })), motionAfterApply);
  recordCheck("Motion path: visible keyboard focus after coordinate apply, insertion and minimum-size removal; exact paths restored");
};

const storageJourney = async () => {
  const peer = await context.newPage();
  peer.setDefaultTimeout(20_000);
  peer.on("pageerror", (error) => errors.push(`Other tab: ${error.message}`));
  peer.on("console", (message) => { if (message.type() === "error") errors.push(`Other tab: ${message.text()}`); });
  peer.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(`Other tab HTTP ${response.status()}`);
  });
  const refresh = async (target) => {
    await target.bringToFront();
    if (await target.locator("#zook-loader").isHidden()) await target.locator("#loader-command").click();
    await target.locator('[data-loader-category="my-zooks"]').click();
    await expect(target.locator("#loader-open")).toBeEnabled();
  };
  const open = async (target, name) => {
    await refresh(target);
    await target.getByRole("option", { name: new RegExp(`^${name}\\b`) }).click();
    await target.locator("#loader-open").click();
    await expect(target.locator("#zook-loader")).toBeHidden();
  };
  const width = async (target, value) => {
    await target.bringToFront();
    await target.getByLabel("Width", { exact: true }).fill(value);
    await expect(target.locator("#editor-announcement")).toHaveText("Reshape blob complete");
  };
  const save = async (target) => {
    await fileCommand("Save", target);
    await expect(target.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");
  };
  const saveAs = async (target, name) => {
    await fileCommand("Save As", target);
    await target.locator("#save-as-name").fill(name);
    await target.locator("#save-as-confirm").click();
    await expect(target.locator("#save-as-dialog")).toBeHidden();
    await expect(target.locator("#editor-announcement")).toContainText("saved as a new My Zooks entry");
  };
  const records = () => page.evaluate(async () => {
    const request = indexedDB.open("bamzooki-original-v31");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction(["zooks", "zookIndex", "photos"], "readonly");
      const done = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      const result = await Promise.all(["zooks", "zookIndex", "photos"].map(store => new Promise((resolve, reject) => {
        const read = transaction.objectStore(store).getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      })));
      await done;
      return { zooks: result[0], index: result[1], photos: result[2] };
    } finally { db.close(); }
  });
  const storedBytes = (stored, name) => stored.zooks.find(record => JSON.parse(record.documentJson).metadata.name === name)?.documentJson;
  try {
    await page.goto(`${origin}${prefix}`);
    await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
    await page.locator("#loader-new").click();
    await page.locator("#new-zook-name").fill("Storage Zook");
    await page.locator("#new-zook-confirm").click();
    await expect(page.locator("#zook-loader")).toBeHidden();
    await save(page);
    await peer.goto(`${origin}${prefix}`);
    await expect(peer.locator("#app")).toHaveAttribute("aria-busy", "false");
    await open(peer, "Storage Zook");
    await width(peer, "0.9");
    const unsaved = await exportZook(peer);
    await width(page, "0.8");
    await save(page);
    const newer = await exportZook();
    const beforeConflict = await records();
    await peer.bringToFront();
    await fileCommand("Save", peer);
    await expect(peer.locator("#editor-announcement")).toContainText("Use Save As or Export");
    await peer.screenshot({ path: path.join(output, `${engine}-storage-save-conflict.png`), fullPage: true });
    await fileCommand("New", peer);
    await expect(peer.locator("#loader-replace-confirm")).toBeVisible();
    await peer.locator("#loader-replace-cancel").click();
    await peer.locator("#loader-close").click();
    assert.equal(await exportZook(peer), unsaved);
    assert.deepEqual(await records(), beforeConflict, "A conflicting Save cannot write any store");
    recordCheck("Storage conflict: stale Save preserves exact unsaved bytes, dirty state and all three stores");
    await saveAs(peer, "Recovered conflict");
    await width(peer, "1");
    await save(peer);
    const copy = await exportZook(peer);
    assert.equal(storedBytes(await records(), "Storage Zook"), newer);
    assert.equal(storedBytes(await records(), "Recovered conflict"), copy);
    assert.equal((await records()).zooks.length, 2);
    recordCheck("Storage recovery: Save As creates an independent copy and subsequent Save updates only that copy");

    await refresh(page);
    await page.getByRole("option", { name: /^Storage Zook\b/ }).click();
    await page.locator("#loader-delete").click();
    await open(peer, "Storage Zook");
    await width(peer, "1.1");
    await save(peer);
    const beforeDelete = await records();
    await page.bringToFront();
    await page.locator("#loader-delete-confirm-button").click();
    await expect(page.locator("#loader-announcement")).toContainText("Nothing was deleted");
    assert.deepEqual(await records(), beforeDelete);
    await shot("storage-delete-conflict");
    await accessibility("Delete conflict");
    recordCheck("Storage deletion: a changed confirmation preview cannot delete a newer document or its index");

    await refresh(page);
    await page.getByRole("option", { name: /^Storage Zook\b/ }).click();
    await page.locator("#loader-delete").click();
    await page.locator("#loader-delete-confirm-button").click();
    await expect(page.locator("#loader-announcement")).toHaveText("Local Zook deleted");
    assert.equal((await records()).zooks.length, 1);
    await width(peer, "1.2");
    const deletedUnsaved = await exportZook(peer);
    await fileCommand("Save", peer);
    await expect(peer.locator("#editor-announcement")).toContainText("Use Save As or Export");
    assert.equal(await exportZook(peer), deletedUnsaved);
    assert.equal((await records()).zooks.length, 1, "Stale Save must not resurrect a deleted identity");
    await saveAs(peer, "Recovered deletion");
    recordCheck("Storage deletion recovery: stale Save cannot resurrect a deleted entry; Save As retains its unsaved work");

    const corruptId = (await records()).index.find(entry => entry.name === "Recovered conflict").id;
    await page.evaluate(async (id) => {
      const request = indexedDB.open("bamzooki-original-v31");
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const transaction = db.transaction("zookIndex", "readwrite");
        transaction.objectStore("zookIndex").put({ id, name: 7 });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
      } finally { db.close(); }
    }, corruptId);
    await refresh(page);
    await page.locator("#loader-repair").click();
    // Pause only the first validation digest in this tab. The other tab then
    // completes an ordinary UI Save between Repair's read and write snapshots.
    await page.evaluate(() => {
      const original = crypto.subtle.digest;
      crypto.subtle.digest = function (...args) {
        crypto.subtle.digest = original;
        window.__storageRepairWaiting = true;
        return new Promise(resolve => { window.__resumeStorageRepair = resolve; })
          .then(() => Reflect.apply(original, this, args));
      };
    });
    await page.locator("#loader-repair-confirm-button").click();
    await expect.poll(() => page.evaluate(() => window.__storageRepairWaiting === true)).toBe(true);
    await width(peer, "1.3");
    await save(peer);
    const beforeRepair = await records();
    await page.evaluate(() => { window.__resumeStorageRepair(); delete window.__resumeStorageRepair; delete window.__storageRepairWaiting; });
    await expect(page.locator("#loader-announcement")).toContainText("Nothing was repaired");
    assert.deepEqual(await records(), beforeRepair, "Repair must not partially apply a stale plan");
    await page.bringToFront();
    await shot("storage-repair-conflict");
    await accessibility("Repair conflict");
    recordCheck("Storage repair race: an ordinary second-tab Save invalidates the repair snapshot without any partial write");
    await refresh(page);
    await page.locator("#loader-repair").click();
    await page.evaluate(() => {
      const original = crypto.subtle.digest;
      crypto.subtle.digest = function () {
        crypto.subtle.digest = original;
        return Promise.reject(new TypeError("Simulated unavailable verification"));
      };
    });
    await page.locator("#loader-repair-confirm-button").click();
    await expect(page.locator("#loader-announcement")).toHaveText("Could not verify local Zooks. Nothing was repaired; try again.");
    assert.deepEqual(await records(), beforeRepair, "A failed digest is not evidence of corrupt stored data");
    recordCheck("Storage verification failure: an unavailable digest preserves every record instead of treating it as corrupt");
    await refresh(page);
    await page.locator("#loader-repair").click();
    await page.locator("#loader-repair-confirm-button").click();
    await expect(page.locator("#loader-announcement")).toContainText("Rebuilt 1 recoverable index record");
    const repaired = await records();
    assert.deepEqual(repaired.zooks, beforeRepair.zooks);
    assert.deepEqual(repaired.photos, beforeRepair.photos);
    assert.equal(repaired.index.find(entry => entry.id === corruptId).name, "Recovered conflict");
    await expect(page.locator("#loader-repair")).toBeHidden();
    recordCheck("Storage repair retry: a fresh confirmed repair rebuilds only the invalid index and preserves both documents");

    // Both live-tab checks are complete. Retire their WebGL/physics runtimes
    // before the independent upgrade fixture; only its old/new tabs must coexist.
    await context.close();
    reportProgress("Storage upgrade: starting isolated legacy/new connection pair");
    const legacyContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    let upgraded;
    try {
      await legacyContext.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(origin) || /^(?:blob|data):/.test(url)) return route.continue();
        errors.push("Upgrade: unexpected external network request");
        return route.abort();
      });
      const legacy = await legacyContext.newPage();
      // An empty script keeps this isolated fixture page from opening the new
      // database before the prior-version records and connection are prepared.
      await legacy.route("**/assets/*.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
      await legacy.goto(`${origin}${prefix}`);
      await legacy.evaluate(async (fixture) => {
        const request = indexedDB.open("bamzooki-original-v31", 1);
        request.onupgradeneeded = () => {
          for (const name of ["zooks", "zookIndex", "photos"]) request.result.createObjectStore(name, { keyPath: "id" });
        };
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = db.transaction(["zooks", "zookIndex"], "readwrite");
        for (const record of fixture.zooks) transaction.objectStore("zooks").put(record);
        for (const record of fixture.index) transaction.objectStore("zookIndex").put(record);
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        window.__legacyConnection = db;
        db.onversionchange = () => { db.close(); window.__legacyClosed = true; };
      }, repaired);
      upgraded = await legacyContext.newPage();
      upgraded.on("pageerror", error => errors.push(`Upgrade: ${error.message}`));
      upgraded.on("console", message => { if (message.type() === "error") errors.push(`Upgrade: ${message.text()}`); });
      upgraded.on("response", response => {
        if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(`Upgrade HTTP ${response.status()}`);
      });
      await upgraded.goto(`${origin}${prefix}`);
      await expect(upgraded.locator("#app")).toHaveAttribute("aria-busy", "false");
      await expect.poll(() => legacy.evaluate(() => window.__legacyClosed === true)).toBe(true);
      assert.equal(await legacy.evaluate(() => {
        try { window.__legacyConnection.transaction("zooks", "readwrite"); return "unexpected success"; }
        catch (error) { return error.name; }
      }), "InvalidStateError");
      assert.equal(await legacy.evaluate(() => new Promise(resolve => {
        const request = indexedDB.open("bamzooki-original-v31", 1);
        request.onerror = event => { event.preventDefault(); resolve(request.error.name); };
        request.onsuccess = () => { request.result.close(); resolve("unexpected success"); };
      })), "VersionError");
      await open(upgraded, "Recovered conflict");
      assert.equal(await exportZook(upgraded), storedBytes(repaired, "Recovered conflict"));
      await open(upgraded, "Recovered deletion");
      assert.equal(await exportZook(upgraded), storedBytes(repaired, "Recovered deletion"));
      recordCheck("Storage upgrade: v1 records survive byte-identically while old connections close and old-version writers are refused");
    } catch (error) {
      // Preserve the failing fixture before its context is closed. The outer
      // journey screenshot cannot inspect an already retired earlier page.
      if (upgraded) await upgraded.screenshot({ path: path.join(output, `${engine}-storage-upgrade-failure.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { await legacyContext.close(); }
  } finally { if (!peer.isClosed()) await peer.close(); }
};

const browserRecoveryJourney = async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-tutorial").click();
  await expect(page.locator("#part-summary")).toHaveText("9 parts");
  const original = await exportZook();
  await page.getByLabel("Width", { exact: true }).fill("0.77");
  const changed = await exportZook();
  assert.notEqual(changed, original);
  await page.setViewportSize({ width: 760, height: 560 });
  await expect(page.locator(".shell")).toBeHidden();
  await expect(page.locator(".small-screen-message")).toHaveText(
    "BAMZOOKi's editor requires a desktop-sized window of at least 800 × 600 pixels.");
  await accessibility("Small-window recovery message");
  await shot("small-window-fallback");

  for (const viewport of [
    { width: 800, height: 600 }, { width: 1024, height: 768 }, { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".small-screen-message")).toBeHidden();
    await expect(page.locator(".shell")).toBeVisible();
    const layout = await page.evaluate(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { shell: bounds(".shell"), logo: bounds(".brand-strip > div:first-child"),
        controls: ["#modules-command", "#loader-command", "#input-settings-command", "#help-command",
          "#fullscreen-command", "#build-status"].map(selector => ({ selector, ...bounds(selector) })) };
    });
    assert.ok(Math.abs(layout.shell.width / layout.shell.height - 4 / 3) < 0.002, "Shell must retain 4:3");
    for (const [index, control] of layout.controls.entries()) {
      assert.ok(control.left >= layout.shell.left && control.right <= layout.shell.right &&
        control.top >= layout.shell.top && control.bottom <= layout.shell.bottom, `${control.selector} must fit the shell`);
      if (index < 5) assert.ok(control.left >= layout.logo.right, `${control.selector} must not overlap the title`);
      for (const other of layout.controls.slice(index + 1)) assert.ok(
        !(control.left < other.right && other.left < control.right && control.top < other.bottom && other.top < control.bottom),
        `${control.selector} must not overlap ${other.selector}`);
    }
    assert.equal(await exportZook(), changed, "Resize must preserve exact unsaved document bytes");
  }
  await shot("short-desktop-recovered");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator("#undo-command").click();
  assert.equal(await exportZook(), original, "Resize must preserve Undo history");
  await page.locator("#redo-command").click();
  assert.equal(await exportZook(), changed, "Resize must preserve Redo history");
  recordCheck("Resize: small-window fallback, three 4:3 layouts, non-overlapping header and exact dirty-document Undo/Redo recovery");

  const settingsCommand = page.locator("#input-settings-command");
  const settings = page.locator("#input-settings-dialog");
  const forward = settings.getByLabel("Camera forward / Follow closer", { exact: true });
  const back = settings.getByLabel("Camera back / Follow farther", { exact: true });
  const pose = settings.getByLabel("Ground / suspend Zook in Test", { exact: true });
  await settingsCommand.click();
  await expect(forward).toBeFocused();
  await expect(forward).toHaveValue("KeyW");
  await expect(pose).toHaveValue("Space");
  await forward.selectOption("KeyI");
  await back.selectOption("KeyI");
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("cannot use the same key");
  await accessibility("Input settings validation");
  await shot("input-settings-conflict");
  await back.selectOption("KeyS");
  await pose.selectOption("KeyP");
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("saved in this browser");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settingsCommand).toBeFocused();

  const cameraPixels = async name => {
    await page.locator("#modules-command").focus();
    await page.locator("#modules-command").hover();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // The canvas rectangle also contains DOM controls. Exclude their changing
    // focus outlines only from this camera comparison; full-page shots retain them.
    return createHash("sha256").update(await page.locator("#game-canvas").screenshot({
      path: path.join(output, `${engine}-input-camera-${name}.png`),
      style: ".chrome { display: none !important; }",
    })).digest("hex");
  };
  const hold = async key => {
    await page.keyboard.down(key);
    try { await page.waitForTimeout(300); } finally { await page.keyboard.up(key); }
  };
  await page.keyboard.press("Home");
  const cameraBefore = await cameraPixels("home");
  await hold("w");
  assert.equal(await cameraPixels("replaced-w"), cameraBefore, "Replaced W binding must not move the camera");
  await hold("i");
  assert.notEqual(await cameraPixels("remapped-i"), cameraBefore, "Remapped I binding must visibly move the camera");
  await page.keyboard.press("Home");
  assert.equal(await cameraPixels("reset"), cameraBefore, "Historical Home must still restore the exact camera");
  await page.locator("#mode-test").click();
  await expect(page.locator("#test-pose-value")).toHaveText("Grounded");
  await page.keyboard.press("Space");
  await expect(page.locator("#test-pose-value")).toHaveText("Grounded");
  await page.keyboard.press("p");
  await expect(page.locator("#test-pose-value")).toHaveText("Floating at start");
  await page.locator("#mode-select").click();
  assert.equal(await exportZook(), changed);
  recordCheck("Input settings: duplicate rejection, real remapped camera and Test keys, historical Home and unchanged Zook bytes");

  await fileCommand("Save");
  await expect(page.locator("#editor-announcement")).toHaveText("Zook saved to My Zooks");
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await settingsCommand.click();
  await expect(forward).toHaveValue("KeyI");
  await expect(pose).toHaveValue("KeyP");
  await settings.getByRole("button", { name: "Restore historical defaults", exact: true }).click();
  await expect(forward).toHaveValue("KeyW");
  await expect(pose).toHaveValue("Space");
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("saved in this browser");
  const storedPreferences = await page.evaluate(() => localStorage.getItem("bamzooki.original-v31.input-bindings.v1"));
  await pose.selectOption("KeyP");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "bamzooki.original-v31.input-bindings.v1") {
        Storage.prototype.setItem = original;
        throw new DOMException("Simulated preference storage exhaustion", "QuotaExceededError");
      }
      return Reflect.apply(original, this, [key, value]);
    };
  });
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("applied for this tab, but browser preference storage is unavailable");
  assert.equal(await page.evaluate(() => localStorage.getItem("bamzooki.original-v31.input-bindings.v1")), storedPreferences);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "My Zooks", exact: true }).click();
  await page.locator("#loader-open").click();
  assert.equal(await exportZook(), changed);
  await page.locator("#mode-test").click();
  await page.keyboard.press("p");
  await expect(page.locator("#test-pose-value")).toHaveText("Floating at start");
  await page.locator("#mode-select").click();
  await settingsCommand.click();
  await settings.getByRole("button", { name: "Restore historical defaults", exact: true }).click();
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("saved in this browser");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  recordCheck("Input settings: reload persistence, historical-default restore and honest tab-only recovery after a failed preference write");

  // Disconnect only after the compiled app/profile has loaded. Any attempted
  // HTTP request still fails this check, even if the game hides its failure.
  const requests = [];
  const captureRequest = request => { if (/^https?:/.test(request.url())) requests.push(request.url()); };
  page.on("request", captureRequest);
  await context.setOffline(true);
  try {
    await page.locator("#loader-command").click();
    await page.getByRole("button", { name: "Website Zooks", exact: true }).click();
    await expect(page.locator("#zook-loader")).toContainText("no network replacement is implied");
    await page.locator("#loader-close").click();
    await page.locator("#file-system-command").click();
    const menu = page.getByRole("dialog", { name: "File / system", exact: true });
    for (const [name, message] of [["Send to CBBC", "retired account and upload service"],
      ["Website", "makes no request"], ["Online Update", "retired Windows updater"]]) {
      await menu.getByRole("button", { name, exact: true }).click();
      await expect(menu.getByRole("status")).toContainText(message);
    }
    await menu.getByRole("button", { name: "Cancel", exact: true }).click();

    const contextRecovery = async (canvasSelector, clockSelector, name) => {
      const canvas = page.locator(canvasSelector);
      const clock = page.locator(clockSelector);
      const readClock = () => clockSelector === "#motion-timeline" ? clock.inputValue() : clock.innerText();
      const initial = await readClock();
      await expect.poll(readClock).not.toBe(initial);
      // This is the real browser WebGL extension, not a fabricated DOM event
      // or access to a game controller. Hold restoration until freeze is proved.
      const handle = await canvas.evaluateHandle(element => {
        const gl = element.getContext("webgl2");
        const extension = gl?.getExtension("WEBGL_lose_context");
        if (!extension) throw new Error("WebGL context-loss extension unavailable");
        return { canvas: element, extension };
      });
      try {
        await handle.evaluate(({ canvas, extension }) => new Promise(resolve => {
          canvas.addEventListener("webglcontextlost", () => resolve(), { once: true });
          extension.loseContext();
        }));
        await expect(canvas).toHaveAttribute("data-context-state", "lost");
        await expect(page.locator("#build-status")).toContainText("paused while the graphics context recovers");
        const frozen = await readClock();
        await page.waitForTimeout(400);
        assert.equal(await readClock(), frozen, `${name} displayed authoritative clock must freeze during context loss`);
        await shot(`${name}-context-lost`);
        assert.equal(await readClock(), frozen, `${name} must remain frozen throughout loss capture`);
        await handle.evaluate(({ extension }) => extension.restoreContext());
        await expect(canvas).toHaveAttribute("data-context-state", "ready");
        await expect(page.locator("#build-status")).not.toContainText("graphics context");
        await expect.poll(readClock).not.toBe(frozen);
        await shot(`${name}-context-restored`);
      } finally { await handle.dispose(); }
    };

    await page.locator("#mode-test").click();
    await page.keyboard.press("Space");
    await expect(page.locator("#test-pose-value")).toHaveText("Floating at start");
    await page.keyboard.press("Space");
    await expect(page.locator("#test-pose-value")).toHaveText("Grounded");
    await page.locator("#test-timer-start").click();
    await contextRecovery("#game-canvas", "#test-timer-value", "test");
    await page.locator("#test-timer-stop").click();
    await page.locator("#mode-select").click();
    assert.equal(await exportZook(), changed);
    recordCheck("Test: real WebGL loss freezes the live clock, restores rendering and preserves exact Zook bytes offline");

    await module("simulator");
    await page.locator("#simulator-contest-list button").filter({ hasText: "Dodgy Zook" }).click();
    await page.locator("#simulator-zook-1").selectOption("tutorial");
    await page.locator("#simulator-zook-2").selectOption("tutorial");
    await page.locator("#simulator-start").click();
    await expect.poll(async () => Number.parseFloat(await page.locator("#simulator-time").innerText()),
      { timeout: 40_000 }).toBeGreaterThan(0.3);
    await contextRecovery("#simulator-arena-canvas", "#simulator-time", "simulator");
    await page.locator("#simulator-stop").click();
    await expect(page.locator("#simulator-save-dialog")).toBeVisible();
    await page.locator("#simulator-replay-name").fill("Browser recovery fixture");
    await page.locator("#simulator-save").click();
    await expect(page.locator("#simulator-save-dialog")).toBeHidden();
    recordCheck("Simulator: real WebGL loss freezes live contest time, restores play and saves an ordinary recording offline");

    await module("motion-player");
    const replayOption = page.locator("#motion-replay-library option").filter({ hasText: "Browser recovery fixture" });
    await expect(replayOption).toHaveCount(1);
    await page.locator("#motion-replay-library").selectOption(await replayOption.getAttribute("value"));
    await keyboardActivate(page.locator("#motion-load"));
    await expect(page.locator("#motion-play")).toBeEnabled({ timeout: 20_000 });
    await keyboardFocus(page.locator("#motion-play"));
    await shot("replay-load-focus");
    recordCheck("Replay loading: keyboard Load selected hands focus to enabled, visibly focused Play");
    const replay = await exportReplay();
    await page.locator("#motion-loop").check();
    await page.locator("#motion-play").click();
    await expect(page.locator("#motion-play")).toHaveText("Pause");
    await contextRecovery("#motion-canvas", "#motion-timeline", "motion-player");
    await page.locator("#motion-play").click();
    await expect(page.locator("#motion-play")).toHaveText("Play");
    assert.equal(await exportReplay(), replay);
    await expect(page.locator("#motion-export")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await keyboardFocus(page.locator("#motion-eject"));
    await shot("replay-export-reverse-focus");
    recordCheck("Replay export: pointer Export preserves exact bytes and native reverse Tab reaches visibly focused Eject");

    // A failed browser digest is an operational failure, not a corrupt replay.
    // The one-shot fault is confined to this disposable CI browser context.
    const failNextReplayVerification = () => page.evaluate(() => {
      const original = crypto.subtle.digest;
      crypto.subtle.digest = function () {
        crypto.subtle.digest = original;
        return Promise.reject(new TypeError("Simulated unavailable replay verification"));
      };
    });
    await failNextReplayVerification();
    await keyboardActivate(page.locator("#motion-load"));
    await expect(page.locator("#motion-status")).toHaveText("Simulated unavailable replay verification");
    await expect(page.locator("#build-status")).toHaveText("Simulated unavailable replay verification");
    await keyboardFocus(page.locator("#motion-load"));
    await shot("replay-load-failure-focus");
    assert.equal(await exportReplay(), replay, "Failed loading must preserve the previously loaded replay");
    await keyboardActivate(page.locator("#motion-refresh"));
    await expect(page.locator("#motion-status")).toHaveText("1 browser replay available.");
    await expect(page.locator("#build-status")).toHaveText("Simulated unavailable replay verification");
    recordCheck("Replay status: a successful unrelated Refresh does not dismiss the failed Load");
    await keyboardActivate(page.locator("#motion-load"));
    await expect(page.locator("#motion-status")).toHaveText("Loaded checksum-verified browser replay.");
    await expect(page.locator("#build-status")).toHaveText("Motion Player — browser-native sampled playback; legacy .bvz blocked");
    await keyboardFocus(page.locator("#motion-play"));
    await shot("replay-load-retry-status");
    assert.equal(await exportReplay(), replay);
    recordCheck("Replay loading: failed verification returns focus to Load, preserves exact replay bytes and permits an ordinary retry");

    for (const boundary of ["other-control", "open-dialog", "inactive-module", "graphics-loss"]) {
      reportProgress(`Replay delayed completion: ${boundary} setup`);
      if (boundary === "inactive-module" || boundary === "graphics-loss") {
        await failNextReplayVerification();
        await keyboardActivate(page.locator("#motion-load"));
        await expect(page.locator("#build-status")).toHaveText("Simulated unavailable replay verification");
        await keyboardFocus(page.locator("#motion-load"));
      }
      await keyboardNavigate(page.locator("#motion-load"));
      const pending = await page.evaluateHandle(() => {
        const original = crypto.subtle.digest;
        let started = false;
        let resume;
        crypto.subtle.digest = function (...args) {
          crypto.subtle.digest = original;
          started = true;
          return new Promise(resolve => { resume = resolve; })
            .then(() => Reflect.apply(original, this, args));
        };
        return { started: () => started, resume: () => resume?.(), restore: () => { crypto.subtle.digest = original; } };
      });
      let lostContext = null;
      try {
        await page.keyboard.press("Enter");
        await expect.poll(() => pending.evaluate(state => state.started())).toBe(true);
        await expect(page.locator("#motion-load")).toBeDisabled();
        // Focus displacement to body does not reset the native Tab starting
        // point. All later controls are busy; go back to the available list.
        await page.keyboard.press("Shift+Tab");
        await keyboardFocus(page.locator("#motion-replay-library"));
        reportProgress(`Replay delayed completion: ${boundary} returned to library`);
        const modules = page.locator("#modules-command");
        await keyboardNavigate(modules);
        let owner = modules;
        if (boundary === "open-dialog" || boundary === "inactive-module") {
          await page.keyboard.press("Enter");
          owner = page.locator('#module-launcher [data-suite-module="motion-player"]');
          await keyboardFocus(owner);
        }
        if (boundary === "inactive-module") {
          await keyboardActivate(page.locator('#module-launcher [data-suite-module="zook-kit"]'));
          await expect(page.locator("#module-launcher")).toBeHidden();
          await expect(page.locator(".shell")).toHaveAttribute("data-module", "zook-kit");
          owner = modules;
        }
        if (boundary === "graphics-loss") {
          lostContext = await page.locator("#motion-canvas").evaluateHandle(canvas => {
            const extension = canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context");
            if (!extension) throw new Error("WebGL context-loss extension unavailable");
            return { canvas, extension };
          });
          await lostContext.evaluate(({ canvas, extension }) => new Promise(resolve => {
            canvas.addEventListener("webglcontextlost", () => resolve(), { once: true });
            extension.loseContext();
          }));
          await expect(page.locator("#motion-canvas")).toHaveAttribute("data-context-state", "lost");
          await expect(page.locator("#build-status")).toContainText("paused while the graphics context recovers");
        }
        const newerStatus = await page.locator("#build-status").innerText();
        await pending.evaluate(state => state.resume());
        await expect(page.locator("#motion-load")).toBeEnabled({ timeout: 20_000 });
        await keyboardFocus(owner);
        if (boundary === "inactive-module" || boundary === "graphics-loss") {
          await expect(page.locator("#build-status")).toHaveText(newerStatus);
        }
        if (boundary === "open-dialog") {
          await shot("replay-load-modal-focus");
          await page.keyboard.press("Escape");
        }
        if (boundary === "graphics-loss") {
          await expect(page.locator("#motion-status")).toHaveText("Loaded checksum-verified browser replay.");
          await shot("replay-load-newer-graphics-status");
          await lostContext.evaluate(({ extension }) => extension.restoreContext());
          await expect(page.locator("#motion-canvas")).toHaveAttribute("data-context-state", "ready");
          await expect(page.locator("#build-status")).toHaveText("Motion Player — browser-native sampled playback; legacy .bvz blocked");
          await shot("replay-load-retry-restored-graphics");
        }
        if (boundary === "inactive-module") await module("motion-player");
        assert.equal(await exportReplay(), replay, `${boundary}: delayed loading must not change replay bytes`);
      } finally {
        await pending.evaluate(state => { state.resume(); state.restore(); });
        await pending.dispose();
        if (lostContext !== null) {
          await lostContext.evaluate(({ canvas, extension }) => {
            if (canvas.dataset.contextState === "lost") extension.restoreContext();
          });
          await lostContext.dispose();
        }
      }
    }
    recordCheck("Replay loading: delayed completion respects another focused control, an open dialog and an inactive module");
    recordCheck("Replay status: delayed successful retry preserves newer module and real graphics-loss status, then renders after restoration");
    await module("zook-kit");
    assert.equal(await exportZook(), changed);
    recordCheck("Motion Player: real WebGL loss freezes the playing timeline, restores playback and preserves exact replay and Zook bytes offline");
    assert.deepEqual(requests, [], "Loaded core play and retired-service surfaces must not attempt HTTP requests");
    recordCheck("Offline: retired services, Test, Simulator, replay Save/load/play/export and editor return make zero post-load HTTP requests");
  } finally {
    page.off("request", captureRequest);
    await context.setOffline(false);
  }
};

const inputOwnershipJourney = async () => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}${prefix}`);
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
  await page.locator("#loader-tutorial").click();
  await expect(page.locator("#part-summary")).toHaveText("9 parts");
  const original = await exportZook();
  const width = page.getByLabel("Width", { exact: true });
  await width.fill("0.77");
  const changed = await exportZook();
  assert.notEqual(changed, original);

  // Capture an unobscured floor strip without changing focus, hiding controls,
  // or triggering the ownership boundary the test is supposed to exercise.
  const canvas = page.locator("#game-canvas");
  const box = await canvas.boundingBox();
  assert.ok(box, "Editor canvas must be measurable");
  const clip = { x: Math.ceil(box.x + 16), y: Math.ceil(box.y + box.height * 0.45),
    width: Math.floor(box.width * 0.08), height: Math.floor(box.height * 0.3) };
  const cameraPixels = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return createHash("sha256").update(await page.screenshot({ clip,
      path: path.join(output, `${engine}-ownership-camera-${name}.png`) })).digest("hex");
  };
  const stationary = async name => {
    const before = await cameraPixels(`${name}-before`);
    await page.waitForTimeout(400);
    assert.equal(await cameraPixels(`${name}-after`), before, `${name}: released camera must remain stationary`);
  };
  const beginHeldCamera = async name => {
    await page.locator("#modules-command").focus();
    await page.locator("#modules-command").hover();
    await page.keyboard.press("Home");
    const before = await cameraPixels(`${name}-home`);
    await page.keyboard.down("w");
    await page.waitForTimeout(300);
    assert.notEqual(await cameraPixels(`${name}-held`), before, `${name}: positive control must visibly move the camera`);
  };
  const switchKeepingDocument = async name => {
    await page.locator("#modules-command").click();
    await page.locator(`#module-launcher [data-suite-module="${name}"]`).click();
    if (await page.locator("#module-dirty-confirm").isVisible()) await page.locator("#module-dirty-continue").click();
    await expect(page.locator("#module-launcher")).toBeHidden();
    await expect(page.locator(".shell")).toHaveAttribute("data-module", name);
  };

  await beginHeldCamera("editable");
  try {
    await width.focus();
    await expect(width).toBeFocused();
    await stationary("editable-held");
    await page.keyboard.up("w");
    await page.keyboard.down("w");
    await stationary("editable-new-key");
    await expect(width).toBeFocused();
    await expect(width).toHaveValue("0.77");
    await shot("input-editable-owner");
  } finally { await page.keyboard.up("w"); }
  assert.equal(await exportZook(), changed);
  recordCheck("Input ownership: editable focus releases held camera movement, suppresses new movement and preserves exact dirty Zook bytes");

  await beginHeldCamera("help");
  const help = page.getByRole("dialog", { name: "How to make a Zook" });
  try {
    await page.keyboard.press("F1");
    await expect(help).toBeVisible();
    const helpBox = await help.boundingBox();
    assert.ok(helpBox && (clip.x + clip.width <= helpBox.x || clip.y + clip.height <= helpBox.y ||
      clip.x >= helpBox.x + helpBox.width || clip.y >= helpBox.y + helpBox.height), "Help must not occlude the observed floor strip");
    await stationary("help-held");
    await page.keyboard.up("w");
    await page.keyboard.down("w");
    await stationary("help-new-key");
    await expect(help.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await shot("input-help-owner");
    await help.getByRole("button", { name: "Close", exact: true }).click();
    await stationary("help-return");
  } finally { await page.keyboard.up("w"); }
  assert.equal(await exportZook(), changed);
  recordCheck("Input ownership: Help releases held camera movement, suppresses new movement and closes without resumed drift or document changes");

  await beginHeldCamera("loader");
  try {
    await page.locator("#loader-command").click();
    await expect(page.locator("#zook-loader")).toBeVisible();
    await page.waitForTimeout(400);
    await page.keyboard.up("w");
    await page.keyboard.down("w");
    await page.waitForTimeout(400);
    await shot("input-loader-owner");
    await page.getByRole("button", { name: "Continue current Zook", exact: true }).click();
    await expect(page.locator("#zook-loader")).toBeHidden();
    await stationary("loader-return");
  } finally { await page.keyboard.up("w"); }
  assert.equal(await exportZook(), changed);
  recordCheck("Input ownership: Loader returns from held and newly pressed camera keys without resumed drift or document changes");

  await beginHeldCamera("module");
  try {
    await page.locator("#modules-command").click();
    await page.locator('#module-launcher [data-suite-module="simulator"]').click();
    await expect(page.locator("#module-dirty-confirm")).toBeVisible();
    await page.locator("#module-dirty-cancel").click();
    await expect(page.locator(".shell")).toHaveAttribute("data-module", "zook-kit");
    await expect(page.locator("#module-dirty-confirm")).toBeHidden();
    await expect(page.locator("#module-launcher")).toBeHidden();
    await stationary("module-cancel");
    await switchKeepingDocument("simulator");
    await switchKeepingDocument("zook-kit");
    await stationary("module-return");
    await shot("input-module-return");
  } finally { await page.keyboard.up("w"); }
  assert.equal(await exportZook(), changed);
  recordCheck("Input ownership: dirty module Cancel and Keep-and-switch preserve the document and do not resume held camera movement");

  // Playwright forces foreground state by default. Remove those framework
  // overrides; never set document.hidden or dispatch a visibility event.
  if (engine === "chromium") {
    // The keep-visible capture belongs to the session that enabled it. A new
    // CDP session cannot release the driver's existing foreground override.
    const session = page._connection?.toImpl?.(page)?.delegate?._mainFrameSession?._client;
    assert.equal(typeof session?.send, "function", "Pinned Chromium visibility adapter is unavailable");
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  } else if (engine === "webkit") {
    // This pinned internal adapter is necessary because WebKit has no public
    // protocol-session API. An omitted active value removes the override.
    const session = page._connection?.toImpl?.(page)?.delegate?._pageProxySession;
    assert.equal(typeof session?.send, "function", "Pinned WebKit visibility adapter is unavailable");
    await session.send("Emulation.setActiveAndFocused", {});
  }
  const windows = execFileSync("xdotool", ["search", "--onlyvisible", "--name", ".*"],
    { encoding: "utf8", timeout: 10_000 }).trim().split("\n").map(id => ({ id,
      title: execFileSync("xdotool", ["getwindowname", id], { encoding: "utf8", timeout: 10_000 }).trim(),
    }));
  console.log(`Isolated native windows: ${JSON.stringify(windows)}`);
  let gameWindows = windows.filter(({ title }) => /^BAMZOOKi.*browser reconstruction/.test(title));
  if (engine === "webkit" && gameWindows.length === 0) {
    const miniBrowserWindows = execFileSync("xdotool", ["search", "--onlyvisible", "--class", "^MiniBrowser$"],
      { encoding: "utf8", timeout: 10_000 }).trim().split("\n");
    gameWindows = windows.filter(({ id }) => miniBrowserWindows.includes(id));
  }
  assert.equal(gameWindows.length, 1, "Exactly one owned game window must exist in the isolated CI display");
  const windowId = gameWindows[0].id;
  assert.match(windowId, /^\d+$/, "Native window identity must be numeric");
  const windowCommand = command => execFileSync("xdotool", [command, "--sync", windowId], { timeout: 10_000 });
  const backgroundAndResume = async (clockSelector, name) => {
    const clock = page.locator(clockSelector);
    const read = () => clock.evaluate(element => element instanceof HTMLInputElement ? element.value : element.textContent);
    try {
      windowCommand("windowminimize");
      await expect.poll(() => page.evaluate(() => document.hidden)).toBe(true);
      await expect(page.locator("#build-status")).toHaveText("Paused while this tab is hidden");
      const hidden = await read();
      await page.waitForTimeout(400);
      assert.equal(await read(), hidden, `${name}: public clock must freeze while the native window is hidden`);
      windowCommand("windowmap");
      windowCommand("windowactivate");
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false);
      await expect(page.locator("#build-status")).not.toHaveText("Paused while this tab is hidden");
      await expect.poll(read).not.toBe(hidden);
      await shot(`input-${name}-resumed`);
    } finally {
      windowCommand("windowmap");
      windowCommand("windowactivate");
      await page.bringToFront();
    }
  };
  await page.locator("#mode-test").click();
  await page.locator("#test-timer-start").click();
  await expect.poll(async () => Number.parseFloat(await page.locator("#test-timer-value").innerText())).toBeGreaterThan(0.1);
  await backgroundAndResume("#test-timer-value", "test");
  await page.locator("#test-timer-stop").click();
  await page.locator("#mode-select").click();
  assert.equal(await exportZook(), changed);
  recordCheck("Visibility: native window hide and restore freeze and restart the public Test timer without changing Zook bytes");

  await switchKeepingDocument("simulator");
  await page.locator("#simulator-contest-list button").filter({ hasText: "Dodgy Zook" }).click();
  await page.locator("#simulator-zook-1").selectOption("tutorial");
  await page.locator("#simulator-zook-2").selectOption("tutorial");
  await page.locator("#simulator-start").click();
  await expect.poll(async () => Number.parseFloat(await page.locator("#simulator-time").innerText()),
    { timeout: 40_000 }).toBeGreaterThan(0.3);
  await backgroundAndResume("#simulator-time", "simulator");
  await page.locator("#simulator-stop").click();
  await expect(page.locator("#simulator-save-dialog")).toBeVisible();
  await page.locator("#simulator-replay-name").fill("Input ownership fixture");
  const checksumFailure = await page.evaluateHandle(() => {
    const original = crypto.subtle.digest;
    crypto.subtle.digest = function () {
      crypto.subtle.digest = original;
      return Promise.reject(new Error("Replay checksum temporarily unavailable"));
    };
    return { restore: () => { crypto.subtle.digest = original; } };
  });
  const stoppedTime = await page.locator("#simulator-time").innerText();
  try {
    await page.locator("#simulator-save").click();
    await expect(page.locator("#simulator-save-status")).toHaveText("Replay checksum temporarily unavailable");
    await expect(page.locator("#build-status")).toHaveText("Replay checksum temporarily unavailable");
    await expect(page.locator("#simulator-save-dialog")).toBeVisible();
    await expect(page.locator("#simulator-save")).toBeEnabled();
    await expect(page.locator("#simulator-replay-name")).toHaveValue("Input ownership fixture");
    await expect(page.locator("#simulator-time")).toHaveText(stoppedTime);
    await shot("input-checksum-failure-retained");
  } finally {
    await checksumFailure.evaluate(state => state.restore());
    await checksumFailure.dispose();
  }
  await page.locator("#simulator-save").click();
  await expect(page.locator("#simulator-save-dialog")).toBeHidden();
  await expect(page.locator("#build-status")).toHaveText("Simulator — evidence-bounded Provisional Play");
  recordCheck("Visibility: native window hide and restore freeze and restart live Simulator time, then save an ordinary recording");
  recordCheck("Replay save: checksum failure retains the stopped recording and name, and retry saves it without a stale error");

  await switchKeepingDocument("motion-player");
  const replayOption = page.locator("#motion-replay-library option").filter({ hasText: "Input ownership fixture" });
  await expect(replayOption).toHaveCount(1);
  await page.locator("#motion-replay-library").selectOption(await replayOption.getAttribute("value"));
  await page.locator("#motion-load").click();
  await expect(page.locator("#motion-play")).toBeEnabled();
  const replay = await exportReplay();
  await page.locator("#motion-loop").check();
  await page.locator("#motion-play").click();
  await expect(page.locator("#motion-play")).toHaveText("Pause");
  await backgroundAndResume("#motion-timeline", "motion-player");
  const pauseInput = await page.evaluateHandle(() => {
    const button = document.querySelector("#motion-play");
    const events = [];
    let mutations = 0;
    const state = () => ({ hidden: document.hidden, focused: document.hasFocus(),
      active: document.activeElement?.id, label: button.textContent, disabled: button.disabled,
      tick: document.querySelector("#motion-timeline").value, mutations });
    const observe = event => {
      if (events.length >= 64) return;
      events.push({ type: event.type, phase: event.eventPhase, trusted: event.isTrusted,
        target: event.target?.id || event.target?.nodeName, prevented: event.defaultPrevented,
        x: event.clientX, y: event.clientY,
        hit: document.elementFromPoint(event.clientX, event.clientY)?.id, ...state() });
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of types) {
      document.addEventListener(type, observe, { capture: true, passive: true });
      document.addEventListener(type, observe, { passive: true });
    }
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(button, { childList: true, characterData: true, subtree: true });
    const before = state();
    return { read: () => ({ before, after: state(), events }), dispose: () => {
      observer.disconnect();
      for (const type of types) {
        document.removeEventListener(type, observe, true);
        document.removeEventListener(type, observe, false);
      }
    } };
  });
  try {
    await page.locator("#motion-play").click();
    await expect(page.locator("#motion-play")).toHaveText("Play");
  } finally {
    console.log(`Restored-window pause input: ${JSON.stringify(await pauseInput.evaluate(value => value.read()))}`);
    await pauseInput.evaluate(value => value.dispose());
    await pauseInput.dispose();
  }
  assert.equal(await exportReplay(), replay);
  await switchKeepingDocument("zook-kit");
  assert.equal(await exportZook(), changed);
  await page.locator("#undo-command").click();
  assert.equal(await exportZook(), original, "All input/visibility handoffs must retain Undo history");
  await page.locator("#redo-command").click();
  assert.equal(await exportZook(), changed, "All input/visibility handoffs must retain Redo history");
  recordCheck("Visibility: native window hide and restore freeze and restart replay, preserving exact replay, dirty Zook and Undo/Redo bytes");
};

try {
  if (suite === "trial-focus") await trialFocusJourney();
  else if (suite === "storage") await storageJourney();
  else if (suite === "browser-recovery") await browserRecoveryJourney();
  else if (suite === "input-ownership") await inputOwnershipJourney();
  else {
    const library = await prepareLibraryJourney();
    if (suite === "contests") await contestReplayJourney(library);
    else await editorFileJourney(library);
  }
  assert.equal(checks.length, { contests: 38, editor: 34, "trial-focus": 3, storage: 10, "browser-recovery": 15, "input-ownership": 8 }[suite], "Every suite check must execute");
  assert.equal(new Set(checks).size, checks.length, "Suite checks must have distinct identities");
  assert.deepEqual(errors, [], "Browser console, script, network errors");
  console.log(`${engine} ${suite}: ${checks.length} compiled-release checks passed.`);
} catch (error) {
  failures.push(error.message);
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, `${engine}-summary.json`), `${JSON.stringify({ engine, suite, graphics: "software-rendered CI; not hardware performance or real Safari evidence", checks, failures, errors }, null, 2)}\n`);
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
