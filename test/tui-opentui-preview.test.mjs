import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendOpenTuiFeed,
  applyOpenTuiDashboardCache,
  applyTaskEventToState,
  completeOpenTuiDiagnostics,
  completeOpenTuiRenamePreview,
  completeOpenTuiSymbolNavigation,
  completeOpenTuiWorkspaceDiff,
  completeOpenTuiWorkspaceSearch,
  completeOpenTuiWorkspaceSymbols,
  completeOpenTuiRunCopy,
  completeOpenTuiPatchResolve,
  completeOpenTuiRunExport,
  completeOpenTuiRunDetail,
  completeOpenTuiRunStop,
  completeOpenTuiTask,
  createOpenTuiDashboardCache,
  createOpenTuiPreviewUiState,
  beginOpenTuiBridgeApproval,
  dashboardCacheForOpenTuiPersistence,
  filteredOpenTuiPaletteItems,
  formatOpenTuiPreviewText,
  handleOpenTuiTerminalEvent,
  loadOpenTuiPreviewStartupState,
  openTuiPaletteItems,
  parseOpenTuiPreviewArgs,
  reduceOpenTuiPreviewKey,
  reduceOpenTuiPreviewMouse,
  refreshOpenTuiPreviewUiState,
  resolveOpenTuiPreviewRoomSelection,
  resolvePanelTabs,
} from "../dist/tui-opentui-preview.js";
import { stripAnsi, visibleLength } from "../dist/tui-render.js";
import { createUndoSnapshot } from "../dist/tui-undo.js";

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

function previewState() {
  return {
    args: {
      dir: "/tmp/project",
      smokeTest: false,
      durationMs: 0,
    },
    safety,
    workspace,
    workspaceFiles: ["README.md", "src/app.ts", "assets/screen.png"],
    instructions: { files: [{ path: "AGENTS.md", title: "Guide", bytes: 10 }] },
    memory: { files: [{ path: "MEMORY.md", title: "Project Memory", bytes: 12 }] },
    taskHistory: ["Fix tests", "Ship dashboard"],
    dashboard: {
      config: {
        roomId: "room-a",
        roomName: "Alpha",
        projectDir: "/tmp/project",
        provider: "opencode",
        server: "https://co-od.example",
      },
      session: { sessionToken: "token", expiresAt: Date.now() + 60_000, user: "user-a" },
      bridge: "running",
      providerAvailability: { opencode: true, codex: true },
      provider: "opencode",
      rooms: [],
      message: "Room refreshed: 1 agents, 1 recent tasks.",
      dashboard: {
        agents: [{
          _id: "agent-a",
          name: "Builder",
          provider: "opencode",
          execution_mode: "local_cli",
        }, {
          _id: "agent-b",
          name: "Reviewer",
          provider: "codex",
          execution_mode: "local_codex",
        }],
        runs: [{
          _id: "run-a",
          agent_id: "agent-a",
          status: "running",
          execution_mode: "local_cli",
          goal: "Ship dashboard",
          created_at: Date.parse("2026-05-31T01:00:00.000Z"),
          started_at: Date.parse("2026-05-31T01:01:00.000Z"),
          steps: [{
            idx: 1,
            kind: "tool",
            input: { description: "Inspect current dashboard" },
            output: { success: true, payload: { providerSessionId: "opencode-session-a" } },
          }],
        }, {
          _id: "run-child",
          agent_id: "agent-a",
          parent_run_id: "run-a",
          status: "completed",
          goal: "Review terminal output",
          created_at: Date.parse("2026-05-31T01:02:00.000Z"),
        }],
        services: {
          web: { ok: true, latencyMs: 12 },
          runtime: { ok: false, status: 503, message: "offline" },
          terminal: { ok: true },
          collab: { ok: true },
        },
      },
    },
  };
}

function rowFor(text, pattern) {
  const rows = stripAnsi(text).split("\n");
  const index = rows.findIndex((row) => pattern.test(row));
  assert.notEqual(index, -1, `Missing row for ${pattern}`);
  return index + 1;
}

function runDetail(overrides = {}) {
  return {
    run: {
      ...previewState().dashboard.dashboard.runs[0],
      steps: [{
        idx: 1,
        kind: "tool",
        input: { description: "Inspect current dashboard" },
        output: { success: true },
      }, {
        idx: 2,
        kind: "tool_call",
        input: { description: "approval:destructive" },
        output: {
          success: false,
          payload: {
            approval: {
              kind: "destructive",
              decision: "denied",
              mode: "deny",
              command: "rm -rf demo",
              reason: "dangerous test command",
            },
          },
        },
      }, {
        idx: 3,
        kind: "patch",
        output: { success: false, payload: { summary: "Patch failed validation" } },
      }],
    },
    allRuns: previewState().dashboard.dashboard.runs,
    patches: [{
      _id: "patch-a",
      run_id: "run-a",
      title: "Dashboard copy",
      path: "packages/cli/src/tui-opentui-preview.ts",
      status: "proposed",
      diff_text: "--- a/file\n+++ b/file\n+added\n-removed\n context",
    }, {
      _id: "patch-b",
      run_id: "run-a",
      title: "Renderer docs",
      path: "README.md",
      status: "proposed",
      diff_text: "@@ section\n+new docs",
    }],
    ...overrides,
  };
}

test("parseOpenTuiPreviewArgs handles room, provider, server, dir, and smoke settings", () => {
  assert.deepEqual(
    parseOpenTuiPreviewArgs([
      "room-a",
      "--provider",
      "opencode",
      "--server",
      "https://co-od.example",
      "--dir",
      "/tmp/project",
      "--smoke-test",
      "--startup-budget-ms",
      "750",
    ], "/cwd"),
    {
      roomId: "room-a",
      provider: "opencode",
      server: "https://co-od.example",
      dir: "/tmp/project",
      smokeTest: true,
      durationMs: 250,
      startupProfile: true,
      startupBudgetMs: 750,
    },
  );
});

test("resolveOpenTuiPreviewRoomSelection prefers explicit room then persisted room", () => {
  assert.deepEqual(
    resolveOpenTuiPreviewRoomSelection(
      { roomId: "room-explicit" },
      { selectedRoomId: "room-persisted", selectedRoomName: "Persisted" },
    ),
    { roomId: "room-explicit", fromPersisted: false },
  );
  assert.deepEqual(
    resolveOpenTuiPreviewRoomSelection(
      {},
      { selectedRoomId: "room-persisted", selectedRoomName: "Persisted" },
    ),
    { roomId: "room-persisted", roomName: "Persisted", fromPersisted: true },
  );
  assert.deepEqual(resolveOpenTuiPreviewRoomSelection({}, null), { fromPersisted: false });
});

test("resolvePanelTabs maps legacy ids onto the room/chat/projects tabs", () => {
  assert.deepEqual(resolvePanelTabs({ panelTabs: ["room", "work", "chat"] }), ["room", "chat"]);
  assert.deepEqual(resolvePanelTabs({ panelTabs: ["team", "rooms"] }), ["room", "projects"]);
  assert.deepEqual(resolvePanelTabs({ panelTabs: ["missing"] }), ["room", "chat", "projects"]);
  assert.deepEqual(resolvePanelTabs(null), ["room", "chat", "projects"]);
});

test("loadOpenTuiPreviewStartupState builds a local first-paint state", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-opentui-startup-"));
  writeFileSync(
    join(dir, ".co-od.json"),
    JSON.stringify({ roomId: "room-local", roomName: "Local", provider: "codex" }),
    "utf-8",
  );

  const state = loadOpenTuiPreviewStartupState({
    dir,
    smokeTest: false,
    durationMs: 0,
  });

  assert.equal(state.dashboard.config.roomId, "room-local");
  assert.equal(state.dashboard.provider, "codex");
  assert.equal(state.dashboard.bridge, "offline");
  assert.equal(state.dashboard.session, null);
  assert.equal(state.dashboard.dashboard.agents.length, 0);
  assert.equal(state.dashboard.dashboard.runs.length, 0);
  assert.equal(state.workspace.isGitRepo, false);
  assert.equal(state.workspaceFiles.length, 0);
  assert.equal(state.dashboard.message, "Loading live room data...");
});

test("refreshOpenTuiPreviewUiState swaps live data without clobbering local input", () => {
  const current = {
    ...createOpenTuiPreviewUiState(previewState()),
    mode: "task",
    taskInput: "finish the dashboard",
    feed: [{ kind: "info", text: "first paint" }],
  };
  const latest = {
    ...previewState(),
    dashboard: {
      ...previewState().dashboard,
      message: "Room refreshed: 2 agents, 1 recent tasks.",
      dashboard: {
        ...previewState().dashboard.dashboard,
        agents: [
          ...previewState().dashboard.dashboard.agents,
          { _id: "agent-c", name: "QA", provider: "codex" },
        ],
      },
    },
  };

  const refreshed = refreshOpenTuiPreviewUiState(current, latest);

  assert.equal(refreshed.mode, "task");
  assert.equal(refreshed.taskInput, "finish the dashboard");
  assert.deepEqual(refreshed.feed, [{ kind: "info", text: "first paint" }]);
  assert.equal(refreshed.dashboard.dashboard.agents.length, 3);
  assert.equal(refreshed.message, "Room refreshed: 2 agents, 1 recent tasks.");
});

