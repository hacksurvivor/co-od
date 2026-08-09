import {
  addAttachment,
  attachmentLabel,
  attachmentSummary,
  attachmentTransportSummary,
  removeAttachment,
  type TuiAttachment,
  type TuiAttachmentKind,
} from "./tui-attachments.js";
import {
  applyRoomDashboardCache,
  createRoomDashboardCache,
  dashboardCachePolicyFromEnv,
  formatDashboardCachePolicy,
  formatServiceHealth,
  isRoomDashboardCacheFresh,
  loadTuiDashboardState,
  readProjectConfig,
  type CachedRoomDashboard,
  type DashboardCachePolicy,
  type DashboardData,
  type TuiDashboardState,
} from "./tui-dashboard.js";
import { buildActions, parseSlashCommand, slashHelpText } from "./tui-actions.js";
import { buildAgentActivityRows } from "./tui-agent-activity.js";
import {
  resolveAgentPauseCommand,
  resolveAgentResumeCommand,
  resolveAgentStartCommand,
  resolveAgentStopCommand,
} from "./tui-agent-actions.js";
import { taskComposerLines } from "./tui-composer.js";
import { taskContextSummary } from "./tui-context.js";
import {
  instructionSummary,
  loadProjectInstructions,
  type ProjectInstructions,
} from "./tui-instructions.js";
import {
  loadProjectMemory,
  memorySummary,
  type ProjectMemory,
} from "./tui-memory.js";
import {
  buildDelegationRows,
  classifyDiffLine,
  compact,
  diffStat,
  formatStepDescription,
  resolveRunId,
  shortId,
  type RunDetailData,
} from "./tui-model.js";
import {
  buildPaletteItems,
  filterPaletteItems,
  slashCommandSuggestions,
  composerSuggestions,
  providerMentionTargets,
  activeMentionToken,
  agentHandle,
  type AgentMentionTarget,
  type PaletteItem,
  type SlashCommandSuggestion,
} from "./tui-palette.js";
import { resolveModelCommand, TUI_PROVIDERS } from "./tui-provider.js";
import { resolveFanoutCommand, type FanoutTarget } from "./tui-fanout.js";
import { resolveHandoffCommand, type HandoffResolution } from "./tui-handoff.js";
import {
  cycleHandoffTarget,
  formatHandoffPrefill,
  handoffTargetLabel,
  resolveHandoffTarget,
  handoffTargetSummary,
} from "./tui-handoff-targets.js";
import {
  resolveContinueCommand,
  resolveForkCommand,
  resolveRerunCommand,
  resolveResumeCommand,
  resolveRetryCommand,
  resolveStopCommand,
} from "./tui-run-actions.js";
import {
  resolveEnvCommand,
  type TuiEnvAction,
} from "./tui-env.js";
import type { TuiMouseEvent } from "./tui-mouse.js";
import type { RunCopyKind } from "./tui-run-export.js";
import {
  emptyPins,
  pinAgent,
  pinProvider,
  pinRoom,
  pinSummaryLines,
  type PinTarget,
  type TuiPins,
  unpinTarget,
} from "./tui-pins.js";
import {
  loadTuiProjectState,
  normalizeSafetyAudit,
  normalizeSideRailWidth,
  SIDE_RAIL_DEFAULT_WIDTH,
  SIDE_RAIL_MIN_MAIN_WIDTH,
  normalizeTaskHistory,
  saveTuiProjectState,
  type TuiProjectState,
} from "./tui-persistence.js";
import {
  formatTaskHistory,
  resolveTaskHistoryItem,
} from "./tui-history.js";
import {
  collectProviderSessions,
  formatProviderSessions,
  providerSessionStatusForRun,
  resolveProviderSession,
} from "./tui-sessions.js";
import type { ProviderSessionContext } from "./adapters/base.js";
import {
  createSafetyState,
  evaluateSafetyActionApproval,
  evaluateTaskApproval,
  safetyLines,
  toggleSafety,
  type TuiSafetyAction,
  type TuiSafetyState,
} from "./tui-safety.js";
import {
  formatTuiScrollbackSearch,
  searchTuiScrollback,
} from "./tui-scrollback-search.js";
import {
  appendTerminalOutputLines,
  createTerminalConnectionState,
  reduceTerminalConnectionState,
  type TuiTerminalConnectionState,
  type TuiTerminalEvent,
} from "./tui-terminal.js";
import {
  createUndoSnapshot,
  pushUndoSnapshot,
  restoreFileUndoChanges,
  restoreUndoSnapshot,
  type TuiUndoSnapshot,
} from "./tui-undo.js";
import { renderTerminalFrame, visibleLength } from "./tui-render.js";
import {
  formatWorkspaceFilePreview,
  listWorkspaceFiles,
  loadWorkspaceContext,
  loadWorkspaceFilePreview,
  type WorkspaceContext,
  type WorkspaceDiffResult,
  type WorkspaceSearchResult,
} from "./tui-workspace.js";
import type { TuiRenamePreviewResult, TuiSymbolNavigationResult, TuiSymbolResult } from "./tui-symbols.js";
import { diagnosticsRequestLabel, type TypeScriptDiagnosticResult } from "./tui-diagnostics.js";
import {
  bridgeApprovalDetailLines,
  bridgeApprovalTarget,
  bridgeApprovalTitle,
  type BridgeApprovalDecision,
  type BridgeApprovalRequest,
} from "./tui-bridge-approvals.js";
import { buildDoctorReport, formatDoctorReport } from "./commands/doctor.js";
import {
  buildTuiQaReport,
  formatTuiQaReport,
  resolveTuiQaSlashCommand,
} from "./tui-qa.js";
import {
  appendUserMessage,
  createEmptyTranscript,
  foldTaskEventIntoTranscript,
  type TranscriptMessage,
  type FoldContext,
} from "./tui-chat-transcript.js";
import type { TuiTaskEvent } from "./tui-task.js";

export interface OpenTuiPreviewArgs {
  dir: string;
  roomId?: string;
  provider?: string;
  server?: string;
  smokeTest: boolean;
  durationMs: number;
  startupProfile?: boolean;
  startupBudgetMs?: number;
}

export interface OpenTuiPreviewFormatOptions {
  width?: number;
  height?: number;
  sideRailWidth?: number;
  sideRailMinMainWidth?: number;
}

export interface OpenTuiPreviewState {
  args: OpenTuiPreviewArgs;
  dashboard: TuiDashboardState;
  workspace: WorkspaceContext;
  workspaceFiles: string[];
  instructions: ProjectInstructions;
  memory: ProjectMemory;
  safety: TuiSafetyState;
  pins: TuiPins;
  attachments: TuiAttachment[];
  taskHistory: string[];
  model?: string;
  selectedAgentId?: string;
  lastRunId?: string;
  sideRailWidth?: number;
  panelVisible?: boolean;
  dismissedRunIds?: string[];
}

export type OpenTuiPreviewMode = "dashboard" | "task" | "palette" | "run" | "workspace" | "terminal" | "confirm" | "help";
export type OpenTuiDashboardFocus = "runs" | "agents";

// Side-panel tabs — destinations, not fragments: room (crew + needs-you +
// activity), chat (the full room conversation), projects (switch rooms).
// The set and order are user-customizable via `.co-od.json`
// ("panelTabs": ["room","chat","projects"]); legacy ids map sensibly.
export const AVAILABLE_PANEL_TABS = ["room", "chat", "projects"] as const;
export type PanelTabId = (typeof AVAILABLE_PANEL_TABS)[number];
const DEFAULT_PANEL_TABS: PanelTabId[] = ["room", "chat", "projects"];
const PANEL_TAB_ALIASES: Record<string, PanelTabId> = {
  room: "room",
  team: "room",
  work: "room",
  chat: "chat",
  projects: "projects",
  rooms: "projects",
};

export function resolvePanelTabs(config?: { panelTabs?: string[] } | null): PanelTabId[] {
  const seen = new Set<PanelTabId>();
  const requested = (config?.panelTabs || []).flatMap((tab) => {
    const resolved = PANEL_TAB_ALIASES[tab.toLowerCase()];
    if (!resolved || seen.has(resolved)) return [];
    seen.add(resolved);
    return [resolved];
  });
  return requested.length > 0 ? requested : DEFAULT_PANEL_TABS;
}

export type OpenTuiPreviewFeedKind = "info" | "output" | "success" | "warning" | "error";

export interface OpenTuiPreviewFeedEntry {
  kind: OpenTuiPreviewFeedKind;
  text: string;
}

export type OpenTuiWorkspaceResultKind = "search" | "symbols" | "diagnostics" | "diff" | "rename";

export interface OpenTuiWorkspaceResultEntry {
  label: string;
  detail?: string;
  attachPath?: string;
  promptText?: string;
}

export interface OpenTuiWorkspaceResults {
  kind: OpenTuiWorkspaceResultKind;
  title: string;
  query?: string;
  summary: string;
  entries: OpenTuiWorkspaceResultEntry[];
  selectedIndex: number;
}

export type OpenTuiRunnableIntent =
  | { type: "submit"; goal: string; provider?: string; agentId?: string; continueRunId?: string; providerSession?: ProviderSessionContext }
  | { type: "fanout"; goal: string; targets: FanoutTarget[] }
  | { type: "handoff"; resolution: HandoffResolution }
  | { type: "agent-start"; goal: string; provider: string; agentId: string };

export type OpenTuiApprovedIntent =
  | OpenTuiRunnableIntent
  | { type: "bridge-approval"; approvalId: string; decision: BridgeApprovalDecision; target: string }
  | { type: "resolve-patch"; runId: string; patchId: string; action: "accept" | "reject" }
  | { type: "connect-terminal" }
  | { type: "stop-run"; runId: string }
  | { type: "agent-pause"; agentId: string; agentName: string; runIds: string[] }
  | { type: "agent-resume"; agentId: string; agentName: string; runIds: string[] }
  | { type: "agent-stop"; agentId: string; agentName: string; runIds: string[] }
  | { type: "runtime-action"; action: TuiEnvAction; ttlSeconds?: number }
  | { type: "rename-apply"; oldName: string; newName: string }
  | { type: "init-project" };

export interface OpenTuiApprovalRequest {
  safetyAction?: TuiSafetyAction;
  title: string;
  detail: string;
  confirmLabel: string;
  runningMessage: string;
  feedMessage: string;
  feedKind: OpenTuiPreviewFeedKind;
  returnMode: Exclude<OpenTuiPreviewMode, "confirm" | "help">;
  returnTaskInput: string;
  intent: OpenTuiApprovedIntent;
  cancelIntent?: OpenTuiApprovedIntent;
}

export type OpenTuiPendingRunAction =
  | { type: "copy"; kind: RunCopyKind }
  | { type: "export"; outputPath?: string };

export interface OpenTuiPreviewUiState extends OpenTuiPreviewState {
  mode: OpenTuiPreviewMode;
  taskInput: string;
  taskCursor: number;
  taskSuggestionSelected: number;
  taskRunning: boolean;
  /** Epoch ms when the running task started — drives the elapsed-time hint. */
  taskStartedAt?: number;
  paletteInput: string;
  paletteSelected: number;
  dashboardFocus: OpenTuiDashboardFocus;
  panelTab: PanelTabId;
  /** Message cursor on the rail's chat tab (index into the visible window). */
  railChatSelected?: number;
  /** Room cursor on the rail's projects tab. */
  railProjectSelected?: number;
  /** Failures dismissed from "needs you" (persisted per project). */
  dismissedRunIds?: string[];
  /** Which transport keeps the room live — drives the ambient wordmark dot. */
  liveTransport?: "convex" | "sse" | "poll";
  sideRailWidth: number;
  /** Room rail visibility (⌃B toggle). On by default on wide terminals — the
   * multiplayer surface should be glanceable, not summoned. */
  panelVisible: boolean;
  selectedAgentId?: string;
  selectedHandoffTargetAgentId?: string;
  selectedRunId?: string;
  selectedRunDetail?: RunDetailData;
  runDetailLoading: boolean;
  selectedPatchIndex: number;
  workspaceResults?: OpenTuiWorkspaceResults;
  terminal: TuiTerminalConnectionState;
  terminalLines: string[];
  undoStack: TuiUndoSnapshot[];
  pendingApproval?: OpenTuiApprovalRequest;
  pendingRunAction?: OpenTuiPendingRunAction;
  helpReturnMode?: Exclude<OpenTuiPreviewMode, "confirm" | "help">;
  message: string;
  feed: OpenTuiPreviewFeedEntry[];
  transcript: TranscriptMessage[];
}

export type OpenTuiPreviewIntent =
  | { type: "none" }
  | { type: "quit" }
  | { type: "chat-message"; bodyMd: string }
  | { type: "agent-add"; name: string; provider?: string; model?: string }
  | OpenTuiApprovedIntent
  | { type: "load-run"; runId: string }
  | { type: "terminal-input"; data: string }
  | { type: "copy-run"; kind: RunCopyKind }
  | { type: "export-run"; outputPath?: string }
  | { type: "login" }
  | { type: "init-project" }
  | { type: "open-browser"; url: string }
  | { type: "select-room"; roomId: string; roomName?: string }
  | { type: "search-workspace"; query: string }
  | { type: "workspace-diff"; path?: string }
  | { type: "list-symbols"; query: string }
  | { type: "goto-symbol"; query: string }
  | { type: "rename-preview"; oldName: string; newName: string }
  | { type: "server-undo"; snapshot: TuiUndoSnapshot }
  | { type: "live-qa"; roomId?: string; includeTerminal: boolean; bridgeUrl?: string }
  | { type: "diagnostics"; project?: string };

export interface OpenTuiPreviewKeyResult {
  state: OpenTuiPreviewUiState;
  intent: OpenTuiPreviewIntent;
}

export function parseOpenTuiPreviewArgs(args: string[], cwd = process.cwd()): OpenTuiPreviewArgs {
  const parsed: OpenTuiPreviewArgs = {
    dir: cwd,
    smokeTest: false,
    durationMs: 0,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dir" && args[index + 1]) {
      parsed.dir = args[++index];
    } else if (arg === "--provider" && args[index + 1]) {
      parsed.provider = args[++index];
    } else if (arg === "--server" && args[index + 1]) {
      parsed.server = args[++index];
    } else if (arg === "--smoke-test") {
      parsed.smokeTest = true;
    } else if (arg === "--duration-ms" && args[index + 1]) {
      parsed.durationMs = Math.max(0, Number(args[++index]) || 0);
    } else if (arg === "--startup-profile") {
      parsed.startupProfile = true;
    } else if (arg === "--startup-budget-ms" && args[index + 1]) {
      parsed.startupBudgetMs = Math.max(0, Number(args[++index]) || 0);
      parsed.startupProfile = true;
    } else if (arg === "--view" && args[index + 1]) {
      index++; // consume "--view <value>"; the renderer host reads it from argv
    } else if (!arg.startsWith("--") && !parsed.roomId) {
      parsed.roomId = arg;
    }
  }

  if (parsed.smokeTest && parsed.durationMs === 0) parsed.durationMs = 250;
  return parsed;
}

export function resolveOpenTuiPreviewRoomSelection(
  args: Pick<OpenTuiPreviewArgs, "roomId">,
  persisted?: Pick<TuiProjectState, "selectedRoomId" | "selectedRoomName"> | null,
): { roomId?: string; roomName?: string; fromPersisted: boolean } {
  if (args.roomId) {
    return { roomId: args.roomId, fromPersisted: false };
  }
  if (!persisted?.selectedRoomId) {
    return { fromPersisted: false };
  }
  return {
    roomId: persisted.selectedRoomId,
    roomName: persisted.selectedRoomName,
    fromPersisted: true,
  };
}

export function applyOpenTuiDashboardCache(
  state: TuiDashboardState,
  cache?: CachedRoomDashboard | null,
  policy: DashboardCachePolicy = dashboardCachePolicyFromEnv(),
): TuiDashboardState {
  if (!state.config?.roomId) return state;
  const dashboard = applyRoomDashboardCache({
    dashboard: state.dashboard,
    cache,
    roomId: state.config.roomId,
    reason: state.dashboard.error,
    policy,
  });
  if (dashboard === state.dashboard || !dashboard.cached) return state;
  return {
    ...state,
    dashboard,
    message: dashboard.cacheReason
      ? `Showing cached room data: ${compact(dashboard.cacheReason)}`
      : "Showing cached room data.",
  };
}

export function createOpenTuiDashboardCache(state: Pick<OpenTuiPreviewUiState, "dashboard">): CachedRoomDashboard | null {
  const config = state.dashboard.config;
  if (!config?.roomId || state.dashboard.dashboard.cached || state.dashboard.dashboard.error) return null;
  return createRoomDashboardCache({
    roomId: config.roomId,
    roomName: config.roomName,
    dashboard: state.dashboard.dashboard,
  });
}

export function dashboardCacheForOpenTuiPersistence(
  state: Pick<OpenTuiPreviewUiState, "dashboard">,
): CachedRoomDashboard | null | undefined {
  const config = state.dashboard.config;
  const dashboard = state.dashboard.dashboard;
  if (!config?.roomId || dashboard.cached || dashboard.error) return undefined;
  return createRoomDashboardCache({
    roomId: config.roomId,
    roomName: config.roomName,
    dashboard,
  }) || null;
}

function emptyOpenTuiWorkspace(): WorkspaceContext {
  return {
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
}

function cachedStartupDashboard(input: {
  cache?: CachedRoomDashboard;
  roomId?: string;
  policy?: DashboardCachePolicy;
}): DashboardData {
  const policy = input.policy || dashboardCachePolicyFromEnv();
  if (
    policy.enabled &&
    input.cache &&
    input.cache.roomId === input.roomId &&
    isRoomDashboardCacheFresh({ cache: input.cache, maxAgeMs: policy.maxAgeMs })
  ) {
    return {
      agents: input.cache.agents,
      runs: input.cache.runs,
      services: {},
      cached: true,
      cachedAt: input.cache.cachedAt,
      cacheReason: "startup cache",
    };
  }
  return {
    agents: [],
    runs: [],
    services: {},
  };
}

export function loadOpenTuiPreviewStartupState(args: OpenTuiPreviewArgs): OpenTuiPreviewState {
  const persisted = loadTuiProjectState({ projectDir: args.dir });
  const resumeRoom = resolveOpenTuiPreviewRoomSelection(args, persisted);
  let config = readProjectConfig(args.dir, resumeRoom.roomId);
  if (resumeRoom.fromPersisted && resumeRoom.roomName && config && config.roomId === resumeRoom.roomId) {
    config = { ...config, roomName: resumeRoom.roomName };
  }
  const provider = args.provider || config?.provider || persisted?.provider || TUI_PROVIDERS[0];
  const dashboard = cachedStartupDashboard({
    cache: persisted?.dashboardCache,
    roomId: config?.roomId,
  });
  const safety = createSafetyState();
  const message = !config
    ? "No room here yet."
    : dashboard.cached
      ? "Showing cached room data while live dashboard loads."
      : "Loading live room data...";

  return {
    args,
    dashboard: {
      config,
      session: null,
      bridge: "offline",
      providerAvailability: {},
      dashboard,
      rooms: [],
      provider,
      message,
    },
    workspace: emptyOpenTuiWorkspace(),
    workspaceFiles: [],
    instructions: loadProjectInstructions(args.dir),
    memory: loadProjectMemory(args.dir),
    safety: { ...safety, audit: normalizeSafetyAudit(persisted?.safetyAudit) },
    pins: persisted?.pins || emptyPins(),
    attachments: persisted?.attachments || [],
    taskHistory: normalizeTaskHistory(persisted?.taskHistory || []),
    model: persisted?.model,
    selectedAgentId: persisted?.selectedAgentId,
    lastRunId: persisted?.lastRunId,
    sideRailWidth: normalizeSideRailWidth(persisted?.sideRailWidth),
    panelVisible: persisted?.panelVisible,
    dismissedRunIds: persisted?.dismissedRunIds,
  };
}

export async function loadOpenTuiPreviewState(args: OpenTuiPreviewArgs): Promise<OpenTuiPreviewState> {
  const persisted = loadTuiProjectState({ projectDir: args.dir });
  const resumeRoom = resolveOpenTuiPreviewRoomSelection(args, persisted);
  const [loadedDashboard, workspace, workspaceFiles, instructions, memory] = await Promise.all([
    loadTuiDashboardState({
      dir: args.dir,
      roomId: resumeRoom.roomId,
      provider: args.provider,
      server: args.server,
      previousProvider: persisted?.provider,
    }),
    loadWorkspaceContext(args.dir),
    listWorkspaceFiles({ dir: args.dir, limit: 500 }).then((result) => result.files).catch(() => []),
    Promise.resolve(loadProjectInstructions(args.dir)),
    Promise.resolve(loadProjectMemory(args.dir)),
  ]);
  const safety = createSafetyState();
  let dashboard = loadedDashboard;
  const loadedConfig = dashboard.config;
  if (resumeRoom.fromPersisted && resumeRoom.roomName && loadedConfig && loadedConfig.roomId === resumeRoom.roomId) {
    dashboard = { ...dashboard, config: { ...loadedConfig, roomName: resumeRoom.roomName } };
  }
  dashboard = applyOpenTuiDashboardCache(dashboard, persisted?.dashboardCache);

  return {
    args,
    dashboard,
    workspace,
    workspaceFiles,
    instructions,
    memory,
    safety: { ...safety, audit: normalizeSafetyAudit(persisted?.safetyAudit) },
    pins: persisted?.pins || emptyPins(),
    attachments: persisted?.attachments || [],
    taskHistory: normalizeTaskHistory(persisted?.taskHistory || []),
    model: persisted?.model,
    selectedAgentId: persisted?.selectedAgentId,
    lastRunId: persisted?.lastRunId,
    sideRailWidth: normalizeSideRailWidth(persisted?.sideRailWidth),
    panelVisible: persisted?.panelVisible,
    dismissedRunIds: persisted?.dismissedRunIds,
  };
}

export function persistOpenTuiPreviewState(state: OpenTuiPreviewUiState): void {
  try {
    saveTuiProjectState({
      projectDir: state.args.dir,
      state: {
        taskHistory: state.taskHistory,
        selectedRoomId: state.dashboard.config?.roomId,
        selectedRoomName: state.dashboard.config?.roomName,
        provider: state.dashboard.provider,
        model: state.model,
        selectedAgentId: state.selectedAgentId,
        lastRunId: state.selectedRunId || state.selectedRunDetail?.run._id,
        attachments: state.attachments,
        dashboardCache: dashboardCacheForOpenTuiPersistence(state),
        pins: state.pins,
        safetyAudit: state.safety.audit,
        sideRailWidth: state.sideRailWidth,
        panelVisible: state.panelVisible,
        dismissedRunIds: state.dismissedRunIds,
      },
    });
  } catch {
    // Persistence is best-effort; OpenTUI should keep working if the state file cannot be written.
  }
}

export function createOpenTuiPreviewUiState(state: OpenTuiPreviewState): OpenTuiPreviewUiState {
  const selectedAgentId = state.dashboard.dashboard.agents.find((agent) => agent._id === state.selectedAgentId)?._id
    || state.dashboard.dashboard.agents.find((agent) => agent._id === state.pins?.agents?.[0]?.agentId)?._id
    || state.dashboard.dashboard.agents[0]?._id;
  const selectedRunId = state.dashboard.dashboard.runs.find((run) => run._id === state.lastRunId)?._id
    || state.dashboard.dashboard.runs[0]?._id;
  return {
    ...state,
    mode: "dashboard",
    taskInput: "",
    taskCursor: 0,
    taskSuggestionSelected: 0,
    taskRunning: false,
    paletteInput: "",
    paletteSelected: 0,
    dashboardFocus: selectedRunId ? "runs" : "agents",
    panelTab: resolvePanelTabs(state.dashboard.config)[0],
    sideRailWidth: normalizeSideRailWidth(state.sideRailWidth) || SIDE_RAIL_DEFAULT_WIDTH,
    panelVisible: state.panelVisible ?? true,
    dismissedRunIds: state.dismissedRunIds || [],
    liveTransport: "poll",
    selectedAgentId,
    selectedRunId,
    runDetailLoading: false,
    selectedPatchIndex: 0,
    terminal: createTerminalConnectionState(),
    terminalLines: [],
    pins: state.pins || emptyPins(),
    attachments: state.attachments || [],
    taskHistory: normalizeTaskHistory(state.taskHistory || []),
    model: state.model,
    undoStack: [],
    message: state.dashboard.message,
    feed: [],
    transcript: createEmptyTranscript(),
  };
}

export function refreshOpenTuiPreviewUiState(
  current: OpenTuiPreviewUiState,
  latest: OpenTuiPreviewState,
): OpenTuiPreviewUiState {
  const next = createOpenTuiPreviewUiState(latest);
  const currentAgentStillVisible = next.dashboard.dashboard.agents.some((agent) => agent._id === current.selectedAgentId);
  const currentRunStillVisible = next.dashboard.dashboard.runs.some((run) => run._id === current.selectedRunId);
  const currentDetailStillVisible = Boolean(
    current.selectedRunDetail &&
    next.dashboard.dashboard.runs.some((run) => run._id === current.selectedRunDetail?.run._id),
  );

  return {
    ...next,
    mode: current.mode,
    taskInput: current.taskInput,
    taskCursor: current.taskCursor,
    taskSuggestionSelected: current.taskSuggestionSelected,
    taskRunning: current.taskRunning,
    paletteInput: current.paletteInput,
    paletteSelected: current.paletteSelected,
    dashboardFocus: current.dashboardFocus,
    panelTab: current.panelTab,
    sideRailWidth: current.sideRailWidth,
    panelVisible: current.panelVisible,
    dismissedRunIds: current.dismissedRunIds,
    liveTransport: current.liveTransport,
    selectedAgentId: currentAgentStillVisible ? current.selectedAgentId : next.selectedAgentId,
    selectedHandoffTargetAgentId: current.selectedHandoffTargetAgentId,
    selectedRunId: currentRunStillVisible ? current.selectedRunId : next.selectedRunId,
    selectedRunDetail: currentDetailStillVisible ? current.selectedRunDetail : undefined,
    runDetailLoading: current.runDetailLoading,
    selectedPatchIndex: current.selectedPatchIndex,
    workspaceResults: current.workspaceResults,
    terminal: current.terminal,
    terminalLines: current.terminalLines,
    undoStack: current.undoStack,
    pendingApproval: current.pendingApproval,
    pendingRunAction: current.pendingRunAction,
    helpReturnMode: current.helpReturnMode,
    message: current.taskRunning ? current.message : next.message,
    feed: current.feed,
    transcript: current.transcript,
  };
}

function openOpenTuiKeyboardHelp(
  state: OpenTuiPreviewUiState,
  returnMode: Exclude<OpenTuiPreviewMode, "confirm" | "help">,
): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      mode: "help",
      helpReturnMode: returnMode,
      message: "Keyboard help open.",
    },
    intent: { type: "none" },
  };
}

