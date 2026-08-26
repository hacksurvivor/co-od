import { createCliRenderer, Text } from "@opentui/core";
import * as api from "../api-client.js";
import {
  appendOpenTuiFeed,
  completeOpenTuiRenamePreview,
  completeOpenTuiRunCopy,
  completeOpenTuiRunExport,
  completeOpenTuiSymbolNavigation,
  completeOpenTuiPatchResolve,
  completeOpenTuiRunStop,
  completeOpenTuiServerUndo,
  completeOpenTuiTask,
  completeOpenTuiRunDetail,
  completeOpenTuiDiagnostics,
  completeOpenTuiWorkspaceDiff,
  completeOpenTuiWorkspaceSearch,
  completeOpenTuiWorkspaceSymbols,
  createOpenTuiPreviewUiState,
  beginOpenTuiBridgeApproval,
  failOpenTuiRunDetail,
  formatOpenTuiPreviewText,
  handleOpenTuiTerminalEvent,
  loadOpenTuiPreviewStartupState,
  loadOpenTuiPreviewState,
  parseOpenTuiPreviewArgs,
  persistOpenTuiPreviewState,
  reduceOpenTuiPreviewKey,
  reduceOpenTuiPreviewMouse,
  refreshOpenTuiPreviewUiState,
  applyTaskEventToState,
  moveOpenTuiDashboardSelection,
  recallOpenTuiTaskHistory,
  resolvePanelTabs,
  knownOpenTuiRooms,
  type OpenTuiPreviewUiState,
} from "../tui-opentui-preview.js";
import { slashCommandSuggestions } from "../tui-palette.js";
import { normalizeKeySequence } from "../tui-keys.js";
import { ConvexLiveSession, resolveConvexUrl } from "../tui-convex-live.js";
import { createRoomNotifier, type RoomNotifier, type TelegramApprovalCallback } from "../notify.js";
import { appendChatTurn, appendUserMessage } from "../tui-chat-transcript.js";
import { loadRoomDashboardData, loadRunDetailData, resolveRunPatch, restoreServerUndoChanges } from "../tui-dashboard.js";
import type { ProviderSessionContext } from "../adapters/base.js";
import { formatGoalWithAttachments, resolveAttachmentTransport, type TuiAttachmentTransport } from "../tui-attachments.js";
import { fileMentionAttachmentsChanged, resolveFileMentionAttachments } from "../tui-file-mentions.js";
import { formatRunCopyText, writeClipboardText, writeRunSummaryExport } from "../tui-run-export.js";
import { runTuiTask, type TuiTaskEvent } from "../tui-task.js";
import { executeRoomHandoff, type HandoffResolution } from "../tui-handoff.js";
import type { FanoutTarget } from "../tui-fanout.js";
import { connectTuiTerminal, resolveTerminalPaneSize } from "../tui-terminal.js";
import { listWorkspaceFiles, loadWorkspaceDiff, searchWorkspaceText } from "../tui-workspace.js";
import { applyRename, loadRenamePreview, loadSymbolNavigation, loadWorkspaceSymbols } from "../tui-symbols.js";
import { loadWorkspaceDiagnostics } from "../tui-diagnostics.js";
import {
  formatEnvMutation,
  formatEnvStatus,
  type TuiEnvAction,
  type TuiEnvMutationResponse,
  type TuiEnvStatusResponse,
} from "../tui-env.js";
import type { RoomTerminalSession } from "../connect.js";
import { createUndoSnapshot, pushUndoSnapshot, restoreUndoSnapshot } from "../tui-undo.js";
import { opentuiTextColor } from "../tui-theme.js";
import { createStartupTimer, evaluateStartupBudget, formatStartupTiming } from "../tui-startup.js";
import { parseSgrMouse } from "../tui-mouse.js";
import {
  SIDE_RAIL_DEFAULT_WIDTH,
  SIDE_RAIL_MAX_WIDTH,
  SIDE_RAIL_MIN_MAIN_WIDTH,
  SIDE_RAIL_MIN_WIDTH,
  normalizeTaskHistory,
} from "../tui-persistence.js";
import {
  defaultLocalBridgeUrl,
  parseBridgeApprovalSseBlock,
  respondToBridgeApproval,
  type BridgeApprovalDecision,
  type BridgeApprovalRequest,
} from "../tui-bridge-approvals.js";
import { buildTuiLiveQaReport, formatTuiLiveQaReport } from "../tui-qa.js";
import { createElement } from "react";
import { createRoot, type Root as ReactRoot } from "@opentui/react";
import { ChatView } from "./chat-view.js";

