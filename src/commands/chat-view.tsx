// React (@opentui/react) chat view. The whole tree is reconciled by React's
// renderer, so updates (typing, streaming, scrolling) are applied in place —
// no manual teardown/rebuild, which is what caused the transcript to jump and
// the scrollbar to bounce in the hand-rolled reconciler.
//
// This component is pure render: it reads the existing headless state and emits
// OpenTUI elements. All input/orchestration stays in the renderer host, which
// calls `root.render(<ChatView state={currentState} />)` after each update.
//
// The layout follows Claude Code's conventions — that's the muscle memory
// people arrive with: a single full-width conversation, `>` user prompts,
// `⏺` agent turns with `⎿` tool lines, a welcome card on an empty screen, a
// bordered composer pinned at the bottom, and one status line under it.
// What makes it multiplayer is ambient, not summoned: a one-line header
// (room · who's here · fleet counts) and a glanceable room rail (crew /
// needs-you / tasks / room chat) that is on by default on wide terminals
// and tucks away with ⌃B.
import React, { memo } from "react";
import {
  type OpenTuiPreviewUiState,
  type PanelTabId,
  filteredOpenTuiPaletteItems,
  knownOpenTuiRooms,
  openTuiMentionTargets,
  resolveOpenTuiConversationTarget,
} from "../tui-opentui-preview.js";
import type { OpenTuiPreviewFeedEntry } from "../tui-opentui-preview.js";
import type { MessageRecord } from "../tui-dashboard.js";
import type { TranscriptMessage, TranscriptBlock } from "../tui-chat-transcript.js";
import { HIGH_CONTRAST_TUI_THEME } from "../tui-theme.js";
import { compact, diffStat, formatStepDescription, shortId, type PatchRecord } from "../tui-model.js";
import { agentHandle, composerSuggestions, providerMentionTargets } from "../tui-palette.js";
import { buildAgentActivityRows } from "../tui-agent-activity.js";
import { wrapPlain } from "../tui-render.js";
import { composerWindow } from "../tui-composer.js";
import {
  SIDE_RAIL_DEFAULT_WIDTH,
  SIDE_RAIL_MAX_WIDTH,
  SIDE_RAIL_MIN_MAIN_WIDTH,
  SIDE_RAIL_MIN_WIDTH,
} from "../tui-persistence.js";

const theme = HIGH_CONTRAST_TUI_THEME.colors;
const MAX_BLOCK_LINES = 14;
const COMPOSER_MAX_LINES = 5;
const FAILED_RUN_STATUSES = new Set(["failed", "error", "cancelled"]);
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FEED_SYSTEM_PATTERNS = [
  /^Dashboard refreshed\b/i,
  /^Room refreshed\b/i,
  /^Room dashboard loaded\b/i,
  /^Bridge approval\b/i,
  /^Connecting shared terminal\b/i,
  /^Connected shared terminal\b/i,
  /^Initializing project room\b/i,
  /^Pinned\b/i,
  /^Selected\b/i,
];

interface HttpErrorInfo {
  method: string;
  path: string;
  resource: string;
  code: string;
  reason: string;
}

interface SpawnErrorInfo {
  tool: string;
  path: string;
  next: string;
}

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*Error:\*\*/gi, "Error:")
    .replace(/^_([^_\n]+)_$/gm, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .trimEnd();
}

export function httpErrorInfo(text: string): HttpErrorInfo | null {
  const normalized = oneLine(cleanMarkdown(text));
  const match = normalized.match(/(?:Error:\s*)?(POST|GET|PUT|PATCH|DELETE)\s+(\S+)\s+failed:\s+(\d{3})(?:\s+(.+))?/i);
  if (!match) return null;
  const [, method, path, code, reason] = match;
  const resource = path.split("?")[0].split("/").filter(Boolean).at(-1) || "request";
  return {
    method: method.toUpperCase(),
    path: path.split("?")[0],
    resource,
    code,
    reason: reason || "request failed",
  };
}

export function spawnErrorInfo(text: string): SpawnErrorInfo | null {
  const cleaned = cleanMarkdown(text);
  const normalized = oneLine(cleaned);
  if (!/\bENOENT\b/.test(normalized) || !/\bspawn\b/i.test(normalized)) return null;
  const path = cleaned.match(/Error:\s*spawn\s+(.+?)(?:\s+at\s+|\s+spawnargs:|\s+errno:|\s+code:|$)/is)?.[1]?.trim()
    || cleaned.match(/path:\s*'([^']+)'/i)?.[1]?.trim()
    || "provider executable";
  const lower = path.toLowerCase();
  if (lower.includes("codex")) {
    return { tool: "Codex CLI", path, next: "reinstall @openai/codex or fix the Codex CLI path, then rerun" };
  }
  if (lower.includes("claude")) {
    return { tool: "Claude Code", path, next: "reinstall Claude Code or fix the Claude CLI path, then rerun" };
  }
  if (lower.includes("opencode")) {
    return { tool: "OpenCode", path, next: "reinstall OpenCode or fix the OpenCode CLI path, then rerun" };
  }
  return { tool: "provider CLI", path, next: "reinstall the provider CLI or fix PATH, then rerun" };
}

function compactHttpError(text: string): string | null {
  const error = httpErrorInfo(text);
  if (!error) return null;
  return `${error.resource} failed (${error.code} ${error.reason})`;
}

export function statusDetail(message: string): string {
  const http = httpErrorInfo(message);
  if (http) {
    if (http.code === "401") return "signed out — /login reconnects you";
    if (http.code === "403") return "no permission here — ask a room owner";
    return "✗ failed — ↑ resends · /retry reruns";
  }
  if (spawnErrorInfo(message)) return "provider cli missing";
  const text = oneLine(message);
  // Run ids are plumbing — the status line speaks in outcomes, not identifiers.
  const created = text.match(/^(?:Handoff run|Run)\s+\S+\s+created\.\s*Executing with\s+([^.\s]+)/i);
  if (created) return `sending to ${created[1]}…`;
  if (/^(Continuing|Resuming) run\b/i.test(text)) return "picking up the task…";
  const task = text.match(/^Task\s+(succeeded|completed|failed|cancelled):/i);
  if (task) {
    const status = task[1].toLowerCase();
    if (status === "failed") return "✗ task failed — /retry reruns it";
    if (status === "cancelled") return "task stopped";
    return "✓ task done";
  }
  if (/^Task detail loaded/i.test(text)) return "task open — esc goes back";
  if (/^(Opening|Loading) task detail/i.test(text)) return "opening the task…";
  return text;
}

function shouldShowTransientMessage(message: string): boolean {
  const text = oneLine(message);
  if (!text || text === "Ready.") return false;
  if (FEED_SYSTEM_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (/^Side panel \d+ cols\.$/i.test(text)) return false;
  return true;
}

function feedText(entry: OpenTuiPreviewFeedEntry): string {
  const compactError = compactHttpError(entry.text);
  return compactError || oneLine(entry.text);
}

export function isTaskFeedNoise(entry: OpenTuiPreviewFeedEntry): boolean {
  const text = oneLine(entry.text);
  return compactHttpError(text) !== null
    || entry.kind === "output"
    || /^Submitting task\b/i.test(text)
    || /^Submitted to\b/i.test(text)
    || /^Task (completed|failed|cancelled|succeeded):/i.test(text)
    // Navigation echoes ("Task detail loaded: <id>") belong to the status
    // line, never the conversation — and never with a raw run id.
    || /^Task detail loaded\b/i.test(text)
    || /^(Opening|Loading) task detail\b/i.test(text)
    || /^Task selected\b/i.test(text);
}

function isRoomSystemFeed(entry: OpenTuiPreviewFeedEntry): boolean {
  const text = oneLine(entry.text);
  return FEED_SYSTEM_PATTERNS.some((pattern) => pattern.test(text));
}

function feedFg(kind: string): string {
  if (kind === "error") return theme.danger;
  if (kind === "warning") return theme.warning;
  if (kind === "success") return theme.success;
  return theme.muted;
}

// A failure is "handled" once a later run with the same goal and agent
// succeeded — a retry that worked should clear the nag, not leave stale red.
function unresolvedFailures(
  runs: Array<{ _id: string; status?: string; goal?: string; agent_id?: string; created_at?: number }>,
  dismissed?: string[],
): typeof runs {
  const waved = new Set(dismissed || []);
  const failures = runs.filter((run) => FAILED_RUN_STATUSES.has(run.status || "") && !waved.has(run._id));
  return failures.filter((failure) => {
    const goal = oneLine(failure.goal || "");
    if (!goal) return true;
    const failedAt = failure.created_at || 0;
    return !runs.some((candidate) =>
      (candidate.status === "succeeded" || candidate.status === "completed")
      && candidate.agent_id === failure.agent_id
      && oneLine(candidate.goal || "") === goal
      && (candidate.created_at || 0) > failedAt);
  });
}

function runGlyph(status?: string): { glyph: string; fg: string } {
  switch (status) {
    case "completed":
    case "succeeded":
      return { glyph: "✓", fg: theme.success };
    case "failed":
    case "error":
      return { glyph: "✗", fg: theme.danger };
    case "cancelled":
      return { glyph: "✗", fg: theme.muted };
    case "running":
    case "in_progress":
      return { glyph: spinnerFrame(), fg: theme.accent };
    case "queued":
      return { glyph: "◌", fg: theme.warning };
    case "paused":
      return { glyph: "⏸", fg: theme.warning };
    default:
      return { glyph: "·", fg: theme.muted };
  }
}

function spinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 140) % SPINNER_FRAMES.length];
}

function elapsedLabel(startedAt?: number): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Where a plain Enter lands — must match the reducer's dispatch exactly, so
// the status line never lies about who will answer.
function conversationTarget(state: OpenTuiPreviewUiState): { label: string; provider?: string; agentId?: string } | null {
  return resolveOpenTuiConversationTarget(state);
}

// Readiness of the active provider: can a plain message actually run here?
function providerReadiness(state: OpenTuiPreviewUiState): { ready: boolean; reason?: string } {
  const provider = state.dashboard.provider;
  const available = state.dashboard.providerAvailability?.[provider] === true;
  const auth = (state.dashboard.providerAuth || []).find((entry) => entry.provider === provider);
  if (!available) return { ready: false, reason: `${provider} CLI not found — install it` };
  if (auth && auth.status !== "connected") {
    return { ready: false, reason: auth.status === "cli_missing" ? `${provider} CLI not found — install it` : `${provider} not signed in` };
  }
  return { ready: true };
}

function agentNameFor(state: OpenTuiPreviewUiState, agentId?: string): string {
  const agent = state.dashboard.dashboard.agents.find((candidate) => candidate._id === agentId);
  return agent?.name || (agentId ? shortId(agentId) : "agent");
}

function roomLabel(roomName?: string, roomId?: string): string {
  return truncate(roomName || roomId || "no room", 20);
}

// "room 3" should read "room 3", not "room room 3".
function roomTitle(roomName?: string, roomId?: string): string {
  const label = roomLabel(roomName, roomId);
  return /^room\b/i.test(label) ? label : `room ${label}`;
}

function agentDisplayHandle(agent: { agentId: string; name?: string }): string {
  return `@${agentHandle({ _id: agent.agentId, name: agent.name })}`;
}