export function reduceOpenTuiPreviewKey(state: OpenTuiPreviewUiState, sequence: string): OpenTuiPreviewKeyResult {
  if (sequence === "\u0003") {
    return { state, intent: { type: "quit" } };
  }

  if (state.mode === "confirm") {
    return reduceOpenTuiApprovalKey(state, sequence);
  }

  if (state.mode === "palette") {
    return reduceOpenTuiPaletteKey(state, sequence);
  }

  if (state.mode === "help") {
    if (sequence === "\u001b" || sequence === "q" || sequence === "?") {
      return {
        state: {
          ...state,
          mode: state.helpReturnMode || "dashboard",
          helpReturnMode: undefined,
          message: "Keyboard help closed.",
        },
        intent: { type: "none" },
      };
    }
    return { state, intent: { type: "none" } };
  }

  if (state.mode === "workspace") {
    if (sequence === "q") return { state, intent: { type: "quit" } };
    if (sequence === "?") return openOpenTuiKeyboardHelp(state, "workspace");
    if (sequence === "\u0010") {
      return {
        state: { ...state, mode: "palette", paletteInput: "", paletteSelected: 0, message: "Command palette." },
        intent: { type: "none" },
      };
    }
    if (sequence === "\u001b" || sequence === "b") {
      return {
        state: { ...state, mode: "dashboard", message: "Workspace results closed." },
        intent: { type: "none" },
      };
    }
    if (sequence === "j" || sequence === "\u001b[B") {
      return { state: moveOpenTuiWorkspaceResultSelection(state, 1), intent: { type: "none" } };
    }
    if (sequence === "k" || sequence === "\u001b[A") {
      return { state: moveOpenTuiWorkspaceResultSelection(state, -1), intent: { type: "none" } };
    }
    if (sequence === "g") {
      return { state: selectOpenTuiWorkspaceResult(state, "first"), intent: { type: "none" } };
    }
    if (sequence === "G") {
      return { state: selectOpenTuiWorkspaceResult(state, "last"), intent: { type: "none" } };
    }
    if (sequence === "a") {
      return attachOpenTuiWorkspaceResult(state, false);
    }
    if (sequence === "\r") {
      return attachOpenTuiWorkspaceResult(state, true);
    }
    return { state, intent: { type: "none" } };
  }

  if (sequence === "\u0010") {
    return {
      state: { ...state, mode: "palette", paletteInput: "", paletteSelected: 0, message: "Command palette." },
      intent: { type: "none" },
    };
  }

  if (state.mode === "terminal") {
    return reduceOpenTuiTerminalKey(state, sequence);
  }

  if (state.mode === "dashboard") {
    if (sequence === "q") return { state, intent: { type: "quit" } };
    if (sequence === "?") return openOpenTuiKeyboardHelp(state, "dashboard");
    if (sequence === "\t") {
      return {
        state: {
          ...state,
          dashboardFocus: state.dashboardFocus === "runs" ? "agents" : "runs",
          message: state.dashboardFocus === "runs" ? "Agent roster focused." : "Recent work focused.",
        },
        intent: { type: "none" },
      };
    }
    if (sequence === "j" || sequence === "\u001b[B") {
      return {
        state: moveOpenTuiDashboardSelection(state, 1),
        intent: { type: "none" },
      };
    }
    if (sequence === "k" || sequence === "\u001b[A") {
      return {
        state: moveOpenTuiDashboardSelection(state, -1),
        intent: { type: "none" },
      };
    }
    if (sequence === "[" || sequence === "]") {
      return {
        state: moveOpenTuiDashboardAgentSelection(state, sequence === "]" ? 1 : -1),
        intent: { type: "none" },
      };
    }
    if (sequence === "c") {
      return beginOpenTuiTerminalConnection(state);
    }
    if (sequence === "v" || sequence === "\r") {
      const runId = state.selectedRunId || state.dashboard.dashboard.runs[0]?._id;
      if (!runId) {
        return {
          state: { ...state, message: "No task available to inspect." },
          intent: { type: "none" },
        };
      }
      return beginOpenTuiRunDetail(state, runId);
    }
    if (sequence === "t") {
      return {
        state: { ...state, mode: "task", taskSuggestionSelected: 0, message: "Task composer active." },
        intent: { type: "none" },
      };
    }
    if (sequence === "/") {
      return {
        state: { ...state, mode: "task", taskInput: "/", taskCursor: 1, taskSuggestionSelected: 0, message: "Slash command composer active." },
        intent: { type: "none" },
      };
    }
    if (sequence === "\x06") {
      return {
        state: { ...state, mode: "task", taskInput: "/find ", taskCursor: 6, taskSuggestionSelected: 0, message: "Search feed and terminal scrollback." },
        intent: { type: "none" },
      };
    }
    return { state, intent: { type: "none" } };
  }

  if (state.mode === "run") {
    if (sequence === "q") return { state, intent: { type: "quit" } };
    if (sequence === "?") return openOpenTuiKeyboardHelp(state, "run");
    if (sequence === "\x06") {
      return {
        state: { ...state, mode: "task", taskInput: "/find ", taskCursor: 6, taskSuggestionSelected: 0, message: "Search feed and terminal scrollback." },
        intent: { type: "none" },
      };
    }
    if (sequence === "\u001b" || sequence === "b") {
      return {
        state: { ...state, mode: "dashboard", message: "Task detail closed." },
        intent: { type: "none" },
      };
    }
    if (sequence === "r" && state.selectedRunId) {
      return beginOpenTuiRunDetail(state, state.selectedRunId);
    }
    if (sequence === "j" || sequence === "\u001b[B") {
      return { state: moveOpenTuiPatchSelection(state, 1), intent: { type: "none" } };
    }
    if (sequence === "k" || sequence === "\u001b[A") {
      return { state: moveOpenTuiPatchSelection(state, -1), intent: { type: "none" } };
    }
    if (sequence === "g") {
      return { state: selectOpenTuiPatch(state, "first"), intent: { type: "none" } };
    }
    if (sequence === "G") {
      return { state: selectOpenTuiPatch(state, "last"), intent: { type: "none" } };
    }
    if (sequence === "a") {
      return beginOpenTuiPatchResolve(state, "accept");
    }
    if (sequence === "x") {
      return beginOpenTuiPatchResolve(state, "reject");
    }
    if (sequence === "e") {
      return beginOpenTuiRunExport(state);
    }
    if (sequence === "y" || sequence === "c") {
      return beginOpenTuiRunCopy(state, "summary");
    }
    if (sequence === "R") {
      return beginOpenTuiRunRetry(state);
    }
    if (sequence === "s") {
      return beginOpenTuiRunStop(state);
    }
    if (sequence === "d") {
      return dismissOpenTuiFailure(state);
    }
    if (sequence === "[" || sequence === "]") {
      return cycleOpenTuiHandoffTarget(state, sequence === "]" ? 1 : -1);
    }
    if (sequence === "h") {
      const target = selectedOpenTuiHandoffTarget(state);
      return {
        state: {
          ...state,
          mode: "task",
          taskInput: formatHandoffPrefill(target),
          taskCursor: formatHandoffPrefill(target).length,
          taskSuggestionSelected: 0,
          message: target
            ? `Handoff target: ${handoffTargetLabel(target)}. Add context or press Enter.`
            : "Choose a target agent for this handoff.",
        },
        intent: { type: "none" },
      };
    }
    if (/^[1-9]$/.test(sequence)) {
      const run = state.dashboard.dashboard.runs[Number(sequence) - 1];
      if (!run) return { state: { ...state, message: "No task exists at that index." }, intent: { type: "none" } };
      return beginOpenTuiRunDetail(state, run._id);
    }
    return { state, intent: { type: "none" } };
  }

  const cursor = Number.isFinite(state.taskCursor)
    ? Math.min(Math.max(0, state.taskCursor), state.taskInput.length)
    : state.taskInput.length;

  if (sequence === "\u001b") {
    return {
      state: { ...state, mode: "dashboard", taskSuggestionSelected: 0, message: "Task composer cancelled." },
      intent: { type: "none" },
    };
  }
  if (sequence === "\u0015") {
    return {
      state: { ...state, taskInput: "", taskCursor: 0, taskSuggestionSelected: 0, message: "Task input cleared." },
      intent: { type: "none" },
    };
  }
  if (sequence === "\u007f" || sequence === "\b") {
    if (cursor === 0) return { state, intent: { type: "none" } };
    return {
      state: {
        ...state,
        taskInput: state.taskInput.slice(0, cursor - 1) + state.taskInput.slice(cursor),
        taskCursor: cursor - 1,
        taskSuggestionSelected: 0,
      },
      intent: { type: "none" },
    };
  }
  // Cursor movement within the composer (plain arrows / Home / End).
  if (sequence === "\u001b[D") {
    return { state: { ...state, taskCursor: Math.max(0, cursor - 1) }, intent: { type: "none" } };
  }
  if (sequence === "\u001b[C") {
    return { state: { ...state, taskCursor: Math.min(state.taskInput.length, cursor + 1) }, intent: { type: "none" } };
  }
  if (sequence === "\u001b[H" || sequence === "\u001b[1~") {
    return { state: { ...state, taskCursor: 0 }, intent: { type: "none" } };
  }
  if (sequence === "\u001b[F" || sequence === "\u001b[4~") {
    return { state: { ...state, taskCursor: state.taskInput.length }, intent: { type: "none" } };
  }
  if (sequence === "\t") {
    return completeOpenTuiTaskSuggestion(state);
  }
  if (sequence === "\u001b[A") {
    const suggestions = openTuiTaskSuggestions(state);
    if (suggestions.length > 0) return moveOpenTuiTaskSuggestion(state, -1);
    return recallOpenTuiTaskHistory(state, -1);
  }
  if (sequence === "\u001b[B") {
    const suggestions = openTuiTaskSuggestions(state);
    if (suggestions.length > 0) return moveOpenTuiTaskSuggestion(state, 1);
    return recallOpenTuiTaskHistory(state, 1);
  }
  if (sequence === "\n") {
    return {
      state: {
        ...state,
        taskInput: state.taskInput.slice(0, cursor) + "\n" + state.taskInput.slice(cursor),
        taskCursor: cursor + 1,
      },
      intent: { type: "none" },
    };
  }
  if (sequence === "\r") {
    // If a slash suggestion is highlighted and the input isn't that command yet,
    // Enter completes it (so down then Enter fills in the command) rather than
    // running the partial text as an unknown command.
    const suggestion = selectedOpenTuiTaskSuggestion(state);
    if (suggestion && suggestion.completion.trim() !== state.taskInput.trim()) {
      return completeOpenTuiTaskSuggestion(state);
    }
    const rawGoal = state.taskInput.trim();
    if (!rawGoal) {
      return {
        state: { ...state, message: "Type a message before pressing Enter." },
        intent: { type: "none" },
      };
    }
    if (rawGoal.startsWith("/")) {
      return applyOpenTuiSlashCommand(state, rawGoal);
    }
    // '#' posts to the shared room chat (humans + the room log). Everything
    // else is a conversation turn with an agent — type, Enter, get an answer.
    if (rawGoal.startsWith("#")) {
      const body = rawGoal.slice(1).trim();
      if (!body) {
        return {
          state: { ...state, message: "Add a message after # to post to the room chat." },
          intent: { type: "none" },
        };
      }
      // No `>` prompt echo here — the send path folds the message back into
      // the conversation as a proper `#` chat turn once the server has it.
      return {
        state: {
          ...state,
          mode: "task",
          taskInput: "",
          taskCursor: 0,
          taskSuggestionSelected: 0,
          message: "Posting to the room chat...",
        },
        intent: { type: "chat-message", bodyMd: body },
      };
    }
    return beginOpenTuiAgentChatSubmit(state, rawGoal, state.taskInput);
  }

  if (isPrintableInput(sequence)) {
    return {
      state: {
        ...state,
        taskInput: state.taskInput.slice(0, cursor) + sequence + state.taskInput.slice(cursor),
        taskCursor: cursor + sequence.length,
        taskSuggestionSelected: 0,
      },
      intent: { type: "none" },
    };
  }

  // Multi-character input that isn't an escape sequence is a paste. Newlines
  // survive (the composer is multi-line); tabs become spaces; other control
  // characters are dropped.
  if (sequence.length > 1 && !sequence.startsWith("\u001b")) {
    const pasted = sequence
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (pasted) {
      return {
        state: {
          ...state,
          taskInput: state.taskInput.slice(0, cursor) + pasted + state.taskInput.slice(cursor),
          taskCursor: cursor + pasted.length,
          taskSuggestionSelected: 0,
        },
        intent: { type: "none" },
      };
    }
  }

  return { state, intent: { type: "none" } };
}

export function reduceOpenTuiPreviewMouse(
  state: OpenTuiPreviewUiState,
  event: TuiMouseEvent,
  options: OpenTuiPreviewFormatOptions = {},
): OpenTuiPreviewKeyResult {
  if (event.type === "scroll") {
    const direction: -1 | 1 = event.button === 64 ? -1 : 1;
    if (state.mode === "dashboard") {
      return { state: moveOpenTuiDashboardSelection(state, direction), intent: { type: "none" } };
    }
    if (state.mode === "workspace") {
      return { state: moveOpenTuiWorkspaceResultSelection(state, direction), intent: { type: "none" } };
    }
    if (state.mode === "run") {
      return { state: moveOpenTuiPatchSelection(state, direction), intent: { type: "none" } };
    }
    if (state.mode === "palette") {
      return { state: moveOpenTuiPaletteSelection(state, direction), intent: { type: "none" } };
    }
    return { state, intent: { type: "none" } };
  }

  if (event.type !== "press" || event.button !== 0) {
    return { state, intent: { type: "none" } };
  }

  const line = openTuiMouseLine(state, event.row, options);
  if (!line) return { state, intent: { type: "none" } };

  if (state.mode === "dashboard") {
    const explicitAgent = state.dashboard.dashboard.agents.find((candidate) => {
      const handle = `@${agentHandle({ _id: candidate._id, name: candidate.name })}`;
      const handleColumn = line.indexOf(handle) + 1;
      return handleColumn > 0 && Math.floor(event.column) >= handleColumn - 1;
    });
    if (explicitAgent) {
      return {
        state: {
          ...state,
          dashboardFocus: "agents",
          selectedAgentId: explicitAgent._id,
          message: `Selected agent: ${compact(explicitAgent.name, explicitAgent._id)}`,
        },
        intent: { type: "none" },
      };
    }

    const run = /\s\d{2}\s/.test(line)
      ? state.dashboard.dashboard.runs.find((candidate) => line.includes(shortId(candidate._id)))
      : undefined;
    if (run) {
      return beginOpenTuiRunDetail(
        { ...state, dashboardFocus: "runs", selectedRunId: run._id },
        run._id,
        `Task selected by mouse: ${shortId(run._id)}`,
      );
    }

    const agent = state.dashboard.dashboard.agents.find((candidate) => {
      const handle = `@${agentHandle({ _id: candidate._id, name: candidate.name })}`;
      return Boolean(candidate.name && line.includes(candidate.name)) || line.includes(handle) || line.includes(shortId(candidate._id));
    });
    if (agent) {
      return {
        state: {
          ...state,
          dashboardFocus: "agents",
          selectedAgentId: agent._id,
          message: `Selected agent: ${compact(agent.name, agent._id)}`,
        },
        intent: { type: "none" },
      };
    }

    if (/Task Composer/.test(line)) {
      return {
        state: { ...state, mode: "task", message: "Task composer active." },
        intent: { type: "none" },
      };
    }
  }

  if (state.mode === "workspace" && state.workspaceResults) {
    const index = state.workspaceResults.entries.findIndex((entry) => line.includes(entry.label));
    if (index >= 0) {
      const entry = state.workspaceResults.entries[index];
      return {
        state: {
          ...state,
          workspaceResults: { ...state.workspaceResults, selectedIndex: index },
          message: `Selected ${index + 1}/${state.workspaceResults.entries.length}: ${entry.label}`,
        },
        intent: { type: "none" },
      };
    }
  }

  if (state.mode === "palette") {
    const items = filteredOpenTuiPaletteItems(state, 8);
    const index = items.findIndex((item) => line.includes(item.label));
    if (index >= 0) {
      return applyOpenTuiPaletteSelection({ ...state, paletteSelected: index });
    }
  }

  if (state.mode === "run") {
    const detail = selectedOpenTuiRunDetail(state);
    const patchIndex = detail?.patches.findIndex((patch) => line.includes(shortId(patch._id))) ?? -1;
    if (patchIndex >= 0) {
      return {
        state: {
          ...state,
          selectedPatchIndex: patchIndex,
          message: `Selected patch ${patchIndex + 1} of ${detail?.patches.length}.`,
        },
        intent: { type: "none" },
      };
    }
  }

  return { state, intent: { type: "none" } };
}

function openTuiMouseLine(
  state: OpenTuiPreviewUiState,
  row: number,
  options: OpenTuiPreviewFormatOptions,
): string | undefined {
  if (!Number.isFinite(row) || row < 1) return undefined;
  return formatOpenTuiPreviewText(state, options).split("\n")[Math.floor(row) - 1];
}

function beginOpenTuiRunnableIntent(
  state: OpenTuiPreviewUiState,
  request: OpenTuiApprovalRequest,
): OpenTuiPreviewKeyResult {
  return beginOpenTuiApprovedIntent(state, { ...request, safetyAction: request.safetyAction ?? "task" });
}

function beginOpenTuiTaskSubmit(
  state: OpenTuiPreviewUiState,
  input: string,
  returnTaskInput = input,
): OpenTuiPreviewKeyResult {
  const rawGoal = input.trim();
  if (!rawGoal) {
    return {
      state: { ...state, message: "Usage: /task <prompt>" },
      intent: { type: "none" },
    };
  }
  if (state.taskRunning) {
    return {
      state: { ...state, message: "A task is already running. Wait for it to finish before sending another." },
      intent: { type: "none" },
    };
  }

  const lead = rawGoal.match(/^@([a-z0-9-]+)\s+/i);
  const target = lead ? openTuiMentionTargets(state).find((agent) => agentHandle(agent) === lead[1].toLowerCase()) : undefined;
  const goal = target && lead ? rawGoal.slice(lead[0].length).trim() : rawGoal;
  if (!goal) {
    return {
      state: { ...state, message: `Add a task after @${lead?.[1]}.` },
      intent: { type: "none" },
    };
  }

  const targetLabel = target ? ` to @${agentHandle(target)}` : "";
  const provider = target?.kind === "provider" ? target.provider : undefined;
  const agentId = target?.kind !== "provider" ? target?._id : undefined;
  const providerLabel = provider || target?.provider || state.dashboard.provider;
  return beginOpenTuiRunnableIntent(state, {
    title: "Run agent task?",
    detail: `Auto-run is off. Approve this task${targetLabel} for ${providerLabel}: ${previewText(goal, "(no prompt)")}`,
    confirmLabel: "Run task",
    runningMessage: `Submitting task${targetLabel}...`,
    feedKind: "info",
    feedMessage: `Submitting task${targetLabel}: ${goal}`,
    returnMode: "task",
    returnTaskInput,
    intent: target ? { type: "submit", goal, provider, agentId } : { type: "submit", goal },
  });
}

/**
 * Where a plain Enter goes: the provider you're signed into (runs locally,
 * right now), else the first available provider, else the selected room
 * agent. Null when nothing can answer — the composer says so instead of
 * posting into a void.
 */
export function resolveOpenTuiConversationTarget(
  state: OpenTuiPreviewUiState,
): { label: string; provider?: string; agentId?: string } | null {
  const targets = openTuiMentionTargets(state);
  const provider = targets.find((target) => target.kind === "provider" && target.provider === state.dashboard.provider)
    || targets.find((target) => target.kind === "provider");
  if (provider) return { label: `@${agentHandle(provider)}`, provider: provider.provider };
  const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === state.selectedAgentId)
    || state.dashboard.dashboard.agents[0];
  if (agent) return { label: `@${agentHandle({ _id: agent._id, name: agent.name })}`, agentId: agent._id };
  return null;
}