async function main(): Promise<void> {
  const args = parseOpenTuiPreviewArgs(process.argv.slice(2));
  const startupTimer = createStartupTimer({ budgetMs: args.startupBudgetMs });
  currentState = createOpenTuiPreviewUiState(loadOpenTuiPreviewStartupState(args));
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  });

  let closing = false;
  let rawInputHandler: ((chunk: Buffer | string) => void) | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let roomRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  const close = (code = 0) => {
    if (closing) return;
    closing = true;
    persistNow();
    roomNotifier?.close();
    if (animationTimer) clearInterval(animationTimer);
    if (roomRefreshTimer) clearInterval(roomRefreshTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    roomStreamStopped = true;
    roomStreamAbort?.abort();
    convexLive?.close();
    if (rawInputHandler) process.stdin.off("data", rawInputHandler);
    process.off("SIGINT", handleSigint);
    bridgeApprovalAbort?.abort();
    terminalSession?.close();
    renderer.destroy();
    process.exit(code);
  };
  const handleSigint = () => close(0);
  process.on("SIGINT", handleSigint);
  rawInputHandler = (chunk) => {
    if (String(chunk).includes("\u0003")) close(0);
  };
  process.stdin.on("data", rawInputHandler);

  const screenSize = () => ({
    width: Math.max(20, (process.stdout.columns || 100) - 2),
    height: Math.max(10, process.stdout.rows || 30),
  });
  const formatScreen = () => formatOpenTuiPreviewText(currentState, screenSize());
  const initialScreenSize = screenSize();

  const chatView = (() => {
    const argv = process.argv.slice(2);
    const index = argv.indexOf("--view");
    return index >= 0 && argv[index + 1] === "chat";
  })();

  let chatRoot: ReactRoot | undefined;
  const renderChat = () => {
    chatRoot?.render(createElement(ChatView, { state: currentState, width: screenSize().width }));
  };
  if (chatView) {
    chatRoot = createRoot(renderer);
    renderChat();
  } else {
    renderer.root.add(Text({
      id: "co-od-opentui-screen",
      content: formatScreen(),
      fg: opentuiTextColor(),
      width: initialScreenSize.width,
      height: initialScreenSize.height,
      wrapMode: "none",
    }));
  }
  const firstPaintTiming = startupTimer.markFirstPaint();
  if (args.startupProfile) {
    currentState = {
      ...currentState,
      message: formatStartupTiming(firstPaintTiming),
    };
  }

  const render = () => {
    // Ref-equality inside observe makes this free on keystroke renders; it
    // only does work when the runs/patches arrays were actually replaced.
    // patches stays undefined until loaded — observe treats that as "no patch
    // knowledge yet", never as "zero patches" (which would burst-notify the
    // backlog when the real payload lands).
    roomNotifier?.observe(
      currentState.dashboard.dashboard.runs || [],
      currentState.dashboard.dashboard.patches,
      currentState.dashboard.config?.roomId,
      notifierRoomContext,
    );
    if (chatRoot) {
      renderChat();
      renderer.requestRender();
      return;
    }
    const screen = renderer.root.getRenderable("co-od-opentui-screen") as { content?: string; width?: number; height?: number } | undefined;
    if (screen) {
      const size = screenSize();
      screen.width = size.width;
      screen.height = size.height;
      screen.content = formatOpenTuiPreviewText(currentState, size);
    }
    renderer.requestRender();
  };
  if (args.startupProfile) render();
  if (chatView) {
    animationTimer = setInterval(() => {
      const animating = currentState.taskRunning
        || currentState.transcript.some((message) => message.streaming)
        || currentState.dashboard.dashboard.runs.some((run) => ["queued", "running", "in_progress"].includes(run.status || ""));
      if (animating) render();
    }, 140);
  }
  // Persisting rewrites the whole multi-project state file synchronously —
  // doing that inside the input handler made typing latency grow with run
  // history. Debounce to a trailing write; close() flushes whatever is pending.
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const persistNow = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = undefined;
    persistOpenTuiPreviewState(currentState);
  };
  const persist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 400);
  };
  roomNotifier = createRoomNotifier();
  roomNotifier?.setRemoteDecisionHandler((callback) =>
    handleRemoteApprovalDecision(callback, (nextState) => {
      currentState = nextState;
      render();
    }),
  );
  // Delivery failures are non-fatal but never silent — a user who expects to
  // approve from their phone must see that the bot is unreachable.
  roomNotifier?.setProblemHandler((problem) => {
    currentState = {
      ...currentState,
      feed: appendOpenTuiFeed(currentState.feed, "warning", problem),
    };
    render();
  });
  let sideRailResizeActive = false;
  const terminalColumns = () => Math.max(60, process.stdout.columns || 100);
  const clampSideRailWidth = (width: number) => {
    const max = Math.max(SIDE_RAIL_MIN_WIDTH, Math.min(SIDE_RAIL_MAX_WIDTH, terminalColumns() - SIDE_RAIL_MIN_MAIN_WIDTH));
    return Math.max(SIDE_RAIL_MIN_WIDTH, Math.min(max, Math.round(width)));
  };
  const dividerColumn = () => terminalColumns() - clampSideRailWidth(currentState.sideRailWidth || SIDE_RAIL_DEFAULT_WIDTH) + 1;
  const resizeSideRailFromColumn = (column: number) => {
    const nextWidth = clampSideRailWidth(terminalColumns() - column + 1);
    if (nextWidth === currentState.sideRailWidth) return;
    currentState = {
      ...currentState,
      sideRailWidth: nextWidth,
      message: `Side panel ${nextWidth} cols.`,
    };
    persist();
    render();
  };

  seedSeenChat(currentState);
  void refreshAfterFirstPaint(args, startupTimer, (nextState) => {
    currentState = nextState;
    // Everything loaded so far is history, not news — fold only what arrives
    // from here on. Then keep the room alive on a quiet 6s pulse.
    seedSeenChat(currentState);
    persist();
    render();
    if (chatView && !roomRefreshTimer) {
      void startConvexLive(render);
      void runRoomStream(render);
      void sendPresenceHeartbeat();
      presenceTimer = setInterval(() => void sendPresenceHeartbeat(), 20_000);
      roomRefreshTimer = setInterval(() => {
        if (convexLiveHealthy || roomStreamHealthy) return; // live transports own this
        void refreshRoomData().then((changed) => {
          if (changed) render();
        });
      }, 6000);
    }
  });

  renderer.addInputHandler((rawSequence) => {
    // Terminals on the kitty keyboard protocol (Ghostty, Kitty, recent
    // WezTerm) deliver keys as CSI-u sequences — translate them back to the
    // legacy bytes every comparison below (and in the reducer) expects.
    // Key-release events normalize to "" and must be swallowed.
    const sequence = normalizeKeySequence(rawSequence);
    if (sequence === "") return true;
    // Ctrl+B shows/hides the room panel (agents / work / chat). Chat-first by
    // default; the preference persists per project.
    if (chatView && (currentState.mode === "dashboard" || currentState.mode === "task")
      && sequence === "\u0002") {
      const panelVisible = !currentState.panelVisible;
      currentState = {
        ...currentState,
        panelVisible,
        message: panelVisible ? "Room panel shown. \u2303B hides it." : "Room panel hidden. \u2303B brings it back.",
      };
      persist();
      render();
      return true;
    }
    const mouseEvent = parseSgrMouse(sequence);
    if (chatView && currentState.panelVisible && mouseEvent && (currentState.mode === "dashboard" || currentState.mode === "task")) {
      if (mouseEvent.type === "release") {
        const wasResizing = sideRailResizeActive;
        sideRailResizeActive = false;
        if (wasResizing) return true;
      }
      if (mouseEvent.type === "press" && mouseEvent.button === 0 && Math.abs(mouseEvent.column - dividerColumn()) <= 1) {
        sideRailResizeActive = true;
        resizeSideRailFromColumn(mouseEvent.column);
        return true;
      }
      if (mouseEvent.type === "drag" && sideRailResizeActive) {
        resizeSideRailFromColumn(mouseEvent.column);
        return true;
      }
    }
    // Esc clears the current draft (and any slash autocomplete). No overlay to
    // close here, so "cancel" means "clear what I'm typing" — nothing more.
    // The draft lands in history first, so ↑ brings it straight back.
    if (chatView && (currentState.mode === "dashboard" || currentState.mode === "task")
      && sequence === "\x1b") {
      if (currentState.taskInput) {
        currentState = {
          ...currentState,
          taskInput: "",
          taskCursor: 0,
          taskSuggestionSelected: 0,
          taskHistory: normalizeTaskHistory(currentState.taskHistory, currentState.taskInput),
          message: currentState.panelVisible ? "Cleared — ⌥↑ brings it back." : "Cleared — ↑ brings it back.",
        };
        persist();
        render();
      }
      return true;
    }
    // Rail navigation — only while the rail is on screen (⌃B), with an empty
    // composer (typing always wins). ←/→ switch the tab (room · chat ·
    // projects), ↑/↓ move the active tab's cursor, ⏎ confirms. History recall
    // is ⌥↑/⌥↓ while the rail is open (never ⌃arrows — macOS owns those for
    // Mission Control / Spaces); with the rail hidden, plain ↑ is history.
    if (chatView && currentState.panelVisible && (currentState.mode === "dashboard" || currentState.mode === "task")) {
      const composerEmpty = currentState.taskInput.length === 0;
      const isUp = sequence === "\x1b[A";
      const isDown = sequence === "\x1b[B";
      const isLeft = sequence === "\x1b[D";
      const isRight = sequence === "\x1b[C";
      const altUp = sequence === "\x1b[1;3A" || sequence === "\x1b\x1b[A";
      const altDown = sequence === "\x1b[1;3B" || sequence === "\x1b\x1b[B";
      if (altUp || altDown) {
        const result = recallOpenTuiTaskHistory({ ...currentState, mode: "task" }, altUp ? -1 : 1);
        currentState = result.state;
        persist();
        render();
        return true;
      }
      if ((isLeft || isRight) && composerEmpty) {
        const tabs = resolvePanelTabs(currentState.dashboard.config);
        const at = Math.max(0, tabs.indexOf(currentState.panelTab));
        currentState = {
          ...currentState,
          panelTab: tabs[(at + (isRight ? 1 : -1) + tabs.length) % tabs.length],
          railChatSelected: undefined,
          railProjectSelected: undefined,
        };
        persist();
        render();
        return true;
      }
      if ((isUp || isDown) && composerEmpty) {
        const dir = isDown ? 1 : -1;
        if (currentState.panelTab === "chat") {
          const total = Math.min(16, (currentState.dashboard.dashboard.messages || []).length);
          const fallback = Math.max(0, total - 1);
          const at = currentState.railChatSelected ?? fallback;
          currentState = {
            ...currentState,
            railChatSelected: Math.max(0, Math.min(Math.max(0, total - 1), at + dir)),
          };
        } else if (currentState.panelTab === "projects") {
          const rooms = knownOpenTuiRooms(currentState);
          const currentIndex = Math.max(0, rooms.findIndex((room) => room.roomId === currentState.dashboard.config?.roomId));
          const at = currentState.railProjectSelected ?? currentIndex;
          currentState = {
            ...currentState,
            railProjectSelected: Math.max(0, Math.min(Math.max(0, rooms.length - 1), at + dir)),
          };
        } else {
          currentState = moveOpenTuiDashboardSelection({ ...currentState, dashboardFocus: "agents" }, dir);
        }
        persist();
        render();
        return true;
      }
      if (sequence === "\r" && currentState.taskInput.trim() === "") {
        if (currentState.panelTab === "chat") {
          // Reply affordance: drop a `# ` into the composer.
          currentState = {
            ...currentState,
            mode: "task",
            taskInput: "# ",
            taskCursor: 2,
            message: "Replying to the room — ⏎ sends.",
          };
          render();
          return true;
        }
        if (currentState.panelTab === "projects") {
          const rooms = knownOpenTuiRooms(currentState);
          const currentIndex = Math.max(0, rooms.findIndex((room) => room.roomId === currentState.dashboard.config?.roomId));
          const room = rooms[currentState.railProjectSelected ?? currentIndex];
          if (room && room.roomId !== currentState.dashboard.config?.roomId) {
            roomStreamAbort?.abort();
            void selectRoom(room.roomId, room.roomName, (nextState) => {
              currentState = nextState;
              render();
            });
          }
          return true;
        }
        // Room tab: a pending review outranks browsing; otherwise open the
        // selected agent's latest task.
        const proposedPatch = (currentState.dashboard.dashboard.patches || [])
          .find((patch) => patch.status === "proposed" && patch.run_id);
        const latestRun = currentState.dashboard.dashboard.runs
          .find((run) => run.agent_id === currentState.selectedAgentId);
        const targetRunId = proposedPatch?.run_id || latestRun?._id;
        if (targetRunId) {
          void loadRunDetail(targetRunId, (nextState) => {
            currentState = nextState;
            render();
          });
          return true;
        }
      }
    }
    // Chat is composer-first: never sit in dashboard mode, so keystrokes land in
    // the composer instead of firing single-key shortcuts. Commands stay reachable
    // via the palette (Ctrl+P) and slash commands.
    const inputState = chatView && currentState.mode === "dashboard"
      ? { ...currentState, mode: "task" as const }
      : currentState;
    const mouse = inputState.mode === "terminal" ? null : mouseEvent;
    const result = mouse
      ? reduceOpenTuiPreviewMouse(inputState, mouse, screenSize())
      : reduceOpenTuiPreviewKey(inputState, sequence);
    currentState = result.state;
    persist();
    render();
    if (result.intent.type === "quit") {
      close();
      return true;
    }
    if (result.intent.type === "chat-message") {
      void sendChatMessage(result.intent.bodyMd, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "submit") {
      void submitTask(result.intent.goal, (nextState) => {
        currentState = nextState;
        render();
      }, { provider: result.intent.provider, agentId: result.intent.agentId, continueRunId: result.intent.continueRunId, providerSession: result.intent.providerSession });
      return true;
    }
    if (result.intent.type === "agent-add") {
      void addAgent(result.intent, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "load-run") {
      void loadRunDetail(result.intent.runId, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "resolve-patch") {
      void resolvePatch(
        result.intent.runId,
        result.intent.patchId,
        result.intent.action,
        (nextState) => {
          currentState = nextState;
          render();
        },
      );
      return true;
    }
    if (result.intent.type === "server-undo") {
      void restoreServerUndo(result.intent.snapshot, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "connect-terminal") {
      void connectTerminal((nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "terminal-input") {
      terminalSession?.write(result.intent.data);
      return true;
    }
    if (result.intent.type === "bridge-approval") {
      void resolveBridgeApproval(
        result.intent.approvalId,
        result.intent.decision,
        result.intent.target,
        (nextState) => {
          currentState = nextState;
          render();
        },
      );
      return true;
    }
    if (result.intent.type === "copy-run") {
      copyRun(result.intent.kind, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "export-run") {
      exportRun((nextState) => {
        currentState = nextState;
        render();
      }, result.intent.outputPath);
      return true;
    }
    if (result.intent.type === "stop-run") {
      void stopRun(result.intent.runId, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "fanout") {
      void runFanout(result.intent.goal, result.intent.targets, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "handoff") {
      void runHandoff(result.intent.resolution, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "agent-start") {
      void submitTask(result.intent.goal, (nextState) => {
        currentState = nextState;
        render();
      }, {
        provider: result.intent.provider,
        agentId: result.intent.agentId,
      });
      return true;
    }
    if (result.intent.type === "agent-stop") {
      void stopAgentRuns(result.intent.agentName, result.intent.runIds, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "agent-pause") {
      void pauseAgentRuns(result.intent.agentName, result.intent.runIds, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "agent-resume") {
      void resumeAgentRuns(result.intent.agentName, result.intent.agentId, result.intent.runIds, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "runtime-action") {
      void runRuntimeAction(result.intent.action, result.intent.ttlSeconds, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "login") {
      void runLoginFlow((nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "init-project") {
      void runProjectInit((nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "open-browser") {
      void openBrowser(result.intent.url, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "select-room") {
      roomStreamAbort?.abort();
      void selectRoom(result.intent.roomId, result.intent.roomName, (nextState) => {
        currentState = nextState;
        retargetConvexLive();
        render();
      });
      return true;
    }
    if (result.intent.type === "search-workspace") {
      void showWorkspaceSearch(result.intent.query, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "workspace-diff") {
      void showWorkspaceDiff(result.intent.path, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "list-symbols") {
      void showWorkspaceSymbols(result.intent.query, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "goto-symbol") {
      void showSymbolNavigation(result.intent.query, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "rename-preview") {
      void showRenamePreview(result.intent.oldName, result.intent.newName, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "rename-apply") {
      void applySymbolRename(result.intent.oldName, result.intent.newName, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "diagnostics") {
      void showDiagnostics(result.intent.project, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    if (result.intent.type === "live-qa") {
      void runLiveQa(result.intent.roomId, result.intent.includeTerminal, result.intent.bridgeUrl, (nextState) => {
        currentState = nextState;
        render();
      });
      return true;
    }
    return result.intent.type !== "none" || sequence.length > 0;
  });

  if (args.durationMs > 0) {
    setTimeout(() => {
      const budget = evaluateStartupBudget(startupTimer.snapshot());
      close(args.startupBudgetMs !== undefined && !budget.ok ? 1 : 0);
    }, args.durationMs);
  }
}

async function refreshAfterFirstPaint(
  args: Parameters<typeof loadOpenTuiPreviewState>[0],
  startupTimer: ReturnType<typeof createStartupTimer>,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  try {
    const latest = await loadOpenTuiPreviewState(args);
    currentState = refreshOpenTuiPreviewUiState(currentState, latest);
    const refreshTiming = startupTimer.markRefreshComplete();
    if (args.startupProfile) {
      currentState = {
        ...currentState,
        feed: appendOpenTuiFeed(currentState.feed, "info", formatStartupTiming(refreshTiming)),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...currentState,
      message,
      feed: appendOpenTuiFeed(currentState.feed, "warning", `Live dashboard refresh failed: ${message}`),
    };
  }
  update(currentState);
}

function copyRun(kind: Parameters<typeof completeOpenTuiRunCopy>[1], update: (state: OpenTuiPreviewUiState) => void): void {
  const state = currentState;
  const detail = state.selectedRunDetail;
  if (!detail) {
    currentState = {
      ...state,
      message: "No run loaded to copy.",
      feed: appendOpenTuiFeed(state.feed, "error", "copy: No run loaded to copy."),
    };
    update(currentState);
    return;
  }

  try {
    const text = formatRunCopyText({
      detail,
      kind,
      selectedPatchIndex: state.selectedPatchIndex,
      agentName: (agentId) => agentName(state, agentId),
    });
    writeClipboardText(text);
    currentState = completeOpenTuiRunCopy(state, kind);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `copy: ${message}`),
    };
  }
  update(currentState);
}

function startBridgeApprovalStream(
  agentId: string | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): AbortController | undefined {
  if (!agentId) return undefined;

  const bridgeUrl = defaultLocalBridgeUrl();
  const controller = new AbortController();
  bridgeApprovalAbort?.abort();
  bridgeApprovalAbort = controller;

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
        if (approval) handleBridgeApprovalRequest(approval, update);
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted && currentState.taskRunning) {
      currentState = {
        ...currentState,
        message: "approvals offline",
        feed: appendOpenTuiFeed(currentState.feed, "warning", "approvals are offline — agents pause for your OK until the bridge reconnects"),
      };
      update(currentState);
    }
  });

  return controller;
}

function handleBridgeApprovalRequest(
  approval: BridgeApprovalRequest,
  update: (state: OpenTuiPreviewUiState) => void,
): void {
  if (activeBridgeApprovals.has(approval.approvalId)) return;
  activeBridgeApprovals.add(approval.approvalId);
  currentState = beginOpenTuiBridgeApproval(currentState, approval);
  const context = notifierRoomContext();
  roomNotifier?.approvalRequested(approval, {
    roomName: context.roomName,
    agentName: context.agentName(approval.agentId),
  });
  update(currentState);
}

async function resolveBridgeApproval(
  approvalId: string,
  decision: BridgeApprovalDecision,
  target: string,
  update: (state: OpenTuiPreviewUiState) => void,
  via: "tui" | "telegram" = "tui",
): Promise<boolean> {
  // A keyboard press and a Telegram tap can land within one network
  // round-trip. Whoever claims the approval first wins; the loser no-ops
  // instead of double-posting the decision to the bridge.
  if (resolvingBridgeApprovals.has(approvalId)) return false;
  resolvingBridgeApprovals.add(approvalId);
  let resolved = false;
  try {
    await respondToBridgeApproval({ approvalId, decision });
    resolved = true;
    roomNotifier?.approvalResolved(approvalId, decision, via);
    const verb = decision === "approve" ? "approved" : "denied";
    currentState = {
      ...currentState,
      message: `Bridge approval ${verb}.`,
      feed: appendOpenTuiFeed(
        currentState.feed,
        decision === "approve" ? "success" : "warning",
        `Bridge approval ${verb}: ${target}`,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...currentState,
      message,
      feed: appendOpenTuiFeed(currentState.feed, "error", `Bridge approval response failed: ${message}`),
    };
  } finally {
    activeBridgeApprovals.delete(approvalId);
    resolvingBridgeApprovals.delete(approvalId);
    update(currentState);
  }
  return resolved;
}

function exportRun(update: (state: OpenTuiPreviewUiState) => void, outputPath?: string): void {
  const state = currentState;
  const detail = state.selectedRunDetail;
  if (!detail) {
    currentState = {
      ...state,
      message: "No run loaded to export.",
      feed: appendOpenTuiFeed(state.feed, "error", "export: No run loaded to export."),
    };
    update(currentState);
    return;
  }

  try {
    const result = writeRunSummaryExport({
      detail,
      projectDir: state.args.dir,
      outputPath,
      agentName: (agentId) => agentName(state, agentId),
    });
    const undoStack = result.fileChange
      ? pushUndoSnapshot(state.undoStack, createUndoSnapshot({
        label: `export run ${detail.run._id}`,
        provider: state.dashboard.provider,
        model: state.model,
        selectedAgentId: state.selectedAgentId,
        attachments: state.attachments,
        pins: state.pins,
        safety: state.safety,
        fileChanges: [result.fileChange],
      }))
      : state.undoStack;
    currentState = {
      ...completeOpenTuiRunExport(state, result.path, Boolean(result.fileChange)),
      undoStack,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `export: ${message}`),
    };
  }
  update(currentState);
}

async function showWorkspaceSearch(
  query: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await searchWorkspaceText({
    dir: state.args.dir,
    query,
    limit: 25,
  });

  state = currentState;
  currentState = completeOpenTuiWorkspaceSearch(state, result);
  update(currentState);
}

async function openBrowser(url: string, update: (state: OpenTuiPreviewUiState) => void): Promise<void> {
  let state = currentState;
  try {
    const open = (await import("open")).default;
    await open(url);
    currentState = {
      ...state,
      message: `Opened ${url}`,
      feed: appendOpenTuiFeed(state.feed, "success", `Opened browser workspace: ${url}`),
    };
  } catch {
    state = currentState;
    currentState = {
      ...state,
      message: `Open manually: ${url}`,
      feed: appendOpenTuiFeed(state.feed, "warning", `Open manually: ${url}`),
    };
  }
  update(currentState);
}

async function runLoginFlow(update: (state: OpenTuiPreviewUiState) => void): Promise<void> {
  const state = currentState;
  try {
    currentState = {
      ...state,
      message: "Login flow running...",
      feed: appendOpenTuiFeed(state.feed, "info", "Login flow running..."),
    };
    update(currentState);
    const { run } = await import("./login.js");
    await run(state.args.server ? ["--server", state.args.server] : []);
    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: appendOpenTuiFeed(currentState.feed, "success", "Login complete."),
      message: "Login complete.",
      attachments: state.attachments,
      taskHistory: state.taskHistory,
      model: state.model,
    };
    persistOpenTuiPreviewState(currentState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `login: ${message}`),
    };
  }
  update(currentState);
}

async function runProjectInit(update: (state: OpenTuiPreviewUiState) => void): Promise<void> {
  const state = currentState;
  try {
    currentState = {
      ...state,
      message: "Project init running...",
      feed: appendOpenTuiFeed(state.feed, "info", "Project init running..."),
    };
    update(currentState);
    const { run } = await import("./init.js");
    const initArgs = ["--dir", state.args.dir, "--provider", state.dashboard.provider];
    if (state.args.server) initArgs.push("--server", state.args.server);
    await run(initArgs);
    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: appendOpenTuiFeed(currentState.feed, "success", "Project initialized."),
      message: "Project initialized.",
      attachments: state.attachments,
      taskHistory: state.taskHistory,
      model: state.model,
    };
    persistOpenTuiPreviewState(currentState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `init: ${message}`),
    };
  }
  update(currentState);
}

async function selectRoom(
  roomId: string,
  roomName: string | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  const state = currentState;
  try {
    const latest = await loadOpenTuiPreviewState({ ...state.args, roomId });
    const next = createOpenTuiPreviewUiState(latest);
    currentState = {
      ...next,
      dashboard: {
        ...next.dashboard,
        config: next.dashboard.config && roomName
          ? { ...next.dashboard.config, roomName }
          : next.dashboard.config,
      },
      feed: appendOpenTuiFeed(state.feed, "info", `✓ ${roomName || roomId}`),
      message: `✓ ${roomName || roomId} — switched`,
      attachments: state.attachments,
      taskHistory: state.taskHistory,
      model: state.model,
    };
    persistOpenTuiPreviewState(currentState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `room: ${message}`),
    };
  }
  update(currentState);
}

async function runRuntimeAction(
  action: TuiEnvAction,
  ttlSeconds: number | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before controlling the hosted runtime.");
    update(currentState);
    return;
  }

  try {
    if (action === "status") {
      const status = await api.get<TuiEnvStatusResponse>(`/api/rooms/${config.roomId}/env/status`);
      state = currentState;
      currentState = completeOpenTuiTask(state, "info", formatEnvStatus(status));
      update(currentState);
      return;
    }

    const response = await api.post<TuiEnvMutationResponse>(
      `/api/rooms/${config.roomId}/env/${action}`,
      action === "start" && ttlSeconds ? { ttlSeconds } : {},
    );
    state = currentState;
    currentState = completeOpenTuiTask(
      state,
      action === "stop" ? "warning" : "success",
      formatEnvMutation(action, response),
    );
  } catch (error) {
    state = currentState;
    const message = error instanceof Error ? error.message : String(error);
    currentState = completeOpenTuiTask(state, "error", `runtime ${action}: ${message}`);
  }
  update(currentState);
}

async function showWorkspaceSymbols(
  query: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await loadWorkspaceSymbols({
    dir: state.args.dir,
    query,
    limit: 40,
  });

  state = currentState;
  currentState = completeOpenTuiWorkspaceSymbols(state, result);
  update(currentState);
}

async function showWorkspaceDiff(
  path: string | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await loadWorkspaceDiff({
    dir: state.args.dir,
    path,
    limit: 240,
  });

  state = currentState;
  currentState = completeOpenTuiWorkspaceDiff(state, result);
  update(currentState);
}

async function showSymbolNavigation(
  query: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await loadSymbolNavigation({
    dir: state.args.dir,
    query,
  });

  state = currentState;
  currentState = completeOpenTuiSymbolNavigation(state, result);
  update(currentState);
}

async function showRenamePreview(
  oldName: string,
  newName: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await loadRenamePreview({
    dir: state.args.dir,
    oldName,
    newName,
  });

  state = currentState;
  currentState = completeOpenTuiRenamePreview(state, result);
  update(currentState);
}

async function applySymbolRename(
  oldName: string,
  newName: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await applyRename({
    dir: state.args.dir,
    oldName,
    newName,
  });

  state = currentState;
  const nextUndoStack = !result.error && result.changedFiles.length > 0
    ? pushUndoSnapshot(state.undoStack, createUndoSnapshot({
      label: `rename ${result.oldName} -> ${result.newName}`,
      provider: state.dashboard.provider,
      model: state.model,
      selectedAgentId: state.selectedAgentId,
      attachments: state.attachments,
      pins: state.pins,
      safety: state.safety,
      fileChanges: result.fileChanges,
    }))
    : state.undoStack;
  currentState = {
    ...state,
    undoStack: nextUndoStack,
    message: result.message,
    feed: appendOpenTuiFeed(
      state.feed,
      result.error ? "error" : result.changedFiles.length > 0 ? "success" : "warning",
      result.error || result.changedFiles.length === 0
        ? `rename: ${result.message}`
        : [
          result.message,
          `Changed files: ${result.changedFiles.join(", ")}`,
          "Use /undo to restore these file edits.",
        ].join("\n"),
    ),
  };
  update(currentState);
}

async function showDiagnostics(
  project: string | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const result = await loadWorkspaceDiagnostics({
    dir: state.args.dir,
    request: project,
    timeoutMs: 20_000,
  });

  state = currentState;
  currentState = completeOpenTuiDiagnostics(state, result);
  update(currentState);
}

async function runLiveQa(
  roomId: string | undefined,
  includeTerminal: boolean,
  bridgeUrl: string | undefined,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  const state = currentState;
  try {
    const report = await buildTuiLiveQaReport({
      dir: state.args.dir,
      roomId: roomId || state.dashboard.config?.roomId,
      serverUrl: state.args.server || api.getBaseUrl(),
      includeTerminal,
      allowMutations: false,
      bridgeUrl,
      getSession: api.getSession,
      apiGet: api.get,
    });
    currentState = {
      ...currentState,
      message: report.ok ? "Live TUI QA passed." : "Live TUI QA found blockers.",
      feed: appendOpenTuiFeed(currentState.feed, report.ok ? "success" : "error", formatTuiLiveQaReport(report)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...currentState,
      message,
      feed: appendOpenTuiFeed(currentState.feed, "error", `live QA: ${message}`),
    };
  }
  update(currentState);
}

async function stopRun(runId: string, update: (state: OpenTuiPreviewUiState) => void): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = failOpenTuiRunDetail(state, "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = failOpenTuiRunDetail(state, "Not logged in. Login before stopping runs.");
    update(currentState);
    return;
  }

  try {
    await api.del(`/api/rooms/${config.roomId}/agent-runs/${runId}`);
    const detail = await loadRunDetailData({ roomId: config.roomId, runId });
    state = currentState;
    currentState = completeOpenTuiRunStop(state, detail, runId);
  } catch (error) {
    state = currentState;
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `stop: ${message}`),
    };
  }
  update(currentState);
}

async function stopAgentRuns(
  agentName: string,
  runIds: string[],
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before stopping agent tasks.");
    update(currentState);
    return;
  }

  try {
    for (const runId of runIds) {
      await api.del(`/api/rooms/${config.roomId}/agent-runs/${runId}`);
      state = currentState;
      currentState = {
        ...state,
        feed: appendOpenTuiFeed(state.feed, "warning", `Stopped ${agentName}: ${runId}`),
      };
      update(currentState);
    }
    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: currentState.feed,
      message: `Stopped ${runIds.length} active task${runIds.length === 1 ? "" : "s"} for ${agentName}.`,
      selectedAgentId: currentState.selectedAgentId,
      selectedRunId: runIds[0] || currentState.selectedRunId,
      attachments: currentState.attachments,
      taskHistory: currentState.taskHistory,
      taskRunning: false,
    };
  } catch (error) {
    state = currentState;
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      taskRunning: false,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `agent-stop: ${message}`),
    };
  }
  update(currentState);
}

async function pauseAgentRuns(
  agentName: string,
  runIds: string[],
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before pausing agent tasks.");
    update(currentState);
    return;
  }

  try {
    for (const runId of runIds) {
      await api.post(`/api/rooms/${config.roomId}/agent-runs/${runId}/pause`, {});
      state = currentState;
      currentState = {
        ...state,
        feed: appendOpenTuiFeed(state.feed, "warning", `Paused ${agentName}: ${runId}`),
      };
      update(currentState);
    }
    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: currentState.feed,
      message: `Paused ${runIds.length} active task${runIds.length === 1 ? "" : "s"} for ${agentName}.`,
      selectedAgentId: currentState.selectedAgentId,
      selectedRunId: runIds[0] || currentState.selectedRunId,
      attachments: currentState.attachments,
      taskHistory: currentState.taskHistory,
      taskRunning: false,
    };
  } catch (error) {
    state = currentState;
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      taskRunning: false,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `agent-pause: ${message}`),
    };
  }
  update(currentState);
}

async function resumeAgentRuns(
  agentName: string,
  agentId: string,
  runIds: string[],
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  for (const runId of runIds) {
    currentState = {
      ...currentState,
      feed: appendOpenTuiFeed(currentState.feed, "info", `Resuming ${agentName}: ${runId}`),
    };
    update(currentState);
    await submitTask(
      "Resume this paused run. Review the prior context and continue with the next useful step.",
      update,
      { agentId, continueRunId: runId },
    );
  }
}

async function runFanout(
  goal: string,
  targets: FanoutTarget[],
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before running room actions.");
    update(currentState);
    return;
  }

  const dispatch = beginRunnableDispatch(`fanout:${config.roomId}:${goal.trim()}`, update);
  if (!dispatch) return;
  try {
    const submitted = await formatSubmittedGoal(goal, state, update);
    state = currentState;

    for (const target of targets) {
      state = currentState;
      currentState = {
        ...state,
        message: `Fan-out target ${target.name}...`,
        feed: appendOpenTuiFeed(state.feed, "info", `Fan-out target ${target.name} (${target.provider})`),
      };
      update(currentState);

      const fanoutUserMessageId = `u${currentState.transcript.length}`;
      currentState = {
        ...currentState,
        transcript: appendUserMessage(currentState.transcript, submitted.goal, fanoutUserMessageId),
      };
      update(currentState);
      const fanoutAgentMessageId = `m${currentState.transcript.length}`;

      const approvalStream = startBridgeApprovalStream(target.agentId, update);
      try {
        const result = await runTuiTask({
          roomId: config.roomId,
          goal: submitted.goal,
          provider: target.provider,
          model: target.provider === state.dashboard.provider ? state.model : undefined,
          dir: state.args.dir,
          agentId: target.agentId,
          attachments: submitted.attachments,
          onEvent: (event) => handleTaskEvent(event, fanoutAgentMessageId, target.name, update),
        });
        if (!result.ok) {
          state = currentState;
          currentState = {
            ...state,
            feed: appendOpenTuiFeed(state.feed, "error", `${target.name}: ${result.errorMessage}`),
          };
          update(currentState);
        }
      } finally {
        approvalStream?.abort();
        if (bridgeApprovalAbort === approvalStream) bridgeApprovalAbort = null;
      }
    }

    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      transcript: currentState.transcript,
      feed: currentState.feed,
      message: "Fan-out complete.",
      selectedAgentId: currentState.selectedAgentId,
      selectedRunId: currentState.selectedRunId,
      attachments: currentState.attachments,
      taskHistory: currentState.taskHistory,
      model: currentState.model,
      taskRunning: false,
    };
    update(currentState);
  } finally {
    endRunnableDispatch(dispatch);
  }
}

async function runHandoff(
  resolution: HandoffResolution,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before running room actions.");
    update(currentState);
    return;
  }

  const dispatch = beginRunnableDispatch(`handoff:${config.roomId}:${resolution.sourceRunId}:${resolution.targetAgentId}`, update);
  if (!dispatch) return;
  try {
    const result = await executeRoomHandoff({
      roomId: config.roomId,
      sourceRunId: resolution.sourceRunId,
      targetAgentId: resolution.targetAgentId,
      targetProvider: resolution.targetProvider,
      context: resolution.context,
      goal: resolution.goal,
      delegation: resolution.delegation,
      model: resolution.targetProvider === state.dashboard.provider ? state.model : undefined,
      dir: state.args.dir,
      onStatus: (message) => {
        state = currentState;
        currentState = {
          ...state,
          message,
          feed: appendOpenTuiFeed(state.feed, "info", message),
        };
        update(currentState);
      },
      onOutput: (data) => {
        state = currentState;
        currentState = {
          ...state,
          feed: appendOpenTuiFeed(state.feed, "output", data),
        };
        update(currentState);
      },
    });

    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: appendOpenTuiFeed(
        currentState.feed,
        result.status === "failed" ? "error" : "success",
        `Handoff ${result.status}: ${result.newRunId}${result.executedLocally ? " (local execution complete)" : ""}`,
      ),
      message: `Handoff ${result.status}.`,
      selectedAgentId: currentState.selectedAgentId,
      selectedRunId: result.newRunId,
      taskHistory: currentState.taskHistory,
      attachments: currentState.attachments,
      model: currentState.model,
      taskRunning: false,
    };
  } catch (error) {
    state = currentState;
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      taskRunning: false,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `handoff: ${message}`),
    };
  } finally {
    endRunnableDispatch(dispatch);
  }
  update(currentState);
}

