import WebSocket from "ws";
import { createLocalPty } from "./pty.js";
import { runPrompt, isRunning } from "./promptRunner.js";

export interface ConnectOptions {
  terminalWsUrl: string;
  realtimeToken: string;
  roomId: string;
  workDir: string;
  serverUrl: string;
  sessionToken: string;
}

export interface RoomTerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  waitUntilClosed(): Promise<void>;
}

export interface RoomTerminalHooks {
  onStatus?: (message: string) => void;
  onOutput?: (data: string) => void;
  onError?: (message: string) => void;
  onClose?: (reason?: string) => void;
}

export function createRoomTerminalSession(options: ConnectOptions, hooks: RoomTerminalHooks = {}): RoomTerminalSession {
  const { terminalWsUrl, realtimeToken, roomId, workDir, serverUrl, sessionToken } = options;

  // Build the PTY provider WebSocket URL
  // terminalWsUrl is like ws://host:port — append the pty-provider path
  const baseUrl = terminalWsUrl.replace(/\/$/, "");
  const wsUrl = `${baseUrl}/pty-provider?roomId=${encodeURIComponent(roomId)}&token=${encodeURIComponent(realtimeToken)}`;

  hooks.onStatus?.("Connecting to terminal gateway...");

  const ws = new WebSocket(wsUrl);
  const pty = createLocalPty(workDir);

  let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let resolveClosed: (() => void) | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const cleanup = (reason = "Connection closed") => {
    if (closed) return;
    closed = true;
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    pty.kill();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    hooks.onClose?.(reason);
    resolveClosed?.();
  };

  // Wire PTY output → WebSocket
  pty.onData((data) => {
    hooks.onOutput?.(data);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  ws.on("open", () => {
    hooks.onStatus?.("Connected. Terminal is now shared with the room.");

    // Send initial connection info
    ws.send(JSON.stringify({
      type: "connected",
      cwd: workDir,
      data: `[co-ode] Remote CLI connected from ${workDir}\r\n\r\n`,
    }));

    // Schedule token refresh (45 minutes — tokens last 1 hour)
    tokenRefreshTimer = setTimeout(() => refreshToken(options), 45 * 60 * 1000);
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
        runId?: string;
        goal?: string;
        token?: string;
        completeUrl?: string;
        heartbeatUrl?: string;
        heartbeatIntervalMs?: number;
        provider?: string;
      };

      switch (msg.type) {
        case "input":
          // Browser client typed something → forward to local PTY
          if (msg.data) {
            pty.write(msg.data);
          }
          break;

        case "resize":
          if (msg.cols && msg.rows) {
            pty.resize(msg.cols, msg.rows);
          }
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        case "prompt.dispatch":
          // Room member sent an agent prompt
          if (isRunning()) {
            ws.send(JSON.stringify({ type: "prompt.busy", runId: msg.runId }));
            break;
          }

          ws.send(JSON.stringify({ type: "prompt.ack", runId: msg.runId }));

          void runPrompt(
            {
              runId: msg.runId!,
              goal: msg.goal!,
              token: msg.token!,
              completeUrl: msg.completeUrl!,
              heartbeatUrl: msg.heartbeatUrl!,
              heartbeatIntervalMs: msg.heartbeatIntervalMs || 10000,
              provider: msg.provider,
            },
            {
              workDir,
              roomId,
              serverUrl,
              sessionToken,
              onOutput: (data) => {
                hooks.onOutput?.(data);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "output", data }));
                }
              },
            }
          ).then(() => {
            ws.send(JSON.stringify({
              type: "prompt.complete",
              runId: msg.runId,
              status: "done",
            }));
          });
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", (code, reasonBuffer) => {
    hooks.onStatus?.("Disconnected from room.");
    const reason = reasonBuffer.toString() || (code ? `WebSocket closed (${code})` : "Disconnected from room.");
    cleanup(reason);
  });

  ws.on("error", (err) => {
    hooks.onError?.(`WebSocket error: ${err.message}`);
  });

  return {
    write(data: string) {
      pty.write(data);
    },
    resize(cols: number, rows: number) {
      pty.resize(cols, rows);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    },
    close() {
      cleanup("Terminal closed by user");
    },
    waitUntilClosed() {
      return closedPromise;
    },
  };
}

export async function connectToRoom(options: ConnectOptions): Promise<void> {
  const session = createRoomTerminalSession(options, {
    onStatus: (message) => console.error(`[co-ode] ${message}`),
    onOutput: () => undefined,
    onError: (message) => console.error(`[co-ode] ${message}`),
  });

  console.error(`[co-ode] Room members can see your terminal and dispatch agent prompts.`);
  console.error(`[co-ode] Press Ctrl+C to disconnect.\n`);

  process.on("SIGINT", () => {
    console.error(`\n[co-ode] Disconnecting...`);
    session.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    session.close();
    process.exit(0);
  });

  await session.waitUntilClosed();
  process.exit(0);
}

async function refreshToken(options: ConnectOptions) {
  try {
    console.error(`[co-ode] Refreshing realtime token...`);
    const res = await fetch(
      `${options.serverUrl}/api/rooms/${options.roomId}/realtime/session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.sessionToken}`,
        },
        body: JSON.stringify({ ttlSeconds: 3600 }),
      }
    );

    if (res.ok) {
      const data = (await res.json()) as { token: string };
      options.realtimeToken = data.token;
      console.error(`[co-ode] Token refreshed`);
    } else {
      console.error(`[co-ode] Warning: token refresh failed (${res.status})`);
    }
  } catch (err) {
    console.error(`[co-ode] Warning: token refresh error: ${err}`);
  }
}
