import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentEnvironment,
  extractProviderSessionIdFromText,
  findProviderSessionId,
  providerSessionEnvironment,
  resolveProviderSessionIdFromResult,
} from "../dist/adapters/base.js";

import {
  addAttachment,
  attachmentLabel,
  attachmentSummary,
  attachmentTransportSummary,
  formatGoalWithAttachments,
  inferAttachmentKind,
  nativeAttachmentKindsForProvider,
  normalizeAttachmentPath,
  removeAttachment,
  resolveAttachmentTransport,
} from "../dist/tui-attachments.js";

test("normalizeAttachmentPath trims quotes and whitespace", () => {
  assert.equal(normalizeAttachmentPath(" 'packages/cli/src/tui.ts' "), "packages/cli/src/tui.ts");
  assert.equal(normalizeAttachmentPath('"README.md"'), "README.md");
});

test("addAttachment appends unique paths and rejects empty values", () => {
  const empty = [];
  assert.deepEqual(addAttachment(empty, ""), {
    ok: false,
    attachments: empty,
    message: "Attach needs a file path.",
  });

  const added = addAttachment(empty, "README.md");
  assert.deepEqual(added, {
    ok: true,
    attachments: [{ path: "README.md", kind: "file" }],
    message: "Attached file: README.md",
  });

  assert.deepEqual(addAttachment(added.attachments, "README.md"), {
    ok: true,
    attachments: [{ path: "README.md", kind: "file" }],
    message: "Already attached: README.md",
  });
});

test("attachment kind inference detects images and explicit kinds", () => {
  assert.equal(inferAttachmentKind("screenshots/failure.png"), "image");
  assert.equal(inferAttachmentKind("docs/spec.md"), "file");
  assert.deepEqual(addAttachment([], "screenshots/failure.png").attachments, [
    { path: "screenshots/failure.png", kind: "image" },
  ]);
  assert.deepEqual(addAttachment([], "capture.bin", { kind: "image" }).attachments, [
    { path: "capture.bin", kind: "image" },
  ]);
});

test("removeAttachment removes by path, index, and all", () => {
  const attachments = [{ path: "a.ts", kind: "file" }, { path: "b.ts", kind: "file" }];
  assert.deepEqual(removeAttachment(attachments, "1"), {
    ok: true,
    attachments: [{ path: "b.ts", kind: "file" }],
    message: "Detached: a.ts",
  });
  assert.deepEqual(removeAttachment(attachments, "b.ts"), {
    ok: true,
    attachments: [{ path: "a.ts", kind: "file" }],
    message: "Detached: b.ts",
  });
  assert.deepEqual(removeAttachment(attachments, "all"), {
    ok: true,
    attachments: [],
    message: "Cleared attachments.",
  });
  assert.equal(removeAttachment(attachments, "missing.ts").ok, false);
});

test("attachmentSummary and formatGoalWithAttachments create prompt context", () => {
  const attachments = [
    { path: "a.ts", kind: "file" },
    { path: "screenshots/failure.png", kind: "image" },
    { path: "src", kind: "directory" },
  ];
  assert.equal(attachmentLabel(attachments[1]), "[image] screenshots/failure.png");
  assert.equal(attachmentSummary(attachments), "1. [file] a.ts\n2. [image] screenshots/failure.png\n3. [directory] src");
  assert.equal(
    formatGoalWithAttachments("Fix the bug", attachments),
    [
      "Attached context:",
      "Files:",
      "- a.ts",
      "Directories:",
      "- src",
      "Images:",
      "- screenshots/failure.png (image path; inspect directly if your provider supports image inputs)",
      "",
      "Task:",
      "Fix the bug",
    ].join("\n"),
  );
  assert.equal(formatGoalWithAttachments("No files", []), "No files");
});

test("resolveAttachmentTransport materializes absolute attachment metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-attachments-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), "export const app = true;\n");

  const transport = resolveAttachmentTransport([
    { path: "src/app.ts", kind: "file" },
    { path: "src", kind: "directory" },
    { path: "missing.png", kind: "image" },
  ], dir);

  assert.deepEqual(transport.map((attachment) => ({
    path: attachment.path,
    kind: attachment.kind,
    exists: attachment.exists,
  })), [
    { path: "src/app.ts", kind: "file", exists: true },
    { path: "src", kind: "directory", exists: true },
    { path: "missing.png", kind: "image", exists: false },
  ]);
  assert.equal(transport[0].absolutePath, join(dir, "src/app.ts"));
});

