import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRoomDashboardCache,
  createRoomDashboardCache,
  dashboardCachePolicyFromEnv,
  DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS,
  formatDashboardCacheMaxAge,
  formatDashboardCachePolicy,
  formatServiceHealth,
  isRoomDashboardCacheFresh,
  loadRunDetailData,
  loadRoomDashboardData,
  loadRoomsData,
  loadTuiDashboardState,
  parseDashboardCacheMaxAgeMs,
  readProjectConfig,
  resolveDashboardProvider,
  resolveRunPatch,
  restoreServerUndoChanges,
  roomDashboardCacheAgeMs,
  serviceFailureReason,
} from "../dist/tui-dashboard.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "co-od-dashboard-"));

test("readProjectConfig reads .co-od.json and room override", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".co-od.json"), JSON.stringify({
      roomId: "room-a",
      roomName: "Alpha",
      provider: "opencode",
      projectDir: dir,
    }));

    assert.deepEqual(readProjectConfig(dir), {
      roomId: "room-a",
      roomName: "Alpha",
      provider: "opencode",
      projectDir: dir,
    });
    assert.deepEqual(readProjectConfig(dir, "room-b"), {
      roomId: "room-b",
      roomName: "room-b",
      provider: "opencode",
      projectDir: dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDashboardProvider honors arg, config, availability, and fallback order", () => {
  assert.equal(resolveDashboardProvider({
    argProvider: "codex",
    configProvider: "claude",
    providerAvailability: { opencode: true },
    previousProvider: "opencode",
  }), "codex");

  assert.equal(resolveDashboardProvider({
    configProvider: "claude",
    providerAvailability: { opencode: true },
    previousProvider: "opencode",
  }), "claude");

  assert.equal(resolveDashboardProvider({
    providerAvailability: { opencode: false, codex: true },
    previousProvider: "claude",
    providers: ["opencode", "codex"],
  }), "codex");

  assert.equal(resolveDashboardProvider({
    providerAvailability: {},
    previousProvider: "claude",
    providers: ["opencode", "codex"],
  }), "claude");
});

test("loadRoomsData returns server rooms and captures API errors", async () => {
  const ok = await loadRoomsData({
    apiGet: async (path) => {
      assert.equal(path, "/api/rooms");
      return { rooms: [{ _id: "room-a", name: "Alpha", status: "active" }] };
    },
  });

  assert.deepEqual(ok, {
    rooms: [{ _id: "room-a", name: "Alpha", status: "active" }],
    error: undefined,
  });

  const failed = await loadRoomsData({
    apiGet: async () => {
      throw new Error("rooms offline");
    },
  });

  assert.deepEqual(failed, { rooms: [], error: "rooms offline" });
});

test("loadRoomDashboardData returns agents/runs and captures API errors", async () => {
  const ok = await loadRoomDashboardData({
    roomId: "room-a",
    apiGet: async (path) => {
      if (path.endsWith("/agents")) return { agents: [{ _id: "agent-a", name: "Builder" }] };
      if (path.endsWith("/messages")) return { messages: [{ _id: "m1", author_type: "user", body_md: "hi" }] };
      if (path.endsWith("/patches")) return { patches: [{ _id: "p1", run_id: "run-a", status: "proposed" }] };
      if (path.endsWith("/presence")) return { presence: [{ name: "Sergey", workos_user_id: "user_1" }] };
      return { runs: [{ _id: "run-a", status: "succeeded" }] };
    },
  });

  assert.deepEqual(ok, {
    agents: [{ _id: "agent-a", name: "Builder" }],
    runs: [{ _id: "run-a", status: "succeeded" }],
    messages: [{ _id: "m1", author_type: "user", body_md: "hi" }],
    patches: [{ _id: "p1", run_id: "run-a", status: "proposed" }],
    presence: [{ name: "Sergey", workos_user_id: "user_1" }],
    error: undefined,
  });

  const failed = await loadRoomDashboardData({
    roomId: "room-a",
    apiGet: async () => {
      throw new Error("api unavailable");
    },
  });

  assert.equal(failed.error, "agents: api unavailable; runs: api unavailable");
  assert.deepEqual(failed.agents, []);
  assert.deepEqual(failed.runs, []);

  const partial = await loadRoomDashboardData({
    roomId: "room-a",
    apiGet: async (path) => {
      if (path.endsWith("/agents")) return { agents: [{ _id: "agent-live" }] };
      throw new Error("runs offline");
    },
  });

  assert.equal(partial.error, "runs: runs offline");
  assert.deepEqual(partial.agents, [{ _id: "agent-live" }]);
  assert.deepEqual(partial.runs, []);
});

