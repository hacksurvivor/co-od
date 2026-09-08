import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { artifactRuntimeRoot, readArtifactRuntime } from "./artifact-runtime.js";
import { getCodexAppServer, disposeCodexAppServer } from "./codex-app-server.js";

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export interface ArtifactHostRequest {
  bindingID: string;
  artifactID: string;
  contentSHA256: string;
  method: "connect" | "tools/call" | "resources/read";
  params?: Record<string, unknown>;
  operationID?: string;
}

export { disposeCodexAppServer as disposeArtifactRuntime };

export interface ArtifactRPCClient {
  managedIntegrationConfig?: Record<string, unknown>;
  ensureStarted(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Names and session identity come exclusively from the producing Mac's private
 * binding. The embedded app can supply arguments, never a server or thread. */
export async function performCodexArtifactRequest(
  request: ArtifactHostRequest,
  client?: ArtifactRPCClient,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const binding = await readArtifactRuntime(request.bindingID, request.artifactID, request.contentSHA256, environment);
  const server = client ?? getCodexAppServer(environment);
  try {
    await server.ensureStarted();
    const history = object(await server.request("thread/read", { threadId: binding.threadId, includeTurns: true }));
    const item = (history.thread?.turns || []).flatMap((turn: any) => turn.items || [])
      .find((candidate: any) => candidate.id === binding.originCallId);
    if (!item || item.type !== "mcpToolCall" || item.server !== binding.server || item.tool !== binding.tool) {
      throw new Error("The producing tool call is no longer available in this provider session.");
    }
    if ((history.thread?.turns || []).some((turn: any) => turn.status === "inProgress")) {
      throw new Error("The agent is still working. Try this action when the current turn finishes.");
    }
    await server.request("thread/resume", { threadId: binding.threadId,
      ...(server.managedIntegrationConfig ? { config: server.managedIntegrationConfig } : {}),
    });
    const readParams = {
      threadId: binding.threadId, server: binding.server, uri: binding.uri,
      originCallId: binding.originCallId,
      ...(binding.connectorId ? { connectorId: binding.connectorId } : {}),
    };
    const resource = object(await server.request("mcpServer/resource/read", readParams));
    const matchingResource = (resource.contents || []).find((entry: any) => {
      const bytes = typeof entry.text === "string" ? Buffer.from(entry.text)
        : typeof entry.blob === "string" ? Buffer.from(entry.blob, "base64") : Buffer.alloc(0);
      return entry.uri === binding.uri && createHash("sha256").update(bytes).digest("hex") === binding.contentSHA256;
    });
    if (!matchingResource) throw new Error("The plugin changed this preview. Ask the agent to open its latest revision.");
    const tools: Record<string, any> = {};
    let cursor: string | undefined;
    for (let page = 0; page < 16; page++) {
      const inventory = object(await server.request("mcpServerStatus/list", {
        threadId: binding.threadId, limit: 100, ...(cursor ? { cursor } : {}),
      }));
      const ownServer = (inventory.data || []).find((entry: any) => entry.name === binding.server);
      if (ownServer) { Object.assign(tools, ownServer.tools || {}); break; }
      cursor = inventory.nextCursor;
      if (!cursor) break;
    }
    const allowedTools = Object.entries(tools).filter(([, tool]) => {
      const meta = object(tool._meta);
      const ui = object(meta.ui);
      if (Array.isArray(ui.visibility) && !ui.visibility.includes("app")) return false;
      const uri = ui.resourceUri ?? meta["openai/outputTemplate"];
      return uri === binding.uri || (ui.visibility?.includes("app") && !uri);
    }).map(([key, tool]) => ({ key, name: String(tool.name || key) }));
    if (request.method === "connect") return {
      tools: allowedTools.map((tool) => tool.name), resources: [binding.uri],
    };
    if (request.method === "resources/read") {
      if (request.params?.uri !== binding.uri) throw new Error("This resource does not belong to the open artifact.");
      return resource;
    }
    if (request.method !== "tools/call") throw new Error("Unsupported artifact method.");
    const selected = allowedTools.find((tool) => tool.name === request.params?.name || tool.key === request.params?.name);
    if (!selected) throw new Error("This tool is not available to the open artifact.");
    if (!/^[a-f0-9-]{36}$/i.test(request.operationID || "")) throw new Error("The artifact action needs a durable operation ID.");
    const path = join(artifactRuntimeRoot(environment)!, `${binding.id}-${request.operationID}.action.json`);
    const digest = createHash("sha256").update(JSON.stringify({ name: selected.name, arguments: request.params?.arguments })).digest("hex");
    let handle;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let record;
      try { record = JSON.parse(await previous.readFile("utf8")); } finally { await previous.close(); }
      if (record.digest !== digest) throw new Error("This operation ID was already used for another action.");
      if (record.status === "completed") return record.result;
      throw new Error("This action's outcome is uncertain. Check the plugin before submitting a new action.");
    }
    try {
      await handle.writeFile(JSON.stringify({ status: "started", digest }));
      await handle.sync();
    } finally { await handle.close(); }
    const result = await server.request("mcpServer/tool/call", {
      threadId: binding.threadId, server: binding.server, tool: selected.name,
      arguments: object(request.params?.arguments),
      _meta: { "ui/resourceUri": binding.uri },
    });
    const encoded = JSON.stringify({ status: "completed", digest, result });
    if (Buffer.byteLength(encoded) > 8 * 1_024 * 1_024) throw new Error("The plugin response is too large to display.");
    const temporary = await open(`${path}.tmp`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await temporary.writeFile(encoded); await temporary.sync(); } finally { await temporary.close(); }
    await rename(`${path}.tmp`, path);
    return result;
  } finally { if (!client) disposeCodexAppServer(); }
}
