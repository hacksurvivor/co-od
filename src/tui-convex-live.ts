// Native Convex subscriptions for the TUI — the backend's actual superpower.
// Instead of polling (or asking an SSE route to poll for us), the client
// subscribes to the queries it renders and Convex pushes every change the
// moment it commits. Auth rides in the query args (`userToken`, the same
// app-session JWT the CLI already holds), matching the backend's
// INTERNAL_AUTH convention.
//
// Liveness ladder: convex subscriptions (this) → SSE stream → 6s poll.
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export interface ConvexLiveHandlers {
  onMessages?: (messages: unknown[]) => void;
  onRuns?: (runs: unknown[]) => void;
  onAgents?: (agents: unknown[]) => void;
  onPatches?: (patches: unknown[]) => void;
  onPresence?: (presence: unknown[]) => void;
  /** Connection state changes — drives the fallback ladder. */
  onHealthy?: (healthy: boolean) => void;
}

const QUERIES = {
  onMessages: makeFunctionReference<"query">("messages:list"),
  onRuns: makeFunctionReference<"query">("agentRuns:list"),
  onAgents: makeFunctionReference<"query">("agents:list"),
  onPatches: makeFunctionReference<"query">("patches:list"),
  onPresence: makeFunctionReference<"query">("presence:list"),
} as const;

export class ConvexLiveSession {
  private client?: ConvexClient;
  private unsubscribers: Array<() => void> = [];
  private healthy = false;

  constructor(
    private readonly convexUrl: string,
    private readonly userToken: string,
    private readonly handlers: ConvexLiveHandlers,
  ) {}

  /** Subscribe every room query; safe to call again for a room switch. */
  subscribe(roomId: string): void {
    this.unsubscribeAll();
    if (!this.client) {
      this.client = new ConvexClient(this.convexUrl);
    }
    const args = { roomId, userToken: this.userToken };
    for (const [key, query] of Object.entries(QUERIES) as Array<[
      keyof typeof QUERIES,
      ReturnType<typeof makeFunctionReference<"query">>,
    ]>) {
      const handler = this.handlers[key];
      if (!handler) continue;
      const unsubscribe = this.client.onUpdate(
        query,
        args,
        (result: unknown) => {
          if (!Array.isArray(result)) return;
          this.markHealthy(true);
          (handler as (rows: unknown[]) => void)(result);
        },
        () => {
          // Per-query error (auth, missing function on older deployments).
          // One failing query shouldn't kill the rest; overall health is
          // judged by whether anything delivers.
        },
      );
      this.unsubscribers.push(unsubscribe);
    }
  }

  private markHealthy(value: boolean): void {
    if (this.healthy === value) return;
    this.healthy = value;
    this.handlers.onHealthy?.(value);
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  private unsubscribeAll(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Already torn down.
      }
    }
  }

  close(): void {
    this.unsubscribeAll();
    void this.client?.close();
    this.client = undefined;
    this.markHealthy(false);
  }
}

/**
 * Resolve the Convex URL for direct subscriptions: explicit env first, then
 * the web API (present once the runtime-config endpoint is deployed).
 * Null means "no direct path" — callers stay on SSE/poll.
 */
export async function resolveConvexUrl(
  apiGet: <T>(path: string) => Promise<T>,
): Promise<string | null> {
  if (process.env.CO_OD_CONVEX_URL) return process.env.CO_OD_CONVEX_URL;
  try {
    const config = await apiGet<{ ok?: boolean; convexUrl?: string | null }>("/api/runtime-config");
    return config?.convexUrl || null;
  } catch {
    return null;
  }
}
