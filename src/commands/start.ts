/**
 * `npx co-od` (no args) — the zero-config magic start.
 *
 * 1. Check login → open browser if needed
 * 2. Detect project dir + available CLIs
 * 3. Find or create room for this project
 * 4. Start local bridge in background
 * 5. Open browser to room
 * 6. Done — user types a task in the browser
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import * as api from "../api-client.js";
import { getAdapter } from "../adapters/index.js";

function log(msg: string) {
  console.error(`  ${msg}`);
}

function detectProvider(): string {
  // Check what's available, prefer established configured harnesses first.
  const checks = [
    { name: "claude", bin: "claude" },
    { name: "codex", bin: "codex" },
    { name: "opencode", bin: "opencode" },
    { name: "hermes", bin: "hermes" },
    { name: "pi", bin: "pi" },
    { name: "openclaw", bin: "openclaw" },
    { name: "zeroclaw", bin: "zeroclaw" },
  ];

  const paths = (process.env.PATH || "").split(":");
  for (const { name, bin } of checks) {
    if (paths.some((dir) => existsSync(join(dir, bin)))) return name;
  }
  return "claude"; // default, will fail with helpful message later
}

async function ensureLoggedIn(): Promise<boolean> {
  const token = api.getSessionToken();
  if (token) return true;

  log("Not logged in. Opening browser...\n");

  // Run login command
  const { run: loginRun } = await import("./login.js");
  await loginRun([]);

  // Check again
  return !!api.getSessionToken();
}

function findExistingConfig(dir: string): { roomId: string; roomName: string } | null {
  const configPath = join(dir, ".co-od.json");
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    if (data.roomId) return { roomId: data.roomId, roomName: data.roomName || basename(dir) };
  } catch { /* ignore */ }
  return null;
}

function startBridgeBackground(): void {
  // Check if bridge is already running
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    // Can't use fetch synchronously, so spawn a quick check
    const check = spawn("sh", ["-c", "curl -sf http://127.0.0.1:4786/health > /dev/null 2>&1"], {
      stdio: "ignore",
    });
    check.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        log("✓ local bridge already running");
        return;
      }
      // Not running — start it
      spawnBridge();
    });
    check.on("error", () => {
      clearTimeout(timeout);
      spawnBridge();
    });
  } catch {
    spawnBridge();
  }
}

function spawnBridge(): void {
  // Find the bridge script — check common locations
  const possiblePaths = [
    join(process.cwd(), "services/local-bridge/src/index.ts"),
    join(process.cwd(), "node_modules/.bin/co-od-bridge"),
    // Monorepo structure
    join(process.cwd(), "../../services/local-bridge/src/index.ts"),
  ];

  // For now, just try to start via the co-ode monorepo if we're in it
  const monorepoRoot = findMonorepoRoot(process.cwd());
  if (monorepoRoot) {
    const bridgePath = join(monorepoRoot, "services/local-bridge/src/index.ts");
    if (existsSync(bridgePath)) {
      const child = spawn("npx", ["ts-node", "--transpile-only", bridgePath], {
        cwd: join(monorepoRoot, "services/local-bridge"),
        stdio: "ignore",
        detached: true,
        env: { ...process.env, LOCAL_BRIDGE_PROJECT_ROOT: process.cwd() },
      });
      child.unref();
      log("✓ local bridge started in background (port 4786)");
      return;
    }
  }

  log("⚠ local bridge not started — run your bridge manually or install the co-od bridge package");
}

function findMonorepoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "services/local-bridge"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function openBrowser(url: string): Promise<void> {
  try {
    const open = (await import("open")).default;
    await open(url);
  } catch {
    log(`Open in browser: ${url}`);
  }
}

