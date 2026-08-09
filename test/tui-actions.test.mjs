import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActions,
  parseSlashCommand,
  resolveMenuKey,
  resolvePaletteKey,
  resolveProviderCommand,
  resolveRunKey,
  resolveTaskKey,
  slashHelpText,
} from "../dist/tui-actions.js";

test("buildActions reflects room, login, task, terminal, and run state", () => {
  const actions = buildActions({
    hasRoom: true,
    loggedIn: true,
    taskRunning: false,
    terminalActive: true,
    runCount: 2,
  });

  assert.equal(actions.find((action) => action.id === "task")?.enabled, true);
  assert.equal(actions.find((action) => action.id === "join")?.label, "Focus shared terminal");
  assert.equal(actions.find((action) => action.id === "run")?.enabled, true);
  assert.equal(actions.find((action) => action.id === "help")?.key, "?");
  assert.equal(actions.find((action) => action.id === "help")?.enabled, true);

  const disabled = buildActions({
    hasRoom: false,
    loggedIn: false,
    taskRunning: true,
    terminalActive: false,
    runCount: 0,
  });
  assert.equal(disabled.find((action) => action.id === "task")?.enabled, false);
  assert.equal(disabled.find((action) => action.id === "init")?.enabled, false);
  assert.equal(disabled.find((action) => action.id === "login")?.enabled, true);
});

test("buildActions labels disconnected terminal as reconnectable", () => {
  const actions = buildActions({
    hasRoom: true,
    loggedIn: true,
    taskRunning: false,
    terminalActive: false,
    terminalDisconnected: true,
    runCount: 0,
  });

  assert.equal(actions.find((action) => action.id === "join")?.label, "Reconnect shared terminal");
  assert.equal(actions.find((action) => action.id === "join")?.hint, "restore the room shell connection");
});

test("slash command parsing defaults to help and preserves args", () => {
  assert.deepEqual(parseSlashCommand("/"), { command: "help", args: [] });
  assert.deepEqual(parseSlashCommand("/provider opencode"), { command: "provider", args: ["opencode"] });
  assert.deepEqual(parseSlashCommand("/exit"), { command: "quit", args: [] });
  assert.match(slashHelpText(), /\/run \[id\|index\]/);
  assert.match(slashHelpText(), /\/sessions/);
  assert.match(slashHelpText(), /\/session/);
  assert.match(slashHelpText(), /\/undo/);
  assert.match(slashHelpText(), /\/room <pinned-room>/);
  assert.match(slashHelpText(), /\/handoff-target/);
  assert.match(slashHelpText(), /\/handoff/);
  assert.match(slashHelpText(), /\/agent-start/);
  assert.match(slashHelpText(), /\/resume/);
  assert.match(slashHelpText(), /\/fork/);
  assert.match(slashHelpText(), /\/stop/);
  assert.match(slashHelpText(), /\/history/);
  assert.match(slashHelpText(), /\/use-history/);
  assert.match(slashHelpText(), /\/again/);
  assert.match(slashHelpText(), /\/find <query>/);
  assert.match(slashHelpText(), /\/runtime/);
  assert.match(slashHelpText(), /\/env start/);
  assert.match(slashHelpText(), /\/exit/);
  assert.match(slashHelpText(), /\/doctor/);
  assert.match(slashHelpText(), /\/qa \[live\]/);
  assert.match(slashHelpText(), /\/live-qa/);
  assert.match(slashHelpText(), /\/diff/);
  assert.match(slashHelpText(), /\/symbols/);
  assert.match(slashHelpText(), /\/goto/);
  assert.match(slashHelpText(), /\/rename-preview/);
  assert.match(slashHelpText(), /\/diagnostics/);
  assert.match(slashHelpText(), /\/context/);
  assert.match(slashHelpText(), /\/attach-image/);
  assert.match(slashHelpText(), /\/instructions/);
  assert.match(slashHelpText(), /\/memory/);
  assert.match(slashHelpText(), /\/reconnect/);
});

