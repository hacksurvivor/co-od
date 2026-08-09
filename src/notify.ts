// Attention routing: when a run finishes, a patch wants review, or a bridge
// approval is blocking, the person is usually NOT looking at the terminal.
// This module delivers those moments to where they are — the desktop and
// Telegram — always attributed ("room 2 · @builder"), and lets a Telegram tap
// answer a bridge approval so runs survive the user leaving their desk.
//
// Design rules: pure detection/formatting (testable), injectable fetch/exec,
// best-effort delivery (a notification failure must never break the TUI — but
// it must not be SILENT either: onDeliveryProblem surfaces it), and the
// Telegram long-poll runs only while an approval is actually pending.
//
// Security invariants:
// - Notification text derives from agent-controlled data (run goals, patch
//   paths, approval commands). It must never pass through a shell: delivery
//   uses execFile with argv arrays, no string interpolation into sh.
// - A Telegram tap authorizes shell commands / file edits on this machine.
//   Callbacks are only honored from the CONFIGURED chat — getUpdates receives
//   updates from every chat the bot is in (groups included), and the bot
//   token is the only other gate.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  bridgeApprovalTarget,
  bridgeApprovalTitle,
  type BridgeApprovalDecision,
  type BridgeApprovalRequest,
} from "./tui-bridge-approvals.js";

// ── Config ───────────────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface NotifyConfig {
  desktop: boolean;
  telegram?: TelegramConfig;
}

const CONFIG_DIR = join(homedir(), ".co-ode");
// CO_OD_NOTIFY_CONFIG redirects the config file — tests point it at a temp
// path so they never touch the user's real configuration.
const NOTIFY_CONFIG_PATH = process.env.CO_OD_NOTIFY_CONFIG?.trim() || join(CONFIG_DIR, "notify.json");

// Telegram long-poll: 25s server-side wait per request, 3s backoff after an
// error response (bad token, 409 from a second poller, network flap) so the
// loop can never hot-spin.
const TELEGRAM_POLL_TIMEOUT_S = 25;
const TELEGRAM_POLL_RETRY_DELAY_MS = 3000;

export function notifyConfigPath(): string {
  return NOTIFY_CONFIG_PATH;
}

/** File config first, env overrides on top, CO_OD_NOTIFY=off kills everything. */
export function loadNotifyConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): NotifyConfig | null {
  if ((env.CO_OD_NOTIFY || "").trim().toLowerCase() === "off") return null;

  let fileConfig: Partial<NotifyConfig> = {};
  try {
    fileConfig = JSON.parse(readFile(NOTIFY_CONFIG_PATH)) as Partial<NotifyConfig>;
  } catch {
    // No config file is the common case.
  }

  const botToken = env.CO_OD_TELEGRAM_BOT_TOKEN?.trim() || fileConfig.telegram?.botToken?.trim();
  const chatId = env.CO_OD_TELEGRAM_CHAT_ID?.trim() || fileConfig.telegram?.chatId?.trim();

  return {
    desktop: fileConfig.desktop !== false,
    telegram: botToken && chatId ? { botToken, chatId } : undefined,
  };
}

