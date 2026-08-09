import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "./api-client.js";
import { getAdapter } from "./adapters/index.js";
import { dedupeRuns, type AgentRunRecord, type PatchRecord, type RunDetailData } from "./tui-model.js";
import { resolveInitialProvider, TUI_PROVIDERS } from "./tui-provider.js";
import { checkAllProviderAuth, type ProviderAuthStatus } from "./provider-auth.js";
import { loadHerdrAgents, type HerdrAgentLoadResult } from "./tui-herdr.js";
import type { TuiServerUndoChange } from "./tui-undo.js";

export interface ProjectConfig {
  roomId: string;
  roomName?: string;
  projectDir?: string;
  provider?: string;
  server?: string;
  /** Side-panel tabs to show, in order. Defaults to ["room","work","chat"]; "team" remains a legacy alias. */
  panelTabs?: string[];
}

export interface MessageRecord {
  _id: string;
  author_type?: "user" | "agent" | "system";
  author_id?: string;
  author_name?: string;
  /** WorkOS id of a user author — lets clients recognize their own messages. */
  author_workos_id?: string;
  body_md?: string;
  created_at?: number;
}

export interface PresenceRecord {
  name?: string;
  workos_user_id?: string;
  client?: string;
  last_seen_at?: number;
}

/** Who this CLI is signed in as — for "you" detection in chat. */
export interface SessionIdentity {
  workosUserId?: string;
  name?: string;
}

export interface AgentRecord {
  _id: string;
  name?: string;
  type?: string;
  provider?: string;
  execution_mode?: string;
  has_api_key?: boolean;
  external_source?: string;
  external_status?: string;
  external_summary?: string;
  external_target?: string;
  external_attach_command?: string;
}

export interface RoomRecord {
  _id: string;
  name?: string;
  status?: string;
  agents?: Array<{ name?: string }>;
  members?: Array<{ name?: string }>;
}

export interface ServiceHealth {
  ok?: boolean;
  status?: number;
  latencyMs?: number;
  message?: string;
}

export interface ProviderAuthSummary {
  provider: string;
  label: string;
  status: ProviderAuthStatus;
}

export interface DashboardData {
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  messages?: MessageRecord[];
  /** Room-level patches — proposed ones drive the "needs you" review inbox. */
  patches?: PatchRecord[];
  /** Live presence — who has the room open right now (heartbeat-fresh). */
  presence?: PresenceRecord[];
  services: Record<string, ServiceHealth>;
  checkedAt?: string;
  error?: string;
  cached?: boolean;
  cachedAt?: string;
  cacheReason?: string;
}

export interface CachedRoomDashboard {
  roomId: string;
  roomName?: string;
  agents: AgentRecord[];
  runs: AgentRunRecord[];
  cachedAt: string;
}

export const DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DashboardCachePolicy {
  enabled: boolean;
  maxAgeMs: number;
}

export interface TuiDashboardState {
  config: ProjectConfig | null;
  session: api.CachedSession | null;
  bridge: "running" | "offline";
  providerAvailability: Record<string, boolean>;
  providerAuth?: ProviderAuthSummary[];
  identity?: SessionIdentity;
  dashboard: DashboardData;
  rooms: RoomRecord[];
  roomsError?: string;
  provider: string;
  message: string;
}

export interface TuiDashboardLoadOptions {
  dir: string;
  roomId?: string;
  provider?: string;
  server?: string;
  previousProvider?: string;
  getSession?: () => api.CachedSession | null;
  getBaseUrl?: () => string;
  apiGet?: <T = unknown>(path: string) => Promise<T>;
  fetchImpl?: typeof fetch;
  adapterAvailable?: (provider: string) => Promise<boolean>;
  loadHerdrAgents?: () => Promise<HerdrAgentLoadResult>;
}

export function readProjectConfig(dir: string, roomId?: string): ProjectConfig | null {
  const configPath = join(dir, ".co-od.json");
  let config: ProjectConfig | null = null;
  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8")) as ProjectConfig;
      if (data.roomId) config = data;
    } catch {
      config = null;
    }
  }

  if (roomId) {
    return {
      ...config,
      roomId,
      roomName: config?.roomId === roomId ? config?.roomName || roomId : roomId,
      projectDir: config?.projectDir || dir,
    };
  }

  return config;
}

