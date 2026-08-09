#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function printHelp() {
  console.log(`co-od TUI release gate

Usage:
  pnpm release:tui -- --room <room-id> [--server <url>] [--dir <path>]

Options:
  --room <id>          Target beta room for strict doctor and live QA
  --server <url>       Target server, defaults to CO_ODE_SERVER or https://co-od.dev
  --dir <path>         Project directory for room config and persisted TUI state
  --bridge-url <url>   Local bridge URL for approval-broker live QA checks
  --bridge <url>       Alias for --bridge-url
  --agent <id>         Preferred disposable mutation agent
  --skip-terminal      Skip live terminal realtime session check
  --help, -h           Show this help
`);
}

function fail(message) {
  console.error(`[release:tui] ${message}`);
  process.exit(1);
}

function assertKnownArgs(args) {
  const valueFlags = new Set(["--room", "--server", "--dir", "--bridge-url", "--bridge", "--agent"]);
  const booleanFlags = new Set(["--skip-terminal", "--help", "-h"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      i++;
      continue;
    }
    if (booleanFlags.has(arg)) continue;
    fail(`unknown argument: ${arg}`);
  }
}

function run(command, args, options = {}) {
  console.error(`\n[release:tui] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || packageDir,
    env: options.env || process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runPnpm(args, options = {}) {
  run("corepack", ["pnpm", ...args], options);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
  printHelp();
  process.exit(0);
}
assertKnownArgs(args);

const roomId = readFlagValue(args, "--room") || process.env.CO_ODE_RELEASE_ROOM;
const serverUrl = readFlagValue(args, "--server") || process.env.CO_ODE_SERVER;
const projectDir = readFlagValue(args, "--dir");
const bridgeUrl = readFlagValue(args, "--bridge-url") || readFlagValue(args, "--bridge");
const agentId = readFlagValue(args, "--agent");
const skipTerminal = hasFlag(args, "--skip-terminal");

const env = {
  ...process.env,
  ...(serverUrl ? { CO_ODE_SERVER: serverUrl } : {}),
};

const doctorArgs = ["dist/index.js", "doctor", "--strict"];
const liveArgs = ["dist/index.js", "tui-qa", "--live"];
const mutateArgs = ["dist/index.js", "tui-qa", "--live", "--mutate"];

for (const target of [doctorArgs, liveArgs, mutateArgs]) {
  if (roomId) target.push("--room", roomId);
  if (serverUrl) target.push("--server", serverUrl);
  if (projectDir) target.push("--dir", projectDir);
}
for (const target of [liveArgs, mutateArgs]) {
  if (bridgeUrl) target.push("--bridge-url", bridgeUrl);
  if (skipTerminal) target.push("--skip-terminal");
}
if (agentId) mutateArgs.push("--agent", agentId);

runPnpm(["run", "verify:tui"], { env });
runPnpm(["run", "smoke:fresh-install"], { env });
run(process.execPath, doctorArgs, { env });
run(process.execPath, liveArgs, { env });
run(process.execPath, mutateArgs, { env });
