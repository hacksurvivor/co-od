import type { AgentRecord } from "./tui-dashboard.js";
import { compact, shortId, type AgentRunRecord } from "./tui-model.js";
import { resolveLocalProviderForAgent } from "./tui-provider.js";

export type AgentActivityState = "running" | "queued" | "blocked" | "failed" | "succeeded" | "cancelled" | "idle";
export type AgentSemanticState = "working" | "queued" | "blocked" | "review" | "failed" | "idle";
export type AgentAvailability = "available" | "hosted" | "missing" | "remote" | "external" | "unsupported" | "unknown";

export interface AgentActivityRow {
  agentId: string;
  name: string;
  provider: string;
  executionMode: string;
  localProvider?: string;
  availability: AgentAvailability;
  availabilityReason?: string;
  state: AgentActivityState;
  semanticState: AgentSemanticState;
  runId?: string;
  goal?: string;
  heartbeatAgeMs?: number;
  elapsedMs?: number;
  tokenEstimate?: number;
}

const ACTIVE_STATUSES = new Set(["running", "queued", "in_progress"]);

export function buildAgentActivityRows(input: {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  providerAvailability?: Record<string, boolean>;
  now?: number;
}): AgentActivityRow[] {
  const now = input.now ?? Date.now();
  return input.agents.map((agent) => {
    const runs = input.runs
      .filter((run) => run.agent_id === agent._id)
      .sort((left, right) => (right.created_at || 0) - (left.created_at || 0));
    const currentRun = runs.find((run) => ACTIVE_STATUSES.has(run.status || ""));
    const latestRun = currentRun || runs[0];
    const startedAt = latestRun?.started_at || latestRun?.created_at;
    const finishedAt = latestRun?.finished_at;
    const executionMode = compact(agent.execution_mode, "hosted_api");
    const localProvider = executionMode === "remote_cli" ? undefined : resolveLocalProviderForAgent(agent);
    const availability = resolveAgentAvailabilityDetail(agent, localProvider, input.providerAvailability);
    const state = normalizeAgentState(latestRun?.status || agent.external_status);

    return {
      agentId: agent._id,
      name: compact(agent.name, shortId(agent._id)),
      provider: compact(agent.provider),
      executionMode,
      localProvider,
      availability: availability.availability,
      availabilityReason: availability.reason,
      state,
      semanticState: normalizeAgentSemanticState(state, latestRun?.status || agent.external_status),
      runId: latestRun?._id,
      goal: latestRun?.goal || agent.external_summary,
      heartbeatAgeMs: latestRun?.heartbeat_at ? Math.max(0, now - latestRun.heartbeat_at) : undefined,
      elapsedMs: startedAt ? Math.max(0, (finishedAt || now) - startedAt) : undefined,
      tokenEstimate: latestRun?.token_estimate,
    };
  });
}

export function resolveAgentAvailability(
  localProvider?: string,
  providerAvailability?: Record<string, boolean>,
): AgentAvailability {
  if (!localProvider) return "hosted";
  if (!providerAvailability || !(localProvider in providerAvailability)) return "unknown";
  return providerAvailability[localProvider] ? "available" : "missing";
}

export function resolveAgentAvailabilityDetail(
  agent: { provider?: string; execution_mode?: string; has_api_key?: boolean },
  localProvider?: string,
  providerAvailability?: Record<string, boolean>,
): { availability: AgentAvailability; reason?: string } {
  const executionMode = agent.execution_mode || "hosted_api";
  const provider = agent.provider || "";

  if (executionMode === "external_herdr" || provider === "herdr") {
    return {
      availability: "external",
      reason: "Herdr pane; attach with herdr agent attach",
    };
  }

  if (executionMode === "remote_cli") {
    return { availability: "remote", reason: "remote CLI dispatch" };
  }

  if (localProvider) {
    if (!providerAvailability || !(localProvider in providerAvailability)) {
      return { availability: "unknown", reason: `waiting for ${localProvider} CLI probe` };
    }
    if (providerAvailability[localProvider]) {
      return { availability: "available" };
    }
    return { availability: "missing", reason: `${providerCommandHint(localProvider)} not found on PATH` };
  }

  if (executionMode.startsWith("local_")) {
    return { availability: "unsupported", reason: `${executionMode} has no TUI CLI adapter` };
  }

  if (executionMode === "hosted_api" && agent.has_api_key === false && provider && provider !== "runtime") {
    return { availability: "hosted", reason: "no stored agent key; server env may be required" };
  }

  return { availability: "hosted" };
}

export function normalizeAgentState(status?: string): AgentActivityState {
  const normalized = (status || "").toLowerCase();
  if (normalized === "running" || normalized === "working" || normalized === "in_progress") return "running";
  if (status === "queued") return "queued";
  if (normalized === "blocked" || normalized === "needs_attention" || normalized === "input_required") return "blocked";
  if (status === "failed") return "failed";
  if (normalized === "succeeded" || normalized === "completed" || normalized === "done") return "succeeded";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "idle";
}

export function normalizeAgentSemanticState(state: AgentActivityState, rawStatus?: string): AgentSemanticState {
  const normalized = (rawStatus || "").toLowerCase();
  if (state === "running") return "working";
  if (state === "queued") return "queued";
  if (state === "blocked") return "blocked";
  if (state === "failed" || state === "cancelled") return "failed";
  if (state === "succeeded" || normalized === "done") return "review";
  return "idle";
}

function providerCommandHint(provider: string): string {
  if (provider === "openclaw") return "zeroclaw/openclaw";
  return provider;
}
