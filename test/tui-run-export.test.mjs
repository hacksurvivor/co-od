import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultRunSummaryPath,
  formatRunCopyText,
  formatRunSummaryMarkdown,
  resolveRunSummaryPath,
  writeClipboardText,
  writeRunSummaryExport,
} from "../dist/tui-run-export.js";

const detail = {
  run: {
    _id: "run-alpha-0001",
    agent_id: "agent-a",
    goal: "Fix dashboard",
    status: "succeeded",
    execution_mode: "local_opencode",
    created_at: 1780000000000,
    steps: [
      {
        idx: 1,
        kind: "shell",
        input: { description: "ran tests" },
        output: {
          success: true,
          payload: {
            stdout: "tests passed\n",
            stderr: "warning: slow test\n",
          },
        },
      },
    ],
  },
  patches: [
    {
      _id: "patch-a-0001",
      run_id: "run-alpha-0001",
      title: "Dashboard patch",
      path: "packages/cli/src/commands/tui.ts",
      status: "proposed",
      diff_text: "+new\n-old",
    },
  ],
  allRuns: [
    { _id: "run-alpha-0001", status: "succeeded", goal: "Fix dashboard", created_at: 100 },
    { _id: "run-child-0002", parent_run_id: "run-alpha-0001", status: "running", goal: "Review", created_at: 200 },
  ],
};

test("formatRunSummaryMarkdown includes run, timeline, delegation, and patch sections", () => {
  const markdown = formatRunSummaryMarkdown(detail, {
    agentName: (agentId) => (agentId === "agent-a" ? "Builder" : "unknown"),
  });

  assert.match(markdown, /# Run alpha-0001/);
  assert.match(markdown, /- Agent: Builder/);
  assert.match(markdown, /## Timeline \(1\)/);
  assert.match(markdown, /shell succeeded: ran tests/);
  assert.match(markdown, /## Delegation \(2\)/);
  assert.match(markdown, /spawn child-0002 running/);
  assert.match(markdown, /## Patches \(1\)/);
  assert.match(markdown, /proposed tch-a-0001 \+1 -1 Dashboard patch/);
});

test("resolveRunSummaryPath defaults under .co-od/runs and respects relative or absolute paths", () => {
  assert.equal(defaultRunSummaryPath("/tmp/project", "run-a"), "/tmp/project/.co-od/runs/run-a.md");
  assert.equal(resolveRunSummaryPath("/tmp/project", undefined, "run-a"), "/tmp/project/.co-od/runs/run-a.md");
  assert.equal(resolveRunSummaryPath("/tmp/project", "exports/run.md", "run-a"), "/tmp/project/exports/run.md");
  assert.equal(resolveRunSummaryPath("/tmp/project", "/tmp/run.md", "run-a"), "/tmp/run.md");
});

test("formatRunCopyText returns id, goal, output, summary, and selected diff snippets", () => {
  assert.equal(formatRunCopyText({ detail, kind: "id" }), "run-alpha-0001");
  assert.equal(formatRunCopyText({ detail, kind: "goal" }), "Fix dashboard");
  assert.equal(
    formatRunCopyText({ detail, kind: "output" }),
    "## Step 1 shell\n\nstdout:\ntests passed\n\nstderr:\nwarning: slow test",
  );
  assert.equal(formatRunCopyText({ detail, kind: "diff", selectedPatchIndex: 0 }), "+new\n-old");
  assert.match(formatRunCopyText({ detail, kind: "summary", agentName: () => "Builder" }), /# Run alpha-0001/);
});

test("writeClipboardText uses injectable writer and rejects empty text", () => {
  let copied = "";
  writeClipboardText("hello", (text) => {
    copied = text;
  });
  assert.equal(copied, "hello");
  assert.throws(() => writeClipboardText("", () => undefined), /Nothing to copy/);
});

test("writeRunSummaryExport writes markdown to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-run-export-"));
  try {
    const result = writeRunSummaryExport({
      detail,
      projectDir: dir,
      outputPath: "exports/run.md",
      agentName: () => "Builder",
    });

    assert.equal(result.path, join(dir, "exports/run.md"));
    assert.equal(existsSync(result.path), true);
    assert.equal(readFileSync(result.path, "utf-8"), result.markdown);
    assert.match(result.markdown, /Fix dashboard/);
    assert.deepEqual(result.fileChange, {
      path: "exports/run.md",
      before: null,
      after: result.markdown,
      createdDirectories: ["exports"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRunSummaryExport records undo data for overwritten exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-run-export-overwrite-"));
  try {
    const outputPath = join(dir, "exports/run.md");
    mkdirSync(join(dir, "exports"), { recursive: true });
    writeFileSync(outputPath, "old summary\n");

    const result = writeRunSummaryExport({
      detail,
      projectDir: dir,
      outputPath: "exports/run.md",
      agentName: () => "Builder",
    });

    assert.equal(result.fileChange?.before, "old summary\n");
    assert.equal(result.fileChange?.after, result.markdown);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
