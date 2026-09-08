import { nativeImageAttachments } from "./native-images.js";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type ContentBlock,
  type ClientContext,
  type InitializeResponse,
  type ForkSessionResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  HARNESS_CONTRACT_VERSION,
  boundedActivityPayload,
  existingAttachmentPaths,
  providerProcessEnvironment,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessActivityKind,
  type HarnessCapabilityReceipt,
  type HarnessPermissionDecision,
} from "./base.js";
import { harnessArtifactsFromToolResult } from "./harness-artifacts.js";

export interface AcpAgentCommand {
  executable: string;
  args: string[];
  harness: string;
  newSessionParameters?: Record<string, unknown>;
  stopSessionOnCancel?: boolean;
}

interface AcpSessionSetup {
  sessionID: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string; _meta?: { reasoningEfforts?: Array<{ id: string; value?: string; label?: string }> } }> };
}

interface ObservedAcpFeatures {
  plan: boolean;
  usage: boolean;
}

function textFromContent(content: ContentBlock | undefined): string | undefined {
  if (!content) return undefined;
  if (content.type === "text") return content.text;
  if (content.type === "resource_link") return content.title || content.name || content.uri;
  if (content.type === "resource" && "text" in content.resource) return content.resource.text;
  return undefined;
}

function activityKind(kind: ToolCall["kind"] | null | undefined, title: string): HarnessActivityKind {
  if (/\b(?:test|check|lint|build)\b/i.test(title)) return "tests";
  switch (kind) {
    case "read": return "read";
    case "edit":
    case "delete":
    case "move": return "file";
    case "search": return "search";
    case "execute": return "command";
    case "fetch": return /\b(?:browser|page|url|web)\b/i.test(title) ? "browser" : "tool";
    case "think": return "plan";
    default: return "tool";
  }
}

function toolOutput(update: Pick<ToolCallUpdate, "content" | "rawOutput">): string | undefined {
  const raw = boundedActivityPayload(update.rawOutput);
  if (raw) return raw;
  const content = update.content?.map((item) => {
    if (item.type === "content") return textFromContent(item.content);
    if (item.type === "diff") return `${item.path}\n${item.newText}`;
    if (item.type === "terminal") return `terminal ${item.terminalId}`;
    return undefined;
  }).filter((item): item is string => Boolean(item));
  return content?.length ? content.join("\n") : undefined;
}

function publishToolActivity(
  update: ToolCall | ToolCallUpdate,
  options: ExecuteOptions,
  provider: string,
  previous?: ToolCall,
): ToolCall {
  const merged: ToolCall = {
    toolCallId: update.toolCallId,
    title: update.title || previous?.title || "Using a tool",
    name: update.name ?? previous?.name,
    kind: update.kind ?? previous?.kind,
    status: update.status ?? previous?.status ?? "in_progress",
    content: update.content ?? previous?.content,
    locations: update.locations ?? previous?.locations,
    rawInput: update.rawInput ?? previous?.rawInput,
    rawOutput: update.rawOutput ?? previous?.rawOutput,
  };
  const completed = merged.status === "completed" || merged.status === "failed";
  const input = boundedActivityPayload(merged.rawInput);
  const output = toolOutput(merged);
  const artifactContent = merged.content?.flatMap((item) =>
    item.type === "content" ? [item.content] : []);
  const artifacts = completed && artifactContent?.length
    ? harnessArtifactsFromToolResult({ content: artifactContent }, {
      provider,
      tool: merged.name || merged.kind || "tool",
      title: merged.title,
    })
    : [];
  options.onActivity?.({
    kind: activityKind(merged.kind, merged.title),
    phase: completed ? "completed" : "started",
    title: merged.title,
    detail: merged.locations?.map((location) => location.path).join(", ") || undefined,
    tool: merged.name || merged.kind || "tool",
    ...(input ? { input, codeLanguage: "json" } : {}),
    ...(output ? { output } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(completed ? { result: merged.status === "failed" ? "Failed" : "Completed" } : {}),
  });
  return merged;
}

function firstOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  return kinds.flatMap((kind) => options.filter((option) => option.kind === kind))[0];
}

