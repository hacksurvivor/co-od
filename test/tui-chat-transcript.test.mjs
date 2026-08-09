import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyTranscript,
  appendUserMessage,
  foldTaskEventIntoTranscript,
  addPatchBlock,
  setPatchStatus,
} from "../dist/tui-chat-transcript.js";

test("appendUserMessage adds a 'you' message with one markdown block", () => {
  const t = appendUserMessage(createEmptyTranscript(), "refactor the auth flow", "u1");
  assert.equal(t.length, 1);
  assert.equal(t[0].role, "you");
  assert.equal(t[0].id, "u1");
  assert.deepEqual(t[0].blocks, [{ kind: "markdown", text: "refactor the auth flow" }]);
});

test("submitted event opens a streaming agent message", () => {
  const t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x", agentId: "a1" }, { messageId: "m1", agentName: "Release QA" });
  assert.equal(t.length, 1);
  assert.equal(t[0].role, "agent");
  assert.equal(t[0].agentName, "Release QA");
  assert.equal(t[0].provider, "claude");
  assert.equal(t[0].streaming, true);
  assert.deepEqual(t[0].blocks, []);
});

test("output events append to the trailing markdown block of the streaming message", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = foldTaskEventIntoTranscript(t, { type: "output", data: "Traced " }, { messageId: "m1" });
  t = foldTaskEventIntoTranscript(t, { type: "output", data: "the chain." }, { messageId: "m1" });
  assert.deepEqual(t[0].blocks, [{ kind: "markdown", text: "Traced the chain." }]);
});

test("complete event clears streaming on the message", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = foldTaskEventIntoTranscript(t, { type: "complete", result: { runId: "r1", status: "completed", exitCode: 0 } }, { messageId: "m1" });
  assert.equal(t[0].streaming, false);
});

test("error event appends a danger markdown block and clears streaming", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = foldTaskEventIntoTranscript(t, { type: "error", message: "boom" }, { messageId: "m1" });
  assert.equal(t[0].streaming, false);
  assert.deepEqual(t[0].blocks.at(-1), { kind: "markdown", text: "**Error:** boom" });
});

test("addPatchBlock attaches a diff block to the message", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = addPatchBlock(t, "m1", { patchId: "p1", runId: "r1", file: "auth/redirect.ts", diff: "@@ -1 +1 @@", status: "proposed" });
  assert.deepEqual(t[0].blocks.at(-1), { kind: "diff", patchId: "p1", runId: "r1", file: "auth/redirect.ts", diff: "@@ -1 +1 @@", status: "proposed" });
});

test("setPatchStatus updates the targeted patch to accepted", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = addPatchBlock(t, "m1", { patchId: "p1", runId: "r1", file: "a.ts", diff: "@@", status: "proposed" });
  t = setPatchStatus(t, "p1", "accepted");
  assert.equal(t[0].blocks.at(-1).status, "accepted");
});

test("setPatchStatus only mutates the matching patchId across messages", () => {
  let t = foldTaskEventIntoTranscript([], { type: "submitted", provider: "claude", goal: "x" }, { messageId: "m1", agentName: "QA" });
  t = addPatchBlock(t, "m1", { patchId: "p1", file: "a.ts", diff: "@@", status: "proposed" });
  t = addPatchBlock(t, "m1", { patchId: "p2", file: "b.ts", diff: "@@", status: "proposed" });
  t = setPatchStatus(t, "p2", "rejected");
  const blocks = t[0].blocks.filter((b) => b.kind === "diff");
  assert.equal(blocks.find((b) => b.patchId === "p1").status, "proposed");
  assert.equal(blocks.find((b) => b.patchId === "p2").status, "rejected");
});
