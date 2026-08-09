import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildTuiLiveQaReport,
  buildTuiQaReport,
  formatTuiLiveQaReport,
  formatTuiQaReport,
  resolveTuiQaSlashCommand,
} from "../dist/tui-qa.js";

function healthyServices() {
  return {
    web: { ok: true, latencyMs: 8 },
    convex: { ok: true, latencyMs: 9 },
    runtimeGateway: { ok: true, latencyMs: 10 },
    collab: { ok: true, latencyMs: 11 },
    terminal: { ok: true, latencyMs: 12 },
    orchestrator: { ok: true, latencyMs: 13 },
  };
}

test("buildTuiQaReport verifies deterministic room flow coverage", () => {
  const report = buildTuiQaReport(new Date("2026-05-31T00:00:00.000Z"));
  assert.equal(report.ok, true);
  assert.equal(report.checkedAt, "2026-05-31T00:00:00.000Z");
  assert.deepEqual(report.checks.map((check) => check.id), [
    "resume-provider-session",
    "completion-provider-session",
    "session-listing",
    "continue-resume-fork",
    "retry-stop",
    "agent-pause-resume",
    "patch-review",
    "fanout-handoff",
    "file-mentions-undo",
    "attachment-transport",
    "scrollback-search",
    "file-preview",
    "server-undo",
    "file-operation-undo",
    "confirmation",
    "approval-metadata",
    "runtime-commands",
    "terminal-pane",
  ]);
  assert.equal(report.checks.every((check) => check.ok), true);
});

test("formatTuiQaReport renders pass/fail check lines", () => {
  const report = buildTuiQaReport(new Date("2026-05-31T00:00:00.000Z"));
  const text = formatTuiQaReport(report);
  assert.match(text, /co-od TUI QA passed/);
  assert.match(text, /OK  resume-provider-session/);
  assert.match(text, /OK  session-listing/);
  assert.match(text, /OK  agent-pause-resume/);
  assert.match(text, /OK  file-mentions-undo/);
  assert.match(text, /OK  attachment-transport/);
  assert.match(text, /OK  scrollback-search/);
  assert.match(text, /OK  file-preview/);
  assert.match(text, /OK  server-undo/);
  assert.match(text, /OK  file-operation-undo/);
  assert.match(text, /OK  approval-metadata/);
  assert.match(text, /OK  runtime-commands/);
  assert.match(text, /OK  terminal-pane/);
});

