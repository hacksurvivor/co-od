import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
  options: Pick<ExecuteOptions, "attachments" | "effort" | "model" | "permissionMode" | "providerSession"> = {},
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
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") args.push("--fork-session");
  }
  return args;
}

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
    sessionResume: true,
    sessionFork: true,
    attachments: true,
    modelSelection: true,
    effortSelection: true,
    permissionSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which("grok");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const args = buildGrokArgs(promptWithHarnessCapabilities(goal, options, this.name), options);
    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn("grok", args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let receivedTextDelta = false;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on("line", (line) => {
        stdout += `${line}\n`;
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          const delta = grokTextDelta(payload);
          if (delta) {
            receivedTextDelta = true;
            options.onTextDelta?.(delta);
            options.onOutput?.(delta);
          }
        } catch {
          options.onOutput?.(`${line}\n`);
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        resolve({ exitCode: 127, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        const parsed = parseGrokPrintOutput(stdout);
        if (parsed.text && !receivedTextDelta) options.onTextDelta?.(parsed.text);
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
  }
}
