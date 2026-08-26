import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  separateAppServerMessageDelta,
  translateAppServerItem,
} from "../dist/adapters/codex.js";
import {
  codexPermissionDecision,
  codexPermissionRequest,
  codexPersistentThreadEnvironment,
  codexThreadConfig,
  CodexAppServerClient,
  prepareCodexAppServerThread,
  harnessUsageWindowLabel,
  readCodexModels,
  readCodexUsageLimits,
  runCodexAppServerTurn,
  validateMcpElicitationContent,
} from "../dist/adapters/codex-app-server.js";

test("Codex app-server approvals normalize into the shared fail-closed contract", () => {
  const request = codexPermissionRequest("item/commandExecution/requestApproval", {
    threadId: "thread-approval",
    turnId: "turn-approval",
    itemId: "item-approval",
    command: "curl https://example.com",
    cwd: "/workspace",
    reason: "Needs network access",
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    additionalPermissions: {
      network: { enabled: true },
      token: "must-not-cross-the-activity-boundary",
    },
  });

  assert.ok(request);
  assert.equal(request.sessionID, "thread-approval");
  assert.equal(request.toolCallID, "item-approval");
  assert.equal(request.kind, "execute");
  assert.deepEqual(request.options.map(({ id, kind }) => ({ id, kind })), [
    { id: "accept", kind: "allow_once" },
    { id: "acceptForSession", kind: "allow_always" },
    { id: "decline", kind: "reject_once" },
    { id: "cancel", kind: "reject_always" },
  ]);
  assert.match(request.input, /curl https:\/\/example\.com/);
  assert.doesNotMatch(request.input, /must-not-cross-the-activity-boundary/);
  assert.deepEqual(codexPermissionDecision(request, "ask"), {
    outcome: "selected",
    optionID: "decline",
  });
  assert.deepEqual(codexPermissionDecision(request, "custom"), {
    outcome: "selected",
    optionID: "decline",
  });
  assert.deepEqual(codexPermissionDecision(request, "plan"), {
    outcome: "selected",
    optionID: "cancel",
  });
  assert.deepEqual(codexPermissionDecision(request, "approve"), {
    outcome: "selected",
    optionID: "accept",
  });
  assert.deepEqual(codexPermissionDecision(request, "fullAccess"), {
    outcome: "selected",
    optionID: "acceptForSession",
  });

  const fileRequest = codexPermissionRequest("item/fileChange/requestApproval", {
    threadId: "thread-approval",
    itemId: "file-approval",
    reason: "Apply the patch",
    availableDecisions: ["accept", "decline"],
  });
  assert.equal(fileRequest?.kind, "edit");
  assert.equal(fileRequest?.tool, "file_change");
  assert.equal(codexPermissionRequest("item/tool/call", {}), undefined);

  const permissionRequest = codexPermissionRequest("item/permissions/requestApproval", {
    threadId: "thread-approval",
    turnId: "turn-approval",
    itemId: "network-approval",
    cwd: "/workspace",
    reason: "Reach the package registry",
    permissions: { network: { enabled: true } },
  });
  assert.equal(permissionRequest?.scope, "externalAction");
  assert.deepEqual(permissionRequest?.options.map(({ id, kind }) => ({ id, kind })), [
    { id: "grantTurn", kind: "allow_once" },
    { id: "deny", kind: "reject_once" },
  ]);
});

test("Codex typed MCP elicitation preserves the provider schema and validates exact primitive content", () => {
  const schema = {
    type: "object",
    properties: {
      email: { type: "string", format: "email", minLength: 3 },
      retries: { type: "integer", minimum: 1, maximum: 5 },
      alerts: { type: "boolean" },
      regions: { type: "array", items: { type: "string", enum: ["eu", "us"] }, minItems: 1 },
    },
    required: ["email", "retries", "regions"],
  };
  const request = codexPermissionRequest("mcpServer/elicitation/request", {
    threadId: "thread-form",
    turnId: "turn-form",
    serverName: "billing",
    mode: "form",
    message: "Connect billing",
    requestedSchema: schema,
  });
  assert.deepEqual(request.requestedSchema, schema);
  assert.equal(request.scope, "externalAction");
  assert.deepEqual(request.options.map(({ id }) => id), ["accept", "decline", "cancel"]);
  assert.deepEqual(validateMcpElicitationContent(schema, {
    email: "owner@example.com",
    retries: 2,
    alerts: true,
    regions: ["eu"],
  }), {
    email: "owner@example.com",
    retries: 2,
    alerts: true,
    regions: ["eu"],
  });
  assert.equal(validateMcpElicitationContent(schema, {
    email: "owner@example.com",
    retries: 2.5,
    regions: ["moon"],
  }), undefined);
  assert.equal(validateMcpElicitationContent(schema, {
    email: "owner@example.com",
    retries: 2,
    regions: ["eu"],
    secretExtra: "blocked",
  }), undefined);
});