export function acpPermissionDecision(
  request: Pick<RequestPermissionRequest, "options">,
  mode: ExecuteOptions["permissionMode"],
): HarnessPermissionDecision {
  const selected = mode === "fullAccess"
    ? firstOption(request.options, ["allow_always", "allow_once"])
    : mode === "approve"
      ? firstOption(request.options, ["allow_once"])
      : mode === "plan"
        ? firstOption(request.options, ["reject_always", "reject_once"])
        : undefined;
  return selected
    ? { outcome: "selected", optionID: selected.optionId }
    : { outcome: "cancelled" };
}

export function acpPermissionScope(
  harness: string,
  toolCall: Pick<ToolCallUpdate, "name" | "kind" | "title" | "rawInput">,
): "workspace" | "externalAction" {
  if (!["hermes", "openclaw", "zeroclaw"].includes(harness.toLowerCase())) {
    return "workspace";
  }
  const input = boundedActivityPayload(toolCall.rawInput);
  return /(?:camera|channel|device|discord|email|gateway|gpio|hardware|i2c|message|microphone|mqtt|notify|pin|schedule|send|sensor|serial|slack|spi|telegram|webhook|whatsapp)/i.test(
    `${toolCall.name || ""} ${toolCall.kind || ""} ${toolCall.title || ""} ${input || ""}`,
  ) ? "externalAction" : "workspace";
}

const firstTargetString = (value: unknown, keys: RegExp): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.test(key) && ["string", "number"].includes(typeof child)) {
      return String(child).trim().slice(0, 512) || undefined;
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const nested = firstTargetString(child, keys);
    if (nested) return nested;
  }
  return undefined;
};

/** Bind external approval to the exact provider recipient or hardware resource. */
export function acpAuthorityTarget(
  harness: string,
  toolCall: Pick<ToolCallUpdate, "name" | "kind" | "title" | "rawInput">,
) {
  if (acpPermissionScope(harness, toolCall) !== "externalAction") return undefined;
  const searchable = `${toolCall.name || ""} ${toolCall.kind || ""} ${toolCall.title || ""} ${boundedActivityPayload(toolCall.rawInput) || ""}`;
  const operation = String(toolCall.name || toolCall.title || toolCall.kind || "external action").slice(0, 256);
  if (/(?:camera|device|gpio|hardware|i2c|microphone|mqtt|pin|sensor|serial|spi)/i.test(searchable)) {
    return {
      kind: "hardware" as const,
      operation,
      hardware: firstTargetString(toolCall.rawInput, /^(?:camera|device|deviceId|gpio|hardware|i2c|microphone|pin|port|sensor|serial|spi|topic)$/i)
        || String(toolCall.title || toolCall.name || "hardware resource").slice(0, 512),
    };
  }
  const recipient = firstTargetString(toolCall.rawInput, /^(?:address|chatId|email|phone|recipient|recipientId|target|to|user|userId|username)$/i);
  const channel = firstTargetString(toolCall.rawInput, /^(?:channel|channelId|gateway|platform|service|transport)$/i);
  return {
    kind: "recipient" as const,
    operation,
    ...(recipient ? { recipient } : {}),
    ...(channel ? { channel } : {}),
  };
}

