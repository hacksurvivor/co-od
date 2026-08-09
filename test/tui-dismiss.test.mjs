import test from "node:test";
import assert from "node:assert/strict";
import { createOpenTuiPreviewUiState, reduceOpenTuiPreviewKey } from "../dist/tui-opentui-preview.js";
import { loadOpenTuiPreviewStartupState, parseOpenTuiPreviewArgs } from "../dist/tui-opentui-preview.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stateWithRuns(runs) {
  const dir = mkdtempSync(join(tmpdir(), "co-od-dismiss-"));
  writeFileSync(join(dir, ".co-od.json"), JSON.stringify({ roomId: "room-a", roomName: "A" }));
  const base = createOpenTuiPreviewUiState(loadOpenTuiPreviewStartupState(parseOpenTuiPreviewArgs(["--dir", dir])));
  return {
    ...base,
    mode: "task",
    dashboard: {
      ...base.dashboard,
      dashboard: { ...base.dashboard.dashboard, runs },
    },
  };
}

test("/dismiss waves off the latest failure and persists the id in state", () => {
  const ui = stateWithRuns([
    { _id: "run-ok", status: "succeeded", goal: "fine" },
    { _id: "run-bad", status: "failed", goal: "broken thing" },
  ]);
  const result = reduceOpenTuiPreviewKey({ ...ui, taskInput: "/dismiss" }, "\r");
  assert.deepEqual(result.intent, { type: "none" });
  assert.ok(result.state.dismissedRunIds.includes("run-bad"));
  assert.match(result.state.message, /dismissed: broken thing/);
});

test("/dismiss with nothing failed says the inbox is clear", () => {
  const ui = stateWithRuns([{ _id: "run-ok", status: "succeeded", goal: "fine" }]);
  const result = reduceOpenTuiPreviewKey({ ...ui, taskInput: "/dismiss" }, "\r");
  assert.match(result.state.message, /Nothing to dismiss/);
  assert.deepEqual(result.state.dismissedRunIds || [], []);
});

test("dismissing twice reports already dismissed", () => {
  const ui = stateWithRuns([{ _id: "run-bad", status: "failed", goal: "broken" }]);
  const once = reduceOpenTuiPreviewKey({ ...ui, taskInput: "/dismiss" }, "\r").state;
  const twice = reduceOpenTuiPreviewKey({ ...once, mode: "task", taskInput: "/dismiss run-bad" }, "\r");
  assert.match(twice.state.message, /Already dismissed/);
});
