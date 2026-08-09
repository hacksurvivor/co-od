import { spawn } from "node:child_process";
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
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";
import type {
  HarnessUsageLimits,
  HarnessUsageWindow,
} from "./codex-app-server.js";
import { generateHooksDir, cleanupHooksDir } from "../hooks-generator.js";

function which(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(":");
  return paths.some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildClaudeArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "effort" | "model" | "permissionMode" | "providerSession"> & { extraAddDirs?: string[]; providerNativeBrowser?: boolean } = {},
): string[] {
  const permissionMode = {
    ask: "default",
    approve: "acceptEdits",
    fullAccess: "bypassPermissions",
    plan: "plan",
    custom: "default",
  }[options.permissionMode || "approve"];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    permissionMode,
    // Native Chrome is enabled only after the room supervisor supplies a
    // fresh parity proof. The ordinary room path remains explicitly isolated.
    options.providerNativeBrowser ? "--chrome" : "--no-chrome",
    "--disallowedTools",
    "WebFetch,WebSearch",
  ];
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
  args.push("--", goal);
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

export function parseClaudePrintOutput(stdout: string): { text: string; providerSessionId?: string } {
  let streamedText = "";
  let finalText = "";
  let providerSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
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
      // Preserve unknown output only if no structured response was found.
    }
  }
  return {
    text: finalText || streamedText || stdout,
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";
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
    return which("claude");
  }

  async execute(
    goal: string,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    const { workDir, onOutput, signal } = options;

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
    const args = buildClaudeArgs(promptWithHarnessCapabilities(goal, options, this.name), {
      attachments: options.attachments,
      effort: options.effort,
      model: options.model,
      permissionMode: options.permissionMode,
      providerSession: options.providerSession,
      extraAddDirs,
      providerNativeBrowser: browserModeForExecution(this.name, options.browserAccess, options.browserProviderParity) === "providerNative",
    });

    return new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let receivedTextDelta = false;

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on("line", (line) => {
        stdout += `${line}\n`;
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          recordClaudeRateLimitEvent(payload);
          const delta = claudeTextDelta(payload);
          if (delta) {
            receivedTextDelta = true;
            options.onTextDelta?.(delta);
            onOutput?.(delta);
          } else if (payload.type === "tool_use" && typeof payload.tool_name === "string") {
            const input = boundedActivityPayload(
              payload.input ?? payload.tool_input ?? payload.arguments,
            );
            const output = boundedActivityPayload(
              payload.output ?? payload.tool_output ?? payload.result,
            );
            options.onActivity?.({
              kind: /\b(?:browser|chrome|web)\b/i.test(payload.tool_name) ? "browser" : "tool",
              phase: "completed",
              title: `Used ${payload.tool_name}`,
              detail: payload.tool_name,
              tool: payload.tool_name,
              ...(input ? { input, codeLanguage: "json" } : {}),
              ...(output ? { output } : {}),
              result: "Completed",
            });
          }
        } catch {
          onOutput?.(`${line}\n`);
        }
      });

      child.stderr?.on("data", (chunk: string) => {
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
  }
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