test("tui-qa command emits JSON report", () => {
  const output = execFileSync(process.execPath, ["dist/index.js", "tui-qa", "--json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 18);
});

test("resolveTuiQaSlashCommand parses deterministic and live TUI QA aliases", () => {
  assert.deepEqual(resolveTuiQaSlashCommand("qa", []), {
    live: false,
    includeTerminal: false,
    roomId: undefined,
    bridgeUrl: undefined,
  });
  assert.deepEqual(resolveTuiQaSlashCommand("qa", ["live", "--room", "room-a", "--terminal", "--bridge-url", "http://bridge.test"]), {
    live: true,
    includeTerminal: true,
    roomId: "room-a",
    bridgeUrl: "http://bridge.test",
  });
  assert.deepEqual(resolveTuiQaSlashCommand("live-qa", ["room-b"]), {
    live: true,
    includeTerminal: false,
    roomId: "room-b",
    bridgeUrl: undefined,
  });
  assert.deepEqual(resolveTuiQaSlashCommand("qa", ["live", "--bridge", "http://bridge.test", "room-c"]).roomId, "room-c");
  assert.match(resolveTuiQaSlashCommand("qa", ["live", "--mutate"]).error || "", /mutations/);
});

test("buildTuiLiveQaReport verifies live room API contracts through injected clients", async () => {
  const expiresAt = Date.now() + 60_000;
  const apiGet = async (path) => {
    switch (path) {
      case "/api/rooms":
        return { rooms: [{ _id: "room-a", name: "Alpha" }] };
      case "/api/rooms/room-a/agents":
        return {
          agents: [
            { _id: "agent-open", name: "OpenCode", execution_mode: "local_opencode" },
          ],
        };
      case "/api/rooms/room-a/agent-runs":
        return {
          runs: [
            {
              _id: "run-active",
              agent_id: "agent-open",
              execution_mode: "local_opencode",
              status: "running",
              goal: "Live task",
              created_at: 1_700_000_000_000,
            },
          ],
        };
      case "/api/rooms/room-a/agent-runs/run-active":
        return {
          run: {
            _id: "run-active",
            agent_id: "agent-open",
            execution_mode: "local_opencode",
            status: "running",
            goal: "Live task",
            created_at: 1_700_000_000_000,
          },
        };
      case "/api/rooms/room-a/patches":
        return {
          patches: [
            { _id: "patch-a", run_id: "run-active", title: "Patch", status: "proposed", diff_text: "+x" },
          ],
        };
      case "/api/rooms/room-a/env/status":
        return {
          ok: true,
          runtimeAvailable: true,
          convex: { status: "running" },
          orchestrator: {
            ok: true,
            env: {
              status: "running",
              provider: "docker",
              publicUrl: "https://runtime.test/room-a",
            },
          },
        };
      default:
        throw new Error(`unexpected path ${path}`);
    }
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith("/api/health/deep")) {
      return new Response(JSON.stringify({ services: healthyServices() }), { status: 200 });
    }
    if (text.endsWith("/api/rooms/room-a/realtime/session")) {
      return new Response(JSON.stringify({ token: "rt-token", terminalWsUrl: "wss://terminal.test/room-a" }), { status: 200 });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };

  const report = await buildTuiLiveQaReport({
    dir: process.cwd(),
    roomId: "room-a",
    serverUrl: "https://co-od.test",
    date: new Date("2026-05-31T00:00:00.000Z"),
    getSession: () => ({ sessionToken: "session-token", expiresAt }),
    projectState: null,
    apiGet,
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [
    ["session-auth", "pass"],
    ["room-config", "pass"],
    ["service-health", "pass"],
    ["rooms-list", "pass"],
    ["room-dashboard", "pass"],
    ["run-detail", "pass"],
    ["lifecycle-candidates", "pass"],
    ["approval-broker", "skip"],
    ["runtime-status", "pass"],
    ["mutation-runtime-lifecycle", "skip"],
    ["mutation-disposable-run", "skip"],
    ["mutation-patch-review", "skip"],
    ["mutation-retry", "skip"],
    ["mutation-fanout", "skip"],
    ["terminal-session", "pass"],
  ]);

  const text = formatTuiLiveQaReport(report);
  assert.match(text, /co-od live TUI QA passed/);
  assert.match(text, /OK  terminal-session/);
});

test("buildTuiLiveQaReport fails closed without live auth or room context", async () => {
  const report = await buildTuiLiveQaReport({
    dir: process.cwd(),
    serverUrl: "https://co-od.test",
    date: new Date("2026-05-31T00:00:00.000Z"),
    getSession: () => null,
    projectState: null,
    fetchImpl: async () => new Response(JSON.stringify({ services: { web: { ok: true } } }), { status: 200 }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "session-auth")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "room-config")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "mutation-disposable-run")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "mutation-runtime-lifecycle")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "mutation-patch-review")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "mutation-retry")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "mutation-fanout")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "approval-broker")?.status, "skip");
  assert.equal(report.checks.find((check) => check.id === "terminal-session")?.status, "skip");

  const text = formatTuiLiveQaReport(report);
  assert.match(text, /Next steps:/);
  assert.match(text, /Run `co-od login`/);
  assert.match(text, /pass `--room <room-id>`/);
});

