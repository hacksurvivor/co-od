import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaletteItems,
  composerSuggestions,
  filterPaletteItems,
  providerMentionTargets,
  scorePaletteMatch,
  slashCommandSuggestions,
} from "../dist/tui-palette.js";

const actions = [
  {
    id: "task",
    key: "t",
    label: "Run an agent task",
    hint: "type a prompt and execute locally",
    enabled: true,
  },
  {
    id: "join",
    key: "c",
    label: "Connect shared terminal",
    hint: "embed room shell in this TUI",
    enabled: false,
  },
  {
    id: "help",
    key: "?",
    label: "Keyboard help",
    hint: "show keybindings and terminal controls",
    enabled: true,
  },
];

test("buildPaletteItems includes actions, slash commands, providers, room, agents, and runs", () => {
  const items = buildPaletteItems({
    actions,
    providers: ["opencode", "codex"],
    providerAvailability: { opencode: true },
    agents: [
      {
        _id: "agent-a",
        name: "Builder",
        provider: "opencode",
        execution_mode: "local_cli",
      },
    ],
    runs: [
      {
        _id: "run-a",
        goal: "Fix dashboard",
        status: "succeeded",
      },
    ],
    room: { roomId: "room-a", roomName: "Alpha" },
    rooms: [{ roomId: "room-c", roomName: "Gamma" }],
    files: ["packages/cli/src/tui.ts"],
    pins: {
      rooms: [
        { roomId: "room-a", roomName: "Alpha" },
        { roomId: "room-b", roomName: "Beta" },
      ],
      providers: ["opencode"],
      agents: [{ agentId: "agent-a", name: "Builder" }],
    },
  });

  assert.equal(items.some((item) => item.id === "action:task"), true);
  assert.equal(items.some((item) => item.id === "action:help"), true);
  assert.equal(items.some((item) => item.id === "slash:/undo"), true);
  assert.equal(items.some((item) => item.id === "slash:/health"), true);
  assert.equal(items.some((item) => item.id === "slash:/copy"), true);
  assert.equal(items.some((item) => item.id === "slash:/export"), true);
  assert.equal(items.some((item) => item.id === "slash:/fanout"), true);
  assert.equal(items.some((item) => item.id === "slash:/handoff"), true);
  assert.equal(items.some((item) => item.id === "slash:/resume"), true);
  assert.equal(items.some((item) => item.id === "slash:/fork"), true);
  assert.equal(items.some((item) => item.id === "slash:/stop"), true);
  assert.equal(items.some((item) => item.id === "slash:/history"), true);
  assert.equal(items.some((item) => item.id === "slash:/use-history"), true);
  assert.equal(items.some((item) => item.id === "slash:/again"), true);
  assert.equal(items.some((item) => item.id === "slash:/sessions"), true);
  assert.equal(items.some((item) => item.id === "slash:/session"), true);
  assert.equal(items.some((item) => item.id === "slash:/doctor"), true);
  assert.equal(items.some((item) => item.id === "slash:/qa"), true);
  assert.equal(items.some((item) => item.id === "slash:/live-qa"), true);
  assert.equal(items.some((item) => item.id === "slash:/runtime"), true);
  assert.equal(items.some((item) => item.id === "slash:/env"), true);
  assert.equal(items.some((item) => item.id === "slash:/env-start"), true);
  assert.equal(items.some((item) => item.id === "slash:/env-stop"), true);
  assert.equal(items.some((item) => item.id === "slash:/env-touch"), true);
  assert.equal(items.some((item) => item.id === "slash:/diff"), true);
  assert.equal(items.some((item) => item.id === "slash:/symbols"), true);
  assert.equal(items.some((item) => item.id === "slash:/goto"), true);
  assert.equal(items.some((item) => item.id === "slash:/rename-preview"), true);
  assert.equal(items.some((item) => item.id === "slash:/rename"), true);
  assert.equal(items.some((item) => item.id === "slash:/diagnostics"), true);
  assert.equal(items.some((item) => item.id === "slash:/context"), true);
  assert.equal(items.some((item) => item.id === "slash:/instructions"), true);
  assert.equal(items.some((item) => item.id === "slash:/attach-image"), true);
  assert.equal(items.some((item) => item.id === "slash:/reconnect"), true);
  assert.equal(items.some((item) => item.id === "slash:/pin"), true);
  assert.equal(items.some((item) => item.id === "slash:/pins"), true);
  assert.equal(items.find((item) => item.id === "provider:opencode")?.detail, "pinned provider available");
  assert.equal(items.find((item) => item.id === "provider:codex")?.detail, "provider not found");
  assert.match(items.find((item) => item.id === "room:room-a")?.detail || "", /pinned current room/);
  assert.match(items.find((item) => item.id === "room:room-b")?.detail || "", /pinned room/);
  assert.equal(items.find((item) => item.id === "room:room-b")?.label, "Beta");
  assert.match(items.find((item) => item.id === "room:room-c")?.detail || "", /room room-c/);
  assert.match(items.find((item) => item.id === "agent:agent-a")?.detail || "", /pinned opencode/);
  assert.equal(items.some((item) => item.id === "run:run-a"), true);
  assert.equal(items.find((item) => item.id === "file:packages/cli/src/tui.ts")?.filePath, "packages/cli/src/tui.ts");
});