function beginOpenTuiAgentChatSubmit(
  state: OpenTuiPreviewUiState,
  input: string,
  returnTaskInput = input,
): OpenTuiPreviewKeyResult {
  const rawGoal = input.trim();
  const lead = rawGoal.match(/^@([a-z0-9-]+)(?:\s+|$)/i);
  const handle = lead?.[1]?.toLowerCase();
  const leadText = lead?.[0] || "";
  const mentionTarget = handle ? openTuiMentionTargets(state).find((agent) => agentHandle(agent) === handle) : undefined;
  if (handle && !mentionTarget) {
    return {
      state: {
        ...state,
        message: `No connected agent matches @${handle}. Use /task <prompt> or connect that provider first.`,
      },
      intent: { type: "none" },
    };
  }
  const resolved = mentionTarget
    ? {
      label: `@${agentHandle(mentionTarget)}`,
      provider: mentionTarget.kind === "provider" ? mentionTarget.provider : undefined,
      agentId: mentionTarget.kind !== "provider" ? mentionTarget._id : undefined,
      providerLabel: (mentionTarget.kind === "provider" ? mentionTarget.provider : undefined) || mentionTarget.provider || state.dashboard.provider,
    }
    : (() => {
      const fallback = resolveOpenTuiConversationTarget(state);
      return fallback
        ? { ...fallback, providerLabel: fallback.provider || state.dashboard.provider }
        : null;
    })();
  if (!resolved) {
    return {
      state: {
        ...state,
        message: "No agent is connected yet. Install claude, codex, or opencode — or start with # to post to the room chat.",
      },
      intent: { type: "none" },
    };
  }

  if (state.taskRunning) {
    return {
      state: { ...state, message: "An agent reply is already running. Wait for it to finish before asking another." },
      intent: { type: "none" },
    };
  }

  const goal = (mentionTarget ? rawGoal.slice(leadText.length) : rawGoal).trim();
  if (!goal) {
    return {
      state: { ...state, message: `Add a message after ${resolved.label}.` },
      intent: { type: "none" },
    };
  }

  const targetLabel = resolved.label;
  const provider = resolved.provider;
  const agentId = resolved.agentId;
  const providerLabel = resolved.providerLabel;
  return beginOpenTuiRunnableIntent(state, {
    title: `Ask ${targetLabel}?`,
    detail: `Auto-run is off. Approve this message for ${providerLabel}: ${previewText(goal, "(no prompt)")}`,
    confirmLabel: "Ask agent",
    runningMessage: `Asking ${targetLabel}...`,
    feedKind: "info",
    feedMessage: `Asking ${targetLabel}: ${goal}`,
    returnMode: "task",
    returnTaskInput,
    intent: { type: "submit", goal, provider, agentId },
  });
}

function beginOpenTuiApprovedIntent(
  state: OpenTuiPreviewUiState,
  request: OpenTuiApprovalRequest,
): OpenTuiPreviewKeyResult {
  const action = request.safetyAction ?? "task";
  const decision = action === "task"
    ? evaluateTaskApproval(state.safety)
    : evaluateSafetyActionApproval(state.safety, action);
  if (decision.status === "allowed") {
    return {
      state: startOpenTuiApprovedIntent(state, request, decision.state),
      intent: request.intent,
    };
  }

  const detail = [request.detail, decision.message].filter(Boolean).join("\n");
  return {
    state: {
      ...state,
      safety: decision.state,
      mode: "confirm",
      pendingApproval: { ...request, detail },
      taskRunning: false,
      message: decision.message,
      feed: appendOpenTuiFeed(state.feed, "warning", `${request.title} ${decision.message}`),
    },
    intent: { type: "none" },
  };
}

function reduceOpenTuiApprovalKey(state: OpenTuiPreviewUiState, sequence: string): OpenTuiPreviewKeyResult {
  const request = state.pendingApproval;
  if (!request) {
    return {
      state: { ...state, mode: "dashboard", message: "No pending approval." },
      intent: { type: "none" },
    };
  }

  if (sequence === "\r" || sequence.toLowerCase() === "y") {
    const action = request.safetyAction ?? "task";
    const decision = action === "task"
      ? evaluateTaskApproval(state.safety, { approved: true })
      : evaluateSafetyActionApproval(state.safety, action, { approved: true });
    return {
      state: startOpenTuiApprovedIntent(state, request, decision.state),
      intent: request.intent,
    };
  }

  if (sequence === "\u001b" || sequence.toLowerCase() === "n" || sequence.toLowerCase() === "q") {
    return {
      state: {
        ...state,
        mode: request.returnMode,
        pendingApproval: undefined,
        taskRunning: request.cancelIntent ? state.taskRunning : false,
        taskInput: request.returnTaskInput,
        taskCursor: (request.returnTaskInput ?? "").length,
        message: request.cancelIntent ? "Approval denied." : "Approval cancelled.",
        feed: appendOpenTuiFeed(
          state.feed,
          "warning",
          request.cancelIntent ? `Approval denied: ${request.title}` : `Approval cancelled: ${request.title}`,
        ),
      },
      intent: request.cancelIntent || { type: "none" },
    };
  }

  return { state, intent: { type: "none" } };
}

function startOpenTuiApprovedIntent(
  state: OpenTuiPreviewUiState,
  request: OpenTuiApprovalRequest,
  safety: TuiSafetyState,
): OpenTuiPreviewUiState {
  if (request.intent.type === "connect-terminal") {
    return {
      ...state,
      safety,
      mode: "terminal",
      pendingApproval: undefined,
      taskRunning: false,
      message: request.runningMessage,
      terminal: { ...state.terminal, connecting: true, disconnectReason: undefined, closedAt: undefined },
      feed: appendOpenTuiFeed(state.feed, request.feedKind, request.feedMessage),
    };
  }

  if (!isOpenTuiRunnableIntent(request.intent)) {
    return {
      ...state,
      safety,
      mode: request.returnMode,
      pendingApproval: undefined,
      taskRunning: request.intent.type === "agent-stop"
        || request.intent.type === "agent-pause"
        || request.intent.type === "runtime-action"
        || request.intent.type === "rename-apply"
        || (request.intent.type === "bridge-approval" && state.taskRunning),
      taskInput: "",
      message: request.runningMessage,
      feed: appendOpenTuiFeed(state.feed, request.feedKind, request.feedMessage),
    };
  }

  return {
    ...state,
    safety,
    mode: "dashboard",
    pendingApproval: undefined,
    taskInput: "",
    taskRunning: true,
    taskStartedAt: Date.now(),
    taskHistory: normalizeTaskHistory(state.taskHistory, openTuiRunnableHistoryGoal(request.intent)),
    message: request.runningMessage,
    feed: appendOpenTuiFeed(state.feed, request.feedKind, request.feedMessage),
  };
}

function isOpenTuiRunnableIntent(intent: OpenTuiApprovedIntent): intent is OpenTuiRunnableIntent {
  return intent.type === "submit" || intent.type === "fanout" || intent.type === "handoff" || intent.type === "agent-start";
}

function openTuiRunnableHistoryGoal(intent: OpenTuiRunnableIntent): string {
  if (intent.type === "handoff") {
    return intent.resolution.goal || intent.resolution.context;
  }
  return intent.goal;
}

export function beginOpenTuiBridgeApproval(
  state: OpenTuiPreviewUiState,
  approval: BridgeApprovalRequest,
): OpenTuiPreviewUiState {
  const target = bridgeApprovalTarget(approval);
  return {
    ...state,
    mode: "confirm",
    pendingApproval: {
      title: `Approve ${bridgeApprovalTitle(approval)}?`,
      detail: bridgeApprovalDetailLines(approval).join("\n"),
      confirmLabel: "Approve",
      runningMessage: "Bridge approval approved.",
      feedMessage: `Bridge approval requested: ${bridgeApprovalTitle(approval)} for ${target}`,
      feedKind: "warning",
      returnMode: state.mode === "confirm" || state.mode === "help" ? "dashboard" : state.mode,
      returnTaskInput: state.taskInput,
      intent: { type: "bridge-approval", approvalId: approval.approvalId, decision: "approve", target },
      cancelIntent: { type: "bridge-approval", approvalId: approval.approvalId, decision: "deny", target },
    },
    message: "Bridge approval requested.",
    feed: appendOpenTuiFeed(state.feed, "warning", `Bridge approval requested: ${bridgeApprovalTitle(approval)} for ${target}`),
  };
}

function beginOpenTuiLogin(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      mode: "dashboard",
      message: "Starting login flow...",
      feed: appendOpenTuiFeed(state.feed, "info", "Starting login flow..."),
    },
    intent: { type: "login" },
  };
}

function beginOpenTuiInit(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  if (!state.dashboard.session) {
    return {
      state: {
        ...state,
        mode: "dashboard",
        message: "Login before initializing a project room.",
        feed: appendOpenTuiFeed(state.feed, "warning", "Run /login before /init."),
      },
      intent: { type: "none" },
    };
  }

  const request = {
    title: state.dashboard.config?.roomId ? "Reinitialize project room?" : "Initialize project room?",
    detail: `This will run init for ${state.args.dir} and may update .co-od.json.`,
    confirmLabel: state.dashboard.config?.roomId ? "Reinitialize" : "Initialize",
    runningMessage: "Initializing project room...",
    feedKind: "info" as const,
    feedMessage: "Initializing project room...",
    returnMode: "dashboard" as const,
    returnTaskInput: "/init",
    intent: { type: "init-project" as const },
  };

  if (state.dashboard.config?.roomId) {
    return beginOpenTuiApprovedIntent(state, { ...request, safetyAction: "destructive" });
  }

  return {
    state: {
      ...state,
      mode: "dashboard",
      message: request.runningMessage,
      feed: appendOpenTuiFeed(state.feed, request.feedKind, request.feedMessage),
    },
    intent: request.intent,
  };
}

export function openTuiPaletteItems(state: OpenTuiPreviewUiState): PaletteItem[] {
  return buildPaletteItems({
    actions: buildActions({
      hasRoom: Boolean(state.dashboard.config?.roomId),
      loggedIn: Boolean(state.dashboard.session),
      taskRunning: state.taskRunning,
      terminalActive: state.terminal.connected,
      terminalConnecting: state.terminal.connecting,
      terminalDisconnected: Boolean(state.terminal.disconnectReason || state.terminalLines.length > 0)
        && !state.terminal.connected,
      runCount: state.dashboard.dashboard.runs.length,
    }),
    providers: TUI_PROVIDERS,
    providerAvailability: state.dashboard.providerAvailability,
    agents: state.dashboard.dashboard.agents,
    runs: state.dashboard.dashboard.runs,
    room: state.dashboard.config
      ? { roomId: state.dashboard.config.roomId, roomName: state.dashboard.config.roomName }
      : null,
    rooms: state.dashboard.rooms.map((room) => ({ roomId: room._id, roomName: room.name })),
    files: state.workspaceFiles,
  });
}

export function filteredOpenTuiPaletteItems(state: OpenTuiPreviewUiState, limit = 10): PaletteItem[] {
  return filterPaletteItems(openTuiPaletteItems(state), state.paletteInput, limit);
}

function openTuiTaskSuggestions(state: OpenTuiPreviewUiState, limit = 6): SlashCommandSuggestion[] {
  if (state.mode !== "task") return [];
  const cursor = Number.isFinite(state.taskCursor) ? state.taskCursor : state.taskInput.length;
  return composerSuggestions(state.taskInput, cursor, openTuiMentionTargets(state), limit);
}

export function openTuiMentionTargets(state: OpenTuiPreviewUiState): AgentMentionTarget[] {
  return providerMentionTargets({
    agents: state.dashboard.dashboard.agents || [],
    providers: TUI_PROVIDERS,
    providerAvailability: state.dashboard.providerAvailability,
    providerAuth: state.dashboard.providerAuth,
  });
}

function selectedOpenTuiTaskSuggestion(state: OpenTuiPreviewUiState): SlashCommandSuggestion | undefined {
  const suggestions = openTuiTaskSuggestions(state);
  if (suggestions.length === 0) return undefined;
  const index = Math.min(Math.max(0, state.taskSuggestionSelected), suggestions.length - 1);
  return suggestions[index];
}

function moveOpenTuiTaskSuggestion(state: OpenTuiPreviewUiState, direction: -1 | 1): OpenTuiPreviewKeyResult {
  const suggestions = openTuiTaskSuggestions(state);
  if (suggestions.length === 0) return { state, intent: { type: "none" } };
  return {
    state: {
      ...state,
      taskSuggestionSelected: (state.taskSuggestionSelected + direction + suggestions.length) % suggestions.length,
      message: "Slash command autocomplete.",
    },
    intent: { type: "none" },
  };
}

function completeOpenTuiTaskSuggestion(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  const suggestion = selectedOpenTuiTaskSuggestion(state);
  if (!suggestion) return { state, intent: { type: "none" } };
  const cursor = Number.isFinite(state.taskCursor) ? state.taskCursor : state.taskInput.length;
  const token = activeMentionToken(state.taskInput, cursor);
  // @agent completion replaces just the @token in place (mid-sentence); slash
  // completion replaces the whole input.
  if (token && suggestion.completion.startsWith("@")) {
    const start = cursor - token.length;
    const taskInput = state.taskInput.slice(0, start) + suggestion.completion + state.taskInput.slice(cursor);
    return {
      state: {
        ...state,
        taskInput,
        taskCursor: start + suggestion.completion.length,
        taskSuggestionSelected: 0,
        message: `Targeting ${suggestion.command}.`,
      },
      intent: { type: "none" },
    };
  }
  return {
    state: {
      ...state,
      taskInput: suggestion.completion,
      taskCursor: suggestion.completion.length,
      taskSuggestionSelected: 0,
      message: `Completed ${suggestion.command}.`,
    },
    intent: { type: "none" },
  };
}

export function appendOpenTuiFeed(
  feed: OpenTuiPreviewFeedEntry[],
  kind: OpenTuiPreviewFeedKind,
  text: string,
  limit = 80,
): OpenTuiPreviewFeedEntry[] {
  if (!text) return feed;
  return [...feed, { kind, text }].slice(-limit);
}

function rememberOpenTuiUndo(state: OpenTuiPreviewUiState, label: string): OpenTuiPreviewUiState {
  return {
    ...state,
    undoStack: pushUndoSnapshot(state.undoStack, createUndoSnapshot({
      label,
      provider: state.dashboard.provider,
      model: state.model,
      selectedAgentId: state.selectedAgentId,
      attachments: state.attachments,
      pins: state.pins,
      safety: state.safety,
    })),
  };
}

