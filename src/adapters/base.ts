import { createHash } from "node:crypto";
import type { TuiAttachmentTransport } from "../tui-attachments.js";
import {
  promptWithWorkspaceAccess,
  workspaceToolEnvironment,
  type HarnessWorkspaceAccess,
} from "../workspace-tools.js";

export interface AgentAdapter {
  name: string;
  capabilities: HarnessCapabilities;
  available(): Promise<boolean>;
  execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult>;
  nativeSessionState?: HarnessNativeSessionState;
  backgroundAgents?: HarnessBackgroundAgentService;
  nativeControls?: HarnessNativeControlService;
  dispose?(): void | Promise<void>;
}

export type HarnessDelegationToolName =
  | "proposeDelegation"
  | "cancelDelegation"
  | "joinDelegation";

export interface HarnessDelegationToolCall {
  name: HarnessDelegationToolName;
  input: Record<string, unknown>;
}

/**
 * A structured co·ode-owned delegation bridge. Adapters may expose this as a
 * native tool, but must never treat transcript prose as a graph mutation.
 */
export interface HarnessDelegationBridge {
  graphId: string;
  leadOperationId: string;
  tools: readonly HarnessDelegationToolName[];
  invoke(call: HarnessDelegationToolCall): Promise<Record<string, unknown>>;
}

export type HarnessNativeControlActionRisk = "safe" | "destructive" | "privileged";

export interface HarnessNativeControlAction {
  id: string;
  title: string;
  risk: HarnessNativeControlActionRisk;
  /** Exact confirmation phrase required for destructive or privileged actions. */
  confirmation?: string;
  /** Optional short string input, such as a one-time provider OTP. */
  inputLabel?: string;
}

export interface HarnessNativeControlItem {
  id: string;
  title: string;
  detail?: string;
  status?: "ready" | "working" | "attention" | "unavailable" | "unknown";
  providerID?: string;
  actions?: HarnessNativeControlAction[];
}

export interface HarnessNativeControlGroup {
  id: string;
  title: string;
  detail?: string;
  items: HarnessNativeControlItem[];
}

export interface HarnessNativeControlSnapshot {
  contractVersion: 1;
  harness: string;
  observedAt: string;
  version?: string;
  groups: HarnessNativeControlGroup[];
}

export interface HarnessNativeControlContext {
  workDir: string;
  providerSessionID?: string;
}

export interface HarnessNativeControlService {
  snapshot(context: HarnessNativeControlContext): Promise<HarnessNativeControlSnapshot>;
  perform?(
    context: HarnessNativeControlContext,
    actionID: string,
    providerID?: string,
    input?: string,
  ): Promise<HarnessNativeControlSnapshot>;
}

export interface HarnessBackgroundAgentSummary {
  id: string;
  name?: string;
  status?: string;
  workDir?: string;
  providerSessionID?: string;
  raw?: Record<string, unknown>;
}

export type HarnessBackgroundAgentAction = "logs" | "stop" | "respawn" | "remove";

export interface HarnessBackgroundAgentControlResult {
  agent: HarnessBackgroundAgentSummary;
  /** Bounded recent provider output. Present only for the explicit logs action. */
  output?: string;
}

export interface HarnessBackgroundAgentService {
  list(workDir: string, includeCompleted?: boolean): Promise<HarnessBackgroundAgentSummary[]>;
  dispatch(
    goal: string,
    options: Pick<ExecuteOptions, "workDir" | "model" | "effort" | "permissionMode">,
  ): Promise<HarnessBackgroundAgentSummary>;
  control(
    action: HarnessBackgroundAgentAction,
    agentID: string,
    workDir: string,
  ): Promise<HarnessBackgroundAgentControlResult>;
}

export interface HarnessNativeSessionStateContext {
  workDir: string;
  providerSessionID: string;
}

export interface HarnessNativeSessionState {
  diff(context: HarnessNativeSessionStateContext, messageID?: string): Promise<unknown>;
  revert(
    context: HarnessNativeSessionStateContext,
    messageID: string,
    partID?: string,
  ): Promise<boolean>;
  unrevert(context: HarnessNativeSessionStateContext): Promise<boolean>;
  project?(context: HarnessNativeSessionStateContext): Promise<HarnessNativeSessionProjection>;
}