function wrapWithIndent(text: string, width: number, indent = "  "): string[] {
  return wrapPlain(text, Math.max(8, width - indent.length)).map((line) => (line ? indent + line : line));
}

// ── Transcript ───────────────────────────────────────────────────────────────

function blockText(block: TranscriptBlock): string {
  if (block.kind === "markdown" || block.kind === "code") return block.text;
  if (block.kind === "toolCall") return `${block.label}${block.detail ? ` ${block.detail}` : ""}`;
  return `${block.file || "patch"} ${block.diff}`;
}

function userMessageLines(message: TranscriptMessage): string[] {
  const text = message.blocks.map(blockText).join("\n").trim();
  const lines = cleanMarkdown(text).split("\n");
  const visible = lines.slice(0, 8);
  if (lines.length > 8) visible.push(`… ${lines.length - 8} more lines`);
  return visible;
}

function agentLabel(message: TranscriptMessage): string {
  const agent = oneLine(message.agentName || "");
  const provider = oneLine(message.provider || "");
  if (agent && provider && agent.toLowerCase() !== provider.toLowerCase()) return `${agent} · ${provider}`;
  return agent || provider || "agent";
}

function messageHttpError(message: TranscriptMessage): HttpErrorInfo | null {
  for (const block of message.blocks) {
    if (block.kind !== "markdown") continue;
    const error = httpErrorInfo(block.text);
    if (error) return error;
  }
  return null;
}

function messageCraftedError(message: TranscriptMessage): string | null {
  for (const block of message.blocks) {
    if (block.kind !== "markdown") continue;
    const text = cleanMarkdown(block.text).trim();
    const match = text.match(/^Error:\s*([\s\S]+)/);
    if (match && !httpErrorInfo(text) && !spawnErrorInfo(text)) {
      return oneLine(match[1]);
    }
  }
  return null;
}

function messageSpawnError(message: TranscriptMessage): SpawnErrorInfo | null {
  for (const block of message.blocks) {
    if (block.kind !== "markdown") continue;
    const error = spawnErrorInfo(block.text);
    if (error) return error;
  }
  return null;
}

// Turn a raw HTTP failure into something a person wants to read. The room is a
// calm place — no status codes or stack-speak in the feed (the raw line still
// lives in task detail). Returns a short headline and one quiet next step.
export function humaneHttpError(error: HttpErrorInfo): { headline: string; next: string } {
  const what = error.resource === "agents" ? "your agents"
    : error.resource === "runs" ? "the task"
    : `the ${error.resource}`;
  const code = Number(error.code);
  if (code === 401) {
    return { headline: `couldn't reach ${what} — your sign-in expired`, next: "run  co-od login  then try again" };
  }
  if (code === 403) {
    return { headline: `${what} is locked to editors`, next: "ask a room owner to add you, then rerun" };
  }
  if (code === 404) {
    return { headline: `couldn't find ${what}`, next: "the room or agent may have moved — refresh and retry" };
  }
  if (code === 429) {
    return { headline: "too many requests for now", next: "give it a moment, then rerun" };
  }
  if (code >= 500) {
    return { headline: `the server stumbled reaching ${what}`, next: "give it a moment" };
  }
  return { headline: `couldn't reach ${what}`, next: "check your connection" };
}

interface ClassifiedAgentLine {
  kind: "body" | "activity" | "warning";
  text: string;
}

interface AgentMessageSummary {
  bodyLines: string[];
  activityLines: string[];
  warningLines: string[];
  omittedBody: number;
  omittedActivity: number;
}

export function classifyAgentLine(line: string): ClassifiedAgentLine | null {
  const text = cleanMarkdown(line).trim();
  if (!text) return { kind: "body", text: "" };
  if (httpErrorInfo(text)) return null;
  if (spawnErrorInfo(text)) return null;
  if (/^Error:\s/.test(text)) return null; // rendered as the crafted-error block
  if (/^(at\s+|errno:|code:|syscall:|path:|spawnargs:|\{|\}|'.*',?$)/i.test(text)) return null;
  if (/^Error:\s*spawn\b/i.test(text)) return null;
  // Dispatch plumbing ("run created", "live activity on", stdin chatter) is
  // not conversation — the turn header and status line already carry state.
  if (/^Creating run in room\b/i.test(text)) return null;
  if (/^(Continuing|Resuming) run\b/i.test(text)) return null;
  if (/^\[co-od\]\s*Live activity reporting enabled\b/i.test(text)) return null;
  if (/^\[co-od\]\s*/i.test(text)) return { kind: "activity", text: text.replace(/^\[co-od\]\s*/i, "") };
  if (/^Warning:\s*no stdin data received\b/i.test(text)) return null;
  if (/^If piping from a slow command\b/i.test(text)) return null;
  if (/^to skip\.?$/i.test(text)) return null;
  if (/^Bridge approval stream unavailable:/i.test(text)) return { kind: "warning", text: "approval stream offline" };
  if (/^Submitting task\b/i.test(text)) return null;
  if (/^Submitted to\b/i.test(text)) return null;
  if (/^Task (completed|failed|cancelled|succeeded):/i.test(text)) return null;
  if (/^Run (completed|failed|cancelled|succeeded|created)\b/i.test(text)) return null;
  return { kind: "body", text };
}

function uniqueLimited(lines: string[], limit: number): { lines: string[]; omitted: number } {
  const unique: string[] = [];
  for (const line of lines) {
    const value = oneLine(line);
    if (!value || unique.includes(value)) continue;
    unique.push(value);
  }
  return { lines: unique.slice(0, limit), omitted: Math.max(0, unique.length - limit) };
}

function compactBodyLines(lines: string[], limit: number): { lines: string[]; omitted: number } {
  const compacted: string[] = [];
  for (const line of lines) {
    const value = line.trimEnd();
    if (!value.trim()) {
      if (compacted.length > 0 && compacted.at(-1) !== "") compacted.push("");
      continue;
    }
    compacted.push(value);
  }
  while (compacted[0] === "") compacted.shift();
  while (compacted.at(-1) === "") compacted.pop();
  return { lines: compacted.slice(0, limit), omitted: Math.max(0, compacted.length - limit) };
}

export function summarizeAgentMessage(message: TranscriptMessage): AgentMessageSummary {
  const body: string[] = [];
  const activity: string[] = [];
  const warnings: string[] = [];

  for (const block of message.blocks) {
    if (block.kind !== "markdown") continue;
    for (const line of cleanMarkdown(block.text).split("\n")) {
      const classified = classifyAgentLine(line);
      if (!classified) continue;
      if (classified.kind === "body") body.push(classified.text);
      if (classified.kind === "activity") activity.push(classified.text);
      if (classified.kind === "warning") warnings.push(classified.text);
    }
  }

  const bodyResult = compactBodyLines(body, MAX_BLOCK_LINES);
  const activityResult = uniqueLimited(activity, 4);
  const warningResult = uniqueLimited(warnings, 3);
  return {
    bodyLines: bodyResult.lines,
    activityLines: activityResult.lines,
    warningLines: warningResult.lines,
    omittedBody: bodyResult.omitted,
    omittedActivity: activityResult.omitted,
  };
}

function nonMarkdownBlocks(message: TranscriptMessage): TranscriptBlock[] {
  return message.blocks.filter((block) => block.kind !== "markdown");
}

interface MessageDerived {
  error: HttpErrorInfo | null;
  spawnError: SpawnErrorInfo | null;
  craftedError: string | null;
  summary: AgentMessageSummary;
}

// Message objects are immutable — the reducer replaces the streaming message
// with a fresh object per chunk — so derived parses (dozens of regex passes
// over the full text) are computed once per object, not once per render.
// Without this, every keystroke and every 140ms spinner tick re-parsed the
// entire transcript.
const messageDerivedCache = new WeakMap<TranscriptMessage, MessageDerived>();

function deriveAgentMessage(message: TranscriptMessage): MessageDerived {
  const cached = messageDerivedCache.get(message);
  if (cached) return cached;
  const derived: MessageDerived = {
    error: messageHttpError(message),
    spawnError: messageSpawnError(message),
    craftedError: messageCraftedError(message),
    summary: summarizeAgentMessage(message),
  };
  messageDerivedCache.set(message, derived);
  return derived;
}

// Non-text blocks render as `⎿` follow-up lines under the turn, the way
// Claude Code prints tool results: subordinate, scannable, one line each.
function Block({ messageId, block, index, width }: { messageId: string; block: TranscriptBlock; index: number; width: number }) {
  const key = `msg-${messageId}-block-${index}`;
  switch (block.kind) {
    case "markdown": {
      const text = cleanMarkdown(block.text);
      const error = httpErrorInfo(text);
      if (error) {
        return (
          <box key={key} style={{ flexDirection: "column" }}>
            <text fg={theme.muted}>{`  ⎿ ${error.method} ${error.path} -> ${error.code}`}</text>
            <text fg={theme.muted}>{`     ${error.reason}`}</text>
          </box>
        );
      }
      return (
        <box key={key} style={{ flexDirection: "column" }}>
          {wrapWithIndent(text, width).map((line, lineIndex) => (
            <text key={`${key}-${lineIndex}`} fg={theme.foreground}>{line || " "}</text>
          ))}
        </box>
      );
    }
    case "code":
      return (
        <box key={key} style={{ flexDirection: "column" }}>
          {block.text.split("\n").slice(0, 10).map((line, lineIndex) => (
            <text key={`${key}-${lineIndex}`} fg={theme.foreground}>{truncate(`    ${line}`, width)}</text>
          ))}
          {block.text.split("\n").length > 10 ? (
            <text fg={theme.muted}>{`    … ${block.text.split("\n").length - 10} more lines`}</text>
          ) : null}
        </box>
      );
    case "diff": {
      // Collapsed patch ticket: one line in chat; line-by-line review (and
      // accept/reject) lives in the task overlay. diffStat keeps the counts
      // consistent with the rail and the run-detail overlay.
      const tag = block.status === "accepted" ? "  ✓ accepted"
        : block.status === "rejected" ? "  ✗ rejected"
        : "  · open to review";
      const fg = block.status === "accepted" ? theme.success
        : block.status === "rejected" ? theme.danger
        : theme.foreground;
      return <text key={key} fg={fg}>{truncate(`  ⎿ ${block.file || "patch"}   ${diffStat(block.diff)}${tag}`, width)}</text>;
    }
    case "toolCall":
      return <text key={key} fg={theme.muted}>{truncate(`  ⎿ ${block.label}${block.detail ? ` ${block.detail}` : ""}`, width)}</text>;
  }
}

