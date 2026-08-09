import test from "node:test";
import assert from "node:assert/strict";

import {
  findAgent,
  resolveAgentPauseCommand,
  resolveAgentResumeCommand,
  resolveAgentStartCommand,
  resolveAgentStopCommand,
} from "../dist/tui-agent-actions.js";

const agents = [
  { _id: "agent-open", name: "Builder", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-codex", name: "Reviewer", provider: "openai", execution_mode: "local_codex" },
  { _id: "agent-hosted", name: "Hosted", provider: "openai", execution_mode: "hosted_api" },
];

const runs = [
  { _id: "run-active", agent_id: "agent-open", status: "running", goal: "Build", created_at: 30 },
  { _id: "run-queued", agent_id: "agent-open", status: "queued", goal: "Wait", created_at: 40 },
  { _id: "run-paused", agent_id: "agent-open", status: "paused", goal: "Pause", created_at: 45 },
  { _id: "run-done", agent_id: "agent-open", status: "succeeded", goal: "Done", created_at: 50 },
  { _id: "run-other", agent_id: "agent-codex", status: "running", goal: "Review", created_at: 20 },
];

test("findAgent resolves by id suffix, name, and index", () => {
  assert.equal(findAgent(agents, "open")?._id, "agent-open");
  assert.equal(findAgent(agents, "reviewer")?._id, "agent-codex");
  assert.equal(findAgent(agents, "3")?._id, "agent-hosted");
});

test("resolveAgentStartCommand starts local CLI-capable agents", () => {
  const result = resolveAgentStartCommand({
    agents,
    args: ["Builder", "fix", "the", "tests"],
    providerAvailability: { opencode: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentId, "agent-open");
  assert.equal(result.provider, "opencode");
  assert.equal(result.goal, "fix the tests");
});

test("resolveAgentStartCommand reports missing, hosted, and unavailable agents", () => {
  assert.match(resolveAgentStartCommand({ agents, args: [] }).message, /Usage/);
  assert.match(resolveAgentStartCommand({ agents, args: ["missing", "go"] }).message, /No matching agent/);
  assert.match(resolveAgentStartCommand({ agents, args: ["Hosted", "go"] }).message, /no local CLI dispatch path/);
  assert.match(
    resolveAgentStartCommand({
      agents,
      args: ["Builder", "go"],
      providerAvailability: { opencode: false },
    }).message,
    /not available on PATH/,
  );
});

test("resolveAgentStopCommand selects active tasks for one agent", () => {
  const result = resolveAgentStopCommand({
    agents,
    runs,
    args: ["Builder"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.runIds, ["run-queued", "run-active"]);
  assert.match(result.message, /2 active tasks/);
});

test("resolveAgentStopCommand reports invalid or idle agents", () => {
  assert.match(resolveAgentStopCommand({ agents, runs, args: [] }).message, /Usage/);
  assert.match(resolveAgentStopCommand({ agents, runs, args: ["missing"] }).message, /No matching agent/);
  assert.match(resolveAgentStopCommand({ agents, runs: [], args: ["Builder"] }).message, /no queued or running tasks/);
});

test("resolveAgentPauseCommand selects active local bridge tasks", () => {
  const result = resolveAgentPauseCommand({
    agents,
    runs,
    args: ["Builder"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentId, "agent-open");
  assert.deepEqual(result.runIds, ["run-queued", "run-active"]);
  assert.match(result.message, /2 active tasks/);
});

test("resolveAgentResumeCommand selects paused local bridge runs", () => {
  const result = resolveAgentResumeCommand({
    agents,
    runs,
    args: ["Builder"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentId, "agent-open");
  assert.deepEqual(result.runIds, ["run-paused"]);
  assert.match(result.message, /1 paused run/);
});

test("agent pause and resume commands report invalid or unsupported targets", () => {
  assert.match(resolveAgentPauseCommand({ agents, runs, args: [] }).message, /Usage/);
  assert.match(resolveAgentPauseCommand({ agents, runs, args: ["missing"] }).message, /No matching agent/);
  assert.match(resolveAgentPauseCommand({ agents, runs: [], args: ["Builder"] }).message, /no queued or running local bridge tasks/);
  assert.match(resolveAgentResumeCommand({ agents, runs, args: ["Reviewer"] }).message, /no paused local bridge runs/);
  assert.match(resolveAgentResumeCommand({ agents, runs, args: ["Hosted"] }).message, /no paused local bridge runs/);
});
