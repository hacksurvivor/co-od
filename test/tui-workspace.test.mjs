import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filterWorkspaceFiles,
  formatWorkspaceFilePreview,
  listWorkspaceFiles,
  loadWorkspaceDiff,
  loadWorkspaceContext,
  loadWorkspaceFilePreview,
  parseGitBranchLine,
  parseGitNumstat,
  parseGitStatusShort,
  parseRipgrepSearchOutput,
  parseWorkspaceFilePreviewRef,
  searchWorkspaceText,
  workspaceRelativePath,
} from "../dist/tui-workspace.js";

test("parseGitBranchLine extracts branch, upstream, ahead, and behind", () => {
  assert.deepEqual(parseGitBranchLine("## main...origin/main [ahead 2, behind 1]"), {
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });

  assert.deepEqual(parseGitBranchLine("## feature/tui"), {
    branch: "feature/tui",
    upstream: undefined,
    ahead: 0,
    behind: 0,
  });
});

test("parseGitStatusShort counts staged, unstaged, and untracked changes", () => {
  const status = parseGitStatusShort([
    "## main...origin/main [ahead 1]",
    " M packages/cli/src/index.ts",
    "A  packages/cli/src/tui.ts",
    "?? docs/tui-roadmap.md",
    "R  old.ts -> new.ts",
  ].join("\n"));

  assert.equal(status.branch, "main");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.equal(status.dirty, true);
  assert.equal(status.stagedCount, 2);
  assert.equal(status.unstagedCount, 1);
  assert.equal(status.untrackedCount, 1);
  assert.deepEqual(status.changedFiles.map((file) => file.path), [
    "packages/cli/src/index.ts",
    "packages/cli/src/tui.ts",
    "docs/tui-roadmap.md",
    "old.ts -> new.ts",
  ]);
});

test("parseGitNumstat summarizes text diffs and ignores binary counts", () => {
  assert.deepEqual(parseGitNumstat("10\t2\ta.ts\n-\t-\timage.png\n4\t0\tb.ts\n"), {
    insertions: 14,
    deletions: 2,
  });
});

