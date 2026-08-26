#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const tmp = mkdtempSync(join(tmpdir(), "co-od-pack-smoke-"));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || packageDir,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parsePackOutput(output) {
  const trimmed = output.trim();
  const parsed = JSON.parse(trimmed);
  // npm 10 returns an array while npm 11 can return an object keyed by
  // package name when invoked inside a workspace-aware package runner.
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.values(parsed)
      : [];
  assert.equal(entries.length, 1);
  return entries[0];
}

function requireFile(root, relativePath) {
  const fullPath = join(root, relativePath);
  assert.equal(existsSync(fullPath), true, `missing ${relativePath}`);
}

function forbidFile(root, relativePath) {
  const fullPath = join(root, relativePath);
  assert.equal(existsSync(fullPath), false, `unexpected ${relativePath}`);
}

try {
  // The release gate builds immediately before this smoke. Suppress lifecycle
  // output here so npm's machine-readable pack response remains pure JSON on
  // every supported npm version.
  const packInfo = parsePackOutput(run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    tmp,
  ]));
  const tarball = isAbsolute(packInfo.filename)
    ? packInfo.filename
    : join(tmp, basename(packInfo.filename));

  assert.equal(existsSync(tarball), true, `missing tarball ${tarball}`);
  assert.equal(packInfo.name, "@codegrammer/co-od");
  assert.match(packInfo.version, /^\d+\.\d+\.\d+/);

  run("tar", ["-xzf", tarball, "-C", tmp], { cwd: tmp });

  const extracted = join(tmp, "package");
  const packageJson = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@codegrammer/co-od");
  // npm normalizes bin paths inconsistently across versions ("dist/index.js"
  // vs "./dist/index.js"); compare the resolved path, not the spelling.
  const normalizeBin = (bin) => bin?.replace(/^\.\//, "");
  assert.equal(normalizeBin(packageJson.bin["co-od"]), "dist/index.js");
  assert.equal(normalizeBin(packageJson.bin["co-ode"]), "dist/index.js");

  requireFile(extracted, "dist/index.js");
  requireFile(extracted, "dist/commands/tui.js");
  requireFile(extracted, "dist/commands/opentui.js");
  requireFile(extracted, "dist/commands/doctor.js");
  requireFile(extracted, "dist/commands/completion.js");
  requireFile(extracted, "dist/tui-qa.js");
  requireFile(extracted, "SKILL.md");
  forbidFile(extracted, "src/index.ts");
  forbidFile(extracted, "test/doctor-command.test.mjs");

  const firstLine = readFileSync(join(extracted, "dist/index.js"), "utf8").split(/\r?\n/, 1)[0];
  assert.equal(firstLine, "#!/usr/bin/env node");

  const installRoot = join(tmp, "install");
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefix",
    installRoot,
    tarball,
  ], { cwd: tmp });
  const installedPackage = join(installRoot, "node_modules", "@codegrammer", "co-od");
  const env = {
    ...process.env,
    CO_OD_TUI_DISABLE_DASHBOARD_CACHE: "1",
  };
  const entrypoint = join(installedPackage, "dist", "index.js");

  const version = run(process.execPath, [entrypoint, "--version"], { cwd: installRoot, env }).trim();
  assert.equal(version, packageJson.version);

  const doctor = JSON.parse(run(process.execPath, [entrypoint, "doctor", "--json"], { cwd: installRoot, env }));
  assert.equal(doctor.installKind, "package");
  assert.match(doctor.installHint, /npm install -g @codegrammer\/co-od/);
  assert.match(doctor.updateHint, /npm update -g @codegrammer\/co-od/);

  console.log(`co-od packaged smoke passed: ${packInfo.filename}`);
} finally {
  if (!process.env.CO_OD_KEEP_PACK_SMOKE) {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`kept packaged smoke workspace: ${tmp}`);
  }
}