async function permissionResponse(
  request: RequestPermissionRequest,
  options: ExecuteOptions,
  harness: string,
): Promise<RequestPermissionResponse> {
  const input = boundedActivityPayload(request.toolCall.rawInput);
  const scope = acpPermissionScope(harness, request.toolCall);
  const authorityTarget = acpAuthorityTarget(harness, request.toolCall);
  const externalRequest = {
    sessionID: request.sessionId,
    toolCallID: request.toolCall.toolCallId,
    title: request.toolCall.title || "Tool permission",
    tool: request.toolCall.name || undefined,
    kind: request.toolCall.kind || undefined,
    input,
    scope,
    ...(authorityTarget ? { authorityTarget } : {}),
    options: request.options.map((option) => ({
      id: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
  options.onActivity?.({
    kind: activityKind(request.toolCall.kind, request.toolCall.title || "Tool permission"),
    phase: "started",
    title: `Approval required: ${request.toolCall.title || "tool action"}`,
    tool: request.toolCall.name || request.toolCall.kind || "permission",
    ...(input ? { input, codeLanguage: "json" } : {}),
  });
  const decision = options.signal?.aborted
    ? { outcome: "cancelled" as const }
    : options.onPermissionRequest
      ? await options.onPermissionRequest(externalRequest)
      : acpPermissionDecision(request, options.permissionMode);
  const selected = decision.outcome === "selected"
    ? request.options.find((option) => option.optionId === decision.optionID)
    : undefined;
  options.onActivity?.({
    kind: activityKind(request.toolCall.kind, request.toolCall.title || "Tool permission"),
    phase: "completed",
    title: request.toolCall.title || "Tool permission",
    tool: request.toolCall.name || request.toolCall.kind || "permission",
    result: selected ? selected.name : "Cancelled",
  });
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function flattenSelectOptions(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((candidate) => "options" in candidate ? candidate.options : [candidate]);
}

const normalizedModeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolve only permission modes owned by the native ACP agent. Other agents
 * continue to use their provider-supplied requestPermission choices instead
 * of inheriting a made-up co·od-wide mode.
 */
export function acpNativeSessionMode(
  harness: string,
  permissionMode: ExecuteOptions["permissionMode"],
  modes: SessionModeState,
): string | undefined {
  const find = (names: string[]): string | undefined => modes.availableModes.find((candidate) => {
    const values = [normalizedModeName(candidate.id), normalizedModeName(candidate.name)];
    return names.some((name) => values.includes(normalizedModeName(name)));
  })?.id;

  if (permissionMode === "plan") return find(["plan"]);
  if (harness.toLowerCase() !== "grok") {
    if (harness.toLowerCase() === "gemini") {
      if (permissionMode === "fullAccess") return find(["yolo"]);
      if (permissionMode === "approve") return find(["auto_edit"]);
      if (permissionMode === "ask" || permissionMode === "custom") return find(["default"]);
    }
    if (harness.toLowerCase() === "hermes") {
      if (permissionMode === "approve") return find(["accept_edits"]);
      if (permissionMode === "fullAccess") return find(["dont_ask"]);
      if (permissionMode === "ask" || permissionMode === "custom") return find(["default"]);
    }
    // Resume out of a previously selected native Plan mode when the user changes modes.
    if (permissionMode && normalizedModeName(modes.currentModeId) === "plan") return find(["build", "code", "edit", "default"]);
    return undefined;
  }

  switch (permissionMode) {
    case "approve":
      return find(["acceptEdits"]);
    case "fullAccess":
      return find(["bypassPermissions"]);
    case "ask":
    case "custom":
    case undefined:
      // No setMode request is required when Grok does not advertise an
      // explicit Default entry: the freshly negotiated current mode is its
      // own default and remains untouched.
      return find(["default"]);
  }
}

export async function configureSession(
  context: ClientContext,
  session: AcpSessionSetup,
  options: ExecuteOptions,
  harness: string,
): Promise<void> {
  if (session.modes) {
    const requestedMode = acpNativeSessionMode(
      harness,
      options.permissionMode,
      session.modes,
    );
    if (
      harness.toLowerCase() === "grok"
      && ["approve", "fullAccess"].includes(options.permissionMode || "")
      && !requestedMode
    ) {
      throw new Error(
        `Grok did not advertise its requested ${options.permissionMode} permission mode for this session.`,
      );
    }
    if (requestedMode && requestedMode !== session.modes.currentModeId) {
      await context.request(methods.agent.session.setMode, {
        sessionId: session.sessionID,
        modeId: requestedMode,
      });
    }
  }

  if (!session.modes) {
    const modeConfig = session.configOptions?.find((candidate) => candidate.type === "select" && candidate.category === "mode");
    if (modeConfig?.type === "select") {
      const requested = acpNativeSessionMode(harness, options.permissionMode, {
        currentModeId: modeConfig.currentValue,
        availableModes: flattenSelectOptions(modeConfig).map((entry) => ({ id: entry.value, name: entry.name })),
      });
      if (requested && requested !== modeConfig.currentValue) {
        const updated = await context.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionID, configId: modeConfig.id, value: requested,
        });
        if (updated.configOptions) session.configOptions = updated.configOptions;
      }
    } else if (harness.toLowerCase() === "grok" && options.permissionMode) {
      // Installed Grok versions expose native Plan through set_mode without a modes catalog.
      await context.request(methods.agent.session.setMode, {
        sessionId: session.sessionID, modeId: options.permissionMode === "plan" ? "plan" : "default",
      });
    }
  }

  const desired = [
    { kind: "model", value: options.model, category: "model", labels: /^(?:model|models)$/i },
    { kind: "reasoning effort", value: options.effort, category: "thought_level", labels: /(?:effort|reason|thought)/i },
  ];
  for (const target of desired) {
    if (!target.value) continue;
    if (target.kind === "reasoning effort" && harness.toLowerCase() === "grok" && session.models
      && !session.configOptions?.some((candidate) => candidate.category === "thought_level")) {
      const current = session.models.availableModels.find((candidate) => candidate.modelId === session.models!.currentModelId);
      const selected = current?._meta?.reasoningEfforts?.find((candidate) => candidate.id === target.value || candidate.value === target.value);
      if (!selected || !current) throw new Error(`Grok did not advertise the selected reasoning effort: ${target.value}.`);
      await context.request("session/set_model", {
        sessionId: session.sessionID, modelId: current.modelId, _meta: { reasoningEffort: selected.value ?? selected.id },
      });
      continue;
    }
    const selects = session.configOptions?.filter((candidate) => candidate.type === "select") ?? [];
    // model_config also covers context size and speed; it is not a model selector.
    const config = selects.find((candidate) => candidate.category === target.category)
      ?? selects.find((candidate) => target.labels.test(candidate.id) || target.labels.test(candidate.name));
    if (!config) {
      // Older installed agents still advertise the former native model API.
      if (target.kind === "model" && session.models) {
        const selected = session.models.availableModels.find((candidate) =>
          candidate.modelId === target.value || candidate.name.toLowerCase() === target.value!.toLowerCase());
        if (!selected) throw new Error(`${harness} did not advertise the selected model: ${target.value}.`);
        if (selected.modelId !== session.models.currentModelId) {
          await context.request("session/set_model", { sessionId: session.sessionID, modelId: selected.modelId });
        }
        session.models.currentModelId = selected.modelId;
        continue;
      }
      throw new Error(`${harness} does not expose ${target.kind} selection for this session; the requested ${target.value} was not applied.`);
    }
    const match = flattenSelectOptions(config).find((candidate) => candidate.value === target.value)
      ?? flattenSelectOptions(config).find((candidate) => candidate.name.toLowerCase() === target.value!.toLowerCase());
    if (!match) throw new Error(`${harness} did not advertise the selected ${target.kind}: ${target.value}.`);
    if (match.value === config.currentValue) continue;
    const updated = await context.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionID,
      configId: config.id,
      value: match.value,
    });
    // Changing the model can change its effort choices. Use the provider's new catalog.
    if (updated.configOptions) session.configOptions = updated.configOptions;
  }
}

function receiptFor(
  command: AcpAgentCommand,
  initialized: InitializeResponse,
  observed: ObservedAcpFeatures,
): HarnessCapabilityReceipt {
  const session = initialized.agentCapabilities?.sessionCapabilities;
  return {
    contractVersion: HARNESS_CONTRACT_VERSION,
    harness: command.harness,
    transport: "acp",
    protocolVersion: initialized.protocolVersion,
    agentName: initialized.agentInfo?.name,
    agentVersion: initialized.agentInfo?.version,
    observedAt: new Date().toISOString(),
    source: "negotiated",
    capabilities: {
      sessionLoad: initialized.agentCapabilities?.loadSession === true,
      sessionList: Boolean(session?.list),
      sessionDelete: Boolean(session?.delete),
      sessionResume: Boolean(session?.resume),
      sessionFork: Boolean(session?.fork),
      sessionClose: Boolean(session?.close),
      attachments: true,
      modelDiscovery: initialized.agentCapabilities?.providers != null,
      providerDiscovery: initialized.agentCapabilities?.providers != null,
      planReporting: observed.plan,
      usageReporting: observed.usage,
      approvalBridge: true,
    },
  };
}

async function setupSession(
  context: ClientContext,
  capabilities: AgentCapabilities | undefined,
  options: ExecuteOptions,
  newSessionParameters?: Record<string, unknown>,
): Promise<AcpSessionSetup> {
  const additionalDirectories = [...new Set(options.additionalDirectories || [])];
  const common = {
    cwd: options.workDir,
    additionalDirectories,
    mcpServers: [],
  };
  const providerSession = options.providerSession;
  const source = providerSession?.providerSessionId;
  if (!source) {
    const created = await context.request(methods.agent.session.new, { ...newSessionParameters, ...common }) as NewSessionResponse;
    return { sessionID: created.sessionId, modes: created.modes, configOptions: created.configOptions, models: (created as typeof created & Pick<AcpSessionSetup, "models">).models };
  }
  if (providerSession.mode === "fork") {
    if (!capabilities?.sessionCapabilities?.fork) {
      throw new Error(`${providerSession.sourceRunId} cannot fork: the installed ACP agent did not advertise session/fork.`);
    }
    const forked = await context.request(methods.agent.session.fork, { sessionId: source, ...common }) as ForkSessionResponse;
    return { sessionID: forked.sessionId, modes: forked.modes, configOptions: forked.configOptions, models: (forked as typeof forked & Pick<AcpSessionSetup, "models">).models };
  }
  if (capabilities?.sessionCapabilities?.resume) {
    const resumed = await context.request(methods.agent.session.resume, { sessionId: source, ...common }) as ResumeSessionResponse;
    return { sessionID: source, modes: resumed.modes, configOptions: resumed.configOptions, models: (resumed as typeof resumed & Pick<AcpSessionSetup, "models">).models };
  }
  if (capabilities?.loadSession) {
    const loaded = await context.request(methods.agent.session.load, { sessionId: source, ...common }) as LoadSessionResponse;
    return { sessionID: source, modes: loaded.modes, configOptions: loaded.configOptions, models: (loaded as typeof loaded & Pick<AcpSessionSetup, "models">).models };
  }
  throw new Error(`${providerSession.sourceRunId} cannot continue: the installed ACP agent advertised neither session/resume nor session/load.`);
}

function processUpdate(
  notification: SessionNotification,
  options: ExecuteOptions,
  provider: string,
  tools: Map<string, ToolCall>,
  observed: ObservedAcpFeatures,
  appendText: (text: string, messageID?: string | null) => void,
): void {
  const update: SessionUpdate = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      if (text) appendText(text, update.messageId);
      break;
    }
    case "agent_thought_chunk":
      // ACP may carry private chain-of-thought. co·ode intentionally exposes
      // operational activity and provider-authored summaries, never raw thought.
      break;
    case "tool_call":
    case "tool_call_update": {
      const prior = tools.get(update.toolCallId);
      tools.set(update.toolCallId, publishToolActivity(update, options, provider, prior));
      break;
    }
    case "plan":
    case "plan_update": {
      observed.plan = true;
      options.onActivity?.({
        kind: "plan",
        phase: "started",
        title: "Updated plan",
        tool: "acp_plan",
        output: boundedActivityPayload(update),
        codeLanguage: "json",
      });
      break;
    }
    case "usage_update":
      observed.usage = true;
      break;
    default:
      break;
  }
}

