import { existsSync } from "node:fs";
import { executeAcpAgent } from "./acp.js";
import {
  coodeIsolatedBrowser,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
  type HarnessNativeControlService,
} from "./base.js";
import {
  compactNativeControlText,
  runNativeControlCommand,
} from "./native-control.js";

const ZEROCLAW_BIN = process.env.ZEROCLAW_BIN || "zeroclaw";

function executableAvailable(executable: string): boolean {
  if (executable.includes("/")) return existsSync(executable);
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) return false;
  return (process.env.PATH || "")
    .split(":")
    .some((directory) => existsSync(`${directory}/${executable}`));
}

export function buildZeroClawAcpArgs(): string[] {
  return ["acp"];
}

/** Select only an explicit alias or an unambiguous native configuration. */
export function zeroClawAgentAlias(config: unknown, explicit = process.env.ZEROCLAW_AGENT_ALIAS): string {
  if (explicit?.trim()) return explicit.trim();
  const value = config && typeof config === "object" ? (config as { value?: unknown }).value : undefined;
  const aliases = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (aliases.length === 1) return aliases[0]!;
  throw new Error(aliases.length
    ? "ZeroClaw has multiple configured agents. Select one with ZEROCLAW_AGENT_ALIAS before starting this agent."
    : "ZeroClaw requires a configured agent alias. Configure a native ZeroClaw agent before starting it in co·od.");
}

const zeroClawNativeControls: HarnessNativeControlService = {
  async snapshot(context) {
    const [version, runtime, estop, autonomy] = await Promise.all([
      runNativeControlCommand(ZEROCLAW_BIN, ["--version"], context.workDir),
      runNativeControlCommand(ZEROCLAW_BIN, ["status"], context.workDir),
      runNativeControlCommand(ZEROCLAW_BIN, ["estop", "status"], context.workDir),
      runNativeControlCommand(ZEROCLAW_BIN, ["config", "get", "autonomy.level"], context.workDir),
    ]);
    const estopText = estop.stdout || estop.stderr;
    const engaged = /engaged|active|kill-all|network-kill|domain-block|tool-freeze/i.test(estopText)
      && !/not engaged|inactive|disabled|none/i.test(estopText);
    return {
      contractVersion: 1,
      harness: "zeroclaw",
      observedAt: new Date().toISOString(),
      version: compactNativeControlText(version.stdout || version.stderr, 120),
      groups: [
        {
          id: "runtime",
          title: "Autonomous runtime",
          items: [{
            id: "runtime-status",
            title: runtime.exitCode === 0 ? "Runtime status" : "Runtime unavailable",
            detail: compactNativeControlText(runtime.stdout || runtime.stderr),
            status: runtime.exitCode === 0 ? "ready" : "attention",
          }, {
            id: "autonomy-level",
            title: "Autonomy level",
            detail: compactNativeControlText(autonomy.stdout || autonomy.stderr) || "Not reported by this version",
            status: autonomy.exitCode === 0 ? "ready" : "unknown",
          }],
        },
        {
          id: "emergency-stop",
          title: "Emergency stop",
          detail: "Provider-native ZeroClaw safety control",
          items: [{
            id: "estop-status",
            title: engaged ? "Emergency stop engaged" : "Emergency stop ready",
            detail: compactNativeControlText(estopText),
            status: engaged ? "attention" : "ready",
            actions: engaged ? [{
              id: "zeroclaw-estop-resume",
              title: "Resume ZeroClaw",
              risk: "privileged",
              confirmation: "RESUME",
              inputLabel: "One-time resume OTP (if configured)",
            }] : [{
              id: "zeroclaw-estop-engage",
              title: "Emergency stop",
              risk: "safe",
            }],
          }],
        },
      ],
    };
  },
  async perform(context, actionID, _providerID, input) {
    const args = actionID === "zeroclaw-estop-engage" ? ["estop"]
      : actionID === "zeroclaw-estop-resume"
        ? ["estop", "resume", ...(input?.trim() ? ["--otp", input.trim()] : [])]
        : undefined;
    if (!args) throw new Error("Unsupported ZeroClaw control action.");
    const result = await runNativeControlCommand(ZEROCLAW_BIN, args, context.workDir, 20_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "ZeroClaw declined the control action.");
    }
    return this.snapshot(context);
  },
};

/** ZeroClaw has its own versioned ACP/session/autonomy surface. */
export class ZeroClawAdapter implements AgentAdapter {
  name = "zeroclaw";
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
    sessionClose: true,
    attachments: true,
    permissionSelection: true,
    approvalBridge: true,
    planReporting: true,
    usageReporting: true,
    costReporting: true,
    modelDiscovery: true,
    providerDiscovery: true,
    externalActions: true,
    browser: coodeIsolatedBrowser(),
  });
  nativeControls = zeroClawNativeControls;

  async available(): Promise<boolean> {
    return executableAvailable(ZEROCLAW_BIN);
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    let agentAlias: string;
    try {
      let config: unknown;
      if (!process.env.ZEROCLAW_AGENT_ALIAS?.trim()) {
        const result = await runNativeControlCommand(ZEROCLAW_BIN, ["config", "get", "agents", "--json"], options.workDir);
        if (result.exitCode === 0) config = JSON.parse(result.stdout);
      }
      agentAlias = zeroClawAgentAlias(config);
    } catch (error) {
      return { exitCode: 78, stdout: "", stderr: error instanceof Error ? error.message : "ZeroClaw agent configuration is unavailable." };
    }
    return executeAcpAgent(
      { executable: ZEROCLAW_BIN, args: buildZeroClawAcpArgs(), harness: this.name, newSessionParameters: { agentAlias }, stopSessionOnCancel: true },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
