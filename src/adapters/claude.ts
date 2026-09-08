import { nativeImageAttachments } from "./native-images.js";
import { managedIntegrationRuntime, type ManagedIntegrationRuntime } from "./managed-integrations.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  boundedActivityPayload,
  existingAttachmentPaths,
  coodeIsolatedBrowser,
  browserModeForExecution,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  withDeclaredHarnessCapabilityReceipt,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessActivityUpdate,
  type HarnessBackgroundAgentSummary,
  type HarnessBackgroundAgentAction,
  type HarnessBackgroundAgentControlResult,
} from "./base.js";
import type {
  HarnessUsageLimits,
  HarnessUsageWindow,
} from "./codex-app-server.js";
import { generateHooksDir, cleanupHooksDir } from "../hooks-generator.js";
import { harnessArtifactsFromToolResult } from "./harness-artifacts.js";

function which(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(":");
  return paths.some((dir) => existsSync(`${dir}/${cmd}`));
}

const captureClaude = (args: string[], workDir: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("claude", args, {
    cwd: workDir,
    env: providerProcessEnvironment({ provider: "claude" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (value: string) => { stdout += value; });
  child.stderr?.on("data", (value: string) => { stderr += value; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0
    ? resolve(stdout)
    : reject(new Error(stderr.trim() || `Claude exited with status ${code ?? 1}.`)));
});

const claudeBackgroundPermissionMode = (mode: ExecuteOptions["permissionMode"]): string => ({
  ask: "manual",
  approve: "acceptEdits",
  fullAccess: "bypassPermissions",
  plan: "plan",
  custom: "manual",
}[mode || "ask"]);

const claudeForegroundPermissionMode = (mode: ExecuteOptions["permissionMode"]): string => ({
  ask: "manual",
  approve: "acceptEdits",
  fullAccess: "bypassPermissions",
  plan: "plan",
  custom: "manual",
}[mode || "approve"]);

const boundedClaudeAgentID = (value: string): string => {
  const id = value.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Claude background agent id is invalid.");
  }
  return id;
};

export const claudeBackgroundAgents = {
  async list(workDir: string, includeCompleted = false): Promise<HarnessBackgroundAgentSummary[]> {
    const stdout = await captureClaude([
      "agents", "--json", "--cwd", workDir,
      ...(includeCompleted ? ["--all"] : []),
    ], workDir);
    const value = JSON.parse(stdout || "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): HarnessBackgroundAgentSummary[] => {
      if (!entry || typeof entry !== "object") return [];
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id
        : typeof raw.jobId === "string" ? raw.jobId
          : typeof raw.sessionId === "string" ? raw.sessionId : "";
      if (!id) return [];
      return [{
        id,
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.state === "string" ? { status: raw.state }
          : typeof raw.status === "string" ? { status: raw.status } : {}),
        ...(typeof raw.cwd === "string" ? { workDir: raw.cwd } : {}),
        ...(typeof raw.sessionId === "string" ? { providerSessionID: raw.sessionId } : {}),
        raw,
      }];
    });
  },

  async dispatch(
    goal: string,
    options: Pick<ExecuteOptions, "workDir" | "model" | "effort" | "permissionMode">,
  ): Promise<HarnessBackgroundAgentSummary> {
    const stdout = await captureClaude([
      "--bg",
      "--permission-mode", claudeBackgroundPermissionMode(options.permissionMode),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["--effort", options.effort] : []),
      "--",
      goal,
    ], options.workDir);
    const id = stdout.match(/backgrounded\s*[·:]\s*([a-zA-Z0-9_-]+)/i)?.[1]
      || stdout.match(/\b([a-f0-9]{8,})\b/i)?.[1];
    if (!id) throw new Error("Claude background dispatch did not return an agent id.");
    return { id, status: "running", workDir: options.workDir };
  },

  async control(
    action: HarnessBackgroundAgentAction,
    agentID: string,
    workDir: string,
  ): Promise<HarnessBackgroundAgentControlResult> {
    const id = boundedClaudeAgentID(agentID);
    const command: Record<HarnessBackgroundAgentAction, string> = {
      logs: "logs",
      stop: "stop",
      respawn: "respawn",
      remove: "rm",
    };
    const output = await captureClaude([command[action], id], workDir);
    return {
      agent: {
        id,
        workDir,
        status: action === "stop" ? "stopped"
          : action === "respawn" ? "working"
            : action === "remove" ? "removed" : "observed",
      },
      ...(action === "logs" ? { output: output.trim().slice(-16_000) } : {}),
    };
  },
};

