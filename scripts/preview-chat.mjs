// Headless chat-view preview: renders ChatView with synthetic state at any
// terminal size and prints the captured character frame. The design iteration
// loop for the TUI — no login, no room, no real terminal needed.
//
// Usage:  bun scripts/preview-chat.mjs [scenario] [width] [height]
// Scenarios: signed-out | empty | active | streaming | palette | run | confirm | help
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { ChatView } from "../dist/commands/chat-view.js";
import { createOpenTuiPreviewUiState } from "../dist/tui-opentui-preview.js";

const scenario = process.argv[2] || "active";
const width = Number(process.argv[3] || 100);
const height = Number(process.argv[4] || 30);

const NOW = 1760000000000;

function baseState(overrides = {}) {
  const {
    session = { sessionToken: "tok", user: { name: "sergey" } },
    config = { roomId: "room-1", roomName: "co-ode", provider: "opencode" },
    agents = [],
    runs = [],
    messages = [],
    provider = "opencode",
    bridge = "running",
    message = "Ready.",
  } = overrides;
  return {
    args: { dir: process.cwd(), smokeTest: true, durationMs: 0 },
    dashboard: {
      config,
      session,
      bridge,
      providerAvailability: { opencode: true, codex: true, "claude-code": false },
      providerAuth: [
        { provider: "opencode", label: "OpenCode", status: "connected" },
        { provider: "codex", label: "Codex", status: "connected" },
      ],
      dashboard: { agents, runs, messages, services: {} },
      rooms: [],
      provider,
      message,
    },
    workspace: { dir: process.cwd(), git: null },
    workspaceFiles: ["src/index.ts", "src/api.ts", "README.md"],
    instructions: { sections: [] },
    memory: { entries: [] },
    safety: { autoApprove: false, audit: [] },
    pins: { agents: [], runs: [] },
    attachments: [],
    taskHistory: [],
  };
}

const AGENTS = [
  { _id: "agent-build", name: "builder", provider: "opencode", execution_mode: "local_opencode" },
  { _id: "agent-rev", name: "reviewer", provider: "codex", execution_mode: "local_codex" },
];

const RUNS = [
  { _id: "run-aaa11122", goal: "implement dark mode toggle for settings page", status: "running", agent_id: "agent-build", created_at: NOW - 120000 },
  { _id: "run-bbb33344", goal: "review the auth middleware changes", status: "queued", agent_id: "agent-rev", created_at: NOW - 60000 },
  { _id: "run-ccc55566", goal: "fix flaky websocket reconnect test", status: "completed", agent_id: "agent-build", created_at: NOW - 1800000 },
  { _id: "run-ddd77788", goal: "migrate billing config to new schema", status: "failed", agent_id: "agent-rev", created_at: NOW - 3600000 },
];

const TRANSCRIPT = [
  { id: "u0", role: "you", blocks: [{ kind: "markdown", text: "implement a dark mode toggle for the settings page, persist the choice" }] },
  {
    id: "m1", role: "agent", agentName: "builder", provider: "opencode", streaming: false,
    blocks: [
      { kind: "markdown", text: "I found the settings page at `apps/web/app/settings/page.tsx`. The theme state lives in a React context without persistence.\n\nPlan:\n1. Add a `ThemeToggle` component with system/light/dark options\n2. Persist the selection to localStorage\n3. Read the stored value during hydration to avoid a flash of the wrong theme" },
      { kind: "toolCall", label: "Read", detail: "apps/web/app/settings/page.tsx" },
      { kind: "diff", patchId: "p1", runId: "run-aaa11122", file: "apps/web/app/settings/page.tsx", status: "proposed", diff: "--- a\n+++ b\n@@ -1,4 +1,9 @@\n+import { ThemeToggle } from './theme-toggle';\n+const theme = useTheme();\n-old\n+new\n+more\n" },
    ],
  },
  { id: "u2", role: "you", blocks: [{ kind: "markdown", text: "looks good — also make sure the toggle is keyboard accessible" }] },
  {
    id: "m3", role: "agent", agentName: "builder", provider: "opencode", streaming: true,
    blocks: [
      { kind: "markdown", text: "Adding keyboard support now. The toggle will be a radiogroup with arrow-key navigation and visible focus rings." },
    ],
  },
];