test("loadTuiDashboardState merges detected Herdr panes as external agents", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".co-od.json"), JSON.stringify({ roomId: "room-a" }));
    const state = await loadTuiDashboardState({
      dir,
      getSession: () => ({ token: "token", user: { email: "dev@example.com" } }),
      getBaseUrl: () => "http://127.0.0.1:3000",
      adapterAvailable: async () => false,
      fetchImpl: async () => ({ ok: true, json: async () => ({ services: {} }) }),
      loadHerdrAgents: async () => ({
        available: true,
        agents: [{
          _id: "herdr:term-1",
          name: "codex reviewer",
          provider: "herdr",
          execution_mode: "external_herdr",
          external_source: "herdr",
          external_status: "blocked",
        }],
      }),
      apiGet: async (path) => {
        if (path.endsWith("/agents")) return { agents: [{ _id: "agent-a", name: "Builder" }] };
        if (path.endsWith("/agent-runs")) return { runs: [] };
        if (path.endsWith("/auth/session")) return { user: { workosUserId: "user-1", name: "Dev" } };
        return {};
      },
    });

    assert.deepEqual(state.dashboard.agents.map((agent) => agent._id), ["agent-a", "herdr:term-1"]);
    assert.match(state.message, /1 Herdr pane detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service health formatting preserves compact failure reasons", () => {
  assert.equal(formatServiceHealth(), "unknown");
  assert.equal(formatServiceHealth({ ok: true, latencyMs: 12 }), "ok 12ms");
  assert.equal(
    formatServiceHealth({ ok: false, status: 503, message: "runtime gateway timeout", latencyMs: 2500 }),
    "down HTTP 503: runtime gateway timeout 2500ms",
  );
  assert.equal(serviceFailureReason({ ok: false, status: 500, message: "x".repeat(100) }, 20), "HTTP 500: xxxxxxx...");
});

test("room dashboard cache is bounded and applied only to missing errored segments", () => {
  const now = Date.parse("2026-05-31T00:00:00.000Z");
  const cache = createRoomDashboardCache({
    roomId: "room-a",
    roomName: "Alpha",
    now: "2026-05-31T00:00:00.000Z",
    agentLimit: 1,
    runLimit: 1,
    dashboard: {
      agents: [{ _id: "agent-a" }, { _id: "agent-b" }],
      runs: [{ _id: "run-a" }, { _id: "run-b" }],
    },
  });

  assert.deepEqual(cache, {
    roomId: "room-a",
    roomName: "Alpha",
    agents: [{ _id: "agent-a" }],
    runs: [{ _id: "run-a" }],
    cachedAt: "2026-05-31T00:00:00.000Z",
  });

  const applied = applyRoomDashboardCache({
    roomId: "room-a",
    cache,
    dashboard: {
      agents: [],
      runs: [],
      services: {},
      error: "api unavailable",
    },
    now,
  });
  assert.equal(applied.cached, true);
  assert.equal(applied.cachedAt, "2026-05-31T00:00:00.000Z");
  assert.deepEqual(applied.agents, [{ _id: "agent-a" }]);
  assert.deepEqual(applied.runs, [{ _id: "run-a" }]);
  assert.match(applied.error, /showing cached room data/);

  const partial = applyRoomDashboardCache({
    roomId: "room-a",
    cache,
    dashboard: {
      agents: [{ _id: "agent-live" }],
      runs: [],
      services: {},
      error: "partial issue",
    },
    now,
  });
  assert.equal(partial.cached, true);
  assert.deepEqual(partial.agents, [{ _id: "agent-live" }]);
  assert.deepEqual(partial.runs, [{ _id: "run-a" }]);

  const cleanEmpty = applyRoomDashboardCache({
    roomId: "room-a",
    cache,
    dashboard: {
      agents: [],
      runs: [],
      services: {},
      error: undefined,
    },
  });
  assert.equal(cleanEmpty.cached, undefined);
  assert.deepEqual(cleanEmpty.agents, []);
  assert.deepEqual(cleanEmpty.runs, []);

  assert.equal(createRoomDashboardCache({
    roomId: "room-a",
    dashboard: { agents: [], runs: [], error: "nope" },
  }), null);
});