export function saveNotifyConfig(config: NotifyConfig): void {
  mkdirSync(dirname(NOTIFY_CONFIG_PATH), { recursive: true });
  writeFileSync(NOTIFY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// ── Room transition detection (pure) ─────────────────────────────────────────

export interface RoomRunLike {
  _id: string;
  status?: string;
  goal?: string;
  agent_id?: string;
}

export interface RoomPatchLike {
  _id: string;
  status?: string;
  path?: string;
  title?: string;
}

export interface RoomSnapshot {
  runStatuses: Map<string, string>;
  /** All patch ids we have seen, regardless of status. */
  knownPatches: Set<string>;
  /** False until a real patches payload has been observed — `undefined`
   *  patches means "not loaded yet", and comparing against that would turn
   *  every historical proposed patch into a notification burst. */
  hasPatchData: boolean;
}

export interface RoomEventContext {
  roomName: string;
  agentName: (agentId?: string) => string;
}

export interface RoomEvent {
  key: string;
  kind: "run-succeeded" | "run-failed" | "patch-proposed";
  title: string;
  body: string;
}

export function roomSnapshot(runs: RoomRunLike[], patches: RoomPatchLike[] | undefined): RoomSnapshot {
  return {
    runStatuses: new Map(runs.map((run) => [run._id, run.status || "unknown"])),
    knownPatches: new Set((patches || []).map((patch) => patch._id)),
    hasPatchData: patches !== undefined,
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * News is a TRANSITION: a run we previously saw in a non-terminal state landing
 * in a terminal one, or a patch arriving that the previous (loaded) snapshot
 * had never seen. Anything first sighted in its final state is history and
 * stays silent — that's what keeps launch and room-switch quiet.
 */
export function detectRoomTransitions(
  previous: RoomSnapshot,
  next: { runs: RoomRunLike[]; patches: RoomPatchLike[] | undefined },
  context: RoomEventContext,
): RoomEvent[] {
  const events: RoomEvent[] = [];
  const attribution = (agentId?: string) => `${context.roomName} · ${context.agentName(agentId)}`;

  for (const run of next.runs) {
    const before = previous.runStatuses.get(run._id);
    if (!before) continue; // first sighting — not a transition
    if (before === run.status) continue;
    const goal = oneLine(run.goal || "task");
    if (run.status === "succeeded" || run.status === "completed") {
      events.push({
        key: `run:${run._id}:done`,
        kind: "run-succeeded",
        title: `✓ done — ${attribution(run.agent_id)}`,
        body: goal,
      });
    } else if (run.status === "failed" || run.status === "error") {
      events.push({
        key: `run:${run._id}:failed`,
        kind: "run-failed",
        title: `✗ failed — ${attribution(run.agent_id)}`,
        body: `${goal} — /retry reruns it`,
      });
    }
  }

  // Patch news requires the previous snapshot to have had REAL patch data —
  // otherwise "patches just finished loading" would read as a burst of news.
  if (previous.hasPatchData) {
    for (const patch of next.patches || []) {
      if (patch.status !== "proposed") continue;
      if (previous.knownPatches.has(patch._id)) continue;
      events.push({
        key: `patch:${patch._id}:proposed`,
        kind: "patch-proposed",
        title: `▲ review needed — ${context.roomName}`,
        body: oneLine(patch.path || patch.title || "patch awaiting review"),
      });
    }
  }

  return events;
}

// ── Desktop delivery ─────────────────────────────────────────────────────────

export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Notification text is agent-controlled (run goals, patch paths, commands) —
 * it must never touch a shell. execFile passes title/body as literal argv;
 * the only escaping needed is for the AppleScript string literal itself.
 */
export function sendDesktopNotification(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  execFileImpl: typeof execFile = execFile,
): void {
  const safeTitle = oneLine(title);
  const safeBody = oneLine(body);
  try {
    if (platform === "darwin") {
      const script = `display notification "${escapeAppleScript(safeBody)}" with title "${escapeAppleScript(safeTitle)}" sound name "Glass"`;
      execFileImpl("osascript", ["-e", script], () => {});
    } else if (platform === "linux") {
      execFileImpl("notify-send", [safeTitle, safeBody], () => {});
    }
  } catch {
    // Notifications are best-effort, always.
  }
}

// ── Telegram delivery + approval round-trip ──────────────────────────────────

export interface TelegramApprovalCallback {
  approvalId: string;
  decision: BridgeApprovalDecision;
}

export function approvalCallbackData(approvalId: string, decision: BridgeApprovalDecision): string {
  return `apr|${approvalId}|${decision}`;
}

export function parseApprovalCallback(data: unknown): TelegramApprovalCallback | null {
  if (typeof data !== "string") return null;
  const match = data.match(/^apr\|(.+)\|(approve|deny)$/);
  if (!match) return null;
  return { approvalId: match[1], decision: match[2] as BridgeApprovalDecision };
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function formatApprovalMessage(
  approval: BridgeApprovalRequest,
  context: { roomName: string; agentName: string },
): string {
  const lines = [
    `⏸ ${bridgeApprovalTitle(approval)} — ${context.roomName} · ${context.agentName}`,
    "",
    truncate(bridgeApprovalTarget(approval), 600),
  ];
  if (approval.cwd) lines.push(`cwd: ${truncate(approval.cwd, 200)}`);
  if (approval.reason) lines.push(`reason: ${truncate(approval.reason, 300)}`);
  // Telegram rejects messages over 4096 chars; rejecting means no buttons.
  return truncate(lines.join("\n"), 3500);
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: { chat?: { id?: number | string } };
  };
}

/**
 * A tap from the wrong chat must never resolve an approval: the bot may be in
 * group chats, and getUpdates delivers callbacks from ALL of them. Only the
 * configured chat is trusted.
 */
export function callbackFromConfiguredChat(update: TelegramUpdate, chatId: string): boolean {
  const fromChat = update.callback_query?.message?.chat?.id;
  return fromChat !== undefined && String(fromChat) === chatId;
}

export class TelegramChannel {
  private readonly api: string;
  private offset = 0;
  private polling = false;
  private pollAbort: AbortController | null = null;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onProblem: (problem: string) => void = () => {},
  ) {
    this.api = `https://api.telegram.org/bot${config.botToken}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
    try {
      const response = await this.fetchImpl(`${this.api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        // 409 = another getUpdates poller on this token (second TUI instance).
        // Don't echo response bodies — they can quote the bot token's URL.
        if (method !== "getUpdates" || response.status === 409) {
          this.onProblem(`telegram ${method} failed (${response.status})`);
        }
        return null;
      }
      const data = (await response.json()) as { ok?: boolean; result?: T };
      return data.ok ? (data.result as T) : null;
    } catch (error) {
      if (signal?.aborted) return null;
      if (method !== "getUpdates") {
        this.onProblem(`telegram ${method} unreachable`);
      }
      return null;
    }
  }

  async send(text: string): Promise<number | null> {
    const result = await this.call<{ message_id?: number }>("sendMessage", {
      chat_id: this.config.chatId,
      text,
    });
    return result?.message_id ?? null;
  }

  /**
   * `token` (not the raw approvalId) rides in callback_data — Telegram caps
   * callback_data at 64 bytes and bridge approval ids can exceed that, which
   * would make the whole message (and its buttons) invalid.
   */
  async sendApproval(
    approval: BridgeApprovalRequest,
    context: { roomName: string; agentName: string },
    token: string,
  ): Promise<number | null> {
    const result = await this.call<{ message_id?: number }>("sendMessage", {
      chat_id: this.config.chatId,
      text: formatApprovalMessage(approval, context),
      reply_markup: {
        inline_keyboard: [[
          { text: "✓ Allow", callback_data: approvalCallbackData(token, "approve") },
          { text: "✗ Deny", callback_data: approvalCallbackData(token, "deny") },
        ]],
      },
    });
    return result?.message_id ?? null;
  }

  async markResolved(messageId: number, original: string, decision: BridgeApprovalDecision, via: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: this.config.chatId,
      message_id: messageId,
      text: `${original}\n\n${decision === "approve" ? "✓ allowed" : "✗ denied"} (${via})`,
    });
  }

  /**
   * Long-poll for inline-button taps. Started when an approval becomes
   * pending, stopped (via stopPolling) when none remain — idle sessions make
   * zero Telegram requests.
   */
  startPolling(onApproval: (callback: TelegramApprovalCallback) => void): void {
    if (this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();
    const signal = this.pollAbort.signal;
    void (async () => {
      while (this.polling && !signal.aborted) {
        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: TELEGRAM_POLL_TIMEOUT_S, allowed_updates: ["callback_query"] },
          signal,
        );
        if (!updates) {
          if (this.polling && !signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, TELEGRAM_POLL_RETRY_DELAY_MS));
          }
          continue;
        }
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (!update.callback_query) continue;
          if (!callbackFromConfiguredChat(update, this.config.chatId)) {
            // A tap from a chat we don't trust gets acknowledged (so the
            // sender's spinner clears) but never resolves anything.
            void this.call("answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: "Not authorized for this approval.",
            });
            continue;
          }
          const callback = parseApprovalCallback(update.callback_query.data);
          if (callback) {
            void this.call("answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: callback.decision === "approve" ? "Allowed" : "Denied",
            });
            onApproval(callback);
          }
        }
      }
    })();
  }

  stopPolling(): void {
    this.polling = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
  }
}

