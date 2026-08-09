import { attachmentSummary, type TuiAttachment } from "./tui-attachments.js";
import { instructionSummary, type ProjectInstructions } from "./tui-instructions.js";
import { memorySummary, type ProjectMemory } from "./tui-memory.js";
import { compact } from "./tui-model.js";
import { safetySummary, type TuiSafetyState } from "./tui-safety.js";
import type { WorkspaceContext } from "./tui-workspace.js";

export interface TaskContextSummaryInput {
  roomName?: string;
  roomId?: string;
  projectDir: string;
  provider: string;
  model?: string;
  agentName?: string;
  workspace: WorkspaceContext;
  safety: TuiSafetyState;
  attachments: TuiAttachment[];
  instructions: ProjectInstructions;
  memory: ProjectMemory;
}

export function taskContextSummary(input: TaskContextSummaryInput): string[] {
  return [
    "Task context:",
    `room        ${formatRoom(input.roomName, input.roomId)}`,
    `project     ${input.projectDir}`,
    `provider    ${formatProvider(input.provider, input.model, input.agentName)}`,
    `workspace   ${formatWorkspace(input.workspace)}`,
    `safety      ${safetySummary(input.safety, input.provider)}`,
    "",
    "Attachments:",
    ...attachmentSummary(input.attachments, 12).split("\n"),
    "",
    "Instructions:",
    ...instructionSummary(input.instructions, 12),
    "",
    "Memory:",
    ...memorySummary(input.memory, 12),
  ];
}

function formatRoom(roomName?: string, roomId?: string): string {
  if (roomName && roomId && roomName !== roomId) return `${roomName} (${roomId})`;
  return roomName || roomId || "not configured";
}

function formatProvider(provider: string, model?: string, agentName?: string): string {
  return [
    provider,
    model ? `model ${model}` : "",
    agentName ? `agent ${agentName}` : "agent none",
  ].filter(Boolean).join("  ");
}

function formatWorkspace(workspace: WorkspaceContext): string {
  if (!workspace.isGitRepo) {
    return workspace.error ? `not a git repo (${workspace.error})` : "not a git repo";
  }

  return [
    `branch ${compact(workspace.branch, "detached")}`,
    workspace.dirty ? "dirty" : "clean",
    `${workspace.changedFiles.length} files`,
    `+${workspace.insertions}/-${workspace.deletions}`,
    `staged ${workspace.stagedCount}`,
    `unstaged ${workspace.unstagedCount}`,
    `untracked ${workspace.untrackedCount}`,
    workspace.ahead || workspace.behind ? `${workspace.ahead} ahead/${workspace.behind} behind` : "",
  ].filter(Boolean).join("  ");
}
