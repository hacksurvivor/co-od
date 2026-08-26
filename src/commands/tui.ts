import { createInterface, emitKeypressEvents } from "node:readline";
import { randomUUID } from "node:crypto";
import * as api from "../api-client.js";
import type { ProviderSessionContext } from "../adapters/base.js";
import { type RoomTerminalSession } from "../connect.js";
import {
  applyRoomDashboardCache,
  createRoomDashboardCache,
  dashboardCachePolicyFromEnv,
  formatDashboardCachePolicy,
  formatServiceHealth,
  loadRunDetailData,
  loadRoomDashboardData,
  loadTuiDashboardState,
  readProjectConfig,
  resolveRunPatch,
  restoreServerUndoChanges,
  type AgentRecord,
  type DashboardCachePolicy,
  type CachedRoomDashboard,
  type DashboardData,
  type ProjectConfig,
  type RoomRecord,
  type ServiceHealth,
} from "../tui-dashboard.js";
import {
  addAttachment,
  attachmentLabel,
  attachmentSummary,
  attachmentTransportSummary,
  formatGoalWithAttachments,
  removeAttachment,
  resolveAttachmentTransport,
  type TuiAttachment,
  type TuiAttachmentTransport,
} from "../tui-attachments.js";
import {
  buildAgentActivityRows,
  type AgentActivityState,
  type AgentSemanticState,
} from "../tui-agent-activity.js";
import {
  resolveAgentPauseCommand,
  resolveAgentResumeCommand,
  resolveAgentStartCommand,
  resolveAgentStopCommand,
} from "../tui-agent-actions.js";
import {
  buildActions,
  parseSlashCommand,
  resolveMenuKey,
  resolvePaletteKey,
  resolveRunKey,
  resolveTaskKey,
  slashHelpText,
  type Action,
  type KeyInfo,
} from "../tui-actions.js";
import {
  createConfirmation,
  resolveConfirmationKey,
  type TuiConfirmation,
} from "../tui-confirmation.js";
import {
  bridgeApprovalDetailLines,
  bridgeApprovalTarget,
  bridgeApprovalTitle,
  defaultLocalBridgeUrl,
  parseBridgeApprovalSseBlock,
  respondToBridgeApproval,
  type BridgeApprovalDecision,
  type BridgeApprovalRequest,
} from "../tui-bridge-approvals.js";
import {
  taskComposerLines,
} from "../tui-composer.js";
import { buildDoctorReport, formatDoctorReport } from "./doctor.js";
import {
  buildTuiLiveQaReport,
  buildTuiQaReport,
  formatTuiLiveQaReport,
  formatTuiQaReport,
  resolveTuiQaSlashCommand,
} from "../tui-qa.js";
import {
  taskContextSummary,
} from "../tui-context.js";
import {
  buildDelegationRows,
  classifyDiffLine,
  compact,
  diffStat,
  formatStepDescription,
  resolveRunId,
  shortId,
  type AgentRunRecord,
  type AgentRunStepRecord,
  type PatchRecord,
  type RunDetailData,
} from "../tui-model.js";
import { runTuiTask, type TuiTaskEvent } from "../tui-task.js";
import {
  providerStatus,
  resolveLocalProviderForAgent,
  resolveModelCommand,
  resolveProviderCommand,
  TUI_PROVIDERS as PROVIDERS,
} from "../tui-provider.js";
import {
  buildPaletteItems,
  filterPaletteItems,
  slashCommandSuggestions,
  type PaletteItem,
  type SlashCommandSuggestion,
} from "../tui-palette.js";
import {
  resolveFanoutCommand,
  type FanoutTarget,
} from "../tui-fanout.js";
import {
  executeRoomHandoff,
  resolveHandoffCommand,
} from "../tui-handoff.js";
import {
  cycleHandoffTarget,
  formatHandoffPrefill,
  handoffTargetLabel,
  resolveHandoffTarget,
  handoffTargetSummary,
} from "../tui-handoff-targets.js";
import {
  diagnosticsRequestLabel,
  loadWorkspaceDiagnostics,
  type TypeScriptDiagnosticResult,
} from "../tui-diagnostics.js";
import {
  formatEnvMutation,
  formatEnvStatus,
  resolveEnvCommand,
  type TuiEnvAction,
  type TuiEnvMutationResponse,
  type TuiEnvStatusResponse,
} from "../tui-env.js";
import {
  applyRename,
  loadRenamePreview,
  loadSymbolNavigation,
  loadWorkspaceSymbols,
  type TuiSymbol,
  type TuiRenameOccurrence,
} from "../tui-symbols.js";
import {
  fileMentionAttachmentsChanged,
  resolveFileMentionAttachments,
} from "../tui-file-mentions.js";
import {
  instructionSummary,
  loadProjectInstructions,
  type ProjectInstructions,
} from "../tui-instructions.js";
import {
  loadProjectMemory,
  memorySummary,
  type ProjectMemory,
} from "../tui-memory.js";
import {
  formatTaskHistory,
  resolveTaskHistoryItem,
} from "../tui-history.js";
import {
  collectProviderSessions,
  formatProviderSessions,
  providerSessionStatusForRun,
  resolveProviderSession,
} from "../tui-sessions.js";
import {
  emptyPins,
  isPinnedAgent,
  isPinnedProvider,
  isPinnedRoom,
  pinAgent,
  pinProvider,
  pinRoom,
  pinSummaryLines,
  unpinTarget,
  type PinTarget,
  type TuiPins,
} from "../tui-pins.js";
import {
  loadTuiProjectState,
  normalizeSafetyAudit,
  normalizeTaskHistory,
  saveTuiProjectState,
} from "../tui-persistence.js";
import {
  resolveContinueCommand,
  resolveForkCommand,
  resolveResumeCommand,
  resolveRetryCommand,
  resolveRerunCommand,
  resolveStopCommand,
} from "../tui-run-actions.js";
import {
  formatRunCopyText,
  type RunCopyKind,
  writeClipboardText,
  writeRunSummaryExport,
} from "../tui-run-export.js";
import {
  createSafetyState,
  evaluateSafetyActionApproval,
  evaluateTaskApproval,
  safetyLines,
  safetySummary,
  toggleSafety,
  type TuiSafetyAction,
  type TuiSafetyState,
} from "../tui-safety.js";
import {
  formatTuiScrollbackSearch,
  searchTuiScrollback,
} from "../tui-scrollback-search.js";
import {
  appendTerminalOutputLines,
  connectTuiTerminal,
  createTerminalConnectionState,
  reduceTerminalConnectionState,
  resolveTerminalPaneSize,
  type TuiTerminalConnectionState,
  type TuiTerminalEvent,
} from "../tui-terminal.js";
import {
  createStartupTimer,
  evaluateStartupBudget,
  formatStartupTiming,
  type TuiStartupTiming,
  type TuiStartupTimer,
} from "../tui-startup.js";
import {
  isPrimaryMousePress,
  parseSgrMouse,
  type TuiMouseEvent,
} from "../tui-mouse.js";
import {
  formatWorkspaceFilePreview,
  listWorkspaceFiles,
  loadWorkspaceFilePreview,
  loadWorkspaceDiff,
  loadWorkspaceContext,
  searchWorkspaceText,
  type WorkspaceDiffResult,
  type WorkspaceContext,
  type WorkspaceFileChange,
  type WorkspaceSearchMatch,
} from "../tui-workspace.js";
import {
  createUndoSnapshot,
  pushUndoSnapshot,
  restoreFileUndoChanges,
  restoreUndoSnapshot,
  type TuiUndoSnapshot,
} from "../tui-undo.js";
import {
  fitAnsi,
  padAnsi,
  renderTerminalFrame,
  stripAnsi,
} from "../tui-render.js";
import { tuiColor as color } from "../tui-theme.js";

interface ParsedArgs {
  dir: string;
  roomId?: string;
  provider?: string;
  server?: string;
  smokeTest?: boolean;
  durationMs?: number;
  startupProfile?: boolean;
  startupBudgetMs?: number;
}

type FeedKind = "info" | "output" | "success" | "warning" | "error";

interface FeedEntry {
  kind: FeedKind;
  text: string;
  createdAt: number;
}

type PendingConfirmation = {
  prompt: TuiConfirmation;
  returnMode: CoOdMode;
  onConfirm: () => Promise<void> | void;
  onCancel?: () => Promise<void> | void;
};

type CoOdMode = "menu" | "task" | "terminal" | "run" | "palette" | "help" | "confirm";

type ActionMouseHitbox = {
  actionIndex: number;
  row: number;
  startColumn: number;
  endColumn: number;
};

const EMPTY_WORKSPACE: WorkspaceContext = {
  isGitRepo: false,
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  insertions: 0,
  deletions: 0,
};

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dir: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (args[i] === "--smoke-test") {
      parsed.smokeTest = true;
    } else if (args[i] === "--duration-ms" && args[i + 1]) {
      parsed.durationMs = Math.max(0, Number(args[++i]) || 0);
    } else if (args[i] === "--startup-profile") {
      parsed.startupProfile = true;
    } else if (args[i] === "--startup-budget-ms" && args[i + 1]) {
      parsed.startupBudgetMs = Math.max(0, Number(args[++i]) || 0);
      parsed.startupProfile = true;
    } else if (!args[i].startsWith("--") && !parsed.roomId) {
      parsed.roomId = args[i];
    }
  }
  if (parsed.smokeTest && parsed.durationMs === undefined) parsed.durationMs = 250;
  return parsed;
}

