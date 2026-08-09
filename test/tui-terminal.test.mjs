import test from "node:test";
import assert from "node:assert/strict";

import {
  appendTerminalOutputLines,
  connectTuiTerminal,
  createTerminalConnectionState,
  createRealtimeSession,
  isTerminalConnectedStatus,
  isTerminalConnectingStatus,
  reduceTerminalConnectionState,
  resolveTerminalPaneSize,
} from "../dist/tui-terminal.js";

function createFetch(body, init = {}) {
  return async (url, options) => {
    init.onRequest?.(url, options);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      async json() {
        return body;
      },
    };
  };
}

test("isTerminalConnectedStatus only marks connected status messages as connected", () => {
  assert.equal(isTerminalConnectedStatus("Connected. Terminal is now shared with the room."), true);
  assert.equal(isTerminalConnectedStatus("Connecting to terminal gateway..."), false);
  assert.equal(isTerminalConnectedStatus("Disconnected from room."), false);
});

test("isTerminalConnectingStatus detects gateway connection progress", () => {
  assert.equal(isTerminalConnectingStatus("Connecting to terminal gateway..."), true);
  assert.equal(isTerminalConnectingStatus("Connected. Terminal is now shared with the room."), false);
});

test("reduceTerminalConnectionState tracks connecting, connected, and closed reasons", () => {
  let state = createTerminalConnectionState();
  state = reduceTerminalConnectionState(state, { type: "connecting" }, 100);
  assert.deepEqual(state, { connected: false, connecting: true });

  state = reduceTerminalConnectionState(
    state,
    { type: "status", message: "Connected. Terminal is now shared with the room.", connected: true },
    200,
  );
  assert.deepEqual(state, { connected: true, connecting: false });

  state = reduceTerminalConnectionState(state, { type: "error", message: "WebSocket error: boom" }, 300);
  assert.deepEqual(state, {
    connected: false,
    connecting: false,
    disconnectReason: "WebSocket error: boom",
    closedAt: 300,
  });

  state = reduceTerminalConnectionState(state, { type: "closed", reason: "WebSocket closed (1006)" }, 400);
  assert.deepEqual(state, {
    connected: false,
    connecting: false,
    disconnectReason: "WebSocket closed (1006)",
    closedAt: 400,
  });
});

test("resolveTerminalPaneSize keeps a stable embedded PTY size", () => {
  assert.deepEqual(resolveTerminalPaneSize(120, 40), { columns: 120, rows: 14 });
  assert.deepEqual(resolveTerminalPaneSize(10, 10), { columns: 20, rows: 12 });
  assert.deepEqual(resolveTerminalPaneSize(), { columns: 80, rows: 12 });
});

test("appendTerminalOutputLines normalizes output lines and caps scrollback", () => {
  assert.deepEqual(appendTerminalOutputLines(["old"], "one\r\ntwo\n"), ["old", "one", "two"]);
  assert.deepEqual(appendTerminalOutputLines(["a", "b"], "c\nd\ne", 3), ["c", "d", "e"]);
});

test("createRealtimeSession posts to the room realtime endpoint", async () => {
  let requestUrl = "";
  let requestOptions = {};
  const result = await createRealtimeSession({
    serverUrl: "https://co-od.example",
    roomId: "room-a",
    sessionToken: "session-token",
    fetchImpl: createFetch(
      { token: "realtime-token", terminalWsUrl: "ws://terminal" },
      {
        onRequest(url, options) {
          requestUrl = url;
          requestOptions = options;
        },
      },
    ),
  });

  assert.deepEqual(result, { token: "realtime-token", terminalWsUrl: "ws://terminal" });
  assert.equal(requestUrl, "https://co-od.example/api/rooms/room-a/realtime/session");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers.authorization, "Bearer session-token");
  assert.equal(requestOptions.body, JSON.stringify({ ttlSeconds: 3600 }));
});

test("createRealtimeSession rejects missing terminal connection details", async () => {
  await assert.rejects(
    () =>
      createRealtimeSession({
        serverUrl: "https://co-od.example",
        roomId: "room-a",
        sessionToken: "session-token",
        fetchImpl: createFetch({ token: "realtime-token" }),
      }),
    /Realtime session did not include terminal connection details/,
  );
});

test("connectTuiTerminal maps session hooks into renderer-neutral events", async () => {
  const events = [];
  let capturedHooks;
  let resizedTo;
  let sessionOptions;

  const result = await connectTuiTerminal({
    serverUrl: "https://co-od.example",
    roomId: "room-a",
    sessionToken: "session-token",
    workDir: "/tmp/project",
    columns: 100,
    rows: 18,
    fetchImpl: createFetch({ token: "realtime-token", terminalWsUrl: "ws://terminal" }),
    createSession(options, hooks) {
      sessionOptions = options;
      capturedHooks = hooks;
      return {
        write() {},
        resize(cols, rows) {
          resizedTo = { cols, rows };
        },
        close() {},
        async waitUntilClosed() {},
      };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sessionOptions, {
    terminalWsUrl: "ws://terminal",
    realtimeToken: "realtime-token",
    roomId: "room-a",
    workDir: "/tmp/project",
    serverUrl: "https://co-od.example",
    sessionToken: "session-token",
  });
  assert.deepEqual(resizedTo, { cols: 100, rows: 18 });
  assert.deepEqual(events, [{ type: "connecting" }]);

  capturedHooks.onStatus("Connected. Terminal is now shared with the room.");
  capturedHooks.onOutput("hello");
  capturedHooks.onError("socket failed");
  capturedHooks.onClose("WebSocket closed (1006)");

  assert.deepEqual(events, [
    { type: "connecting" },
    { type: "status", message: "Connected. Terminal is now shared with the room.", connected: true },
    { type: "output", data: "hello" },
    { type: "error", message: "socket failed" },
    { type: "closed", reason: "WebSocket closed (1006)" },
  ]);
});

test("connectTuiTerminal returns a failure result and emits an error event", async () => {
  const events = [];
  const result = await connectTuiTerminal({
    serverUrl: "https://co-od.example",
    roomId: "room-a",
    sessionToken: "session-token",
    workDir: "/tmp/project",
    columns: 100,
    rows: 18,
    fetchImpl: createFetch(
      {},
      {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      },
    ),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    ok: false,
    errorMessage: "Failed to create realtime session: 401 Unauthorized",
  });
  assert.deepEqual(events, [
    { type: "connecting" },
    { type: "error", message: "Failed to create realtime session: 401 Unauthorized" },
  ]);
});
