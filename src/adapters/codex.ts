import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import {
  boundedActivityPayload,
  existingAttachmentPaths,
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  withDeclaredHarnessCapabilityReceipt,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessActivityKind,
  type HarnessActivityUpdate,
  type HarnessArtifactUpdate,
  type HarnessNativeControlService,
} from "./base.js";
import {
  harnessArtifactContext,
  harnessArtifactFromResource,
  harnessArtifactsFromToolResult,
} from "./harness-artifacts.js";
import {
  CodexAppServerTurnTerminatedError,
  disposeCodexAppServer,
  getCodexAppServer,
  runCodexAppServerTurn,
} from "./codex-app-server.js";

const codexNativeControls: HarnessNativeControlService = {
  async snapshot(context) {
    const client = getCodexAppServer();
    await client.ensureStarted();
    const list = async (archived: boolean) => {
      const response = await client.request("thread/list", {
        archived,
        cwd: context.workDir,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
      }) as { data?: Array<Record<string, unknown>> };
      return (response.data || []).map((thread) => ({
        id: String(thread.id || ""),
        name: compactText(thread.name || thread.preview, 160) || "Untitled Codex task",
        status: compactText(thread.status, 80) || (archived ? "archived" : "idle"),
        updatedAt: Number(thread.updatedAt || 0),
      })).filter((thread) => thread.id);
    };
    const [active, archived] = await Promise.all([list(false), list(true)]);
    const item = (thread: Awaited<ReturnType<typeof list>>[number], isArchived: boolean) => ({
      id: thread.id,
      providerID: thread.id,
      title: thread.name,
      detail: [
        thread.status,
        thread.updatedAt > 0 ? new Date(thread.updatedAt * 1_000).toISOString() : undefined,
      ].filter(Boolean).join(" · "),
      status: isArchived ? "unknown" as const
        : /active|running|working/i.test(thread.status) ? "working" as const : "ready" as const,
      actions: [{
        id: isArchived ? "codex-unarchive-thread" : "codex-archive-thread",
        title: isArchived ? "Unarchive" : "Archive",
        risk: isArchived ? "safe" as const : "destructive" as const,
        ...(isArchived ? {} : { confirmation: "ARCHIVE" }),
      }],
    });
    return {
      contractVersion: 1,
      harness: "codex",
      observedAt: new Date().toISOString(),
      groups: [
        { id: "active-threads", title: "Active tasks", items: active.map((thread) => item(thread, false)) },
        { id: "archived-threads", title: "Archived tasks", items: archived.map((thread) => item(thread, true)) },
      ],
    };
  },
  async perform(context, actionID, providerID) {
    if (!providerID) throw new Error("The Codex task is no longer attached to this relay.");
    const method = actionID === "codex-archive-thread" ? "thread/archive"
      : actionID === "codex-unarchive-thread" ? "thread/unarchive" : undefined;
    if (!method) throw new Error("Unsupported Codex task action.");
    const client = getCodexAppServer();
    await client.ensureStarted();
    await client.request(method, { threadId: providerID });
    return this.snapshot(context);
  },
};

function which(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(":");
  return paths.some((dir) => existsSync(`${dir}/${cmd}`));
}

const compactText = (value: unknown, maximum = 512): string | undefined => {
  const text = Array.isArray(value)
    ? value.map((part) => String(part)).join(" ")
    : typeof value === "string"
      ? value
      : undefined;
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
};

const boundedOutput = (value: unknown, maximum = 16_000): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").trimEnd();
  return normalized ? normalized.slice(0, maximum) : undefined;
};

const durationMilliseconds = (value: unknown): number | undefined => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
};

const commandActivityKind = (command: string): HarnessActivityKind => {
  const searchable = ` ${command.toLowerCase()} `;
  if (/\b(?:test|pytest|vitest|jest|xcodebuild|swift test)\b/.test(searchable)) return "tests";
  if (/\b(?:rg|grep|find|fd|locate)\b/.test(searchable)) return "search";
  if (/\b(?:cat|sed|head|tail|less|bat)\b/.test(searchable)) return "read";
  return "command";
};

const activityTitle = (
  kind: HarnessActivityKind,
  phase: HarnessActivityUpdate["phase"],
  subject?: string,
): string => {
  const active = phase === "started";
  switch (kind) {
    case "artifact": return subject
      ? `${active ? "Opening" : "Opened"} ${subject}`
      : active ? "Opening an artifact" : "Opened an artifact";
    case "tests": return active ? "Running checks" : "Ran checks";
    case "search": return active ? "Searching files" : "Searched files";
    case "read": return active ? "Reading files" : "Read files";
    case "file": return subject
      ? `${active ? "Editing" : "Edited"} ${subject}`
      : active ? "Editing files" : "Edited files";
    case "image": return active ? "Viewing an image" : "Viewed an image";
    case "browser": return active ? "Browsing" : "Browsed";
    case "plan": return active ? "Updating the plan" : "Updated the plan";
    case "tool": return subject
      ? `${active ? "Using" : "Used"} ${subject}`
      : active ? "Using a tool" : "Used a tool";
    case "command": return active ? "Running a command" : "Ran a command";
  }
};

