import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { executeAcpAgent } from "./acp.js";
import {
  existingAttachmentPaths,
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

function which(command: string): boolean {
  return (process.env.PATH || "").split(":").some((directory) => existsSync(`${directory}/${command}`));
}

export function buildGrokArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "bestOfN" | "effort" | "model" | "permissionMode" | "providerSession" | "selfCheck"> = {},
): string[] {
  const references = existingAttachmentPaths(options.attachments);
  const prompt = references.length > 0
    ? `${references.map((path) => `Reference: ${path}`).join("\n")}\n\n${goal}`
    : goal;
  const permissionMode = {
    ask: "default",
    approve: "acceptEdits",
    fullAccess: "bypassPermissions",
    plan: "plan",
    custom: "default",
  }[options.permissionMode || "approve"];
  const args = [
    "--single",
    prompt,
    "--output-format",
    "streaming-json",
    "--permission-mode",
    permissionMode,
    "--no-subagents",
    "--no-memory",
    "--disable-web-search",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--reasoning-effort", options.effort);
  if (Number.isInteger(options.bestOfN) && Number(options.bestOfN) > 1) {
    args.push("--best-of-n", String(Math.min(8, Number(options.bestOfN))));
  }
  if (options.selfCheck) args.push("--check");
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") args.push("--fork-session");
  }
  return args;
}

const executeGrokHeadless = async (goal: string, options: ExecuteOptions): Promise<ExecuteResult> => {
  if (["ask", "custom"].includes(options.permissionMode || "ask")) {
    return {
      exitCode: 78,
      stdout: "",
      stderr: "Grok best-of-N and check run headlessly. Choose Plan, Approve safe edits, or Full access explicitly before using them.",
    };
  }
  return await new Promise<ExecuteResult>((resolve) => {
    const args = buildGrokArgs(goal, options);
    void options.onRawEvent?.({
      observedAt: new Date().toISOString(),
      direction: "coodeToProvider",
      channel: "protocol",
      payload: { command: "grok", args },
    });
    const child = spawn("grok", args, {
      cwd: options.workDir,
      env: providerProcessEnvironment({ ...options, provider: "grok" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let streamed = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          void options.onRawEvent?.({
            observedAt: new Date().toISOString(),
            direction: "providerToCoode",
            channel: "protocol",
            payload,
          });
          const delta = grokTextDelta(payload);
          if (delta) {
            streamed += delta;
            options.onTextDelta?.(delta, { phase: "assistant" });
            options.onOutput?.(delta);
          }
        } catch {
          void options.onRawEvent?.({
            observedAt: new Date().toISOString(),
            direction: "providerToCoode",
            channel: "stdout",
            payload: `${line}\n`,
          });
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "stderr",
        payload: chunk,
      });
      options.onOutput?.(chunk);
    });
    child.once("error", (error) => resolve({ exitCode: 127, stdout: streamed, stderr: stderr || error.message }));
    child.once("close", (code) => {
      const parsed = parseGrokPrintOutput(stdout);
      if (!streamed && parsed.text) options.onTextDelta?.(parsed.text, { phase: "assistant" });
      resolve({
        exitCode: code ?? 1,
        stdout: parsed.text,
        stderr,
        providerSessionId: parsed.providerSessionId
          || resolveProviderSessionIdFromResult(`${stdout}\n${stderr}`, options.providerSession),
      });
    });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  });
};

export function grokTextDelta(payload: Record<string, unknown>): string | undefined {
  const type = String(payload.type || "").toLowerCase();
  const delta = payload.delta && typeof payload.delta === "object"
    ? payload.delta as Record<string, unknown>
    : undefined;
  if (type.includes("delta")) {
    if (typeof payload.delta === "string") return payload.delta;
    if (typeof delta?.text === "string") return delta.text;
    if (typeof delta?.content === "string") return delta.content;
    if (typeof payload.text === "string") return payload.text;
  }
  return undefined;
}

export function parseGrokPrintOutput(stdout: string): { text: string; providerSessionId?: string } {
  const fallback = stdout.trim();
  let streamedText = "";
  let finalText = "";
  let providerSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      streamedText += grokTextDelta(payload) || "";
      const type = String(payload.type || "").toLowerCase();
      if ((type === "result" || type === "final") && typeof payload.text === "string") {
        finalText = payload.text;
      } else if ((type === "result" || type === "final") && typeof payload.result === "string") {
        finalText = payload.result;
      } else if (!payload.type && typeof payload.text === "string") {
        finalText = payload.text;
      }
      providerSessionId = typeof payload.sessionId === "string"
        ? payload.sessionId
        : typeof payload.session_id === "string" ? payload.session_id : providerSessionId;
    } catch {
      // Preserve unknown output only if no structured response was found.
    }
  }
  return {
    text: finalText || streamedText || fallback,
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

export class GrokAdapter implements AgentAdapter {
  name = "grok";
  capabilities = harnessCapabilities({
    transport: {
      kind: "acp",
      protocolVersion: 1,
      capabilityNegotiation: true,
      structuredEvents: true,
    },
    sessionResume: true,
    sessionFork: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    permissionSelection: true,
    sessionLoad: true,
    sessionList: true,
    sessionDelete: true,
    approvalBridge: true,
    planReporting: true,
    nativeReview: true,
    diffReporting: true,
    subagents: true,
    backgroundExecution: true,
    usageReporting: true,
    costReporting: true,
    modelDiscovery: true,
    providerDiscovery: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which("grok");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    if ((options.bestOfN || 1) > 1 || options.selfCheck === true) {
      return executeGrokHeadless(
        promptWithHarnessCapabilities(goal, options, this.name),
        options,
      );
    }
    return executeAcpAgent(
      { executable: "grok", args: ["agent", "stdio"], harness: this.name },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
