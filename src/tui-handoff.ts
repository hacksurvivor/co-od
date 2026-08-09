import { getAdapter } from "./adapters/index.js";
import type { ExecuteResult } from "./adapters/base.js";
import * as api from "./api-client.js";
import type { AgentRecord } from "./tui-dashboard.js";
import { compact, shortId, type AgentRunRecord } from "./tui-model.js";
import { resolveLocalProviderForAgent } from "./tui-provider.js";

export interface HandoffResolution {
  ok: true;
  sourceRunId: string;
  targetAgentId: string;
  targetName: string;
  targetProvider?: string;
  context: string;
  goal: string;
}

export type HandoffCommandResult = HandoffResolution | { ok: false; message: string };

export interface HandoffExecutionResult {
  newRunId: string;
  status: "succeeded" | "failed" | "queued" | "running" | "cancelled";
  exitCode?: number;
  executedLocally: boolean;
}

interface HandoffDispatch {
  token?: string;
  completeUrl?: string;
  heartbeatUrl?: string;
  heartbeatIntervalMs?: number;
  goal?: string;
}

interface HandoffApiResponse {
  ok?: boolean;
  newRunId?: string;
  status?: HandoffExecutionResult["status"];
  dispatch?: HandoffDispatch;
}

export function resolveHandoffCommand(input: {
  runs: AgentRunRecord[];
  agents: AgentRecord[];
  args: string[];
  currentRunId?: string;
  lastRunId?: string;
}): HandoffCommandResult {
  if (input.args.length === 0) {
    return { ok: false, message: "Usage: /handoff [run|current|last] <agent> [context]" };
  }

  const parsed = parseHandoffArgs(input);
  if (!parsed.ok) return parsed;

  const sourceRun = findRun(input.runs, parsed.runRef);
  if (!sourceRun) {
    return { ok: false, message: `No matching source run: ${parsed.runRef}` };
  }

  const targetAgent = findAgent(input.agents, parsed.agentRef);
  if (!targetAgent) {
    return { ok: false, message: `No matching target agent: ${parsed.agentRef}` };
  }

  const sourceGoal = compact(sourceRun.goal, "(no goal)");
  const context = parsed.context || `Handoff from run ${shortId(sourceRun._id)}: ${sourceGoal}`;
  return {
    ok: true,
    sourceRunId: sourceRun._id,
    targetAgentId: targetAgent._id,
    targetName: compact(targetAgent.name, shortId(targetAgent._id)),
    targetProvider: resolveLocalProviderForAgent(targetAgent),
    context,
    goal: `Continue from run ${shortId(sourceRun._id)}: ${sourceGoal}`,
  };
}

function parseHandoffArgs(input: {
  runs: AgentRunRecord[];
  agents: AgentRecord[];
  args: string[];
  currentRunId?: string;
  lastRunId?: string;
}): { ok: true; runRef: string; agentRef: string; context: string } | { ok: false; message: string } {
  const [first, second, ...rest] = input.args;
  const normalizedFirst = first?.toLowerCase();

  if (normalizedFirst === "current") {
    if (!input.currentRunId) return { ok: false, message: "No current run is open for handoff." };
    if (!second) return { ok: false, message: "Handoff needs a target agent." };
    return { ok: true, runRef: input.currentRunId, agentRef: second, context: rest.join(" ").trim() };
  }

  if (normalizedFirst === "last") {
    if (!input.lastRunId) return { ok: false, message: "No last run is available for handoff." };
    if (!second) return { ok: false, message: "Handoff needs a target agent." };
    return { ok: true, runRef: input.lastRunId, agentRef: second, context: rest.join(" ").trim() };
  }

  if (second && findRun(input.runs, first)) {
    return { ok: true, runRef: first, agentRef: second, context: rest.join(" ").trim() };
  }

  if (input.currentRunId && findAgent(input.agents, first)) {
    return {
      ok: true,
      runRef: input.currentRunId,
      agentRef: first,
      context: [second, ...rest].filter(Boolean).join(" ").trim(),
    };
  }

  return { ok: false, message: "Usage: /handoff [run|current|last] <agent> [context]" };
}

function findRun(runs: AgentRunRecord[], ref: string): AgentRunRecord | undefined {
  const query = ref.trim();
  if (!query) return undefined;
  if (/^\d+$/.test(query)) return runs[Number(query) - 1];
  return runs.find((run) => run._id === query || run._id.endsWith(query));
}

function findAgent(agents: AgentRecord[], ref: string): AgentRecord | undefined {
  const query = ref.trim().toLowerCase();
  if (!query) return undefined;
  return agents.find((agent) => agent._id === ref || agent._id.endsWith(ref) || agent.name?.toLowerCase() === query);
}

