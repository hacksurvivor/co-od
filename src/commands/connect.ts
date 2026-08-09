import * as api from "../api-client.js";

interface ParsedArgs {
  code?: string;
  server?: string;
}

interface RelayResolveResponse {
  ok: boolean;
  online: boolean;
  room_id?: string | null;
  message?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (!args[i].startsWith("--")) {
      parsed.code = args[i];
    }
  }

  return parsed;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (!parsed.code) {
    console.error("Usage: co-od connect <relay-code>");
    process.exit(1);
  }

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  console.error(`[co-od] Connecting to relay ${parsed.code}...`);

  const code = parsed.code.toUpperCase();
  const res = await api.get<RelayResolveResponse>(`/api/relay/${code}/resolve`);

  if (!res.ok || !res.online) {
    console.error(`[co-od] Failed to connect to relay. ${res.message || "Code may be invalid, expired, or offline."}`);
    process.exit(1);
  }

  console.log(`Connected to relay ${code}`);
  console.log("Set this code in the room UI to dispatch local runs through the shared machine.");
  if (res.room_id) {
    console.log(`\nRoom ID: ${res.room_id}`);
  }
}
