// Codex app-server client — the persistent JSON-RPC daemon the Codex IDE
// extension uses (`codex app-server`). One process serves every prompt, so
// MCP servers initialize once instead of on every `codex exec`, threads
// continue natively (no `exec resume` flags), and turns stream deltas.
//
// Protocol (newline-delimited JSON-RPC over stdio, verified against
// `codex app-server generate-ts` bindings for codex 0.137):
//   initialize → thread/start | thread/resume → turn/start
//   notifications: item/agentMessage/delta, item/completed, turn/completed
//
// The exec path stays as fallback — if the daemon can't start or a turn
// fails to dispatch, callers fall back to `codex exec`.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import {
  codexWorkspaceDynamicTools,
  invokeWorkspaceTool,
  type HarnessWorkspaceAccess,
} from "../workspace-tools.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => unknown | Promise<unknown> | undefined;

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_INTERRUPT_TIMEOUT_MS = 10_000;
const MCP_STARTUP_TIMEOUT_MS = 15_000;
const MCP_STARTUP_QUIET_MS = 750;

/** A coding turn gets a generous hard deadline, but never runs forever. */
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 30 * 60_000;

export class CodexAppServerTurnTerminatedError extends Error {
  readonly dispatched = true;

  constructor(
    message: string,
    readonly code: "codex_turn_timeout" | "codex_turn_cancelled" | "codex_turn_dispatch_failed",
  ) {
    super(message);
    this.name = "CodexAppServerTurnTerminatedError";
  }
}

export interface CodexAppServerClientOptions {
  /**
   * Room turns keep co·ode's explicit process environment while Codex loads
   * the user's normal plugins, skills, and MCP servers from CODEX_HOME.
   */
  environment?: NodeJS.ProcessEnv;
}

