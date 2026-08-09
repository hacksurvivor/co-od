import { spawn } from "node:child_process";
import {
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

/**
 * OpenClaw / ZeroClaw adapter.
 *
 * Supports both the legacy `openclaw` CLI and the newer `zeroclaw` CLI.
 * Sends tasks via `zeroclaw agent -m <goal>` (non-interactive single-shot mode).
 * Reports tool calls and file changes as agent steps when room context is available.
 */

const ZEROCLAW_BIN = process.env.ZEROCLAW_BIN || "zeroclaw";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

async function findBinary(): Promise<{ bin: string; variant: "zeroclaw" | "openclaw" } | null> {
  for (const [bin, variant] of [
    [ZEROCLAW_BIN, "zeroclaw"],
    [OPENCLAW_BIN, "openclaw"],
  ] as const) {
    try {
      const child = spawn("sh", ["-lc", `command -v ${bin}`], { stdio: "pipe" });
      const ok = await new Promise<boolean>((resolve) => {
        child.on("close", (code) => resolve(code === 0));
        child.on("error", () => resolve(false));
      });
      if (ok) return { bin, variant };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Report a step to the co-ode room.
 */
async function reportStep(
  config: { roomId: string; runId: string; serverUrl: string; sessionToken: string },
  kind: string,
  description: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
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
          kind,
          input: { description, payload },
          output: { success: true, payload },
        }),
      },
    );
  } catch {
    // Non-fatal
  }
}

/**
 * Parse openclaw/zeroclaw output lines for tool calls and file changes.
 * ZeroClaw outputs structured markers like:
 *   [TOOL] tool_name: description
 *   [FILE] path/to/file
 *   [EXEC] command
 *   [DONE] summary
 */
function parseOutputLine(
  line: string,
): { kind: string; description: string; payload: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("[TOOL]")) {
    return { kind: "tool_call", description: trimmed.slice(6).trim(), payload: {} };
  }
  if (trimmed.startsWith("[FILE]")) {
    const path = trimmed.slice(6).trim();
    return { kind: "tool_call", description: `write ${path}`, payload: { path } };
  }
  if (trimmed.startsWith("[EXEC]")) {
    const cmd = trimmed.slice(6).trim();
    return { kind: "tool_call", description: cmd, payload: { command: cmd } };
  }
  if (trimmed.startsWith("[DONE]")) {
    return { kind: "observation", description: trimmed.slice(6).trim(), payload: {} };
  }
  // Also detect common patterns from unstructured output
  if (trimmed.match(/^(reading|writing|creating|editing|modifying)\s/i)) {
    return { kind: "tool_call", description: trimmed.slice(0, 100), payload: {} };
  }
  if (trimmed.match(/^\$\s+/)) {
    const cmd = trimmed.slice(2).trim();
    return { kind: "tool_call", description: cmd, payload: { command: cmd } };
  }
  return null;
}

export class OpenClawAdapter implements AgentAdapter {
  name = "openclaw";
  capabilities = harnessCapabilities({ browser: coodeIsolatedBrowser() });

  async available(): Promise<boolean> {
    const found = await findBinary();
    return found !== null;
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const found = await findBinary();
    if (!found) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "Neither zeroclaw nor openclaw CLI found on PATH. Install: brew install zeroclaw",
      };
    }

    const { bin } = found;
    const hasRoomContext = Boolean(
      options.roomId && options.runId && options.serverUrl && options.sessionToken,
    );
    const reportConfig = hasRoomContext
      ? {
          roomId: options.roomId!,
          runId: options.runId!,
          serverUrl: options.serverUrl!,
          sessionToken: options.sessionToken!,
        }
      : null;

    // zeroclaw agent -m "goal" — single-shot non-interactive mode
    const args = ["agent", "-m", promptWithHarnessCapabilities(goal, options, this.name)];

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(bin, args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end();

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
        }, { once: true });
      }

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        options.onTextDelta?.(chunk);
        options.onOutput?.(chunk);

        // Parse lines for step reporting
        if (reportConfig) {
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";
          for (const line of lines) {
            const parsed = parseOutputLine(line);
            if (parsed) {
              void reportStep(reportConfig, parsed.kind, parsed.description, parsed.payload);
            }
          }
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
        });
      });

      child.on("close", (code) => {
        // Flush remaining line buffer
        if (reportConfig && lineBuffer.trim()) {
          const parsed = parseOutputLine(lineBuffer);
          if (parsed) {
            void reportStep(reportConfig, parsed.kind, parsed.description, parsed.payload);
          }
        }
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}