export interface HarnessNativeChildSession {
  fingerprint: string;
  title?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HarnessNativeTodo {
  id?: string;
  content: string;
  status?: string;
  priority?: string;
}

export interface HarnessNativeSessionProjection {
  childSessions: HarnessNativeChildSession[];
  todos: HarnessNativeTodo[];
}

export const HARNESS_CONTRACT_VERSION = 1;

export type HarnessTransportKind =
  | "acp"
  | "appServer"
  | "jsonl"
  | "plainText"
  | "sdk"
  | "custom";

export interface HarnessTransportCapabilities {
  kind: HarnessTransportKind;
  protocolVersion?: number;
  capabilityNegotiation: boolean;
  structuredEvents: boolean;
}

export interface HarnessPermissionOption {
  id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface HarnessPermissionRequest {
  sessionID: string;
  toolCallID: string;
  title: string;
  tool?: string;
  kind?: string;
  input?: string;
  /** The authority boundary the provider is asking co·ode to cross. */
  scope?: "workspace" | "externalAction";
  /** Provider-owned JSON Schema for a typed MCP elicitation form. */
  requestedSchema?: Record<string, unknown>;
  /** Provider-owned URL for an explicit user-completed authorization flow. */
  url?: string;
  /** Exact recipient or hardware authority covered by a one-time external grant. */
  authorityTarget?: HarnessAuthorityTarget;
  options: HarnessPermissionOption[];
}

export interface HarnessAuthorityTarget {
  kind: "recipient" | "hardware";
  operation: string;
  recipient?: string;
  channel?: string;
  hardware?: string;
}

export type HarnessElicitationContent = Record<string, unknown>;

export type HarnessPermissionDecision =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionID: string; content?: HarnessElicitationContent };

export interface HarnessCapabilityReceipt {
  contractVersion: typeof HARNESS_CONTRACT_VERSION;
  harness: string;
  transport: HarnessTransportKind;
  protocolVersion?: number;
  agentName?: string;
  agentVersion?: string;
  observedAt: string;
  source: "declared" | "negotiated" | "attested";
  capabilities: {
    sessionLoad: boolean;
    sessionList: boolean;
    sessionDelete: boolean;
    sessionResume: boolean;
    sessionFork: boolean;
    sessionClose: boolean;
    attachments: boolean;
    modelDiscovery: boolean;
    providerDiscovery: boolean;
    planReporting: boolean;
    usageReporting: boolean;
    approvalBridge: boolean;
  };
}

export interface HarnessCapabilities {
  contractVersion: typeof HARNESS_CONTRACT_VERSION;
  transport: HarnessTransportCapabilities;
  sessionResume: boolean;
  sessionFork: boolean;
  sessionLoad: boolean;
  sessionList: boolean;
  sessionDelete: boolean;
  sessionClose: boolean;
  sessionRewind: boolean;
  streamingOutput: boolean;
  cancellation: boolean;
  nativeSteer: boolean;
  nativeQueue: boolean;
  approvalBridge: boolean;
  planReporting: boolean;
  nativeReview: boolean;
  diffReporting: boolean;
  checkpointing: boolean;
  rollback: boolean;
  subagents: boolean;
  backgroundExecution: boolean;
  usageReporting: boolean;
  costReporting: boolean;
  rateLimitReporting: boolean;
  modelDiscovery: boolean;
  providerDiscovery: boolean;
  externalActions: boolean;
  attachments: boolean;
  modelSelection: boolean;
  effortSelection: boolean;
  speedSelection: boolean;
  permissionSelection: boolean;
  goalContext: boolean;
  persistentProcess: boolean;
  /**
   * Provider-owned extensions are inherited from the harness's normal user
   * configuration. co·ode never copies integration commands, URLs,
   * environment variables, or credentials into the room protocol.
   */
  nativeIntegrations: HarnessNativeIntegrationCapabilities;
  /**
   * Browser access is an explicit provider boundary. `none` means the
   * provider must not inherit a user browser profile, browser extension, or
   * user-configured browser MCP. A future co-ode executor can opt in here
   * without pretending that the provider CLI owns the browser.
   */
  browser: HarnessBrowserCapabilities;
}

export interface HarnessNativeIntegrationCapabilities {
  inheritsUserConfiguration: boolean;
  plugins: boolean;
  skills: boolean;
  mcpServers: boolean;
}

export type HarnessBrowserMode = "none" | "providerNative" | "coodeIsolated";

export interface HarnessBrowserCapabilities {
  mode: HarnessBrowserMode;
  observesSharedContext: boolean;
  reversibleNavigation: boolean;
  semanticInspection: boolean;
  arbitraryScripting: boolean;
  sharesUserBrowserProfile: boolean;
}

export const PROVIDER_BROWSER_PARITY_PROTOCOL_VERSION = 1;
export const PROVIDER_BROWSER_PARITY_MAX_AGE_MS = 15 * 60 * 1_000;
export const PROVIDER_BROWSER_PARITY_FEATURES = Object.freeze([
  "artifact-receipts",
  "confirmation-receipts",
  "isolated-context",
  "lease-control",
  "privacy-barrier",
  "recorded-traces",
  "reversible-navigation",
  "semantic-targets",
] as const);

export interface ProviderBrowserParity {
  seatID: string;
  provider: string;
  adapterVersion: string;
  protocolVersion: number;
  features: string[];
  proofHash: string;
  verifiedAt: string;
}

const stableProviderParityValue = (parity: Omit<ProviderBrowserParity, "proofHash" | "verifiedAt">) => JSON.stringify({
  seatID: parity.seatID,
  provider: parity.provider.trim().toLowerCase(),
  adapterVersion: parity.adapterVersion.trim(),
  protocolVersion: parity.protocolVersion,
  features: [...new Set(parity.features)].sort(),
});

export function providerBrowserParityProof(
  parity: Omit<ProviderBrowserParity, "proofHash" | "verifiedAt">,
): string {
  return createHash("sha256").update(stableProviderParityValue(parity)).digest("hex");
}

export function verifiedProviderBrowserParity(
  parity: ProviderBrowserParity | undefined,
  provider: string,
  now = Date.now(),
): ProviderBrowserParity | undefined {
  if (!parity || parity.provider.trim().toLowerCase() !== provider.trim().toLowerCase()) return undefined;
  if (parity.protocolVersion !== PROVIDER_BROWSER_PARITY_PROTOCOL_VERSION) return undefined;
  const verifiedAt = Date.parse(parity.verifiedAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > PROVIDER_BROWSER_PARITY_MAX_AGE_MS) return undefined;
  const features = [...new Set(parity.features)].sort();
  if (features.length !== PROVIDER_BROWSER_PARITY_FEATURES.length
      || PROVIDER_BROWSER_PARITY_FEATURES.some((feature, index) => features[index] !== feature)) return undefined;
  const expected = providerBrowserParityProof({
    seatID: parity.seatID,
    provider: parity.provider,
    adapterVersion: parity.adapterVersion,
    protocolVersion: parity.protocolVersion,
    features,
  });
  return /^[a-f0-9]{64}$/.test(parity.proofHash) && parity.proofHash === expected ? parity : undefined;
}

export function browserModeForExecution(
  provider: string,
  browserAccess?: HarnessBrowserAccess,
  parity?: ProviderBrowserParity,
): HarnessBrowserMode {
  if (verifiedProviderBrowserParity(parity, provider)) return "providerNative";
  return browserAccess ? "coodeIsolated" : "none";
}

export function noHarnessBrowser(): HarnessBrowserCapabilities {
  return {
    mode: "none",
    observesSharedContext: false,
    reversibleNavigation: false,
    semanticInspection: false,
    arbitraryScripting: false,
    sharesUserBrowserProfile: false,
  };
}

export function coodeIsolatedBrowser(): HarnessBrowserCapabilities {
  return {
    mode: "coodeIsolated",
    // The first browser slice is intentionally private per harness turn. A
    // later projection layer may expose shared observation without changing
    // the provider's authority contract.
    observesSharedContext: false,
    reversibleNavigation: true,
    semanticInspection: true,
    arbitraryScripting: false,
    sharesUserBrowserProfile: false,
  };
}

export function nativeHarnessIntegrations(): HarnessNativeIntegrationCapabilities {
  return {
    inheritsUserConfiguration: true,
    plugins: true,
    skills: true,
    mcpServers: true,
  };
}

export function noNativeHarnessIntegrations(): HarnessNativeIntegrationCapabilities {
  return {
    inheritsUserConfiguration: false,
    plugins: false,
    skills: false,
    mcpServers: false,
  };
}

export function harnessCapabilities(
  overrides: Partial<Omit<HarnessCapabilities, "contractVersion">> = {},
): HarnessCapabilities {
  return {
    contractVersion: HARNESS_CONTRACT_VERSION,
    transport: {
      kind: "plainText",
      capabilityNegotiation: false,
      structuredEvents: false,
    },
    sessionResume: false,
    sessionFork: false,
    sessionLoad: false,
    sessionList: false,
    sessionDelete: false,
    sessionClose: false,
    sessionRewind: false,
    streamingOutput: true,
    cancellation: true,
    nativeSteer: false,
    nativeQueue: false,
    approvalBridge: false,
    planReporting: false,
    nativeReview: false,
    diffReporting: false,
    checkpointing: false,
    rollback: false,
    subagents: false,
    backgroundExecution: false,
    usageReporting: false,
    costReporting: false,
    rateLimitReporting: false,
    modelDiscovery: false,
    providerDiscovery: false,
    externalActions: false,
    attachments: false,
    modelSelection: false,
    effortSelection: false,
    speedSelection: false,
    permissionSelection: false,
    goalContext: true,
    persistentProcess: false,
    nativeIntegrations: nativeHarnessIntegrations(),
    browser: noHarnessBrowser(),
    ...overrides,
  };
}

export interface ProviderSessionContext {
  mode: "continue" | "fork";
  sourceRunId: string;
  providerSessionId?: string;
}

export type HarnessNativeReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export interface HarnessNativeReviewRequest {
  target: HarnessNativeReviewTarget;
  /** Detached reviews keep the builder thread immutable. */
  delivery?: "inline" | "detached";
}

/** Controls that are valid only while one provider-native turn is active. */
export interface HarnessRuntimeControl {
  harness: string;
  providerSessionID: string;
  providerTurnID: string;
  steer?: (text: string) => Promise<{ providerTurnID: string }>;
}

/** Exact provider event material routed only to a relay-local private archive. */
export interface HarnessRawEvent {
  observedAt: string;
  direction: "providerToCoode" | "coodeToProvider";
  channel: "protocol" | "stdout" | "stderr";
  payload: unknown;
}

/** Identifies which provider message a response delta belongs to. */
export interface HarnessTextDeltaMessage {
  /** Stable per-message identifier from the provider, when it supplies one. */
  messageID?: string;
  /** Provider's own classification, such as commentary versus a final answer. */
  phase?: string;
}

export interface ExecuteOptions {
  workDir: string;
  additionalDirectories?: string[];
  /** Human-readable process activity such as tool calls and diagnostics. */
  onOutput?: (data: string) => void;
  /**
   * Assistant-authored response text only, delivered as the provider emits it.
   *
   * `message.messageID` identifies which provider message the delta belongs to.
   * A provider narrates its work as several messages interleaved with tool
   * calls; reporting that identity lets the transcript keep them as separate
   * entries in the order they happened. Adapters whose providers do not
   * distinguish messages simply omit it and produce one entry per turn.
   */
  onTextDelta?: (data: string, message?: HarnessTextDeltaMessage) => void;
  /** Structured, provider-authored work activity for live UI and transcript summaries. */
  onActivity?: (activity: HarnessActivityUpdate) => void;
  /** Native permission request. Callers must answer explicitly; absence fails closed. */
  onPermissionRequest?: (
    request: HarnessPermissionRequest,
  ) => HarnessPermissionDecision | Promise<HarnessPermissionDecision>;
  /** Exact-version capability evidence negotiated by a native protocol. */
  onCapabilityReceipt?: (receipt: HarnessCapabilityReceipt) => void;
  /** Publishes or clears controls whose lifetime is the active native turn. */
  onRuntimeControl?: (control: HarnessRuntimeControl | undefined) => void;
  /** Lossless local evidence. Callers must never copy this payload into Room history. */
  onRawEvent?: (event: HarnessRawEvent) => void | Promise<void>;
  signal?: AbortSignal;
  model?: string;
  effort?: string;
  speed?: "standard" | "fast";
  /** Grok headless native candidate fan-out. Values above one require an explicit non-ask permission mode. */
  bestOfN?: number;
  /** Grok headless self-verification loop. */
  selfCheck?: boolean;
  permissionMode?: "ask" | "approve" | "fullAccess" | "plan" | "custom";
  activeGoal?: string;
  /** Room context — enables hooks that report activity to the room */
  roomId?: string;
  runId?: string;
  serverUrl?: string;
  sessionToken?: string;
  attachments?: TuiAttachmentTransport[];
  providerSession?: ProviderSessionContext;
  /** Ask the provider's native review engine to inspect this exact target. */
  nativeReview?: HarnessNativeReviewRequest;
  browserAccess?: HarnessBrowserAccess;
  /** Short-lived Room automation and task-management authority for this turn. */
  workspaceAccess?: HarnessWorkspaceAccess;
  delegation?: HarnessDelegationBridge;
  /** Fresh host-verified proof that a provider-native browser matches co·ode's safety contract. */
  browserProviderParity?: ProviderBrowserParity;
}

export type HarnessActivityKind =
  | "artifact"
  | "browser"
  | "command"
  | "file"
  | "image"
  | "plan"
  | "read"
  | "search"
  | "tests"
  | "tool";

export type HarnessArtifactKind =
  | "mcpApp"
  | "html"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "data"
  | "file"
  | "link"
  | "unknown";

/**
 * A bounded, transport-neutral artifact emitted by a native harness.
 *
 * Artifact bytes stay process-local until the Relay converts them into normal
 * Room attachment receipts. Provider-owned payloads are never copied directly
 * into shared event metadata.
 */
export interface HarnessArtifactUpdate {
  id: string;
  kind: HarnessArtifactKind;
  title: string;
  mediaType: string;
  fileName: string;
  /** Original resource URI, retained only as inert presentation metadata. */
  uri?: string;
  /** UTF-8 text or base64 bytes, bounded again by the Relay before upload. */
  content?: string;
  encoding?: "utf8" | "base64";
  /** MCP tool-result context needed to initialise an MCP App host bridge. */
  context?: string;
  displayMode?: "inline" | "fullscreen";
  interactive?: boolean;
  provider?: string;
  server?: string;
  tool?: string;
}

export interface HarnessActivityUpdate {
  kind: HarnessActivityKind;
  phase: "started" | "completed";
  title: string;
  detail?: string;
  /** Stable provider-native tool identifier shown in expanded activity details. */
  tool?: string;
  /** Bounded, redacted provider input shown only when an action is expanded. */
  input?: string;
  result?: string;
  /** Bounded provider output shown only when a completed action is expanded. */
  output?: string;
  /** Provider-reported elapsed time when available. */
  durationMs?: number;
  /** Optional syntax label for expandable activity details. */
  codeLanguage?: "json" | "shell" | "text";
  /** Local images the harness explicitly inspected during this activity. */
  imagePaths?: string[];
  /** Provider-neutral artifacts rendered by the co·ode host. */
  artifacts?: HarnessArtifactUpdate[];
  /** Provider-native agent lineage, when the harness exposes it. */
  agentID?: string;
  parentAgentID?: string;
  background?: boolean;
  /** Stable, human-readable identity and owned task for delegated work. */
  agentName?: string;
  agentTask?: string;
  /** Honest lifecycle/current-action signals; no synthetic percentage. */
  agentStatus?: "working" | "completed" | "failed";
  agentProgress?: string;
}

const sensitiveActivityPayloadKey = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i;

/** Keep expanded tool disclosures useful without persisting obvious credentials or unbounded payloads. */
export function boundedActivityPayload(value: unknown, maximum = 16_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let payload = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/\r\n?/g, "\n").slice(0, maximum);
    }
  }
  try {
    const serialized = JSON.stringify(
      payload,
      (key, candidate) => sensitiveActivityPayloadKey.test(key) ? "[redacted]" : candidate,
      2,
    );
    return serialized && serialized !== "{}" && serialized !== "[]"
      ? serialized.slice(0, maximum)
      : undefined;
  } catch {
    const fallback = String(payload).trim();
    return fallback ? fallback.slice(0, maximum) : undefined;
  }
}

