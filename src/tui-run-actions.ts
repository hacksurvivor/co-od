import { compact, resolveRunId, type AgentRunRecord } from "./tui-model.js";

export interface ContinueCommandResolution {
  ok: boolean;
  runId?: string;
  goal?: string;
  message?: string;
}

export interface ResumeCommandResolution {
  ok: boolean;
  runId?: string;
  goal?: string;
  message?: string;
}

export interface RerunCommandResolution {
  ok: boolean;
  goal?: string;
  runId?: string;
  message?: string;
}

export interface ForkCommandResolution {
  ok: boolean;
  goal?: string;
  runId?: string;
  message?: string;
}

export interface RetryCommandResolution {
  ok: boolean;
  goal?: string;
  runId?: string;
  message?: string;
}

export interface StopCommandResolution {
  ok: boolean;
  runId?: string;
  message?: string;
}

export function resolveContinueCommand(input: {
  runs: AgentRunRecord[];
  args: string[];
  lastRunId?: string;
}): ContinueCommandResolution {
  if (input.runs.length === 0 && !input.lastRunId) {
    return { ok: false, message: "No run is available to continue." };
  }

  const [first, ...rest] = input.args;
  let runId = input.lastRunId || resolveRunId(input.runs, 0) || undefined;
  let goal = input.args.join(" ").trim();

  if (first) {
    const explicit = resolveRunId(input.runs, first);
    const matchedLoadedRun = input.runs.some((run) => run._id === explicit);
    const looksLikeRunRef = matchedLoadedRun || /^\d+$/.test(first) || first.startsWith("run");
    if (looksLikeRunRef) {
      runId = explicit || runId;
      goal = rest.join(" ").trim();
    }
  }

  if (!runId) {
    return { ok: false, message: "No matching run is available to continue." };
  }
  if (!goal) {
    return { ok: false, runId, message: `Add a follow-up prompt after /continue ${runId}.` };
  }
  return { ok: true, runId, goal };
}

export function resolveResumeCommand(input: {
  runs: AgentRunRecord[];
  args: string[];
  lastRunId?: string;
  currentRunId?: string;
  defaultGoal?: string;
}): ResumeCommandResolution {
  if (input.runs.length === 0 && !input.lastRunId && !input.currentRunId) {
    return { ok: false, message: "No run is available to resume." };
  }

  const [first, ...rest] = input.args;
  let runId = input.currentRunId || input.lastRunId || resolveRunId(input.runs, 0) || undefined;
  let goal = input.args.join(" ").trim();

  if (first) {
    const explicit = resolveRunId(input.runs, first);
    const matchedLoadedRun = input.runs.some((run) => run._id === explicit);
    const looksLikeRunRef = matchedLoadedRun || /^\d+$/.test(first) || first.startsWith("run");
    if (looksLikeRunRef) {
      runId = explicit || runId;
      goal = rest.join(" ").trim();
    }
  }

  if (!runId) {
    return { ok: false, message: "No matching run is available to resume." };
  }

  return {
    ok: true,
    runId,
    goal: goal || input.defaultGoal || "Resume this run. Review the prior context and continue with the next useful step.",
  };
}

export function resolveRerunCommand(input: {
  runs: AgentRunRecord[];
  runRef?: string;
}): RerunCommandResolution {
  if (input.runs.length === 0) {
    return { ok: false, message: "No run is available to rerun." };
  }
  const runId = resolveRunId(input.runs, input.runRef || "1");
  const run = input.runs.find((candidate) => candidate._id === runId);
  if (!run) {
    return { ok: false, message: "No matching run is loaded." };
  }
  const goal = compact(run.goal, "");
  if (!goal) {
    return { ok: false, runId: run._id, message: "Selected run has no goal to rerun." };
  }
  return { ok: true, runId: run._id, goal };
}

export function resolveForkCommand(input: {
  runs: AgentRunRecord[];
  args: string[];
  currentRunId?: string;
  lastRunId?: string;
}): ForkCommandResolution {
  if (input.runs.length === 0) {
    return { ok: false, message: "No run is available to fork." };
  }

  const [first, ...rest] = input.args;
  let runId = input.currentRunId || input.lastRunId || resolveRunId(input.runs, "1") || undefined;
  let prompt = input.args.join(" ").trim();

  if (first) {
    const explicit = resolveRunId(input.runs, first);
    const matchedLoadedRun = input.runs.some((run) => run._id === explicit);
    const looksLikeRunRef = matchedLoadedRun || /^\d+$/.test(first) || first.startsWith("run");
    if (looksLikeRunRef) {
      runId = explicit || runId;
      prompt = rest.join(" ").trim();
    }
  }

  const run = input.runs.find((candidate) => candidate._id === runId);
  if (!run) {
    return { ok: false, message: "No matching run is loaded." };
  }

  const sourceGoal = compact(run.goal, "");
  if (!sourceGoal && !prompt) {
    return { ok: false, runId: run._id, message: "Selected run has no goal to fork. Add a prompt after /fork." };
  }

  const goal = [
    `Fork from run ${run._id}.`,
    sourceGoal ? `Original goal: ${sourceGoal}` : "",
    prompt ? `Fork prompt: ${prompt}` : "Fork prompt: Explore an independent alternative approach from the original run context.",
  ].filter(Boolean).join("\n\n");

  return { ok: true, runId: run._id, goal };
}

export function resolveRetryCommand(input: {
  runs: AgentRunRecord[];
  runRef?: string;
  currentRunId?: string;
}): RetryCommandResolution {
  if (input.runs.length === 0) {
    return { ok: false, message: "No run is available to retry." };
  }
  const runId = input.runRef
    ? resolveRunId(input.runs, input.runRef)
    : input.currentRunId || resolveRunId(input.runs, "1");
  const run = input.runs.find((candidate) => candidate._id === runId);
  if (!run) {
    return { ok: false, message: "No matching run is loaded." };
  }
  if (run.status !== "failed" && run.status !== "cancelled") {
    return { ok: false, runId: run._id, message: "Only failed or cancelled runs can be retried. Use /rerun to run any goal again." };
  }
  const goal = compact(run.goal, "");
  if (!goal) {
    return { ok: false, runId: run._id, message: "Selected run has no goal to retry." };
  }
  return { ok: true, runId: run._id, goal };
}

export function resolveStopCommand(input: {
  runs: AgentRunRecord[];
  runRef?: string;
  currentRunId?: string;
}): StopCommandResolution {
  if (input.runs.length === 0) {
    return { ok: false, message: "No run is available to stop." };
  }
  const runId = input.runRef
    ? resolveRunId(input.runs, input.runRef)
    : input.currentRunId || resolveRunId(input.runs, "1");
  const run = input.runs.find((candidate) => candidate._id === runId);
  if (!run) {
    return { ok: false, message: "No matching run is loaded." };
  }
  if (run.status !== "queued" && run.status !== "running") {
    return { ok: false, runId: run._id, message: "Only queued or running tasks can be stopped." };
  }
  return { ok: true, runId: run._id };
}