test("room dashboard cache rejects malformed or stale cache entries", () => {
  const now = Date.parse("2026-05-31T00:00:00.000Z");
  const fresh = { cachedAt: "2026-05-30T23:59:00.000Z" };
  const stale = { cachedAt: "2026-05-20T00:00:00.000Z" };

  assert.equal(roomDashboardCacheAgeMs(fresh, now), 60_000);
  assert.equal(roomDashboardCacheAgeMs({ cachedAt: "not-a-date" }, now), null);
  assert.equal(isRoomDashboardCacheFresh({ cache: fresh, now }), true);
  assert.equal(isRoomDashboardCacheFresh({ cache: stale, now }), false);
  assert.equal(isRoomDashboardCacheFresh({
    cache: stale,
    now,
    maxAgeMs: DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS * 2,
  }), true);

  const applied = applyRoomDashboardCache({
    roomId: "room-a",
    now,
    cache: {
      roomId: "room-a",
      cachedAt: "2026-05-20T00:00:00.000Z",
      agents: [{ _id: "agent-stale" }],
      runs: [{ _id: "run-stale" }],
    },
    dashboard: {
      agents: [],
      runs: [],
      services: {},
      error: "api unavailable",
    },
  });

  assert.equal(applied.cached, undefined);
  assert.deepEqual(applied.agents, []);
  assert.deepEqual(applied.runs, []);
});

test("dashboard cache policy is configurable from environment", () => {
  assert.equal(parseDashboardCacheMaxAgeMs("1500"), 1500);
  assert.equal(parseDashboardCacheMaxAgeMs("2s"), 2000);
  assert.equal(parseDashboardCacheMaxAgeMs("1.5h"), 5_400_000);
  assert.equal(parseDashboardCacheMaxAgeMs("2d"), 172_800_000);
  assert.equal(parseDashboardCacheMaxAgeMs("bad"), undefined);
  assert.equal(formatDashboardCacheMaxAge(604_800_000), "7d");
  assert.equal(formatDashboardCacheMaxAge(90_000), "90s");
  assert.equal(formatDashboardCachePolicy({ enabled: true, maxAgeMs: 10_800_000 }), "enabled max-age 3h");
  assert.equal(formatDashboardCachePolicy({ enabled: false, maxAgeMs: 10_800_000 }), "disabled");

  assert.deepEqual(dashboardCachePolicyFromEnv({}), {
    enabled: true,
    maxAgeMs: DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS,
  });
  assert.deepEqual(dashboardCachePolicyFromEnv({
    CO_OD_TUI_DISABLE_DASHBOARD_CACHE: "true",
    CO_OD_TUI_DASHBOARD_CACHE_MAX_AGE: "3h",
  }), {
    enabled: false,
    maxAgeMs: 10_800_000,
  });

  const dashboard = {
    agents: [],
    runs: [],
    services: {},
    error: "api unavailable",
  };
  const cache = {
    roomId: "room-a",
    cachedAt: "2026-05-31T00:00:00.000Z",
    agents: [{ _id: "agent-a" }],
    runs: [{ _id: "run-a" }],
  };

  const disabled = applyRoomDashboardCache({
    roomId: "room-a",
    cache,
    dashboard,
    now: Date.parse("2026-05-31T00:01:00.000Z"),
    policy: { enabled: false, maxAgeMs: DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS },
  });
  assert.equal(disabled.cached, undefined);

  const expired = applyRoomDashboardCache({
    roomId: "room-a",
    cache,
    dashboard,
    now: Date.parse("2026-05-31T00:01:00.000Z"),
    policy: { enabled: true, maxAgeMs: 30_000 },
  });
  assert.equal(expired.cached, undefined);
});

