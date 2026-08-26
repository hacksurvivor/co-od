import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  existingAttachmentPaths,
  boundedActivityPayload,
  coodeIsolatedBrowser,
  declaredHarnessCapabilityReceipt,
  harnessCapabilities,
  promptWithHarnessCapabilities,
  providerProcessEnvironment,
  resolveProviderSessionIdFromResult,
  type AgentAdapter,
  type ExecuteOptions,
  type ExecuteResult,
} from "./base.js";

function which(cmd: string): boolean {
  return (process.env.PATH || "").split(":").some((dir) => existsSync(`${dir}/${cmd}`));
}

export function buildAntigravityArgs(
  goal: string,
  options: Pick<ExecuteOptions, "attachments" | "model" | "providerSession"> = {},
  structuredOutput = false,
): string[] {
  const args = ["--sandbox", "--mode", "accept-edits"];
  if (options.model) args.push("--model", options.model);
  if (options.providerSession?.providerSessionId) {
    args.push("--conversation", options.providerSession.providerSessionId);
  }
  if (structuredOutput) args.push("--output-format", "stream-json");
  const references = existingAttachmentPaths(options.attachments, ["file", "directory", "image"]);
  const prompt = references.length > 0
    ? `${references.map((path) => `@${path}`).join("\n")}\n\n${goal}`
    : goal;
  args.push("--print", prompt);
  return args;
}

const parseVersion = (value: string): [number, number, number] | undefined => {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\D|$)/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

export const antigravitySupportsStructuredOutput = (version: string): boolean => {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor, patch] = parsed;
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 8)));
};

const captureAntigravityVersion = (): Promise<string> => new Promise((resolve) => {
  const child = spawn(process.env.ANTIGRAVITY_BIN || "agy", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const finish = () => resolve(output.trim().slice(0, 512));
  const timer = setTimeout(() => child.kill("SIGTERM"), 3_000);
  timer.unref();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { output += chunk; });
  child.once("error", finish);
  child.once("close", () => {
    clearTimeout(timer);
    finish();
  });
});

const textValue = (...values: unknown[]): string | undefined => values
  .find((value) => typeof value === "string" && value.trim()) as string | undefined;

export interface AntigravityStructuredEvent {
  text?: string;
  final?: boolean;
  providerSessionID?: string;
  activities: Array<Parameters<NonNullable<ExecuteOptions["onActivity"]>>[0]>;
}

export function parseAntigravityStructuredLine(line: string): AntigravityStructuredEvent | undefined {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = textValue(value.type, value.event) || "";
  const nested = value[type] && typeof value[type] === "object" && !Array.isArray(value[type])
    ? value[type] as Record<string, unknown> : {};
  const data = { ...value, ...nested };
  const providerSessionID = textValue(
    data.conversation_id,
    data.conversationId,
    data.session_id,
    data.sessionId,
  );
  const activities: AntigravityStructuredEvent["activities"] = [];
  const tool = data.tool_info && typeof data.tool_info === "object"
    ? data.tool_info as Record<string, unknown>
    : undefined;
  if (tool) {
    const status = textValue(tool.status, data.status, data.state)?.toLowerCase() || "";
    const name = textValue(tool.name, tool.tool_name, tool.tool, "Antigravity tool")!;
    activities.push({
      kind: "tool",
      phase: ["completed", "complete", "done", "failed", "error"].includes(status)
        ? "completed" : "started",
      title: name,
      tool: name,
      ...(boundedActivityPayload(tool.input ?? tool.arguments) ? {
        input: boundedActivityPayload(tool.input ?? tool.arguments),
      } : {}),
      ...(boundedActivityPayload(tool.output ?? tool.result) ? {
        output: boundedActivityPayload(tool.output ?? tool.result),
      } : {}),
    });
  }
  const subagent = data.subagent_info && typeof data.subagent_info === "object"
    ? data.subagent_info as Record<string, unknown>
    : undefined;
  if (subagent) {
    const status = textValue(subagent.status, data.status, data.state)?.toLowerCase() || "";
    activities.push({
      kind: "tool",
      phase: ["completed", "complete", "done", "failed", "error"].includes(status)
        ? "completed" : "started",
      title: textValue(subagent.name, subagent.task, "Antigravity subagent")!,
      agentID: textValue(subagent.id, subagent.agent_id),
      parentAgentID: textValue(subagent.parent_id, subagent.parent_agent_id),
      background: subagent.background === true,
      ...(boundedActivityPayload(subagent.task ?? subagent.prompt) ? {
        input: boundedActivityPayload(subagent.task ?? subagent.prompt),
      } : {}),
      ...(boundedActivityPayload(subagent.result ?? subagent.output) ? {
        output: boundedActivityPayload(subagent.result ?? subagent.output),
      } : {}),
    });
  }
  const text = type === "result"
    ? textValue(data.response, data.result, data.output, data.text, data.message)
    : textValue(data.text_delta, data.delta, type === "step_update" ? data.text : undefined);
  return {
    ...(text ? { text } : {}),
    ...(type === "result" ? { final: true } : {}),
    ...(providerSessionID ? { providerSessionID } : {}),
    activities,
  };
}

