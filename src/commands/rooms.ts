import * as api from "../api-client.js";

interface Room {
  _id: string;
  name: string;
  status?: string;
  agents?: Array<{ name: string }>;
  members?: Array<{ name: string }>;
}

interface RoomsResponse {
  rooms: Room[];
}

interface ParsedArgs {
  json: boolean;
  server?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
      parsed.json = true;
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    }
  }
  return parsed;
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

function printTable(rooms: Room[]) {
  if (rooms.length === 0) {
    console.log("No rooms found.");
    return;
  }

  const header = [
    padRight("ID", 26),
    padRight("NAME", 30),
    padRight("STATUS", 12),
    padRight("AGENTS", 8),
    padRight("MEMBERS", 8),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const room of rooms) {
    const row = [
      padRight(room._id || "", 26),
      padRight(room.name || "(unnamed)", 30),
      padRight(room.status || "idle", 12),
      padRight(String(room.agents?.length ?? 0), 8),
      padRight(String(room.members?.length ?? 0), 8),
    ].join("  ");
    console.log(row);
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  const data = await api.get<RoomsResponse>("/api/rooms");
  const rooms = data.rooms || [];

  if (parsed.json) {
    console.log(JSON.stringify(rooms, null, 2));
  } else {
    printTable(rooms);
  }
}
