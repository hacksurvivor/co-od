import test from "node:test";
import assert from "node:assert/strict";

import {
  createSafetyState,
  evaluateSafetyActionApproval,
  evaluateTaskApproval,
  ensureTaskAllowed,
  providerSafetyPolicy,
  safetyLines,
  safetySummary,
  toggleSafety,
} from "../dist/tui-safety.js";

test("createSafetyState reads explicit environment policy", () => {
  const state = createSafetyState({
    CODEX_APPROVAL_POLICY: "on-request",
    CODEX_SANDBOX_MODE: "workspace-write",
    CODEX_NETWORK_ACCESS: "enabled",
  });

  assert.equal(state.approvalMode, "on-request");
  assert.equal(state.sandboxMode, "workspace-write");
  assert.equal(state.networkEnabled, true);
  assert.equal(state.autoRun, true);
  assert.equal(state.autoApply, false);
  assert.equal(state.allowDangerousCommands, false);
});

test("providerSafetyPolicy documents local adapter policy", () => {
  assert.equal(providerSafetyPolicy("codex").approvalMode, "full-auto");
  assert.match(providerSafetyPolicy("opencode").note, /OpenCode/);
  assert.equal(providerSafetyPolicy("missing").sandboxMode, "provider-default");
});

test("safetySummary and safetyLines expose visible state", () => {
  const state = createSafetyState({});
  const summary = safetySummary(state, "codex");
  assert.match(summary, /approval full-auto/);
  assert.match(summary, /auto-run on/);
  assert.equal(safetyLines(state, "opencode").some((line) => line.includes("opencode defaults")), true);
});

test("toggleSafety supports aliases and records audit entries", () => {
  let result = toggleSafety(createSafetyState({}), "auto-run");
  assert.equal(result.ok, true);
  assert.equal(result.state.autoRun, false);
  assert.equal(result.state.audit.at(-1).decision, "toggled");

  result = toggleSafety(result.state, "danger");
  assert.equal(result.state.allowDangerousCommands, true);

  result = toggleSafety(result.state, "nope");
  assert.equal(result.ok, false);
  assert.match(result.message, /Toggle one of/);
});

test("ensureTaskAllowed gates task submission when auto-run is off", () => {
  const disabled = { ...createSafetyState({}), autoRun: false };
  const blocked = ensureTaskAllowed(disabled);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /auto-run is off/);
  assert.equal(blocked.state.audit.at(-1).decision, "blocked");

  const allowed = ensureTaskAllowed(createSafetyState({}));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.state.audit.at(-1).decision, "allowed");
});

test("evaluateTaskApproval supports manual approval without toggling auto-run", () => {
  const disabled = { ...createSafetyState({}), autoRun: false };
  const pending = evaluateTaskApproval(disabled);
  assert.equal(pending.status, "needs-approval");
  assert.equal(pending.state.audit.length, 0);

  const approved = evaluateTaskApproval(disabled, { approved: true });
  assert.equal(approved.status, "allowed");
  assert.equal(approved.state.autoRun, false);
  assert.equal(approved.state.audit.at(-1).decision, "allowed");
  assert.match(approved.state.audit.at(-1).reason, /manually approved/);
});

test("evaluateSafetyActionApproval gates file edits on auto-apply", () => {
  const disabled = createSafetyState({});
  const pending = evaluateSafetyActionApproval(disabled, "file-edit");
  assert.equal(pending.status, "needs-approval");
  assert.match(pending.message, /auto-apply is off/);
  assert.equal(pending.state.audit.length, 0);

  const approved = evaluateSafetyActionApproval(disabled, "file-edit", { approved: true });
  assert.equal(approved.status, "allowed");
  assert.equal(approved.state.autoApply, false);
  assert.equal(approved.state.audit.at(-1).action, "file-edit");
  assert.match(approved.state.audit.at(-1).reason, /manually approved/);

  const enabled = evaluateSafetyActionApproval({ ...disabled, autoApply: true }, "file-edit");
  assert.equal(enabled.status, "allowed");
  assert.match(enabled.message, /local policy/);
  assert.equal(enabled.state.audit.at(-1).reason, "auto-apply enabled");
});

test("evaluateSafetyActionApproval gates network on local policy", () => {
  const disabled = { ...createSafetyState({}), networkEnabled: false };
  const pending = evaluateSafetyActionApproval(disabled, "network");
  assert.equal(pending.status, "needs-approval");
  assert.match(pending.message, /network is disabled/);

  const approved = evaluateSafetyActionApproval(disabled, "network", { approved: true });
  assert.equal(approved.status, "allowed");
  assert.equal(approved.state.networkEnabled, false);
  assert.equal(approved.state.audit.at(-1).action, "network");

  const unspecified = evaluateSafetyActionApproval(createSafetyState({}), "network");
  assert.equal(unspecified.status, "allowed");
  assert.equal(unspecified.state.audit.at(-1).reason, "network allowed by local policy");
});

test("evaluateSafetyActionApproval gates destructive actions on dangerous policy", () => {
  const blockedState = createSafetyState({});
  const pending = evaluateSafetyActionApproval(blockedState, "destructive");
  assert.equal(pending.status, "needs-approval");
  assert.match(pending.message, /dangerous commands are blocked/);

  const approved = evaluateSafetyActionApproval(blockedState, "destructive", { approved: true });
  assert.equal(approved.status, "allowed");
  assert.equal(approved.state.allowDangerousCommands, false);
  assert.match(approved.state.audit.at(-1).reason, /manually approved/);

  const enabled = evaluateSafetyActionApproval({ ...blockedState, allowDangerousCommands: true }, "destructive");
  assert.equal(enabled.status, "allowed");
  assert.equal(enabled.state.audit.at(-1).reason, "dangerous commands allowed");
});
