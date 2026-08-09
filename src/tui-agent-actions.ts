import type { AgentRecord } from "./tui-dashboard.js";
import { compact, shortId, type AgentRunRecord } from "./tui-model.js";
import { resolveLocalProviderForAgent } from "./tui-provider.js";

export interface AgentStartResolution {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  provider?: string;
  goal?: string;
  message: string;
}

export interface AgentStopResolution {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  runIds: string[];
  message: string;
}

export interface AgentPauseResolution {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  runIds: string[];
  message: string;
}

export interface AgentResumeResolution {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  runIds: string[];
  message: string;
}

export function resolveAgentStartCommand(input: {
  agents: AgentRecord[];
  args: string[];
  providerAvailability?: Record<string, boolean>;
}): AgentStartResolution {
  const [agentRef, ...goalParts] = input.args;
  if (!agentRef || goalParts.length === 0) {
    return { ok: false, message: "Usage: /agent-start <agent> <prompt>" };
  }

  const agent = findAgent(input.agents, agentRef);
  if (!agent) {
    return { ok: false, message: `No matching agent: ${agentRef}` };
  }

  const agentName = compact(agent.name, shortId(agent._id));
  const provider = resolveLocalProviderForAgent(agent);
  if (!provider) {
    const mode = compact(agent.execution_mode, "hosted_api");
    return {
      ok: false,
      agentId: agent._id,
      agentName,
      message: `${agentName} cannot be started from this TUI because ${mode} has no local CLI dispatch path.`,
    };
  }

  if (input.providerAvailability && input.providerAvailability[provider] === false) {
    return {
      ok: false,
      agentId: agent._id,
      agentName,
      provider,
      message: `${agentName} cannot be started because ${provider} is not available on PATH.`,
    };
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    return { ok: false, agentId: agent._id, agentName, provider, message: `Add a prompt after /agent-start ${agentName}.` };
  }

  return {
    ok: true,
    agentId: agent._id,
    agentName,
    provider,
    goal,
    message: `Starting ${agentName} with ${provider}: ${goal}`,
  };
}

export function resolveAgentStopCommand(input: {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  args: string[];
}): AgentStopResolution {
  const [agentRef] = input.args;
  if (!agentRef) {
    return { ok: false, runIds: [], message: "Usage: /agent-stop <agent>" };
  }

  const agent = findAgent(input.agents, agentRef);
  if (!agent) {
    return { ok: false, runIds: [], message: `No matching agent: ${agentRef}` };
  }

  const runIds = input.runs
    .filter((run) => run.agent_id === agent._id && (run.status === "queued" || run.status === "running"))
    .sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
    .map((run) => run._id);
  const agentName = compact(agent.name, shortId(agent._id));

  if (runIds.length === 0) {
    return {
      ok: false,
      agentId: agent._id,
      agentName,
      runIds,
      message: `${agentName} has no queued or running tasks to stop.`,
    };
  }

  return {
    ok: true,
    agentId: agent._id,
    agentName,
    runIds,
    message: `Stopping ${runIds.length} active task${runIds.length === 1 ? "" : "s"} for ${agentName}.`,
  };
}

export function resolveAgentPauseCommand(input: {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  args: string[];
}): AgentPauseResolution {
  const [agentRef] = input.args;
  if (!agentRef) {
    return { ok: false, runIds: [], message: "Usage: /agent-pause <agent>" };
  }

  const agent = findAgent(input.agents, agentRef);
  if (!agent) {
    return { ok: false, runIds: [], message: `No matching agent: ${agentRef}` };
  }
  const agentName = compact(agent.name, shortId(agent._id));
  const runIds = input.runs
    .filter((run) => run.agent_id === agent._id && (run.status === "queued" || run.status === "running") && isPauseSupported(run.execution_mode || agent.execution_mode))
    .sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
    .map((run) => run._id);
  if (runIds.length === 0) {
    return {
      ok: false,
      agentId: agent._id,
      agentName,
      runIds,
      message: `${agentName} has no queued or running local bridge tasks to pause.`,
    };
  }

  return {
    ok: true,
    agentId: agent._id,
    agentName,
    runIds,
    message: `Pausing ${runIds.length} active task${runIds.length === 1 ? "" : "s"} for ${agentName}.`,
  };
}

export function resolveAgentResumeCommand(input: {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  args: string[];
}): AgentResumeResolution {
  const [agentRef] = input.args;
  if (!agentRef) {
    return { ok: false, runIds: [], message: "Usage: /agent-resume <agent>" };
  }

  const agent = findAgent(input.agents, agentRef);
  if (!agent) {
    return { ok: false, runIds: [], message: `No matching agent: ${agentRef}` };
  }
  const agentName = compact(agent.name, shortId(agent._id));
  const runIds = input.runs
    .filter((run) => run.agent_id === agent._id && run.status === "paused" && isPauseSupported(run.execution_mode || agent.execution_mode))
    .sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
    .map((run) => run._id);
  if (runIds.length === 0) {
    return {
      ok: false,
      agentId: agent._id,
      agentName,
      runIds,
      message: `${agentName} has no paused local bridge runs to resume.`,
    };
  }

  return {
    ok: true,
    agentId: agent._id,
    agentName,
    runIds,
    message: `Resuming ${runIds.length} paused run${runIds.length === 1 ? "" : "s"} for ${agentName}.`,
  };
}

function isPauseSupported(executionMode?: string): boolean {
  return executionMode === "local_codex"
    || executionMode === "local_claude_code"
    || executionMode === "local_cli"
    || executionMode === "local_opencode"
    || executionMode === "local_hermes"
    || executionMode === "local_openclaw"
    || executionMode === "local_sandcastle";
}

export function findAgent(agents: AgentRecord[], ref: string): AgentRecord | undefined {
  const query = ref.trim().toLowerCase();
  if (!query) return undefined;
  return agents.find((agent, index) => {
    const name = agent.name?.toLowerCase();
    return agent._id === ref
      || agent._id.endsWith(ref)
      || name === query
      || String(index + 1) === ref;
  });
}
