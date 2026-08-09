import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".co-ode");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

export interface CachedSession {
  sessionToken: string;
  expiresAt: number;
  user?: string;
}

function getBaseUrl(): string {
  return (
    process.env.CO_ODE_SERVER || "https://co-od.dev"
  );
}

function getSessionToken(): string | null {
  // Test/automation override — lets a TUI instance run against a local stack
  // without touching the real ~/.co-od/session.json.
  if (process.env.CO_OD_SESSION_TOKEN) return process.env.CO_OD_SESSION_TOKEN;
  try {
    const data = JSON.parse(
      readFileSync(SESSION_FILE, "utf-8")
    ) as CachedSession;
    if (data.expiresAt > Date.now()) {
      return data.sessionToken;
    }
  } catch {
    // No session
  }
  return null;
}

export function getSession(): CachedSession | null {
  if (process.env.CO_OD_SESSION_TOKEN) {
    return {
      sessionToken: process.env.CO_OD_SESSION_TOKEN,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      user: process.env.CO_OD_SESSION_USER || "local",
    };
  }
  try {
    const data = JSON.parse(
      readFileSync(SESSION_FILE, "utf-8")
    ) as CachedSession;
    if (data.expiresAt > Date.now()) {
      return data;
    }
  } catch {
    // No session
  }
  return null;
}

function requireToken(): string {
  const token = getSessionToken();
  if (!token) {
    console.error(
      "[co-od] Not logged in. Run `co-od login` first."
    );
    process.exit(1);
  }
  return token;
}

function headers(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

export async function get<T = unknown>(path: string): Promise<T> {
  const token = requireToken();
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) {
    throw new Error(await formatHttpError("GET", path, res));
  }
  return res.json() as Promise<T>;
}

export async function post<T = unknown>(
  path: string,
  body?: unknown
): Promise<T> {
  const token = requireToken();
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(await formatHttpError("POST", path, res));
  }
  return res.json() as Promise<T>;
}

export async function del<T = unknown>(path: string): Promise<T> {
  const token = requireToken();
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: headers(token),
  });
  if (!res.ok) {
    throw new Error(await formatHttpError("DELETE", path, res));
  }
  return res.json() as Promise<T>;
}

async function formatHttpError(method: string, path: string, res: Response): Promise<string> {
  const detail = await responseErrorDetail(res);
  return `${method} ${path} failed: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`;
}

async function responseErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text.trim()) return "";
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: string };
      message?: string;
      details?: string;
    };
    return [
      body.error?.message || body.message,
      body.error?.details || body.details,
    ].filter(Boolean).join(": ");
  } catch {
    return text.trim().slice(0, 500);
  }
}

export async function poll<T = unknown>(
  path: string,
  intervalMs: number,
  condition: (data: T) => boolean,
  signal?: AbortSignal
): Promise<T> {
  while (true) {
    if (signal?.aborted) {
      throw new Error("Polling aborted");
    }
    const data = await get<T>(path);
    if (condition(data)) {
      return data;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Polling aborted"));
          },
          { once: true }
        );
      }
    });
  }
}

export { getBaseUrl, getSessionToken, requireToken };