async function isBridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:4786/health", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function run(args: string[]): Promise<void> {
  const dir = process.cwd();
  const projectName = basename(dir);
  const existing = findExistingConfig(dir);
  const bridgeUp = await isBridgeRunning();
  const hasToken = !!api.getSessionToken();

  // ── FAST PATH: everything's already set up ──
  // If config exists + bridge running + logged in → just show status, don't open browser
  if (existing && bridgeUp && hasToken && !args.includes("--open")) {
    const url = `${api.getBaseUrl()}/rooms/${existing.roomId}`;
    console.error(`  co-od · ${existing.roomName}\n`);
    console.error(`  room:    ${url}`);
    console.error(`  bridge:  running (port 4786)`);
    console.error(`  project: ${dir}\n`);
    console.error(`  Everything is running. Commands:\n`);
    console.error(`    co-od run ${existing.roomId.slice(0, 12)} "your task"    # single task`);
    console.error(`    co-od daemon ${existing.roomId.slice(0, 12)} --auto-execute  # autonomous`);
    console.error(`    co-od share                                   # invite teammate`);
    console.error(`    co-od --open                                  # open browser\n`);
    return;
  }

  // ── SETUP PATH: first time or something needs fixing ──
  console.error(`
  ┌─────────────────────────────┐
  │         co-od               │
  │   agents + humans,          │
  │   one workspace             │
  └─────────────────────────────┘
`);

  // Step 1: Login
  if (!hasToken) {
    log("[1/5] Checking authentication...");
    const loggedIn = await ensureLoggedIn();
    if (!loggedIn) {
      log("✗ Login required. Run: co-od login");
      process.exit(1);
    }
    log("✓ logged in\n");
  } else {
    log("[1/5] ✓ logged in");
  }

  // Step 2: Detect environment
  log("[2/5] Detecting environment...");
  const provider = detectProvider();
  const adapter = getAdapter(provider);
  const available = await adapter.available();
  if (available) {
    log(`✓ ${adapter.name} CLI available`);
  } else {
    log(`⚠ no agent CLI found — install Claude Code, Codex, or ZeroClaw`);
    log(`  brew install claude    (or)    npm install -g @openai/codex`);
  }
  log(`✓ project: ${dir}\n`);

  // Step 3: Find or create room
  log("[3/5] Setting up room...");
  let roomId: string;
  let roomName: string;

  if (existing) {
    roomId = existing.roomId;
    roomName = existing.roomName;
    log(`✓ found existing room: ${roomName}`);
  } else {
    roomName = projectName;
    try {
      const res = await api.post<{ roomId?: string; room?: { _id: string } }>(
        "/api/rooms",
        { name: roomName }
      );
      roomId = res.roomId || res.room?._id || "";
      if (!roomId) throw new Error("No room ID");
      log(`✓ room created: ${roomName}`);

      // Add default agent
      const agentName = provider === "codex" ? "Codex Builder"
        : provider === "opencode" ? "OpenCode Builder"
        : provider === "hermes" ? "Hermes Agent"
        : provider === "openclaw" ? "OpenClaw Agent"
        : "Claude Builder";
      const executionMode = provider === "codex" ? "local_codex"
        : provider === "opencode" ? "local_opencode"
        : provider === "hermes" ? "local_hermes"
        : provider === "openclaw" || provider === "zeroclaw" ? "local_openclaw"
        : "local_claude_code";
      const agentProvider = provider === "codex" ? "openai"
        : provider === "opencode" ? "opencode"
        : provider === "hermes" ? "hermes"
        : provider === "openclaw" || provider === "zeroclaw" ? "openclaw"
        : "anthropic";
      try {
        await api.post(`/api/rooms/${roomId}/agents`, {
          name: agentName,
          type: "builder",
          executionMode,
          provider: agentProvider,
          permissions: { "fs.read": true, "fs.write": true, "fs.applyPatch": true, "exec.run": true, "net.egress": false, "ports.expose": false, "secrets.read": false },
        });
        log(`✓ agent "${agentName}" added`);
      } catch {
        log(`⚠ could not add agent (add one manually in the UI)`);
      }

      // Save config
      const config = { roomId, roomName, projectDir: dir, provider, server: api.getBaseUrl(), createdAt: new Date().toISOString() };
      try {
        writeFileSync(join(dir, ".co-od.json"), JSON.stringify(config, null, 2) + "\n");
        log(`✓ config saved: .co-od.json`);
      } catch { /* non-fatal */ }

      // Save to global rooms map
      try {
        const globalDir = join(homedir(), ".co-od");
        mkdirSync(globalDir, { recursive: true });
        const mapPath = join(globalDir, "rooms.json");
        let rooms: Record<string, unknown> = {};
        if (existsSync(mapPath)) rooms = JSON.parse(readFileSync(mapPath, "utf-8"));
        rooms[roomId] = { roomId, projectDir: dir, name: roomName };
        writeFileSync(mapPath, JSON.stringify(rooms, null, 2) + "\n");
      } catch { /* non-fatal */ }
    } catch (err) {
      log(`✗ failed to create room: ${err}`);
      process.exit(1);
    }
  }
  console.error("");

  // Step 4: Start bridge (only if not already running)
  if (bridgeUp) {
    log("[4/5] ✓ local bridge already running");
  } else {
    log("[4/5] Starting local bridge...");
    startBridgeBackground();
  }
  console.error("");

  // Step 5: Open browser
  log("[5/5] Opening workspace...\n");
  const url = `${api.getBaseUrl()}/rooms/${roomId}`;
  await openBrowser(url);

  console.error(`  ✓ Ready! Your workspace is open at:`);
  console.error(`    ${url}\n`);
  console.error(`  Type a task in the browser to get started.`);
  console.error(`  Or use the CLI:\n`);
  console.error(`    co-od run ${roomId.slice(0, 12)} "your task here"`);
  console.error(`    co-od daemon ${roomId.slice(0, 12)} --auto-execute`);
  console.error(`    co-od share\n`);
}
