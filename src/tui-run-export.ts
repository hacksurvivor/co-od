import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDelegationRows,
  compact,
  diffStat,
  formatStepDescription,
  shortId,
  type RunDetailData,
} from "./tui-model.js";
import { createFileWriteUndoChange, type TuiFileUndoChange } from "./tui-undo.js";

export type RunCopyKind = "id" | "goal" | "summary" | "diff" | "output";
export type ClipboardWriter = (text: string) => void;

export interface RunSummaryExportOptions {
  detail: RunDetailData;
  projectDir: string;
  outputPath?: string;
  agentName?: (agentId?: string) => string;
}

export interface RunSummaryExportResult {
  path: string;
  markdown: string;
  fileChange?: TuiFileUndoChange;
}

export interface RunCopyTextOptions {
  detail: RunDetailData;
  kind: RunCopyKind;
  selectedPatchIndex?: number;
  agentName?: (agentId?: string) => string;
}

export function defaultRunSummaryPath(projectDir: string, runId: string): string {
  return join(projectDir, ".co-od", "runs", `${runId}.md`);
}

export function resolveRunSummaryPath(projectDir: string, outputPath: string | undefined, runId: string): string {
  const requested = outputPath?.trim();
  if (!requested) return defaultRunSummaryPath(projectDir, runId);
  return isAbsolute(requested) ? requested : join(projectDir, requested);
}

export function formatRunSummaryMarkdown(detail: RunDetailData, input: {
  agentName?: (agentId?: string) => string;
} = {}): string {
  const { run, patches, allRuns } = detail;
  const agentName = input.agentName || ((agentId?: string) => compact(agentId, "unknown"));
  const lines: string[] = [];

  lines.push(`# Run ${shortId(run._id)}`);
  lines.push("");
  lines.push(`- Status: ${compact(run.status, "unknown")}`);
  lines.push(`- Agent: ${agentName(run.agent_id)}`);
  lines.push(`- Execution: ${compact(run.execution_mode, "hosted_api")}`);
  lines.push(`- Created: ${formatTimestamp(run.created_at)}`);
  lines.push(`- Started: ${formatTimestamp(run.started_at)}`);
  lines.push(`- Finished: ${formatTimestamp(run.finished_at)}`);
  if (run.parent_run_id || run.root_run_id || run.handoff_from || run.subagent_role) {
    lines.push(`- Parent: ${compact(run.parent_run_id)}`);
    lines.push(`- Root: ${compact(run.root_run_id)}`);
    lines.push(`- Handoff From: ${compact(run.handoff_from)}`);
    lines.push(`- Role: ${compact(run.subagent_role)}`);
  }
  lines.push("");
  lines.push("## Goal");
  lines.push("");
  lines.push(compact(run.goal, "(no goal)"));

  if (run.join_summary_md) {
    lines.push("");
    lines.push("## Join Summary");
    lines.push("");
    lines.push(run.join_summary_md.trim());
  }

  lines.push("");
  lines.push(`## Timeline (${run.steps?.length ?? 0})`);
  lines.push("");
  if (!run.steps || run.steps.length === 0) {
    lines.push("_No steps recorded._");
  } else {
    for (const step of run.steps) {
      const index = step.idx === undefined ? "-" : String(step.idx);
      const status = step.output?.success === false ? "failed" : step.output?.success === true ? "succeeded" : "recorded";
      lines.push(`- ${index} ${compact(step.kind, "step")} ${status}: ${formatStepDescription(step)}`);
    }
  }

  const delegation = buildDelegationRows(run, allRuns);
  lines.push("");
  lines.push(`## Delegation (${delegation.length})`);
  lines.push("");
  if (delegation.length === 0) {
    lines.push("_No delegation recorded._");
  } else {
    for (const row of delegation) {
      const indent = "  ".repeat(row.depth);
      const selected = row.selected ? " (selected)" : "";
      const role = row.role ? ` ${row.role}` : "";
      lines.push(`${indent}- ${row.relation}${role} ${shortId(row.runId)} ${compact(row.status, "unknown")}${selected}: ${compact(row.goal, "(no goal)")}`);
    }
  }

  lines.push("");
  lines.push(`## Patches (${patches.length})`);
  lines.push("");
  if (patches.length === 0) {
    lines.push("_No patches attached to this run._");
  } else {
    for (const patch of patches) {
      lines.push(`- ${compact(patch.status, "unknown")} ${shortId(patch._id)} ${diffStat(patch.diff_text)} ${compact(patch.title, "(untitled)")} ${compact(patch.path)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatRunCopyText(options: RunCopyTextOptions): string {
  const { detail, kind } = options;
  if (kind === "id") return detail.run._id;
  if (kind === "goal") return compact(detail.run.goal, "(no goal)");
  if (kind === "output") return formatRunOutputText(detail);
  if (kind === "diff") {
    const patch = detail.patches[options.selectedPatchIndex ?? 0];
    return patch?.diff_text || "";
  }
  return formatRunSummaryMarkdown(detail, { agentName: options.agentName });
}

export function formatRunOutputText(detail: RunDetailData): string {
  const lines: string[] = [];
  for (const step of detail.run.steps || []) {
    const chunks = stepOutputChunks(step.output?.payload);
    if (chunks.length === 0) continue;
    const index = step.idx === undefined ? "-" : String(step.idx);
    lines.push(`## Step ${index} ${compact(step.kind, "step")}`);
    lines.push("");
    chunks.forEach((chunk, index) => {
      if (index > 0) lines.push("");
      lines.push(chunk);
    });
    lines.push("");
  }
  return lines.join("\n").trim();
}

function stepOutputChunks(payload?: Record<string, unknown>): string[] {
  if (!payload) return [];
  return ["stdout", "stderr", "output", "text", "summary", "message"]
    .map((key) => payloadString(key, payload[key]))
    .filter((value): value is string => Boolean(value));
}

function payloadString(key: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (key === "stdout" || key === "stderr") {
    return `${key}:\n${value.trim()}`;
  }
  return value.trim();
}

export function writeClipboardText(text: string, writer?: ClipboardWriter): void {
  if (!text) {
    throw new Error("Nothing to copy.");
  }
  if (writer) {
    writer(text);
    return;
  }

  const commands =
    process.platform === "darwin" ? [["pbcopy"]] :
    process.platform === "win32" ? [["clip"]] :
    [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

  for (const command of commands) {
    const [bin, ...args] = command;
    const result = spawnSync(bin, args, { input: text, encoding: "utf-8" });
    if (!result.error && result.status === 0) return;
  }

  throw new Error("No clipboard command found. Install pbcopy, wl-copy, xclip, or xsel.");
}

export function writeRunSummaryExport(options: RunSummaryExportOptions): RunSummaryExportResult {
  const path = resolveRunSummaryPath(options.projectDir, options.outputPath, options.detail.run._id);
  const markdown = formatRunSummaryMarkdown(options.detail, { agentName: options.agentName });
  const fileChange = createFileWriteUndoChange({
    dir: options.projectDir,
    path,
    after: markdown,
  }) || undefined;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf-8");
  return { path, markdown, fileChange };
}

function formatTimestamp(value?: number): string {
  if (!value) return "-";
  return new Date(value).toISOString();
}
