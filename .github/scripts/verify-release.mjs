import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixedFiles = new Set([
  "README.md", ".github/workflows/pages.yml", ".github/scripts/verify-release.mjs",
  ".github/scripts/smoke-test.mjs",
  "site/index.html", "site/.nojekyll", "site/THIRD_PARTY_NOTICES.txt",
]);

export function isPublicReleaseFile(relative) {
  return fixedFiles.has(relative) || /^site\/assets\/[A-Za-z0-9_-]+\.(?:js|css|wasm)$/.test(relative);
}

export function assertPublicText(text, relative) {
  const forbidden = [
    /sourceMappingURL\s*=/i,
    /(?:\/Users\/|\/home\/)[^/\s]+\//,
    /[A-Z]:\\(?:Users|Documents and Settings)\\/i,
    /reference[\\/](?:extracted|manifests|private-pack|private-analysis)/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|sk-proj-[A-Za-z0-9_-]{40,})/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) {
    throw new Error(`Public release contains a forbidden source, diagnostic, or personal marker: ${relative}`);
  }
  // The verifier necessarily names these markers in its own rejection rules.
  // Only that marker family is exempt there; paths, keys and tokens never are.
  const developmentMarkers = [
    /(?:\.git-local|PROJECT_STATE\.md|BAMZOOKI_BROWSER_RECONSTRUCTION_GOAL)/,
    /(?:__BAMZOOKI_DIAGNOSTICS__|__BAMZOOKI_PERFORMANCE__|private-textures\/|private-visuals\/)/,
  ];
  if (relative !== ".github/scripts/verify-release.mjs" &&
      developmentMarkers.some((pattern) => pattern.test(text))) {
    throw new Error(`Public release contains a forbidden development marker: ${relative}`);
  }
}

async function listFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (relative === "" && entry.name === ".git" && entry.isDirectory()) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Public release contains a symbolic link: ${name}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Public release contains a non-file: ${name}`);
  }
  return files.sort();
}

export async function auditPublicRelease(root, { allowPreviousRelease = false } = {}) {
  return auditPublicReleaseSnapshot(await listFiles(root),
    (name) => readFile(path.join(root, name)), { allowPreviousRelease });
}

export async function auditPublicReleaseSnapshot(names, readBytes, { allowPreviousRelease = false } = {}) {
  const manifest = JSON.parse((await readBytes("release-manifest.json")).toString("utf8"));
  if (manifest === null || typeof manifest !== "object" ||
      Object.keys(manifest).sort().join(",") !== "files,schema" ||
      manifest.schema !== "bamzooki.public-release.v1" || !Array.isArray(manifest.files) ||
      manifest.files.some((entry) => entry === null || typeof entry !== "object" ||
        Object.keys(entry).sort().join(",") !== "bytes,path,sha256")) {
    throw new Error("Public release manifest is invalid");
  }
  const actual = [...names].sort();
  const expected = manifest.files.map(({ path: name }) => name);
  if (expected.length > 40 || new Set(expected).size !== expected.length ||
      expected.some((name) => !isPublicReleaseFile(name)) ||
      actual.join("\n") !== [...expected, "release-manifest.json"].sort().join("\n") ||
      [...fixedFiles].some((name) => !expected.includes(name) &&
        !(allowPreviousRelease && name === ".github/scripts/smoke-test.mjs"))) {
    throw new Error("Public release contains an unapproved, missing, or duplicate file");
  }
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const bytes = await readBytes(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 10_000_000 ||
        bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Public release integrity mismatch: ${entry.path}`);
    }
    totalBytes += bytes.length;
    if (!entry.path.endsWith(".wasm")) {
      assertPublicText(bytes.toString("utf8"), entry.path);
    }
  }
  if (totalBytes > 15_000_000) throw new Error("Public release exceeds its byte budget");
  const html = (await readBytes("site/index.html")).toString("utf8");
  if (!html.includes("not affiliated with or endorsed by the BBC or Gameware")) {
    throw new Error("Public disclaimer is missing");
  }
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  if (references.length < 2 || references.some((url) => {
    if (!url.startsWith("/BamzookiReloaded/")) return true;
    return !expected.includes(`site/${url.slice("/BamzookiReloaded/".length)}`);
  })) throw new Error("Public entry references escape or miss the release");
  return Object.freeze({ files: actual.length, bytes: totalBytes });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditPublicRelease(path.resolve(process.argv[2] ?? "."));
  console.log(`Distribution-only audit passed: ${result.files} files, ${result.bytes} bytes.`);
}