function codexSingleActivityFromEvent(
  event: Record<string, unknown>,
): HarnessActivityUpdate | undefined {
  const eventType = String(event.type || "");
  if (eventType !== "item.started" && eventType !== "item.completed") return undefined;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) return undefined;

  const phase = eventType === "item.started" ? "started" : "completed";
  const itemType = String(item.type || "");
  switch (itemType) {
    case "command_execution": {
      const detail = compactText(item.command, 2_048);
      const kind = commandActivityKind(detail || "");
      const output = boundedOutput(
        item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? item.stdout,
      );
      const durationMs = durationMilliseconds(item.duration_ms ?? item.durationMs);
      return {
        kind,
        phase,
        title: activityTitle(kind, phase),
        detail,
        tool: "shell",
        codeLanguage: "shell",
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(phase === "completed" && output ? { output } : {}),
        ...(phase === "completed" && item.exit_code !== undefined
          ? { result: Number(item.exit_code) === 0 ? "Completed" : `Exit ${item.exit_code}` }
          : {}),
      };
    }
    case "file_change": {
      const path = compactText(item.path)
        || compactText((item.changes as Array<{ path?: string }> | undefined)?.[0]?.path);
      return {
        kind: "file",
        phase,
        title: activityTitle("file", phase, path),
        detail: path,
        tool: "file_change",
        ...(path ? { input: path, codeLanguage: "text" as const } : {}),
      };
    }
    case "mcp_tool_call": {
      const tool = compactText(item.tool_name || item.tool);
      const server = compactText(item.server || item.namespace);
      const kind: HarnessActivityKind = /\b(?:browser|chrome|web)\b/i.test(tool || "")
        ? "browser"
        : "tool";
      const input = boundedActivityPayload(item.arguments ?? item.input);
      const output = boundedActivityPayload(item.result ?? item.content_items ?? item.output);
      const error = item.error as Record<string, unknown> | string | undefined;
      const errorMessage = typeof error === "string"
        ? compactText(error, 1_024)
        : compactText(error?.message, 1_024);
      const durationMs = durationMilliseconds(item.duration_ms ?? item.durationMs);
      const identifier = [server, tool].filter(Boolean).join(".");
      const artifacts = phase === "completed" && item.artifact_deferred !== true
        ? harnessArtifactsFromToolResult(item.result ?? item.content_items ?? item.output, {
          provider: "codex",
          server,
          tool,
          title: tool,
        })
        : [];
      return {
        kind,
        phase,
        title: activityTitle(kind, phase, tool),
        detail: server && tool ? `${server} · ${tool}` : tool,
        ...(identifier ? { tool: identifier } : {}),
        ...(input ? { input, codeLanguage: "json" as const } : {}),
        ...(phase === "completed" && output ? { output } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(phase === "completed" && errorMessage
          ? { result: errorMessage }
          : phase === "completed" ? { result: "Completed" } : {}),
      };
    }
    case "web_search": {
      const query = compactText(item.query || item.text);
      const durationMs = durationMilliseconds(item.duration_ms ?? item.durationMs);
      return {
        kind: "search",
        phase,
        title: phase === "started" ? "Searching the web" : "Searched the web",
        detail: query,
        tool: "web_search",
        ...(query ? {
          input: boundedActivityPayload({ query }),
          codeLanguage: "json" as const,
        } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(phase === "completed" ? { result: "Completed" } : {}),
      };
    }
    case "plan_update": {
      const plan = boundedOutput(item.text);
      return {
        kind: "plan",
        phase,
        title: activityTitle("plan", phase),
        tool: "plan_update",
        ...(plan ? { output: plan, codeLanguage: "text" as const } : {}),
        ...(phase === "completed" ? { result: "Completed" } : {}),
      };
    }
    case "image_view": {
      const path = compactText(item.path, 2_048);
      return {
        kind: "image",
        phase,
        title: phase === "started" ? "Viewing an image" : "Viewed an image",
        detail: path,
        tool: "image_view",
        ...(path ? { input: path, codeLanguage: "text" as const } : {}),
        ...(path ? { imagePaths: [path] } : {}),
        ...(phase === "completed" ? { result: "Completed" } : {}),
      };
    }
    case "sleep": {
      const durationMs = durationMilliseconds(item.duration_ms ?? item.durationMs);
      return {
        kind: "tool",
        phase,
        title: phase === "started" ? "Waiting" : "Waited",
        detail: durationMs === undefined ? undefined : `${durationMs} ms`,
        tool: "sleep",
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(phase === "completed" ? { result: "Completed" } : {}),
      };
    }
    case "collab_agent_tool_call": {
      const tool = compactText(item.tool) || "agent";
      const prompt = compactText(item.prompt, 4_096);
      const durationMs = durationMilliseconds(item.duration_ms ?? item.durationMs);
      return {
        kind: "tool",
        phase,
        title: activityTitle("tool", phase, tool),
        detail: tool,
        tool: `collaboration.${tool}`,
        ...(prompt ? { input: prompt, codeLanguage: "text" as const } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(phase === "completed"
          ? { result: String(item.status || "").toLowerCase() === "failed" ? "Failed" : "Completed" }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

type CodexAgentLabel = {
  name: string;
  task: string;
  parentAgentID?: string;
};

type CodexAgentLabels = Map<string, CodexAgentLabel>;

const codexSubagentTitle = (agentPath: unknown): string => {
  const path = compactText(agentPath, 512) || "delegated task";
  const leaf = path.split("/").filter(Boolean).at(-1) || path;
  const words = leaf.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Delegated task";
};

const codexAgentIDs = (item: Record<string, unknown>): string[] => {
  const receiverIDs = item.receiver_thread_ids ?? item.receiverThreadIds;
  const states = item.agents_states ?? item.agentsStates;
  const candidates = [
    ...(Array.isArray(receiverIDs) ? receiverIDs : []),
    ...(states && typeof states === "object" && !Array.isArray(states)
      ? Object.keys(states as Record<string, unknown>)
      : []),
  ];
  return [...new Set(candidates
    .map((candidate) => compactText(candidate, 512))
    .filter((candidate): candidate is string => Boolean(candidate)))];
};

const codexAgentState = (
  item: Record<string, unknown>,
  agentID: string,
): Record<string, unknown> | undefined => {
  const states = item.agents_states ?? item.agentsStates;
  if (!states || typeof states !== "object" || Array.isArray(states)) return undefined;
  const state = (states as Record<string, unknown>)[agentID];
  return state && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : undefined;
};

const codexAgentOutcome = (
  tool: string,
  eventPhase: HarnessActivityUpdate["phase"],
  callStatus: string,
  agentStatus: string,
): { phase: HarnessActivityUpdate["phase"]; result: string; titleVerb: string; terminal: boolean } => {
  const normalizedStatus = agentStatus.replace(/[_-]/g, "").toLowerCase();
  const failed = callStatus.toLowerCase() === "failed"
    || ["errored", "interrupted", "notfound"].includes(normalizedStatus);
  if (failed) return { phase: "completed", result: "Failed", titleVerb: "Failed", terminal: true };
  if (["completed", "shutdown"].includes(normalizedStatus) || tool === "closeagent") {
    return { phase: "completed", result: "Completed", titleVerb: "Completed", terminal: true };
  }
  if (["running", "pendinginit"].includes(normalizedStatus)
    || ["spawnagent", "sendinput", "resumeagent"].includes(tool)) {
    return { phase: "started", result: "Working", titleVerb: "Started", terminal: false };
  }
  if (tool === "wait" && eventPhase === "completed") {
    return { phase: "completed", result: "Completed", titleVerb: "Completed", terminal: true };
  }
  return eventPhase === "started"
    ? { phase: "started", result: "Working", titleVerb: "Started", terminal: false }
    : { phase: "completed", result: "Completed", titleVerb: "Completed", terminal: true };
};

/** Project Codex collaboration calls into one provider-neutral lifecycle per target agent. */
export function codexActivitiesFromEvent(
  event: Record<string, unknown>,
  labels: CodexAgentLabels = new Map(),
): HarnessActivityUpdate[] {
  const eventType = String(event.type || "");
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || (eventType !== "item.started" && eventType !== "item.completed")) return [];
  if (String(item.type || "") === "subagent_activity") {
    const agentID = compactText(item.agent_thread_id ?? item.agentThreadId, 512);
    if (!agentID) return [];
    const kind = String(item.kind || "").replace(/[_-]/g, "").toLowerCase();
    const failed = kind === "interrupted";
    const name = codexSubagentTitle(item.agent_path ?? item.agentPath);
    const previous = labels.get(agentID);
    const task = previous?.task || name;
    if (failed) labels.delete(agentID);
    else labels.set(agentID, { name, task, parentAgentID: previous?.parentAgentID });
    return [{
      kind: "tool",
      phase: failed ? "completed" : "started",
      title: `${failed ? "Failed" : "Started"} ${task}`,
      detail: "Codex subagent",
      tool: "collaboration.subAgent",
      result: failed ? "Failed" : "Working",
      agentID,
      agentName: name,
      agentTask: task,
      agentStatus: failed ? "failed" : "working",
      agentProgress: failed ? "Stopped before finishing" : "Starting",
    }];
  }
  if (String(item.type || "") !== "collab_agent_tool_call") {
    const activity = codexSingleActivityFromEvent(event);
    return activity ? [activity] : [];
  }

  const rawTool = compactText(item.tool, 160) || "agent";
  const normalizedTool = rawTool.replace(/[_-]/g, "").toLowerCase();
  const agentIDs = codexAgentIDs(item);
  if (agentIDs.length === 0) {
    // Current Codex App Server wait events can omit receiver/state arrays even
    // while a subAgentActivity is live. Waiting is transport plumbing, not a
    // user-facing action; the active agent row already carries the truth.
    if (normalizedTool === "wait") return [];
    const activity = codexSingleActivityFromEvent(event);
    return activity ? [activity] : [];
  }

  const prompt = compactText(item.prompt, 4_096);
  const senderID = compactText(item.sender_thread_id ?? item.senderThreadId, 512);
  const eventPhase = eventType === "item.started" ? "started" : "completed";
  const callStatus = compactText(item.status, 80) || "";

  return agentIDs.map((agentID) => {
    const state = codexAgentState(item, agentID);
    const agentStatus = compactText(state?.status, 80) || "";
    const outcome = codexAgentOutcome(normalizedTool, eventPhase, callStatus, agentStatus);
    const previous = labels.get(agentID);
    const task = prompt || previous?.task || "Delegated task";
    const name = previous?.name || "Codex subagent";
    if (normalizedTool === "spawnagent") {
      labels.set(agentID, {
        name,
        task,
        ...(senderID && senderID !== agentID ? { parentAgentID: senderID } : {}),
      });
    }
    if (outcome.terminal) labels.delete(agentID);
    const output = boundedOutput(state?.message);
    return {
      kind: "tool",
      phase: outcome.phase,
      title: `${outcome.titleVerb} ${task}`,
      detail: "Codex subagent",
      tool: `collaboration.${rawTool}`,
      ...(normalizedTool === "spawnagent" && prompt
        ? { input: prompt, codeLanguage: "text" as const }
        : {}),
      ...(output ? { output } : {}),
      result: outcome.result,
      agentID,
      ...(senderID && senderID !== agentID ? { parentAgentID: senderID } : {}),
      agentName: name,
      agentTask: task,
      agentStatus: outcome.result === "Failed"
        ? "failed"
        : outcome.terminal ? "completed" : "working",
      agentProgress: output || (outcome.terminal ? outcome.result : "Working"),
    };
  });
}

/** Close subagents that Codex announced without a matching terminal item. */
export function codexCompletedSubagentActivities(
  labels: CodexAgentLabels,
  failed = false,
): HarnessActivityUpdate[] {
  const activities = [...labels.entries()].map(([agentID, label]) => ({
    kind: "tool" as const,
    phase: "completed" as const,
    title: `${failed ? "Failed" : "Completed"} ${label.task}`,
    detail: "Codex subagent",
    tool: "collaboration.subAgent",
    result: failed ? "Failed" : "Completed",
    agentID,
    ...(label.parentAgentID ? { parentAgentID: label.parentAgentID } : {}),
    agentName: label.name,
    agentTask: label.task,
    agentStatus: failed ? "failed" as const : "completed" as const,
    agentProgress: failed ? "Stopped before finishing" : "Finished",
  }));
  labels.clear();
  return activities;
}

function codexChildActivity(
  activity: HarnessActivityUpdate,
  context: { threadId: string; parentThreadId?: string },
  labels: CodexAgentLabels,
): HarnessActivityUpdate {
  const label = labels.get(context.threadId);
  return {
    ...activity,
    agentID: context.threadId,
    ...(context.parentThreadId ? { parentAgentID: context.parentThreadId } : {}),
    agentName: label?.name || "Codex subagent",
    agentTask: label?.task || "Delegated task",
    agentStatus: "working",
    agentProgress: activity.title,
  };
}

function codexChildMessageActivity(
  item: Record<string, unknown>,
  context: { threadId: string; parentThreadId?: string },
  labels: CodexAgentLabels,
): HarnessActivityUpdate | undefined {
  const message = compactText(item.text, 512);
  if (!message) return undefined;
  const label = labels.get(context.threadId);
  return {
    kind: "plan",
    // A child message is progress inside the delegated lifecycle, not the
    // lifecycle's terminal event. The parent completion closes the member.
    phase: "started",
    title: message,
    detail: "Subagent update",
    tool: "collaboration.progress",
    agentID: context.threadId,
    ...(context.parentThreadId ? { parentAgentID: context.parentThreadId } : {}),
    agentName: label?.name || "Codex subagent",
    agentTask: label?.task || "Delegated task",
    agentStatus: "working",
    agentProgress: message,
  };
}

/** Backwards-compatible single-activity projection used by existing consumers. */
export function codexActivityFromEvent(
  event: Record<string, unknown>,
): HarnessActivityUpdate | undefined {
  return codexActivitiesFromEvent(event)[0];
}

const nestedString = (value: unknown, keys: string[]): string | undefined => {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!source) return undefined;
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

export const codexMcpAppResourceURI = (item: Record<string, unknown>): string | undefined => {
  const appContext = item.appContext as Record<string, unknown> | undefined;
  const result = item.result as Record<string, unknown> | undefined;
  const meta = result?._meta as Record<string, unknown> | undefined;
  const ui = meta?.ui as Record<string, unknown> | undefined;
  return nestedString(appContext, ["resourceUri"])
    || compactText(item.mcpAppResourceUri, 4_096)
    || nestedString(ui, ["resourceUri"])
    || nestedString(meta, ["ui/resourceUri", "openai/outputTemplate"]);
};

type CodexAppServerRequester = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

/** Hydrate one completed MCP App into a provider-neutral artifact activity. */
export async function codexArtifactActivityFromItem(
  item: Record<string, unknown>,
  threadId: string,
  client: CodexAppServerRequester,
): Promise<HarnessActivityUpdate | undefined> {
  if (item.type !== "mcpToolCall" || item.status === "failed") return undefined;
  const server = compactText(item.server, 256);
  const tool = compactText(item.tool, 256);
  if (!server || !tool) return undefined;
  const result = item.result;
  const resourceURI = codexMcpAppResourceURI(item);
  const appContext = item.appContext as Record<string, unknown> | undefined;
  const appName = compactText(appContext?.appName, 160);
  const title = appName || tool.replace(/[_-]+/g, " ");
  const context = harnessArtifactContext({
    ...(result && typeof result === "object" ? result as Record<string, unknown> : {}),
    appContext,
  });
  let artifacts: HarnessArtifactUpdate[] = [];

  if (resourceURI) {
    try {
      const response = await client.request("mcpServer/resource/read", {
        threadId,
        server,
        uri: resourceURI,
        ...(typeof item.id === "string" ? { originCallId: item.id } : {}),
        ...(typeof appContext?.connectorId === "string"
          ? { connectorId: appContext.connectorId }
          : {}),
      }) as { contents?: unknown[] };
      artifacts = (response.contents || []).map((resource, index) =>
        harnessArtifactFromResource(resource, {
          provider: "codex",
          server,
          tool,
          title,
          uri: resourceURI,
          context,
          forceKind: "mcpApp",
          interactive: true,
          displayMode: "inline",
        }, index)).filter((artifact): artifact is HarnessArtifactUpdate => Boolean(artifact));
    } catch {
      // A direct embedded artifact or a link fallback remains useful when an
      // older Codex App Server cannot hydrate the MCP resource.
    }
  }

  if (artifacts.length === 0) {
    artifacts = harnessArtifactsFromToolResult(result, {
      provider: "codex",
      server,
      tool,
      title,
      uri: resourceURI,
    });
  }
  if (artifacts.length === 0 && resourceURI) {
    artifacts = [{
      id: createHash("sha256").update(`${server}\0${tool}\0${resourceURI}`).digest("hex").slice(0, 32),
      kind: "link",
      title,
      mediaType: "text/html;profile=mcp-app",
      fileName: `${tool.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 96) || "artifact"}.html`,
      uri: resourceURI,
      provider: "codex",
      server,
      tool,
    }];
  }
  if (artifacts.length === 0) return undefined;
  return {
    kind: "artifact",
    phase: "completed",
    title: activityTitle("artifact", "completed", title),
    detail: `${server} · ${tool}`,
    tool: `${server}.${tool}`,
    result: "Ready",
    artifacts,
  };
}

export function codexReasoningSummaryActivity(
  summary: string,
): HarnessActivityUpdate | undefined {
  const title = compactText(summary, 180);
  if (!title || title.length < 12) return undefined;
  return {
    kind: "plan",
    phase: "started",
    title,
    tool: "reasoning_summary",
  };
}

export function buildCodexArgs(
  goal: string,
  options: Pick<ExecuteOptions, "additionalDirectories" | "attachments" | "effort" | "model" | "permissionMode" | "providerSession" | "speed"> & { json?: boolean } = {},
): string[] {
  const providerSessionId = options.providerSession?.mode === "continue"
    ? options.providerSession.providerSessionId
    : undefined;
  const permission = options.permissionMode;
  const sandbox = permission === "fullAccess" ? "danger-full-access" : permission === "plan" ? "read-only" : "workspace-write";
  const approval = permission === "approve" || permission === "fullAccess" ? "never" : "on-request";
  // Keep the existing room default byte-for-byte compatible. Permission flags
  // are authoritative only after the user chooses a profile in co-ode.
  const args = permission
    ? ["--sandbox", sandbox, "--ask-for-approval", approval]
    : providerSessionId
      ? ["--sandbox", "workspace-write"]
      : ["exec", "--sandbox", "workspace-write"];
  const additionalDirectories = [...new Set(
    (options.additionalDirectories || []).map((directory) => directory.trim()).filter(Boolean),
  )];
  if (additionalDirectories.length > 0) {
    const execIndex = args.indexOf("exec");
    const insertionIndex = execIndex < 0 ? args.length : execIndex;
    args.splice(
      insertionIndex,
      0,
      ...additionalDirectories.flatMap((directory) => ["--add-dir", directory]),
    );
  }
  if (options.effort) args.push("--config", `model_reasoning_effort=\"${options.effort}\"`);
  if (options.speed === "fast") args.push("--config", `service_tier=\"fast\"`);
  if (permission || providerSessionId) args.push("exec");
  if (providerSessionId) args.push("resume");
  // Use the provider's ordinary configuration so installed plugins, skills,
  // and MCP servers behave exactly as they do in the native Codex client.
  // Browser authority remains a separate, explicit co·ode capability.
  if (options.json) args.push("--json");
  if (options.model) args.push("--model", options.model);
  if (!providerSessionId) {
    for (const dir of existingAttachmentPaths(options.attachments, ["directory"])) {
      args.push("--add-dir", dir);
    }
  }
  for (const image of existingAttachmentPaths(options.attachments, ["image"])) {
    args.push("--image", image);
  }
  if (providerSessionId) {
    args.push(providerSessionId, goal);
  } else {
    args.push("--", goal);
  }
  return args;
}

/**
 * Parse a Codex JSONL event and report it as an agent step to co-ode.
 * Codex events: thread.started, turn.started, turn.completed,
 * item.started, item.completed (with item types: command_execution,
 * file_change, mcp_tool_call, agent_message, reasoning, plan_update)
 */
async function reportCodexEvent(
  event: Record<string, unknown>,
  config: { roomId: string; runId: string; serverUrl: string; sessionToken: string },
): Promise<void> {
  const type = event.type as string;
  const item = event.item as Record<string, unknown> | undefined;

  // Only report completed items as steps
  if (type !== "item.completed" || !item) return;

  const itemType = item.type as string;
  let stepKind: string;
  let description: string;
  let payload: Record<string, unknown> = {};

  switch (itemType) {
    case "command_execution":
      stepKind = "tool_call";
      description = (item.command as string) || "exec";
      payload = {
        command: item.command,
        exitCode: item.exit_code,
        output: boundedOutput(item.aggregated_output ?? item.output ?? item.stdout, 4_000),
      };
      break;
    case "file_change":
      stepKind = "tool_call";
      description = `write ${(item.path as string) || "file"}`;
      payload = { path: item.path };
      break;
    case "mcp_tool_call":
      stepKind = "tool_call";
      description = (item.tool_name as string) || "mcp_tool";
      payload = { tool: item.tool_name };
      break;
    case "agent_message":
      stepKind = "observation";
      description = ((item.text as string) || "").slice(0, 200);
      payload = { text: ((item.text as string) || "").slice(0, 4000) };
      break;
    case "plan_update":
      stepKind = "plan";
      description = "plan updated";
      payload = { plan: item.plan };
      break;
    default:
      return; // Skip reasoning, web_search, etc.
  }

  try {
    await fetch(
      `${config.serverUrl}/api/rooms/${config.roomId}/agent-runs/${config.runId}/steps`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.sessionToken}`,
        },
        body: JSON.stringify({
          kind: stepKind,
          input: { description, payload },
          output: { success: true, payload },
        }),
      },
    );
  } catch {
    // Non-fatal — don't break Codex execution
  }
}

/** App-server thread items → exec JSONL event shape (snake_case types). */
export function translateAppServerItem(
  item: Record<string, unknown>,
  phase: "started" | "completed" = "completed",
): { type: string; item: Record<string, unknown> } | null {
  const type = item.type as string | undefined;
  if (!type) return null;
  const eventType = `item.${phase}`;
  if (type === "agentMessage") {
    return {
      type: eventType,
      item: {
        type: "agent_message",
        text: item.text,
        ...(item.phase === "commentary" || item.phase === "final_answer"
          ? { phase: item.phase }
          : {}),
      },
    };
  }
  if (type === "commandExecution") {
    const output = item.aggregatedOutput ?? item.aggregated_output ?? item.output;
    return {
      type: eventType,
      item: {
        type: "command_execution",
        command: item.command,
        exit_code: item.exitCode,
        ...(item.durationMs !== undefined ? { duration_ms: item.durationMs } : {}),
        ...(output !== undefined ? { aggregated_output: output } : {}),
      },
    };
  }
  if (type === "fileChange" || type === "fileUpdate") {
    const changes = (item.changes as Array<{ path?: string }> | undefined) || [];
    return { type: eventType, item: { type: "file_change", path: item.path || changes[0]?.path } };
  }
  if (type === "reasoning") {
    const summary = (item.summary as string[] | undefined)?.join(" ") || "";
    return summary ? { type: eventType, item: { type: "reasoning", text: summary } } : null;
  }
  if (type === "plan") {
    return { type: eventType, item: { type: "plan_update", text: item.text } };
  }
  if (type === "mcpToolCall") {
    return {
      type: eventType,
      item: {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
        duration_ms: item.durationMs,
        appContext: item.appContext,
        mcpAppResourceUri: item.mcpAppResourceUri,
        pluginId: item.pluginId,
        artifact_deferred: true,
      },
    };
  }
  if (type === "dynamicToolCall") {
    return {
      type: eventType,
      item: {
        type: "mcp_tool_call",
        namespace: item.namespace,
        tool: item.tool,
        arguments: item.arguments,
        result: item.contentItems,
        status: item.status,
        duration_ms: item.durationMs,
      },
    };
  }
  if (type === "webSearch") {
    return {
      type: eventType,
      item: {
        type: "web_search",
        query: item.query,
        action: item.action,
      },
    };
  }
  if (type === "imageView") {
    return { type: eventType, item: { type: "image_view", path: item.path } };
  }
  if (type === "sleep") {
    return { type: eventType, item: { type: "sleep", duration_ms: item.durationMs } };
  }
  if (type === "collabAgentToolCall") {
    return {
      type: eventType,
      item: {
        type: "collab_agent_tool_call",
        id: item.id,
        tool: item.tool,
        prompt: item.prompt,
        status: item.status,
        sender_thread_id: item.senderThreadId,
        receiver_thread_ids: item.receiverThreadIds,
        model: item.model,
        reasoning_effort: item.reasoningEffort,
        agents_states: item.agentsStates,
        ...(item.durationMs !== undefined ? { duration_ms: item.durationMs } : {}),
      },
    };
  }
  if (type === "subAgentActivity") {
    return {
      type: eventType,
      item: {
        type: "subagent_activity",
        id: item.id,
        kind: item.kind,
        agent_thread_id: item.agentThreadId,
        agent_path: item.agentPath,
      },
    };
  }
  return null;
}

/**
 * Separates consecutive provider messages for consumers that render one block
 * of text per turn.
 *
 * Callers that report `messageID` to `onTextDelta` receive the boundary as
 * structured data instead and must not also insert this blank line, or the
 * separator would be duplicated at the start of every segment.
 */
export function separateAppServerMessageDelta(
  delta: string,
  itemId: string | undefined,
  previousItemId: string | undefined,
  hasStreamedText: boolean,
): string {
  if (!delta) return delta;
  if (hasStreamedText && itemId && previousItemId && itemId !== previousItemId) {
    return `\n\n${delta}`;
  }
  return delta;
}

export const codexDisplayStdout = (
  transportStdout: string,
  finalMessage: string,
  isRoomExecution: boolean,
): string => isRoomExecution && finalMessage.trim()
  ? finalMessage
  : transportStdout;

export class CodexAdapter implements AgentAdapter {
  name = "codex";
  capabilities = harnessCapabilities({
    transport: {
      kind: "appServer",
      // App Server is structured, but this adapter does not yet persist its
      // initialize response as negotiated capability evidence.
      capabilityNegotiation: false,
      structuredEvents: true,
    },
    sessionResume: true,
    sessionFork: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    speedSelection: true,
    permissionSelection: true,
    persistentProcess: true,
    nativeSteer: true,
    approvalBridge: true,
    planReporting: true,
    nativeReview: true,
    diffReporting: true,
    usageReporting: true,
    rateLimitReporting: true,
    modelDiscovery: true,
    browser: coodeIsolatedBrowser(),
  });
  nativeControls = codexNativeControls;

  async available(): Promise<boolean> {
    return which("codex");
  }

  dispose(): void {
    disposeCodexAppServer();
  }

  /** Persistent-daemon path: one codex process serves every prompt. */
  private async executeViaAppServer(
    goal: string,
    options: ExecuteOptions,
    hasRoomContext: boolean,
  ): Promise<ExecuteResult> {
    const isRoomExecution = Boolean(options.roomId && options.runId);
    const reportConfig = hasRoomContext
      ? {
        roomId: options.roomId!,
        runId: options.runId!,
        serverUrl: options.serverUrl!,
        sessionToken: options.sessionToken!,
      }
      : undefined;
    const sourceThreadId = options.providerSession?.providerSessionId;
    let stdout = "";
    let streamedDelta = false;
    let activeMessageItemId: string | undefined;
    let reasoningSummary = "";
    let lastReasoningTitle = "";
    let lastReasoningPublishedAt = 0;
    const completedMcpItems: Record<string, unknown>[] = [];
    const collaborationLabels: CodexAgentLabels = new Map();
    const processEnvironment = providerProcessEnvironment({
      ...options,
      provider: this.name,
    });
    const appServer = getCodexAppServer(
      providerProcessEnvironment({ provider: this.name }),
    );
    const sandbox = options.permissionMode === "fullAccess"
      ? "danger-full-access"
      : options.permissionMode === "plan"
        ? "read-only"
        : "workspace-write";
    const approvalPolicy = options.permissionMode === "approve"
      || options.permissionMode === "fullAccess"
      ? "never"
      : "on-request";
    const result = await runCodexAppServerTurn(goal, {
        workDir: options.workDir,
        model: options.model,
        effort: options.effort,
        speed: options.speed,
        sandbox,
        approvalPolicy,
        threadId: sourceThreadId,
        forkThread: options.providerSession?.mode === "fork",
        workspaceAccess: options.workspaceAccess,
        permissionMode: options.permissionMode,
        nativeReview: options.nativeReview,
        onRuntimeControl: options.onRuntimeControl,
        onRawEvent: options.onRawEvent,
        onPermissionRequest: async (request) => {
          options.onActivity?.({
            kind: request.kind === "execute" ? "command" : "file",
            phase: "started",
            title: `Approval required: ${request.title}`,
            tool: request.tool,
            ...(request.input ? { input: request.input, codeLanguage: "json" } : {}),
          });
          const decision = options.onPermissionRequest
            ? await options.onPermissionRequest(request)
            : undefined;
          if (decision) {
            const selected = decision.outcome === "selected"
              ? request.options.find((option) => option.id === decision.optionID)
              : undefined;
            options.onActivity?.({
              kind: request.kind === "execute" ? "command" : "file",
              phase: "completed",
              title: request.title,
              tool: request.tool,
              result: selected?.name || "Cancelled",
            });
            return decision;
          }
          // Returning undefined is not part of the shared callback contract;
          // omit the callback entirely when no UI broker exists by delegating
          // to the App Server policy below.
          const fallback = options.permissionMode === "plan"
            ? request.options.find((option) => option.kind === "reject_always")
              || request.options.find((option) => option.kind === "reject_once")
            : request.options.find((option) => option.kind === "reject_once")
              || request.options.find((option) => option.kind === "reject_always");
          options.onActivity?.({
            kind: request.kind === "execute" ? "command" : "file",
            phase: "completed",
            title: request.title,
            tool: request.tool,
            result: fallback?.name || "Cancelled",
          });
          return fallback
            ? { outcome: "selected", optionID: fallback.id }
            : { outcome: "cancelled" };
        },
        client: appServer,
        signal: options.signal,
        environmentOverrides: processEnvironment,
        onDelta: (text, message) => {
          // The transcript keeps each provider message as its own entry, so the
          // boundary travels as `messageID` rather than as an injected blank
          // line. `onOutput` is a flat log, so it still receives the separator.
          const separatedText = separateAppServerMessageDelta(
            text,
            message.itemId,
            activeMessageItemId,
            streamedDelta,
          );
          if (message.itemId) activeMessageItemId = message.itemId;
          if (separatedText) streamedDelta = true;
          if (text) {
            options.onTextDelta?.(text, {
              messageID: message.itemId,
              phase: message.phase,
            });
          }
          options.onOutput?.(separatedText);
        },
        onReasoningSummaryDelta: (text) => {
          reasoningSummary = `${reasoningSummary}${text}`.slice(-1_000);
          const activity = codexReasoningSummaryActivity(reasoningSummary);
          if (!activity || activity.title === lastReasoningTitle) return;
          const now = Date.now();
          if (lastReasoningTitle && now - lastReasoningPublishedAt < 250) return;
          lastReasoningTitle = activity.title;
          lastReasoningPublishedAt = now;
          options.onActivity?.(activity);
        },
        onItem: (item, phase, context) => {
          if (phase === "completed"
              && item.type === "mcpToolCall"
              && !context?.isSubagent) {
            completedMcpItems.push(item);
          }
          if (context?.isSubagent
              && phase === "completed"
              && item.type === "agentMessage") {
            const progress = codexChildMessageActivity(item, context, collaborationLabels);
            if (progress) options.onActivity?.(progress);
          }
          // Translate app-server items into the exec JSONL event shape the
          // room reporting + display pipeline already understands.
          const translated = translateAppServerItem(item, phase);
          if (!translated) return;
          for (const activity of codexActivitiesFromEvent(translated, collaborationLabels)) {
            options.onActivity?.(
              context?.isSubagent
                ? codexChildActivity(activity, context, collaborationLabels)
                : activity,
            );
          }
          if (phase !== "completed") return;
          stdout += `${JSON.stringify(translated)}
`;
          if (reportConfig) void reportCodexEvent(translated, reportConfig);
          const itemType = (translated.item as Record<string, unknown>)?.type;
          if (itemType === "command_execution") {
            options.onOutput?.(`$ ${(translated.item as Record<string, unknown>).command}
`);
          } else if (itemType === "file_change") {
            options.onOutput?.(`[write] ${(translated.item as Record<string, unknown>).path}
`);
          }
        },
      });
    for (const activity of codexCompletedSubagentActivities(
      collaborationLabels,
      result.exitCode !== 0,
    )) {
      options.onActivity?.(activity);
    }
    for (const item of completedMcpItems) {
      const activity = await codexArtifactActivityFromItem(
        item,
        result.threadId,
        appServer,
      );
      if (activity) options.onActivity?.(activity);
    }
    // Synthesize thread.started so provider-session extraction keeps working.
    const threadEvent = { type: "thread.started", thread_id: result.threadId };
    stdout = `${JSON.stringify(threadEvent)}
${stdout}`;
    if (reportConfig) void reportCodexEvent(threadEvent, reportConfig);
    if (result.finalMessage && !streamedDelta) {
      options.onTextDelta?.(result.finalMessage);
      options.onOutput?.(`${result.finalMessage}
`);
    }
    return {
      exitCode: result.exitCode,
      stdout: codexDisplayStdout(
        `${stdout}${result.finalMessage}\n`,
        result.finalMessage,
        isRoomExecution,
      ),
      stderr: result.errorMessage || "",
      providerSessionId: result.threadId,
    };
  }

  async execute(
    goal: string,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const { workDir, onOutput, signal } = options;
    const executionGoal = promptWithHarnessCapabilities(goal, options, this.name, {
      nativeWorkspaceTools: true,
    });
    const isRoomExecution = Boolean(options.roomId && options.runId);
    const hasRoomReportingContext = Boolean(
      options.roomId && options.runId && options.serverUrl && options.sessionToken,
    );
    const finish = (result: ExecuteResult) => withDeclaredHarnessCapabilityReceipt(
      result,
      this.name,
      this.capabilities,
      options,
    );

    // The persistent app-server and exec fallback both inherit the user's
    // normal Codex plugins, skills, and MCP servers. Browser authority remains
    // scoped separately through co·ode's short-lived browser capability.
    if (process.env.CO_OD_CODEX_EXEC !== "1") {
      try {
        return finish(await this.executeViaAppServer(executionGoal, options, hasRoomReportingContext));
      } catch (error) {
        if (error instanceof CodexAppServerTurnTerminatedError) {
          // The provider accepted this turn. Never duplicate it through the
          // exec fallback after a timeout, explicit stop, or ambiguous start.
          throw error;
        }
        if (options.providerSession?.mode === "fork") {
          // `codex exec` has no provider-native fork equivalent. Failing here
          // is safer than creating an empty lookalike task with lost history.
          throw error;
        }
        if (options.nativeReview) {
          // A normal exec prompt is not equivalent to App Server's review
          // target/delivery semantics, so never silently downgrade it.
          throw error;
        }
        // Daemon unavailable or dispatch failed — fall through to exec.
      }
    }

    // Use --json for JSONL event streaming when we have room context.
    const args = buildCodexArgs(executionGoal, {
      attachments: options.attachments,
      additionalDirectories: options.additionalDirectories,
      effort: options.effort,
      model: options.model,
      permissionMode: options.permissionMode,
      providerSession: options.providerSession,
      speed: options.speed,
      json: isRoomExecution,
    });

    const collaborationLabels: CodexAgentLabels = new Map();
    const result = await new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn("codex", args, {
        cwd: workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let lastAgentMessage = "";
      let receivedAgentDelta = false;
      let receivedAgentMessage = false;
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      if (isRoomExecution) {
        // Parse JSONL events from stdout for real-time reporting
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        rl.on("line", (line) => {
          stdout += line + "\n";
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "providerToCoode",
              channel: "protocol",
              payload: event,
            });
            const item = event.item as Record<string, unknown> | undefined;
            for (const activity of codexActivitiesFromEvent(event, collaborationLabels)) {
              options.onActivity?.(activity);
            }
            const delta = typeof event.delta === "string"
              ? event.delta
              : typeof item?.delta === "string"
                ? item.delta
                : undefined;
            if (delta && String(event.type || "").toLowerCase().includes("delta")) {
              receivedAgentDelta = true;
              options.onTextDelta?.(delta);
            }
            // Extract final agent message for display
            if (
              event.type === "item.completed" &&
              item?.type === "agent_message"
            ) {
              lastAgentMessage =
                (item.text as string) || "";
              if (lastAgentMessage && !receivedAgentDelta) {
                options.onTextDelta?.(
                  `${receivedAgentMessage ? "\n\n" : ""}${lastAgentMessage}`,
                );
                receivedAgentMessage = true;
              }
            }
            // Report progress to co-ode
            if (hasRoomReportingContext) {
              const config = {
                roomId: options.roomId!,
                runId: options.runId!,
                serverUrl: options.serverUrl!,
                sessionToken: options.sessionToken!,
              };
              void reportCodexEvent(event, config);
            }
            // Feed human-readable output to onOutput
            const itemType = item?.type;
            if (event.type === "item.completed" && itemType === "command_execution") {
              onOutput?.(`$ ${(event.item as Record<string, unknown>).command}\n`);
            } else if (event.type === "item.completed" && itemType === "file_change") {
              onOutput?.(`[write] ${(event.item as Record<string, unknown>).path}\n`);
            } else if (event.type === "item.completed" && itemType === "agent_message") {
              onOutput?.(
                `${((event.item as Record<string, unknown>).text as string || "").slice(0, 500)}\n`,
              );
            }
          } catch {
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "providerToCoode",
              channel: "stdout",
              payload: `${line}\n`,
            });
            // Not valid JSON — pass through as raw output
            onOutput?.(line + "\n");
          }
        });
      } else {
        // No room context — raw output mode (original behavior)
        child.stdout?.on("data", (chunk: string) => {
          void options.onRawEvent?.({
            observedAt: new Date().toISOString(),
            direction: "providerToCoode",
            channel: "stdout",
            payload: chunk,
          });
          stdout += chunk;
          onOutput?.(chunk);
        });
      }

      child.stderr?.on("data", (chunk: string) => {
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: "stderr",
          payload: chunk,
        });
        stderr += chunk;
        onOutput?.(chunk);
      });

      // `exit` can fire before the stdio pipes are fully drained. Resolve on
      // `close` so short-lived providers cannot lose their final JSONL lines
      // during app-server fallback.
      child.on("close", (code) => {
        // Keep provider JSONL available only for session-id recovery. Room
        // consumers need the final human response, never the transport stream.
        const providerOutput = `${stdout}\n${stderr}`;
        const displayStdout = codexDisplayStdout(
          stdout,
          lastAgentMessage,
          isRoomExecution,
        );
        const providerSessionId = resolveProviderSessionIdFromResult(
          providerOutput,
          options.providerSession,
        );
        resolve({
          exitCode: code ?? 1,
          stdout: displayStdout,
          stderr,
          providerSessionId,
        });
      });

      child.on("error", (err) => {
        reject(err);
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGTERM");
          },
          { once: true },
        );
      }
    });
    for (const activity of codexCompletedSubagentActivities(
      collaborationLabels,
      result.exitCode !== 0,
    )) {
      options.onActivity?.(activity);
    }
    return finish(result);
  }
}
