import * as api from "../api-client.js";
import { getAdapter, PROVIDER_LIST } from "../adapters/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

interface ParsedArgs {
  dir: string;
  name?: string;
  provider: string;
  server?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    dir: process.cwd(),
    provider: "claude",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) {
      parsed.dir = args[++i];
    } else if (args[i] === "--name" && args[i + 1]) {
      parsed.name = args[++i];
    } else if (args[i] === "--provider" && args[i + 1]) {
      parsed.provider = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    } else if (!args[i].startsWith("--") && !parsed.name) {
      parsed.name = args[i];
    }
  }

  return parsed;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error(`Usage: co-od init [name] [--dir <path>] [--provider ${PROVIDER_LIST}]

Sets up a new co-ode project:
  1. Creates a room on co-od.dev
  2. Links it to your local project directory
  3. Adds a default agent
  4. Generates a .co-od config file
  5. Ready to go — start giving tasks

Examples:
  co-od init                          # Uses current dir name as room name
  co-od init "my-saas-app"            # Custom room name
  co-od init --provider codex         # Use Codex as default agent
  co-od init --dir ~/projects/app     # Different directory
`);
    process.exit(0);
  }

  const parsed = parseArgs(args);

  if (parsed.server) {
    process.env.CO_ODE_SERVER = parsed.server;
  }

  // Ensure logged in
  const token = api.getSessionToken();
  if (!token) {
    console.error(`[${timestamp()}] Not logged in. Run: co-od login`);
    process.exit(1);
  }

  const projectDir = parsed.dir;
  const roomName = parsed.name || basename(projectDir);

  console.error(`\n  co-od init\n`);
  console.error(`  project:  ${projectDir}`);
  console.error(`  room:     ${roomName}`);
  console.error(`  provider: ${parsed.provider}\n`);

  // Step 1: Check provider is available
  console.error(`  [1/5] Checking ${parsed.provider} CLI...`);
  const adapter = getAdapter(parsed.provider);
  const available = await adapter.available();
  if (!available) {
    console.error(`        ✗ ${adapter.name} not found on PATH`);
    console.error(`        Install it first, then run co-od init again.`);
    process.exit(1);
  }
  console.error(`        ✓ ${adapter.name} available`);

  // Step 2: Create room
  console.error(`  [2/5] Creating room "${roomName}"...`);
  let roomId: string;
  try {
    const res = await api.post<{ roomId?: string; room?: { _id: string } }>(
      "/api/rooms",
      { name: roomName }
    );
    roomId = res.roomId || res.room?._id || "";
    if (!roomId) throw new Error("No room ID returned");
    console.error(`        ✓ Room created: ${roomId.slice(0, 12)}...`);
  } catch (err) {
    console.error(`        ✗ Failed to create room: ${err}`);
    process.exit(1);
  }

  // Step 3: Add default agent
  console.error(`  [3/5] Adding default agent...`);
  let agentId: string;
  try {
    const agentName = parsed.provider === "codex" ? "Codex Builder"
      : parsed.provider === "opencode" ? "OpenCode Builder"
      : parsed.provider === "hermes" ? "Hermes Agent"
      : parsed.provider === "openclaw" ? "OpenClaw Agent"
      : "Claude Builder";
    const executionMode = parsed.provider === "codex" ? "local_codex"
      : parsed.provider === "opencode" ? "local_opencode"
      : parsed.provider === "hermes" ? "local_hermes"
      : parsed.provider === "openclaw" || parsed.provider === "zeroclaw" ? "local_openclaw"
      : "local_claude_code";
    const agentProvider = parsed.provider === "codex" ? "openai"
      : parsed.provider === "opencode" ? "opencode"
      : parsed.provider === "hermes" ? "hermes"
      : parsed.provider === "openclaw" || parsed.provider === "zeroclaw" ? "openclaw"
      : "anthropic";
    const res = await api.post<{ agentId?: string }>(
      `/api/rooms/${roomId}/agents`,
      {
        name: agentName,
        type: "builder",
        executionMode,
        provider: agentProvider,
        permissions: {
          "fs.read": true,
          "fs.write": true,
          "fs.applyPatch": true,
          "exec.run": true,
          "net.egress": false,
          "ports.expose": false,
          "secrets.read": false,
        },
      }
    );
    agentId = res.agentId || "";
    console.error(`        ✓ Agent "${agentName}" added`);
  } catch (err) {
    console.error(`        ✗ Failed to add agent: ${err}`);
    agentId = "";
  }

  // Step 4: Save config
  console.error(`  [4/5] Saving config...`);
  const config = {
    roomId,
    roomName,
    projectDir,
    provider: parsed.provider,
    agentId,
    server: api.getBaseUrl(),
    createdAt: new Date().toISOString(),
  };

  // Save to project dir
  const configPath = join(projectDir, ".co-od.json");
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    console.error(`        ✓ ${configPath}`);
  } catch {
    console.error(`        ✗ Could not write ${configPath}`);
  }

  // Also save room mapping to global config
  const globalConfigDir = join(homedir(), ".co-od");
  const roomsMapPath = join(globalConfigDir, "rooms.json");
  try {
    mkdirSync(globalConfigDir, { recursive: true });
    let rooms: Record<string, { roomId: string; projectDir: string; name: string }> = {};
    if (existsSync(roomsMapPath)) {
      rooms = JSON.parse(require("node:fs").readFileSync(roomsMapPath, "utf-8"));
    }
    rooms[roomId] = { roomId, projectDir, name: roomName };
    writeFileSync(roomsMapPath, JSON.stringify(rooms, null, 2) + "\n", "utf-8");
  } catch {
    // Non-fatal
  }

  // Step 5: Done
  console.error(`  [5/5] Ready!\n`);
  console.error(`  Your room is live. Next steps:\n`);
  console.error(`    co-od run ${roomId.slice(0, 12)} "describe your task"   # run a single task`);
  console.error(`    co-od daemon ${roomId.slice(0, 12)} --auto-execute       # autonomous mode`);
  console.error(`    co-od share                                    # invite teammates\n`);
  console.error(`  Or open in browser:`);
  console.error(`    ${api.getBaseUrl()}/rooms/${roomId}\n`);

  // Output JSON for scripting
  console.log(JSON.stringify(config, null, 2));
}
