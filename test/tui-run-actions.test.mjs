import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveContinueCommand,
  resolveForkCommand,
  resolveResumeCommand,
  resolveRetryCommand,
  resolveRerunCommand,
  resolveStopCommand,
} from "../dist/tui-run-actions.js";

const runs = [
  { _id: "run-a", goal: "Fix dashboard", created_at: 200 },
  { _id: "run-b", goal: "Add tests", created_at: 100 },
];

test("resolveContinueCommand defaults to last or latest run and parses explicit refs", () => {
  assert.deepEqual(resolveContinueCommand({
    runs,
    lastRunId: "run-b",
    args: ["follow", "up"],
  }), {
    ok: true,
    runId: "run-b",
    goal: "follow up",
  });

  assert.deepEqual(resolveContinueCommand({
    runs,
    args: ["1", "continue", "this"],
  }), {
    ok: true,
    runId: "run-a",
    goal: "continue this",
  });

  assert.deepEqual(resolveContinueCommand({
    runs,
    args: ["run-b", "more"],
  }), {
    ok: true,
    runId: "run-b",
    goal: "more",
  });
});

test("resolveContinueCommand reports missing run or prompt", () => {
  assert.match(resolveContinueCommand({ runs: [], args: [] }).message, /No run/);
  const missingPrompt = resolveContinueCommand({ runs, args: ["run-a"] });
  assert.equal(missingPrompt.ok, false);
  assert.equal(missingPrompt.runId, "run-a");
  assert.match(missingPrompt.message, /follow-up prompt/);
});

test("resolveResumeCommand defaults to current, last, or latest run with optional prompt", () => {
  assert.deepEqual(resolveResumeCommand({
    runs,
    currentRunId: "run-a",
    lastRunId: "run-b",
    args: [],
    defaultGoal: "Continue where you left off.",
  }), {
    ok: true,
    runId: "run-a",
    goal: "Continue where you left off.",
  });

  assert.deepEqual(resolveResumeCommand({
    runs,
    lastRunId: "run-b",
    args: ["follow", "up"],
  }), {
    ok: true,
    runId: "run-b",
    goal: "follow up",
  });

  assert.deepEqual(resolveResumeCommand({
    runs,
    args: ["1", "continue", "this"],
  }), {
    ok: true,
    runId: "run-a",
    goal: "continue this",
  });

  assert.match(resolveResumeCommand({ runs: [], args: [] }).message, /No run/);
});

test("resolveRerunCommand extracts the selected run goal", () => {
  assert.deepEqual(resolveRerunCommand({ runs, runRef: "2" }), {
    ok: true,
    runId: "run-b",
    goal: "Add tests",
  });

  assert.match(resolveRerunCommand({ runs: [], runRef: "1" }).message, /No run/);
  assert.match(resolveRerunCommand({ runs: [{ _id: "run-empty" }], runRef: "1" }).message, /no goal/);
});

test("resolveForkCommand starts an independent run from selected run context", () => {
  assert.deepEqual(resolveForkCommand({
    runs,
    args: ["2", "try", "another", "approach"],
  }), {
    ok: true,
    runId: "run-b",
    goal: "Fork from run run-b.\n\nOriginal goal: Add tests\n\nFork prompt: try another approach",
  });

  assert.deepEqual(resolveForkCommand({
    runs,
    currentRunId: "run-a",
    args: [],
  }), {
    ok: true,
    runId: "run-a",
    goal: "Fork from run run-a.\n\nOriginal goal: Fix dashboard\n\nFork prompt: Explore an independent alternative approach from the original run context.",
  });

  assert.match(resolveForkCommand({ runs: [], args: [] }).message, /No run/);
  assert.match(resolveForkCommand({ runs: [{ _id: "run-empty" }], args: ["1"] }).message, /no goal/);
});

test("resolveRetryCommand only retries failed or cancelled runs", () => {
  const retryRuns = [
    { _id: "run-ok", goal: "Succeeded", status: "succeeded" },
    { _id: "run-failed", goal: "Fix failed thing", status: "failed" },
    { _id: "run-cancelled", goal: "Resume cancelled thing", status: "cancelled" },
  ];

  assert.deepEqual(resolveRetryCommand({ runs: retryRuns, runRef: "run-failed" }), {
    ok: true,
    runId: "run-failed",
    goal: "Fix failed thing",
  });
  assert.deepEqual(resolveRetryCommand({ runs: retryRuns, currentRunId: "run-cancelled" }), {
    ok: true,
    runId: "run-cancelled",
    goal: "Resume cancelled thing",
  });
  assert.match(resolveRetryCommand({ runs: retryRuns, runRef: "run-ok" }).message, /Only failed or cancelled/);
  assert.match(resolveRetryCommand({ runs: [{ _id: "run-empty", status: "failed" }], runRef: "1" }).message, /no goal/);
});

test("resolveStopCommand only stops queued or running tasks", () => {
  const stopRuns = [
    { _id: "run-ok", goal: "Succeeded", status: "succeeded" },
    { _id: "run-running", goal: "Running", status: "running" },
    { _id: "run-queued", goal: "Queued", status: "queued" },
  ];

  assert.deepEqual(resolveStopCommand({ runs: stopRuns, runRef: "run-running" }), {
    ok: true,
    runId: "run-running",
  });
  assert.deepEqual(resolveStopCommand({ runs: stopRuns, currentRunId: "run-queued" }), {
    ok: true,
    runId: "run-queued",
  });
  assert.match(resolveStopCommand({ runs: stopRuns, runRef: "run-ok" }).message, /Only queued or running/);
  assert.match(resolveStopCommand({ runs: [], runRef: "1" }).message, /No run/);
});
