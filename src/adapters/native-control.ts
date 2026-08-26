import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 96 * 1_024;

export interface NativeControlCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runNativeControlCommand(
  executable: string,
  args: string[],
  workDir: string,
  timeoutMs = 12_000,
): Promise<NativeControlCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: workDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.slice(-MAX_OUTPUT_BYTES).trim(),
        stderr: stderr.slice(-MAX_OUTPUT_BYTES).trim(),
      });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      stderr += error.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `${stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms.`;
      finish(124);
    }, timeoutMs);
    timer.unref?.();
  });
}

export function parseNativeControlJSON(value: string): unknown | undefined {
  try { return JSON.parse(value); } catch { return undefined; }
}

export function compactNativeControlText(value: unknown, maximum = 480): string | undefined {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const redacted = text
    .replace(
      /\bAuthorization(\s*:\s*)Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
      "Authorization$1Bearer [redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b(\s*[:=]\s*)["']?[^\s,}"']+/giu,
      "$1$2[redacted]",
    )
    .replace(/([?&](?:token|key|secret|signature|sig|auth)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\/(?:Users|home)\/[^/\s"']+/gu, "~");
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, maximum) : undefined;
}
