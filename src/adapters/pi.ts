import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  HARNESS_CONTRACT_VERSION,
  boundedActivityPayload,
  coodeIsolatedBrowser,
  existingAttachmentPaths,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessCapabilityReceipt,
  type HarnessPermissionDecision,
  type HarnessPermissionRequest,
} from "./base.js";
import { harnessArtifactsFromToolResult } from "./harness-artifacts.js";

const piBinary = (): string => process.env.PI_BIN || "pi";

function which(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return null;
  const directory = (process.env.PATH || "")
    .split(":")
    .find((candidate) => existsSync(`${candidate}/${command}`));
  return directory ? `${directory}/${command}` : null;
}

export function buildPiRpcArgs(
  options: Pick<ExecuteOptions, "effort" | "model" | "permissionMode" | "providerSession"> = {},
): string[] {
  const args = ["--mode", "rpc"];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--thinking", options.effort);
  const sessionID = options.providerSession?.providerSessionId;
  if (sessionID) {
    args.push(options.providerSession?.mode === "fork" ? "--fork" : "--session", sessionID);
  }
  // Pi has no generic built-in tool approval callback. An ask/custom/plan turn
  // therefore starts without tools; claiming interactive approval here would
  // silently grant more authority than the user selected.
  if (["ask", "custom", "plan"].includes(options.permissionMode || "ask")) {
    args.push("--no-tools");
  }
  return args;
}

const activityText = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return boundedActivityPayload(value);
  const text = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { type?: string; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
  return text || boundedActivityPayload(value);
};

const receipt = (observedAt: string): HarnessCapabilityReceipt => ({
  contractVersion: HARNESS_CONTRACT_VERSION,
  harness: "pi",
  transport: "jsonl",
  agentName: "Pi",
  observedAt,
  source: "declared",
  capabilities: {
    sessionLoad: true,
    sessionList: false,
    sessionDelete: false,
    sessionResume: true,
    sessionFork: true,
    sessionClose: false,
    attachments: true,
    modelDiscovery: false,
    providerDiscovery: false,
    planReporting: false,
    usageReporting: true,
    approvalBridge: true,
  },
});

const piDialogMethods = new Set(["select", "confirm", "input", "editor"]);

/** Translate Pi's extension UI sub-protocol into co·ode's typed, fail-closed approval surface. */
export function piExtensionPermissionRequest(
  event: Record<string, unknown>,
  sessionID: string,
): HarnessPermissionRequest | undefined {
  const id = typeof event.id === "string" ? event.id.trim() : "";
  const method = typeof event.method === "string" ? event.method.trim() : "";
  if (!id || !piDialogMethods.has(method)) return undefined;
  const title = typeof event.title === "string" && event.title.trim()
    ? event.title.trim().slice(0, 512)
    : "Pi extension request";
  const message = typeof event.message === "string" ? event.message.trim().slice(0, 4_096) : "";
  const options = method === "select" && Array.isArray(event.options)
    ? event.options.filter((value): value is string => typeof value === "string").slice(0, 100)
    : [];
  const requestedSchema = method === "input" || method === "editor" ? {
    type: "object",
    required: ["value"],
    properties: {
      value: {
        type: "string",
        title,
        ...(typeof event.placeholder === "string" ? { description: event.placeholder.slice(0, 1_024) } : {}),
        ...(typeof event.prefill === "string" ? { default: event.prefill.slice(0, 16_000) } : {}),
      },
    },
  } : undefined;
  return {
    sessionID,
    toolCallID: id,
    title: message ? `${title}\n${message}` : title,
    tool: `pi.extension.${method}`,
    kind: method,
    scope: "workspace",
    ...(requestedSchema ? { requestedSchema } : {}),
    options: method === "select"
      ? [
        ...options.map((name, index) => ({
          id: `select:${index}`,
          name: name.slice(0, 256),
          kind: "allow_once" as const,
        })),
        { id: "cancel", name: "Cancel", kind: "reject_once" as const },
      ]
      : method === "confirm"
        ? [
          { id: "confirm", name: "Confirm", kind: "allow_once" },
          { id: "cancel", name: "Cancel", kind: "reject_once" },
        ]
        : [
          { id: "submit", name: "Continue", kind: "allow_once" },
          { id: "cancel", name: "Cancel", kind: "reject_once" },
        ],
  };
}

