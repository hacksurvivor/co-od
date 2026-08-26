import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { executeAcpAgent } from "./acp.js";
import {
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessNativeControlService,
} from "./base.js";
import {
  compactNativeControlText,
  parseNativeControlJSON,
  runNativeControlCommand,
} from "./native-control.js";

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

const hermesNativeControls: HarnessNativeControlService = {
  async snapshot(context) {
    const executable = await resolveHermesBinary();
    if (!executable) throw new Error("Hermes CLI is unavailable.");
    const [version, profiles, boards, tasks, gateway] = await Promise.all([
      runNativeControlCommand(executable, ["--version"], context.workDir),
      runNativeControlCommand(executable, ["profile", "list"], context.workDir),
      runNativeControlCommand(executable, ["kanban", "boards", "list", "--json"], context.workDir),
      runNativeControlCommand(executable, ["kanban", "list", "--json"], context.workDir),
      runNativeControlCommand(executable, ["gateway", "status"], context.workDir),
    ]);
    const profileLines = profiles.stdout.split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean).slice(0, 50);
    const boardJSON = parseNativeControlJSON(boards.stdout);
    const taskJSON = parseNativeControlJSON(tasks.stdout);
    const records = (value: unknown): Array<Record<string, unknown>> => {
      if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
      if (value && typeof value === "object") {
        for (const key of ["data", "items", "boards", "tasks"]) {
          const child = (value as Record<string, unknown>)[key];
          if (Array.isArray(child)) return records(child);
        }
      }
      return [];
    };
    const boardItems = records(boardJSON).slice(0, 30).map((board, index) => ({
      id: String(board.slug || board.id || `board-${index}`),
      title: String(board.name || board.title || board.slug || "Hermes board").slice(0, 160),
      detail: compactNativeControlText(board.description || board.status || board.path),
      status: "ready" as const,
    }));
    const taskItems = records(taskJSON).slice(0, 100).map((task, index) => {
      const status = String(task.status || "unknown");
      return {
        id: String(task.id || task.task_id || `task-${index}`),
        title: String(task.title || task.name || "Hermes task").slice(0, 160),
        detail: [task.assignee, status].filter(Boolean).map(String).join(" · "),
        status: /running/i.test(status) ? "working" as const
          : /blocked|review/i.test(status) ? "attention" as const
            : /ready|todo|done/i.test(status) ? "ready" as const : "unknown" as const,
      };
    });
    return {
      contractVersion: 1,
      harness: "hermes",
      observedAt: new Date().toISOString(),
      version: compactNativeControlText(
        (version.stdout || version.stderr).split(/\r?\n/)[0],
        120,
      ),
      groups: [
        {
          id: "profiles",
          title: "Profiles",
          items: profileLines.map((line, index) => ({
            id: `profile-${index}`,
            title: line.slice(0, 200),
            status: "ready" as const,
          })),
        },
        { id: "boards", title: "Kanban boards", items: boardItems },
        { id: "tasks", title: "Kanban tasks", items: taskItems },
        {
          id: "gateway",
          title: "Gateway",
          items: [{
            id: "gateway-status",
            title: gateway.exitCode === 0 ? "Gateway status" : "Gateway unavailable",
            detail: compactNativeControlText(gateway.stdout || gateway.stderr),
            status: gateway.exitCode === 0 ? "ready" : "attention",
          }],
        },
      ],
    };
  },
};

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
    transport: {
      kind: "acp",
      protocolVersion: 1,
      capabilityNegotiation: true,
      structuredEvents: true,
    },
    modelSelection: true,
    attachments: true,
    permissionSelection: true,
    approvalBridge: true,
    planReporting: true,
    diffReporting: true,
    subagents: true,
    backgroundExecution: true,
    usageReporting: true,
    costReporting: true,
    modelDiscovery: true,
    providerDiscovery: true,
    externalActions: true,
    browser: coodeIsolatedBrowser(),
  });
  nativeControls = hermesNativeControls;

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
    return executeAcpAgent(
      { executable, args: ["acp"], harness: this.name },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
