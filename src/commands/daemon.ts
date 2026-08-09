import { getAdapter, PROVIDER_LIST } from "../adapters/index.js";
import * as api from "../api-client.js";
import type { ExecuteResult } from "../adapters/base.js";




interface ParsedArgs {
  roomId?: string;
  as?: string;
  role?: string;
  provider: string;
  watch: string[];
  autoExecute: boolean;
  instructions?: string;
  maxConcurrent: number;
  dir: string;
  server?: string;
  handoffTo?: string; // agent name or ID to hand off to after completion
}

interface RoomEvent {
  _id: string;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: number;
}

interface EventsResponse {
  events: RoomEvent[];
  cursor?: string;
}

interface AgentRegistration {
  agentId: string;
}

interface CreateRunResponse {
  runId: string;
  dispatch?: {
    token?: string;
    completeUrl?: string;
    heartbeatUrl?: string;
    heartbeatIntervalMs?: number;
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    provider: "claude",
    watch: [],
    autoExecute: false,
    maxConcurrent: 1,
    dir: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--as" && args[i + 1]) {
      parsed.as = args[++i];
    } else if (args[i] === "--role" && args[i + 1]) {
      parsed.role = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
    } else if (args[i] === "--watch" && args[i + 1]) {
      parsed.watch = args[++i].split(",");
    } else if (args[i] === "--auto-execute") {
      parsed.autoExecute = true;
    } else if (args[i] === "--instructions" && args[i + 1]) {
      parsed.instructions = args[++i];
    } else if (args[i] === "--max-concurrent" && args[i + 1]) {
      parsed.maxConcurrent = parseInt(args[++i], 10) || 1;
    } else if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (args[i] === "--handoff-to" && args[i + 1]) {
      parsed.handoffTo = args[++i];
    } else if (!args[i].startsWith("--")) {
      parsed.roomId = args[i];
    }
  }

  // Default watch events if none specified
  if (parsed.watch.length === 0) {
    parsed.watch = ["task.assigned", "patch.proposed", "run.requested"];
  }

  return parsed;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

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

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (!parsed.roomId) {
    console.error(
      `Usage: co-od daemon <room-id> [--as <name>] [--role <role>] [--provider ${PROVIDER_LIST}] [--watch <events>] [--auto-execute] [--max-concurrent <n>]`
    );
    process.exit(1);
  }

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  const adapter = getAdapter(parsed.provider);
  const isAvailable = await adapter.available();
  if (!isAvailable) {
    console.error(
      `Error: '${adapter.name}' is not installed or not in PATH.`
    );
    process.exit(1);
  }

  // Register as an agent in the room
  const agentName = parsed.as || `cli-${process.env.USER || "agent"}`;
  const executionMode = parsed.provider === "codex" ? "local_codex"
    : parsed.provider === "opencode" ? "local_opencode"
    : parsed.provider === "hermes" ? "local_hermes"
    : parsed.provider === "openclaw" || parsed.provider === "zeroclaw" ? "local_openclaw"
    : "local_claude_code";
  const agentProvider = parsed.provider === "codex" ? "openai"
    : parsed.provider === "opencode" ? "opencode"
    : parsed.provider === "hermes" ? "hermes"
    : parsed.provider === "openclaw" || parsed.provider === "zeroclaw" ? "openclaw"
    : "anthropic";
  console.error(`[${timestamp()}] Registering agent "${agentName}" in room ${parsed.roomId}...`);

  let agentId: string;
  try {
    const reg = await api.post<AgentRegistration>(
      `/api/rooms/${parsed.roomId}/agents`,
      {
        name: agentName,
        type: parsed.role || "worker",
        executionMode,
        provider: agentProvider,
        soulDoc: parsed.instructions,
      }
    );
    agentId = reg.agentId;
    console.error(`[${timestamp()}] Registered as agent ${agentId}`);
  } catch (err) {
    console.error(`[${timestamp()}] Failed to register agent: ${err}`);
    process.exit(1);
  }

  console.error(`[${timestamp()}] Watching for events: ${parsed.watch.join(", ")}`);
  console.error(`[${timestamp()}] Auto-execute: ${parsed.autoExecute}`);
  console.error(`[${timestamp()}] Max concurrent: ${parsed.maxConcurrent}`);
  console.error(`[${timestamp()}] Press Ctrl+C to stop.\n`);

  let cursor: string | undefined;
  let activeRuns = 0;
  const processedEvents = new Set<string>();

  // Handle graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.error(`\n[${timestamp()}] Stopping daemon... (Ctrl+C again to force)`);
    if (activeRuns === 0) process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopping = true;
    process.exit(0);
  });

  // Event polling loop
  while (!stopping) {
    try {
      const queryParams = cursor ? `?cursor=${cursor}` : "";
      const data = await api.get<EventsResponse>(
        `/api/rooms/${parsed.roomId}/events${queryParams}`
      );

      if (data.cursor) {
        cursor = data.cursor;
      }

      const events = (data.events || []).filter(
        (e) =>
          parsed.watch.includes(e.type) && !processedEvents.has(e._id)
      );

      for (const event of events) {
        processedEvents.add(event._id);

        console.error(
          `[${timestamp()}] Event: ${event.type} ${JSON.stringify(event.payload || {}).slice(0, 100)}`
        );

        if (activeRuns >= parsed.maxConcurrent) {
          console.error(
            `[${timestamp()}] Skipping — at max concurrent (${parsed.maxConcurrent})`
          );
          continue;
        }

        if (parsed.autoExecute) {
          // Auto-dispatch
          const goal =
            (event.payload?.goal as string) ||
            (event.payload?.description as string) ||
            `Handle event: ${event.type}`;

          activeRuns++;
          console.error(`[${timestamp()}] Dispatching: ${goal.slice(0, 80)}`);

          // Create a run on the server
          const sessionToken = api.getSessionToken();
          const baseUrl = api.getBaseUrl();

          api
            .post<CreateRunResponse>(
              `/api/rooms/${parsed.roomId}/agent-runs`,
              { goal, agentId, eventId: event._id }
            )
            .then(async ({ runId, dispatch }) => {
              if (!dispatch?.token || !dispatch.completeUrl) {
                throw new Error("Server did not return a local execution dispatch for this run");
              }

              const heartbeat = startHeartbeat({
                heartbeatUrl: dispatch.heartbeatUrl,
                token: dispatch.token,
                intervalMs: dispatch.heartbeatIntervalMs,
              });
              let result: ExecuteResult;
              try {
                result = await adapter.execute(goal, {
                  workDir: parsed.dir,
                  onOutput: (data: string) => process.stderr.write(data),
                  // Room context enables Claude Code hooks for live reporting
                  roomId: parsed.roomId,
                  runId,
                  serverUrl: baseUrl,
                  sessionToken: sessionToken || undefined,
                });
              } catch (error) {
                result = errorToResult(error);
              } finally {
                if (heartbeat) {
                  clearInterval(heartbeat);
                }
              }

              const succeeded = result.exitCode === 0;
              console.error(
                `\n[${timestamp()}] Run ${runId} ${succeeded ? "succeeded" : "failed"}`
              );

              // Report completion
              try {
                await postCompletion(
                  dispatch.completeUrl,
                  dispatch.token,
                  {
                    ok: succeeded,
                    run: {
                      status: succeeded ? "succeeded" : "failed",
                      steps: [
                        {
                          kind: succeeded ? "observation" : "error",
                          input: { description: succeeded ? "Task completed" : "Task failed" },
                          output: {
                            success: succeeded,
                            payload: {
                              stdout: result.stdout.slice(-4096),
                              stderr: result.stderr.slice(-2048),
                              exitCode: result.exitCode,
                              ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
                            },
                          },
                        },
                      ],
                    },
                  },
                );
              } catch (error) {
                console.error(
                  `[${timestamp()}] Warning: failed to report completion: ${error}`
                );
              }

              // Agent-to-agent handoff
              const handoffTarget =
                parsed.handoffTo ||
                (event.payload?.handoffTo as string) ||
                null;

              if (succeeded && handoffTarget && parsed.roomId) {
                console.error(
                  `[${timestamp()}] Handing off to "${handoffTarget}"...`
                );
                try {
                  // Find target agent by name
                  const agents = await api.get<{ agents: Array<{ _id: string; name: string }> }>(
                    `/api/rooms/${parsed.roomId}/agents`
                  );
                  const target = agents.agents?.find(
                    (a) => a.name.toLowerCase() === handoffTarget.toLowerCase() || a._id === handoffTarget
                  );

                  if (target) {
                    await api.post(
                      `/api/rooms/${parsed.roomId}/agent-runs/${runId}/handoff`,
                      {
                        targetAgentId: target._id,
                        context: `Completed: ${goal}. Output: ${result.stdout.slice(-500)}`,
                        goal: `Continue from "${agentName}": ${goal}`,
                      }
                    );
                    console.error(
                      `[${timestamp()}] Handed off to "${target.name}" (${target._id})`
                    );
                  } else {
                    console.error(
                      `[${timestamp()}] Handoff target "${handoffTarget}" not found in room`
                    );
                  }
                } catch (err) {
                  console.error(
                    `[${timestamp()}] Handoff failed: ${err}`
                  );
                }
              }
            })
            .catch((err) => {
              console.error(
                `[${timestamp()}] Run failed: ${err}`
              );
            })
            .finally(() => {
              activeRuns--;
              if (stopping && activeRuns === 0) process.exit(0);
            });
        } else {
          // Print event, wait for user confirmation
          const goal =
            (event.payload?.goal as string) ||
            (event.payload?.description as string) ||
            `Handle event: ${event.type}`;

          console.error(
            `[${timestamp()}] Pending: ${goal.slice(0, 120)}`
          );
          console.error(
            `[${timestamp()}] (use --auto-execute to handle automatically)`
          );
        }
      }
    } catch (err) {
      console.error(`[${timestamp()}] Poll error: ${err}`);
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, 3000));
  }
}
