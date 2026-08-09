import { PROVIDER_LIST } from "./adapters/index.js";

export interface CliCommandInfo {
  desc: string;
  usage: string;
  flags: string[];
}

export const CLI_COMMANDS: Record<string, CliCommandInfo> = {
  tui: {
    desc: "Open the terminal workspace",
    usage: `co-od tui [room] [--renderer node|opentui] [--provider ${PROVIDER_LIST}] [--dir <path>] [--smoke-test] [--startup-profile] [--startup-budget-ms <ms>]`,
    flags: ["--renderer", "--provider", "--dir", "--smoke-test", "--startup-profile", "--startup-budget-ms", "--duration-ms", "--server", "--help", "-h"],
  },
  opentui: {
    desc: "Open the experimental Bun/OpenTUI workspace",
    usage: "co-od opentui [room] [--provider <name>] [--server <url>] [--dir <path>] [--smoke-test] [--startup-profile] [--startup-budget-ms <ms>]",
    flags: ["--provider", "--server", "--dir", "--smoke-test", "--startup-profile", "--startup-budget-ms", "--duration-ms", "--help", "-h"],
  },
  web: {
    desc: "Open the browser workspace",
    usage: "co-od web [--open]",
    flags: ["--open", "--help", "-h"],
  },
  start: {
    desc: "Set up local bridge and browser workspace",
    usage: "co-od start [--open]",
    flags: ["--open", "--help", "-h"],
  },
  init: {
    desc: "Set up a new co-ode project",
    usage: `co-od init [name] [--dir <path>] [--provider ${PROVIDER_LIST}]`,
    flags: ["--dir", "--provider", "--help", "-h"],
  },
  login: {
    desc: "Authenticate with co-ode",
    usage: "co-od login [--token <t>]",
    flags: ["--token", "--help", "-h"],
  },
  auth: {
    desc: "Connect local provider subscriptions",
    usage: "co-od auth [status|login|logout|list] [codex|claude|gemini] [--json]",
    flags: ["--json", "--help", "-h"],
  },
  rooms: {
    desc: "List your rooms",
    usage: "co-od rooms [--json]",
    flags: ["--json", "--help", "-h"],
  },
  run: {
    desc: "Execute a single task in a room",
    usage: `co-od run <room> <goal> [--provider ${PROVIDER_LIST}] [--dir <path>] [--continue <run-id>] [--json]`,
    flags: ["--provider", "--model", "--dir", "--continue", "--json", "--help", "-h"],
  },
  join: {
    desc: "Join a room as an interactive agent",
    usage: "co-od join <room> [--invite-token <tok>] [--dir <path>]",
    flags: ["--invite-token", "--dir", "--help", "-h"],
  },
  daemon: {
    desc: "Autonomous watch mode for a room",
    usage: "co-od daemon <room> [--as <name>] [--auto-execute] [--handoff-to <agent>]",
    flags: ["--as", "--role", "--provider", "--watch", "--auto-execute", "--max-concurrent", "--handoff-to", "--help", "-h"],
  },
  share: {
    desc: "Generate a relay code for teammates",
    usage: `co-od share [--provider ${PROVIDER_LIST}] [--room <room-id>]`,
    flags: ["--provider", "--room", "--help", "-h"],
  },
  connect: {
    desc: "Connect to a relay via code",
    usage: "co-od connect <code>",
    flags: ["--help", "-h"],
  },
  status: {
    desc: "Show current login and running state",
    usage: "co-od status [--json]",
    flags: ["--json", "--help", "-h"],
  },
  doctor: {
    desc: "Check local CLI install and TUI runtime readiness",
    usage: "co-od doctor [--json] [--strict] [--room <id>] [--dir <path>] [--server <url>]",
    flags: ["--json", "--strict", "--room", "--dir", "--server", "--help", "-h"],
  },

  notify: {
    desc: "Route room events to your desktop and Telegram",
    usage: "co-od notify [status | set telegram <bot-token> <chat-id> | set desktop <on|off> | off | test]",
    flags: ["--help", "-h"],
  },
  "tui-qa": {
    desc: "Run TUI flow QA checks",
    usage: "co-od tui-qa [--json] [--live] [--room <id>] [--dir <path>] [--server <url>] [--bridge-url <url>] [--skip-terminal] [--mutate] [--agent <id>]",
    flags: ["--json", "--live", "--room", "--dir", "--server", "--bridge-url", "--bridge", "--skip-terminal", "--mutate", "--agent", "--help", "-h"],
  },
  completion: {
    desc: "Generate a shell completion script",
    usage: "co-od completion <bash|zsh|fish>",
    flags: ["--help", "-h"],
  },
};

export const CLI_COMMAND_NAMES = Object.keys(CLI_COMMANDS);

export const GLOBAL_FLAGS = ["--help", "-h", "--version", "-v", "--open"];

export const PROVIDER_NAMES = PROVIDER_LIST.split("|");
