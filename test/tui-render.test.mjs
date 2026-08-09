import test from "node:test";
import assert from "node:assert/strict";

import {
  ANSI_RESET,
  fitAnsi,
  renderTerminalFrame,
  stripAnsi,
  visibleLength,
  wrapPlain,
} from "../dist/tui-render.js";

const green = (text) => `\x1b[32m${text}${ANSI_RESET}`;

test("fitAnsi preserves visible width across plain and colored text", () => {
  assert.equal(fitAnsi("abcdef", 4), "abcd");
  assert.equal(fitAnsi("ab", 4), "ab  ");

  const fitted = fitAnsi(`${green("abcdef")} tail`, 8);
  assert.equal(stripAnsi(fitted), "abcdef t");
  assert.equal(visibleLength(fitted), 8);
  assert.ok(fitted.includes("\x1b[32m"));
  assert.ok(fitted.includes(ANSI_RESET));
});

test("renderTerminalFrame smokes 80x24 and wide layouts", () => {
  const sourceLines = Array.from({ length: 40 }, (_, index) => {
    const label = index === 0 ? "co-od terminal" : `line ${index}`;
    return `${label} ${green("x".repeat(200))}`;
  });

  for (const [width, height] of [[80, 24], [140, 40]]) {
    const frame = renderTerminalFrame(sourceLines, width, height);
    const rows = frame.split("\n");
    assert.equal(rows.length, height);
    assert.equal(stripAnsi(rows[0]).length, width);
    assert.ok(rows.every((row) => visibleLength(row) === width));
    assert.ok(stripAnsi(frame).includes("co-od terminal"));
  }
});

test("wrapPlain wraps on spaces and never drops words", () => {
  const lines = wrapPlain("the quick brown fox jumps over the lazy dog", 16);
  assert.ok(lines.every((line) => line.length <= 16));
  assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), "the quick brown fox jumps over the lazy dog");
});

test("wrapPlain keeps list markers and aligns continuations under the text", () => {
  const lines = wrapPlain("1. Add a ThemeToggle component with options", 30);
  assert.ok(lines[0].startsWith("1. "));
  assert.ok(lines.slice(1).every((line) => line.startsWith("   ")));
});

test("wrapPlain hard-breaks tokens longer than the width", () => {
  const lines = wrapPlain("see apps/web/app/settings/very-long-component-name.tsx now", 20);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.ok(lines.join("").includes("very-long-component"));
});

test("wrapPlain preserves blank lines and empty input", () => {
  assert.deepEqual(wrapPlain("a\n\nb", 10), ["a", "", "b"]);
  assert.deepEqual(wrapPlain("", 10), [""]);
});