test("Codex App Server steers the exact active turn", async () => {
  let notification;
  let runtimeControl;
  const requests = [];
  const client = {
    async ensureStarted() {},
    isThreadActive() { return false; },
    markThreadActive() {},
    onNotification(handler) {
      notification = handler;
      return () => {};
    },
    onRequest() { return () => {}; },
    async request(method, params) {
      requests.push([method, params]);
      if (method === "thread/start") return { thread: { id: "thread-steer" } };
      if (method === "turn/start") return { turn: { id: "turn-steer" } };
      if (method === "turn/steer") {
        setTimeout(() => {
          notification("item/completed", {
            threadId: "thread-steer",
            turnId: "turn-steer",
            item: { type: "agentMessage", id: "answer", text: "Steered.", phase: "final_answer" },
          });
          notification("turn/completed", {
            threadId: "thread-steer",
            turn: { id: "turn-steer", status: "completed" },
          });
        }, 0);
        return { turnId: "turn-steer" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const resultPromise = runCodexAppServerTurn("Start", {
    workDir: "/workspace",
    client,
    turnTimeoutMs: 2_000,
    onRuntimeControl(control) {
      if (!control) return;
      runtimeControl = control;
      void control.steer("Use the focused test instead");
    },
  });
  const result = await resultPromise;
  assert.equal(result.finalMessage, "Steered.");
  assert.equal(runtimeControl.providerTurnID, "turn-steer");
  assert.deepEqual(requests.find(([method]) => method === "turn/steer")?.[1], {
    threadId: "thread-steer",
    expectedTurnId: "turn-steer",
    input: [{ type: "text", text: "Use the focused test instead" }],
  });
});

test("Codex App Server forwards child-thread tools with durable parent lineage", async () => {
  let notification;
  const observed = [];
  const client = {
    async ensureStarted() {},
    isThreadActive() { return false; },
    markThreadActive() {},
    onNotification(handler) {
      notification = handler;
      return () => {};
    },
    onRequest() { return () => {}; },
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-root" } };
      if (method === "turn/start") {
        setTimeout(() => {
          notification("item/completed", {
            threadId: "thread-root",
            item: {
              type: "subAgentActivity",
              id: "spawn-child",
              kind: "started",
              agentThreadId: "thread-child",
              agentPath: "/root/ui_scout",
            },
          });
          notification("item/started", {
            threadId: "thread-child",
            item: {
              type: "commandExecution",
              id: "child-command",
              command: "rg -n sidebar apps/macos",
            },
          });
          notification("item/completed", {
            threadId: "thread-child",
            item: {
              type: "commandExecution",
              id: "child-command",
              command: "rg -n sidebar apps/macos",
              exitCode: 0,
            },
          });
          notification("item/completed", {
            threadId: "thread-root",
            item: { type: "agentMessage", id: "answer", text: "Done.", phase: "final_answer" },
          });
          notification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "turn-root", status: "completed" },
          });
        }, 0);
        return { turn: { id: "turn-root" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };

  await runCodexAppServerTurn("Fix the UI", {
    workDir: "/workspace",
    client,
    turnTimeoutMs: 2_000,
    onItem(item, phase, context) {
      observed.push({ type: item.type, phase, context });
    },
  });

  assert.deepEqual(
    observed.filter(({ type }) => type === "commandExecution").map(({ phase, context }) => ({
      phase,
      context,
    })),
    [
      {
        phase: "started",
        context: {
          threadId: "thread-child",
          parentThreadId: "thread-root",
          isSubagent: true,
        },
      },
      {
        phase: "completed",
        context: {
          threadId: "thread-child",
          parentThreadId: "thread-root",
          isSubagent: true,
        },
      },
    ],
  );
});

test("Codex App Server runs detached native review and returns review findings", async () => {
  let notification;
  const requests = [];
  const client = {
    async ensureStarted() {},
    isThreadActive() { return false; },
    markThreadActive() {},
    onNotification(handler) {
      notification = handler;
      return () => {};
    },
    onRequest() { return () => {}; },
    async request(method, params) {
      requests.push([method, params]);
      if (method === "thread/start") return { thread: { id: "thread-builder" } };
      if (method === "review/start") {
        setTimeout(() => {
          notification("item/completed", {
            threadId: "thread-review",
            turnId: "turn-review",
            item: { type: "exitedReviewMode", id: "review", review: "No findings." },
          });
          notification("turn/completed", {
            threadId: "thread-review",
            turn: { id: "turn-review", status: "completed" },
          });
        }, 0);
        return { reviewThreadId: "thread-review", turn: { id: "turn-review" } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await runCodexAppServerTurn("unused", {
    workDir: "/workspace",
    client,
    turnTimeoutMs: 2_000,
    nativeReview: {
      target: { type: "custom", instructions: "Review the completed change" },
      delivery: "detached",
    },
  });
  assert.equal(result.threadId, "thread-review");
  assert.equal(result.finalMessage, "No findings.");
  assert.deepEqual(requests.find(([method]) => method === "review/start")?.[1], {
    threadId: "thread-builder",
    target: { type: "custom", instructions: "Review the completed change" },
    delivery: "detached",
  });
});

test("Codex app-server initialization completes the required client handshake", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-app-server-"));
  const executable = join(directory, "codex");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.COODE_APP_SERVER_TRANSCRIPT;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { userAgent: "coode-test-app-server" },
    }) + "\\n");
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      COODE_APP_SERVER_TRANSCRIPT: transcript,
    },
  });
  t.after(() => client.dispose());

  await client.ensureStarted();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages[0].method, "initialize");
  assert.deepEqual(
    messages[0].params.capabilities.extensions["io.modelcontextprotocol/ui"],
    { mimeTypes: ["text/html;profile=mcp-app"] },
  );
  assert.deepEqual(messages[1], {
    jsonrpc: "2.0",
    method: "initialized",
  });
});