test("buildTuiLiveQaReport fails service health when required room services are missing", async () => {
  const report = await buildTuiLiveQaReport({
    dir: process.cwd(),
    roomId: "room-a",
    serverUrl: "https://co-od.test",
    date: new Date("2026-05-31T00:00:00.000Z"),
    getSession: () => null,
    projectState: null,
    fetchImpl: async () => new Response(JSON.stringify({ services: { web: { ok: true } } }), { status: 200 }),
  });

  const serviceHealth = report.checks.find((check) => check.id === "service-health");
  assert.equal(serviceHealth?.status, "fail");
  assert.match(serviceHealth?.detail || "", /runtimeGateway:missing/);
  assert.match(serviceHealth?.detail || "", /terminal:missing/);
});

test("buildTuiLiveQaReport resolves room context from persisted TUI state", async () => {
  const expiresAt = Date.now() + 60_000;
  const report = await buildTuiLiveQaReport({
    dir: process.cwd(),
    serverUrl: "https://co-od.test",
    date: new Date("2026-05-31T00:00:00.000Z"),
    getSession: () => ({ sessionToken: "session-token", expiresAt }),
    projectState: { selectedRoomId: "room-persisted", selectedRoomName: "Persisted" },
    apiGet: async (path) => {
      if (path === "/api/rooms") return { rooms: [{ _id: "room-persisted", name: "Persisted" }] };
      if (path === "/api/rooms/room-persisted/agents") return { agents: [] };
      if (path === "/api/rooms/room-persisted/agent-runs") return { runs: [] };
      if (path === "/api/rooms/room-persisted/env/status") return { ok: false };
      throw new Error(`unexpected path ${path}`);
    },
    fetchImpl: async () => new Response(JSON.stringify({ services: healthyServices() }), { status: 200 }),
    includeTerminal: false,
  });

  assert.equal(report.roomId, "room-persisted");
  assert.equal(report.checks.find((check) => check.id === "room-config")?.status, "pass");
  assert.match(report.checks.find((check) => check.id === "room-config")?.detail || "", /persisted TUI state/);
});

