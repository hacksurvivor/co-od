import test from "node:test";
import assert from "node:assert/strict";

import { resolveFanoutCommand } from "../dist/tui-fanout.js";

const agents = [
  { _id: "agent-open", name: "Open", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-codex", name: "Codex", provider: "openai", execution_mode: "local_codex" },
  { _id: "agent-hosted", name: "Hosted", provider: "openai", execution_mode: "hosted_api" },
];

test("resolveFanoutCommand selects all available local CLI agents", () => {
  const result = resolveFanoutCommand({
    agents,
    args: ["all", "review", "the", "plan"],
    providerAvailability: { opencode: true, codex: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.goal, "review the plan");
  assert.deepEqual(result.targets.map((target) => [target.agentId, target.provider]), [
    ["agent-open", "opencode"],
    ["agent-codex", "codex"],
  ]);
  assert.match(result.message, /Skipped Hosted: not local/);
});

test("resolveFanoutCommand selects explicit comma-separated agents", () => {
  const result = resolveFanoutCommand({
    agents,
    args: ["Open,Codex", "ship", "it"],
    providerAvailability: { opencode: true, codex: true },
  });

  assert.equal(result.ok, true);
  assert.equal(result.goal, "ship it");
  assert.deepEqual(result.targets.map((target) => target.name), ["Open", "Codex"]);
});

test("resolveFanoutCommand reports missing prompt or unavailable agents", () => {
  assert.match(resolveFanoutCommand({ agents, args: [] }).message, /Usage/);
  assert.match(resolveFanoutCommand({ agents, args: ["all"] }).message, /needs a prompt/);
  assert.match(
    resolveFanoutCommand({
      agents,
      args: ["all", "go"],
      providerAvailability: { opencode: false, codex: false },
    }).message,
    /No local CLI agents/,
  );
});