test("OpenTUI preview applies cached dashboard data only for errored matching rooms", () => {
  const cachedAt = new Date().toISOString();
  const dashboard = {
    ...previewState().dashboard,
    dashboard: {
      ...previewState().dashboard.dashboard,
      agents: [],
      runs: [],
      error: "agents: offline; runs: offline",
    },
    message: "Dashboard data unavailable.",
  };
  const cached = applyOpenTuiDashboardCache(dashboard, {
    roomId: "room-a",
    roomName: "Alpha",
    cachedAt,
    agents: [{ _id: "agent-cached", name: "Cached Builder" }],
    runs: [{ _id: "run-cached", goal: "Cached run" }],
  });

  assert.equal(cached.dashboard.cached, true);
  assert.equal(cached.dashboard.agents[0]._id, "agent-cached");
  assert.equal(cached.dashboard.runs[0]._id, "run-cached");
  assert.match(cached.message, /Showing cached room data/);

  const mismatched = applyOpenTuiDashboardCache(dashboard, {
    roomId: "room-other",
    cachedAt,
    agents: [{ _id: "agent-other" }],
    runs: [{ _id: "run-other" }],
  });
  assert.equal(mismatched, dashboard);

  const disabled = applyOpenTuiDashboardCache(dashboard, {
    roomId: "room-a",
    cachedAt,
    agents: [{ _id: "agent-cached" }],
    runs: [{ _id: "run-cached" }],
  }, { enabled: false, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  assert.equal(disabled, dashboard);
});

test("OpenTUI preview creates fresh dashboard cache from live room data", () => {
  const ui = createOpenTuiPreviewUiState(previewState());
  const cache = createOpenTuiDashboardCache(ui);

  assert.equal(cache?.roomId, "room-a");
  assert.equal(cache?.roomName, "Alpha");
  assert.equal(cache?.agents.length, 2);
  assert.equal(cache?.runs.length, 2);
  assert.equal(createOpenTuiDashboardCache({
    dashboard: {
      ...ui.dashboard,
      dashboard: { ...ui.dashboard.dashboard, cached: true },
    },
  }), null);
});

test("OpenTUI preview clears cache only after fresh empty live room data", () => {
  const ui = createOpenTuiPreviewUiState(previewState());

  assert.equal(dashboardCacheForOpenTuiPersistence({
    dashboard: {
      ...ui.dashboard,
      dashboard: { ...ui.dashboard.dashboard, agents: [], runs: [] },
    },
  }), null);

  assert.equal(dashboardCacheForOpenTuiPersistence({
    dashboard: {
      ...ui.dashboard,
      dashboard: { ...ui.dashboard.dashboard, agents: [], runs: [], error: "runs offline" },
    },
  }), undefined);

  assert.equal(dashboardCacheForOpenTuiPersistence({
    dashboard: {
      ...ui.dashboard,
      dashboard: { ...ui.dashboard.dashboard, cached: true },
    },
  }), undefined);
});

test("formatOpenTuiPreviewText includes live dashboard sections", () => {
  const ui = createOpenTuiPreviewUiState(previewState());
  const text = formatOpenTuiPreviewText(ui);

  assert.match(text, /co·ode · room Alpha · opencode · ●live · 1 working/);
  assert.doesNotMatch(text, /Renderer migration|Experimental Bun renderer/);
  assert.match(text, /target @builder · 2 agents · main clean · bridge connected/);
  assert.doesNotMatch(text, /runtime\s+down HTTP 503: offline/);
  assert.match(text, /now/);
  assert.match(text, /stream/);
  assert.match(text, /needs you/);
  assert.match(text, /@builder\s+opencode/);
  assert.match(text, /Ship dashboard/);
  assert.match(text, /agents\s+inbox\s+rooms/);
  assert.match(text, /Ctrl\+P palette/);

  const wide = formatOpenTuiPreviewText(ui, { width: 160, height: 40 });
  assert.match(wide, /rooms/);
  assert.match(wide, /target @builder/);
  assert.match(wide, /room pulse/);
  assert.doesNotMatch(wide, /runbook|dispatch/);
});

test("OpenTUI room frame follows the local-first multiplayer product shape", () => {
  const ui = createOpenTuiPreviewUiState(previewState());
  const text = stripAnsi(formatOpenTuiPreviewText(ui, { width: 120, height: 36 }));
  const lines = text.split("\n");

  assert.match(lines[0], /co·ode · room Alpha · opencode · ●live · 1 working/);
  assert.match(lines[1], /target @builder · 2 agents · main clean · bridge connected/);
  assert.doesNotMatch(lines.slice(0, 3).join("\n"), /runtime .*terminal .*collab .*web/);
  assert.match(text, /agents\s+inbox\s+rooms/);
  assert.match(text, /now/);
  assert.match(text, /stream/);
  assert.match(text, /needs you/);
  assert.match(text, /▌ you/);
  assert.match(text, /╭/);
  assert.match(text, /Ask @builder to work…/);
});

test("OpenTUI product shape task composer uses placeholder for blank input", () => {
  const ui = {
    ...createOpenTuiPreviewUiState(previewState()),
    mode: "task",
    taskInput: "",
  };
  const text = stripAnsi(formatOpenTuiPreviewText(ui, { width: 100, height: 36 }));

  assert.match(text, /> Ask @builder to work…/);
  assert.doesNotMatch(text, /│ > _\s+│/);
});

test("OpenTUI room frame keeps in-progress work consistent across panes", () => {
  const state = previewState();
  state.dashboard.dashboard.runs[0] = {
    ...state.dashboard.dashboard.runs[0],
    status: "in_progress",
  };
  const text = stripAnsi(formatOpenTuiPreviewText(createOpenTuiPreviewUiState(state), { width: 160, height: 40 }));

  assert.match(text.split("\n")[0], /●live · 1 working/);
  assert.match(text, /⠋ @builder\s+opencode/);
  assert.match(text, /Ship dashboard/);
  assert.match(text, /now/);
  assert.match(text, /1 active tasks/);
  assert.doesNotMatch(text, /Add a Codex, Claude Code, or OpenCode target to start/);
});

test("OpenTUI preview does not render a cramped side rail", () => {
  const state = previewState();
  state.dashboard.dashboard.agents[0] = {
    ...state.dashboard.dashboard.agents[0],
    name: "Release QA Codex",
  };
  const ui = createOpenTuiPreviewUiState({
    ...state,
    sideRailWidth: 18,
  });

  // Below the rail + main minimum the rail hides entirely instead of cramping.
  const narrow = stripAnsi(formatOpenTuiPreviewText(ui, { width: 80, height: 40 }));
  assert.doesNotMatch(narrow, /agents\s+inbox\s+rooms/);

  const wide = stripAnsi(formatOpenTuiPreviewText(ui, { width: 160, height: 40 }));
  assert.match(wide, /agents\s+inbox\s+rooms/);
  assert.match(wide, /target @release-qa-codex/);
  const targetLine = wide.split("\n").find((row) => /target @release-qa-codex/.test(row)) || "";
  assert.doesNotMatch(targetLine, /\.\.\./);
});

test("formatOpenTuiPreviewText frames OpenTUI preview for narrow and wide viewports", () => {
  const ui = createOpenTuiPreviewUiState(previewState());

  for (const [width, height] of [[80, 24], [140, 40]]) {
    const frame = formatOpenTuiPreviewText(ui, { width, height });
    const rows = frame.split("\n");
    assert.equal(rows.length, height);
    assert.ok(rows.every((row) => visibleLength(row) === width));
    assert.match(stripAnsi(frame), /co·ode · room Alpha · opencode/);
    assert.match(stripAnsi(frame), />/);
  }
});

test("OpenTUI preview dashboard navigates recent work and selected agent", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  assert.equal(ui.dashboardFocus, "runs");
  assert.equal(ui.selectedRunId, "run-a");
  assert.equal(ui.selectedAgentId, "agent-a");

  let result = reduceOpenTuiPreviewKey(ui, "j");
  ui = result.state;
  assert.equal(ui.dashboardFocus, "runs");
  assert.equal(ui.selectedRunId, "run-child");
  assert.match(ui.message, /Selected run 2\/2/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> 01 completed run-child Review terminal output - Builder/);

  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.mode, "run");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-child" });

  ui = createOpenTuiPreviewUiState(previewState());
  result = reduceOpenTuiPreviewKey(ui, "]");
  ui = result.state;
  assert.equal(ui.dashboardFocus, "agents");
  assert.equal(ui.selectedAgentId, "agent-b");
  assert.match(ui.message, /Selected agent 2\/2: Reviewer/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> ○ @reviewer\s+codex/);

  result = reduceOpenTuiPreviewKey(ui, "\t");
  assert.equal(result.state.dashboardFocus, "runs");
  assert.match(result.state.message, /Recent work focused/);
});

test("OpenTUI preview mouse selects dashboard rows and scrolls panes", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  const options = { width: 120, height: 40 };

  let frame = formatOpenTuiPreviewText(ui, options);
  let result = reduceOpenTuiPreviewMouse(ui, {
    type: "press",
    button: 0,
    column: 105,
    row: rowFor(frame, /@reviewer\s+codex/),
    released: false,
  }, options);
  ui = result.state;
  assert.equal(ui.dashboardFocus, "agents");
  assert.equal(ui.selectedAgentId, "agent-b");
  assert.match(ui.message, /Selected agent: Reviewer/);

  result = reduceOpenTuiPreviewMouse(ui, {
    type: "scroll",
    button: 65,
    column: 105,
    row: rowFor(frame, /@reviewer\s+codex/),
    released: false,
  }, options);
  assert.equal(result.state.dashboardFocus, "agents");
  assert.equal(result.state.selectedAgentId, "agent-a");

  frame = formatOpenTuiPreviewText(result.state, options);
  result = reduceOpenTuiPreviewMouse(result.state, {
    type: "press",
    button: 0,
    column: 8,
    row: rowFor(frame, /01 completed run-child/),
    released: false,
  }, options);
  assert.equal(result.state.mode, "run");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-child" });
  assert.match(result.state.message, /Loading task detail: run-child/);
});

test("OpenTUI preview restores persisted agent and last run when still available", () => {
  const ui = createOpenTuiPreviewUiState({
    ...previewState(),
    selectedAgentId: "agent-b",
    lastRunId: "run-child",
    pins: {
      rooms: [],
      providers: [],
      agents: [{ agentId: "agent-a", name: "Builder", provider: "opencode" }],
    },
  });

  assert.equal(ui.selectedAgentId, "agent-b");
  assert.equal(ui.selectedRunId, "run-child");
  assert.equal(ui.dashboardFocus, "runs");
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> @reviewer/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> 01 completed run-child/);
});

test("OpenTUI preview falls back from stale persisted selections", () => {
  const ui = createOpenTuiPreviewUiState({
    ...previewState(),
    selectedAgentId: "agent-missing",
    lastRunId: "run-missing",
    pins: {
      rooms: [],
      providers: [],
      agents: [{ agentId: "agent-b", name: "Reviewer", provider: "codex" }],
    },
  });

  assert.equal(ui.selectedAgentId, "agent-b");
  assert.equal(ui.selectedRunId, "run-a");
});

test("OpenTUI preview opens keyboard help overlay from room and task detail", () => {
  let ui = createOpenTuiPreviewUiState(previewState());

  let result = reduceOpenTuiPreviewKey(ui, "?");
  ui = result.state;
  assert.equal(ui.mode, "help");
  assert.equal(ui.helpReturnMode, "dashboard");
  assert.match(formatOpenTuiPreviewText(ui), /Keyboard Help/);
  assert.match(formatOpenTuiPreviewText(ui), /Room keys: j\/k move selected task/);
  assert.match(formatOpenTuiPreviewText(ui), /Ctrl\+P palette/);
  assert.match(formatOpenTuiPreviewText(ui), /Ctrl\+F find/);

  result = reduceOpenTuiPreviewKey(ui, "\u001b");
  ui = result.state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.helpReturnMode, undefined);

  ui = {
    ...ui,
    mode: "run",
    selectedRunId: "run-a",
    selectedRunDetail: runDetail(),
  };
  result = reduceOpenTuiPreviewKey(ui, "?");
  ui = result.state;
  assert.equal(ui.mode, "help");
  assert.equal(ui.helpReturnMode, "run");
  assert.match(formatOpenTuiPreviewText(ui), /Task detail keys: j\/k move patches/);

  result = reduceOpenTuiPreviewKey(ui, "q");
  assert.equal(result.state.mode, "run");
  assert.deepEqual(result.intent, { type: "none" });
});

