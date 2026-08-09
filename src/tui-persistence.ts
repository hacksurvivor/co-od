import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CachedRoomDashboard } from "./tui-dashboard.js";
import { normalizePins, type TuiPins } from "./tui-pins.js";
import type { TuiSafetyAuditEntry } from "./tui-safety.js";

export interface PersistedAttachment {
  path: string;
  kind?: "directory" | "file" | "image";
}

export interface TuiProjectState {
  projectDir: string;
  taskHistory: string[];
  selectedRoomId?: string;
  selectedRoomName?: string;
  provider?: string;
  model?: string;
  selectedAgentId?: string;
  lastRunId?: string;
  attachments?: PersistedAttachment[];
  dashboardCache?: CachedRoomDashboard;
  pins?: TuiPins;
  safetyAudit?: TuiSafetyAuditEntry[];
  sideRailWidth?: number;
  /** Room panel visibility (⌃B). Hidden by default — chat is the hero. */
  panelVisible?: boolean;
  /** Failures waved off from "needs you" — personal, never touches history. */
  dismissedRunIds?: string[];
  updatedAt?: string;
}

export interface TuiStateStore {
  projects: Record<string, TuiProjectState>;
}

// Slim rail (BRAND.md presence rail): visible on a normal ~100-col terminal.
// At narrow widths the rail hides before the composer compresses.
export const SIDE_RAIL_MIN_WIDTH = 28;
export const SIDE_RAIL_DEFAULT_WIDTH = 38;
export const SIDE_RAIL_MAX_WIDTH = 64;
export const SIDE_RAIL_MIN_MAIN_WIDTH = 64;

export function tuiStateKey(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 24);
}

export function tuiStatePath(baseDir = join(homedir(), ".co-od")): string {
  return join(baseDir, "tui-state.json");
}

export function normalizeTaskHistory(history: string[], next?: string, limit = 50): string[] {
  const values = [...history, ...(next ? [next] : [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  for (const entry of values) {
    const existing = deduped.indexOf(entry);
    if (existing >= 0) deduped.splice(existing, 1);
    deduped.push(entry);
  }
  return deduped.slice(-limit);
}

export function readTuiStateStore(path: string): TuiStateStore {
  if (!existsSync(path)) return { projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TuiStateStore>;
    return { projects: parsed.projects || {} };
  } catch {
    return { projects: {} };
  }
}

export function loadTuiProjectState(input: {
  projectDir: string;
  baseDir?: string;
}): TuiProjectState | null {
  const store = readTuiStateStore(tuiStatePath(input.baseDir));
  return store.projects[tuiStateKey(input.projectDir)] || null;
}

export function saveTuiProjectState(input: {
  projectDir: string;
  state: Partial<Omit<TuiProjectState, "dashboardCache">> & { dashboardCache?: CachedRoomDashboard | null };
  baseDir?: string;
}): TuiProjectState {
  const path = tuiStatePath(input.baseDir);
  const store = readTuiStateStore(path);
  const key = tuiStateKey(input.projectDir);
  const current = store.projects[key] || {
    projectDir: input.projectDir,
    taskHistory: [],
  };
  const next: TuiProjectState = {
    ...current,
    ...input.state,
    projectDir: input.projectDir,
    taskHistory: normalizeTaskHistory(input.state.taskHistory || current.taskHistory || []),
    selectedRoomId: input.state.selectedRoomId || current.selectedRoomId,
    selectedRoomName: input.state.selectedRoomName || current.selectedRoomName,
    selectedAgentId: input.state.selectedAgentId || current.selectedAgentId,
    lastRunId: input.state.lastRunId || current.lastRunId,
    attachments: input.state.attachments || current.attachments || [],
    dashboardCache: input.state.dashboardCache === null
      ? undefined
      : normalizeDashboardCache(input.state.dashboardCache || current.dashboardCache),
    pins: normalizePins(input.state.pins || current.pins),
    safetyAudit: normalizeSafetyAudit(input.state.safetyAudit || current.safetyAudit),
    sideRailWidth: normalizeSideRailWidth(input.state.sideRailWidth ?? current.sideRailWidth),
    dismissedRunIds: (input.state.dismissedRunIds ?? current.dismissedRunIds ?? []).slice(-100),
    updatedAt: new Date().toISOString(),
  };
  store.projects[key] = next;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
  return next;
}

export function normalizeSideRailWidth(width?: number): number | undefined {
  if (!Number.isFinite(width)) return undefined;
  return Math.max(SIDE_RAIL_MIN_WIDTH, Math.min(SIDE_RAIL_MAX_WIDTH, Math.round(width as number)));
}

export function normalizeSafetyAudit(entries?: TuiSafetyAuditEntry[], limit = 50): TuiSafetyAuditEntry[] {
  return (entries || [])
    .filter((entry) =>
      typeof entry?.action === "string" &&
      ["allowed", "blocked", "toggled", "info"].includes(entry.decision) &&
      typeof entry.reason === "string" &&
      typeof entry.createdAt === "number" &&
      Number.isFinite(entry.createdAt)
    )
    .slice(-limit);
}

export function normalizeDashboardCache(cache?: CachedRoomDashboard): CachedRoomDashboard | undefined {
  if (!cache?.roomId || !cache.cachedAt) return undefined;
  if (!Number.isFinite(Date.parse(cache.cachedAt))) return undefined;
  return {
    roomId: cache.roomId,
    roomName: cache.roomName,
    agents: (cache.agents || []).slice(0, 30),
    runs: (cache.runs || []).slice(0, 60),
    cachedAt: cache.cachedAt,
  };
}