export function buildClaudeArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "effort" | "model" | "permissionMode" | "providerSession"> & { extraAddDirs?: string[]; nativeInput?: boolean; providerNativeBrowser?: boolean; managedIntegrations?: ManagedIntegrationRuntime } = {},
): string[] {
  const permissionMode = {
    ask: "manual",
    approve: "acceptEdits",
    fullAccess: "bypassPermissions",
    plan: "plan",
    custom: "manual",
  }[options.permissionMode || "approve"];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--include-hook-events",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
  if (options.providerNativeBrowser) args.push("--chrome");
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") {
      args.push("--fork-session");
    }
  }
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  for (const dir of options.extraAddDirs || []) {
    args.push("--add-dir", dir);
  }
  for (const dir of existingAttachmentPaths(options.attachments, ["directory"])) {
    args.push("--add-dir", dir);
  }
  args.push(...(options.managedIntegrations?.claudeArguments ?? []));
  if (options.nativeInput) args.push("--input-format", "stream-json");
  else args.push("--", goal);
  return args;
}

export function claudeTextDelta(payload: Record<string, unknown>): string | undefined {
  const streamEvent = payload.type === "stream_event" && payload.event && typeof payload.event === "object"
    ? payload.event as Record<string, unknown>
    : payload;
  const delta = streamEvent.delta && typeof streamEvent.delta === "object"
    ? streamEvent.delta as Record<string, unknown>
    : undefined;
  if (
    streamEvent.type === "content_block_delta"
    && delta?.type === "text_delta"
    && typeof delta.text === "string"
  ) {
    return delta.text;
  }
  return undefined;
}

export function claudeSubagentActivities(
  payload: Record<string, unknown>,
  labels: Map<string, string> = new Map(),
): HarnessActivityUpdate[] {
  if (payload.type !== "assistant" && payload.type !== "user") return [];
  const parentAgentID = typeof payload.parent_tool_use_id === "string"
    ? payload.parent_tool_use_id
    : undefined;
  const message = payload.message && typeof payload.message === "object"
    ? payload.message as Record<string, unknown>
    : payload;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const activities: HarnessActivityUpdate[] = [];
  for (const value of blocks) {
    if (!value || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    if (block.type === "tool_use"
        && typeof block.id === "string"
        && /^(?:Agent|Task)$/i.test(String(block.name || ""))) {
      const input = block.input && typeof block.input === "object"
        ? block.input as Record<string, unknown>
        : {};
      const description = typeof input.description === "string"
        ? input.description
        : typeof input.prompt === "string" ? input.prompt.slice(0, 240) : "Claude subagent";
      labels.set(block.id, description);
      activities.push({
        kind: "tool",
        phase: "started",
        title: `Started ${description}`,
        detail: "Claude subagent",
        tool: String(block.name || "Agent"),
        input: boundedActivityPayload(input),
        codeLanguage: "json",
        agentID: block.id,
        ...(parentAgentID ? { parentAgentID } : {}),
        background: input.run_in_background === true || input.background === true,
        agentName: "Claude subagent",
        agentTask: description,
        agentStatus: "working",
        agentProgress: "Starting",
      });
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const description = labels.get(block.tool_use_id);
      if (description === undefined) continue;
      const failed = block.is_error === true;
      activities.push({
        kind: "tool",
        phase: "completed",
        title: description
          ? `${failed ? "Failed" : "Completed"} ${description}`
          : failed ? "Claude subagent failed" : "Claude subagent completed",
        detail: "Claude subagent",
        tool: "Agent",
        output: boundedActivityPayload(block.content),
        result: failed ? "Failed" : "Completed",
        agentID: block.tool_use_id,
        ...(parentAgentID ? { parentAgentID } : {}),
        agentName: "Claude subagent",
        agentTask: description || "Delegated task",
        agentStatus: failed ? "failed" : "completed",
        agentProgress: failed ? "Stopped before finishing" : "Finished",
      });
      labels.delete(block.tool_use_id);
    }
  }
  return activities;
}

/** Tracks ordinary tool calls separately from Agent/Task lineage. */
export class ClaudeTranscriptTracker {
  private readonly tools = new Map<string, HarnessActivityUpdate>();
  private readonly messages = new Map<string, string>();

  messageID(payload: Record<string, unknown>): string | undefined {
    const scope = typeof payload.parent_tool_use_id === "string" ? payload.parent_tool_use_id : "root";
    const event = payload.type === "stream_event" && payload.event && typeof payload.event === "object"
      ? payload.event as Record<string, unknown> : payload;
    if (event.type === "message_start" && event.message && typeof event.message === "object") {
      const id = (event.message as Record<string, unknown>).id;
      if (typeof id === "string") this.messages.set(scope, id);
    }
    return this.messages.get(scope);
  }

  activities(payload: Record<string, unknown>): HarnessActivityUpdate[] {
    if (payload.type !== "assistant" && payload.type !== "user") return [];
    const message = payload.message && typeof payload.message === "object" ? payload.message as Record<string, unknown> : payload;
    const activities: HarnessActivityUpdate[] = [];
    for (const value of Array.isArray(message.content) ? message.content : []) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && !/^(?:Agent|Task)$/i.test(block.name)) {
        if (this.tools.has(block.id)) continue;
        const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
        const command = typeof input.command === "string" ? input.command : undefined;
        const shell = block.name === "Bash";
        const activity: HarnessActivityUpdate = {
          kind: shell ? "command" : block.name === "Read" ? "read" : /^(Grep|Glob)$/.test(block.name) ? "search" : "tool",
          phase: "started", title: shell ? "Running command" : `Using ${block.name}`,
          detail: command || (typeof input.file_path === "string" ? input.file_path : block.name),
          tool: block.name, input: boundedActivityPayload(input), codeLanguage: shell ? "shell" : "json",
        };
        this.tools.set(block.id, activity);
        activities.push(activity);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const started = this.tools.get(block.tool_use_id);
        if (!started) continue;
        this.tools.delete(block.tool_use_id);
        const failed = block.is_error === true;
        const artifacts = harnessArtifactsFromToolResult(block.content, { provider: "claude", tool: started.tool!, title: started.title });
        activities.push({ ...started, phase: "completed", title: failed ? `Failed ${started.tool}` : started.tool === "Bash" ? "Ran command" : `Used ${started.tool}`,
          result: failed ? "Failed" : "Completed", output: boundedActivityPayload(block.content), ...(artifacts.length ? { artifacts } : {}) });
      }
    }
    return activities;
  }
}

