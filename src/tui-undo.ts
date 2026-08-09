import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { TuiAttachment } from "./tui-attachments.js";
import { emptyPins, type TuiPins } from "./tui-pins.js";
import { addSafetyAudit, type TuiSafetyState } from "./tui-safety.js";

export interface TuiFileUndoChange {
  path: string;
  before: string | null;
  after: string;
  createdDirectories?: string[];
}

export interface TuiServerUndoChange {
  kind: "patch-reopen";
  roomId: string;
  runId?: string;
  patchId: string;
  fromStatus: "rejected";
  toStatus: "proposed";
}

export interface TuiUndoSnapshot {
  label: string;
  createdAt: number;
  provider: string;
  model?: string;
  selectedAgentId?: string;
  attachments: TuiAttachment[];
  pins: TuiPins;
  safety: Pick<
    TuiSafetyState,
    "autoRun" | "autoApply" | "networkEnabled" | "allowDangerousCommands"
  >;
  fileChanges?: TuiFileUndoChange[];
  serverChanges?: TuiServerUndoChange[];
}

export interface TuiUndoRestoredState {
  provider: string;
  model?: string;
  selectedAgentId?: string;
  attachments: TuiAttachment[];
  pins: TuiPins;
  safety: TuiSafetyState;
  fileChanges: TuiFileUndoChange[];
  serverChanges: TuiServerUndoChange[];
}

export interface TuiFileUndoRestoreResult {
  ok: boolean;
  changedFiles: string[];
  error?: string;
  message: string;
}

export function createUndoSnapshot(input: {
  label: string;
  provider: string;
  model?: string;
  selectedAgentId?: string;
  attachments?: TuiAttachment[];
  pins?: TuiPins;
  safety: TuiSafetyState;
  fileChanges?: TuiFileUndoChange[];
  serverChanges?: TuiServerUndoChange[];
  now?: number;
}): TuiUndoSnapshot {
  return {
    label: input.label,
    createdAt: input.now ?? Date.now(),
    provider: input.provider,
    model: input.model,
    selectedAgentId: input.selectedAgentId,
    attachments: cloneAttachments(input.attachments || []),
    pins: clonePins(input.pins || emptyPins()),
    safety: {
      autoRun: input.safety.autoRun,
      autoApply: input.safety.autoApply,
      networkEnabled: input.safety.networkEnabled,
      allowDangerousCommands: input.safety.allowDangerousCommands,
    },
    fileChanges: cloneFileChanges(input.fileChanges || []),
    serverChanges: cloneServerChanges(input.serverChanges || []),
  };
}

export function pushUndoSnapshot(
  stack: TuiUndoSnapshot[],
  snapshot: TuiUndoSnapshot,
  limit = 20,
): TuiUndoSnapshot[] {
  return [...stack, snapshot].slice(-limit);
}

export function restoreUndoSnapshot(
  snapshot: TuiUndoSnapshot,
  currentSafety: TuiSafetyState,
  now = Date.now(),
): TuiUndoRestoredState {
  return {
    provider: snapshot.provider,
    model: snapshot.model,
    selectedAgentId: snapshot.selectedAgentId,
    attachments: cloneAttachments(snapshot.attachments),
    pins: clonePins(snapshot.pins),
    fileChanges: cloneFileChanges(snapshot.fileChanges || []),
    serverChanges: cloneServerChanges(snapshot.serverChanges || []),
    safety: addSafetyAudit(
      {
        ...currentSafety,
        autoRun: snapshot.safety.autoRun,
        autoApply: snapshot.safety.autoApply,
        networkEnabled: snapshot.safety.networkEnabled,
        allowDangerousCommands: snapshot.safety.allowDangerousCommands,
      },
      "undo",
      "info",
      `restored ${snapshot.label}`,
      now,
    ),
  };
}

