import test from "node:test";
import assert from "node:assert/strict";

import {
  isPrimaryMousePress,
  parseSgrMouse,
} from "../dist/tui-mouse.js";

test("parseSgrMouse parses primary press coordinates", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;12;7M"), {
    button: 0,
    column: 12,
    row: 7,
    released: false,
    type: "press",
  });
});

test("parseSgrMouse distinguishes release, drag, and scroll events", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;12;7m"), {
    button: 0,
    column: 12,
    row: 7,
    released: true,
    type: "release",
  });
  assert.equal(parseSgrMouse("\x1b[<32;4;5M")?.type, "drag");
  assert.equal(parseSgrMouse("\x1b[<64;4;5M")?.type, "scroll");
});

test("parseSgrMouse rejects unrelated input", () => {
  assert.equal(parseSgrMouse("\x1b[A"), null);
  assert.equal(parseSgrMouse("plain text"), null);
});

test("isPrimaryMousePress only accepts left button presses", () => {
  const primary = parseSgrMouse("\x1b[<0;1;1M");
  const release = parseSgrMouse("\x1b[<0;1;1m");
  const secondary = parseSgrMouse("\x1b[<2;1;1M");

  assert.equal(primary ? isPrimaryMousePress(primary) : false, true);
  assert.equal(release ? isPrimaryMousePress(release) : true, false);
  assert.equal(secondary ? isPrimaryMousePress(secondary) : true, false);
});