export function parseClaudePrintOutput(stdout: string): { text: string; providerSessionId?: string } {
  let streamedText = "";
  let finalText = "";
  let plainText = "";
  let sawStructuredOutput = false;
  let providerSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      sawStructuredOutput = true;
      streamedText += claudeTextDelta(payload) || "";
      if (payload.type === "result" && typeof payload.result === "string") {
        finalText = payload.result;
      } else if (!payload.type && typeof payload.result === "string") {
        finalText = payload.result;
      }
      providerSessionId = typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.sessionId === "string" ? payload.sessionId : providerSessionId;
    } catch {
      plainText += `${line}\n`;
    }
  }
  return {
    // Claude's stream also contains lifecycle and hook JSON. If a run stops
    // before producing assistant text, surfacing that transport stream leaks
    // provider internals into the Room and can make a long transcript very
    // expensive to render. Preserve genuinely plain CLI output, but never use
    // recognized structured events as user-facing fallback text.
    text: finalText || streamedText || (sawStructuredOutput ? plainText.trim() : stdout),
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

type ClaudePersistentOptions = Pick<
  ExecuteOptions,
  "effort" | "model" | "permissionMode" | "providerSession" | "signal" |
  "onActivity" | "onOutput" | "onTextDelta" | "onRawEvent"
> & { workDir: string; providerNativeBrowser?: boolean; managedIntegrations?: ManagedIntegrationRuntime };

export function buildClaudePersistentArgs(
  options: Pick<ClaudePersistentOptions, "effort" | "model" | "permissionMode" | "providerSession" | "providerNativeBrowser" | "managedIntegrations">,
): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--include-hook-events",
    "--replay-user-messages",
    "--verbose",
    "--permission-mode", claudeForegroundPermissionMode(options.permissionMode),
  ];
  if (options.providerNativeBrowser) args.push("--chrome");
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") args.push("--fork-session");
  }
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  args.push(...(options.managedIntegrations?.claudeArguments ?? []));
  return args;
}