async function connectTerminal(update: (state: OpenTuiPreviewUiState) => void): Promise<void> {
  let state = currentState;
  if (terminalSession) {
    currentState = { ...state, mode: "terminal", message: "Shared terminal input active." };
    update(currentState);
    return;
  }

  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = handleOpenTuiTerminalEvent(state, {
      type: "error",
      message: "No room configured. Initialize this directory first.",
    });
    update(currentState);
    return;
  }
  const sessionToken = state.dashboard.session?.sessionToken;
  if (!sessionToken) {
    currentState = handleOpenTuiTerminalEvent(state, {
      type: "error",
      message: "Not logged in. Login before connecting the shared terminal.",
    });
    update(currentState);
    return;
  }

  const result = await connectTuiTerminal({
    roomId: config.roomId,
    workDir: state.args.dir,
    serverUrl: config.server || state.args.server || "https://co-od.dev",
    sessionToken,
    ...resolveTerminalPaneSize(process.stdout.columns, process.stdout.rows),
    onEvent: (event) => {
      state = currentState;
      currentState = handleOpenTuiTerminalEvent(state, event);
      if (event.type === "closed") terminalSession = null;
      update(currentState);
    },
  });

  if (result.ok) {
    terminalSession = result.session;
  }
}

function agentName(state: OpenTuiPreviewUiState, agentId?: string): string {
  const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === agentId);
  return agent?.name || agentId || "unknown";
}

