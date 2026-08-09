import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AntigravityAdapter, buildAntigravityArgs } from "../dist/adapters/antigravity.js";
import {
  buildClaudeArgs,
  claudeTextDelta,
  parseClaudePrintOutput,
  readClaudeUsageLimits,
  recordClaudeRateLimitEvent,
  resetClaudeUsageLimits,
} from "../dist/adapters/claude.js";
import {
  CodexAdapter,
  buildCodexArgs,
  codexActivityFromEvent,
  codexReasoningSummaryActivity,
} from "../dist/adapters/codex.js";
import { buildCustomHarnessArgs } from "../dist/adapters/custom.js";
import { buildOpenCodeArgs } from "../dist/adapters/opencode.js";
import { buildGeminiArgs, GeminiAdapter, parseGeminiStreamOutput } from "../dist/adapters/gemini.js";
import { buildGrokArgs, grokTextDelta, parseGrokPrintOutput } from "../dist/adapters/grok.js";
import { buildHermesArgs } from "../dist/adapters/hermes.js";
import { getAdapter, getHarnessCapabilities } from "../dist/adapters/index.js";
import {
  HARNESS_CONTRACT_VERSION,
  PROVIDER_BROWSER_PARITY_FEATURES,
  browserModeForExecution,
  promptWithBrowserAccess,
  providerBrowserParityProof,
  providerProcessEnvironment,
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
    assert.match(result.stdout, /"type":"thread.started"/);
    assert.match(result.stdout, /--- Agent Response ---\nroom-safe/);
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
      "--session",
      "opencode-session-a",
      "--fork",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "Follow up",
    ],
  );
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
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: "continued\n",
      stderr: "Resume with: agy --conversation agy-conversation-a\n",
      providerSessionId: "agy-conversation-a",
    });
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

test("GeminiAdapter executes the native stream protocol and continues a known session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coode-gemini-adapter-"));
  const executable = join(directory, "gemini");
  const argumentsPath = join(directory, "args.txt");
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_GEMINI_ARGS_PATH"
printf '%s\\n' '{"type":"init","session_id":"gemini-session-a","model":"gemini-3"}'
printf '%s\\n' '{"type":"message","role":"assistant","content":"continued","delta":true}'
printf '%s\\n' '{"type":"result","status":"success"}'
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
      onOutput: (chunk) => streamed.push(chunk),
    });
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: "continued",
      stderr: "",
      providerSessionId: "gemini-session-a",
    });
    assert.equal(streamed.join(""), "continued");
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "--resume",
      "gemini-session-a",
      "--output-format",
      "stream-json",
      "--prompt",
      "Continue",
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
  assert.deepEqual(getHarnessCapabilities("grok"), {
    contractVersion: HARNESS_CONTRACT_VERSION,
    sessionResume: true,
    sessionFork: true,
    streamingOutput: true,
    cancellation: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    speedSelection: false,
    permissionSelection: true,
    goalContext: true,
    persistentProcess: false,
    nativeIntegrations: {
      inheritsUserConfiguration: true,
      plugins: true,
      skills: true,
      mcpServers: true,
    },
    browser: {
      mode: "coodeIsolated",
      observesSharedContext: false,
      reversibleNavigation: true,
      semanticInspection: true,
      arbitraryScripting: false,
      sharesUserBrowserProfile: false,
    },
  });
  assert.equal(getHarnessCapabilities("codex").browser.mode, "coodeIsolated");
  assert.equal(getHarnessCapabilities("codex").speedSelection, true);
  assert.equal(getHarnessCapabilities("claude").browser.sharesUserBrowserProfile, false);
  for (const provider of ["codex", "claude", "gemini", "grok", "antigravity", "opencode", "openclaw"]) {
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
  assert.equal(getHarnessCapabilities("openclaw").attachments, false);
  assert.equal(getHarnessCapabilities("custom").nativeIntegrations.inheritsUserConfiguration, false);
  for (const provider of ["codex", "claude", "gemini", "grok", "hermes", "antigravity", "opencode", "openclaw"]) {
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
