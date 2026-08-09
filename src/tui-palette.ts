import { compact, shortId, type AgentRunRecord } from "./tui-model.js";
import { providerStatus, TUI_PROVIDERS } from "./tui-provider.js";
import type { Action } from "./tui-actions.js";
import { emptyPins, isPinnedAgent, isPinnedProvider, isPinnedRoom, type TuiPins } from "./tui-pins.js";
import type { ProviderAuthSummary } from "./tui-dashboard.js";

export type PaletteItemKind = "action" | "slash" | "provider" | "agent" | "run" | "room" | "file";

export interface PaletteItem {
  id: string;
  kind: PaletteItemKind;
  label: string;
  detail: string;
  enabled: boolean;
  actionId?: Action["id"];
  command?: string;
  provider?: string;
  agentId?: string;
  runId?: string;
  runIndex?: number;
  roomId?: string;
  filePath?: string;
}

export interface PaletteAgent {
  _id: string;
  name?: string;
  provider?: string;
  execution_mode?: string;
  type?: string;
}

export interface PaletteRoom {
  roomId: string;
  roomName?: string;
}

export interface BuildPaletteItemsInput {
  actions: Action[];
  providers: string[];
  providerAvailability: Record<string, boolean>;
  agents: PaletteAgent[];
  runs: AgentRunRecord[];
  room?: PaletteRoom | null;
  rooms?: PaletteRoom[];
  files?: string[];
  pins?: TuiPins;
}

export interface SlashCommandSuggestion {
  command: string;
  detail: string;
  completion: string;
}

export interface AgentMentionTarget {
  _id: string;
  name?: string;
  provider?: string;
  model?: string;
  kind?: "room-agent" | "provider";
  status?: string;
}

export function providerMentionTargets(input: {
  agents?: AgentMentionTarget[];
  providers?: string[];
  providerAvailability?: Record<string, boolean>;
  providerAuth?: ProviderAuthSummary[];
}): AgentMentionTarget[] {
  const agents = input.agents || [];
  const availability = input.providerAvailability || {};
  const authByProvider = new Map((input.providerAuth || []).map((auth) => [auth.provider, auth]));
  const providers = input.providers || TUI_PROVIDERS;
  const targets: AgentMentionTarget[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const auth = authByProvider.get(provider);
    const connected = auth?.status === "connected";
    const available = availability[provider] === true;
    const include = auth ? connected && available : available;
    if (!include) continue;
    targets.push({
      _id: `provider:${provider}`,
      name: provider,
      provider,
      kind: "provider",
      status: connected ? "connected" : "available",
    });
    seen.add(provider);
  }

  for (const agent of agents) {
    const handle = agentHandle(agent);
    if (seen.has(handle)) continue;
    targets.push({ ...agent, kind: agent.kind || "room-agent" });
  }

  return targets;
}