export interface HarnessBrowserAccess {
  toolPath: string;
  artifactDirectory: string;
  serverURL: string;
  capability: string;
  roomID: string;
  contextID: string;
  expiresAt: string;
}

/**
 * Give a harness the minimum operator contract for co-ode's scoped browser.
 * The capability itself remains in the environment so it cannot be copied
 * into transcripts by this prompt. Relay validation, not these instructions,
 * is the security boundary.
 */
export function promptWithBrowserAccess(
  goal: string,
  browserAccess?: HarnessBrowserAccess,
  provider?: string,
  browserProviderParity?: ProviderBrowserParity,
): string {
  const mode = browserModeForExecution(provider || "", browserAccess, browserProviderParity);
  if (mode === "none") return goal;
  if (mode === "providerNative") {
    return [
      "<co-ode-browser>",
      "Use the provider-native browser tools for this turn. co·ode verified a fresh parity proof for the room-scoped isolated context.",
      "Use semantic targets only. Do not access another browser profile, extension, tab, context, or credential store.",
      "External writes and destructive actions still require co·ode confirmation receipts.",
      "Record test steps and artifact receipts so room collaborators can inspect the result.",
      "</co-ode-browser>",
      "",
      "<task>",
      goal,
      "</task>",
    ].join("\n");
  }
  return [
    "<co-ode-browser>",
    "For browser work in this room, use only co-ode's isolated browser through $CO_OD_BROWSER_TOOL.",
    "Do not use a provider-native browser, web-search tool, browser extension, MCP browser, or a user's browser profile.",
    "Run semantic steps by piping JSON on stdin, for example:",
    `printf '%s' '{"steps":[{"kind":"setViewport","width":390,"height":844},{"kind":"navigate","url":"https://example.com"},{"kind":"assertVisible","target":{"by":"role","role":"heading","name":"Example Domain"}},{"kind":"assertText","target":{"by":"role","role":"heading","name":"Example Domain"},"expected":"Example Domain"},{"kind":"screenshot"}]}' | "$CO_OD_BROWSER_TOOL" run`,
    "Allowed step kinds: setViewport, navigate, assertVisible, assertText, click, fill, screenshot.",
    "setViewport accepts integer width and height values from 240 through 3840, so responsive layouts can be checked without using a personal browser.",
    "Use semantic targets only. Every target requires a `by` discriminator: {\"by\":\"role\",\"role\":\"heading\",\"name\":\"...\"}, {\"by\":\"label\",\"text\":\"...\"}, {\"by\":\"text\",\"text\":\"...\"}, or {\"by\":\"testId\",\"value\":\"...\"}. assertText also requires an `expected` string. Arbitrary scripts and coordinate clicks are not available.",
    "For assertText, the target only identifies the element and `expected` contains the text to verify. A status live region normally uses {\"by\":\"role\",\"role\":\"status\"} without a name; add `name` only when it is the element's actual accessible name. Use `exact:false` only for an intentional partial accessible-name match.",
    "Treat every absolute URL and semantic label in the task as authoritative: copy them literally into the requested steps. No CO_OD_* environment variable contains a project preview URL, so never substitute an environment variable or guess another port.",
    "Do not start, restart, or stop a preview server unless the task explicitly asks you to. If the requested browser run fails, report its safe error and failed step instead of changing the server lifecycle or inventing alternate targets.",
    "When the task requests one browser run, submit the complete requested sequence once; do not silently change accessible names or assertions between retries.",
    `Download a returned artifact with: "$CO_OD_BROWSER_TOOL" artifact ARTIFACT_ID`,
    "Never print, copy, log, or expose browser environment variables or capabilities.",
    "</co-ode-browser>",
    "",
    "<task>",
    goal,
    "</task>",
  ].join("\n");
}