function applyOpenTuiUndo(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  const snapshot = state.undoStack.at(-1);
  if (!snapshot) {
    return {
      state: {
        ...state,
        message: "Nothing to undo.",
        feed: appendOpenTuiFeed(state.feed, "warning", "Nothing to undo."),
      },
      intent: { type: "none" },
    };
  }

  if (snapshot.serverChanges && snapshot.serverChanges.length > 0) {
    return {
      state: {
        ...state,
        message: "Restoring server state...",
        feed: appendOpenTuiFeed(state.feed, "info", "Restoring server state for undo."),
      },
      intent: { type: "server-undo", snapshot },
    };
  }

  const fileRestore = snapshot.fileChanges && snapshot.fileChanges.length > 0
    ? restoreFileUndoChanges(state.args.dir, snapshot.fileChanges)
    : null;
  if (fileRestore && !fileRestore.ok) {
    return {
      state: {
        ...state,
        message: fileRestore.message,
        feed: appendOpenTuiFeed(state.feed, "error", fileRestore.message),
      },
      intent: { type: "none" },
    };
  }

  const restored = restoreUndoSnapshot(snapshot, state.safety);
  return {
    state: {
      ...state,
      dashboard: { ...state.dashboard, provider: restored.provider },
      model: restored.model,
      selectedAgentId: restored.selectedAgentId,
      attachments: restored.attachments,
      pins: restored.pins,
      safety: restored.safety,
      undoStack: state.undoStack.slice(0, -1),
      message: `Undid: ${snapshot.label}`,
      feed: appendOpenTuiFeed(
        state.feed,
        "info",
        [
          `Undid: ${snapshot.label}`,
          fileRestore && fileRestore.changedFiles.length > 0 ? `Restored files: ${fileRestore.changedFiles.join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      ),
    },
    intent: { type: "none" },
  };
}

export function recallOpenTuiTaskHistory(state: OpenTuiPreviewUiState, direction: -1 | 1): OpenTuiPreviewKeyResult {
  const current = state.taskHistory.indexOf(state.taskInput);
  const nextIndex = current < 0
    ? direction < 0 ? state.taskHistory.length - 1 : 0
    : Math.max(0, Math.min(state.taskHistory.length - 1, current + direction));
  const goal = state.taskHistory[nextIndex];
  if (!goal) {
    return {
      state: { ...state, message: "No task history yet." },
      intent: { type: "none" },
    };
  }
  return {
    state: {
      ...state,
      taskInput: goal,
      taskCursor: goal.length,
      message: `Task history ${nextIndex + 1}/${state.taskHistory.length}.`,
    },
    intent: { type: "none" },
  };
}

export function completeOpenTuiTask(
  state: OpenTuiPreviewUiState,
  kind: OpenTuiPreviewFeedKind,
  message: string,
): OpenTuiPreviewUiState {
  return {
    ...state,
    taskRunning: false,
    taskStartedAt: undefined,
    message,
    feed: appendOpenTuiFeed(state.feed, kind, message),
  };
}

export function completeOpenTuiRunDetail(state: OpenTuiPreviewUiState, detail: RunDetailData): OpenTuiPreviewUiState {
  return {
    ...state,
    mode: "run",
    selectedRunId: detail.run._id,
    selectedRunDetail: detail,
    runDetailLoading: false,
    selectedPatchIndex: Math.min(state.selectedPatchIndex, Math.max(0, detail.patches.length - 1)),
    message: `Task detail loaded: ${shortId(detail.run._id)}`,
    feed: appendOpenTuiFeed(state.feed, "info", `Task detail loaded: ${shortId(detail.run._id)}`),
  };
}

export function failOpenTuiRunDetail(state: OpenTuiPreviewUiState, message: string): OpenTuiPreviewUiState {
  return {
    ...state,
    runDetailLoading: false,
    pendingRunAction: undefined,
    message,
    feed: appendOpenTuiFeed(state.feed, "warning", message),
  };
}

export function completeOpenTuiWorkspaceSearch(
  state: OpenTuiPreviewUiState,
  result: WorkspaceSearchResult,
): OpenTuiPreviewUiState {
  if (result.error) {
    const message = result.query ? "No search results." : "Search needs a query.";
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "search",
        title: "Workspace Search",
        query: result.query,
        summary: `search: ${result.error}`,
        entries: [],
        selectedIndex: 0,
      },
      message,
      feed: appendOpenTuiFeed(state.feed, result.query ? "warning" : "error", `search: ${result.error}`),
    };
  }

  const entries = result.matches.map((match) => ({
    label: `${match.path}:${match.line}:${match.column}`,
    detail: match.text,
    attachPath: match.path,
    promptText: `Review @${quoteFileMentionPath(match.path)} around line ${match.line}: ${match.text}`,
  }));
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "search",
      title: "Workspace Search",
      query: result.query,
      summary: entries.length > 0
        ? `${entries.length} matches for ${result.query}`
        : `No matches for ${result.query}`,
      entries,
      selectedIndex: 0,
    },
    message: entries.length > 0 ? `Search returned ${entries.length} matches.` : "No search results.",
    feed: appendOpenTuiFeed(
      state.feed,
      entries.length > 0 ? "info" : "warning",
      entries.length > 0 ? `Search ${result.query}: ${entries.length} matches` : `No matches for ${result.query}.`,
    ),
  };
}

export function completeOpenTuiWorkspaceDiff(
  state: OpenTuiPreviewUiState,
  result: WorkspaceDiffResult,
): OpenTuiPreviewUiState {
  if (result.error) {
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "diff",
        title: "Workspace Diff",
        query: result.path,
        summary: `diff: ${result.error}`,
        entries: [],
        selectedIndex: 0,
      },
      message: "Workspace diff unavailable.",
      feed: appendOpenTuiFeed(state.feed, "error", `diff: ${result.error}`),
    };
  }

  const entries = result.lines.map((line, index) => ({
    label: `${String(index + 1).padStart(4, " ")}`,
    detail: line || " ",
    attachPath: result.path,
    promptText: result.path
      ? `Review the local diff for @${quoteFileMentionPath(result.path)}.`
      : "Review the current workspace diff.",
  }));
  const summary = entries.length > 0
    ? `${entries.length} diff lines${result.path ? ` in ${result.path}` : ""}${result.truncated ? " (truncated)" : ""}`
    : result.path
      ? `No diff for ${result.path}`
      : "No workspace diff";
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "diff",
      title: "Workspace Diff",
      query: result.path,
      summary,
      entries,
      selectedIndex: 0,
    },
    message: entries.length > 0 ? `Diff loaded: ${entries.length} lines.` : "No workspace diff.",
    feed: appendOpenTuiFeed(state.feed, entries.length > 0 ? "output" : "info", summary),
  };
}

export function completeOpenTuiWorkspaceSymbols(
  state: OpenTuiPreviewUiState,
  result: TuiSymbolResult,
): OpenTuiPreviewUiState {
  if (result.error) {
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "symbols",
        title: "Workspace Symbols",
        query: result.query,
        summary: `symbols: ${result.error}`,
        entries: [],
        selectedIndex: 0,
      },
      message: "Symbol scan unavailable.",
      feed: appendOpenTuiFeed(state.feed, "error", `symbols: ${result.error}`),
    };
  }

  const entries = result.symbols.map((symbol) => ({
    label: `${symbol.path}:${symbol.line}:${symbol.column}`,
    detail: `${symbol.kind.padEnd(9)} ${symbol.name}  ${symbol.signature}`,
    attachPath: symbol.path,
    promptText: `Review @${quoteFileMentionPath(symbol.path)} symbol ${symbol.name} at line ${symbol.line}.`,
  }));
  const summary = result.query
    ? `${entries.length} symbols matching ${result.query} across ${result.scannedFiles} files`
    : `${entries.length} workspace symbols across ${result.scannedFiles} files`;
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "symbols",
      title: "Workspace Symbols",
      query: result.query,
      summary,
      entries,
      selectedIndex: 0,
    },
    message: entries.length > 0 ? `Listed ${entries.length} symbols from ${result.scannedFiles} files.` : "No symbols found.",
    feed: appendOpenTuiFeed(state.feed, entries.length > 0 ? "info" : "warning", summary),
  };
}

export function completeOpenTuiSymbolNavigation(
  state: OpenTuiPreviewUiState,
  result: TuiSymbolNavigationResult,
): OpenTuiPreviewUiState {
  if (!result.symbol) {
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "symbols",
        title: "Symbol Location",
        query: result.query,
        summary: result.message,
        entries: [],
        selectedIndex: 0,
      },
      message: result.message,
      feed: appendOpenTuiFeed(state.feed, result.error ? "error" : "warning", `goto: ${result.message}`),
    };
  }

  const symbol = result.symbol;
  const source = result.source ? ` via ${result.source}` : "";
  const entry = {
    label: `${symbol.path}:${symbol.line}:${symbol.column}`,
    detail: `${symbol.kind.padEnd(9)} ${symbol.name}${source}  ${symbol.signature}`,
    attachPath: symbol.path,
    promptText: `Review @${quoteFileMentionPath(symbol.path)} symbol ${symbol.name} at line ${symbol.line}: ${symbol.signature}`,
  };
  const summary = `${result.message}; scanned ${result.scannedFiles} files`;
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "symbols",
      title: "Symbol Location",
      query: result.query,
      summary,
      entries: [entry],
      selectedIndex: 0,
    },
    message: result.message,
    feed: appendOpenTuiFeed(state.feed, "success", `${summary}\n${entry.label} ${entry.detail}`),
  };
}

export function completeOpenTuiRenamePreview(
  state: OpenTuiPreviewUiState,
  result: TuiRenamePreviewResult,
): OpenTuiPreviewUiState {
  if (!result.symbol || result.error) {
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "rename",
        title: "Rename Preview",
        query: `${result.oldName} -> ${result.newName}`,
        summary: result.message,
        entries: [],
        selectedIndex: 0,
      },
      message: result.message,
      feed: appendOpenTuiFeed(state.feed, result.error ? "error" : "warning", `rename-preview: ${result.message}`),
    };
  }

  const visibleOccurrences = result.occurrences.slice(0, 50);
  const entries = visibleOccurrences.map((occurrence) => ({
    label: `${occurrence.path}:${occurrence.line}:${occurrence.column}`,
    detail: occurrence.text,
    attachPath: occurrence.path,
    promptText: `Review rename ${result.oldName} -> ${result.newName} in @${quoteFileMentionPath(occurrence.path)} at line ${occurrence.line}: ${occurrence.text}`,
  }));
  const source = result.source ? ` via ${result.source}` : "";
  const summary = `${result.message}${source}; scanned ${result.scannedFiles} files`;
  const truncated = result.occurrences.length > entries.length
    ? `Showing first ${entries.length} of ${result.occurrences.length} occurrences.`
    : "";
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "rename",
      title: "Rename Preview",
      query: `${result.oldName} -> ${result.newName}`,
      summary: truncated ? `${summary} ${truncated}` : summary,
      entries,
      selectedIndex: 0,
    },
    message: entries.length > 0
      ? `Rename preview found ${result.occurrences.length} occurrences.`
      : result.message,
    feed: appendOpenTuiFeed(
      state.feed,
      entries.length > 0 ? "info" : "warning",
      [
        summary,
        `Definition ${result.symbol.path}:${result.symbol.line}:${result.symbol.column} ${result.symbol.kind} ${result.symbol.name}`,
        truncated,
      ].filter(Boolean).join("\n"),
    ),
  };
}

export function completeOpenTuiDiagnostics(
  state: OpenTuiPreviewUiState,
  result: TypeScriptDiagnosticResult,
): OpenTuiPreviewUiState {
  const title = result.kind === "python"
    ? "Python Diagnostics"
    : result.kind === "go"
      ? "Go Diagnostics"
      : result.kind === "rust"
        ? "Rust Diagnostics"
        : result.kind === "all"
          ? "Workspace Diagnostics"
          : "TypeScript Diagnostics";
  const label = result.label || result.project || (result.kind === "python" ? "python" : result.kind === "go" ? "go" : result.kind === "rust" ? "rust" : result.kind === "all" ? "all" : "diagnostics");
  if (result.error) {
    const entries = (result.projects || []).map((project) => ({
      label: project,
      attachPath: project,
      promptText: `Run TypeScript diagnostics for @${quoteFileMentionPath(project)}.`,
    }));
    return {
      ...state,
      mode: "workspace",
      workspaceResults: {
        kind: "diagnostics",
        title,
        query: result.project,
        summary: `diagnostics: ${result.error}`,
        entries,
        selectedIndex: 0,
      },
      message: result.projects && result.projects.length > 1
        ? "Diagnostics need a tsconfig path."
        : "Diagnostics unavailable.",
      feed: appendOpenTuiFeed(state.feed, "warning", `diagnostics: ${result.error}`),
    };
  }

  const entries = result.diagnostics.map((diagnostic) => ({
    label: `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`,
    detail: `${diagnostic.code} ${diagnostic.message}`,
    attachPath: diagnostic.file,
    promptText: `Fix ${diagnostic.code} in @${quoteFileMentionPath(diagnostic.file)} at line ${diagnostic.line}: ${diagnostic.message}`,
  }));
  const summary = entries.length > 0
    ? `${entries.length} diagnostics in ${label}`
    : `Diagnostics clean: ${label}`;
  return {
    ...state,
    mode: "workspace",
    workspaceResults: {
      kind: "diagnostics",
      title,
      query: result.project,
      summary,
      entries,
      selectedIndex: 0,
    },
    message: entries.length > 0 ? `Diagnostics found ${entries.length} issues.` : "Diagnostics clean.",
    feed: appendOpenTuiFeed(state.feed, entries.length > 0 ? "warning" : "success", summary),
  };
}

export function completeOpenTuiPatchResolve(
  state: OpenTuiPreviewUiState,
  detail: RunDetailData,
  action: "accept" | "reject",
  patchId: string,
): OpenTuiPreviewUiState {
  const base = action === "reject" && state.dashboard.config?.roomId && state.selectedRunDetail
    ? {
        ...state,
        undoStack: pushUndoSnapshot(state.undoStack, createUndoSnapshot({
          label: "patch reject",
          provider: state.dashboard.provider,
          model: state.model,
          selectedAgentId: state.selectedAgentId,
          attachments: state.attachments,
          pins: state.pins,
          safety: state.safety,
          serverChanges: [{
            kind: "patch-reopen",
            roomId: state.dashboard.config.roomId,
            runId: state.selectedRunDetail.run._id,
            patchId,
            fromStatus: "rejected",
            toStatus: "proposed",
          }],
        })),
      }
    : state;
  const next = completeOpenTuiRunDetail(base, detail);
  const message = `Patch ${action}ed: ${shortId(patchId)}`;
  return {
    ...next,
    message,
    feed: appendOpenTuiFeed(
      next.feed,
      action === "accept" ? "success" : "warning",
      action === "reject" ? `${message}\nUse /undo to reopen this patch.` : message,
    ),
  };
}

export function completeOpenTuiRunExport(
  state: OpenTuiPreviewUiState,
  path: string,
  undoable = false,
): OpenTuiPreviewUiState {
  const message = `Exported task summary: ${path}`;
  return {
    ...state,
    pendingRunAction: undefined,
    message,
    feed: appendOpenTuiFeed(
      state.feed,
      "success",
      undoable ? `${message}\nUse /undo to restore or remove this export.` : message,
    ),
  };
}

export function completeOpenTuiServerUndo(
  state: OpenTuiPreviewUiState,
  snapshot: TuiUndoSnapshot,
  restored: ReturnType<typeof restoreUndoSnapshot>,
  restoredPatchIds: string[],
): OpenTuiPreviewUiState {
  return {
    ...state,
    dashboard: { ...state.dashboard, provider: restored.provider },
    model: restored.model,
    selectedAgentId: restored.selectedAgentId,
    attachments: restored.attachments,
    pins: restored.pins,
    safety: restored.safety,
    undoStack: state.undoStack.slice(0, -1),
    message: `Undid: ${snapshot.label}`,
    feed: appendOpenTuiFeed(
      state.feed,
      "info",
      [
        `Undid: ${snapshot.label}`,
        restoredPatchIds.length > 0 ? `Restored server state: ${restoredPatchIds.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
    ),
  };
}

export function completeOpenTuiRunCopy(state: OpenTuiPreviewUiState, kind: RunCopyKind): OpenTuiPreviewUiState {
  const message = `Copied task ${kind} to clipboard.`;
  return {
    ...state,
    pendingRunAction: undefined,
    message,
    feed: appendOpenTuiFeed(state.feed, "success", message),
  };
}

export function completeOpenTuiRunStop(state: OpenTuiPreviewUiState, detail: RunDetailData, runId: string): OpenTuiPreviewUiState {
  const next = completeOpenTuiRunDetail(state, detail);
  const message = `Stopped run: ${shortId(runId)}`;
  return {
    ...next,
    message,
    feed: appendOpenTuiFeed(next.feed, "warning", message),
  };
}

export function handleOpenTuiTerminalEvent(
  state: OpenTuiPreviewUiState,
  event: TuiTerminalEvent,
): OpenTuiPreviewUiState {
  const terminal = reduceTerminalConnectionState(state.terminal, event);
  if (event.type === "connecting") {
    const message = state.terminalLines.length > 0 || state.terminal.disconnectReason
      ? "Reconnecting shared terminal..."
      : "Connecting shared terminal...";
    return {
      ...state,
      mode: "terminal",
      terminal,
      message,
      feed: appendOpenTuiFeed(state.feed, "info", message),
    };
  }
  if (event.type === "status") {
    return {
      ...state,
      terminal,
      message: `Terminal ${event.message}`,
      feed: appendOpenTuiFeed(state.feed, "info", `terminal: ${event.message}`),
    };
  }
  if (event.type === "output") {
    return {
      ...state,
      terminal,
      terminalLines: appendTerminalOutputLines(state.terminalLines, event.data),
    };
  }
  if (event.type === "error") {
    return {
      ...state,
      terminal,
      message: event.message,
      feed: appendOpenTuiFeed(state.feed, "error", `terminal: ${event.message}`),
    };
  }
  if (event.type === "closed") {
    return {
      ...state,
      mode: state.mode === "terminal" ? "dashboard" : state.mode,
      terminal,
      message: "Shared terminal disconnected. Press c to reconnect.",
      feed: appendOpenTuiFeed(state.feed, "warning", `terminal closed: ${terminal.disconnectReason || "Connection closed"}`),
    };
  }
  return { ...state, terminal };
}

export function formatOpenTuiPreviewText(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  options: OpenTuiPreviewFormatOptions = {},
): string {
  const width = normalizeViewportSize(options.width);
  const height = normalizeViewportSize(options.height);
  const lines = formatOpenTuiPreviewLines(state, width, height, options);

  if (width && height) return renderTerminalFrame(lines, width, height);
  if (width) return lines.map((line) => fitPlain(line, width)).join("\n");
  return lines.join("\n");
}

function formatOpenTuiPreviewLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  width?: number,
  height?: number,
  options: OpenTuiPreviewFormatOptions = {},
): string[] {
  const palette = paletteLines(state);
  const runDetail = runDetailLines(state);
  const workspaceResults = workspaceResultLines(state);
  const terminal = terminalLines(state);
  const approval = approvalLines(state);
  const help = helpLines(state);

  if (runDetail.length > 0 || workspaceResults.length > 0 || terminal.length > 0 || palette.length > 0 || approval.length > 0 || help.length > 0) {
    return [
      ...openTuiHeaderLines(state, width),
      "",
      ...runDetail,
      ...workspaceResults,
      ...terminal,
      ...palette,
      ...approval,
      ...help,
      "",
      ...openTuiComposerSurfaceLines(state, width),
    ];
  }

  return openTuiDashboardExperienceLines(state, width, height, options);
}

function openTuiDashboardExperienceLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  width = 118,
  height = 34,
  options: OpenTuiPreviewFormatOptions = {},
): string[] {
  const usableHeight = Math.max(18, height);
  const header = openTuiHeaderLines(state, width);
  const composer = openTuiComposerSurfaceLines(state, width);
  const footerReserve = composer.length + 2;
  const bodyLimit = Math.max(7, usableHeight - header.length - footerReserve - 1);
  const railWidth = isUiState(state)
    ? normalizeFormatSideRailWidth(options.sideRailWidth)
      || normalizeSideRailWidth(state.sideRailWidth)
      || SIDE_RAIL_DEFAULT_WIDTH
    : 0;
  const minMainWidth = normalizeFormatSideRailMinMainWidth(options.sideRailMinMainWidth)
    || SIDE_RAIL_MIN_MAIN_WIDTH;
  const useRail = railWidth > 0 && width >= railWidth + minMainWidth + 2;
  const gap = useRail ? "  " : "";
  const mainWidth = useRail ? width - railWidth - gap.length : width;
  const main = openTuiMainPaneLines(state, bodyLimit, mainWidth);
  const rail = useRail ? openTuiTeamRailLines(state, bodyLimit, railWidth) : [];
  const body = useRail
    ? zipColumns(main, rail, mainWidth, railWidth, gap).slice(0, bodyLimit)
    : main.slice(0, bodyLimit).map((line) => fitPlain(line, width));

  return [
    ...header,
    "",
    ...body,
    "",
    ...composer,
  ];
}

function normalizeFormatSideRailWidth(width?: number): number | undefined {
  if (!Number.isFinite(width) || (width as number) <= 0) return undefined;
  return Math.max(14, Math.min(64, Math.round(width as number)));
}

function normalizeFormatSideRailMinMainWidth(width?: number): number | undefined {
  if (!Number.isFinite(width) || (width as number) <= 0) return undefined;
  return Math.max(40, Math.min(SIDE_RAIL_MIN_MAIN_WIDTH, Math.round(width as number)));
}

function openTuiHeaderLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  width = 118,
): string[] {
  const room = state.dashboard.config?.roomName || state.dashboard.config?.roomId || "no room";
  const selectedAgent = isUiState(state) ? selectedOpenTuiAgent(state) : state.dashboard.dashboard.agents[0];
  const model = isUiState(state) && state.model ? ` model ${state.model}` : "";
  const provider = `${state.dashboard.provider}${model}`;
  const workspace = state.workspace.isGitRepo
    ? `${compact(state.workspace.branch, "detached")} ${state.workspace.dirty ? "dirty" : "clean"}`
    : "not a git repo";
  const queuedTasks = state.dashboard.dashboard.runs.filter(isOpenTuiQueuedRun).length;
  const runningTasks = state.dashboard.dashboard.runs.filter(isOpenTuiWorkingRun).length;
  const taskSummary = runningTasks > 0
    ? `${runningTasks} working${queuedTasks > 0 ? `, ${queuedTasks} queued` : ""}`
    : queuedTasks > 0
      ? `${queuedTasks} queued`
      : "ready";
  const target = selectedAgent ? `@${agentHandle(selectedAgent)}` : "room";
  const live = state.dashboard.session ? "●live" : "○offline";
  const bridge = state.dashboard.bridge === "running" ? "bridge connected" : "bridge offline";

  return [
    fitPlain(`co·ode · room ${compact(room, "no room")} · ${provider} · ${live} · ${taskSummary}`, width),
    fitPlain(`target ${target} · ${state.dashboard.dashboard.agents.length} agents · ${workspace} · ${bridge}`, width),
  ];
}

function isOpenTuiActiveRun(run: { status?: string | null }): boolean {
  return isOpenTuiQueuedRun(run) || isOpenTuiWorkingRun(run);
}

function isOpenTuiQueuedRun(run: { status?: string | null }): boolean {
  return run.status === "queued";
}

function isOpenTuiWorkingRun(run: { status?: string | null }): boolean {
  return run.status === "running" || run.status === "in_progress";
}

function isOpenTuiFailedRun(run: { status?: string | null }): boolean {
  return run.status === "failed" || run.status === "error" || run.status === "cancelled";
}

function openTuiMainPaneLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  limit: number,
  width: number,
): string[] {
  const rows: string[] = [];

  if (!state.dashboard.config?.roomId) {
    return [
      "start a room",
      "1. co-od login",
      "2. co-od init",
      "3. add an agent: codex, claude, opencode",
      "",
      "now",
      "  no agents yet",
      "",
      "next",
      "  /init creates the room here",
    ].slice(0, limit).map((line) => fitPlain(line, width));
  }

  if (!state.dashboard.session) {
    return [
      "co·ode — signed out",
      "/login enters the room here.",
      "",
      "now",
      "  agents wait until you sign in",
    ].slice(0, limit).map((line) => fitPlain(line, width));
  }

  const runs = state.dashboard.dashboard.runs;
  const patches = state.dashboard.dashboard.patches || [];
  const messages = state.dashboard.dashboard.messages || [];
  const failedRuns = runs.filter(isOpenTuiFailedRun);
  const proposedPatches = patches.filter((patch) => patch.status === "proposed");
  const transcript = isUiState(state) ? openTuiTranscriptLines(state, Math.min(6, Math.max(2, limit - 14)), width) : [];
  const agents = buildAgentActivityRows({
    agents: state.dashboard.dashboard.agents,
    runs,
    providerAvailability: state.dashboard.providerAvailability,
  });
  const totalDone = runs.filter((run) => run.status === "succeeded" || run.status === "completed").length;
  const lastActivityAt = Math.max(
    0,
    ...runs.map((run) => run.finished_at || run.created_at || 0),
    ...messages.map((message) => message.created_at || 0),
    ...patches.map((patch) => patch.created_at || 0),
  );

  rows.push("now");
  if (agents.length === 0) {
    rows.push("  no agents yet - /agent-add reviewer codex");
  }
  for (const agent of agents.slice(0, 4)) {
    const selected = isUiState(state) && agent.agentId === state.selectedAgentId ? ">" : " ";
    const agentRuns = runs.filter((run) => run.agent_id === agent.agentId);
    const active = agentRuns.find(isOpenTuiActiveRun)
      || agentRuns.find((run) => run.status === "succeeded" || run.status === "completed");
    const done = agentRuns.filter((run) => run.status === "succeeded" || run.status === "completed").length;
    const queued = agentRuns.filter(isOpenTuiQueuedRun).length;
    const failed = agentRuns.filter(isOpenTuiFailedRun).length;
    const glyph = active && isOpenTuiWorkingRun(active) ? "⠋"
      : active && isOpenTuiQueuedRun(active) ? "◌"
      : active ? "●" : "○";
    const stateBits = isOpenTuiActiveRun(active || {})
      ? [compact(active?.goal, "working")]
      : ["ready", done > 0 ? `${done} done` : "", queued > 0 ? `${queued} queued` : "", failed > 0 ? `${failed} need retry` : ""].filter(Boolean);
    rows.push(`${selected} ${glyph} @${agentHandle({ _id: agent.agentId, name: agent.name })}  ${agent.provider}`);
    rows.push(`  ${stateBits.join(" · ")}`);
  }
  rows.push(`room pulse · ${[totalDone > 0 ? `${totalDone} done` : "", failedRuns.length > 0 ? `${failedRuns.length} need retry` : "inbox clear", lastActivityAt > 0 ? `last activity ${formatOpenTuiRelativeTime(lastActivityAt)}` : ""].filter(Boolean).join(" · ")}`);

  rows.push("");
  rows.push("stream");
  if (isUiState(state) && state.message && state.message !== "Ready when you are.") {
    rows.push(`· ${state.message}`);
  }
  if (transcript.length > 0) {
    rows.push(...transcript);
  } else if (messages.length > 0) {
    const significant = messages
      .filter((message) => {
        const body = compact(message.body_md, "").toLowerCase();
        return body.length > 8 && !/^(hi|hello|hey|hola|yo|yoo|hii+)[.!?]*$/.test(body);
      })
      .slice(-2);
    for (const message of significant) {
      rows.push(`▌ ${compact(message.author_name || message.author_type, "teammate")}`);
      rows.push(`  ${compact(message.body_md, "")}`);
    }
  } else {
    rows.push("▌ you");
    rows.push("  Ready when you are.");
  }
  for (const [index, run] of runs.filter((candidate) => candidate.status === "succeeded" || candidate.status === "completed").slice(0, 2).entries()) {
    const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === run.agent_id);
    const marker = isUiState(state) && run._id === state.selectedRunId ? ">" : "✓";
    rows.push(`${marker} ${String(index + 1).padStart(2, "0")} ${compact(run.status, "done")} ${shortId(run._id)} ${compact(run.goal, "(no goal)")} - ${compact(agent?.name, "agent")}`);
  }
  for (const patch of proposedPatches.slice(0, 2)) {
    rows.push(`▸ ${compact(patch.path || patch.title, "patch")} ${diffStat(patch.diff_text)} review`);
  }

  rows.push("");
  rows.push("needs you");
  if (proposedPatches.length === 0 && failedRuns.length === 0) {
    rows.push("  nothing needs you");
  }
  for (const patch of proposedPatches) {
    rows.push(`▲ ${compact(patch.path || patch.title, "patch")} ${diffStat(patch.diff_text)} - review`);
  }
  if (failedRuns.length > 0) {
    const run = failedRuns[0];
    const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === run.agent_id);
    rows.push(`✗ ${failedRuns.length} task${failedRuns.length === 1 ? "" : "s"} need retry`);
    rows.push(`  latest: ${compact(run.goal, "(no goal)")} - ${compact(agent?.name, "agent")}`);
    rows.push("  R retry latest - d dismiss");
  }

  return rows.slice(0, limit).map((line) => fitPlain(line, width));
}

function openTuiTranscriptLines(state: OpenTuiPreviewUiState, limit: number, width: number): string[] {
  const rows: string[] = [];
  for (const message of state.transcript.slice(-4)) {
    const speaker = message.role === "you"
      ? "you"
      : compact(message.agentName || message.provider, "agent");
    const suffix = message.streaming ? " ..." : "";
    rows.push(`${speaker}${suffix}`);
    for (const block of message.blocks.slice(0, 3)) {
      if (block.kind === "markdown") {
        for (const line of block.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(Boolean).slice(0, 3)) {
          rows.push(`  ${previewText(line.trim(), "", Math.max(24, width - 4))}`);
        }
      } else if (block.kind === "toolCall") {
        rows.push(`  bash ${previewText(block.label, "", Math.max(24, width - 9))}`);
      } else if (block.kind === "diff") {
        rows.push(`  diff ${compact(block.file, block.patchId)} ${block.status}`);
      } else if (block.kind === "code") {
        rows.push(`  code ${previewText(block.text.replace(/\s+/g, " "), "", Math.max(24, width - 9))}`);
      }
    }
  }
  return rows.slice(-limit);
}

function openTuiTeamRailLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  limit: number,
  width: number,
): string[] {
  const selectedAgent = isUiState(state) ? selectedOpenTuiAgent(state) : state.dashboard.dashboard.agents[0];
  const activeRuns = state.dashboard.dashboard.runs.filter(isOpenTuiActiveRun);
  const queuedRuns = state.dashboard.dashboard.runs.filter(isOpenTuiQueuedRun).length;
  const workingRuns = state.dashboard.dashboard.runs.filter(isOpenTuiWorkingRun).length;
  const agents = buildAgentActivityRows({
    agents: state.dashboard.dashboard.agents,
    runs: state.dashboard.dashboard.runs,
    providerAvailability: state.dashboard.providerAvailability,
  });
  const selectedTarget = selectedAgent ? `@${agentHandle(selectedAgent)}` : "room";
  const roomStatus = workingRuns > 0
    ? `${workingRuns} working${queuedRuns > 0 ? ` - ${queuedRuns} queued` : ""}`
    : queuedRuns > 0
      ? `${queuedRuns} queued`
      : "ready";
  const roomRows = state.dashboard.session
    ? ["you  local coordinator", roomStatus, state.dashboard.bridge === "running" ? "bridge connected" : "bridge offline"]
    : ["you  local", "sign in to sync", state.dashboard.bridge === "running" ? "bridge connected" : "bridge offline"];
  const proposedPatches = (state.dashboard.dashboard.patches || []).filter((patch) => patch.status === "proposed");
  const failedRuns = state.dashboard.dashboard.runs.filter(isOpenTuiFailedRun);
  const attention = proposedPatches.length + failedRuns.length;
  const currentRoom = state.dashboard.config?.roomName || state.dashboard.config?.roomId || "current room";
  const lines = [
    `agents  inbox${attention > 0 ? `·${attention}` : ""}  rooms`,
    "",
    "you",
    ...roomRows,
    "",
    "agents",
    ...(agents.length === 0
      ? ["none yet", "/agent-add reviewer codex"]
      : agents.slice(0, 5).flatMap((agent) => {
        const marker = selectedAgent && agent.agentId === selectedAgent._id ? ">" : " ";
        const agentRuns = state.dashboard.dashboard.runs.filter((run) => run.agent_id === agent.agentId);
        const active = agentRuns.find(isOpenTuiActiveRun)
          || agentRuns.find((run) => run.status === "succeeded" || run.status === "completed");
        const done = agentRuns.filter((run) => run.status === "succeeded" || run.status === "completed").length;
        const failed = agentRuns.filter(isOpenTuiFailedRun).length;
        const status = isOpenTuiActiveRun(active || {})
          ? compact(active?.goal, "working")
          : ["ready", done > 0 ? `${done} done` : "", failed > 0 ? `${failed} retry` : ""].filter(Boolean).join(" - ");
        const reason = agent.availabilityReason && agent.availability !== "available"
          ? [`  ${compact(agent.availabilityReason, agent.availability)}`]
          : [];
        return [`${marker} @${agentHandle({ _id: agent.agentId, name: agent.name })}  ${agent.provider}`, `  ${status}`, ...reason];
      })),
    "",
    "inbox",
    attention > 0 ? `${attention} need you` : "nothing needs you",
    proposedPatches.length > 0 ? `▲ ${proposedPatches.length} patch${proposedPatches.length === 1 ? "" : "es"} to review` : "",
    failedRuns.length > 0 ? `✗ ${failedRuns.length} task${failedRuns.length === 1 ? "" : "s"} need retry` : "",
    failedRuns[0] ? `  latest ${compact(failedRuns[0].goal, shortId(failedRuns[0]._id))}` : "",
    "",
    "rooms",
    `● ${compact(currentRoom, "room")}`,
    `target ${selectedTarget}`,
    `${activeRuns.length} active tasks`,
  ].filter((line) => line !== "");
  return lines.slice(0, limit).map((line) => fitPlain(line, width));
}

function zipColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
  gap: string,
): string[] {
  const count = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let index = 0; index < count; index++) {
    rows.push(`${fitPlain(left[index] || "", leftWidth)}${gap}${fitPlain(right[index] || "", rightWidth)}`.trimEnd());
  }
  return rows;
}

function openTuiComposerSurfaceLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  width = 118,
): string[] {
  const isTask = isUiState(state) && state.mode === "task";
  const prompt = isUiState(state) ? state.taskInput : "";
  const inputLines = taskComposerLines(prompt, {
    width: Math.max(20, width - 4),
    cursor: isTask ? "_" : "",
    maxLines: isTask ? 4 : 1,
  }).map((line) => fitPlain(line, width));
  const suggestions = isTask ? openTuiTaskSuggestionLines(state, width, 5) : [];
  const attachments = isUiState(state) && state.attachments.length > 0
    ? [fitPlain(`attachments ${state.attachments.map((attachment, index) => `${index + 1}. ${attachmentLabel(attachment)}`).join("  ")}`, width)]
    : [];
  const hint = isTask && suggestions.length > 0
    ? "Tab complete  Up/Down choose  Enter run command  Esc cancel"
    : isTask
      ? "Enter send  Ctrl+J newline  Esc cancel  @file attach"
      : "t compose  / commands  Ctrl+P palette  Ctrl+F find  v task  c terminal  ? help  q quit";
  const top = `╭${"─".repeat(Math.max(0, width - 2))}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
  const promptPlaceholder = openTuiComposerPlaceholder(state);
  const promptLines = isTask && prompt.trim().length > 0 ? inputLines : [promptPlaceholder];

  return [
    fitPlain(top, width),
    ...attachments.map((line) => fitPlain(`│ ${line.trimEnd()}`, width - 1) + "│"),
    ...promptLines.map((line) => fitPlain(`│ ${line.trimEnd() || promptPlaceholder}`, width - 1) + "│"),
    ...suggestions.map((line) => fitPlain(`│ ${line.trimEnd()}`, width - 1) + "│"),
    fitPlain(bottom, width),
    fitPlain(hint, width),
  ];
}

function openTuiComposerPlaceholder(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string {
  if (!state.dashboard.config?.roomId || !state.dashboard.session) {
    return "> /login to enter the room…";
  }
  const selected = isUiState(state) ? selectedOpenTuiAgent(state) : state.dashboard.dashboard.agents[0];
  return selected ? `> Ask @${agentHandle(selected)} to work…` : "> Message the room…";
}

function openTuiTaskSuggestionLines(state: OpenTuiPreviewUiState, width: number, limit: number): string[] {
  const suggestions = openTuiTaskSuggestions(state, limit);
  if (suggestions.length === 0) return [];
  const selected = Math.min(Math.max(0, state.taskSuggestionSelected), suggestions.length - 1);
  return [
    fitPlain("commands", width),
    ...suggestions.map((suggestion, index) => {
      const marker = index === selected ? ">" : " ";
      return fitPlain(`${marker} ${suggestion.command.padEnd(17)} ${suggestion.detail}`, width);
    }),
  ];
}

function dashboardPaneLines(
  state: OpenTuiPreviewState | OpenTuiPreviewUiState,
  width?: number,
): string[] {
  const left = [
    "Room",
    ...roomLines(state.dashboard),
    "",
    "Services",
    ...serviceLines(state.dashboard),
  ];
  const right = [
    "Agents",
    ...agentLines(state.dashboard, isUiState(state) ? state.selectedAgentId : undefined),
    "",
    "Recent Runs",
    ...runLines(state.dashboard, isUiState(state) ? state.selectedRunId : undefined),
  ];
  const focus = isUiState(state)
    ? state.dashboardFocus === "agents"
      ? "Activity Pane [agents]"
      : "Activity Pane [runs]"
    : "Activity Pane";
  return twoColumnLines("Workspace Pane", left, focus, right, width);
}

function twoColumnLines(
  leftTitle: string,
  leftLines: string[],
  rightTitle: string,
  rightLines: string[],
  viewportWidth = 118,
): string[] {
  const gap = "  ";
  const usableWidth = Math.max(40, viewportWidth);
  const leftWidth = Math.max(18, Math.floor((usableWidth - gap.length) / 2));
  const rightWidth = Math.max(18, usableWidth - gap.length - leftWidth);
  const rows = [
    `${fitPlain(leftTitle, leftWidth)}${gap}${fitPlain(rightTitle, rightWidth)}`.trimEnd(),
  ];
  const count = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < count; index++) {
    rows.push(`${fitPlain(leftLines[index] || "", leftWidth)}${gap}${fitPlain(rightLines[index] || "", rightWidth)}`.trimEnd());
  }
  return rows;
}

function fitPlain(input: string, width: number): string {
  const inputLength = visibleLength(input);
  const text = inputLength > width ? input.slice(0, Math.max(0, width - 3)) + "..." : input;
  return text.padEnd(width);
}

function normalizeViewportSize(value?: number): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  return Math.max(1, Math.floor(value));
}

function openTuiTaskContextLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  const selectedAgent = isUiState(state)
    ? selectedOpenTuiAgent(state)
    : state.dashboard.dashboard.agents[0];
  return taskContextSummary({
    roomName: state.dashboard.config?.roomName,
    roomId: state.dashboard.config?.roomId,
    projectDir: state.args.dir,
    provider: state.dashboard.provider,
    model: isUiState(state) ? state.model : undefined,
    agentName: selectedAgent ? `${compact(selectedAgent.name, "agent")} ${shortId(selectedAgent._id)}` : undefined,
    workspace: state.workspace,
    safety: state.safety,
    attachments: isUiState(state) ? state.attachments : [],
    instructions: state.instructions,
    memory: state.memory,
  });
}

function reduceOpenTuiPaletteKey(state: OpenTuiPreviewUiState, sequence: string): OpenTuiPreviewKeyResult {
  if (sequence === "\u001b") {
    return {
      state: { ...state, mode: "dashboard", paletteInput: "", paletteSelected: 0, message: "Palette closed." },
      intent: { type: "none" },
    };
  }
  if (sequence === "\u0015") {
    return {
      state: { ...state, paletteInput: "", paletteSelected: 0 },
      intent: { type: "none" },
    };
  }
  if (sequence === "\u007f" || sequence === "\b") {
    return {
      state: { ...state, paletteInput: state.paletteInput.slice(0, -1), paletteSelected: 0 },
      intent: { type: "none" },
    };
  }
  if (sequence === "\u001b[B" || sequence === "\t" || sequence === "\u000e") {
    return {
      state: moveOpenTuiPaletteSelection(state, 1),
      intent: { type: "none" },
    };
  }
  if (sequence === "\u001b[A" || sequence === "\u001b[Z" || sequence === "\u0010") {
    return {
      state: moveOpenTuiPaletteSelection(state, -1),
      intent: { type: "none" },
    };
  }
  if (sequence === "\r") {
    return applyOpenTuiPaletteSelection(state);
  }
  if (isPrintableInput(sequence)) {
    return {
      state: { ...state, paletteInput: `${state.paletteInput}${sequence}`, paletteSelected: 0 },
      intent: { type: "none" },
    };
  }
  return { state, intent: { type: "none" } };
}

function moveOpenTuiPaletteSelection(state: OpenTuiPreviewUiState, direction: -1 | 1): OpenTuiPreviewUiState {
  const items = filteredOpenTuiPaletteItems(state);
  if (items.length === 0) return state;
  return {
    ...state,
    paletteSelected: (state.paletteSelected + direction + items.length) % items.length,
  };
}

function applyOpenTuiPaletteSelection(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  const items = filteredOpenTuiPaletteItems(state);
  const item = items[state.paletteSelected];
  if (!item) {
    return {
      state: { ...state, message: "No matching palette item." },
      intent: { type: "none" },
    };
  }

  const base: OpenTuiPreviewUiState = {
    ...state,
    mode: "dashboard",
    paletteInput: "",
    paletteSelected: 0,
  };

  if (!item.enabled) {
    const message = openTuiDisabledPaletteMessage(base, item);
    return {
      state: {
        ...base,
        message,
        feed: appendOpenTuiFeed(base.feed, "warning", message),
      },
      intent: { type: "none" },
    };
  }

  if (item.kind === "action") {
    if (item.actionId === "task") {
      return {
        state: { ...base, mode: "task", message: "Task composer active." },
        intent: { type: "none" },
      };
    }
    if (item.actionId === "join") {
      return beginOpenTuiTerminalConnection(base);
    }
    if (item.actionId === "login") {
      return beginOpenTuiLogin(base);
    }
    if (item.actionId === "init") {
      return beginOpenTuiInit(base);
    }
    if (item.actionId === "help") {
      return openOpenTuiKeyboardHelp(base, "dashboard");
    }
    if (item.actionId === "run") {
      const runId = base.selectedRunId || base.dashboard.dashboard.runs[0]?._id;
      if (!runId) {
        return {
          state: { ...base, message: "No task available to inspect." },
          intent: { type: "none" },
        };
      }
      return beginOpenTuiRunDetail(base, runId);
    }
    if (item.actionId === "rooms") {
      return applyOpenTuiRoomsCommand(base);
    }
    if (item.actionId === "open") {
      return applyOpenTuiOpenCommand(base);
    }
    if (item.actionId === "quit") return { state: base, intent: { type: "quit" } };
    const message = openTuiUnsupportedPaletteItemMessage(item);
    return {
      state: {
        ...base,
        message,
        feed: appendOpenTuiFeed(base.feed, "warning", message),
      },
      intent: { type: "none" },
    };
  }

  if (item.kind === "provider" && item.provider) {
    return {
      state: {
        ...base,
        dashboard: { ...base.dashboard, provider: item.provider },
        message: `Provider selected: ${item.provider}`,
        feed: appendOpenTuiFeed(base.feed, "info", `Provider selected: ${item.provider}`),
      },
      intent: { type: "none" },
    };
  }

  if (item.kind === "agent" && item.agentId) {
    return {
      state: {
        ...base,
        selectedAgentId: item.agentId,
        message: `Agent selected: ${item.label}`,
        feed: appendOpenTuiFeed(base.feed, "info", `Agent selected: ${item.label}`),
      },
      intent: { type: "none" },
    };
  }

  if (item.kind === "run" && item.runId) {
    return beginOpenTuiRunDetail(base, item.runId, `Task selected: ${shortId(item.runId)} ${item.label}`);
  }

  if (item.kind === "slash" && item.command) {
    return {
      state: {
        ...base,
        mode: "task",
        taskInput: `${item.command} `,
        taskCursor: item.command.length + 1,
        taskSuggestionSelected: 0,
        message: `Slash command selected: ${item.command}`,
      },
      intent: { type: "none" },
    };
  }

  if (item.kind === "room" && item.roomId) {
    return {
      state: {
        ...base,
        message: `Switching room to ${item.label}...`,
      },
      intent: { type: "select-room", roomId: item.roomId, roomName: item.label },
    };
  }

  if (item.kind === "file" && item.filePath) {
    const result = addAttachment(base.attachments, item.filePath, { projectDir: base.args.dir });
    return {
      state: {
        ...base,
        attachments: result.attachments,
        message: result.message,
        feed: appendOpenTuiFeed(base.feed, result.ok ? "info" : "warning", result.message),
      },
      intent: { type: "none" },
    };
  }

  const message = openTuiUnsupportedPaletteItemMessage(item);
  return {
    state: {
      ...base,
      message,
      feed: appendOpenTuiFeed(base.feed, "warning", message),
    },
    intent: { type: "none" },
  };
}

function openTuiUnsupportedPaletteItemMessage(item: PaletteItem): string {
  if (item.kind === "action") {
    return `${item.label} is unavailable in this terminal context.`;
  }
  return `Palette item is unavailable: ${item.label}.`;
}

function openTuiDisabledPaletteMessage(state: OpenTuiPreviewUiState, item: PaletteItem): string {
  const action = item.actionId;
  if (action === "task") {
    if (!state.dashboard.config?.roomId) return "Run an agent task is unavailable: no room configured.";
    if (!state.dashboard.session) return "Run an agent task is unavailable: login required.";
    if (state.taskRunning) return "Run an agent task is unavailable: another task is already running.";
  }
  if (action === "join") {
    return "Shared terminal is unavailable: no room configured.";
  }
  if (action === "init") {
    return "Initialize project room is unavailable: login required.";
  }
  if (action === "rooms") {
    return "List rooms is unavailable: login required.";
  }
  if (action === "run") {
    if (!state.dashboard.config?.roomId) return "Inspect latest task is unavailable: no room configured.";
    if (!state.dashboard.session) return "Inspect latest task is unavailable: login required.";
    return "Inspect latest task is unavailable: no recent work.";
  }
  if (action === "open") {
    return "Open browser workspace is unavailable: no room configured.";
  }
  return `${item.label} is unavailable.`;
}

function applyOpenTuiSlashCommand(state: OpenTuiPreviewUiState, input: string): OpenTuiPreviewKeyResult {
  const { command, args } = parseSlashCommand(input);
  const base: OpenTuiPreviewUiState = { ...state, mode: "dashboard", taskInput: "", taskSuggestionSelected: 0 };
  const argText = args.join(" ");

  if (command === "" || command === "help") {
    // Help is an overlay, not a feed line — feed lines are invisible once the
    // conversation has content, and a one-line command dump teaches nothing.
    return openOpenTuiKeyboardHelp(base, base.mode === "run" || base.mode === "workspace" ? base.mode : "task");
  }
  if (command === "clear") {
    return {
      state: {
        ...base,
        feed: appendOpenTuiFeed([], "info", "Feed cleared."),
        message: "Feed cleared.",
      },
      intent: { type: "none" },
    };
  }
  if (command === "quit" || command === "q") {
    return { state: base, intent: { type: "quit" } };
  }
  if (command === "login") {
    return beginOpenTuiLogin(base);
  }
  if (command === "init") {
    return beginOpenTuiInit(base);
  }
  if (command === "undo" || command === "rewind") {
    return applyOpenTuiUndo(base);
  }
  if (command === "runs") {
    return applyOpenTuiRunsCommand(base);
  }
  if (command === "history") {
    return applyOpenTuiHistoryCommand(base, argText);
  }
  if (command === "find" || command === "feed" || command === "scrollback") {
    const result = searchTuiScrollback({
      feed: base.feed,
      terminalLines: base.terminalLines,
      query: argText,
      limit: 30,
    });
    return {
      state: {
        ...base,
        message: result.error
          ? "Search needs a query."
          : result.matches.length > 0
            ? `Found ${result.matches.length} feed/terminal matches.`
            : "No feed or terminal matches.",
        feed: appendOpenTuiFeed(base.feed, result.error || result.matches.length === 0 ? "warning" : "info", formatTuiScrollbackSearch(result)),
      },
      intent: { type: "none" },
    };
  }
  if (command === "use-history" || command === "hist") {
    return applyOpenTuiUseHistoryCommand(base, argText);
  }
  if (command === "again" || command === "rerun-history") {
    return beginOpenTuiHistoryRun(base, argText, input);
  }
  if (command === "task") {
    return beginOpenTuiTaskSubmit(base, argText, input);
  }
  if (command === "health") {
    return {
      state: {
        ...base,
        message: "Health listed in the feed.",
        feed: appendOpenTuiFeed(base.feed, "info", ["Health:", ...serviceLines(base.dashboard)].join("\n")),
      },
      intent: { type: "none" },
    };
  }
  if (command === "doctor") {
    const report = buildDoctorReport({
      projectDir: base.args.dir,
      server: base.args.server,
      session: base.dashboard.session,
      projectConfig: base.dashboard.config,
      projectState: {
        selectedRoomId: base.dashboard.config?.roomId,
        selectedRoomName: base.dashboard.config?.roomName,
      },
    });
    return {
      state: {
        ...base,
        message: report.strictReady ? "Doctor ready." : "Doctor found readiness blockers.",
        feed: appendOpenTuiFeed(base.feed, "info", formatDoctorReport(report)),
      },
      intent: { type: "none" },
    };
  }
  if (command === "qa" || command === "tui-qa" || command === "live-qa") {
    const resolution = resolveTuiQaSlashCommand(command, args);
    if (resolution.error) {
      return {
        state: {
          ...base,
          message: "TUI QA command rejected.",
          feed: appendOpenTuiFeed(base.feed, "warning", resolution.error),
        },
        intent: { type: "none" },
      };
    }
    if (resolution.live) {
      return {
        state: {
          ...base,
          message: "Running live TUI QA preflight...",
          feed: appendOpenTuiFeed(base.feed, "info", "Running live TUI QA preflight."),
        },
        intent: {
          type: "live-qa",
          roomId: resolution.roomId || base.dashboard.config?.roomId,
          includeTerminal: resolution.includeTerminal,
          bridgeUrl: resolution.bridgeUrl,
        },
      };
    }
    const report = buildTuiQaReport();
    return {
      state: {
        ...base,
        message: report.ok ? "TUI QA passed." : "TUI QA failed.",
        feed: appendOpenTuiFeed(base.feed, report.ok ? "success" : "error", formatTuiQaReport(report)),
      },
      intent: { type: "none" },
    };
  }
  if (isOpenTuiRuntimeCommand(command)) {
    return beginOpenTuiRuntimeCommand(base, command, args, input);
  }
  if (command === "rooms") {
    return applyOpenTuiRoomsCommand(base);
  }
  if (command === "pins") {
    return applyOpenTuiPinsCommand(base);
  }
  if (command === "pin") {
    return applyOpenTuiPinCommand(base, args);
  }
  if (command === "unpin") {
    return applyOpenTuiUnpinCommand(base, args);
  }
  if (command === "room") {
    return applyOpenTuiRoomCommand(base, argText);
  }
  if (command === "open" || command === "browser") {
    return applyOpenTuiOpenCommand(base);
  }
  if (command === "attach") {
    return applyOpenTuiAttachment(base, argText);
  }
  if (command === "attach-image" || command === "image" || command === "screenshot") {
    return applyOpenTuiAttachment(base, argText, "image");
  }
  if (command === "detach" || command === "unattach") {
    const result = removeAttachment(base.attachments, argText);
    const next = result.ok ? rememberOpenTuiUndo(base, "detach") : base;
    return {
      state: {
        ...next,
        attachments: result.attachments,
        message: result.message,
        feed: appendOpenTuiFeed(next.feed, result.ok ? "info" : "warning", result.message),
      },
      intent: { type: "none" },
    };
  }
  if (command === "attachments" || command === "attached") {
    const summary = [
      attachmentSummary(base.attachments),
      ...attachmentTransportSummary(base.attachments, base.dashboard.provider, base.args.dir).lines,
    ].join("\n");
    return {
      state: {
        ...base,
        message: base.attachments.length > 0 ? `${base.attachments.length} files attached.` : "No attached files.",
        feed: appendOpenTuiFeed(base.feed, "info", summary),
      },
      intent: { type: "none" },
    };
  }
  if (command === "provider") {
    const provider = args[0];
    if (provider && TUI_PROVIDERS.includes(provider)) {
      const withUndo = rememberOpenTuiUndo(base, "provider");
      return {
        state: {
          ...withUndo,
          dashboard: { ...withUndo.dashboard, provider },
          message: `Provider selected: ${provider}`,
          feed: appendOpenTuiFeed(withUndo.feed, "info", `Provider selected: ${provider}`),
        },
        intent: { type: "none" },
      };
    }
    return {
      state: {
        ...base,
        message: `Providers: ${TUI_PROVIDERS.join(", ")}`,
        feed: appendOpenTuiFeed(base.feed, "info", `Providers: ${TUI_PROVIDERS.join(", ")}`),
      },
      intent: { type: "none" },
    };
  }
  if (command === "model") {
    const result = resolveModelCommand({
      current: { provider: base.dashboard.provider, model: base.model },
      requested: argText,
    });
    if (!result.ok) {
      return {
        state: {
          ...base,
          model: result.state.model,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    const withUndo = rememberOpenTuiUndo(base, "model");
    return {
      state: {
        ...withUndo,
        model: result.state.model,
        message: result.message,
        feed: appendOpenTuiFeed(withUndo.feed, "info", result.message),
      },
      intent: { type: "none" },
    };
  }
  if (command === "safety") {
    return applyOpenTuiSafetyCommand(base, args);
  }
  if (command === "context") {
    return applyOpenTuiContextCommand(base);
  }
  if (command === "git" || command === "workspace") {
    return applyOpenTuiWorkspaceCommand(base);
  }
  if (command === "diff" || command === "changes") {
    const path = argText.trim();
    return {
      state: {
        ...base,
        message: path ? `Loading diff for ${path}...` : "Loading workspace diff...",
        feed: appendOpenTuiFeed(base.feed, "info", path ? `Loading diff: ${path}` : "Loading workspace diff."),
      },
      intent: { type: "workspace-diff", path: path || undefined },
    };
  }
  if (command === "view" || command === "peek" || command === "cat") {
    const result = loadWorkspaceFilePreview({
      dir: base.args.dir,
      ref: argText,
      contextLines: 8,
    });
    return {
      state: {
        ...base,
        message: result.error ? "File preview unavailable." : `Previewing ${result.path}:${result.requestedLine || 1}.`,
        feed: appendOpenTuiFeed(base.feed, result.error ? "warning" : "info", formatWorkspaceFilePreview(result)),
      },
      intent: { type: "none" },
    };
  }
  if (command === "files" || command === "file") {
    return applyOpenTuiFilesCommand(base, argText);
  }
  if (command === "search" || command === "rg") {
    const query = argText.trim();
    if (!query) {
      return {
        state: {
          ...base,
          message: "Search needs a query.",
          feed: appendOpenTuiFeed(base.feed, "warning", "Usage: /search <query>"),
        },
        intent: { type: "none" },
      };
    }
    return {
      state: {
        ...base,
        message: `Searching workspace for ${query}...`,
        feed: appendOpenTuiFeed(base.feed, "info", `Searching workspace: ${query}`),
      },
      intent: { type: "search-workspace", query },
    };
  }
  if (command === "instructions" || command === "instruction") {
    return applyOpenTuiInstructionsCommand(base, args);
  }
  if (command === "memory" || command === "memories") {
    return applyOpenTuiMemoryCommand(base, args);
  }
  if (command === "agent-add" || command === "add-agent") {
    const name = args[0];
    if (!name) {
      return { state: { ...base, message: "Usage: /agent-add <name> [provider] [model]" }, intent: { type: "none" } };
    }
    return {
      state: { ...base, message: `Adding agent ${name}…` },
      intent: { type: "agent-add", name, provider: args[1], model: args[2] },
    };
  }
  if (command === "agent" || command === "agents") {
    if (argText) {
      const agent = base.dashboard.dashboard.agents.find((candidate) => {
        const haystack = `${candidate._id} ${candidate.name || ""}`.toLowerCase();
        return haystack.includes(argText.toLowerCase());
      });
      if (agent) {
        const label = compact(agent.name, shortId(agent._id));
        return {
          state: {
            ...base,
            selectedAgentId: agent._id,
            message: `Agent selected: ${label}`,
            feed: appendOpenTuiFeed(base.feed, "info", `Agent selected: ${label}`),
          },
          intent: { type: "none" },
        };
      }
      return {
        state: { ...base, message: `Agent not found: ${argText}` },
        intent: { type: "none" },
      };
    }
    const lines = base.dashboard.dashboard.agents.length > 0
      ? base.dashboard.dashboard.agents.map((agent) => `${compact(agent.name, "agent")} ${shortId(agent._id)} ${compact(agent.provider)}`).join("\n")
      : "No agents in this room.";
    return {
      state: {
        ...base,
        message: "Agents listed in the feed.",
        feed: appendOpenTuiFeed(base.feed, "info", lines),
      },
      intent: { type: "none" },
    };
  }
  if (command === "run") {
    const runId = args[0]
      ? base.dashboard.dashboard.runs.find((run, index) =>
        run._id === args[0] || run._id.endsWith(args[0]) || String(index + 1) === args[0]
      )?._id
      : base.dashboard.dashboard.runs[0]?._id;
    if (!runId) return { state: { ...base, message: "No matching run loaded." }, intent: { type: "none" } };
    return beginOpenTuiRunDetail(base, runId);
  }
  if (command === "sessions") {
    return applyOpenTuiProviderSessionsCommand(base, argText);
  }
  if (command === "session") {
    return beginOpenTuiProviderSessionDetail(base, argText);
  }
  if (command === "terminal" || command === "reconnect") {
    return beginOpenTuiTerminalConnection(base);
  }
  if (command === "fanout" || command === "fan-out") {
    const result = resolveFanoutCommand({
      agents: base.dashboard.dashboard.agents,
      args,
      providerAvailability: base.dashboard.providerAvailability,
    });
    if (!result.ok) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return beginOpenTuiRunnableIntent(base, {
      title: "Run fan-out task?",
      detail: `Auto-run is off. Approve fan-out to ${result.targets.length} agents: ${previewText(result.goal, "(no prompt)")}`,
      confirmLabel: "Run fan-out",
      runningMessage: `Fan-out running for ${result.targets.length} agents...`,
      feedKind: "info",
      feedMessage: result.message,
      returnMode: "task",
      returnTaskInput: input,
      intent: { type: "fanout", goal: result.goal, targets: result.targets },
    });
  }
  if (command === "handoff-target" || command === "handoff-agent" || command === "target-agent") {
    return applyOpenTuiHandoffTargetCommand(base, argText);
  }
  if (command === "handoff") {
    const result = resolveHandoffCommand({
      runs: base.selectedRunDetail?.allRuns || base.dashboard.dashboard.runs,
      agents: base.dashboard.dashboard.agents,
      args,
      currentRunId: base.selectedRunDetail?.run._id || base.selectedRunId,
      lastRunId: base.selectedRunId,
    });
    if (!result.ok) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return beginOpenTuiRunnableIntent(base, {
      title: "Run handoff?",
      detail: `Auto-run is off. Approve handoff ${shortId(result.sourceRunId)} to ${result.targetName}: ${previewText(result.context, "(no context)")}`,
      confirmLabel: "Run handoff",
      runningMessage: `Handing off to ${result.targetName}...`,
      feedKind: "info",
      feedMessage: `Handing off ${shortId(result.sourceRunId)} to ${result.targetName}: ${result.context}`,
      returnMode: "task",
      returnTaskInput: input,
      intent: { type: "handoff", resolution: result },
    });
  }
  if (command === "agent-start" || command === "start-agent") {
    const result = resolveAgentStartCommand({
      agents: base.dashboard.dashboard.agents,
      args,
      providerAvailability: base.dashboard.providerAvailability,
    });
    if (!result.ok || !result.agentId || !result.agentName || !result.provider || !result.goal) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return beginOpenTuiRunnableIntent(base, {
      title: "Start agent task?",
      detail: `Auto-run is off. Approve ${result.agentName}: ${previewText(result.goal, "(no prompt)")}`,
      confirmLabel: "Start agent",
      runningMessage: `Starting ${result.agentName}...`,
      feedKind: "info",
      feedMessage: result.message,
      returnMode: "task",
      returnTaskInput: input,
      intent: { type: "agent-start", goal: result.goal, provider: result.provider, agentId: result.agentId },
    });
  }
  if (command === "agent-stop" || command === "stop-agent") {
    const result = resolveAgentStopCommand({
      agents: base.dashboard.dashboard.agents,
      runs: base.dashboard.dashboard.runs,
      args,
    });
    if (!result.ok || !result.agentId || !result.agentName) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return beginOpenTuiApprovedIntent(base, {
      safetyAction: "destructive",
      title: "Stop active agent tasks?",
      detail: `${result.agentName} has ${result.runIds.length} queued or running task${result.runIds.length === 1 ? "" : "s"} that will be marked cancelled.`,
      confirmLabel: "Stop agent tasks",
      runningMessage: result.message,
      feedKind: "warning",
      feedMessage: result.message,
      returnMode: "dashboard",
      returnTaskInput: input,
      intent: { type: "agent-stop", agentId: result.agentId, agentName: result.agentName, runIds: result.runIds },
    });
  }
  if (command === "agent-pause" || command === "pause-agent") {
    const result = resolveAgentPauseCommand({
      agents: base.dashboard.dashboard.agents,
      runs: base.dashboard.dashboard.runs,
      args,
    });
    if (!result.ok || !result.agentId || !result.agentName) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return beginOpenTuiApprovedIntent(base, {
      safetyAction: "destructive",
      title: "Pause active agent tasks?",
      detail: `${result.agentName} has ${result.runIds.length} queued or running local bridge task${result.runIds.length === 1 ? "" : "s"} that will be marked paused.`,
      confirmLabel: "Pause agent tasks",
      runningMessage: result.message,
      feedKind: "warning",
      feedMessage: result.message,
      returnMode: "dashboard",
      returnTaskInput: input,
      intent: { type: "agent-pause", agentId: result.agentId, agentName: result.agentName, runIds: result.runIds },
    });
  }
  if (command === "agent-resume" || command === "resume-agent") {
    const result = resolveAgentResumeCommand({
      agents: base.dashboard.dashboard.agents,
      runs: base.dashboard.dashboard.runs,
      args,
    });
    if (!result.ok || !result.agentId || !result.agentName) {
      return {
        state: {
          ...base,
          message: result.message,
          feed: appendOpenTuiFeed(base.feed, "warning", result.message),
        },
        intent: { type: "none" },
      };
    }
    return {
      state: {
        ...base,
        message: result.message,
        feed: appendOpenTuiFeed(base.feed, "info", result.message),
      },
      intent: { type: "agent-resume", agentId: result.agentId, agentName: result.agentName, runIds: result.runIds },
    };
  }
  if (command === "continue") {
    return beginOpenTuiContinueRun(base, args, input);
  }
  if (command === "resume") {
    return beginOpenTuiResumeRun(base, args, input);
  }
  if (command === "fork") {
    return beginOpenTuiForkRun(base, args, input);
  }
  if (command === "rerun") {
    return beginOpenTuiRerunRun(base, args[0], input);
  }
  if (command === "retry") {
    return beginOpenTuiRunRetry(base, args[0], input);
  }
  if (command === "work") {
    return beginOpenTuiWorkCommand(base, input);
  }
  if (command === "dismiss") {
    return dismissOpenTuiFailure(base, args[0]);
  }
  if (command === "stop" || command === "cancel") {
    return beginOpenTuiRunStop(base, args[0]);
  }
  if (command === "copy" || command === "yank") {
    const first = args[0]?.toLowerCase();
    const kind = openTuiRunCopyKind(first) || "summary";
    const runRef = openTuiRunCopyKind(first) ? args[1] : args[0];
    return beginOpenTuiRunCopy(base, kind, runRef);
  }
  if (command === "export" || command === "summary") {
    const [runRef, outputPath] = openTuiRunExportArgs(base, args);
    return beginOpenTuiRunExport(base, runRef, outputPath);
  }
  if (command === "goto" || command === "definition" || command === "def") {
    const query = args.join(" ").trim();
    if (!query) {
      return {
        state: {
          ...base,
          message: "Usage: /goto <symbol>",
          feed: appendOpenTuiFeed(base.feed, "warning", "Usage: /goto <symbol>"),
        },
        intent: { type: "none" },
      };
    }
    return {
      state: {
        ...base,
        message: `Finding symbol ${query}...`,
        feed: appendOpenTuiFeed(base.feed, "info", `Finding symbol: ${query}`),
      },
      intent: { type: "goto-symbol", query },
    };
  }
  if (command === "symbols" || command === "symbol" || command === "sym") {
    const query = args.join(" ").trim();
    return {
      state: {
        ...base,
        message: query ? `Scanning symbols for ${query}...` : "Scanning workspace symbols...",
        feed: appendOpenTuiFeed(base.feed, "info", query ? `Scanning symbols: ${query}` : "Scanning workspace symbols."),
      },
      intent: { type: "list-symbols", query },
    };
  }
  if (command === "rename-preview" || command === "rename" || command === "rename-apply") {
    const [oldName = "", newName = ""] = args;
    if (!oldName || !newName) {
      const usage = command === "rename-preview"
        ? "Usage: /rename-preview <symbol> <new-name>"
        : "Usage: /rename <symbol> <new-name>";
      return {
        state: {
          ...base,
          message: usage,
          feed: appendOpenTuiFeed(base.feed, "warning", usage),
        },
        intent: { type: "none" },
      };
    }
    if (command === "rename" || command === "rename-apply") {
      return beginOpenTuiApprovedIntent(base, {
        safetyAction: "file-edit",
        title: `Apply rename ${oldName} -> ${newName}?`,
        detail: "This changes files on disk from the OpenTUI renderer.",
        confirmLabel: "Apply rename",
        runningMessage: `Applying rename ${oldName} -> ${newName}...`,
        feedKind: "warning",
        feedMessage: `Applying rename ${oldName} -> ${newName}`,
        returnMode: "dashboard",
        returnTaskInput: input,
        intent: { type: "rename-apply", oldName, newName },
      });
    }
    return {
      state: {
        ...base,
        message: `Previewing rename ${oldName} -> ${newName}...`,
        feed: appendOpenTuiFeed(base.feed, "info", `Previewing rename ${oldName} -> ${newName}`),
      },
      intent: { type: "rename-preview", oldName, newName },
    };
  }
  if (command === "diagnostics" || command === "diag" || command === "typecheck") {
    const project = args.join(" ").trim();
    const label = diagnosticsRequestLabel(project);
    return {
      state: {
        ...base,
        message: `Running ${label}...`,
        feed: appendOpenTuiFeed(base.feed, "info", `Running ${label}.`),
      },
      intent: { type: "diagnostics", project: project || undefined },
    };
  }

  const message = `Unknown command: /${command} — ⌃P lists everything, /help shows the keys.`;
  return {
    state: {
      ...base,
      message,
      feed: appendOpenTuiFeed(base.feed, "warning", message),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiAttachment(
  state: OpenTuiPreviewUiState,
  path: string,
  kind?: TuiAttachmentKind,
): OpenTuiPreviewKeyResult {
  const result = addAttachment(state.attachments, path, { kind, projectDir: state.args.dir });
  const next = result.ok ? rememberOpenTuiUndo(state, kind === "image" ? "attach image" : "attach") : state;
  return {
    state: {
      ...next,
      attachments: result.attachments,
      message: result.message,
      feed: appendOpenTuiFeed(next.feed, result.ok ? "info" : "warning", result.message),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiHistoryCommand(state: OpenTuiPreviewUiState, query: string): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      message: query.trim() ? "Task history filtered." : "Task history listed.",
      feed: appendOpenTuiFeed(
        state.feed,
        state.taskHistory.length > 0 ? "info" : "warning",
        formatTaskHistory(state.taskHistory, query),
      ),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiUseHistoryCommand(state: OpenTuiPreviewUiState, ref: string): OpenTuiPreviewKeyResult {
  const result = resolveTaskHistoryItem(state.taskHistory, ref);
  if (!result.ok || !result.goal) {
    return {
      state: {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "warning", result.message),
      },
      intent: { type: "none" },
    };
  }
  return {
    state: {
      ...state,
      mode: "task",
      taskInput: result.goal,
      taskCursor: result.goal.length,
      message: "Task history item loaded. Edit or press Enter to run.",
      feed: appendOpenTuiFeed(state.feed, "info", result.message),
    },
    intent: { type: "none" },
  };
}

function beginOpenTuiHistoryRun(
  state: OpenTuiPreviewUiState,
  ref: string,
  input: string,
): OpenTuiPreviewKeyResult {
  const result = resolveTaskHistoryItem(state.taskHistory, ref);
  if (!result.ok || !result.goal) {
    return {
      state: {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "warning", result.message),
      },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiRunnableIntent(state, {
    title: "Rerun task history item?",
    detail: `Auto-run is off. Approve task history item ${result.index}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Rerun task",
    runningMessage: `Rerunning task history item ${result.index}...`,
    feedKind: "info",
    feedMessage: `Rerunning task history item ${result.index}: ${result.goal}`,
    returnMode: "task",
    returnTaskInput: input,
    intent: { type: "submit", goal: result.goal },
  });
}

