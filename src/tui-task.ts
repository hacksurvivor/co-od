import { executeRoomTask, type ExecuteRoomTaskOptions, type RoomTaskResult } from "./commands/run.js";
import type { ProviderSessionContext } from "./adapters/base.js";
import type { TuiAttachmentTransport } from "./tui-attachments.js";

export type TuiTaskEvent =
  | { type: "submitted"; provider: string; goal: string; model?: string; continueRunId?: string; agentId?: string }
  | { type: "status"; message: string }
  | { type: "output"; data: string }
  | { type: "complete"; result: RoomTaskResult }
  | { type: "error"; message: string };

export type TuiTaskExecutor = (options: ExecuteRoomTaskOptions) => Promise<RoomTaskResult>;

export interface RunTuiTaskOptions {
  roomId: string;
  goal: string;
  provider: string;
  model?: string;
  dir: string;
  agentId?: string;
  attachments?: TuiAttachmentTransport[];
  continueRunId?: string;
  providerSession?: ProviderSessionContext;
  executeTask?: TuiTaskExecutor;
  onEvent?: (event: TuiTaskEvent) => void;
}

export type TuiTaskRunResult =
  | { ok: true; result: RoomTaskResult }
  | { ok: false; errorMessage: string };

export async function runTuiTask(options: RunTuiTaskOptions): Promise<TuiTaskRunResult> {
  const executeTask = options.executeTask || executeRoomTask;
  options.onEvent?.({
    type: "submitted",
    provider: options.provider,
    goal: options.goal,
    model: options.model,
    continueRunId: options.continueRunId,
    agentId: options.agentId,
  });

  try {
    const result = await executeTask({
      roomId: options.roomId,
      goal: options.goal,
      provider: options.provider,
      model: options.model,
      dir: options.dir,
      agentId: options.agentId,
      attachments: options.attachments,
      continueRunId: options.continueRunId,
      providerSession: options.providerSession,
      onStatus: (message) => options.onEvent?.({ type: "status", message }),
      onOutput: (data) => options.onEvent?.({ type: "output", data }),
    });
    options.onEvent?.({ type: "complete", result });
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "error", message });
    return { ok: false, errorMessage: message };
  }
}
