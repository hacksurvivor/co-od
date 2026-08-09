import { createRoomTerminalSession, type ConnectOptions, type RoomTerminalSession } from "./connect.js";

export interface RealtimeSessionResponse {
  token: string;
  terminalWsUrl: string;
}

export type TuiTerminalEvent =
  | { type: "connecting" }
  | { type: "status"; message: string; connected: boolean }
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "closed"; reason?: string };

export interface TuiTerminalConnectionState {
  connected: boolean;
  connecting: boolean;
  disconnectReason?: string;
  closedAt?: number;
}

export type TuiTerminalSessionFactory = (
  options: ConnectOptions,
  hooks?: Parameters<typeof createRoomTerminalSession>[1],
) => RoomTerminalSession;

export interface CreateRealtimeSessionOptions {
  serverUrl: string;
  roomId: string;
  sessionToken: string;
  fetchImpl?: typeof fetch;
}

export interface ConnectTuiTerminalOptions extends CreateRealtimeSessionOptions {
  workDir: string;
  columns: number;
  rows: number;
  createSession?: TuiTerminalSessionFactory;
  onEvent?: (event: TuiTerminalEvent) => void;
}

export type TuiTerminalConnectResult =
  | { ok: true; session: RoomTerminalSession }
  | { ok: false; errorMessage: string };

export function isTerminalConnectedStatus(message: string): boolean {
  return message.toLowerCase().startsWith("connected");
}

export function isTerminalConnectingStatus(message: string): boolean {
  return message.toLowerCase().startsWith("connecting");
}

export function createTerminalConnectionState(): TuiTerminalConnectionState {
  return { connected: false, connecting: false };
}

export function resolveTerminalPaneSize(columns?: number, rows?: number): { columns: number; rows: number } {
  const safeColumns = Math.max(20, Math.floor(columns || 80));
  const safeRows = Math.max(12, Math.floor((rows || 24) * 0.35));
  return { columns: safeColumns, rows: safeRows };
}

export function reduceTerminalConnectionState(
  state: TuiTerminalConnectionState,
  event: TuiTerminalEvent,
  now = Date.now(),
): TuiTerminalConnectionState {
  if (event.type === "connecting") {
    return { connected: false, connecting: true };
  }

  if (event.type === "status") {
    if (event.connected) {
      return { connected: true, connecting: false };
    }
    if (isTerminalConnectingStatus(event.message)) {
      return { ...state, connected: false, connecting: true, disconnectReason: undefined, closedAt: undefined };
    }
    return { connected: false, connecting: false, disconnectReason: event.message, closedAt: now };
  }

  if (event.type === "error") {
    return { connected: false, connecting: false, disconnectReason: event.message, closedAt: now };
  }

  if (event.type === "closed") {
    return {
      connected: false,
      connecting: false,
      disconnectReason: event.reason || state.disconnectReason || "Connection closed",
      closedAt: now,
    };
  }

  return state;
}

export function splitTerminalOutputLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export function appendTerminalOutputLines(existing: string[], data: string, maxLines = 500): string[] {
  const lines = [...existing, ...splitTerminalOutputLines(data)];
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

export async function createRealtimeSession(options: CreateRealtimeSessionOptions): Promise<RealtimeSessionResponse> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${options.serverUrl}/api/rooms/${options.roomId}/realtime/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.sessionToken}`,
    },
    body: JSON.stringify({ ttlSeconds: 3600 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to create realtime session: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as Partial<RealtimeSessionResponse>;
  if (!body.token || !body.terminalWsUrl) {
    throw new Error("Realtime session did not include terminal connection details");
  }
  return { token: body.token, terminalWsUrl: body.terminalWsUrl };
}

export async function connectTuiTerminal(options: ConnectTuiTerminalOptions): Promise<TuiTerminalConnectResult> {
  const createSession = options.createSession || createRoomTerminalSession;
  options.onEvent?.({ type: "connecting" });

  try {
    const realtime = await createRealtimeSession(options);
    const session = createSession(
      {
        terminalWsUrl: realtime.terminalWsUrl,
        realtimeToken: realtime.token,
        roomId: options.roomId,
        workDir: options.workDir,
        serverUrl: options.serverUrl,
        sessionToken: options.sessionToken,
      },
      {
        onStatus: (message) => {
          options.onEvent?.({ type: "status", message, connected: isTerminalConnectedStatus(message) });
        },
        onOutput: (data) => {
          options.onEvent?.({ type: "output", data });
        },
        onError: (message) => {
          options.onEvent?.({ type: "error", message });
        },
        onClose: (reason) => {
          options.onEvent?.({ type: "closed", reason });
        },
      },
    );
    session.resize(options.columns, options.rows);
    return { ok: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "error", message });
    return { ok: false, errorMessage: message };
  }
}
