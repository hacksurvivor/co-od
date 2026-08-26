import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  AntigravityAdapter,
  antigravitySupportsStructuredOutput,
  buildAntigravityArgs,
  parseAntigravityStructuredLine,
} from "../dist/adapters/antigravity.js";
import {
  ClaudeAdapter,
  buildClaudeArgs,
  buildClaudePersistentArgs,
  claudeBackgroundAgents,
  claudeSubagentActivities,
  claudeTextDelta,
  parseClaudePrintOutput,
  readClaudeUsageLimits,
  recordClaudeRateLimitEvent,
  resetClaudeUsageLimits,
  disposeClaudePersistentSessions,
} from "../dist/adapters/claude.js";
import {
  CodexAdapter,
  buildCodexArgs,
  codexActivitiesFromEvent,
  codexCompletedSubagentActivities,
  codexArtifactActivityFromItem,
  codexActivityFromEvent,
  codexMcpAppResourceURI,
  codexReasoningSummaryActivity,
  codexDisplayStdout,
} from "../dist/adapters/codex.js";
import {
  buildCustomHarnessArgs,
  customHarnessManifestPayload,
  verifyCustomHarnessAttestation,
} from "../dist/adapters/custom.js";
import { buildOpenCodeArgs } from "../dist/adapters/opencode.js";
import { openCodeNativeSessionState } from "../dist/adapters/opencode-server.js";
import { buildGeminiArgs, GeminiAdapter, parseGeminiStreamOutput } from "../dist/adapters/gemini.js";
import { buildGrokArgs, grokTextDelta, parseGrokPrintOutput } from "../dist/adapters/grok.js";
import { buildHermesArgs } from "../dist/adapters/hermes.js";
import {
  acpAuthorityTarget,
  acpNativeSessionMode,
  acpPermissionDecision,
  acpPermissionScope,
  executeAcpAgent,
} from "../dist/adapters/acp.js";
import { buildOpenClawAcpArgs } from "../dist/adapters/openclaw.js";
import {
  buildPiRpcArgs,
  PiAdapter,
  piExtensionPermissionRequest,
  piExtensionResponse,
} from "../dist/adapters/pi.js";
import { buildZeroClawAcpArgs } from "../dist/adapters/zeroclaw.js";
import { getAdapter, getHarnessCapabilities } from "../dist/adapters/index.js";
import { harnessArtifactsFromToolResult } from "../dist/adapters/harness-artifacts.js";
import {
  HARNESS_CONTRACT_VERSION,
  PROVIDER_BROWSER_PARITY_FEATURES,
  browserModeForExecution,
  declaredHarnessCapabilityReceipt,
  harnessCapabilities,
  promptWithBrowserAccess,
  providerBrowserParityProof,
  providerProcessEnvironment,
  withDeclaredHarnessCapabilityReceipt,
} from "../dist/adapters/base.js";

const attachments = [
  { path: "src", absolutePath: "/tmp/project/src", kind: "directory", exists: true },
  { path: "README.md", absolutePath: "/tmp/project/README.md", kind: "file", exists: true },
  { path: "screen.png", absolutePath: "/tmp/project/screen.png", kind: "image", exists: true },
  { path: "missing.png", absolutePath: "/tmp/project/missing.png", kind: "image", exists: false },
];

const browserAccess = {
  toolPath: "/private/coode-browser",
  artifactDirectory: "/private/browser-artifacts",
  serverURL: "https://relay.example.test",
  capability: "scoped-browser-capability",
  roomID: "room-safe",
  contextID: "context-safe",
  expiresAt: "2026-07-22T12:00:00.000Z",
};

const acpFixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const piRpcFixture = fileURLToPath(new URL("./fixtures/pi-rpc-agent.mjs", import.meta.url));

test("channel-capable ACP harnesses elevate outbound actions to explicit external grants", () => {
  const outbound = {
    name: "send_message",
    kind: "execute",
    title: "Send to Telegram channel",
    rawInput: { channel: "release-updates", text: "Ship it" },
  };
  assert.equal(acpPermissionScope("openclaw", outbound), "externalAction");
  assert.equal(acpPermissionScope("hermes", outbound), "externalAction");
  assert.equal(acpPermissionScope("zeroclaw", outbound), "externalAction");
  assert.deepEqual(acpAuthorityTarget("openclaw", outbound), {
    kind: "recipient",
    operation: "send_message",
    channel: "release-updates",
  });
  const hardware = {
    name: "gpio_write",
    kind: "execute",
    title: "Set GPIO pin",
    rawInput: { device: "raspberry-pi", pin: 17, value: true },
  };
  assert.equal(acpPermissionScope("zeroclaw", hardware), "externalAction");
  assert.deepEqual(acpAuthorityTarget("zeroclaw", hardware), {
    kind: "hardware",
    operation: "gpio_write",
    hardware: "raspberry-pi",
  });
  assert.equal(acpPermissionScope("opencode", outbound), "workspace");
  assert.equal(acpPermissionScope("openclaw", {
    name: "read_file",
    kind: "read",
    title: "Read package.json",
    rawInput: { path: "package.json" },
  }), "workspace");
});

test("non-negotiating adapters publish a versioned declared capability receipt", () => {
  const capabilities = harnessCapabilities({
    transport: {
      kind: "jsonl",
      capabilityNegotiation: false,
      structuredEvents: true,
    },
    sessionResume: true,
    attachments: true,
    usageReporting: true,
    approvalBridge: true,
  });
  const receipt = declaredHarnessCapabilityReceipt(
    "fixture-jsonl",
    capabilities,
    "2026-08-15T00:00:00.000Z",
  );
  assert.deepEqual(receipt, {
    contractVersion: HARNESS_CONTRACT_VERSION,
    harness: "fixture-jsonl",
    transport: "jsonl",
    agentName: "fixture-jsonl",
    observedAt: "2026-08-15T00:00:00.000Z",
    source: "declared",
    capabilities: {
      sessionLoad: false,
      sessionList: false,
      sessionDelete: false,
      sessionResume: true,
      sessionFork: false,
      sessionClose: false,
      attachments: true,
      modelDiscovery: false,
      providerDiscovery: false,
      planReporting: false,
      usageReporting: true,
      approvalBridge: true,
    },
  });

  const published = [];
  const result = withDeclaredHarnessCapabilityReceipt(
    { exitCode: 0, stdout: "done", stderr: "" },
    "fixture-jsonl",
    capabilities,
    { onCapabilityReceipt: (value) => published.push(value) },
  );
  assert.equal(published.length, 1);
  assert.equal(result.capabilityReceipt.source, "declared");
});

test("ACP permission policy fails closed unless the run explicitly grants authority", () => {
  const request = {
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  };
  assert.deepEqual(acpPermissionDecision(request, "ask"), { outcome: "cancelled" });
  assert.deepEqual(acpPermissionDecision(request, "custom"), { outcome: "cancelled" });
  assert.deepEqual(acpPermissionDecision(request, "approve"), {
    outcome: "selected",
    optionID: "allow-once",
  });
  assert.deepEqual(acpPermissionDecision(request, "fullAccess"), {
    outcome: "selected",
    optionID: "allow-always",
  });
  assert.deepEqual(acpPermissionDecision(request, "plan"), {
    outcome: "selected",
    optionID: "reject-once",
  });
});

