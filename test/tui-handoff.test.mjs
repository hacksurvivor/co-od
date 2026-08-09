import test from "node:test";
import assert from "node:assert/strict";

import { resolveHandoffCommand } from "../dist/tui-handoff.js";

const runs = [
  { _id: "run-source", agent_id: "agent-open", goal: "Audit the dashboard", status: "succeeded" },
  { _id: "run-latest", agent_id: "agent-codex", goal: "Fix the palette", status: "failed" },
];

const agents = [
  { _id: "agent-open", name: "Open", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-codex", name: "Codex", provider: "openai", execution_mode: "local_codex" },
  { _id: "agent-hosted", name: "Hosted", provider: "openai", execution_mode: "hosted_api" },
];

test("resolveHandoffCommand resolves explicit run and agent refs", () => {
  const result = resolveHandoffCommand({
    runs,
    agents,
    args: ["1", "Codex", "continue", "implementation"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.sourceRunId, "run-source");
  assert.equal(result.targetAgentId, "agent-codex");
  assert.equal(result.targetProvider, "codex");
  assert.equal(result.context, "continue implementation");
  assert.match(result.goal, /Audit the dashboard/);
});

test("resolveHandoffCommand uses current run when first arg is an agent", () => {
  const result = resolveHandoffCommand({
    runs,
    agents,
    args: ["Hosted"],
    currentRunId: "run-latest",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sourceRunId, "run-latest");
  assert.equal(result.targetAgentId, "agent-hosted");
  assert.equal(result.targetProvider, undefined);
  assert.match(result.context, /Handoff from run/);
});

test("resolveHandoffCommand reports missing context objects", () => {
  assert.match(resolveHandoffCommand({ runs, agents, args: [] }).message, /Usage/);
  assert.match(resolveHandoffCommand({ runs, agents, args: ["current", "Codex"] }).message, /No current run/);
  assert.match(resolveHandoffCommand({ runs, agents, args: ["1", "Nobody"] }).message, /No matching target agent/);
  assert.match(resolveHandoffCommand({ runs, agents, args: ["missing", "Codex"] }).message, /Usage/);
});