test("OpenTUI preview composer sends '#' messages to the room chat", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  assert.equal(ui.mode, "dashboard");

  let result = reduceOpenTuiPreviewKey(ui, "t");
  ui = result.state;
  assert.equal(ui.mode, "task");

  for (const key of ["#", "F", "i", "x", "\n", "t", "e", "s", "t", "s"]) {
    result = reduceOpenTuiPreviewKey(ui, key);
    ui = result.state;
  }
  assert.equal(ui.taskInput, "#Fix\ntests");
  assert.match(formatOpenTuiPreviewText(ui), /\| tests_/);

  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "chat-message", bodyMd: "Fix\ntests" });
  assert.equal(ui.taskRunning, false);
  assert.deepEqual(ui.taskHistory, previewState().taskHistory);
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "");
  // No prompt echo: the send path folds the message back into the transcript
  // as a `#` chat turn once the server confirms it, so the reducer leaves the
  // transcript untouched.
  assert.equal(ui.transcript.length, 0);

  ui = completeOpenTuiTask(ui, "success", "Message sent.");
  assert.equal(ui.taskRunning, false);
  assert.match(formatOpenTuiPreviewText(ui), /Message sent/);
});

test("OpenTUI preview plain Enter starts a conversation with the default agent", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "hi there", taskCursor: "hi there".length };

  const result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "hi there", provider: "opencode", agentId: undefined });
  assert.equal(result.state.taskRunning, true);
  assert.equal(result.state.taskInput, "");
  assert.match(result.state.message, /Asking @opencode/);
});

test("OpenTUI preview tells the user when no agent can answer a plain message", () => {
  const state = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...state,
    dashboard: {
      ...state.dashboard,
      providerAvailability: {},
      dashboard: { ...state.dashboard.dashboard, agents: [] },
    },
  });
  ui = { ...ui, mode: "task", taskInput: "hello?", taskCursor: "hello?".length };

  const result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /No agent is connected yet/);
  assert.match(result.state.message, /#/);
});

test("OpenTUI preview does not submit another runnable task while one is running", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = {
    ...ui,
    mode: "task",
    taskRunning: true,
    taskInput: "/task second request",
    taskCursor: "/task second request".length,
  };

  const result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.taskRunning, true);
  assert.equal(result.state.taskInput, "");
  assert.match(result.state.message, /already running/i);
});

test("OpenTUI preview asks for manual approval when auto-run is off", () => {
  const state = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...state,
    safety: { ...state.safety, autoRun: false },
  });

  let result = reduceOpenTuiPreviewKey(ui, "t");
  ui = result.state;
  for (const key of ["/", "t", "a", "s", "k", " ", "F", "i", "x"]) {
    result = reduceOpenTuiPreviewKey(ui, key);
    ui = result.state;
  }

  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(result.intent.type, "none");
  assert.equal(ui.mode, "confirm");
  assert.equal(ui.taskRunning, false);
  assert.equal(ui.taskInput, "");
  assert.equal(ui.pendingApproval?.returnTaskInput, "/task Fix");
  assert.match(formatOpenTuiPreviewText(ui), /Approval\nRun agent task\?/);
  assert.match(formatOpenTuiPreviewText(ui), /Y\/Enter Run task/);

  result = reduceOpenTuiPreviewKey(ui, "y");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "submit", goal: "Fix" });
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.taskRunning, true);
  assert.equal(ui.taskInput, "");
  assert.equal(ui.safety.autoRun, false);
  assert.equal(ui.safety.audit.at(-1).decision, "allowed");
  assert.match(ui.safety.audit.at(-1).reason, /manually approved/);
});

test("OpenTUI preview turns bridge approval requests into approve and deny intents", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = {
    ...ui,
    taskRunning: true,
    mode: "dashboard",
  };

  ui = beginOpenTuiBridgeApproval(ui, {
    approvalId: "approval-a",
    kind: "file-edit",
    mode: "prompt",
    files: ["index.ts"],
    reason: "test edit",
  });
  assert.equal(ui.mode, "confirm");
  assert.equal(ui.taskRunning, true);
  assert.match(formatOpenTuiPreviewText(ui), /Approval\nApprove file edit approval\?/);
  assert.match(formatOpenTuiPreviewText(ui), /index\.ts/);

  let result = reduceOpenTuiPreviewKey(ui, "y");
  assert.deepEqual(result.intent, {
    type: "bridge-approval",
    approvalId: "approval-a",
    decision: "approve",
    target: "index.ts",
  });
  assert.equal(result.state.taskRunning, true);

  ui = beginOpenTuiBridgeApproval({ ...ui, mode: "dashboard", pendingApproval: undefined }, {
    approvalId: "approval-b",
    kind: "destructive",
    command: "rm -rf demo",
  });
  result = reduceOpenTuiPreviewKey(ui, "n");
  assert.deepEqual(result.intent, {
    type: "bridge-approval",
    approvalId: "approval-b",
    decision: "deny",
    target: "rm -rf demo",
  });
  assert.equal(result.state.taskRunning, true);
});

test("OpenTUI preview composer supports slash start, clear, backspace, cancel, and feed bounds", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  let result = reduceOpenTuiPreviewKey(ui, "/");
  ui = result.state;
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "/");

  ui = reduceOpenTuiPreviewKey(ui, "h").state;
  ui = reduceOpenTuiPreviewKey(ui, "\u007f").state;
  assert.equal(ui.taskInput, "/");

  ui = reduceOpenTuiPreviewKey(ui, "\u0015").state;
  assert.equal(ui.taskInput, "");

  ui = reduceOpenTuiPreviewKey(ui, "\u001b").state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.message, "Task composer cancelled.");

  const feed = Array.from({ length: 90 }, (_, index) => ({ kind: "info", text: String(index) }));
  assert.equal(appendOpenTuiFeed(feed, "info", "latest").length, 80);
  assert.equal(appendOpenTuiFeed(feed, "info", "latest").at(-1).text, "latest");
});

test("OpenTUI preview searches feed and terminal scrollback with slash command and Ctrl+F", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  let result = reduceOpenTuiPreviewKey(ui, "\x06");
  ui = result.state;
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "/find ");

  ui = {
    ...ui,
    mode: "task",
    taskInput: "/find dashboard",
    feed: appendOpenTuiFeed(ui.feed, "output", "Dashboard loaded"),
    terminalLines: ["co-od", "dashboard smoke passed"],
  };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "dashboard");
  assert.match(ui.message, /Found 2 feed\/terminal matches/);
  assert.match(ui.feed.at(-1).text, /terminal:2: dashboard smoke passed/);
  assert.match(ui.feed.at(-1).text, /feed:1\/output:1: Dashboard loaded/);
});

test("OpenTUI preview previews workspace files through slash commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-opentui-view-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "one\ntwo\nthree\nfour\nfive\n");

    let ui = createOpenTuiPreviewUiState({
      ...previewState(),
      args: {
        ...previewState().args,
        dir,
      },
    });
    ui = { ...ui, mode: "task", taskInput: "/view src/app.ts:3" };

    const result = reduceOpenTuiPreviewKey(ui, "\r");
    ui = result.state;
    assert.deepEqual(result.intent, { type: "none" });
    assert.equal(ui.mode, "dashboard");
    assert.match(ui.message, /Previewing src\/app\.ts:3/);
    assert.match(ui.feed.at(-1).text, /File src\/app\.ts:1-5 \(5 lines\)/);
    assert.match(ui.feed.at(-1).text, /> 3 \| three/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenTUI preview composer manages attachments through slash commands", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = reduceOpenTuiPreviewKey(ui, "/").state;
  for (const key of "attach README.md") {
    ui = reduceOpenTuiPreviewKey(ui, key).state;
  }

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "dashboard");
  assert.deepEqual(ui.attachments, [{ path: "README.md", kind: "file" }]);
  assert.match(ui.message, /Attached file: README\.md/);
  assert.match(formatOpenTuiPreviewText(ui), /1\. \[file\] README\.md/);

  ui = reduceOpenTuiPreviewKey(ui, "/").state;
  for (const key of "attach-image assets/screen.png") {
    ui = reduceOpenTuiPreviewKey(ui, key).state;
  }
  ui = reduceOpenTuiPreviewKey(ui, "\r").state;
  assert.equal(ui.attachments.at(-1).kind, "image");
  assert.match(formatOpenTuiPreviewText(ui), /\[image\] assets\/screen\.png/);

  ui = { ...ui, mode: "task", taskInput: "/attachments" };
  ui = reduceOpenTuiPreviewKey(ui, "\r").state;
  assert.match(ui.feed.at(-1).text, /1\. \[file\] README\.md/);
  assert.match(ui.feed.at(-1).text, /Provider transport for opencode:/);
  assert.match(ui.feed.at(-1).text, /native flags: none/);
  assert.match(ui.feed.at(-1).text, /prompt\/env fallback: \[file\] README\.md \(missing\), \[image\] assets\/screen\.png \(missing\)/);

  ui = { ...ui, mode: "task", taskInput: "/detach 1" };
  ui = reduceOpenTuiPreviewKey(ui, "\r").state;
  assert.equal(ui.attachments.some((attachment) => attachment.path === "README.md"), false);
});

test("OpenTUI preview exposes safety slash commands", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/safety" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /auto-run\s+on/);

  ui = { ...ui, mode: "task", taskInput: "/safety toggle auto-run" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.safety.autoRun, false);
  assert.match(ui.message, /auto-run off/);

  ui = { ...ui, mode: "task", taskInput: "/safety audit" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.match(result.state.feed.at(-1).text, /toggled\s+auto-run/);
});

test("OpenTUI preview exposes model slash command in task context", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/model anthropic/claude-sonnet-4-5" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.model, "anthropic/claude-sonnet-4-5");
  assert.match(ui.message, /Model set to anthropic\/claude-sonnet-4-5/);
  assert.match(formatOpenTuiPreviewText(ui), /co·ode · room Alpha · opencode model anthropic\/claude-sonnet-4-5/);

  ui = { ...ui, mode: "task", taskInput: "/model" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.model, "anthropic/claude-sonnet-4-5");
  assert.match(result.state.message, /Model selection needs a model name/);
});

test("OpenTUI preview autocompletes slash commands in the task composer", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/ren" };

  assert.match(formatOpenTuiPreviewText(ui), /commands/);
  assert.match(formatOpenTuiPreviewText(ui), /> \/rename\s+apply a validated symbol rename/);

  let result = reduceOpenTuiPreviewKey(ui, "\u001b[B");
  ui = result.state;
  assert.equal(ui.taskSuggestionSelected, 1);
  assert.match(formatOpenTuiPreviewText(ui), /> \/rename-preview\s+preview symbol rename occurrences/);

  result = reduceOpenTuiPreviewKey(ui, "\t");
  ui = result.state;
  assert.equal(ui.taskInput, "/rename-preview ");
  assert.equal(ui.taskSuggestionSelected, 0);
  assert.match(ui.message, /Completed \/rename-preview/);

  result = reduceOpenTuiPreviewKey({ ...ui, taskInput: "/find query" }, "\t");
  assert.equal(result.state.taskInput, "/find query");
  assert.equal(result.state.taskSuggestionSelected, 0);
});

