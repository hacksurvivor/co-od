import { existsSync } from "node:fs";
import { executeAcpAgent } from "./acp.js";
import {
  existingAttachmentPaths,
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";
import { openCodeNativeSessionState } from "./opencode-server.js";

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

function which(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(":");
  return paths.some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildOpenCodeArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
): string[] {
  const args = ["run"];
  args.push("--format", "json");
  if (options.providerSession?.providerSessionId) {
    args.push("--session", options.providerSession.providerSessionId);
    if (options.providerSession.mode === "fork") {
      args.push("--fork");
    }
  }
  if (options.model) args.push("--model", options.model);
  for (const file of existingAttachmentPaths(options.attachments, ["file", "image"])) {
    args.push("--file", file);
  }
  args.push(goal);
  return args;
}

export class OpenCodeAdapter implements AgentAdapter {
  name = "opencode";
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
    sessionRewind: true,
    approvalBridge: true,
    planReporting: true,
    diffReporting: true,
    checkpointing: true,
    rollback: true,
    usageReporting: true,
    costReporting: true,
    modelDiscovery: true,
    providerDiscovery: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });
  nativeSessionState = openCodeNativeSessionState;

  async available(): Promise<boolean> {
    return which(OPENCODE_BIN);
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    return executeAcpAgent(
      { executable: OPENCODE_BIN, args: ["acp"], harness: this.name },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
