import * as api from "../api-client.js";
import {
  buildTuiLiveQaReport,
  buildTuiQaReport,
  formatTuiLiveQaReport,
  formatTuiQaReport,
} from "../tui-qa.js";

interface TuiQaArgs {
  json: boolean;
  live: boolean;
  roomId?: string;
  serverUrl?: string;
  dir: string;
  includeTerminal: boolean;
  allowMutations: boolean;
  mutationAgentId?: string;
  bridgeUrl?: string;
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function parseArgs(args: string[]): TuiQaArgs {
  return {
    json: args.includes("--json"),
    live: args.includes("--live"),
    roomId: readFlagValue(args, "--room"),
    serverUrl: readFlagValue(args, "--server"),
    dir: readFlagValue(args, "--dir") || process.cwd(),
    includeTerminal: !args.includes("--skip-terminal"),
    allowMutations: args.includes("--mutate"),
    mutationAgentId: readFlagValue(args, "--agent"),
    bridgeUrl: readFlagValue(args, "--bridge-url") || readFlagValue(args, "--bridge"),
  };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.serverUrl) {
    process.env.CO_ODE_SERVER = parsed.serverUrl;
  }
  if (parsed.live) {
    const report = await buildTuiLiveQaReport({
      dir: parsed.dir,
      roomId: parsed.roomId,
      serverUrl: parsed.serverUrl || api.getBaseUrl(),
      includeTerminal: parsed.includeTerminal,
      allowMutations: parsed.allowMutations,
      mutationAgentId: parsed.mutationAgentId,
      bridgeUrl: parsed.bridgeUrl,
      getSession: api.getSession,
      apiGet: api.get,
      apiPost: api.post,
      apiDelete: api.del,
    });
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTuiLiveQaReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const report = buildTuiQaReport();
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTuiQaReport(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}