test("OpenTUI preview routes leading provider mentions to exact local provider", () => {
  let ui = createOpenTuiPreviewUiState({
    ...previewState(),
    dashboard: {
      ...previewState().dashboard,
      providerAuth: [{ provider: "codex", label: "OpenAI Codex", status: "connected" }],
    },
  });

  ui = { ...ui, mode: "task", taskInput: "/task @co", taskCursor: "/task @co".length };
  let result = reduceOpenTuiPreviewKey(ui, "\t");
  assert.equal(result.state.taskInput, "/task @codex ");
  assert.match(result.state.message, /Targeting @codex/);

  ui = { ...result.state, taskInput: "/task @codex fix the parser", taskCursor: "/task @codex fix the parser".length };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "fix the parser", provider: "codex", agentId: undefined });
  assert.match(result.state.message, /Submitting task to @codex/);
});

test("OpenTUI preview treats leading provider mentions as agent chat asks", () => {
  let ui = createOpenTuiPreviewUiState({
    ...previewState(),
    dashboard: {
      ...previewState().dashboard,
      providerAuth: [{ provider: "codex", label: "OpenAI Codex", status: "connected" }],
    },
  });

  ui = { ...ui, mode: "task", taskInput: "@co", taskCursor: 3 };
  let result = reduceOpenTuiPreviewKey(ui, "\t");
  assert.equal(result.state.taskInput, "@codex ");
  assert.match(result.state.message, /Targeting @codex/);

  ui = { ...result.state, taskInput: "@codex hi", taskCursor: "@codex hi".length };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "hi", provider: "codex", agentId: undefined });
  assert.match(result.state.message, /Asking @codex/);

  result = reduceOpenTuiPreviewKey({ ...ui, taskInput: "@missing hi", taskCursor: "@missing hi".length }, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.taskInput, "@missing hi");
  assert.match(result.state.message, /No connected agent matches @missing/);
});

test("OpenTUI preview exposes basic slash command parity", () => {
  let ui = createOpenTuiPreviewUiState({
    ...previewState(),
    dashboard: {
      ...previewState().dashboard,
      rooms: [
        { _id: "room-b", name: "Beta", status: "active", agents: [{ name: "Builder" }], members: [{ name: "User" }] },
      ],
    },
  });

  ui = { ...ui, mode: "task", taskInput: "/help" };
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  // Help is an overlay now — feed lines are invisible once the conversation
  // has content, so /help must open a real surface.
  assert.equal(ui.mode, "help");
  assert.equal(ui.helpReturnMode, "task");
  ui = reduceOpenTuiPreviewKey(ui, "\u001b").state;

  ui = { ...ui, mode: "task", taskInput: "/runs" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Recent work:/);
  assert.match(ui.feed.at(-1).text, /run-a/);

  ui = { ...ui, mode: "task", taskInput: "/sessions" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /Provider sessions:/);
  assert.match(ui.feed.at(-1).text, /opencode-session-a/);

  ui = { ...ui, mode: "task", taskInput: "/session 1" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-a" });
  assert.match(ui.feed.at(-1).text, /Provider session 1 selected/);

  ui = { ...ui, mode: "task", taskInput: "/history" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Task history:/);
  assert.match(ui.feed.at(-1).text, /1\. Ship dashboard/);

  ui = { ...ui, mode: "task", taskInput: "/use-history 2" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "Fix tests");

  ui = { ...ui, mode: "task", taskInput: "/again 1" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "submit", goal: "Ship dashboard" });
  assert.match(ui.message, /Rerunning task history item 1/);

  ui = { ...ui, mode: "task", taskInput: "/health" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Health:/);
  assert.match(ui.feed.at(-1).text, /runtime\s+down HTTP 503/);

  ui = { ...ui, mode: "task", taskInput: "/doctor" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /co-od doctor/);
  assert.match(ui.feed.at(-1).text, /Checks:/);
  assert.match(ui.message, /Doctor/);

  ui = { ...ui, mode: "task", taskInput: "/qa" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /co-od TUI QA passed/);
  assert.match(ui.feed.at(-1).text, /file-mentions-undo/);
  assert.match(ui.message, /TUI QA passed/);

  ui = { ...ui, mode: "task", taskInput: "/tui-qa" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /co-od TUI QA passed/);

  ui = { ...ui, mode: "task", taskInput: "/qa live --room room-a --bridge-url http://bridge.test" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "live-qa", roomId: "room-a", includeTerminal: false, bridgeUrl: "http://bridge.test" });
  assert.match(ui.message, /Running live TUI QA/);

  ui = { ...ui, mode: "task", taskInput: "/live-qa room-b --terminal" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "live-qa", roomId: "room-b", includeTerminal: true, bridgeUrl: undefined });

  ui = { ...ui, mode: "task", taskInput: "/qa live --mutate" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /mutations/);

  ui = { ...ui, mode: "task", taskInput: "/runtime" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "runtime-action", action: "status", ttlSeconds: undefined });
  assert.match(ui.message, /Loading runtime status/);

  ui = { ...ui, mode: "task", taskInput: "/env start 900" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "confirm");
  assert.match(ui.pendingApproval?.title || "", /Start hosted runtime/);
  result = reduceOpenTuiPreviewKey(ui, "y");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "runtime-action", action: "start", ttlSeconds: 900 });
  assert.match(ui.message, /Starting runtime/);

  ui = { ...ui, mode: "task", taskInput: "/env-start later" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.message, /TTL must be a positive/);

  ui = { ...ui, mode: "task", taskInput: "/rooms" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Rooms:/);
  assert.match(ui.feed.at(-1).text, /Alpha/);
  assert.match(ui.feed.at(-1).text, /Beta/);

  ui = { ...ui, mode: "task", taskInput: "/room Beta" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "select-room", roomId: "room-b", roomName: "Beta" });
  assert.match(result.state.message, /Switching room to Beta/);

  ui = { ...result.state, mode: "task", taskInput: "/open" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "open-browser", url: "https://co-od.example/rooms/room-a" });
  assert.match(result.state.message, /Opening https:\/\/co-od\.example\/rooms\/room-a/);

  ui = { ...result.state, mode: "task", taskInput: "/login" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "login" });
  assert.match(result.state.message, /Starting login flow/);

  ui = { ...result.state, mode: "task", taskInput: "/init" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(result.state.pendingApproval?.title || "", /Reinitialize project room/);
  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, { type: "init-project" });
  assert.match(result.state.message, /Initializing project room/);

  const loggedOut = createOpenTuiPreviewUiState({
    ...previewState(),
    dashboard: { ...previewState().dashboard, session: null },
  });
  result = reduceOpenTuiPreviewKey({ ...loggedOut, mode: "task", taskInput: "/init" }, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /Login before initializing/);

  ui = { ...result.state, feed: [{ kind: "info", text: "old" }], mode: "task", taskInput: "/clear" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.deepEqual(result.state.feed, [{ kind: "info", text: "Feed cleared." }]);

  ui = { ...result.state, mode: "task", taskInput: "/quit" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "quit" });

  ui = { ...result.state, mode: "task", taskInput: "/exit" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "quit" });

  result = reduceOpenTuiPreviewKey({ ...result.state, mode: "task", taskInput: "draft" }, "\u0003");
  assert.deepEqual(result.intent, { type: "quit" });
});

test("OpenTUI preview supports pins and undo for local state", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/pin room" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.deepEqual(ui.pins.rooms, [{ roomId: "room-a", roomName: "Alpha" }]);
  assert.equal(ui.undoStack.length, 1);
  assert.match(ui.message, /Pinned current room/);

  ui = { ...ui, mode: "task", taskInput: "/pin provider codex" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(ui.pins.providers, ["codex"]);

  ui = { ...ui, mode: "task", taskInput: "/pin agent Builder" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(ui.pins.agents.map((agent) => agent.agentId), ["agent-a"]);

  ui = { ...ui, mode: "task", taskInput: "/pins" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Pinned preferences:/);
  assert.match(ui.feed.at(-1).text, /rooms\s+Alpha/);
  assert.match(ui.feed.at(-1).text, /providers codex/);
  assert.match(ui.feed.at(-1).text, /agents\s+Builder/);

  ui = { ...ui, mode: "task", taskInput: "/unpin provider codex" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(ui.pins.providers, []);
  assert.match(ui.message, /Unpinned provider/);

  ui = { ...ui, mode: "task", taskInput: "/undo" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(ui.pins.providers, ["codex"]);
  assert.match(ui.message, /Undid: unpin provider/);
  assert.equal(ui.safety.audit.at(-1).action, "undo");

  ui = { ...ui, mode: "task", taskInput: "/provider claude" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.dashboard.provider, "claude");

  ui = { ...ui, mode: "task", taskInput: "/undo" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.dashboard.provider, "opencode");
});

test("OpenTUI preview undo restores captured file edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-opentui-file-undo-"));
  const file = join(dir, "src.ts");
  writeFileSync(file, "const loadProject = true;\n");
  const base = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...base,
    args: { ...base.args, dir },
  });
  ui = {
    ...ui,
    undoStack: [createUndoSnapshot({
      label: "rename loadWorkspace -> loadProject",
      provider: ui.dashboard.provider,
      pins: ui.pins,
      safety: ui.safety,
      fileChanges: [{
        path: "src.ts",
        before: "const loadWorkspace = true;\n",
        after: "const loadProject = true;\n",
      }],
    })],
    mode: "task",
    taskInput: "/undo",
  };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.equal(readFileSync(file, "utf8"), "const loadWorkspace = true;\n");
  assert.equal(result.state.undoStack.length, 0);
  assert.match(result.state.feed.at(-1).text, /Restored files: src\.ts/);
});