function openTuiProviderSessionRows(state: OpenTuiPreviewUiState) {
  return collectProviderSessions({
    runs: state.selectedRunDetail?.allRuns || state.dashboard.dashboard.runs,
    agents: state.dashboard.dashboard.agents,
  });
}

function applyOpenTuiProviderSessionsCommand(state: OpenTuiPreviewUiState, query: string): OpenTuiPreviewKeyResult {
  const rows = openTuiProviderSessionRows(state);
  return {
    state: {
      ...state,
      message: query.trim() ? "Provider sessions filtered." : "Provider sessions listed.",
      feed: appendOpenTuiFeed(state.feed, rows.length > 0 ? "info" : "warning", formatProviderSessions(rows, query)),
    },
    intent: { type: "none" },
  };
}

function beginOpenTuiProviderSessionDetail(state: OpenTuiPreviewUiState, ref: string): OpenTuiPreviewKeyResult {
  const result = resolveProviderSession(openTuiProviderSessionRows(state), ref);
  if (!result.ok || !result.row) {
    return {
      state: {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "warning", result.message),
      },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiRunDetail(state, result.row.runId, result.message);
}

function beginOpenTuiRuntimeCommand(
  state: OpenTuiPreviewUiState,
  command: string,
  args: string[],
  input: string,
): OpenTuiPreviewKeyResult {
  if (!state.dashboard.config?.roomId) {
    return {
      state: {
        ...state,
        message: "No room configured. Initialize this directory first.",
        feed: appendOpenTuiFeed(state.feed, "warning", "No room configured. Initialize this directory first."),
      },
      intent: { type: "none" },
    };
  }

  const result = resolveEnvCommand(command, args);
  if (!result.ok || !result.action) {
    return {
      state: {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "warning", result.message),
      },
      intent: { type: "none" },
    };
  }

  return beginOpenTuiApprovedIntent(state, {
    safetyAction: result.action === "start" || result.action === "stop" ? "destructive" : "network",
    title: openTuiRuntimeTitle(result.action),
    detail: openTuiRuntimeDetail(result.action, result.ttlSeconds),
    confirmLabel: openTuiRuntimeConfirmLabel(result.action),
    runningMessage: openTuiRuntimeRunningMessage(result.action),
    feedKind: result.action === "stop" ? "warning" : "info",
    feedMessage: result.message,
    returnMode: "dashboard",
    returnTaskInput: input,
    intent: {
      type: "runtime-action",
      action: result.action,
      ttlSeconds: result.ttlSeconds,
    },
  });
}

function isOpenTuiRuntimeCommand(command: string): boolean {
  return (
    command === "env" ||
    command === "runtime" ||
    command === "env-status" ||
    command === "runtime-status" ||
    command === "status-env" ||
    command === "status-runtime" ||
    command === "env-start" ||
    command === "runtime-start" ||
    command === "start-env" ||
    command === "start-runtime" ||
    command === "env-stop" ||
    command === "runtime-stop" ||
    command === "stop-env" ||
    command === "stop-runtime" ||
    command === "env-touch" ||
    command === "runtime-touch" ||
    command === "touch-env" ||
    command === "touch-runtime"
  );
}

function openTuiRuntimeTitle(action: TuiEnvAction): string {
  if (action === "status") return "Check runtime status?";
  if (action === "start") return "Start hosted runtime?";
  if (action === "stop") return "Stop hosted runtime?";
  return "Touch hosted runtime?";
}

function openTuiRuntimeDetail(action: TuiEnvAction, ttlSeconds?: number): string {
  if (action === "status") return "This reads the room runtime state from the server.";
  if (action === "start") {
    return ttlSeconds
      ? `This starts or extends the hosted room runtime for ${ttlSeconds}s.`
      : "This starts or extends the hosted room runtime using the server default TTL.";
  }
  if (action === "stop") return "This stops the hosted room runtime for the current room.";
  return "This refreshes the hosted room runtime lease for the current room.";
}

function openTuiRuntimeConfirmLabel(action: TuiEnvAction): string {
  if (action === "status") return "Check runtime";
  if (action === "start") return "Start runtime";
  if (action === "stop") return "Stop runtime";
  return "Touch runtime";
}

function openTuiRuntimeRunningMessage(action: TuiEnvAction): string {
  if (action === "status") return "Loading runtime status...";
  if (action === "start") return "Starting runtime...";
  if (action === "stop") return "Stopping runtime...";
  return "Touching runtime...";
}

