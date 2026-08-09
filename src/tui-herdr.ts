import { execFile as nodeExecFile } from "node:child_process";
import type { AgentRecord } from "./tui-dashboard.js";
import { compact } from "./tui-model.js";

export interface HerdrAgentLoadResult {
  available: boolean;
  agents: AgentRecord[];
  error?: string;
}

export type HerdrExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => void;

const HERDR_AGENT_LIST_COMMANDS = [
  ["agent", "list", "--json"],
  ["agent", "list"],
];

export async function loadHerdrAgents(input: {
  execFile?: HerdrExecFile;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<HerdrAgentLoadResult> {
  const env = input.env || process.env;
  if (isDisabled(env.CO_OD_TUI_HERDR) || isDisabled(env.CO_OD_TUI_ENABLE_HERDR)) {
    return { available: false, agents: [] };
  }

  const execFile = input.execFile || nodeExecFile as unknown as HerdrExecFile;
  const timeout = input.timeoutMs ?? 800;
  let lastError = "";

  for (const args of HERDR_AGENT_LIST_COMMANDS) {
    try {
      const stdout = await execHerdr(execFile, args, { timeout, env });
      const agents = parseHerdrAgentList(stdout);
      return { available: true, agents };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { available: false, agents: [], error: lastError || "herdr agent list unavailable" };
}

export function parseHerdrAgentList(text: string): AgentRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const items = extractAgentItems(parsed);
  return dedupeAgents(items.map(toHerdrAgentRecord).filter((agent): agent is AgentRecord => Boolean(agent)));
}

function execHerdr(
  execFile: HerdrExecFile,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("herdr", args, { timeout: options.timeout, windowsHide: true, env: options.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.message || String(stderr) || "herdr command failed"));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function extractAgentItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["agents", "items", "data"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function toHerdrAgentRecord(item: Record<string, unknown>, index: number): AgentRecord | null {
  const target = stringField(item, [
    "target",
    "terminal_id",
    "terminalId",
    "pane_id",
    "paneId",
    "id",
    "name",
    "label",
    "agent",
  ]);
  if (!target) return null;

  const name = stringField(item, [
    "display_agent",
    "displayAgent",
    "display_name",
    "displayName",
    "agent",
    "name",
    "label",
  ]) || `Herdr ${index + 1}`;
  const state = stringField(item, ["state", "status", "agent_state", "agentState", "custom_status", "customStatus"]);
  const summary = stringField(item, ["message", "custom_status", "customStatus", "title", "cwd", "foreground_cwd", "foregroundCwd"]);
  const safeTarget = target.replace(/[^A-Za-z0-9_.:-]+/g, "_");

  return {
    _id: `herdr:${safeTarget}`,
    name: compact(name, `Herdr ${index + 1}`),
    provider: "herdr",
    execution_mode: "external_herdr",
    external_source: "herdr",
    external_status: state,
    external_summary: summary,
    external_target: target,
    external_attach_command: `herdr agent attach ${shellQuote(target)}`,
  };
}

function stringField(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function dedupeAgents(agents: AgentRecord[]): AgentRecord[] {
  const seen = new Set<string>();
  const result: AgentRecord[] = [];
  for (const agent of agents) {
    if (seen.has(agent._id)) continue;
    seen.add(agent._id);
    result.push(agent);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDisabled(value?: string): boolean {
  return /^(0|false|no|off)$/i.test((value || "").trim());
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
