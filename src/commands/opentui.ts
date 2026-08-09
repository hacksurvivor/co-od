import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OpenTuiLaunchPlan {
  ok: boolean;
  bun?: string;
  rendererPath: string;
  args: string[];
  message?: string;
}

export function findBunExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (env.BUN_INSTALL) {
    const candidate = join(env.BUN_INSTALL, "bin", "bun");
    if (exists(candidate)) return candidate;
  }

  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "bun");
    if (exists(candidate)) return candidate;
  }

  return null;
}

export function openTuiRendererPath(metaUrl = import.meta.url): string {
  return fileURLToPath(new URL("./opentui-renderer.js", metaUrl));
}

export function buildOpenTuiLaunchPlan(args: string[], input: {
  bun?: string | null;
  rendererPath?: string;
} = {}): OpenTuiLaunchPlan {
  const bun = "bun" in input ? input.bun : findBunExecutable();
  const rendererPath = input.rendererPath || openTuiRendererPath();

  if (!bun) {
    return {
      ok: false,
      rendererPath,
      args,
      message: "OpenTUI renderer requires Bun. Install Bun or run `co-od tui --renderer node` for the fallback ANSI TUI.",
    };
  }

  return {
    ok: true,
    bun,
    rendererPath,
    args,
  };
}

export async function run(args: string[]): Promise<void> {
  const plan = buildOpenTuiLaunchPlan(args);
  if (!plan.ok || !plan.bun) {
    console.error(plan.message);
    process.exitCode = 1;
    return;
  }

  const child = spawn(plan.bun, [plan.rendererPath, ...plan.args], {
    stdio: "inherit",
    env: {
      ...process.env,
      CO_OD_OPENTUI: "1",
    },
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(`[co-od opentui] ${error.message}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        console.error(`[co-od opentui] renderer exited via ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });

  process.exitCode = exitCode;
}
