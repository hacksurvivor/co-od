import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

const HERMES_BIN = process.env.HERMES_BIN || "hermes";

async function resolveHermesBinary(): Promise<string | null> {
  if (HERMES_BIN.includes("/")) return existsSync(HERMES_BIN) ? HERMES_BIN : null;
  if (!/^[A-Za-z0-9._+-]+$/.test(HERMES_BIN)) return null;
  const direct = (process.env.PATH || "")
    .split(":")
    .find((directory) => existsSync(`${directory}/${HERMES_BIN}`));
  if (direct) return `${direct}/${HERMES_BIN}`;

  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lic", `command -v -- ${HERMES_BIN}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const path = output.trim().split(/\r?\n/)[0];
      resolve(code === 0 && path ? path : null);
    });
  });
}

export function buildHermesArgs(
  goal: string,
  options: Pick<ExecuteOptions, "model"> = {},
): string[] {
  const args = ["-z", goal];
  if (options.model) args.push("--model", options.model);
  return args;
}

export class HermesAdapter implements AgentAdapter {
  name = "hermes";
  capabilities = harnessCapabilities({
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return Boolean(await resolveHermesBinary());
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const executable = await resolveHermesBinary();
    if (!executable) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "Hermes CLI was not found in the login shell. Install Hermes Agent, then reopen co·ode.",
      };
    }
    const prompt = promptWithHarnessCapabilities(goal, options, this.name);
    const args = buildHermesArgs(prompt, options);

    return new Promise<ExecuteResult>((resolve) => {
      const child = spawn(executable, args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
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
        resolve({ exitCode: 127, stdout, stderr: stderr || error.message });
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
  }
}