export async function bridgeHealth(fetchImpl: typeof fetch = fetch): Promise<"running" | "offline"> {
  try {
    const res = await fetchImpl("http://127.0.0.1:4786/health", {
      signal: AbortSignal.timeout(800),
    });
    return res.ok ? "running" : "offline";
  } catch {
    return "offline";
  }
}

export async function fetchServiceHealth(
  baseUrl: string = api.getBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<Pick<DashboardData, "services" | "checkedAt">> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health/deep`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_500),
    });
    const body = (await response.json().catch(() => ({}))) as {
      services?: Record<string, ServiceHealth>;
      checkedAt?: string;
    };
    return {
      services: body.services || {},
      checkedAt: body.checkedAt,
    };
  } catch (error) {
    return {
      services: {
        web: {
          ok: false,
          status: 503,
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export function serviceFailureReason(service?: ServiceHealth, maxLength = 80): string {
  if (!service) return "";
  const parts = [
    typeof service.status === "number" ? `HTTP ${service.status}` : "",
    service.message || "",
  ].filter(Boolean);
  return truncateText(parts.join(": "), maxLength);
}

export function formatServiceHealth(service?: ServiceHealth): string {
  if (!service) return "unknown";
  const latency = typeof service.latencyMs === "number" ? ` ${service.latencyMs}ms` : "";
  if (service.ok) return `ok${latency}`;
  const reason = serviceFailureReason(service);
  return reason ? `down ${reason}${latency}` : `down${latency}`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return ".".repeat(Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function availableProviders(
  adapterAvailable: (provider: string) => Promise<boolean> = (provider) => getAdapter(provider).available(),
  providers: string[] = TUI_PROVIDERS,
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  await Promise.all(
    providers.map(async (provider) => {
      result[provider] = await adapterAvailable(provider);
    }),
  );
  return result;
}

export function resolveDashboardProvider(input: {
  argProvider?: string;
  configProvider?: string;
  providerAvailability: Record<string, boolean>;
  previousProvider?: string;
  providers?: string[];
}): string {
  return resolveInitialProvider(input);
}

export async function loadRoomDashboardData(input: {
  roomId: string;
  apiGet?: <T = unknown>(path: string) => Promise<T>;
}): Promise<Pick<DashboardData, "agents" | "runs" | "messages" | "patches" | "presence" | "error">> {
  const apiGet = input.apiGet || api.get;
  const [agentsResult, runsResult, messagesResult, patchesResult, presenceResult] = await Promise.allSettled([
    apiGet<{ agents?: AgentRecord[] }>(`/api/rooms/${input.roomId}/agents`),
    apiGet<{ runs?: AgentRunRecord[] }>(`/api/rooms/${input.roomId}/agent-runs`),
    apiGet<{ messages?: MessageRecord[] }>(`/api/rooms/${input.roomId}/messages`),
    apiGet<{ patches?: PatchRecord[] }>(`/api/rooms/${input.roomId}/patches`),
    apiGet<{ presence?: PresenceRecord[] }>(`/api/rooms/${input.roomId}/presence`),
  ]);
  const errors: string[] = [];
  const agents = agentsResult.status === "fulfilled" ? agentsResult.value.agents || [] : [];
  const runs = runsResult.status === "fulfilled" ? runsResult.value.runs || [] : [];
  // The group chat and patch feed are best-effort: a failure there should not
  // block the dashboard.
  const messages = messagesResult.status === "fulfilled" ? messagesResult.value.messages || [] : [];
  const patches = patchesResult.status === "fulfilled" ? patchesResult.value.patches || [] : [];
  const presence = presenceResult.status === "fulfilled" ? presenceResult.value.presence || [] : [];

  if (agentsResult.status === "rejected") {
    errors.push(`agents: ${formatError(agentsResult.reason)}`);
  }
  if (runsResult.status === "rejected") {
    errors.push(`runs: ${formatError(runsResult.reason)}`);
  }

  return {
    agents,
    runs,
    messages,
    patches,
    presence,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

export async function loadRoomsData(input: {
  apiGet?: <T = unknown>(path: string) => Promise<T>;
} = {}): Promise<{ rooms: RoomRecord[]; error?: string }> {
  const apiGet = input.apiGet || api.get;
  try {
    const response = await apiGet<{ rooms?: RoomRecord[] }>("/api/rooms");
    return { rooms: response.rooms || [], error: undefined };
  } catch (error) {
    return {
      rooms: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseBooleanEnv(value?: string): boolean {
  return /^(1|true|yes|on)$/i.test((value || "").trim());
}

export function parseDashboardCacheMaxAgeMs(value?: string): number | undefined {
  const raw = (value || "").trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = (match[2] || "ms").toLowerCase();
  const multiplier =
    unit === "d" ? 24 * 60 * 60 * 1000 :
    unit === "h" ? 60 * 60 * 1000 :
    unit === "m" ? 60 * 1000 :
    unit === "s" ? 1000 :
    1;
  return Math.floor(amount * multiplier);
}

export function dashboardCachePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DashboardCachePolicy {
  const disabled = parseBooleanEnv(env.CO_OD_TUI_DISABLE_DASHBOARD_CACHE || env.CO_OD_TUI_DISABLE_CACHE);
  return {
    enabled: !disabled,
    maxAgeMs: parseDashboardCacheMaxAgeMs(
      env.CO_OD_TUI_DASHBOARD_CACHE_MAX_AGE
        || env.CO_OD_TUI_DASHBOARD_CACHE_MAX_AGE_MS
        || env.CO_OD_TUI_CACHE_MAX_AGE_MS,
    ) ?? DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS,
  };
}

export function formatDashboardCacheMaxAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "invalid";
  const units = [
    ["d", 24 * 60 * 60 * 1000],
    ["h", 60 * 60 * 1000],
    ["m", 60 * 1000],
    ["s", 1000],
  ] as const;
  for (const [label, unitMs] of units) {
    if (ms >= unitMs && ms % unitMs === 0) {
      return `${ms / unitMs}${label}`;
    }
  }
  return `${ms}ms`;
}

export function formatDashboardCachePolicy(policy: DashboardCachePolicy): string {
  return policy.enabled ? `enabled max-age ${formatDashboardCacheMaxAge(policy.maxAgeMs)}` : "disabled";
}

export function createRoomDashboardCache(input: {
  roomId: string;
  roomName?: string;
  dashboard: Pick<DashboardData, "agents" | "runs" | "error">;
  now?: string;
  agentLimit?: number;
  runLimit?: number;
}): CachedRoomDashboard | null {
  if (input.dashboard.error) return null;
  if (input.dashboard.agents.length === 0 && input.dashboard.runs.length === 0) {
    return null;
  }
  return {
    roomId: input.roomId,
    roomName: input.roomName,
    agents: input.dashboard.agents.slice(0, input.agentLimit ?? 30),
    // The cache exists to draw lists on the next launch — embedded step
    // payloads (stdout/output text) can be hundreds of KB and the task detail
    // view re-fetches them on demand, so they never belong on disk here.
    runs: input.dashboard.runs.slice(0, input.runLimit ?? 60).map((run) => {
      const { steps: _steps, ...rest } = run as typeof run & { steps?: unknown };
      return rest as typeof run;
    }),
    cachedAt: input.now || new Date().toISOString(),
  };
}

export function roomDashboardCacheAgeMs(cache: Pick<CachedRoomDashboard, "cachedAt">, now = Date.now()): number | null {
  const cachedAt = Date.parse(cache.cachedAt);
  if (!Number.isFinite(cachedAt)) return null;
  return Math.max(0, now - cachedAt);
}

export function isRoomDashboardCacheFresh(input: {
  cache: Pick<CachedRoomDashboard, "cachedAt">;
  now?: number;
  maxAgeMs?: number;
}): boolean {
  const age = roomDashboardCacheAgeMs(input.cache, input.now);
  return age !== null && age <= (input.maxAgeMs ?? DEFAULT_DASHBOARD_CACHE_MAX_AGE_MS);
}

export function applyRoomDashboardCache(input: {
  dashboard: DashboardData;
  cache?: CachedRoomDashboard | null;
  roomId?: string;
  reason?: string;
  now?: number;
  maxAgeMs?: number;
  policy?: DashboardCachePolicy;
}): DashboardData {
  if (input.policy && !input.policy.enabled) return input.dashboard;
  const cache = input.cache;
  if (!cache || (input.roomId && cache.roomId !== input.roomId)) {
    return input.dashboard;
  }
  if (!isRoomDashboardCacheFresh({
    cache,
    now: input.now,
    maxAgeMs: input.maxAgeMs ?? input.policy?.maxAgeMs,
  })) {
    return input.dashboard;
  }
  const reason = input.reason || input.dashboard.error;
  if (!reason) {
    return input.dashboard;
  }
  const applyAgents = input.dashboard.agents.length === 0 && cache.agents.length > 0;
  const applyRuns = input.dashboard.runs.length === 0 && cache.runs.length > 0;
  if (!applyAgents && !applyRuns) return input.dashboard;

  return {
    ...input.dashboard,
    agents: applyAgents ? cache.agents : input.dashboard.agents,
    runs: applyRuns ? cache.runs : input.dashboard.runs,
    cached: true,
    cachedAt: cache.cachedAt,
    cacheReason: reason,
    error: input.dashboard.error
      ? `${input.dashboard.error} (showing cached room data)`
      : input.dashboard.error,
  };
}

export async function loadRunDetailData(input: {
  roomId: string;
  runId: string;
  apiGet?: <T = unknown>(path: string) => Promise<T>;
}): Promise<RunDetailData> {
  const apiGet = input.apiGet || api.get;
  const [runResponse, patchesResponse, runsResponse] = await Promise.all([
    apiGet<{ run?: AgentRunRecord }>(`/api/rooms/${input.roomId}/agent-runs/${input.runId}`),
    apiGet<{ patches?: PatchRecord[] }>(`/api/rooms/${input.roomId}/patches`),
    apiGet<{ runs?: AgentRunRecord[] }>(`/api/rooms/${input.roomId}/agent-runs`),
  ]);
  const run = runResponse.run;
  if (!run) {
    throw new Error("Run detail response did not include a run");
  }
  return {
    run,
    patches: (patchesResponse.patches || []).filter((patch) => patch.run_id === run._id),
    allRuns: dedupeRuns([run, ...(runsResponse.runs || [])]),
  };
}

export async function resolveRunPatch(input: {
  roomId: string;
  patchId: string;
  action: "accept" | "reject";
  rejectReason?: string;
  apiPost?: <T = unknown>(path: string, body?: unknown) => Promise<T>;
}): Promise<void> {
  const apiPost = input.apiPost || api.post;
  const path = `/api/rooms/${input.roomId}/patches/${input.patchId}/${input.action}`;
  await apiPost(path, input.action === "reject" ? { reason: input.rejectReason || "Rejected from co-od TUI" } : undefined);
}

export interface TuiServerUndoRestoreResult {
  ok: boolean;
  changed: TuiServerUndoChange[];
  error?: string;
  message: string;
}

export async function restoreServerUndoChanges(input: {
  changes: TuiServerUndoChange[];
  apiPost?: <T = unknown>(path: string, body?: unknown) => Promise<T>;
}): Promise<TuiServerUndoRestoreResult> {
  if (input.changes.length === 0) {
    return { ok: true, changed: [], message: "No server changes to restore." };
  }

  const apiPost = input.apiPost || api.post;
  const changed: TuiServerUndoChange[] = [];
  try {
    for (const change of input.changes) {
      if (change.kind !== "patch-reopen") {
        throw new Error(`Unsupported server undo change: ${change.kind}`);
      }
      await apiPost(`/api/rooms/${change.roomId}/patches/${change.patchId}/reopen`, {
        reason: "Reopened by co-od TUI undo",
      });
      changed.push(change);
    }
    return {
      ok: true,
      changed,
      message: `Restored ${changed.length} server change${changed.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    return {
      ok: false,
      changed,
      error: error instanceof Error ? error.message : String(error),
      message: `Server undo failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadTuiDashboardState(options: TuiDashboardLoadOptions): Promise<TuiDashboardState> {
  if (options.server) {
    process.env.CO_ODE_SERVER = options.server;
  }

  const getSession = options.getSession || api.getSession;
  const getBaseUrl = options.getBaseUrl || api.getBaseUrl;
  const config = readProjectConfig(options.dir, options.roomId);
  const session = getSession();
  const [bridge, providers, serviceHealth, herdr] = await Promise.all([
    bridgeHealth(options.fetchImpl),
    availableProviders(options.adapterAvailable),
    fetchServiceHealth(getBaseUrl(), options.fetchImpl),
    (options.loadHerdrAgents || loadHerdrAgents)(),
  ]);
  const providerAuth = checkAllProviderAuth().map(({ provider, label, status }) => ({ provider, label, status }));

  const provider = resolveDashboardProvider({
    argProvider: options.provider,
    configProvider: config?.provider,
    providerAvailability: providers,
    previousProvider: options.previousProvider,
  });

  let dashboard: DashboardData = {
    agents: [],
    runs: [],
    messages: [],
    services: serviceHealth.services,
    checkedAt: serviceHealth.checkedAt,
  };
  let rooms: RoomRecord[] = [];
  let roomsError: string | undefined;
  let message = "Ready.";

  let identity: SessionIdentity | undefined;
  if (session) {
    const apiGet = options.apiGet || api.get;
    const [roomsData, identityData] = await Promise.all([
      loadRoomsData({ apiGet: options.apiGet }),
      apiGet<{ user?: { workosUserId?: string; name?: string } }>("/api/auth/session").catch(() => null),
    ]);
    rooms = roomsData.rooms;
    roomsError = roomsData.error;
    if (identityData?.user) {
      identity = { workosUserId: identityData.user.workosUserId, name: identityData.user.name };
    }
  }

  if (!config) {
    message = "No .co-od.json here yet. Initialize a room first.";
  } else if (!session) {
    message = "Not logged in. Login before running room actions.";
  } else {
    const roomData = await loadRoomDashboardData({
      roomId: config.roomId,
      apiGet: options.apiGet,
    });
    dashboard = {
      ...dashboard,
      agents: roomData.agents,
      runs: roomData.runs,
      messages: roomData.messages,
      patches: roomData.patches,
      presence: roomData.presence,
      error: roomData.error,
    };
    message = roomData.error
      ? (/\b401\b|unauthorized/i.test(roomData.error)
          ? "signed out — run  co-od login  to bring your agents"
          : `couldn't load the room — ${roomData.error}`)
      : `Room refreshed: ${dashboard.agents.length} agents, ${dashboard.runs.length} recent tasks.`;
  }

  if (herdr.agents.length > 0) {
    dashboard = {
      ...dashboard,
      agents: mergeAgentRecords(dashboard.agents, herdr.agents),
    };
    message = appendHerdrMessage(message, herdr.agents.length);
  }

  return {
    config,
    session,
    bridge,
    providerAvailability: providers,
    providerAuth,
    identity,
    dashboard,
    rooms,
    roomsError,
    provider,
    message,
  };
}

function mergeAgentRecords(roomAgents: AgentRecord[], externalAgents: AgentRecord[]): AgentRecord[] {
  const seen = new Set(roomAgents.map((agent) => agent._id));
  const merged = [...roomAgents];
  for (const agent of externalAgents) {
    if (seen.has(agent._id)) continue;
    seen.add(agent._id);
    merged.push(agent);
  }
  return merged;
}

function appendHerdrMessage(message: string, count: number): string {
  const label = `${count} Herdr pane${count === 1 ? "" : "s"}`;
  if (!message || message === "Ready.") return `${label} detected.`;
  return `${message} ${label} detected.`;
}
