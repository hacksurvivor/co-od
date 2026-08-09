import test from "node:test";
import assert from "node:assert/strict";

import {
  formatEnvMutation,
  formatEnvStatus,
  resolveEnvCommand,
} from "../dist/tui-env.js";

test("resolveEnvCommand supports status, subcommands, aliases, and ttl", () => {
  assert.deepEqual(resolveEnvCommand("runtime", []), {
    ok: true,
    action: "status",
    message: "Runtime status.",
  });
  assert.deepEqual(resolveEnvCommand("env", ["start", "7200"]), {
    ok: true,
    action: "start",
    ttlSeconds: 7200,
    message: "Runtime start requested for 7200s.",
  });
  assert.deepEqual(resolveEnvCommand("env-stop", []), {
    ok: true,
    action: "stop",
    message: "Runtime stop.",
  });
  assert.deepEqual(resolveEnvCommand("runtime-touch", []), {
    ok: true,
    action: "touch",
    message: "Runtime touch.",
  });
});

test("resolveEnvCommand rejects invalid subcommands and ttl values", () => {
  assert.equal(resolveEnvCommand("env", ["restart"]).ok, false);
  assert.equal(resolveEnvCommand("env-start", ["later"]).message, "Runtime TTL must be a positive whole number of seconds.");
  assert.equal(resolveEnvCommand("runtime-stop", ["extra"]).ok, false);
});

test("formatEnvStatus prefers orchestrator state and includes service details", () => {
  const output = formatEnvStatus({
    ok: true,
    runtimeAvailable: true,
    convex: { status: "starting" },
    orchestrator: {
      ok: true,
      env: {
        status: "running",
        provider: "docker",
        publicUrl: "https://runtime.example",
        daemonUrl: "http://daemon",
        termWsUrl: "wss://term",
        containerId: "container-a",
        ttlSeconds: 3600,
      },
    },
  });

  assert.match(output, /Runtime: running via docker/);
  assert.match(output, /Service: orchestrator available/);
  assert.match(output, /Convex: starting/);
  assert.match(output, /Preview: https:\/\/runtime\.example/);
  assert.match(output, /Terminal: wss:\/\/term/);
  assert.match(output, /TTL: 3600s/);
});

test("formatEnvStatus falls back when orchestrator is unavailable", () => {
  const output = formatEnvStatus({
    ok: true,
    runtimeAvailable: false,
    convex: { status: "stopped" },
    orchestrator: null,
  });

  assert.match(output, /Runtime: stopped/);
  assert.match(output, /Service: orchestrator unavailable/);
});

test("formatEnvMutation extracts direct, nested, and orchestrator env payloads", () => {
  assert.match(
    formatEnvMutation("start", {
      ok: true,
      env: {
        status: "running",
        provider: "memory",
        publicUrl: "https://preview.example",
      },
    }),
    /Runtime started: running via memory\nPreview: https:\/\/preview\.example/,
  );

  assert.match(
    formatEnvMutation("stop", {
      ok: true,
      env: {
        status: "stopped",
        env: {
          status: "stopped",
          provider: "docker",
        },
      },
    }),
    /Runtime stopped: stopped via docker/,
  );

  assert.match(
    formatEnvMutation("touch", {
      ok: true,
      orchestrator: {
        ok: true,
        env: {
          status: "running",
          lastTouchedAt: 1_800_000_000_000,
        },
      },
    }),
    /Touched: 2027-01-15T08:00:00.000Z/,
  );
});