function splitFeedText(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

function statusText(status?: string): string {
  if (!status) return color.dim("unknown");
  if (status === "running" || status === "succeeded" || status === "ok" || status === "healthy") {
    return color.green(status);
  }
  if (status === "failed" || status === "error" || status === "cancelled") {
    return color.yellow(status);
  }
  return status;
}

function serviceText(service?: ServiceHealth): string {
  const text = formatServiceHealth(service);
  if (text === "unknown") return color.dim(text);
  if (text.startsWith("ok")) {
    return `${color.green("ok")}${color.dim(text.slice(2))}`;
  }
  return color.yellow(text);
}

function formatAge(timestamp?: number): string {
  if (!timestamp) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "-";
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatTokenEstimate(tokens?: number): string {
  if (tokens === undefined) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k tok`;
  return `${tokens} tok`;
}

function agentStateText(state: AgentActivityState | AgentSemanticState): string {
  if (state === "working" || state === "running") return color.green("working");
  if (state === "queued") return color.yellow("queued");
  if (state === "blocked") return color.yellow("blocked");
  if (state === "failed" || state === "cancelled") return color.yellow(state);
  if (state === "review" || state === "succeeded") return color.dim("review");
  return color.dim("idle");
}

function formatAbsoluteTime(timestamp?: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
}

function formatIsoAge(timestamp?: string): string {
  if (!timestamp) return "-";
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? "-" : formatAge(value);
}

function diffLine(line: string): string {
  const kind = classifyDiffLine(line);
  if (kind === "meta") {
    return color.cyan(line);
  }
  if (kind === "add") return color.green(line);
  if (kind === "remove") return color.red(line);
  return line;
}

async function waitForEnter(): Promise<void> {
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPress Enter to return to co-od...", () => {
      rl.close();
      resolve();
    });
  });
}

class CoOdTerminalApp {
  private config: ProjectConfig | null = null;
  private session: ReturnType<typeof api.getSession> = null;
  private bridge: "running" | "offline" = "offline";
  private providerAvailability: Record<string, boolean> = {};
  private dashboard: DashboardData = { agents: [], runs: [], services: {} };
  private rooms: RoomRecord[] = [];
  private roomsError?: string;
  private dashboardCachePolicy: DashboardCachePolicy = dashboardCachePolicyFromEnv();
  private dashboardCache: CachedRoomDashboard | null = null;
  private workspace: WorkspaceContext = EMPTY_WORKSPACE;
  private feed: FeedEntry[] = [];
  private terminalSession: RoomTerminalSession | null = null;
  private terminalLines: string[] = [];
  private terminalState: TuiTerminalConnectionState = createTerminalConnectionState();
  private instructions: ProjectInstructions = { files: [] };
  private memoryContext: ProjectMemory = { files: [] };
  private diagnostics: TypeScriptDiagnosticResult = { diagnostics: [] };
  private runDetail: RunDetailData | null = null;
  private runDetailPatchIndex = 0;
  private taskRunning = false;
  private taskHistory: string[] = [];
  private taskHistoryIndex = -1;
  private taskAttachments: TuiAttachment[] = [];
  private lastRunId?: string;
  private selectedRoomId?: string;
  private selectedRoomName?: string;
  private selected = 0;
  private message = "Ready.";
  private mode: CoOdMode = "menu";
  private taskInput = "";
  private taskSuggestionSelected = 0;
  private paletteInput = "";
  private paletteSelected = 0;
  private paletteFiles: string[] = [];
  private paletteFilesError?: string;
  private provider: string;
  private model?: string;
  private selectedAgentId?: string;
  private handoffTargetAgentId?: string;
  private pins: TuiPins = emptyPins();
  private safety: TuiSafetyState = createSafetyState();
  private undoStack: TuiUndoSnapshot[] = [];
  private pendingConfirmation: PendingConfirmation | null = null;
  private bridgeApprovalAbort: AbortController | null = null;
  private activeBridgeApprovals = new Set<string>();
  private resolveDone: (() => void) | null = null;
  private keyHandler?: (chunk: string, key: KeyInfo) => void;
  private resizeHandler?: () => void;
  private stopped = false;
  private startupTimer: TuiStartupTimer = createStartupTimer();
  private actionMouseHitboxes: ActionMouseHitbox[] = [];

  constructor(private readonly args: ParsedArgs) {
    this.provider = args.provider || "opencode";
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.restorePersistedState();
      await this.printFallback();
      return;
    }

    this.restorePersistedState();
    this.applyInitialStartupState();
    this.startupTimer = createStartupTimer({ budgetMs: this.args.startupBudgetMs });
    this.message = "Loading dashboard, workspace, and room health...";
    this.addFeed("info", "Starting terminal workspace. Live room data is loading.");
    this.startTerminal();
    this.render();
    const firstPaintTiming = this.startupTimer.markFirstPaint();
    if (this.args.startupProfile) {
      this.addFeed("info", formatStartupTiming(firstPaintTiming));
      this.render();
    }
    if (this.applyStartupBudgetGate(firstPaintTiming)) {
      this.render();
    }
    void this.refreshAfterFirstPaint();
    if (this.args.smokeTest && this.args.durationMs !== undefined) {
      setTimeout(() => this.quit(), this.args.durationMs);
    }

    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private async refreshAfterFirstPaint(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.message = `Startup refresh failed: ${message}`;
      this.addFeed("error", this.message);
    }
    if (this.stopped) return;
    const refreshTiming = this.startupTimer.markRefreshComplete();
    if (this.args.startupProfile) {
      this.addFeed("info", formatStartupTiming(refreshTiming));
    }
    this.render();
  }

  private applyStartupBudgetGate(timing: TuiStartupTiming): boolean {
    if (this.args.startupBudgetMs === undefined) return false;

    const result = evaluateStartupBudget(timing);
    if (result.ok) {
      this.addFeed("success", result.message);
      return true;
    }

    this.addFeed("error", result.message);
    if (this.args.smokeTest) {
      process.exitCode = 1;
    }
    return true;
  }

  private async printFallback(): Promise<void> {
    await this.refresh();
    console.log("co-od terminal");
    console.log("=".repeat(40));
    console.log(`Project: ${this.args.dir}`);
    console.log(`Server:  ${api.getBaseUrl()}`);
    console.log(`Auth:    ${this.session ? "logged in" : "not logged in"}`);
    console.log(`Bridge:  ${this.bridge}`);
    console.log(`Room:    ${this.config?.roomId || "(not configured)"}`);
    console.log("");
    console.log("Run in an interactive terminal for the full TUI:");
    console.log("  co-od tui");
  }

  private restorePersistedState(): void {
    const state = loadTuiProjectState({ projectDir: this.args.dir });
    if (!state) return;
    this.taskHistory = normalizeTaskHistory(state.taskHistory || []);
    this.taskHistoryIndex = -1;
    if (!this.args.provider && state.provider) {
      this.provider = state.provider;
    }
    this.model = state.model;
    this.selectedRoomId = this.args.roomId || state.selectedRoomId;
    this.selectedRoomName = this.args.roomId ? undefined : state.selectedRoomName;
    this.selectedAgentId = state.selectedAgentId;
    this.lastRunId = state.lastRunId;
    this.taskAttachments = state.attachments || [];
    this.dashboardCache = state.dashboardCache || null;
    this.pins = state.pins || emptyPins();
    this.safety = {
      ...this.safety,
      audit: normalizeSafetyAudit(state.safetyAudit),
    };
  }

  private applyInitialStartupState(): void {
    if (this.args.server) {
      process.env.CO_ODE_SERVER = this.args.server;
    }

    const config = readProjectConfig(this.args.dir, this.args.roomId || this.selectedRoomId);
    if (config && this.selectedRoomId === config.roomId && this.selectedRoomName) {
      this.config = { ...config, roomName: this.selectedRoomName };
    } else {
      this.config = config;
    }

    this.session = api.getSession();
    if (!this.args.provider && this.config?.provider) {
      this.provider = this.config.provider;
    }
  }

  private persistState(): void {
    try {
      saveTuiProjectState({
        projectDir: this.args.dir,
        state: {
          taskHistory: this.taskHistory,
          selectedRoomId: this.config?.roomId || this.selectedRoomId,
          selectedRoomName: this.config?.roomName || this.selectedRoomName,
          provider: this.provider,
          model: this.model,
          selectedAgentId: this.selectedAgentId,
          lastRunId: this.lastRunId,
          attachments: this.taskAttachments,
          dashboardCache: this.dashboardCache || undefined,
          pins: this.pins,
          safetyAudit: this.safety.audit,
        },
      });
    } catch {
      // Persistence is best-effort; the TUI should keep working if the home dir is read-only.
    }
  }

  private startTerminal(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.keyHandler = (chunk, key) => void this.handleKey(chunk, key);
    process.stdin.on("keypress", this.keyHandler);
    this.resizeHandler = () => this.handleTerminalResize();
    process.stdout.on("resize", this.resizeHandler);
  }

  private stopTerminal(): void {
    if (this.keyHandler) {
      process.stdin.off("keypress", this.keyHandler);
      this.keyHandler = undefined;
    }
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler);
      this.resizeHandler = undefined;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  }

  private async refresh(): Promise<void> {
    const [state, workspace, instructions, memoryContext] = await Promise.all([
      loadTuiDashboardState({
        dir: this.args.dir,
        roomId: this.args.roomId || this.selectedRoomId,
        provider: this.args.provider,
        server: this.args.server,
        previousProvider: this.provider,
      }),
      loadWorkspaceContext(this.args.dir),
      Promise.resolve(loadProjectInstructions(this.args.dir)),
      Promise.resolve(loadProjectMemory(this.args.dir)),
    ]);
    this.config = state.config;
    if (this.config && this.selectedRoomId === this.config.roomId && this.selectedRoomName) {
      this.config = { ...this.config, roomName: this.selectedRoomName };
    }
    this.session = state.session;
    this.bridge = state.bridge;
    this.providerAvailability = state.providerAvailability;
    this.dashboard = state.dashboard;
    this.rooms = state.rooms;
    this.roomsError = state.roomsError;
    this.workspace = workspace;
    this.instructions = instructions;
    this.memoryContext = memoryContext;
    this.provider = state.provider;
    this.message = state.message;
    this.useCachedDashboardIfNeeded();
    this.validateSelectedAgent();
    this.validateHandoffTargetAgent();
    this.cacheDashboardIfFresh();

    if (this.feed.length === 0) {
      this.addFeed("info", "Terminal workspace ready. Run a task with [t].");
    }
  }

  private async loadRoomDashboard(): Promise<void> {
    if (!this.config?.roomId || !this.session) return;
    const roomData = await loadRoomDashboardData({ roomId: this.config.roomId });
    this.dashboard = {
      ...this.dashboard,
      agents: roomData.agents,
      runs: roomData.runs,
      error: roomData.error,
      cached: false,
      cachedAt: undefined,
      cacheReason: undefined,
    };
    this.message = roomData.error
      ? `Dashboard data unavailable: ${roomData.error}`
      : `Room refreshed: ${this.dashboard.agents.length} agents, ${this.dashboard.runs.length} recent tasks.`;
    this.useCachedDashboardIfNeeded();
    this.validateHandoffTargetAgent();
    this.cacheDashboardIfFresh();
  }

  private useCachedDashboardIfNeeded(): void {
    if (!this.config?.roomId) return;
    const next = applyRoomDashboardCache({
      dashboard: this.dashboard,
      cache: this.dashboardCache,
      roomId: this.config.roomId,
      reason: this.dashboard.error,
      policy: this.dashboardCachePolicy,
    });
    if (next === this.dashboard || !next.cached) return;
    this.dashboard = next;
    this.message = this.dashboard.cacheReason
      ? `Showing cached room data: ${this.dashboard.cacheReason}`
      : "Showing cached room data.";
  }

  private cacheDashboardIfFresh(): void {
    if (!this.config?.roomId || this.dashboard.cached || this.dashboard.error) return;
    const cache = createRoomDashboardCache({
      roomId: this.config.roomId,
      roomName: this.config.roomName,
      dashboard: this.dashboard,
    });
    if (!cache) {
      if (this.dashboardCache?.roomId === this.config.roomId) {
        this.dashboardCache = null;
        this.persistState();
      }
      return;
    }
    this.dashboardCache = cache;
    this.persistState();
  }

  private render = (): void => {
    const width = Math.max(60, process.stdout.columns || 80);
    const height = Math.max(20, process.stdout.rows || 24);
    const lines = this.buildLines(width, height);
    process.stdout.write(`\x1b[H${renderTerminalFrame(lines, width, height)}`);
  };

  private handleTerminalResize(): void {
    if (this.terminalSession) {
      const size = resolveTerminalPaneSize(process.stdout.columns, process.stdout.rows);
      this.terminalSession.resize(size.columns, size.rows);
    }
    this.render();
  }

  private buildLines(width: number, height: number): string[] {
    const rule = "-".repeat(width);
    const status = this.session ? color.green("logged in") : color.yellow("not logged in");
    const bridge =
      this.bridge === "running" ? color.green("running") : color.yellow("offline");
    const room = this.config?.roomName || this.config?.roomId || "(not configured)";
    const roomPin = isPinnedRoom(this.pins, this.config?.roomId) ? " [pin]" : "";
    const providerPin = isPinnedProvider(this.pins, this.provider) ? " [pin]" : "";
    const providerState = providerStatus(this.provider, this.providerAvailability);
    const providerAvailabilityText =
      providerState === "available"
        ? color.green("available")
        : providerState === "checking"
          ? color.dim("checking")
          : color.yellow("not found");
    const model = this.model ? `  Model ${this.model}` : "";
    const selectedAgent = this.selectedAgent();
    const agent = selectedAgent ? `  Agent ${compact(selectedAgent.name, shortId(selectedAgent._id))}` : "";

    const lines: string[] = [
      `${color.bold("co-od terminal")} ${color.dim("local-first room control")}`,
      color.dim(rule),
      `Room ${color.bold(`${room}${roomPin}`)}  Auth ${status}  Bridge ${bridge}`,
      `Provider ${this.provider}${providerPin} ${providerAvailabilityText}${model}${agent} ${color.dim("press p to cycle")}`,
      `Project ${this.args.dir}`,
      `Workspace ${this.workspaceSummary()}`,
      `Server ${api.getBaseUrl()}`,
      `Services ${this.serviceSummary()}`,
      `Safety ${this.safetySummaryLine()}`,
      `Status ${this.messageLine()}`,
      "",
    ];

    if (this.mode === "terminal") {
      lines.push(color.bold("Terminal Input"));
      lines.push(color.dim("Keys are sent to the shared shell. Ctrl+] returns to dashboard. Ctrl+C is sent to the shell."));
      lines.push("");
    } else if (this.mode === "run") {
      lines.push(color.bold("Run Detail"));
      lines.push(color.dim("number opens run. j/k patches. g/G first/last patch. [/] handoff target. h handoff. a accept. x reject. R retry failed. y/c copy. e export. r refresh. Esc/q back."));
      lines.push("");
      lines.push(...this.runDetailLines(width, Math.max(8, height - lines.length - 1)));
      return lines;
    } else if (this.mode === "palette") {
      lines.push(color.bold("Command Palette"));
      lines.push(`> ${this.paletteInput}${color.inverse(" ")}`);
      lines.push(color.dim("Type to filter. Enter executes. Up/down selects. Esc returns."));
      lines.push("");
      lines.push(...this.paletteLines(width, Math.max(8, height - lines.length - 1)));
      return lines;
    } else if (this.mode === "help") {
      lines.push(color.bold("Keyboard Help"));
      lines.push(color.dim("Esc, q, or Enter returns to the dashboard."));
      lines.push("");
      lines.push(...this.keyboardHelpLines());
      return lines;
    } else if (this.mode === "confirm") {
      lines.push(...this.confirmationLines(width));
      lines.push("");
    } else if (this.mode === "task") {
      lines.push(color.bold("Task"));
      lines.push(...taskComposerLines(this.taskInput, {
        width,
        cursor: color.inverse(" "),
        maxLines: Math.max(3, Math.min(8, Math.floor(height * 0.25))),
      }));
      if (this.taskAttachments.length > 0) {
        lines.push(color.dim(`Attached: ${this.taskAttachments.map((attachment) => attachmentLabel(attachment)).join(", ")}`));
      }
      lines.push(...this.taskSuggestionLines(width, 5));
      lines.push(color.dim(
        this.taskSuggestions().length > 0
          ? "Tab completes. Up/down chooses suggestions. Enter runs command. Esc cancels."
          : "Enter submits. Ctrl+J newline. Use @path to mention files/images. Esc cancels. Ctrl+U clears. Up/down walks history.",
      ));
      lines.push("");
    } else {
      lines.push(color.dim("Shortcuts: t task, Ctrl+P palette, Ctrl+F find, ? help, / command, v task detail, c connect, i init, l login, m rooms, o browser, f refresh, q quit."));
      lines.push("");
    }

    lines.push(...this.feedLines(width, Math.max(4, Math.min(8, Math.floor(height * 0.25)))));
    if (this.terminalSession || this.terminalLines.length > 0 || this.terminalState.connecting || this.terminalState.disconnectReason) {
      lines.push("");
      lines.push(...this.terminalPaneLines(width, Math.max(5, Math.min(9, Math.floor(height * 0.3)))));
    }
    lines.push("");
    const dashboardStartRow = lines.length + 1;
    lines.push(...this.dashboardLines(width));
    this.actionMouseHitboxes = this.actionMouseHitboxesForDashboard(width, dashboardStartRow);

    return lines;
  }

  private actionMouseHitboxesForDashboard(width: number, dashboardStartRow: number): ActionMouseHitbox[] {
    const columnWidth = width < 100 ? width : Math.floor(width * 0.42);
    return this.actions().map((_, index) => ({
      actionIndex: index,
      row: dashboardStartRow + 1 + index,
      startColumn: 1,
      endColumn: columnWidth,
    }));
  }

  private serviceSummary(): string {
    const services = this.dashboard.services;
    return [
      `runtime ${serviceText(services.runtimeGateway || services.orchestrator)}`,
      `terminal ${serviceText(services.terminal)}`,
      `collab ${serviceText(services.collab)}`,
      `web ${serviceText(services.web)}`,
    ].join("  ");
  }

  private workspaceSummary(): string {
    if (!this.workspace.isGitRepo) {
      return color.dim("not a git repo");
    }
    const branch = this.workspace.branch || "detached";
    const dirty = this.workspace.dirty
      ? color.yellow(`${this.workspace.changedFiles.length} files +${this.workspace.insertions}/-${this.workspace.deletions}`)
      : color.green("clean");
    const sync = [
      this.workspace.ahead > 0 ? `ahead ${this.workspace.ahead}` : "",
      this.workspace.behind > 0 ? `behind ${this.workspace.behind}` : "",
    ].filter(Boolean).join(", ");
    return `${branch} ${dirty}${sync ? color.dim(` ${sync}`) : ""}`;
  }

  private dashboardLines(width: number): string[] {
    const left = [
      color.bold("Actions"),
      ...this.actionLines(Math.max(36, Math.floor(width * 0.38))),
      "",
      color.bold("Project Config"),
      ...this.configLines(),
      "",
      color.bold("Pins"),
      ...this.pinPanelLines(),
      "",
      color.bold("Workspace"),
      ...this.workspaceLines(),
      "",
      color.bold("Instructions"),
      ...this.instructionLines(),
      "",
      color.bold("Memory"),
      ...this.memoryLines(),
      "",
      color.bold("Diagnostics"),
      ...this.diagnosticLines(),
      "",
      color.bold("Safety"),
      ...this.safetyPanelLines(),
    ];
    const right = [
      color.bold("Agents"),
      ...this.agentLines(),
      "",
      color.bold("Recent Runs"),
      ...this.runLines(),
    ];

    if (width < 100) {
      return [
        color.bold("Actions"),
        ...this.actionLines(width),
        "",
        color.bold("Project Config"),
        ...this.configLines(),
        "",
        color.bold("Pins"),
        ...this.pinPanelLines(),
        "",
        color.bold("Workspace"),
        ...this.workspaceLines(),
        "",
        color.bold("Instructions"),
        ...this.instructionLines(),
        "",
        color.bold("Memory"),
        ...this.memoryLines(),
        "",
        color.bold("Diagnostics"),
        ...this.diagnosticLines(),
        "",
        color.bold("Safety"),
        ...this.safetyPanelLines(),
        "",
        color.bold("Agents"),
        ...this.agentLines(),
        "",
        color.bold("Recent Runs"),
        ...this.runLines(),
      ];
    }

    return this.columns(left, right, Math.floor(width * 0.42), width - Math.floor(width * 0.42) - 3);
  }

  private actionLines(columnWidth: number): string[] {
    return this.actions().map((action, index) => {
      const selected = index === this.selected;
      const marker = selected ? ">" : " ";
      const key = `[${action.key}]`;
      const label = action.enabled ? action.label : color.dim(action.label);
      const hint = color.dim(action.hint);
      const line = `${marker} ${key.padEnd(4)} ${label} ${hint}`;
      return selected ? color.inverse(fitAnsi(line, columnWidth)) : line;
    });
  }

  private configLines(): string[] {
    const config = this.config;
    if (!config) return [color.yellow("No project config found."), color.dim("Use [i] init after login.")];
    return [
      `roomId   ${config.roomId}`,
      `name     ${compact(config.roomName)}`,
      `provider ${compact(config.provider || this.provider)}`,
      `server   ${compact(config.server || api.getBaseUrl())}`,
      `dir      ${compact(config.projectDir || this.args.dir)}`,
      `cache    ${formatDashboardCachePolicy(this.dashboardCachePolicy)}`,
    ];
  }

  private pinPanelLines(): string[] {
    return pinSummaryLines(this.pins);
  }

  private workspaceLines(): string[] {
    if (!this.workspace.isGitRepo) {
      return [
        color.dim("No git repository detected."),
        ...(this.workspace.error ? [color.dim(compact(this.workspace.error))] : []),
      ];
    }

    const lines = [
      `branch   ${compact(this.workspace.branch, "detached")}`,
      `state    ${this.workspace.dirty ? color.yellow("dirty") : color.green("clean")} ${color.dim(`${this.workspace.changedFiles.length} files`)}`,
      `sync     ${this.workspace.ahead || this.workspace.behind ? `${this.workspace.ahead} ahead, ${this.workspace.behind} behind` : "up to date"}`,
      `diff     +${this.workspace.insertions}/-${this.workspace.deletions}`,
      `changes  staged ${this.workspace.stagedCount}, unstaged ${this.workspace.unstagedCount}, untracked ${this.workspace.untrackedCount}`,
    ];

    for (const file of this.workspace.changedFiles.slice(0, 5)) {
      lines.push(`${file.status.padEnd(2)} ${compact(file.path)}`);
    }
    if (this.workspace.changedFiles.length > 5) {
      lines.push(color.dim(`... ${this.workspace.changedFiles.length - 5} more`));
    }
    return lines;
  }

  private instructionLines(): string[] {
    return instructionSummary(this.instructions, 4).map((line) => color.dim(line));
  }

  private memoryLines(): string[] {
    return memorySummary(this.memoryContext, 4).map((line) => color.dim(line));
  }

  private diagnosticLines(): string[] {
    if (this.diagnostics.error) {
      return [
        color.yellow(compact(this.diagnostics.error)),
        ...(this.diagnostics.projects && this.diagnostics.projects.length > 0
          ? [color.dim(`${this.diagnostics.projects.length} tsconfig files`)]
          : []),
      ];
    }

    if (!this.diagnostics.project) {
      return [color.dim("Not run. Use /diagnostics.")];
    }

    if (this.diagnostics.diagnostics.length === 0) {
      return [
        `${this.diagnostics.label || this.diagnostics.project} ${color.green("clean")}`,
      ];
    }

    return [
      `${this.diagnostics.label || this.diagnostics.project} ${color.yellow(`${this.diagnostics.diagnostics.length} issues`)}`,
      ...this.diagnostics.diagnostics.slice(0, 3).map((diagnostic) => color.dim(this.diagnosticLine(diagnostic))),
    ];
  }

  private safetySummaryLine(): string {
    const summary = safetySummary(this.safety, this.provider);
    if (this.safety.autoRun && !this.safety.autoApply && !this.safety.allowDangerousCommands) {
      return color.dim(summary);
    }
    return color.yellow(summary);
  }

  private safetyPanelLines(): string[] {
    return [
      ...safetyLines(this.safety, this.provider),
      `audit     ${this.safety.audit.length > 0 ? `${this.safety.audit.length} local events` : "none"}`,
    ];
  }

  private agentLines(): string[] {
    if (this.dashboard.error && !this.dashboard.cached) {
      return [color.yellow(this.dashboard.error)];
    }
    const prefix = this.dashboard.cached ? [color.yellow(`Cached ${formatIsoAge(this.dashboard.cachedAt)} ago${this.dashboard.cacheReason ? `: ${compact(this.dashboard.cacheReason)}` : ""}`)] : [];
    if (!this.config?.roomId && this.dashboard.agents.length === 0) {
      return [color.dim("Initialize a room to load agents.")];
    }
    if (!this.session && this.dashboard.agents.length === 0) {
      return [color.dim("Login to load agents.")];
    }
    if (this.dashboard.agents.length === 0) {
      return [...prefix, color.dim("No agents in this room.")];
    }
    const rows = buildAgentActivityRows({
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      providerAvailability: this.providerAvailability,
    });
    return [...prefix, ...rows.slice(0, 6).map((row) => this.agentActivityLine(row))];
  }

  private agentActivityLine(row: ReturnType<typeof buildAgentActivityRows>[number]): string {
    const pinned = isPinnedAgent(this.pins, row.agentId) ? "[pin] " : "";
    const heartbeat = row.heartbeatAgeMs === undefined ? "hb -" : `hb ${formatDuration(row.heartbeatAgeMs)}`;
    const elapsed = row.elapsedMs === undefined ? "time -" : `time ${formatDuration(row.elapsedMs)}`;
    const tokens = row.tokenEstimate === undefined ? "" : ` ${formatTokenEstimate(row.tokenEstimate)}`;
    const availability = this.agentAvailabilityText(row.availability);
    const reason = row.availabilityReason ? color.dim(` (${compact(row.availabilityReason, "")})`) : "";
    const run = row.runId ? `${shortId(row.runId)} ${compact(row.goal, "(no goal)")}` : "no runs";
    return `${pinned}${row.name} ${agentStateText(row.semanticState)} ${availability}${reason} ${color.dim(`${row.provider}/${row.executionMode}`)} ${color.dim(`${heartbeat} ${elapsed}${tokens}`)} ${run}`;
  }

  private agentAvailabilityText(availability: ReturnType<typeof buildAgentActivityRows>[number]["availability"]): string {
    if (availability === "available") return color.green("available");
    if (availability === "missing") return color.yellow("missing");
    if (availability === "unsupported") return color.yellow("unsupported");
    if (availability === "remote") return color.dim("remote");
    if (availability === "external") return color.dim("external");
    if (availability === "hosted") return color.dim("hosted");
    return color.dim("unknown");
  }

  private runLines(): string[] {
    if (!this.config?.roomId) {
      return [color.dim("Initialize a room to load runs.")];
    }
    if (!this.session) {
      return [color.dim("Login to load runs.")];
    }
    if (this.dashboard.runs.length === 0) {
      return [color.dim("No recent tasks.")];
    }
    return this.dashboard.runs.slice(0, 7).map((run) => {
      const status = statusText(run.status);
      const agent = this.agentName(run.agent_id);
      const age = formatAge(run.finished_at || run.started_at || run.created_at);
      const goal = compact(run.goal, "(no goal)");
      const stepCount = run.steps?.length ?? 0;
      const index = this.dashboard.runs.indexOf(run) + 1;
      const current = run._id === this.lastRunId ? color.dim(" last") : "";
      return `${color.dim(`[${index}]`)} ${status} ${color.dim(age.padStart(4))} ${agent}${current} ${color.dim(`${stepCount} steps`)} ${goal}`;
    });
  }

  private runDetailLines(width: number, maxLines: number): string[] {
    if (!this.runDetail) {
      return [color.dim("No run selected.")];
    }

    const run = this.runDetail.run;
    const patches = this.runDetail.patches;
    const selectedPatch = patches[this.runDetailPatchIndex];
    const lines: string[] = [
      `${color.bold(shortId(run._id))} ${statusText(run.status)} ${color.dim(run.execution_mode || "hosted_api")} ${color.dim(this.agentName(run.agent_id))}`,
      `Goal ${compact(run.goal, "(no goal)")}`,
      `Created ${formatAbsoluteTime(run.created_at)}  Started ${formatAbsoluteTime(run.started_at)}  Finished ${formatAbsoluteTime(run.finished_at)}`,
      `Links parent ${shortId(run.parent_run_id)}  root ${shortId(run.root_run_id)}  handoff ${shortId(run.handoff_from)}  role ${compact(run.subagent_role)}`,
      `Handoff target ${handoffTargetSummary(this.dashboard.agents, this.handoffTargetAgentId)} ${color.dim("[/] cycle, h prefill")}`,
    ];
    if (run.join_summary_md) {
      lines.push(`Join ${compact(run.join_summary_md)}`);
    }
    lines.push(
      "",
      color.bold(`Timeline (${run.steps?.length ?? 0})`),
    );

    const stepBudget = selectedPatch ? 6 : 10;
    const steps = (run.steps || []).slice(-stepBudget);
    if (steps.length === 0) {
      lines.push(color.dim("No steps recorded."));
    } else {
      for (const step of steps) {
        lines.push(fitAnsi(this.stepLine(step), width));
      }
    }

    lines.push("");
    lines.push(color.bold("Delegation"));
    lines.push(...this.delegationLines(run, this.runDetail.allRuns, width, 8));

    lines.push("");
    lines.push(color.bold(`Patches (${patches.length})`));
    if (patches.length === 0) {
      lines.push(color.dim("No patches attached to this run."));
    } else {
      for (let index = 0; index < Math.min(5, patches.length); index++) {
        const patch = patches[index];
        const marker = index === this.runDetailPatchIndex ? ">" : " ";
        const status = patch.status === "proposed" ? color.yellow("proposed") : statusText(patch.status);
        const line = `${marker} ${status} ${shortId(patch._id)} ${diffStat(patch.diff_text)} ${compact(patch.title, "(untitled)")} ${color.dim(compact(patch.path))}`;
        lines.push(index === this.runDetailPatchIndex ? color.inverse(fitAnsi(line, width)) : fitAnsi(line, width));
      }
    }

    if (selectedPatch) {
      lines.push("");
      lines.push(color.bold(`Diff Preview ${shortId(selectedPatch._id)} ${diffStat(selectedPatch.diff_text)}`));
      for (const line of (selectedPatch.diff_text || "").split("\n").slice(0, 14)) {
        lines.push(fitAnsi(diffLine(line), width));
      }
    }

    return lines.slice(0, maxLines);
  }

  private stepLine(step: AgentRunStepRecord): string {
    const idx = typeof step.idx === "number" ? String(step.idx).padStart(2) : "--";
    const success = step.output?.success === false ? color.yellow("failed") : step.output?.success === true ? color.green("ok") : color.dim("-");
    const description = formatStepDescription(step);
    return `${color.dim(idx)} ${statusText(step.kind)} ${success} ${description}`;
  }

  private delegationLines(run: AgentRunRecord, allRuns: AgentRunRecord[], width: number, maxLines: number): string[] {
    const rows = buildDelegationRows(run, allRuns);
    if (rows.length <= 1 && !run.parent_run_id && !run.handoff_from) {
      return [color.dim("No subagents or handoffs recorded.")];
    }
    return rows.slice(0, maxLines).map((row) => fitAnsi(this.delegationRowLine(row), width));
  }

  private delegationRowLine(row: ReturnType<typeof buildDelegationRows>[number]): string {
    const prefix = row.depth === 0 ? "" : `${"   ".repeat(Math.max(0, row.depth - 1))}|- `;
    const relation = row.relation === "handoff" ? "handoff " : row.relation === "cycle" ? "cycle " : "";
    const runId = row.selected ? color.inverse(shortId(row.runId)) : shortId(row.runId);
    const role = row.role ? `/${row.role}` : "";
    return `${prefix}${relation}${runId} ${statusText(row.status)} ${color.dim(`${this.agentName(row.agentId)}${role}`)} ${compact(row.goal, "(no goal)")}`;
  }

  private feedLines(width: number, maxLines: number): string[] {
    const entries = this.feed.slice(-80).flatMap((entry) => {
      const timestamp = new Date(entry.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const marker = entry.kind === "output" ? "|" : entry.kind === "success" ? "OK" : entry.kind === "error" ? "ERR" : entry.kind === "warning" ? "!" : "*";
      return splitFeedText(entry.text).map((line, index) => {
        const prefix = index === 0 ? `${timestamp} ${marker.padEnd(3)}` : " ".repeat(12);
        const text = `${prefix} ${line}`;
        if (entry.kind === "success") return color.green(text);
        if (entry.kind === "error") return color.red(text);
        if (entry.kind === "warning") return color.yellow(text);
        if (entry.kind === "info") return color.dim(text);
        return text;
      });
    });
    const visible = entries.slice(-maxLines);
    return [
      color.bold("Feed"),
      ...(visible.length > 0 ? visible.map((line) => fitAnsi(line, width)) : [color.dim("No task output yet.")]),
    ];
  }

  private terminalPaneLines(width: number, maxLines: number): string[] {
    const status = this.terminalState.connected
      ? color.green("connected")
      : this.terminalState.connecting
        ? color.yellow("connecting")
        : color.yellow("disconnected");
    const action = this.terminalState.connected
      ? this.mode === "terminal" ? "input active" : "press c to focus"
      : this.terminalState.connecting
        ? "waiting for gateway"
        : "press c or /reconnect";
    const reason = this.terminalState.disconnectReason ? ` ${color.dim(`(${this.terminalState.disconnectReason})`)}` : "";
    const title = `${color.bold("Shared Terminal")} ${status}${reason} ${color.dim(action)}`;
    const visible = this.terminalLines.slice(-maxLines);
    return [
      title,
      ...(visible.length > 0 ? visible.map((line) => fitAnsi(line, width)) : [color.dim("No terminal output yet.")]),
    ];
  }

  private paletteItems(): PaletteItem[] {
    return buildPaletteItems({
      actions: this.actions(),
      providers: PROVIDERS,
      providerAvailability: this.providerAvailability,
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      room: this.config ? { roomId: this.config.roomId, roomName: this.config.roomName } : null,
      rooms: [
        ...this.pins.rooms,
        ...this.rooms.map((room) => ({ roomId: room._id, roomName: room.name })),
      ],
      files: this.paletteFiles,
      pins: this.pins,
    });
  }

  private filteredPaletteItems(): PaletteItem[] {
    return filterPaletteItems(this.paletteItems(), this.paletteInput, 12);
  }

  private taskSuggestions(limit = 6): SlashCommandSuggestion[] {
    if (this.mode !== "task") return [];
    return slashCommandSuggestions(this.taskInput, limit);
  }

  private selectedTaskSuggestion(): SlashCommandSuggestion | undefined {
    const suggestions = this.taskSuggestions();
    if (suggestions.length === 0) return undefined;
    const index = Math.min(Math.max(0, this.taskSuggestionSelected), suggestions.length - 1);
    return suggestions[index];
  }

  private taskSuggestionLines(width: number, maxLines: number): string[] {
    const suggestions = this.taskSuggestions(maxLines);
    if (suggestions.length === 0) return [];
    const selected = Math.min(Math.max(0, this.taskSuggestionSelected), suggestions.length - 1);
    return [
      color.dim("Commands"),
      ...suggestions.map((suggestion, index) => {
        const marker = index === selected ? ">" : " ";
        const line = `${marker} ${suggestion.command.padEnd(17)} ${color.dim(suggestion.detail)}`;
        return index === selected ? color.inverse(fitAnsi(line, width)) : fitAnsi(line, width);
      }),
    ];
  }

  private paletteLines(width: number, maxLines: number): string[] {
    const items = this.filteredPaletteItems();
    if (items.length === 0) {
      return [color.dim("No matching commands, providers, agents, runs, rooms, or files.")];
    }
    return items.slice(0, maxLines).map((item, index) => {
      const marker = index === this.paletteSelected ? ">" : " ";
      const kind = item.kind.padEnd(8);
      const label = item.enabled ? item.label : color.dim(item.label);
      const detail = color.dim(item.detail);
      const line = `${marker} ${kind} ${label} ${detail}`;
      return index === this.paletteSelected ? color.inverse(fitAnsi(line, width)) : fitAnsi(line, width);
    });
  }

  private confirmationLines(width: number): string[] {
    const prompt = this.pendingConfirmation?.prompt;
    if (!prompt) return [color.dim("No pending confirmation.")];
    return [
      prompt.danger ? color.red(color.bold(prompt.title)) : color.bold(prompt.title),
      ...(prompt.detail ? prompt.detail.split("\n").map((line) => fitAnsi(line, width)) : []),
      color.dim(`Y/Enter ${prompt.confirmLabel || "Confirm"}  N/Esc ${prompt.cancelLabel || "Cancel"}`),
    ];
  }

  private keyboardHelpLines(): string[] {
    return [
      "Global",
      "  Ctrl+C quit unless shared terminal input is focused",
      "  Ctrl+P open command palette; file results attach to the next task",
      "  Ctrl+F search feed and shared-terminal scrollback",
      "  ? show this help",
      "  f refresh dashboard",
      "  p cycle provider",
      "  / start slash command",
      "  /fanout <all|agent[,agent]> <prompt> sends one task to multiple local agents",
      "  /handoff [task|current|last] <agent> [context] creates a handoff task",
      "  /agent-start <agent> <prompt> starts one local agent; /agent-stop <agent> cancels its active tasks",
      "  /continue [run|index] <prompt> continues a loaded run",
      "  /resume [run|index] [prompt] resumes current, last, or latest run",
      "  /fork [run|index] [prompt] starts an independent run from existing context",
      "  /rerun [run|index] starts a new run from an existing goal",
      "  /retry [run|index] retries a failed or cancelled run",
      "  /stop [task|index] cancels a queued or running task",
      "  /copy [id|goal|summary|diff|output] [task|index] copies task content",
      "  /export [task|index] [path] writes a task summary markdown file",
      "  /undo restores the previous local TUI state change",
      "  /find <query> searches visible feed and shared-terminal scrollback",
      "  /room <pinned-room> switches dashboard context without rewriting config",
      "  /terminal or /reconnect connects, focuses, or restores the shared shell",
      "  /diff [path] show workspace git diff",
      "  /view <path[:line]> preview a workspace file around a line",
      "  /files [query] list matching workspace files",
      "  /search <query> search workspace text with rg",
      "  /symbols [query] list workspace code symbols",
      "  /goto <symbol> shows the best matching definition location",
      "  /rename-preview <symbol> <new-name> previews identifier rename impact",
      "  /rename <symbol> <new-name> applies a validated identifier rename",
      "  /diagnostics [all|tsconfig|python|go|rust] run workspace or language diagnostics",
      "  /instructions list instruction files; /instructions attach adds them to task context",
      "  /memory lists durable project memory; /memory attach adds it to task context",
      "  /attach <path>, /attach-image <path>, /detach <path|index|all>, /attachments manage task files",
      "  /pin [room|provider|agent] [value], /unpin <room|provider|agent> <value>, /pins",
      "  /safety, /safety audit, /safety toggle <auto-run|auto-apply|network|dangerous>",
      "",
      "Dashboard",
      "  t task, c terminal, v task detail, i init, l login, m rooms, o browser, q quit",
      "  j/k or arrows move action selection",
      "  click action rows where terminal mouse reporting is supported",
      "  1-9 open a recent run by visible index",
      "",
      "Task",
      "  Enter submit, Ctrl+J newline, Esc cancel, Ctrl+U clear, Up/down recall history",
      "  @path or @\"path with spaces\" adds matching files or images to the submitted context",
      "",
      "Run Detail",
      "  j/k switch patch, [/] cycle handoff target, h prefill handoff, a accept patch, x reject patch",
      "  R retry failed, s stop queued/running, y/c copy, e export, r refresh, q/Esc back",
      "",
      "Shared Terminal",
      "  Ctrl+] or Esc pauses terminal input and returns to dashboard",
      "",
      "Confirmation",
      "  y or Enter confirms. n, q, or Esc cancels.",
    ];
  }

  private agentName(agentId?: string): string {
    if (!agentId) return color.dim("unknown");
    const agent = this.dashboard.agents.find((candidate) => candidate._id === agentId);
    return compact(agent?.name, agentId.slice(-6));
  }

  private selectedAgent(): AgentRecord | undefined {
    if (!this.selectedAgentId) return undefined;
    return this.dashboard.agents.find((agent) => agent._id === this.selectedAgentId);
  }

  private handoffTargetAgent(): AgentRecord | undefined {
    if (!this.handoffTargetAgentId) return undefined;
    return this.dashboard.agents.find((agent) => agent._id === this.handoffTargetAgentId);
  }

  private validateSelectedAgent(): void {
    if (!this.selectedAgentId || this.dashboard.agents.length === 0) return;
    if (this.dashboard.agents.some((agent) => agent._id === this.selectedAgentId)) return;
    this.selectedAgentId = undefined;
    this.persistState();
  }

  private validateHandoffTargetAgent(): void {
    if (!this.handoffTargetAgentId || this.dashboard.agents.length === 0) return;
    if (this.dashboard.agents.some((agent) => agent._id === this.handoffTargetAgentId)) return;
    this.handoffTargetAgentId = undefined;
  }

  private columns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
    const max = Math.max(left.length, right.length);
    const rows: string[] = [];
    for (let index = 0; index < max; index++) {
      rows.push(`${padAnsi(fitAnsi(left[index] || "", leftWidth), leftWidth)}   ${fitAnsi(right[index] || "", rightWidth)}`);
    }
    return rows;
  }

  private messageLine(): string {
    if (this.message.toLowerCase().includes("not") || this.message.toLowerCase().includes("no ")) {
      return color.yellow(this.message);
    }
    return color.green(this.message);
  }

  private actions(): Action[] {
    return buildActions({
      hasRoom: Boolean(this.config?.roomId),
      loggedIn: Boolean(this.session),
      taskRunning: this.taskRunning,
      terminalActive: Boolean(this.terminalSession),
      terminalConnecting: this.terminalState.connecting,
      terminalDisconnected: Boolean(this.terminalState.disconnectReason || this.terminalLines.length > 0) && !this.terminalSession,
      runCount: this.dashboard.runs.length,
    });
  }

  private async handleKey(chunk: string, key: KeyInfo): Promise<void> {
    if (this.mode === "terminal") {
      this.handleTerminalKey(chunk, key);
      return;
    }

    const mouse = parseSgrMouse(chunk);
    if (mouse) {
      await this.handleMouse(mouse);
      return;
    }

    if (key.ctrl && key.name === "c") {
      this.quit();
      return;
    }

    if (this.mode === "run") {
      await this.handleRunKey(chunk, key);
      return;
    }

    if (this.mode === "palette") {
      await this.handlePaletteKey(chunk, key);
      return;
    }

    if (this.mode === "confirm") {
      await this.handleConfirmationKey(chunk, key);
      return;
    }

    if (this.mode === "help") {
      if (key.name === "escape" || key.name === "q" || key.name === "return") {
        this.mode = "menu";
        this.message = "Returned to dashboard.";
        this.render();
      }
      return;
    }

    if (this.mode === "task") {
      await this.handleTaskKey(chunk, key);
      return;
    }

    const actions = this.actions();
    const intent = resolveMenuKey(chunk, key, actions, this.selected);
    switch (intent.type) {
      case "quit":
        this.quit();
        return;
      case "select":
        this.selected = intent.selected;
        this.render();
        return;
      case "execute":
        await this.execute(intent.action);
        return;
      case "refresh":
        await this.refresh();
        this.render();
        return;
      case "cycle_provider":
        this.cycleProvider();
        this.render();
        return;
      case "open_palette":
        await this.openPalette();
        return;
      case "open_help":
        this.mode = "help";
        this.message = "Keyboard help.";
        this.render();
        return;
      case "start_slash":
        this.mode = "task";
        this.taskInput = "/";
        this.taskSuggestionSelected = 0;
        this.message = "Type a slash command or prompt.";
        this.render();
        return;
      case "start_find":
        this.mode = "task";
        this.taskInput = "/find ";
        this.taskSuggestionSelected = 0;
        this.message = "Search feed and terminal scrollback.";
        this.render();
        return;
      case "open_run":
        await this.openRunDetail(intent.index);
        return;
      case "none":
        return;
    }
  }

  private async handleMouse(event: TuiMouseEvent): Promise<void> {
    if (this.mode !== "menu" || !isPrimaryMousePress(event)) return;

    const hitbox = this.actionMouseHitboxes.find((candidate) =>
      candidate.row === event.row &&
      event.column >= candidate.startColumn &&
      event.column <= candidate.endColumn
    );
    if (!hitbox) return;

    const action = this.actions()[hitbox.actionIndex];
    if (!action) return;

    this.selected = hitbox.actionIndex;
    this.render();
    await this.execute(action);
  }

  private async handleTaskKey(chunk: string, key: KeyInfo): Promise<void> {
    const suggestions = this.taskSuggestions();
    if (suggestions.length > 0 && (key.name === "tab" || chunk === "\t")) {
      const suggestion = this.selectedTaskSuggestion();
      if (suggestion) {
        this.taskInput = suggestion.completion;
        this.taskSuggestionSelected = 0;
        this.message = `Completed ${suggestion.command}.`;
        this.render();
      }
      return;
    }
    if (suggestions.length > 0 && (key.name === "up" || key.name === "down")) {
      const direction = key.name === "up" ? -1 : 1;
      this.taskSuggestionSelected = (this.taskSuggestionSelected + direction + suggestions.length) % suggestions.length;
      this.message = "Slash command autocomplete.";
      this.render();
      return;
    }

    const intent = resolveTaskKey(chunk, key);
    switch (intent.type) {
      case "cancel":
        this.mode = "menu";
        this.taskInput = "";
        this.taskSuggestionSelected = 0;
        this.message = "Task cancelled.";
        this.render();
        return;
      case "clear":
        this.taskInput = "";
        this.taskSuggestionSelected = 0;
        this.render();
        return;
      case "backspace":
        this.taskInput = this.taskInput.slice(0, -1);
        this.taskSuggestionSelected = 0;
        this.render();
        return;
      case "history":
        this.recallTaskHistory(intent.direction);
        return;
      case "submit": {
        const goal = this.taskInput.trim();
        if (!goal) {
          this.message = "Type a task before submitting.";
          this.render();
          return;
        }
        if (goal.startsWith("/")) {
          await this.handleSlashCommand(goal);
          return;
        }
        await this.runTask(goal);
        return;
      }
      case "append":
        this.taskInput += intent.text;
        this.taskSuggestionSelected = 0;
        this.render();
        return;
      case "none":
        return;
    }
  }

  private async openPalette(input = ""): Promise<void> {
    this.mode = "palette";
    this.paletteInput = input;
    this.paletteSelected = 0;
    this.message = "Command palette. Loading files...";
    this.render();

    const files = await listWorkspaceFiles({
      dir: this.args.dir,
      limit: 1_000,
    });
    this.paletteFiles = files.files;
    this.paletteFilesError = files.error;
    this.message = files.error ? `Command palette. File list unavailable: ${files.error}` : "Command palette.";
    this.render();
  }

  private async handlePaletteKey(chunk: string, key: KeyInfo): Promise<void> {
    const intent = resolvePaletteKey(chunk, key);
    switch (intent.type) {
      case "cancel":
        this.mode = "menu";
        this.paletteInput = "";
        this.paletteSelected = 0;
        this.message = "Palette closed.";
        this.render();
        return;
      case "clear":
        this.paletteInput = "";
        this.paletteSelected = 0;
        this.render();
        return;
      case "backspace":
        this.paletteInput = this.paletteInput.slice(0, -1);
        this.paletteSelected = 0;
        this.render();
        return;
      case "move": {
        const items = this.filteredPaletteItems();
        if (items.length > 0) {
          this.paletteSelected = (this.paletteSelected + intent.direction + items.length) % items.length;
        }
        this.render();
        return;
      }
      case "submit":
        await this.executePaletteItem();
        return;
      case "append":
        this.paletteInput += intent.text;
        this.paletteSelected = 0;
        this.render();
        return;
      case "none":
        return;
    }
  }

  private async handleConfirmationKey(chunk: string, key: KeyInfo): Promise<void> {
    const intent = resolveConfirmationKey(chunk, key);
    if (intent.type === "none") return;

    const pending = this.pendingConfirmation;
    this.pendingConfirmation = null;
    this.mode = pending?.returnMode === "confirm" ? "menu" : pending?.returnMode || "menu";

    if (intent.type === "cancel") {
      this.message = "Action cancelled.";
      this.addFeed("warning", pending ? `Cancelled: ${pending.prompt.title}` : "Confirmation cancelled.");
      if (pending?.onCancel) {
        await pending.onCancel();
      }
      this.render();
      return;
    }

    if (!pending) {
      this.message = "No action to confirm.";
      this.render();
      return;
    }

    await pending.onConfirm();
  }

  private requestConfirmation(
    prompt: TuiConfirmation,
    onConfirm: () => Promise<void> | void,
    onCancel?: () => Promise<void> | void,
  ): void {
    this.pendingConfirmation = {
      prompt: createConfirmation(prompt),
      returnMode: this.mode,
      onConfirm,
      onCancel,
    };
    this.mode = "confirm";
    this.message = "Confirm action.";
    this.render();
  }

  private async executePaletteItem(): Promise<void> {
    const items = this.filteredPaletteItems();
    const item = items[this.paletteSelected];
    if (!item) {
      this.message = "No matching palette item.";
      this.render();
      return;
    }

    this.mode = "menu";
    this.paletteInput = "";
    this.paletteSelected = 0;

    if (item.kind === "action" && item.actionId) {
      const action = this.actions().find((candidate) => candidate.id === item.actionId);
      if (action) {
        await this.execute(action);
        return;
      }
    }

    if (item.kind === "provider" && item.provider) {
      this.setProviderFromCommand(item.provider);
      this.render();
      return;
    }

    if (item.kind === "run") {
      await this.openRunDetail(item.runId || item.runIndex || 0);
      return;
    }

    if (item.kind === "slash" && item.command) {
      await this.handleSlashCommand(item.command);
      return;
    }

    if (item.kind === "agent") {
      this.selectAgent(item.agentId || item.label);
      this.render();
      return;
    }

    if (item.kind === "room") {
      await this.switchRoom(item.roomId || item.label, item.label);
      return;
    }

    if (item.kind === "file" && item.filePath) {
      this.attachFile(item.filePath);
      this.render();
      return;
    }

    this.message = `Palette item unavailable: ${item.label}`;
    this.render();
  }

  private async execute(action: Action): Promise<void> {
    if (!action.enabled) {
      this.message = `Action unavailable: ${action.label}`;
      this.render();
      return;
    }

    switch (action.id) {
      case "task":
        this.mode = "task";
        this.taskInput = "";
        this.taskSuggestionSelected = 0;
        this.message = "Describe the task to run in this room.";
        this.render();
        return;
      case "join":
        await this.focusOrConnectTerminal();
        return;
      case "init":
        if (this.config?.roomId) {
          this.requestConfirmation(
            {
              id: "project.reinitialize",
              title: "Reinitialize project room?",
              detail: `This will run init for ${this.args.dir} and may update .co-od.json.`,
              confirmLabel: "Reinitialize",
              danger: true,
            },
            () => this.runInitHandoff(),
          );
          return;
        }
        await this.runInitHandoff();
        return;
      case "login":
        await this.handoff(async () => {
          const { run } = await import("./login.js");
          await run([]);
        }, true);
        return;
      case "rooms":
        this.showRoomsInFeed();
        this.render();
        return;
      case "run":
        await this.openRunDetail(0);
        return;
      case "open":
        await this.openBrowser();
        return;
      case "help":
        this.mode = "help";
        this.message = "Keyboard help.";
        this.render();
        return;
      case "quit":
        this.quit();
        return;
    }
  }

  private async runInitHandoff(): Promise<void> {
    await this.handoff(async () => {
      const { run } = await import("./init.js");
      await run(["--dir", this.args.dir, "--provider", this.provider]);
    }, true);
  }

  private async runTask(
    goal: string,
    continueRunId?: string,
    overrides: { provider?: string; agentId?: string; providerSession?: ProviderSessionContext } = {},
    approved = false,
  ): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const safety = evaluateTaskApproval(this.safety, { approved });
    this.safety = safety.state;
    if (safety.status === "needs-approval") {
      this.requestConfirmation(
        {
          id: "task.run.approve",
          title: "Run agent task?",
          detail: `Auto-run is off. Approve this task for ${this.provider}: ${previewText(goal, "(no prompt)")}`,
          confirmLabel: "Run task",
        },
        () => this.runTask(goal, continueRunId, overrides, true),
      );
      this.persistState();
      return;
    }
    this.persistState();

    const submitted = await this.formatSubmittedGoal(goal);
    this.mode = "menu";
    this.taskInput = "";
    this.taskHistory = normalizeTaskHistory(this.taskHistory, goal);
    this.taskHistoryIndex = -1;
    this.taskRunning = true;
    const provider = overrides.provider || this.provider;
    const model = provider === this.provider ? this.model : undefined;
    const agentId = overrides.agentId ?? this.selectedAgentId;
    const selectedAgent = agentId
      ? this.dashboard.agents.find((agent) => agent._id === agentId)
      : this.selectedAgent();
    const agentLabel = selectedAgent ? ` via ${compact(selectedAgent.name, shortId(selectedAgent._id))}` : "";
    this.message = continueRunId
      ? `Continuing run ${shortId(continueRunId)} with ${provider}${agentLabel}...`
      : `Running task with ${provider}${agentLabel}...`;
    this.persistState();
    this.render();

    const approvalStream = this.startBridgeApprovalStream(agentId);
    try {
      const result = await runTuiTask({
        roomId: this.config.roomId,
        goal: submitted.goal,
        provider,
        model,
        dir: this.args.dir,
        agentId,
        attachments: submitted.attachments,
        continueRunId,
        providerSession: overrides.providerSession,
        onEvent: (event) => this.handleTaskEvent(event),
      });
      if (result.ok) {
        await this.loadRoomDashboard();
      }
    } finally {
      approvalStream?.abort();
      if (this.bridgeApprovalAbort === approvalStream) this.bridgeApprovalAbort = null;
      this.taskRunning = false;
      this.render();
    }
  }

  private async runFanoutTask(goal: string, targets: FanoutTarget[], approved = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const safety = evaluateTaskApproval(this.safety, { approved });
    this.safety = safety.state;
    if (safety.status === "needs-approval") {
      this.requestConfirmation(
        {
          id: "task.fanout.approve",
          title: "Run fan-out task?",
          detail: `Auto-run is off. Approve fan-out to ${targets.length} agents: ${previewText(goal, "(no prompt)")}`,
          confirmLabel: "Run fan-out",
        },
        () => this.runFanoutTask(goal, targets, true),
      );
      this.persistState();
      return;
    }
    this.persistState();

    const submitted = await this.formatSubmittedGoal(goal);
    this.mode = "menu";
    this.taskInput = "";
    this.taskHistory = normalizeTaskHistory(this.taskHistory, goal);
    this.taskHistoryIndex = -1;
    this.taskRunning = true;
    this.message = `Fan-out running for ${targets.length} agents...`;
    this.addFeed("info", `Fan-out submitted to ${targets.map((target) => target.name).join(", ")}: ${goal}`);
    this.persistState();
    this.render();

    try {
      const graphId = randomUUID();
      const rootHumanOperationId = randomUUID();
      const sourceTaskId = randomUUID();
      const leadOperationId = randomUUID();
      for (const [index, target] of targets.entries()) {
        this.addFeed("info", `Fan-out target ${target.name} (${target.provider})`);
        const approvalStream = this.startBridgeApprovalStream(target.agentId);
        const result = await runTuiTask({
          roomId: this.config.roomId,
          goal: submitted.goal,
          provider: target.provider,
          model: target.provider === this.provider ? this.model : undefined,
          dir: this.args.dir,
          agentId: target.agentId,
          attachments: submitted.attachments,
          delegation: {
            graphId,
            operationId: index === 0 ? leadOperationId : randomUUID(),
            ...(index === 0 ? {} : { parentOperationId: leadOperationId }),
            rootHumanOperationId,
            sourceTaskId,
            role: index === 0 ? "lead" : index === 1 ? "research" : "review",
            owningPersonId: "self",
            sponsoringPersonId: "self",
            runtimeRevision: 0,
            state: index === 0 ? "awaitingApproval" : "proposed",
            riskReasons: index === 0 ? ["writer"] : [],
            dependencyOperationIds: [],
            workspaceId: this.args.dir,
            ...(index === 0 ? { approvalId: randomUUID() } : {}),
            visibility: "room",
          },
          onEvent: (event) => this.handleTaskEvent(event),
        });
        approvalStream?.abort();
        if (this.bridgeApprovalAbort === approvalStream) this.bridgeApprovalAbort = null;
        if (!result.ok) {
          this.addFeed("error", `${target.name}: ${result.errorMessage}`);
        }
      }
      await this.loadRoomDashboard();
      this.message = "Fan-out complete.";
    } finally {
      this.taskRunning = false;
      this.render();
    }
  }

  private async formatSubmittedGoal(goal: string): Promise<{ goal: string; attachments: TuiAttachmentTransport[] }> {
    const files = await listWorkspaceFiles({
      dir: this.args.dir,
      limit: 10_000,
    });
    if (files.error) {
      return {
        goal: formatGoalWithAttachments(goal, this.taskAttachments),
        attachments: resolveAttachmentTransport(this.taskAttachments, this.args.dir),
      };
    }

    const mentions = resolveFileMentionAttachments({
      goal,
      files: files.files,
      currentAttachments: this.taskAttachments,
    });
    if (fileMentionAttachmentsChanged(this.taskAttachments, mentions.attachments)) {
      this.rememberUndo("file mentions");
      this.taskAttachments = mentions.attachments;
      this.persistState();
    }

    if (mentions.matched.length > 0) {
      this.addFeed(
        "info",
        `Resolved file mentions: ${mentions.matched.map((mention) => `${mention.ref} -> ${mention.path}`).join(", ")}`,
      );
    }
    if (mentions.unresolved.length > 0) {
      this.addFeed("warning", `Unresolved file mentions: ${mentions.unresolved.join(", ")}`);
    }

    const attachments = resolveAttachmentTransport(mentions.attachments, this.args.dir);
    if (attachments.length > 0) {
      this.addFeed(
        "info",
        `Prepared ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} for provider transport.`,
      );
    }

    return {
      goal: formatGoalWithAttachments(goal, mentions.attachments),
      attachments,
    };
  }

  private handleTaskEvent(event: TuiTaskEvent): void {
    switch (event.type) {
      case "submitted":
        this.addFeed("info", event.continueRunId
          ? `Follow-up submitted to ${event.provider}${event.agentId ? `/${shortId(event.agentId)}` : ""} for ${shortId(event.continueRunId)}: ${event.goal}`
          : `Task submitted to ${event.provider}${event.agentId ? `/${shortId(event.agentId)}` : ""}: ${event.goal}`);
        this.message = event.continueRunId
          ? `Continuing run ${shortId(event.continueRunId)} with ${event.provider}...`
          : `Running task with ${event.provider}...`;
        break;
      case "status":
        this.addFeed("info", event.message);
        this.message = event.message;
        break;
      case "output":
        this.addFeed("output", event.data);
        break;
      case "complete":
        this.lastRunId = event.result.runId;
        this.persistState();
        this.addFeed(event.result.exitCode === 0 ? "success" : "error", `Run ${event.result.status}: ${event.result.runId} (exit ${event.result.exitCode})`);
        this.message = `Task ${event.result.status}.`;
        break;
      case "error":
        this.addFeed("error", event.message);
        this.message = event.message;
        break;
    }
    this.render();
  }

  private startBridgeApprovalStream(agentId?: string): AbortController | undefined {
    if (!agentId || this.bridge !== "running") return undefined;

    const bridgeUrl = defaultLocalBridgeUrl();
    const controller = new AbortController();
    this.bridgeApprovalAbort?.abort();
    this.bridgeApprovalAbort = controller;

    void (async () => {
      const response = await fetch(`${bridgeUrl}/v1/stream/${encodeURIComponent(agentId)}`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const approval = parseBridgeApprovalSseBlock(block);
          if (approval) {
            this.handleBridgeApprovalRequest(approval, bridgeUrl);
          }
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted && this.taskRunning) {
        const message = error instanceof Error ? error.message : String(error);
        this.addFeed("warning", `Bridge approval stream unavailable: ${message}`);
        this.render();
      }
    });

    return controller;
  }

  private handleBridgeApprovalRequest(approval: BridgeApprovalRequest, bridgeUrl: string): void {
    if (this.activeBridgeApprovals.has(approval.approvalId)) return;
    this.activeBridgeApprovals.add(approval.approvalId);

    const target = bridgeApprovalTarget(approval);
    const title = `Approve ${bridgeApprovalTitle(approval)}?`;
    const detail = bridgeApprovalDetailLines(approval)
      .map((line) => line.startsWith("expires: ")
        ? `expires: ${formatAbsoluteTime(Date.parse(line.slice("expires: ".length)))}`
        : line)
      .join("\n");

    this.addFeed("warning", `Bridge approval requested: ${bridgeApprovalTitle(approval)} for ${target}`);
    this.requestConfirmation(
      {
        id: `bridge.approval.${approval.approvalId}`,
        title,
        detail,
        confirmLabel: "Approve",
        cancelLabel: "Deny",
        danger: approval.kind === "destructive",
      },
      () => this.resolveBridgeApproval(approval, "approve", bridgeUrl),
      () => this.resolveBridgeApproval(approval, "deny", bridgeUrl),
    );
  }

  private async resolveBridgeApproval(
    approval: BridgeApprovalRequest,
    decision: BridgeApprovalDecision,
    bridgeUrl: string,
  ): Promise<void> {
    try {
      await respondToBridgeApproval({ bridgeUrl, approvalId: approval.approvalId, decision });
      const verb = decision === "approve" ? "approved" : "denied";
      this.addFeed(decision === "approve" ? "success" : "warning", `Bridge approval ${verb}: ${bridgeApprovalTarget(approval)}`);
      this.message = `Bridge approval ${verb}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `Bridge approval response failed: ${message}`);
      this.message = message;
    } finally {
      this.activeBridgeApprovals.delete(approval.approvalId);
      this.render();
    }
  }

  private async handleSlashCommand(input: string): Promise<void> {
    const { command, args } = parseSlashCommand(input);

    this.mode = "menu";
    this.taskInput = "";
    this.taskSuggestionSelected = 0;

    switch (command) {
      case "":
      case "help":
        this.showSlashHelp();
        this.message = "Slash commands listed in the feed.";
        this.render();
        return;
      case "clear":
        this.feed = [];
        this.addFeed("info", "Feed cleared.");
        this.message = "Feed cleared.";
        this.render();
        return;
      case "undo":
      case "rewind":
        await this.undoLocalChange();
        this.render();
        return;
      case "provider":
        this.setProviderFromCommand(args[0]);
        this.render();
        return;
      case "model":
        this.setModelFromCommand(args.join(" "));
        this.render();
        return;
      case "agent":
      case "agents":
        if (args.length > 0) {
          this.selectAgent(args.join(" "));
        } else {
          this.showAgentsInFeed();
          this.message = "Agents listed in the feed.";
        }
        this.render();
        return;
      case "room":
        await this.switchRoomFromCommand(args.join(" "));
        return;
      case "run":
        await this.openRunDetail(args[0] || "1");
        return;
      case "runs":
        this.showRunsInFeed();
        this.message = "Recent work listed in the feed.";
        this.render();
        return;
      case "sessions":
        this.showProviderSessions(args.join(" "));
        this.render();
        return;
      case "session":
        await this.openProviderSession(args.join(" "));
        return;
      case "copy":
      case "yank":
        await this.copyRunFromCommand(args);
        return;
      case "export":
      case "summary":
        await this.exportRunFromCommand(args);
        return;
      case "fanout":
      case "fan-out":
        await this.fanoutFromCommand(args);
        return;
      case "handoff-target":
      case "handoff-agent":
      case "target-agent":
        this.selectHandoffTargetFromCommand(args.join(" "));
        this.render();
        return;
      case "handoff":
        await this.handoffFromCommand(args);
        return;
      case "agent-start":
      case "start-agent":
        await this.startAgentFromCommand(args);
        return;
      case "agent-stop":
      case "stop-agent":
        await this.stopAgentFromCommand(args);
        return;
      case "agent-pause":
      case "pause-agent":
        await this.pauseAgentFromCommand(args);
        return;
      case "agent-resume":
      case "resume-agent":
        await this.resumeAgentFromCommand(args);
        return;
      case "continue":
        await this.continueRunFromCommand(args);
        return;
      case "resume":
        await this.resumeRunFromCommand(args);
        return;
      case "fork":
        await this.forkRunFromCommand(args);
        return;
      case "rerun":
        await this.rerunFromCommand(args[0]);
        return;
      case "retry":
        await this.retryFromCommand(args[0]);
        return;
      case "stop":
      case "cancel":
        await this.stopRunFromCommand(args[0]);
        return;
      case "history":
        this.showTaskHistory(args.join(" "));
        this.render();
        return;
      case "find":
      case "feed":
      case "scrollback":
        this.showScrollbackSearch(args.join(" "));
        this.render();
        return;
      case "use-history":
      case "hist":
        this.prefillTaskHistory(args.join(" "));
        this.render();
        return;
      case "again":
      case "rerun-history":
        await this.runTaskHistory(args.join(" "));
        return;
      case "env":
      case "runtime":
      case "env-status":
      case "runtime-status":
      case "status-env":
      case "status-runtime":
      case "env-start":
      case "runtime-start":
      case "start-env":
      case "start-runtime":
      case "env-stop":
      case "runtime-stop":
      case "stop-env":
      case "stop-runtime":
      case "env-touch":
      case "runtime-touch":
      case "touch-env":
      case "touch-runtime":
        await this.handleEnvCommand(command, args);
        return;
      case "health":
        await this.refresh();
        this.addFeed("info", `Health: ${stripAnsi(this.serviceSummary())}`);
        this.message = "Health refreshed.";
        this.render();
        return;
      case "doctor":
        this.showDoctorInFeed();
        this.render();
        return;
      case "qa":
      case "tui-qa":
        await this.showTuiQaInFeed(command, args);
        this.render();
        return;
      case "live-qa":
        await this.showTuiQaInFeed(command, args);
        this.render();
        return;
      case "git":
      case "workspace":
        await this.refreshWorkspace();
        this.showWorkspaceInFeed();
        this.message = "Workspace status refreshed.";
        this.render();
        return;
      case "diff":
      case "changes":
        await this.showWorkspaceDiffInFeed(args.join(" "));
        this.render();
        return;
      case "view":
      case "peek":
      case "cat":
        this.showWorkspaceFilePreviewInFeed(args.join(" "));
        this.render();
        return;
      case "files":
      case "file":
        await this.showFilesInFeed(args.join(" "));
        this.render();
        return;
      case "search":
      case "rg":
        await this.showSearchInFeed(args.join(" "));
        this.render();
        return;
      case "symbols":
      case "symbol":
      case "sym":
        await this.showSymbolsInFeed(args.join(" "));
        this.render();
        return;
      case "goto":
      case "definition":
      case "def":
        await this.showSymbolNavigationInFeed(args.join(" "));
        this.render();
        return;
      case "rename-preview":
        await this.showRenamePreviewInFeed(args);
        this.render();
        return;
      case "rename":
        await this.renameSymbolFromCommand(args);
        this.render();
        return;
      case "diagnostics":
      case "diag":
      case "typecheck":
        await this.showDiagnosticsInFeed(args.join(" "));
        this.render();
        return;
      case "instructions":
      case "instruction":
        this.handleInstructionsCommand(args);
        this.render();
        return;
      case "memory":
      case "memories":
        this.handleMemoryCommand(args);
        this.render();
        return;
      case "context":
        await this.showContextInFeed();
        this.render();
        return;
      case "attach":
        this.attachFile(args.join(" "));
        this.render();
        return;
      case "attach-image":
      case "image":
      case "screenshot":
        this.attachImage(args.join(" "));
        this.render();
        return;
      case "detach":
      case "unattach":
        this.detachFile(args.join(" "));
        this.render();
        return;
      case "attachments":
      case "attached":
        this.showAttachmentsInFeed();
        this.render();
        return;
      case "pin":
        this.handlePinCommand(args);
        this.render();
        return;
      case "unpin":
        this.handleUnpinCommand(args);
        this.render();
        return;
      case "pins":
        this.showPinsInFeed();
        this.render();
        return;
      case "safety":
      case "policy":
        this.handleSafetyCommand(args);
        this.render();
        return;
      case "terminal":
      case "connect":
      case "reconnect":
        await this.focusOrConnectTerminal();
        return;
      case "open":
      case "browser":
        await this.openBrowser();
        return;
      case "login":
        await this.execute(this.actions().find((action) => action.id === "login")!);
        return;
      case "init":
        await this.execute(this.actions().find((action) => action.id === "init")!);
        return;
      case "rooms":
        this.showRoomsInFeed();
        this.render();
        return;
      case "quit":
      case "q":
        this.quit();
        return;
      default:
        this.addFeed("warning", `Unknown command: /${command}. Try /help.`);
        this.message = `Unknown command: /${command}`;
        this.render();
    }
  }

  private showSlashHelp(): void {
    this.addFeed("info", slashHelpText());
  }

  private showTaskHistory(query: string): void {
    const text = formatTaskHistory(this.taskHistory, query);
    this.addFeed(this.taskHistory.length > 0 ? "info" : "warning", text);
    this.message = query.trim() ? "Task history filtered." : "Task history listed.";
  }

  private showScrollbackSearch(query: string): void {
    const result = searchTuiScrollback({
      feed: this.feed,
      terminalLines: this.terminalLines,
      query,
      limit: 30,
    });
    this.addFeed(result.error || result.matches.length === 0 ? "warning" : "info", formatTuiScrollbackSearch(result));
    this.message = result.error
      ? "Search needs a query."
      : result.matches.length > 0
        ? `Found ${result.matches.length} feed/terminal matches.`
        : "No feed or terminal matches.";
  }

  private prefillTaskHistory(ref: string): void {
    const result = resolveTaskHistoryItem(this.taskHistory, ref);
    if (!result.ok || !result.goal) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      return;
    }
    this.mode = "task";
    this.taskInput = result.goal;
    this.taskHistoryIndex = -1;
    this.addFeed("info", result.message);
    this.message = "Task history item loaded. Edit or press Enter to run.";
  }

  private async runTaskHistory(ref: string): Promise<void> {
    const result = resolveTaskHistoryItem(this.taskHistory, ref);
    if (!result.ok || !result.goal) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }
    this.addFeed("info", `Rerunning task history item ${result.index}: ${result.goal}`);
    await this.runTask(result.goal);
  }

  private providerSessionRows() {
    return collectProviderSessions({
      runs: this.runDetail?.allRuns || this.dashboard.runs,
      agents: this.dashboard.agents,
    });
  }

  private showProviderSessions(query: string): void {
    const rows = this.providerSessionRows();
    this.addFeed(rows.length > 0 ? "info" : "warning", formatProviderSessions(rows, query));
    this.message = query.trim() ? "Provider sessions filtered." : "Provider sessions listed.";
  }

  private async openProviderSession(ref: string): Promise<void> {
    const result = resolveProviderSession(this.providerSessionRows(), ref);
    if (!result.ok || !result.row) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }
    this.addFeed("info", result.message);
    await this.openRunDetail(result.row.runId);
  }

  private async handleEnvCommand(command: string, args: string[], confirmed = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveEnvCommand(command, args);
    if (!result.ok || !result.action) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    const safetyAction: TuiSafetyAction = result.action === "start" || result.action === "stop"
      ? "destructive"
      : "network";
    const safety = evaluateSafetyActionApproval(this.safety, safetyAction, { approved: confirmed });
    if (safety.status === "needs-approval") {
      this.requestConfirmation(
        {
          id: `runtime.${result.action}`,
          title: this.envConfirmationTitle(result.action),
          detail: `${this.envConfirmationDetail(result.action, result.ttlSeconds)}\n${safety.message}`,
          confirmLabel: this.envConfirmationLabel(result.action),
          danger: result.action === "start" || result.action === "stop",
        },
        () => this.handleEnvCommand(command, args, true),
      );
      return;
    }

    this.safety = safety.state;
    this.persistState();

    try {
      this.message = this.envProgressMessage(result.action);
      this.render();
      if (result.action === "status") {
        const status = await api.get<TuiEnvStatusResponse>(
          `/api/rooms/${this.config.roomId}/env/status`,
        );
        this.addFeed("info", formatEnvStatus(status));
        this.message = "Runtime status loaded.";
        this.render();
        return;
      }

      const response = await this.executeEnvMutation(result.action, result.ttlSeconds);
      this.addFeed(result.action === "stop" ? "warning" : "success", formatEnvMutation(result.action, response));
      await this.refresh();
      this.message = this.envCompleteMessage(result.action);
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `runtime ${result.action}: ${message}`);
      this.message = message;
      this.render();
    }
  }

  private async executeEnvMutation(
    action: Exclude<TuiEnvAction, "status">,
    ttlSeconds?: number,
  ): Promise<TuiEnvMutationResponse> {
    if (!this.config?.roomId) {
      throw new Error("No room configured.");
    }
    if (action === "start") {
      return api.post<TuiEnvMutationResponse>(
        `/api/rooms/${this.config.roomId}/env/start`,
        ttlSeconds ? { ttlSeconds } : {},
      );
    }
    if (action === "stop") {
      return api.post<TuiEnvMutationResponse>(`/api/rooms/${this.config.roomId}/env/stop`, {});
    }
    return api.post<TuiEnvMutationResponse>(`/api/rooms/${this.config.roomId}/env/touch`, {});
  }

  private envConfirmationTitle(action: TuiEnvAction): string {
    if (action === "status") return "Check runtime status?";
    if (action === "start") return "Start hosted runtime?";
    if (action === "stop") return "Stop hosted runtime?";
    return "Touch hosted runtime?";
  }

  private envConfirmationDetail(action: TuiEnvAction, ttlSeconds?: number): string {
    if (action === "status") return "This reads the room runtime state from the server.";
    if (action === "start") {
      return ttlSeconds
        ? `This starts or extends the hosted room runtime for ${ttlSeconds}s.`
        : "This starts or extends the hosted room runtime using the server default TTL.";
    }
    if (action === "stop") return "This stops the hosted room runtime for the current room.";
    return "This refreshes the hosted room runtime lease for the current room.";
  }

  private envConfirmationLabel(action: TuiEnvAction): string {
    if (action === "status") return "Check runtime";
    if (action === "start") return "Start runtime";
    if (action === "stop") return "Stop runtime";
    return "Touch runtime";
  }

  private envProgressMessage(action: TuiEnvAction): string {
    if (action === "status") return "Loading runtime status...";
    if (action === "start") return "Starting runtime...";
    if (action === "stop") return "Stopping runtime...";
    return "Touching runtime...";
  }

  private envCompleteMessage(action: Exclude<TuiEnvAction, "status">): string {
    if (action === "start") return "Runtime start request completed.";
    if (action === "stop") return "Runtime stop request completed.";
    return "Runtime lease touch completed.";
  }

  private rememberUndo(label: string): void {
    this.undoStack = pushUndoSnapshot(this.undoStack, createUndoSnapshot({
      label,
      provider: this.provider,
      model: this.model,
      selectedAgentId: this.selectedAgentId,
      attachments: this.taskAttachments,
      pins: this.pins,
      safety: this.safety,
    }));
  }

  private async undoLocalChange(): Promise<void> {
    const snapshot = this.undoStack.at(-1);
    if (!snapshot) {
      this.addFeed("warning", "Nothing to undo.");
      this.message = "Nothing to undo.";
      return;
    }

    const fileRestore = snapshot.fileChanges && snapshot.fileChanges.length > 0
      ? restoreFileUndoChanges(this.args.dir, snapshot.fileChanges)
      : null;
    if (fileRestore && !fileRestore.ok) {
      this.addFeed("error", fileRestore.message);
      this.message = fileRestore.message;
      return;
    }

    const serverRestore = snapshot.serverChanges && snapshot.serverChanges.length > 0
      ? await restoreServerUndoChanges({ changes: snapshot.serverChanges })
      : null;
    if (serverRestore && !serverRestore.ok) {
      this.addFeed("error", serverRestore.message);
      this.message = serverRestore.message;
      return;
    }

    this.undoStack = this.undoStack.slice(0, -1);
    const restored = restoreUndoSnapshot(snapshot, this.safety);
    this.provider = restored.provider;
    this.model = restored.model;
    this.selectedAgentId = restored.selectedAgentId;
    this.taskAttachments = restored.attachments;
    this.pins = restored.pins;
    this.safety = restored.safety;
    this.persistState();
    this.addFeed("info", [
      `Undid: ${snapshot.label}`,
      fileRestore && fileRestore.changedFiles.length > 0 ? `Restored files: ${fileRestore.changedFiles.join(", ")}` : "",
      serverRestore && serverRestore.changed.length > 0 ? `Restored server state: ${serverRestore.changed.map((change) => change.patchId).join(", ")}` : "",
    ].filter(Boolean).join("\n"));
    this.message = `Undid: ${snapshot.label}`;
  }

  private setProviderFromCommand(provider?: string): void {
    const result = resolveProviderCommand({
      current: this.provider,
      requested: provider,
      availability: this.providerAvailability,
      providers: PROVIDERS,
    });
    if (!result.ok) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      return;
    }
    this.rememberUndo("provider");
    this.provider = result.provider;
    this.clearSelectedAgentIfProviderChanged();
    this.addFeed("info", result.message);
    this.message = result.message;
    this.persistState();
  }

  private setModelFromCommand(model?: string): void {
    const result = resolveModelCommand({
      current: { provider: this.provider, model: this.model },
      requested: model,
    });
    if (!result.ok) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      return;
    }
    this.rememberUndo("model");
    this.model = result.state.model;
    this.addFeed("info", result.message);
    this.message = result.message;
    this.persistState();
  }

  private showAgentsInFeed(): void {
    if (this.dashboard.agents.length === 0) {
      this.addFeed("info", "No room agents loaded.");
      return;
    }
    const lines = buildAgentActivityRows({
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      providerAvailability: this.providerAvailability,
    })
      .slice(0, 12)
      .map((row) => stripAnsi(this.agentActivityLine(row)))
      .join("\n");
    this.addFeed("info", lines);
  }

  private selectAgent(value: string): void {
    const agent = this.findAgent(value);
    if (!agent) {
      this.addFeed("warning", `No matching agent: ${value}`);
      this.message = "No matching agent.";
      return;
    }

    const provider = resolveLocalProviderForAgent(agent);
    if (!provider) {
      this.addFeed(
        "warning",
        `${compact(agent.name, agent._id)} is not a local CLI agent. TUI task execution currently supports local agents.`,
      );
      this.message = "Agent is not available for local TUI tasks.";
      return;
    }

    this.rememberUndo("agent");
    this.selectedAgentId = agent._id;
    this.provider = provider;
    this.addFeed("info", `Selected agent: ${compact(agent.name, agent._id)} (${provider})`);
    this.message = `Selected agent: ${compact(agent.name, shortId(agent._id))}`;
    this.persistState();
  }

  private showRoomsInFeed(): void {
    if (this.roomsError) {
      this.addFeed("warning", `Room list unavailable: ${this.roomsError}`);
      this.message = "Room list unavailable.";
      return;
    }

    const rooms = this.knownRooms();
    if (rooms.length === 0) {
      this.addFeed("info", this.session ? "No rooms loaded." : "Login to load rooms.");
      this.message = this.session ? "No rooms loaded." : "Login to load rooms.";
      return;
    }

    this.addFeed(
      "info",
      rooms
        .slice(0, 20)
        .map((room, index) => {
          const current = this.config?.roomId === room.roomId ? "*" : " ";
          const pinned = isPinnedRoom(this.pins, room.roomId) ? "pin" : "   ";
          const status = room.status || "room";
          const agents = room.agentCount === undefined ? "?" : String(room.agentCount);
          const members = room.memberCount === undefined ? "?" : String(room.memberCount);
          return `${current} ${String(index + 1).padStart(2)} ${pinned} ${compact(room.roomName, room.roomId)} ${color.dim(`${status} ${room.roomId} agents:${agents} members:${members}`)}`;
        })
        .join("\n"),
    );
    this.message = "Rooms listed in the feed. Use /room <name|id> to switch.";
  }

  private async switchRoomFromCommand(value: string): Promise<void> {
    const room = this.findRoom(value);
    if (!room) {
      const known = this.knownRoomLabels().join(", ");
      this.addFeed("warning", known ? `No matching room: ${value}. Known rooms: ${known}` : "No rooms loaded. Login and use /rooms after refresh.");
      this.message = "No matching room.";
      this.render();
      return;
    }
    await this.switchRoom(room.roomId, room.roomName);
  }

  private async switchRoom(roomId: string, roomName?: string): Promise<void> {
    const nextRoomId = roomId.trim();
    if (!nextRoomId) {
      this.message = "Room id is required.";
      this.render();
      return;
    }

    if (this.config?.roomId === nextRoomId) {
      this.message = `Already in room ${roomName || nextRoomId}.`;
      this.render();
      return;
    }

    if (this.terminalSession) {
      this.terminalSession.close();
    }
    this.terminalSession = null;
    this.terminalState = createTerminalConnectionState();
    this.terminalLines = [];
    this.runDetail = null;
    this.runDetailPatchIndex = 0;
    this.dashboard = { ...this.dashboard, agents: [], runs: [], error: undefined, cached: false };
    this.selectedAgentId = undefined;
    this.lastRunId = undefined;
    this.selectedRoomId = nextRoomId;
    this.selectedRoomName = roomName && roomName !== nextRoomId ? roomName : undefined;
    this.config = {
      ...(this.config || {}),
      roomId: nextRoomId,
      roomName: this.selectedRoomName || nextRoomId,
      projectDir: this.args.dir,
    };
    this.addFeed("info", `Switching room to ${this.selectedRoomName || nextRoomId}...`);
    this.persistState();
    await this.refresh();
    this.message = `Room selected: ${this.config?.roomName || nextRoomId}`;
    this.addFeed("info", `Room selected: ${this.config?.roomName || nextRoomId}`);
    this.render();
  }

  private showRunsInFeed(): void {
    if (this.dashboard.runs.length === 0) {
      this.addFeed("info", "No recent tasks loaded.");
      return;
    }
    this.addFeed(
      "info",
      this.dashboard.runs
        .slice(0, 12)
        .map((run) => `${run.status || "unknown"} ${formatAge(run.finished_at || run.started_at || run.created_at)}${run._id === this.lastRunId ? " last" : ""} ${compact(run.goal, "(no goal)")}`)
        .join("\n"),
    );
  }

  private async exportRunFromCommand(args: string[]): Promise<void> {
    const first = args[0];
    const explicitRunId = first ? this.matchLoadedRunId(first) : null;
    const runId = explicitRunId || this.runDetail?.run._id || resolveRunId(this.dashboard.runs);
    const outputPath = explicitRunId ? args.slice(1).join(" ") : args.join(" ");

    if (!this.runDetail || (runId && this.runDetail.run._id !== runId)) {
      await this.openRunDetail(runId || first || undefined);
    }

    this.exportCurrentRunSummary(outputPath || undefined);
  }

  private async copyRunFromCommand(args: string[]): Promise<void> {
    const first = args[0]?.toLowerCase();
    const kind = this.isRunCopyKind(first) ? first : "summary";
    const runRef = this.isRunCopyKind(first) ? args[1] : args[0];
    const runId = runRef ? this.matchLoadedRunId(runRef) || runRef : this.runDetail?.run._id || resolveRunId(this.dashboard.runs);

    if (!this.runDetail || (runId && this.runDetail.run._id !== runId)) {
      await this.openRunDetail(runId || undefined);
    }

    this.copyCurrentRun(kind);
  }

  private isRunCopyKind(value?: string): value is RunCopyKind {
    return value === "id" || value === "goal" || value === "summary" || value === "diff" || value === "output";
  }

  private matchLoadedRunId(value: string): string | null {
    const query = value.trim();
    if (!query) return null;
    if (/^\d+$/.test(query)) {
      return this.dashboard.runs[Number(query) - 1]?._id || null;
    }
    return this.dashboard.runs.find((run) => run._id === query || run._id.endsWith(query))?._id || null;
  }

  private exportCurrentRunSummary(outputPath?: string): void {
    if (!this.runDetail) {
      this.message = "No run loaded to export.";
      this.render();
      return;
    }

    try {
      const result = writeRunSummaryExport({
        detail: this.runDetail,
        projectDir: this.args.dir,
        outputPath,
        agentName: (agentId) => stripAnsi(this.agentName(agentId)),
      });
      if (result.fileChange) {
        this.undoStack = pushUndoSnapshot(this.undoStack, createUndoSnapshot({
          label: `export run ${shortId(this.runDetail.run._id)}`,
          provider: this.provider,
          model: this.model,
          selectedAgentId: this.selectedAgentId,
          attachments: this.taskAttachments,
          pins: this.pins,
          safety: this.safety,
          fileChanges: [result.fileChange],
        }));
      }
      this.addFeed("success", [
        `Exported task summary: ${result.path}`,
        result.fileChange ? "Use /undo to restore or remove this export." : "Export path is outside the workspace; undo was not recorded.",
      ].join("\n"));
      this.message = `Exported task summary: ${result.path}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `export: ${message}`);
      this.message = message;
    }
    this.render();
  }

  private copyCurrentRun(kind: RunCopyKind): void {
    if (!this.runDetail) {
      this.message = "No run loaded to copy.";
      this.render();
      return;
    }

    try {
      const text = formatRunCopyText({
        detail: this.runDetail,
        kind,
        selectedPatchIndex: this.runDetailPatchIndex,
        agentName: (agentId) => stripAnsi(this.agentName(agentId)),
      });
      writeClipboardText(text);
      this.addFeed("success", `Copied task ${kind} to clipboard.`);
      this.message = `Copied task ${kind} to clipboard.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `copy: ${message}`);
      this.message = message;
    }
    this.render();
  }

  private async fanoutFromCommand(args: string[]): Promise<void> {
    const result = resolveFanoutCommand({
      agents: this.dashboard.agents,
      args,
      providerAvailability: this.providerAvailability,
    });

    if (!result.ok) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    this.addFeed("info", result.message);
    await this.runFanoutTask(result.goal, result.targets);
  }

  private async handoffFromCommand(args: string[], approved = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveHandoffCommand({
      runs: this.dashboard.runs,
      agents: this.dashboard.agents,
      args,
      currentRunId: this.runDetail?.run._id,
      lastRunId: this.lastRunId,
    });
    if (!result.ok) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    const safety = evaluateTaskApproval(this.safety, { approved });
    this.safety = safety.state;
    if (safety.status === "needs-approval") {
      this.requestConfirmation(
        {
          id: "task.handoff.approve",
          title: "Run handoff?",
          detail: `Auto-run is off. Approve handoff ${shortId(result.sourceRunId)} to ${result.targetName}: ${previewText(result.context, "(no context)")}`,
          confirmLabel: "Run handoff",
        },
        () => this.handoffFromCommand(args, true),
      );
      this.persistState();
      return;
    }
    this.persistState();

    this.mode = "menu";
    this.taskRunning = true;
    this.addFeed(
      "info",
      `Handing off ${shortId(result.sourceRunId)} to ${result.targetName}: ${result.context}`,
    );
    this.message = `Handing off to ${result.targetName}...`;
    this.render();

    try {
      const handoffResult = await executeRoomHandoff({
        roomId: this.config.roomId,
        sourceRunId: result.sourceRunId,
        targetAgentId: result.targetAgentId,
        targetProvider: result.targetProvider,
        context: result.context,
        goal: result.goal,
        delegation: result.delegation,
        model: result.targetProvider === this.provider ? this.model : undefined,
        dir: this.args.dir,
        onStatus: (message) => {
          this.addFeed("info", message);
          this.message = message;
          this.render();
        },
        onOutput: (data) => {
          this.addFeed("output", data);
          this.render();
        },
      });
      this.lastRunId = handoffResult.newRunId;
      this.addFeed(
        handoffResult.status === "failed" ? "error" : "success",
        `Handoff ${handoffResult.status}: ${shortId(handoffResult.newRunId)}${handoffResult.executedLocally ? " (local execution complete)" : ""}`,
      );
      await this.loadRoomDashboard();
      this.message = `Handoff ${handoffResult.status}.`;
      this.persistState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `handoff: ${message}`);
      this.message = message;
    } finally {
      this.taskRunning = false;
      this.render();
    }
  }

  private async startAgentFromCommand(args: string[]): Promise<void> {
    const result = resolveAgentStartCommand({
      agents: this.dashboard.agents,
      args,
      providerAvailability: this.providerAvailability,
    });
    if (!result.ok || !result.agentId || !result.provider || !result.goal) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    this.addFeed("info", result.message);
    await this.runTask(result.goal, undefined, {
      provider: result.provider,
      agentId: result.agentId,
    });
  }

  private async stopAgentFromCommand(args: string[], confirmed = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveAgentStopCommand({
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      args,
    });
    if (!result.ok) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    if (!confirmed) {
      const safety = evaluateSafetyActionApproval(this.safety, "destructive");
      this.requestConfirmation(
        {
          id: `agent.stop.${result.agentId}`,
          title: "Stop active agent tasks?",
          detail: `${result.agentName} has ${result.runIds.length} queued or running task${result.runIds.length === 1 ? "" : "s"} that will be marked cancelled.\n${safety.message}`,
          confirmLabel: "Stop agent tasks",
          danger: true,
        },
        () => this.stopAgentFromCommand([result.agentId || ""], true),
      );
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, "destructive", { approved: confirmed });
    this.safety = safety.state;
    this.persistState();

    try {
      for (const runId of result.runIds) {
        await api.del(`/api/rooms/${this.config.roomId}/agent-runs/${runId}`);
        this.addFeed("warning", `Stopped ${result.agentName}: ${shortId(runId)}`);
      }
      this.lastRunId = result.runIds[0] || this.lastRunId;
      await this.loadRoomDashboard();
      this.message = `Stopped ${result.runIds.length} active task${result.runIds.length === 1 ? "" : "s"} for ${result.agentName}.`;
      this.persistState();
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `agent-stop: ${message}`);
      this.message = message;
      this.render();
    }
  }

  private async pauseAgentFromCommand(args: string[], confirmed = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveAgentPauseCommand({
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      args,
    });
    if (!result.ok || !result.agentId || !result.agentName) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    if (!confirmed) {
      const safety = evaluateSafetyActionApproval(this.safety, "destructive");
      this.requestConfirmation(
        {
          id: `agent.pause.${result.agentId}`,
          title: "Pause active agent tasks?",
          detail: `${result.agentName} has ${result.runIds.length} queued or running local bridge task${result.runIds.length === 1 ? "" : "s"} that will be marked paused.\n${safety.message}`,
          confirmLabel: "Pause agent tasks",
          danger: true,
        },
        () => this.pauseAgentFromCommand([result.agentId || ""], true),
      );
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, "destructive", { approved: confirmed });
    this.safety = safety.state;
    this.persistState();

    try {
      for (const runId of result.runIds) {
        await api.post(`/api/rooms/${this.config.roomId}/agent-runs/${runId}/pause`, {});
        this.addFeed("warning", `Paused ${result.agentName}: ${shortId(runId)}`);
      }
      this.lastRunId = result.runIds[0] || this.lastRunId;
      await this.loadRoomDashboard();
      this.message = `Paused ${result.runIds.length} active task${result.runIds.length === 1 ? "" : "s"} for ${result.agentName}.`;
      this.persistState();
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `agent-pause: ${message}`);
      this.message = message;
      this.render();
    }
  }

  private async resumeAgentFromCommand(args: string[]): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveAgentResumeCommand({
      agents: this.dashboard.agents,
      runs: this.dashboard.runs,
      args,
    });
    if (!result.ok || !result.agentId || !result.agentName) {
      this.addFeed("warning", result.message);
      this.message = result.message;
      this.render();
      return;
    }

    this.addFeed("info", result.message);
    for (const runId of result.runIds) {
      this.lastRunId = runId;
      await this.runTask(
        "Resume this paused run. Review the prior context and continue with the next useful step.",
        runId,
        { agentId: result.agentId },
      );
    }
  }

  private async continueRunFromCommand(args: string[]): Promise<void> {
    const result = resolveContinueCommand({
      runs: this.dashboard.runs,
      args,
      lastRunId: this.lastRunId,
    });
    if (!result.ok || !result.runId || !result.goal) {
      this.addFeed("warning", result.message || "Unable to continue run.");
      this.message = result.message || "Unable to continue run.";
      this.render();
      return;
    }

    this.lastRunId = result.runId;
    this.addFeed("info", providerSessionStatusForRun(this.dashboard.runs, result.runId).message);
    await this.runTask(result.goal, result.runId);
  }

  private async resumeRunFromCommand(args: string[]): Promise<void> {
    const result = resolveResumeCommand({
      runs: this.dashboard.runs,
      args,
      currentRunId: this.runDetail?.run._id,
      lastRunId: this.lastRunId,
    });
    if (!result.ok || !result.runId || !result.goal) {
      this.addFeed("warning", result.message || "Unable to resume run.");
      this.message = result.message || "Unable to resume run.";
      this.render();
      return;
    }

    this.addFeed("info", `Resuming ${shortId(result.runId)}: ${result.goal}`);
    this.addFeed("info", providerSessionStatusForRun(this.dashboard.runs, result.runId).message);
    this.lastRunId = result.runId;
    await this.runTask(result.goal, result.runId);
  }

  private async forkRunFromCommand(args: string[]): Promise<void> {
    const result = resolveForkCommand({
      runs: this.dashboard.runs,
      args,
      currentRunId: this.runDetail?.run._id,
      lastRunId: this.lastRunId,
    });
    if (!result.ok || !result.goal || !result.runId) {
      this.addFeed("warning", result.message || "Unable to fork run.");
      this.message = result.message || "Unable to fork run.";
      this.render();
      return;
    }

    const sessionStatus = providerSessionStatusForRun(this.dashboard.runs, result.runId);
    this.addFeed("info", `Forking ${shortId(result.runId)} into a new run.`);
    this.addFeed("info", sessionStatus.message);
    await this.runTask(result.goal, undefined, {
      providerSession: {
        mode: "fork",
        sourceRunId: result.runId,
        providerSessionId: sessionStatus.providerSessionId,
      },
    });
  }

  private async rerunFromCommand(runRef?: string): Promise<void> {
    const result = resolveRerunCommand({
      runs: this.dashboard.runs,
      runRef,
    });
    if (!result.ok || !result.goal) {
      this.addFeed("warning", result.message || "Unable to rerun.");
      this.message = result.message || "Unable to rerun.";
      this.render();
      return;
    }

    this.addFeed("info", `Rerunning ${shortId(result.runId)}: ${result.goal}`);
    await this.runTask(result.goal);
  }

  private async retryFromCommand(runRef?: string): Promise<void> {
    const result = resolveRetryCommand({
      runs: this.dashboard.runs,
      runRef,
      currentRunId: this.runDetail?.run._id,
    });
    if (!result.ok || !result.goal) {
      this.addFeed("warning", result.message || "Unable to retry.");
      this.message = result.message || "Unable to retry.";
      this.render();
      return;
    }

    this.addFeed("info", `Retrying ${shortId(result.runId)}: ${result.goal}`);
    await this.runTask(result.goal);
  }

  private async stopRunFromCommand(runRef?: string, confirmed = false): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    const result = resolveStopCommand({
      runs: this.dashboard.runs,
      runRef,
      currentRunId: this.runDetail?.run._id,
    });
    if (!result.ok || !result.runId) {
      this.addFeed("warning", result.message || "Unable to stop run.");
      this.message = result.message || "Unable to stop run.";
      this.render();
      return;
    }

    if (!confirmed) {
      const safety = evaluateSafetyActionApproval(this.safety, "destructive");
      this.requestConfirmation(
        {
          id: `run.stop.${result.runId}`,
          title: "Stop agent task?",
          detail: `Run ${shortId(result.runId)} will be marked cancelled and any supported local/hosted execution will be asked to stop.\n${safety.message}`,
          confirmLabel: "Stop run",
          danger: true,
        },
        () => this.stopRunFromCommand(result.runId, true),
      );
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, "destructive", { approved: confirmed });
    this.safety = safety.state;
    this.persistState();

    try {
      await api.del(`/api/rooms/${this.config.roomId}/agent-runs/${result.runId}`);
      this.addFeed("warning", `Stopped run: ${shortId(result.runId)}`);
      this.lastRunId = result.runId;
      await this.loadRoomDashboard();
      if (this.runDetail?.run._id === result.runId) {
        await this.openRunDetail(result.runId);
      } else {
        this.message = `Stopped run ${shortId(result.runId)}.`;
        this.persistState();
        this.render();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `stop: ${message}`);
      this.message = message;
      this.render();
    }
  }

  private async refreshWorkspace(): Promise<void> {
    this.workspace = await loadWorkspaceContext(this.args.dir);
  }

  private showWorkspaceInFeed(): void {
    if (!this.workspace.isGitRepo) {
      this.addFeed("info", "No git repository detected.");
      return;
    }
    const lines = [
      `branch ${compact(this.workspace.branch, "detached")}`,
      `state ${this.workspace.dirty ? "dirty" : "clean"} (${this.workspace.changedFiles.length} files, +${this.workspace.insertions}/-${this.workspace.deletions})`,
      `sync ${this.workspace.ahead} ahead, ${this.workspace.behind} behind`,
      `changes staged ${this.workspace.stagedCount}, unstaged ${this.workspace.unstagedCount}, untracked ${this.workspace.untrackedCount}`,
      ...this.workspace.changedFiles.slice(0, 20).map((file) => this.workspaceFileLine(file)),
    ];
    if (this.workspace.changedFiles.length > 20) {
      lines.push(`... ${this.workspace.changedFiles.length - 20} more`);
    }
    this.addFeed("info", lines.join("\n"));
  }

  private workspaceFileLine(file: WorkspaceFileChange): string {
    return `${file.status.padEnd(2)} ${file.path}`;
  }

  private showWorkspaceFilePreviewInFeed(ref: string): void {
    const result = loadWorkspaceFilePreview({
      dir: this.args.dir,
      ref,
      contextLines: 8,
    });
    this.addFeed(result.error ? "warning" : "info", formatWorkspaceFilePreview(result));
    this.message = result.error ? "File preview unavailable." : `Previewing ${result.path}:${result.requestedLine || 1}.`;
  }

  private async showFilesInFeed(query: string): Promise<void> {
    const result = await listWorkspaceFiles({
      dir: this.args.dir,
      query,
      limit: 30,
    });
    if (result.error) {
      this.addFeed("error", `files: ${result.error}`);
      this.message = "File list unavailable.";
      return;
    }
    if (result.files.length === 0) {
      this.addFeed("info", query ? `No files matched ${query}.` : "No workspace files found.");
      this.message = "No files found.";
      return;
    }
    this.addFeed("info", [
      query ? `Files matching ${query}:` : "Workspace files:",
      "Use /attach <path> to include a file in the next task.",
      ...result.files,
    ].join("\n"));
    this.message = `Listed ${result.files.length} files.`;
  }

  private async showSearchInFeed(query: string): Promise<void> {
    const result = await searchWorkspaceText({
      dir: this.args.dir,
      query,
      limit: 25,
    });
    if (result.error) {
      this.addFeed(result.query ? "warning" : "error", `search: ${result.error}`);
      this.message = result.query ? "No search results." : "Search needs a query.";
      return;
    }
    if (result.matches.length === 0) {
      this.addFeed("info", `No matches for ${result.query}.`);
      this.message = "No search results.";
      return;
    }
    this.addFeed("info", [
      `Search ${result.query}:`,
      ...result.matches.map((match) => this.searchMatchLine(match)),
    ].join("\n"));
    this.message = `Search returned ${result.matches.length} matches.`;
  }

  private async showWorkspaceDiffInFeed(path: string): Promise<void> {
    this.message = path ? `Loading diff for ${path}...` : "Loading workspace diff...";
    this.render();

    const result = await loadWorkspaceDiff({
      dir: this.args.dir,
      path,
      limit: 220,
    });
    if (result.error) {
      this.addFeed("error", `diff: ${result.error}`);
      this.message = "Workspace diff unavailable.";
      return;
    }
    if (result.lines.length === 0) {
      this.addFeed("info", result.path ? `No diff for ${result.path}.` : "No workspace diff.");
      this.message = "No workspace diff.";
      return;
    }
    this.addFeed("output", [
      this.workspaceDiffTitle(result),
      ...result.lines.map((line) => stripAnsi(diffLine(line))),
      result.truncated ? "... diff truncated; pass a path to narrow results." : "",
    ].filter(Boolean).join("\n"));
    this.message = `Diff loaded: ${result.lines.length} lines${result.truncated ? " (truncated)" : ""}.`;
  }

  private workspaceDiffTitle(result: WorkspaceDiffResult): string {
    return result.path ? `Workspace diff: ${result.path}` : "Workspace diff";
  }

  private searchMatchLine(match: WorkspaceSearchMatch): string {
    return `${match.path}:${match.line}:${match.column}: ${compact(match.text, "")}`;
  }

  private async showSymbolsInFeed(query: string): Promise<void> {
    this.message = query ? `Scanning symbols for ${query}...` : "Scanning workspace symbols...";
    this.render();

    const result = await loadWorkspaceSymbols({
      dir: this.args.dir,
      query,
      limit: 40,
    });

    if (result.error) {
      this.addFeed("error", `symbols: ${result.error}`);
      this.message = "Symbol scan unavailable.";
      return;
    }

    if (result.symbols.length === 0) {
      this.addFeed("info", query
        ? `No symbols matched ${query} across ${result.scannedFiles} files.`
        : `No symbols found across ${result.scannedFiles} files.`);
      this.message = "No symbols found.";
      return;
    }

    this.addFeed("info", [
      query ? `Symbols matching ${query}:` : "Workspace symbols:",
      ...result.symbols.map((symbol) => this.symbolLine(symbol)),
      result.symbols.length >= 40 ? "Use /symbols <query> to narrow results." : "",
    ].filter(Boolean).join("\n"));
    this.message = `Listed ${result.symbols.length} symbols from ${result.scannedFiles} files.`;
  }

  private symbolLine(symbol: TuiSymbol): string {
    return `${symbol.path}:${symbol.line}:${symbol.column}: ${symbol.kind.padEnd(9)} ${symbol.name}  ${compact(symbol.signature, "")}`;
  }

  private async showSymbolNavigationInFeed(query: string): Promise<void> {
    this.message = query ? `Finding symbol ${query}...` : "Symbol navigation needs a query.";
    this.render();

    const result = await loadSymbolNavigation({
      dir: this.args.dir,
      query,
    });

    if (!result.symbol) {
      this.addFeed(result.error ? "error" : "warning", `goto: ${result.message}`);
      this.message = result.message;
      return;
    }

    this.addFeed("success", [
      "Symbol location:",
      this.symbolLine(result.symbol),
      `Scanned ${result.scannedFiles} files.`,
    ].join("\n"));
    this.message = result.message;
  }

  private async showRenamePreviewInFeed(args: string[]): Promise<void> {
    const [oldName = "", newName = ""] = args;
    this.message = oldName && newName
      ? `Previewing rename ${oldName} -> ${newName}...`
      : "Rename preview needs a symbol and a new name.";
    this.render();

    const result = await loadRenamePreview({
      dir: this.args.dir,
      oldName,
      newName,
    });

    if (result.error || !result.symbol) {
      this.addFeed(result.error ? "error" : "warning", `rename-preview: ${result.message}`);
      this.message = result.message;
      return;
    }

    const visible = result.occurrences.slice(0, 25);
    this.addFeed("info", [
      result.message,
      `Definition ${this.symbolLine(result.symbol)}`,
      ...visible.map((occurrence) => this.renameOccurrenceLine(occurrence)),
      result.occurrences.length > visible.length ? `... ${result.occurrences.length - visible.length} more` : "",
    ].filter(Boolean).join("\n"));
    this.message = result.message;
  }

  private async renameSymbolFromCommand(args: string[], approved = false): Promise<void> {
    const [oldName = "", newName = ""] = args;
    this.message = oldName && newName
      ? `${approved ? "Applying" : "Preparing"} rename ${oldName} -> ${newName}...`
      : "Rename needs a symbol and a new name.";
    this.render();

    if (!oldName || !newName) {
      this.addFeed("warning", "Usage: /rename <symbol> <new-name>");
      this.message = "Usage: /rename <symbol> <new-name>";
      return;
    }

    if (!approved) {
      const preview = await loadRenamePreview({
        dir: this.args.dir,
        oldName,
        newName,
      });
      if (preview.error || !preview.symbol || preview.occurrences.length === 0) {
        this.addFeed(preview.error ? "error" : "warning", `rename: ${preview.message}`);
        this.message = preview.message;
        return;
      }
      const visible = preview.occurrences.slice(0, 10);
      this.addFeed("info", [
        preview.message,
        `Definition ${this.symbolLine(preview.symbol)}`,
        ...visible.map((occurrence) => this.renameOccurrenceLine(occurrence)),
        preview.occurrences.length > visible.length ? `... ${preview.occurrences.length - visible.length} more` : "",
      ].filter(Boolean).join("\n"));
      const safety = evaluateSafetyActionApproval(this.safety, "file-edit");
      this.requestConfirmation({
        id: "rename-symbol",
        title: `Apply rename ${preview.oldName} -> ${preview.newName}?`,
        detail: `${preview.occurrences.length} occurrence${preview.occurrences.length === 1 ? "" : "s"} will be edited. This changes files on disk.\n${safety.message}`,
        confirmLabel: "Apply rename",
        cancelLabel: "Cancel",
        danger: true,
      }, () => this.renameSymbolFromCommand([preview.oldName, preview.newName], true));
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, "file-edit", { approved });
    this.safety = safety.state;
    this.persistState();

    const result = await applyRename({
      dir: this.args.dir,
      oldName,
      newName,
    });
    if (result.error || result.changedFiles.length === 0) {
      this.addFeed(result.error ? "error" : "warning", `rename: ${result.message}`);
      this.message = result.message;
      return;
    }

    this.undoStack = pushUndoSnapshot(this.undoStack, createUndoSnapshot({
      label: `rename ${result.oldName} -> ${result.newName}`,
      provider: this.provider,
      model: this.model,
      selectedAgentId: this.selectedAgentId,
      attachments: this.taskAttachments,
      pins: this.pins,
      safety: this.safety,
      fileChanges: result.fileChanges,
    }));
    this.addFeed("success", [
      result.message,
      `Changed files: ${result.changedFiles.join(", ")}`,
      "Use /undo to restore these file edits.",
    ].join("\n"));
    this.message = result.message;
  }

  private renameOccurrenceLine(occurrence: TuiRenameOccurrence): string {
    return `${occurrence.path}:${occurrence.line}:${occurrence.column}: ${compact(occurrence.text, "")}`;
  }

  private async showDiagnosticsInFeed(project: string): Promise<void> {
    const diagnosticsLabel = diagnosticsRequestLabel(project);
    this.message = `Running ${diagnosticsLabel}...`;
    this.render();

    this.diagnostics = await loadWorkspaceDiagnostics({
      dir: this.args.dir,
      request: project || undefined,
      timeoutMs: 20_000,
    });

    if (this.diagnostics.error) {
      const projectLines = this.diagnostics.projects && this.diagnostics.projects.length > 0
        ? ["", "Available TypeScript projects:", ...this.diagnostics.projects.slice(0, 30).map((path) => `  ${path}`)]
        : [];
      this.addFeed("warning", [
        `diagnostics: ${this.diagnostics.error}`,
        ...projectLines,
        ...(this.diagnostics.projects && this.diagnostics.projects.length > 30
          ? [`  ... ${this.diagnostics.projects.length - 30} more`]
          : []),
      ].join("\n"));
      this.message = this.diagnostics.projects && this.diagnostics.projects.length > 1
        ? "Diagnostics need a tsconfig path."
        : "Diagnostics unavailable.";
      return;
    }

    if (this.diagnostics.diagnostics.length === 0) {
      this.addFeed("success", `Diagnostics clean: ${this.diagnostics.label || this.diagnostics.project}`);
      this.message = "Diagnostics clean.";
      return;
    }

    const visible = this.diagnostics.diagnostics.slice(0, 25);
    this.addFeed("warning", [
      `Diagnostics ${this.diagnostics.label || this.diagnostics.project}: ${this.diagnostics.diagnostics.length} issues`,
      ...visible.map((diagnostic) => this.diagnosticLine(diagnostic)),
      ...(this.diagnostics.diagnostics.length > visible.length
        ? [`... ${this.diagnostics.diagnostics.length - visible.length} more`]
        : []),
    ].join("\n"));
    this.message = `Diagnostics found ${this.diagnostics.diagnostics.length} issues.`;
  }

  private diagnosticLine(diagnostic: TypeScriptDiagnosticResult["diagnostics"][number]): string {
    return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code} ${diagnostic.message}`;
  }

  private handleInstructionsCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();
    this.instructions = loadProjectInstructions(this.args.dir);

    if (subcommand === "attach" || subcommand === "add") {
      if (this.instructions.files.length === 0) {
        this.addFeed("info", "No project instruction files found.");
        this.message = "No instruction files found.";
        return;
      }
      for (const file of this.instructions.files) {
        if (this.instructions.files.indexOf(file) === 0) {
          this.rememberUndo("attach instructions");
        }
        const result = addAttachment(this.taskAttachments, file.path, {
          kind: "file",
          projectDir: this.args.dir,
        });
        this.taskAttachments = result.attachments;
      }
      this.addFeed(
        "info",
        `Attached instruction files: ${this.instructions.files.map((file) => file.path).join(", ")}`,
      );
      this.message = `Attached ${this.instructions.files.length} instruction files.`;
      this.persistState();
      return;
    }

    this.addFeed(
      "info",
      ["Project instructions:", ...instructionSummary(this.instructions, 20), "", "Use /instructions attach to include them in the next task."].join("\n"),
    );
    this.message = this.instructions.files.length > 0
      ? `${this.instructions.files.length} instruction files found.`
      : "No instruction files found.";
  }

  private handleMemoryCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();
    this.memoryContext = loadProjectMemory(this.args.dir);

    if (subcommand === "attach" || subcommand === "add") {
      if (this.memoryContext.files.length === 0) {
        this.addFeed("info", "No project memory files found.");
        this.message = "No memory files found.";
        return;
      }
      for (const file of this.memoryContext.files) {
        if (this.memoryContext.files.indexOf(file) === 0) {
          this.rememberUndo("attach memory");
        }
        const result = addAttachment(this.taskAttachments, file.path, {
          kind: "file",
          projectDir: this.args.dir,
        });
        this.taskAttachments = result.attachments;
      }
      this.addFeed(
        "info",
        `Attached memory files: ${this.memoryContext.files.map((file) => file.path).join(", ")}`,
      );
      this.message = `Attached ${this.memoryContext.files.length} memory files.`;
      this.persistState();
      return;
    }

    this.addFeed(
      "info",
      ["Project memory:", ...memorySummary(this.memoryContext, 20), "", "Use /memory attach to include them in the next task."].join("\n"),
    );
    this.message = this.memoryContext.files.length > 0
      ? `${this.memoryContext.files.length} memory files found.`
      : "No memory files found.";
  }

  private async showContextInFeed(): Promise<void> {
    await this.refreshWorkspace();
    this.instructions = loadProjectInstructions(this.args.dir);
    this.memoryContext = loadProjectMemory(this.args.dir);
    const agent = this.selectedAgent();
    const agentName = agent
      ? `${compact(agent.name, "agent")} ${shortId(agent._id)}`
      : undefined;
    const lines = taskContextSummary({
      roomName: this.config?.roomName,
      roomId: this.config?.roomId,
      projectDir: this.args.dir,
      provider: this.provider,
      model: this.model,
      agentName,
      workspace: this.workspace,
      safety: this.safety,
      attachments: this.taskAttachments,
      instructions: this.instructions,
      memory: this.memoryContext,
    });
    this.addFeed("info", lines.join("\n"));
    this.message = "Task context listed.";
  }

  private showDoctorInFeed(): void {
    const report = buildDoctorReport({
      projectDir: this.args.dir,
      server: api.getBaseUrl(),
      session: this.session,
      projectConfig: this.config,
      projectState: {
        selectedRoomId: this.selectedRoomId,
        selectedRoomName: this.selectedRoomName,
      },
    });
    this.addFeed("info", formatDoctorReport(report));
    this.message = report.strictReady ? "Doctor ready." : "Doctor found readiness blockers.";
  }

  private async showTuiQaInFeed(command = "qa", args: string[] = []): Promise<void> {
    const resolution = resolveTuiQaSlashCommand(command, args);
    if (resolution.error) {
      this.addFeed("warning", resolution.error);
      this.message = "TUI QA command rejected.";
      return;
    }
    if (resolution.live) {
      this.message = "Running live TUI QA preflight...";
      const report = await buildTuiLiveQaReport({
        dir: this.args.dir,
        roomId: resolution.roomId || this.config?.roomId || this.selectedRoomId,
        serverUrl: api.getBaseUrl(),
        includeTerminal: resolution.includeTerminal,
        allowMutations: false,
        bridgeUrl: resolution.bridgeUrl,
        getSession: () => this.session,
        apiGet: api.get,
      });
      this.addFeed(report.ok ? "success" : "error", formatTuiLiveQaReport(report));
      this.message = report.ok ? "Live TUI QA passed." : "Live TUI QA found blockers.";
      return;
    }
    const report = buildTuiQaReport();
    this.addFeed(report.ok ? "success" : "error", formatTuiQaReport(report));
    this.message = report.ok ? "TUI QA passed." : "TUI QA failed.";
  }

  private attachFile(path: string): void {
    const result = addAttachment(this.taskAttachments, path, { projectDir: this.args.dir });
    if (result.ok) this.rememberUndo("attach");
    this.taskAttachments = result.attachments;
    this.addFeed(result.ok ? "info" : "warning", result.message);
    this.message = result.message;
    if (result.ok) this.persistState();
  }

  private attachImage(path: string): void {
    const result = addAttachment(this.taskAttachments, path, {
      kind: "image",
      projectDir: this.args.dir,
    });
    if (result.ok) this.rememberUndo("attach image");
    this.taskAttachments = result.attachments;
    this.addFeed(result.ok ? "info" : "warning", result.message);
    this.message = result.message;
    if (result.ok) this.persistState();
  }

  private detachFile(target: string): void {
    const result = removeAttachment(this.taskAttachments, target);
    if (result.ok) this.rememberUndo("detach");
    this.taskAttachments = result.attachments;
    this.addFeed(result.ok ? "info" : "warning", result.message);
    this.message = result.message;
    if (result.ok) this.persistState();
  }

  private showAttachmentsInFeed(): void {
    const summary = [
      attachmentSummary(this.taskAttachments),
      ...attachmentTransportSummary(this.taskAttachments, this.provider, this.args.dir).lines,
    ].join("\n");
    this.addFeed("info", summary);
    this.message = this.taskAttachments.length > 0 ? `${this.taskAttachments.length} files attached.` : "No attached files.";
  }

  private handlePinCommand(args: string[]): void {
    const target = (args[0] || "room").toLowerCase();
    if (target === "room") {
      if (!this.config?.roomId) {
        this.addFeed("warning", "No room configured to pin.");
        this.message = "No room configured to pin.";
        return;
      }
      this.rememberUndo("pin room");
      this.pins = pinRoom(this.pins, {
        roomId: this.config.roomId,
        roomName: this.config.roomName,
      });
      this.addFeed("info", `Pinned room: ${this.config.roomName || this.config.roomId}`);
      this.message = "Pinned current room.";
      this.persistState();
      return;
    }

    if (target === "provider") {
      const provider = args[1] || this.provider;
      this.rememberUndo("pin provider");
      this.pins = pinProvider(this.pins, provider);
      this.addFeed("info", `Pinned provider: ${provider}`);
      this.message = "Pinned provider.";
      this.persistState();
      return;
    }

    if (target === "agent") {
      const agent = this.findAgent(args.slice(1).join(" "));
      if (!agent) {
        this.addFeed("warning", "No matching agent. Use /agent to list loaded agents first.");
        this.message = "No matching agent.";
        return;
      }
      this.rememberUndo("pin agent");
      this.pins = pinAgent(this.pins, {
        agentId: agent._id,
        name: agent.name,
        provider: agent.provider,
      });
      this.addFeed("info", `Pinned agent: ${agent.name || agent._id}`);
      this.message = "Pinned agent.";
      this.persistState();
      return;
    }

    this.addFeed("warning", "Pin one of: room, provider, agent.");
    this.message = "Unknown pin target.";
  }

  private handleUnpinCommand(args: string[]): void {
    const target = args[0]?.toLowerCase() as PinTarget | undefined;
    if (!target || !["room", "provider", "agent"].includes(target)) {
      this.addFeed("warning", "Usage: /unpin <room|provider|agent> <value>");
      this.message = "Unpin needs a target.";
      return;
    }

    const fallback =
      target === "room" ? this.config?.roomId || "" :
      target === "provider" ? this.provider :
      "";
    const value = args.slice(1).join(" ") || fallback;
    if (!value) {
      this.addFeed("warning", `No ${target} value to unpin.`);
      this.message = `No ${target} value to unpin.`;
      return;
    }

    this.requestConfirmation(
      {
        id: `pin.unpin.${target}`,
        title: `Unpin ${target}?`,
        detail: value,
        confirmLabel: "Unpin",
        danger: true,
      },
      () => this.applyUnpin(target, value),
    );
  }

  private applyUnpin(target: PinTarget, value: string): void {
    this.rememberUndo(`unpin ${target}`);
    this.pins = unpinTarget(this.pins, target, value);
    this.addFeed("info", `Unpinned ${target}: ${value}`);
    this.message = `Unpinned ${target}.`;
    this.persistState();
    this.render();
  }

  private showPinsInFeed(): void {
    this.addFeed("info", ["Pinned preferences:", ...pinSummaryLines(this.pins)].join("\n"));
    this.message = "Pinned preferences listed in the feed.";
  }

  private findAgent(value: string): AgentRecord | null {
    const query = value.trim().toLowerCase();
    if (!query) return null;
    return this.dashboard.agents.find((agent) => {
      const name = agent.name?.toLowerCase();
      return agent._id === value || agent._id.endsWith(value) || name === query;
    }) || null;
  }

  private findRoom(value: string): { roomId: string; roomName?: string } | null {
    const query = value.trim().toLowerCase();
    if (!query) return null;
    const rooms = this.knownRooms();
    const byIndex = Number.parseInt(value, 10);
    if (Number.isInteger(byIndex) && byIndex > 0) {
      const indexed = rooms[byIndex - 1];
      if (indexed) return { roomId: indexed.roomId, roomName: indexed.roomName };
    }
    return rooms.find((room) => {
      const name = room.roomName?.toLowerCase();
      return room.roomId === value || room.roomId.endsWith(value) || name === query;
    }) || null;
  }

  private knownRooms(): Array<{ roomId: string; roomName?: string; status?: string; agentCount?: number; memberCount?: number }> {
    const rooms: Array<{ roomId: string; roomName?: string; status?: string; agentCount?: number; memberCount?: number }> = [];
    const add = (room: { roomId: string; roomName?: string; status?: string; agentCount?: number; memberCount?: number }) => {
      if (!room.roomId) return;
      const existing = rooms.findIndex((candidate) => candidate.roomId === room.roomId);
      if (existing >= 0) {
        rooms[existing] = { ...rooms[existing], ...room };
        return;
      }
      rooms.push(room);
    };
    if (this.config?.roomId) {
      add({ roomId: this.config.roomId, roomName: this.config.roomName });
    }
    for (const room of this.pins.rooms) {
      add({ roomId: room.roomId, roomName: room.roomName });
    }
    for (const room of this.rooms) {
      add({
        roomId: room._id,
        roomName: room.name,
        status: room.status,
        agentCount: room.agents?.length,
        memberCount: room.members?.length,
      });
    }
    return rooms;
  }

  private knownRoomLabels(): string[] {
    return this.knownRooms().map((room) => room.roomName || room.roomId);
  }

  private handleSafetyCommand(args: string[]): void {
    const subcommand = (args[0] || "show").toLowerCase();
    if (subcommand === "toggle") {
      const target = args.slice(1).join(" ");
      if (!this.safety.allowDangerousCommands && this.isDangerousToggle(target)) {
        this.requestConfirmation(
          {
            id: "safety.dangerous",
            title: "Allow dangerous commands?",
            detail: "This changes the local TUI safety policy for the current session.",
            confirmLabel: "Allow",
            danger: true,
          },
          () => this.applySafetyToggle(target),
        );
        return;
      }
      this.applySafetyToggle(target);
      return;
    }

    if (subcommand === "audit") {
      this.showSafetyAuditInFeed();
      this.message = "Safety audit listed in the feed.";
      return;
    }

    this.addFeed("info", [
      "Safety policy:",
      ...safetyLines(this.safety, this.provider),
      "",
      "Use /safety toggle <auto-run|auto-apply|network|dangerous> to change local session toggles.",
    ].join("\n"));
    this.message = "Safety policy listed in the feed.";
  }

  private applySafetyToggle(target: string): void {
    const result = toggleSafety(this.safety, target);
    if (result.ok) this.rememberUndo("safety toggle");
    this.safety = result.state;
    this.addFeed(result.ok ? "info" : "warning", result.message);
    this.message = result.message;
    if (result.ok) this.persistState();
    this.render();
  }

  private isDangerousToggle(target: string): boolean {
    const normalized = target.trim().toLowerCase();
    return normalized === "danger" || normalized === "dangerous" || normalized === "dangerous-commands";
  }

  private showSafetyAuditInFeed(): void {
    if (this.safety.audit.length === 0) {
      this.addFeed("info", "No local safety audit events yet.");
      return;
    }
    this.addFeed(
      "info",
      this.safety.audit
        .slice(-20)
        .map((entry) => {
          const at = new Date(entry.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          return `${at} ${entry.decision} ${entry.action}: ${entry.reason}`;
        })
        .join("\n"),
    );
  }

  private async handleRunKey(chunk: string, key: KeyInfo): Promise<void> {
    const intent = resolveRunKey(chunk, key);
    switch (intent.type) {
      case "back":
        this.mode = "menu";
        this.message = "Returned to dashboard.";
        this.render();
        return;
      case "refresh":
        await this.openRunDetail(this.runDetail?.run._id);
        return;
      case "move_patch":
        this.moveSelectedPatch(intent.direction);
        return;
      case "select_patch":
        this.selectPatch(intent.position);
        return;
      case "accept_patch":
        await this.resolveSelectedPatch("accept");
        return;
      case "reject_patch":
        await this.resolveSelectedPatch("reject");
        return;
      case "export_run":
        this.exportCurrentRunSummary();
        return;
      case "copy_run":
        this.copyCurrentRun("summary");
        return;
      case "retry_run":
        await this.retryFromCommand(this.runDetail?.run._id);
        return;
      case "stop_run":
        await this.stopRunFromCommand(this.runDetail?.run._id);
        return;
      case "handoff_run":
        this.openRunHandoffComposer();
        return;
      case "cycle_handoff_target":
        this.cycleRunHandoffTarget(intent.direction);
        return;
      case "open_run":
        await this.openRunDetail(intent.index);
        return;
      case "none":
        return;
    }
  }

  private openRunHandoffComposer(): void {
    const target = this.handoffTargetAgent();
    this.mode = "task";
    this.taskInput = formatHandoffPrefill(target);
    this.message = target
      ? `Handoff target: ${handoffTargetLabel(target)}. Add context or press Enter.`
      : "Choose a target agent for this handoff.";
    this.render();
  }

  private cycleRunHandoffTarget(direction: -1 | 1): void {
    const target = cycleHandoffTarget(this.dashboard.agents, this.handoffTargetAgentId, direction);
    if (!target) {
      this.message = "No agents loaded for handoff target selection.";
      this.addFeed("warning", this.message);
      this.render();
      return;
    }

    this.handoffTargetAgentId = target._id;
    this.message = `Handoff target: ${handoffTargetLabel(target)}`;
    this.render();
  }

  private selectHandoffTargetFromCommand(query: string): void {
    const result = resolveHandoffTarget(this.dashboard.agents, query);
    if (!result.ok) {
      this.message = result.message;
      this.addFeed("warning", result.message);
      return;
    }

    this.handoffTargetAgentId = result.agent._id;
    this.message = result.message;
    this.addFeed("info", `${result.message}. Press h from task detail or use /handoff current ${result.agent._id} <context>.`);
  }

  private moveSelectedPatch(direction: -1 | 1): void {
    const count = this.runDetail?.patches.length ?? 0;
    if (count === 0) return;
    this.runDetailPatchIndex = (this.runDetailPatchIndex + direction + count) % count;
    this.render();
  }

  private selectPatch(position: "first" | "last"): void {
    const count = this.runDetail?.patches.length ?? 0;
    if (count === 0) return;
    this.runDetailPatchIndex = position === "first" ? 0 : count - 1;
    this.render();
  }

  private async openRunDetail(runRef?: string | number): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }
    if (!this.session) {
      this.message = "Login before inspecting runs.";
      this.render();
      return;
    }

    const runId = resolveRunId(this.dashboard.runs, runRef);
    if (!runId) {
      this.message = "No matching run loaded.";
      this.render();
      return;
    }

    this.mode = "run";
    this.message = `Loading task ${shortId(runId)}...`;
    this.render();

    try {
      this.runDetail = await loadRunDetailData({
        roomId: this.config.roomId,
        runId,
      });
      this.runDetailPatchIndex = Math.min(this.runDetailPatchIndex, Math.max(0, this.runDetail.patches.length - 1));
      this.dashboard.runs = this.runDetail.allRuns;
      this.lastRunId = this.runDetail.run._id;
      this.persistState();
      this.message = `Viewing run ${shortId(this.runDetail.run._id)}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runDetail = null;
      this.addFeed("error", `run: ${message}`);
      this.message = message;
    } finally {
      this.render();
    }
  }

  private async resolveSelectedPatch(action: "accept" | "reject", confirmed = false): Promise<void> {
    if (!this.config?.roomId || !this.runDetail) return;
    const patch = this.runDetail.patches[this.runDetailPatchIndex];
    if (!patch) {
      this.message = "No patch selected.";
      this.render();
      return;
    }
    if (patch.status !== "proposed") {
      this.message = `Patch is already ${patch.status || "resolved"}.`;
      this.render();
      return;
    }
    const safetyAction: TuiSafetyAction = action === "accept" ? "file-edit" : "destructive";
    if (!confirmed) {
      const safety = evaluateSafetyActionApproval(this.safety, safetyAction);
      this.requestConfirmation(
        {
          id: `patch.${action}`,
          title: `${action === "accept" ? "Accept" : "Reject"} proposed patch?`,
          detail: `${shortId(patch._id)} from run ${shortId(this.runDetail.run._id)}\n${safety.message}`,
          confirmLabel: action === "accept" ? "Accept patch" : "Reject patch",
          danger: true,
        },
        () => this.resolveSelectedPatch(action, true),
      );
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, safetyAction, { approved: confirmed });
    this.safety = safety.state;
    this.persistState();

    try {
      await resolveRunPatch({
        roomId: this.config.roomId,
        patchId: patch._id,
        action,
      });
      if (action === "reject") {
        this.undoStack = pushUndoSnapshot(this.undoStack, createUndoSnapshot({
          label: "patch reject",
          provider: this.provider,
          model: this.model,
          selectedAgentId: this.selectedAgentId,
          attachments: this.taskAttachments,
          pins: this.pins,
          safety: this.safety,
          serverChanges: [{
            kind: "patch-reopen",
            roomId: this.config.roomId,
            runId: this.runDetail.run._id,
            patchId: patch._id,
            fromStatus: "rejected",
            toStatus: "proposed",
          }],
        }));
      }
      this.addFeed(
        action === "accept" ? "success" : "warning",
        action === "reject"
          ? `Patch rejected: ${shortId(patch._id)}\nUse /undo to reopen this patch.`
          : `Patch accepted: ${shortId(patch._id)}`,
      );
      await this.openRunDetail(this.runDetail.run._id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addFeed("error", `patch ${action}: ${message}`);
      this.message = message;
      this.render();
    }
  }

  private async focusOrConnectTerminal(): Promise<void> {
    if (!this.config?.roomId) {
      this.message = "No room configured. Initialize this directory first.";
      this.render();
      return;
    }

    if (!this.terminalSession) {
      await this.connectEmbeddedTerminal({ focusAfterConnect: true });
    }

    if (this.terminalSession) {
      this.mode = "terminal";
      this.message = "Shared terminal input active.";
      this.render();
    }
  }

  private async connectEmbeddedTerminal(options: { approved?: boolean; focusAfterConnect?: boolean } = {}): Promise<void> {
    if (!this.config?.roomId) return;
    const sessionToken = api.getSessionToken();
    if (!sessionToken) {
      this.message = "Login before connecting the shared terminal.";
      this.render();
      return;
    }

    const safety = evaluateSafetyActionApproval(this.safety, "network", { approved: options.approved });
    if (safety.status === "needs-approval") {
      this.requestConfirmation(
        {
          id: "terminal.network.approve",
          title: "Connect shared terminal?",
          detail: `${safety.message}\nThis opens a realtime network session to the room terminal gateway.`,
          confirmLabel: "Connect terminal",
        },
        () => this.connectEmbeddedTerminal({ approved: true, focusAfterConnect: options.focusAfterConnect }),
      );
      return;
    }
    this.safety = safety.state;
    this.persistState();

    const result = await connectTuiTerminal({
      roomId: this.config.roomId,
      workDir: this.args.dir,
      serverUrl: api.getBaseUrl(),
      sessionToken,
      ...resolveTerminalPaneSize(process.stdout.columns, process.stdout.rows),
      onEvent: (event) => this.handleTerminalEvent(event),
    });

    if (result.ok) {
      this.terminalSession = result.session;
      if (options.focusAfterConnect) {
        this.mode = "terminal";
        this.message = "Shared terminal input active.";
        this.render();
      }
    }
  }

  private handleTerminalEvent(event: TuiTerminalEvent): void {
    const wasDisconnected = !this.terminalState.connected && Boolean(this.terminalState.disconnectReason);
    this.terminalState = reduceTerminalConnectionState(this.terminalState, event);

    if (event.type === "connecting") {
      const reconnecting = wasDisconnected || this.terminalLines.length > 0;
      this.addFeed("info", reconnecting ? "Reconnecting shared terminal..." : "Connecting shared terminal...");
      this.message = reconnecting ? "Reconnecting shared terminal..." : "Connecting shared terminal...";
      this.render();
      return;
    }

    if (event.type === "status") {
      this.addFeed("info", `terminal: ${event.message}`);
      this.message = `Terminal ${event.message}`;
      this.render();
      return;
    }

    if (event.type === "output") {
      this.terminalLines = appendTerminalOutputLines(this.terminalLines, event.data);
      this.render();
      return;
    }

    if (event.type === "error") {
      this.addFeed("error", `terminal: ${event.message}`);
      this.message = event.message;
      this.render();
      return;
    }

    if (event.type === "closed") {
      this.terminalSession = null;
      if (this.mode === "terminal") this.mode = "menu";
      this.addFeed("warning", `terminal closed: ${this.terminalState.disconnectReason || "Connection closed"}`);
      this.message = `Shared terminal disconnected. Use /reconnect to restore it.`;
      this.render();
    }
  }

  private handleTerminalKey(chunk: string, key: KeyInfo): void {
    if (key.ctrl && key.name === "]") {
      this.mode = "menu";
      this.message = "Shared terminal input paused.";
      this.render();
      return;
    }

    if (key.name === "escape") {
      this.mode = "menu";
      this.message = "Shared terminal input paused.";
      this.render();
      return;
    }

    if (!this.terminalSession) {
      this.mode = "menu";
      this.message = "Shared terminal is not connected.";
      this.render();
      return;
    }

    if (chunk) {
      this.terminalSession.write(chunk);
    }
  }

  private addFeed(kind: FeedKind, text: string): void {
    if (!text) return;
    this.feed.push({ kind, text, createdAt: Date.now() });
    if (this.feed.length > 250) {
      this.feed.splice(0, this.feed.length - 250);
    }
  }

  private recallTaskHistory(direction: -1 | 1): void {
    if (this.taskHistory.length === 0) return;
    if (this.taskHistoryIndex === -1) {
      this.taskHistoryIndex = direction < 0 ? this.taskHistory.length - 1 : 0;
    } else {
      this.taskHistoryIndex = Math.max(0, Math.min(this.taskHistory.length - 1, this.taskHistoryIndex + direction));
    }
    this.taskInput = this.taskHistory[this.taskHistoryIndex] || "";
    this.render();
  }

  private async handoff(command: () => Promise<void>, returnsToTui: boolean): Promise<void> {
    this.stopTerminal();
    let error: unknown = null;
    try {
      await command();
    } catch (err) {
      error = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n[co-od] ${message}`);
    } finally {
      if (returnsToTui) {
        await waitForEnter();
        await this.refresh();
        if (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.message = message;
        }
        this.startTerminal();
        this.render();
      }
    }
  }

  private async openBrowser(): Promise<void> {
    if (!this.config?.roomId) return;
    const url = `${api.getBaseUrl()}/rooms/${this.config.roomId}`;
    try {
      const open = (await import("open")).default;
      await open(url);
      this.message = `Opened ${url}`;
    } catch {
      this.message = `Open manually: ${url}`;
    }
    this.render();
  }

  private cycleProvider(): void {
    const result = resolveProviderCommand({
      current: this.provider,
      availability: this.providerAvailability,
      providers: PROVIDERS,
    });
    if (result.ok) {
      this.provider = result.provider;
      this.clearSelectedAgentIfProviderChanged();
    }
    this.message = result.message;
    this.persistState();
  }

  private clearSelectedAgentIfProviderChanged(): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    if (resolveLocalProviderForAgent(agent) === this.provider) return;
    this.selectedAgentId = undefined;
  }

  private quit(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bridgeApprovalAbort?.abort();
    this.bridgeApprovalAbort = null;
    this.terminalSession?.close();
    this.stopTerminal();
    this.resolveDone?.();
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const app = new CoOdTerminalApp(parsed);
  await app.run();
}

function previewText(text: string | undefined, fallback: string, maxLength = 180): string {
  const value = compact(text, fallback);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
