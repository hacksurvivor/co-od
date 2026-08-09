import test from "node:test";
import assert from "node:assert/strict";

import {
  bridgeApprovalDetailLines,
  bridgeApprovalTarget,
  bridgeApprovalTitle,
  defaultLocalBridgeUrl,
  parseBridgeApprovalRequest,
  parseBridgeApprovalSseBlock,
  respondToBridgeApproval,
} from "../dist/tui-bridge-approvals.js";

test("parseBridgeApprovalRequest accepts prompt-mode approval payloads", () => {
  assert.deepEqual(parseBridgeApprovalRequest(JSON.stringify({
    approvalId: "agent-a:4:123",
    agentId: "agent-a",
    method: "item/commandExecution/requestApproval",
    requestId: 4,
    kind: "destructive",
    mode: "prompt",
    command: ["rm", "-rf", "demo"],
    cwd: "/repo",
    reason: "dangerous command",
    files: ["", "demo"],
    timeoutMs: 10000,
  })), {
    approvalId: "agent-a:4:123",
    agentId: "agent-a",
    method: "item/commandExecution/requestApproval",
    requestId: "4",
    kind: "destructive",
    mode: "prompt",
    status: undefined,
    summary: undefined,
    reason: "dangerous command",
    command: "rm -rf demo",
    cwd: "/repo",
    files: ["demo"],
    requestedAt: undefined,
    expiresAt: undefined,
    timeoutMs: 10000,
  });
});

test("parseBridgeApprovalSseBlock extracts approval_request data events", () => {
  const payload = {
    type: "approval_request",
    data: JSON.stringify({
      approvalId: "approval-1",
      kind: "file-edit",
      files: ["index.ts"],
    }),
  };
  assert.equal(parseBridgeApprovalSseBlock(`data: ${JSON.stringify(payload)}\n\n`)?.approvalId, "approval-1");
  assert.equal(parseBridgeApprovalSseBlock(`data: ${JSON.stringify({ type: "text_delta", data: "hi" })}\n\n`), null);
});

test("bridge approval helpers format target, title, url, and response", async () => {
  assert.equal(defaultLocalBridgeUrl({ CO_OD_LOCAL_BRIDGE_URL: "http://host:4786/" }), "http://host:4786");
  assert.equal(bridgeApprovalTitle({ approvalId: "a", kind: "network" }), "network access approval");
  assert.equal(bridgeApprovalTitle({ approvalId: "a", kind: "file-edit" }), "file edit approval");
  assert.equal(bridgeApprovalTitle({ approvalId: "a", kind: "destructive" }), "destructive command approval");
  assert.equal(bridgeApprovalTarget({ approvalId: "a", files: ["a.ts", "b.ts"] }), "a.ts, b.ts");
  assert.deepEqual(bridgeApprovalDetailLines({
    approvalId: "a",
    kind: "shell",
    command: "pnpm test",
    cwd: "/repo",
    reason: "needs tests",
    method: "item/commandExecution/requestApproval",
    requestId: "9",
    expiresAt: "2026-05-31T00:00:00.000Z",
  }), [
    "pnpm test",
    "cwd: /repo",
    "reason: needs tests",
    "method: item/commandExecution/requestApproval #9",
    "expires: 2026-05-31T00:00:00.000Z",
  ]);

  const calls = [];
  await respondToBridgeApproval({
    bridgeUrl: "http://127.0.0.1:4786/",
    approvalId: "approval/id",
    decision: "deny",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });
  assert.equal(calls[0].url, "http://127.0.0.1:4786/v1/approvals/approval%2Fid");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).decision, "deny");
});