test("shared ACP transport negotiates, streams structured activity, and returns a receipt", async () => {
  const text = [];
  const activity = [];
  const permissions = [];
  const receipts = [];
  const result = await executeAcpAgent(
    { executable: process.execPath, args: [acpFixture], harness: "fixture" },
    "Prove ACP",
    {
      workDir: process.cwd(),
      model: "Fixture Large",
      effort: "high",
      permissionMode: "ask",
      onTextDelta: (chunk, message) => text.push({ chunk, message }),
      onActivity: (update) => activity.push(update),
      onCapabilityReceipt: (receipt) => receipts.push(receipt),
      onPermissionRequest: (request) => {
        permissions.push(request);
        return { outcome: "selected", optionID: "allow-once" };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ACP ready");
  assert.equal(result.stderr, "");
  assert.equal(result.providerSessionId, "acp-session-new");
  assert.equal(text[0].message.messageID, "message-1");
  assert.equal(permissions.length, 1);
  assert.match(permissions[0].input, /\[redacted\]/);
  assert.doesNotMatch(permissions[0].input, /must-redact/);
  assert.ok(activity.some((update) => update.kind === "plan" && update.title === "Updated plan"));
  assert.ok(activity.some((update) => update.kind === "read" && update.phase === "completed"));
  assert.equal(receipts.length, 1);
  assert.equal(result.capabilityReceipt.protocolVersion, 1);
  assert.equal(result.capabilityReceipt.agentName, "co-ode-acp-fixture");
  assert.equal(result.capabilityReceipt.capabilities.sessionFork, true);
  assert.equal(result.capabilityReceipt.capabilities.sessionResume, true);
  assert.equal(result.capabilityReceipt.capabilities.planReporting, true);
  assert.equal(result.capabilityReceipt.capabilities.usageReporting, true);
});

test("OpenClaw and ZeroClaw are separate ACP adapters", () => {
  assert.equal(getAdapter("openclaw").name, "openclaw");
  assert.equal(getAdapter("zeroclaw").name, "zeroclaw");
  assert.deepEqual(buildOpenClawAcpArgs(), ["acp"]);
  assert.deepEqual(buildZeroClawAcpArgs(), ["acp"]);
});

test("Pi RPC arguments preserve sessions and fail closed without a tool approval bridge", () => {
  assert.deepEqual(buildPiRpcArgs(), ["--mode", "rpc", "--no-tools"]);
  assert.deepEqual(buildPiRpcArgs({
    model: "openai/gpt-5.6",
    effort: "high",
    permissionMode: "approve",
    providerSession: { mode: "continue", sourceRunId: "run-a", providerSessionId: "pi-session-a" },
  }), [
    "--mode", "rpc",
    "--model", "openai/gpt-5.6",
    "--thinking", "high",
    "--session", "pi-session-a",
  ]);
  assert.deepEqual(buildPiRpcArgs({
    permissionMode: "plan",
    providerSession: { mode: "fork", sourceRunId: "run-a", providerSessionId: "pi-session-a" },
  }), ["--mode", "rpc", "--fork", "pi-session-a", "--no-tools"]);
});

test("Pi extension dialogs map to typed approvals and exact RPC responses", () => {
  const event = {
    type: "extension_ui_request",
    id: "request-1",
    method: "select",
    title: "Choose deployment",
    options: ["Preview", "Production"],
  };
  const request = piExtensionPermissionRequest(event, "session-1");
  assert.equal(request.scope, "workspace");
  assert.deepEqual(request.options.map(({ id, name }) => ({ id, name })), [
    { id: "select:0", name: "Preview" },
    { id: "select:1", name: "Production" },
    { id: "cancel", name: "Cancel" },
  ]);
  assert.deepEqual(piExtensionResponse(event, {
    outcome: "selected",
    optionID: "select:1",
  }), {
    type: "extension_ui_response",
    id: "request-1",
    value: "Production",
  });
  assert.deepEqual(piExtensionResponse({ ...event, method: "input" }, {
    outcome: "selected",
    optionID: "submit",
    content: { value: "typed value" },
  }), {
    type: "extension_ui_response",
    id: "request-1",
    value: "typed value",
  });
});

test("PiAdapter streams strict JSONL activity, usage, identity, and native session state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coode-pi-adapter-"));
  const executable = join(directory, "pi");
  const argumentsPath = join(directory, "args.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_PI_ARGS_PATH"
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(piRpcFixture)}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousArgumentsPath = process.env.TEST_PI_ARGS_PATH;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_PI_ARGS_PATH = argumentsPath;
  try {
    const text = [];
    const activity = [];
    const receipts = [];
    const runtimeControls = [];
    const steering = [];
    const result = await new PiAdapter().execute("Inspect Pi", {
      workDir: directory,
      permissionMode: "plan",
      onTextDelta: (chunk) => text.push(chunk),
      onActivity: (update) => activity.push(update),
      onCapabilityReceipt: (receipt) => receipts.push(receipt),
      onPermissionRequest: (request) => {
        assert.equal(request.tool, "pi.extension.confirm");
        return { outcome: "selected", optionID: "confirm" };
      },
      onRuntimeControl: (control) => {
        runtimeControls.push(control);
        if (control?.steer) steering.push(control.steer("Focus on the fixture"));
      },
    });
    await Promise.all(steering);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "Pi\u2028ready");
    assert.equal(text.join(""), "Pi\u2028ready");
    assert.equal(result.providerSessionId, "pi-session-fixture");
    assert.equal(result.capabilityReceipt.transport, "jsonl");
    assert.equal(result.capabilityReceipt.source, "declared");
    assert.equal(result.capabilityReceipt.capabilities.approvalBridge, true);
    assert.equal(receipts.length, 1);
    assert.ok(runtimeControls.some((control) => control?.harness === "pi" && control.steer));
    assert.equal(runtimeControls.at(-1), undefined);
    assert.ok(activity.some((update) => update.title === "Used read" && update.output === "fixture content"));
    assert.ok(activity.some((update) => update.title === "Discovered Pi extensions and skills"));
    const usage = activity.find((update) => update.title === "Recorded Pi usage");
    assert.match(usage.output, /\[redacted\]/);
    assert.doesNotMatch(usage.output, /must-redact/);
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "--mode", "rpc", "--no-tools",
    ]);
  } finally {
    process.env.PATH = previousPath;
    process.env.TEST_PI_ARGS_PATH = previousArgumentsPath;
    await rm(directory, { recursive: true, force: true });
  }
});

const providerParity = (provider, verifiedAt = new Date().toISOString()) => {
  const declaration = {
    seatID: "seat-safe",
    provider,
    adapterVersion: "provider-test-1",
    protocolVersion: 1,
    features: [...PROVIDER_BROWSER_PARITY_FEATURES],
  };
  return {
    ...declaration,
    proofHash: providerBrowserParityProof(declaration),
    verifiedAt,
  };
};

test("Codex native events become truthful live activity instead of placeholder steps", () => {
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.started",
      item: { type: "command_execution", command: "swift test --filter BillingTests" },
    }),
    {
      kind: "tests",
      phase: "started",
      title: "Running checks",
      detail: "swift test --filter BillingTests",
      tool: "shell",
      codeLanguage: "shell",
    },
  );
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "git status --short",
        aggregated_output: "## main\n M app.swift\n",
        exit_code: 0,
      },
    }),
    {
      kind: "command",
      phase: "completed",
      title: "Ran a command",
      detail: "git status --short",
      tool: "shell",
      codeLanguage: "shell",
      output: "## main\n M app.swift",
      result: "Completed",
    },
  );
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.completed",
      item: { type: "image_view", path: "/tmp/agent-screen.png" },
    }),
    {
      kind: "image",
      phase: "completed",
      title: "Viewed an image",
      detail: "/tmp/agent-screen.png",
      tool: "image_view",
      input: "/tmp/agent-screen.png",
      codeLanguage: "text",
      imagePaths: ["/tmp/agent-screen.png"],
      result: "Completed",
    },
  );
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.completed",
      item: { type: "file_change", path: "Sources/BillingRoute.swift" },
    }),
    {
      kind: "file",
      phase: "completed",
      title: "Edited Sources/BillingRoute.swift",
      detail: "Sources/BillingRoute.swift",
      tool: "file_change",
      input: "Sources/BillingRoute.swift",
      codeLanguage: "text",
    },
  );
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.started",
      item: { type: "web_search", query: "SwiftUI shimmer text" },
    }),
    {
      kind: "search",
      phase: "started",
      title: "Searching the web",
      detail: "SwiftUI shimmer text",
      tool: "web_search",
      input: `{
  "query": "SwiftUI shimmer text"
}`,
      codeLanguage: "json",
    },
  );
  assert.equal(
    codexActivityFromEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "Done" },
    }),
    undefined,
  );
  assert.deepEqual(
    codexActivityFromEvent({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "pathmark",
        tool: "recall_memory",
        arguments: {
          query: "prior decisions",
          accessToken: "must-not-persist",
        },
        result: { structuredContent: { usedMemories: [{ id: "memory-one" }] } },
        status: "completed",
        duration_ms: 4_200,
      },
    }),
    {
      kind: "tool",
      phase: "completed",
      title: "Used recall_memory",
      detail: "pathmark · recall_memory",
      tool: "pathmark.recall_memory",
      input: `{
  "query": "prior decisions",
  "accessToken": "[redacted]"
}`,
      codeLanguage: "json",
      output: `{
  "structuredContent": {
    "usedMemories": [
      {
        "id": "memory-one"
      }
    ]
  }
}`,
      durationMs: 4_200,
      result: "Completed",
    },
  );
});

