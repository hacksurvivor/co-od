import test from "node:test";
import assert from "node:assert/strict";

import {
  loadHerdrAgents,
  parseHerdrAgentList,
} from "../dist/tui-herdr.js";

test("parseHerdrAgentList normalizes JSON agent output", () => {
  const agents = parseHerdrAgentList(JSON.stringify({
    agents: [
      {
        terminal_id: "term-1",
        display_agent: "codex reviewer",
        state: "blocked",
        message: "approval requested",
      },
      {
        pane_id: "pane-2",
        agent: "opencode builder",
        status: "working",
        cwd: "/repo",
      },
    ],
  }));

  assert.deepEqual(agents.map((agent) => agent._id), ["herdr:term-1", "herdr:pane-2"]);
  assert.equal(agents[0].name, "codex reviewer");
  assert.equal(agents[0].provider, "herdr");
  assert.equal(agents[0].execution_mode, "external_herdr");
  assert.equal(agents[0].external_status, "blocked");
  assert.equal(agents[0].external_summary, "approval requested");
  assert.equal(agents[0].external_attach_command, "herdr agent attach term-1");
});

test("loadHerdrAgents falls back from --json to default list output", async () => {
  const calls = [];
  const result = await loadHerdrAgents({
    timeoutMs: 10,
    execFile: (file, args, _options, callback) => {
      calls.push([file, ...args]);
      if (args.includes("--json")) {
        callback(new Error("unknown flag"), "", "");
        return;
      }
      callback(null, JSON.stringify([{ id: "a", name: "Agent", state: "done" }]), "");
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].external_status, "done");
  assert.deepEqual(calls, [
    ["herdr", "agent", "list", "--json"],
    ["herdr", "agent", "list"],
  ]);
});

test("loadHerdrAgents respects explicit disable env", async () => {
  const result = await loadHerdrAgents({
    env: { CO_OD_TUI_HERDR: "0" },
    execFile: () => {
      throw new Error("should not execute");
    },
  });

  assert.deepEqual(result, { available: false, agents: [] });
});
