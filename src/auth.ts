import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AuthResult {
  sessionToken: string;
  realtimeToken: string;
  terminalWsUrl: string;
}

interface CachedSession {
  sessionToken: string;
  expiresAt: number;
}

const CONFIG_DIR = join(homedir(), ".co-ode");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

function loadCachedSession(): CachedSession | null {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as CachedSession;
    if (data.expiresAt > Date.now()) {
      return data;
    }
  } catch {
    // No cached session
  }
  return null;
}

function saveCachedSession(session: CachedSession) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch {
    // Non-fatal
  }
}

async function deviceAuthFlow(serverUrl: string): Promise<string> {
  // Step 1: Request a device code
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

  // Step 2: Open browser for approval
  console.error(`\n[co-ode] To authenticate, open this URL in your browser:\n`);
  console.error(`  ${verificationUrl}\n`);
  console.error(`[co-ode] Your code: ${code}\n`);

  try {
    const open = (await import("open")).default;
    await open(verificationUrl);
    console.error(`[co-ode] Browser opened. Waiting for approval...`);
  } catch {
    console.error(`[co-ode] Could not open browser automatically. Please open the URL manually.`);
  }

  // Step 3: Poll for token
  const pollInterval = 2000;
  const deadline = expiresAt;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenRes = await fetch(`${serverUrl}/api/auth/cli/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (tokenRes.status === 410) {
      throw new Error("Auth code expired. Please try again.");
    }

    if (tokenRes.status === 202) {
      // Still pending
      continue;
    }

    if (tokenRes.ok) {
      const { token } = (await tokenRes.json()) as { ok: boolean; token: string };
      if (token) {
        // Cache for 23 hours (tokens last 24h)
        saveCachedSession({
          sessionToken: token,
          expiresAt: Date.now() + 23 * 60 * 60 * 1000,
        });
        return token;
      }
    }

    throw new Error(`Unexpected auth response: ${tokenRes.status}`);
  }

  throw new Error("Auth timed out. Please try again.");
}

export async function authenticate({
  serverUrl,
  roomId,
  inviteToken,
}: {
  serverUrl: string;
  roomId: string;
  inviteToken?: string;
}): Promise<AuthResult> {
  // Try cached session first
  let sessionToken: string;
  const cached = loadCachedSession();

  if (cached) {
    console.error(`[co-ode] Using cached session`);
    sessionToken = cached.sessionToken;
  } else {
    // If invite token provided, redeem it first
    if (inviteToken) {
      console.error(`[co-ode] Redeeming invite token...`);
      const inviteRes = await fetch(`${serverUrl}/api/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: inviteToken }),
      });
      if (!inviteRes.ok) {
        console.error(`[co-ode] Warning: invite redemption failed (${inviteRes.status}), continuing with auth...`);
      }
    }

    sessionToken = await deviceAuthFlow(serverUrl);
  }

  // Get realtime session for the room
  console.error(`[co-ode] Getting realtime session for room ${roomId}...`);
  const realtimeRes = await fetch(
    `${serverUrl}/api/rooms/${roomId}/realtime/session`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ ttlSeconds: 3600 }),
    }
  );

  if (!realtimeRes.ok) {
    // Cached session may be invalid, clear it and retry
    if (cached) {
      console.error(`[co-ode] Cached session invalid, re-authenticating...`);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(SESSION_FILE);
      } catch { /* ignore */ }

      sessionToken = await deviceAuthFlow(serverUrl);

      const retryRes = await fetch(
        `${serverUrl}/api/rooms/${roomId}/realtime/session`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ ttlSeconds: 3600 }),
        }
      );

      if (!retryRes.ok) {
        throw new Error(`Failed to get realtime session: ${retryRes.status}`);
      }

      const data = (await retryRes.json()) as {
        terminalWsUrl: string;
        token: string;
      };
      return {
        sessionToken,
        realtimeToken: data.token,
        terminalWsUrl: data.terminalWsUrl,
      };
    }

    throw new Error(`Failed to get realtime session: ${realtimeRes.status}`);
  }

  const realtimeData = (await realtimeRes.json()) as {
    terminalWsUrl: string;
    token: string;
  };

  return {
    sessionToken,
    realtimeToken: realtimeData.token,
    terminalWsUrl: realtimeData.terminalWsUrl,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