test("Codex app-server exits during handshake without leaking an uncaught EPIPE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-app-server-exit-"));
  const executable = join(directory, "codex");
  await writeFile(executable, `#!/bin/sh
exit 0
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
    },
  });
  t.after(() => client.dispose());

  await assert.rejects(
    client.ensureStarted(),
    /codex app-server (?:exited|write failed|initialize request write failed)/,
  );
  await assert.rejects(
    client.request("thread/start", {}),
    /codex app-server is not running/,
  );
});

test("Codex app-server sends the UI-selected native approval response", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-approval-"));
  const executable = join(directory, "codex");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.COODE_APP_SERVER_TRANSCRIPT;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-approval" } } });
  } else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-approval" } } });
    setTimeout(() => send({
      jsonrpc: "2.0",
      id: 701,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        itemId: "command-approval",
        command: "npm test",
        cwd: "/workspace",
        reason: "Run the verification suite",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    }), 5);
  } else if (message.id === 701 && message.result?.decision === "accept") {
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        item: { type: "agentMessage", id: "answer", text: "Approved safely.", phase: "final_answer" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-approval", turn: { id: "turn-approval", status: "completed" } },
    });
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      COODE_APP_SERVER_TRANSCRIPT: transcript,
    },
  });
  t.after(() => client.dispose());
  const approvals = [];
  const result = await runCodexAppServerTurn("Run the tests", {
    workDir: directory,
    client,
    approvalPolicy: "on-request",
    permissionMode: "ask",
    turnTimeoutMs: 2_000,
    onPermissionRequest: (request) => {
      approvals.push(request);
      return { outcome: "selected", optionID: "accept" };
    },
  });

  assert.equal(result.finalMessage, "Approved safely.");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolCallID, "command-approval");
  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    messages.find((message) => message.method === "turn/start")?.params?.approvalPolicy,
    "on-request",
  );
  assert.deepEqual(messages.find((message) => message.id === 701 && message.result), {
    jsonrpc: "2.0",
    id: 701,
    result: { decision: "accept" },
  });
});

test("Codex app-server interrupts a turn that exceeds its hard deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-timeout-"));
  const executable = join(directory, "codex");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.COODE_APP_SERVER_TRANSCRIPT;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const message = JSON.parse(line);
  const responses = {
    "initialize": { userAgent: "coode-test-app-server" },
    "thread/start": { thread: { id: "thread-stuck" } },
    "turn/start": { turn: { id: "turn-stuck", status: "inProgress", items: [] } },
    "turn/interrupt": {},
  };
  if (message.id !== undefined && message.method in responses) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: responses[message.method],
    }) + "\\n");
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      COODE_APP_SERVER_TRANSCRIPT: transcript,
    },
  });
  t.after(() => client.dispose());

  await assert.rejects(
    () => runCodexAppServerTurn("Never finish", {
      workDir: directory,
      client,
      turnTimeoutMs: 75,
    }),
    (error) => error?.code === "codex_turn_timeout"
      && error?.dispatched === true
      && /safety limit/.test(error.message),
  );

  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.find((message) => message.method === "turn/interrupt")?.params,
    {
      threadId: "thread-stuck",
      turnId: "turn-stuck",
    },
  );
});

test("Codex prepares thread-scoped MCP servers and reuses the live thread without resuming", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-prepared-thread-"));
  const executable = join(directory, "codex");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.COODE_APP_SERVER_TRANSCRIPT;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
input.on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  } else if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-prepared" } } }) + "\\n");
    setTimeout(() => notify("mcpServer/startupStatus/updated", {
      threadId: "thread-prepared", name: "test-mcp", status: "starting", error: null,
    }), 5);
    setTimeout(() => notify("mcpServer/startupStatus/updated", {
      threadId: "thread-prepared", name: "test-mcp", status: "ready", error: null,
    }), 25);
  } else if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-prepared" } } }) + "\\n");
    setTimeout(() => notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-prepared",
      turnId: "turn-prepared",
      itemId: "reasoning-prepared",
      delta: "Checking the request",
      summaryIndex: 0,
    }), 2);
    setTimeout(() => {
      notify("item/completed", {
        threadId: "thread-prepared",
        turnId: "turn-prepared",
        item: { type: "agentMessage", id: "answer", text: "Ready.", phase: "final_answer" },
      });
      notify("turn/completed", {
        threadId: "thread-prepared",
        turn: { id: "turn-prepared", status: "completed" },
      });
    }, 5);
  } else if (message.method === "thread/resume") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-prepared" } } }) + "\\n");
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      COODE_APP_SERVER_TRANSCRIPT: transcript,
    },
  });
  t.after(() => client.dispose());

  const prepared = await prepareCodexAppServerThread({
    workDir: directory,
    client,
  });
  assert.equal(prepared.threadId, "thread-prepared");
  assert.ok(prepared.mcpStartupDurationMs >= 700);

  const reasoning = [];
  const result = await runCodexAppServerTurn("Reply when ready", {
    workDir: directory,
    client,
    threadId: prepared.threadId,
    turnTimeoutMs: 2_000,
    environmentOverrides: {
      CO_OD_ROOM_ID: "room-a",
      CO_OD_RUN_ID: "run-one",
      CO_OD_BROWSER_MODE: "none",
      CO_OD_WORKSPACE_CAPABILITY: "short-lived-capability",
      CO_OD_WORKSPACE_RUN_ID: "run-one",
      CO_OD_WORKSPACE_EXPIRES_AT: "2026-08-05T10:00:00.000Z",
    },
    onReasoningSummaryDelta: (text, summary) => reasoning.push([text, summary]),
  });
  assert.equal(result.finalMessage, "Ready.");
  assert.deepEqual(reasoning, [["Checking the request", {
    itemId: "reasoning-prepared",
    summaryIndex: 0,
  }]]);

  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.filter((message) => message.method === "thread/start").length, 1);
  assert.equal(messages.filter((message) => message.method === "thread/resume").length, 0);
  assert.equal(messages.filter((message) => message.method === "turn/start").length, 1);
  assert.equal(
    messages.find((message) => message.method === "turn/start").params.summary,
    "concise",
  );
  assert.equal(
    messages.find((message) => message.method === "thread/start").params.dynamicTools[0].name,
    "coode",
  );
});

test("interactive Codex preparation does not wait for optional MCP startup", async () => {
  let subscribed = false;
  const client = {
    async ensureStarted() {},
    onNotification() {
      subscribed = true;
      return () => {};
    },
    async request(method) {
      assert.equal(method, "thread/start");
      return { thread: { id: "thread-interactive" } };
    },
    markThreadActive() {},
  };

  const prepared = await prepareCodexAppServerThread({
    workDir: "/tmp/coode-interactive-prewarm",
    client,
    waitForMcpStartup: false,
  });

  assert.deepEqual(prepared, {
    threadId: "thread-interactive",
    mcpStartupDurationMs: 0,
  });
  assert.equal(subscribed, false);
});

test("Codex app-server exposes and executes run-scoped co·ode dynamic tools", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-workspace-tools-"));
  const executable = join(directory, "codex");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.COODE_APP_SERVER_TRANSCRIPT;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  appendFileSync(transcript, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  } else if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-tools" } } }) + "\\n");
  } else if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-tools" } } }) + "\\n");
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 700,
      method: "item/tool/call",
      params: {
        threadId: "thread-tools",
        turnId: "turn-tools",
        callId: "call-tools",
        namespace: "coode",
        tool: "create_automation",
        arguments: { title: "Daily review" },
      },
    }) + "\\n"), 10);
  } else if (message.id === 700 && message.result) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-tools",
        turnId: "turn-tools",
        item: { type: "agentMessage", id: "answer", text: "Automation created.", phase: "final_answer" },
      },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-tools", turn: { id: "turn-tools", status: "completed" } },
    }) + "\\n");
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      COODE_APP_SERVER_TRANSCRIPT: transcript,
    },
  });
  t.after(() => client.dispose());
  const calls = [];
  const result = await runCodexAppServerTurn("Create my automation", {
    workDir: directory,
    client,
    turnTimeoutMs: 2_000,
    workspaceAccess: {
      toolPath: "/tmp/coode-workspace-tool.mjs",
      serverURL: "http://127.0.0.1:7331",
      capability: "scoped",
      roomID: "room-a",
      runID: "run-a",
      expiresAt: "2026-08-03T03:00:00.000Z",
      invoke: async (tool, args) => {
        calls.push([tool, args]);
        return { message: "Created Daily review" };
      },
    },
  });

  assert.equal(result.finalMessage, "Automation created.");
  assert.deepEqual(calls, [["create_automation", { title: "Daily review" }]]);
  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const threadStart = messages.find((message) => message.method === "thread/start");
  assert.equal(threadStart.params.dynamicTools[0].name, "coode");
  const toolResponse = messages.find((message) => message.id === 700 && message.result);
  assert.equal(toolResponse.result.success, true);
  assert.deepEqual(JSON.parse(toolResponse.result.contentItems[0].text), {
    message: "Created Daily review",
  });
});

test("Codex app-server scopes Room authority to the thread environment", () => {
  assert.deepEqual(
    codexThreadConfig({
      PATH: "/usr/bin",
      COODE_ROOM_TOKEN: "must-not-cross-provider-boundary",
      CO_OD_ROOM_ID: "room-a",
      CO_OD_BROWSER_CAPABILITY: "browser-capability",
    }),
    {
      shell_environment_policy: {
        inherit: "all",
        set: {
          CO_OD_ROOM_ID: "room-a",
          CO_OD_BROWSER_CAPABILITY: "browser-capability",
        },
      },
    },
  );
  assert.equal(codexThreadConfig({ PATH: "/usr/bin" }), undefined);
});

test("Codex keeps per-turn Room authority out of the persistent thread signature", () => {
  assert.equal(codexPersistentThreadEnvironment({
    CO_OD_ROOM_ID: "room-a",
    CO_OD_RUN_ID: "run-a",
    CO_OD_PROVIDER_SESSION_ID: "thread-a",
    CO_OD_WORKSPACE_CAPABILITY: "short-lived-workspace-capability",
    CO_OD_WORKSPACE_EXPIRES_AT: "2026-08-05T10:00:00.000Z",
    CO_OD_BROWSER_MODE: "none",
  }), undefined);

  assert.deepEqual(codexPersistentThreadEnvironment({
    CO_OD_ROOM_ID: "room-a",
    CO_OD_BROWSER_MODE: "coodeIsolated",
    CO_OD_BROWSER_TOOL: "/tmp/coode-browser-tool",
    CO_OD_BROWSER_CAPABILITY: "short-lived-browser-capability",
    CO_OD_ATTACHMENT_PATHS: "/tmp/brief.md",
  }), {
    CO_OD_BROWSER_MODE: "coodeIsolated",
    CO_OD_BROWSER_TOOL: "/tmp/coode-browser-tool",
    CO_OD_BROWSER_CAPABILITY: "short-lived-browser-capability",
    CO_OD_ATTACHMENT_PATHS: "/tmp/brief.md",
  });
});

test("translateAppServerItem maps app-server items to exec event shapes", () => {
  assert.deepEqual(
    translateAppServerItem({
      type: "agentMessage",
      id: "i1",
      text: "hi",
      phase: "commentary",
    }),
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "hi",
        phase: "commentary",
      },
    },
  );
  assert.deepEqual(
    translateAppServerItem({
      type: "commandExecution",
      id: "i2",
      command: "ls",
      exitCode: 0,
      aggregatedOutput: "README.md\n",
    }),
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "ls",
        exit_code: 0,
        aggregated_output: "README.md\n",
      },
    },
  );
  assert.deepEqual(
    translateAppServerItem({ type: "fileChange", id: "i3", changes: [{ path: "a.ts" }] }),
    { type: "item.completed", item: { type: "file_change", path: "a.ts" } },
  );
  assert.deepEqual(
    translateAppServerItem({
      type: "mcpToolCall",
      id: "i-tool",
      server: "pathmark",
      tool: "recall_memory",
      status: "completed",
      arguments: { query: "prior decisions" },
      result: {
        content: [{ type: "text", text: "{\"usedMemories\":[]}" }],
        structuredContent: { usedMemories: [] },
        _meta: null,
      },
      error: null,
      durationMs: 4_200,
    }),
    {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        id: "i-tool",
        server: "pathmark",
        tool: "recall_memory",
        arguments: { query: "prior decisions" },
        result: {
          content: [{ type: "text", text: "{\"usedMemories\":[]}" }],
          structuredContent: { usedMemories: [] },
          _meta: null,
        },
        error: null,
        status: "completed",
        duration_ms: 4_200,
        appContext: undefined,
        mcpAppResourceUri: undefined,
        pluginId: undefined,
        artifact_deferred: true,
      },
    },
  );
  assert.deepEqual(
    translateAppServerItem({
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "agent-root",
      receiverThreadIds: ["agent-child"],
      prompt: "Audit multiplayer presence",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentsStates: {
        "agent-child": { status: "running", message: null },
      },
    }),
    {
      type: "item.completed",
      item: {
        type: "collab_agent_tool_call",
        id: "collab-1",
        tool: "spawnAgent",
        prompt: "Audit multiplayer presence",
        status: "completed",
        sender_thread_id: "agent-root",
        receiver_thread_ids: ["agent-child"],
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        agents_states: {
          "agent-child": { status: "running", message: null },
        },
      },
    },
  );
  assert.deepEqual(
    translateAppServerItem({
      type: "subAgentActivity",
      id: "call-subagent",
      kind: "started",
      agentThreadId: "agent-repo-scout",
      agentPath: "/root/repo_scout",
    }),
    {
      type: "item.completed",
      item: {
        type: "subagent_activity",
        id: "call-subagent",
        kind: "started",
        agent_thread_id: "agent-repo-scout",
        agent_path: "/root/repo_scout",
      },
    },
  );
  assert.equal(translateAppServerItem({ type: "userMessage", id: "i4" }), null);
  assert.equal(translateAppServerItem({}), null);
});

test("translateAppServerItem preserves app-server lifecycle phases", () => {
  assert.deepEqual(
    translateAppServerItem({
      type: "commandExecution",
      id: "i2",
      command: "pwd",
      exitCode: null,
      aggregatedOutput: null,
    }, "started"),
    {
      type: "item.started",
      item: {
        type: "command_execution",
        command: "pwd",
        exit_code: null,
      },
    },
  );
});

test("translateAppServerItem keeps reasoning only when there is a summary", () => {
  assert.equal(translateAppServerItem({ type: "reasoning", summary: [], content: [] }), null);
  assert.deepEqual(
    translateAppServerItem({ type: "reasoning", summary: ["thinking"], content: [] }),
    { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
  );
});

test("agent-message item changes create prose boundaries in the streamed transcript", () => {
  assert.equal(
    separateAppServerMessageDelta("First", "commentary-1", undefined, false),
    "First",
  );
  assert.equal(
    separateAppServerMessageDelta(" continues", "commentary-1", "commentary-1", true),
    " continues",
  );
  assert.equal(
    separateAppServerMessageDelta("Final answer", "final-1", "commentary-1", true),
    "\n\nFinal answer",
  );
  assert.equal(
    separateAppServerMessageDelta("", "final-1", "commentary-1", true),
    "",
  );
});

// /dismiss lives here to avoid a new test file — reducer-level behavior.

test("account usage limits are read and clamped for display", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-usage-"));
  const executable = join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const lines = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lines.push(chunk);
  const joined = lines.join("");
  for (const line of joined.split("\\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    } else if (message.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 77.4, windowDurationMins: 10080, resetsAt: 1786162729 },
            secondary: { usedPercent: 142 },
            credits: { hasCredits: true },
            planType: "pro",
          },
        },
      }) + "\\n");
    }
  }
  lines.length = 0;
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: { ...process.env, PATH: `${directory}:${process.env.PATH || ""}` },
  });
  t.after(() => client.dispose());

  const limits = await readCodexUsageLimits(client);
  assert.equal(limits?.planType, "pro");
  // Rounded for display, and clamped so a stale value cannot render an
  // overfull ring.
  assert.equal(limits?.primary?.usedPercent, 77);
  assert.equal(limits?.primary?.windowDurationMins, 10080);
  assert.equal(limits?.secondary?.usedPercent, 100);
  // Windows are named by their length, so the label stays true for any
  // provider rather than hardcoding one vendor's wording.
  assert.equal(harnessUsageWindowLabel(limits?.primary), "7d");
  assert.equal(harnessUsageWindowLabel({ usedPercent: 0, windowDurationMins: 300 }), "5h");
  assert.equal(harnessUsageWindowLabel({ usedPercent: 0 }), undefined);
});

test("a provider that cannot report limits simply reports none", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-usage-missing-"));
  const executable = join(directory, "codex");
  // An older CLI, or a signed-out account, answers with an error. A missing
  // limit must not surface as a failure or a fabricated zero.
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      }) + "\\n");
    }
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: { ...process.env, PATH: `${directory}:${process.env.PATH || ""}` },
  });
  t.after(() => client.dispose());

  assert.equal(await readCodexUsageLimits(client), undefined);
});

test("provider models are read live, skipping hidden entries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-models-"));
  const executable = join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    } else if (message.method === "model/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { data: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
              { reasoningEffort: "ultra" },
            ],
            defaultReasoningEffort: "low",
          },
          { id: "internal-preview", displayName: "Internal", hidden: true },
          { id: "bare-model" },
        ] },
      }) + "\\n");
    }
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: { ...process.env, PATH: `${directory}:${process.env.PATH || ""}` },
  });
  t.after(() => client.dispose());

  const models = await readCodexModels(client);
  // A hidden model is one the provider does not want offered.
  assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-sol", "bare-model"]);
  assert.equal(models[0].displayName, "GPT-5.6-Sol");
  // Efforts come from the provider, including ones no hardcoded list knows.
  assert.deepEqual(models[0].supportedEfforts, ["low", "high", "ultra"]);
  assert.equal(models[0].defaultEffort, "low");
  // A model without a display name still lists, named by its identifier.
  assert.equal(models[1].displayName, "bare-model");
});

test("a provider that cannot list models yields no override", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-models-none-"));
  const executable = join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "method not found" },
      }) + "\\n");
    }
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const client = new CodexAppServerClient({
    environment: { ...process.env, PATH: `${directory}:${process.env.PATH || ""}` },
  });
  t.after(() => client.dispose());

  // undefined, not [], so callers keep their built-in list instead of
  // rendering an empty picker.
  assert.equal(await readCodexModels(client), undefined);
});
