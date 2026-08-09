import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFileMentionRefs,
  fileMentionAttachmentsChanged,
  resolveFileMentionAttachments,
  resolveFileRef,
} from "../dist/tui-file-mentions.js";

const files = [
  "packages/cli/src/tui.ts",
  "packages/cli/src/tui-actions.ts",
  "apps/web/app/page.tsx",
  "README.md",
  "docs/space name.md",
];

test("extractFileMentionRefs parses bare and quoted file mentions", () => {
  assert.deepEqual(
    extractFileMentionRefs("Review @README.md and @packages/cli/src/tui.ts, then @\"docs/space name.md\"."),
    ["README.md", "packages/cli/src/tui.ts", "docs/space name.md"],
  );
});

test("resolveFileRef supports exact, suffix, and unique basename matches", () => {
  assert.equal(resolveFileRef("README.md", files), "README.md");
  assert.equal(resolveFileRef("src/tui-actions.ts", files), "packages/cli/src/tui-actions.ts");
  assert.equal(resolveFileRef("page.tsx", files), "apps/web/app/page.tsx");
  assert.equal(resolveFileRef("missing.ts", files), null);
});

test("resolveFileMentionAttachments dedupes current attachments and reports misses", () => {
  const result = resolveFileMentionAttachments({
    goal: "Use @README.md @src/tui-actions.ts @missing.ts",
    files,
    currentAttachments: [{ path: "README.md" }],
  });

  assert.deepEqual(result.attachments, [
    { path: "README.md" },
    { path: "packages/cli/src/tui-actions.ts", kind: "file" },
  ]);
  assert.deepEqual(result.matched.map((match) => match.path), [
    "README.md",
    "packages/cli/src/tui-actions.ts",
  ]);
  assert.deepEqual(result.unresolved, ["missing.ts"]);
});

test("fileMentionAttachmentsChanged detects visible attachment state changes", () => {
  assert.equal(
    fileMentionAttachmentsChanged([{ path: "README.md" }], [{ path: "README.md" }]),
    false,
  );
  assert.equal(
    fileMentionAttachmentsChanged([{ path: "README.md" }], [
      { path: "README.md" },
      { path: "packages/cli/src/tui-actions.ts", kind: "file" },
    ]),
    true,
  );
  assert.equal(
    fileMentionAttachmentsChanged([{ path: "README.md" }], [{ path: "README.md", kind: "file" }]),
    true,
  );
});
