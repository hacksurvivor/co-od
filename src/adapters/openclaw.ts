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
  parseNativeControlJSON,
  runNativeControlCommand,
} from "./native-control.js";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

function executableAvailable(executable: string): boolean {
  if (executable.includes("/")) return existsSync(executable);
  if (!/^[A-Za-z0-9._+-]+$/.test(executable)) return false;
  return (process.env.PATH || "")
    .split(":")
    .some((directory) => existsSync(`${directory}/${executable}`));
}

export function buildOpenClawAcpArgs(): string[] {
  return ["acp"];
}

const openClawRecords = (value: unknown, keys: string[]): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  if (value && typeof value === "object") {
    for (const key of keys) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        const records = openClawRecords(child, keys);
        if (records.length > 0) return records;
      }
    }
  }
  return [];
};

const openClawNativeControls: HarnessNativeControlService = {
  async snapshot(context) {
    const [version, status, sessions, channels, gateway] = await Promise.all([
      runNativeControlCommand(OPENCLAW_BIN, ["--version"], context.workDir),
      runNativeControlCommand(OPENCLAW_BIN, ["status", "--json", "--timeout", "5000"], context.workDir),
      runNativeControlCommand(OPENCLAW_BIN, ["sessions", "--all-agents", "--limit", "50", "--json"], context.workDir),
      runNativeControlCommand(OPENCLAW_BIN, ["channels", "list", "--json"], context.workDir),
      runNativeControlCommand(OPENCLAW_BIN, ["gateway", "status", "--json"], context.workDir),
    ]);
    const sessionItems = openClawRecords(parseNativeControlJSON(sessions.stdout), ["sessions", "data", "items"])
      .slice(0, 50).map((session, index) => ({
        id: String(session.key || session.id || session.sessionId || `session-${index}`),
        title: String(session.title || session.displayName || session.key || "OpenClaw session").slice(0, 180),
        detail: compactNativeControlText(session.model || session.channel || session.updatedAt),
        status: "ready" as const,
      }));
    const channelItems = openClawRecords(parseNativeControlJSON(channels.stdout), ["channels", "accounts", "data", "items"])
      .slice(0, 50).map((channel, index) => {
        const enabled = channel.enabled !== false;
        const configured = channel.configured !== false;
        return {
          id: String(channel.id || channel.name || channel.channel || `channel-${index}`),
          title: String(channel.name || channel.channel || channel.id || "OpenClaw channel").slice(0, 180),
          detail: [configured ? "configured" : "not configured", enabled ? "enabled" : "disabled"].join(" · "),
          status: configured && enabled ? "ready" as const : "unavailable" as const,
        };
      });
    return {
      contractVersion: 1,
      harness: "openclaw",
      observedAt: new Date().toISOString(),
      version: compactNativeControlText(version.stdout || version.stderr, 120),
      groups: [
        {
          id: "gateway",
          title: "Gateway",
          items: [{
            id: "gateway",
            title: gateway.exitCode === 0 ? "Gateway" : "Gateway unavailable",
            detail: compactNativeControlText(gateway.stdout || gateway.stderr || status.stdout || status.stderr),
            status: gateway.exitCode === 0 ? "ready" : "attention",
          }],
        },
        { id: "channels", title: "Channels", items: channelItems },
        { id: "sessions", title: "Sessions", items: sessionItems },
        {
          id: "diagnostics",
          title: "Runtime diagnostics",
          items: [{
            id: "status",
            title: status.exitCode === 0 ? "Read-only status probe passed" : "Status probe needs attention",
            detail: compactNativeControlText(status.stdout || status.stderr),
            status: status.exitCode === 0 ? "ready" : "attention",
          }],
        },
      ],
    };
  },
};

/** OpenClaw is a distinct Gateway-backed runtime; it must never alias ZeroClaw. */
export class OpenClawAdapter implements AgentAdapter {
  name = "openclaw";
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
  nativeControls = openClawNativeControls;

  async available(): Promise<boolean> {
    return executableAvailable(OPENCLAW_BIN);
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    return executeAcpAgent(
      { executable: OPENCLAW_BIN, args: buildOpenClawAcpArgs(), harness: this.name },
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
    );
  }
}
