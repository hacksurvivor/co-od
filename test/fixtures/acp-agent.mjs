import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const modes = {
  currentModeId: "edit",
  availableModes: [
    { id: "edit", name: "Edit" },
    { id: "plan", name: "Plan" },
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
};

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture-small",
    options: [
      { value: "fixture-small", name: "Fixture Small" },
      { value: "fixture-large", name: "Fixture Large" },
    ],
  },
  {
    id: "effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

let selectedModel = "fixture-small";
const sessionConfiguration = () => process.argv.includes("--legacy-models")
  ? { models: { currentModelId: selectedModel, availableModels: [{ modelId: "fixture-small", name: "Fixture Small" }, { modelId: "fixture-large", name: "Fixture Large" }] } }
  : { configOptions };

const fixture = agent({ name: "co-ode-acp-fixture" })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : params.protocolVersion,
    agentInfo: { name: "co-ode-acp-fixture", version: "1.0.0" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: {
        list: {},
        delete: {},
        additionalDirectories: {},
        fork: {},
        ...(process.argv.includes("--load-only") ? {} : { resume: {} }),
        close: {},
      },
      providers: {},
    },
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: "acp-session-new",
    modes,
    ...sessionConfiguration(),
  }))
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Prior answer replay" },
      },
    });
    return { modes, configOptions };
  })
  .onRequest(methods.agent.session.resume, () => ({ modes, configOptions }))
  .onRequest(methods.agent.session.fork, () => ({
    sessionId: "acp-session-fork",
    modes,
    configOptions,
  }))
  .onRequest("session/set_model", { parse: value => value }, ({ params }) => { selectedModel = params.modelId; return {}; })
  .onRequest(methods.agent.session.setMode, () => ({}))
  .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (process.argv.includes("--message-boundaries")) {
      for (const text of ["Preparing", " the edit."]) await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Prove the transport", priority: "high", status: "in_progress" }],
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Inspect the fixture",
        name: "read_file",
        kind: "read",
        status: "pending",
        rawInput: { path: "README.md", token: "must-redact" },
      },
    });
    const permission = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Inspect the fixture",
        name: "read_file",
        kind: "read",
        status: "pending",
        rawInput: { path: "README.md", secret: "must-redact" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (permission.outcome.outcome !== "selected") {
      return { stopReason: "cancelled" };
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { ok: true },
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "private fixture thought" },
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: process.argv.includes("--legacy-models") ? selectedModel : "ACP ready" },
      },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.01, currency: "USD" },
      },
    });
    if (process.argv.includes("--message-boundaries")) await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "message-2", content: { type: "text", text: "Finished." } },
    });
    return {
      stopReason: process.argv.includes("--token-limit") ? "max_tokens" : "end_turn",
      usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 },
    };
  });

const connection = fixture.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));

await connection.closed;
