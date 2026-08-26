import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type {
  HarnessNativeSessionState,
  HarnessNativeSessionStateContext,
  HarnessNativeSessionProjection,
} from "./base.js";

const STARTUP_TIMEOUT_MS = 10_000;

const boundedID = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new Error(`OpenCode ${name} is invalid.`);
  }
  return normalized;
};

const fingerprint = (value: unknown): string => createHash("sha256")
  .update(String(value ?? ""))
  .digest("hex")
  .slice(0, 16);

const boundedText = (value: unknown, maximum = 2_000): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
};

const isoDate = (value: unknown): string | undefined => {
  const date = typeof value === "number"
    ? new Date(value > 10_000_000_000 ? value : value * 1_000)
    : typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const availablePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

class OpenCodeServerClient {
  private child?: ChildProcess;
  private baseURL = "";
  private readonly password = randomBytes(24).toString("base64url");

  constructor(private readonly workDir: string) {}

  async start(): Promise<void> {
    const port = await availablePort();
    this.baseURL = `http://127.0.0.1:${port}`;
    const child = spawn(process.env.OPENCODE_BIN || "opencode", [
      "serve",
      "--hostname", "127.0.0.1",
      "--port", String(port),
    ], {
      cwd: this.workDir,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: "coode",
        OPENCODE_SERVER_PASSWORD: this.password,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    child.stderr?.resume();

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`OpenCode server exited before startup (${child.exitCode}).`);
      }
      try {
        const health = await this.request("GET", "/global/health");
        if ((health as { healthy?: boolean })?.healthy === true) return;
      } catch {
        // The process is still binding the loopback port.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.dispose();
    throw new Error("OpenCode server did not become ready before the safety deadline.");
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseURL);
    url.searchParams.set("directory", this.workDir);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`coode:${this.password}`).toString("base64")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new Error(`OpenCode server ${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  dispose(): void {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}

async function withOpenCodeServer<T>(
  workDir: string,
  operation: (client: OpenCodeServerClient) => Promise<T>,
): Promise<T> {
  const client = new OpenCodeServerClient(workDir);
  await client.start();
  try {
    return await operation(client);
  } finally {
    client.dispose();
  }
}

export const openCodeNativeSessionState: HarnessNativeSessionState = {
  async project(context): Promise<HarnessNativeSessionProjection> {
    const sessionID = encodeURIComponent(boundedID(context.providerSessionID, "session id"));
    return withOpenCodeServer(context.workDir, async (client) => {
      const [rawChildren, rawTodos] = await Promise.all([
        client.request("GET", `/session/${sessionID}/children`),
        client.request("GET", `/session/${sessionID}/todo`),
      ]);
      const children = Array.isArray(rawChildren) ? rawChildren : [];
      const todos = Array.isArray(rawTodos) ? rawTodos : [];
      return {
        childSessions: children.slice(0, 100).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const child = value as Record<string, unknown>;
          const rawID = child.id ?? child.sessionID ?? child.sessionId;
          if (typeof rawID !== "string" || !rawID.trim()) return [];
          const time = child.time && typeof child.time === "object"
            ? child.time as Record<string, unknown>
            : {};
          return [{
            fingerprint: fingerprint(rawID),
            ...(boundedText(child.title ?? child.name, 512) ? {
              title: boundedText(child.title ?? child.name, 512),
            } : {}),
            ...(boundedText(child.status, 128) ? { status: boundedText(child.status, 128) } : {}),
            ...(isoDate(time.created ?? child.createdAt) ? {
              createdAt: isoDate(time.created ?? child.createdAt),
            } : {}),
            ...(isoDate(time.updated ?? child.updatedAt) ? {
              updatedAt: isoDate(time.updated ?? child.updatedAt),
            } : {}),
          }];
        }),
        todos: todos.slice(0, 200).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const todo = value as Record<string, unknown>;
          const content = boundedText(todo.content ?? todo.text ?? todo.title, 2_000);
          if (!content) return [];
          return [{
            ...(todo.id !== undefined ? { id: fingerprint(todo.id) } : {}),
            content,
            ...(boundedText(todo.status, 128) ? { status: boundedText(todo.status, 128) } : {}),
            ...(boundedText(todo.priority, 128) ? { priority: boundedText(todo.priority, 128) } : {}),
          }];
        }),
      };
    });
  },

  async diff(context: HarnessNativeSessionStateContext, messageID?: string): Promise<unknown> {
    const sessionID = encodeURIComponent(boundedID(context.providerSessionID, "session id"));
    const suffix = messageID
      ? `&messageID=${encodeURIComponent(boundedID(messageID, "message id"))}`
      : "";
    return withOpenCodeServer(context.workDir, (client) =>
      client.request("GET", `/session/${sessionID}/diff?${suffix.slice(1)}`)
    );
  },

  async revert(context, messageID, partID): Promise<boolean> {
    const sessionID = encodeURIComponent(boundedID(context.providerSessionID, "session id"));
    const result = await withOpenCodeServer(context.workDir, (client) =>
      client.request("POST", `/session/${sessionID}/revert`, {
        messageID: boundedID(messageID, "message id"),
        ...(partID ? { partID: boundedID(partID, "part id") } : {}),
      })
    );
    return result === true;
  },

  async unrevert(context): Promise<boolean> {
    const sessionID = encodeURIComponent(boundedID(context.providerSessionID, "session id"));
    const result = await withOpenCodeServer(context.workDir, (client) =>
      client.request("POST", `/session/${sessionID}/unrevert`)
    );
    return result === true;
  },
};
