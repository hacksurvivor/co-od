import test from "node:test";
import assert from "node:assert/strict";

import { taskContextSummary } from "../dist/tui-context.js";

const safety = {
  approvalMode: "local-cli",
  sandboxMode: "workspace-write",
  networkEnabled: true,
  autoRun: true,
  autoApply: false,
  allowDangerousCommands: false,
  audit: [],
};

test("taskContextSummary combines room, provider, workspace, attachments, and instructions", () => {
  const lines = taskContextSummary({
    roomName: "Alpha",
    roomId: "room-a",
    projectDir: "/tmp/project",
    provider: "opencode",
    model: "sonnet",
    agentName: "Builder abc123",
    safety,
    workspace: {
      isGitRepo: true,
      branch: "main",
      ahead: 1,
      behind: 2,
      dirty: true,
      changedFiles: [{ status: " M", path: "src/index.ts" }],
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      insertions: 12,
      deletions: 3,
    },
    attachments: [{ path: "src/index.ts", kind: "file" }],
    instructions: { files: [{ path: "AGENTS.md", title: "Agent Guide", bytes: 120 }] },
    memory: { files: [{ path: "MEMORY.md", title: "Project Memory", bytes: 80 }] },
  });

  assert.match(lines.join("\n"), /room\s+Alpha \(room-a\)/);
  assert.match(lines.join("\n"), /provider\s+opencode\s+model sonnet\s+agent Builder abc123/);
  assert.match(lines.join("\n"), /workspace\s+branch main\s+dirty\s+1 files\s+\+12\/-3/);
  assert.match(lines.join("\n"), /1\. \[file\] src\/index\.ts/);
  assert.match(lines.join("\n"), /AGENTS\.md - Agent Guide/);
  assert.match(lines.join("\n"), /MEMORY\.md - Project Memory/);
});

test("taskContextSummary has explicit empty states", () => {
  const lines = taskContextSummary({
    projectDir: "/tmp/project",
    provider: "codex",
    safety,
    workspace: {
      isGitRepo: false,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      insertions: 0,
      deletions: 0,
    },
    attachments: [],
    instructions: { files: [] },
    memory: { files: [] },
  });

  assert.match(lines.join("\n"), /room\s+not configured/);
  assert.match(lines.join("\n"), /provider\s+codex\s+agent none/);
  assert.match(lines.join("\n"), /workspace\s+not a git repo/);
  assert.match(lines.join("\n"), /No attached files\./);
  assert.match(lines.join("\n"), /No project instruction files found\./);
  assert.match(lines.join("\n"), /No project memory files found\./);
});