test("Codex collaboration events preserve every delegated agent lifecycle", () => {
  const labels = new Map();
  assert.deepEqual(
    codexActivitiesFromEvent({
      type: "item.completed",
      item: {
        type: "collab_agent_tool_call",
        tool: "spawnAgent",
        status: "completed",
        sender_thread_id: "agent-root",
        receiver_thread_ids: ["agent-a", "agent-b"],
        prompt: "Trace the Room session pool tests",
        agents_states: {
          "agent-a": { status: "running", message: null },
          "agent-b": { status: "pendingInit", message: null },
        },
      },
    },
    labels,
  ),
  [
    {
      kind: "tool",
      phase: "started",
      title: "Started Trace the Room session pool tests",
      detail: "Codex subagent",
      tool: "collaboration.spawnAgent",
      input: "Trace the Room session pool tests",
      codeLanguage: "text",
      result: "Working",
      agentID: "agent-a",
      parentAgentID: "agent-root",
      agentName: "Codex subagent",
      agentTask: "Trace the Room session pool tests",
      agentStatus: "working",
      agentProgress: "Working",
    },
    {
      kind: "tool",
      phase: "started",
      title: "Started Trace the Room session pool tests",
      detail: "Codex subagent",
      tool: "collaboration.spawnAgent",
      input: "Trace the Room session pool tests",
      codeLanguage: "text",
      result: "Working",
      agentID: "agent-b",
      parentAgentID: "agent-root",
      agentName: "Codex subagent",
      agentTask: "Trace the Room session pool tests",
      agentStatus: "working",
      agentProgress: "Working",
    },
  ]);

  assert.deepEqual(
    codexActivitiesFromEvent({
      type: "item.completed",
      item: {
        type: "collab_agent_tool_call",
        tool: "wait",
        status: "completed",
        sender_thread_id: "agent-root",
        receiver_thread_ids: ["agent-a", "agent-b"],
        agents_states: {
          "agent-a": { status: "completed", message: "Found the regression test location." },
          "agent-b": { status: "errored", message: "Test discovery failed." },
        },
      },
    },
    labels,
  ),
  [
    {
      kind: "tool",
      phase: "completed",
      title: "Completed Trace the Room session pool tests",
      detail: "Codex subagent",
      tool: "collaboration.wait",
      output: "Found the regression test location.",
      result: "Completed",
      agentID: "agent-a",
      parentAgentID: "agent-root",
      agentName: "Codex subagent",
      agentTask: "Trace the Room session pool tests",
      agentStatus: "completed",
      agentProgress: "Found the regression test location.",
    },
    {
      kind: "tool",
      phase: "completed",
      title: "Failed Trace the Room session pool tests",
      detail: "Codex subagent",
      tool: "collaboration.wait",
      output: "Test discovery failed.",
      result: "Failed",
      agentID: "agent-b",
      parentAgentID: "agent-root",
      agentName: "Codex subagent",
      agentTask: "Trace the Room session pool tests",
      agentStatus: "failed",
      agentProgress: "Test discovery failed.",
    },
  ]);
  assert.equal(labels.size, 0);
});

test("Codex subAgentActivity drives the native row when wait has no receivers", () => {
  const labels = new Map();
  assert.deepEqual(
    codexActivitiesFromEvent({
      type: "item.completed",
      item: {
        type: "subagent_activity",
        id: "call-subagent",
        kind: "started",
        agent_thread_id: "agent-repo-scout",
        agent_path: "/root/repo_scout",
      },
    }, labels),
    [{
      kind: "tool",
      phase: "started",
      title: "Started Repo scout",
      detail: "Codex subagent",
      tool: "collaboration.subAgent",
      result: "Working",
      agentID: "agent-repo-scout",
      agentName: "Repo scout",
      agentTask: "Repo scout",
      agentStatus: "working",
      agentProgress: "Starting",
    }],
  );

  assert.deepEqual(
    codexActivitiesFromEvent({
      type: "item.completed",
      item: {
        type: "collab_agent_tool_call",
        tool: "wait",
        status: "completed",
        sender_thread_id: "agent-root",
        receiver_thread_ids: [],
        agents_states: {},
      },
    }, labels),
    [],
  );

  assert.deepEqual(codexCompletedSubagentActivities(labels), [{
    kind: "tool",
    phase: "completed",
    title: "Completed Repo scout",
    detail: "Codex subagent",
    tool: "collaboration.subAgent",
    result: "Completed",
    agentID: "agent-repo-scout",
    agentName: "Repo scout",
    agentTask: "Repo scout",
    agentStatus: "completed",
    agentProgress: "Finished",
  }]);
  assert.equal(labels.size, 0);
});

test("Codex native reasoning summaries become concise live progress", () => {
  assert.equal(codexReasoningSummaryActivity("Thinking"), undefined);
  assert.deepEqual(
    codexReasoningSummaryActivity("Checking the selected project before replying."),
    {
      kind: "plan",
      phase: "started",
      title: "Checking the selected project before replying.",
      tool: "reasoning_summary",
    },
  );
});

test("Codex hydrates MCP App resources into bounded host artifacts", async () => {
  const item = {
    type: "mcpToolCall",
    id: "call-artifact",
    server: "scratchpad",
    tool: "open_html",
    status: "completed",
    appContext: {
      connectorId: "scratchpad",
      resourceUri: "ui://scratchpad/html-artifact.html",
      appName: "Scratchpad HTML",
    },
    result: {
      content: [{ type: "text", text: "Artifact ready" }],
      structuredContent: { artifact: { title: "Allocation round" } },
      _meta: {
        artifact: { title: "Allocation round", html: "<main>private body</main>" },
        accessToken: "must-not-cross-room-boundary",
      },
    },
  };
  let request;
  const activity = await codexArtifactActivityFromItem(item, "thread-one", {
    async request(method, params) {
      request = { method, params };
      return {
        contents: [{
          uri: "ui://scratchpad/html-artifact.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><title>Scratchpad HTML</title><main>viewer</main>",
        }],
      };
    },
  });

  assert.equal(codexMcpAppResourceURI(item), "ui://scratchpad/html-artifact.html");
  assert.deepEqual(request, {
    method: "mcpServer/resource/read",
    params: {
      threadId: "thread-one",
      server: "scratchpad",
      uri: "ui://scratchpad/html-artifact.html",
      originCallId: "call-artifact",
      connectorId: "scratchpad",
    },
  });
  assert.equal(activity.kind, "artifact");
  assert.equal(activity.artifacts[0].kind, "mcpApp");
  assert.equal(activity.artifacts[0].mediaType, "text/html;profile=mcp-app");
  assert.match(activity.artifacts[0].content, /viewer/);
  assert.match(activity.artifacts[0].context, /Allocation round/);
  assert.doesNotMatch(activity.artifacts[0].context, /must-not-cross-room-boundary/);
});