export const claudeUserInput = (goal: string, sessionID?: string, images: Awaited<ReturnType<typeof nativeImageAttachments>> = []): string => JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: goal }, ...images.map((image) => ({
      type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data },
    }))],
  },
  parent_tool_use_id: null,
  ...(sessionID ? { session_id: sessionID } : {}),
});

interface PendingClaudeTurn {
  options: ClaudePersistentOptions;
  stdout: string;
  stderr: string;
  finalText: string;
  streamedText: string;
  providerSessionID?: string;
  receivedTextDelta: boolean;
  resolve: (result: ExecuteResult) => void;
  reject: (error: Error) => void;
  abort?: () => void;
}

class ClaudePersistentProcess {
  private readonly child: ChildProcess;
  private pending?: PendingClaudeTurn;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private idleTimer?: NodeJS.Timeout;
  private readonly subagentLabels = new Map<string, string>();
  private transcriptTracker = new ClaudeTranscriptTracker();
  providerSessionID?: string;

  constructor(
    readonly signature: string,
    private readonly options: ClaudePersistentOptions,
    private readonly onSessionID: (sessionID: string, process: ClaudePersistentProcess) => void,
    private readonly onClose: (process: ClaudePersistentProcess) => void,
  ) {
    this.child = spawn("claude", buildClaudePersistentArgs(options), {
      cwd: options.workDir,
      env: providerProcessEnvironment({ provider: "claude", providerSession: options.providerSession }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr?.on("data", (chunk: string) => {
      const pending = this.pending;
      if (!pending) return;
      void pending.options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "stderr",
        payload: chunk,
      });
      pending.stderr += chunk;
      pending.options.onOutput?.(chunk);
    });
    this.child.once("error", (error) => this.close(error));
    this.child.once("close", (code) => this.close(
      this.pending?.options.signal?.aborted
        ? undefined
        : code === 0 ? undefined : new Error(`Claude persistent session exited with status ${code ?? 1}.`),
      code ?? 1,
    ));
  }

  run(goal: string, options: ClaudePersistentOptions): Promise<ExecuteResult> {
    const operation = this.queue.then(() => this.runNow(goal, options));
    this.queue = operation.catch(() => {});
    return operation;
  }

  private runNow(goal: string, options: ClaudePersistentOptions): Promise<ExecuteResult> {
    if (this.closed || !this.child.stdin?.writable) {
      return Promise.reject(new Error("Claude persistent session is no longer attached."));
    }
    if (options.signal?.aborted) {
      return Promise.resolve({ exitCode: 130, stdout: "", stderr: "Claude turn was cancelled." });
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.transcriptTracker = new ClaudeTranscriptTracker();
    return new Promise<ExecuteResult>((resolve, reject) => {
      const pending: PendingClaudeTurn = {
        options,
        stdout: "",
        stderr: "",
        finalText: "",
        streamedText: "",
        providerSessionID: this.providerSessionID,
        receivedTextDelta: false,
        resolve,
        reject,
      };
      const abort = () => {
        // Stream-input mode has no documented per-turn interrupt envelope.
        // Terminate the owned process and resume the durable provider session
        // in a fresh process on the next Room turn.
        this.child.kill("SIGTERM");
      };
      pending.abort = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending = pending;
      const input = claudeUserInput(goal, this.providerSessionID);
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "coodeToProvider",
        channel: "protocol",
        payload: JSON.parse(input),
      });
      this.child.stdin!.write(`${input}\n`);
    });
  }

