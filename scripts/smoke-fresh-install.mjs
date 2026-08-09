#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
const tmp = mkdtempSync(join(tmpdir(), "co-od-fresh-install-"));

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
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not return JSON output: ${trimmed}`);
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1));
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  return parsed[0];
}

try {
  const packInfo = parsePackOutput(run("npm", ["pack", "--json", "--pack-destination", tmp]));
  const tarball = isAbsolute(packInfo.filename)
    ? packInfo.filename
    : join(tmp, basename(packInfo.filename));

  const installRoot = join(tmp, "consumer");
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ private: true }, null, 2));
  run("npm", ["init", "-y"], { cwd: tmp });
  run("npm", ["install", "--prefix", installRoot, "--no-audit", "--no-fund", tarball], { cwd: tmp });

  const bin = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "co-od.cmd" : "co-od");
  const version = run(bin, ["--version"], {
    cwd: installRoot,
    env: {
      ...process.env,
      CO_OD_TUI_DISABLE_DASHBOARD_CACHE: "1",
    },
  }).trim();
  assert.equal(version, packInfo.version);

  const doctor = JSON.parse(run(bin, ["doctor", "--json"], {
    cwd: installRoot,
    env: {
      ...process.env,
      CO_OD_TUI_DISABLE_DASHBOARD_CACHE: "1",
    },
  }));
  assert.equal(doctor.installKind, "package");
  assert.equal(doctor.version, packInfo.version);
  assert.match(doctor.installHint, /npm install -g @codegrammer\/co-od/);

  const completion = run(bin, ["completion", "zsh"], { cwd: installRoot });
  assert.match(completion, /#compdef co-od/);

  const installedPackageJson = JSON.parse(readFileSync(join(installRoot, "node_modules", "@codegrammer", "co-od", "package.json"), "utf8"));
  assert.equal(installedPackageJson.name, "@codegrammer/co-od");
  assert.equal(installedPackageJson.version, packInfo.version);

  console.log(`co-od fresh install smoke passed: ${packInfo.filename}`);
} finally {
  if (!process.env.CO_OD_KEEP_FRESH_INSTALL_SMOKE) {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`kept fresh install smoke workspace: ${tmp}`);
  }
}
