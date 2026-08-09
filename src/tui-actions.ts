export {
  TUI_PROVIDERS,
  cycleProvider,
  resolveProviderCommand,
  type ProviderState,
} from "./tui-provider.js";

export interface KeyInfo {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export interface Action {
  id: "task" | "join" | "init" | "login" | "rooms" | "run" | "open" | "help" | "quit";
  key: string;
  label: string;
  hint: string;
  enabled: boolean;
}

export interface ActionContext {
  hasRoom: boolean;
  loggedIn: boolean;
  taskRunning: boolean;
  terminalActive: boolean;
  terminalConnecting?: boolean;
  terminalDisconnected?: boolean;
  runCount: number;
}

export type MenuKeyIntent =
  | { type: "none" }
  | { type: "quit" }
  | { type: "select"; selected: number }
  | { type: "execute"; action: Action }
  | { type: "refresh" }
  | { type: "cycle_provider" }
  | { type: "open_palette" }
  | { type: "open_help" }
  | { type: "start_slash" }
  | { type: "start_find" }
  | { type: "open_run"; index: number };

export type TaskKeyIntent =
  | { type: "none" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "backspace" }
  | { type: "history"; direction: -1 | 1 }
  | { type: "submit" }
  | { type: "append"; text: string };

export type RunKeyIntent =
  | { type: "none" }
  | { type: "back" }
  | { type: "refresh" }
  | { type: "move_patch"; direction: -1 | 1 }
  | { type: "select_patch"; position: "first" | "last" }
  | { type: "accept_patch" }
  | { type: "reject_patch" }
  | { type: "export_run" }
  | { type: "copy_run" }
  | { type: "retry_run" }
  | { type: "stop_run" }
  | { type: "handoff_run" }
  | { type: "cycle_handoff_target"; direction: -1 | 1 }
  | { type: "open_run"; index: number };

export type PaletteKeyIntent =
  | { type: "none" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "backspace" }
  | { type: "move"; direction: -1 | 1 }
  | { type: "submit" }
  | { type: "append"; text: string };

export interface SlashCommand {
  command: string;
  args: string[];
}

export function buildActions(context: ActionContext): Action[] {
  return [
    {
      id: "task",
      key: "t",
      label: "Run an agent task",
      hint: "type a prompt and execute locally",
      enabled: context.hasRoom && context.loggedIn && !context.taskRunning,
    },
    {
      id: "join",
      key: "c",
      label: context.terminalActive
        ? "Focus shared terminal"
        : context.terminalConnecting
          ? "Connecting shared terminal"
          : context.terminalDisconnected
            ? "Reconnect shared terminal"
            : "Connect shared terminal",
      hint: context.terminalActive
        ? "send input to the room shell"
        : context.terminalDisconnected
          ? "restore the room shell connection"
          : "embed room shell in this TUI",
      enabled: context.hasRoom,
    },
    {
      id: "init",
      key: "i",
      label: context.hasRoom ? "Reinitialize project room" : "Initialize project room",
      hint: "create .co-od.json for this directory",
      enabled: context.loggedIn,
    },
    {
      id: "login",
      key: "l",
      label: context.loggedIn ? "Refresh login" : "Login",
      hint: "browser device auth",
      enabled: true,
    },
    {
      id: "rooms",
      key: "m",
      label: "List rooms",
      hint: "show server rooms",
      enabled: context.loggedIn,
    },
    {
      id: "run",
      key: "v",
      label: "Inspect latest run",
      hint: "steps, patches, and diff review",
      enabled: context.hasRoom && context.loggedIn && context.runCount > 0,
    },
    {
      id: "open",
      key: "o",
      label: "Open browser workspace",
      hint: "kept as an escape hatch",
      enabled: context.hasRoom,
    },
    {
      id: "help",
      key: "?",
      label: "Keyboard help",
      hint: "show keybindings and terminal controls",
      enabled: true,
    },
    {
      id: "quit",
      key: "q",
      label: "Quit",
      hint: "leave the terminal shell",
      enabled: true,
    },
  ];
}

export function parseSlashCommand(input: string): SlashCommand {
  const [rawCommand = "help", ...args] = input.slice(1).trim().split(/\s+/).filter(Boolean);
  const command = rawCommand.toLowerCase();
  return { command: command === "exit" ? "quit" : command, args };
}

export function slashHelpText(): string {
  return [
    "Slash commands:",
    "/help, /clear, /undo, /provider [name], /model, /agent, /run [id|index], /runs, /sessions [query], /session [index|id|query], /copy [id|goal|summary|diff|output], /export",
    "/fanout <all|agent[,agent]> <prompt>, /handoff-target <agent|index>, /handoff [run|current|last] <agent> [context]",
    "/agent-start <agent> <prompt>, /agent-stop <agent>, /agent-pause <agent>, /agent-resume <agent>",
    "/continue [run|index] <prompt>, /resume [run|index] [prompt], /fork [run|index] [prompt], /rerun, /retry, /stop [run|index]",
    "/history [query], /use-history [index|query], /again [index|query]",
    "/find <query> search the visible feed and shared-terminal scrollback",
    "/room <pinned-room>, /rooms",
    "/runtime, /env status, /env start [ttlSeconds], /env stop, /env touch",
    "/health, /doctor, /qa [live] [--bridge-url <url>], /live-qa, /git, /diff [path], /files [query], /search <query>, /symbols [query], /goto <symbol>, /rename-preview <symbol> <new-name>, /rename <symbol> <new-name>, /diagnostics [tsconfig], /context",
    "/view <path[:line]>, /peek <path[:line]> preview a workspace file around a line",
    "/instructions, /instructions attach, /memory, /memory attach",
    "/attach <path>, /attach-image <path>, /detach <path|index|all>, /attachments",
    "/pin [room|provider|agent] [value], /unpin <room|provider|agent> <value>, /pins",
    "/safety, /safety audit, /safety toggle <auto-run|auto-apply|network|dangerous>",
    "/terminal, /reconnect, /open, /login, /init, /exit, /quit",
  ].join("\n");
}

export function resolveMenuKey(chunk: string, key: KeyInfo, actions: Action[], selected: number): MenuKeyIntent {
  const name = key.name || "";

  if (name === "q") return { type: "quit" };
  if (name === "down" || name === "tab" || name === "j") {
    return { type: "select", selected: (selected + 1) % actions.length };
  }
  if (name === "up" || name === "k") {
    return { type: "select", selected: (selected - 1 + actions.length) % actions.length };
  }
  if (name === "return") return { type: "execute", action: actions[selected] };
  if (key.ctrl && name === "f") return { type: "start_find" };
  if (name === "f") return { type: "refresh" };
  if (key.ctrl && name === "p") return { type: "open_palette" };
  if (name === "p") return { type: "cycle_provider" };
  if (chunk === "?") return { type: "open_help" };
  if (chunk === "/") return { type: "start_slash" };
  if (/^[1-9]$/.test(chunk)) return { type: "open_run", index: Number(chunk) - 1 };

  const shortcut = actions.find((action) => action.key === name);
  if (shortcut) return { type: "execute", action: shortcut };

  return { type: "none" };
}

export function resolveTaskKey(chunk: string, key: KeyInfo): TaskKeyIntent {
  const name = key.name || "";
  if (name === "escape") return { type: "cancel" };
  if (key.ctrl && name === "u") return { type: "clear" };
  if (key.ctrl && name === "j") return { type: "append", text: "\n" };
  if (name === "backspace") return { type: "backspace" };
  if (name === "up") return { type: "history", direction: -1 };
  if (name === "down") return { type: "history", direction: 1 };
  if (name === "return") return { type: "submit" };
  if (chunk && chunk >= " " && chunk !== "\x7f") return { type: "append", text: chunk };
  return { type: "none" };
}

export function resolveRunKey(chunk: string, key: KeyInfo): RunKeyIntent {
  const name = key.name || "";
  if (chunk === "R") return { type: "retry_run" };
  if (name === "escape" || name === "q") return { type: "back" };
  if (name === "r" || name === "f") return { type: "refresh" };
  if (name === "h") return { type: "handoff_run" };
  if (chunk === "[") return { type: "cycle_handoff_target", direction: -1 };
  if (chunk === "]") return { type: "cycle_handoff_target", direction: 1 };
  if (name === "j" || name === "down") return { type: "move_patch", direction: 1 };
  if (name === "k" || name === "up") return { type: "move_patch", direction: -1 };
  if (chunk === "G") return { type: "select_patch", position: "last" };
  if (name === "g") return { type: "select_patch", position: "first" };
  if (name === "a") return { type: "accept_patch" };
  if (name === "x") return { type: "reject_patch" };
  if (name === "e") return { type: "export_run" };
  if (name === "y" || name === "c") return { type: "copy_run" };
  if (name === "s") return { type: "stop_run" };
  if (/^[1-9]$/.test(chunk)) return { type: "open_run", index: Number(chunk) - 1 };
  return { type: "none" };
}

export function resolvePaletteKey(chunk: string, key: KeyInfo): PaletteKeyIntent {
  const name = key.name || "";
  if (name === "escape") return { type: "cancel" };
  if (key.ctrl && name === "u") return { type: "clear" };
  if (name === "backspace") return { type: "backspace" };
  if (name === "up" || (key.ctrl && name === "p")) return { type: "move", direction: -1 };
  if (name === "down" || name === "tab" || (key.ctrl && name === "n")) return { type: "move", direction: 1 };
  if (name === "return") return { type: "submit" };
  if (chunk && chunk >= " " && chunk !== "\x7f") return { type: "append", text: chunk };
  return { type: "none" };
}
