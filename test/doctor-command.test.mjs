import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDoctorReport,
  formatDoctorReport,
  strictDoctorFailures,
} from "../dist/commands/doctor.js";

test("buildDoctorReport reports OpenTUI default readiness through Bun", () => {
  const report = buildDoctorReport({
    version: "0.1.8",
    command: "co-od",
    nodeVersion: "v22.0.0",
    entrypoint: "/repo/packages/cli/dist/index.js",
    bun: null,
    projectDir: "/repo",
    server: "https://co-od.dev",
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: (command) => command === "codex",
  });

  assert.equal(report.checks.find((check) => check.id === "node")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "default-tui")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "opentui")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "completion")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "dashboard-cache")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "install-surface")?.ok, true);
  assert.equal(report.installKind, "repo");
  assert.match(report.checks.find((check) => check.id === "dashboard-cache")?.detail || "", /enabled max-age 7d/);
  assert.equal(report.checks.find((check) => check.id === "provider-claude")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "provider-codex")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "provider-cli")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "provider-opencode")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "provider-openclaw")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "live-session")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "room-config")?.ok, false);
  assert.equal(report.strictReady, false);
  assert.deepEqual(strictDoctorFailures(report).map((check) => check.id), ["live-session", "room-config"]);
  assert.match(report.installHint, /pnpm build/);
  assert.deepEqual(report.cachePolicy, { enabled: true, maxAgeMs: 604_800_000 });
});

test("buildDoctorReport detects packaged install surfaces", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    entrypoint: "/usr/local/lib/node_modules/@codegrammer/co-od/dist/index.js",
    projectDir: "/workspace",
    bun: "/usr/local/bin/bun",
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: (command) => command === "codex",
  });

  assert.equal(report.installKind, "package");
  assert.match(report.checks.find((check) => check.id === "install-surface")?.detail || "", /packaged install/);
  assert.match(report.installHint, /npm install -g @codegrammer\/co-od/);
  assert.match(report.updateHint, /npm update -g @codegrammer\/co-od/);
});

test("buildDoctorReport accepts explicit release room context", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    entrypoint: "/repo/packages/cli/dist/index.js",
    projectDir: "/repo",
    roomId: "room_beta",
    server: "https://beta.example.test",
    bun: "/usr/local/bin/bun",
    date: new Date("2026-05-31T00:00:00.000Z"),
    session: {
      sessionToken: "test-token",
      expiresAt: new Date("2026-06-01T00:00:00.000Z").getTime(),
    },
    projectState: null,
    commandExists: (command) => command === "codex",
  });

  assert.equal(report.server, "https://beta.example.test");
  assert.equal(report.checks.find((check) => check.id === "room-config")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /room_beta/);
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /--room/);
  assert.doesNotMatch(report.checks.find((check) => check.id === "room-config")?.detail || "", /\.co-od\.json/);
  assert.equal(report.strictReady, true);
});

test("buildDoctorReport resolves package bin symlinks before detecting install surface", () => {
  const tmp = mkdtempSync(join(tmpdir(), "co-od-doctor-bin-"));

  try {
    const packageDist = join(tmp, "node_modules", "@codegrammer", "co-od", "dist");
    const binDir = join(tmp, "node_modules", ".bin");
    mkdirSync(packageDist, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const entrypoint = join(packageDist, "index.js");
    const bin = join(binDir, "co-od");
    writeFileSync(entrypoint, "#!/usr/bin/env node\n");
    symlinkSync(entrypoint, bin);

    const report = buildDoctorReport({
      nodeVersion: "v22.0.0",
      entrypoint: bin,
      projectDir: tmp,
      bun: "/usr/local/bin/bun",
      session: null,
      projectConfig: null,
      projectState: null,
      commandExists: (command) => command === "codex",
    });

    assert.equal(report.installKind, "package");
    assert.match(report.checks.find((check) => check.id === "install-surface")?.detail || "", /packaged install/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildDoctorReport supports explicit linked install surface hints", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    entrypoint: "/opt/co-od/dist/index.js",
    projectDir: "/workspace",
    bun: "/usr/local/bin/bun",
    installKind: "linked",
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: (command) => command === "codex",
  });

  assert.equal(report.installKind, "linked");
  assert.match(report.checks.find((check) => check.id === "install-surface")?.detail || "", /linked Node package/);
  assert.match(report.updateHint, /relink/);
});

test("buildDoctorReport reports old Node versions", () => {
  const report = buildDoctorReport({
    nodeVersion: "v16.20.0",
    bun: "/usr/local/bin/bun",
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: () => false,
  });

  assert.equal(report.checks.find((check) => check.id === "node")?.ok, false);
  assert.equal(report.checks.find((check) => check.id === "opentui")?.ok, true);
});

test("buildDoctorReport reports live QA readiness when login and room config exist", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    bun: "/usr/local/bin/bun",
    date: new Date("2026-05-31T00:00:00.000Z"),
    session: {
      sessionToken: "test-token",
      expiresAt: new Date("2026-06-01T00:00:00.000Z").getTime(),
    },
    projectConfig: {
      roomId: "room_123",
      roomName: "Beta Room",
      projectDir: "/repo",
      provider: "opencode",
    },
    projectState: null,
    opencodeBin: "custom-opencode",
    commandExists: (command) => command === "custom-opencode" || command === "zeroclaw",
  });

  assert.equal(report.checks.find((check) => check.id === "live-session")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "live-session")?.detail || "", /expires 2026-06-01/);
  assert.equal(report.checks.find((check) => check.id === "room-config")?.ok, true);
  assert.equal(report.checks.find((check) => check.id === "provider-cli")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /Beta Room/);
  assert.equal(report.checks.find((check) => check.id === "provider-opencode")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "provider-opencode")?.detail || "", /custom-opencode/);
  assert.equal(report.checks.find((check) => check.id === "provider-openclaw")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "provider-openclaw")?.detail || "", /zeroclaw/);
  assert.equal(report.strictReady, true);
  assert.deepEqual(strictDoctorFailures(report), []);
});

