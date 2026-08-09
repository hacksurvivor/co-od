import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loginApprovalText,
  loginManualApprovalText,
  loginStartText,
  loginSuccessText,
  tokenLoginSuccessText,
} from "../login-view.js";

const CONFIG_DIR = join(homedir(), ".co-ode");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

interface ParsedArgs {
  token?: string;
  server?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && args[i + 1]) {
      parsed.token = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      parsed.server = args[++i];
    }
  }
  return parsed;
}

function saveSession(sessionToken: string, user?: string) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    SESSION_FILE,
    JSON.stringify(
      {
        sessionToken,
        expiresAt: Date.now() + 23 * 60 * 60 * 1000,
        user: user || "api-token-user",
      },
      null,
      2
    )
  );
}

async function deviceAuthFlow(serverUrl: string): Promise<{ token: string; user?: string }> {
  // Request a device code
  const authorizeRes = await fetch(`${serverUrl}/api/auth/cli/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!authorizeRes.ok) {
    throw new Error(`Failed to start auth flow: ${authorizeRes.status}`);
  }

  const { code, verificationUrl, expiresAt } = (await authorizeRes.json()) as {
    code: string;
    verificationUrl: string;
    expiresAt: number;
  };

  try {
    const open = (await import("open")).default;
    await open(verificationUrl);
    console.error(loginApprovalText(verificationUrl, code));
  } catch {
    console.error(loginManualApprovalText(verificationUrl, code));
  }

  // Poll for token
  const pollInterval = 2000;
  const deadline = expiresAt;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const tokenRes = await fetch(`${serverUrl}/api/auth/cli/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (tokenRes.status === 410) {
      throw new Error("Auth code expired. Please try again.");
    }

    if (tokenRes.status === 202) {
      continue;
    }

    if (tokenRes.ok) {
      const body = (await tokenRes.json()) as { ok: boolean; token: string; user?: string };
      if (body.token) {
        return { token: body.token, user: body.user };
      }
    }

    throw new Error(`Unexpected auth response: ${tokenRes.status}`);
  }

  throw new Error("Auth timed out. Please try again.");
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const serverUrl =
    parsed.server ||
    process.env.CO_ODE_SERVER ||
    "https://co-od.dev";

  // --token flag: headless/CI mode
  if (parsed.token) {
    saveSession(parsed.token);
    console.log(tokenLoginSuccessText());
    return;
  }

  // Interactive browser auth
  console.error(loginStartText(serverUrl));

  const { token, user } = await deviceAuthFlow(serverUrl);
  saveSession(token, user);

  const displayName = user || "authenticated user";
  console.log(loginSuccessText(displayName));
}
