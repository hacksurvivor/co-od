import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileWriteUndoChange,
  createUndoSnapshot,
  pushUndoSnapshot,
  restoreFileUndoChanges,
  restoreUndoSnapshot,
} from "../dist/tui-undo.js";
import { createSafetyState } from "../dist/tui-safety.js";

test("createUndoSnapshot clones local TUI-owned state", () => {
  const attachments = [{ path: "README.md", kind: "file" }];
  const pins = {
    rooms: [{ roomId: "room-a", roomName: "Alpha" }],
    providers: ["opencode"],
    agents: [{ agentId: "agent-a", name: "Builder" }],
  };
  const snapshot = createUndoSnapshot({
    label: "attach file",
    provider: "opencode",
    model: "gpt-5",
    selectedAgentId: "agent-a",
    attachments,
    pins,
    safety: createSafetyState({}),
    now: 100,
  });

  attachments[0].path = "changed.md";
  pins.providers.push("codex");

  assert.equal(snapshot.createdAt, 100);
  assert.equal(snapshot.attachments[0].path, "README.md");
  assert.deepEqual(snapshot.pins.providers, ["opencode"]);
});

test("createUndoSnapshot clones server undo changes", () => {
  const serverChanges = [{
    kind: "patch-reopen",
    roomId: "room-a",
    runId: "run-a",
    patchId: "patch-a",
    fromStatus: "rejected",
    toStatus: "proposed",
  }];
  const snapshot = createUndoSnapshot({
    label: "patch reject",
    provider: "opencode",
    safety: createSafetyState({}),
    serverChanges,
  });

  serverChanges[0].patchId = "changed";
  const restored = restoreUndoSnapshot(snapshot, createSafetyState({}));

  assert.equal(snapshot.serverChanges[0].patchId, "patch-a");
  assert.equal(restored.serverChanges[0].patchId, "patch-a");
});

test("pushUndoSnapshot bounds stack to latest entries", () => {
  const safety = createSafetyState({});
  const stack = Array.from({ length: 4 }, (_, index) => createUndoSnapshot({
    label: `change ${index}`,
    provider: "opencode",
    pins: { rooms: [], providers: [], agents: [] },
    safety,
    now: index,
  }));

  assert.deepEqual(pushUndoSnapshot(stack.slice(0, 3), stack[3], 2).map((entry) => entry.label), [
    "change 2",
    "change 3",
  ]);
});

test("restoreUndoSnapshot restores local state while appending audit history", () => {
  const safety = { ...createSafetyState({}), autoRun: false };
  const snapshot = createUndoSnapshot({
    label: "provider",
    provider: "codex",
    selectedAgentId: "agent-a",
    attachments: [{ path: "a.ts", kind: "file" }],
    pins: { rooms: [], providers: ["codex"], agents: [] },
    safety,
    now: 1,
  });

  const restored = restoreUndoSnapshot(snapshot, {
    ...createSafetyState({}),
    audit: [{ action: "task", decision: "allowed", reason: "auto-run enabled", createdAt: 2 }],
  }, 3);

  assert.equal(restored.provider, "codex");
  assert.equal(restored.selectedAgentId, "agent-a");
  assert.equal(restored.safety.autoRun, false);
  assert.deepEqual(restored.safety.audit.map((entry) => entry.action), ["task", "undo"]);
  assert.equal(restored.safety.audit.at(-1).reason, "restored provider");
});

test("restoreFileUndoChanges validates current content before restoring files", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-file-undo-"));
  const file = join(dir, "src.ts");
  writeFileSync(file, "const nextName = true;\n");

  const restored = restoreFileUndoChanges(dir, [{
    path: "src.ts",
    before: "const oldName = true;\n",
    after: "const nextName = true;\n",
  }]);

  assert.equal(restored.ok, true);
  assert.deepEqual(restored.changedFiles, ["src.ts"]);
  assert.equal(readFileSync(file, "utf8"), "const oldName = true;\n");

  writeFileSync(file, "const userEdit = true;\n");
  const blocked = restoreFileUndoChanges(dir, [{
    path: "src.ts",
    before: "const oldName = true;\n",
    after: "const nextName = true;\n",
  }]);

  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /changed after the original operation/);
  assert.equal(readFileSync(file, "utf8"), "const userEdit = true;\n");
});

test("restoreFileUndoChanges removes files created by TUI-owned operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-file-create-undo-"));
  const file = join(dir, "export.md");
  writeFileSync(file, "# Run\n");

  const restored = restoreFileUndoChanges(dir, [{
    path: "export.md",
    before: null,
    after: "# Run\n",
  }]);

  assert.equal(restored.ok, true);
  assert.deepEqual(restored.changedFiles, ["export.md"]);
  assert.equal(existsSync(file), false);

  rmSync(dir, { recursive: true, force: true });
});

test("restoreFileUndoChanges removes empty directories created by TUI-owned writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-dir-create-undo-"));
  const file = join(dir, "exports", "runs", "summary.md");
  const change = createFileWriteUndoChange({
    dir,
    path: "exports/runs/summary.md",
    after: "# Run\n",
  });

  assert.deepEqual(change?.createdDirectories, ["exports", "exports/runs"]);

  mkdirSync(join(dir, "exports", "runs"), { recursive: true });
  writeFileSync(file, "# Run\n", { flag: "wx" });

  const restored = restoreFileUndoChanges(dir, [change]);

  assert.equal(restored.ok, true);
  assert.deepEqual(restored.changedFiles, ["exports/runs/summary.md"]);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(dir, "exports")), false);

  rmSync(dir, { recursive: true, force: true });
});
