import { existsSync } from "node:fs";
import { executeAcpAgent } from "./acp.js";
import {
  boundedActivityPayload,
  existingAttachmentPaths,
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessNativeControlService,
} from "./base.js";
import { compactNativeControlText, runNativeControlCommand } from "./native-control.js";

function which(cmd: string): boolean {
  return (process.env.PATH || "").split(":").some((dir) => existsSync(`${dir}/${cmd}`));
}

const geminiNativeControls: HarnessNativeControlService = {
  async snapshot(context) {
    const [version, sessions] = await Promise.all([
      runNativeControlCommand("gemini", ["--version"], context.workDir),
      runNativeControlCommand("gemini", ["--list-sessions"], context.workDir),
    ]);
    const sessionItems = sessions.stdout.split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean).slice(0, 50)
      .map((line, index) => ({
        id: `gemini-session-${index}`,
        title: line.slice(0, 200),
        status: "ready" as const,
      }));
    return {
      contractVersion: 1,
      harness: "gemini",
      observedAt: new Date().toISOString(),
      version: compactNativeControlText(version.stdout || version.stderr, 120),
      groups: [{ id: "sessions", title: "Sessions", items: sessionItems }, {
        id: "rewind",
        title: "Rewind",
        detail: "Capability boundary",
        items: [{
          id: "rewind-contract",
          title: "Interactive rewind is not exposed over Gemini ACP",
          detail: "This installed CLI supports /rewind in its TUI, but its documented ACP contract exposes load, prompt, cancel, mode, and model controls only. co·ode will not automate terminal keystrokes or edit Gemini's private session store.",
          status: "unavailable",
        }],
      }],
    };
  },
};

export function buildGeminiArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.providerSession?.providerSessionId) {
    args.push("--resume", options.providerSession.providerSessionId);
  }
  args.push("--output-format", "stream-json");
  const references = existingAttachmentPaths(options.attachments, ["file", "directory", "image"]);
  const prompt = references.length > 0
    ? `${references.map((path) => `@${path}`).join("\n")}\n\n${goal}`
    : goal;
  args.push("--prompt", prompt);
  return args;
}

export function parseGeminiStreamOutput(stdout: string): { text: string; providerSessionId?: string } {
  let text = "";
  let providerSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "init" && typeof event.session_id === "string") {
        providerSessionId = event.session_id;
      }
      if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
        text += event.content;
      }
    } catch {
      // Unknown provider output is preserved as a fallback below.
    }
  }
  return {
    text: text || stdout,
    providerSessionId: providerSessionId || resolveProviderSessionIdFromResult(stdout),
  };
}

export class GeminiAdapter implements AgentAdapter {
  name = "gemini";
  capabilities = harnessCapabilities({
    transport: {
      kind: "acp",
      protocolVersion: 1,
      capabilityNegotiation: true,
      structuredEvents: true,
    },
    sessionResume: true,
    sessionFork: true,
    sessionLoad: true,
    sessionList: true,
    sessionDelete: true,
    approvalBridge: true,
    planReporting: true,
    diffReporting: true,
    checkpointing: true,
    rollback: true,
    subagents: true,
    usageReporting: true,
    costReporting: true,
    modelDiscovery: true,
    providerDiscovery: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });
  nativeControls = geminiNativeControls;

  async available(): Promise<boolean> {
    return which("gemini");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    return executeAcpAgent(
      { executable: "gemini", args: ["--acp"], harness: this.name },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