const Message = memo(function Message({ message, width, startedAt }: { message: TranscriptMessage; width: number; startedAt?: number }) {
  if (message.chat) {
    const body = message.blocks.map(blockText).join("\n").trim();
    const fg = message.mine ? theme.muted : theme.foreground;
    const stamp = relativeTime(message.at);
    return (
      <box style={{ flexDirection: "column", paddingBottom: 1 }}>
        <box style={{ flexDirection: "row" }}>
          <text fg={theme.muted}>{"# "}</text>
          <text fg={fg}>{truncate(message.author || "teammate", Math.max(8, width - 8))}</text>
          {stamp ? <text fg={theme.muted}>{`  ${stamp}`}</text> : null}
        </box>
        {cleanMarkdown(body).split("\n").slice(0, 8).flatMap((line, index) =>
          wrapWithIndent(line, width).map((wrapped, wrapIndex) => (
            <text key={`${message.id}-chat-${index}-${wrapIndex}`} fg={fg}>{wrapped || " "}</text>
          )),
        )}
      </box>
    );
  }
  if (message.role === "you") {
    const lines = userMessageLines(message);
    return (
      <box style={{ flexDirection: "column", paddingBottom: 1 }}>
        {lines.flatMap((line, index) =>
          wrapWithIndent(line, width).map((wrapped, wrapIndex) => (
            <box key={`${message.id}-${index}-${wrapIndex}`} style={{ flexDirection: "row" }}>
              <text fg={theme.muted}>{index === 0 && wrapIndex === 0 ? "> " : "  "}</text>
              <text fg={theme.muted}>{wrapped.slice(2) || " "}</text>
            </box>
          )),
        )}
      </box>
    );
  }
  const label = agentLabel(message);
  const { error, spawnError, craftedError, summary } = deriveAgentMessage(message);
  const failed = Boolean(error || spawnError || craftedError);
  const otherBlocks = nonMarkdownBlocks(message);
  const dot = failed ? { glyph: "⏺", fg: theme.danger }
    : message.streaming ? { glyph: spinnerFrame(), fg: theme.accent }
    : { glyph: "⏺", fg: theme.success };
  return (
    <box style={{ flexDirection: "column", paddingBottom: 1 }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={dot.fg}>{dot.glyph}</text>
        <text fg={theme.foreground}>{` ${label}`}</text>
        {message.streaming ? (
          <text fg={theme.accent}>{`  working${startedAt ? ` · ${elapsedLabel(startedAt)}` : "…"}`}</text>
        ) : null}
        {failed ? <text fg={theme.danger}>  failed</text> : null}
      </box>
      {error ? (() => {
        const humane = humaneHttpError(error);
        return (
          <>
            {wrapWithIndent(humane.headline, width).map((line, index) => (
              <text key={`${message.id}-err-${index}`} fg={theme.warning}>{line}</text>
            ))}
            <text fg={theme.muted}>{truncate(`  ⎿ next: ${humane.next}`, width)}</text>
          </>
        );
      })() : null}
      {spawnError ? (
        <>
          <text fg={theme.warning}>{truncate(`  ${spawnError.tool} executable is missing`, width)}</text>
          <text fg={theme.muted}>{truncate(`  ⎿ path: ${spawnError.path}`, width)}</text>
          <text fg={theme.muted}>{truncate(`  ⎿ next: ${spawnError.next}`, width)}</text>
        </>
      ) : null}
      {craftedError ? (
        wrapWithIndent(craftedError, width).map((line, index) => (
          <text key={`${message.id}-crafted-${index}`} fg={theme.warning}>{line}</text>
        ))
      ) : null}
      {failed ? (
        <text fg={theme.muted}>{truncate("  ⎿ ↑ edits & resends · /retry reruns · /handoff tries another agent", width)}</text>
      ) : null}
      {/* No "waiting for output…" placeholder — the header's `working · 12s`
          already says it, and elapsed time answers "keep watching or not?" */}
      {!failed && summary.bodyLines.flatMap((line, index) =>
        (line ? wrapWithIndent(line, width) : [""]).map((wrapped, wrapIndex) => (
          <text key={`${message.id}-body-${index}-${wrapIndex}`} fg={wrapped ? theme.foreground : theme.faint}>
            {wrapped || " "}
          </text>
        )),
      )}
      {!failed && summary.omittedBody > 0 ? (
        <text fg={theme.muted}>{`  ⎿ … ${summary.omittedBody} more lines — /run opens the full task`}</text>
      ) : null}
      {otherBlocks.map((block, index) => (
        <Block key={index} messageId={message.id} block={block} index={index} width={width} />
      ))}
      {!spawnError && summary.activityLines.length > 0 ? (
        <text fg={theme.muted}>{truncate(`  ⎿ ${summary.activityLines.join(" · ")}${summary.omittedActivity > 0 ? ` · +${summary.omittedActivity}` : ""}`, width)}</text>
      ) : null}
      {!spawnError && summary.warningLines.map((line, index) => (
        <text key={`${message.id}-warning-${index}`} fg={theme.warning}>
          {truncate(`  ⎿ warning: ${line}`, width)}
        </text>
      ))}
    </box>
  );
}, (prev, next) =>
  // Streaming turns animate a spinner from Date.now(), so they re-render every
  // tick; settled turns re-render only when identity or layout changes.
  !next.message.streaming
  && prev.message === next.message
  && prev.width === next.width
  && prev.startedAt === next.startedAt);

function statusForRun(status?: string): string {
  if (status === "in_progress") return "running";
  return status || "idle";
}

// ── Welcome card ─────────────────────────────────────────────────────────────
// Claude Code greets an empty screen with a small bordered card that names the
// session and the first thing to try. Same shape here: room, provider, live
// state, and the two commands that matter. Signed-out / no-room states render
// their single next step in the same card instead of bare warning lines.
function WelcomeCard({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const { config, provider, session } = state.dashboard;
  const agents = state.dashboard.dashboard.agents || [];
  const target = conversationTarget(state);
  const readiness = providerReadiness(state);
  const runs = state.dashboard.dashboard.runs || [];
  const working = runs.filter((run) => run.status === "running" || run.status === "in_progress").length;
  const peers = roomPeers(state);
  const cardWidth = Math.max(40, Math.min(72, width - 2));
  const inner = cardWidth - 4;
  const lines: Array<{ text: string; fg: string } | { row: Array<{ text: string; fg: string }> }> = [];
  if (!session) {
    lines.push({ row: [{ text: "✻ ", fg: theme.accent }, { text: "co·ode — signed out", fg: theme.foreground }] });
    lines.push({ text: " ", fg: theme.muted });
    lines.push({ text: "/login  signs you in right here.", fg: theme.foreground });
  } else if (!config?.roomId) {
    lines.push({ row: [{ text: "✻ ", fg: theme.accent }, { text: "co·ode — no room here yet", fg: theme.foreground }] });
    lines.push({ text: " ", fg: theme.muted });
    lines.push({ text: "/init  creates a room for this folder.", fg: theme.foreground });
    lines.push({ text: "or open a folder that already has one.", fg: theme.muted });
  } else {
    lines.push({
      row: [
        { text: "✻ ", fg: readiness.ready ? theme.accent : theme.muted },
        { text: `co·ode — ${roomTitle(config.roomName, config.roomId)}`, fg: theme.foreground },
      ],
    });
    lines.push({ text: " ", fg: theme.muted });
    const crewBits = [
      peers.length > 0 ? `you + ${peers.length} teammate${peers.length === 1 ? "" : "s"}` : "just you so far",
      agents.length > 0 ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : "",
      working > 0 ? `${working} working now` : "",
    ].filter(Boolean).join(" · ");
    lines.push({ text: crewBits, fg: theme.muted });
    lines.push({
      text: readiness.ready ? `${provider} ready` : readiness.reason || `${provider} not ready`,
      fg: readiness.ready ? theme.muted : theme.warning,
    });
    lines.push({ text: " ", fg: theme.muted });
    if (target) {
      lines.push({ text: `Type to talk to ${target.label} — answers stream here.`, fg: theme.foreground });
      lines.push({ text: "# message …  posts to the room chat instead", fg: theme.muted });
    } else {
      lines.push({ text: "No agent can answer yet.", fg: theme.warning });
      lines.push({ text: "Install claude, codex, or opencode — then just type.", fg: theme.muted });
    }
    lines.push({ text: "/help  shortcuts · ⌃B  room panel", fg: theme.muted });
  }
  return (
    <box
      style={{
        width: cardWidth,
        flexShrink: 0,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: theme.faint,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {lines.map((line, index) =>
        "row" in line ? (
          <box key={index} style={{ flexDirection: "row" }}>
            {line.row.map((part, partIndex) => (
              <text key={partIndex} fg={part.fg}>{truncate(part.text, inner)}</text>
            ))}
          </box>
        ) : (
          <text key={index} fg={line.fg}>{truncate(line.text, inner)}</text>
        ),
      )}
    </box>
  );
}

// "2m" / "3h" / "2d" — enough to ground history without timestamp clutter.
function relativeTime(ts?: number): string {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// Once the room has history, the full welcome card is chrome — the header and
// rail already carry its facts. Collapse to one teaching line.
function WelcomeLine({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const target = conversationTarget(state);
  const readiness = providerReadiness(state);
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.accent}>{"✻ "}</text>
        <text fg={theme.muted}>
          {truncate(
            target
              ? `type to talk to ${target.label} · # room chat · /help`
              : "no agent can answer yet — install claude, codex, or opencode",
            Math.max(12, width - 2),
          )}
        </text>
      </box>
      {!readiness.ready && readiness.reason ? (
        <text fg={theme.warning}>{truncate(`  ${readiness.reason}`, width)}</text>
      ) : null}
    </box>
  );
}

type DashboardRun = OpenTuiPreviewUiState["dashboard"]["dashboard"]["runs"][number];

function runsForAgent(
  runs: OpenTuiPreviewUiState["dashboard"]["dashboard"]["runs"],
  agentId: string,
): DashboardRun[] {
  return runs
    .filter((run) => run.agent_id === agentId)
    .sort((left, right) => (right.created_at || 0) - (left.created_at || 0));
}

function runCounts(runs: DashboardRun[]): { done: number; queued: number; failed: number } {
  return {
    done: runs.filter((run) => run.status === "succeeded" || run.status === "completed").length,
    queued: runs.filter((run) => run.status === "queued").length,
    failed: runs.filter((run) => FAILED_RUN_STATUSES.has(run.status || "")).length,
  };
}

function currentRunForAgent(
  runs: OpenTuiPreviewUiState["dashboard"]["dashboard"]["runs"],
  agentId: string,
): DashboardRun | undefined {
  const agentRuns = runsForAgent(runs, agentId);
  return agentRuns.find((run) => run.status === "running" || run.status === "in_progress")
    || agentRuns.find((run) => run.status === "queued")
    || agentRuns.find((run) => run.status === "paused")
    || agentRuns.find((run) => run.status === "succeeded" || run.status === "completed");
}

function runActivityText(run: DashboardRun | undefined): string {
  if (!run) return "idle";
  const goal = oneLine(run.goal || "") || shortId(run._id);
  if (run.status === "running" || run.status === "in_progress") {
    return `${goal}${run.started_at ? ` · ${elapsedLabel(run.started_at)}` : ""}`;
  }
  if (run.status === "queued") return `${goal} · queued`;
  if (run.status === "paused") return `${goal} · paused`;
  const when = relativeTime(run.finished_at || run.created_at);
  return `last: ${goal}${when ? ` · ${when}` : ""}`;
}

function floorActivityText(run: DashboardRun | undefined, counts: { done: number; queued: number; failed: number }): string {
  if (run && (run.status === "running" || run.status === "in_progress" || run.status === "queued" || run.status === "paused")) {
    return runActivityText(run);
  }
  const bits = ["ready"];
  if (counts.done > 0) bits.push(`${counts.done} done`);
  if (counts.queued > 0) bits.push(`${counts.queued} queued`);
  if (counts.failed > 0) bits.push(`${counts.failed} need retry`);
  return bits.join(" · ");
}

function agentFloorGlyph(run: DashboardRun | undefined): { glyph: string; fg: string } {
  if (!run) return { glyph: "○", fg: theme.muted };
  if (run.status === "running" || run.status === "in_progress") return { glyph: spinnerFrame(), fg: theme.accent };
  if (run.status === "queued") return { glyph: "◌", fg: theme.warning };
  if (run.status === "paused") return { glyph: "⏸", fg: theme.warning };
  return { glyph: "●", fg: theme.success };
}

// Agent Floor board: the room's first viewport. It leads with live agents and
// current work, then stream and attention. Old history is useful context, but
// it must never be the product's first impression.
function AgentFloorBoard({ state, width, railVisible, transcriptEmpty }: {
  state: OpenTuiPreviewUiState;
  width: number;
  railVisible: boolean;
  transcriptEmpty: boolean;
}) {
  const agents = state.dashboard.dashboard.agents || [];
  const allRuns = state.dashboard.dashboard.runs || [];
  const messages = transcriptEmpty ? (state.dashboard.dashboard.messages || []) : [];
  const patches = state.dashboard.dashboard.patches || [];
  const agentRows = buildAgentActivityRows({
    agents,
    runs: allRuns,
    providerAvailability: state.dashboard.providerAvailability,
  });
  const proposedPatches = patches.filter((patch) => patch.status === "proposed");
  const failed = unresolvedFailures(allRuns.slice(0, 12), state.dismissedRunIds);
  const recentFinished = allRuns
    .filter((run) => run.status === "succeeded" || run.status === "completed")
    .sort((a, b) => (b.finished_at || b.created_at || 0) - (a.finished_at || a.created_at || 0))
    .slice(0, 2);
  const recentMessages = messages
    .filter((message) => {
      const body = oneLine(message.body_md || "").toLowerCase();
      return body.length > 8 && !/^(hi|hello|hey|hola|yo|yoo|hii+)[.!?]*$/.test(body);
    })
    .slice(-2);
  const earlierMessages = messages.slice(Math.max(0, messages.length - 6), Math.max(0, messages.length - 2));
  const agentName = (id?: string) => agentNameFor(state, id);
  const lineWidth = Math.max(12, width - 1);
  const hasLiveRoom = state.dashboard.session && state.dashboard.config?.roomId;
  const hasBoardContent = agentRows.length > 0 || allRuns.length > 0 || messages.length > 0 || proposedPatches.length > 0 || failed.length > 0;
  const totalDone = allRuns.filter((run) => run.status === "succeeded" || run.status === "completed").length;
  const lastActivityAt = Math.max(
    0,
    ...allRuns.map((run) => run.finished_at || run.created_at || 0),
    ...messages.map((message) => message.created_at || 0),
    ...patches.map((patch) => patch.created_at || 0),
  );
  const pulse = [
    totalDone > 0 ? `${totalDone} done` : "",
    failed.length > 0 ? `${failed.length} need retry` : "inbox clear",
    lastActivityAt > 0 ? `last activity ${relativeTime(lastActivityAt)}` : "",
  ].filter(Boolean).join(" · ");
  if (!hasLiveRoom || !hasBoardContent) return <WelcomeLine state={state} width={width} />;
  return (
    <box style={{ flexDirection: "column", paddingTop: 1 }}>
      {agentRows.length > 0 ? (
        <>
          <text fg={theme.muted}>now</text>
          {agentRows.slice(0, railVisible ? 4 : 6).map((row) => {
            const agentRuns = runsForAgent(allRuns, row.agentId);
            const current = currentRunForAgent(allRuns, row.agentId);
            const glyph = agentFloorGlyph(current);
            const counts = runCounts(agentRuns);
            return (
              <box key={row.agentId} style={{ flexDirection: "column", flexShrink: 0 }}>
                <box style={{ flexDirection: "row" }}>
                  <text fg={glyph.fg}>{`${glyph.glyph} `}</text>
                  <text fg={theme.foreground}>{truncate(`@${agentHandle({ _id: row.agentId, name: row.name })}`, Math.max(12, Math.floor(lineWidth * 0.36)))}</text>
                  <text fg={theme.muted}>{truncate(`  ${row.provider}`, Math.max(8, Math.floor(lineWidth * 0.16)))}</text>
                </box>
                <text fg={theme.muted}>
                  {truncate(`  ${floorActivityText(current, counts)}`, lineWidth)}
                </text>
                {current && (current.status === "succeeded" || current.status === "completed") ? (
                  <text fg={theme.muted}>{truncate(`  ${runActivityText(current)}`, lineWidth)}</text>
                ) : null}
              </box>
            );
          })}
          {pulse ? <text fg={theme.faint}>{truncate(`room pulse · ${pulse}`, lineWidth)}</text> : null}
          <text> </text>
        </>
      ) : (
        <>
          <text fg={theme.muted}>now</text>
          <text fg={theme.muted}>  no agents in this room yet</text>
          <text fg={theme.muted}>  /agent-add adds one · @provider targets a local CLI</text>
          <text> </text>
        </>
      )}

      {recentMessages.length > 0 || recentFinished.length > 0 || proposedPatches.length > 0 ? (
        <>
          <text fg={theme.muted}>stream</text>
          {recentMessages.map((message) => {
            const who = chatAuthorLabel(message, state);
            const body = oneLine(message.body_md || "");
            return (
              <box key={`stream-msg-${message._id}`} style={{ flexDirection: "column", flexShrink: 0 }}>
                <box style={{ flexDirection: "row" }}>
                  <text fg={who.mine ? theme.muted : theme.foreground}>▌ </text>
                  <text fg={who.mine ? theme.muted : theme.foreground}>{who.mine ? "you" : who.label}</text>
                  {message.author_type === "agent" ? <text fg={theme.muted}>{" · agent"}</text> : null}
                  {relativeTime(message.created_at) ? <text fg={theme.muted}>{`  ${relativeTime(message.created_at)}`}</text> : null}
                </box>
                <text fg={who.mine ? theme.muted : theme.foreground}>{truncate(`  ${body}`, lineWidth)}</text>
              </box>
            );
          })}
          {recentFinished.map((run) => (
            <box key={`stream-run-${run._id}`} style={{ flexDirection: "row", flexShrink: 0 }}>
              <text fg={theme.success}>✓ </text>
              <text fg={theme.foreground}>{truncate(`${oneLine(run.goal || "") || shortId(run._id)} — ${agentName(run.agent_id)}`, Math.max(12, lineWidth - 8))}</text>
              {relativeTime(run.finished_at || run.created_at) ? (
                <text fg={theme.muted}>{`  ${relativeTime(run.finished_at || run.created_at)}`}</text>
              ) : null}
            </box>
          ))}
          {proposedPatches.slice(0, 2).map((patch) => (
            <text key={`stream-patch-${patch._id}`} fg={theme.foreground}>
              {truncate(`▸ ${patch.path || patch.title || "patch"}  ${diffStat(patch.diff_text)}  review`, lineWidth)}
            </text>
          ))}
          <text> </text>
        </>
      ) : null}

      {proposedPatches.length > 0 || failed.length > 0 ? (
        <>
          <text fg={theme.muted}>needs you</text>
          {proposedPatches.slice(0, 3).map((patch) => (
            <text key={`needs-patch-${patch._id}`} fg={theme.warning}>
              {truncate(`▲ ${patch.path || patch.title || "patch"}  ${diffStat(patch.diff_text)} · a accept · x reject`, lineWidth)}
            </text>
          ))}
          {failed.length > 0 ? (
            <>
              <box style={{ flexDirection: "row", flexShrink: 0 }}>
                <text fg={theme.danger}>✗ </text>
                <text fg={theme.foreground}>{truncate(`${failed.length} task${failed.length === 1 ? "" : "s"} need retry`, Math.max(12, Math.floor(lineWidth * 0.34)))}</text>
                <text fg={theme.muted}>
                  {truncate(
                    `  latest: ${oneLine(failed[0]?.goal || "") || (failed[0] ? shortId(failed[0]._id) : "task")} — ${agentName(failed[0]?.agent_id)}`,
                    Math.max(12, Math.floor(lineWidth * 0.58)),
                  )}
                </text>
              </box>
              <text fg={theme.muted}>{truncate("  R retry latest · d dismiss · /inbox opens all", lineWidth)}</text>
            </>
          ) : null}
          {(proposedPatches.length + failed.length) > proposedPatches.slice(0, 3).length + (failed.length > 0 ? 1 : 0) ? (
            <text fg={theme.muted}>{truncate(`  +${proposedPatches.length + failed.length - proposedPatches.slice(0, 3).length - (failed.length > 0 ? 1 : 0)} more`, lineWidth)}</text>
          ) : null}
          <text> </text>
        </>
      ) : null}

      {earlierMessages.length > 0 ? (
        <>
          <text fg={theme.muted}>earlier</text>
          <text fg={theme.muted}>
            {truncate(`  ${earlierMessages.length} older room message${earlierMessages.length === 1 ? "" : "s"} · latest ${relativeTime(earlierMessages.at(-1)?.created_at) || "earlier"}`, lineWidth)}
          </text>
          <text> </text>
        </>
      ) : null}
    </box>
  );
}

const Transcript = memo(function Transcript({
  state,
  transcript,
  feed,
  contentWidth,
  railVisible,
}: {
  state: OpenTuiPreviewUiState;
  transcript: TranscriptMessage[];
  feed: OpenTuiPreviewFeedEntry[];
  contentWidth: number;
  railVisible: boolean;
}) {
  const visibleFeed = feed
    .filter((entry) => !isTaskFeedNoise(entry))
    .filter((entry) => transcript.length === 0 || isRoomSystemFeed(entry))
    .slice(-3);
  const empty = transcript.length === 0;
  return (
    <scrollbox
      style={{ flexGrow: 1, flexDirection: "column", paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2 }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
      stickyScroll
      stickyStart="bottom"
      contentOptions={{ minHeight: "100%", justifyContent: "flex-end" }}
    >
      {/* The room board is the transcript's header, not an empty-state screen:
          it hangs from the top while the conversation gravitates to the
          composer, and the spacer absorbs whatever is left. One chat message
          must never collapse the whole board back into a void. */}
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {empty && !(state.dashboard.session && state.dashboard.config?.roomId
          && ((state.dashboard.dashboard.messages?.length || 0) > 0 || state.dashboard.dashboard.runs.length > 0))
          ? <WelcomeCard state={state} width={contentWidth} />
          : <AgentFloorBoard state={state} width={contentWidth} railVisible={railVisible} transcriptEmpty={empty} />}
      </box>
      <box style={{ flexGrow: 1 }} />
      {transcript.map((message) => (
        <Message
          key={message.id}
          message={message}
          width={contentWidth}
          startedAt={message.streaming && state.taskRunning ? state.taskStartedAt : undefined}
        />
      ))}
      {visibleFeed.map((entry, index) => (
        <text key={`feed-${index}`} fg={feedFg(entry.kind)}>{truncate(`· ${feedText(entry)}`, contentWidth)}</text>
      ))}
    </scrollbox>
  );
});

// ── Room rail ────────────────────────────────────────────────────────────────
// The glanceable half of the workspace, organized around one question: who is
// in this room and what are they doing? The crew list is the only thing to
// navigate — each agent carries its own work underneath it, so there is no
// separate task list to cross-reference. One cursor (`›`), `↑/↓` to move,
// `⏎` opens the selected agent's latest task, ⌃B tucks the rail away.
// Color discipline: glyphs carry status, text stays calm.

function RailSection({ label, badge, badgeFg, children }: {
  label: string;
  badge?: string;
  badgeFg?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <text> </text>
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        {/* Labels carry meaning — muted, never the faint border color, which
            disappears on transparent terminal backgrounds. */}
        <text fg={theme.muted}>{`  ${label}`}</text>
        {badge ? <text fg={badgeFg || theme.muted}>{`  ${badge}`}</text> : null}
      </box>
      {/* Sections never compress — when the rail runs out of rows they clip
          as a block instead of compositing rows into garbled text. */}
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        {children}
      </box>
    </>
  );
}

function authorGlyph(type?: string): { glyph: string; fg: string } {
  if (type === "user") return { glyph: ">", fg: theme.foreground };
  if (type === "system") return { glyph: "·", fg: theme.muted };
  return { glyph: "⏺", fg: theme.accent };
}

function firstLine(text: string): string {
  return ((text || "").split("\n").find((line) => line.trim()) || "").trim();
}

// Agent-centric rail: the crew is the single navigable list; each agent's
// work hangs under its name. "Needs you" is the human inbox; room chat sits
// quietly at the bottom.
const Panel = memo(function Panel({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const panelWidth = Math.max(SIDE_RAIL_MIN_WIDTH, Math.min(SIDE_RAIL_MAX_WIDTH, width));
  const lineWidth = panelWidth - 3;
  const agents = state.dashboard.dashboard.agents || [];
  const runs = state.dashboard.dashboard.runs || [];
  const messages = state.dashboard.dashboard.messages || [];
  const patches = state.dashboard.dashboard.patches || [];
  const bridge = state.dashboard.bridge;
  const providerAvailability = state.dashboard.providerAvailability;
  const providerAuth = state.dashboard.providerAuth;
  const selectedAgentId = state.selectedAgentId;
  const tab = state.panelTab;
  const rows = buildAgentActivityRows({ agents, runs, providerAvailability });
  const agentName = (id?: string) => agents.find((agent) => agent._id === id)?.name || shortId(id);
  // "Needs you" is an inbox, not an archive: open patches first (review is
  // the product), then failures among the most recent runs — so stale red
  // ages out on its own.
  const proposedPatches = patches.filter((patch) => patch.status === "proposed");
  const failedRuns = unresolvedFailures(runs.slice(0, 10), state.dismissedRunIds);
  const attention = proposedPatches.length + failedRuns.length;
  const agentForPatch = (patch: PatchRecord): string | null => {
    const run = runs.find((candidate) => candidate._id === patch.run_id);
    return run ? agentName(run.agent_id) : null;
  };
  const providerTargets = providerMentionTargets({ agents, providerAvailability, providerAuth })
    .filter((target) => target.kind === "provider");
  const railPeers = roomPeers(state).slice(0, 3);
  const tabFor = (id: PanelTabId, label: string) => (
    <box key={id} style={{ flexDirection: "row" }}>
      <text fg={tab === id ? theme.foreground : theme.muted}>{id === "chat" && attention > 0 ? `${label}·${attention}` : label}</text>
      <text fg={theme.faint}>{"   "}</text>
    </box>
  );
  return (
    <box
      style={{
        width: panelWidth,
        flexShrink: 0,
        flexDirection: "column",
        border: ["left"],
        borderStyle: "single",
        // Matches the header rule — the two lines form the room's one frame.
        borderColor: theme.muted,
        padding: 1,
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.faint}>{"  "}</text>
        {tabFor("room", "agents")}
        {tabFor("chat", "inbox")}
        {tabFor("projects", "rooms")}
      </box>
      {/* Clip, never overlap: at very short heights the sections exceed the
          rail and opentui composites overflowing rows into garbled text. */}
      <box style={{ flexGrow: 1, flexDirection: "column", overflow: "hidden" }}>
        {tab === "room" ? (
          <>
            <RailSection label="agents">
              <box style={{ flexDirection: "row", flexShrink: 0 }}>
                <text fg={theme.foreground}>{truncate(railPeers.length > 0 ? `  you + ${railPeers.join(", ")}` : "  you", lineWidth - 11)}</text>
                {bridge === "running" ? <text fg={theme.success}>{"  · bridge ●"}</text> : null}
              </box>
              {rows.length === 0 ? (
                providerTargets.length === 0 ? (
                  <>
                    <text fg={theme.muted}>{truncate("  no agents yet", lineWidth)}</text>
                    <text fg={theme.muted}>{truncate("  /agent-add ana codex", lineWidth)}</text>
                  </>
                ) : (
                  providerTargets.slice(0, 5).map((target) => (
                    <text key={target._id} fg={theme.muted}>
                      {truncate(`  ◌ @${agentHandle(target)} · ${target.status || "available"}`, lineWidth)}
                    </text>
                  ))
                )
              ) : (
                rows.slice(0, 5).map((row) => {
                  const selected = selectedAgentId === row.agentId;
                  const agentRuns = runsForAgent(runs, row.agentId);
                  const current = currentRunForAgent(runs, row.agentId);
                  const counts = runCounts(agentRuns);
                  const running = current?.status === "running" || current?.status === "in_progress";
                  const queued = !running && current?.status === "queued";
                  const paused = !running && !queued && current?.status === "paused";
                  const glyph = running ? { text: spinnerFrame(), fg: theme.accent }
                    : queued ? { text: "◌", fg: theme.warning }
                    : paused ? { text: "⏸", fg: theme.warning }
                    : { text: current ? "●" : "○", fg: row.availability === "available" || row.availability === "external" ? theme.success : theme.muted };
                  const doing = floorActivityText(current, counts);
                  const stats = [
                    counts.done > 0 ? `${counts.done} done` : "",
                    counts.queued > 0 ? `${counts.queued} queued` : "",
                    counts.failed > 0 ? `${counts.failed} retry` : "",
                  ].filter(Boolean).join(" · ");
                  const selectedDetail = current && (current.status === "succeeded" || current.status === "completed")
                    ? runActivityText(current)
                    : stats;
                  return (
                    // flexShrink 0: a 2-3 row agent card must clip at tiny
                    // heights, never compress — compressed rows composite into
                    // garbled text ("implement darkcmode toggle").
                    <box key={row.agentId} style={{ flexDirection: "column", flexShrink: 0 }}>
                      <box style={{ flexDirection: "row" }}>
                        <text fg={selected ? theme.foreground : theme.muted}>{selected ? "› " : "  "}</text>
                        <text fg={glyph.fg}>{glyph.text}</text>
                        <text fg={selected ? theme.foreground : theme.muted}>
                          {truncate(` ${agentDisplayHandle(row)}`, Math.max(10, Math.floor(lineWidth * 0.58)))}
                        </text>
                        {lineWidth >= 24 ? <text fg={theme.muted}>{truncate(`  ${row.provider}`, Math.max(12, Math.floor(lineWidth * 0.28)))}</text> : null}
                      </box>
                      <text fg={theme.muted}>{truncate(`    ${doing}`, lineWidth)}</text>
                      {selected && selectedDetail ? (
                        <text fg={theme.muted}>
                          {truncate(`    ${selectedDetail}`, lineWidth)}
                        </text>
                      ) : null}
                      {selected && row.availabilityReason && row.availability !== "available" ? (
                        <text fg={theme.warning}>{truncate(`    ${row.availabilityReason}`, lineWidth)}</text>
                      ) : null}
                    </box>
                  );
                })
              )}
            </RailSection>
            {proposedPatches.length > 0 || failedRuns.length > 0 ? (
              <RailSection
                label="needs you"
                badge={`${proposedPatches.length + failedRuns.length}`}
                badgeFg={proposedPatches.length > 0 ? theme.warning : theme.danger}
              >
                {proposedPatches.slice(0, 3).map((patch) => (
                  <box key={patch._id} style={{ flexDirection: "row", flexShrink: 0 }}>
                    <text fg={theme.warning}>{"  ▲ "}</text>
                    <text fg={theme.foreground}>
                      {truncate(
                        `${patch.path || patch.title || "patch"}  ${diffStat(patch.diff_text)}${agentForPatch(patch) ? ` — ${agentForPatch(patch)}` : ""}`,
                        Math.max(8, lineWidth - 4),
                      )}
                    </text>
                  </box>
                ))}
                {proposedPatches.length > 3 ? (
                  <text fg={theme.muted}>{truncate(`    +${proposedPatches.length - 3} more to review`, lineWidth)}</text>
                ) : null}
                {proposedPatches.length > 0 ? (
                  <text fg={theme.muted}>{truncate("    ⏎ review · a accept · x reject", lineWidth)}</text>
                ) : null}
                {failedRuns.length > 0 ? (
                  <>
                    <box style={{ flexDirection: "row", flexShrink: 0 }}>
                      <text fg={theme.danger}>{"  ✗ "}</text>
                      <text fg={theme.foreground}>{truncate(`${failedRuns.length} need retry`, Math.max(8, lineWidth - 4))}</text>
                    </box>
                    <text fg={theme.muted}>
                      {truncate(`    latest: ${oneLine(failedRuns[0]?.goal || "") || (failedRuns[0] ? shortId(failedRuns[0]._id) : "task")}`, lineWidth)}
                    </text>
                    <text fg={theme.muted}>{truncate("    R retry · d dismiss", lineWidth)}</text>
                  </>
                ) : null}
              </RailSection>
            ) : null}
            {(() => {
              // Dedupe by rendered text (keep the newest) — the same action
              // repeated three times is one fact, not three lines of noise.
              const deduped = new Map<string, OpenTuiPreviewFeedEntry>();
              for (const entry of (state.feed || [])
                .filter((candidate) => !isTaskFeedNoise(candidate))
                .filter((candidate) => !/^(Run|Task) \S*[a-z0-9]{12,}/i.test(oneLine(candidate.text)))) {
                deduped.set(feedText(entry), entry);
              }
              const activity = [...deduped.values()].slice(-3);
              if (activity.length === 0) return null;
              return (
                <RailSection label="activity">
                  {activity.map((entry, index) => (
                    <text key={`activity-${index}`} fg={feedFg(entry.kind)}>
                      {truncate(`  · ${feedText(entry)}`, lineWidth)}
                    </text>
                  ))}
                </RailSection>
              );
            })()}
          </>
        ) : tab === "chat" ? (
          <RailSection label="inbox" badge={attention > 0 ? `${attention}` : undefined} badgeFg={attention > 0 ? theme.danger : theme.muted}>
            {proposedPatches.length === 0 && failedRuns.length === 0 ? (
              <>
                <text fg={theme.muted}>{truncate("  nothing needs you", lineWidth)}</text>
                <text fg={theme.muted}>{truncate("  keep the room moving", lineWidth)}</text>
              </>
            ) : null}
            {proposedPatches.slice(0, 8).map((patch) => (
              <box key={patch._id} style={{ flexDirection: "column", flexShrink: 0 }}>
                <text fg={theme.warning}>{truncate(`  ▲ ${patch.path || patch.title || "patch"}`, lineWidth)}</text>
                <text fg={theme.muted}>{truncate(`    ${diffStat(patch.diff_text)} · a accept · x reject`, lineWidth)}</text>
              </box>
            ))}
            {failedRuns.length > 0 ? (
              <box style={{ flexDirection: "column", flexShrink: 0 }}>
                <text fg={theme.foreground}>{truncate(`  ✗ ${failedRuns.length} task${failedRuns.length === 1 ? "" : "s"} need retry`, lineWidth)}</text>
                <text fg={theme.muted}>
                  {truncate(`    latest: ${oneLine(failedRuns[0]?.goal || "") || (failedRuns[0] ? shortId(failedRuns[0]._id) : "task")} — ${agentName(failedRuns[0]?.agent_id)}`, lineWidth)}
                </text>
                {failedRuns.length > 1 ? (
                  <text fg={theme.muted}>{truncate(`    +${failedRuns.length - 1} more in this room`, lineWidth)}</text>
                ) : null}
              </box>
            ) : null}
            <text> </text>
            <text fg={theme.muted}>{truncate("  ⏎ open · R retry · d dismiss", lineWidth)}</text>
          </RailSection>
        ) : (
          <RailSection label="rooms">
            {(() => {
              const rooms = knownOpenTuiRooms(state);
              if (rooms.length === 0) {
                return <text fg={theme.muted}>{truncate("  no rooms yet — /init creates one", lineWidth)}</text>;
              }
              const currentIndex = Math.max(0, rooms.findIndex((room) => room.roomId === state.dashboard.config?.roomId));
              const cursor = Math.max(0, Math.min(rooms.length - 1, state.railProjectSelected ?? currentIndex));
              return rooms.slice(0, 12).map((room, index) => {
                const isCurrent = room.roomId === state.dashboard.config?.roomId;
                const selected = index === cursor;
                const label = room.roomName || shortId(room.roomId);
                const counts = [
                  room.agentCount !== undefined ? `${room.agentCount} agent${room.agentCount === 1 ? "" : "s"}` : "",
                  room.memberCount !== undefined ? `${room.memberCount} member${room.memberCount === 1 ? "" : "s"}` : "",
                ].filter(Boolean).join(" · ");
                return (
                  <box key={room.roomId} style={{ flexDirection: "column", flexShrink: 0 }}>
                    <box style={{ flexDirection: "row" }}>
                      <text fg={selected ? theme.foreground : theme.muted}>{selected ? "› " : "  "}</text>
                      <text fg={isCurrent ? theme.accent : theme.muted}>{isCurrent ? "● " : "○ "}</text>
                      <text fg={selected || isCurrent ? theme.foreground : theme.muted}>
                        {truncate(label, Math.max(8, lineWidth - 6))}
                      </text>
                    </box>
                    {selected && counts ? (
                      <text fg={theme.muted}>{truncate(`      ${counts}`, lineWidth)}</text>
                    ) : null}
                  </box>
                );
              });
            })()}
            <text> </text>
            <text fg={theme.muted}>{truncate("  ⏎ switches the room", lineWidth)}</text>
          </RailSection>
        )}
      </box>
      <text fg={theme.muted}>{truncate("←→ tab · ↑↓ pick · ⏎ open · ⌃B hide", lineWidth)}</text>
    </box>
  );
});

// ── Composer dock ────────────────────────────────────────────────────────────

function composerPlaceholder(state: OpenTuiPreviewUiState): string {
  const target = conversationTarget(state);
  if (!state.dashboard.session) return "/login to enter the room…";
  if (!state.dashboard.config?.roomId) return "/init to create a coding room…";
  if (state.taskInput.startsWith("#")) return "Message the room…";
  if (state.taskInput.startsWith("/")) return "Run a command…";
  return target ? `Ask ${target.label} to work…` : "No agent connected — # messages the room…";
}

// Autocomplete: @agent mentions while addressing an agent, or / slash commands.
// Appears only while typing one, so the composer stays quiet otherwise.
function ComposerSuggestions({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const suggestions = composerSuggestions(state.taskInput, state.taskCursor, openTuiMentionTargets(state), 5);
  if (suggestions.length === 0) return null;
  const selected = Math.min(Math.max(0, state.taskSuggestionSelected), suggestions.length - 1);
  const rowWidth = Math.max(24, width - 8);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 2 }}>
      {suggestions.map((suggestion, index) => {
        const active = index === selected;
        return (
          <text key={suggestion.command} fg={active ? theme.foreground : theme.muted}>
            {truncate(`${active ? "›" : " "} ${suggestion.command.padEnd(14)} ${suggestion.detail}`, rowWidth)}
          </text>
        );
      })}
      <text fg={theme.muted}>{truncate("  ⇥ complete · ↑↓ pick · ⏎ run", rowWidth)}</text>
    </box>
  );
}

function Composer({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const slashActive = composerSuggestions(state.taskInput, state.taskCursor, openTuiMentionTargets(state), 1).length > 0;
  const inner = Math.max(12, width - 6);
  const window = composerWindow(state.taskInput, state.taskCursor, inner, COMPOSER_MAX_LINES);
  const empty = state.taskInput.length === 0;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <ComposerSuggestions state={state} width={width} />
      <box
        style={{
          flexDirection: "column",
          flexShrink: 0,
          border: true,
          borderStyle: "rounded",
          borderColor: slashActive ? theme.muted : theme.faint,
          paddingLeft: 1,
        }}
      >
        {empty ? (
          <box style={{ flexDirection: "row" }}>
            <text fg={theme.foreground}>{"> "}</text>
            <text fg={theme.muted}>{composerPlaceholder(state)}</text>
          </box>
        ) : (
          <>
            {window.hiddenAbove > 0 ? (
              <text fg={theme.muted}>{`… ${window.hiddenAbove} earlier line${window.hiddenAbove === 1 ? "" : "s"}`}</text>
            ) : null}
            {window.lines.map((line, index) => (
              <text key={`composer-${index}`} fg={theme.foreground}>
                {index === 0 && window.hiddenAbove === 0 ? `> ${line}` : `  ${line}`}
              </text>
            ))}
            {window.hiddenBelow > 0 ? (
              <text fg={theme.muted}>{`… ${window.hiddenBelow} more line${window.hiddenBelow === 1 ? "" : "s"}`}</text>
            ) : null}
          </>
        )}
      </box>
    </box>
  );
}

// ── Header bar ───────────────────────────────────────────────────────────────
// One line that makes the room legible before anything is typed: which room
// this is, who is here, and what the fleet is doing right now. This is the
// ambient multiplayer surface — it stays even when the side rail is hidden
// (narrow terminals), so the room never collapses into a single-agent CLI.

function isMineMessage(message: MessageRecord, state: OpenTuiPreviewUiState): boolean {
  if (message.author_type !== "user") return false;
  const identity = state.dashboard.identity;
  if (message.author_workos_id && identity?.workosUserId) {
    return message.author_workos_id === identity.workosUserId;
  }
  if (message.author_name && identity?.name) {
    return message.author_name === identity.name;
  }
  return false;
}

function chatAuthorLabel(message: MessageRecord, state: OpenTuiPreviewUiState): { label: string; mine: boolean } {
  if (isMineMessage(message, state)) return { label: "you", mine: true };
  return {
    label: message.author_name || (message.author_type === "agent" ? "agent" : message.author_type === "user" ? "teammate" : "system"),
    mine: false,
  };
}

// Who is here: real presence when the backend provides it, otherwise inferred
// from recent message authors (the pre-presence fallback).
function roomPeers(state: OpenTuiPreviewUiState): string[] {
  const identity = state.dashboard.identity;
  const presence = state.dashboard.dashboard.presence || [];
  if (presence.length > 0) {
    return Array.from(new Set(
      presence
        .filter((entry) => entry.name && (!identity?.workosUserId || entry.workos_user_id !== identity.workosUserId))
        .map((entry) => entry.name as string),
    ));
  }
  return Array.from(new Set(
    (state.dashboard.dashboard.messages || [])
      .filter((message) => message.author_type === "user" && message.author_name
        && !/^you$/i.test(message.author_name)
        && !isMineMessage(message, state))
      .map((message) => message.author_name as string),
  ));
}

function HeaderBar({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const { config } = state.dashboard;
  const runs = state.dashboard.dashboard.runs || [];
  const agents = state.dashboard.dashboard.agents || [];
  const working = runs.filter((run) => run.status === "running" || run.status === "in_progress").length;
  const queued = runs.filter((run) => run.status === "queued").length;
  const paused = runs.filter((run) => run.status === "paused").length;
  const failed = unresolvedFailures(runs, state.dismissedRunIds).length;
  const toReview = (state.dashboard.dashboard.patches || []).filter((patch) => patch.status === "proposed").length;
  const here = 1 + roomPeers(state).length;

  const right: Array<{ text: string; fg: string }> = [];
  right.push({ text: `${here} here`, fg: here > 1 ? theme.foreground : theme.muted });
  if (agents.length > 0) right.push({ text: `${agents.length} agent${agents.length === 1 ? "" : "s"}`, fg: theme.muted });
  if (working > 0) right.push({ text: `${spinnerFrame()} ${working} working`, fg: theme.accent });
  if (toReview > 0) right.push({ text: `▲ ${toReview} to review`, fg: theme.warning });
  if (queued > 0) right.push({ text: `◌ ${queued} queued`, fg: theme.warning });
  if (paused > 0) right.push({ text: `⏸ ${paused} paused`, fg: theme.warning });
  if (failed > 0) right.push({ text: `retry ${failed}`, fg: theme.danger });

  const title = config?.roomId ? roomTitle(config.roomName, config.roomId) : "no room";
  // Theo: "always show the current branch — parallel work is first-class."
  const branch = state.workspace?.isGitRepo && state.workspace.branch
    ? `⎇ ${state.workspace.branch}${state.workspace.dirty ? "*" : ""}`
    : "";
  // The brand dot is the live indicator: ember while changes PUSH to this
  // screen (convex subscription or SSE), muted when the room is only polled.
  const pushLive = state.liveTransport === "convex" || state.liveTransport === "sse";
  // Drop right-side segments until the line fits the terminal.
  const rendered = [...right];
  const used = () => 11 + title.length + rendered.reduce((sum, part) => sum + part.text.length + 3, 0);
  while (rendered.length > 1 && used() > width - 2) rendered.pop();

  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 2, paddingRight: 2, justifyContent: "space-between" }}>
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.foreground}>co</text>
        <text fg={pushLive ? theme.accent : theme.muted}>·</text>
        <text fg={theme.foreground}>ode</text>
        <text fg={theme.faint}>{"  "}</text>
        <text fg={theme.muted}>{truncate(title, Math.max(8, Math.floor(width * 0.3)))}</text>
        {branch && width >= 80 ? (
          <text fg={theme.muted}>{truncate(`  ${branch}`, Math.max(8, Math.floor(width * 0.25)))}</text>
        ) : null}
      </box>
      <box style={{ flexDirection: "row" }}>
        {rendered.map((part, index) => (
          <box key={index} style={{ flexDirection: "row" }}>
            {index > 0 ? <text fg={theme.faint}>{" · "}</text> : null}
            <text fg={part.fg}>{part.text}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

// One status line under the composer, Claude Code style. Left: what's
// happening (transient message > working spinner > key hints). Right: where a
// message lands — the header above owns room identity and fleet counts.
function StatusLine({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const { provider } = state.dashboard;
  const message = shouldShowTransientMessage(state.message) ? statusDetail(state.message) : "";
  const messageError = /fail|error|expired|missing|offline|denied|unknown/i.test(message);
  // "signed out" is a fixable state, not a failure — but it must not whisper
  // in muted gray while the rest of the screen claims everything is fine.
  const messageWarning = /signed out|not signed in|no permission/i.test(message);
  const elapsed = state.taskRunning ? elapsedLabel(state.taskStartedAt) : "";

  const keysFor = (): string => {
    if (state.mode === "confirm") return "⏎ confirm · esc cancel";
    if (state.mode === "palette") return "↑↓ pick · ⏎ run · esc close";
    if (state.mode === "run") return "j/k patch · a accept · x reject · esc back";
    if (state.mode === "help") return "esc closes";
    const multiRoom = (state.dashboard.rooms || []).length > 1;
    if (width >= 96) {
      return multiRoom
        ? "⏎ send · # room · / commands · ⌃P palette · ⌃B panel"
        : "⏎ send · # room · ⌃P palette · ⌃B panel · /help";
    }
    return "⏎ send · / commands · /help";
  };

  const target = conversationTarget(state);
  const readiness = providerReadiness(state);
  const attached = state.attachments.length > 0 ? `${state.attachments.length} attached` : "";
  const rightParts: Array<{ text: string; fg: string }> = [];
  if (attached) rightParts.push({ text: attached, fg: theme.warning });
  // One identity segment: who answers Enter, and whether it can. `@opencode ✓`
  // collapses target+provider; a distinct target shows alongside the provider.
  const providerMark = { text: `${provider} ${readiness.ready ? "✓" : "✗"}`, fg: readiness.ready ? theme.success : theme.danger };
  if (target && target.label !== `@${provider}`) {
    rightParts.push({ text: truncate(`⏎ ${target.label}`, 20), fg: theme.foreground });
    rightParts.push(providerMark);
  } else if (target) {
    rightParts.push({ text: `⏎ ${target.label} ${readiness.ready ? "✓" : "✗"}`, fg: readiness.ready ? theme.foreground : theme.danger });
  } else {
    rightParts.push(providerMark);
  }

  const lastTurn = state.transcript.at(-1);
  const lastTurnFailed = Boolean(
    lastTurn && lastTurn.role === "agent"
    && (messageHttpError(lastTurn) || messageSpawnError(lastTurn) || messageCraftedError(lastTurn)),
  );
  const messageEchoesTurn = Boolean(
    message && lastTurn && lastTurnFailed
    && lastTurn.blocks.some((block) => block.kind === "markdown"
      && oneLine(cleanMarkdown(block.text)).includes(oneLine(message).slice(0, 32))),
  );
  const left = messageEchoesTurn
    ? { text: "✗ failed — ↑ resends · /retry reruns", fg: theme.muted }
    : message
    ? { text: truncate(message, Math.max(16, Math.floor(width * 0.55))), fg: messageError ? theme.danger : messageWarning ? theme.warning : theme.muted }
    : state.taskRunning
      ? { text: `${spinnerFrame()} working${elapsed ? ` · ${elapsed}` : ""} · /stop cancels`, fg: theme.accent }
      : { text: keysFor(), fg: theme.muted };

  // Drop right-side pieces until the line fits.
  const rendered = [...rightParts];
  const lineLength = () => left.text.length + 3 + rendered.reduce((sum, part) => sum + part.text.length + 3, 0);
  while (rendered.length > 1 && lineLength() > width - 2) rendered.shift();

  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }}>
      <text fg={left.fg}>{left.text}</text>
      <box style={{ flexDirection: "row" }}>
        {rendered.map((part, index) => (
          <box key={index} style={{ flexDirection: "row" }}>
            {index > 0 ? <text fg={theme.faint}>{" · "}</text> : null}
            <text fg={part.fg}>{part.text}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

// ── Overlays ─────────────────────────────────────────────────────────────────
// Overlays size to their content and sit above the room; the spacer below
// keeps the composer pinned to the bottom so the dock never jumps.

function OverlayShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <box
        style={{
          flexShrink: 1,
          overflow: "hidden",
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: theme.faint,
          paddingLeft: 1,
          paddingRight: 1,
        }}
        title={title}
      >
        {children}
      </box>
      <box style={{ flexGrow: 1 }} />
    </>
  );
}

function PaletteOverlay({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  // Chat view is composer-first: the single-letter dashboard hotkeys ("t -",
  // "c -") don't exist here, and slash commands are what people search for.
  const items = filteredOpenTuiPaletteItems(state, 12)
    .map((item) => ({ ...item, detail: item.detail.replace(/^[a-z?] - /, "") }));
  const lineWidth = Math.max(24, width - 6);
  return (
    <OverlayShell title="Commands">
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.foreground}>{`› ${state.paletteInput}`}</text>
        <text fg={theme.faint}>▏</text>
        <text fg={theme.muted}>{`   ${items.length} match${items.length === 1 ? "" : "es"}`}</text>
      </box>
      <text> </text>
      {items.length === 0 ? <text fg={theme.muted}>  Nothing matches. Try /help for the full list.</text> : null}
      {items.map((item, index) => {
        const selected = index === state.paletteSelected;
        const detail = item.detail ? `   ${item.detail}` : "";
        return (
          <text key={item.id} fg={selected ? theme.foreground : theme.muted}>
            {truncate(`${selected ? "›" : " "} ${item.label}${detail}`, lineWidth)}
          </text>
        );
      })}
    </OverlayShell>
  );
}

const HELP_SECTIONS: Array<{ label: string; rows: Array<[string, string]> }> = [
  {
    label: "composer",
    rows: [
      ["⏎", "send — your agent answers right here"],
      ["#", "start with # to post to the room chat instead"],
      ["@name", "address a specific agent · ⌃J newline"],
      ["↑ ↓", "history, or pick a suggestion while one is open"],
      ["⇥", "complete the highlighted command"],
      ["esc", "clear the draft (↑ brings it back)"],
    ],
  },
  {
    label: "room rail (⌃B)",
    rows: [
      ["⌃B", "show / hide the rail"],
      ["← →", "switch tab — room · chat · projects"],
      ["↑ ↓", "move the cursor (empty composer)"],
      ["⏎ empty", "open task / reply / switch project — per tab"],
      ["⌥↑ ⌥↓", "prompt history while the rail is open"],
    ],
  },
  {
    label: "task detail",
    rows: [
      ["j k", "move between patches"],
      ["a / x", "accept / reject · e export · y copy"],
      ["R / s", "retry / stop · esc back to the room"],
    ],
  },
  {
    label: "commands",
    rows: [
      ["/work", "run the next queued task on this machine"],
      ["/retry", "retry a failed or cancelled task"],
      ["/rooms", "list projects · /room <name> switches"],
      ["/diff", "workspace changes · /find searches"],
      ["/agent-add", "add an agent · @name addresses one"],
    ],
  },
  {
    label: "everywhere",
    rows: [
      ["⌃P", "command palette — every command, fuzzy-searchable"],
      ["⌃↑↓", "select agent in the rail · ⏎ opens its last task"],
      ["⌃C", "quit"],
    ],
  },
];

function HelpOverlay({ width }: { width: number }) {
  const keyWidth = 11;
  const lineWidth = Math.max(24, width - 6);
  return (
    <OverlayShell title="Shortcuts">
      {/* paddingTop spaces the sections — an unkeyed conditional spacer child
          confuses the reconciler and overlaps rows across sections. */}
      {HELP_SECTIONS.map((section, sectionIndex) => (
        <box key={section.label} style={{ flexDirection: "column", paddingTop: sectionIndex > 0 ? 1 : 0 }}>
          <text fg={theme.muted}>{section.label}</text>
          {section.rows.map(([key, description]) => (
            <box key={`${section.label}-${key}`} style={{ flexDirection: "row" }}>
              <text fg={theme.foreground}>{`  ${key.padEnd(keyWidth)}`}</text>
              <text fg={theme.muted}>{truncate(description, Math.max(8, lineWidth - keyWidth - 2))}</text>
            </box>
          ))}
        </box>
      ))}
      <text> </text>
      <text fg={theme.muted}>esc closes</text>
    </OverlayShell>
  );
}

// Runs are named by goal, not opaque ids. When the id has to appear, show a
// short recognizable tail: run-abc123… -> #abc123.
function friendlyRunId(id: string): string {
  return `#${id.replace(/^run[-_]?/i, "").slice(-8)}`;
}

// Plan steps store their input as {"goal": …} — render the goal as prose;
// raw JSON in the steps list is plumbing, not conversation.
function stepDescription(step: { kind?: string; input?: { description?: string; payload?: Record<string, unknown> }; output?: { payload?: Record<string, unknown> } }): string {
  if (step.kind === "plan") {
    const goal = step.input?.payload?.goal;
    if (typeof goal === "string" && goal.trim()) return oneLine(goal);
  }
  return formatStepDescription(step as Parameters<typeof formatStepDescription>[0]);
}

function diffLineFg(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return theme.muted;
  if (line.startsWith("@@")) return theme.muted;
  if (line.startsWith("+")) return theme.success;
  if (line.startsWith("-")) return theme.danger;
  return theme.muted;
}

// The run's actual outcome — the thing a person opens the overlay to see.
// Last meaningful output from the steps, skipping pure goal echoes.
function runResultLines(run: { goal?: string; steps?: Array<{ kind?: string; output?: { payload?: Record<string, unknown> } }> }, maxLines = 6): string[] {
  const goal = oneLine(run.goal || "");
  for (const step of [...(run.steps || [])].reverse()) {
    const payload = step.output?.payload || {};
    const raw = typeof payload.stdout === "string" ? payload.stdout
      : typeof payload.text === "string" ? payload.text
      : typeof payload.summary === "string" ? payload.summary
      : "";
    const lines = cleanMarkdown(raw).split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    const meaningful = lines.filter((line) => oneLine(line) !== goal && !/^\{\s*"/.test(line));
    if (meaningful.length > 0) return meaningful.slice(-maxLines);
  }
  return [];
}

/** Steps that say more than the goal already does. */
function meaningfulSteps<T extends { kind?: string; input?: Record<string, unknown> }>(steps: T[], goal?: string): T[] {
  const normalizedGoal = oneLine(goal || "");
  return steps.filter((step) => {
    const description = oneLine(stepDescription(step as Parameters<typeof stepDescription>[0]));
    return description && description !== normalizedGoal && description !== "-";
  });
}

function runTimingLabel(run: { status?: string; started_at?: number; finished_at?: number; created_at?: number }): string {
  const start = run.started_at || run.created_at;
  if (!start) return "";
  const end = run.finished_at || ((run.status === "running" || run.status === "in_progress") ? Date.now() : 0);
  if (!end || end < start) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fallbackWorkTrail(run: { status?: string; execution_mode?: string; agent_id?: string }): Array<{ glyph: string; fg: string; text: string }> {
  const mode = run.execution_mode ? run.execution_mode.replace(/^local_/, "") : "local agent";
  if (run.status === "queued") {
    return [{ glyph: "◌", fg: theme.warning, text: `waiting for ${mode} to pick this up` }];
  }
  if (run.status === "running" || run.status === "in_progress") {
    return [{ glyph: spinnerFrame(), fg: theme.accent, text: `${mode} is working` }];
  }
  if (FAILED_RUN_STATUSES.has(run.status || "")) {
    return [
      { glyph: "✓", fg: theme.success, text: `started ${mode}` },
      { glyph: "✗", fg: theme.danger, text: "stopped before producing a patch" },
    ];
  }
  return [
    { glyph: "✓", fg: theme.success, text: `started ${mode}` },
    { glyph: "✓", fg: theme.success, text: "returned final answer" },
  ];
}

function RunDetailOverlay({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const detail = state.selectedRunDetail;
  const run = detail?.run;
  const lineWidth = Math.max(24, width - 6);
  if (!run) {
    return (
      <OverlayShell title="Task">
        <text fg={theme.muted}>{state.runDetailLoading ? `${spinnerFrame()} loading the task…` : "No task selected. Pick one in Work (⌃B) and press ⏎."}</text>
        <text fg={theme.muted}>esc back</text>
      </OverlayShell>
    );
  }
  const { glyph, fg } = runGlyph(run.status);
  const steps = meaningfulSteps(run.steps || [], run.goal);
  const result = runResultLines(run);
  const patches = detail?.patches || [];
  const selectedPatch = patches[Math.min(Math.max(0, state.selectedPatchIndex), Math.max(0, patches.length - 1))];
  const diffLines = (selectedPatch?.diff_text || "").split("\n").filter((line) => line.trim() !== "");
  const visibleDiff = diffLines.slice(0, 12);
  const timing = runTimingLabel(run);
  return (
    <OverlayShell title="Task">
      {wrapPlain(compact(run.goal) || shortId(run._id), lineWidth).slice(0, 2).map((line, index) => (
        <text key={`goal-${index}`} fg={theme.foreground}>{line}</text>
      ))}
      <box style={{ flexDirection: "row" }}>
        <text fg={fg}>{`${glyph} ${statusForRun(run.status)}`}</text>
        <text fg={theme.muted}>
          {truncate(`  ·  ${agentNameFor(state, run.agent_id)}${run.execution_mode ? ` · ${run.execution_mode.replace(/^local_/, "")}` : ""}${timing ? ` · ${timing}` : ""}  ·  ${friendlyRunId(run._id)}`, Math.max(8, lineWidth - 12))}
        </text>
      </box>
      {run.status === "queued" ? (
        <text fg={theme.warning}>{truncate("  waiting for an executor to pick this up — R retries it here, s cancels", lineWidth)}</text>
      ) : null}
      {result.length > 0 ? (
        <>
          <text> </text>
          <text fg={theme.muted}>result</text>
          {result.flatMap((line, index) =>
            wrapPlain(line, Math.max(8, lineWidth - 2)).map((wrapped, wrapIndex) => (
              <text key={`result-${index}-${wrapIndex}`} fg={theme.foreground}>{`  ${wrapped}`}</text>
            )),
          )}
        </>
      ) : null}
      <text> </text>
      <text fg={theme.muted}>work trail</text>
      {steps.length === 0 ? fallbackWorkTrail(run).map((trail, index) => (
        <text key={`fallback-trail-${index}`} fg={trail.fg}>{truncate(`  ${trail.glyph} ${trail.text}`, lineWidth)}</text>
      )) : null}
      {steps.slice(-6).map((step, index) => {
        const ok = step.output?.success;
        const stepFg = ok === false ? theme.danger : ok === true ? theme.success : theme.muted;
        const stepGlyph = ok === false ? "✗" : ok === true ? "✓" : "·";
        const description = stepDescription(step);
        return (
          <text key={step._id || `${step.idx ?? index}`} fg={stepFg}>
            {truncate(`  ${stepGlyph} ${description === "-" ? step.kind || "step" : description}`, lineWidth)}
          </text>
        );
      })}
      <text> </text>
      <text fg={theme.muted}>patches</text>
      {patches.length === 0 ? <text fg={theme.muted}>  no patches from this run</text> : null}
      {patches.slice(0, 6).map((patch, index) => {
        const selected = index === state.selectedPatchIndex;
        const patchFg = patch.status === "accepted" ? theme.success
          : patch.status === "rejected" ? theme.danger
          : selected ? theme.foreground : theme.muted;
        const tag = patch.status === "accepted" ? "✓ accepted"
          : patch.status === "rejected" ? "✗ rejected"
          : "· open";
        return (
          <text key={patch._id || index} fg={patchFg}>
            {truncate(`  ${selected ? "›" : " "} ${patch.path || patch.title || "patch"}  ${diffStat(patch.diff_text)}  ${tag}`, lineWidth)}
          </text>
        );
      })}
      {selectedPatch && visibleDiff.length > 0 ? (
        <>
          <text> </text>
          {visibleDiff.map((line, index) => (
            <text key={`diff-${index}`} fg={diffLineFg(line)}>{truncate(`  ${line}`, lineWidth)}</text>
          ))}
          {diffLines.length > visibleDiff.length ? (
            <text fg={theme.muted}>{`  … ${diffLines.length - visibleDiff.length} more diff lines — e exports the full task`}</text>
          ) : null}
        </>
      ) : null}
      <text> </text>
      <text fg={theme.muted}>
        {truncate(
          [
            patches.length > 0 ? "j/k patch · a accept · x reject" : "",
            run.status === "running" || run.status === "in_progress" || run.status === "queued" ? "s stop" : "",
            FAILED_RUN_STATUSES.has(run.status || "") ? "R retry · d dismiss" : "",
            run.status === "succeeded" || run.status === "completed" ? "R rerun" : "",
            "y copy · e export · esc back",
          ].filter(Boolean).join(" · "),
          lineWidth,
        )}
      </text>
    </OverlayShell>
  );
}

function ConfirmOverlay({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const request = state.pendingApproval;
  const lineWidth = Math.max(24, width - 6);
  const details = (request?.detail || "Approve this action?")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(Boolean);
  return (
    <OverlayShell title={request?.title || "Confirm"}>
      {details.flatMap((line, index) =>
        wrapPlain(line, lineWidth).map((wrapped, wrapIndex) => (
          <text key={`${index}-${wrapIndex}`} fg={index === 0 ? theme.foreground : theme.muted}>{wrapped}</text>
        )),
      )}
      <text> </text>
      <box style={{ flexDirection: "row" }}>
        <text fg={theme.success}>{`⏎ ${request?.confirmLabel || "confirm"}`}</text>
        <text fg={theme.muted}>   ·   </text>
        <text fg={theme.danger}>esc cancel</text>
      </box>
    </OverlayShell>
  );
}

function WorkspaceOverlay({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const results = state.workspaceResults;
  const lineWidth = Math.max(24, width - 6);
  if (!results) {
    return (
      <OverlayShell title="Workspace">
        <text fg={theme.muted}>Nothing loaded. /diff shows changes, /find searches.</text>
        <text fg={theme.muted}>esc back</text>
      </OverlayShell>
    );
  }
  const selected = Math.min(Math.max(0, results.selectedIndex), Math.max(0, results.entries.length - 1));
  // Window the entries around the selection so j/k can walk long diffs.
  const windowSize = 14;
  const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), results.entries.length - windowSize));
  const visible = results.entries.slice(start, start + windowSize);
  return (
    <OverlayShell title={results.title}>
      <text fg={theme.muted}>{truncate(results.summary, lineWidth)}</text>
      <text> </text>
      {results.entries.length === 0 ? <text fg={theme.muted}>  Nothing to show.</text> : null}
      {visible.map((entry, index) => {
        const absolute = start + index;
        const isSelected = absolute === selected;
        const body = entry.label.replace(/^\s*\d+\s+/, "");
        const fg = isSelected ? theme.foreground
          : body.startsWith("+") && !body.startsWith("+++") ? theme.success
          : body.startsWith("-") && !body.startsWith("---") ? theme.danger
          : theme.muted;
        return (
          <text key={`ws-${absolute}`} fg={fg}>
            {truncate(`${isSelected ? "›" : " "} ${entry.label}${entry.detail ? `  ${entry.detail}` : ""}`, lineWidth)}
          </text>
        );
      })}
      {results.entries.length > start + windowSize ? (
        <text fg={theme.muted}>{truncate(`  … ${results.entries.length - start - windowSize} more`, lineWidth)}</text>
      ) : null}
      <text> </text>
      <text fg={theme.muted}>j/k pick · ⏎ use · esc back</text>
    </OverlayShell>
  );
}

function overlayFor(state: OpenTuiPreviewUiState, width: number): React.ReactNode | null {
  if (state.mode === "palette") return <PaletteOverlay state={state} width={width} />;
  if (state.mode === "help") return <HelpOverlay width={width} />;
  if (state.mode === "run") return <RunDetailOverlay state={state} width={width} />;
  if (state.mode === "confirm") return <ConfirmOverlay state={state} width={width} />;
  if (state.mode === "workspace") return <WorkspaceOverlay state={state} width={width} />;
  return null;
}

export function ChatView({ state, width }: { state: OpenTuiPreviewUiState; width: number }) {
  const overlay = overlayFor(state, width);
  const sideRailWidth = Math.max(
    SIDE_RAIL_MIN_WIDTH,
    Math.min(SIDE_RAIL_MAX_WIDTH, state.sideRailWidth || SIDE_RAIL_DEFAULT_WIDTH),
  );
  const showSideRail = state.panelVisible && width >= sideRailWidth + SIDE_RAIL_MIN_MAIN_WIDTH + 1;
  // The transcript's real text budget: full width minus the side panel (and its
  // border) minus the scrollbox padding. Every line wraps to this, so no long
  // line (e.g. an API URL in an error) can shove the panel off-screen.
  const contentWidth = Math.max(24, Math.min(84, width - (showSideRail ? sideRailWidth + 1 : 0) - 6));
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <HeaderBar state={state} width={width} />
      {/* Hairline under the header: on a transparent terminal nothing else
          frames the layout, so this one rule is what makes the header read as
          a bar and the columns below read as one surface. Muted, not faint —
          faint (#30363D) sits on the terminal's own background and vanishes. */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text fg={theme.muted}>{"─".repeat(Math.max(0, width))}</text>
      </box>
      <box style={{ flexDirection: overlay ? "column" : "row", flexGrow: 1 }}>
        {overlay ? (
          overlay
        ) : (
          <>
            <Transcript state={state} transcript={state.transcript} feed={state.feed || []} contentWidth={contentWidth} railVisible={showSideRail} />
            {showSideRail ? (
              <Panel state={state} width={sideRailWidth} />
            ) : null}
          </>
        )}
      </box>
      <Composer state={state} width={width} />
      <StatusLine state={state} width={width} />
    </box>
  );
}
