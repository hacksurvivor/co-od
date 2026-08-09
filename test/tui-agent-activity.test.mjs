import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentActivityRows,
  normalizeAgentState,
  resolveAgentAvailability,
  resolveAgentAvailabilityDetail,
} from "../dist/tui-agent-activity.js";

const now = 1_000_000;
const agents = [
  { _id: "agent-open", name: "Open", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-codex", name: "Codex", provider: "openai", execution_mode: "local_codex" },
  { _id: "agent-idle", name: "Idle", provider: "openai", execution_mode: "hosted_api", has_api_key: false },
];

test("buildAgentActivityRows prefers active runs and exposes heartbeat, elapsed, and tokens", () => {
  const rows = buildAgentActivityRows({
    agents,
    now,
    providerAvailability: { opencode: true, codex: false },
    runs: [
      {
        _id: "old-run",
        agent_id: "agent-open",
        goal: "Finished task",
        status: "succeeded",
        created_at: now - 100_000,
        finished_at: now - 80_000,
      },
      {
        _id: "current-run",
        agent_id: "agent-open",
        goal: "Current task",
        status: "running",
        created_at: now - 30_000,
        started_at: now - 20_000,
        heartbeat_at: now - 5_000,
        token_estimate: 1234,
      },
      {
        _id: "failed-run",
        agent_id: "agent-codex",
        goal: "Failed task",
        status: "failed",
        created_at: now - 60_000,
        started_at: now - 50_000,
        finished_at: now - 40_000,
      },
    ],
  });

  assert.deepEqual(rows.map((row) => row.state), ["running", "failed", "idle"]);
  assert.deepEqual(rows.map((row) => row.semanticState), ["working", "failed", "idle"]);
  assert.equal(rows[0].runId, "current-run");
  assert.equal(rows[0].localProvider, "opencode");
  assert.equal(rows[0].availability, "available");
  assert.equal(rows[0].heartbeatAgeMs, 5_000);
  assert.equal(rows[0].elapsedMs, 20_000);
  assert.equal(rows[0].tokenEstimate, 1234);
  assert.equal(rows[1].elapsedMs, 10_000);
  assert.equal(rows[1].localProvider, "codex");
  assert.equal(rows[1].availability, "missing");
  assert.equal(rows[1].availabilityReason, "codex not found on PATH");
  assert.equal(rows[2].runId, undefined);
  assert.equal(rows[2].availability, "hosted");
  assert.equal(rows[2].availabilityReason, "no stored agent key; server env may be required");
});

test("buildAgentActivityRows treats in_progress as active over newer completed work", () => {
  const rows = buildAgentActivityRows({
    agents: [agents[0]],
    now,
    providerAvailability: { opencode: true },
    runs: [
      {
        _id: "active-run",
        agent_id: "agent-open",
        goal: "Still implementing",
        status: "in_progress",
        created_at: now - 60_000,
        started_at: now - 50_000,
        heartbeat_at: now - 5_000,
      },
      {
        _id: "newer-completed-run",
        agent_id: "agent-open",
        goal: "Review previous work",
        status: "completed",
        created_at: now - 10_000,
        started_at: now - 9_000,
        finished_at: now - 1_000,
      },
    ],
  });

  assert.equal(rows[0].runId, "active-run");
  assert.equal(rows[0].goal, "Still implementing");
  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].semanticState, "working");
  assert.equal(rows[0].heartbeatAgeMs, 5_000);
});

test("resolveAgentAvailability maps hosted, unknown, available, and missing providers", () => {
  assert.equal(resolveAgentAvailability(), "hosted");
  assert.equal(resolveAgentAvailability("opencode"), "unknown");
  assert.equal(resolveAgentAvailability("opencode", { opencode: true }), "available");
  assert.equal(resolveAgentAvailability("opencode", { opencode: false }), "missing");
});

test("resolveAgentAvailabilityDetail explains unavailable agent dispatch paths", () => {
  assert.deepEqual(
    resolveAgentAvailabilityDetail({ provider: "herdr", execution_mode: "external_herdr" }, undefined, {}),
    { availability: "external", reason: "Herdr pane; attach with herdr agent attach" },
  );
  assert.deepEqual(
    resolveAgentAvailabilityDetail({ provider: "opencode", execution_mode: "remote_cli" }, undefined, { opencode: true }),
    { availability: "remote", reason: "remote CLI dispatch" },
  );
  assert.deepEqual(
    resolveAgentAvailabilityDetail({ provider: "sandcastle", execution_mode: "local_sandcastle" }, undefined, {}),
    { availability: "unsupported", reason: "local_sandcastle has no TUI CLI adapter" },
  );
  assert.deepEqual(
    resolveAgentAvailabilityDetail({ provider: "openclaw", execution_mode: "local_openclaw" }, "openclaw", { openclaw: false }),
    { availability: "missing", reason: "zeroclaw/openclaw not found on PATH" },
  );
});

test("normalizeAgentState keeps known states and falls back to idle", () => {
  assert.equal(normalizeAgentState("queued"), "queued");
  assert.equal(normalizeAgentState("working"), "running");
  assert.equal(normalizeAgentState("blocked"), "blocked");
  assert.equal(normalizeAgentState("done"), "succeeded");
  assert.equal(normalizeAgentState("cancelled"), "cancelled");
  assert.equal(normalizeAgentState("other"), "idle");
  assert.equal(normalizeAgentState(), "idle");
});
