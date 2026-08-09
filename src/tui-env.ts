export type TuiEnvAction = "status" | "start" | "stop" | "touch";

export interface TuiEnvCommandResolution {
  ok: boolean;
  action?: TuiEnvAction;
  ttlSeconds?: number;
  message: string;
}

export interface RuntimeEnvSnapshot {
  id?: string;
  roomId?: string;
  status?: string;
  publicUrl?: string;
  daemonUrl?: string;
  termWsUrl?: string;
  containerId?: string;
  provider?: string;
  startedAt?: number;
  stoppedAt?: number;
  workspacePath?: string;
  ttlSeconds?: number;
  lastTouchedAt?: number;
}

export interface TuiEnvStatusResponse {
  ok?: boolean;
  convex?: RuntimeEnvSnapshot | null;
  orchestrator?: {
    ok?: boolean;
    env?: RuntimeEnvSnapshot | null;
  } | null;
  runtimeAvailable?: boolean;
}

export interface TuiEnvMutationResponse {
  ok?: boolean;
  env?: RuntimeEnvSnapshot | (RuntimeEnvSnapshot & {
    ok?: boolean;
    env?: RuntimeEnvSnapshot | null;
  }) | null;
  orchestrator?: {
    ok?: boolean;
    env?: RuntimeEnvSnapshot | null;
  } | null;
}

const ENV_COMMAND_ALIASES: Record<string, TuiEnvAction> = {
  "env-status": "status",
  "runtime-status": "status",
  "status-env": "status",
  "status-runtime": "status",
  "env-start": "start",
  "runtime-start": "start",
  "start-env": "start",
  "start-runtime": "start",
  "env-stop": "stop",
  "runtime-stop": "stop",
  "stop-env": "stop",
  "stop-runtime": "stop",
  "env-touch": "touch",
  "runtime-touch": "touch",
  "touch-env": "touch",
  "touch-runtime": "touch",
};

export function resolveEnvCommand(command: string, args: string[]): TuiEnvCommandResolution {
  const normalized = command.trim().toLowerCase();
  const aliased = ENV_COMMAND_ALIASES[normalized];
  if (aliased) {
    return resolveEnvAction(aliased, args);
  }

  if (normalized !== "env" && normalized !== "runtime") {
    return {
      ok: false,
      message: "Use /runtime, /env start [ttlSeconds], /env stop, or /env touch.",
    };
  }

  if (args.length === 0) {
    return { ok: true, action: "status", message: "Runtime status." };
  }

  const [subcommand = "", ...rest] = args;
  const action = normalizeEnvSubcommand(subcommand);
  if (!action) {
    return {
      ok: false,
      message: "Runtime command must be one of: status, start, stop, touch.",
    };
  }
  return resolveEnvAction(action, rest);
}