const MESSAGES = [
  { _id: "msg1", author_type: "user", author_name: "dana", body_md: "morning! can someone pick up the billing bug?", created_at: NOW - 500000 },
  { _id: "msg2", author_type: "agent", author_name: "builder", body_md: "dark mode toggle in progress", created_at: NOW - 200000 },
  { _id: "msg3", author_type: "user", author_name: "you", body_md: "on it — sent it to builder", created_at: NOW - 100000 },
];

function makeUiState() {
  switch (scenario) {
    case "signed-out": {
      const ui = createOpenTuiPreviewUiState(baseState({
        session: null,
        config: null,
        bridge: "offline",
        message: "No .co-od.json here yet. Initialize a room first.",
      }));
      return ui;
    }
    case "empty": {
      return createOpenTuiPreviewUiState(baseState({}));
    }
    case "streaming": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, transcript: TRANSCRIPT, taskRunning: true, mode: "task", taskInput: "", taskCursor: 0 };
    }
    case "palette": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, transcript: TRANSCRIPT, mode: "palette", paletteInput: "task", paletteSelected: 1 };
    }
    case "run": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return {
        ...ui,
        mode: "run",
        selectedRunId: "run-aaa11122",
        selectedRunDetail: {
          run: {
            _id: "run-aaa11122", goal: "implement dark mode toggle for settings page", status: "running",
            agent_id: "agent-build", execution_mode: "local_opencode", created_at: NOW - 120000,
            steps: [
              { _id: "s1", idx: 1, kind: "plan", output: { success: true }, description: "Scanned settings page structure" },
              { _id: "s2", idx: 2, kind: "edit", output: { success: true }, description: "Added ThemeToggle component" },
              { _id: "s3", idx: 3, kind: "test", output: { success: false }, description: "Unit test failed: hydration mismatch" },
            ],
          },
          patches: [
            { _id: "p1", path: "apps/web/app/settings/page.tsx", status: "proposed", diff_text: "--- a\n+++ b\n@@ -1,3 +1,8 @@\n+import { ThemeToggle } from './theme-toggle';\n context\n-  <OldToggle />\n+  <ThemeToggle defaultValue={stored} />\n context\n+  <FocusRing />\n" },
            { _id: "p2", path: "apps/web/app/settings/theme-toggle.tsx", status: "accepted", diff_text: "--- a\n+++ b\n@@ -0,0 +1,40 @@\n+export function ThemeToggle() {}\n" },
          ],
          children: [],
        },
      };
    }
    case "confirm": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return {
        ...ui,
        mode: "confirm",
        transcript: TRANSCRIPT,
        pendingApproval: {
          title: "Run shell command",
          detail: "builder wants to run:\nnpm test -- --filter settings\nWorking dir: ~/Coding/Codex/co-ode",
          confirmLabel: "Allow",
          runningMessage: "Running...",
          feedMessage: "Approved shell command",
          feedKind: "info",
          returnMode: "task",
          returnTaskInput: "",
          intent: { type: "bridge-approval", approvalId: "ap1", decision: "approve", target: "npm test" },
        },
      };
    }
    case "help": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, mode: "help", transcript: TRANSCRIPT };
    }
    case "panel": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, transcript: TRANSCRIPT.map((m) => ({ ...m, streaming: false })), panelVisible: true };
    }
    case "catchup": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return ui;
    }
    case "composing": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      const draft = "review the settings page diff and check:\n- hydration mismatch on first paint\n- focus ring visibility in dark mode\nthen summarize what still blocks the merge";
      return { ...ui, transcript: TRANSCRIPT.map((m) => ({ ...m, streaming: false })), mode: "task", taskInput: draft, taskCursor: draft.length };
    }
    case "suggest": {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, transcript: TRANSCRIPT.map((m) => ({ ...m, streaming: false })), mode: "task", taskInput: "/ta", taskCursor: 3 };
    }
    case "active":
    default: {
      const ui = createOpenTuiPreviewUiState(baseState({ agents: AGENTS, runs: RUNS, messages: MESSAGES }));
      return { ...ui, transcript: TRANSCRIPT.map((message) => ({ ...message, streaming: false })) };
    }
  }
}

const { renderer, renderOnce, flush, captureCharFrame } = await createTestRenderer({ width, height });
const root = createRoot(renderer);
root.render(createElement(ChatView, { state: makeUiState(), width }));
await new Promise((resolve) => setTimeout(resolve, 150));
await flush();
await renderOnce();
const frame = captureCharFrame();
console.log("┌" + "─".repeat(width) + "┐");
for (const line of frame.split("\n")) console.log("│" + line.padEnd(width) + "│");
console.log("└" + "─".repeat(width) + "┘");
process.exit(0);
