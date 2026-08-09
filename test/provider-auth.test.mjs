import test from "node:test";
import assert from "node:assert/strict";

import {
  checkAllProviderAuth,
  checkProviderAuth,
  providerAuthProviders,
} from "../dist/provider-auth.js";

// These tests deliberately exercise only the pure, hermetic branches of the
// provider-auth module: provider metadata, the unknown-provider guard, and
// environment-variable credential detection (which short-circuits before any
// home-directory file or ledger read). The persistence helpers
// (readProviderAuthState / writeProviderAuthState / logoutProvider) write to
// the real ~/.co-ode/auth.json and are intentionally left for an integration
// harness with a sandboxed HOME, rather than clobbering the developer's file.

test("providerAuthProviders lists the supported CLI providers with labels", () => {
  assert.deepEqual(providerAuthProviders(), [
    { provider: "codex", label: "OpenAI Codex", command: "codex" },
    { provider: "claude", label: "Claude Code", command: "claude" },
    { provider: "gemini", label: "Google Gemini CLI", command: "gemini" },
  ]);
});

test("checkProviderAuth reports an unknown provider as cli_missing", () => {
  const check = checkProviderAuth("does-not-exist");
  assert.equal(check.provider, "does-not-exist");
  assert.equal(check.installed, false);
  assert.equal(check.status, "cli_missing");
  assert.match(check.detail, /Unknown provider auth target: does-not-exist/);
});

test("checkProviderAuth treats a populated credential env var as connected", () => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-value";
  try {
    const check = checkProviderAuth("gemini");
    assert.equal(check.status, "connected");
    assert.equal(check.source, "GEMINI_API_KEY");
    assert.equal(check.label, "Google Gemini CLI");
    assert.match(check.detail, /credentials found in GEMINI_API_KEY/);
  } finally {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  }
});

test("checkProviderAuth ignores a blank credential env var", () => {
  const original = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "   ";
  try {
    const check = checkProviderAuth("gemini");
    // A whitespace-only value must not count as connected via the env branch.
    assert.notEqual(check.source, "GEMINI_API_KEY");
  } finally {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  }
});

test("checkAllProviderAuth returns exactly one check per known provider", () => {
  const checks = checkAllProviderAuth();
  assert.deepEqual(
    checks.map((check) => check.provider),
    ["codex", "claude", "gemini"],
  );
  for (const check of checks) {
    assert.ok(["connected", "not_connected", "cli_missing"].includes(check.status));
    assert.equal(typeof check.detail, "string");
  }
});