export function promptWithActiveGoal(prompt: string, activeGoal?: string): string {
  if (!activeGoal?.trim()) return prompt;
  return [
    "<co-ode-goal>",
    activeGoal.trim(),
    "Treat this as the durable objective for this queued turn. Preserve provider-session continuity.",
    "</co-ode-goal>",
    "",
    prompt,
  ].join("\n");
}

export function promptWithHarnessCapabilities(
  goal: string,
  options: Pick<ExecuteOptions, "activeGoal" | "browserAccess" | "browserProviderParity" | "workspaceAccess">,
  provider: string,
  { nativeWorkspaceTools = false } = {},
): string {
  return promptWithWorkspaceAccess(
    promptWithBrowserAccess(
      promptWithActiveGoal(goal, options.activeGoal),
      options.browserAccess,
      provider,
      options.browserProviderParity,
    ),
    options.workspaceAccess,
    { nativeDynamicTools: nativeWorkspaceTools },
  );
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  providerSessionId?: string;
  capabilityReceipt?: HarnessCapabilityReceipt;
}

/**
 * Snapshot the adapter's exact v1 declaration when its transport cannot
 * negotiate capabilities at runtime. The `source` field keeps this weaker
 * evidence distinct from an ACP handshake while still making every run
 * auditable and versioned.
 */