// ── RoomNotifier: ties detection to delivery ─────────────────────────────────

interface PendingApprovalDelivery {
  messageId: number | null;
  text: string;
  token: string;
}

export class RoomNotifier {
  private snapshot: RoomSnapshot | null = null;
  private snapshotRoomId: string | undefined;
  private lastRuns: unknown = null;
  private lastPatches: unknown = null;
  private delivered = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApprovalDelivery>();
  private readonly approvalTokens = new Map<string, string>();
  private readonly telegram: TelegramChannel | null;
  private onRemoteDecision: (callback: TelegramApprovalCallback) => void = () => {};
  private onProblem: (problem: string) => void = () => {};

  constructor(
    private readonly config: NotifyConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.telegram = config.telegram
      ? new TelegramChannel(config.telegram, fetchImpl, (problem) => this.onProblem(problem))
      : null;
  }

  setRemoteDecisionHandler(handler: (callback: TelegramApprovalCallback) => void): void {
    this.onRemoteDecision = handler;
  }

  /** Delivery failures stay non-fatal but must not be invisible — the TUI
   *  surfaces them in the feed so "approve from my phone" is never assumed
   *  to work when the bot is unreachable. */
  setProblemHandler(handler: (problem: string) => void): void {
    this.onProblem = handler;
  }