test("Codex preserves embedded MCP media when resource hydration is unavailable", () => {
  const activity = codexActivityFromEvent({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "media",
      tool: "show_result",
      result: {
        content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      },
    },
  });
  assert.equal(activity.artifacts.length, 1);
  assert.equal(activity.artifacts[0].kind, "image");
  assert.equal(activity.artifacts[0].encoding, "base64");
});

test("shared artifact extraction is provider-neutral for ACP harnesses", () => {
  for (const provider of ["claude", "gemini", "grok", "opencode", "hermes", "openclaw", "zeroclaw", "pi"]) {
    const artifacts = harnessArtifactsFromToolResult({
      content: [{
        type: "resource",
        resource: {
          uri: `ui://${provider}/result.html`,
          mimeType: "text/html;profile=mcp-app",
          text: `<main>${provider}</main>`,
        },
      }],
    }, {
      provider,
      server: "fixture",
      tool: "show_result",
      title: `${provider} result`,
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].provider, provider);
    assert.equal(artifacts[0].kind, "mcpApp");
    assert.equal(artifacts[0].interactive, true);
    assert.match(artifacts[0].content, new RegExp(provider));
  }
});

test("shared artifact extraction recognizes standard MCP App metadata", () => {
  const artifacts = harnessArtifactsFromToolResult({
    _meta: { ui: { resourceUri: "ui://portable/dashboard.html" } },
    content: [{
      type: "resource_link",
      uri: "ui://portable/dashboard.html",
      name: "Portable dashboard",
      mimeType: "text/html;profile=mcp-app",
    }],
  }, {
    provider: "claude",
    server: "portable",
    tool: "open_dashboard",
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "mcpApp");
  assert.equal(artifacts[0].uri, "ui://portable/dashboard.html");
  assert.equal(artifacts[0].interactive, true);
});

test("custom harness templates receive prompt, model, effort, and goal without a shell", () => {
  const definition = {
    id: "pi",
    name: "Pi",
    executable: "pi",
    arguments: ["run", "--model", "{model}", "--effort={effort}", "--goal", "{goal}", "{prompt}"],
  };
  assert.deepEqual(
    buildCustomHarnessArgs(definition, "Fix the issue", {
      model: "pi-pro",
      effort: "high",
      activeGoal: "Ship the fix",
    }),
    ["run", "--model", "pi-pro", "--effort=high", "--goal", "Ship the fix", "Fix the issue"],
  );
  assert.deepEqual(
    buildCustomHarnessArgs({ ...definition, arguments: ["run"] }, "Fix the issue"),
    ["run", "Fix the issue"],
  );
});

test("custom harness conformance manifests pin the signer, executable, version, and launch definition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-custom-attestation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "agent");
  await writeFile(executable, "#!/bin/sh\nprintf 'agent 1.0.0\\n'\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const definition = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Attested Agent",
    executable,
    arguments: ["{prompt}"],
    versionArguments: ["--version"],
  };
  const manifest = {
    schemaVersion: 1,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    signerPublicKey: rawPublicKey,
    signature: "",
    executableSHA256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    versionOutputSHA256: createHash("sha256").update("agent 1.0.0").digest("hex"),
    capabilities: { sessionResume: true, attachments: true },
  };
  const signedDefinition = { ...definition, conformanceManifest: manifest };
  manifest.signature = sign(
    null,
    Buffer.from(customHarnessManifestPayload(signedDefinition, manifest)),
    privateKey,
  ).toString("base64");

  const verified = verifyCustomHarnessAttestation(signedDefinition, [rawPublicKey]);
  assert.equal(verified.verified, true);
  assert.equal(verified.versionOutput, "agent 1.0.0");
  assert.match(
    verifyCustomHarnessAttestation(signedDefinition, []).reason,
    /not pinned/i,
  );

  await writeFile(executable, "#!/bin/sh\nprintf 'tampered\\n'\n", { mode: 0o700 });
  assert.match(
    verifyCustomHarnessAttestation(signedDefinition, [rawPublicKey]).reason,
    /no longer matches/i,
  );
});

test("Hermes uses its quiet one-shot interface and optional configured model", () => {
  assert.deepEqual(buildHermesArgs("Fix the issue"), ["-z", "Fix the issue"]);
  assert.deepEqual(
    buildHermesArgs("Fix the issue", { model: "anthropic/claude-sonnet-4.6" }),
    ["-z", "Fix the issue", "--model", "anthropic/claude-sonnet-4.6"],
  );
  assert.equal(getAdapter("hermes").name, "hermes");
  assert.equal(getHarnessCapabilities("hermes").streamingOutput, true);
});

test("provider processes retain provider auth but never inherit relay authority or host browser policy", () => {
  const environment = providerProcessEnvironment({
    roomId: "room-safe",
    runId: "run-safe",
    providerSession: {
      mode: "continue",
      sourceRunId: "run-source",
      providerSessionId: "provider-session",
    },
    browserAccess,
  }, {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "provider-secret",
    ANTHROPIC_API_KEY: "provider-secret-two",
    COODE_ROOM_TOKEN: "must-not-leak",
    COODE_BROWSER_PROJECT_ORIGINS: "https://host-policy.invalid",
    COODE_SEAT_ID: "host-seat",
    CO_OD_BROWSER_CAPABILITY: "stale-capability",
  });

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.OPENAI_API_KEY, "provider-secret");
  assert.equal(environment.ANTHROPIC_API_KEY, "provider-secret-two");
  assert.equal(environment.COODE_ROOM_TOKEN, undefined);
  assert.equal(environment.COODE_BROWSER_PROJECT_ORIGINS, undefined);
  assert.equal(environment.COODE_SEAT_ID, undefined);
  assert.equal(environment.CO_OD_ROOM_ID, "room-safe");
  assert.equal(environment.CO_OD_RUN_ID, "run-safe");
  assert.equal(environment.CO_OD_PROVIDER_SESSION_ID, "provider-session");
  assert.equal(environment.CO_OD_BROWSER_TOOL, "/private/coode-browser");
  assert.equal(environment.CO_OD_BROWSER_ARTIFACT_DIRECTORY, "/private/browser-artifacts");
  assert.equal(environment.CO_OD_BROWSER_SERVER_URL, "https://relay.example.test");
  assert.equal(environment.CO_OD_BROWSER_CAPABILITY, "scoped-browser-capability");
  assert.equal(environment.CO_OD_BROWSER_ROOM_ID, "room-safe");
  assert.equal(environment.CO_OD_BROWSER_CONTEXT_ID, "context-safe");
  assert.equal(environment.CO_OD_BROWSER_EXPIRES_AT, "2026-07-22T12:00:00.000Z");
});

