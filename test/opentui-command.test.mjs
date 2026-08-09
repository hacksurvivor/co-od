import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenTuiLaunchPlan,
  findBunExecutable,
  openTuiRendererPath,
} from "../dist/commands/opentui.js";

test("findBunExecutable prefers BUN_INSTALL and then PATH", () => {
  const existing = new Set([
    "/home/me/.bun/bin/bun",
    "/usr/local/bin/bun",
  ]);
  const exists = (path) => existing.has(path);

  assert.equal(
    findBunExecutable({ BUN_INSTALL: "/home/me/.bun", PATH: "/usr/local/bin" }, exists),
    "/home/me/.bun/bin/bun",
  );
  assert.equal(
    findBunExecutable({ PATH: "/bin:/usr/local/bin" }, exists),
    "/usr/local/bin/bun",
  );
  assert.equal(findBunExecutable({ PATH: "/bin" }, exists), null);
});

test("buildOpenTuiLaunchPlan fails closed without Bun", () => {
  const plan = buildOpenTuiLaunchPlan(["--dir", "/tmp/project"], {
    bun: null,
    rendererPath: "/repo/dist/commands/opentui-renderer.js",
  });

  assert.equal(plan.ok, false);
  assert.match(plan.message || "", /requires Bun/);
  assert.deepEqual(plan.args, ["--dir", "/tmp/project"]);
});

test("buildOpenTuiLaunchPlan targets the isolated renderer script", () => {
  const plan = buildOpenTuiLaunchPlan(["--smoke-test"], {
    bun: "/usr/local/bin/bun",
    rendererPath: "/repo/dist/commands/opentui-renderer.js",
  });

  assert.deepEqual(plan, {
    ok: true,
    bun: "/usr/local/bin/bun",
    rendererPath: "/repo/dist/commands/opentui-renderer.js",
    args: ["--smoke-test"],
  });

  assert.match(openTuiRendererPath(), /opentui-renderer\.js$/);
});