test("buildDoctorReport includes configured dashboard cache policy", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    bun: "/usr/local/bin/bun",
    session: null,
    projectConfig: null,
    projectState: null,
    cachePolicy: { enabled: false, maxAgeMs: 10_800_000 },
    commandExists: (command) => command === "codex",
  });

  assert.deepEqual(report.cachePolicy, { enabled: false, maxAgeMs: 10_800_000 });
  const check = report.checks.find((candidate) => candidate.id === "dashboard-cache");
  assert.equal(check?.ok, true);
  assert.equal(check?.required, undefined);
  assert.match(check?.detail || "", /disabled/);
  assert.doesNotMatch(strictDoctorFailures(report).map((candidate) => candidate.id).join(","), /dashboard-cache/);
});

test("buildDoctorReport treats persisted TUI room state as live QA room context", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    bun: "/usr/local/bin/bun",
    date: new Date("2026-05-31T00:00:00.000Z"),
    session: {
      sessionToken: "test-token",
      expiresAt: new Date("2026-06-01T00:00:00.000Z").getTime(),
    },
    projectConfig: null,
    projectState: {
      selectedRoomId: "room_persisted",
      selectedRoomName: "Persisted Room",
    },
    commandExists: (command) => command === "codex",
  });

  assert.equal(report.checks.find((check) => check.id === "room-config")?.ok, true);
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /Persisted Room/);
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /persisted TUI state/);
  assert.equal(report.strictReady, true);
});

test("formatDoctorReport renders install and update guidance", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    entrypoint: "/repo/dist/index.js",
    bun: "/usr/local/bin/bun",
    projectDir: "/repo",
    server: "https://co-od.dev",
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: () => false,
  });

  const text = formatDoctorReport(report);
  assert.match(text, /co-od doctor/);
  assert.match(text, /Default TUI/);
  assert.match(text, /OpenTUI runtime/);
  assert.match(text, /Shell completion/);
  assert.match(text, /Dashboard cache/);
  assert.match(text, /Install surface/);
  assert.match(text, /Provider CLI/);
  assert.match(text, /Provider claude/);
  assert.match(text, /Provider codex/);
  assert.match(text, /Provider opencode/);
  assert.match(text, /Provider hermes/);
  assert.match(text, /Provider openclaw/);
  assert.match(text, /Live QA login/);
  assert.match(text, /Room context/);
  assert.match(text, /Project:\s+\/repo/);
  assert.match(text, /Server:\s+https:\/\/co-od\.dev/);
  assert.match(text, /Install:/);
  assert.match(text, /Update:/);
  assert.match(text, /Completion:/);
  assert.match(text, /Live QA:/);
  assert.match(text, /Strict: blocked by Provider CLI, Live QA login, Room context/);
});

test("doctor explains the local-first beta model and Bun requirement", () => {
  const report = buildDoctorReport({
    nodeVersion: "v22.0.0",
    bun: null,
    session: null,
    projectConfig: null,
    projectState: null,
    commandExists: () => false,
  });
  const text = formatDoctorReport(report);

  assert.match(text, /Full TUI: Bun is required for the public beta experience/);
  assert.match(text, /Free path: bring your own Codex CLI, Claude Code, Hermes Agent, OpenCode, or OpenClaw credentials/);
  assert.match(text, /Hosted runtime: optional and limited/);
  assert.match(text, /Provider CLI.*no local provider CLI found/);
});