test("browser prompt contract is opt-in, semantic, and never embeds authority", () => {
  assert.equal(promptWithBrowserAccess("Inspect the app"), "Inspect the app");
  const prompt = promptWithBrowserAccess("Inspect the app", browserAccess);
  assert.match(prompt, /use only co-ode's isolated browser/i);
  assert.match(prompt, /\$CO_OD_BROWSER_TOOL/);
  assert.match(prompt, /setViewport, navigate, assertVisible, assertText, click, fill, screenshot/);
  assert.match(prompt, /"width":390,"height":844/);
  assert.match(prompt, /semantic targets only/);
  assert.match(prompt, /"by":"role"/);
  assert.match(prompt, /"expected":"Example Domain"/);
  assert.match(prompt, /assertText also requires an `expected` string/);
  assert.match(prompt, /status live region normally uses .*"role":"status".* without a name/);
  assert.match(prompt, /absolute URL and semantic label.*authoritative/i);
  assert.match(prompt, /No CO_OD_\* environment variable contains a project preview URL/);
  assert.match(prompt, /never substitute an environment variable or guess another port/);
  assert.match(prompt, /Do not start, restart, or stop a preview server unless the task explicitly asks/);
  assert.match(prompt, /submit the complete requested sequence once/);
  assert.match(prompt, /<task>\nInspect the app\n<\/task>/);
  assert.doesNotMatch(prompt, /scoped-browser-capability/);
  assert.doesNotMatch(prompt, /https:\/\/relay\.example\.test/);
});

test("provider-native browser mode requires a fresh complete proof and otherwise falls back", () => {
  const parity = providerParity("claude");
  assert.equal(browserModeForExecution("claude", browserAccess, parity), "providerNative");
  assert.equal(browserModeForExecution("codex", browserAccess, parity), "coodeIsolated");
  assert.equal(browserModeForExecution("claude", browserAccess, {
    ...parity,
    features: parity.features.filter((feature) => feature !== "privacy-barrier"),
  }), "coodeIsolated");
  assert.equal(browserModeForExecution("claude", browserAccess, providerParity(
    "claude",
    new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
  )), "coodeIsolated");

  const prompt = promptWithBrowserAccess("Inspect the app", browserAccess, "claude", parity);
  assert.match(prompt, /provider-native browser tools/i);
  assert.doesNotMatch(prompt, /\$CO_OD_BROWSER_TOOL/);

  const environment = providerProcessEnvironment({
    provider: "claude",
    browserAccess,
    browserProviderParity: parity,
  }, { PATH: "/usr/bin" });
  assert.equal(environment.CO_OD_BROWSER_MODE, "providerNative");
  assert.equal(environment.CO_OD_BROWSER_CAPABILITY, undefined);
});

test("buildClaudeArgs passes model and readable directories natively", () => {
  assert.deepEqual(
    buildClaudeArgs("Fix issue", {
      attachments,
      model: "sonnet",
      extraAddDirs: ["/tmp/co-od-hooks"],
    }),
    [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--include-hook-events",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--no-chrome",
      "--disallowedTools",
      "WebFetch,WebSearch",
      "--model",
      "sonnet",
      "--add-dir",
      "/tmp/co-od-hooks",
      "--add-dir",
      "/tmp/project/src",
      "--",
      "Fix issue",
    ],
  );
});

test("buildClaudeArgs enables Chrome only after provider parity was verified by the caller", () => {
  const args = buildClaudeArgs("Inspect", { providerNativeBrowser: true });
  assert.ok(args.includes("--chrome"));
  assert.ok(!args.includes("--no-chrome"));
});

test("buildClaudeArgs resumes or forks known provider sessions", () => {
  assert.deepEqual(
    buildClaudeArgs("Follow up", {
      model: "sonnet",
      providerSession: {
        mode: "fork",
        sourceRunId: "run-a",
        providerSessionId: "claude-session-a",
      },
    }),
    [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--include-hook-events",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--no-chrome",
      "--disallowedTools",
      "WebFetch,WebSearch",
      "--resume",
      "claude-session-a",
      "--fork-session",
      "--model",
      "sonnet",
      "--",
      "Follow up",
    ],
  );
});

test("parseClaudePrintOutput keeps the native session id and unwraps the final response", () => {
  assert.deepEqual(
    parseClaudePrintOutput(JSON.stringify({ result: "Implemented the revision.", session_id: "claude-session-a" })),
    { text: "Implemented the revision.", providerSessionId: "claude-session-a" },
  );
  assert.deepEqual(parseClaudePrintOutput("plain fallback"), { text: "plain fallback" });
  const delta = {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    },
  };
  assert.equal(claudeTextDelta(delta), "Hello");
  assert.deepEqual(
    parseClaudePrintOutput([
      JSON.stringify(delta),
      JSON.stringify({ type: "result", result: "Hello world", session_id: "claude-session-b" }),
    ].join("\n")),
    { text: "Hello world", providerSessionId: "claude-session-b" },
  );
  assert.deepEqual(
    parseClaudePrintOutput([
      JSON.stringify({
        type: "system",
        subtype: "hook_started",
        hook_name: "SessionStart:startup",
        session_id: "claude-session-c",
      }),
      JSON.stringify({
        type: "system",
        subtype: "hook_response",
        output: "private provider hook context",
        session_id: "claude-session-c",
      }),
    ].join("\n")),
    { text: "", providerSessionId: "claude-session-c" },
  );
  assert.deepEqual(
    parseClaudePrintOutput([
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-d" }),
      "Claude stopped before returning a response.",
    ].join("\n")),
    {
      text: "Claude stopped before returning a response.",
      providerSessionId: "claude-session-d",
    },
  );
});

test("Claude subagent messages preserve background lineage", () => {
  assert.deepEqual(claudeSubagentActivities({
    type: "assistant",
    parent_tool_use_id: "agent-parent",
    message: {
      content: [{
        type: "tool_use",
        id: "agent-child",
        name: "Agent",
        input: {
          description: "Run focused tests",
          prompt: "Run the parser tests",
          run_in_background: true,
        },
      }],
    },
  }), [{
    kind: "tool",
    phase: "started",
    title: "Started Run focused tests",
    detail: "Claude subagent",
    tool: "Agent",
    input: JSON.stringify({
      description: "Run focused tests",
      prompt: "Run the parser tests",
      run_in_background: true,
    }, null, 2),
    codeLanguage: "json",
    agentID: "agent-child",
    parentAgentID: "agent-parent",
    background: true,
    agentName: "Claude subagent",
    agentTask: "Run focused tests",
    agentStatus: "working",
    agentProgress: "Starting",
  }]);
  assert.equal(getHarnessCapabilities("claude").backgroundExecution, true);
  assert.equal(getHarnessCapabilities("claude").subagents, true);
});

test("Claude subagent completion keeps the task name from its start event", () => {
  const labels = new Map();
  claudeSubagentActivities({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "agent-child",
        name: "Agent",
        input: { description: "Audit multiplayer presence" },
      }],
    },
  }, labels);

  assert.deepEqual(claudeSubagentActivities({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "agent-child",
        content: "Presence audit complete",
      }],
    },
  }, labels), [{
    kind: "tool",
    phase: "completed",
    title: "Completed Audit multiplayer presence",
    detail: "Claude subagent",
    tool: "Agent",
    output: "Presence audit complete",
    result: "Completed",
    agentID: "agent-child",
    agentName: "Claude subagent",
    agentTask: "Audit multiplayer presence",
    agentStatus: "completed",
    agentProgress: "Finished",
  }]);
  assert.equal(labels.size, 0);
});

test("Claude foreground sessions keep one stream-json process attached across Room turns", async (t) => {
  assert.deepEqual(buildClaudePersistentArgs({ permissionMode: "ask" }).slice(0, 7), [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--forward-subagent-text",
  ]);
  const directory = await mkdtemp(join(tmpdir(), "coode-claude-persistent-"));
  const executable = join(directory, "claude");
  const transcript = join(directory, "claude-inputs.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.TEST_CLAUDE_PERSISTENT_TRANSCRIPT;
appendFileSync(transcript, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(transcript, JSON.stringify({ pid: process.pid, input: message }) + "\\n");
  const text = message.message.content[0].text;
  process.stdout.write(JSON.stringify({ type: "result", result: "reply:" + text, session_id: "claude-session-a" }) + "\\n");
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousTranscript = process.env.TEST_CLAUDE_PERSISTENT_TRANSCRIPT;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_CLAUDE_PERSISTENT_TRANSCRIPT = transcript;
  t.after(async () => {
    disposeClaudePersistentSessions();
    process.env.PATH = previousPath;
    if (previousTranscript === undefined) delete process.env.TEST_CLAUDE_PERSISTENT_TRANSCRIPT;
    else process.env.TEST_CLAUDE_PERSISTENT_TRANSCRIPT = previousTranscript;
    await rm(directory, { recursive: true, force: true });
  });

  const adapter = new ClaudeAdapter();
  const first = await adapter.execute("first", { workDir: directory, permissionMode: "ask" });
  const second = await adapter.execute("second", {
    workDir: directory,
    permissionMode: "ask",
    providerSession: {
      mode: "continue",
      sourceRunId: "run-a",
      providerSessionId: first.providerSessionId,
    },
  });
  assert.equal(first.stdout, "reply:first");
  assert.equal(second.stdout, "reply:second");
  const entries = (await readFile(transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(new Set(entries.map((entry) => entry.pid)).size, 1);
  assert.equal(entries.filter((entry) => entry.input).length, 2);
  assert.equal(entries.find((entry) => entry.args)?.args.includes("--replay-user-messages"), true);
});

test("Claude background-agent service lists, dispatches, and controls the native lifecycle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-claude-agents-"));
  const executable = join(directory, "claude");
  const transcript = join(directory, "commands.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CLAUDE_AGENT_TRANSCRIPT"
case "$1" in
  agents) printf '%s\\n' '[{"id":"agent_123","name":"Research","state":"working","sessionId":"session-secret"}]' ;;
  --bg) printf '%s\\n' 'Backgrounded · agent_456' ;;
  logs) printf '%s\\n' 'recent safe output' ;;
  *) printf '%s\\n' 'ok' ;;