function applyOpenTuiSafetyCommand(state: OpenTuiPreviewUiState, args: string[]): OpenTuiPreviewKeyResult {
  const action = args[0]?.toLowerCase();
  if (action === "audit") {
    const audit = state.safety.audit.slice(-10);
    const lines = audit.length > 0
      ? audit.map((entry) => `${entry.decision.padEnd(7)} ${entry.action}: ${entry.reason}`)
      : ["No safety audit entries yet."];
    return {
      state: {
        ...state,
        message: "Safety audit listed in feed.",
        feed: appendOpenTuiFeed(state.feed, "info", lines.join("\n")),
      },
      intent: { type: "none" },
    };
  }

  if (action === "toggle") {
    const target = args.slice(1).join(" ");
    const result = toggleSafety(state.safety, target);
    const next = result.ok ? rememberOpenTuiUndo(state, "safety") : state;
    return {
      state: {
        ...next,
        safety: result.state,
        message: result.message,
        feed: appendOpenTuiFeed(next.feed, result.ok ? "info" : "warning", result.message),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      message: "Safety status listed in feed.",
      feed: appendOpenTuiFeed(state.feed, "info", safetyLines(state.safety, state.dashboard.provider).join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiContextCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      message: "Task context listed.",
      feed: appendOpenTuiFeed(state.feed, "info", openTuiTaskContextLines(state).join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiWorkspaceCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  if (!state.workspace.isGitRepo) {
    return {
      state: {
        ...state,
        message: "No git repository detected.",
        feed: appendOpenTuiFeed(state.feed, "info", "No git repository detected."),
      },
      intent: { type: "none" },
    };
  }

  const lines = [
    `branch ${compact(state.workspace.branch, "detached")}`,
    `state ${state.workspace.dirty ? "dirty" : "clean"} (${state.workspace.changedFiles.length} files, +${state.workspace.insertions}/-${state.workspace.deletions})`,
    `sync ${state.workspace.ahead} ahead, ${state.workspace.behind} behind`,
    `changes staged ${state.workspace.stagedCount}, unstaged ${state.workspace.unstagedCount}, untracked ${state.workspace.untrackedCount}`,
    ...state.workspace.changedFiles.slice(0, 20).map((file) => `${file.status.padEnd(2)} ${file.path}`),
  ];
  if (state.workspace.changedFiles.length > 20) {
    lines.push(`... ${state.workspace.changedFiles.length - 20} more`);
  }

  return {
    state: {
      ...state,
      message: "Workspace status listed.",
      feed: appendOpenTuiFeed(state.feed, "info", lines.join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiFilesCommand(state: OpenTuiPreviewUiState, query: string): OpenTuiPreviewKeyResult {
  const normalized = query.trim().toLowerCase();
  const files = state.workspaceFiles
    .filter((file) => !normalized || file.toLowerCase().includes(normalized))
    .slice(0, 30);

  if (files.length === 0) {
    const message = normalized ? `No files matched ${query}.` : "No workspace files found.";
    return {
      state: {
        ...state,
        message: "No files found.",
        feed: appendOpenTuiFeed(state.feed, "info", message),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      message: `Listed ${files.length} files.`,
      feed: appendOpenTuiFeed(state.feed, "info", [
        normalized ? `Files matching ${query}:` : "Workspace files:",
        "Use /attach <path> to include a file in the next task.",
        ...files,
      ].join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiRunsCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  const runs = state.dashboard.dashboard.runs.slice(0, 12);
  const lines = runs.length > 0
    ? runs.map((run, index) =>
      `${String(index + 1).padStart(2, "0")} ${compact(run.status, "unknown")} ${shortId(run._id)} ${compact(run.goal, "(no goal)")}`
    )
    : ["No recent work loaded."];
  return {
    state: {
      ...state,
      message: runs.length > 0 ? "Recent work listed in the feed." : "No recent work loaded.",
      feed: appendOpenTuiFeed(state.feed, "info", ["Recent work:", ...lines].join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiRoomsCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  const rooms = knownOpenTuiRooms(state);
  const lines = rooms.length > 0
    ? rooms.slice(0, 20).map((room, index) => {
      const current = state.dashboard.config?.roomId === room.roomId ? "*" : " ";
      const status = compact(room.status, "room");
      const agents = room.agentCount === undefined ? "?" : String(room.agentCount);
      const members = room.memberCount === undefined ? "?" : String(room.memberCount);
      return `${current} ${String(index + 1).padStart(2, "0")} ${compact(room.roomName, room.roomId)} ${status} ${room.roomId} agents:${agents} members:${members}`;
    })
    : [state.dashboard.session ? "No rooms loaded." : "Login to load rooms."];

  return {
    state: {
      ...state,
      message: rooms.length > 0 ? "Rooms listed in the feed. Use /room <name|id|index> to switch." : lines[0],
      feed: appendOpenTuiFeed(state.feed, rooms.length > 0 ? "info" : "warning", ["Rooms:", ...lines].join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiOpenCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  if (!state.dashboard.config?.roomId) {
    return {
      state: {
        ...state,
        message: "No room configured to open.",
        feed: appendOpenTuiFeed(state.feed, "warning", "No room configured to open."),
      },
      intent: { type: "none" },
    };
  }
  const server = state.dashboard.config.server || "http://localhost:3000";
  const url = `${server}/rooms/${state.dashboard.config.roomId}`;
  return {
    state: {
      ...state,
      message: `Opening ${url}...`,
      feed: appendOpenTuiFeed(state.feed, "info", `Opening browser workspace: ${url}`),
    },
    intent: { type: "open-browser", url },
  };
}

function applyOpenTuiPinsCommand(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      message: "Pinned preferences listed in the feed.",
      feed: appendOpenTuiFeed(state.feed, "info", ["Pinned preferences:", ...pinSummaryLines(state.pins)].join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiPinCommand(state: OpenTuiPreviewUiState, args: string[]): OpenTuiPreviewKeyResult {
  const target = (args[0] || "room").toLowerCase();
  if (target === "room") {
    if (!state.dashboard.config?.roomId) {
      return {
        state: {
          ...state,
          message: "No room configured to pin.",
          feed: appendOpenTuiFeed(state.feed, "warning", "No room configured to pin."),
        },
        intent: { type: "none" },
      };
    }
    const next = rememberOpenTuiUndo(state, "pin room");
    const label = state.dashboard.config.roomName || state.dashboard.config.roomId;
    return {
      state: {
        ...next,
        pins: pinRoom(next.pins, {
          roomId: state.dashboard.config.roomId,
          roomName: state.dashboard.config.roomName,
        }),
        message: "Pinned current room.",
        feed: appendOpenTuiFeed(next.feed, "info", `Pinned room: ${label}`),
      },
      intent: { type: "none" },
    };
  }

  if (target === "provider") {
    const provider = args[1] || state.dashboard.provider;
    const next = rememberOpenTuiUndo(state, "pin provider");
    return {
      state: {
        ...next,
        pins: pinProvider(next.pins, provider),
        message: "Pinned provider.",
        feed: appendOpenTuiFeed(next.feed, "info", `Pinned provider: ${provider}`),
      },
      intent: { type: "none" },
    };
  }

  if (target === "agent") {
    const agent = findOpenTuiAgent(state, args.slice(1).join(" ") || state.selectedAgentId || "");
    if (!agent) {
      return {
        state: {
          ...state,
          message: "No matching agent.",
          feed: appendOpenTuiFeed(state.feed, "warning", "No matching agent. Use /agent to list loaded agents first."),
        },
        intent: { type: "none" },
      };
    }
    const next = rememberOpenTuiUndo(state, "pin agent");
    const label = compact(agent.name, agent._id);
    return {
      state: {
        ...next,
        pins: pinAgent(next.pins, {
          agentId: agent._id,
          name: agent.name,
          provider: agent.provider,
        }),
        message: "Pinned agent.",
        feed: appendOpenTuiFeed(next.feed, "info", `Pinned agent: ${label}`),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      message: "Unknown pin target.",
      feed: appendOpenTuiFeed(state.feed, "warning", "Pin one of: room, provider, agent."),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiUnpinCommand(state: OpenTuiPreviewUiState, args: string[]): OpenTuiPreviewKeyResult {
  const target = args[0]?.toLowerCase() as PinTarget | undefined;
  if (!target || !["room", "provider", "agent"].includes(target)) {
    return {
      state: {
        ...state,
        message: "Unpin needs a target.",
        feed: appendOpenTuiFeed(state.feed, "warning", "Usage: /unpin <room|provider|agent> <value>"),
      },
      intent: { type: "none" },
    };
  }

  const fallback =
    target === "room" ? state.dashboard.config?.roomId || "" :
    target === "provider" ? state.dashboard.provider :
    "";
  const value = args.slice(1).join(" ") || fallback;
  if (!value) {
    return {
      state: {
        ...state,
        message: `No ${target} value to unpin.`,
        feed: appendOpenTuiFeed(state.feed, "warning", `No ${target} value to unpin.`),
      },
      intent: { type: "none" },
    };
  }

  const next = rememberOpenTuiUndo(state, `unpin ${target}`);
  return {
    state: {
      ...next,
      pins: unpinTarget(next.pins, target, value),
      message: `Unpinned ${target}.`,
      feed: appendOpenTuiFeed(next.feed, "info", `Unpinned ${target}: ${value}`),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiRoomCommand(state: OpenTuiPreviewUiState, value: string): OpenTuiPreviewKeyResult {
  const room = findOpenTuiRoom(state, value);
  if (!room) {
    const known = knownOpenTuiRooms(state).map((candidate) => candidate.roomName || candidate.roomId).join(", ");
    const message = known
      ? `No matching room: ${value}. Known rooms: ${known}`
      : "No rooms loaded. Login and use /rooms after refresh.";
    return {
      state: {
        ...state,
        message: "No matching room.",
        feed: appendOpenTuiFeed(state.feed, "warning", message),
      },
      intent: { type: "none" },
    };
  }

  const label = room.roomName || room.roomId;
  return {
    state: {
      ...state,
      message: `Switching room to ${label}...`,
    },
    intent: { type: "select-room", roomId: room.roomId, roomName: room.roomName },
  };
}

export function knownOpenTuiRooms(
  state: OpenTuiPreviewUiState,
): Array<{ roomId: string; roomName?: string; status?: string; agentCount?: number; memberCount?: number }> {
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

  if (state.dashboard.config?.roomId) {
    add({ roomId: state.dashboard.config.roomId, roomName: state.dashboard.config.roomName });
  }
  for (const room of state.dashboard.rooms) {
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

function findOpenTuiRoom(
  state: OpenTuiPreviewUiState,
  value: string,
): { roomId: string; roomName?: string } | null {
  const query = value.trim().toLowerCase();
  if (!query) return null;
  const rooms = knownOpenTuiRooms(state);
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

function findOpenTuiAgent(state: OpenTuiPreviewUiState, value: string) {
  const query = value.trim().toLowerCase();
  if (!query) return null;
  return state.dashboard.dashboard.agents.find((agent) => {
    const name = agent.name?.toLowerCase();
    return agent._id === value || agent._id.endsWith(value) || name === query;
  }) || null;
}

function applyOpenTuiInstructionsCommand(state: OpenTuiPreviewUiState, args: string[]): OpenTuiPreviewKeyResult {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === "attach" || subcommand === "add") {
    if (state.instructions.files.length === 0) {
      return {
        state: {
          ...state,
          message: "No instruction files found.",
          feed: appendOpenTuiFeed(state.feed, "info", "No project instruction files found."),
        },
        intent: { type: "none" },
      };
    }

    let attachments = state.attachments;
    for (const file of state.instructions.files) {
      attachments = addAttachment(attachments, file.path, {
        kind: "file",
        projectDir: state.args.dir,
      }).attachments;
    }
    const next = rememberOpenTuiUndo(state, "instructions attach");
    return {
      state: {
        ...next,
        attachments,
        message: `Attached ${state.instructions.files.length} instruction files.`,
        feed: appendOpenTuiFeed(
          next.feed,
          "info",
          `Attached instruction files: ${state.instructions.files.map((file) => file.path).join(", ")}`,
        ),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      message: state.instructions.files.length > 0
        ? `${state.instructions.files.length} instruction files found.`
        : "No instruction files found.",
      feed: appendOpenTuiFeed(state.feed, "info", [
        "Project instructions:",
        ...instructionSummary(state.instructions, 20),
        "",
        "Use /instructions attach to include them in the next task.",
      ].join("\n")),
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiMemoryCommand(state: OpenTuiPreviewUiState, args: string[]): OpenTuiPreviewKeyResult {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === "attach" || subcommand === "add") {
    if (state.memory.files.length === 0) {
      return {
        state: {
          ...state,
          message: "No memory files found.",
          feed: appendOpenTuiFeed(state.feed, "info", "No project memory files found."),
        },
        intent: { type: "none" },
      };
    }

    let attachments = state.attachments;
    for (const file of state.memory.files) {
      attachments = addAttachment(attachments, file.path, {
        kind: "file",
        projectDir: state.args.dir,
      }).attachments;
    }
    const next = rememberOpenTuiUndo(state, "memory attach");
    return {
      state: {
        ...next,
        attachments,
        message: `Attached ${state.memory.files.length} memory files.`,
        feed: appendOpenTuiFeed(
          next.feed,
          "info",
          `Attached memory files: ${state.memory.files.map((file) => file.path).join(", ")}`,
        ),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      message: state.memory.files.length > 0
        ? `${state.memory.files.length} memory files found.`
        : "No memory files found.",
      feed: appendOpenTuiFeed(state.feed, "info", [
        "Project memory:",
        ...memorySummary(state.memory, 20),
        "",
        "Use /memory attach to include them in the next task.",
      ].join("\n")),
    },
    intent: { type: "none" },
  };
}

function roomLines(state: TuiDashboardState): string[] {
  const config = state.config;
  if (!config) {
    return [
      "config      not found",
      `auth        ${state.session ? "logged in" : "not logged in"}`,
      `message     ${state.message}`,
    ];
  }

  return [
    `name        ${compact(config.roomName, config.roomId)}`,
    `room id     ${config.roomId}`,
    `provider    ${state.provider}`,
    `server      ${compact(config.server)}`,
    `project     ${compact(config.projectDir, state.config?.projectDir || "-")}`,
    `auth        ${state.session ? "logged in" : "not logged in"}`,
    `message     ${state.message}`,
  ];
}

function serviceLines(state: TuiDashboardState): string[] {
  const services = state.dashboard.services;
  return [
    `bridge      ${state.bridge}`,
    `web         ${formatServiceHealth(services.web)}`,
    `runtime     ${formatServiceHealth(services.runtime)}`,
    `terminal    ${formatServiceHealth(services.terminal)}`,
    `collab      ${formatServiceHealth(services.collab)}`,
    `cache       ${formatDashboardCachePolicy(dashboardCachePolicyFromEnv())}`,
  ];
}

function agentLines(state: TuiDashboardState, selectedAgentId?: string): string[] {
  if (state.dashboard.error && !state.dashboard.cached) return [state.dashboard.error];
  if (!state.config?.roomId) return ["Initialize a room to load agents."];
  if (!state.session) return ["Login to load agents."];
  if (state.dashboard.agents.length === 0) return ["No agents in this room. Add one with /agent-add reviewer codex."];

  const prefix = state.dashboard.cached ? [`cached      ${state.dashboard.cachedAt || "cached data"}`] : [];
  const rows = buildAgentActivityRows({
    agents: state.dashboard.agents,
    runs: state.dashboard.runs,
    providerAvailability: state.providerAvailability,
  });

  return [
    ...prefix,
    ...rows.slice(0, 8).map((row) => {
      const task = row.runId ? `${shortId(row.runId)} ${compact(row.goal, "(no goal)")}` : "no tasks";
      const marker = row.agentId === selectedAgentId ? ">" : " ";
      return `${marker} @${agentHandle({ _id: row.agentId, name: row.name })}  ${row.state}  ${row.availability}  ${row.provider}/${row.executionMode}  ${task}`;
    }),
  ];
}

function runLines(state: TuiDashboardState, selectedRunId?: string): string[] {
  if (!state.config?.roomId) return ["Initialize a room to load tasks."];
  if (!state.session) return ["Login to load tasks."];
  if (state.dashboard.runs.length === 0) return ["No recent tasks."];

  return state.dashboard.runs.slice(0, 8).map((run, index) => {
    const steps = run.steps?.length ?? 0;
    const agent = state.dashboard.agents.find((candidate) => candidate._id === run.agent_id);
    const marker = run._id === selectedRunId ? ">" : " ";
    return `${marker} ${String(index + 1).padStart(2, "0")} ${compact(run.status, "unknown")} ${shortId(run._id)} ${compact(agent?.name, run.agent_id || "agent")} ${steps} steps  ${compact(run.goal, "(no goal)")}`;
  });
}

function composerLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state)) {
    return ["press t to compose a task"];
  }
  const status = state.taskRunning
    ? "running"
    : state.mode === "confirm"
      ? "approval"
      : state.mode === "task"
        ? "editing"
        : state.mode === "help"
          ? "help"
          : "ready";
  return [
    `status      ${status}`,
    `message     ${state.message}`,
    ...(state.attachments.length > 0
      ? [`attached    ${state.attachments.map((attachment) => attachmentLabel(attachment)).join(", ")}`]
      : []),
    ...taskComposerLines(state.taskInput, {
      width: 96,
      cursor: state.mode === "task" ? "_" : "",
      maxLines: 4,
    }),
    ...(state.mode === "task" ? openTuiTaskSuggestionLines(state, 96, 5) : []),
    state.mode === "task"
      ? "Enter submits. Tab completes slash commands. Up/down choose command suggestions or history. Ctrl+J newline. Esc cancels."
      : "press t to compose a task, / slash, Ctrl+P palette, Ctrl+F find, q quit.",
  ];
}

function helpLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || state.mode !== "help") return [];
  return [
    "Keyboard Help",
    "Room keys: j/k move selected task, [/] select agent, Tab swaps pane focus, Enter/v opens selected task.",
    "Room commands: t compose, / slash command, Ctrl+P palette, Ctrl+F find, c terminal, ? help, q quit.",
    "Task detail keys: j/k move patches, g/G first/last patch, a accept, x reject, e export, y copy, R retry, s stop, h handoff.",
    "Workspace result keys: j/k move rows, g/G first/last row, a attach file, Enter attach and prefill task, Esc/b back.",
    "Composer keys: Enter submit, Tab complete slash command, Up/Down choose suggestions or history, Ctrl+J newline, Ctrl+U clear, Esc cancel.",
    "Terminal keys: Esc or Ctrl+] returns to dashboard while the shared shell is focused.",
    "Press ? or Esc to close this help surface.",
  ];
}

function approvalLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || state.mode !== "confirm" || !state.pendingApproval) return [];
  const detailLines = state.pendingApproval.detail
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(Boolean);
  return [
    "Approval",
    state.pendingApproval.title,
    ...detailLines,
    `Y/Enter ${state.pendingApproval.confirmLabel}  N/Esc Cancel`,
  ];
}

function paletteLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || state.mode !== "palette") return [];
  const items = filteredOpenTuiPaletteItems(state, 8);
  return [
    "Command Palette",
    `query       ${state.paletteInput || "(all)"}`,
    ...(items.length > 0
      ? items.map((item, index) => {
        const marker = index === state.paletteSelected ? ">" : " ";
        return `${marker} ${item.kind.padEnd(8)} ${item.label}  ${item.detail}`;
      })
      : ["No matching commands, providers, agents, runs, or rooms."]),
    "Enter selects, arrows/Ctrl+N/Ctrl+P move, Ctrl+U clears, Esc closes.",
  ];
}

function feedLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || state.feed.length === 0) return [];
  return [
    "Feed",
    ...state.feed.slice(-6).map((entry) => `${entry.kind.padEnd(7)} ${entry.text}`),
  ];
}

function workspaceResultLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || !state.workspaceResults) return [];
  const result = state.workspaceResults;
  const windowStart = selectedPatchWindowStart(result.selectedIndex, result.entries.length, 12);
  const visible = result.entries.slice(windowStart, windowStart + 12);
  return [
    result.title,
    `kind        ${result.kind}`,
    ...(result.query ? [`query       ${result.query}`] : []),
    `summary     ${result.summary}`,
    ...(visible.length > 0
      ? visible.map((entry, index) => {
        const rowIndex = windowStart + index;
        const marker = rowIndex === result.selectedIndex ? ">" : " ";
        return `${marker} ${entry.label}${entry.detail ? `  ${entry.detail}` : ""}`;
      })
      : ["No rows to show."]),
    "j/k move, g/G first/last, a attach file, Enter attach and prefill task, Esc/b back, ? help.",
  ];
}

function terminalLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state)) return [];
  if (
    state.mode !== "terminal"
    && state.terminalLines.length === 0
    && !state.terminal.connecting
    && !state.terminal.connected
    && !state.terminal.disconnectReason
  ) {
    return [];
  }

  const status = state.terminal.connected
    ? "connected"
    : state.terminal.connecting
      ? "connecting"
      : "disconnected";
  const action = state.mode === "terminal"
    ? "input active"
    : state.terminal.connected
      ? "press c to focus"
      : "press c to connect";
  const reason = state.terminal.disconnectReason ? ` (${state.terminal.disconnectReason})` : "";
  const visible = state.terminalLines.slice(-8);
  return [
    "Shared Terminal",
    `status      ${status}${reason}`,
    `action      ${action}`,
    ...(state.mode === "terminal"
      ? ["keys        Esc or Ctrl+] returns to dashboard. Other keys go to the shared shell."]
      : []),
    ...(visible.length > 0 ? visible : ["No terminal output yet."]),
  ];
}

function runDetailLines(state: OpenTuiPreviewState | OpenTuiPreviewUiState): string[] {
  if (!isUiState(state) || state.mode !== "run") return [];
  const detail = selectedOpenTuiRunDetail(state);
  if (!detail) {
    return [
      "Task",
      state.runDetailLoading ? "loading     task detail..." : "No task selected.",
      "Esc/b returns to dashboard, Ctrl+P opens palette, q quits.",
    ];
  }

  const { run, patches, allRuns } = detail;
  const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === run.agent_id);
  const steps = run.steps || [];
  const delegation = buildDelegationRows(run, allRuns);
  const selectedPatch = patches[state.selectedPatchIndex] || patches[0];
  const patchStart = selectedPatchWindowStart(state.selectedPatchIndex, patches.length, 5);
  const visiblePatches = patches.slice(patchStart, patchStart + 5);
  const handoffTarget = handoffTargetSummary(
    state.dashboard.dashboard.agents,
    state.selectedHandoffTargetAgentId,
  );

  return [
    "Task",
    `${compact(run.goal, "(no goal)")}`,
    "",
    state.runDetailLoading ? "loading     refreshing task detail..." : `id          ${run._id}`,
    `status      ${compact(run.status, "unknown")}`,
    `agent       ${compact(agent?.name, run.agent_id || "agent")} ${shortId(run.agent_id)}`,
    `execution   ${compact(run.execution_mode, "hosted_api")}`,
    `created     ${formatOpenTuiTimestamp(run.created_at)}`,
    `started     ${formatOpenTuiTimestamp(run.started_at)}`,
    `finished    ${formatOpenTuiTimestamp(run.finished_at)}`,
    `handoff     ${handoffTarget}  [/] cycle, h prefill`,
    "",
    "result",
    ...runTextResultLines(run).map((line) => `  ${line}`),
    "",
    "work trail",
    ...(steps.length > 0
      ? steps.slice(0, 8).map((step) => {
        const index = step.idx === undefined ? "-" : String(step.idx).padStart(2, "0");
        const status = step.output?.success === false ? "failed" : step.output?.success === true ? "ok" : "recorded";
        return `${index} ${compact(step.kind, "step")} ${status}  ${compact(formatStepDescription(step), "-")}`;
      })
      : taskFallbackTrailLines(run)),
    "",
    `Delegation (${delegation.length})`,
    ...delegation.slice(0, 8).map((row) => {
      const marker = row.selected ? ">" : " ";
      const indent = "  ".repeat(row.depth);
      return `${marker} ${indent}${row.relation} ${shortId(row.runId)} ${compact(row.status, "unknown")} ${compact(row.role)} ${compact(row.goal, "(no goal)")}`;
    }),
    "",
    "patches",
    ...(patches.length > 0
      ? visiblePatches.map((patch, visibleIndex) => {
        const index = patchStart + visibleIndex;
        const marker = patch._id === selectedPatch?._id ? ">" : " ";
        return `${marker} ${String(index + 1).padStart(2, "0")} ${compact(patch.status, "unknown")} ${shortId(patch._id)} ${diffStat(patch.diff_text)} ${compact(patch.title, "(untitled)")} ${compact(patch.path)}`;
      })
      : ["no patches from this run"]),
    ...(selectedPatch
      ? [
        "",
        `Diff Preview ${shortId(selectedPatch._id)} ${diffStat(selectedPatch.diff_text)}`,
        ...(selectedPatch.diff_text || "").split("\n").slice(0, 12).map(formatOpenTuiDiffLine),
      ]
      : []),
    "j/k patch, g/G first/last, [/] target, h handoff, a accept, x reject, y/c copy, e export, R retry, s stop, r reload, Esc/b back.",
  ];
}

function runTextResultLines(run: { goal?: string; steps?: Array<{ output?: { payload?: Record<string, unknown> } }> }): string[] {
  const goal = compact(run.goal, "");
  for (const step of [...(run.steps || [])].reverse()) {
    const payload = step.output?.payload || {};
    const raw = typeof payload.stdout === "string" ? payload.stdout
      : typeof payload.text === "string" ? payload.text
      : typeof payload.summary === "string" ? payload.summary
      : "";
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== goal);
    if (lines.length > 0) return lines.slice(-4);
  }
  return ["no captured output yet"];
}

function taskFallbackTrailLines(run: { status?: string; execution_mode?: string }): string[] {
  const mode = compact((run.execution_mode || "local agent").replace(/^local_/, ""), "local agent");
  if (isOpenTuiQueuedRun(run)) return [`◌ waiting for ${mode} to pick this up`];
  if (isOpenTuiWorkingRun(run)) return [`⠋ ${mode} is working`];
  if (isOpenTuiFailedRun(run)) return [`✓ started ${mode}`, "✗ stopped before producing a patch"];
  return [`✓ started ${mode}`, "✓ returned final answer"];
}

function isUiState(state: OpenTuiPreviewState | OpenTuiPreviewUiState): state is OpenTuiPreviewUiState {
  return "mode" in state;
}

function selectedOpenTuiAgent(state: OpenTuiPreviewUiState) {
  if (!state.selectedAgentId) return state.dashboard.dashboard.agents[0];
  return state.dashboard.dashboard.agents.find((agent) => agent._id === state.selectedAgentId)
    || state.dashboard.dashboard.agents[0];
}

export function moveOpenTuiDashboardSelection(
  state: OpenTuiPreviewUiState,
  direction: -1 | 1,
): OpenTuiPreviewUiState {
  if (state.dashboardFocus === "agents") return moveOpenTuiDashboardAgentSelection(state, direction);
  return moveOpenTuiDashboardRunSelection(state, direction);
}

function moveOpenTuiDashboardRunSelection(
  state: OpenTuiPreviewUiState,
  direction: -1 | 1,
): OpenTuiPreviewUiState {
  const runs = state.dashboard.dashboard.runs;
  if (runs.length === 0) {
    return { ...state, message: "No recent work to select." };
  }

  const current = Math.max(0, runs.findIndex((run) => run._id === state.selectedRunId));
  const nextIndex = (current + direction + runs.length) % runs.length;
  const run = runs[nextIndex];
  return {
    ...state,
    dashboardFocus: "runs",
    selectedRunId: run._id,
    message: `Selected run ${nextIndex + 1}/${runs.length}: ${shortId(run._id)} ${compact(run.goal, "(no goal)")}`,
  };
}

function moveOpenTuiDashboardAgentSelection(
  state: OpenTuiPreviewUiState,
  direction: -1 | 1,
): OpenTuiPreviewUiState {
  const agents = state.dashboard.dashboard.agents;
  if (agents.length === 0) {
    return { ...state, message: "No agents to select." };
  }

  const current = Math.max(0, agents.findIndex((agent) => agent._id === state.selectedAgentId));
  const nextIndex = (current + direction + agents.length) % agents.length;
  const agent = agents[nextIndex];
  return {
    ...state,
    dashboardFocus: "agents",
    selectedAgentId: agent._id,
    message: `Selected agent ${nextIndex + 1}/${agents.length}: ${compact(agent.name, agent._id)}`,
  };
}

function moveOpenTuiWorkspaceResultSelection(
  state: OpenTuiPreviewUiState,
  direction: -1 | 1,
): OpenTuiPreviewUiState {
  const result = state.workspaceResults;
  if (!result || result.entries.length === 0) {
    return { ...state, message: "No workspace result rows to select." };
  }

  const nextIndex = (result.selectedIndex + direction + result.entries.length) % result.entries.length;
  return {
    ...state,
    workspaceResults: { ...result, selectedIndex: nextIndex },
    message: `Selected ${nextIndex + 1}/${result.entries.length}: ${result.entries[nextIndex].label}`,
  };
}

function selectOpenTuiWorkspaceResult(
  state: OpenTuiPreviewUiState,
  position: "first" | "last",
): OpenTuiPreviewUiState {
  const result = state.workspaceResults;
  if (!result || result.entries.length === 0) {
    return { ...state, message: "No workspace result rows to select." };
  }
  const selectedIndex = position === "first" ? 0 : result.entries.length - 1;
  return {
    ...state,
    workspaceResults: { ...result, selectedIndex },
    message: `Selected ${selectedIndex + 1}/${result.entries.length}: ${result.entries[selectedIndex].label}`,
  };
}

function attachOpenTuiWorkspaceResult(
  state: OpenTuiPreviewUiState,
  compose: boolean,
): OpenTuiPreviewKeyResult {
  const result = state.workspaceResults;
  const entry = result?.entries[result.selectedIndex || 0];
  if (!entry) {
    return {
      state: { ...state, message: "No workspace result row selected." },
      intent: { type: "none" },
    };
  }

  if (!entry.attachPath) {
    return {
      state: { ...state, message: "Selected row has no attachable file path." },
      intent: { type: "none" },
    };
  }

  const attached = addAttachment(state.attachments, entry.attachPath, {
    kind: "file",
    projectDir: state.args.dir,
  });
  const next = attached.ok && attached.attachments !== state.attachments
    ? rememberOpenTuiUndo(state, "workspace result attach")
    : state;
  return {
    state: {
      ...next,
      mode: compose ? "task" : "workspace",
      attachments: attached.attachments,
      taskInput: compose ? entry.promptText || `Review @${quoteFileMentionPath(entry.attachPath)}.` : state.taskInput,
      message: compose
        ? `${attached.message}. Task composer prefilled.`
        : attached.message,
      feed: appendOpenTuiFeed(next.feed, attached.ok ? "info" : "warning", attached.message),
    },
    intent: { type: "none" },
  };
}

function quoteFileMentionPath(path: string): string {
  return /[\s"'@]/.test(path) ? JSON.stringify(path) : path;
}

function selectedOpenTuiHandoffTarget(state: OpenTuiPreviewUiState) {
  if (!state.selectedHandoffTargetAgentId) return undefined;
  return state.dashboard.dashboard.agents.find((agent) => agent._id === state.selectedHandoffTargetAgentId);
}

function cycleOpenTuiHandoffTarget(
  state: OpenTuiPreviewUiState,
  direction: -1 | 1,
): OpenTuiPreviewKeyResult {
  const target = cycleHandoffTarget(
    state.dashboard.dashboard.agents,
    state.selectedHandoffTargetAgentId,
    direction,
  );
  if (!target) {
    return {
      state: {
        ...state,
        message: "No agents loaded for handoff target selection.",
        feed: appendOpenTuiFeed(state.feed, "warning", "No agents loaded for handoff target selection."),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      selectedHandoffTargetAgentId: target._id,
      message: `Handoff target: ${handoffTargetLabel(target)}`,
    },
    intent: { type: "none" },
  };
}

function applyOpenTuiHandoffTargetCommand(
  state: OpenTuiPreviewUiState,
  query: string,
): OpenTuiPreviewKeyResult {
  const result = resolveHandoffTarget(state.dashboard.dashboard.agents, query);
  if (!result.ok) {
    return {
      state: {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "warning", result.message),
      },
      intent: { type: "none" },
    };
  }

  return {
    state: {
      ...state,
      selectedHandoffTargetAgentId: result.agent._id,
      message: result.message,
      feed: appendOpenTuiFeed(
        state.feed,
        "info",
        `${result.message}. Press h from task detail or use /handoff current ${result.agent._id} <context>.`,
      ),
    },
    intent: { type: "none" },
  };
}

function selectedOpenTuiRunDetail(state: OpenTuiPreviewUiState): RunDetailData | null {
  if (state.selectedRunDetail && state.selectedRunDetail.run._id === state.selectedRunId) {
    return state.selectedRunDetail;
  }
  const runId = state.selectedRunId || state.dashboard.dashboard.runs[0]?._id;
  const run = state.dashboard.dashboard.runs.find((candidate) => candidate._id === runId);
  if (!run) return null;
  return {
    run,
    patches: [],
    allRuns: state.dashboard.dashboard.runs,
  };
}

function beginOpenTuiRunDetail(
  state: OpenTuiPreviewUiState,
  runId: string,
  feedMessage = `Opening task detail: ${shortId(runId)}`,
): OpenTuiPreviewKeyResult {
  return {
    state: {
      ...state,
      mode: "run",
      selectedRunId: runId,
      selectedRunDetail: state.selectedRunDetail?.run._id === runId ? state.selectedRunDetail : undefined,
      runDetailLoading: true,
      selectedPatchIndex: 0,
      message: `Loading task detail: ${shortId(runId)}`,
      feed: appendOpenTuiFeed(state.feed, "info", feedMessage),
    },
    intent: { type: "load-run", runId },
  };
}

function beginOpenTuiTerminalConnection(state: OpenTuiPreviewUiState): OpenTuiPreviewKeyResult {
  if (state.terminal.connected) {
    return {
      state: { ...state, mode: "terminal", message: "Shared terminal input active." },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiApprovedIntent(state, {
    safetyAction: "network",
    title: "Connect shared terminal?",
    detail: "This opens a realtime network session to the room terminal gateway.",
    confirmLabel: "Connect terminal",
    runningMessage: "Connecting shared terminal...",
    feedKind: "info",
    feedMessage: "Connecting shared terminal...",
    returnMode: "dashboard",
    returnTaskInput: state.taskInput,
    intent: { type: "connect-terminal" },
  });
}

function reduceOpenTuiTerminalKey(state: OpenTuiPreviewUiState, sequence: string): OpenTuiPreviewKeyResult {
  if (sequence === "\u001b" || sequence === "\u001d") {
    return {
      state: { ...state, mode: "dashboard", message: "Shared terminal input paused." },
      intent: { type: "none" },
    };
  }
  if (!state.terminal.connected) {
    if (sequence === "c" || sequence === "r") return beginOpenTuiTerminalConnection(state);
    return {
      state: { ...state, message: "Shared terminal is not connected. Press c to reconnect." },
      intent: { type: "none" },
    };
  }
  return { state, intent: { type: "terminal-input", data: sequence } };
}

function moveOpenTuiPatchSelection(state: OpenTuiPreviewUiState, direction: -1 | 1): OpenTuiPreviewUiState {
  const count = selectedOpenTuiRunDetail(state)?.patches.length ?? 0;
  if (count === 0) return { ...state, message: "No patches attached to this run." };
  return {
    ...state,
    selectedPatchIndex: (state.selectedPatchIndex + direction + count) % count,
    message: `Selected patch ${((state.selectedPatchIndex + direction + count) % count) + 1} of ${count}.`,
  };
}

function selectOpenTuiPatch(state: OpenTuiPreviewUiState, position: "first" | "last"): OpenTuiPreviewUiState {
  const count = selectedOpenTuiRunDetail(state)?.patches.length ?? 0;
  if (count === 0) return { ...state, message: "No patches attached to this run." };
  return {
    ...state,
    selectedPatchIndex: position === "first" ? 0 : count - 1,
    message: `Selected ${position} patch.`,
  };
}

function beginOpenTuiPatchResolve(
  state: OpenTuiPreviewUiState,
  action: "accept" | "reject",
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  if (!detail) {
    return { state: { ...state, message: "No task selected." }, intent: { type: "none" } };
  }
  const patch = detail.patches[state.selectedPatchIndex];
  if (!patch) {
    return { state: { ...state, message: "No patch selected." }, intent: { type: "none" } };
  }
  if (patch.status !== "proposed") {
    return {
      state: { ...state, message: `Patch is already ${patch.status || "resolved"}.` },
      intent: { type: "none" },
    };
  }
  const message = `${action === "accept" ? "Accepting" : "Rejecting"} patch ${shortId(patch._id)}...`;
  return beginOpenTuiApprovedIntent(state, {
    safetyAction: action === "accept" ? "file-edit" : "destructive",
    title: `${action === "accept" ? "Accept" : "Reject"} proposed patch?`,
    detail: `${shortId(patch._id)} from run ${shortId(detail.run._id)}`,
    confirmLabel: action === "accept" ? "Accept patch" : "Reject patch",
    runningMessage: message,
    feedKind: action === "accept" ? "info" : "warning",
    feedMessage: message,
    returnMode: "run",
    returnTaskInput: state.taskInput,
    intent: { type: "resolve-patch", runId: detail.run._id, patchId: patch._id, action },
  });
}

function openTuiRunCopyKind(value?: string): RunCopyKind | null {
  return value === "id" || value === "goal" || value === "summary" || value === "diff" || value === "output"
    ? value
    : null;
}

function openTuiSelectedRunDetailForRef(state: OpenTuiPreviewUiState, runRef?: string): RunDetailData | undefined {
  const detail = state.selectedRunDetail;
  if (!detail || detail.run._id !== state.selectedRunId) return undefined;
  if (!runRef) return detail;
  const runId = resolveRunId(detail.allRuns || state.dashboard.dashboard.runs, runRef);
  return runId === detail.run._id ? detail : undefined;
}

function openTuiRunExportArgs(
  state: OpenTuiPreviewUiState,
  args: string[],
): [runRef: string | undefined, outputPath: string | undefined] {
  const first = args[0];
  if (!first) return [undefined, undefined];
  const runs = state.selectedRunDetail?.allRuns || state.dashboard.dashboard.runs;
  const explicitRunId = /^\d+$/.test(first)
    ? runs[Number(first) - 1]?._id
    : runs.find((run) => run._id === first || run._id.endsWith(first))?._id;
  const firstLooksLikeRunRef = Boolean(explicitRunId) || first.startsWith("run");
  if (firstLooksLikeRunRef) return [first, args.slice(1).join(" ").trim() || undefined];
  return [undefined, args.join(" ").trim() || undefined];
}

function beginOpenTuiRunExport(
  state: OpenTuiPreviewUiState,
  runRef?: string,
  outputPath?: string,
): OpenTuiPreviewKeyResult {
  const detail = openTuiSelectedRunDetailForRef(state, runRef);
  if (!detail) {
    const runId = runRef ? resolveRunId(state.dashboard.dashboard.runs, runRef) : state.selectedRunId;
    if (runId) {
      return {
        state: {
          ...state,
          mode: "run",
          selectedRunId: runId,
          runDetailLoading: true,
          pendingRunAction: outputPath ? { type: "export", outputPath } : { type: "export" },
          message: `Loading task ${shortId(runId)} before export...`,
          feed: appendOpenTuiFeed(state.feed, "info", `Loading task ${shortId(runId)} before export.`),
        },
        intent: { type: "load-run", runId },
      };
    }
    return { state: { ...state, message: "No task loaded to export." }, intent: { type: "none" } };
  }
  return {
    state: {
      ...state,
      message: `Exporting task summary: ${shortId(detail.run._id)}...`,
      feed: appendOpenTuiFeed(state.feed, "info", `Exporting task summary: ${shortId(detail.run._id)}...`),
    },
    intent: outputPath ? { type: "export-run", outputPath } : { type: "export-run" },
  };
}

function beginOpenTuiRunCopy(
  state: OpenTuiPreviewUiState,
  kind: RunCopyKind,
  runRef?: string,
): OpenTuiPreviewKeyResult {
  const detail = openTuiSelectedRunDetailForRef(state, runRef);
  if (!detail) {
    const runId = runRef ? resolveRunId(state.dashboard.dashboard.runs, runRef) : state.selectedRunId;
    if (runId) {
      return {
        state: {
          ...state,
          mode: "run",
          selectedRunId: runId,
          runDetailLoading: true,
          pendingRunAction: { type: "copy", kind },
          message: `Loading task ${shortId(runId)} before copy...`,
          feed: appendOpenTuiFeed(state.feed, "info", `Loading task ${shortId(runId)} before copy.`),
        },
        intent: { type: "load-run", runId },
      };
    }
    return { state: { ...state, message: "No task loaded to copy." }, intent: { type: "none" } };
  }
  return {
    state: {
      ...state,
      message: `Copying task ${kind}: ${shortId(detail.run._id)}...`,
      feed: appendOpenTuiFeed(state.feed, "info", `Copying task ${kind}: ${shortId(detail.run._id)}...`),
    },
    intent: { type: "copy-run", kind },
  };
}

// Execution modes this TUI can claim and run with a locally installed CLI.
const WORKABLE_EXECUTION_MODES: Record<string, string> = {
  local_claude_code: "claude",
  local_codex: "codex",
  local_opencode: "opencode",
  local_hermes: "hermes",
  local_openclaw: "openclaw",
};

// /work — act as the executor for the room's queue. Claims the oldest queued
// run whose provider is installed here (via the continue/claim dispatch path,
// so the SAME run goes queued → running → done; no clone-and-cancel) and
// executes it locally. One task per invocation, matching the single-task
// state machine; the queue count in the rail tells you to run it again.
function beginOpenTuiWorkCommand(
  state: OpenTuiPreviewUiState,
  input = state.taskInput,
): OpenTuiPreviewKeyResult {
  const runs = state.dashboard.dashboard.runs || [];
  const queued = runs.filter((run) => run.status === "queued");
  if (queued.length === 0) {
    return {
      state: { ...state, message: "Queue is clear — nothing waiting for an executor." },
      intent: { type: "none" },
    };
  }
  const availability = state.dashboard.providerAvailability || {};
  const ordered = [...queued].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const claimable = ordered.find((run) => {
    const provider = WORKABLE_EXECUTION_MODES[run.execution_mode || ""];
    return provider !== undefined && availability[provider] === true;
  });
  if (!claimable) {
    return {
      state: { ...state, message: "Queued tasks need a provider that isn't installed here (or run hosted)." },
      intent: { type: "none" },
    };
  }
  const provider = WORKABLE_EXECUTION_MODES[claimable.execution_mode || ""];
  const goal = compact(claimable.goal, "");
  if (!goal) {
    return {
      state: { ...state, message: "The next queued task has no goal to run." },
      intent: { type: "none" },
    };
  }
  const others = queued.length - 1;
  return beginOpenTuiRunnableIntent(state, {
    title: "Work the queue?",
    detail: `Run queued task ${shortId(claimable._id)} on this machine with ${provider}: ${previewText(goal, "(no prompt)")}${others > 0 ? `\n${others} more queued — /work again after this one.` : ""}`,
    confirmLabel: "Run here",
    runningMessage: `Working queued ${shortId(claimable._id)}…`,
    feedKind: "info",
    feedMessage: `Claimed queued task ${shortId(claimable._id)}: ${goal}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: { type: "submit", goal, provider, agentId: claimable.agent_id, continueRunId: claimable._id },
  });
}

const DISMISSABLE_STATUSES = new Set(["failed", "error", "cancelled"]);

// Dismiss a failure from "needs you" — personal attention management, not a
// server action: the run stays in history, only your inbox stops nagging.
function dismissOpenTuiFailure(
  state: OpenTuiPreviewUiState,
  runRef?: string,
): OpenTuiPreviewKeyResult {
  const runs = state.dashboard.dashboard.runs || [];
  const dismissed = new Set(state.dismissedRunIds || []);
  const target = runRef
    ? runs.find((run) => run._id === resolveRunId(runs, runRef))
    : state.mode === "run" && state.selectedRunDetail
      ? runs.find((run) => run._id === state.selectedRunDetail?.run._id) || state.selectedRunDetail.run
      : runs.find((run) => DISMISSABLE_STATUSES.has(run.status || "") && !dismissed.has(run._id));
  if (!target) {
    return {
      state: { ...state, message: "Nothing to dismiss — needs-you is clear." },
      intent: { type: "none" },
    };
  }
  if (!DISMISSABLE_STATUSES.has(target.status || "")) {
    return {
      state: { ...state, message: "Only failed tasks can be dismissed. Patches want a or x." },
      intent: { type: "none" },
    };
  }
  if (dismissed.has(target._id)) {
    return {
      state: { ...state, message: "Already dismissed." },
      intent: { type: "none" },
    };
  }
  const label = compact(target.goal, shortId(target._id));
  return {
    state: {
      ...state,
      mode: state.mode === "run" ? "task" : state.mode,
      selectedRunDetail: state.mode === "run" ? undefined : state.selectedRunDetail,
      dismissedRunIds: [...(state.dismissedRunIds || []), target._id].slice(-100),
      message: `dismissed: ${previewText(label, "task")} — it stays in history`,
    },
    intent: { type: "none" },
  };
}

function beginOpenTuiRunRetry(
  state: OpenTuiPreviewUiState,
  runRef?: string,
  input = state.taskInput,
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveRetryCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    runRef,
    currentRunId: detail?.run._id || state.selectedRunId,
  });
  if (!result.ok || !result.goal) {
    return {
      state: { ...state, message: result.message || "Unable to retry." },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiRunnableIntent(state, {
    title: "Retry task?",
    detail: `Auto-run is off. Approve retry ${shortId(result.runId)}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Retry",
    runningMessage: `Retrying ${shortId(result.runId)}...`,
    feedKind: "info",
    feedMessage: `Retrying ${shortId(result.runId)}: ${result.goal}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: { type: "submit", goal: result.goal },
  });
}

function beginOpenTuiContinueRun(
  state: OpenTuiPreviewUiState,
  args: string[],
  input: string,
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveContinueCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    args,
    lastRunId: detail?.run._id || state.selectedRunId,
  });
  if (!result.ok || !result.goal || !result.runId) {
    return {
      state: {
        ...state,
        message: result.message || "Unable to continue task.",
        feed: appendOpenTuiFeed(state.feed, "warning", result.message || "Unable to continue task."),
      },
      intent: { type: "none" },
    };
  }
  const sessionStatus = providerSessionStatusForRun(detail?.allRuns || state.dashboard.dashboard.runs, result.runId);
  return beginOpenTuiRunnableIntent(state, {
    title: "Continue task?",
    detail: `Auto-run is off. Approve continue ${shortId(result.runId)}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Continue",
    runningMessage: `Continuing ${shortId(result.runId)}...`,
    feedKind: "info",
    feedMessage: `Continuing ${shortId(result.runId)}: ${result.goal}\n${sessionStatus.message}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: { type: "submit", goal: result.goal, continueRunId: result.runId },
  });
}

function beginOpenTuiResumeRun(
  state: OpenTuiPreviewUiState,
  args: string[],
  input: string,
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveResumeCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    args,
    currentRunId: detail?.run._id || state.selectedRunId,
    lastRunId: state.selectedRunId,
  });
  if (!result.ok || !result.goal || !result.runId) {
    return {
      state: {
        ...state,
        message: result.message || "Unable to resume task.",
        feed: appendOpenTuiFeed(state.feed, "warning", result.message || "Unable to resume task."),
      },
      intent: { type: "none" },
    };
  }
  const sessionStatus = providerSessionStatusForRun(detail?.allRuns || state.dashboard.dashboard.runs, result.runId);
  return beginOpenTuiRunnableIntent(state, {
    title: "Resume task?",
    detail: `Auto-run is off. Approve resume ${shortId(result.runId)}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Resume",
    runningMessage: `Resuming ${shortId(result.runId)}...`,
    feedKind: "info",
    feedMessage: `Resuming ${shortId(result.runId)}: ${result.goal}\n${sessionStatus.message}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: { type: "submit", goal: result.goal, continueRunId: result.runId },
  });
}

function beginOpenTuiForkRun(
  state: OpenTuiPreviewUiState,
  args: string[],
  input: string,
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveForkCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    args,
    currentRunId: detail?.run._id || state.selectedRunId,
    lastRunId: state.selectedRunId,
  });
  if (!result.ok || !result.goal || !result.runId) {
    return {
      state: {
        ...state,
        message: result.message || "Unable to fork task.",
        feed: appendOpenTuiFeed(state.feed, "warning", result.message || "Unable to fork task."),
      },
      intent: { type: "none" },
    };
  }
  const sessionStatus = providerSessionStatusForRun(detail?.allRuns || state.dashboard.dashboard.runs, result.runId);
  return beginOpenTuiRunnableIntent(state, {
    title: "Fork task?",
    detail: `Auto-run is off. Approve fork ${shortId(result.runId)}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Fork",
    runningMessage: `Forking ${shortId(result.runId)}...`,
    feedKind: "info",
    feedMessage: `Forking ${shortId(result.runId)}: ${result.goal}\n${sessionStatus.message}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: {
      type: "submit",
      goal: result.goal,
      providerSession: {
        mode: "fork",
        sourceRunId: result.runId,
        providerSessionId: sessionStatus.providerSessionId,
      },
    },
  });
}

function beginOpenTuiRerunRun(
  state: OpenTuiPreviewUiState,
  runRef: string | undefined,
  input: string,
): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveRerunCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    runRef,
  });
  if (!result.ok || !result.goal) {
    return {
      state: {
        ...state,
        message: result.message || "Unable to rerun.",
        feed: appendOpenTuiFeed(state.feed, "warning", result.message || "Unable to rerun."),
      },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiRunnableIntent(state, {
    title: "Rerun goal?",
    detail: `Auto-run is off. Approve rerun ${shortId(result.runId)}: ${previewText(result.goal, "(no prompt)")}`,
    confirmLabel: "Rerun",
    runningMessage: `Rerunning ${shortId(result.runId)}...`,
    feedKind: "info",
    feedMessage: `Rerunning ${shortId(result.runId)}: ${result.goal}`,
    returnMode: state.mode === "run" ? "run" : "task",
    returnTaskInput: input,
    intent: { type: "submit", goal: result.goal },
  });
}

function beginOpenTuiRunStop(state: OpenTuiPreviewUiState, runRef?: string): OpenTuiPreviewKeyResult {
  const detail = selectedOpenTuiRunDetail(state);
  const result = resolveStopCommand({
    runs: detail?.allRuns || state.dashboard.dashboard.runs,
    runRef,
    currentRunId: detail?.run._id || state.selectedRunId,
  });
  if (!result.ok || !result.runId) {
    return {
      state: { ...state, message: result.message || "Unable to stop task." },
      intent: { type: "none" },
    };
  }
  return beginOpenTuiApprovedIntent(state, {
    safetyAction: "destructive",
    title: "Stop agent task?",
    detail: `Task ${shortId(result.runId)} will be marked cancelled and any supported local/hosted execution will be asked to stop.`,
    confirmLabel: "Stop task",
    runningMessage: `Stopping task ${shortId(result.runId)}...`,
    feedKind: "warning",
    feedMessage: `Stopping task ${shortId(result.runId)}...`,
    returnMode: "run",
    returnTaskInput: state.taskInput,
    intent: { type: "stop-run", runId: result.runId },
  });
}

function selectedPatchWindowStart(selectedIndex: number, count: number, size: number): number {
  if (count <= size) return 0;
  if (selectedIndex <= 1) return 0;
  if (selectedIndex >= count - 2) return count - size;
  return selectedIndex - 2;
}

function formatOpenTuiDiffLine(line: string): string {
  const kind = classifyDiffLine(line);
  if (kind === "add") return `+ ${line}`;
  if (kind === "remove") return `- ${line}`;
  if (kind === "meta") return `@ ${line}`;
  return `  ${line}`;
}

function formatOpenTuiTimestamp(value?: number): string {
  if (!value) return "-";
  return new Date(value).toISOString();
}

function formatOpenTuiRelativeTime(value?: number): string {
  if (!value) return "earlier";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function isPrintableInput(sequence: string): boolean {
  return sequence.length > 0 && !/[\u0000-\u001f\u007f]/.test(sequence);
}

function previewText(text: string | undefined, fallback: string, maxLength = 180): string {
  const value = compact(text, fallback);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

export function applyTaskEventToState(
  state: OpenTuiPreviewUiState,
  event: TuiTaskEvent,
  context: FoldContext,
): OpenTuiPreviewUiState {
  return { ...state, transcript: foldTaskEventIntoTranscript(state.transcript, event, context) };
}
