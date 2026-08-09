export type TuiRenderer = "node" | "opentui" | "chat";

export interface TuiRendererSelection {
  renderer: TuiRenderer;
  args: string[];
  error?: string;
}

export function resolveTuiRendererSelection(args: string[]): TuiRendererSelection {
  const nextArgs: string[] = [];
  let renderer: TuiRenderer = "chat";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value: string | undefined;

    if (arg === "--renderer") {
      value = args[++index];
      if (!value) {
        return { renderer, args: nextArgs, error: "Missing value for --renderer. Use node, opentui, or chat." };
      }
    } else if (arg.startsWith("--renderer=")) {
      value = arg.slice("--renderer=".length);
    } else {
      nextArgs.push(arg);
      continue;
    }

    const normalized = normalizeRenderer(value);
    if (!normalized) {
      return { renderer, args: nextArgs, error: `Unsupported TUI renderer: ${value}. Use node, opentui, or chat.` };
    }
    renderer = normalized;
  }

  return { renderer, args: nextArgs };
}

function normalizeRenderer(value: string): TuiRenderer | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "node" || normalized === "ansi" || normalized === "default") return "node";
  if (normalized === "opentui" || normalized === "open-tui" || normalized === "bun") return "opentui";
  if (normalized === "chat" || normalized === "chat-first") return "chat";
  return undefined;
}

export function chatViewLaunchArgs(selection: TuiRendererSelection): string[] {
  return selection.renderer === "chat" ? ["--view", "chat", ...selection.args] : selection.args;
}