esac
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousTranscript = process.env.TEST_CLAUDE_AGENT_TRANSCRIPT;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_CLAUDE_AGENT_TRANSCRIPT = transcript;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousTranscript === undefined) delete process.env.TEST_CLAUDE_AGENT_TRANSCRIPT;
    else process.env.TEST_CLAUDE_AGENT_TRANSCRIPT = previousTranscript;
    await rm(directory, { recursive: true, force: true });
  });
  const agents = await claudeBackgroundAgents.list(directory);
  assert.equal(agents[0].id, "agent_123");
  assert.equal(agents[0].status, "working");
  const dispatched = await claudeBackgroundAgents.dispatch("Research the failure", {
    workDir: directory,
    permissionMode: "ask",
  });
  assert.equal(dispatched.id, "agent_456");
  assert.equal((await claudeBackgroundAgents.control("logs", "agent_123", directory)).output, "recent safe output");
  assert.equal((await claudeBackgroundAgents.control("stop", "agent_123", directory)).agent.status, "stopped");
  assert.equal((await claudeBackgroundAgents.control("respawn", "agent_123", directory)).agent.status, "working");
  assert.equal((await claudeBackgroundAgents.control("remove", "agent_123", directory)).agent.status, "removed");
  await assert.rejects(() => claudeBackgroundAgents.control("logs", "../secret", directory), /id is invalid/);
  const commands = await readFile(transcript, "utf8");
  assert.match(commands, /agents --json --cwd/);
  assert.match(commands, /--bg --permission-mode manual -- Research the failure/);
  assert.match(commands, /respawn agent_123/);
  assert.match(commands, /rm agent_123/);
});

test("buildCodexArgs passes model, directories, and images natively", () => {
  assert.deepEqual(
    buildCodexArgs("Fix issue", {
      attachments,
      model: "gpt-5",
      json: true,
    }),
    [
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "--model",
      "gpt-5",
      "--add-dir",
      "/tmp/project/src",
      "--image",
      "/tmp/project/screen.png",
      "--",
      "Fix issue",
    ],
  );
});

test("buildCodexArgs grants project source folders across fresh and resumed turns", () => {
  const sourceDirectories = ["/tmp/atlas-docs", "/tmp/atlas-design"];
  const fresh = buildCodexArgs("Use every project source", {
    additionalDirectories: sourceDirectories,
  });
  const resumed = buildCodexArgs("Continue across every project source", {
    additionalDirectories: sourceDirectories,
    providerSession: {
      mode: "continue",
      sourceRunId: "run-a",
      providerSessionId: "codex-thread-a",
    },
  });

  for (const args of [fresh, resumed]) {
    assert.ok(args.includes("/tmp/atlas-docs"));
    assert.ok(args.includes("/tmp/atlas-design"));
    assert.ok(args.indexOf("--add-dir") < args.indexOf("exec"));
  }
});

test("buildCodexArgs maps fast speed to Codex service tier", () => {
  assert.deepEqual(
    buildCodexArgs("Fix issue", {
      model: "gpt-5.6-sol",
      effort: "high",
      speed: "fast",
    }),
    [
      "exec",
      "--sandbox",
      "workspace-write",
      "--config",
      "model_reasoning_effort=\"high\"",
      "--config",
      "service_tier=\"fast\"",
      "--model",
      "gpt-5.6-sol",
      "--",
      "Fix issue",
    ],
  );
});

test("buildCodexArgs resumes known provider sessions", () => {
  assert.deepEqual(
    buildCodexArgs("Follow up", {
      attachments,
      model: "gpt-5",
      json: true,
      providerSession: {
        mode: "continue",
        sourceRunId: "run-a",
        providerSessionId: "codex-thread-a",
      },
    }),
    [
      "--sandbox",
      "workspace-write",
      "exec",
      "resume",
      "--json",
      "--model",
      "gpt-5",
      "--image",
      "/tmp/project/screen.png",
      "codex-thread-a",
      "Follow up",
    ],
  );
});

test("buildCodexArgs starts fresh execs for fork contexts", () => {
  assert.deepEqual(
    buildCodexArgs("Try alternate path", {
      attachments,
      model: "gpt-5",
      json: true,
      providerSession: {
        mode: "fork",
        sourceRunId: "run-a",
        providerSessionId: "codex-thread-a",
      },
    }),
    [
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "--model",
      "gpt-5",
      "--add-dir",
      "/tmp/project/src",
      "--image",
      "/tmp/project/screen.png",
      "--",
      "Try alternate path",
    ],
  );
});

test("Codex room results expose the final answer instead of provider JSONL", () => {
  const transport = [
    '{"type":"thread.started","thread_id":"thread-safe"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Clean answer"}}',
  ].join("\n");
  assert.equal(codexDisplayStdout(transport, "Clean answer", true), "Clean answer");
  assert.equal(codexDisplayStdout(transport, "Clean answer", false), transport);
  assert.equal(codexDisplayStdout(transport, "", true), transport);
});

test("CodexAdapter inherits native integrations without forwarding relay credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coode-codex-room-adapter-"));
  const executable = join(directory, "codex");
  const argumentsPath = join(directory, "args.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_CODEX_ARGS_PATH"
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-room-thread"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"room-safe"}}'
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousArgumentsPath = process.env.TEST_CODEX_ARGS_PATH;
  const previousExecMode = process.env.CO_OD_CODEX_EXEC;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_CODEX_ARGS_PATH = argumentsPath;
  delete process.env.CO_OD_CODEX_EXEC;
  try {
    const streamed = [];
    const result = await new CodexAdapter().execute("Inspect", {
      workDir: directory,
      roomId: "room-safe",
      runId: "run-safe",
      onOutput: (chunk) => streamed.push(chunk),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "room-safe");
    assert.doesNotMatch(result.stdout, /"type":"thread.started"/);
    assert.equal(result.stderr, "");
    assert.match(streamed.join(""), /room-safe/);
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "--",
      "Inspect",
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgumentsPath === undefined) delete process.env.TEST_CODEX_ARGS_PATH;
    else process.env.TEST_CODEX_ARGS_PATH = previousArgumentsPath;
    if (previousExecMode === undefined) delete process.env.CO_OD_CODEX_EXEC;
    else process.env.CO_OD_CODEX_EXEC = previousExecMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildOpenCodeArgs passes model and attachable files natively", () => {
  assert.deepEqual(
    buildOpenCodeArgs("Fix issue", {
      attachments,
      model: "anthropic/claude-sonnet-4-5",
    }),
    [
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--file",
      "/tmp/project/README.md",
      "--file",
      "/tmp/project/screen.png",
      "Fix issue",
    ],
  );
});

test("buildOpenCodeArgs resumes or forks known provider sessions", () => {
  assert.deepEqual(
    buildOpenCodeArgs("Follow up", {
      model: "anthropic/claude-sonnet-4-5",
      providerSession: {
        mode: "fork",
        sourceRunId: "run-a",
        providerSessionId: "opencode-session-a",
      },
    }),
    [
      "run",
      "--format",
      "json",
      "--session",
      "opencode-session-a",
      "--fork",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "Follow up",
    ],
  );
});

