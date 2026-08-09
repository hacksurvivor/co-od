import test from "node:test";
import assert from "node:assert/strict";
import { normalizeKeySequence } from "../dist/tui-keys.js";

test("legacy sequences pass through untouched", () => {
  for (const seq of ["j", "\r", "\x1b", "\x02", "\x1b[A", "\x1b[1;5B", "\x1b[<0;10;5M", "hello"]) {
    assert.equal(normalizeKeySequence(seq), seq);
  }
});

test("kitty CSI-u maps named keys to legacy bytes", () => {
  assert.equal(normalizeKeySequence("\x1b[13u"), "\r");      // Enter
  assert.equal(normalizeKeySequence("\x1b[27u"), "\x1b");    // Esc
  assert.equal(normalizeKeySequence("\x1b[9u"), "\t");       // Tab
  assert.equal(normalizeKeySequence("\x1b[127u"), "\x7f");   // Backspace
});

test("kitty CSI-u maps printable keys and modifiers", () => {
  assert.equal(normalizeKeySequence("\x1b[106u"), "j");          // j
  assert.equal(normalizeKeySequence("\x1b[106;2u"), "J");        // shift+j
  assert.equal(normalizeKeySequence("\x1b[98;5u"), "\x02");      // ctrl+b
  assert.equal(normalizeKeySequence("\x1b[112;5u"), "\x10");     // ctrl+p
  assert.equal(normalizeKeySequence("\x1b[106;3u"), "\x1bj");    // alt+j
});

test("kitty key-release events are swallowed", () => {
  assert.equal(normalizeKeySequence("\x1b[106;1:3u"), "");
  assert.equal(normalizeKeySequence("\x1b[13;1:3u"), "");
  // press and repeat still fire
  assert.equal(normalizeKeySequence("\x1b[106;1:1u"), "j");
  assert.equal(normalizeKeySequence("\x1b[106;1:2u"), "j");
});

test("xterm modifyOtherKeys encoding maps to legacy bytes", () => {
  assert.equal(normalizeKeySequence("\x1b[27;5;106~"), "\x0a");  // ctrl+j
  assert.equal(normalizeKeySequence("\x1b[27;1;13~"), "\r");     // Enter
});