test("loadRunDetailData loads run, filters patches, and dedupes room runs", async () => {
  const detail = await loadRunDetailData({
    roomId: "room-a",
    runId: "run-a",
    apiGet: async (path) => {
      if (path.endsWith("/agent-runs/run-a")) {
        return { run: { _id: "run-a", status: "succeeded", created_at: 200 } };
      }
      if (path.endsWith("/patches")) {
        return {
          patches: [
            { _id: "patch-a", run_id: "run-a", status: "proposed", diff_text: "+a" },
            { _id: "patch-b", run_id: "run-b", status: "proposed", diff_text: "+b" },
          ],
        };
      }
      return { runs: [{ _id: "run-a", status: "running", created_at: 100 }, { _id: "run-b", created_at: 50 }] };
    },
  });

  assert.equal(detail.run._id, "run-a");
  assert.deepEqual(detail.patches.map((patch) => patch._id), ["patch-a"]);
  assert.deepEqual(detail.allRuns.map((run) => [run._id, run.status]), [
    ["run-a", "running"],
    ["run-b", undefined],
  ]);
});

test("loadRunDetailData rejects missing run payload", async () => {
  await assert.rejects(
    () => loadRunDetailData({
      roomId: "room-a",
      runId: "run-missing",
      apiGet: async () => ({}),
    }),
    /did not include a run/,
  );
});

test("resolveRunPatch posts accept and reject payloads", async () => {
  const calls = [];
  const apiPost = async (path, body) => {
    calls.push([path, body]);
    return { ok: true };
  };

  await resolveRunPatch({
    roomId: "room-a",
    patchId: "patch-a",
    action: "accept",
    apiPost,
  });
  await resolveRunPatch({
    roomId: "room-a",
    patchId: "patch-b",
    action: "reject",
    rejectReason: "No thanks",
    apiPost,
  });

  assert.deepEqual(calls, [
    ["/api/rooms/room-a/patches/patch-a/accept", undefined],
    ["/api/rooms/room-a/patches/patch-b/reject", { reason: "No thanks" }],
  ]);
});

test("restoreServerUndoChanges reopens rejected patches through room API", async () => {
  const calls = [];
  const apiPost = async (path, body) => {
    calls.push([path, body]);
    return { ok: true };
  };

  const result = await restoreServerUndoChanges({
    changes: [{
      kind: "patch-reopen",
      roomId: "room-a",
      runId: "run-a",
      patchId: "patch-b",
      fromStatus: "rejected",
      toStatus: "proposed",
    }],
    apiPost,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed.map((change) => change.patchId), ["patch-b"]);
  assert.deepEqual(calls, [
    ["/api/rooms/room-a/patches/patch-b/reopen", { reason: "Reopened by co-od TUI undo" }],
  ]);
});

test("loadTuiDashboardState builds unconfigured and configured dashboard states", async () => {
  const unconfigured = tempDir();
  const configured = tempDir();
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/health/deep")) {
      return {
        ok: true,
        json: async () => ({
          checkedAt: "now",
          services: { runtimeGateway: { ok: true, latencyMs: 12 } },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const empty = await loadTuiDashboardState({
      dir: unconfigured,
      previousProvider: "claude",
      getSession: () => null,
      getBaseUrl: () => "http://example.test",
      fetchImpl,
      adapterAvailable: async (provider) => provider === "opencode",
    });

    assert.equal(empty.config, null);
    assert.equal(empty.bridge, "running");
    assert.equal(empty.provider, "opencode");
    assert.match(empty.message, /No \.co-od\.json/);

    writeFileSync(join(configured, ".co-od.json"), JSON.stringify({
      roomId: "room-a",
      roomName: "Alpha",
      provider: "codex",
    }));

    const full = await loadTuiDashboardState({
      dir: configured,
      previousProvider: "opencode",
      getSession: () => ({ sessionToken: "token", expiresAt: Date.now() + 1000 }),
      getBaseUrl: () => "http://example.test",
      fetchImpl,
      adapterAvailable: async (provider) => provider === "opencode",
      apiGet: async (path) => {
        if (path === "/api/rooms") return { rooms: [{ _id: "room-a", name: "Alpha" }] };
        if (path.endsWith("/agents")) return { agents: [{ _id: "agent-a" }] };
        return { runs: [{ _id: "run-a" }] };
      },
    });

    assert.equal(full.config?.roomId, "room-a");
    assert.equal(full.provider, "codex");
    assert.deepEqual(full.rooms, [{ _id: "room-a", name: "Alpha" }]);
    assert.equal(full.dashboard.agents.length, 1);
    assert.equal(full.dashboard.runs.length, 1);
    assert.equal(full.message, "Room refreshed: 1 agents, 1 recent tasks.");
  } finally {
    rmSync(unconfigured, { recursive: true, force: true });
    rmSync(configured, { recursive: true, force: true });
  }
});