export function declaredHarnessCapabilityReceipt(
  harness: string,
  capabilities: HarnessCapabilities,
  observedAt = new Date().toISOString(),
): HarnessCapabilityReceipt {
  return {
    contractVersion: HARNESS_CONTRACT_VERSION,
    harness,
    transport: capabilities.transport.kind,
    ...(capabilities.transport.protocolVersion !== undefined
      ? { protocolVersion: capabilities.transport.protocolVersion }
      : {}),
    agentName: harness,
    observedAt,
    source: "declared",
    capabilities: {
      sessionLoad: capabilities.sessionLoad,
      sessionList: capabilities.sessionList,
      sessionDelete: capabilities.sessionDelete,
      sessionResume: capabilities.sessionResume,
      sessionFork: capabilities.sessionFork,
      sessionClose: capabilities.sessionClose,
      attachments: capabilities.attachments,
      modelDiscovery: capabilities.modelDiscovery,
      providerDiscovery: capabilities.providerDiscovery,
      planReporting: capabilities.planReporting,
      usageReporting: capabilities.usageReporting,
      approvalBridge: capabilities.approvalBridge,
    },
  };
}

/** Attach and publish a declared receipt without replacing negotiated proof. */
export function withDeclaredHarnessCapabilityReceipt(
  result: ExecuteResult,
  harness: string,
  capabilities: HarnessCapabilities,
  options: Pick<ExecuteOptions, "onCapabilityReceipt">,
): ExecuteResult {
  if (result.capabilityReceipt) return result;
  const capabilityReceipt = declaredHarnessCapabilityReceipt(harness, capabilities);
  options.onCapabilityReceipt?.(capabilityReceipt);
  return { ...result, capabilityReceipt };
}