test("slashCommandSuggestions completes partial slash commands before arguments", () => {
  assert.deepEqual(
    slashCommandSuggestions("/ren", 2).map((item) => item.command),
    ["/rename", "/rename-preview"],
  );
  assert.equal(slashCommandSuggestions("/env", 4).some((item) => item.command === "/env-start"), true);
  assert.equal(slashCommandSuggestions("/find query").length, 0);
  assert.equal(slashCommandSuggestions("plain task").length, 0);
});

test("provider mention targets expose exact provider agents before room agents", () => {
  const targets = providerMentionTargets({
    agents: [{ _id: "agent-codex-reviewer", name: "codex reviewer", provider: "codex" }],
    providerAvailability: { codex: true, claude: false, opencode: true },
    providerAuth: [
      { provider: "codex", label: "OpenAI Codex", status: "connected" },
      { provider: "claude", label: "Claude Code", status: "not_connected" },
    ],
  });

  assert.deepEqual(targets.slice(0, 2).map((target) => target.name), ["opencode", "codex"]);
  assert.equal(targets.some((target) => target.name === "codex reviewer"), true);

  const suggestions = composerSuggestions("@co", 3, targets, 4);
  assert.equal(suggestions[0].command, "@codex");
  assert.match(suggestions[0].detail, /connected|available/);
});

test("filterPaletteItems supports substring and fuzzy matching", () => {
  const items = buildPaletteItems({
    actions,
    providers: ["opencode", "codex"],
    providerAvailability: {},
    agents: [],
    runs: [{ _id: "run-a", goal: "Review proposed patch", status: "running" }],
    files: ["packages/cli/src/tui-palette.ts"],
  });

  assert.equal(filterPaletteItems(items, "health")[0].id, "slash:/health");
  assert.equal(filterPaletteItems(items, "rvptch")[0].id, "run:run-a");
  assert.equal(filterPaletteItems(items, "tui-palette")[0].id, "file:packages/cli/src/tui-palette.ts");
  assert.equal(filterPaletteItems(items, "no-match").length, 0);
});

test("scorePaletteMatch gives blank queries and direct matches usable scores", () => {
  const item = {
    id: "provider:opencode",
    kind: "provider",
    label: "opencode",
    detail: "provider available",
    enabled: true,
  };

  assert.equal(scorePaletteMatch(item, ""), 1);
  assert.equal(scorePaletteMatch(item, "open") > scorePaletteMatch(item, "ocd"), true);
  assert.equal(scorePaletteMatch(item, "zzz"), 0);
});
