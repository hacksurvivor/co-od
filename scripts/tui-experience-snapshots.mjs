#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenTuiPreviewUiState,
  formatOpenTuiPreviewText,
} from "../dist/tui-opentui-preview.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const outDir = join(repoRoot, "docs", "release", "artifacts", "tui-experience");
const fixtureNow = Date.UTC(2026, 5, 29, 12, 0, 0);
const configuredFormatOptions = {
  sideRailWidth: 18,
  sideRailMinMainWidth: 60,
};
const configuredEvidence = [
  "co·ode",
  "now",
  "stream",
  "needs you",
];

const safety = {
  approvalMode: "local-cli",
  sandboxMode: "workspace-write",
  networkEnabled: true,
  autoRun: true,
  autoApply: false,
  allowDangerousCommands: false,
  audit: [],
};

const workspace = {
  isGitRepo: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  insertions: 0,
  deletions: 0,
};

function baseState() {
  return {
    args: {
      dir: "/Users/you/project",
      smokeTest: false,
      durationMs: 0,
    },
    safety,
    workspace,
    workspaceFiles: ["README.md", "src/app.ts"],
    instructions: { files: [{ path: "AGENTS.md", title: "Agent Guide", bytes: 1200 }] },
    memory: { files: [{ path: "MEMORY.md", title: "Project Memory", bytes: 800 }] },
    taskHistory: ["Review auth edge cases", "Ship terminal polish"],
    dashboard: {
      config: {
        roomId: "room_release",
        roomName: "Release QA",
        projectDir: "/Users/you/project",
        provider: "codex",
        server: "https://co-od.dev",
      },
      session: { sessionToken: "snapshot-token", expiresAt: fixtureNow + 60_000, user: "you" },
      bridge: "running",
      providerAvailability: { codex: true, opencode: true },
      provider: "codex",
      rooms: [],
      message: "Ready when you are.",
      dashboard: {
        agents: [
          { _id: "agent-builder", name: "Builder", provider: "codex", execution_mode: "local_codex" },
          { _id: "agent-reviewer", name: "Reviewer", provider: "opencode", execution_mode: "local_opencode" },
        ],
        runs: [
          {
            _id: "run-auth",
            agent_id: "agent-builder",
            status: "running",
            execution_mode: "local_codex",
            goal: "Add auth guard to checkout route",
            created_at: fixtureNow - 120_000,
            started_at: fixtureNow - 110_000,
            steps: [{ idx: 1, kind: "tool", input: { description: "Read auth route" }, output: { success: true } }],
          },
          {
            _id: "run-review",
            agent_id: "agent-reviewer",
            status: "queued",
            execution_mode: "local_opencode",
            goal: "Review patch for edge cases",
            created_at: fixtureNow - 60_000,
            steps: [],
          },
          {
            _id: "run-failed",
            agent_id: "agent-reviewer",
            status: "failed",
            execution_mode: "local_opencode",
            goal: "Verify packaged install",
            created_at: fixtureNow - 90_000,
            finished_at: fixtureNow - 30_000,
            steps: [],
          },
        ],
        messages: [
          {
            _id: "msg-one",
            author_type: "user",
            author_name: "teammate",
            body_md: "shipping the live room polish now",
            created_at: fixtureNow - 45_000,
          },
        ],
        patches: [
          {
            _id: "patch-login",
            run_id: "run-auth",
            title: "Login ceremony",
            path: "packages/cli/src/commands/login.ts",
            status: "proposed",
            diff_text: "--- a/login.ts\n+++ b/login.ts\n+polished login\n-raw oauth logs",
          },
        ],
        services: {
          web: { ok: true, latencyMs: 18 },
          runtime: { ok: false, status: 503, message: "hosted runtime optional" },
          terminal: { ok: true },
          collab: { ok: true },
        },
      },
    },
  };
}

function unconfiguredState() {
  const state = baseState();
  return {
    ...state,
    dashboard: {
      ...state.dashboard,
      config: null,
      session: null,
      bridge: "stopped",
      message: "No room here yet.",
      dashboard: {
        agents: [],
        runs: [],
        services: {},
      },
    },
  };
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function assertSnapshot({ label, text, width, height, includes = [] }) {
  const plainText = stripAnsi(text);
  for (const expected of includes) {
    if (!plainText.includes(expected)) {
      throw new Error(`${label} missing required evidence: ${expected}`);
    }
  }

  const lines = plainText.split("\n");
  if (lines.length !== height) {
    throw new Error(`${label} expected ${height} rows, got ${lines.length}`);
  }

  const overflow = lines.findIndex((line) => line.length > width);
  if (overflow !== -1) {
    throw new Error(`${label} line ${overflow + 1} exceeds ${width} columns: ${lines[overflow].length}`);
  }
}

function writeSnapshot(name, state, width, height, formatOptions = {}, includes = []) {
  const text = formatOpenTuiPreviewText(createOpenTuiPreviewUiState(state), { width, height, ...formatOptions });
  const path = join(outDir, `${name}-${width}x${height}.txt`);
  writeFileSync(path, text);
  assertSnapshot({ label: `${name}-${width}x${height}`, text, width, height, includes });
  return path;
}

mkdirSync(outDir, { recursive: true });

const outputs = [
  writeSnapshot("configured", baseState(), 80, 24, configuredFormatOptions, configuredEvidence),
  writeSnapshot("configured", baseState(), 120, 36, {}, configuredEvidence),
  writeSnapshot("configured", baseState(), 160, 44, {}, configuredEvidence),
  writeSnapshot("unconfigured", unconfiguredState(), 100, 30, {}, ["start a room", "> /login to enter the room…"]),
];

for (const path of outputs) {
  console.log(`[tui-experience] wrote ${path}`);
}
