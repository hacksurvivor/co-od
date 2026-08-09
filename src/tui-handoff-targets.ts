import type { AgentRecord } from "./tui-dashboard.js";
import { compact, shortId } from "./tui-model.js";

export function handoffTargetLabel(agent: AgentRecord): string {
  return compact(agent.name, shortId(agent._id));
}

export function handoffTargetRef(agent: AgentRecord): string {
  return agent._id;
}

export function cycleHandoffTarget(
  agents: AgentRecord[],
  currentAgentId: string | undefined,
  direction: -1 | 1,
): AgentRecord | undefined {
  if (agents.length === 0) return undefined;
  const currentIndex = currentAgentId
    ? agents.findIndex((agent) => agent._id === currentAgentId)
    : -1;
  const nextIndex = currentIndex === -1
    ? direction === 1 ? 0 : agents.length - 1
    : (currentIndex + direction + agents.length) % agents.length;
  return agents[nextIndex];
}

export function resolveHandoffTarget(
  agents: AgentRecord[],
  query: string,
): { ok: true; agent: AgentRecord; message: string } | { ok: false; message: string } {
  const requested = query.trim();
  if (agents.length === 0) {
    return { ok: false, message: "No agents loaded for handoff target selection." };
  }
  if (!requested) {
    return {
      ok: false,
      message: `Usage: /handoff-target <agent|index>. Loaded targets: ${handoffTargetList(agents)}.`,
    };
  }

  const byIndex = requested.match(/^\d+$/)
    ? agents[Number(requested) - 1]
    : undefined;
  if (byIndex) {
    return { ok: true, agent: byIndex, message: `Handoff target: ${handoffTargetLabel(byIndex)}` };
  }

  const normalized = requested.toLowerCase();
  const exact = agents.find((agent) =>
    agent._id === requested ||
    agent._id.endsWith(requested) ||
    (agent.name || "").toLowerCase() === normalized
  );
  if (exact) {
    return { ok: true, agent: exact, message: `Handoff target: ${handoffTargetLabel(exact)}` };
  }

  const matches = agents.filter((agent) =>
    `${agent._id} ${agent.name || ""} ${agent.provider || ""}`.toLowerCase().includes(normalized)
  );
  if (matches.length === 1) {
    return { ok: true, agent: matches[0], message: `Handoff target: ${handoffTargetLabel(matches[0])}` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Handoff target is ambiguous: ${matches.map((agent) => `${handoffTargetLabel(agent)} (${shortId(agent._id)})`).join(", ")}.`,
    };
  }

  return { ok: false, message: `Handoff target not found: ${requested}.` };
}

export function formatHandoffPrefill(agent?: AgentRecord, runRef = "current"): string {
  return agent
    ? `/handoff ${runRef} ${handoffTargetRef(agent)} `
    : `/handoff ${runRef} `;
}

export function handoffTargetSummary(
  agents: AgentRecord[],
  currentAgentId: string | undefined,
): string {
  if (agents.length === 0) return "no agents loaded";
  const agent = currentAgentId
    ? agents.find((candidate) => candidate._id === currentAgentId)
    : undefined;
  return agent
    ? `${handoffTargetLabel(agent)} (${shortId(agent._id)})`
    : "none selected";
}

function handoffTargetList(agents: AgentRecord[]): string {
  return agents
    .map((agent, index) => `${index + 1}. ${handoffTargetLabel(agent)} (${shortId(agent._id)})`)
    .join(", ");
}