function closeCodeForStopReason(reason: string): number {
  return reason === "end_turn" ? 0
    : reason === "cancelled" ? 130
      : 1;
}

/**
 * Run one ACP turn while preserving native sessions and structured events.
 * The official SDK owns JSON-RPC framing; this layer owns co·ode policy,
 * process cleanup, event normalization, and capability receipts.
 */
export async function executeAcpAgent(
  command: AcpAgentCommand,
  goal: string,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const references = existingAttachmentPaths(options.attachments);
  const prompt = references.length > 0
    ? `${references.map((path) => `Reference: ${path}`).join("\n")}\n\n${goal}`
    : goal;
  const child = spawn(command.executable, command.args, {
    cwd: options.workDir,
    env: providerProcessEnvironment({ ...options, provider: command.harness }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const raw = (
    direction: "providerToCoode" | "coodeToProvider",
    payload: unknown,
    channel: "protocol" | "stdout" | "stderr" = "protocol",
  ) => void options.onRawEvent?.({
    observedAt: new Date().toISOString(),
    direction,
    channel,
    payload,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    raw("providerToCoode", chunk, "stderr");
    stderr += chunk;
    options.onOutput?.(chunk);
  });
  const childClosed = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
  });
  const childError = new Promise<never>((_, reject) => child.once("error", reject));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const tools = new Map<string, ToolCall>();
  const observed: ObservedAcpFeatures = { plan: false, usage: false };
  let stdout = "";
  let providerSessionId: string | undefined;
  let capabilityReceipt: HarnessCapabilityReceipt | undefined;
  let cancelActive: (() => Promise<void>) | undefined;
  let promptInFlight = false;
  let lastMessageID: string | undefined;
  let toolSinceText = false;
  const appendText = (text: string, messageID?: string | null) => {
    const startsMessage = toolSinceText || (messageID && lastMessageID && messageID !== lastMessageID);
    const delta = stdout && startsMessage && !stdout.endsWith("\n") && !text.startsWith("\n")
      ? `\n\n${text}` : text;
    stdout += delta;
    toolSinceText = false;
    lastMessageID = messageID || lastMessageID;
    options.onTextDelta?.(delta, { messageID: messageID || undefined, phase: "assistant" });
    options.onOutput?.(delta);
  };
  const app = client({ name: "co-ode" })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      raw("providerToCoode", { method: methods.client.session.requestPermission, params });
      const response = await permissionResponse(params, options, command.harness);
      raw("coodeToProvider", { method: methods.client.session.requestPermission, response });
      return response;
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      // session/load replays prior messages before its response. Those belong
      // to retained history, not this attempt's text, activity, or token usage.
      if (!promptInFlight) return;
      if (params.update.sessionUpdate === "tool_call" && stdout) toolSinceText = true;
      raw("providerToCoode", { method: methods.client.session.update, params });
      processUpdate(params, options, command.harness, tools, observed, appendText);
    });

  const abort = () => {
    void cancelActive?.().catch(() => {});
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, 1_000).unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const workflow = app.connectWith(stream, async (context) => {
      const initializeParams = {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          session: { configOptions: { boolean: {} } },
          plan: {},
        },
        clientInfo: { name: "co-ode", version: "0.2.0" },
      };
      raw("coodeToProvider", { method: methods.agent.initialize, params: initializeParams });
      const initialized = await context.request(methods.agent.initialize, initializeParams, { cancellationSignal: options.signal }) as InitializeResponse;
      raw("providerToCoode", { method: methods.agent.initialize, result: initialized });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}; co·ode supports ${PROTOCOL_VERSION}.`);
      }
      const session = await setupSession(context, initialized.agentCapabilities, options, command.newSessionParameters);
      providerSessionId = session.sessionID;
      cancelActive = async () => {
        if (command.stopSessionOnCancel) await context.request("session/stop", { sessionId: session.sessionID });
        else await context.notify(methods.agent.session.cancel, { sessionId: session.sessionID });
      };
      await configureSession(context, session, options, command.harness);
      const promptParams = {
        sessionId: session.sessionID,
        prompt: [
          { type: "text" as const, text: prompt },
          ...(initialized.agentCapabilities?.promptCapabilities?.image ? await nativeImageAttachments(options.attachments) : []),
        ],
      };
      raw("coodeToProvider", { method: methods.agent.session.prompt, params: promptParams });
      promptInFlight = true;
      const response = await context.request(methods.agent.session.prompt, promptParams, { cancellationSignal: options.signal }) as PromptResponse;
      promptInFlight = false;
      raw("providerToCoode", { method: methods.agent.session.prompt, result: response });
      if (response.usage) observed.usage = true;
      capabilityReceipt = receiptFor(command, initialized, observed);
      options.onCapabilityReceipt?.(capabilityReceipt);
      return response;
    });
    const response = await Promise.race([workflow, childError]);
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      childClosed,
      new Promise<number>((resolve) => setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve(child.exitCode ?? 0);
      }, 1_500)),
    ]);
    return {
      exitCode: closeCodeForStopReason(response.stopReason),
      stdout,
      stderr: stderr || (["max_tokens", "max_turn_requests"].includes(response.stopReason)
        ? `${command.harness} stopped at its native turn limit. Continue the saved session to finish.` : ""),
      providerSessionId,
      capabilityReceipt,
    };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: options.signal?.aborted ? 130 : child.exitCode === null ? 1 : child.exitCode || 1,
      stdout,
      stderr: stderr || message,
      providerSessionId,
      capabilityReceipt,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
