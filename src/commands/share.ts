import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAdapter, PROVIDER_LIST } from "../adapters/index.js";
import * as api from "../api-client.js";
import type { ExecuteResult } from "../adapters/base.js";

interface ParsedArgs {
  provider: string;
  dir: string;
  server?: string;
  roomId?: string;
}

interface RelayRegistration {
  code: string;
  expiresAt?: number;
}

interface RelayJob {
  jobId: string;
  payload?: string;
  goal?: string;
  roomId?: string;
  provider?: string;
}

interface RelayPollResponse {
  jobs?: RelayJob[];
  job?: RelayJob | null;
}

interface RelayDispatch {
  runId?: string;
  roomId?: string;
  provider?: string;
  goal?: string;
  token?: string;
  completeUrl?: string;
  heartbeatUrl?: string;
  heartbeatIntervalMs?: number;
  projectDir?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    provider: "claude",
    dir: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
    } else if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (args[i] === "--room" && args[i + 1]) {
      parsed.roomId = args[++i];
    }
  }

  return parsed;
}

function readRoomId(dir: string): string | undefined {
  try {
    const configPath = join(dir, ".co-od.json");
    if (!existsSync(configPath)) return undefined;
    const data = JSON.parse(readFileSync(configPath, "utf-8")) as { roomId?: unknown };
    return typeof data.roomId === "string" && data.roomId.trim() ? data.roomId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

const providerFromDispatch = (provider?: string) => {
  switch (provider) {
    case "local_codex":
      return "codex";
    case "local_opencode":
      return "opencode";
    case "local_hermes":
      return "hermes";
    case "local_openclaw":
      return "openclaw";
    case "local_claude_code":
      return "claude";
    default:
      return provider || "claude";
  }
};

const parseDispatch = (job: RelayJob): RelayDispatch => {
  if (!job.payload) {
    return {
      goal: job.goal,
      roomId: job.roomId,
      provider: job.provider,
    };
  }

  try {
    const parsed = JSON.parse(job.payload) as RelayDispatch;
    return {
      ...parsed,
      goal: parsed.goal || job.goal,
      roomId: parsed.roomId || job.roomId,
      provider: parsed.provider || job.provider,
    };
  } catch {
    return {
      goal: job.payload,
      roomId: job.roomId,
      provider: job.provider,
    };
  }
};

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
  token?: string;
  intervalMs?: number;
}) => {
  if (!input.heartbeatUrl || !input.token) {
    return undefined;
  }

  const intervalMs = Math.max(5_000, Number(input.intervalMs || 15_000));
  const send = async () => {
    await fetch(input.heartbeatUrl!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
        "x-local-bridge-token": input.token!,
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

const completionPayload = (goal: string, result: ExecuteResult) => ({
  ok: result.exitCode === 0,
  run: {
    status: result.exitCode === 0 ? "succeeded" : "failed",
    steps: [
      {
        kind: result.exitCode === 0 ? "observation" : "error",
        input: { description: goal },
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

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  const roomId = parsed.roomId || readRoomId(parsed.dir);
  if (!roomId) {
    console.error("[co-od] Relay sharing requires a room. Run inside a project with .co-od.json or pass --room <room-id>.");
    process.exit(1);
  }

  console.error(`[co-od] Registering relay...`);

  const reg = await api.post<RelayRegistration>("/api/relay/register", {
    provider: parsed.provider,
    roomId,
  });

  console.log(`\nRelay code: ${reg.code}`);
  console.log("Share this with teammates to let them dispatch tasks to your machine.\n");
  if (reg.expiresAt) {
    console.error(`[${timestamp()}] Relay active. Expires at ${new Date(reg.expiresAt).toLocaleTimeString()}`);
  } else {
    console.error(`[${timestamp()}] Relay active.`);
  }
  console.error(`[${timestamp()}] Waiting for jobs... (Ctrl+C to stop)\n`);

  let stopping = false;
  let activeJobs = 0;

  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.error(`\n[${timestamp()}] Stopping relay... (Ctrl+C again to force)`);
    if (activeJobs === 0) process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopping = true;
    process.exit(0);
  });

  while (!stopping) {
    try {
      const data = await api.post<RelayPollResponse>("/api/relay/poll", {
        code: reg.code,
      });
      const jobs = data.jobs ?? (data.job ? [data.job] : []);

      for (const job of jobs) {
        const dispatch = parseDispatch(job);
        const goal = dispatch.goal?.trim();
        if (!goal) {
          console.error(`[${timestamp()}] Job ${job.jobId} has no goal; marking failed`);
          await api.post(`/api/relay/${reg.code}/complete`, {
            jobId: job.jobId,
            result: JSON.stringify({ ok: false, message: "Relay job has no goal" }),
          }).catch(() => undefined);
          continue;
        }

        const adapter = getAdapter(providerFromDispatch(dispatch.provider || job.provider || parsed.provider));
        activeJobs++;

        void (async () => {
          const heartbeat = startHeartbeat({
            heartbeatUrl: dispatch.heartbeatUrl,
            token: dispatch.token,
            intervalMs: dispatch.heartbeatIntervalMs,
          });
          let result: ExecuteResult;

          try {
            const available = await adapter.available();
            if (!available) {
              throw new Error(`${adapter.name} is not installed or not in PATH`);
            }

            console.error(`[${timestamp()}] Job received: ${goal.slice(0, 100)}`);
            result = await adapter.execute(goal, {
              workDir: dispatch.projectDir || parsed.dir,
              onOutput: (out) => process.stderr.write(out),
              roomId: dispatch.roomId,
              runId: dispatch.runId,
              serverUrl: api.getBaseUrl(),
              sessionToken: api.getSessionToken() || undefined,
            });
          } catch (error) {
            result = errorToResult(error);
          } finally {
            if (heartbeat) {
              clearInterval(heartbeat);
            }
          }

          console.error(
            `\n[${timestamp()}] Job ${job.jobId} ${result.exitCode === 0 ? "succeeded" : "failed"}`
          );

          if (dispatch.completeUrl && dispatch.token) {
            try {
              await postCompletion(dispatch.completeUrl, dispatch.token, completionPayload(goal, result));
            } catch {
              console.error(`[${timestamp()}] Warning: failed to report run completion`);
            }
          }

          try {
            await api.post(`/api/relay/${reg.code}/complete`, {
              jobId: job.jobId,
              result: JSON.stringify({
                ok: result.exitCode === 0,
                stdout: result.stdout.slice(-4096),
                stderr: result.stderr.slice(-2048),
                exitCode: result.exitCode,
              }),
            });
          } catch {
            console.error(`[${timestamp()}] Warning: failed to report relay job completion`);
          }
        })()
          .catch((err) => {
            console.error(`[${timestamp()}] Job error: ${err}`);
          })
          .finally(() => {
            activeJobs--;
            if (stopping && activeJobs === 0) process.exit(0);
          });
      }
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("404") || errMsg.includes("410")) {
        console.error(`[${timestamp()}] Relay expired. Exiting.`);
        process.exit(0);
      }
      console.error(`[${timestamp()}] Poll error: ${err}`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}
