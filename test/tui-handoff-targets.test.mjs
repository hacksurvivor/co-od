import test from "node:test";
import assert from "node:assert/strict";

import {
  cycleHandoffTarget,
  formatHandoffPrefill,
  handoffTargetLabel,
  handoffTargetRef,
  handoffTargetSummary,
  resolveHandoffTarget,
} from "../dist/tui-handoff-targets.js";

const agents = [
  { _id: "agent-alpha", name: "Builder" },
  { _id: "agent-beta", name: "Reviewer" },
  { _id: "agent-gamma", name: "QA Agent" },
];

test("cycleHandoffTarget walks loaded agents in both directions", () => {
  assert.equal(cycleHandoffTarget(agents, undefined, 1)?._id, "agent-alpha");
  assert.equal(cycleHandoffTarget(agents, undefined, -1)?._id, "agent-gamma");
  assert.equal(cycleHandoffTarget(agents, "agent-alpha", 1)?._id, "agent-beta");
  assert.equal(cycleHandoffTarget(agents, "agent-alpha", -1)?._id, "agent-gamma");
  assert.equal(cycleHandoffTarget([], undefined, 1), undefined);
});

test("handoff target helpers use stable agent ids for slash prefill", () => {
  assert.equal(handoffTargetLabel(agents[2]), "QA Agent");
  assert.equal(handoffTargetRef(agents[2]), "agent-gamma");
  assert.equal(formatHandoffPrefill(agents[2]), "/handoff current agent-gamma ");
  assert.equal(formatHandoffPrefill(undefined, "last"), "/handoff last ");
});

test("handoffTargetSummary reports empty, unset, and selected states", () => {
  assert.equal(handoffTargetSummary([], undefined), "no agents loaded");
  assert.equal(handoffTargetSummary(agents, undefined), "none selected");
  assert.equal(handoffTargetSummary(agents, "agent-beta"), "Reviewer (agent-beta)");
});

test("resolveHandoffTarget selects by index, id suffix, exact name, and fuzzy name", () => {
  assert.equal(resolveHandoffTarget(agents, "2").agent?._id, "agent-beta");
  assert.equal(resolveHandoffTarget(agents, "gamma").agent?._id, "agent-gamma");
  assert.equal(resolveHandoffTarget(agents, "Reviewer").agent?._id, "agent-beta");
  assert.equal(resolveHandoffTarget(agents, "qa").agent?._id, "agent-gamma");
});

test("resolveHandoffTarget reports empty, missing, and ambiguous targets", () => {
  assert.match(resolveHandoffTarget([], "1").message, /No agents loaded/);
  assert.match(resolveHandoffTarget(agents, "").message, /Usage: \/handoff-target/);
  assert.match(resolveHandoffTarget(agents, "missing").message, /not found/);
  assert.match(resolveHandoffTarget(agents, "agent").message, /ambiguous/);
});
