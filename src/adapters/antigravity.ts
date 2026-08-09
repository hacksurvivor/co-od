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

function which(cmd: string): boolean {
  return (process.env.PATH || "").split(":").some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildAntigravityArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
): string[] {
  const args = ["--sandbox", "--mode", "accept-edits"];
  if (options.model) args.push("--model", options.model);
  if (options.providerSession?.providerSessionId) {
    args.push("--conversation", options.providerSession.providerSessionId);
  }
  const references = existingAttachmentPaths(options.attachments, ["file", "directory", "image"]);
  const prompt = references.length > 0
    ? `${references.map((path) => `@${path}`).join("\n")}\n\n${goal}`
    : goal;
  args.push("--print", prompt);
  return args;
}

export class AntigravityAdapter implements AgentAdapter {
  name = "antigravity";
  capabilities = harnessCapabilities({
    sessionResume: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which("agy");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const args = buildAntigravityArgs(
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn("agy", args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (options.signal) {
        options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
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
      child.on("error", (error) => {
        const failure = stderr || error.message;
        resolve({
          exitCode: 127,
          stdout,
          stderr: failure,
          providerSessionId: resolveProviderSessionIdFromResult(`${stdout}\n${failure}`, options.providerSession),
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