  private handleLine(line: string): void {
    const pending = this.pending;
    if (!pending || !line.trim()) return;
    pending.stdout += `${line}\n`;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      void pending.options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "stdout",
        payload: `${line}\n`,
      });
      pending.options.onOutput?.(`${line}\n`);
      return;
    }
    void pending.options.onRawEvent?.({
      observedAt: new Date().toISOString(),
      direction: "providerToCoode",
      channel: "protocol",
      payload,
    });
    recordClaudeRateLimitEvent(payload);
    const sessionID = typeof payload.session_id === "string" ? payload.session_id
      : typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (sessionID) {
      this.providerSessionID = sessionID;
      pending.providerSessionID = sessionID;
      this.onSessionID(sessionID, this);
    }
    for (const activity of claudeSubagentActivities(payload, this.subagentLabels)) {
      pending.options.onActivity?.(activity);
    }
    for (const activity of this.transcriptTracker.activities(payload)) pending.options.onActivity?.(activity);
    const messageID = this.transcriptTracker.messageID(payload);
    const delta = claudeTextDelta(payload);
    if (delta) {
      pending.receivedTextDelta = true;
      pending.streamedText += delta;
      const parentToolUseID = typeof payload.parent_tool_use_id === "string"
        ? payload.parent_tool_use_id : undefined;
      pending.options.onTextDelta?.(delta, messageID ? { messageID, ...(parentToolUseID ? { phase: "commentary" as const } : {}) } : parentToolUseID ? {
        messageID: `subagent:${parentToolUseID}`,
        phase: "commentary",
      } : undefined);
      pending.options.onOutput?.(delta);
    }
    if (payload.type === "tool_use" && typeof payload.tool_name === "string") {
      const toolResult = payload.output ?? payload.tool_output ?? payload.result;
      const artifacts = harnessArtifactsFromToolResult(toolResult, {
        provider: "claude",
        tool: payload.tool_name,
        title: payload.tool_name,
      });
      pending.options.onActivity?.({
        kind: /\b(?:browser|chrome|web)\b/i.test(payload.tool_name) ? "browser" : "tool",
        phase: "completed",
        title: `Used ${payload.tool_name}`,
        detail: payload.tool_name,
        tool: payload.tool_name,
        input: boundedActivityPayload(payload.input ?? payload.tool_input ?? payload.arguments),
        output: boundedActivityPayload(toolResult),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        result: "Completed",
        codeLanguage: "json",
      });
    }
    if (payload.type !== "result") return;
    pending.finalText = typeof payload.result === "string" ? payload.result : pending.streamedText;
    this.finishPending({
      exitCode: payload.is_error === true ? 1 : 0,
      stdout: pending.finalText || pending.streamedText,
      stderr: pending.stderr,
      providerSessionId: pending.providerSessionID,
    });
  }

  private finishPending(result: ExecuteResult): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (pending.abort) pending.options.signal?.removeEventListener("abort", pending.abort);
    if (result.stdout && !pending.receivedTextDelta) pending.options.onTextDelta?.(result.stdout);
    pending.resolve(result);
    this.idleTimer = setTimeout(() => this.dispose(), 20 * 60_000);
    this.idleTimer.unref();
  }

  private close(error?: Error, exitCode = 1): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      if (pending.abort) pending.options.signal?.removeEventListener("abort", pending.abort);
      if (pending.options.signal?.aborted) {
        pending.resolve({
          exitCode: 130,
          stdout: pending.finalText || pending.streamedText,
          stderr: pending.stderr || "Claude turn was cancelled.",
          providerSessionId: pending.providerSessionID,
        });
      } else if (error) {
        pending.reject(error);
      } else {
        pending.resolve({
          exitCode,
          stdout: pending.finalText || pending.streamedText,
          stderr: pending.stderr,
          providerSessionId: pending.providerSessionID,
        });
      }
    }
    this.onClose(this);
  }

  dispose(): void {
    if (!this.closed) this.child.kill("SIGTERM");
  }
}

class ClaudePersistentSessionPool {
  private readonly bySessionID = new Map<string, ClaudePersistentProcess>();
  private readonly processes = new Set<ClaudePersistentProcess>();

  async execute(goal: string, options: ClaudePersistentOptions): Promise<ExecuteResult> {
    const signature = JSON.stringify({
      workDir: options.workDir,
      model: options.model || "",
      effort: options.effort || "",
      permissionMode: options.permissionMode || "ask",
      nativeBrowser: options.providerNativeBrowser === true,
      integrations: options.managedIntegrations?.signature,
    });
    const requestedSessionID = options.providerSession?.mode === "continue"
      ? options.providerSession.providerSessionId
      : undefined;
    let process = requestedSessionID ? this.bySessionID.get(requestedSessionID) : undefined;
    if (process && process.signature !== signature) process = undefined;
    if (!process) {
      process = new ClaudePersistentProcess(
        signature,
        options,
        (sessionID, owner) => this.bySessionID.set(sessionID, owner),
        (owner) => {
          this.processes.delete(owner);
          for (const [sessionID, candidate] of this.bySessionID) {
            if (candidate === owner) this.bySessionID.delete(sessionID);
          }
        },
      );
      this.processes.add(process);
    }
    return process.run(goal, options);
  }

  dispose(): void {
    for (const process of this.processes) process.dispose();
    this.processes.clear();
    this.bySessionID.clear();
  }
}

