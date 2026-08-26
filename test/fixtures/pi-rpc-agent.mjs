let buffer = "";

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const finishPrompt = () => {
  send({
    type: "message_update",
    usage: { input: 4, output: 2, totalTokens: 6 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ready" },
  });
  send({ type: "agent_settled" });
};

const handle = (command) => {
  if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({
      type: "message_update",
      usage: { input: 4, output: 1, totalTokens: 5 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Pi\u2028" },
    });
    send({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md", token: "must-redact" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "fixture content" }] },
      isError: false,
    });
    send({
      type: "extension_ui_request",
      id: "extension-confirm-1",
      method: "confirm",
      title: "Approve fixture extension?",
      message: "Exercise the native extension bridge.",
    });
    return;
  }
  if (command.type === "extension_ui_response" && command.id === "extension-confirm-1") {
    if (command.confirmed !== true) process.exitCode = 2;
    finishPrompt();
    return;
  }
  if (command.type === "get_commands") {
    send({
      id: command.id,
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [{ name: "fixture", source: "extension" }] },
    });
    return;
  }
  if (command.type === "steer") {
    send({ id: command.id, type: "response", command: "steer", success: true });
    return;
  }
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "pi-session-fixture", isStreaming: false },
    });
    return;
  }
  if (command.type === "get_session_stats") {
    send({
      id: command.id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        tokens: { input: 4, output: 2, total: 6 },
        cost: 0.001,
        credential: "must-redact",
      },
    });
    return;
  }
  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: "abort", success: true });
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
