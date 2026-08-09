#!/usr/bin/env node

import { CLI_COMMANDS } from "./commands-registry.js";
import { resolveTuiRendererSelection, chatViewLaunchArgs } from "./tui-renderer-option.js";

const VERSION = "0.2.0";

function printHelp() {
  console.error(`co-od v${VERSION} — CLI for co-ode rooms\n`);
  console.error("Usage: co-od <command> [options]\n");
  console.error("Commands:");

  const maxLen = Math.max(...Object.keys(CLI_COMMANDS).map((k) => k.length));
  for (const [name, { desc }] of Object.entries(CLI_COMMANDS)) {
    console.error(`  ${name.padEnd(maxLen + 2)}${desc}`);
  }

  console.error(`\nRun 'co-od <command> --help' for command-specific usage.`);
  console.error(`\nOptions:`);
  console.error(`  --help, -h       Show this help message`);
  console.error(`  --version, -v    Show version`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);

  // Global flags
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    process.exit(0);
  }

  // No args = terminal workspace (chat-first renderer by default). Browser setup
  // remains available via `co-od web` and `co-od --open`.
  if (args.length === 0) {
    args.push("tui");
  }

  if (args[0] === "--open") {
    const { run } = await import("./commands/start.js");
    await run(args);
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Show command-specific help
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    const cmd = CLI_COMMANDS[command];
    if (cmd) {
      console.error(`${cmd.desc}\n`);
      console.error(`Usage: ${cmd.usage}`);
    } else {
      console.error(`Unknown command: ${command}`);
      printHelp();
    }
    process.exit(0);
  }

  // Route to command
  switch (command) {
    case "tui": {
      const selection = resolveTuiRendererSelection(commandArgs);
      if (selection.error) {
        console.error(selection.error);
        process.exit(1);
      }
      // First-run setup gate: make sure the chat opens signed in and in a room,
      // instead of dropping into a roomless dead chat. Skipped for non-interactive
      // runs (no TTY) and smoke tests.
      const dirIndex = selection.args.indexOf("--dir");
      const setupDir = dirIndex >= 0 && selection.args[dirIndex + 1]
        ? selection.args[dirIndex + 1]
        : process.cwd();
      const interactive = process.stdin.isTTY && !selection.args.includes("--smoke-test");
      if (selection.renderer === "chat" && interactive) {
        const { runSetupGate } = await import("./commands/setup-gate.js");
        const gate = await runSetupGate(setupDir);
        if (!gate.ready) {
          // Open the room anyway — the welcome card walks through /login and
          // /init in-TUI. Never bounce the user back to the shell.
          console.error(`\n  Setup didn't finish${gate.reason ? ` (${gate.reason})` : ""} — opening anyway.`);
          console.error(`  /login and /init work right inside the chat.\n`);
        }
      }
      const wantsOpenTuiHost = selection.renderer === "opentui" || selection.renderer === "chat";
      const { findBunExecutable } = await import("./commands/opentui.js");
      const bunAvailable = Boolean(findBunExecutable());
      if (wantsOpenTuiHost && bunAvailable) {
        const { run } = await import("./commands/opentui.js");
        await run(chatViewLaunchArgs(selection));
      } else {
        if (wantsOpenTuiHost && !bunAvailable) {
          console.error("[co-od] Bun not found — using the basic renderer. Install Bun for the chat UI: https://bun.sh");
        }
        const { run } = await import("./commands/tui.js");
        await run(selection.args);
      }
      break;
    }
    case "opentui": {
      const { run } = await import("./commands/opentui.js");
      await run(commandArgs);
      break;
    }
    case "web": {
      const { run } = await import("./commands/start.js");
      await run(["--open", ...commandArgs]);
      break;
    }
    case "start": {
      const { run } = await import("./commands/start.js");
      await run(commandArgs);
      break;
    }
    case "init": {
      const { run } = await import("./commands/init.js");
      await run(commandArgs);
      break;
    }
    case "login": {
      const { run } = await import("./commands/login.js");
      await run(commandArgs);
      break;
    }
    case "auth": {
      const { run } = await import("./commands/auth.js");
      await run(commandArgs);
      break;
    }
    case "rooms": {
      const { run } = await import("./commands/rooms.js");
      await run(commandArgs);
      break;
    }
    case "run": {
      const { run } = await import("./commands/run.js");
      await run(commandArgs);
      break;
    }
    case "join": {
      const { run } = await import("./commands/join.js");
      await run(commandArgs);
      break;
    }
    case "daemon": {
      const { run } = await import("./commands/daemon.js");
      await run(commandArgs);
      break;
    }
    case "share": {
      const { run } = await import("./commands/share.js");
      await run(commandArgs);
      break;
    }
    case "connect": {
      const { run } = await import("./commands/connect.js");
      await run(commandArgs);
      break;
    }
    case "status": {
      const { run } = await import("./commands/status.js");
      await run(commandArgs);
      break;
    }
    case "doctor": {
      const { run } = await import("./commands/doctor.js");
      await run(commandArgs);
      break;
    }
    case "notify": {
      const { run } = await import("./commands/notify.js");
      await run(commandArgs);
      break;
    }
    case "tui-qa": {
      const { run } = await import("./commands/tui-qa.js");
      await run(commandArgs);
      break;
    }
    case "completion": {
      const { run } = await import("./commands/completion.js");
      await run(commandArgs);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[co-od] Fatal: ${err.message || err}`);
  process.exit(1);
});
