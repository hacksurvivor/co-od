// Unit tests for chat-view's pure helpers: error humanization, feed-noise
// filtering, status rewriting, and agent-message summarization. These shape
// every line a person reads in the room, so they get behavioral coverage even
// though the surrounding component tree is only exercised visually.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAgentLine,
  httpErrorInfo,
  humaneHttpError,
  isTaskFeedNoise,
  spawnErrorInfo,
  statusDetail,
  summarizeAgentMessage,
} from "../dist/commands/chat-view.js";
import { agentCreationErrorMessage } from "../dist/commands/run.js";
import { resolveConvexUrl } from "../dist/tui-convex-live.js";

test("httpErrorInfo parses method, path, code, and reason from raw failures", () => {
  const parsed = httpErrorInfo("Error: POST /api/rooms/r1/agents failed: 500 Internal Server Error");
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.path, "/api/rooms/r1/agents");
  assert.equal(parsed.code, "500");
  assert.equal(parsed.resource, "agents");
  assert.equal(httpErrorInfo("just some prose about a failure"), null);
});

test("humaneHttpError maps status codes to a headline and one next step", () => {
  const unauthorized = humaneHttpError(httpErrorInfo("GET /api/rooms/r1/agents failed: 401 Unauthorized"));
  assert.match(unauthorized.headline, /sign-in expired/);
  assert.match(unauthorized.next, /login/);
  const server = humaneHttpError(httpErrorInfo("POST /api/rooms/r1/runs failed: 503 Service Unavailable"));
  assert.match(server.headline, /server stumbled/);
});

test("spawnErrorInfo recognizes missing provider executables and names the tool", () => {
  const error = spawnErrorInfo("Error: spawn /usr/local/bin/codex ENOENT");
  assert.equal(error.tool, "Codex CLI");
  assert.match(error.path, /codex/);
  assert.equal(spawnErrorInfo("Error: something else entirely"), null);
});

test("statusDetail rewrites plumbing into outcomes without run ids", () => {
  assert.equal(statusDetail("POST /api/x failed: 401 Unauthorized"), "signed out — /login reconnects you");
  assert.equal(statusDetail("Task succeeded: run-abc123def456"), "✓ task done");
  assert.equal(statusDetail("Loading task detail: abc123def456"), "opening the task…");
  assert.equal(statusDetail("Opening task detail: abc123def456"), "opening the task…");
  assert.ok(!statusDetail("Task failed: run-abc123def456").includes("run-abc123def456"));
});

test("isTaskFeedNoise filters navigation echoes and submit chatter from the feed", () => {
  for (const text of [
    "Opening task detail: t0sh87xxbf",
    "Loading task detail: t0sh87xxbf",
    "Task detail loaded: t0sh87xxbf",
    "Submitting task to @claude",
  ]) {
    assert.equal(isTaskFeedNoise({ kind: "info", text }), true, text);
  }
  assert.equal(isTaskFeedNoise({ kind: "info", text: "Pinned agent @builder" }), false);
});

test("classifyAgentLine drops dispatch plumbing and keeps prose", () => {
  assert.equal(classifyAgentLine("Creating run in room room-1..."), null);
  assert.equal(classifyAgentLine("Warning: no stdin data received"), null);
  assert.equal(classifyAgentLine("[co-od] Read src/index.ts").kind, "activity");
  assert.equal(classifyAgentLine("The fix is in auth.ts line 47.").kind, "body");
});

test("summarizeAgentMessage separates body, activity, and caps long output", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `body line ${index + 1}`);
  const summary = summarizeAgentMessage({
    id: "m1",
    role: "agent",
    blocks: [{ kind: "markdown", text: `${lines.join("\n")}\n[co-od] Read a.ts\n[co-od] Read a.ts\n[co-od] Edit b.ts` }],
  });
  assert.ok(summary.bodyLines.length <= 14);
  assert.ok(summary.omittedBody > 0);
  // duplicate activity collapses
  assert.deepEqual(summary.activityLines, ["Read a.ts", "Edit b.ts"]);
});

test("agentCreationErrorMessage keeps the status code, drops the raw HTTP shape", () => {
  const message = agentCreationErrorMessage("Codex", "POST https://api.example/agents failed: 500 Internal Server Error");
  assert.match(message, /can't add a Codex agent/);
  assert.match(message, /server error 500/);
  assert.ok(!message.includes("https://api.example"));
  const noCode = agentCreationErrorMessage("Codex", "socket hang up");
  assert.ok(!noCode.includes("server error"));
  assert.match(noCode, /room role may not allow agent creation/);
});

test("resolveConvexUrl prefers env, falls back to the API, and degrades to null", async () => {
  process.env.CO_OD_CONVEX_URL = "https://convex.example";
  try {
    assert.equal(await resolveConvexUrl(async () => ({})), "https://convex.example");
  } finally {
    delete process.env.CO_OD_CONVEX_URL;
  }
  assert.equal(await resolveConvexUrl(async () => ({ ok: true, convexUrl: "https://from-api.example" })), "https://from-api.example");
  assert.equal(await resolveConvexUrl(async () => ({ ok: true, convexUrl: null })), null);
  assert.equal(await resolveConvexUrl(async () => { throw new Error("offline"); }), null);
});