test("OpenCode native session state uses authenticated diff, revert, and unrevert APIs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "coode-opencode-server-"));
  const executable = join(directory, "opencode");
  const transcript = join(directory, "requests.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const transcript = process.env.COODE_OPENCODE_TRANSCRIPT;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    appendFileSync(transcript, JSON.stringify({ method: request.method, url: request.url, body, authorization: request.headers.authorization }) + "\\n");
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/global/health")) response.end(JSON.stringify({ healthy: true, version: "test" }));
    else if (request.url.includes("/children")) response.end(JSON.stringify([{ id: "child-secret", title: "Research", status: "busy", time: { created: 1720000000000 } }]));
    else if (request.url.includes("/todo")) response.end(JSON.stringify([{ id: "todo-secret", content: "Verify tests", status: "pending", priority: "high" }]));
    else if (request.url.includes("/diff")) response.end(JSON.stringify([{ file: "src/a.ts" }]));
    else response.end("true");
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, "utf8");
  await chmod(executable, 0o755);
  const previousBin = process.env.OPENCODE_BIN;
  const previousTranscript = process.env.COODE_OPENCODE_TRANSCRIPT;
  process.env.OPENCODE_BIN = executable;
  process.env.COODE_OPENCODE_TRANSCRIPT = transcript;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousTranscript === undefined) delete process.env.COODE_OPENCODE_TRANSCRIPT;
    else process.env.COODE_OPENCODE_TRANSCRIPT = previousTranscript;
  });
  const context = { workDir: directory, providerSessionID: "session-a" };
  assert.deepEqual(await openCodeNativeSessionState.diff(context), [{ file: "src/a.ts" }]);
  assert.equal(await openCodeNativeSessionState.revert(context, "message-a", "part-a"), true);
  assert.equal(await openCodeNativeSessionState.unrevert(context), true);
  const projection = await openCodeNativeSessionState.project(context);
  assert.equal(projection.childSessions[0].title, "Research");
  assert.equal(projection.childSessions[0].fingerprint.length, 16);
  assert.equal(projection.todos[0].content, "Verify tests");
  assert.notEqual(projection.todos[0].id, "todo-secret");
  const requests = (await readFile(transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(requests.every((request) => request.authorization?.startsWith("Basic ")));
  assert.match(requests.find((request) => request.url.includes("/revert"))?.body, /message-a/);
  assert.ok(getHarnessCapabilities("opencode").rollback);
  assert.ok(getHarnessCapabilities("opencode").checkpointing);
});

test("buildAntigravityArgs uses native sandboxed print mode and resumes known conversations", () => {
  assert.deepEqual(buildAntigravityArgs("Continue the change", {
    attachments,
    model: "gemini-3.5-flash",
    providerSession: {
      mode: "continue",
      sourceRunId: "run-a",
      providerSessionId: "agy-conversation-a",
    },
  }), [
    "--sandbox",
    "--mode",
    "accept-edits",
    "--model",
    "gemini-3.5-flash",
    "--conversation",
    "agy-conversation-a",
    "--print",
    "@/tmp/project/src\n@/tmp/project/README.md\n@/tmp/project/screen.png\n\nContinue the change",
  ]);
});

test("Antigravity structured bridge is version gated and projects tool and subagent events", () => {
  assert.equal(antigravitySupportsStructuredOutput("agy 1.1.7"), false);
  assert.equal(antigravitySupportsStructuredOutput("Antigravity CLI v1.1.8"), true);
  assert.ok(buildAntigravityArgs("Ship it", {}, true).includes("stream-json"));
  const parsed = parseAntigravityStructuredLine(JSON.stringify({
    type: "step_update",
    conversation_id: "conversation-a",
    tool_info: { tool_name: "Read", status: "completed", input: { path: "README.md" } },
    subagent_info: { id: "agent-a", parent_id: "root", task: "Research", status: "started" },
    text_delta: "Done",
  }));
  assert.equal(parsed.providerSessionID, "conversation-a");
  assert.equal(parsed.text, "Done");
  assert.equal(parsed.activities.length, 2);
  assert.equal(parsed.activities[0].phase, "completed");
  assert.equal(parsed.activities[1].agentID, "agent-a");
  const installedShape = parseAntigravityStructuredLine(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation-b",
      status: "SUCCESS",
      response: "Verified\n",
    },
  }));
  assert.equal(installedShape.providerSessionID, "conversation-b");
  assert.equal(installedShape.text, "Verified\n");
  assert.equal(installedShape.final, true);
});

test("AntigravityAdapter executes native print mode and captures the resume conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coode-antigravity-adapter-"));
  const executable = join(directory, "agy");
  const argumentsPath = join(directory, "args.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_ANTIGRAVITY_ARGS_PATH"
printf '%s\\n' 'continued'
printf '%s\\n' 'Resume with: agy --conversation agy-conversation-a' >&2
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousArgumentsPath = process.env.TEST_ANTIGRAVITY_ARGS_PATH;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_ANTIGRAVITY_ARGS_PATH = argumentsPath;
  try {
    const result = await new AntigravityAdapter().execute("Continue", { workDir: directory });
    assert.deepEqual({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      providerSessionId: result.providerSessionId,
    }, {
      exitCode: 0,
      stdout: "continued\n",
      stderr: "Resume with: agy --conversation agy-conversation-a\n",
      providerSessionId: "agy-conversation-a",
    });
    assert.equal(result.capabilityReceipt?.source, "declared");
    assert.equal(result.capabilityReceipt?.harness, "antigravity");
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "--sandbox",
      "--mode",
      "accept-edits",
      "--print",
      "Continue",
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgumentsPath === undefined) delete process.env.TEST_ANTIGRAVITY_ARGS_PATH;
    else process.env.TEST_ANTIGRAVITY_ARGS_PATH = previousArgumentsPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildGeminiArgs references existing attachments with @ paths before the goal", () => {
  assert.deepEqual(
    buildGeminiArgs("Fix issue", {
      attachments,
      model: "gemini-2.5-pro",
    }),
    [
      "--model",
      "gemini-2.5-pro",
      "--output-format",
      "stream-json",
      "--prompt",
      "@/tmp/project/src\n@/tmp/project/README.md\n@/tmp/project/screen.png\n\nFix issue",
    ],
  );
});

test("buildGeminiArgs resumes the native project-scoped session", () => {
  assert.deepEqual(buildGeminiArgs("Fix issue", {
    providerSession: { mode: "continue", sourceRunId: "run-a", providerSessionId: "gemini-session-a" },
  }), [
    "--resume",
    "gemini-session-a",
    "--output-format",
    "stream-json",
    "--prompt",
    "Fix issue",
  ]);
});

test("buildGeminiArgs ignores attachments that do not exist on disk", () => {
  assert.deepEqual(
    buildGeminiArgs("Summarize", {
      attachments: [
        { path: "missing.png", absolutePath: "/tmp/project/missing.png", kind: "image", exists: false },
      ],
    }),
    ["--output-format", "stream-json", "--prompt", "Summarize"],
  );
});

test("parseGeminiStreamOutput unwraps assistant deltas and native session id", () => {
  const output = [
    JSON.stringify({ type: "init", session_id: "gemini-session-a", model: "gemini-3" }),
    JSON.stringify({ type: "message", role: "assistant", content: "Implemented ", delta: true }),
    JSON.stringify({ type: "tool_use", tool_name: "write_file" }),
    JSON.stringify({ type: "message", role: "assistant", content: "the revision.", delta: true }),
    JSON.stringify({ type: "result", status: "success" }),
  ].join("\n");
  assert.deepEqual(parseGeminiStreamOutput(output), {
    text: "Implemented the revision.",
    providerSessionId: "gemini-session-a",
  });
});

