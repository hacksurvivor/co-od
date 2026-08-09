import { findProviderSessionId } from "./adapters/base.js";
import { compact, shortId, type AgentRunRecord } from "./tui-model.js";

export interface ProviderSessionAgent {
  _id: string;
  name?: string;
  provider?: string;
  execution_mode?: string;
}

export interface ProviderSessionRow {
  index: number;
  providerSessionId: string;
  runId: string;
  runStatus?: string;
  runGoal?: string;
  provider?: string;
  agentName?: string;
  createdAt?: number;
}

export interface ProviderSessionResolution {
  ok: boolean;
  row?: ProviderSessionRow;
  message: string;
}

export interface ProviderSessionRunStatus {
  runId: string;
  providerSessionId?: string;
  loaded: boolean;
  message: string;
}

export function extractProviderSessionIdFromRunRecord(run?: AgentRunRecord | null): string | undefined {
  const steps = run?.steps || [];
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const outputSession = findProviderSessionId(step.output?.payload);
    if (outputSession) return outputSession;
    const inputSession = findProviderSessionId(step.input?.payload);
    if (inputSession) return inputSession;
  }
  return findProviderSessionId((run as { result?: unknown } | null | undefined)?.result);
}

export function collectProviderSessions(input: {
  runs: AgentRunRecord[];
  agents?: ProviderSessionAgent[];
  limit?: number;
}): ProviderSessionRow[] {
  const agentsById = new Map((input.agents || []).map((agent) => [agent._id, agent]));
  const rows: ProviderSessionRow[] = [];
  const seen = new Set<string>();
  const runs = [...input.runs].sort((left, right) => (right.created_at || 0) - (left.created_at || 0));

  for (const run of runs) {
    const providerSessionId = extractProviderSessionIdFromRunRecord(run);
    if (!providerSessionId || seen.has(providerSessionId)) continue;
    seen.add(providerSessionId);
    const agent = agentsById.get(run.agent_id || "");
    rows.push({
      index: rows.length + 1,
      providerSessionId,
      runId: run._id,
      runStatus: run.status,
      runGoal: run.goal,
      provider: agent?.provider || providerFromExecutionMode(run.execution_mode || agent?.execution_mode),
      agentName: agent?.name,
      createdAt: run.created_at,
    });
    if (input.limit && rows.length >= input.limit) break;
  }

  return rows;
}

export function formatProviderSessions(rows: ProviderSessionRow[], query = "", limit = 12): string {
  const filtered = filterProviderSessions(rows, query).slice(0, limit);
  const normalized = query.trim();
  if (filtered.length === 0) {
    return normalized ? `No provider sessions matched: ${normalized}` : "No provider sessions found in loaded runs.";
  }
  const header = normalized ? `Provider sessions matching ${normalized}:` : "Provider sessions:";
  return [
    header,
    ...filtered.map((row, index) => {
      const provider = compact(row.provider, "provider");
      const agent = row.agentName ? ` ${row.agentName}` : "";
      const status = compact(row.runStatus, "unknown");
      return `${index + 1}. ${provider} ${row.providerSessionId} ${shortId(row.runId)} ${status}${agent} - ${compact(row.runGoal, "(no goal)")}`;
    }),
  ].join("\n");
}

export function resolveProviderSession(rows: ProviderSessionRow[], ref = ""): ProviderSessionResolution {
  if (rows.length === 0) {
    return { ok: false, message: "No provider sessions found in loaded runs." };
  }

  const value = ref.trim();
  if (!value || value === "latest" || value === "last") {
    const row = rows[0];
    return {
      ok: true,
      row,
      message: `Provider session ${row.index} selected: ${row.providerSessionId} from run ${shortId(row.runId)}.`,
    };
  }

  if (/^\d+$/.test(value)) {
    const row = rows[Number(value) - 1];
    return row
      ? {
          ok: true,
          row,
          message: `Provider session ${Number(value)} selected: ${row.providerSessionId} from run ${shortId(row.runId)}.`,
        }
      : { ok: false, message: `No provider session at index ${value}. Available: 1-${rows.length}.` };
  }

  const normalized = value.toLowerCase();
  const matches = rows.filter((row) => providerSessionHaystack(row).includes(normalized));
  if (matches.length === 1) {
    const row = matches[0];
    return {
      ok: true,
      row,
      message: `Provider session ${row.index} selected: ${row.providerSessionId} from run ${shortId(row.runId)}.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Provider session query matched ${matches.length} items. Use /sessions ${value} then /session <index>.`,
    };
  }
  return { ok: false, message: `No provider session matched: ${value}` };
}

export function providerSessionStatusForRun(runs: AgentRunRecord[], runId?: string): ProviderSessionRunStatus {
  const value = runId?.trim();
  if (!value) {
    return {
      runId: "",
      loaded: false,
      message: "No run selected for native provider session recovery.",
    };
  }
  const run = runs.find((candidate) => candidate._id === value);
  if (!run) {
    return {
      runId: value,
      loaded: false,
      message: `Native provider session not loaded for ${shortId(value)}; co-od will try room detail before dispatch.`,
    };
  }
  const providerSessionId = extractProviderSessionIdFromRunRecord(run);
  return providerSessionId
    ? {
        runId: run._id,
        providerSessionId,
        loaded: true,
        message: `Native provider session available for ${shortId(run._id)}: ${providerSessionId}`,
      }
    : {
        runId: run._id,
        loaded: true,
        message: `No native provider session id found in loaded steps for ${shortId(run._id)}; co-od will try room detail before dispatch.`,
      };
}

function filterProviderSessions(rows: ProviderSessionRow[], query: string): ProviderSessionRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) => providerSessionHaystack(row).includes(normalized));
}

function providerSessionHaystack(row: ProviderSessionRow): string {
  return [
    row.providerSessionId,
    row.runId,
    row.provider,
    row.agentName,
    row.runStatus,
    row.runGoal,
  ].filter(Boolean).join(" ").toLowerCase();
}

function providerFromExecutionMode(mode?: string): string | undefined {
  if (!mode) return undefined;
  if (mode.includes("opencode")) return "opencode";
  if (mode.includes("codex")) return "codex";
  if (mode.includes("claude")) return "claude";
  return undefined;
}