export class CodexAppServerClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private handlers = new Set<NotificationHandler>();
  private requestHandlers = new Set<ServerRequestHandler>();
  private activeThreads = new Map<string, string>();
  private starting?: Promise<void>;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  /** Spawn + initialize once; concurrent callers share the same handshake. */
  ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return this.starting || Promise.resolve();
    this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.environment ?? process.env,
    });
    child.unref();
    this.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    child.stderr?.resume(); // drain — codex logs MCP noise here
    child.on("close", () => {
      const error = new Error("codex app-server exited");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.activeThreads.clear();
      if (this.child === child) {
        this.child = undefined;
        this.starting = undefined;
      }
    });
    child.on("error", () => {
      // Surfaced through the close handler / pending rejections.
    });

    await this.request("initialize", {
      clientInfo: { name: "co-od", title: "co-od", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === "number" && this.pending.has(id) && !("method" in message)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (message.error) {
        const detail = (message.error as { message?: string })?.message || JSON.stringify(message.error);
        pending.reject(new Error(detail));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      if (id !== undefined) {
        const params = (message.params as Record<string, unknown>) || {};
        for (const handler of this.requestHandlers) {
          let result: unknown | Promise<unknown> | undefined;
          try {
            result = handler(message.method, params);
          } catch (error) {
            this.respondToServerRequest(id, undefined, error);
            return;
          }
          if (result === undefined) continue;
          void Promise.resolve(result).then(
            (value) => this.respondToServerRequest(id, value),
            (error) => this.respondToServerRequest(id, undefined, error),
          );
          return;
        }
        // Approval requests remain denied. Only explicitly registered,
        // run-scoped dynamic tools are handled by this client.
        this.respondToServerRequest(
          id,
          undefined,
          Object.assign(new Error("co·ode declines interactive requests"), { code: -32601 }),
        );
        return;
      }
      const params = (message.params as Record<string, unknown>) || {};
      if (message.method === "thread/closed" || message.method === "thread/archived") {
        const threadId = params.threadId;
        if (typeof threadId === "string") this.activeThreads.delete(threadId);
      }
      for (const handler of this.handlers) handler(message.method, params);
    }
  }

  private respondToServerRequest(
    id: unknown,
    result?: unknown,
    error?: unknown,
  ): void {
    if (!this.child?.stdin?.writable) return;
    const failure = error as { code?: number; message?: string } | undefined;
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(failure ? {
        error: {
          code: typeof failure.code === "number" ? failure.code : -32000,
          message: String(failure.message || "co·ode tool request failed").slice(0, 2_000),
        },
      } : { result }),
    })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin?.writable) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex app-server: ${method} timed out`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin?.writable) {
      throw new Error("codex app-server is not running");
    }
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onRequest(handler: ServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  markThreadActive(threadId: string, runtimeSignature: string): void {
    this.activeThreads.set(threadId, runtimeSignature);
  }

  isThreadActive(threadId: string, runtimeSignature: string): boolean {
    return this.activeThreads.get(threadId) === runtimeSignature;
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
    this.activeThreads.clear();
    this.starting = undefined;
  }
}

let shared: CodexAppServerClient | undefined;

export function getCodexAppServer(
  environment?: NodeJS.ProcessEnv,
): CodexAppServerClient {
  if (!shared) {
    shared = new CodexAppServerClient(
      environment ? { environment } : undefined,
    );
    // The daemon must never outlive the CLI.
    process.once("exit", () => shared?.dispose());
  }
  return shared;
}

export function disposeCodexAppServer(): void {
  shared?.dispose();
  shared = undefined;
}

export interface AppServerTurnOptions {
  workDir: string;
  model?: string;
  effort?: string;
  speed?: "standard" | "fast";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  /** Resume an existing thread (native continuation). */
  threadId?: string;
  /** Fork `threadId` into a provider-native independent thread. */
  forkThread?: boolean;
  onDelta?: (
    text: string,
    message: {
      itemId?: string;
      phase?: "commentary" | "final_answer";
    },
  ) => void;
  /** Provider-authored reasoning summaries for live progress UI. Raw reasoning is never forwarded. */
  onReasoningSummaryDelta?: (
    text: string,
    summary: {
      itemId?: string;
      summaryIndex?: number;
    },
  ) => void;
  /** Thread items, in app-server shape, with their real lifecycle phase. */
  onItem?: (item: Record<string, unknown>, phase: "started" | "completed") => void;
  client?: CodexAppServerClient;
  /**
   * Per-thread process environment overrides. The daemon stays warm while
   * short-lived Room capabilities remain scoped to the Codex thread.
   */
  environmentOverrides?: NodeJS.ProcessEnv;
  /** Override the generous default hard deadline for a coding turn. */
  turnTimeoutMs?: number;
  /** Cancels the provider turn rather than merely abandoning the local wait. */
  signal?: AbortSignal;
  /** Run-scoped co·ode automation and task tools. */
  workspaceAccess?: HarnessWorkspaceAccess;
}

export interface AppServerTurnResult {
  exitCode: number;
  finalMessage: string;
  threadId: string;
  errorMessage?: string;
}

export interface AppServerThreadOptions {
  workDir: string;
  model?: string;
  speed?: "standard" | "fast";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  /**
   * Wait for every configured MCP server to leave its startup state before
   * returning. Interactive prewarm callers should disable this: app-server can
   * begin a turn while optional MCP servers continue starting in parallel.
   */
  waitForMcpStartup?: boolean;
  client?: CodexAppServerClient;
  environmentOverrides?: NodeJS.ProcessEnv;
}

export interface AppServerPreparedThread {
  threadId: string;
  mcpStartupDurationMs: number;
}

export function codexThreadConfig(
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, unknown> | undefined {
  if (!environment) return undefined;
  const overrides = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => key.startsWith("CO_OD_") && value !== undefined,
    ),
  );
  if (Object.keys(overrides).length === 0) return undefined;
  return {
    shell_environment_policy: {
      inherit: "all",
      set: overrides,
    },
  };
}

/**
 * Keep only capability environment that Codex must expose to its shell.
 *
 * Room/task management is served through native dynamic tools. Passing its
 * short-lived capability, run id, and expiry through the thread environment
 * would change the thread signature on every Send and force app-server to
 * `thread/resume` before every turn. Attachments are already named in the
 * prompt, but retaining their environment keeps existing attachment-aware
 * skills compatible. The isolated browser still requires its scoped shell
 * capability, so browser turns intentionally refresh the thread runtime.
 */
export function codexPersistentThreadEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!environment) return undefined;
  const browserMode = environment.CO_OD_BROWSER_MODE;
  const overrides = Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => {
      if (value === undefined) return false;
      if (key.startsWith("CO_OD_ATTACHMENT_")) return true;
      if (!key.startsWith("CO_OD_BROWSER_")) return false;
      return key !== "CO_OD_BROWSER_MODE" || browserMode !== "none";
    }),
  );
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function codexPersistentThreadConfig(
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, unknown> | undefined {
  return codexThreadConfig(codexPersistentThreadEnvironment(environment));
}

function codexThreadRuntimeSignature(
  options: Pick<AppServerThreadOptions, "workDir" | "sandbox" | "approvalPolicy" | "environmentOverrides">,
): string {
  return JSON.stringify({
    cwd: resolvePath(options.workDir),
    sandbox: options.sandbox ?? "workspace-write",
    approvalPolicy: options.approvalPolicy ?? "never",
    config: codexPersistentThreadConfig(options.environmentOverrides),
  });
}

async function waitForCodexMcpStartup(
  threadId: string,
  observedByThread: Map<string, Map<string, string>>,
  lastUpdateByThread: Map<string, { value: number }>,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_STARTUP_TIMEOUT_MS) {
    const observed = observedByThread.get(threadId);
    const pending = [...(observed?.values() ?? [])]
      .some((status) => status === "starting");
    const quietFor = Date.now()
      - (lastUpdateByThread.get(threadId)?.value ?? startedAt);
    if (!pending && quietFor >= MCP_STARTUP_QUIET_MS) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, MCP_STARTUP_QUIET_MS)));
  }
  return Date.now() - startedAt;
}

/**
 * Opens the exact Codex thread a selected chat will use before its first turn.
 * Thread-scoped MCP/plugin startup therefore happens while the user is typing,
 * instead of after Send. A bounded wait settles ready and failed servers alike.
 */
export async function prepareCodexAppServerThread(
  options: AppServerThreadOptions,
): Promise<AppServerPreparedThread> {
  const server = options.client ?? getCodexAppServer();
  await server.ensureStarted();
  const threadConfig = codexPersistentThreadConfig(options.environmentOverrides);
  const shouldWaitForMcpStartup = options.waitForMcpStartup !== false;
  const observedMcpStatuses = new Map<string, Map<string, string>>();
  const lastMcpUpdates = new Map<string, { value: number }>();
  const off = shouldWaitForMcpStartup ? server.onNotification((method, params) => {
    if (method !== "mcpServer/startupStatus/updated") return;
    const notificationThreadId = params.threadId;
    if (typeof notificationThreadId !== "string") return;
    const name = params.name;
    const status = params.status;
    if (typeof name !== "string" || typeof status !== "string") return;
    const statuses = observedMcpStatuses.get(notificationThreadId) ?? new Map<string, string>();
    statuses.set(name, status);
    observedMcpStatuses.set(notificationThreadId, statuses);
    const lastUpdate = lastMcpUpdates.get(notificationThreadId) ?? { value: Date.now() };
    lastUpdate.value = Date.now();
    lastMcpUpdates.set(notificationThreadId, lastUpdate);
  }) : () => {};

  try {
    const started = await server.request("thread/start", {
      cwd: options.workDir,
      sandbox: options.sandbox ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "never",
      ...(options.model ? { model: options.model } : {}),
      ...(options.speed === "fast" ? { serviceTier: "fast" } : {}),
      ...(threadConfig ? { config: threadConfig } : {}),
      dynamicTools: codexWorkspaceDynamicTools(),
    }) as { thread?: { id?: string } };
    const preparedThreadId = started?.thread?.id;
    if (!preparedThreadId) {
      throw new Error("codex app-server did not return a prepared thread id");
    }
    server.markThreadActive(
      preparedThreadId,
      codexThreadRuntimeSignature(options),
    );
    const mcpStartupDurationMs = shouldWaitForMcpStartup
      ? await waitForCodexMcpStartup(
        preparedThreadId,
        observedMcpStatuses,
        lastMcpUpdates,
      )
      : 0;
    return { threadId: preparedThreadId, mcpStartupDurationMs };
  } finally {
    off();
  }
}

export async function runCodexAppServerTurn(
  goal: string,
  options: AppServerTurnOptions,
): Promise<AppServerTurnResult> {
  const server = options.client ?? getCodexAppServer();
  await server.ensureStarted();
  const threadConfig = codexPersistentThreadConfig(options.environmentOverrides);
  const runtimeSignature = codexThreadRuntimeSignature(options);

  let threadId = options.threadId;
  if (threadId && options.forkThread) {
    const forked = await server.request("thread/fork", {
      threadId,
      cwd: options.workDir,
      sandbox: options.sandbox ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "never",
      ...(threadConfig ? { config: threadConfig } : {}),
    }) as { thread?: { id?: string } };
    threadId = forked?.thread?.id;
    if (!threadId) throw new Error("codex app-server did not return a forked thread id");
    server.markThreadActive(threadId, runtimeSignature);
  } else if (threadId && !server.isThreadActive(threadId, runtimeSignature)) {
    const resumed = await server.request("thread/resume", {
      threadId,
      cwd: options.workDir,
      sandbox: options.sandbox ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "never",
      ...(threadConfig ? { config: threadConfig } : {}),
    })
      .catch(() => null) as { thread?: { id?: string } } | null;
    threadId = resumed?.thread?.id || threadId;
    server.markThreadActive(threadId, runtimeSignature);
  }
  if (!threadId) {
    const started = await server.request("thread/start", {
      cwd: options.workDir,
      sandbox: options.sandbox ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "never",
      ...(options.model ? { model: options.model } : {}),
      ...(options.speed === "fast" ? { serviceTier: "fast" } : {}),
      ...(threadConfig ? { config: threadConfig } : {}),
      dynamicTools: codexWorkspaceDynamicTools(),
    }) as { thread?: { id?: string } };
    threadId = started?.thread?.id;
    if (threadId) server.markThreadActive(threadId, runtimeSignature);
  }
  if (!threadId) throw new Error("codex app-server did not return a thread id");

  return await new Promise<AppServerTurnResult>((resolve, reject) => {
    let finalMessage = "";
    let settled = false;
    let turnId: string | undefined;
    const messagePhases = new Map<string, "commentary" | "final_answer">();
    const timeoutMs = options.turnTimeoutMs ?? DEFAULT_CODEX_TURN_TIMEOUT_MS;
    let timeout: NodeJS.Timeout | undefined;
    let off = () => {};
    let offRequest = () => {};

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortTurn);
      off();
      offRequest();
    };

    const terminate = async (
      error: CodexAppServerTurnTerminatedError,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (turnId) {
        await server.request("turn/interrupt", {
          threadId,
          turnId,
        }, TURN_INTERRUPT_TIMEOUT_MS).catch(() => {});
      }
      reject(error);
    };

    const abortTurn = () => {
      void terminate(new CodexAppServerTurnTerminatedError(
        "Codex turn was cancelled.",
        "codex_turn_cancelled",
      ));
    };

    off = server.onNotification((method, params) => {
      if (settled) return;
      if ((params.threadId as string | undefined) !== threadId) return;
      if (method === "item/agentMessage/delta") {
        const itemId = params.itemId as string | undefined;
        options.onDelta?.((params.delta as string) || "", {
          itemId,
          phase: itemId ? messagePhases.get(itemId) : undefined,
        });
        return;
      }
      if (method === "item/reasoning/summaryTextDelta") {
        options.onReasoningSummaryDelta?.((params.delta as string) || "", {
          itemId: params.itemId as string | undefined,
          summaryIndex: typeof params.summaryIndex === "number"
            ? params.summaryIndex
            : undefined,
        });
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) return;
        const phase = method === "item/started" ? "started" : "completed";
        if (item.type === "agentMessage" && typeof item.id === "string") {
          const messagePhase = item.phase;
          if (messagePhase === "commentary" || messagePhase === "final_answer") {
            messagePhases.set(item.id, messagePhase);
          }
        }
        if (phase === "completed" && item.type === "agentMessage" && typeof item.text === "string") {
          finalMessage = item.text;
        }
        options.onItem?.(item, phase);
        return;
      }
      if (method === "turn/completed") {
        settled = true;
        cleanup();
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
        const failed = turn?.status === "failed" || turn?.status === "interrupted";
        resolve({
          exitCode: failed ? 1 : 0,
          finalMessage,
          threadId: threadId!,
          errorMessage: failed
            ? turn?.error?.message || (turn?.status === "interrupted" ? "turn interrupted" : "turn failed")
            : undefined,
        });
      }
    });

    offRequest = server.onRequest((method, params) => {
      if (method !== "item/tool/call" || !options.workspaceAccess) return undefined;
      if ((params.threadId as string | undefined) !== threadId) return undefined;
      if ((params.namespace as string | null | undefined) !== "coode") return undefined;
      const tool = typeof params.tool === "string" ? params.tool : "";
      const argumentsValue = params.arguments;
      const args = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
        ? argumentsValue as Record<string, unknown>
        : {};
      return invokeWorkspaceTool(options.workspaceAccess, tool, args).then(
        (value) => ({
          contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
          success: true,
        }),
        (error) => ({
          contentItems: [{
            type: "inputText",
            text: String((error as Error)?.message || "The co·ode workspace action failed.").slice(0, 2_000),
          }],
          success: false,
        }),
      );
    });

    if (options.signal?.aborted) {
      abortTurn();
      return;
    }
    options.signal?.addEventListener("abort", abortTurn, { once: true });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        void terminate(new CodexAppServerTurnTerminatedError(
          `Codex turn exceeded the ${Math.ceil(timeoutMs / 60_000)} minute safety limit and was stopped. Retry to continue from the saved working tree.`,
          "codex_turn_timeout",
        ));
      }, timeoutMs);
    }

    server.request("turn/start", {
      threadId,
      input: [{ type: "text", text: goal }],
      cwd: options.workDir,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.speed === "fast" ? { serviceTier: "fast" } : {}),
      summary: "concise",
      approvalPolicy: options.approvalPolicy ?? "never",
    }).then((result) => {
      turnId = (result as { turn?: { id?: string } })?.turn?.id;
      if (!turnId && !settled) {
        void terminate(new CodexAppServerTurnTerminatedError(
          "Codex accepted the turn but did not return a turn identifier.",
          "codex_turn_dispatch_failed",
        ));
      }
    }).catch((error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CodexAppServerTurnTerminatedError(
        `Codex could not start the turn: ${error.message}`,
        "codex_turn_dispatch_failed",
      ));
    });
  });
}

/** One metered window from the provider's account limits. */
export interface HarnessUsageWindow {
  /** Percentage of the window already consumed, 0–100. */
  usedPercent: number;
  /** Length of the metered window in minutes. */
  windowDurationMins?: number;
  /** Unix seconds when the window resets. */
  resetsAt?: number;
}

/**
 * Remaining account capacity for a provider, when it reports one.
 *
 * How much of your plan is left is the fact that decides whether to start a
 * long run now or wait. Installed plugin and skill counts, by contrast, do not
 * change any decision a person makes at the moment they pick an agent.
 */
export interface HarnessUsageLimits {
  /** Provider plan identifier, such as "pro". */
  planType?: string;
  /** The window a person is usually rationing, typically weekly. */
  primary?: HarnessUsageWindow;
  /** A shorter secondary window, when the provider meters one. */
  secondary?: HarnessUsageWindow;
}

/**
 * Human label for a metered window, derived from its length.
 *
 * Providers meter a short rolling window and a longer one — commonly 5h and 7d.
 * Naming them by duration keeps the label true for any provider instead of
 * hardcoding one vendor's wording.
 */
export function harnessUsageWindowLabel(
  window: HarnessUsageWindow | undefined,
): string | undefined {
  const minutes = window?.windowDurationMins;
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function usageWindow(value: unknown): HarnessUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const window = value as Record<string, unknown>;
  const usedPercent = Number(window.usedPercent);
  if (!Number.isFinite(usedPercent)) return undefined;
  return {
    // The provider reports whole percentages; clamp so a stale or unexpected
    // value can never render as a negative or overfull ring.
    usedPercent: Math.min(100, Math.max(0, Math.round(usedPercent))),
    windowDurationMins: Number.isFinite(Number(window.windowDurationMins))
      ? Number(window.windowDurationMins)
      : undefined,
    resetsAt: Number.isFinite(Number(window.resetsAt))
      ? Number(window.resetsAt)
      : undefined,
  };
}

/**
 * Reads the Codex account's current rate limits.
 *
 * Returns undefined rather than throwing when the provider is signed out or the
 * running CLI predates the method, so a missing limit is simply not shown.
 */
export async function readCodexUsageLimits(
  client?: CodexAppServerClient,
): Promise<HarnessUsageLimits | undefined> {
  const server = client ?? getCodexAppServer();
  try {
    await server.ensureStarted();
    const response = await server.request("account/rateLimits/read", {}) as
      Record<string, unknown> | undefined;
    const limits = response?.rateLimits as Record<string, unknown> | undefined;
    if (!limits) return undefined;
    const primary = usageWindow(limits.primary);
    const secondary = usageWindow(limits.secondary);
    if (!primary && !secondary) return undefined;
    return {
      planType: typeof limits.planType === "string" ? limits.planType : undefined,
      primary,
      secondary,
    };
  } catch {
    return undefined;
  }
}

/** A model the provider reports it can run right now. */
export interface HarnessProviderModel {
  id: string;
  displayName: string;
  /** Reasoning effort identifiers the provider accepts for this model. */
  supportedEfforts: string[];
  defaultEffort?: string;
}

/**
 * Lists the models the Codex account can actually use.
 *
 * A hardcoded catalog is wrong the day a provider ships, and wrong about which
 * reasoning efforts exist. Returns undefined when the provider cannot answer so
 * callers keep their built-in list rather than showing an empty picker.
 */
export async function readCodexModels(
  client?: CodexAppServerClient,
): Promise<HarnessProviderModel[] | undefined> {
  const server = client ?? getCodexAppServer();
  try {
    await server.ensureStarted();
    const response = await server.request("model/list", {}) as
      Record<string, unknown> | undefined;
    const data = response?.data;
    if (!Array.isArray(data)) return undefined;
    const models = data.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === "string" ? model.id : "";
      // A hidden model is one the provider does not want offered.
      if (!id || model.hidden === true) return [];
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.flatMap((effort) => {
          const value = effort && typeof effort === "object"
            ? (effort as Record<string, unknown>).reasoningEffort
            : effort;
          return typeof value === "string" && value ? [value] : [];
        })
        : [];
      return [{
        id,
        displayName: typeof model.displayName === "string" && model.displayName
          ? model.displayName
          : id,
        supportedEfforts: efforts,
        defaultEffort: typeof model.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort
          : undefined,
      }];
    });
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}