test("OpenTUI preview exposes context, files, workspace, instructions, and memory slash commands", () => {
  let ui = createOpenTuiPreviewUiState({
    ...previewState(),
    workspace: {
      ...workspace,
      dirty: true,
      changedFiles: [{ status: " M", path: "src/app.ts" }],
      unstagedCount: 1,
      insertions: 3,
      deletions: 1,
    },
  });

  ui = { ...ui, mode: "task", taskInput: "/context" };
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(ui.feed.at(-1).text, /Task context:/);
  assert.match(ui.feed.at(-1).text, /workspace\s+branch main\s+dirty/);
  assert.match(ui.feed.at(-1).text, /MEMORY\.md - Project Memory/);

  ui = { ...ui, mode: "task", taskInput: "/files app" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Files matching app:/);
  assert.match(ui.feed.at(-1).text, /src\/app\.ts/);

  ui = { ...ui, mode: "task", taskInput: "/git" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /branch main/);
  assert.match(ui.feed.at(-1).text, / M src\/app\.ts/);

  ui = { ...ui, mode: "task", taskInput: "/instructions" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Project instructions:/);
  assert.match(ui.feed.at(-1).text, /AGENTS\.md - Guide/);

  ui = { ...ui, mode: "task", taskInput: "/instructions attach" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(result.state.attachments.some((attachment) => attachment.path === "AGENTS.md"), true);
  assert.match(result.state.message, /Attached 1 instruction files/);

  ui = { ...ui, mode: "task", taskInput: "/memory" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.match(ui.feed.at(-1).text, /Project memory:/);
  assert.match(ui.feed.at(-1).text, /MEMORY\.md - Project Memory/);

  ui = { ...ui, mode: "task", taskInput: "/memory attach" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.attachments.some((attachment) => attachment.path === "MEMORY.md"), true);
  assert.match(result.state.message, /Attached 1 memory files/);
});

test("OpenTUI preview palette attaches workspace files", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  assert.equal(openTuiPaletteItems(ui).some((item) => item.id === "file:src/app.ts"), true);

  ui = reduceOpenTuiPreviewKey(ui, "\u0010").state;
  for (const key of ["a", "p", "p", ".", "t", "s"]) {
    ui = reduceOpenTuiPreviewKey(ui, key).state;
  }
  const result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "dashboard");
  assert.deepEqual(ui.attachments, [{ path: "src/app.ts", kind: "file" }]);
  assert.match(ui.message, /Attached file: src\/app\.ts/);
});

test("OpenTUI preview slash fanout resolves local targets", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/fanout all Review the dashboard" };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.equal(result.state.mode, "dashboard");
  assert.equal(result.state.taskRunning, true);
  assert.equal(result.intent.type, "fanout");
  assert.equal(result.intent.goal, "Review the dashboard");
  assert.deepEqual(
    result.intent.targets.map((target) => [target.agentId, target.provider]),
    [["agent-a", "opencode"], ["agent-b", "codex"]],
  );
  assert.match(result.state.message, /Fan-out running for 2 agents/);
});

test("OpenTUI preview slash fanout reports invalid targets", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/fanout missing Do work" };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /No local CLI agents are available/);
  assert.match(result.state.feed.at(-1).text, /missing: not found/);
});

test("OpenTUI preview slash handoff resolves current run to target agent", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiRunDetail(
    { ...ui, mode: "run", selectedRunId: "run-a" },
    runDetail({ allRuns: previewState().dashboard.dashboard.runs }),
  );
  ui = { ...ui, mode: "task", taskInput: "/handoff current Reviewer Check terminal output" };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.equal(result.intent.type, "handoff");
  assert.equal(result.intent.resolution.sourceRunId, "run-a");
  assert.equal(result.intent.resolution.targetAgentId, "agent-b");
  assert.equal(result.intent.resolution.targetProvider, "codex");
  assert.equal(result.intent.resolution.context, "Check terminal output");
  assert.match(result.state.message, /Handing off to Reviewer/);
});

test("OpenTUI preview slash handoff reports invalid arguments", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/handoff" };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /Usage: \/handoff/);
});

test("OpenTUI preview slash agent lifecycle commands resolve supported actions", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/agent-start Builder Fix flaky tests" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, {
    type: "agent-start",
    goal: "Fix flaky tests",
    provider: "opencode",
    agentId: "agent-a",
  });
  assert.equal(result.state.taskRunning, true);
  assert.match(result.state.message, /Starting Builder/);

  ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/agent-stop Builder" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nStop active agent tasks\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, {
    type: "agent-stop",
    agentId: "agent-a",
    agentName: "Builder",
    runIds: ["run-a"],
  });
  assert.match(result.state.message, /Stopping 1 active task/);
});

test("OpenTUI preview slash agent lifecycle resolves pause and resume", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/agent-pause Builder" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nPause active agent tasks\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, {
    type: "agent-pause",
    agentId: "agent-a",
    agentName: "Builder",
    runIds: ["run-a"],
  });
  assert.match(result.state.message, /Pausing 1 active task/);

  const state = previewState();
  state.dashboard.dashboard.runs = [
    { ...state.dashboard.dashboard.runs[0], status: "paused" },
    ...state.dashboard.dashboard.runs.slice(1),
  ];
  ui = createOpenTuiPreviewUiState(state);
  ui = { ...ui, mode: "task", taskInput: "/agent-resume Builder" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, {
    type: "agent-resume",
    agentId: "agent-a",
    agentName: "Builder",
    runIds: ["run-a"],
  });
  assert.match(result.state.message, /Resuming 1 paused run/);
});

test("OpenTUI preview slash symbol commands emit async renderer intents", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/search dashboard" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "search-workspace", query: "dashboard" });
  assert.match(result.state.message, /Searching workspace for dashboard/);

  ui = { ...result.state, mode: "task", taskInput: "/diff src/app.ts" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "workspace-diff", path: "src/app.ts" });
  assert.match(result.state.message, /Loading diff for src\/app\.ts/);

  ui = { ...result.state, mode: "task", taskInput: "/symbols loadWorkspace" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "list-symbols", query: "loadWorkspace" });
  assert.match(result.state.message, /Scanning symbols for loadWorkspace/);

  ui = { ...result.state, mode: "task", taskInput: "/goto loadWorkspace" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "goto-symbol", query: "loadWorkspace" });
  assert.match(result.state.message, /Finding symbol loadWorkspace/);

  ui = { ...result.state, mode: "task", taskInput: "/rename-preview loadWorkspace loadProject" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, {
    type: "rename-preview",
    oldName: "loadWorkspace",
    newName: "loadProject",
  });
  assert.match(result.state.message, /Previewing rename loadWorkspace -> loadProject/);

  ui = { ...result.state, mode: "task", taskInput: "/rename loadWorkspace loadProject" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nApply rename loadWorkspace -> loadProject\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, {
    type: "rename-apply",
    oldName: "loadWorkspace",
    newName: "loadProject",
  });
  assert.match(result.state.message, /Applying rename loadWorkspace -> loadProject/);

  ui = { ...result.state, mode: "task", taskInput: "/diagnostics tsconfig.json" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "diagnostics", project: "tsconfig.json" });
  assert.match(result.state.message, /Running TypeScript diagnostics for tsconfig\.json/);

  ui = { ...result.state, mode: "task", taskInput: "/diagnostics python" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "diagnostics", project: "python" });
  assert.match(result.state.message, /Running Python diagnostics/);

  ui = { ...result.state, mode: "task", taskInput: "/diagnostics go" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "diagnostics", project: "go" });
  assert.match(result.state.message, /Running Go diagnostics/);

  ui = { ...result.state, mode: "task", taskInput: "/diagnostics rust" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "diagnostics", project: "rust" });
  assert.match(result.state.message, /Running Rust diagnostics/);

  ui = { ...result.state, mode: "task", taskInput: "/diagnostics all" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "diagnostics", project: "all" });
  assert.match(result.state.message, /Running workspace diagnostics/);
});

