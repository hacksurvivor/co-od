import { getAdapter, PROVIDER_LIST } from "../adapters/index.js";
import * as api from "../api-client.js";
import type { ExecuteResult, ProviderSessionContext } from "../adapters/base.js";
import { findProviderSessionId } from "../adapters/base.js";
import type { TuiAttachmentTransport } from "../tui-attachments.js";




interface ParsedArgs {
  roomId?: string;
  goal?: string;
  provider: string;
  model?: string;
  dir: string;
  json: boolean;
  server?: string;
  continueRunId?: string;
}

interface AgentRun {
  _id: string;
  status?: string;
  steps?: Array<{
    kind?: string;
    input?: { payload?: unknown; description?: string };
    output?: { payload?: unknown };
  }>;
  result?: unknown;
}

interface CreateRunResponse {
  runId: string;
  dispatch?: {
    token?: string;
    completeUrl?: string;
    heartbeatUrl?: string;
    heartbeatIntervalMs?: number;
    goal?: string;
  };
}

interface AgentRecord {
  _id: string;
  name?: string;
  execution_mode?: string;
  provider?: string;
}

interface AgentsResponse {
  agents?: AgentRecord[];
}

interface AgentRegistration {
  agentId: string;
}

export interface RoomTaskResult {
  runId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RoomTaskDelegationInput {
  graphId: string;
  operationId: string;
  parentOperationId?: string;
  rootHumanOperationId: string;
  sourceTaskId: string;
  role: "lead" | "research" | "review" | "write" | "arbitrate";
  owningPersonId: string;
  sponsoringPersonId: string;
  runtimeRevision: number;
  state: "proposed" | "awaitingApproval" | "queued" | "running" | "reported" | "joined" | "denied" | "cancelling" | "cancelled" | "failed" | "stale";
  riskReasons: string[];
  dependencyOperationIds: string[];
  workspaceId?: string;
  writerLeaseId?: string;
  approvalId?: string;
  visibility?: "private" | "owner" | "room";
}

export interface ExecuteRoomTaskOptions {
  roomId: string;
  goal: string;
  provider: string;
  model?: string;
  dir: string;
  agentId?: string;
  attachments?: TuiAttachmentTransport[];
  continueRunId?: string;
  providerSession?: ProviderSessionContext;
  delegation?: RoomTaskDelegationInput;
  onOutput?: (data: string) => void;
  onStatus?: (message: string) => void;
}

export function buildRoomTaskCompletionPayload(input: {
  goal: string;
  continueRunId?: string;
  status: "succeeded" | "failed";
  result: ExecuteResult;
  now?: number;
}) {
  const outputPayload: Record<string, unknown> = {
    stdout: input.result.stdout.slice(-4096),
    stderr: input.result.stderr.slice(-2048),
    exitCode: input.result.exitCode,
  };
  if (input.result.providerSessionId) {
    outputPayload.providerSessionId = input.result.providerSessionId;
  }

  return {
    ok: input.result.exitCode === 0,
    run: {
      status: input.status,
      steps: [
        {
          kind: input.result.exitCode === 0 ? "observation" : "error",
          input: { description: input.continueRunId ? `Follow-up: ${input.goal}` : input.goal },
          output: {
            success: input.result.exitCode === 0,
            payload: outputPayload,
          },
          created_at: input.now ?? Date.now(),
        },
      ],
    },
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    provider: "claude",
    dir: process.cwd(),
    json: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      parsed.model = args[++i];
    } else if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (args[i] === "--json") {
      parsed.json = true;
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (args[i] === "--continue" && args[i + 1]) {
      parsed.continueRunId = args[++i];
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }

  parsed.roomId = positional[0];
  parsed.goal = positional.slice(1).join(" ");

  return parsed;
}

const executionModeForProvider = (provider: string) =>
  provider === "codex" ? "local_codex"
    : provider === "opencode" ? "local_opencode"
    : provider === "hermes" ? "local_hermes"
    : provider === "openclaw" || provider === "zeroclaw" ? "local_openclaw"
    : "local_claude_code";

const agentProviderForProvider = (provider: string) =>
  provider === "codex" ? "openai"
    : provider === "opencode" ? "opencode"
    : provider === "hermes" ? "hermes"
    : provider === "openclaw" || provider === "zeroclaw" ? "openclaw"
    : "anthropic";

const postCompletion = async (
  completeUrl: string,
  token: string,
  payload: unknown,
) => {
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

const startHeartbeat = (input: {
  heartbeatUrl?: string;
  token: string;
  intervalMs?: number;
}) => {
  if (!input.heartbeatUrl) {
    return undefined;
  }

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

const errorToResult = (error: unknown): ExecuteResult => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return {
    exitCode: 1,
    stdout: "",
    stderr: message,
  };
};

export function extractProviderSessionIdFromRun(run?: AgentRun | null): string | undefined {
  const steps = run?.steps || [];
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const outputSession = findProviderSessionId(step.output?.payload);
    if (outputSession) return outputSession;
    const inputSession = findProviderSessionId(step.input?.payload);
    if (inputSession) return inputSession;
  }
  return findProviderSessionId(run?.result);
}

// Keep the status code but strip the raw "POST <url> failed:" shape —
// otherwise downstream classifiers treat this as a generic HTTP error and
// discard the specific guidance.
export function agentCreationErrorMessage(adapterName: string, detail: string): string {
  const code = detail.match(/failed:\s*(\d{3})/)?.[1];
  const reason = detail.split(/\s+-\s+/, 2)[1]?.trim();
  return `This room can't add a ${adapterName} agent right now`
    + `${code ? ` (server error ${code})` : ""}. `
    + `${reason ? `${reason}. ` : ""}`
    + `The server may need a backend deploy, or your room role may not allow agent creation.`;
}

async function resolveProviderSessionContext(options: ExecuteRoomTaskOptions): Promise<ProviderSessionContext | undefined> {
  const base = options.providerSession || (options.continueRunId
    ? { mode: "continue" as const, sourceRunId: options.continueRunId }
    : undefined);
  if (!base || base.providerSessionId) return base;

  const sourceRun = await api.get<{ run?: AgentRun }>(
    `/api/rooms/${options.roomId}/agent-runs/${base.sourceRunId}`,
  ).catch(() => null);
  const providerSessionId = extractProviderSessionIdFromRun(sourceRun?.run);
  return providerSessionId ? { ...base, providerSessionId } : base;
}

export async function executeRoomTask(options: ExecuteRoomTaskOptions): Promise<RoomTaskResult> {
  const adapter = getAdapter(options.provider);
  const isAvailable = await adapter.available();
  if (!isAvailable) {
    throw new Error(`'${adapter.name}' is not installed or not in PATH.`);
  }

  const executionMode = executionModeForProvider(options.provider);
  const agentProvider = agentProviderForProvider(options.provider);

  const agentsResponse = await api.get<AgentsResponse>(`/api/rooms/${options.roomId}/agents`);
  let agent = options.agentId
    ? agentsResponse.agents?.find((candidate) => candidate._id === options.agentId)
    : agentsResponse.agents?.find(
        (candidate) => candidate.execution_mode === executionMode && candidate.provider === agentProvider,
      );
  if (options.agentId && !agent) {
    throw new Error(`Selected agent not found in room: ${options.agentId}`);
  }
  if (!agent) {
    try {
      const created = await api.post<AgentRegistration>(
        `/api/rooms/${options.roomId}/agents`,
        {
          name: `${adapter.name} CLI`,
          type: "builder",
          executionMode,
          provider: agentProvider,
        },
      );
      agent = { _id: created.agentId, execution_mode: executionMode, provider: agentProvider };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(agentCreationErrorMessage(adapter.name, detail));
    }
  }

  options.onStatus?.(
    options.continueRunId
      ? `Continuing run ${options.continueRunId}...`
      : `Creating run in room ${options.roomId}...`,
  );

  const createRes = await api.post<CreateRunResponse>(
    `/api/rooms/${options.roomId}/agent-runs`,
    {
      goal: options.goal,
      agentId: agent._id,
      continueRunId: options.continueRunId,
      delegation: options.delegation,
    }
  );

  const runId = createRes.runId;
  const dispatch = createRes.dispatch;
  if (!dispatch?.token || !dispatch.completeUrl) {
    throw new Error("Server did not return a local execution dispatch for this run");
  }

  options.onStatus?.(
    options.continueRunId
      ? `Run ${runId} resumed. Executing with ${adapter.name}...`
      : `Run ${runId} created. Executing with ${adapter.name}...`,
  );

  const heartbeat = startHeartbeat({
    heartbeatUrl: dispatch.heartbeatUrl,
    token: dispatch.token,
    intervalMs: dispatch.heartbeatIntervalMs,
  });

  // Execute locally — with room context for live hooks reporting
  const executionGoal = dispatch.goal || options.goal;
  const providerSession = await resolveProviderSessionContext(options);
  let result: ExecuteResult;
  try {
    result = await adapter.execute(executionGoal, {
      workDir: options.dir,
      onOutput: options.onOutput,
      attachments: options.attachments,
      model: options.model,
      roomId: options.roomId,
      runId,
      serverUrl: api.getBaseUrl(),
      sessionToken: api.getSessionToken() || undefined,
      providerSession,
    });
  } catch (error) {
    result = errorToResult(error);
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }

  const status = result.exitCode === 0 ? "succeeded" : "failed";
  options.onStatus?.(`Run ${status} (exit ${result.exitCode})`);

  try {
    await postCompletion(dispatch.completeUrl, dispatch.token, buildRoomTaskCompletionPayload({
      goal: options.goal,
      continueRunId: options.continueRunId,
      status,
      result,
    }));
  } catch {
    options.onStatus?.("Warning: failed to report completion to server");
  }

  return {
    runId,
    status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (!parsed.roomId) {
    console.error(`Usage: co-od run <room-id> <goal> [--provider ${PROVIDER_LIST}] [--model <name>] [--dir <path>] [--continue <run-id>] [--json]`);
    process.exit(1);
  }

  if (!parsed.goal) {
    console.error("Error: goal is required");
    console.error("Usage: co-od run <room-id> <goal> [--model <name>] [--continue <run-id>]");
    process.exit(1);
  }

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  const result = await executeRoomTask({
    roomId: parsed.roomId,
    goal: parsed.goal,
    provider: parsed.provider,
    model: parsed.model,
    dir: parsed.dir,
    continueRunId: parsed.continueRunId,
    onOutput: parsed.json ? undefined : (data: string) => process.stderr.write(data),
    onStatus: parsed.json ? undefined : (message: string) => console.error(`[co-od] ${message}`),
  });

  if (parsed.json) {
    console.log(
      JSON.stringify({
        runId: result.runId,
        status: result.status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    );
  }

  process.exit(result.exitCode === 0 ? 0 : 1);
}
