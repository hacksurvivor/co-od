import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRoomTaskCompletionPayload,
  extractProviderSessionIdFromRun,
} from "./commands/run.js";
import { attachmentTransportSummary } from "./tui-attachments.js";
import { createConfirmation, resolveConfirmationKey } from "./tui-confirmation.js";
import {
  fetchServiceHealth,
  loadRoomDashboardData,
  loadRoomsData,
  loadRunDetailData,
  readProjectConfig,
  restoreServerUndoChanges,
  type AgentRecord,
  type ServiceHealth,
} from "./tui-dashboard.js";
import { createRealtimeSession } from "./tui-terminal.js";
import type { CachedSession } from "./api-client.js";
import { resolveAgentPauseCommand, resolveAgentResumeCommand } from "./tui-agent-actions.js";
import { resolveFanoutCommand } from "./tui-fanout.js";
import { resolveHandoffCommand } from "./tui-handoff.js";
import {
  classifyDiffLine,
  diffStat,
  type AgentRunRecord,
  type PatchRecord,
} from "./tui-model.js";
import {
  resolveContinueCommand,
  resolveForkCommand,
  resolveResumeCommand,
  resolveRetryCommand,
  resolveStopCommand,
} from "./tui-run-actions.js";
import {
  formatEnvMutation,
  formatEnvStatus,
  resolveEnvCommand,
  type RuntimeEnvSnapshot,
  type TuiEnvMutationResponse,
  type TuiEnvStatusResponse,
} from "./tui-env.js";
import {
  collectProviderSessions,
  providerSessionStatusForRun,
  resolveProviderSession,
} from "./tui-sessions.js";
import {
  fileMentionAttachmentsChanged,
  resolveFileMentionAttachments,
} from "./tui-file-mentions.js";
import {
  createFileWriteUndoChange,
  createUndoSnapshot,
  restoreFileUndoChanges,
  restoreUndoSnapshot,
} from "./tui-undo.js";
import { createSafetyState } from "./tui-safety.js";
import {
  bridgeApprovalDetailLines,
  bridgeApprovalTitle,
  defaultLocalBridgeUrl,
  parseBridgeApprovalRequest,
  type BridgeApprovalRequest,
} from "./tui-bridge-approvals.js";
import {
  appendTerminalOutputLines,
  createTerminalConnectionState,
  reduceTerminalConnectionState,
  resolveTerminalPaneSize,
} from "./tui-terminal.js";
import { loadTuiProjectState, type TuiProjectState } from "./tui-persistence.js";
import {
  formatTuiScrollbackSearch,
  searchTuiScrollback,
} from "./tui-scrollback-search.js";
import {
  formatWorkspaceFilePreview,
  loadWorkspaceFilePreview,
} from "./tui-workspace.js";

export interface TuiQaCheck {
  id: string;
  description: string;
  ok: boolean;
  detail?: string;
}

export interface TuiQaReport {
  ok: boolean;
  checkedAt: string;
  checks: TuiQaCheck[];
}

export interface TuiQaSlashResolution {
  live: boolean;
  includeTerminal: boolean;
  roomId?: string;
  bridgeUrl?: string;
  error?: string;
}

export type TuiLiveQaCheckStatus = "pass" | "fail" | "skip";

export interface TuiLiveQaCheck {
  id: string;
  description: string;
  status: TuiLiveQaCheckStatus;
  detail?: string;
}

export interface TuiLiveQaReport {
  ok: boolean;
  checkedAt: string;
  roomId?: string;
  serverUrl: string;
  checks: TuiLiveQaCheck[];
}

export interface BuildTuiLiveQaReportOptions {
  dir: string;
  roomId?: string;
  serverUrl: string;
  includeTerminal?: boolean;
  allowMutations?: boolean;
  mutationAgentId?: string;
  bridgeUrl?: string;
  date?: Date;
  getSession?: () => CachedSession | null;
  projectState?: Pick<TuiProjectState, "selectedRoomId" | "selectedRoomName"> | null;
  apiGet?: <T = unknown>(path: string) => Promise<T>;
  apiPost?: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  apiDelete?: <T = unknown>(path: string) => Promise<T>;
  fetchImpl?: typeof fetch;
}

export function resolveTuiQaSlashCommand(command: string, args: string[]): TuiQaSlashResolution {
  const normalized = command.toLowerCase();
  const live = normalized === "live-qa" || args.includes("live") || args.includes("--live");
  const includeTerminal = args.includes("--terminal") || args.includes("terminal");
  if (args.includes("--mutate") || args.includes("mutate")) {
    return {
      live,
      includeTerminal,
      error: "Live QA mutations are only available from `co-od tui-qa --live --mutate`.",
    };
  }
  return {
    live,
    includeTerminal,
    roomId: readTuiQaRoomArg(args),
    bridgeUrl: readTuiQaFlagValue(args, "--bridge-url") || readTuiQaFlagValue(args, "--bridge"),
  };
}

const now = 1_700_000_000_000;

type FixtureRun = AgentRunRecord & { status: string };

function fixtureAgents(): AgentRecord[] {
  return [
    { _id: "agent-claude", name: "Claude Local", provider: "anthropic", execution_mode: "local_claude_code" },
    { _id: "agent-open", name: "OpenCode Local", provider: "opencode", execution_mode: "local_opencode" },
    { _id: "agent-hosted", name: "Hosted", provider: "openai", execution_mode: "hosted_api" },
  ];
}

function fixtureRuns(): FixtureRun[] {
  return [
    {
      _id: "run-success",
      agent_id: "agent-claude",
      goal: "Implement the TUI dashboard",
      status: "succeeded",
      created_at: now - 1_000,
      steps: [
        {
          kind: "observation",
          output: {
            success: true,
            payload: {
              providerSessionId: "provider-session-success",
              stdout: "done",
            },
          },
        },
      ],
    },
    {
      _id: "run-failed",
      agent_id: "agent-open",
      goal: "Retryable task",
      status: "failed",
      created_at: now - 2_000,
    },
    {
      _id: "run-running",
      agent_id: "agent-open",
      goal: "Running task",
      status: "running",
      created_at: now - 3_000,
    },
    {
      _id: "run-paused",
      agent_id: "agent-open",
      goal: "Paused task",
      status: "paused",
      created_at: now - 4_000,
    },
  ];
}