export function attachmentEnvironment(attachments?: TuiAttachmentTransport[]): Record<string, string> {
  if (!attachments || attachments.length === 0) return {};
  return {
    CO_OD_ATTACHMENTS_JSON: JSON.stringify(attachments),
    CO_OD_ATTACHMENT_PATHS: attachments.map((attachment) => attachment.absolutePath).join(":"),
  };
}

export function providerSessionEnvironment(session?: ProviderSessionContext): Record<string, string> {
  if (!session) return {};
  return {
    CO_OD_PROVIDER_SESSION_MODE: session.mode,
    CO_OD_PROVIDER_SOURCE_RUN_ID: session.sourceRunId,
    CO_OD_PROVIDER_SESSION_ID: session.providerSessionId || "",
  };
}

const INTERNAL_COODE_ENVIRONMENT_PREFIXES = ["COODE_", "CO_OD_"];

/**
 * Provider CLIs inherit their own authentication and ordinary shell settings,
 * but never relay credentials, seat supervisor state, or host browser policy.
 * The only browser authority exposed to a harness is a short-lived,
 * context-bound capability minted by the relay.
 */
export function providerProcessEnvironment(
  options: Pick<ExecuteOptions, "attachments" | "browserAccess" | "browserProviderParity" | "providerSession" | "roomId" | "runId" | "workspaceAccess"> & { provider?: string } = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    value !== undefined && !INTERNAL_COODE_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  ));
  const browserMode = browserModeForExecution(options.provider || "", options.browserAccess, options.browserProviderParity);
  return {
    ...environment,
    ...attachmentEnvironment(options.attachments),
    ...providerSessionEnvironment(options.providerSession),
    ...workspaceToolEnvironment(options.workspaceAccess),
    CO_OD_ROOM_ID: options.roomId || "",
    CO_OD_RUN_ID: options.runId || "",
    CO_OD_BROWSER_MODE: browserMode,
    ...(browserMode === "coodeIsolated" && options.browserAccess ? {
      CO_OD_BROWSER_TOOL: options.browserAccess.toolPath,
      CO_OD_BROWSER_ARTIFACT_DIRECTORY: options.browserAccess.artifactDirectory,
      CO_OD_BROWSER_SERVER_URL: options.browserAccess.serverURL,
      CO_OD_BROWSER_CAPABILITY: options.browserAccess.capability,
      CO_OD_BROWSER_ROOM_ID: options.browserAccess.roomID,
      CO_OD_BROWSER_CONTEXT_ID: options.browserAccess.contextID,
      CO_OD_BROWSER_EXPIRES_AT: options.browserAccess.expiresAt,
    } : {}),
  };
}

