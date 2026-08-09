import test from "node:test";
import assert from "node:assert/strict";

import {
  collectProviderSessions,
  extractProviderSessionIdFromRunRecord,
  formatProviderSessions,
  providerSessionStatusForRun,
  resolveProviderSession,
} from "../dist/tui-sessions.js";

const agents = [
  { _id: "agent-a", name: "Builder", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-b", name: "Reviewer", provider: "codex", execution_mode: "local_codex" },
];

const runs = [
  {
    _id: "run-new",
    agent_id: "agent-a",
    status: "completed",
    goal: "Ship dashboard",
    created_at: 300,
    steps: [{
      idx: 1,
      output: { success: true, payload: { providerSessionId: "opencode-session-new" } },
    }],
  },
  {
    _id: "run-old",
    agent_id: "agent-b",
    status: "failed",
    goal: "Fix tests",
    created_at: 100,
    steps: [{
      idx: 1,
      input: { payload: { provider_session_id: "codex-thread-old" } },
    }],
  },
  {
    _id: "run-duplicate",
    agent_id: "agent-a",
    status: "completed",
    goal: "Older duplicate",
    created_at: 50,
    steps: [{
      idx: 1,
      output: { success: true, payload: { providerSessionId: "opencode-session-new" } },
    }],
  },
];

test("extractProviderSessionIdFromRunRecord reads latest step payloads", () => {
  assert.equal(extractProviderSessionIdFromRunRecord(runs[0]), "opencode-session-new");
  assert.equal(extractProviderSessionIdFromRunRecord(runs[1]), "codex-thread-old");
  assert.equal(extractProviderSessionIdFromRunRecord({ _id: "run-empty" }), undefined);
});

test("collectProviderSessions dedupes and enriches rows from agents", () => {
  const rows = collectProviderSessions({ runs, agents });
  assert.deepEqual(rows.map((row) => row.providerSessionId), [
    "opencode-session-new",
    "codex-thread-old",
  ]);
  assert.equal(rows[0].provider, "opencode");
  assert.equal(rows[0].agentName, "Builder");
  assert.equal(rows[1].provider, "codex");
});

test("formatProviderSessions filters visible session rows", () => {
  const rows = collectProviderSessions({ runs, agents });
  assert.match(formatProviderSessions(rows), /1\. opencode opencode-session-new run-new completed Builder/);
  assert.match(formatProviderSessions(rows, "codex"), /Provider sessions matching codex:/);
  assert.match(formatProviderSessions(rows, "codex"), /codex-thread-old/);
  assert.equal(formatProviderSessions([], ""), "No provider sessions found in loaded runs.");
});

test("resolveProviderSession supports latest, index, and unique query", () => {
  const rows = collectProviderSessions({ runs, agents });
  assert.equal(resolveProviderSession(rows, "").row.providerSessionId, "opencode-session-new");
  assert.equal(resolveProviderSession(rows, "2").row.providerSessionId, "codex-thread-old");
  assert.equal(resolveProviderSession(rows, "thread").row.runId, "run-old");
  assert.match(resolveProviderSession(rows, "3").message, /Available: 1-2/);
  assert.match(resolveProviderSession([], "").message, /No provider sessions/);
});

test("providerSessionStatusForRun explains loaded and recoverable native sessions", () => {
  assert.deepEqual(providerSessionStatusForRun(runs, "run-new"), {
    runId: "run-new",
    providerSessionId: "opencode-session-new",
    loaded: true,
    message: "Native provider session available for run-new: opencode-session-new",
  });
  assert.match(providerSessionStatusForRun(runs, "run-missing").message, /will try room detail/);
  assert.match(providerSessionStatusForRun([{ _id: "run-empty" }], "run-empty").message, /No native provider session/);
});