function fixturePatch(): PatchRecord {
  return {
    _id: "patch-a",
    run_id: "run-success",
    title: "Update dashboard",
    status: "proposed",
    diff_text: [
      "diff --git a/a.ts b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  };
}

function check(id: string, description: string, assertion: () => string | undefined): TuiQaCheck {
  try {
    const detail = assertion();
    return { id, description, ok: true, detail };
  } catch (error) {
    return {
      id,
      description,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function readTuiQaRoomArg(args: string[]): string | undefined {
  return readTuiQaFlagValue(args, "--room") || args.find((arg, index) => (
    arg !== "live"
    && arg !== "--live"
    && arg !== "terminal"
    && arg !== "--terminal"
    && arg !== "--skip-terminal"
    && arg !== "mutate"
    && arg !== "--mutate"
    && arg !== "--room"
    && arg !== "--bridge-url"
    && arg !== "--bridge"
    && args[index - 1] !== "--room"
    && args[index - 1] !== "--bridge-url"
    && args[index - 1] !== "--bridge"
    && !arg.startsWith("--")
  ));
}

function readTuiQaFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function buildTuiQaReport(date = new Date()): TuiQaReport {
  const runs = fixtureRuns();
  const agents = fixtureAgents();
  const patch = fixturePatch();

  const checks = [
    check("resume-provider-session", "recovers native provider session ids from persisted room steps", () => {
      const sessionId = extractProviderSessionIdFromRun(runs[0]);
      assert(sessionId === "provider-session-success", `expected provider-session-success, got ${sessionId || "none"}`);
      return sessionId;
    }),
    check("completion-provider-session", "stores provider session ids in local task completion payloads", () => {
      const payload = buildRoomTaskCompletionPayload({
        goal: "Continue",
        continueRunId: "run-success",
        status: "succeeded",
        now,
        result: {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          providerSessionId: "provider-session-next",
        },
      });
      const step = payload.run.steps[0];
      const stored = step.output.payload.providerSessionId;
      assert(stored === "provider-session-next", `expected provider-session-next, got ${String(stored)}`);
      return String(stored);
    }),
    check("session-listing", "lists native provider sessions and resolves a backing run", () => {
      const rows = collectProviderSessions({ runs, agents });
      const selected = resolveProviderSession(rows, "provider-session-success");
      const status = providerSessionStatusForRun(runs, "run-success");
      assert(rows.length === 1, `expected one provider session, got ${rows.length}`);
      assert(selected.ok && selected.row?.runId === "run-success", "provider session did not resolve backing run");
      assert(status.providerSessionId === "provider-session-success", "provider session status did not find loaded id");
      return selected.row?.providerSessionId;
    }),
    check("continue-resume-fork", "resolves continue, resume, and fork commands from room run state", () => {
      const continued = resolveContinueCommand({ runs, args: ["run-success", "follow", "up"] });
      const resumed = resolveResumeCommand({ runs, args: ["run-success"], defaultGoal: "Resume default." });
      const forked = resolveForkCommand({ runs, args: ["run-success", "try", "alternate"] });
      assert(continued.ok && continued.runId === "run-success" && continued.goal === "follow up", "continue did not resolve");
      assert(resumed.ok && resumed.runId === "run-success" && resumed.goal === "Resume default.", "resume did not resolve");
      assert(forked.ok && forked.runId === "run-success" && forked.goal?.includes("try alternate"), "fork did not resolve");
      return "continue/resume/fork ok";
    }),
    check("retry-stop", "resolves retry for failed runs and stop for running runs", () => {
      const retry = resolveRetryCommand({ runs, runRef: "run-failed" });
      const stop = resolveStopCommand({ runs, runRef: "run-running" });
      assert(retry.ok && retry.goal === "Retryable task", "retry did not resolve failed run");
      assert(stop.ok && stop.runId === "run-running", "stop did not resolve running run");
      return "retry/stop ok";
    }),
    check("agent-pause-resume", "resolves backend-backed local agent pause and resume targets", () => {
      const pause = resolveAgentPauseCommand({ agents, runs, args: ["OpenCode Local"] });
      const resume = resolveAgentResumeCommand({ agents, runs, args: ["OpenCode Local"] });
      assert(pause.ok && pause.runIds.includes("run-running"), "pause did not resolve running local run");
      assert(resume.ok && resume.runIds.includes("run-paused"), "resume did not resolve paused local run");
      return "pause/resume ok";
    }),
    check("patch-review", "keeps patch review diff stats and line classification stable", () => {
      const stat = diffStat(patch.diff_text);
      assert(stat === "+1 -1", `expected +1 -1, got ${stat}`);
      assert(classifyDiffLine("+new") === "add", "added line classification failed");
      assert(classifyDiffLine("-old") === "remove", "removed line classification failed");
      return stat;
    }),
    check("fanout-handoff", "resolves local fan-out targets and handoff target context", () => {
      const fanout = resolveFanoutCommand({
        agents,
        args: ["all", "compare", "approaches"],
        providerAvailability: { claude: true, opencode: true },
      });
      const handoff = resolveHandoffCommand({
        agents,
        runs,
        args: ["current", "OpenCode Local", "pick up from here"],
        currentRunId: "run-success",
      });
      assert(fanout.ok && fanout.targets.length === 2, "fan-out did not select two local targets");
      assert(handoff.ok && handoff.targetAgentId === "agent-open", "handoff did not resolve target agent");
      return "fanout/handoff ok";
    }),
    check("file-mentions-undo", "promotes prompt file mentions into visible undoable attachment state", () => {
      const before = [{ path: "README.md" }];
      const mentions = resolveFileMentionAttachments({
        goal: "Review @README.md and @packages/cli/src/tui.ts",
        files: ["README.md", "packages/cli/src/tui.ts"],
        currentAttachments: before,
      });
      assert(mentions.matched.length === 2, `expected two matched mentions, got ${mentions.matched.length}`);
      assert(fileMentionAttachmentsChanged(before, mentions.attachments), "new mention attachment was not detected");
      const safety = createSafetyState({});
      const snapshot = createUndoSnapshot({
        label: "file mentions",
        provider: "opencode",
        attachments: before,
        pins: { rooms: [], providers: [], agents: [] },
        safety,
        now,
      });
      const restored = restoreUndoSnapshot(snapshot, safety, now + 1);
      assert(restored.attachments.length === 1 && restored.attachments[0]?.path === "README.md", "undo did not restore prior attachment state");
      return `${mentions.attachments.length} attachments`;
    }),
    check("attachment-transport", "explains provider-native attachment transport and prompt fallback", () => {
      const dir = mkdtempSync(join(tmpdir(), "co-od-qa-attachments-"));
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "screen.png"), "png\n");
        const summary = attachmentTransportSummary([
          { path: "screen.png", kind: "image" },
          { path: "src", kind: "directory" },
          { path: "README.md", kind: "file" },
        ], "codex", dir);
        assert(summary.native.map((attachment) => attachment.path).join(",") === "screen.png,src", "codex native attachment set was wrong");
        assert(summary.fallback.map((attachment) => attachment.path).join(",") === "README.md", "fallback attachment set was wrong");
        return summary.lines.slice(1, 3).join("; ");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
    check("scrollback-search", "searches visible feed and shared-terminal scrollback", () => {
      const result = searchTuiScrollback({
        query: "dashboard",
        feed: [
          { kind: "info", text: "Room dashboard loaded" },
          { kind: "output", text: "Task output" },
        ],
        terminalLines: ["pnpm test", "dashboard smoke passed"],
      });
      assert(result.matches.length === 2, `expected two scrollback matches, got ${result.matches.length}`);
      const formatted = formatTuiScrollbackSearch(result);
      assert(formatted.includes("terminal:2: dashboard smoke passed"), "terminal match missing");
      assert(formatted.includes("feed:1/info:1: Room dashboard loaded"), "feed match missing");
      return `${result.matches.length} matches`;
    }),
    check("file-preview", "previews workspace files around requested line numbers", () => {
      const dir = mkdtempSync(join(tmpdir(), "co-od-qa-file-preview-"));
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "app.ts"), "one\ntwo\nthree\nfour\nfive\n");
        const result = loadWorkspaceFilePreview({
          dir,
          ref: "src/app.ts:3",
          contextLines: 1,
        });
        assert(!result.error, result.error || "preview failed");
        assert(result.lines.length === 3, `expected three preview lines, got ${result.lines.length}`);
        assert(result.lines.some((line) => line.number === 3 && line.selected && line.text === "three"), "requested line was not highlighted");
        const formatted = formatWorkspaceFilePreview(result);
        assert(formatted.includes("File src/app.ts:2-4"), "preview header missing");
        return `${result.path}:${result.requestedLine}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
    check("server-undo", "reopens rejected room patches through server undo hooks", () => {
      const calls: Array<[string, unknown]> = [];
      void restoreServerUndoChanges({
        changes: [{
          kind: "patch-reopen",
          roomId: "room-a",
          runId: "run-success",
          patchId: "patch-a",
          fromStatus: "rejected",
          toStatus: "proposed",
        }],
        apiPost: async <T = unknown>(path: string, body?: unknown): Promise<T> => {
          calls.push([path, body]);
          return { ok: true } as T;
        },
      });
      assert(calls[0]?.[0] === "/api/rooms/room-a/patches/patch-a/reopen", "server undo did not target patch reopen endpoint");
      return "patch reopen ok";
    }),
    check("file-operation-undo", "removes TUI-created files and empty parent directories", () => {
      const dir = mkdtempSync(join(tmpdir(), "co-od-qa-file-undo-"));
      try {
        const change = createFileWriteUndoChange({
          dir,
          path: "exports/runs/summary.md",
          after: "# Run\n",
        });
        if (!change) throw new Error("file undo change was not recorded");
        assert(change.createdDirectories?.join("/") === "exports/exports/runs", "created directories were not recorded");
        mkdirSync(join(dir, "exports", "runs"), { recursive: true });
        writeFileSync(join(dir, "exports", "runs", "summary.md"), "# Run\n");
        const restored = restoreFileUndoChanges(dir, [change]);
        assert(restored.ok, restored.message);
        assert(!existsSync(join(dir, "exports")), "created export directory was not removed");
        return "created dirs removed";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
    check("confirmation", "maps confirmation keys for manual approval gates", () => {
      const confirmation = createConfirmation({ id: "qa", title: "Approve task" });
      const yes = resolveConfirmationKey("y", { name: "y" });
      const cancel = resolveConfirmationKey("", { name: "escape" });
      assert(confirmation.confirmLabel === "Confirm", "default confirm label missing");
      assert(yes.type === "confirm", "y did not confirm");
      assert(cancel.type === "cancel", "escape did not cancel");
      return "confirm/cancel ok";
    }),
    check("approval-metadata", "formats bridge approval prompts with operation metadata", () => {
      const approval = parseBridgeApprovalRequest({
        approvalId: "agent-open:9:1",
        method: "item/commandExecution/requestApproval",
        requestId: 9,
        kind: "shell",
        command: ["pnpm", "test"],
        cwd: "/repo",
        reason: "test before commit",
      });
      if (!approval) throw new Error("approval payload did not parse");
      assert(bridgeApprovalTitle(approval) === "shell command approval", "approval title did not use operation label");
      const lines = bridgeApprovalDetailLines(approval);
      assert(lines.includes("cwd: /repo"), "cwd metadata missing");
      assert(lines.includes("method: item/commandExecution/requestApproval #9"), "method metadata missing");
      return lines.join(" | ");
    }),
    check("runtime-commands", "resolves hosted runtime status and lifecycle commands", () => {
      const status = resolveEnvCommand("runtime", []);
      const start = resolveEnvCommand("env", ["start", "3600"]);
      const touch = resolveEnvCommand("env-touch", []);
      const stop = resolveEnvCommand("runtime-stop", []);
      assert(status.ok && status.action === "status", "runtime status did not resolve");
      assert(start.ok && start.action === "start" && start.ttlSeconds === 3600, "runtime start did not parse ttl");
      assert(touch.ok && touch.action === "touch", "runtime touch did not resolve");
      assert(stop.ok && stop.action === "stop", "runtime stop did not resolve");
      return "status/start/touch/stop ok";
    }),
    check("terminal-pane", "reduces shared terminal connection state and fixed pane sizing", () => {
      const size = resolveTerminalPaneSize(100, 40);
      let state = createTerminalConnectionState();
      state = reduceTerminalConnectionState(state, { type: "connecting" }, now);
      state = reduceTerminalConnectionState(state, { type: "status", message: "Connected to room shell", connected: true }, now + 1);
      const lines = appendTerminalOutputLines(["hello"], "world\n", 2);
      assert(size.columns === 100 && size.rows === 14, `unexpected pane size ${size.columns}x${size.rows}`);
      assert(state.connected && !state.connecting, "terminal did not reach connected state");
      assert(lines.join("|") === "hello|world", `unexpected scrollback ${lines.join("|")}`);
      return `${size.columns}x${size.rows}`;
    }),
  ];

  return {
    ok: checks.every((item) => item.ok),
    checkedAt: date.toISOString(),
    checks,
  };
}

export function formatTuiQaReport(report: TuiQaReport): string {
  const lines = [
    `co-od TUI QA ${report.ok ? "passed" : "failed"}`,
    `Checked: ${report.checkedAt}`,
    "",
  ];
  for (const item of report.checks) {
    lines.push(`${item.ok ? "OK " : "ERR"} ${item.id} - ${item.description}${item.detail ? ` (${item.detail})` : ""}`);
  }
  return lines.join("\n");
}

function liveCheck(
  id: string,
  description: string,
  status: TuiLiveQaCheckStatus,
  detail?: string,
): TuiLiveQaCheck {
  return { id, description, status, detail };
}

function isValidSession(session: CachedSession | null): session is CachedSession {
  return Boolean(session?.sessionToken && session.expiresAt > Date.now());
}

function summarizeServices(services: Record<string, ServiceHealth>): string {
  const entries = Object.entries(services);
  if (entries.length === 0) return "no services reported";
  return entries
    .map(([name, service]) => {
      const state = service.ok ? "ok" : "down";
      const latency = typeof service.latencyMs === "number" ? ` ${service.latencyMs}ms` : "";
      const status = typeof service.status === "number" ? ` HTTP ${service.status}` : "";
      return `${name}:${state}${status}${latency}`;
    })
    .join(", ");
}

function hasReachableWeb(services: Record<string, ServiceHealth>): boolean {
  const web = services.web;
  if (web) return web.ok !== false;
  return Object.values(services).some((service) => service.ok);
}

const REQUIRED_LIVE_SERVICES = ["web", "convex", "runtimeGateway", "collab", "terminal", "orchestrator"];

function hasRequiredLiveServices(services: Record<string, ServiceHealth>): boolean {
  return REQUIRED_LIVE_SERVICES.every((name) => Boolean(services[name]) && services[name]?.ok !== false);
}

function summarizeMissingLiveServices(services: Record<string, ServiceHealth>): string {
  return REQUIRED_LIVE_SERVICES
    .filter((name) => !services[name])
    .map((name) => `${name}:missing`)
    .join(", ");
}

function firstRunId(runs: AgentRunRecord[]): string | undefined {
  return runs
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]?._id;
}

function localBridgeMode(mode?: string): boolean {
  return (
    mode === "local_codex" ||
    mode === "local_claude_code" ||
    mode === "local_opencode" ||
    mode === "local_openclaw" ||
    mode === "local_sandcastle"
  );
}

function describeLifecycleCandidates(agents: AgentRecord[], runs: AgentRunRecord[]): TuiLiveQaCheck {
  const localAgentIds = new Set(
    agents
      .filter((agent) => localBridgeMode(agent.execution_mode))
      .map((agent) => agent._id),
  );
  const active = runs.filter(
    (run) =>
      (run.status === "queued" || run.status === "running") &&
      (localBridgeMode(run.execution_mode) || (run.agent_id && localAgentIds.has(run.agent_id))),
  );
  const paused = runs.filter(
    (run) =>
      run.status === "paused" &&
      (localBridgeMode(run.execution_mode) || (run.agent_id && localAgentIds.has(run.agent_id))),
  );
  if (active.length === 0 && paused.length === 0) {
    return liveCheck(
      "lifecycle-candidates",
      "detects real local bridge pause/resume candidates without mutating them",
      "skip",
      "no active or paused local bridge runs in this room",
    );
  }
  return liveCheck(
    "lifecycle-candidates",
    "detects real local bridge pause/resume candidates without mutating them",
    "pass",
    `${active.length} active, ${paused.length} paused`,
  );
}

interface LocalBridgeHealthResponse {
  ok?: boolean;
  codexAvailable?: boolean;
  codexApprovalMode?: string;
  codexApprovalPolicy?: string;
  codexApprovalTimeoutMs?: number;
  pendingCodexApprovals?: number;
}

function codexLocalAgents(agents: AgentRecord[]): AgentRecord[] {
  return agents.filter((agent) => agent.execution_mode === "local_codex");
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  }
  return await response.json() as T;
}

function parseBridgeApprovals(data: unknown): BridgeApprovalRequest[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const approvals = (data as { approvals?: unknown }).approvals;
  if (!Array.isArray(approvals)) return [];
  return approvals
    .map((approval) => parseBridgeApprovalRequest(approval))
    .filter((approval): approval is BridgeApprovalRequest => Boolean(approval));
}

async function describeApprovalBroker(input: {
  agents: AgentRecord[];
  bridgeUrl: string;
  fetchImpl: typeof fetch;
}): Promise<TuiLiveQaCheck> {
  const codexAgents = codexLocalAgents(input.agents);
  if (codexAgents.length === 0) {
    return liveCheck(
      "approval-broker",
      "verifies local Codex approval broker readiness without resolving approvals",
      "skip",
      "no local Codex agents in this room",
    );
  }

  const bridgeUrl = input.bridgeUrl.replace(/\/$/, "");
  try {
    const health = await readJsonResponse<LocalBridgeHealthResponse>(
      await input.fetchImpl(`${bridgeUrl}/health`),
      "local bridge health",
    );
    if (health.ok === false) {
      return liveCheck(
        "approval-broker",
        "verifies local Codex approval broker readiness without resolving approvals",
        "fail",
        "local bridge health returned ok=false",
      );
    }
    if (health.codexAvailable === false) {
      return liveCheck(
        "approval-broker",
        "verifies local Codex approval broker readiness without resolving approvals",
        "fail",
        "local Codex CLI is unavailable on the bridge host",
      );
    }

    const approvals = parseBridgeApprovals(
      await readJsonResponse<unknown>(
        await input.fetchImpl(`${bridgeUrl}/v1/approvals`),
        "local bridge approvals",
      ),
    );
    const detail = [
      `${codexAgents.length} local Codex agent${codexAgents.length === 1 ? "" : "s"}`,
      `mode ${health.codexApprovalMode || "unknown"}`,
      health.codexApprovalPolicy ? `policy ${health.codexApprovalPolicy}` : "",
      `pending ${approvals.length}`,
    ].filter(Boolean).join(", ");

    return liveCheck(
      "approval-broker",
      "verifies local Codex approval broker readiness without resolving approvals",
      health.codexApprovalMode === "prompt" ? "pass" : "skip",
      health.codexApprovalMode === "prompt"
        ? detail
        : `${detail}; prompt mode disabled with LOCAL_BRIDGE_CODEX_APPROVAL_MODE=${health.codexApprovalMode || "auto"}`,
    );
  } catch (error) {
    return liveCheck(
      "approval-broker",
      "verifies local Codex approval broker readiness without resolving approvals",
      "fail",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function describeRuntimeStatus(input: {
  roomId: string;
  apiGet: <T = unknown>(path: string) => Promise<T>;
}): Promise<{
  check: TuiLiveQaCheck;
  status?: TuiEnvStatusResponse;
}> {
  try {
    const status = await input.apiGet<TuiEnvStatusResponse>(`/api/rooms/${input.roomId}/env/status`);
    const detail = formatEnvStatus(status).replace(/\n/g, "; ");
    return {
      check: liveCheck(
        "runtime-status",
        "loads live hosted runtime status without mutating it",
        "pass",
        detail,
      ),
      status,
    };
  } catch (error) {
    return {
      check: liveCheck(
        "runtime-status",
        "loads live hosted runtime status without mutating it",
        "fail",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

async function runRuntimeLifecycleScenario(input: {
  roomId: string;
  initialStatus?: TuiEnvStatusResponse;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  date: Date;
}): Promise<TuiLiveQaCheck> {
  const initial = extractRuntimeEnv(input.initialStatus);
  const initiallyRunning = initial?.status === "running" || initial?.status === "starting";
  const markers: string[] = [];

  if (!initial) {
    return liveCheck(
      "mutation-runtime-lifecycle",
      "starts, touches, and safely stops a disposable hosted runtime lease",
      "skip",
      "runtime status did not return an env snapshot; skipping to avoid stopping an existing runtime",
    );
  }

  try {
    if (!initiallyRunning) {
      const ttlSeconds = 900;
      const started = await input.apiPost<TuiEnvMutationResponse>(`/api/rooms/${input.roomId}/env/start`, {
        ttlSeconds,
      });
      markers.push(formatEnvMutation("start", started).replace(/\n/g, "; "));
    } else {
      markers.push(`runtime already ${initial.status}; start skipped`);
    }

    const touched = await input.apiPost<TuiEnvMutationResponse>(`/api/rooms/${input.roomId}/env/touch`, {});
    markers.push(formatEnvMutation("touch", touched).replace(/\n/g, "; "));

    if (!initiallyRunning) {
      const stopped = await input.apiPost<TuiEnvMutationResponse>(`/api/rooms/${input.roomId}/env/stop`, {});
      markers.push(formatEnvMutation("stop", stopped).replace(/\n/g, "; "));
    } else {
      markers.push("stop skipped to preserve the existing runtime");
    }

    return liveCheck(
      "mutation-runtime-lifecycle",
      "starts, touches, and safely stops a disposable hosted runtime lease",
      "pass",
      markers.join(" | "),
    );
  } catch (error) {
    if (!initiallyRunning && markers.some((marker) => marker.startsWith("Runtime started"))) {
      await input.apiPost(`/api/rooms/${input.roomId}/env/stop`, {}).catch(() => null);
      markers.push("cleanup stop attempted");
    }
    const detail = error instanceof Error ? error.message : String(error);
    return liveCheck(
      "mutation-runtime-lifecycle",
      "starts, touches, and safely stops a disposable hosted runtime lease",
      "fail",
      markers.length > 0 ? `${markers.join(" | ")}; ${detail}` : detail,
    );
  }
}

function extractRuntimeEnv(status?: TuiEnvStatusResponse): RuntimeEnvSnapshot | null {
  return status?.orchestrator?.env || status?.convex || null;
}

function findMutationAgent(agents: AgentRecord[], agentId?: string): AgentRecord | undefined {
  if (agentId) {
    return agents.find((agent) => agent._id === agentId && localBridgeMode(agent.execution_mode));
  }
  return agents.find((agent) => localBridgeMode(agent.execution_mode));
}

function findMutationAgents(agents: AgentRecord[], agentId?: string): AgentRecord[] {
  const localAgents = agents.filter((agent) => localBridgeMode(agent.execution_mode));
  if (!agentId) return localAgents;
  const preferred = localAgents.find((agent) => agent._id === agentId);
  if (!preferred) return [];
  return [preferred, ...localAgents.filter((agent) => agent._id !== preferred._id)];
}

function extractRunIdFromCreate(response: unknown): string | undefined {
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) {
    const runId = (response as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId.length > 0) return runId;
  }
  return undefined;
}

async function createDisposableRun(input: {
  roomId: string;
  agentId: string;
  goal: string;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
}): Promise<string> {
  const created = await input.apiPost<unknown>(`/api/rooms/${input.roomId}/agent-runs`, {
    agentId: input.agentId,
    goal: input.goal,
  });
  const runId = extractRunIdFromCreate(created);
  if (!runId) {
    throw new Error("create response did not include runId");
  }
  return runId;
}

async function runDisposableMutationScenario(input: {
  roomId: string;
  agents: AgentRecord[];
  mutationAgentId?: string;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  apiDelete: <T = unknown>(path: string) => Promise<T>;
  date: Date;
}): Promise<TuiLiveQaCheck> {
  const agent = findMutationAgent(input.agents, input.mutationAgentId);
  if (!agent) {
    return liveCheck(
      "mutation-disposable-run",
      "creates, pauses, resumes, and cancels a disposable local bridge run",
      "skip",
      input.mutationAgentId
        ? `agent ${input.mutationAgentId} is not a local bridge agent`
        : "no local bridge agent is available in this room",
    );
  }

  let runId: string | undefined;
  let handoffRunId: string | undefined;
  const markers: string[] = [];
  try {
    const stamp = input.date.toISOString();
    runId = await createDisposableRun({
      roomId: input.roomId,
      agentId: agent._id,
      goal: `[co-od live QA disposable] create/pause/resume/cancel ${stamp}`,
      apiPost: input.apiPost,
    });
    markers.push(`created ${runId}`);

    const paused = await input.apiPost<{ status?: string }>(`/api/rooms/${input.roomId}/agent-runs/${runId}/pause`, {});
    if (paused.status !== "paused") {
      throw new Error(`pause returned ${paused.status || "unknown status"}`);
    }
    markers.push("paused");

    const resumed = await input.apiPost<{ runId?: string; continued?: boolean }>(`/api/rooms/${input.roomId}/agent-runs`, {
      agentId: agent._id,
      goal: "[co-od live QA disposable] resume paused run",
      continueRunId: runId,
    });
    if (resumed.runId !== runId || resumed.continued !== true) {
      throw new Error("resume continuation did not target the paused run");
    }
    markers.push("resumed");

    const handoff = await input.apiPost<{ newRunId?: string }>(`/api/rooms/${input.roomId}/agent-runs/${runId}/handoff`, {
      targetAgentId: agent._id,
      context: "[co-od live QA disposable] handoff smoke",
      goal: "[co-od live QA disposable] handoff child run",
    });
    handoffRunId = handoff.newRunId;
    if (!handoffRunId) {
      throw new Error("handoff response did not include newRunId");
    }
    markers.push(`handoff ${handoffRunId}`);
    await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${handoffRunId}`);
    markers.push("handoff cancelled");
    handoffRunId = undefined;

    await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${runId}`);
    markers.push("cancelled");
    runId = undefined;

    return liveCheck(
      "mutation-disposable-run",
      "creates, pauses, resumes, and cancels a disposable local bridge run",
      "pass",
      `${agent._id}: ${markers.join(", ")}`,
    );
  } catch (error) {
    if (handoffRunId) {
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${handoffRunId}`).catch(() => null);
      markers.push("handoff cleanup attempted");
    }
    if (runId) {
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${runId}`).catch(() => null);
      markers.push("cleanup attempted");
    }
    const detail = error instanceof Error ? error.message : String(error);
    return liveCheck(
      "mutation-disposable-run",
      "creates, pauses, resumes, and cancels a disposable local bridge run",
      "fail",
      markers.length > 0 ? `${markers.join(", ")}; ${detail}` : detail,
    );
  }
}

async function runDisposablePatchScenario(input: {
  roomId: string;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  date: Date;
}): Promise<TuiLiveQaCheck> {
  const stamp = input.date.toISOString();
  const markers: string[] = [];
  try {
    const accepted = await input.apiPost<{ patchId?: string }>(`/api/rooms/${input.roomId}/patches`, {
      title: `[co-od live QA disposable] accept ${stamp}`,
      diffText: "co-od-live-qa-intentionally-invalid-diff",
      path: ".co-od-live-qa/noop.txt",
    });
    if (!accepted.patchId) {
      throw new Error("accept patch create response did not include patchId");
    }
    markers.push(`created accept ${accepted.patchId}`);
    const acceptResult = await input.apiPost<{ patchId?: string }>(`/api/rooms/${input.roomId}/patches/${accepted.patchId}/accept`, {});
    if (acceptResult.patchId !== accepted.patchId) {
      throw new Error("accept response did not match created patch");
    }
    markers.push("accepted");

    const rejected = await input.apiPost<{ patchId?: string }>(`/api/rooms/${input.roomId}/patches`, {
      title: `[co-od live QA disposable] reject ${stamp}`,
      diffText: "co-od-live-qa-intentionally-invalid-diff",
      path: ".co-od-live-qa/noop.txt",
    });
    if (!rejected.patchId) {
      throw new Error("reject patch create response did not include patchId");
    }
    markers.push(`created reject ${rejected.patchId}`);
    const rejectResult = await input.apiPost<{ patchId?: string }>(`/api/rooms/${input.roomId}/patches/${rejected.patchId}/reject`, {
      reason: "Rejected by co-od live QA disposable mutation scenario",
    });
    if (rejectResult.patchId !== rejected.patchId) {
      throw new Error("reject response did not match created patch");
    }
    markers.push("rejected");

    return liveCheck(
      "mutation-patch-review",
      "creates disposable patches and verifies accept/reject endpoints",
      "pass",
      markers.join(", "),
    );
  } catch (error) {
    return liveCheck(
      "mutation-patch-review",
      "creates disposable patches and verifies accept/reject endpoints",
      "fail",
      markers.length > 0
        ? `${markers.join(", ")}; ${error instanceof Error ? error.message : String(error)}`
        : error instanceof Error ? error.message : String(error),
    );
  }
}

async function runDisposableRetryScenario(input: {
  roomId: string;
  agents: AgentRecord[];
  mutationAgentId?: string;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  apiDelete: <T = unknown>(path: string) => Promise<T>;
  date: Date;
}): Promise<TuiLiveQaCheck> {
  const agent = findMutationAgent(input.agents, input.mutationAgentId);
  if (!agent) {
    return liveCheck(
      "mutation-retry",
      "creates a cancelled disposable run and retries it through a new local bridge run",
      "skip",
      input.mutationAgentId
        ? `agent ${input.mutationAgentId} is not a local bridge agent`
        : "no local bridge agent is available in this room",
    );
  }

  let sourceRunId: string | undefined;
  let retryRunId: string | undefined;
  const markers: string[] = [];
  try {
    const stamp = input.date.toISOString();
    const goal = `[co-od live QA disposable] retry source ${stamp}`;
    sourceRunId = await createDisposableRun({
      roomId: input.roomId,
      agentId: agent._id,
      goal,
      apiPost: input.apiPost,
    });
    markers.push(`source ${sourceRunId}`);
    await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${sourceRunId}`);
    markers.push("source cancelled");
    sourceRunId = undefined;

    retryRunId = await createDisposableRun({
      roomId: input.roomId,
      agentId: agent._id,
      goal,
      apiPost: input.apiPost,
    });
    markers.push(`retry ${retryRunId}`);
    await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${retryRunId}`);
    markers.push("retry cancelled");
    retryRunId = undefined;

    return liveCheck(
      "mutation-retry",
      "creates a cancelled disposable run and retries it through a new local bridge run",
      "pass",
      `${agent._id}: ${markers.join(", ")}`,
    );
  } catch (error) {
    if (retryRunId) {
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${retryRunId}`).catch(() => null);
      markers.push("retry cleanup attempted");
    }
    if (sourceRunId) {
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${sourceRunId}`).catch(() => null);
      markers.push("source cleanup attempted");
    }
    const detail = error instanceof Error ? error.message : String(error);
    return liveCheck(
      "mutation-retry",
      "creates a cancelled disposable run and retries it through a new local bridge run",
      "fail",
      markers.length > 0 ? `${markers.join(", ")}; ${detail}` : detail,
    );
  }
}

async function runDisposableFanoutScenario(input: {
  roomId: string;
  agents: AgentRecord[];
  mutationAgentId?: string;
  apiPost: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  apiDelete: <T = unknown>(path: string) => Promise<T>;
  date: Date;
}): Promise<TuiLiveQaCheck> {
  const targets = findMutationAgents(input.agents, input.mutationAgentId).slice(0, 3);
  if (targets.length < 2) {
    return liveCheck(
      "mutation-fanout",
      "fans one disposable prompt out to multiple local bridge agents and cancels the runs",
      "skip",
      input.mutationAgentId
        ? `agent ${input.mutationAgentId} did not leave at least two local bridge targets`
        : "fewer than two local bridge agents are available in this room",
    );
  }

  const runIds: string[] = [];
  const markers: string[] = [];
  try {
    const stamp = input.date.toISOString();
    const goal = `[co-od live QA disposable] fanout ${stamp}`;
    for (const agent of targets) {
      const runId = await createDisposableRun({
        roomId: input.roomId,
        agentId: agent._id,
        goal,
        apiPost: input.apiPost,
      });
      runIds.push(runId);
      markers.push(`${agent._id}:${runId}`);
    }
    while (runIds.length > 0) {
      const runId = runIds.pop()!;
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${runId}`);
    }
    markers.push("cancelled");
    return liveCheck(
      "mutation-fanout",
      "fans one disposable prompt out to multiple local bridge agents and cancels the runs",
      "pass",
      markers.join(", "),
    );
  } catch (error) {
    while (runIds.length > 0) {
      const runId = runIds.pop()!;
      await input.apiDelete(`/api/rooms/${input.roomId}/agent-runs/${runId}`).catch(() => null);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return liveCheck(
      "mutation-fanout",
      "fans one disposable prompt out to multiple local bridge agents and cancels the runs",
      "fail",
      markers.length > 0 ? `${markers.join(", ")}; ${detail}` : detail,
    );
  }
}