/** Produce the exact response shape Pi documents for each extension dialog method. */
export function piExtensionResponse(
  event: Record<string, unknown>,
  decision: HarnessPermissionDecision,
): Record<string, unknown> {
  const id = String(event.id || "");
  const method = String(event.method || "");
  if (decision.outcome !== "selected" || decision.optionID === "cancel") {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  if (method === "confirm") {
    return { type: "extension_ui_response", id, confirmed: decision.optionID === "confirm" };
  }
  if (method === "select") {
    const index = Number.parseInt(decision.optionID.replace(/^select:/, ""), 10);
    const candidates = Array.isArray(event.options) ? event.options : [];
    const value = candidates[index];
    return typeof value === "string"
      ? { type: "extension_ui_response", id, value }
      : { type: "extension_ui_response", id, cancelled: true };
  }
  const value = decision.content?.value;
  return typeof value === "string"
    ? { type: "extension_ui_response", id, value }
    : { type: "extension_ui_response", id, cancelled: true };
}

export class PiAdapter implements AgentAdapter {
  name = "pi";
  capabilities = harnessCapabilities({
    transport: {
      kind: "jsonl",
      capabilityNegotiation: false,
      structuredEvents: true,
    },
    sessionResume: true,
    sessionFork: true,
    sessionLoad: true,
    streamingOutput: true,
    cancellation: true,
    nativeSteer: true,
    nativeQueue: true,
    approvalBridge: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    permissionSelection: true,
    usageReporting: true,
    costReporting: true,
    externalActions: true,
    nativeIntegrations: {
      inheritsUserConfiguration: true,
      plugins: true,
      skills: true,
      mcpServers: false,
    },
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return Boolean(which(piBinary()));
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const executable = which(piBinary());
    if (!executable) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "Pi CLI was not found. Install @earendil-works/pi-coding-agent, then reopen co·ode.",
      };
    }
    const child = spawn(executable, buildPiRpcArgs(options), {
      cwd: options.workDir,
      env: providerProcessEnvironment({ ...options, provider: this.name }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let providerSessionId = options.providerSession?.providerSessionId;
    let statsReceived = false;
    let stateReceived = false;
    let settled = false;
    let finished = false;
    const providerTurnID = `pi-turn-${Date.now().toString(36)}`;
    let rpcSequence = 0;
    const capabilityReceipt = receipt(new Date().toISOString());
    const pendingTools = new Map<string, { name: string; input?: string }>();
    const pendingResponses = new Map<string, {
      resolve: (event: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }>();

    const write = (payload: Record<string, unknown>) => {
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "coodeToProvider",
        channel: "protocol",
        payload,
      });
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    const request = (type: string, payload: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `coode-${type}-${++rpcSequence}`;
      pendingResponses.set(id, { resolve, reject });
      write({ id, type, ...payload });
    });
    const finishIfReady = (resolve: (result: ExecuteResult) => void) => {
      if (finished || !settled || !statsReceived || !stateReceived) return;
      finished = true;
      options.onRuntimeControl?.(undefined);
      options.onCapabilityReceipt?.(capabilityReceipt);
      child.kill("SIGTERM");
      resolve({
        exitCode: 0,
        stdout,
        stderr,
        providerSessionId,
        capabilityReceipt,
      });
    };

    const result = new Promise<ExecuteResult>((resolve) => {
      const handle = (event: Record<string, unknown>) => {
        if (event.type === "extension_ui_request") {
          const permissionRequest = piExtensionPermissionRequest(
            event,
            providerSessionId || providerTurnID,
          );
          if (permissionRequest) {
            void Promise.resolve(options.onPermissionRequest?.(permissionRequest) ?? { outcome: "cancelled" as const })
              .then((decision) => write(piExtensionResponse(event, decision)))
              .catch(() => write({ type: "extension_ui_response", id: event.id, cancelled: true }));
          } else {
            options.onActivity?.({
              kind: "tool",
              phase: "completed",
              title: typeof event.title === "string" ? event.title.slice(0, 512) : "Pi extension update",
              tool: `pi.extension.${String(event.method || "ui")}`,
              result: "Observed",
              output: boundedActivityPayload(event),
              codeLanguage: "json",
            });
          }
          return;
        }
        if (event.type === "message_update") {
          const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (assistant?.type === "text_delta" && typeof assistant.delta === "string") {
            stdout += assistant.delta;
            options.onTextDelta?.(assistant.delta, { phase: "assistant" });
            options.onOutput?.(assistant.delta);
          }
          return;
        }
        if (event.type === "tool_execution_start") {
          const id = String(event.toolCallId || "tool");
          const name = String(event.toolName || "tool");
          const input = boundedActivityPayload(event.args);
          pendingTools.set(id, { name, input });
          options.onActivity?.({
            kind: name === "bash" ? "command" : ["read", "grep", "find", "ls"].includes(name) ? "read" : ["edit", "write"].includes(name) ? "file" : "tool",
            phase: "started",
            title: `Using ${name}`,
            tool: name,
            ...(input ? { input, codeLanguage: "json" } : {}),
          });
          return;
        }
        if (event.type === "tool_execution_end") {
          const id = String(event.toolCallId || "tool");
          const prior = pendingTools.get(id);
          const name = String(event.toolName || prior?.name || "tool");
          const output = activityText(event.result);
          const artifacts = harnessArtifactsFromToolResult(event.result, {
            provider: "pi",
            tool: name,
            title: name,
          });
          options.onActivity?.({
            kind: name === "bash" ? "command" : ["read", "grep", "find", "ls"].includes(name) ? "read" : ["edit", "write"].includes(name) ? "file" : "tool",
            phase: "completed",
            title: `Used ${name}`,
            tool: name,
            ...(prior?.input ? { input: prior.input, codeLanguage: "json" } : {}),
            ...(output ? { output } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            result: event.isError === true ? "Failed" : "Completed",
          });
          pendingTools.delete(id);
          return;
        }
        if (event.type === "compaction_start" || event.type === "auto_retry_start") {
          options.onActivity?.({
            kind: "plan",
            phase: "started",
            title: event.type === "compaction_start" ? "Compacting context" : "Retrying provider request",
            tool: String(event.type),
          });
          return;
        }
        if (event.type === "extension_error") {
          options.onActivity?.({
            kind: "tool",
            phase: "completed",
            title: "Pi extension failed",
            tool: "extension",
            result: "Failed",
            output: boundedActivityPayload({ event: event.event, error: event.error }),
            codeLanguage: "json",
          });
          return;
        }
        if (event.type === "agent_settled") {
          settled = true;
          options.onRuntimeControl?.(undefined);
          write({ id: "coode-state", type: "get_state" });
          write({ id: "coode-stats", type: "get_session_stats" });
          return;
        }
        if (event.type === "response") {
          if (typeof event.id === "string" && pendingResponses.has(event.id)) {
            const pending = pendingResponses.get(event.id)!;
            pendingResponses.delete(event.id);
            if (event.success === false) pending.reject(new Error(String(event.error || `Pi rejected ${event.command || "the request"}.`)));
            else pending.resolve(event);
            return;
          }
          if (event.id === "coode-prompt" && event.success === false) {
            finished = true;
            child.kill("SIGTERM");
            resolve({ exitCode: 1, stdout, stderr: String(event.error || "Pi rejected the prompt."), providerSessionId });
            return;
          }
          if (event.id === "coode-state") {
            const data = event.data as Record<string, unknown> | undefined;
            if (typeof data?.sessionId === "string") providerSessionId = data.sessionId;
            stateReceived = true;
          }
          if (event.id === "coode-stats") {
            statsReceived = true;
            if (event.success !== false) {
              options.onActivity?.({
                kind: "tool",
                phase: "completed",
                title: "Recorded Pi usage",
                tool: "get_session_stats",
                result: "Recorded",
                output: boundedActivityPayload(event.data),
                codeLanguage: "json",
              });
            }
          }
          if (event.id === "coode-commands" && event.success !== false) {
            const commands = (event.data as { commands?: unknown[] } | undefined)?.commands;
            options.onActivity?.({
              kind: "tool",
              phase: "completed",
              title: "Discovered Pi extensions and skills",
              tool: "get_commands",
              result: Array.isArray(commands) ? `${commands.length} available` : "Recorded",
              output: boundedActivityPayload(event.data),
              codeLanguage: "json",
            });
          }
          finishIfReady(resolve);
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        // Pi RPC specifies LF as the sole record delimiter. Do not use
        // readline: U+2028/U+2029 are legal inside JSON strings.
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "providerToCoode",
              channel: "protocol",
              payload: event,
            });
            handle(event);
          } catch {
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "providerToCoode",
              channel: "stdout",
              payload: `${line}\n`,
            });
            stderr += `Invalid Pi RPC record: ${line.slice(0, 1_024)}\n`;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: "stderr",
          payload: chunk,
        });
        stderr += chunk;
        options.onOutput?.(chunk);
      });
      child.once("error", (error) => {
        if (finished) return;
        finished = true;
        options.onRuntimeControl?.(undefined);
        for (const pending of pendingResponses.values()) pending.reject(error);
        pendingResponses.clear();
        resolve({ exitCode: 1, stdout, stderr: stderr || error.message, providerSessionId });
      });
      child.once("close", (code) => {
        if (finished) return;
        finished = true;
        options.onRuntimeControl?.(undefined);
        for (const pending of pendingResponses.values()) pending.reject(new Error("Pi RPC closed before replying."));
        pendingResponses.clear();
        resolve({
          exitCode: options.signal?.aborted ? 130 : code || 1,
          stdout,
          stderr: stderr || "Pi RPC closed before the agent settled.",
          providerSessionId,
        });
      });

      const references = existingAttachmentPaths(options.attachments);
      const prompt = references.length
        ? `${references.map((path) => `Reference: ${path}`).join("\n")}\n\n${goal}`
        : goal;
      write({
        id: "coode-prompt",
        type: "prompt",
        message: promptWithHarnessCapabilities(prompt, options, this.name),
      });
      write({ id: "coode-commands", type: "get_commands" });
      options.onRuntimeControl?.({
        harness: this.name,
        providerSessionID: providerSessionId || providerTurnID,
        providerTurnID,
        steer: async (text) => {
          if (settled || finished) throw new Error("The Pi turn already settled.");
          await request("steer", { message: text });
          return { providerTurnID };
        },
      });
    });

    const abort = () => {
      write({ id: "coode-abort", type: "abort" });
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 1_000).unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await result;
    } finally {
      options.onRuntimeControl?.(undefined);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