export function restoreFileUndoChanges(
  dir: string,
  fileChanges: TuiFileUndoChange[],
): TuiFileUndoRestoreResult {
  if (fileChanges.length === 0) {
    return { ok: true, changedFiles: [], message: "No file changes to restore." };
  }

  const root = resolve(dir);
  const planned: Array<{
    path: string;
    absolute: string;
    before: string | null;
    createdDirectories: Array<{ path: string; absolute: string }>;
  }> = [];
  for (const change of fileChanges) {
    const absolute = resolve(root, change.path);
    if (!isPathInside(root, absolute)) {
      return {
        ok: false,
        changedFiles: [],
        error: `Refusing to restore file outside workspace: ${change.path}`,
        message: `Undo failed: ${change.path} is outside the workspace.`,
      };
    }
    const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    if (current !== change.after) {
      return {
        ok: false,
        changedFiles: [],
        error: `Refusing to restore ${change.path}; file changed since undo snapshot was recorded.`,
        message: `Undo failed: ${change.path} changed after the original operation.`,
      };
    }
    const createdDirectories: Array<{ path: string; absolute: string }> = [];
    for (const dir of change.createdDirectories || []) {
      const absoluteDir = resolve(root, dir);
      if (!isPathInside(root, absoluteDir)) {
        return {
          ok: false,
          changedFiles: [],
          error: `Refusing to remove directory outside workspace: ${dir}`,
          message: `Undo failed: ${dir} is outside the workspace.`,
        };
      }
      createdDirectories.push({ path: dir, absolute: absoluteDir });
    }
    planned.push({ path: change.path, absolute, before: change.before, createdDirectories });
  }

  for (const change of planned) {
    if (change.before === null) {
      unlinkSync(change.absolute);
    } else {
      writeFileSync(change.absolute, change.before, "utf8");
    }
  }

  const directories = uniqueByPath(planned.flatMap((change) => change.createdDirectories))
    .sort((a, b) => b.absolute.length - a.absolute.length);
  for (const dir of directories) {
    try {
      rmdirSync(dir.absolute);
    } catch {
      // Leave non-empty or concurrently edited directories in place.
    }
  }

  return {
    ok: true,
    changedFiles: planned.map((change) => change.path),
    message: `Restored ${planned.length} file${planned.length === 1 ? "" : "s"}.`,
  };
}

export function createFileWriteUndoChange(input: {
  dir: string;
  path: string;
  after: string;
}): TuiFileUndoChange | null {
  const root = resolve(input.dir);
  const absolute = resolve(root, input.path);
  if (!isPathInside(root, absolute)) return null;
  const before = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  const createdDirectories = missingParentDirectories(root, dirname(absolute));
  return {
    path: relative(root, absolute),
    before,
    after: input.after,
    ...(createdDirectories.length > 0 ? { createdDirectories } : {}),
  };
}

function cloneAttachments(attachments: TuiAttachment[]): TuiAttachment[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

function clonePins(pins: TuiPins): TuiPins {
  return {
    rooms: pins.rooms.map((room) => ({ ...room })),
    providers: [...pins.providers],
    agents: pins.agents.map((agent) => ({ ...agent })),
  };
}

function cloneFileChanges(fileChanges: TuiFileUndoChange[]): TuiFileUndoChange[] {
  return fileChanges.map((change) => ({
    ...change,
    createdDirectories: change.createdDirectories ? [...change.createdDirectories] : undefined,
  }));
}

function cloneServerChanges(serverChanges: TuiServerUndoChange[]): TuiServerUndoChange[] {
  return serverChanges.map((change) => ({ ...change }));
}

function isPathInside(root: string, absolute: string): boolean {
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

function missingParentDirectories(root: string, targetDir: string): string[] {
  const dirs: string[] = [];
  let current = targetDir;
  while (current !== root && isPathInside(root, current) && !existsSync(current)) {
    dirs.push(relative(root, current));
    current = dirname(current);
  }
  return dirs.reverse();
}

function uniqueByPath(dirs: Array<{ path: string; absolute: string }>): Array<{ path: string; absolute: string }> {
  const seen = new Set<string>();
  const unique: Array<{ path: string; absolute: string }> = [];
  for (const dir of dirs) {
    if (seen.has(dir.absolute)) continue;
    seen.add(dir.absolute);
    unique.push(dir);
  }
  return unique;
}