export async function buildTuiLiveQaReport(options: BuildTuiLiveQaReportOptions): Promise<TuiLiveQaReport> {
  const checkedAt = (options.date || new Date()).toISOString();
  const checks: TuiLiveQaCheck[] = [];
  const config = readProjectConfig(options.dir, options.roomId);
  const projectState = "projectState" in options
    ? options.projectState
    : loadTuiProjectState({ projectDir: options.dir });
  const roomId = options.roomId || config?.roomId || projectState?.selectedRoomId;
  const roomSource = options.roomId ? "--room" : config?.roomId ? ".co-od.json" : projectState?.selectedRoomId ? "persisted TUI state" : "none";
  const session = options.getSession?.() || null;
  const apiGet = options.apiGet;
  const apiPost = options.apiPost;
  const apiDelete = options.apiDelete;
  const fetchImpl = options.fetchImpl || fetch;
  const bridgeUrl = options.bridgeUrl || defaultLocalBridgeUrl();

  checks.push(
    isValidSession(session)
      ? liveCheck("session-auth", "finds a valid cached login session", "pass", `expires ${new Date(session.expiresAt).toISOString()}`)
      : liveCheck("session-auth", "finds a valid cached login session", "fail", "run `co-od login` before live QA"),
  );

  checks.push(
    roomId
      ? liveCheck("room-config", "resolves a target room from --room, .co-od.json, or persisted TUI state", "pass", `${roomId} via ${roomSource}`)
      : liveCheck("room-config", "resolves a target room from --room, .co-od.json, or persisted TUI state", "fail", "pass --room <id>, run inside a configured project, or open a room in the TUI first"),
  );

  try {
    const health = await fetchServiceHealth(options.serverUrl, fetchImpl);
    const serviceSummary = summarizeServices(health.services);
    const missingSummary = summarizeMissingLiveServices(health.services);
    const detail = missingSummary ? `${serviceSummary}; ${missingSummary}` : serviceSummary;
    checks.push(
      hasReachableWeb(health.services) && hasRequiredLiveServices(health.services)
        ? liveCheck("service-health", "loads live service health from the configured server", "pass", detail)
        : liveCheck("service-health", "loads live service health from the configured server", "fail", detail),
    );
  } catch (error) {
    checks.push(liveCheck("service-health", "loads live service health from the configured server", "fail", error instanceof Error ? error.message : String(error)));
  }

  let agents: AgentRecord[] = [];
  let runs: AgentRunRecord[] = [];
  let runtimeStatus: TuiEnvStatusResponse | undefined;

  if (isValidSession(session) && roomId && apiGet) {
    try {
      const rooms = await loadRoomsData({ apiGet });
      const found = rooms.rooms.some((room) => room._id === roomId);
      checks.push(
        found
          ? liveCheck("rooms-list", "confirms the room appears in the authenticated room list", "pass", `${rooms.rooms.length} rooms visible`)
          : liveCheck("rooms-list", "confirms the room appears in the authenticated room list", "fail", `room ${roomId} was not returned from /api/rooms`),
      );
    } catch (error) {
      checks.push(liveCheck("rooms-list", "confirms the room appears in the authenticated room list", "fail", error instanceof Error ? error.message : String(error)));
    }

    try {
      const dashboard = await loadRoomDashboardData({ roomId, apiGet });
      agents = dashboard.agents;
      runs = dashboard.runs;
      checks.push(
        dashboard.error
          ? liveCheck("room-dashboard", "loads live room agents and recent runs", "fail", dashboard.error)
          : liveCheck("room-dashboard", "loads live room agents and recent runs", "pass", `${agents.length} agents, ${runs.length} runs`),
      );
    } catch (error) {
      checks.push(liveCheck("room-dashboard", "loads live room agents and recent runs", "fail", error instanceof Error ? error.message : String(error)));
    }

    const runId = firstRunId(runs);
    if (runId) {
      try {
        const detail = await loadRunDetailData({ roomId, runId, apiGet });
        checks.push(liveCheck("run-detail", "loads a real run detail, patch list, and run timeline", "pass", `${detail.run._id}: ${detail.patches.length} patches, ${detail.allRuns.length} timeline runs`));
      } catch (error) {
        checks.push(liveCheck("run-detail", "loads a real run detail, patch list, and run timeline", "fail", error instanceof Error ? error.message : String(error)));
      }
    } else {
      checks.push(liveCheck("run-detail", "loads a real run detail, patch list, and run timeline", "skip", "no recent runs in this room"));
    }

    checks.push(describeLifecycleCandidates(agents, runs));
    checks.push(await describeApprovalBroker({ agents, bridgeUrl, fetchImpl }));

    const runtime = await describeRuntimeStatus({ roomId, apiGet });
    runtimeStatus = runtime.status;
    checks.push(runtime.check);

    if (options.allowMutations) {
      if (apiPost) {
        checks.push(await runRuntimeLifecycleScenario({
          roomId,
          initialStatus: runtimeStatus,
          apiPost,
          date: options.date || new Date(),
        }));
      } else {
        checks.push(liveCheck(
          "mutation-runtime-lifecycle",
          "starts, touches, and safely stops a disposable hosted runtime lease",
          "fail",
          "missing mutation API client",
        ));
      }

      if (apiPost && apiDelete) {
        checks.push(await runDisposableMutationScenario({
          roomId,
          agents,
          mutationAgentId: options.mutationAgentId,
          apiPost,
          apiDelete,
          date: options.date || new Date(),
        }));
        checks.push(await runDisposablePatchScenario({
          roomId,
          apiPost,
          date: options.date || new Date(),
        }));
        checks.push(await runDisposableRetryScenario({
          roomId,
          agents,
          mutationAgentId: options.mutationAgentId,
          apiPost,
          apiDelete,
          date: options.date || new Date(),
        }));
        checks.push(await runDisposableFanoutScenario({
          roomId,
          agents,
          mutationAgentId: options.mutationAgentId,
          apiPost,
          apiDelete,
          date: options.date || new Date(),
        }));
      } else {
        checks.push(liveCheck(
          "mutation-disposable-run",
          "creates, pauses, resumes, and cancels a disposable local bridge run",
          "fail",
          "missing mutation API clients",
        ));
        checks.push(liveCheck(
          "mutation-patch-review",
          "creates disposable patches and verifies accept/reject endpoints",
          "fail",
          "missing mutation API clients",
        ));
        checks.push(liveCheck(
          "mutation-retry",
          "creates a cancelled disposable run and retries it through a new local bridge run",
          "fail",
          "missing mutation API clients",
        ));
        checks.push(liveCheck(
          "mutation-fanout",
          "fans one disposable prompt out to multiple local bridge agents and cancels the runs",
          "fail",
          "missing mutation API clients",
        ));
      }
    } else {
      checks.push(liveCheck(
        "mutation-runtime-lifecycle",
        "starts, touches, and safely stops a disposable hosted runtime lease",
        "skip",
        "disabled; pass --mutate to start, touch, and safely clean up a hosted runtime lease",
      ));
      checks.push(liveCheck(
        "mutation-disposable-run",
        "creates, pauses, resumes, and cancels a disposable local bridge run",
        "skip",
        "disabled; pass --mutate to create and clean up a disposable run",
      ));
      checks.push(liveCheck(
        "mutation-patch-review",
        "creates disposable patches and verifies accept/reject endpoints",
        "skip",
        "disabled; pass --mutate to create marked disposable patch records",
      ));
      checks.push(liveCheck(
        "mutation-retry",
        "creates a cancelled disposable run and retries it through a new local bridge run",
        "skip",
        "disabled; pass --mutate to create and clean up disposable retry runs",
      ));
      checks.push(liveCheck(
        "mutation-fanout",
        "fans one disposable prompt out to multiple local bridge agents and cancels the runs",
        "skip",
        "disabled; pass --mutate to create and clean up disposable fan-out runs",
      ));
    }

    if (options.includeTerminal !== false) {
      try {
        const realtime = await createRealtimeSession({
          serverUrl: options.serverUrl,
          roomId,
          sessionToken: session.sessionToken,
          fetchImpl,
        });
        checks.push(liveCheck("terminal-session", "creates a real room terminal realtime session", "pass", realtime.terminalWsUrl));
      } catch (error) {
        checks.push(liveCheck("terminal-session", "creates a real room terminal realtime session", "fail", error instanceof Error ? error.message : String(error)));
      }
    } else {
      checks.push(liveCheck("terminal-session", "creates a real room terminal realtime session", "skip", "disabled with --skip-terminal"));
    }
  } else {
    const reason = !isValidSession(session)
      ? "missing valid login session"
      : !roomId
        ? "missing target room"
        : "missing API client";
    checks.push(liveCheck("rooms-list", "confirms the room appears in the authenticated room list", "skip", reason));
    checks.push(liveCheck("room-dashboard", "loads live room agents and recent runs", "skip", reason));
    checks.push(liveCheck("run-detail", "loads a real run detail, patch list, and run timeline", "skip", reason));
    checks.push(liveCheck("lifecycle-candidates", "detects real local bridge pause/resume candidates without mutating them", "skip", reason));
    checks.push(liveCheck("approval-broker", "verifies local Codex approval broker readiness without resolving approvals", "skip", reason));
    checks.push(liveCheck("runtime-status", "loads live hosted runtime status without mutating it", "skip", reason));
    checks.push(liveCheck("mutation-runtime-lifecycle", "starts, touches, and safely stops a disposable hosted runtime lease", "skip", reason));
    checks.push(liveCheck("mutation-disposable-run", "creates, pauses, resumes, and cancels a disposable local bridge run", "skip", reason));
    checks.push(liveCheck("mutation-patch-review", "creates disposable patches and verifies accept/reject endpoints", "skip", reason));
    checks.push(liveCheck("mutation-retry", "creates a cancelled disposable run and retries it through a new local bridge run", "skip", reason));
    checks.push(liveCheck("mutation-fanout", "fans one disposable prompt out to multiple local bridge agents and cancels the runs", "skip", reason));
    checks.push(liveCheck("terminal-session", "creates a real room terminal realtime session", "skip", reason));
  }

  return {
    ok: checks.every((item) => item.status !== "fail"),
    checkedAt,
    roomId,
    serverUrl: options.serverUrl,
    checks,
  };
}

