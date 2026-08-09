import { authenticate } from "../auth.js";
import { connectToRoom } from "../connect.js";

interface ParsedArgs {
  roomId?: string;
  server?: string;
  inviteToken?: string;
  dir: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dir: process.cwd() };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (args[i] === "--invite-token" && args[i + 1]) {
      parsed.inviteToken = args[++i];
    } else if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (!args[i].startsWith("--")) {
      parsed.roomId = args[i];
    }
  }

  return parsed;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (!parsed.roomId) {
    console.error("Usage: co-od join <room-id> [--invite-token <tok>] [--dir <path>]");
    process.exit(1);
  }

  const serverUrl =
    parsed.server ||
    process.env.CO_ODE_SERVER ||
    "https://co-od.dev";

  console.error(`[co-od] Joining room ${parsed.roomId}...`);
  console.error(`[co-od] Server: ${serverUrl}`);
  console.error(`[co-od] Working directory: ${parsed.dir}`);

  // Authenticate
  const { sessionToken, realtimeToken, terminalWsUrl } = await authenticate({
    serverUrl,
    roomId: parsed.roomId,
    inviteToken: parsed.inviteToken,
  });

  console.error(`[co-od] Authenticated successfully`);

  // Connect to room (blocks until disconnect)
  await connectToRoom({
    terminalWsUrl,
    realtimeToken,
    roomId: parsed.roomId,
    workDir: parsed.dir,
    serverUrl,
    sessionToken,
  });
}
