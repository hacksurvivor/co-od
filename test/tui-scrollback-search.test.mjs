import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTuiScrollbackSearch,
  searchTuiScrollback,
} from "../dist/tui-scrollback-search.js";

test("searchTuiScrollback finds feed and terminal matches newest first", () => {
  const result = searchTuiScrollback({
    query: "dashboard",
    feed: [
      { kind: "info", text: "Starting terminal workspace" },
      { kind: "output", text: "Dashboard loaded\nNo errors" },
    ],
    terminalLines: [
      "pnpm test",
      "dashboard smoke passed",
    ],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.scannedLines, 5);
  assert.deepEqual(
    result.matches.map((match) => `${match.source}:${match.text}`),
    [
      "terminal:dashboard smoke passed",
      "feed:Dashboard loaded",
    ],
  );

  const formatted = formatTuiScrollbackSearch(result);
  assert.match(formatted, /Search "dashboard": 2 matches/);
  assert.match(formatted, /terminal:2: dashboard smoke passed/);
  assert.match(formatted, /feed:2\/output:1: Dashboard loaded/);
});

test("searchTuiScrollback reports usage and empty results", () => {
  assert.equal(searchTuiScrollback({ query: "   " }).error, "Usage: /find <query>");

  const result = searchTuiScrollback({
    query: "missing",
    feed: [{ kind: "info", text: "hello" }],
    terminalLines: ["world"],
  });
  assert.equal(result.matches.length, 0);
  assert.match(formatTuiScrollbackSearch(result), /No feed or terminal matches/);
});