test("OpenTUI preview renders navigable workspace result panes", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiWorkspaceSearch(ui, {
    query: "dashboard",
    matches: [{
      path: "README.md",
      line: 10,
      column: 3,
      text: "dashboard docs",
    }, {
      path: "src/app.ts",
      line: 20,
      column: 5,
      text: "render dashboard",
    }],
  });

  assert.equal(ui.mode, "workspace");
  assert.equal(ui.workspaceResults.kind, "search");
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Workspace Search/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> README\.md:10:3  dashboard docs/);

  let result = reduceOpenTuiPreviewKey(ui, "j");
  ui = result.state;
  assert.equal(ui.workspaceResults.selectedIndex, 1);
  assert.match(ui.message, /Selected 2\/2: src\/app\.ts:20:5/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> src\/app\.ts:20:5  render dashboard/);

  result = reduceOpenTuiPreviewKey(ui, "g");
  assert.equal(result.state.workspaceResults.selectedIndex, 0);

  result = reduceOpenTuiPreviewKey(result.state, "G");
  assert.equal(result.state.workspaceResults.selectedIndex, 1);

  result = reduceOpenTuiPreviewKey(result.state, "a");
  assert.equal(result.state.mode, "workspace");
  assert.deepEqual(result.state.attachments, [{ path: "src/app.ts", kind: "file" }]);
  assert.match(result.state.message, /Attached file: src\/app\.ts/);

  result = reduceOpenTuiPreviewKey(result.state, "\r");
  assert.equal(result.state.mode, "task");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.taskInput, "Review @src/app.ts around line 20: render dashboard");
  assert.match(result.state.message, /Already attached: src\/app\.ts\. Task composer prefilled/);

  result = reduceOpenTuiPreviewKey({ ...result.state, mode: "workspace" }, "\u001b");
  assert.equal(result.state.mode, "dashboard");

  ui = completeOpenTuiWorkspaceSearch(createOpenTuiPreviewUiState(previewState()), {
    query: "dashboard",
    matches: [{
      path: "README.md",
      line: 10,
      column: 3,
      text: "dashboard docs",
    }, {
      path: "src/app.ts",
      line: 20,
      column: 5,
      text: "render dashboard",
    }],
  });
  result = reduceOpenTuiPreviewMouse(ui, {
    type: "press",
    button: 0,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(ui, { width: 120, height: 50 }), /src\/app\.ts:20:5/),
    released: false,
  }, { width: 120, height: 50 });
  assert.equal(result.state.workspaceResults.selectedIndex, 1);
  assert.match(result.state.message, /Selected 2\/2: src\/app\.ts:20:5/);

  result = reduceOpenTuiPreviewMouse(result.state, {
    type: "scroll",
    button: 64,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(result.state, { width: 120, height: 50 }), /src\/app\.ts:20:5/),
    released: false,
  }, { width: 120, height: 50 });
  assert.equal(result.state.workspaceResults.selectedIndex, 0);

  ui = completeOpenTuiWorkspaceDiff(createOpenTuiPreviewUiState(previewState()), {
    path: "src/app.ts",
    lines: [
      "diff --git a/src/app.ts b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ],
    truncated: false,
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Workspace Diff/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), />\s+1\s+diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.taskInput, "Review the local diff for @src/app.ts.");

  ui = completeOpenTuiWorkspaceSymbols(createOpenTuiPreviewUiState(previewState()), {
    query: "load",
    scannedFiles: 3,
    symbols: [{
      path: "src/workspace.ts",
      line: 4,
      column: 17,
      kind: "function",
      name: "loadWorkspace",
      signature: "export function loadWorkspace()",
    }],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Workspace Symbols/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /function\s+loadWorkspace/);
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.taskInput, "Review @src/workspace.ts symbol loadWorkspace at line 4.");

  ui = completeOpenTuiSymbolNavigation(createOpenTuiPreviewUiState(previewState()), {
    query: "loadWorkspace",
    scannedFiles: 5,
    source: "typescript",
    message: "Found loadWorkspace in src/workspace.ts:4:17",
    symbol: {
      path: "src/workspace.ts",
      line: 4,
      column: 17,
      kind: "function",
      name: "loadWorkspace",
      signature: "export function loadWorkspace()",
    },
  });
  assert.equal(ui.mode, "workspace");
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Symbol Location/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /src\/workspace\.ts:4:17/);
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(
    result.state.taskInput,
    "Review @src/workspace.ts symbol loadWorkspace at line 4: export function loadWorkspace()",
  );

  ui = completeOpenTuiSymbolNavigation(createOpenTuiPreviewUiState(previewState()), {
    query: "missingSymbol",
    scannedFiles: 5,
    message: "No matching symbol found.",
    error: "No matching symbol found.",
  });
  assert.equal(ui.mode, "workspace");
  assert.match(ui.message, /No matching symbol/);
  assert.equal(ui.workspaceResults?.entries.length, 0);

  ui = completeOpenTuiRenamePreview(createOpenTuiPreviewUiState(previewState()), {
    oldName: "loadWorkspace",
    newName: "loadProject",
    scannedFiles: 5,
    source: "typescript",
    message: "TypeScript rename preview loadWorkspace -> loadProject: 2 occurrences across 5 files.",
    symbol: {
      path: "src/workspace.ts",
      line: 4,
      column: 17,
      kind: "function",
      name: "loadWorkspace",
      signature: "export function loadWorkspace()",
    },
    occurrences: [{
      path: "src/workspace.ts",
      line: 4,
      column: 17,
      text: "export function loadWorkspace()",
    }, {
      path: "src/app.ts",
      line: 20,
      column: 9,
      text: "await loadWorkspace()",
    }],
  });
  assert.equal(ui.mode, "workspace");
  assert.equal(ui.workspaceResults.kind, "rename");
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Rename Preview/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> src\/workspace\.ts:4:17  export function loadWorkspace/);
  result = reduceOpenTuiPreviewKey(ui, "j");
  result = reduceOpenTuiPreviewKey(result.state, "\r");
  assert.equal(
    result.state.taskInput,
    "Review rename loadWorkspace -> loadProject in @src/app.ts at line 20: await loadWorkspace()",
  );
  assert.deepEqual(result.state.attachments, [{ path: "src/app.ts", kind: "file" }]);

  ui = completeOpenTuiRenamePreview(createOpenTuiPreviewUiState(previewState()), {
    oldName: "missingSymbol",
    newName: "renamedSymbol",
    scannedFiles: 5,
    message: "No occurrences to rename for missingSymbol.",
    error: "No occurrences to rename for missingSymbol.",
    occurrences: [],
  });
  assert.equal(ui.mode, "workspace");
  assert.match(ui.message, /No occurrences/);
  assert.equal(ui.workspaceResults?.entries.length, 0);

  ui = completeOpenTuiDiagnostics(createOpenTuiPreviewUiState(previewState()), {
    kind: "typescript",
    project: "tsconfig.json",
    diagnostics: [{
      file: "src/app.ts",
      line: 8,
      column: 12,
      code: "TS2345",
      severity: "error",
      message: "Argument type mismatch",
    }],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /TypeScript Diagnostics/);
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /> src\/app\.ts:8:12  TS2345 Argument type mismatch/);
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.taskInput, "Fix TS2345 in @src/app.ts at line 8: Argument type mismatch");

  ui = completeOpenTuiDiagnostics(createOpenTuiPreviewUiState(previewState()), {
    kind: "python",
    label: "python (2 files)",
    project: "python",
    diagnostics: [{
      file: "src/app.py",
      line: 2,
      column: 1,
      code: "SyntaxError",
      severity: "error",
      message: "invalid syntax",
      language: "python",
    }],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Python Diagnostics/);
  assert.match(ui.workspaceResults?.summary || "", /1 diagnostics in python \(2 files\)/);

  ui = completeOpenTuiDiagnostics(createOpenTuiPreviewUiState(previewState()), {
    kind: "go",
    label: "go (2 files)",
    project: "go",
    diagnostics: [{
      file: "main.go",
      line: 6,
      column: 13,
      code: "GO",
      severity: "error",
      message: "undefined: missingValue",
      language: "go",
    }],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Go Diagnostics/);
  assert.match(ui.workspaceResults?.summary || "", /1 diagnostics in go \(2 files\)/);

  ui = completeOpenTuiDiagnostics(createOpenTuiPreviewUiState(previewState()), {
    kind: "rust",
    label: "rust (2 files)",
    project: "rust",
    diagnostics: [{
      file: "src/main.rs",
      line: 6,
      column: 13,
      code: "E0425",
      severity: "error",
      message: "cannot find value `missing` in this scope",
      language: "rust",
    }],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Rust Diagnostics/);
  assert.match(ui.workspaceResults?.summary || "", /1 diagnostics in rust \(2 files\)/);

  ui = completeOpenTuiDiagnostics(createOpenTuiPreviewUiState(previewState()), {
    kind: "all",
    label: "all (tsconfig.json, python (2 files), go (1 files))",
    project: "all",
    diagnostics: [
      {
        file: "src/app.ts",
        line: 8,
        column: 12,
        code: "TS2345",
        severity: "error",
        message: "Argument type mismatch",
        language: "typescript",
      },
      {
        file: "scripts/bad.py",
        line: 2,
        column: 1,
        code: "SyntaxError",
        severity: "error",
        message: "invalid syntax",
        language: "python",
      },
    ],
  });
  assert.match(stripAnsi(formatOpenTuiPreviewText(ui)), /Workspace Diagnostics/);
  assert.match(ui.workspaceResults?.summary || "", /2 diagnostics in all/);
});

test("OpenTUI preview slash run continuation commands emit submit intents", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = { ...ui, mode: "task", taskInput: "/continue run-a Follow up" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "Follow up", continueRunId: "run-a" });
  assert.match(result.state.message, /Continuing run-a/);

  ui = { ...result.state, mode: "task", taskInput: "/resume run-a" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.intent.type, "submit");
  assert.equal(result.intent.continueRunId, "run-a");
  assert.match(result.intent.goal, /Resume this run/);
  assert.match(result.state.message, /Resuming run-a/);

  ui = { ...result.state, mode: "task", taskInput: "/fork run-a Try alternate path" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.intent.type, "submit");
  assert.equal(result.intent.continueRunId, undefined);
  assert.deepEqual(result.intent.providerSession, {
    mode: "fork",
    sourceRunId: "run-a",
    providerSessionId: "opencode-session-a",
  });
  assert.match(result.intent.goal, /Fork from run run-a/);
  assert.match(result.intent.goal, /Try alternate path/);
  assert.match(result.state.message, /Forking run-a/);

  ui = { ...result.state, mode: "task", taskInput: "/rerun run-a" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "Ship dashboard" });
  assert.match(result.state.message, /Rerunning run-a/);

  const failedState = previewState();
  ui = createOpenTuiPreviewUiState({
    ...failedState,
    dashboard: {
      ...failedState.dashboard,
      dashboard: {
        ...failedState.dashboard.dashboard,
        runs: [{
          ...failedState.dashboard.dashboard.runs[0],
          status: "failed",
        }, failedState.dashboard.dashboard.runs[1]],
      },
    },
  });
  ui = { ...ui, mode: "task", taskInput: "/retry run-a" };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "submit", goal: "Ship dashboard" });
  assert.match(result.state.message, /Retrying run-a/);
});

test("OpenTUI preview slash continue asks for manual approval when auto-run is off", () => {
  const state = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...state,
    safety: { ...state.safety, autoRun: false },
  });
  ui = { ...ui, mode: "task", taskInput: "/continue run-a Follow up" };

  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(ui), /Approval\nContinue task\?/);

  result = reduceOpenTuiPreviewKey(ui, "y");
  assert.deepEqual(result.intent, { type: "submit", goal: "Follow up", continueRunId: "run-a" });
  assert.equal(result.state.mode, "dashboard");
  assert.equal(result.state.taskRunning, true);
});

test("OpenTUI preview palette opens, filters, moves, and selects providers", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  assert.equal(openTuiPaletteItems(ui).some((item) => item.id === "provider:opencode"), true);

  let result = reduceOpenTuiPreviewKey(ui, "\u0010");
  ui = result.state;
  assert.equal(ui.mode, "palette");
  assert.match(formatOpenTuiPreviewText(ui), /Command Palette/);

  for (const key of ["c", "o", "d", "e", "x"]) {
    ui = reduceOpenTuiPreviewKey(ui, key).state;
  }
  assert.equal(filteredOpenTuiPaletteItems(ui)[0].id, "provider:codex");

  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.dashboard.provider, "codex");
  assert.match(ui.message, /Provider selected: codex/);
  assert.match(formatOpenTuiPreviewText(ui), /co·ode · room Alpha · codex/);

  ui = { ...ui, mode: "palette", paletteInput: "opencode", paletteSelected: 0 };
  result = reduceOpenTuiPreviewMouse(ui, {
    type: "press",
    button: 0,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(ui, { width: 120, height: 50 }), /provider\s+opencode/),
    released: false,
  }, { width: 120, height: 50 });
  ui = result.state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.dashboard.provider, "opencode");
  assert.match(ui.message, /Provider selected: opencode/);
});

test("OpenTUI preview palette opens keyboard help action", () => {
  const ui = {
    ...createOpenTuiPreviewUiState(previewState()),
    mode: "palette",
    paletteInput: "keyboard",
    paletteSelected: 0,
  };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.equal(result.state.mode, "help");
  assert.equal(result.state.helpReturnMode, "dashboard");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(formatOpenTuiPreviewText(result.state), /Keyboard Help/);
});

test("OpenTUI preview palette routes run, rooms, and browser actions", () => {
  const dashboard = {
    ...previewState().dashboard,
    rooms: [
      { _id: "room-b", name: "Beta", status: "active", agents: [{ name: "Builder" }], members: [{ name: "User" }] },
    ],
  };
  let ui = createOpenTuiPreviewUiState({ ...previewState(), dashboard });

  ui = { ...ui, mode: "palette", paletteInput: "inspect latest", paletteSelected: 0 };
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.mode, "run");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-a" });
  assert.match(result.state.message, /Loading task detail: run-a/);

  ui = { ...result.state, mode: "palette", paletteInput: "show server rooms", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.mode, "dashboard");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.feed.at(-1).text, /Rooms:/);
  assert.match(result.state.feed.at(-1).text, /Beta active room-b/);

  ui = { ...result.state, mode: "palette", paletteInput: "browser workspace", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.mode, "dashboard");
  assert.deepEqual(result.intent, { type: "open-browser", url: "https://co-od.example/rooms/room-a" });
  assert.match(result.state.message, /Opening https:\/\/co-od\.example\/rooms\/room-a/);
});

