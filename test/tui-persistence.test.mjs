import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTuiProjectState,
  normalizeDashboardCache,
  normalizeSafetyAudit,
  normalizeTaskHistory,
  saveTuiProjectState,
  tuiStateKey,
  tuiStatePath,
} from "../dist/tui-persistence.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "co-od-tui-state-"));

test("tuiStateKey is stable and path uses the configured base dir", () => {
  assert.equal(tuiStateKey("/tmp/project"), tuiStateKey("/tmp/project"));
  assert.notEqual(tuiStateKey("/tmp/project"), tuiStateKey("/tmp/other"));
  assert.equal(tuiStatePath("/tmp/base"), "/tmp/base/tui-state.json");
});

test("normalizeDashboardCache validates and bounds cached room metadata", () => {
  assert.equal(normalizeDashboardCache(), undefined);
  assert.equal(normalizeDashboardCache({
    roomId: "",
    agents: [],
    runs: [],
    cachedAt: "2026-05-31T00:00:00.000Z",
  }), undefined);
  assert.equal(normalizeDashboardCache({
    roomId: "room-a",
    agents: [],
    runs: [],
    cachedAt: "not-a-date",
  }), undefined);

  const cache = normalizeDashboardCache({
    roomId: "room-a",
    roomName: "Alpha",
    cachedAt: "2026-05-31T00:00:00.000Z",
    agents: Array.from({ length: 35 }, (_, index) => ({ _id: `agent-${index}` })),
    runs: Array.from({ length: 70 }, (_, index) => ({ _id: `run-${index}` })),
  });
  assert.equal(cache?.agents.length, 30);
  assert.equal(cache?.runs.length, 60);
  assert.equal(cache?.agents.at(-1)._id, "agent-29");
  assert.equal(cache?.runs.at(-1)._id, "run-59");
});

test("normalizeTaskHistory trims, dedupes, and keeps the latest entries", () => {
  assert.deepEqual(
    normalizeTaskHistory([" one ", "two", "one"], "three", 3),
    ["two", "one", "three"],
  );
  assert.deepEqual(
    normalizeTaskHistory(["a", "b", "c"], "b", 2),
    ["c", "b"],
  );
});

test("normalizeSafetyAudit validates and bounds persisted safety history", () => {
  const entries = [
    { action: "task", decision: "allowed", reason: "auto-run enabled", createdAt: 1 },
    { action: "bad", decision: "unknown", reason: "bad", createdAt: 2 },
    { action: "toggle", decision: "toggled", reason: "auto-run off", createdAt: 3 },
  ];

  assert.deepEqual(normalizeSafetyAudit(entries, 1), [
    { action: "toggle", decision: "toggled", reason: "auto-run off", createdAt: 3 },
  ]);
});

test("saveTuiProjectState persists and reloads project state", () => {
  const baseDir = tempDir();
  try {
    saveTuiProjectState({
      baseDir,
      projectDir: "/tmp/project-a",
      state: {
        taskHistory: ["Fix tests"],
        selectedRoomId: "room-a",
        selectedRoomName: "Alpha",
        provider: "opencode",
        model: "gpt-5",
        selectedAgentId: "agent-a",
        lastRunId: "run-a",
    dismissedRunIds: [],
        attachments: [{ path: "README.md" }],
        dashboardCache: {
          roomId: "room-a",
          roomName: "Alpha",
          agents: [{ _id: "agent-a" }],
          runs: [{ _id: "run-a" }],
          cachedAt: "2026-05-31T00:00:00.000Z",
        },
        pins: {
          rooms: [{ roomId: "room-a", roomName: "Alpha" }],
          providers: ["opencode"],
          agents: [{ agentId: "agent-a", name: "Builder", provider: "opencode" }],
        },
        safetyAudit: [
          { action: "task", decision: "allowed", reason: "auto-run enabled", createdAt: 100 },
        ],
      },
    });

    const loaded = loadTuiProjectState({ baseDir, projectDir: "/tmp/project-a" });
    assert.equal(typeof loaded?.updatedAt, "string");
    assert.deepEqual(loaded, {
      projectDir: "/tmp/project-a",
      taskHistory: ["Fix tests"],
      selectedRoomId: "room-a",
      selectedRoomName: "Alpha",
      provider: "opencode",
      model: "gpt-5",
      selectedAgentId: "agent-a",
      lastRunId: "run-a",
      dismissedRunIds: [],
      attachments: [{ path: "README.md" }],
      dashboardCache: {
        roomId: "room-a",
        roomName: "Alpha",
        agents: [{ _id: "agent-a" }],
        runs: [{ _id: "run-a" }],
        cachedAt: "2026-05-31T00:00:00.000Z",
      },
      pins: {
        rooms: [{ roomId: "room-a", roomName: "Alpha" }],
        providers: ["opencode"],
        agents: [{ agentId: "agent-a", name: "Builder", provider: "opencode" }],
      },
      safetyAudit: [
        { action: "task", decision: "allowed", reason: "auto-run enabled", createdAt: 100 },
      ],
      updatedAt: loaded?.updatedAt,
    });
    assert.equal(loadTuiProjectState({ baseDir, projectDir: "/tmp/project-b" }), null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("saveTuiProjectState can clear a stale dashboard cache explicitly", () => {
  const baseDir = tempDir();
  try {
    saveTuiProjectState({
      baseDir,
      projectDir: "/tmp/project-a",
      state: {
        dashboardCache: {
          roomId: "room-a",
          agents: [{ _id: "agent-old" }],
          runs: [{ _id: "run-old" }],
          cachedAt: "2026-05-31T00:00:00.000Z",
        },
      },
    });
    assert.equal(loadTuiProjectState({ baseDir, projectDir: "/tmp/project-a" })?.dashboardCache?.roomId, "room-a");

    saveTuiProjectState({
      baseDir,
      projectDir: "/tmp/project-a",
      state: {
        dashboardCache: null,
      },
    });

    assert.equal(loadTuiProjectState({ baseDir, projectDir: "/tmp/project-a" })?.dashboardCache, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
