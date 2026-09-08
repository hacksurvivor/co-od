import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

interface ToolEvent { toolName: string; input: Record<string, unknown> }
interface ToolContext {
  cwd: string;
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}
interface ExtensionAPI {
  registerFlag(name: string, options: { description: string; type: "string"; default: string }): void;
  getFlag(name: string): unknown;
  on(event: "tool_call", handler: (event: ToolEvent, ctx: ToolContext) => Promise<{ block: true; reason: string } | undefined>): void;
}

const readTools = new Set(["read", "grep", "find", "ls"]);

/** Native Pi lifecycle hook: keep tools available while enforcing the selected policy. */
export default function coodePermissions(pi: ExtensionAPI): void {
  pi.registerFlag("coode-permission-mode", { description: "co·od tool approval mode", type: "string", default: "ask" });
  pi.on("tool_call", async (event, ctx) => {
    const mode = pi.getFlag("coode-permission-mode");
    if (mode === "fullAccess") return;
    if (readTools.has(event.toolName)) return;
    if (mode === "plan") return { block: true, reason: "Plan mode permits reading; switch modes to run this tool." };
    if (mode === "approve" && ["edit", "write"].includes(event.toolName)) {
      const path = typeof event.input.path === "string" ? resolve(ctx.cwd, event.input.path) : undefined;
      if (path) {
        // A missing write target is resolved through its nearest existing ancestor.
        let ancestor = path;
        while (true) {
          try {
            const distance = relative(realpathSync(ctx.cwd), realpathSync(ancestor));
            if (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance)) return;
            break;
          } catch {
            try { if (lstatSync(ancestor).isSymbolicLink()) break; } catch {}
            const parent = resolve(ancestor, "..");
            if (parent === ancestor) break;
            ancestor = parent;
          }
        }
      }
    }
    try {
      if (ctx.hasUI && await ctx.ui.confirm(`Allow ${event.toolName}?`, JSON.stringify(event.input))) return;
    } catch { /* A disconnected approval UI never grants a tool call. */ }
    return { block: true, reason: "This tool call was not approved." };
  });
}
