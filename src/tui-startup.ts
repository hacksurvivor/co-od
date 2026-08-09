export interface TuiStartupTiming {
  firstPaintMs?: number;
  refreshMs?: number;
  totalMs?: number;
  budgetMs: number;
}

export interface TuiStartupTimer {
  markFirstPaint(now?: number): TuiStartupTiming;
  markRefreshComplete(now?: number): TuiStartupTiming;
  snapshot(): TuiStartupTiming;
}

export interface TuiStartupBudgetResult {
  ok: boolean;
  status: "pending" | "within_budget" | "over_budget";
  message: string;
}

export function createStartupTimer(input: {
  now?: () => number;
  budgetMs?: number;
} = {}): TuiStartupTimer {
  const now = input.now || (() => Date.now());
  const startedAt = now();
  const budgetMs = input.budgetMs ?? 1_000;
  let firstPaintMs: number | undefined;
  let refreshMs: number | undefined;
  let totalMs: number | undefined;

  const snapshot = (): TuiStartupTiming => ({
    firstPaintMs,
    refreshMs,
    totalMs,
    budgetMs,
  });

  return {
    markFirstPaint(value = now()) {
      firstPaintMs = Math.max(0, value - startedAt);
      return snapshot();
    },
    markRefreshComplete(value = now()) {
      totalMs = Math.max(0, value - startedAt);
      refreshMs = firstPaintMs === undefined ? totalMs : Math.max(0, totalMs - firstPaintMs);
      return snapshot();
    },
    snapshot,
  };
}

export function formatStartupTiming(timing: TuiStartupTiming): string {
  const firstPaint = timing.firstPaintMs === undefined ? "-" : `${Math.round(timing.firstPaintMs)}ms`;
  const refresh = timing.refreshMs === undefined ? "-" : `${Math.round(timing.refreshMs)}ms`;
  const total = timing.totalMs === undefined ? "-" : `${Math.round(timing.totalMs)}ms`;
  const result = evaluateStartupBudget(timing);
  const status = result.status === "within_budget"
    ? "within budget"
    : result.status === "over_budget"
      ? "over budget"
      : "pending";
  return `startup first-paint ${firstPaint} refresh ${refresh} total ${total} (${status}, budget ${timing.budgetMs}ms)`;
}

export function evaluateStartupBudget(timing: TuiStartupTiming): TuiStartupBudgetResult {
  if (timing.firstPaintMs === undefined) {
    return {
      ok: false,
      status: "pending",
      message: `startup first-paint pending (budget ${timing.budgetMs}ms)`,
    };
  }

  const firstPaint = Math.round(timing.firstPaintMs);
  if (timing.firstPaintMs <= timing.budgetMs) {
    return {
      ok: true,
      status: "within_budget",
      message: `startup first-paint ${firstPaint}ms within budget ${timing.budgetMs}ms`,
    };
  }

  return {
    ok: false,
    status: "over_budget",
    message: `startup first-paint ${firstPaint}ms exceeded budget ${timing.budgetMs}ms`,
  };
}
