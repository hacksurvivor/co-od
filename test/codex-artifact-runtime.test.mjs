import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerArtifactRuntime, readArtifactRuntime } from "../dist/adapters/artifact-runtime.js";
import { performCodexArtifactRequest } from "../dist/adapters/codex-artifact-runtime.js";
import { harnessArtifactFromResource } from "../dist/adapters/harness-artifacts.js";

const html = "<html><body>Local chart</body></html>";
const uri = "ui://fixture/chart.html";
const artifact = harnessArtifactFromResource({ uri, mimeType: "text/html;profile=mcp-app", text: html }, { provider: "codex", server: "fixture", tool: "chart" });
const origin = { threadId: "thread-own", originCallId: "call-own", server: "fixture", tool: "chart", uri };
const contentSHA256 = createHash("sha256").update(html).digest("hex");
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "cood-artifact-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { COODE_MANAGED_INTEGRATIONS_PATH: join(root, "library.json") };
  const bindingID = await registerArtifactRuntime(artifact, origin, environment);
  const request = { bindingID, artifactID: artifact.id, contentSHA256, method: "connect" };
  const calls = [];
  let toolCount = 0;
  const client = {
    ensureStarted: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      assert.equal(params.threadId, origin.threadId);
      if (method === "thread/read") return { thread: { turns: [{ status: "completed", items: [{ type: "mcpToolCall", id: origin.originCallId, server: origin.server, tool: origin.tool }] }] } };
      if (method === "thread/resume") return { thread: { id: origin.threadId } };
      if (method === "mcpServer/resource/read") return { contents: [{ uri, text: html }] };
      if (method === "mcpServerStatus/list") return { data: [{ name: "fixture", tools: {
        refresh: { name: "refresh", _meta: { ui: { resourceUri: uri, visibility: ["app"] } } },
        hidden: { name: "hidden", _meta: { ui: { resourceUri: uri, visibility: ["model"] } } },
        foreign: { name: "foreign", _meta: { ui: { resourceUri: "ui://other/app" } } },
      } }] };
      if (method === "mcpServer/tool/call") { toolCount++; return { structuredContent: { count: toolCount }, content: [] }; }
      throw new Error(`Unexpected ${method}`);
    },
  };
  return { root, environment, request, client, calls, toolCount: () => toolCount };
}

test("artifact revisions include all HTML bytes, result context and resource metadata", () => {
  const resource = { uri, mimeType: "text/html", text: "x".repeat(5000) + "A" };
  const options = { provider: "codex", context: '{"value":1}' };
  const first = harnessArtifactFromResource(resource, options);
  assert.notEqual(first.id, harnessArtifactFromResource({ ...resource, text: "x".repeat(5000) + "B" }, options).id);
  assert.notEqual(first.id, harnessArtifactFromResource(resource, { ...options, context: '{"value":2}' }).id);
  const withMeta = harnessArtifactFromResource({ ...resource, _meta: { ui: { csp: { resourceDomains: ["https://cdn.example.com"] } } } }, options);
  assert.equal(JSON.parse(withMeta.context).resourceMeta.ui.csp.resourceDomains[0], "https://cdn.example.com");
});

test("private origin binding exposes only app-visible tools on the producing server", async (t) => {
  const f = await setup(t);
  assert.deepEqual(await performCodexArtifactRequest(f.request, f.client, f.environment), { tools: ["refresh"], resources: [uri] });
  assert.equal(f.toolCount(), 0);
  for (const name of ["hidden", "foreign", "shell"]) {
    await assert.rejects(performCodexArtifactRequest({ ...f.request, method: "tools/call", params: { name }, operationID: randomUUID() }, f.client, f.environment), /not available/);
  }
  await assert.rejects(performCodexArtifactRequest({ ...f.request, method: "resources/read", params: { uri: "file:///etc/passwd" } }, f.client, f.environment), /does not belong/);
});

test("same acknowledged tool operation returns its receipt without executing twice", async (t) => {
  const f = await setup(t);
  const req = { ...f.request, method: "tools/call", params: { name: "refresh", arguments: { metric: "tokens" }, server: "other", threadId: "other" }, operationID: randomUUID() };
  const first = await performCodexArtifactRequest(req, f.client, f.environment);
  assert.deepEqual(await performCodexArtifactRequest(req, f.client, f.environment), first);
  assert.equal(f.toolCount(), 1);
  const dispatch = f.calls.find((call) => call.method === "mcpServer/tool/call");
  assert.equal(dispatch.params.server, "fixture");
  await assert.rejects(performCodexArtifactRequest({ ...req, params: { name: "refresh", arguments: { metric: "time" } } }, f.client, f.environment), /already used/);
});

test("wrong revision, missing origin and changed resource never dispatch a tool", async (t) => {
  const f = await setup(t);
  await assert.rejects(performCodexArtifactRequest({ ...f.request, contentSHA256: "0".repeat(64) }, f.client, f.environment), /does not match/);
  assert.equal(f.calls.length, 0);
  const normal = f.client.request;
  f.client.request = async (method, params) => method === "thread/read" ? { thread: { turns: [] } } : normal(method, params);
  await assert.rejects(performCodexArtifactRequest(f.request, f.client, f.environment), /producing tool call/);
  f.client.request = async (method, params) => method === "mcpServer/resource/read" ? { contents: [{ uri, text: html + "changed" }] } : normal(method, params);
  await assert.rejects(performCodexArtifactRequest(f.request, f.client, f.environment), /latest revision/);
  assert.equal(f.toolCount(), 0);
});

test("unacknowledged tool outcomes cannot be blindly retried", async (t) => {
  const f = await setup(t);
  const normal = f.client.request;
  let attempts = 0;
  f.client.request = async (method, params) => {
    if (method === "mcpServer/tool/call") { attempts++; throw new Error("connection lost after dispatch"); }
    return normal(method, params);
  };
  const req = { ...f.request, method: "tools/call", params: { name: "refresh" }, operationID: randomUUID() };
  await assert.rejects(performCodexArtifactRequest(req, f.client, f.environment), /connection lost/);
  await assert.rejects(performCodexArtifactRequest(req, f.client, f.environment), /outcome is uncertain/);
  assert.equal(attempts, 1);
});

test("runtime bindings require private ownership and never travel inside artifact data", async (t) => {
  const f = await setup(t);
  const bindingPath = join(f.root, "artifact-runtime", `${f.request.bindingID}.json`);
  assert.equal(JSON.parse(await readFile(bindingPath, "utf8")).threadId, origin.threadId);
  assert.equal(JSON.stringify(artifact).includes(origin.threadId), false);
  await chmod(bindingPath, 0o644);
  await assert.rejects(readArtifactRuntime(f.request.bindingID, artifact.id, contentSHA256, f.environment), /could not be verified/);
});