export function formatTuiLiveQaReport(report: TuiLiveQaReport): string {
  const pass = report.checks.filter((check) => check.status === "pass").length;
  const fail = report.checks.filter((check) => check.status === "fail").length;
  const skip = report.checks.filter((check) => check.status === "skip").length;
  const lines = [
    `co-od live TUI QA ${report.ok ? "passed" : "failed"}`,
    `Checked: ${report.checkedAt}`,
    `Server: ${report.serverUrl}`,
    `Room: ${report.roomId || "(not resolved)"}`,
    `Summary: ${pass} passed, ${fail} failed, ${skip} skipped`,
    "",
  ];
  for (const item of report.checks) {
    const prefix = item.status === "pass" ? "OK " : item.status === "skip" ? "SKP" : "ERR";
    lines.push(`${prefix} ${item.id} - ${item.description}${item.detail ? ` (${item.detail})` : ""}`);
  }
  const nextSteps = liveQaNextStepLines(report);
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:", ...nextSteps.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

function liveQaNextStepLines(report: TuiLiveQaReport): string[] {
  if (report.ok) return [];
  const failed = new Set(report.checks.filter((check) => check.status === "fail").map((check) => check.id));
  const lines: string[] = [];
  if (failed.has("session-auth")) {
    lines.push("Run `co-od login`, then rerun `pnpm qa:tui:live`.");
  }
  if (failed.has("room-config")) {
    lines.push("Run inside a project with `.co-od.json`, run `co-od init`, open a room in the TUI, or pass `--room <room-id>`.");
  }
  if (failed.has("service-health")) {
    lines.push("Check the target server health or pass `--server <url>` for the intended environment.");
  }
  const roomChecks = ["rooms-list", "room-dashboard", "run-detail", "approval-broker", "runtime-status", "terminal-session"];
  if (roomChecks.some((id) => failed.has(id))) {
    lines.push("Confirm the authenticated user can access the room and that room services are reachable.");
  }
  const mutationChecks = ["mutation-runtime-lifecycle", "mutation-disposable-run", "mutation-patch-review", "mutation-retry", "mutation-fanout"];
  if (mutationChecks.some((id) => failed.has(id))) {
    lines.push("Use `pnpm qa:tui:live:mutate` only in a disposable beta room with local bridge agents available.");
  }
  return lines;
}