const PROVIDER_SESSION_ID_KEYS = new Set([
  "providerSessionId",
  "provider_session_id",
  "provider-session-id",
  "sessionId",
  "sessionID",
  "session_id",
  "session-id",
  "conversationId",
  "conversation_id",
  "conversation-id",
  "threadId",
  "thread_id",
  "thread-id",
]);

const PROVIDER_SESSION_OBJECT_KEYS = new Set(["providerSession", "provider_session", "session", "conversation", "thread"]);

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function normalizeProviderSessionKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const NORMALIZED_PROVIDER_SESSION_ID_KEYS = new Set(Array.from(PROVIDER_SESSION_ID_KEYS, normalizeProviderSessionKey));
const NORMALIZED_PROVIDER_SESSION_OBJECT_KEYS = new Set(Array.from(PROVIDER_SESSION_OBJECT_KEYS, normalizeProviderSessionKey));

function normalizeProviderSessionIdCandidate(value: string): string | undefined {
  const candidate = value
    .replace(ANSI_PATTERN, "")
    .trim()
    .replace(/^[<("'[{]+/, "")
    .replace(/[>)"',.;\]}]+$/, "");
  if (!candidate || candidate.length < 6) return undefined;
  if (!/[A-Za-z0-9]/.test(candidate)) return undefined;
  if (/^(session|thread|conversation|provider|unknown|null|undefined)$/i.test(candidate)) return undefined;
  return candidate;
}

export function findProviderSessionId(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const candidate = findProviderSessionId(value[index], depth + 1);
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(record)) {
    const normalizedKey = normalizeProviderSessionKey(key);
    if (NORMALIZED_PROVIDER_SESSION_ID_KEYS.has(normalizedKey) && typeof candidate === "string") {
      const normalized = normalizeProviderSessionIdCandidate(candidate);
      if (normalized) return normalized;
    }
    if (NORMALIZED_PROVIDER_SESSION_OBJECT_KEYS.has(normalizedKey) && candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const nestedKey of ["id", "uuid", "sessionId", "session_id", "threadId", "thread_id"]) {
        const nestedCandidate = nested[nestedKey];
        if (typeof nestedCandidate === "string") {
          const normalized = normalizeProviderSessionIdCandidate(nestedCandidate);
          if (normalized) return normalized;
        }
      }
    }
  }

  const entries = Object.entries(record);
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = findProviderSessionId(entries[index][1], depth + 1);
    if (candidate) return candidate;
  }
  return undefined;
}

export function extractProviderSessionIdFromText(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].replace(ANSI_PATTERN, "").trim();
    if (!line) continue;
    try {
      const candidate = findProviderSessionId(JSON.parse(line));
      if (candidate) return candidate;
    } catch {
      // Fall back to unstructured output parsing below.
    }
    const patterns = [
      /\b(?:provider[_ -]?session|session|thread|conversation)[_ -]?id\b\s*[:=]\s*["']?([A-Za-z0-9._:@/+~-]{6,})/i,
      /\b(?:provider[_ -]?session|session|thread|conversation)\b\s*[:=]\s*["']?([A-Za-z0-9._:@/+~-]{6,})/i,
      /\b(?:codex\s+exec\s+resume|claude\s+(?:-r|--resume)|opencode\s+run\s+(?:--session|-s))\s+["']?([A-Za-z0-9._:@/+~-]{6,})/i,
      /\bagy\s+--conversation(?:=|\s+)["']?([A-Za-z0-9._:@/+~-]{6,})/i,
      /\b(?:resume|resuming|continued?|forked?)\s+(?:conversation|session|thread)\s+["']?([A-Za-z0-9._:@/+~-]{6,})/i,
      /\b(?:conversation|session|thread)\s+(?:started|created|forked|resumed|continued)\s+["']?([A-Za-z0-9._:@/+~-]{6,})/i,
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      const candidate = match?.[1] ? normalizeProviderSessionIdCandidate(match[1]) : undefined;
      if (candidate) return candidate;
    }
  }
  return undefined;
}

export function resolveProviderSessionIdFromResult(
  output: string,
  session?: ProviderSessionContext,
): string | undefined {
  return extractProviderSessionIdFromText(output)
    || (session?.mode === "continue" ? session.providerSessionId : undefined);
}

export function existingAttachmentPaths(
  attachments: TuiAttachmentTransport[] | undefined,
  kinds?: TuiAttachmentTransport["kind"][],
): string[] {
  const allowed = kinds ? new Set(kinds) : null;
  return (attachments || [])
    .filter((attachment) => attachment.exists)
    .filter((attachment) => !allowed || allowed.has(attachment.kind))
    .map((attachment) => attachment.absolutePath);
}
