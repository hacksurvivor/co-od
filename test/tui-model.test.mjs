import test from "node:test";
import assert from "node:assert/strict";

import {
  approvalStepMetadata,
  buildDelegationRows,
  classifyDiffLine,
  dedupeRuns,
  diffStat,
  formatApprovalStepDescription,
  formatStepDescription,
  resolveRunId,
  shortId,
} from "../dist/tui-model.js";

test("run ids resolve by index, exact id, and suffix", () => {
  const runs = [
    { _id: "run-alpha-0001", created_at: 300 },
    { _id: "run-beta-0002", created_at: 200 },
  ];

  assert.equal(resolveRunId(runs), "run-alpha-0001");
  assert.equal(resolveRunId(runs, 1), "run-beta-0002");
  assert.equal(resolveRunId(runs, "2"), "run-beta-0002");
  assert.equal(resolveRunId(runs, "run-alpha-0001"), "run-alpha-0001");
  assert.equal(resolveRunId(runs, "0002"), "run-beta-0002");
  assert.equal(resolveRunId(runs, "external-run"), "external-run");
});

test("dedupeRuns keeps latest entry order by creation time", () => {
  const runs = dedupeRuns([
    { _id: "a", status: "queued", created_at: 100 },
    { _id: "b", status: "running", created_at: 300 },
    { _id: "a", status: "succeeded", created_at: 200 },
  ]);

  assert.deepEqual(runs.map((run) => [run._id, run.status]), [
    ["b", "running"],
    ["a", "succeeded"],
  ]);
});

test("diff helpers count changed lines and classify unified diff lines", () => {
  const diff = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " context",
  ].join("\n");

  assert.equal(diffStat(diff), "+1 -1");
  assert.equal(classifyDiffLine("@@ -1 +1 @@"), "meta");
  assert.equal(classifyDiffLine("+added"), "add");
  assert.equal(classifyDiffLine("-removed"), "remove");
  assert.equal(classifyDiffLine(" context"), "context");
});

test("step descriptions prefer explicit descriptions then payload summaries", () => {
  assert.equal(formatStepDescription({ input: { description: "planned" } }), "planned");
  assert.equal(formatStepDescription({ output: { payload: { summary: "summarized" } } }), "summarized");
  assert.equal(formatStepDescription({ output: { payload: { text: "text output" } } }), "text output");
  assert.equal(formatStepDescription({ input: { payload: { command: "pnpm test" } } }), '{"command":"pnpm test"}');
});

test("approval step metadata is extracted and formatted for run timelines", () => {
  const step = {
    kind: "tool_call",
    input: {
      description: "approval:destructive",
      payload: {
        command: "rm -rf demo",
      },
    },
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
  };

  assert.deepEqual(approvalStepMetadata(step), {
    kind: "destructive",
    decision: "denied",
    mode: "deny",
    summary: undefined,
    reason: "dangerous test command",
    command: "rm -rf demo",
    cwd: undefined,
    files: undefined,
  });
  assert.equal(formatApprovalStepDescription(approvalStepMetadata(step)), "Denied destructive (deny): rm -rf demo - dangerous test command");
  assert.equal(formatStepDescription(step), "Denied destructive (deny): rm -rf demo - dangerous test command");
});

test("approval step metadata falls back to description and file payloads", () => {
  const step = {
    kind: "tool_call",
    input: {
      description: "approval:file-edit",
      payload: {
        files: ["src/app.ts"],
      },
    },
    output: {
      success: true,
      payload: {},
    },
  };

  assert.equal(formatStepDescription(step), "Approved file-edit: src/app.ts");
});

test("delegation rows include spawn and handoff children from the selected root", () => {
  const runs = [
    { _id: "root-run-0001", status: "running", agent_id: "agent-root", goal: "Root", created_at: 100 },
    { _id: "child-run-0002", parent_run_id: "root-run-0001", root_run_id: "root-run-0001", subagent_role: "write", status: "succeeded", goal: "Write", created_at: 200 },
    { _id: "handoff-run-0003", handoff_from: "root-run-0001", status: "queued", goal: "Review", created_at: 300 },
  ];

  const rows = buildDelegationRows(runs[1], runs);

  assert.deepEqual(rows.map((row) => [shortId(row.runId), row.relation, row.depth, row.selected]), [
    ["t-run-0001", "root", 0, false],
    ["d-run-0002", "spawn", 1, true],
    ["f-run-0003", "handoff", 1, false],
  ]);
});

test("delegation rows stop cycles", () => {
  const runs = [
    { _id: "cycle-a-0001", parent_run_id: "cycle-b-0002", status: "running", created_at: 100 },
    { _id: "cycle-b-0002", parent_run_id: "cycle-a-0001", status: "running", created_at: 200 },
  ];

  const rows = buildDelegationRows(runs[0], runs);

  assert.ok(rows.some((row) => row.relation === "cycle"));
});

test("canonical graph identity overrides legacy lineage and renders meaningful progress", () => {
  const runs = [
    {
      _id: "run-specialist",
      agent_id: "agent-claude",
      status: "running",
      goal: "Raw specialist goal",
      created_at: 200,
      delegation_graph_id: "graph-1",
      delegation_operation_id: "operation-research",
      delegation_parent_operation_id: "operation-lead",
      delegation_role: "research",
      delegation_state: "running",
      delegation_current_action: "Checking the multiplayer approval path",
    },
    {
      _id: "run-lead",
      agent_id: "agent-codex",
      status: "queued",
      goal: "Lead",
      created_at: 300,
      delegation_graph_id: "graph-1",
      delegation_operation_id: "operation-lead",
      delegation_role: "lead",
      delegation_state: "awaitingApproval",
    },
    { _id: "legacy", status: "running", goal: "Other graph", created_at: 1 },
  ];

  const rows = buildDelegationRows(runs[0], runs);
  assert.deepEqual(rows.map((row) => [row.runId, row.role, row.status, row.depth]), [
    ["run-lead", "lead", "awaitingApproval", 0],
    ["run-specialist", "research", "running", 1],
  ]);
  assert.equal(rows[1].goal, "Checking the multiplayer approval path");
});