test("provider command cycles, validates, and reports availability", () => {
  assert.deepEqual(
    resolveProviderCommand({
      current: "opencode",
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

test("menu keys resolve to renderer-neutral intents", () => {
  const actions = buildActions({
    hasRoom: true,
    loggedIn: true,
    taskRunning: false,
    terminalActive: false,
    runCount: 1,
  });

  assert.deepEqual(resolveMenuKey("", { name: "down" }, actions, 0), { type: "select", selected: 1 });
  assert.deepEqual(resolveMenuKey("", { name: "up" }, actions, 0), { type: "select", selected: actions.length - 1 });
  assert.equal(resolveMenuKey("", { name: "return" }, actions, 0).type, "execute");
  assert.deepEqual(resolveMenuKey("", { name: "p", ctrl: true }, actions, 0), { type: "open_palette" });
  assert.deepEqual(resolveMenuKey("", { name: "f", ctrl: true }, actions, 0), { type: "start_find" });
  assert.deepEqual(resolveMenuKey("?", {}, actions, 0), { type: "open_help" });
  assert.deepEqual(resolveMenuKey("/", {}, actions, 0), { type: "start_slash" });
  assert.deepEqual(resolveMenuKey("3", {}, actions, 0), { type: "open_run", index: 2 });
  assert.equal(resolveMenuKey("", { name: "v" }, actions, 0).type, "execute");
});

test("task keys resolve editing, history, submit, and append intents", () => {
  assert.deepEqual(resolveTaskKey("", { name: "escape" }), { type: "cancel" });
  assert.deepEqual(resolveTaskKey("", { name: "u", ctrl: true }), { type: "clear" });
  assert.deepEqual(resolveTaskKey("", { name: "j", ctrl: true }), { type: "append", text: "\n" });
  assert.deepEqual(resolveTaskKey("", { name: "backspace" }), { type: "backspace" });
  assert.deepEqual(resolveTaskKey("", { name: "up" }), { type: "history", direction: -1 });
  assert.deepEqual(resolveTaskKey("", { name: "return" }), { type: "submit" });
  assert.deepEqual(resolveTaskKey("a", {}), { type: "append", text: "a" });
});

test("run keys resolve navigation and patch review intents", () => {
  assert.deepEqual(resolveRunKey("", { name: "escape" }), { type: "back" });
  assert.deepEqual(resolveRunKey("", { name: "f" }), { type: "refresh" });
  assert.deepEqual(resolveRunKey("", { name: "j" }), { type: "move_patch", direction: 1 });
  assert.deepEqual(resolveRunKey("", { name: "k" }), { type: "move_patch", direction: -1 });
  assert.deepEqual(resolveRunKey("", { name: "g" }), { type: "select_patch", position: "first" });
  assert.deepEqual(resolveRunKey("G", { name: "g" }), { type: "select_patch", position: "last" });
  assert.deepEqual(resolveRunKey("", { name: "a" }), { type: "accept_patch" });
  assert.deepEqual(resolveRunKey("", { name: "x" }), { type: "reject_patch" });
  assert.deepEqual(resolveRunKey("", { name: "e" }), { type: "export_run" });
  assert.deepEqual(resolveRunKey("", { name: "y" }), { type: "copy_run" });
  assert.deepEqual(resolveRunKey("", { name: "c" }), { type: "copy_run" });
  assert.deepEqual(resolveRunKey("R", { name: "r" }), { type: "retry_run" });
  assert.deepEqual(resolveRunKey("", { name: "s" }), { type: "stop_run" });
  assert.deepEqual(resolveRunKey("", { name: "h" }), { type: "handoff_run" });
  assert.deepEqual(resolveRunKey("[", {}), { type: "cycle_handoff_target", direction: -1 });
  assert.deepEqual(resolveRunKey("]", {}), { type: "cycle_handoff_target", direction: 1 });
  assert.deepEqual(resolveRunKey("9", {}), { type: "open_run", index: 8 });
});

test("palette keys resolve filtering, navigation, and submit intents", () => {
  assert.deepEqual(resolvePaletteKey("", { name: "escape" }), { type: "cancel" });
  assert.deepEqual(resolvePaletteKey("", { name: "u", ctrl: true }), { type: "clear" });
  assert.deepEqual(resolvePaletteKey("", { name: "backspace" }), { type: "backspace" });
  assert.deepEqual(resolvePaletteKey("", { name: "up" }), { type: "move", direction: -1 });
  assert.deepEqual(resolvePaletteKey("", { name: "n", ctrl: true }), { type: "move", direction: 1 });
  assert.deepEqual(resolvePaletteKey("", { name: "return" }), { type: "submit" });
  assert.deepEqual(resolvePaletteKey("h", {}), { type: "append", text: "h" });
});
