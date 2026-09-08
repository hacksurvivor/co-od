import assert from "node:assert/strict";
import test from "node:test";

import {
  codexWorkspaceDynamicTools,
  promptWithWorkspaceAccess,
  workspaceToolEnvironment,
} from "../dist/workspace-tools.js";

const access = {
  toolPath: "/Applications/co·ode.app/Contents/Resources/Relay/coode-workspace-tool.mjs",
  serverURL: "http://127.0.0.1:7331",
  capability: "secret-capability",
  roomID: "room-a",
  runID: "run-a",
  expiresAt: "2026-08-03T03:00:00.000Z",
};

test("Codex receives native, schema-constrained workspace and document tools", () => {
  const [namespace] = codexWorkspaceDynamicTools();
  assert.equal(namespace.type, "namespace");
  assert.equal(namespace.name, "coode");
  assert.deepEqual(namespace.tools.map((tool) => tool.name), [
    "create_automation", "list_automations", "update_automation",
    "pause_automation", "resume_automation", "run_automation",
    "delete_automation", "list_tasks", "read_task", "create_task",
    "send_message", "rename_task", "pin_task", "archive_task",
    "unarchive_task", "fork_task",
    "list_documents", "create_document", "read_document", "propose_document",
  ]);
  assert.equal(namespace.tools.find((tool) => tool.name === "create_automation")
    .inputSchema.properties.schedule.additionalProperties, false);
  assert.deepEqual(namespace.tools.find((tool) => tool.name === "create_automation")
    .inputSchema.properties.schedule.required, ["frequency", "anchor", "time_zone"]);
  const proposal = namespace.tools.find((tool) => tool.name === "propose_document");
  assert.deepEqual(proposal.inputSchema.required, ["document_id", "edits"]);
  assert.equal(proposal.inputSchema.properties.edits.items.additionalProperties, false);
});

test("non-Codex harnesses receive the same scoped command contract", () => {
  const prompt = promptWithWorkspaceAccess("Create it", access);
  assert.match(prompt, /\$CO_OD_WORKSPACE_TOOL TOOL_NAME/);
  assert.match(prompt, /Do not guess an omitted time, timezone/);
  assert.match(prompt, /propose_document creates a reviewable paragraph proposal/);
  assert.doesNotMatch(prompt, /secret-capability/);
  assert.deepEqual(workspaceToolEnvironment(access), {
    CO_OD_WORKSPACE_TOOL: access.toolPath,
    CO_OD_WORKSPACE_SERVER_URL: access.serverURL,
    CO_OD_WORKSPACE_CAPABILITY: access.capability,
    CO_OD_WORKSPACE_ROOM_ID: access.roomID,
    CO_OD_WORKSPACE_RUN_ID: access.runID,
    CO_OD_WORKSPACE_EXPIRES_AT: access.expiresAt,
  });
});

test("Codex native Room tools preserve the user's prompt without a second contract", () => {
  const prompt = promptWithWorkspaceAccess("Create it", access, {
    nativeDynamicTools: true,
  });
  assert.equal(prompt, "Create it");
});