test("loadWorkspaceContext runs git commands through an injectable runner", async () => {
  const calls = [];
  const workspace = await loadWorkspaceContext("/tmp/project", async (file, args) => {
    calls.push([file, args]);
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-toplevel") {
      return { stdout: "/tmp/project\n", stderr: "" };
    }
    if (command === "status --short --branch") {
      return { stdout: "## main\n M a.ts\n", stderr: "" };
    }
    if (command === "diff --numstat HEAD") {
      return { stdout: "3\t1\ta.ts\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  });

  assert.deepEqual(calls.map((call) => call[0]), ["git", "git", "git"]);
  assert.equal(workspace.isGitRepo, true);
  assert.equal(workspace.root, "/tmp/project");
  assert.equal(workspace.branch, "main");
  assert.equal(workspace.dirty, true);
  assert.equal(workspace.insertions, 3);
  assert.equal(workspace.deletions, 1);
});

test("loadWorkspaceContext returns a non-repo context when git fails", async () => {
  const workspace = await loadWorkspaceContext("/tmp/project", async () => {
    throw new Error("not a git repository");
  });

  assert.equal(workspace.isGitRepo, false);
  assert.equal(workspace.dirty, false);
  assert.match(workspace.error, /not a git repository/);
});

test("filterWorkspaceFiles filters by query and limit", () => {
  assert.deepEqual(
    filterWorkspaceFiles(["src/index.ts", "src/tui.ts", "README.md"], "tui", 2),
    ["src/tui.ts"],
  );
  assert.deepEqual(
    filterWorkspaceFiles(["a.ts", "b.ts", "c.ts"], "", 2),
    ["a.ts", "b.ts"],
  );
});

test("parseRipgrepSearchOutput parses path, line, column, and text", () => {
  assert.deepEqual(
    parseRipgrepSearchOutput("src/tui.ts:12:4:const value = true\nREADME.md:2:1:TUI docs\n"),
    [
      { path: "src/tui.ts", line: 12, column: 4, text: "const value = true" },
      { path: "README.md", line: 2, column: 1, text: "TUI docs" },
    ],
  );
});

test("workspaceRelativePath keeps workspace paths concise", () => {
  assert.equal(workspaceRelativePath("/tmp/project", "/tmp/project/src/tui.ts"), "src/tui.ts");
  assert.equal(workspaceRelativePath("/tmp/project", "/tmp/other/tui.ts"), "/tmp/other/tui.ts");
  assert.equal(workspaceRelativePath("/tmp/project", "src/tui.ts"), "src/tui.ts");
});

test("loadWorkspaceFilePreview renders a bounded workspace file excerpt", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-preview-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), [
      "one",
      "two",
      "three",
      "four",
      "five",
    ].join("\n"));

    assert.deepEqual(parseWorkspaceFilePreviewRef("src/app.ts:3:4"), {
      path: "src/app.ts",
      line: 3,
    });

    const result = loadWorkspaceFilePreview({
      dir,
      ref: "src/app.ts:3",
      contextLines: 1,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.path, "src/app.ts");
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 4);
    assert.deepEqual(result.lines.map((line) => [line.number, line.selected, line.text]), [
      [2, false, "two"],
      [3, true, "three"],
      [4, false, "four"],
    ]);

    const formatted = formatWorkspaceFilePreview(result);
    assert.match(formatted, /File src\/app\.ts:2-4 \(5 lines\)/);
    assert.match(formatted, /> 3 \| three/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWorkspaceFilePreview rejects outside, missing, directory, and binary previews", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-preview-reject-"));
  const outside = mkdtempSync(join(tmpdir(), "co-od-preview-outside-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "image.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(outside, "secret.txt"), "secret\n");

    assert.match(loadWorkspaceFilePreview({ dir, ref: join(outside, "secret.txt") }).error || "", /limited to the current workspace/);
    assert.match(loadWorkspaceFilePreview({ dir, ref: "missing.ts" }).error || "", /File not found/);
    assert.match(loadWorkspaceFilePreview({ dir, ref: "src" }).error || "", /Not a file/);
    assert.match(loadWorkspaceFilePreview({ dir, ref: "src/image.bin" }).error || "", /Binary file preview/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("listWorkspaceFiles runs rg files through an injectable runner", async () => {
  const result = await listWorkspaceFiles({
    dir: "/tmp/project",
    query: "tui",
    commandRunner: async (file, args) => {
      assert.equal(file, "rg");
      assert.deepEqual(args, ["--files", "--hidden", "-g", "!.git", "/tmp/project"]);
      return { stdout: "/tmp/project/src/index.ts\n/tmp/project/src/tui.ts\n/tmp/project/README.md\n", stderr: "" };
    },
  });

  assert.deepEqual(result, {
    query: "tui",
    files: ["src/tui.ts"],
  });
});

test("searchWorkspaceText runs rg search and handles empty queries", async () => {
  const empty = await searchWorkspaceText({ dir: "/tmp/project", query: " " });
  assert.equal(empty.error, "Search needs a query.");

  const result = await searchWorkspaceText({
    dir: "/tmp/project",
    query: "palette",
    commandRunner: async (file, args) => {
      assert.equal(file, "rg");
      assert.deepEqual(args, [
        "--line-number",
        "--column",
        "--no-heading",
        "--color",
        "never",
        "--smart-case",
        "palette",
        "/tmp/project",
      ]);
      return { stdout: "/tmp/project/src/tui.ts:4:2:palette mode\n", stderr: "" };
    },
  });

  assert.deepEqual(result, {
    query: "palette",
    matches: [{ path: "src/tui.ts", line: 4, column: 2, text: "palette mode" }],
  });
});

test("loadWorkspaceDiff returns git diff lines for all changes or one path", async () => {
  const calls = [];
  const result = await loadWorkspaceDiff({
    dir: "/tmp/project",
    path: "src/tui.ts",
    limit: 3,
    commandRunner: async (file, args) => {
      calls.push([file, args]);
      return {
        stdout: [
          "diff --git a/src/tui.ts b/src/tui.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.deepEqual(calls, [[
    "git",
    ["-C", "/tmp/project", "diff", "--no-ext-diff", "--color=never", "HEAD", "--", "src/tui.ts"],
  ]]);
  assert.deepEqual(result, {
    path: "src/tui.ts",
    lines: ["diff --git a/src/tui.ts b/src/tui.ts", "@@ -1 +1 @@", "-old"],
    truncated: true,
  });
});
