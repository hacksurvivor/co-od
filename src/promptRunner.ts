import { getAdapter } from "./adapters/index.js";

interface PromptDispatch {
  runId: string;
  goal: string;
  token: string;
  completeUrl: string;
  heartbeatUrl: string;
  heartbeatIntervalMs: number;
  provider?: string;
}

interface PromptRunnerOptions {
  workDir: string;
  onOutput: (data: string) => void;
  roomId?: string;
  serverUrl?: string;
  sessionToken?: string;
}

let currentRun: {
  runId: string;
  abortController: AbortController;
  heartbeatTimer: ReturnType<typeof setInterval>;
} | null = null;

export function isRunning(): boolean {
  return currentRun !== null;
}

export const resolveRemoteCliAdapterProvider = (provider?: string): string => {
  const normalized = provider?.trim().toLowerCase().replace(/\s+/g, "-");
  switch (normalized) {
    case "openai":
    case "codex":
    case "chatgpt":
    case "local-codex":
    case "local_codex":
      return "codex";
    case "opencode":
    case "local-opencode":
    case "local_opencode":
      return "opencode";
    case "openclaw":
    case "local-openclaw":
    case "local_openclaw":
      return "openclaw";
    case "zeroclaw":
    case "local-zeroclaw":
    case "local_zeroclaw":
      return "zeroclaw";
    case "pi":
    case "pi-agent":
    case "local-pi":
    case "local_pi":
      return "pi";
    case "hermes":
    case "hermes-agent":
    case "local-hermes":
    case "local_hermes":
      return "hermes";
    case "anthropic":
    case "claude":
    case "claude-code":
    case "local-claude-code":
    case "local_claude_code":
    case "remote-cli":
    case "remote_cli":
    case undefined:
    case "":
      return "claude";
    default:
      throw new Error(
        `Unsupported remote CLI provider "${provider}". Supported remote CLI providers: claude, codex, hermes, opencode, openclaw, pi, zeroclaw.`,
      );
  }
};

const postRunCompletion = async (
  completeUrl: string,
  token: string,
  payload: unknown,
  onOutput: (data: string) => void,
) => {
  try {
    const response = await fetch(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-local-bridge-token": token,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      onOutput(`[co-ode] Warning: completion failed: ${response.status} ${response.statusText}\r\n`);
    }
  } catch (err) {
    onOutput(`[co-ode] Warning: failed to post completion: ${err}\r\n`);
  }
};

export async function runPrompt(
  dispatch: PromptDispatch,
  options: PromptRunnerOptions,
): Promise<void> {
  if (currentRun) {
    throw new Error("A prompt is already running");
  }

  const { runId, goal, token, completeUrl, heartbeatUrl, heartbeatIntervalMs } = dispatch;
  const { workDir, onOutput } = options;
  const abortController = new AbortController();
  let adapterName = "agent";

  onOutput(`\r\n[co-ode] Received prompt: ${goal}\r\n`);

  const intervalMs = heartbeatIntervalMs || 10000;
  const heartbeatTimer = setInterval(async () => {
    try {
      const res = await fetch(heartbeatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-local-bridge-token": token,
        },
        body: JSON.stringify({
          leaseExpiresAt: Date.now() + Math.max(30_000, intervalMs * 3),
        }),
      });

      if (res.ok) {
        const body = (await res.json()) as { continue?: boolean };
        if (body.continue === false) {
          onOutput(`\r\n[co-ode] Server requested cancellation\r\n`);
          cancelCurrentRun();
        }
      }
    } catch {
      // Heartbeat failure is non-fatal.
    }
  }, intervalMs);

  currentRun = { runId, abortController, heartbeatTimer };

  try {
    adapterName = resolveRemoteCliAdapterProvider(dispatch.provider);
    const adapter = getAdapter(adapterName);
    onOutput(`[co-ode] Running ${adapter.name}...\r\n\r\n`);

    const available = await adapter.available();
    if (!available) {
      throw new Error(`${adapter.name} CLI is not installed or not in PATH`);
    }

    const result = await adapter.execute(goal, {
      workDir,
      onOutput,
      signal: abortController.signal,
      roomId: options.roomId,
      runId,
      serverUrl: options.serverUrl,
      sessionToken: options.sessionToken,
    });
    const succeeded = result.exitCode === 0;

    onOutput(`\r\n[co-ode] ${adapter.name} ${succeeded ? "completed" : `exited with code ${result.exitCode}`}\r\n`);

    await postRunCompletion(completeUrl, token, {
      ok: succeeded,
      run: {
        status: succeeded ? "succeeded" : "failed",
        steps: [
          {
            kind: succeeded ? "observation" : "error",
            input: { description: goal },
            output: {
              success: succeeded,
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
    }, onOutput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onOutput(`\r\n[co-ode] Failed to run ${adapterName}: ${message}\r\n`);

    await postRunCompletion(completeUrl, token, {
      ok: false,
      run: {
        status: "failed",
        steps: [
          {
            kind: "error",
            input: { description: `Failed to run ${adapterName}` },
            output: { success: false, payload: { message } },
            created_at: Date.now(),
          },
        ],
      },
    }, onOutput);
  } finally {
    clearInterval(heartbeatTimer);
    currentRun = null;
  }
}

function cancelCurrentRun() {
  if (currentRun) {
    currentRun.abortController.abort();
  }
}