const claudePersistentSessions = new ClaudePersistentSessionPool();

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";
  capabilities = harnessCapabilities({
    transport: {
      kind: "jsonl",
      capabilityNegotiation: false,
      structuredEvents: true,
    },
    sessionResume: true,
    sessionFork: true,
    subagents: true,
    backgroundExecution: true,
    persistentProcess: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    permissionSelection: true,
    rateLimitReporting: true,
    browser: coodeIsolatedBrowser(),
  });
  backgroundAgents = claudeBackgroundAgents;

  async available(): Promise<boolean> {
    return which("claude");
  }

  dispose(): void {
    disposeClaudePersistentSessions();
  }

  async execute(
    goal: string,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    const { workDir, onOutput, signal } = options;
    const managedIntegrations = managedIntegrationRuntime("claude");

    // Generate hooks config if room context is available
    let hooksDir: string | null = null;
    const extraAddDirs: string[] = [...new Set(options.additionalDirectories || [])];

    if (options.roomId && options.runId && options.serverUrl && options.sessionToken) {
      try {
        hooksDir = generateHooksDir({
          roomId: options.roomId,
          runId: options.runId,
          serverUrl: options.serverUrl,
          sessionToken: options.sessionToken,
        });
        // Add the hooks dir so Claude Code picks up the settings.local.json
        extraAddDirs.push(hooksDir);
        onOutput?.(`[co-od] Live activity reporting enabled for this run\n`);
      } catch {
        // Non-fatal — run without hooks
      }
    }
    const providerGoal = promptWithHarnessCapabilities(goal, options, this.name);
    const providerNativeBrowser = browserModeForExecution(
      this.name,
      options.browserAccess,
      options.browserProviderParity,
    ) === "providerNative";
    const images = await nativeImageAttachments(options.attachments);
    const args = buildClaudeArgs(providerGoal, {
      nativeInput: images.length > 0,
      attachments: options.attachments,
      effort: options.effort,
      model: options.model,
      permissionMode: options.permissionMode,
      providerSession: options.providerSession,
      extraAddDirs,
      providerNativeBrowser,
      managedIntegrations,
    });

    // Claude's documented stream-json input keeps one foreground process
    // attached across turns. Per-turn shell/browser capabilities cannot be
    // safely replaced inside an existing process, so capability-bearing or
    // attachment turns use the resumable one-shot path below and the next
    // ordinary turn reattaches persistently to the returned session id.
    const supportsPersistentTurn = !hooksDir
      && !options.workspaceAccess
      && !options.browserAccess
      && !(options.attachments?.length)
      && !(options.additionalDirectories?.length);
    if (supportsPersistentTurn) {
      const result = await claudePersistentSessions.execute(providerGoal, {
        workDir,
        model: options.model,
        effort: options.effort,
        permissionMode: options.permissionMode,
        providerSession: options.providerSession,
        providerNativeBrowser,
        managedIntegrations,
        signal,
        onActivity: options.onActivity,
        onOutput,
        onTextDelta: options.onTextDelta,
        onRawEvent: options.onRawEvent,
      });
      return withDeclaredHarnessCapabilityReceipt(
        result,
        this.name,
        this.capabilities,
        options,
      );
    }

    const result = await new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end(images.length ? `${claudeUserInput(providerGoal, options.providerSession?.providerSessionId, images)}\n` : undefined);

      let stdout = "";
      let stderr = "";
      let receivedTextDelta = false;
      const subagentLabels = new Map<string, string>();
      const transcriptTracker = new ClaudeTranscriptTracker();

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on("line", (line) => {
        stdout += `${line}\n`;
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          void options.onRawEvent?.({
            observedAt: new Date().toISOString(),
            direction: "providerToCoode",
            channel: "protocol",
            payload,
          });
          recordClaudeRateLimitEvent(payload);
          for (const activity of claudeSubagentActivities(payload, subagentLabels)) {
            options.onActivity?.(activity);
          }
          for (const activity of transcriptTracker.activities(payload)) options.onActivity?.(activity);
          const messageID = transcriptTracker.messageID(payload);
          const delta = claudeTextDelta(payload);
          if (delta) {
            receivedTextDelta = true;
            const parentToolUseID = typeof payload.parent_tool_use_id === "string"
              ? payload.parent_tool_use_id
              : undefined;
            options.onTextDelta?.(delta, messageID ? { messageID, ...(parentToolUseID ? { phase: "commentary" as const } : {}) } : parentToolUseID ? {
              messageID: `subagent:${parentToolUseID}`,
              phase: "commentary",
            } : undefined);
            onOutput?.(delta);
          } else if (payload.type === "tool_use" && typeof payload.tool_name === "string") {
            const input = boundedActivityPayload(
              payload.input ?? payload.tool_input ?? payload.arguments,
            );
            const toolResult = payload.output ?? payload.tool_output ?? payload.result;
            const output = boundedActivityPayload(toolResult);
            const artifacts = harnessArtifactsFromToolResult(toolResult, {
              provider: "claude",
              tool: payload.tool_name,
              title: payload.tool_name,
            });
            options.onActivity?.({
              kind: /\b(?:browser|chrome|web)\b/i.test(payload.tool_name) ? "browser" : "tool",
              phase: "completed",
              title: `Used ${payload.tool_name}`,
              detail: payload.tool_name,
              tool: payload.tool_name,
              ...(input ? { input, codeLanguage: "json" } : {}),
              ...(output ? { output } : {}),
              ...(artifacts.length > 0 ? { artifacts } : {}),
              result: "Completed",
            });
          }
        } catch {
          void options.onRawEvent?.({
            observedAt: new Date().toISOString(),
            direction: "providerToCoode",
            channel: "stdout",
            payload: `${line}\n`,
          });
          onOutput?.(`${line}\n`);
        }
      });

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

      child.on("exit", (code) => {
        if (hooksDir) cleanupHooksDir(hooksDir);
        const parsed = parseClaudePrintOutput(stdout);
        if (parsed.text && !receivedTextDelta) options.onTextDelta?.(parsed.text);
        resolve({
          exitCode: code ?? 1,
          stdout: parsed.text,
          stderr,
          providerSessionId: parsed.providerSessionId
            || resolveProviderSessionIdFromResult(`${stdout}\n${stderr}`, options.providerSession),
        });
      });

      child.on("error", (err) => {
        if (hooksDir) cleanupHooksDir(hooksDir);
        reject(err);
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGTERM");
          },
          { once: true }
        );
      }
    });
    return withDeclaredHarnessCapabilityReceipt(
      result,
      this.name,
      this.capabilities,
      options,
    );
  }
}