test("attachmentTransportSummary explains provider-native and fallback paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "co-od-attachment-transport-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "readme\n");
  writeFileSync(join(dir, "screen.png"), "png\n");

  assert.deepEqual(nativeAttachmentKindsForProvider("codex"), ["directory", "image"]);
  assert.deepEqual(nativeAttachmentKindsForProvider("opencode"), ["file", "image"]);
  assert.deepEqual(nativeAttachmentKindsForProvider("openclaw"), []);

  const summary = attachmentTransportSummary([
    { path: "README.md", kind: "file" },
    { path: "screen.png", kind: "image" },
    { path: "src", kind: "directory" },
    { path: "missing.ts", kind: "file" },
  ], "codex", dir);

  assert.deepEqual(summary.native.map((attachment) => attachment.path), ["screen.png", "src"]);
  assert.deepEqual(summary.fallback.map((attachment) => attachment.path), ["README.md", "missing.ts"]);
  assert.deepEqual(summary.lines, [
    "Provider transport for codex:",
    "native flags: [image] screen.png, [directory] src",
    "prompt/env fallback: [file] README.md, [file] missing.ts (missing)",
    "prompt context: included in submitted task text",
  ]);
});

test("attachmentEnvironment exposes provider transport metadata", () => {
  const env = attachmentEnvironment([
    { path: "screen.png", absolutePath: "/tmp/project/screen.png", kind: "image", exists: true },
  ]);

  assert.equal(env.CO_OD_ATTACHMENT_PATHS, "/tmp/project/screen.png");
  assert.deepEqual(JSON.parse(env.CO_OD_ATTACHMENTS_JSON), [
    { path: "screen.png", absolutePath: "/tmp/project/screen.png", kind: "image", exists: true },
  ]);
  assert.deepEqual(attachmentEnvironment([]), {});
});

test("providerSessionEnvironment exposes native continuation metadata", () => {
  assert.deepEqual(providerSessionEnvironment(), {});
  assert.deepEqual(providerSessionEnvironment({
    mode: "continue",
    sourceRunId: "run-a",
    providerSessionId: "session-a",
  }), {
    CO_OD_PROVIDER_SESSION_MODE: "continue",
    CO_OD_PROVIDER_SOURCE_RUN_ID: "run-a",
    CO_OD_PROVIDER_SESSION_ID: "session-a",
  });
});

test("provider session helpers extract ids from structured and text output", () => {
  assert.equal(findProviderSessionId({
    event: {
      item: {
        thread_id: "codex-thread-a",
      },
    },
  }), "codex-thread-a");
  assert.equal(findProviderSessionId({
    result: {
      session: {
        id: "opencode-session-nested",
      },
    },
  }), "opencode-session-nested");
  assert.equal(findProviderSessionId({
    message: {
      providerSessionID: "provider-session-mixed-case",
    },
  }), "provider-session-mixed-case");

  assert.equal(extractProviderSessionIdFromText([
    "{\"type\":\"turn.completed\",\"session_id\":\"older-session\"}",
    "{\"type\":\"turn.completed\",\"session_id\":\"newer-session\"}",
  ].join("\n")), "newer-session");

  assert.equal(
    extractProviderSessionIdFromText("Completed. Conversation ID: claude-conversation-a"),
    "claude-conversation-a",
  );
  assert.equal(
    extractProviderSessionIdFromText("\u001b[32mTo resume, run: codex exec resume codex-thread-2026.\u001b[0m"),
    "codex-thread-2026",
  );
  assert.equal(
    extractProviderSessionIdFromText("Use claude --resume 019b3899-65cc-7380-a00a-0fd20352c4d8"),
    "019b3899-65cc-7380-a00a-0fd20352c4d8",
  );
  assert.equal(
    extractProviderSessionIdFromText("OpenCode session created ses_2Z8h9Kx7jL"),
    "ses_2Z8h9Kx7jL",
  );
  assert.equal(
    extractProviderSessionIdFromText("next: opencode run --session opencode-session-a"),
    "opencode-session-a",
  );

  assert.equal(resolveProviderSessionIdFromResult("", {
    mode: "continue",
    sourceRunId: "run-a",
    providerSessionId: "existing-session",
  }), "existing-session");

  assert.equal(resolveProviderSessionIdFromResult("", {
    mode: "fork",
    sourceRunId: "run-a",
    providerSessionId: "source-session",
  }), undefined);
});
