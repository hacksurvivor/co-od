import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadProjectMemory,
  memorySummary,
} from "../dist/tui-memory.js";

test("loadProjectMemory finds direct and directory memory files", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-memory-"));
  try {
    mkdirSync(join(dir, ".co-od/memories"), { recursive: true });
    mkdirSync(join(dir, ".agents/context"), { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# Main Memory\nStable project facts.\n");
    writeFileSync(join(dir, ".co-od/memories/room.md"), "## Room Notes\n");
    writeFileSync(join(dir, ".agents/context/release.md"), "# Release Context\n");
    writeFileSync(join(dir, ".co-od/memories/ignore.txt"), "not markdown\n");

    const result = loadProjectMemory(dir);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.files.map((file) => [file.path, file.title]), [
      ["MEMORY.md", "Main Memory"],
      [".co-od/memories/room.md", "Room Notes"],
      [".agents/context/release.md", "Release Context"],
    ]);
    assert.match(memorySummary(result).join("\n"), /MEMORY\.md - Main Memory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memorySummary reports empty state", () => {
  assert.deepEqual(memorySummary({ files: [] }), ["No project memory files found."]);
});