export function disposeClaudePersistentSessions(): void {
  claudePersistentSessions.dispose();
}

/**
 * Latest rate-limit reading observed from Claude Code.
 *
 * Codex answers a question ("what are my limits?"); Claude announces the answer
 * mid-turn and is never asked. So the most recent announcement is cached and
 * reported until a newer turn replaces it, and no reading exists until the
 * first turn has run.
 */
let observedClaudeUsage: HarnessUsageLimits | undefined;

/** Window lengths in minutes, keyed by the provider's own window names. */
const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
};

export function recordClaudeRateLimitEvent(
  payload: Record<string, unknown>,
): HarnessUsageLimits | undefined {
  if (payload.type !== "rate_limit_event") return undefined;
  const info = payload.rate_limit_info as Record<string, unknown> | undefined;
  if (!info) return undefined;
  const utilization = Number(info.utilization);
  if (!Number.isFinite(utilization)) return undefined;
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  const window: HarnessUsageWindow = {
    // Reported as a 0–1 fraction rather than a percentage.
    usedPercent: Math.min(100, Math.max(0, Math.round(utilization * 100))),
    windowDurationMins: CLAUDE_WINDOW_MINUTES[type],
    resetsAt: Number.isFinite(Number(info.resetsAt))
      ? Number(info.resetsAt)
      : undefined,
  };
  const isShortWindow = type === "five_hour";
  observedClaudeUsage = {
    planType: observedClaudeUsage?.planType,
    // Each event describes one window, so merge rather than replace: a 5h
    // announcement must not erase a previously seen weekly reading.
    primary: isShortWindow ? observedClaudeUsage?.primary : window,
    secondary: isShortWindow ? window : observedClaudeUsage?.secondary,
  };
  return observedClaudeUsage;
}

/** Most recent Claude limits, or undefined before any turn has reported one. */
export function readClaudeUsageLimits(): HarnessUsageLimits | undefined {
  return observedClaudeUsage;
}

/** Test seam. */
export function resetClaudeUsageLimits(): void {
  observedClaudeUsage = undefined;
}