test("GeminiAdapter executes ACP and continues a negotiated session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coode-gemini-adapter-"));
  const executable = join(directory, "gemini");
  const argumentsPath = join(directory, "args.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_GEMINI_ARGS_PATH"
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(acpFixture)}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousArgumentsPath = process.env.TEST_GEMINI_ARGS_PATH;
  process.env.PATH = `${directory}:${previousPath || ""}`;
  process.env.TEST_GEMINI_ARGS_PATH = argumentsPath;
  try {
    const streamed = [];
    const result = await new GeminiAdapter().execute("Continue", {
      workDir: directory,
      providerSession: { mode: "continue", sourceRunId: "run-a", providerSessionId: "gemini-session-a" },
      permissionMode: "approve",
      onOutput: (chunk) => streamed.push(chunk),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ACP ready");
    assert.equal(result.stderr, "");
    assert.equal(result.providerSessionId, "gemini-session-a");
    assert.equal(result.capabilityReceipt.transport, "acp");
    assert.match(streamed.join(""), /ACP ready/);
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "--acp",
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgumentsPath === undefined) delete process.env.TEST_GEMINI_ARGS_PATH;
    else process.env.TEST_GEMINI_ARGS_PATH = previousArgumentsPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildGrokArgs preserves the native headless harness and isolated edit permissions", () => {
  assert.deepEqual(
    buildGrokArgs("Review this change", { model: "grok-code-fast-1" }),
    [
      "--single",
      "Review this change",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "acceptEdits",
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      "--model",
      "grok-code-fast-1",
    ],
  );
  assert.deepEqual(
    buildGrokArgs("Compare implementations", {
      bestOfN: 3,
      permissionMode: "plan",
      selfCheck: true,
    }).slice(-3),
    ["--best-of-n", "3", "--check"],
  );
});

test("Grok ACP permission selection uses Grok's advertised native modes", () => {
  const modes = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "acceptEdits", name: "Accept Edits" },
      { id: "bypassPermissions", name: "Bypass Permissions" },
      { id: "plan", name: "Plan" },
    ],
  };
  assert.equal(acpNativeSessionMode("grok", "ask", modes), "default");
  assert.equal(acpNativeSessionMode("grok", "approve", modes), "acceptEdits");
  assert.equal(acpNativeSessionMode("grok", "fullAccess", modes), "bypassPermissions");
  assert.equal(acpNativeSessionMode("grok", "plan", modes), "plan");
  assert.equal(acpNativeSessionMode("gemini", "approve", modes), undefined);
});

test("parseGrokPrintOutput keeps the answer and native session ID", () => {
  assert.deepEqual(
    parseGrokPrintOutput(JSON.stringify({
      text: "COODE_GROK_READY",
      sessionId: "019f7a20-5857-7011-a2c9-cca6b273f68d",
      stopReason: "EndTurn",
    })),
    {
      text: "COODE_GROK_READY",
      providerSessionId: "019f7a20-5857-7011-a2c9-cca6b273f68d",
    },
  );
  assert.deepEqual(parseGrokPrintOutput("plain fallback"), { text: "plain fallback" });
  assert.equal(
    grokTextDelta({ type: "content_delta", delta: { text: "Live" } }),
    "Live",
  );
  assert.deepEqual(
    parseGrokPrintOutput([
      JSON.stringify({ type: "content_delta", delta: { text: "Live" } }),
      JSON.stringify({ type: "final", text: "Live answer", sessionId: "grok-session-b" }),
    ].join("\n")),
    { text: "Live answer", providerSessionId: "grok-session-b" },
  );
});

test("getAdapter fails closed for an unknown provider", () => {
  assert.throws(() => getAdapter("mystery-harness"), /Unsupported provider: mystery-harness/);
});

test("provider-neutral harness capabilities advertise the scoped co-ode browser without claiming shared observation", () => {
  const grok = getHarnessCapabilities("grok");
  assert.equal(grok.contractVersion, HARNESS_CONTRACT_VERSION);
  assert.equal(grok.transport.kind, "acp");
  assert.equal(grok.transport.protocolVersion, 1);
  assert.equal(grok.transport.capabilityNegotiation, true);
  assert.equal(grok.transport.structuredEvents, true);
  assert.equal(grok.sessionResume, true);
  assert.equal(grok.sessionFork, true);
  assert.equal(grok.approvalBridge, true);
  assert.equal(grok.planReporting, true);
  assert.equal(grok.subagents, true);
  assert.equal(grok.attachments, true);
  assert.equal(grok.modelSelection, true);
  assert.equal(grok.effortSelection, true);
  assert.equal(grok.permissionSelection, true);
  assert.deepEqual(grok.nativeIntegrations, {
    inheritsUserConfiguration: true,
    plugins: true,
    skills: true,
    mcpServers: true,
  });
  assert.equal(getHarnessCapabilities("codex").browser.mode, "coodeIsolated");
  assert.equal(getHarnessCapabilities("codex").speedSelection, true);
  assert.equal(getHarnessCapabilities("claude").browser.sharesUserBrowserProfile, false);
  for (const provider of ["codex", "claude", "gemini", "grok", "antigravity", "opencode", "openclaw", "pi", "zeroclaw"]) {
    const browser = getHarnessCapabilities(provider).browser;
    assert.equal(browser.mode, "coodeIsolated");
    assert.equal(browser.observesSharedContext, false);
    assert.equal(browser.arbitraryScripting, false);
    assert.equal(browser.sharesUserBrowserProfile, false);
  }
  assert.equal(getHarnessCapabilities("codex").persistentProcess, true);
  assert.equal(getHarnessCapabilities("antigravity").sessionResume, true);
  assert.equal(getHarnessCapabilities("antigravity").attachments, true);
  assert.equal(getHarnessCapabilities("gemini").sessionResume, true);
  assert.equal(getHarnessCapabilities("openclaw").attachments, true);
  assert.equal(getHarnessCapabilities("zeroclaw").externalActions, true);
  assert.equal(getHarnessCapabilities("pi").transport.kind, "jsonl");
  assert.equal(getHarnessCapabilities("pi").approvalBridge, true);
  assert.equal(getHarnessCapabilities("pi").nativeSteer, true);
  assert.equal(getHarnessCapabilities("pi").nativeQueue, true);
  assert.equal(getHarnessCapabilities("pi").sessionFork, true);
  assert.equal(getHarnessCapabilities("custom").nativeIntegrations.inheritsUserConfiguration, false);
  for (const provider of ["codex", "claude", "gemini", "grok", "hermes", "antigravity", "opencode", "openclaw", "zeroclaw"]) {
    assert.deepEqual(getHarnessCapabilities(provider).nativeIntegrations, {
      inheritsUserConfiguration: true,
      plugins: true,
      skills: true,
      mcpServers: true,
    });
  }
});

test("Claude rate-limit announcements become usage limits", () => {
  resetClaudeUsageLimits();
  assert.equal(readClaudeUsageLimits(), undefined);

  // Claude reports utilization as a 0-1 fraction, one window per event.
  recordClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType: "five_hour",
      utilization: 0.96,
      resetsAt: 1785949800,
      status: "allowed_warning",
    },
  });
  let limits = readClaudeUsageLimits();
  assert.equal(limits.secondary.usedPercent, 96);
  assert.equal(limits.secondary.windowDurationMins, 300);
  assert.equal(limits.secondary.resetsAt, 1785949800);

  // A second announcement for the longer window must merge, not replace: the
  // 5h reading has to survive a weekly event arriving after it.
  recordClaudeRateLimitEvent({
    type: "rate_limit_event",
    rate_limit_info: { rateLimitType: "seven_day", utilization: 0.4 },
  });
  limits = readClaudeUsageLimits();
  assert.equal(limits.secondary.usedPercent, 96);
  assert.equal(limits.primary.usedPercent, 40);
  assert.equal(limits.primary.windowDurationMins, 10080);

  // Unrelated stream lines and malformed payloads change nothing.
  assert.equal(recordClaudeRateLimitEvent({ type: "result" }), undefined);
  assert.equal(
    recordClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }),
    undefined,
  );
  resetClaudeUsageLimits();
});
