import test from "node:test";
import assert from "node:assert/strict";

import { resolveTuiRendererSelection, chatViewLaunchArgs } from "../dist/tui-renderer-option.js";

test("resolveTuiRendererSelection defaults to chat and strips renderer flags", () => {
  assert.deepEqual(
    resolveTuiRendererSelection(["room-a", "--provider", "opencode"]),
    { renderer: "chat", args: ["room-a", "--provider", "opencode"] },
  );

  assert.deepEqual(
    resolveTuiRendererSelection(["room-a", "--renderer", "node", "--smoke-test"]),
    { renderer: "node", args: ["room-a", "--smoke-test"] },
  );
});

test("resolveTuiRendererSelection accepts OpenTUI aliases", () => {
  assert.deepEqual(
    resolveTuiRendererSelection(["--renderer", "opentui", "--smoke-test"]),
    { renderer: "opentui", args: ["--smoke-test"] },
  );

  assert.deepEqual(
    resolveTuiRendererSelection(["--renderer=bun", "--provider", "codex"]),
    { renderer: "opentui", args: ["--provider", "codex"] },
  );
});

test("resolveTuiRendererSelection reports missing and invalid renderer values", () => {
  assert.match(resolveTuiRendererSelection(["--renderer"]).error || "", /Missing value/);
  assert.match(resolveTuiRendererSelection(["--renderer", "browser"]).error || "", /Unsupported TUI renderer/);
});

test("--renderer chat resolves to the chat renderer", () => {
  const result = resolveTuiRendererSelection(["--renderer", "chat", "--dir", "/tmp"]);
  assert.equal(result.renderer, "chat");
  assert.deepEqual(result.args, ["--dir", "/tmp"]);
});

test("chat renderer maps onto the opentui host with a chat view arg", () => {
  const plan = chatViewLaunchArgs(resolveTuiRendererSelection(["--renderer", "chat", "--dir", "/tmp"]));
  assert.deepEqual(plan, ["--view", "chat", "--dir", "/tmp"]);
});

test("node renderer launch args are unchanged (no --view)", () => {
  const plan = chatViewLaunchArgs(resolveTuiRendererSelection(["--renderer", "node", "--dir", "/tmp"]));
  assert.deepEqual(plan, ["--dir", "/tmp"]);
});