export class AntigravityAdapter implements AgentAdapter {
  name = "antigravity";
  capabilities = harnessCapabilities({
    transport: {
      kind: "jsonl",
      capabilityNegotiation: false,
      structuredEvents: true,
    },
    sessionResume: true,
    attachments: true,
    modelSelection: true,
    browser: coodeIsolatedBrowser(),
  });

  async available(): Promise<boolean> {
    return which("agy");
  }

  async execute(goal: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const version = await captureAntigravityVersion();
    const structuredOutput = antigravitySupportsStructuredOutput(version);
    const runCapabilities = structuredOutput ? this.capabilities : harnessCapabilities({
      ...this.capabilities,
      transport: {
        kind: "plainText",
        capabilityNegotiation: false,
        structuredEvents: false,
      },
    });
    const args = buildAntigravityArgs(
      promptWithHarnessCapabilities(goal, options, this.name),
      options,
      structuredOutput,
    );
    const result = await new Promise<ExecuteResult>((resolve) => {
      const child = spawn("agy", args, {
        cwd: options.workDir,
        env: providerProcessEnvironment({ ...options, provider: this.name }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (options.signal) {
        options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      }

      let stdout = "";
      let rawStdout = "";
      let stderr = "";
      let providerSessionId: string | undefined;
      let pendingLine = "";
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: structuredOutput ? "protocol" : "stdout",
          payload: chunk,
        });
        rawStdout += chunk;
        if (!structuredOutput) {
          stdout += chunk;
          options.onTextDelta?.(chunk);
          options.onOutput?.(chunk);
          return;
        }
        pendingLine += chunk;
        const lines = pendingLine.split(/\r?\n/u);
        pendingLine = lines.pop() || "";
        for (const line of lines) {
          const event = parseAntigravityStructuredLine(line);
          if (!event) continue;
          providerSessionId ||= event.providerSessionID;
          for (const activity of event.activities) options.onActivity?.(activity);
          if (event.text && !(event.final && stdout.trim())) {
            stdout += event.text;
            options.onTextDelta?.(event.text);
            options.onOutput?.(event.text);
          }
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        void options.onRawEvent?.({
          observedAt: new Date().toISOString(),
          direction: "providerToCoode",
          channel: "stderr",
          payload: chunk,
        });
        stderr += chunk;
        options.onOutput?.(chunk);
      });
      child.on("error", (error) => {
        const failure = stderr || error.message;
        resolve({
          exitCode: 127,
          stdout,
          stderr: failure,
          providerSessionId: providerSessionId
            || resolveProviderSessionIdFromResult(`${rawStdout}\n${failure}`, options.providerSession),
        });
      });
      child.on("close", (code) => {
        if (structuredOutput && pendingLine.trim()) {
          const event = parseAntigravityStructuredLine(pendingLine);
          if (event) {
            providerSessionId ||= event.providerSessionID;
            for (const activity of event.activities) options.onActivity?.(activity);
            if (event.text && !(event.final && stdout.trim())) stdout += event.text;
          }
        }
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          providerSessionId: providerSessionId
            || resolveProviderSessionIdFromResult(`${rawStdout}\n${stderr}`, options.providerSession),
        });
      });
    });
    const capabilityReceipt = declaredHarnessCapabilityReceipt(this.name, runCapabilities);
    capabilityReceipt.agentVersion = version || "unknown";
    options.onCapabilityReceipt?.(capabilityReceipt);
    return { ...result, capabilityReceipt };
  }
}
