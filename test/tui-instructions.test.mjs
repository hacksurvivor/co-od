import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  instructionSummary,
  loadProjectInstructions,
} from "../dist/tui-instructions.js";

test("loadProjectInstructions finds common instruction files and titles", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-instructions-"));
  try {
    mkdirSync(join(dir, ".github"), { recursive: true });
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Agent Rules\nDo this.\n");
    writeFileSync(join(dir, "README.md"), "# Project Readme\n");
    writeFileSync(join(dir, ".github/copilot-instructions.md"), "## Copilot Rules\n");
    writeFileSync(join(dir, ".agents/review.md"), "# Review Agent\n");

    const result = loadProjectInstructions(dir);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.files.map((file) => [file.path, file.title]), [
      ["AGENTS.md", "Agent Rules"],
      [".github/copilot-instructions.md", "Copilot Rules"],
      ["README.md", "Project Readme"],
      [".agents/review.md", "Review Agent"],
    ]);
    assert.match(instructionSummary(result).join("\n"), /AGENTS\.md - Agent Rules/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instructionSummary reports empty state", () => {
  assert.deepEqual(instructionSummary({ files: [] }), ["No project instruction files found."]);
});
