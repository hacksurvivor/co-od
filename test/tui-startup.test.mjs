import test from "node:test";
import assert from "node:assert/strict";

import {
  createStartupTimer,
  evaluateStartupBudget,
  formatStartupTiming,
} from "../dist/tui-startup.js";

test("createStartupTimer records first paint and refresh timings", () => {
  const values = [100, 180, 560];
  const timer = createStartupTimer({ now: () => values.shift(), budgetMs: 250 });

  assert.deepEqual(timer.markFirstPaint(), {
    firstPaintMs: 80,
    refreshMs: undefined,
    totalMs: undefined,
    budgetMs: 250,
  });
  assert.deepEqual(timer.markRefreshComplete(), {
    firstPaintMs: 80,
    refreshMs: 380,
    totalMs: 460,
    budgetMs: 250,
  });
});

test("formatStartupTiming reports budget status", () => {
  assert.equal(
    formatStartupTiming({ firstPaintMs: 80, refreshMs: 380, totalMs: 460, budgetMs: 250 }),
    "startup first-paint 80ms refresh 380ms total 460ms (within budget, budget 250ms)",
  );
  assert.match(
    formatStartupTiming({ firstPaintMs: 1_200, budgetMs: 1_000 }),
    /over budget/,
  );
});

test("evaluateStartupBudget reports pending, pass, and fail states", () => {
  assert.deepEqual(evaluateStartupBudget({ budgetMs: 250 }), {
    ok: false,
    status: "pending",
    message: "startup first-paint pending (budget 250ms)",
  });
  assert.deepEqual(evaluateStartupBudget({ firstPaintMs: 80, budgetMs: 250 }), {
    ok: true,
    status: "within_budget",
    message: "startup first-paint 80ms within budget 250ms",
  });
  assert.deepEqual(evaluateStartupBudget({ firstPaintMs: 251, budgetMs: 250 }), {
    ok: false,
    status: "over_budget",
    message: "startup first-paint 251ms exceeded budget 250ms",
  });
});