test("OpenTUI preview palette routes login and init actions", () => {
  let ui = createOpenTuiPreviewUiState(previewState());

  ui = { ...ui, mode: "palette", paletteInput: "refresh login", paletteSelected: 0 };
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "login" });
  assert.match(result.state.message, /Starting login flow/);

  ui = { ...result.state, mode: "palette", paletteInput: "reinitialize", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(result.state.pendingApproval?.title || "", /Reinitialize project room/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, { type: "init-project" });
});

test("OpenTUI preview palette explains disabled actions before routing", () => {
  const baseState = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...baseState,
    dashboard: {
      ...baseState.dashboard,
      config: null,
      session: null,
      dashboard: {
        ...baseState.dashboard.dashboard,
        runs: [],
      },
    },
  });

  ui = { ...ui, mode: "palette", paletteInput: "run an agent task", paletteSelected: 0 };
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "dashboard");
  assert.match(result.state.message, /no room configured/);
  assert.match(result.state.feed.at(-1).text, /Run an agent task is unavailable/);

  ui = { ...result.state, mode: "palette", paletteInput: "show server rooms", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /login required/);
});

test("OpenTUI preview palette selects slash commands, agents, runs, and can close", () => {
  let ui = createOpenTuiPreviewUiState(previewState());

  ui = reduceOpenTuiPreviewKey(ui, "\u0010").state;
  ui = reduceOpenTuiPreviewKey(ui, "/").state;
  ui = reduceOpenTuiPreviewKey(ui, "r").state;
  ui = reduceOpenTuiPreviewKey(ui, "u").state;
  ui = reduceOpenTuiPreviewKey(ui, "n").state;
  let result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "/run ");

  ui = { ...ui, mode: "palette", paletteInput: "builder", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.selectedAgentId, "agent-a");
  assert.match(formatOpenTuiPreviewText(ui), /target @builder/);

  ui = { ...ui, mode: "palette", paletteInput: "ship dashboard", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.equal(ui.selectedRunId, "run-a");
  assert.equal(ui.mode, "run");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-a" });
  assert.match(ui.message, /Loading task detail: run-a/);
  assert.equal(ui.feed.at(-1).text, "Task selected: run-a Ship dashboard");

  ui = { ...ui, mode: "palette", paletteInput: "/run", paletteSelected: 0 };
  result = reduceOpenTuiPreviewMouse(ui, {
    type: "press",
    button: 0,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(ui, { width: 120, height: 50 }), /slash\s+\/run/),
    released: false,
  }, { width: 120, height: 50 });
  ui = result.state;
  assert.equal(ui.mode, "task");
  assert.equal(ui.taskInput, "/run ");

  ui = { ...ui, mode: "palette", paletteInput: "alpha room", paletteSelected: 0 };
  result = reduceOpenTuiPreviewKey(ui, "\r");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "select-room", roomId: "room-a", roomName: "Alpha" });
  assert.match(ui.message, /Switching room to Alpha/);
  // No feed echo for the switch itself — the completion posts one "✓ <room>"
  // line, so a room change reads as one event, not two.

  ui = { ...ui, mode: "palette", paletteInput: "zzz", paletteSelected: 0 };
  ui = reduceOpenTuiPreviewKey(ui, "\u001b").state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.paletteInput, "");
});

test("OpenTUI preview task detail opens from dashboard and renders result, work trail, delegation, and patches", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  let result = reduceOpenTuiPreviewKey(ui, "v");
  ui = result.state;

  assert.equal(ui.mode, "run");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-a" });
  let text = formatOpenTuiPreviewText(ui);
  assert.match(text, /Task/);
  assert.match(text, /loading\s+refreshing task detail/);
  assert.match(text, /work trail/);
  assert.match(text, /01 tool ok\s+Inspect current dashboard/);
  assert.match(text, /> root run-a running/);
  assert.match(text, /spawn run-child completed/);
  assert.match(text, /patches/);

  ui = completeOpenTuiRunDetail(ui, runDetail({ patches: runDetail().patches.slice(0, 1) }));

  text = formatOpenTuiPreviewText(ui);
  assert.equal(ui.message, "Task detail loaded: run-a");
  assert.match(text, /id\s+run-a/);
  assert.match(text, /result/);
  assert.match(text, /02 tool_call failed\s+Denied destructive \(deny\): rm -rf demo - dangerous test command/);
  assert.match(text, /03 patch failed\s+Patch failed validation/);
  assert.match(text, /patches/);
  assert.match(text, /> 01 proposed patch-a \+1 -1 Dashboard copy/);
  assert.match(text, /Diff Preview patch-a \+1 -1/);
  assert.match(text, /\+ \+added/);
  assert.match(text, /- -removed/);

  ui = reduceOpenTuiPreviewKey(ui, "\u001b").state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.message, "Task detail closed.");
});

test("OpenTUI preview task detail navigates patches and emits accept/reject intents", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiRunDetail({ ...ui, mode: "run", selectedRunId: "run-a" }, runDetail());

  let result = reduceOpenTuiPreviewKey(ui, "j");
  ui = result.state;
  assert.equal(ui.selectedPatchIndex, 1);
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(formatOpenTuiPreviewText(ui), /> 02 proposed patch-b \+1 -0 Renderer docs/);

  ui = reduceOpenTuiPreviewKey(ui, "k").state;
  assert.equal(ui.selectedPatchIndex, 0);

  result = reduceOpenTuiPreviewMouse(ui, {
    type: "press",
    button: 0,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(ui, { width: 120, height: 60 }), /patch-b/),
    released: false,
  }, { width: 120, height: 60 });
  ui = result.state;
  assert.equal(ui.selectedPatchIndex, 1);
  assert.match(ui.message, /Selected patch 2 of 2/);

  result = reduceOpenTuiPreviewMouse(ui, {
    type: "scroll",
    button: 64,
    column: 3,
    row: rowFor(formatOpenTuiPreviewText(ui, { width: 120, height: 60 }), /patch-b/),
    released: false,
  }, { width: 120, height: 60 });
  ui = result.state;
  assert.equal(ui.selectedPatchIndex, 0);

  ui = reduceOpenTuiPreviewKey(ui, "G").state;
  assert.equal(ui.selectedPatchIndex, 1);

  ui = reduceOpenTuiPreviewKey(ui, "g").state;
  assert.equal(ui.selectedPatchIndex, 0);

  result = reduceOpenTuiPreviewKey(ui, "a");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(ui), /Approval\nAccept proposed patch\?/);

  result = reduceOpenTuiPreviewKey(ui, "y");
  ui = result.state;
  assert.deepEqual(result.intent, {
    type: "resolve-patch",
    runId: "run-a",
    patchId: "patch-a",
    action: "accept",
  });
  assert.match(ui.message, /Accepting patch patch-a/);
  assert.equal(ui.mode, "run");
  assert.equal(ui.safety.audit.at(-1).action, "file-edit");

  ui = completeOpenTuiPatchResolve(ui, runDetail({
    patches: [{
      ...runDetail().patches[0],
      status: "accepted",
    }, runDetail().patches[1]],
  }), "accept", "patch-a");
  assert.match(ui.message, /Patch accepted: patch-a/);
  assert.match(formatOpenTuiPreviewText(ui), /> 01 accepted patch-a/);

  result = reduceOpenTuiPreviewKey(ui, "a");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /already accepted/);

  ui = { ...ui, selectedPatchIndex: 1 };
  result = reduceOpenTuiPreviewKey(ui, "x");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nReject proposed patch\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, {
    type: "resolve-patch",
    runId: "run-a",
    patchId: "patch-b",
    action: "reject",
  });
  ui = result.state;
  assert.equal(ui.safety.audit.at(-1).action, "destructive");

  ui = completeOpenTuiPatchResolve(ui, runDetail({
    patches: [runDetail().patches[0], {
      ...runDetail().patches[1],
      status: "rejected",
    }],
  }), "reject", "patch-b");
  assert.equal(ui.undoStack.at(-1).serverChanges[0].patchId, "patch-b");
  assert.match(ui.feed.at(-1).text, /Use \/undo to reopen/);

  result = reduceOpenTuiPreviewKey({ ...ui, mode: "task", taskInput: "/undo" }, "\r");
  assert.equal(result.intent.type, "server-undo");
  assert.equal(result.intent.snapshot.serverChanges[0].patchId, "patch-b");
  assert.match(result.state.message, /Restoring server state/);
});

test("OpenTUI preview terminal mode connects, renders output, sends input, and pauses", () => {
  let ui = createOpenTuiPreviewUiState(previewState());

  let result = reduceOpenTuiPreviewKey(ui, "c");
  ui = result.state;
  assert.equal(ui.mode, "terminal");
  assert.deepEqual(result.intent, { type: "connect-terminal" });
  assert.equal(ui.terminal.connecting, true);
  assert.match(formatOpenTuiPreviewText(ui), /Shared Terminal\nstatus\s+connecting/);

  ui = handleOpenTuiTerminalEvent(ui, { type: "connecting" });
  ui = handleOpenTuiTerminalEvent(ui, {
    type: "status",
    message: "Connected. Terminal is now shared with the room.",
    connected: true,
  });
  assert.equal(ui.terminal.connected, true);

  ui = handleOpenTuiTerminalEvent(ui, { type: "output", data: "hello\r\nworld\n" });
  let text = formatOpenTuiPreviewText(ui);
  assert.match(text, /status\s+connected/);
  assert.match(text, /keys\s+Esc or Ctrl\+\] returns to dashboard/);
  assert.match(text, /hello\nworld/);

  result = reduceOpenTuiPreviewKey(ui, "l");
  assert.deepEqual(result.intent, { type: "terminal-input", data: "l" });

  ui = reduceOpenTuiPreviewKey(ui, "\u001d").state;
  assert.equal(ui.mode, "dashboard");
  assert.equal(ui.message, "Shared terminal input paused.");

  ui = handleOpenTuiTerminalEvent(ui, { type: "closed", reason: "Terminal closed by user" });
  assert.equal(ui.terminal.connected, false);
  assert.match(ui.message, /disconnected/);
  assert.match(formatOpenTuiPreviewText(ui), /status\s+disconnected \(Terminal closed by user\)/);
});

test("OpenTUI preview terminal connection asks for approval when network is disabled", () => {
  const state = previewState();
  let ui = createOpenTuiPreviewUiState({
    ...state,
    safety: { ...state.safety, networkEnabled: false },
  });

  let result = reduceOpenTuiPreviewKey(ui, "c");
  ui = result.state;
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(ui.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(ui), /Approval\nConnect shared terminal\?/);
  assert.match(formatOpenTuiPreviewText(ui), /Network needs approval because network is disabled/);

  result = reduceOpenTuiPreviewKey(ui, "y");
  assert.deepEqual(result.intent, { type: "connect-terminal" });
  assert.equal(result.state.mode, "terminal");
  assert.equal(result.state.terminal.connecting, true);
  assert.equal(result.state.safety.networkEnabled, false);
  assert.equal(result.state.safety.audit.at(-1).action, "network");
});

