import assert from "node:assert/strict";
import test from "node:test";

import { compactNativeControlText } from "../dist/adapters/native-control.js";

test("native dashboard details redact credentials before entering Room state", () => {
  const compact = compactNativeControlText(
    "Gateway token=secret-value Authorization: Bearer abc.def password: hunter2 https://host/status?sig=abc123&safe=yes /Users/alice/.openclaw",
  );
  assert.doesNotMatch(compact, /secret-value|abc\.def|hunter2|abc123/);
  assert.match(compact, /token=\[redacted\]/i);
  assert.match(compact, /Bearer \[redacted\]/);
  assert.match(compact, /sig=\[redacted\]/);
  assert.doesNotMatch(compact, /alice/);
});
