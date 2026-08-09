import { spawn } from "node:child_process";
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
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessActivityKind,
  type HarnessActivityUpdate,
} from "./base.js";
import {
  CodexAppServerTurnTerminatedError,
  disposeCodexAppServer,
  getCodexAppServer,
  runCodexAppServerTurn,
} from "./codex-app-server.js";

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
    case "tests": return active ? "Running checks" : "Ran checks";
    case "search": return active ? "Searching files" : "Searched files";
    case "read": return active ? "Reading files" : "Read files";
    case "file": return subject
      ? `${active ? "Editing" : "Edited"} ${subject}`
      : active ? "Editing files" : "Edited files";
    case "browser": return active ? "Browsing" : "Browsed";
    case "plan": return active ? "Updating the plan" : "Updated the plan";
    case "tool": return subject
      ? `${active ? "Using" : "Used"} ${subject}`
      : active ? "Using a tool" : "Used a tool";
    case "command": return active ? "Running a command" : "Ran a command";
  }
};

export function codexActivityFromEvent(
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
      return {
        kind,
        phase,
        title: activityTitle(kind, phase, tool),
        detail: server && tool ? `${server} · ${tool}` : tool,
        ...(identifier ? { tool: identifier } : {}),
        ...(input ? { input, codeLanguage: "json" as const } : {}),
        ...(phase === "completed" && output ? { output } : {}),
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
        kind: "tool",
        phase,
        title: phase === "started" ? "Viewing an image" : "Viewed an image",
        detail: path,
        tool: "image_view",
        ...(path ? { input: path, codeLanguage: "text" as const } : {}),
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
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
        duration_ms: item.durationMs,
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
        tool: item.tool,
        prompt: item.prompt,
        status: item.status,
        duration_ms: item.durationMs,
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

export class CodexAdapter implements AgentAdapter {
  name = "codex";
  capabilities = harnessCapabilities({
    sessionResume: true,
    sessionFork: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    speedSelection: true,
    permissionSelection: true,
    persistentProcess: true,
    browser: coodeIsolatedBrowser(),
  });

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
    const result = await runCodexAppServerTurn(goal, {
        workDir: options.workDir,
        model: options.model,
        effort: options.effort,
        speed: options.speed,
        sandbox,
        approvalPolicy: "never",
        threadId: sourceThreadId,
        forkThread: options.providerSession?.mode === "fork",
        workspaceAccess: options.workspaceAccess,
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
        onItem: (item, phase) => {
          // Translate app-server items into the exec JSONL event shape the
          // room reporting + display pipeline already understands.
          const translated = translateAppServerItem(item, phase);
          if (!translated) return;
          const activity = codexActivityFromEvent(translated);
          if (activity) options.onActivity?.(activity);
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
      stdout: `${stdout}${result.finalMessage}
`,
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

    // The persistent app-server and exec fallback both inherit the user's
    // normal Codex plugins, skills, and MCP servers. Browser authority remains
    // scoped separately through co·ode's short-lived browser capability.
    if (process.env.CO_OD_CODEX_EXEC !== "1") {
      try {
        return await this.executeViaAppServer(executionGoal, options, hasRoomReportingContext);
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

    return new Promise<ExecuteResult>((resolve, reject) => {
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
            const item = event.item as Record<string, unknown> | undefined;
            const activity = codexActivityFromEvent(event);
            if (activity) options.onActivity?.(activity);
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
            // Not valid JSON — pass through as raw output
            onOutput?.(line + "\n");
          }
        });
      } else {
        // No room context — raw output mode (original behavior)
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
          onOutput?.(chunk);
        });
      }

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        onOutput?.(chunk);
      });

      child.on("exit", (code) => {
        // If we parsed JSONL, include the last agent message in stdout for the caller
        if (isRoomExecution && lastAgentMessage) {
          stdout += `\n--- Agent Response ---\n${lastAgentMessage}\n`;
        }
        const providerSessionId = resolveProviderSessionIdFromResult(
          `${stdout}\n${stderr}`,
          options.providerSession,
        );
        resolve({
          exitCode: code ?? 1,
          stdout,
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
  }
}
