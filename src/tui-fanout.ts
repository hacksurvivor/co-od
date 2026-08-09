import type { AgentRecord } from "./tui-dashboard.js";
import { compact, shortId } from "./tui-model.js";
import { resolveLocalProviderForAgent } from "./tui-provider.js";

export interface FanoutTarget {
  agentId: string;
  name: string;
  provider: string;
}

export type FanoutResolution =
  | { ok: true; targets: FanoutTarget[]; goal: string; message: string }
  | { ok: false; message: string };

export function resolveFanoutCommand(input: {
  agents: AgentRecord[];
  args: string[];
  providerAvailability?: Record<string, boolean>;
}): FanoutResolution {
  const [targetSpec, ...promptParts] = input.args;
  if (!targetSpec) {
    return { ok: false, message: "Usage: /fanout <all|agent[,agent...]> <prompt>" };
  }

  const goal = promptParts.join(" ").trim();
  if (!goal) {
    return { ok: false, message: "Fan-out needs a prompt after the agent target." };
  }

  const refs = targetSpec.toLowerCase() === "all"
    ? input.agents.map((agent) => agent._id)
    : targetSpec.split(",").map((ref) => ref.trim()).filter(Boolean);

  const targets: FanoutTarget[] = [];
  const skipped: string[] = [];
  for (const ref of refs) {
    const agent = findAgent(input.agents, ref);
    if (!agent) {
      skipped.push(`${ref}: not found`);
      continue;
    }
    const provider = resolveLocalProviderForAgent(agent);
    if (!provider) {
      skipped.push(`${compact(agent.name, shortId(agent._id))}: not local`);
      continue;
    }
    if (input.providerAvailability && input.providerAvailability[provider] === false) {
      skipped.push(`${compact(agent.name, shortId(agent._id))}: ${provider} not found`);
      continue;
    }
    if (!targets.some((target) => target.agentId === agent._id)) {
      targets.push({
        agentId: agent._id,
        name: compact(agent.name, shortId(agent._id)),
        provider,
      });
    }
  }

  if (targets.length === 0) {
    const detail = skipped.length > 0 ? ` ${skipped.join("; ")}.` : "";
    return { ok: false, message: `No local CLI agents are available for fan-out.${detail}` };
  }

  const suffix = skipped.length > 0 ? ` Skipped ${skipped.join("; ")}.` : "";
  return {
    ok: true,
    targets,
    goal,
    message: `Fan-out ready for ${targets.length} agent${targets.length === 1 ? "" : "s"}.${suffix}`,
  };
}

function findAgent(agents: AgentRecord[], ref: string): AgentRecord | undefined {
  const query = ref.trim().toLowerCase();
  return agents.find((agent) => {
    const name = agent.name?.toLowerCase();
    return agent._id === ref || agent._id.endsWith(ref) || name === query;
  });
}