export function formatEnvStatus(response: TuiEnvStatusResponse): string {
  const orchestratorEnv = runtimeEnvFromRecord(response.orchestrator?.env);
  const convexEnv = runtimeEnvFromRecord(response.convex);
  const env = orchestratorEnv || convexEnv;
  const service = response.runtimeAvailable === false ? "orchestrator unavailable" : "orchestrator available";
  const lines = [
    `Runtime: ${formatRuntimeHeadline(env)}`,
    `Service: ${service}`,
    convexEnv?.status && convexEnv.status !== env?.status ? `Convex: ${convexEnv.status}` : "",
    env?.publicUrl ? `Preview: ${env.publicUrl}` : "",
    env?.daemonUrl ? `Daemon: ${env.daemonUrl}` : "",
    env?.termWsUrl ? `Terminal: ${env.termWsUrl}` : "",
    env?.containerId ? `Container: ${env.containerId}` : "",
    env?.workspacePath ? `Workspace: ${env.workspacePath}` : "",
    env?.ttlSeconds ? `TTL: ${env.ttlSeconds}s` : "",
    env?.lastTouchedAt ? `Touched: ${formatTimestamp(env.lastTouchedAt)}` : "",
    !env ? "No runtime record returned for this room." : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatEnvMutation(action: Exclude<TuiEnvAction, "status">, response: TuiEnvMutationResponse): string {
  const env = extractMutationEnv(response);
  const label = action === "start"
    ? "Runtime started"
    : action === "stop"
      ? "Runtime stopped"
      : "Runtime touched";
  const lines = [
    `${label}: ${formatRuntimeHeadline(env)}`,
    env?.publicUrl ? `Preview: ${env.publicUrl}` : "",
    env?.daemonUrl ? `Daemon: ${env.daemonUrl}` : "",
    env?.termWsUrl ? `Terminal: ${env.termWsUrl}` : "",
    env?.ttlSeconds ? `TTL: ${env.ttlSeconds}s` : "",
    env?.lastTouchedAt ? `Touched: ${formatTimestamp(env.lastTouchedAt)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function resolveEnvAction(action: TuiEnvAction, args: string[]): TuiEnvCommandResolution {
  if (action !== "start" && args.length > 0) {
    return {
      ok: false,
      message: `/${action === "status" ? "runtime" : `env-${action}`} does not accept extra arguments.`,
    };
  }
  if (action !== "start") {
    return { ok: true, action, message: `Runtime ${action}.` };
  }

  if (args.length > 1) {
    return {
      ok: false,
      message: "Usage: /env start [ttlSeconds] or /env-start [ttlSeconds].",
    };
  }
  const ttlSeconds = args.length === 1 ? parseTtlSeconds(args[0] || "") : undefined;
  if (ttlSeconds === null) {
    return {
      ok: false,
      message: "Runtime TTL must be a positive whole number of seconds.",
    };
  }
  return {
    ok: true,
    action,
    ttlSeconds,
    message: ttlSeconds ? `Runtime start requested for ${ttlSeconds}s.` : "Runtime start requested.",
  };
}

function normalizeEnvSubcommand(value: string): TuiEnvAction | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "status" || normalized === "show" || normalized === "info") return "status";
  if (normalized === "start" || normalized === "up" || normalized === "boot") return "start";
  if (normalized === "stop" || normalized === "down" || normalized === "shutdown") return "stop";
  if (normalized === "touch" || normalized === "keepalive" || normalized === "extend") return "touch";
  return null;
}

function parseTtlSeconds(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function extractMutationEnv(response: TuiEnvMutationResponse): RuntimeEnvSnapshot | null {
  const direct = runtimeEnvFromRecord(response.env);
  const nested = isRecord(response.env) ? runtimeEnvFromRecord(response.env.env) : null;
  const orchestrator = runtimeEnvFromRecord(response.orchestrator?.env);
  return mergeRuntimeEnv(direct, nested) || orchestrator;
}

function mergeRuntimeEnv(
  first: RuntimeEnvSnapshot | null,
  second: RuntimeEnvSnapshot | null,
): RuntimeEnvSnapshot | null {
  if (!first && !second) return null;
  return {
    ...(first || {}),
    ...(second || {}),
  };
}

function runtimeEnvFromRecord(value: unknown): RuntimeEnvSnapshot | null {
  if (!isRecord(value)) return null;
  const env: RuntimeEnvSnapshot = {};
  for (const key of [
    "id",
    "roomId",
    "status",
    "publicUrl",
    "daemonUrl",
    "termWsUrl",
    "containerId",
    "provider",
    "workspacePath",
  ] as const) {
    if (typeof value[key] === "string" && value[key]) {
      env[key] = value[key];
    }
  }
  for (const key of ["startedAt", "stoppedAt", "ttlSeconds", "lastTouchedAt"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      env[key] = value[key];
    }
  }
  return Object.keys(env).length > 0 ? env : null;
}

function formatRuntimeHeadline(env: RuntimeEnvSnapshot | null): string {
  if (!env) return "unknown";
  const provider = env.provider ? ` via ${env.provider}` : "";
  return `${env.status || "unknown"}${provider}`;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
