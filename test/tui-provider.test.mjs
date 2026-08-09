import test from "node:test";
import assert from "node:assert/strict";

import {
  cycleProvider,
  providerStatus,
  resolveInitialProvider,
  resolveLocalProviderForAgent,
  resolveModelCommand,
  resolveProviderCommand,
} from "../dist/tui-provider.js";

test("resolveInitialProvider honors explicit, configured, available, and previous providers", () => {
  assert.equal(
    resolveInitialProvider({
      argProvider: "opencode",
      configProvider: "codex",
      providerAvailability: { codex: true },
      previousProvider: "claude",
      providers: ["opencode", "codex", "claude"],
    }),
    "opencode",
  );

  assert.equal(
    resolveInitialProvider({
      configProvider: "codex",
      providerAvailability: { opencode: true },
      previousProvider: "claude",
      providers: ["opencode", "codex", "claude"],
    }),
    "codex",
  );

  assert.equal(
    resolveInitialProvider({
      providerAvailability: { opencode: false, codex: true },
      previousProvider: "claude",
      providers: ["opencode", "codex", "claude"],
    }),
    "codex",
  );

  assert.equal(
    resolveInitialProvider({
      providerAvailability: {},
      previousProvider: "claude",
      providers: ["opencode", "codex", "claude"],
    }),
    "claude",
  );

  assert.equal(
    resolveInitialProvider({
      providerAvailability: {},
      providers: ["opencode", "codex", "claude"],
    }),
    "opencode",
  );
});

test("provider helpers cycle and report availability", () => {
  assert.equal(cycleProvider("opencode", ["opencode", "codex"]), "codex");
  assert.equal(cycleProvider("unknown", ["opencode", "codex"]), "opencode");
  assert.equal(providerStatus("codex", { codex: true }), "available");
  assert.equal(providerStatus("claude", { codex: true }), "not found");
  assert.equal(providerStatus("opencode", {}), "checking");
});

test("resolveLocalProviderForAgent maps local room agents to CLI providers", () => {
  assert.equal(resolveLocalProviderForAgent({ provider: "opencode", execution_mode: "local_opencode" }), "opencode");
  assert.equal(resolveLocalProviderForAgent({ provider: "openai", execution_mode: "local_codex" }), "codex");
  assert.equal(resolveLocalProviderForAgent({ provider: "anthropic", execution_mode: "local_claude_code" }), "claude");
  assert.equal(resolveLocalProviderForAgent({ provider: "openai", execution_mode: "hosted_api" }), undefined);
});

test("resolveProviderCommand validates requested providers", () => {
  assert.deepEqual(
    resolveProviderCommand({
      current: "opencode",
      requested: "codex",
      availability: { codex: true },
      providers: ["opencode", "codex"],
    }),
    { ok: true, provider: "codex", message: "Provider set to codex (available)." },
  );

  assert.deepEqual(
    resolveProviderCommand({
      current: "opencode",
      requested: "claude",
      availability: {},
      providers: ["opencode", "codex"],
    }),
    {
      ok: false,
      provider: "opencode",
      message: "Unknown provider: claude. Available: opencode, codex.",
    },
  );
});

test("resolveModelCommand updates model state when a model name is provided", () => {
  assert.deepEqual(
    resolveModelCommand({
      current: { provider: "opencode" },
      requested: "gpt-5",
    }),
    {
      ok: true,
      state: { provider: "opencode", model: "gpt-5" },
      message: "Model set to gpt-5.",
    },
  );

  assert.deepEqual(
    resolveModelCommand({
      current: { provider: "opencode", model: "gpt-5" },
      requested: "",
    }),
    {
      ok: false,
      state: { provider: "opencode", model: "gpt-5" },
      message: "Model selection needs a model name, for example /model gpt-5.",
    },
  );
});
