import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyPins,
  isPinnedAgent,
  isPinnedProvider,
  isPinnedRoom,
  normalizePins,
  pinAgent,
  pinProvider,
  pinRoom,
  pinSummaryLines,
  unpinTarget,
} from "../dist/tui-pins.js";

test("normalizePins trims, dedupes, and bounds pin groups", () => {
  const pins = normalizePins({
    rooms: [
      { roomId: " room-a ", roomName: " Alpha " },
      { roomId: "room-a", roomName: "Latest Alpha" },
      { roomId: "" },
    ],
    providers: [" opencode ", "codex", "opencode", ""],
    agents: [
      { agentId: "agent-a", name: "Builder" },
      { agentId: "agent-a", name: "Latest Builder" },
      { agentId: "" },
    ],
  });

  assert.deepEqual(pins.rooms, [{ roomId: "room-a", roomName: "Latest Alpha" }]);
  assert.deepEqual(pins.providers, ["codex", "opencode"]);
  assert.deepEqual(pins.agents, [{ agentId: "agent-a", name: "Latest Builder" }]);
});

test("pin helpers add latest pin and unpin by id or display name", () => {
  let pins = emptyPins();
  pins = pinRoom(pins, { roomId: "room-a", roomName: "Alpha" });
  pins = pinProvider(pins, "opencode");
  pins = pinAgent(pins, { agentId: "agent-a", name: "Builder", provider: "opencode" });

  assert.equal(isPinnedRoom(pins, "room-a"), true);
  assert.equal(isPinnedProvider(pins, "opencode"), true);
  assert.equal(isPinnedAgent(pins, "agent-a"), true);

  pins = unpinTarget(pins, "room", "Alpha");
  pins = unpinTarget(pins, "provider", "opencode");
  pins = unpinTarget(pins, "agent", "Builder");

  assert.equal(isPinnedRoom(pins, "room-a"), false);
  assert.equal(isPinnedProvider(pins, "opencode"), false);
  assert.equal(isPinnedAgent(pins, "agent-a"), false);
});

test("pinSummaryLines returns compact human-readable groups", () => {
  const pins = {
    rooms: [{ roomId: "room-a", roomName: "Alpha" }],
    providers: ["opencode"],
    agents: [{ agentId: "agent-a", name: "Builder" }],
  };

  assert.deepEqual(pinSummaryLines(pins), [
    "rooms     Alpha",
    "providers opencode",
    "agents    Builder",
  ]);
  assert.deepEqual(pinSummaryLines(emptyPins()), [
    "rooms     none",
    "providers none",
    "agents    none",
  ]);
});
