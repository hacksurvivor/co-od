// First-run setup gate. Before the chat opens, make sure the user is signed in
// and this folder is in a room — otherwise the chat would launch with nothing to
// dispatch to ("No room configured"). Runs in the Node process before the Bun
// chat renderer is spawned, so readline owns stdin cleanly.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../api-client.js";
import { readProjectConfig, loadRoomsData, type RoomRecord } from "../tui-dashboard.js";
import { shortId } from "../tui-model.js";
import { brandHeader, ember, ink, muted } from "../brand.js";
import {
  checkAllProviderAuth,
  hasAnyConnectedProvider,
  loginProvider,
  markProviderAuthSetupSkipped,
  providerAuthSetupWasSkipped,
  type ProviderAuthCheck,
} from "../provider-auth.js";

export interface SetupGateResult {
  ready: boolean;
  reason?: string;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function writeRoomConfig(dir: string, room: RoomRecord): void {
  const config = {
    roomId: room._id,
    roomName: room.name || room._id,
    projectDir: dir,
    server: api.getBaseUrl(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, ".co-od.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function providerLine(check: ProviderAuthCheck, index: number): string {
  const status = check.status === "connected" ? "connected"
    : check.status === "cli_missing" ? "install CLI first"
    : "login";
  return `    ${muted(String(index + 1))}  ${ink(check.label)}   ${muted(`${check.provider} · ${status}`)}`;
}

async function ensureProviderAuth(): Promise<void> {
  if (hasAnyConnectedProvider()) return;
  if (providerAuthSetupWasSkipped()) return;

  const checks = checkAllProviderAuth();
  console.error(`\n${brandHeader("connect your coding subscriptions")}`);
  console.error(`  ${muted("Use Codex, Claude Code, or Gemini through their official local login.")}`);
  console.error(`  ${muted("co-od remembers the connection; provider tokens stay in the provider CLI store.")}\n`);
  checks.forEach((check, index) => console.error(providerLine(check, index)));
  console.error(`    ${muted("s")}  ${ink("Skip for now")}\n`);

  const choice = (await ask(`  ${ember("›")} `)).toLowerCase();
  if (!choice || choice === "s" || choice === "skip") {
    markProviderAuthSetupSkipped();
    return;
  }

  const selected = checks[Number(choice) - 1]
    || checks.find((check) => check.provider === choice);
  if (!selected) {
    markProviderAuthSetupSkipped();
    return;
  }
  if (selected.status === "cli_missing") {
    console.error(`\n  ${muted(`${selected.label} is not installed. Install ${selected.command}, then run co-od auth login ${selected.provider}.`)}\n`);
    markProviderAuthSetupSkipped();
    return;
  }

  try {
    await loginProvider(selected.provider);
  } catch (error) {
    console.error(`\n  ${muted(`Provider login did not finish: ${error instanceof Error ? error.message : String(error)}`)}`);
    console.error(`  ${muted(`You can retry later with: co-od auth login ${selected.provider}`)}\n`);
  }
}

export async function runSetupGate(dir: string): Promise<SetupGateResult> {
  // 1. Sign in if needed.
  if (!api.getSessionToken()) {
    console.error(`\n${brandHeader("multiplayer coding rooms · humans + agents")}\n`);
    console.error(`  ${muted("Let's get you signed in.")}\n`);
    try {
      const { run: login } = await import("./login.js");
      await login([]);
    } catch (error) {
      return { ready: false, reason: `login failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!api.getSessionToken()) {
      return { ready: false, reason: "still not signed in" };
    }
  }

  await ensureProviderAuth();

  // 2. Already in a room here? Nothing to do.
  if (readProjectConfig(dir)?.roomId) {
    return { ready: true };
  }

  // 3. Pick an existing room or create a new one.
  const session = api.getSession();
  const who = session?.user ? ` as ${session.user}` : "";
  console.error(`\n${brandHeader("multiplayer coding rooms · humans + agents")}`);
  console.error(`  ${muted(`signed in${who}`)}\n`);
  console.error(`  ${ink("This folder isn't in a room yet.")}`);
  console.error(`  ${muted(dir)}\n`);

  const { rooms, error } = await loadRoomsData();
  if (error) {
    console.error(`  ${muted(`(couldn't list rooms: ${error})`)}`);
  }
  rooms.forEach((room, index) => {
    const count = room.agents?.length ?? 0;
    const agents = count > 0 ? `${count} agent${count === 1 ? "" : "s"}` : "no agents";
    console.error(`    ${muted(String(index + 1))}  ${ink(room.name || room._id)}   ${muted(`${shortId(room._id)} · ${agents}`)}`);
  });
  console.error(`    ${muted("n")}  ${ink("New room for this folder")}\n`);

  const choice = (await ask(`  ${ember("›")} `)).toLowerCase();

  if (choice === "n" || (rooms.length === 0 && choice === "")) {
    try {
      const { run: init } = await import("./init.js");
      await init(["--dir", dir]);
    } catch (error) {
      return { ready: false, reason: `room creation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    return readProjectConfig(dir)?.roomId
      ? { ready: true }
      : { ready: false, reason: "room was not written" };
  }

  const picked = rooms[Number(choice) - 1];
  if (!picked) {
    return { ready: false, reason: "no room selected" };
  }
  writeRoomConfig(dir, picked);
  console.error(`\n  ${muted(`Joined ${picked.name || shortId(picked._id)}. Opening`)} ${ember("●")}\n`);
  return { ready: true };
}
