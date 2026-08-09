import test from "node:test";
import assert from "node:assert/strict";

import { runTuiTask } from "../dist/tui-task.js";
import {
  buildRoomTaskCompletionPayload,
  extractProviderSessionIdFromRun,
} from "../dist/commands/run.js";

test("runTuiTask emits submitted, status, output, and complete events", async () => {
  const events = [];
  const result = await runTuiTask({
    roomId: "room-a",
    goal: "Fix tests",
    provider: "opencode",
    dir: "/tmp/project",
    executeTask: async (options) => {
      assert.equal(options.roomId, "room-a");
      assert.equal(options.goal, "Fix tests");
      assert.equal(options.provider, "opencode");
      assert.equal(options.dir, "/tmp/project");
      assert.equal(options.continueRunId, undefined);
      options.onStatus?.("created");
      options.onOutput?.("hello");
      return {
        runId: "run-a",
        status: "succeeded",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
      };
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, {
    ok: true,
    result: {
      runId: "run-a",
      status: "succeeded",
      exitCode: 0,
      stdout: "hello",
      stderr: "",
    },
  });
  assert.deepEqual(events, [
    {
      type: "submitted",
      provider: "opencode",
      goal: "Fix tests",
      model: undefined,
      continueRunId: undefined,
      agentId: undefined,
    },
    { type: "status", message: "created" },
    { type: "output", data: "hello" },
    {
      type: "complete",
      result: {
        runId: "run-a",
        status: "succeeded",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
      },
    },
  ]);
});

test("runTuiTask emits error and returns failure result", async () => {
  const events = [];
  const result = await runTuiTask({
    roomId: "room-a",
    goal: "Break",
    provider: "codex",
    dir: "/tmp/project",
    executeTask: async () => {
      throw new Error("adapter missing");
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, errorMessage: "adapter missing" });
  assert.deepEqual(events, [
    {
      type: "submitted",
      provider: "codex",
      goal: "Break",
      model: undefined,
      continueRunId: undefined,
      agentId: undefined,
    },
    { type: "error", message: "adapter missing" },
  ]);
});

test("runTuiTask passes continuation run id to executor", async () => {
  const events = [];
  const result = await runTuiTask({
    roomId: "room-a",
    goal: "Follow up",
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-5",
    dir: "/tmp/project",
    attachments: [{ path: "screen.png", absolutePath: "/tmp/project/screen.png", kind: "image", exists: true }],
    continueRunId: "run-a",
    agentId: "agent-a",
    executeTask: async (options) => {
      assert.equal(options.continueRunId, "run-a");
      assert.equal(options.agentId, "agent-a");
      assert.equal(options.model, "anthropic/claude-sonnet-4-5");
      assert.deepEqual(options.attachments, [
        { path: "screen.png", absolutePath: "/tmp/project/screen.png", kind: "image", exists: true },
      ]);
      return {
        runId: "run-a",
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events[0], {
    type: "submitted",
    provider: "opencode",
    goal: "Follow up",
    model: "anthropic/claude-sonnet-4-5",
    continueRunId: "run-a",
    agentId: "agent-a",
  });
});

test("runTuiTask passes provider session context to executor", async () => {
  const providerSession = {
    mode: "fork",
    sourceRunId: "run-a",
    providerSessionId: "opencode-session-a",
  };
  const result = await runTuiTask({
    roomId: "room-a",
    goal: "Try a branch",
    provider: "opencode",
    dir: "/tmp/project",
    providerSession,
    executeTask: async (options) => {
      assert.deepEqual(options.providerSession, providerSession);
      return {
        runId: "run-b",
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(result.ok, true);
});

test("extractProviderSessionIdFromRun finds common provider session payload keys", () => {
  assert.equal(extractProviderSessionIdFromRun({
    _id: "run-a",
    status: "succeeded",
    steps: [{
      kind: "observation",
      output: {
        payload: {
          provider_session_id: "session-from-output",
        },
      },
    }],
  }), "session-from-output");

  assert.equal(extractProviderSessionIdFromRun({
    _id: "run-b",
    status: "succeeded",
    steps: [{
      kind: "plan",
      input: {
        payload: {
          threadId: "thread-from-input",
        },
      },
    }],
  }), "thread-from-input");

  assert.equal(extractProviderSessionIdFromRun({
    _id: "run-c",
    status: "succeeded",
    steps: [
      {
        kind: "observation",
        output: {
          payload: {
            providerSessionId: "older-session",
          },
        },
      },
      {
        kind: "completion",
        output: {
          payload: {
            providerSessionId: "newer-session",
          },
        },
      },
    ],
  }), "newer-session");
});

test("buildRoomTaskCompletionPayload persists provider session id in final step payload", () => {
  assert.deepEqual(buildRoomTaskCompletionPayload({
    goal: "Follow up",
    continueRunId: "run-a",
    status: "succeeded",
    now: 123,
    result: {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      providerSessionId: "session-from-cli",
    },
  }), {
    ok: true,
    run: {
      status: "succeeded",
      steps: [
        {
          kind: "observation",
          input: { description: "Follow-up: Follow up" },
          output: {
            success: true,
            payload: {
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              providerSessionId: "session-from-cli",
            },
          },
          created_at: 123,
        },
      ],
    },
  });
});
