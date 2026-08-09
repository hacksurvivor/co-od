import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSession, getBaseUrl } from "../api-client.js";

const CONFIG_DIR = join(homedir(), ".co-ode");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

interface ParsedArgs {
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  return { json: args.includes("--json") };
}

interface StatusInfo {
  loggedIn: boolean;
  user: string | null;
  sessionFile: string;
  sessionExpires: string | null;
  server: string;
}

function getStatusInfo(): StatusInfo {
  const session = getSession();
  const server = getBaseUrl();

  return {
    loggedIn: session !== null,
    user: session?.user || null,
    sessionFile: SESSION_FILE,
    sessionExpires: session
      ? new Date(session.expiresAt).toLocaleString()
      : null,
    server,
  };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const info = getStatusInfo();

  if (parsed.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`co-od status`);
  console.log(`${"=".repeat(40)}`);
  console.log(`Logged in:       ${info.loggedIn ? "yes" : "no"}`);

  if (info.loggedIn) {
    console.log(`User:            ${info.user || "(unknown)"}`);
    console.log(`Session expires: ${info.sessionExpires}`);
  }

  console.log(`Session file:    ${info.sessionFile}`);
  console.log(`Server:          ${info.server}`);
}
