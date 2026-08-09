import test from "node:test";
import assert from "node:assert/strict";

import { composerWindow, taskComposerLines } from "../dist/tui-composer.js";
import { ANSI_RESET, stripAnsi, visibleLength } from "../dist/tui-render.js";

const cursor = `\x1b[7m ${ANSI_RESET}`;

test("taskComposerLines renders multiline input with prompt and continuation markers", () => {
  const lines = taskComposerLines("fix bug\nrun tests\nsummarize", {
    width: 32,
    cursor,
  });

  assert.deepEqual(lines.slice(0, 2).map((line) => stripAnsi(line).trimEnd()), [
    "> fix bug",
    "| run tests",
  ]);
  assert.ok(stripAnsi(lines[2]).startsWith("| summarize "));
  assert.ok(lines[2].includes(cursor));
  assert.ok(lines.every((line) => visibleLength(line) === 32));
});

test("taskComposerLines keeps the newest lines when the composer is height limited", () => {
  const lines = taskComposerLines("one\ntwo\nthree\nfour", {
    width: 28,
    cursor,
    maxLines: 3,
  });

  assert.deepEqual(lines.slice(0, 2).map((line) => stripAnsi(line).trimEnd()), [
    "| ... 1 earlier line",
    "| three",
  ]);
  assert.ok(stripAnsi(lines[2]).startsWith("| four "));
  assert.ok(lines.every((line) => visibleLength(line) === 28));
});

test("composerWindow renders the cursor marker at the cursor position", () => {
  const window = composerWindow("/ta", 3, 40, 5);
  assert.deepEqual(window.lines, ["/ta\u258f"]);
  assert.equal(window.hiddenAbove, 0);
  assert.equal(window.hiddenBelow, 0);
});

test("composerWindow soft-wraps long rows without losing the cursor", () => {
  const window = composerWindow("hello world", 5, 8, 3);
  assert.deepEqual(window.lines, ["hello\u258f wo", "rld"]);
});

test("composerWindow splits logical lines on newlines", () => {
  const window = composerWindow("one\ntwo\nthree", 13, 20, 5);
  assert.deepEqual(window.lines, ["one", "two", "three\u258f"]);
});

test("composerWindow keeps the cursor row visible when input exceeds maxLines", () => {
  const input = "a\nb\nc\nd\ne\nf";
  const atTop = composerWindow(input, 0, 20, 3);
  assert.equal(atTop.hiddenAbove, 0);
  assert.equal(atTop.hiddenBelow, 3);
  assert.ok(atTop.lines[0].includes("\u258f"));

  const atEnd = composerWindow(input, input.length, 20, 3);
  assert.equal(atEnd.hiddenAbove, 3);
  assert.equal(atEnd.hiddenBelow, 0);
  assert.ok(atEnd.lines.at(-1).includes("\u258f"));
});
