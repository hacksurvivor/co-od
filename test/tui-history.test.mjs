import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTaskHistory,
  resolveTaskHistoryItem,
} from "../dist/tui-history.js";

test("formatTaskHistory lists newest prompts first and filters by query", () => {
  const history = ["Fix tests", "Ship dashboard", "Review runtime controls"];

  assert.match(formatTaskHistory(history), /1\. Review runtime controls/);
  assert.match(formatTaskHistory(history), /2\. Ship dashboard/);
  assert.match(formatTaskHistory(history, "ship"), /Task history matching ship/);
  assert.match(formatTaskHistory(history, "ship"), /1\. Ship dashboard/);
  assert.equal(formatTaskHistory([], ""), "No task history yet.");
});

test("resolveTaskHistoryItem supports latest, numeric index, and unique query", () => {
  const history = ["Fix tests", "Ship dashboard", "Review runtime controls"];

  assert.deepEqual(resolveTaskHistoryItem(history, ""), {
    ok: true,
    goal: "Review runtime controls",
    index: 1,
    message: "Selected latest task history item: Review runtime controls",
  });
  assert.equal(resolveTaskHistoryItem(history, "2").goal, "Ship dashboard");
  assert.equal(resolveTaskHistoryItem(history, "runtime").goal, "Review runtime controls");
});

test("resolveTaskHistoryItem reports missing and ambiguous selections", () => {
  const history = ["Fix tests", "Fix dashboard"];

  assert.equal(resolveTaskHistoryItem([], "").ok, false);
  assert.match(resolveTaskHistoryItem(history, "3").message, /Available: 1-2/);
  assert.match(resolveTaskHistoryItem(history, "fix").message, /matched 2 items/);
});
