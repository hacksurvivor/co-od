import test from "node:test";
import assert from "node:assert/strict";

import { resolveRemoteCliAdapterProvider } from "../dist/promptRunner.js";

test("remote CLI provider aliases resolve to local adapters", () => {
  assert.equal(resolveRemoteCliAdapterProvider(), "claude");
  assert.equal(resolveRemoteCliAdapterProvider("remote_cli"), "claude");
  assert.equal(resolveRemoteCliAdapterProvider("anthropic"), "claude");
  assert.equal(resolveRemoteCliAdapterProvider("openai"), "codex");
  assert.equal(resolveRemoteCliAdapterProvider("chatgpt"), "codex");
  assert.equal(resolveRemoteCliAdapterProvider("local_codex"), "codex");
  assert.equal(resolveRemoteCliAdapterProvider("opencode"), "opencode");
  assert.equal(resolveRemoteCliAdapterProvider("local_opencode"), "opencode");
  assert.equal(resolveRemoteCliAdapterProvider("zeroclaw"), "zeroclaw");
  assert.equal(resolveRemoteCliAdapterProvider("local_openclaw"), "openclaw");
  assert.equal(resolveRemoteCliAdapterProvider("local_zeroclaw"), "zeroclaw");
  assert.equal(resolveRemoteCliAdapterProvider("pi-agent"), "pi");
  assert.equal(resolveRemoteCliAdapterProvider("hermes-agent"), "hermes");
  assert.equal(resolveRemoteCliAdapterProvider("local_hermes"), "hermes");
});

test("remote CLI hosted-only providers fail closed", () => {
  assert.throws(
    () => resolveRemoteCliAdapterProvider("gemini"),
    /Unsupported remote CLI provider/,
  );
  assert.throws(
    () => resolveRemoteCliAdapterProvider("xai"),
    /Unsupported remote CLI provider/,
  );
});
