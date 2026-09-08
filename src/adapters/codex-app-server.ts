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
import { managedIntegrationRuntime, codexManagedIntegrationConfig, type ManagedIntegrationRuntime } from "./managed-integrations.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { resolveCodexExecutable } from "./codex-executable.js";
import {
  codexWorkspaceDynamicTools,
  invokeWorkspaceTool,
  type HarnessWorkspaceAccess,
} from "../workspace-tools.js";
import {
  boundedActivityPayload,
  existingAttachmentPaths,
  providerProcessEnvironment,
  type ExecuteOptions,
  type HarnessNativeReviewRequest,
  type HarnessPermissionDecision,
  type HarnessPermissionRequest,
  type HarnessRuntimeControl,
} from "./base.js";

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

/** Native turns run until completion or cancellation; callers may select a deadline. */
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 0;

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
  managedIntegrations?: ManagedIntegrationRuntime;
}

export class CodexAppServerClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private handlers = new Set<NotificationHandler>();
  private requestHandlers = new Set<ServerRequestHandler>();
  private activeThreads = new Map<string, string>();
  private starting?: Promise<void>;
  private uses = 0;
  private retired = false;
  managedIntegrationConfig?: Record<string, unknown>;

  beginUse(): void { this.uses += 1; }
  endUse(): void {
    this.uses = Math.max(0, this.uses - 1);
    if (this.retired && this.uses === 0) { this.dispose(); retiring.delete(this); }
  }
  retire(): boolean {
    this.retired = true;
    if (this.uses === 0) { this.dispose(); return false; }
    return true;
  }

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  /** Spawn + initialize once; concurrent callers share the same handshake. */
  ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.starting || Promise.resolve();
    }
    if (this.child) {
      this.failChild(this.child, new Error("codex app-server exited before restart"));
    }
    const starting = this.start();
    this.starting = starting;
    void starting.catch((error) => {
      if (this.starting === starting) {
        const child = this.child;
        if (child) { this.failChild(child, error instanceof Error ? error : new Error(String(error))); child.kill(); }
        this.starting = undefined;
      }
    });
    return starting;
  }

  private failChild(child: ChildProcess, error: Error): void {
    // A stale process can close after a replacement has already started. It
    // must never reject requests belonging to the replacement.
    if (this.child !== child) return;
    this.child = undefined;
    this.starting = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.activeThreads.clear();
  }

  private writeLine(child: ChildProcess, line: string, context: string): boolean {
    const input = child.stdin;
    if (!input?.writable || child.killed || child.exitCode !== null) {
      this.failChild(child, new Error(`codex app-server ${context} failed: process is not writable`));
      return false;
    }

    const fail = (cause: unknown): void => {
      const detail = cause instanceof Error ? cause.message : String(cause || "unknown write error");
      this.failChild(child, new Error(`codex app-server ${context} failed: ${detail}`));
    };
    try {
      input.write(line, (error) => {
        if (error) fail(error);
      });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  private async start(): Promise<void> {
    const environment = this.options.environment ?? process.env;
    const child = spawn(resolveCodexExecutable(environment) || "codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    child.unref();
    this.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    child.stderr?.resume(); // drain — codex logs MCP noise here
    child.on("close", () => {
      this.failChild(child, new Error("codex app-server exited"));
    });
    child.on("error", (error) => {
      this.failChild(child, new Error(`codex app-server process failed: ${error.message}`));
    });
    // Writable streams emit their own `error` event. Without a listener, a
    // provider that exits between the writability check and write() can crash
    // the whole Relay with an uncaught EPIPE instead of activating exec fallback.
    child.stdin?.on("error", (error) => {
      this.failChild(child, new Error(`codex app-server write failed: ${error.message}`));
    });

    await this.request("initialize", {
      clientInfo: { name: "co-od", title: "co-od", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
        extensions: {
          "openai/form": {},
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    });
    this.notify("initialized");
    if (this.options.managedIntegrations) {
      const config = await this.request("config/read", { includeLayers: false }) as { config?: Record<string, unknown> };
      this.managedIntegrationConfig = codexManagedIntegrationConfig(this.options.managedIntegrations, config.config || {});
      await this.request("skills/extraRoots/set", { extraRoots: this.options.managedIntegrations.skillRoots });
    }
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
    const child = this.child;
    if (!child?.stdin?.writable) return;
    const failure = error as { code?: number; message?: string } | undefined;
    this.writeLine(child, `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(failure ? {
        error: {
          code: typeof failure.code === "number" ? failure.code : -32000,
          message: String(failure.message || "co·ode tool request failed").slice(0, 2_000),
        },
      } : { result }),
    })}\n`, "response write");
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
      this.writeLine(
        child,
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        `${method} request write`,
      );
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin?.writable) {
      throw new Error("codex app-server is not running");
    }
    this.writeLine(
      child,
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
      `${method} notification write`,
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
    const child = this.child;
    if (child) {
      this.failChild(child, new Error("codex app-server disposed"));
      child.kill();
    } else {
      this.activeThreads.clear();
      this.starting = undefined;
    }
  }
}

let shared: CodexAppServerClient | undefined;
let sharedIntegrationSignature: string | undefined;
const retiring = new Set<CodexAppServerClient>();
let registeredExit = false;

export function getCodexAppServer(environment?: NodeJS.ProcessEnv): CodexAppServerClient {
  // Integration ownership is evaluated by co-od before its private control
  // environment is scrubbed from the provider child.
  const managedEnvironment = environment?.COODE_MANAGED_INTEGRATIONS_PATH ? environment : process.env;
  const managedIntegrations = managedIntegrationRuntime("codex", managedEnvironment);
  if (!shared || sharedIntegrationSignature !== managedIntegrations?.signature) {
    if (shared?.retire()) retiring.add(shared);
    shared = new CodexAppServerClient({ environment: providerProcessEnvironment({ provider: "codex" }, environment ?? process.env), managedIntegrations });
    sharedIntegrationSignature = managedIntegrations?.signature;
    if (!registeredExit) {
      registeredExit = true;
      process.once("exit", disposeCodexAppServer);
    }
  }
  return shared;
}

export function disposeCodexAppServer(): void {
  shared?.dispose();
  for (const client of retiring) client.dispose();
  retiring.clear();
  shared = undefined;
  sharedIntegrationSignature = undefined;
}

/** Omission inherits Codex settings; Standard must explicitly clear Fast. */
export function codexServiceTier(speed: "standard" | "fast" | undefined): "default" | "fast" | undefined {
  return speed === "standard" ? "default" : speed;
}

export interface AppServerTurnOptions {
  workDir: string;
  model?: string;
  attachments?: ExecuteOptions["attachments"];
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
  onItem?: (
    item: Record<string, unknown>,
    phase: "started" | "completed",
    context?: {
      threadId: string;
      parentThreadId?: string;
      isSubagent: boolean;
    },
  ) => void;
  client?: CodexAppServerClient;
  /**
   * Per-thread process environment overrides. The daemon stays warm while
   * short-lived Room capabilities remain scoped to the Codex thread.
   */
  environmentOverrides?: NodeJS.ProcessEnv;
  /** Optional caller-selected deadline; zero leaves the native turn unbounded. */
  turnTimeoutMs?: number;
  /** Cancels the provider turn rather than merely abandoning the local wait. */
  signal?: AbortSignal;
  /** Run-scoped co·ode automation and task tools. */
  workspaceAccess?: HarnessWorkspaceAccess;
  /** Bridge native App Server approval requests into the co·ode policy/UI. */
  permissionMode?: ExecuteOptions["permissionMode"];
  onPermissionRequest?: (
    request: HarnessPermissionRequest,
  ) => HarnessPermissionDecision | Promise<HarnessPermissionDecision>;
  /** Dispatch through `review/start` instead of a normal turn. */
  nativeReview?: HarnessNativeReviewRequest;
  /** Exposes same-turn controls only after App Server returns the active turn id. */
  onRuntimeControl?: (control: HarnessRuntimeControl | undefined) => void;
  /** Exact local event evidence; never copy payloads into the Room ledger. */
  onRawEvent?: ExecuteOptions["onRawEvent"];
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

const commandApprovalDecisions = ["accept", "acceptForSession", "decline", "cancel"] as const;
type CommandApprovalDecision = typeof commandApprovalDecisions[number];

const approvalOption = (decision: CommandApprovalDecision) => ({
  id: decision,
  name: decision === "accept" ? "Allow once"
    : decision === "acceptForSession" ? "Allow for this session"
      : decision === "cancel" ? "Deny and stop turn"
        : "Deny",
  kind: decision === "accept" ? "allow_once" as const
    : decision === "acceptForSession" ? "allow_always" as const
      : decision === "cancel" ? "reject_always" as const
        : "reject_once" as const,
});

/** Convert the current App Server approval requests into the shared v1 shape. */
export function codexPermissionRequest(
  method: string,
  params: Record<string, unknown>,
): HarnessPermissionRequest | undefined {
  const supported = method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "mcpServer/elicitation/request";
  if (!supported) return undefined;
  const threadID = typeof params.threadId === "string" ? params.threadId : "";
  const itemID = typeof params.approvalId === "string"
    ? params.approvalId
    : typeof params.itemId === "string" ? params.itemId
      : typeof params.elicitationId === "string" ? params.elicitationId
        : method === "mcpServer/elicitation/request"
          ? `mcp:${createHash("sha256").update(JSON.stringify({
            serverName: params.serverName,
            turnId: params.turnId,
            mode: params.mode,
            message: params.message,
            requestedSchema: params.requestedSchema,
            url: params.url,
          })).digest("hex").slice(0, 24)}`
          : "";
  if (!threadID || !itemID) return undefined;
  if (method === "item/permissions/requestApproval") {
    const permissions = params.permissions && typeof params.permissions === "object"
      ? params.permissions as Record<string, unknown>
      : {};
    const network = permissions.network && typeof permissions.network === "object"
      ? permissions.network as Record<string, unknown>
      : undefined;
    return {
      sessionID: threadID,
      toolCallID: itemID,
      title: typeof params.reason === "string" ? params.reason : "Grant additional sandbox permissions",
      tool: "permission_profile",
      kind: "permission",
      scope: network?.enabled === true ? "externalAction" : "workspace",
      input: boundedActivityPayload({
        permissions,
        ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      }),
      options: [
        { id: "grantTurn", name: "Allow for this turn", kind: "allow_once" },
        { id: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    const mode = typeof params.mode === "string" ? params.mode : "form";
    const requestedSchema = params.requestedSchema
      && typeof params.requestedSchema === "object"
      && !Array.isArray(params.requestedSchema)
      ? params.requestedSchema as Record<string, unknown>
      : undefined;
    const url = mode === "url" && typeof params.url === "string"
      && /^https:\/\//i.test(params.url) ? params.url.slice(0, 4_096) : undefined;
    return {
      sessionID: threadID,
      toolCallID: itemID,
      title: typeof params.message === "string" ? params.message : "MCP server requests input",
      tool: typeof params.serverName === "string" ? params.serverName : "mcp",
      kind: "elicitation",
      scope: "externalAction",
      ...(requestedSchema ? { requestedSchema } : {}),
      ...(url ? { url } : {}),
      input: boundedActivityPayload({
        mode: params.mode,
        requestedFields: requestedSchema?.properties
          && typeof requestedSchema.properties === "object"
          && !Array.isArray(requestedSchema.properties)
          ? Object.keys(requestedSchema.properties as Record<string, unknown>).slice(0, 100)
          : [],
      }),
      options: [
        { id: "accept", name: mode === "url" ? "Continue" : "Submit", kind: "allow_once" },
        { id: "decline", name: "Decline", kind: "reject_once" },
        { id: "cancel", name: "Cancel turn", kind: "reject_always" },
      ],
    };
  }
  const command = typeof params.command === "string" ? params.command : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((candidate): candidate is CommandApprovalDecision =>
      typeof candidate === "string"
      && commandApprovalDecisions.includes(candidate as CommandApprovalDecision)
    )
    : [...commandApprovalDecisions];
  const decisions = available.length > 0 ? available : ["decline" as const];
  return {
    sessionID: threadID,
    toolCallID: itemID,
    title: method === "item/fileChange/requestApproval"
      ? reason || "Apply file changes"
      : reason || command || "Run command",
    tool: method === "item/fileChange/requestApproval" ? "file_change" : "command_execution",
    kind: method === "item/fileChange/requestApproval" ? "edit" : "execute",
    input: boundedActivityPayload({
      ...(command ? { command } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(reason ? { reason } : {}),
      ...(params.additionalPermissions ? { additionalPermissions: params.additionalPermissions } : {}),
    }),
    scope: "workspace",
    options: decisions.map(approvalOption),
  };
}

const elicitationOptions = (schema: Record<string, unknown>): string[] | undefined => {
  if (Array.isArray(schema.enum)) {
    return schema.enum.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((value) => value && typeof value === "object"
      && typeof (value as Record<string, unknown>).const === "string"
      ? [String((value as Record<string, unknown>).const)] : []);
  }
  const items = schema.items && typeof schema.items === "object"
    ? schema.items as Record<string, unknown> : undefined;
  if (items && Array.isArray(items.enum)) {
    return items.enum.filter((value): value is string => typeof value === "string");
  }
  if (items && Array.isArray(items.anyOf)) {
    return items.anyOf.flatMap((value) => value && typeof value === "object"
      && typeof (value as Record<string, unknown>).const === "string"
      ? [String((value as Record<string, unknown>).const)] : []);
  }
  return undefined;
};

/** Validate and bound typed MCP form content before it crosses back into App Server. */
export function validateMcpElicitationContent(
  schema: Record<string, unknown>,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (schema.type !== "object" || !content || Array.isArray(content)) return undefined;
  const properties = schema.properties && typeof schema.properties === "object"
    && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const result: Record<string, unknown> = {};
  for (const key of required) if (!(key in content)) return undefined;
  for (const [key, raw] of Object.entries(content)) {
    const property = properties[key];
    if (!property || typeof property !== "object" || Array.isArray(property)) return undefined;
    const definition = property as Record<string, unknown>;
    const type = definition.type;
    if (type === "string") {
      if (typeof raw !== "string") return undefined;
      if (Number.isFinite(Number(definition.minLength)) && raw.length < Number(definition.minLength)) return undefined;
      if (Number.isFinite(Number(definition.maxLength)) && raw.length > Number(definition.maxLength)) return undefined;
      const options = elicitationOptions(definition);
      if (options && !options.includes(raw)) return undefined;
      result[key] = raw.slice(0, 16_000);
    } else if (type === "number" || type === "integer") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      if (type === "integer" && !Number.isInteger(raw)) return undefined;
      if (Number.isFinite(Number(definition.minimum)) && raw < Number(definition.minimum)) return undefined;
      if (Number.isFinite(Number(definition.maximum)) && raw > Number(definition.maximum)) return undefined;
      result[key] = raw;
    } else if (type === "boolean") {
      if (typeof raw !== "boolean") return undefined;
      result[key] = raw;
    } else if (type === "array") {
      if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) return undefined;
      if (Number.isFinite(Number(definition.minItems)) && raw.length < Number(definition.minItems)) return undefined;
      if (Number.isFinite(Number(definition.maxItems)) && raw.length > Number(definition.maxItems)) return undefined;
      const options = elicitationOptions(definition);
      if (options && raw.some((value) => !options.includes(value))) return undefined;
      result[key] = raw.slice(0, 100).map((value) => value.slice(0, 4_096));
    } else {
      return undefined;
    }
  }
  return JSON.stringify(result).length <= 32 * 1_024 ? result : undefined;
}

export function codexPermissionDecision(
  request: HarnessPermissionRequest,
  mode: ExecuteOptions["permissionMode"],
): HarnessPermissionDecision {
  const matching = mode === "fullAccess"
    ? request.options.find((option) => option.kind === "allow_always")
      || request.options.find((option) => option.kind === "allow_once")
    : mode === "approve"
      ? request.options.find((option) => option.kind === "allow_once")
      : mode === "plan"
        ? request.options.find((option) => option.kind === "reject_always")
          || request.options.find((option) => option.kind === "reject_once")
        : request.options.find((option) => option.kind === "reject_once")
          || request.options.find((option) => option.kind === "reject_always");
  return matching
    ? { outcome: "selected", optionID: matching.id }
    : { outcome: "cancelled" };
}

async function codexApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  options: AppServerTurnOptions,
): Promise<Record<string, unknown> | undefined> {
  const request = codexPermissionRequest(method, params);
  if (!request) return undefined;
  const decision = options.signal?.aborted
    ? { outcome: "cancelled" as const }
    : options.onPermissionRequest
      ? await options.onPermissionRequest(request)
      : codexPermissionDecision(request, options.permissionMode);
  const selected = decision.outcome === "selected"
    ? request.options.find((option) => option.id === decision.optionID)
    : undefined;
  const nativeDecision = selected?.id;
  if (method === "item/permissions/requestApproval") {
    const granted = nativeDecision === "grantTurn"
      && params.permissions && typeof params.permissions === "object"
      ? params.permissions as Record<string, unknown>
      : {};
    return { permissions: granted, scope: "turn" };
  }
  if (method === "mcpServer/elicitation/request") {
    if (nativeDecision === "accept") {
      if (params.mode === "url") return { action: "accept", content: null, _meta: null };
      const schema = params.requestedSchema && typeof params.requestedSchema === "object"
        ? params.requestedSchema as Record<string, unknown> : undefined;
      const content = schema
        ? validateMcpElicitationContent(schema, decision.outcome === "selected" ? decision.content : undefined)
        : undefined;
      if (content) return { action: "accept", content, _meta: null };
    }
    return {
      action: nativeDecision === "cancel" ? "cancel" : "decline",
      content: null,
      _meta: null,
    };
  }
  if (nativeDecision && commandApprovalDecisions.includes(nativeDecision as CommandApprovalDecision)) {
    return { decision: nativeDecision as CommandApprovalDecision };
  }
  return { decision: request.options.some((option) => option.id === "decline") ? "decline" : "cancel" };
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
      ...(options.speed ? { serviceTier: codexServiceTier(options.speed) } : {}),
      ...((threadConfig || server.managedIntegrationConfig) ? { config: { ...threadConfig, ...server.managedIntegrationConfig } } : {}),
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
  server.beginUse?.();
  try { return await runCodexAppServerTurnWithClient(goal, { ...options, client: server }); }
  finally { server.endUse?.(); }
}

async function runCodexAppServerTurnWithClient(
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
      ...(options.speed ? { serviceTier: codexServiceTier(options.speed) } : {}),
      ...((threadConfig || server.managedIntegrationConfig) ? { config: { ...threadConfig, ...server.managedIntegrationConfig } } : {}),
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
      ...(options.speed ? { serviceTier: codexServiceTier(options.speed) } : {}),
      ...((threadConfig || server.managedIntegrationConfig) ? { config: { ...threadConfig, ...server.managedIntegrationConfig } } : {}),
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
      ...(options.speed ? { serviceTier: codexServiceTier(options.speed) } : {}),
      ...((threadConfig || server.managedIntegrationConfig) ? { config: { ...threadConfig, ...server.managedIntegrationConfig } } : {}),
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
    let activeThreadId = threadId;
    let runtimeControlPublished = false;
    const messagePhases = new Map<string, "commentary" | "final_answer">();
    // Codex runs delegated work in child threads. The app-server publishes
    // their tool notifications on the same connection, so retain the lineage
    // announced by the parent instead of dropping everything whose thread id
    // differs from the root turn.
    const subagentParents = new Map<string, string>();
    const timeoutMs = options.turnTimeoutMs ?? DEFAULT_CODEX_TURN_TIMEOUT_MS;
    let timeout: NodeJS.Timeout | undefined;
    let off = () => {};
    let offRequest = () => {};

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortTurn);
      if (runtimeControlPublished) {
        runtimeControlPublished = false;
        options.onRuntimeControl?.(undefined);
      }
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
          threadId: activeThreadId,
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
      const notificationThreadId = params.threadId as string | undefined;
      if (!notificationThreadId) return;
      const isRootThread = notificationThreadId === activeThreadId;
      const parentThreadId = subagentParents.get(notificationThreadId);
      if (!isRootThread && !parentThreadId) return;
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "protocol",
        payload: { method, params },
      });
      if (method === "item/agentMessage/delta") {
        if (!isRootThread) return;
        const itemId = params.itemId as string | undefined;
        options.onDelta?.((params.delta as string) || "", {
          itemId,
          phase: itemId ? messagePhases.get(itemId) : undefined,
        });
        return;
      }
      if (method === "item/reasoning/summaryTextDelta") {
        if (!isRootThread) return;
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
        // An admitted child can announce its own children. Only retain new
        // lineage from this turn's known tree; unrelated threads stay filtered
        // above, and repeated/cyclic announcements cannot reparent an agent.
        if (item.type === "subAgentActivity"
            && typeof item.agentThreadId === "string"
            && item.agentThreadId !== notificationThreadId
            && item.agentThreadId !== activeThreadId
            && !subagentParents.has(item.agentThreadId)) {
          subagentParents.set(item.agentThreadId, notificationThreadId!);
        }
        if (isRootThread && item.type === "agentMessage" && typeof item.id === "string") {
          const messagePhase = item.phase;
          if (messagePhase === "commentary" || messagePhase === "final_answer") {
            messagePhases.set(item.id, messagePhase);
          }
        }
        if (isRootThread
            && phase === "completed"
            && item.type === "agentMessage"
            && typeof item.text === "string") {
          finalMessage = item.text;
        }
        if (isRootThread
            && phase === "completed"
            && item.type === "exitedReviewMode"
            && typeof item.review === "string") {
          finalMessage = item.review;
        }
        options.onItem?.(item, phase, {
          threadId: notificationThreadId,
          ...(parentThreadId ? { parentThreadId } : {}),
          isSubagent: !isRootThread,
        });
        return;
      }
      if (method === "turn/completed") {
        if (!isRootThread) return;
        settled = true;
        cleanup();
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
        const failed = turn?.status === "failed" || turn?.status === "interrupted";
        resolve({
          exitCode: failed ? 1 : 0,
          finalMessage,
          threadId: activeThreadId!,
          errorMessage: failed
            ? turn?.error?.message || (turn?.status === "interrupted" ? "turn interrupted" : "turn failed")
            : undefined,
        });
      }
    });

    offRequest = server.onRequest((method, params) => {
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "protocol",
        payload: { method, params },
      });
      const approval = codexApprovalResponse(method, params, options);
      if (codexPermissionRequest(method, params)) return approval;
      if (method !== "item/tool/call" || !options.workspaceAccess) return undefined;
      if ((params.threadId as string | undefined) !== activeThreadId) return undefined;
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

    const dispatchMethod = options.nativeReview ? "review/start" : "turn/start";
    const dispatchParams = options.nativeReview
      ? {
        threadId,
        target: options.nativeReview.target,
        delivery: options.nativeReview.delivery ?? "detached",
      }
      : {
        threadId,
        input: [
          { type: "text", text: goal },
          ...existingAttachmentPaths(options.attachments, ["image"]).map((path) => ({ type: "localImage", path })),
        ],
        cwd: options.workDir,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.speed ? { serviceTier: codexServiceTier(options.speed) } : {}),
        summary: "concise",
        approvalPolicy: options.approvalPolicy ?? "never",
      };
    void options.onRawEvent?.({
      observedAt: new Date().toISOString(),
      direction: "coodeToProvider",
      channel: "protocol",
      payload: { method: dispatchMethod, params: dispatchParams },
    });
    server.request(dispatchMethod, dispatchParams).then((result) => {
      void options.onRawEvent?.({
        observedAt: new Date().toISOString(),
        direction: "providerToCoode",
        channel: "protocol",
        payload: { method: dispatchMethod, result },
      });
      const dispatched = result as { turn?: { id?: string }; reviewThreadId?: string };
      turnId = dispatched.turn?.id;
      if (options.nativeReview && dispatched.reviewThreadId) {
        activeThreadId = dispatched.reviewThreadId;
        server.markThreadActive(activeThreadId, runtimeSignature);
      }
      if (!turnId && !settled) {
        void terminate(new CodexAppServerTurnTerminatedError(
          "Codex accepted the turn but did not return a turn identifier.",
          "codex_turn_dispatch_failed",
        ));
        return;
      }
      if (!settled && turnId) {
        runtimeControlPublished = true;
        options.onRuntimeControl?.({
          harness: "codex",
          providerSessionID: activeThreadId!,
          providerTurnID: turnId,
          steer: async (text) => {
            const params = {
              threadId: activeThreadId,
              expectedTurnId: turnId,
              input: [{ type: "text", text }],
            };
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "coodeToProvider",
              channel: "protocol",
              payload: { method: "turn/steer", params },
            });
            const response = await server.request("turn/steer", params) as { turnId?: string };
            void options.onRawEvent?.({
              observedAt: new Date().toISOString(),
              direction: "providerToCoode",
              channel: "protocol",
              payload: { method: "turn/steer", result: response },
            });
            return { providerTurnID: response.turnId || turnId! };
          },
        });
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