/** A stable @handle for an agent: lowercase, non-alphanumerics to dashes. */
export function agentHandle(agent: { _id: string; name?: string }): string {
  return (agent.name || agent._id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || agent._id;
}

/** The @token being typed at the cursor (e.g. "@back"), or null. */
export function activeMentionToken(input: string, cursor: number): string | null {
  const upto = input.slice(0, Math.min(Math.max(0, cursor), input.length));
  const match = upto.match(/(?:^|\s)(@[^\s@]*)$/);
  return match ? match[1] : null;
}

/** Agent suggestions for an active @token, plus a "+ new agent" entry. */
export function agentMentionSuggestions(
  token: string,
  agents: AgentMentionTarget[],
  limit = 6,
): SlashCommandSuggestion[] {
  const query = token.slice(1).toLowerCase();
  const items: SlashCommandSuggestion[] = agents
    .filter((agent) => {
      const handle = agentHandle(agent);
      return handle.includes(query) || (agent.provider || "").toLowerCase().includes(query);
    })
    .sort((a, b) => {
      const aHandle = agentHandle(a);
      const bHandle = agentHandle(b);
      const aStarts = query ? aHandle.startsWith(query) : false;
      const bStarts = query ? bHandle.startsWith(query) : false;
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      if (a.kind === "provider" && b.kind !== "provider") return -1;
      if (a.kind !== "provider" && b.kind === "provider") return 1;
      return aHandle.localeCompare(bHandle);
    })
    .slice(0, limit)
    .map((agent) => {
      const detail = [agent.provider, agent.model].filter(Boolean).join(" ") || "agent";
      const targetDetail = agent.kind === "provider"
        ? `${agent.provider || agentHandle(agent)} ${agent.status || "connected"}`
        : detail;
      return { command: `@${agentHandle(agent)}`, detail: targetDetail, completion: `@${agentHandle(agent)} ` };
    });
  return items;
}

/** Unified composer autocomplete: @agent mentions when an @token is active, else slash commands. */
export function composerSuggestions(
  input: string,
  cursor: number,
  agents: AgentMentionTarget[],
  limit = 6,
): SlashCommandSuggestion[] {
  const token = activeMentionToken(input, cursor);
  if (token !== null) return agentMentionSuggestions(token, agents, limit);
  return slashCommandSuggestions(input, limit);
}

export const SLASH_COMMANDS = [
  ["/help", "keys and commands"],
  ["/work", "run the next queued task on this machine"],
  ["/retry", "retry a failed or cancelled task"],
  ["/dismiss", "clear a failure from needs-you (stays in history)"],
  ["/rooms", "list rooms — /room <name> switches"],
  ["/diff", "show workspace changes"],
  ["/find", "search feed and terminal scrollback"],
  ["/task", "send work to an agent"],
  ["/fanout", "send one prompt to multiple agents"],
  ["/handoff", "handoff current work to another agent"],
  ["/agent-add", "add an agent to this room"],
  ["/undo", "restore the previous local TUI state change"],
  ["/clear", "clear the feed"],
  ["/provider", "cycle or set provider"],
  ["/model", "set visible model name"],
  ["/agent", "list room agents"],
  ["/room", "switch to current or pinned room"],
  ["/run", "inspect task detail"],
  ["/runs", "list recent work"],
  ["/sessions", "list native provider sessions from loaded work"],
  ["/session", "inspect the task backing a provider session"],
  ["/copy", "copy task id, goal, summary, diff, or output"],
  ["/export", "export task summary markdown"],
  ["/handoff-target", "choose the default handoff target agent"],
  ["/agent-start", "start a prompt on one local agent"],
  ["/agent-stop", "stop active tasks for one agent"],
  ["/agent-pause", "show pause support for one agent"],
  ["/agent-resume", "show resume support for one agent"],
  ["/continue", "continue latest or selected task with a prompt"],
  ["/resume", "resume current, last, or latest task"],
  ["/fork", "start independent work from an existing task"],
  ["/rerun", "rerun latest or selected task goal"],
  ["/history", "list previous task prompts"],
  ["/use-history", "prefill a previous task prompt"],
  ["/again", "rerun a previous task prompt"],
  ["/health", "refresh service health"],
  ["/doctor", "show local CLI readiness and live QA blockers"],
  ["/qa", "run deterministic TUI flow QA"],
  ["/live-qa", "run non-mutating live room QA and approval-broker preflight"],
  ["/runtime", "show hosted runtime status"],
  ["/env", "manage hosted runtime: status, start, stop, or touch"],
  ["/env-start", "start hosted runtime for the room"],
  ["/env-stop", "stop hosted runtime for the room"],
  ["/env-touch", "extend hosted runtime lease"],
  ["/stop", "stop a queued or running task"],
  ["/git", "show workspace git status"],
  ["/view", "preview a workspace file around a line"],
  ["/peek", "preview a workspace file around a line"],
  ["/files", "list workspace files"],
  ["/search", "search workspace text with rg"],
  ["/symbols", "list workspace code symbols"],
  ["/goto", "show a symbol definition location"],
  ["/rename-preview", "preview symbol rename occurrences"],
  ["/rename", "apply a validated symbol rename"],
  ["/diagnostics", "run TypeScript diagnostics"],
  ["/context", "show context carried into the next task"],
  ["/instructions", "list or attach project instruction files"],
  ["/attach", "attach a file to the next task"],
  ["/attach-image", "attach an image path to the next task"],
  ["/detach", "remove an attached file"],
  ["/attachments", "show attached task files"],
  ["/pin", "pin current room, provider, or agent"],
  ["/pins", "show pinned rooms, providers, and agents"],
  ["/unpin", "remove a pinned room, provider, or agent"],
  ["/safety", "show approval and sandbox policy"],
  ["/terminal", "connect or focus shared terminal"],
  ["/reconnect", "restore shared terminal connection"],
  ["/open", "open browser workspace"],
  ["/login", "refresh login"],
  ["/init", "initialize project room"],
  ["/rooms", "list server rooms"],
  ["/exit", "leave the TUI"],
  ["/quit", "leave the TUI"],
] as const;

export function buildPaletteItems(input: BuildPaletteItemsInput): PaletteItem[] {
  const items: PaletteItem[] = [];
  const pins = input.pins || emptyPins();

  for (const action of input.actions) {
    items.push({
      id: `action:${action.id}`,
      kind: "action",
      label: action.label,
      detail: `${action.key} - ${action.hint}`,
      enabled: action.enabled,
      actionId: action.id,
    });
  }

  for (const [command, detail] of SLASH_COMMANDS) {
    items.push({
      id: `slash:${command}`,
      kind: "slash",
      label: command,
      detail,
      enabled: true,
      command,
    });
  }

  for (const provider of input.providers) {
    const pinned = isPinnedProvider(pins, provider);
    items.push({
      id: `provider:${provider}`,
      kind: "provider",
      label: provider,
      detail: `${pinned ? "pinned " : ""}provider ${providerStatus(provider, input.providerAvailability)}`,
      enabled: true,
      provider,
    });
  }

  const roomItems = dedupeRooms([
    ...(input.room?.roomId ? [input.room] : []),
    ...pins.rooms,
    ...(input.rooms || []),
  ]);
  for (const room of roomItems) {
    const current = input.room?.roomId === room.roomId;
    const pinned = isPinnedRoom(pins, room.roomId);
    items.push({
      id: `room:${room.roomId}`,
      kind: "room",
      label: room.roomName || room.roomId,
      detail: `${pinned ? "pinned " : ""}${current ? "current room" : "room"} ${room.roomId}`,
      enabled: true,
      roomId: room.roomId,
    });
  }

  for (const agent of input.agents) {
    const mode = compact(agent.execution_mode, "hosted_api");
    const pinned = isPinnedAgent(pins, agent._id);
    items.push({
      id: `agent:${agent._id}`,
      kind: "agent",
      label: compact(agent.name, "agent"),
      detail: `${pinned ? "pinned " : ""}${compact(agent.provider)}/${mode}`,
      enabled: true,
      agentId: agent._id,
    });
  }

  input.runs.slice(0, 20).forEach((run, index) => {
    items.push({
      id: `run:${run._id}`,
      kind: "run",
      label: compact(run.goal, "(no goal)"),
      detail: `${run.status || "unknown"} ${shortId(run._id)}`,
      enabled: true,
      runId: run._id,
      runIndex: index,
    });
  });

  for (const file of (input.files || []).slice(0, 250)) {
    items.push({
      id: `file:${file}`,
      kind: "file",
      label: file,
      detail: "workspace file attach to next task",
      enabled: true,
      filePath: file,
    });
  }

  return items;
}

function dedupeRooms(rooms: PaletteRoom[]): PaletteRoom[] {
  const result: PaletteRoom[] = [];
  for (const room of rooms) {
    if (!room.roomId) continue;
    const existing = result.findIndex((candidate) => candidate.roomId === room.roomId);
    if (existing >= 0) {
      result[existing] = { ...result[existing], ...room };
      continue;
    }
    result.push(room);
  }
  return result;
}

export function scorePaletteMatch(item: PaletteItem, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;

  const haystack = `${item.label} ${item.detail} ${item.kind}`.toLowerCase();
  if (haystack.includes(normalized)) {
    return 100 + normalized.length;
  }

  let score = 0;
  let queryIndex = 0;
  for (let i = 0; i < haystack.length && queryIndex < normalized.length; i++) {
    if (haystack[i] === normalized[queryIndex]) {
      score += i === 0 || haystack[i - 1] === " " || haystack[i - 1] === "/" ? 8 : 2;
      queryIndex++;
    }
  }

  return queryIndex === normalized.length ? score : 0;
}

export function filterPaletteItems(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  return items
    .map((item, index) => ({ item, index, score: scorePaletteMatch(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.item.enabled) - Number(a.item.enabled) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function slashCommandSuggestions(input: string, limit = 6): SlashCommandSuggestion[] {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  if (!normalized.startsWith("/")) return [];

  const [token = ""] = normalized.split(/\s+/, 1);
  const hasArgs = normalized.length > token.length && /\s/.test(normalized[token.length] || "");
  if (hasArgs) return [];

  const query = token.slice(1).toLowerCase();
  const scored = SLASH_COMMANDS
    .map(([command, detail], index) => {
      const name = command.slice(1).toLowerCase();
      const score = slashCommandScore(name, query);
      return { command, detail, index, score };
    })
    .filter((entry) => entry.score > 0)
    // Bare "/" keeps the curated table order — otherwise every command ties
    // at 100 and the length tiebreak surfaces /qa before /help.
    .sort((a, b) => (query ? (b.score - a.score || a.command.length - b.command.length || a.index - b.index) : a.index - b.index))
    .slice(0, limit);

  return scored.map((entry) => ({
    command: entry.command,
    detail: entry.detail,
    completion: `${entry.command} `,
  }));
}

function slashCommandScore(name: string, query: string): number {
  if (!query) return 100;
  if (name === query) return 500;
  if (name.startsWith(query)) return 400 - name.length;
  if (name.includes(query)) return 250 - name.indexOf(query);

  let score = 0;
  let queryIndex = 0;
  for (let index = 0; index < name.length && queryIndex < query.length; index++) {
    if (name[index] !== query[queryIndex]) continue;
    score += index === 0 || name[index - 1] === "-" ? 12 : 3;
    queryIndex++;
  }
  return queryIndex === query.length ? score : 0;
}
