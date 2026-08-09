import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
} from "./base.js";

function which(cmd: string): boolean {
  return (process.env.PATH || "").split(":").some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildGeminiArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
  }
  args.push("--output-format", "stream-json");
  const references = existingAttachmentPaths(options.attachments, ["file", "directory", "image"]);
  const prompt = references.length > 0
    ? `${references.map((path) => `@${path}`).join("\n")}\n\n${goal}`
    : goal;
  args.push("--prompt", prompt);
  return args;
}

export function parseGeminiStreamOutput(stdout: string): { text: string; providerSessionId?: string } {
  let text = "";
  let providerSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "init" && typeof event.session_id === "string") {
        providerSessionId = event.session_id;
      }
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        text += event.content;
      }
    } catch {
      // Unknown provider output is preserved as a fallback below.
    }
  }
  return {
    text: text || stdout,
    providerSessionId: providerSessionId || resolveProviderSessionIdFromResult(stdout),
  };
}

export class GeminiAdapter implements AgentAdapter {
  name = "gemini";
  capabilities = harnessCapabilities({
    sessionResume: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which("gemini");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const args = buildGeminiArgs(promptWithHarnessCapabilities(goal, options, this.name), {
      attachments: options.attachments,
      model: options.model,
      providerSession: options.providerSession,
    });

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn("gemini", args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end();

      if (options.signal) {
        options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      }

      let stdout = "";
      let stderr = "";
      let providerSessionId = options.providerSession?.mode === "continue"
        ? options.providerSession.providerSessionId
        : undefined;

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on("line", (line) => {
        stdout += `${line}\n`;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "init" && typeof event.session_id === "string") {
            providerSessionId = event.session_id;
          } else if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
            options.onTextDelta?.(event.content);
            options.onOutput?.(event.content);
          } else if (event.type === "tool_use" && typeof event.tool_name === "string") {
            const input = boundedActivityPayload(
              event.input ?? event.tool_input ?? event.arguments,
            );
            const output = boundedActivityPayload(
              event.output ?? event.tool_output ?? event.result,
            );
            options.onActivity?.({
              kind: /\b(?:browser|chrome|web)\b/i.test(event.tool_name) ? "browser" : "tool",
              phase: "completed",
              title: `Used ${event.tool_name}`,
              detail: event.tool_name,
              tool: event.tool_name,
              ...(input ? { input, codeLanguage: "json" } : {}),
              ...(output ? { output } : {}),
              result: "Completed",
            });
            options.onOutput?.(`[tool] ${event.tool_name}\n`);
          } else if (event.type === "error" && typeof event.message === "string") {
            options.onOutput?.(`[gemini] ${event.message}\n`);
          }
        } catch {
          options.onOutput?.(`${line}\n`);
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        options.onOutput?.(chunk);
      });

      child.on("error", (err) => {
        resolve({
          exitCode: 127,
          stdout,
          stderr: stderr || err.message,
          providerSessionId: resolveProviderSessionIdFromResult(`${stdout}\n${stderr || err.message}`, options.providerSession),
        });
      });

      child.on("close", (code) => {
        const parsed = parseGeminiStreamOutput(stdout);
        resolve({
          exitCode: code ?? 1,
          stdout: parsed.text,
          stderr,
          providerSessionId: parsed.providerSessionId
            || providerSessionId
            || resolveProviderSessionIdFromResult(`${stdout}\n${stderr}`, options.providerSession),
        });
      });
    });
  }
}