test("OpenTUI preview task detail emits copy, export, retry, and stop intents", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiRunDetail({ ...ui, mode: "run", selectedRunId: "run-a" }, runDetail({
    run: {
      ...runDetail().run,
      status: "failed",
    },
    allRuns: [{
      ...runDetail().run,
      status: "failed",
    }],
  }));

  let result = reduceOpenTuiPreviewKey(ui, "y");
  assert.deepEqual(result.intent, { type: "copy-run", kind: "summary" });
  assert.match(result.state.message, /Copying task summary/);

  ui = completeOpenTuiRunCopy(result.state, "summary");
  assert.match(ui.message, /Copied task summary to clipboard/);

  result = reduceOpenTuiPreviewKey(ui, "e");
  assert.deepEqual(result.intent, { type: "export-run" });
  assert.match(result.state.message, /Exporting task summary/);

  ui = completeOpenTuiRunExport(result.state, "/tmp/project/.co-od/runs/run-a.md");
  assert.match(ui.message, /Exported task summary/);

  result = reduceOpenTuiPreviewKey(ui, "R");
  assert.deepEqual(result.intent, { type: "submit", goal: "Ship dashboard" });
  assert.equal(result.state.mode, "dashboard");
  assert.equal(result.state.taskRunning, true);
  assert.match(result.state.message, /Retrying run-a/);

  ui = completeOpenTuiRunDetail({ ...ui, mode: "run", selectedRunId: "run-a" }, runDetail({
    run: {
      ...runDetail().run,
      status: "running",
    },
    allRuns: [{
      ...runDetail().run,
      status: "running",
    }],
  }));
  result = reduceOpenTuiPreviewKey(ui, "s");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nStop agent task\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, { type: "stop-run", runId: "run-a" });
  assert.match(result.state.message, /Stopping task run-a/);
  assert.equal(result.state.safety.audit.at(-1).action, "destructive");
  const stoppingState = result.state;

  result = reduceOpenTuiPreviewKey(ui, "]");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.selectedHandoffTargetAgentId, "agent-a");
  assert.match(result.state.message, /Handoff target: Builder/);
  assert.match(formatOpenTuiPreviewText(result.state), /handoff\s+Builder/);

  result = reduceOpenTuiPreviewKey(result.state, "]");
  assert.equal(result.state.selectedHandoffTargetAgentId, "agent-b");
  assert.match(result.state.message, /Handoff target: Reviewer/);

  result = reduceOpenTuiPreviewKey({ ...ui, mode: "task", taskInput: "/handoff-target Reviewer" }, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.selectedHandoffTargetAgentId, "agent-b");
  assert.match(result.state.feed.at(-1).text, /Press h from task detail/);

  result = reduceOpenTuiPreviewKey(ui, "h");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "task");
  assert.equal(result.state.taskInput, "/handoff current ");

  result = reduceOpenTuiPreviewKey({ ...ui, selectedHandoffTargetAgentId: "agent-b" }, "h");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "task");
  assert.equal(result.state.taskInput, "/handoff current agent-b ");
  assert.match(result.state.message, /Reviewer/);

  ui = completeOpenTuiRunStop(stoppingState, runDetail({
    run: {
      ...runDetail().run,
      status: "cancelled",
    },
    allRuns: [{
      ...runDetail().run,
      status: "cancelled",
    }],
  }), "run-a");
  assert.match(ui.message, /Stopped run: run-a/);
  assert.match(formatOpenTuiPreviewText(ui), /status\s+cancelled/);
});

test("OpenTUI preview slash run commands copy, export, and stop runs", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiRunDetail({ ...ui, mode: "run", selectedRunId: "run-a" }, runDetail());

  let result = reduceOpenTuiPreviewKey({ ...ui, mode: "task", taskInput: "/copy diff run-a" }, "\r");
  assert.deepEqual(result.intent, { type: "copy-run", kind: "diff" });
  assert.match(result.state.message, /Copying task diff: run-a/);

  result = reduceOpenTuiPreviewKey({ ...result.state, mode: "task", taskInput: "/export run-a" }, "\r");
  assert.deepEqual(result.intent, { type: "export-run" });
  assert.match(result.state.message, /Exporting task summary: run-a/);

  result = reduceOpenTuiPreviewKey({ ...result.state, mode: "task", taskInput: "/export run-a exports/run-a.md" }, "\r");
  assert.deepEqual(result.intent, { type: "export-run", outputPath: "exports/run-a.md" });
  assert.match(result.state.message, /Exporting task summary: run-a/);

  result = reduceOpenTuiPreviewKey({ ...result.state, mode: "task", taskInput: "/copy output run-child" }, "\r");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-child" });
  assert.equal(result.state.mode, "run");
  assert.equal(result.state.runDetailLoading, true);
  assert.deepEqual(result.state.pendingRunAction, { type: "copy", kind: "output" });
  assert.match(result.state.message, /Loading task run-child before copy/);

  ui = completeOpenTuiRunCopy(result.state, "output");
  assert.equal(ui.pendingRunAction, undefined);

  result = reduceOpenTuiPreviewKey({ ...ui, mode: "task", taskInput: "/export run-child exports/child.md" }, "\r");
  assert.deepEqual(result.intent, { type: "load-run", runId: "run-child" });
  assert.deepEqual(result.state.pendingRunAction, { type: "export", outputPath: "exports/child.md" });

  ui = createOpenTuiPreviewUiState(previewState());
  result = reduceOpenTuiPreviewKey({ ...ui, mode: "task", taskInput: "/stop 1" }, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.equal(result.state.mode, "confirm");
  assert.match(formatOpenTuiPreviewText(result.state), /Approval\nStop agent task\?/);

  result = reduceOpenTuiPreviewKey(result.state, "y");
  assert.deepEqual(result.intent, { type: "stop-run", runId: "run-a" });
  assert.match(result.state.message, /Stopping task run-a/);
});

test("OpenTUI preview reports unknown slash commands without preview fallback wording", () => {
  const ui = {
    ...createOpenTuiPreviewUiState(previewState()),
    mode: "task",
    taskInput: "/does-not-exist",
  };

  const result = reduceOpenTuiPreviewKey(ui, "\r");

  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /Unknown command: \/does-not-exist/);
  assert.match(result.state.feed.at(-1).text, /⌃P lists everything/);
  assert.doesNotMatch(result.state.message, /not implemented|preview/i);
});

test("OpenTUI preview task detail blocks retry and stop when task status is not eligible", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = completeOpenTuiRunDetail({ ...ui, mode: "run", selectedRunId: "run-a" }, runDetail({
    run: {
      ...runDetail().run,
      status: "succeeded",
    },
    allRuns: [{
      ...runDetail().run,
      status: "succeeded",
    }],
  }));

  let result = reduceOpenTuiPreviewKey(ui, "R");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /Only failed or cancelled runs can be retried/);

  result = reduceOpenTuiPreviewKey(ui, "s");
  assert.deepEqual(result.intent, { type: "none" });
  assert.match(result.state.message, /Only queued or running tasks can be stopped/);
});

test("OpenTUI preview palette can open shared terminal action", () => {
  let ui = createOpenTuiPreviewUiState(previewState());
  ui = reduceOpenTuiPreviewKey(ui, "\u0010").state;
  for (const key of ["t", "e", "r", "m"]) {
    ui = reduceOpenTuiPreviewKey(ui, key).state;
  }
  const result = reduceOpenTuiPreviewKey(ui, "\r");
  assert.equal(result.state.mode, "terminal");
  assert.deepEqual(result.intent, { type: "connect-terminal" });
  assert.match(result.state.message, /Connecting shared terminal/);
});

test("formatOpenTuiPreviewText keeps unconfigured states explicit", () => {
  const text = formatOpenTuiPreviewText({
    args: {
      dir: "/tmp/project",
      smokeTest: false,
      durationMs: 0,
    },
    safety,
    workspace: { ...workspace, isGitRepo: false },
    workspaceFiles: [],
    instructions: { files: [] },
    memory: { files: [] },
    dashboard: {
      config: null,
      session: null,
      bridge: "offline",
      providerAvailability: {},
      provider: "codex",
      rooms: [],
      message: "No .co-od.json here yet. Initialize a room first.",
      dashboard: {
        agents: [],
        runs: [],
        services: {},
      },
    },
  });

  assert.match(text, /start a room/);
  assert.match(text, /1\. co-od login/);
  assert.match(text, /2\. co-od init/);
  assert.match(text, /3\. add an agent: codex, claude, opencode/);
});

test("OpenTUI unconfigured state gives one clear setup path", () => {
  const text = stripAnsi(formatOpenTuiPreviewText({
    ...previewState(),
    dashboard: {
      ...previewState().dashboard,
      config: null,
      session: null,
      message: "No room here yet.",
      dashboard: {
        agents: [],
        runs: [],
        services: {},
      },
    },
  }, { width: 100, height: 30 }));

  assert.match(text, /start a room/);
  assert.match(text, /1\. co-od login/);
  assert.match(text, /2\. co-od init/);
  assert.match(text, /3\. add an agent: codex, claude, opencode/);
  assert.match(text, /> \/login to enter the room…/);
  assert.doesNotMatch(text, /ERROR|undefined|null/);
});

test("OpenTUI no-room setup steps stay visible at 80x24", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-opentui-empty-"));
  try {
    const ui = createOpenTuiPreviewUiState(loadOpenTuiPreviewStartupState(parseOpenTuiPreviewArgs(["--dir", dir])));
    const text = stripAnsi(formatOpenTuiPreviewText(ui, { width: 80, height: 24 }));

    assert.match(text, /start a room/);
    assert.match(text, /1\. co-od login/);
    assert.match(text, /2\. co-od init/);
    assert.match(text, /3\. add an agent: codex, claude, opencode/);
    assert.doesNotMatch(text, /No \.co-od\.json here yet|Initialize a room first|initialize this project|config not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenTuiPreviewUiState initializes an empty transcript", () => {
  const ui = createOpenTuiPreviewUiState(loadOpenTuiPreviewStartupState(parseOpenTuiPreviewArgs(["--dir", "/tmp"])));
  assert.deepEqual(ui.transcript, []);
});

test("applyTaskEventToState folds a submitted+output sequence into the transcript", () => {
  let ui = createOpenTuiPreviewUiState(loadOpenTuiPreviewStartupState(parseOpenTuiPreviewArgs(["--dir", "/tmp"])));
  ui = applyTaskEventToState(ui, { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  ui = applyTaskEventToState(ui, { type: "output", data: "hello" }, { messageId: "m1" });
  assert.equal(ui.transcript.length, 1);
  assert.equal(ui.transcript[0].blocks[0].text, "hello");
});

test("parseOpenTuiPreviewArgs skips --view and keeps the real roomId", () => {
  const parsed = parseOpenTuiPreviewArgs(["--view", "chat", "room-1"]);
  assert.equal(parsed.roomId, "room-1");
});