  /**
   * Called from the render loop — ref-equality makes the common case free.
   * `context` is a thunk so the caller doesn't allocate on every render.
   */
  observe(
    runs: RoomRunLike[],
    patches: RoomPatchLike[] | undefined,
    roomId: string | undefined,
    context: () => RoomEventContext,
  ): void {
    if (runs === this.lastRuns && patches === this.lastPatches && roomId === this.snapshotRoomId) return;
    this.lastRuns = runs;
    this.lastPatches = patches;

    // A room switch resets knowledge: the new room's history must not read as
    // news against the old room's snapshot, and delivered keys from other
    // rooms have no reason to accumulate.
    if (roomId !== this.snapshotRoomId) {
      this.snapshotRoomId = roomId;
      this.snapshot = null;
      this.delivered = new Set();
    }

    const previous = this.snapshot;
    const next = roomSnapshot(runs, patches);
    // "Patches not loaded yet" must not erase patch knowledge we already had.
    if (!next.hasPatchData && previous?.hasPatchData) {
      next.knownPatches = previous.knownPatches;
      next.hasPatchData = true;
    }
    this.snapshot = next;
    if (!previous) return; // first sight of the room is history, not news

    const resolvedContext = (() => {
      let cached: RoomEventContext | null = null;
      return () => (cached ??= context());
    })();
    for (const event of detectRoomTransitions(previous, { runs, patches }, {
      get roomName() {
        return resolvedContext().roomName;
      },
      agentName: (agentId?: string) => resolvedContext().agentName(agentId),
    })) {
      if (this.delivered.has(event.key)) continue;
      this.delivered.add(event.key);
      this.deliver(event.title, event.body);
    }
  }

  deliver(title: string, body: string): void {
    if (this.config.desktop) sendDesktopNotification(title, body);
    if (this.telegram) void this.telegram.send(`${title}\n${body}`);
  }

  approvalRequested(approval: BridgeApprovalRequest, context: { roomName: string; agentName: string }): void {
    const title = `⏸ approval needed — ${context.roomName} · ${context.agentName}`;
    const body = bridgeApprovalTarget(approval);
    if (this.config.desktop) sendDesktopNotification(title, body);
    if (!this.telegram) return;
    if (this.pendingApprovals.has(approval.approvalId)) return;

    const text = formatApprovalMessage(approval, context);
    // Random nonce, never sequential: a process-local counter resets on
    // restart, and a stale queued tap carrying "a1" could then translate to a
    // DIFFERENT current approval — authorizing the wrong shell command.
    // 8 random bytes keeps callback_data well under Telegram's 64-byte cap.
    const token = randomBytes(8).toString("hex");
    this.approvalTokens.set(token, approval.approvalId);
    this.pendingApprovals.set(approval.approvalId, { messageId: null, text, token });
    this.telegram.startPolling((callback) => {
      // The callback carries the short token; translate to the real id.
      const approvalId = this.approvalTokens.get(callback.approvalId);
      if (!approvalId) return; // stale or foreign token — nothing to resolve
      this.onRemoteDecision({ approvalId, decision: callback.decision });
    });
    void this.telegram.sendApproval(approval, context, token).then((messageId) => {
      const pending = this.pendingApprovals.get(approval.approvalId);
      if (pending) pending.messageId = messageId;
      if (messageId === null) {
        this.onProblem("telegram approval buttons could not be delivered — approve at the terminal");
      }
    });
  }

  approvalResolved(approvalId: string, decision: BridgeApprovalDecision, via: "tui" | "telegram"): void {
    const pending = this.pendingApprovals.get(approvalId);
    this.pendingApprovals.delete(approvalId);
    if (pending) this.approvalTokens.delete(pending.token);
    if (this.pendingApprovals.size === 0) this.telegram?.stopPolling();
    if (pending?.messageId && this.telegram) {
      void this.telegram.markResolved(pending.messageId, pending.text, decision, via);
    }
  }

  hasPendingApproval(approvalId: string): boolean {
    return this.pendingApprovals.has(approvalId);
  }

  close(): void {
    this.telegram?.stopPolling();
  }
}

/** Null when notifications are disabled or nothing is configured to deliver. */
export function createRoomNotifier(
  env: NodeJS.ProcessEnv = process.env,
): RoomNotifier | null {
  const config = loadNotifyConfig(env);
  if (!config) return null;
  if (!config.desktop && !config.telegram) return null;
  return new RoomNotifier(config);
}
