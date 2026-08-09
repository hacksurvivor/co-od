import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

function which(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(":");
  return paths.some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildOpenCodeArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
): string[] {
  const args = ["run"];
  if (options.providerSession?.providerSessionId) {
    args.push("--session", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") {
      args.push("--fork");
    }
  }
  if (options.model) args.push("--model", options.model);
  for (const file of existingAttachmentPaths(options.attachments, ["file", "image"])) {
    args.push("--file", file);
  }
  args.push(goal);
  return args;
}

export class OpenCodeAdapter implements AgentAdapter {
  name = "opencode";
  capabilities = harnessCapabilities({
    sessionResume: true,
    sessionFork: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which(OPENCODE_BIN);
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const args = buildOpenCodeArgs(promptWithHarnessCapabilities(goal, options, this.name), {
      attachments: options.attachments,
      model: options.model,
      providerSession: options.providerSession,
    });

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(OPENCODE_BIN, args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["pipe", "pipe", "pipe"],
      });

      // A piped stdin reads as prompt input — close it immediately or the
      // provider waits for EOF ("reading additional input from stdin").
      child.stdin?.end();

      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => child.kill("SIGTERM"),
          { once: true },
        );
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        options.onTextDelta?.(chunk);
        options.onOutput?.(chunk);
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
          providerSessionId: resolveProviderSessionIdFromResult(
            `${stdout}\n${stderr || err.message}`,
            options.providerSession,
          ),
        });
      });

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          providerSessionId: resolveProviderSessionIdFromResult(`${stdout}\n${stderr}`, options.providerSession),
        });
      });
    });
  }
}