export async function executeRoomHandoff(input: {
  roomId: string;
  sourceRunId: string;
  targetAgentId: string;
  targetProvider?: string;
  context: string;
  goal: string;
  model?: string;
  dir: string;
  onStatus?: (message: string) => void;
  onOutput?: (data: string) => void;
}): Promise<HandoffExecutionResult> {
  input.onStatus?.(`Creating handoff from run ${input.sourceRunId}...`);
  const response = await api.post<HandoffApiResponse>(
    `/api/rooms/${input.roomId}/agent-runs/${input.sourceRunId}/handoff`,
    {
      targetAgentId: input.targetAgentId,
      context: input.context,
      goal: input.goal,
    },
  );

  if (!response.newRunId) {
    throw new Error("Server did not return a handoff run id");
  }

  if (!response.dispatch) {
    return {
      newRunId: response.newRunId,
      status: response.status || "queued",
      executedLocally: false,
    };
  }

  if (!input.targetProvider) {
    throw new Error("Server returned a local handoff dispatch, but the target agent has no local CLI provider");
  }

  return executeLocalHandoffDispatch({
    ...input,
    runId: response.newRunId,
    dispatch: response.dispatch,
    provider: input.targetProvider,
  });
}

async function executeLocalHandoffDispatch(input: {
  roomId: string;
  runId: string;
  provider: string;
  dispatch: HandoffDispatch;
  goal: string;
  context: string;
  model?: string;
  dir: string;
  onStatus?: (message: string) => void;
  onOutput?: (data: string) => void;
}): Promise<HandoffExecutionResult> {
  if (!input.dispatch.token || !input.dispatch.completeUrl) {
    throw new Error("Server did not return a complete local handoff dispatch");
  }

  const adapter = getAdapter(input.provider);
  const isAvailable = await adapter.available();
  const heartbeat = startHeartbeat({
    heartbeatUrl: input.dispatch.heartbeatUrl,
    token: input.dispatch.token,
    intervalMs: input.dispatch.heartbeatIntervalMs,
  });

  let result: ExecuteResult;
  try {
    if (!isAvailable) {
      throw new Error(`'${adapter.name}' is not installed or not in PATH.`);
    }
    input.onStatus?.(`Handoff run ${input.runId} created. Executing with ${adapter.name}...`);
    result = await adapter.execute(input.dispatch.goal || input.goal, {
      workDir: input.dir,
      onOutput: input.onOutput,
      model: input.model,
      roomId: input.roomId,
      runId: input.runId,
      serverUrl: api.getBaseUrl(),
      sessionToken: api.getSessionToken() || undefined,
    });
  } catch (error) {
    result = errorToResult(error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const status = result.exitCode === 0 ? "succeeded" : "failed";
  input.onStatus?.(`Handoff run ${status} (exit ${result.exitCode})`);
  await postCompletion(input.dispatch.completeUrl, input.dispatch.token, {
    ok: result.exitCode === 0,
    run: {
      status,
      steps: [
        {
          kind: result.exitCode === 0 ? "observation" : "error",
          input: { description: `Handoff: ${input.context}` },
          output: {
            success: result.exitCode === 0,
            payload: {
              stdout: result.stdout.slice(-4096),
              stderr: result.stderr.slice(-2048),
              exitCode: result.exitCode,
            },
          },
          created_at: Date.now(),
        },
      ],
    },
  });

  return {
    newRunId: input.runId,
    status,
    exitCode: result.exitCode,
    executedLocally: true,
  };
}

const startHeartbeat = (input: {
  heartbeatUrl?: string;
  token: string;
  intervalMs?: number;
}) => {
  if (!input.heartbeatUrl) return undefined;

  const intervalMs = Math.max(5_000, Number(input.intervalMs || 15_000));
  const send = async () => {
    await fetch(input.heartbeatUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
        "x-local-bridge-token": input.token,
      },
      body: JSON.stringify({
        leaseExpiresAt: Date.now() + Math.max(30_000, intervalMs * 3),
      }),
    }).catch(() => null);
  };

  void send();
  return setInterval(() => void send(), intervalMs);
};

const postCompletion = async (completeUrl: string, token: string, payload: unknown) => {
  const res = await fetch(completeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-local-bridge-token": token,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`completion failed: ${res.status} ${res.statusText}`);
  }
};

const errorToResult = (error: unknown): ExecuteResult => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return {
    exitCode: 1,
    stdout: "",
    stderr: message,
  };
};