test("buildTuiLiveQaReport can run a guarded disposable mutation scenario", async () => {
  const expiresAt = Date.now() + 60_000;
  const calls = [];
  const apiGet = async (path) => {
    switch (path) {
      case "/api/rooms":
        return { rooms: [{ _id: "room-a", name: "Alpha" }] };
      case "/api/rooms/room-a/agents":
        return {
          agents: [
            { _id: "agent-open", name: "OpenCode", execution_mode: "local_opencode" },
            { _id: "agent-codex", name: "Codex", execution_mode: "local_codex" },
          ],
        };
      case "/api/rooms/room-a/agent-runs":
        return { runs: [] };
      case "/api/rooms/room-a/env/status":
        return {
          ok: true,
          runtimeAvailable: true,
          convex: { status: "stopped" },
          orchestrator: {
            ok: true,
            env: {
              status: "stopped",
              provider: "memory",
            },
          },
        };
      default:
        throw new Error(`unexpected get ${path}`);
    }
  };
  const apiPost = async (path, body) => {
    calls.push(["post", path, body]);
    if (path === "/api/rooms/room-a/env/start") {
      assert.equal(body.ttlSeconds, 900);
      return { ok: true, env: { status: "running", provider: "memory", ttlSeconds: 900 } };
    }
    if (path === "/api/rooms/room-a/env/touch") {
      return { ok: true, orchestrator: { ok: true, env: { status: "running", provider: "memory", lastTouchedAt: 1_800_000_000_000 } } };
    }
    if (path === "/api/rooms/room-a/env/stop") {
      return { ok: true, env: { status: "stopped", provider: "memory" } };
    }
    if (path === "/api/rooms/room-a/agent-runs" && !body.continueRunId) {
      if (body.goal.includes("retry source")) {
        const previousRetries = calls.filter((call) => call[0] === "post" && call[1] === path && call[2]?.goal?.includes("retry source")).length;
        return { ok: true, runId: previousRetries === 1 ? "run-retry-source" : "run-retry-next", dispatch: { mode: "local_bridge" } };
      }
      if (body.goal.includes("fanout")) {
        return { ok: true, runId: body.agentId === "agent-open" ? "run-fanout-open" : "run-fanout-codex", dispatch: { mode: "local_bridge" } };
      }
      return { ok: true, runId: "run-qa", dispatch: { mode: "local_bridge" } };
    }
    if (path === "/api/rooms/room-a/agent-runs/run-qa/pause") {
      return { ok: true, runId: "run-qa", status: "paused" };
    }
    if (path === "/api/rooms/room-a/agent-runs" && body.continueRunId === "run-qa") {
      return { ok: true, runId: "run-qa", continued: true, dispatch: { mode: "local_bridge" } };
    }
    if (path === "/api/rooms/room-a/agent-runs/run-qa/handoff") {
      assert.equal(body.targetAgentId, "agent-open");
      return { ok: true, newRunId: "run-handoff", dispatch: { mode: "local_bridge" } };
    }
    if (path === "/api/rooms/room-a/patches") {
      return { ok: true, patchId: body.title.includes("accept") ? "patch-accept" : "patch-reject" };
    }
    if (path === "/api/rooms/room-a/patches/patch-accept/accept") {
      return { ok: true, patchId: "patch-accept" };
    }
    if (path === "/api/rooms/room-a/patches/patch-reject/reject") {
      return { ok: true, patchId: "patch-reject" };
    }
    throw new Error(`unexpected post ${path}`);
  };
  const apiDelete = async (path) => {
    calls.push(["delete", path]);
    assert.match(path, /^\/api\/rooms\/room-a\/agent-runs\/run-(qa|handoff|retry-source|retry-next|fanout-open|fanout-codex)$/);
    return { ok: true };
  };
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith("/api/health/deep")) {
      return new Response(JSON.stringify({ services: healthyServices() }), { status: 200 });
    }
    if (text === "http://bridge.test/health") {
      return new Response(JSON.stringify({
        ok: true,
        codexAvailable: true,
        codexApprovalMode: "prompt",
        codexApprovalPolicy: "on-request",
        pendingCodexApprovals: 0,
      }), { status: 200 });
    }
    if (text === "http://bridge.test/v1/approvals") {
      return new Response(JSON.stringify({ ok: true, approvals: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };

  const report = await buildTuiLiveQaReport({
    dir: process.cwd(),
    roomId: "room-a",
    serverUrl: "https://co-od.test",
    date: new Date("2026-05-31T00:00:00.000Z"),
    includeTerminal: false,
    allowMutations: true,
    bridgeUrl: "http://bridge.test",
    getSession: () => ({ sessionToken: "session-token", expiresAt }),
    apiGet,
    apiPost,
    apiDelete,
    fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "runtime-status")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "approval-broker")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "mutation-runtime-lifecycle")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "mutation-disposable-run")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "mutation-patch-review")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "mutation-retry")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "mutation-fanout")?.status, "pass");
  assert.deepEqual(calls.map((call) => [call[0], call[1]]), [
    ["post", "/api/rooms/room-a/env/start"],
    ["post", "/api/rooms/room-a/env/touch"],
    ["post", "/api/rooms/room-a/env/stop"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["post", "/api/rooms/room-a/agent-runs/run-qa/pause"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["post", "/api/rooms/room-a/agent-runs/run-qa/handoff"],
    ["delete", "/api/rooms/room-a/agent-runs/run-handoff"],
    ["delete", "/api/rooms/room-a/agent-runs/run-qa"],
    ["post", "/api/rooms/room-a/patches"],
    ["post", "/api/rooms/room-a/patches/patch-accept/accept"],
    ["post", "/api/rooms/room-a/patches"],
    ["post", "/api/rooms/room-a/patches/patch-reject/reject"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["delete", "/api/rooms/room-a/agent-runs/run-retry-source"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["delete", "/api/rooms/room-a/agent-runs/run-retry-next"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["post", "/api/rooms/room-a/agent-runs"],
    ["delete", "/api/rooms/room-a/agent-runs/run-fanout-codex"],
    ["delete", "/api/rooms/room-a/agent-runs/run-fanout-open"],
  ]);
});