async function resolvePatch(
  runId: string,
  patchId: string,
  action: "accept" | "reject",
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = failOpenTuiRunDetail(state, "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = failOpenTuiRunDetail(state, "Not logged in. Login before resolving patches.");
    update(currentState);
    return;
  }

  try {
    await resolveRunPatch({
      roomId: config.roomId,
      patchId,
      action,
    });
    const detail = await loadRunDetailData({ roomId: config.roomId, runId });
    state = currentState;
    currentState = completeOpenTuiPatchResolve(state, detail, action, patchId);
  } catch (error) {
    state = currentState;
    currentState = failOpenTuiRunDetail(
      state,
      `Patch ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  update(currentState);
}

async function restoreServerUndo(
  snapshot: OpenTuiPreviewUiState["undoStack"][number],
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const serverChanges = snapshot.serverChanges || [];
  try {
    const result = await restoreServerUndoChanges({ changes: serverChanges });
    state = currentState;
    if (!result.ok) {
      currentState = {
        ...state,
        message: result.message,
        feed: appendOpenTuiFeed(state.feed, "error", result.message),
      };
      update(currentState);
      return;
    }
    const restored = restoreUndoSnapshot(snapshot, state.safety);
    currentState = completeOpenTuiServerUndo(
      state,
      snapshot,
      restored,
      result.changed.map((change) => change.patchId),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state = currentState;
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `undo: ${message}`),
    };
  }
  update(currentState);
}

async function loadRunDetail(
  runId: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = failOpenTuiRunDetail(state, "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = failOpenTuiRunDetail(state, "Not logged in. Login before inspecting runs.");
    update(currentState);
    return;
  }

  try {
    const detail = await loadRunDetailData({ roomId: config.roomId, runId });
    state = currentState;
    currentState = completeOpenTuiRunDetail(state, detail);
    const pending = currentState.pendingRunAction;
    if (pending) {
      currentState = { ...currentState, pendingRunAction: undefined };
      if (pending.type === "copy") {
        copyRun(pending.kind, update);
        return;
      }
      exportRun(update, pending.outputPath);
      return;
    }
  } catch (error) {
    state = currentState;
    currentState = failOpenTuiRunDetail(
      state,
      `Task detail unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  update(currentState);
}

async function addAgent(
  request: { name: string; provider?: string; model?: string },
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  const state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  // Agent creation defaults to OpenCode. The room shell stays co·ode-native,
  // but new local coding agents should get the OpenCode execution path unless
  // the user explicitly asks for another provider.
  const provider = request.provider || "opencode";
  const executionMode = provider === "codex" ? "local_codex"
    : provider === "opencode" ? "local_opencode"
    : provider === "hermes" ? "local_hermes"
    : provider === "openclaw" || provider === "zeroclaw" ? "local_openclaw"
    : "local_claude_code";
  try {
    await api.post(`/api/rooms/${config.roomId}/agents`, {
      name: request.name,
      type: "builder",
      executionMode,
      provider,
      model: request.model,
      permissions: {
        "fs.read": true,
        "fs.write": true,
        "fs.applyPatch": true,
        "exec.run": true,
        "net.egress": false,
        "ports.expose": false,
        "secrets.read": false,
      },
    });
    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      feed: state.feed,
      taskHistory: state.taskHistory,
      transcript: state.transcript,
    };
    currentState = completeOpenTuiTask(
      currentState,
      "success",
      `Added agent ${request.name} (${provider}${request.model ? ` ${request.model}` : ""}). @${request.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")} to address it.`,
    );
    update(currentState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = completeOpenTuiTask(state, "error", `Couldn't add agent: ${message}`);
    update(currentState);
  }
}

// ── Live room ────────────────────────────────────────────────────────────────
// The room must move on its own: a 6s light refresh pulls agents, runs,
// messages, and patches, and any room-chat message we have not seen yet folds
// into the conversation as a turn. Messages present at startup are history
// (the catch-up shows those); only what arrives during the session speaks.

const seenChatMessageIds = new Set<string>();
const ownChatBodies = new Map<string, number>();

function rememberOwnChatBody(body: string): void {
  const key = body.replace(/\s+/g, " ").trim().toLowerCase();
  ownChatBodies.set(key, Date.now());
  for (const [candidate, at] of ownChatBodies) {
    if (Date.now() - at > 120_000) ownChatBodies.delete(candidate);
  }
}

function isOwnChatBody(body: string): boolean {
  const key = body.replace(/\s+/g, " ").trim().toLowerCase();
  const at = ownChatBodies.get(key);
  return at !== undefined && Date.now() - at <= 120_000;
}

function seedSeenChat(state: OpenTuiPreviewUiState): void {
  for (const message of state.dashboard.dashboard.messages || []) {
    if (message._id) seenChatMessageIds.add(message._id);
  }
}

/** Fold unseen room-chat messages into the transcript. Returns true if any landed. */
function foldNewChatMessages(): boolean {
  const messages = currentState.dashboard.dashboard.messages || [];
  let transcript = currentState.transcript;
  for (const message of messages) {
    if (!message._id || seenChatMessageIds.has(message._id)) continue;
    seenChatMessageIds.add(message._id);
    if (message.author_type === "system") continue;
    const body = (message.body_md || "").trim();
    if (!body) continue;
    const identity = currentState.dashboard.identity;
    const mine = message.author_type === "user" && (
      isOwnChatBody(body)
      || (Boolean(message.author_workos_id) && message.author_workos_id === identity?.workosUserId)
      || (Boolean(message.author_name) && message.author_name === identity?.name)
    );
    const author = mine
      ? "you"
      : message.author_name || (message.author_type === "agent" ? "agent" : "teammate");
    transcript = appendChatTurn(transcript, {
      id: `chat-${message._id}`,
      author,
      body,
      mine,
      at: message.created_at,
    });
  }
  if (transcript === currentState.transcript) return false;
  currentState = { ...currentState, transcript };
  return true;
}

// ── Room SSE stream ─────────────────────────────────────────────────────────
// The server pushes changed collections every ~2s and closes after 25s; we
// reconnect forever. While the stream is healthy the polling pulse stands
// down — it is only the fallback for networks that break streaming.

// Native Convex subscriptions — the top of the liveness ladder. When healthy,
// both the SSE stream loop and the poll pulse stand down.
let convexLive: ConvexLiveSession | undefined;
let convexLiveHealthy = false;
let convexLiveRoomId: string | undefined;

function applyConvexRows(field: "messages" | "runs" | "agents" | "patches" | "presence", rows: unknown[], render: () => void): void {
  currentState = {
    ...currentState,
    dashboard: {
      ...currentState.dashboard,
      dashboard: { ...currentState.dashboard.dashboard, [field]: rows },
    },
  };
  if (field === "messages") foldNewChatMessages();
  render();
}

async function startConvexLive(render: () => void): Promise<void> {
  const roomId = currentState.dashboard.config?.roomId;
  const token = api.getSessionToken();
  if (!roomId || !token) return;
  const convexUrl = await resolveConvexUrl((path) => api.get(path));
  if (!convexUrl) return;
  convexLive?.close();
  convexLive = new ConvexLiveSession(convexUrl, token, {
    onMessages: (rows) => applyConvexRows("messages", rows, render),
    onRuns: (rows) => applyConvexRows("runs", rows, render),
    onAgents: (rows) => applyConvexRows("agents", rows, render),
    onPatches: (rows) => applyConvexRows("patches", rows, render),
    onPresence: (rows) => applyConvexRows("presence", rows, render),
    onHealthy: (healthy) => {
      convexLiveHealthy = healthy;
      currentState = { ...currentState, liveTransport: healthy ? "convex" : roomStreamHealthy ? "sse" : "poll" };
      render();
    },
  });
  convexLiveRoomId = roomId;
  convexLive.subscribe(roomId);
}

/** Re-point subscriptions after a room switch. */
function retargetConvexLive(): void {
  const roomId = currentState.dashboard.config?.roomId;
  if (!convexLive || !roomId || roomId === convexLiveRoomId) return;
  convexLiveRoomId = roomId;
  convexLiveHealthy = false;
  convexLive.subscribe(roomId);
}

let roomStreamHealthy = false;
let roomStreamAbort: AbortController | undefined;
let roomStreamStopped = false;

function applyRoomStreamEvent(payload: { type?: string; data?: unknown }): boolean {
  const { type, data } = payload;
  if (!type || data === undefined) return false;
  const dash = currentState.dashboard.dashboard;
  const patch = (fields: Partial<typeof dash>) => {
    currentState = {
      ...currentState,
      dashboard: {
        ...currentState.dashboard,
        dashboard: { ...currentState.dashboard.dashboard, ...fields },
      },
    };
  };
  if (type === "runs" && Array.isArray(data)) { patch({ runs: data as typeof dash.runs }); return true; }
  if (type === "agents" && Array.isArray(data)) { patch({ agents: data as typeof dash.agents }); return true; }
  if (type === "patches" && Array.isArray(data)) { patch({ patches: data as typeof dash.patches }); return true; }
  if (type === "presence" && Array.isArray(data)) { patch({ presence: data as typeof dash.presence }); return true; }
  if (type === "messages" && Array.isArray(data)) {
    patch({ messages: data as typeof dash.messages });
    foldNewChatMessages();
    return true;
  }
  return false;
}

async function runRoomStream(render: () => void): Promise<void> {
  while (!roomStreamStopped) {
    const roomId = currentState.dashboard.config?.roomId;
    const token = api.getSessionToken();
    if (!roomId || !token || convexLiveHealthy) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    roomStreamAbort = new AbortController();
    try {
      const res = await fetch(`${api.getBaseUrl()}/api/rooms/${roomId}/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: roomStreamAbort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      roomStreamHealthy = true;
      if (!convexLiveHealthy) {
        currentState = { ...currentState, liveTransport: "sse" };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        let changed = false;
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) {
            try {
              changed = applyRoomStreamEvent(JSON.parse(dataLine.slice(6)) as { type?: string; data?: unknown }) || changed;
            } catch { /* malformed frame — skip */ }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (changed) render();
      }
    } catch { /* disconnect — fall through to reconnect */ }
    roomStreamHealthy = false;
    if (!convexLiveHealthy && currentState.liveTransport !== "poll") {
      currentState = { ...currentState, liveTransport: "poll" };
    }
    // The server closes streams every ~10s by design (serverless limits) —
    // reconnect almost immediately or we spend a quarter of our life blind.
    if (!roomStreamStopped) await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Best-effort "I'm here" heartbeat — powers real presence for the room. */
async function sendPresenceHeartbeat(): Promise<void> {
  const roomId = currentState.dashboard.config?.roomId;
  if (!roomId || !currentState.dashboard.session) return;
  await api.post(`/api/rooms/${roomId}/presence`, { client: "tui" }).catch(() => null);
}

let roomRefreshInFlight = false;

/** Light room refresh: dashboard data only — no workspace rescans. */
async function refreshRoomData(): Promise<boolean> {
  const roomId = currentState.dashboard.config?.roomId;
  if (!roomId || !currentState.dashboard.session || roomRefreshInFlight) return false;
  roomRefreshInFlight = true;
  try {
    const roomData = await loadRoomDashboardData({ roomId });
    if (roomData.error && roomData.agents.length === 0 && roomData.runs.length === 0) return false;
    currentState = {
      ...currentState,
      dashboard: {
        ...currentState.dashboard,
        dashboard: {
          ...currentState.dashboard.dashboard,
          agents: roomData.agents,
          runs: roomData.runs,
          messages: roomData.messages,
          patches: roomData.patches,
        },
      },
    };
    foldNewChatMessages();
    return true;
  } catch {
    return false;
  } finally {
    roomRefreshInFlight = false;
  }
}

async function sendChatMessage(
  bodyMd: string,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<void> {
  const state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = {
      ...state,
      message: "No room configured. Initialize this directory first.",
      feed: appendOpenTuiFeed(state.feed, "warning", "No room configured. Initialize this directory first."),
    };
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = {
      ...state,
      message: "Not logged in. Login before sending room chat.",
      feed: appendOpenTuiFeed(state.feed, "warning", "Not logged in. Login before sending room chat."),
    };
    update(currentState);
    return;
  }

  try {
    rememberOwnChatBody(bodyMd);
    await api.post(`/api/rooms/${config.roomId}/messages`, {
      bodyMd,
      authorType: "user",
    });
    // Light refresh picks the message back up with its server id and folds it
    // into the conversation as your own chat turn.
    await refreshRoomData();
    currentState = { ...currentState, message: "sent to the room" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentState = {
      ...state,
      message,
      feed: appendOpenTuiFeed(state.feed, "error", `chat: ${message}`),
    };
  }
  update(currentState);
}

async function submitTask(
  goal: string,
  update: (state: OpenTuiPreviewUiState) => void,
  overrides: { provider?: string; agentId?: string; continueRunId?: string; providerSession?: ProviderSessionContext } = {},
): Promise<void> {
  let state = currentState;
  const config = state.dashboard.config;
  if (!config?.roomId) {
    currentState = completeOpenTuiTask(state, "warning", "No room configured. Initialize this directory first.");
    update(currentState);
    return;
  }
  if (!state.dashboard.session) {
    currentState = completeOpenTuiTask(state, "warning", "Not logged in. Login before running room actions.");
    update(currentState);
    return;
  }

  // An explicit provider (@codex) routes to that provider's agent, never the
  // currently selected one — otherwise a codex prompt runs under the claude
  // agent's identity.
  const routedAgentId = overrides.agentId ?? (overrides.provider ? undefined : state.selectedAgentId);
  const dispatch = beginRunnableDispatch(`submit:${config.roomId}:${routedAgentId ?? overrides.provider ?? ""}:${goal.trim()}`, update);
  if (!dispatch) return;
  let approvalStream: AbortController | undefined;
  try {
    const submitted = await formatSubmittedGoal(goal, state, update);
    state = currentState;

    const activeAgent = state.dashboard.dashboard.agents.find(
      (candidate) => candidate._id === routedAgentId,
    );
    const agentName = activeAgent?.name || overrides.provider || state.dashboard.provider;
    const userMessageId = `u${currentState.transcript.length}`;
    currentState = {
      ...currentState,
      transcript: appendUserMessage(currentState.transcript, submitted.goal, userMessageId),
    };
    update(currentState);
    const agentMessageId = `m${currentState.transcript.length}`;

    const handleEvent = (event: TuiTaskEvent) => {
      handleTaskEvent(event, agentMessageId, agentName, update);
    };

    const agentId = routedAgentId;
    approvalStream = startBridgeApprovalStream(agentId, update);
    await runTuiTask({
      roomId: config.roomId,
      goal: submitted.goal,
      provider: overrides.provider || state.dashboard.provider,
      model: (overrides.provider || state.dashboard.provider) === state.dashboard.provider ? state.model : undefined,
      dir: state.args.dir,
      agentId,
      attachments: submitted.attachments,
      continueRunId: overrides.continueRunId,
      providerSession: overrides.providerSession,
      onEvent: handleEvent,
    });

    const latest = await loadOpenTuiPreviewState(state.args);
    currentState = {
      ...createOpenTuiPreviewUiState(latest),
      transcript: currentState.transcript,
      feed: currentState.feed,
      message: currentState.message,
      selectedAgentId: currentState.selectedAgentId,
      selectedRunId: currentState.selectedRunId,
      attachments: currentState.attachments,
      taskHistory: currentState.taskHistory,
      model: currentState.model,
      taskRunning: false,
    };
    update(currentState);
  } finally {
    approvalStream?.abort();
    if (bridgeApprovalAbort === approvalStream) bridgeApprovalAbort = null;
    endRunnableDispatch(dispatch);
  }
}

function handleTaskEvent(
  event: TuiTaskEvent,
  messageId: string,
  agentName: string,
  update: (state: OpenTuiPreviewUiState) => void,
): void {
  const state = currentState;
  if (event.type === "submitted") {
    currentState = {
      ...state,
      feed: appendOpenTuiFeed(state.feed, "info", `Submitted to ${event.provider}: ${event.goal}`),
    };
  } else if (event.type === "status") {
    currentState = {
      ...state,
      message: event.message,
      feed: appendOpenTuiFeed(state.feed, "info", event.message),
    };
  } else if (event.type === "output") {
    currentState = {
      ...state,
      feed: appendOpenTuiFeed(state.feed, "output", event.data),
    };
  } else if (event.type === "error") {
    currentState = completeOpenTuiTask(state, "error", event.message);
  } else {
    currentState = completeOpenTuiTask(
      state,
      event.result.exitCode === 0 ? "success" : "warning",
      `Task ${event.result.status}: ${event.result.runId || "no run id"}`,
    );
  }
  currentState = applyTaskEventToState(currentState, event, { messageId, agentName });
  update(currentState);
}

async function formatSubmittedGoal(
  goal: string,
  state: OpenTuiPreviewUiState,
  update: (state: OpenTuiPreviewUiState) => void,
): Promise<{ goal: string; attachments: TuiAttachmentTransport[] }> {
  const files = await listWorkspaceFiles({ dir: state.args.dir, limit: 10_000 });
  if (files.error) {
    return {
      goal: formatGoalWithAttachments(goal, state.attachments),
      attachments: resolveAttachmentTransport(state.attachments, state.args.dir),
    };
  }

  const baseAttachments = currentState.attachments;
  const mentions = resolveFileMentionAttachments({
    goal,
    files: files.files,
    currentAttachments: baseAttachments,
  });

  if (mentions.matched.length > 0) {
    const undoStack = fileMentionAttachmentsChanged(baseAttachments, mentions.attachments)
      ? pushUndoSnapshot(currentState.undoStack, createUndoSnapshot({
        label: "file mentions",
        provider: currentState.dashboard.provider,
        model: currentState.model,
        selectedAgentId: currentState.selectedAgentId,
        attachments: baseAttachments,
        pins: currentState.pins,
        safety: currentState.safety,
      }))
      : currentState.undoStack;
    currentState = {
      ...currentState,
      attachments: mentions.attachments,
      undoStack,
      feed: appendOpenTuiFeed(
        currentState.feed,
        "info",
        `Resolved file mentions: ${mentions.matched.map((mention) => `${mention.ref} -> ${mention.path}`).join(", ")}`,
      ),
    };
    persistOpenTuiPreviewState(currentState);
    update(currentState);
  }
  if (mentions.unresolved.length > 0) {
    currentState = {
      ...currentState,
      feed: appendOpenTuiFeed(currentState.feed, "warning", `Unresolved file mentions: ${mentions.unresolved.join(", ")}`),
    };
    update(currentState);
  }

  const attachments = resolveAttachmentTransport(mentions.attachments, state.args.dir);
  if (attachments.length > 0) {
    currentState = {
      ...currentState,
      feed: appendOpenTuiFeed(
        currentState.feed,
        "info",
        `Prepared ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} for provider transport.`,
      ),
    };
    update(currentState);
  }

  return {
    goal: formatGoalWithAttachments(goal, mentions.attachments),
    attachments,
  };
}

let currentState: OpenTuiPreviewUiState;
let terminalSession: RoomTerminalSession | null = null;
let bridgeApprovalAbort: AbortController | null = null;
const activeBridgeApprovals = new Set<string>();
const resolvingBridgeApprovals = new Set<string>();
// Attention routing: desktop + Telegram delivery for transitions the user
// would otherwise only learn about by staring at the terminal.
let roomNotifier: RoomNotifier | null = null;

function notifierRoomContext() {
  const config = currentState.dashboard.config;
  const agents = currentState.dashboard.dashboard.agents || [];
  return {
    roomName: config?.roomName || (config?.roomId ? `room ${config.roomId.slice(-4)}` : "co-od"),
    agentName: (agentId?: string) => {
      const agent = agents.find((candidate) => candidate._id === agentId);
      return agent?.name ? `@${agent.name}` : "agent";
    },
  };
}

// A Telegram tap answers the bridge FIRST; the local confirm overlay is
// dismissed only after the bridge accepted the decision. Dismissing eagerly
// would strand the user with no prompt when the POST fails — phone says
// "Allowed", terminal shows nothing, approval still unresolved.
function handleRemoteApprovalDecision(
  callback: TelegramApprovalCallback,
  update: (state: OpenTuiPreviewUiState) => void,
): void {
  if (!roomNotifier?.hasPendingApproval(callback.approvalId)) return;
  void resolveBridgeApproval(callback.approvalId, callback.decision, "remote approval", update, "telegram")
    .then((resolved) => {
      if (!resolved) return;
      const pending = currentState.pendingApproval;
      if (
        currentState.mode === "confirm"
        && pending?.intent.type === "bridge-approval"
        && pending.intent.approvalId === callback.approvalId
      ) {
        currentState = {
          ...currentState,
          mode: pending.returnMode,
          taskInput: pending.returnTaskInput,
          pendingApproval: undefined,
        };
        update(currentState);
      }
    });
}
let activeRunnableDispatch: string | null = null;

function beginRunnableDispatch(label: string, update: (state: OpenTuiPreviewUiState) => void): string | null {
  if (activeRunnableDispatch) {
    currentState = {
      ...currentState,
      message: "A room task is already running. Wait for it to finish before sending another.",
      feed: appendOpenTuiFeed(currentState.feed, "warning", "Ignored duplicate task submit while another task is running."),
    };
    update(currentState);
    return null;
  }
  activeRunnableDispatch = `${label}:${Date.now()}`;
  return activeRunnableDispatch;
}

function endRunnableDispatch(token: string | null): void {
  if (token && activeRunnableDispatch === token) activeRunnableDispatch = null;
}

main().catch((error) => {
  bridgeApprovalAbort?.abort();
  terminalSession?.close();
  console.error(`[co-od opentui] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
