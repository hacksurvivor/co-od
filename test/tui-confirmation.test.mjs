import test from "node:test";
import assert from "node:assert/strict";

import {
  createConfirmation,
  resolveConfirmationKey,
} from "../dist/tui-confirmation.js";

test("createConfirmation supplies default labels", () => {
  assert.deepEqual(
    createConfirmation({
      id: "patch.accept",
      title: "Accept patch?",
      danger: true,
    }),
    {
      id: "patch.accept",
      title: "Accept patch?",
      danger: true,
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
    },
  );
});

test("resolveConfirmationKey maps common confirm and cancel keys", () => {
  assert.deepEqual(resolveConfirmationKey("y", {}), { type: "confirm" });
  assert.deepEqual(resolveConfirmationKey("", { name: "return" }), { type: "confirm" });
  assert.deepEqual(resolveConfirmationKey("n", {}), { type: "cancel" });
  assert.deepEqual(resolveConfirmationKey("", { name: "escape" }), { type: "cancel" });
  assert.deepEqual(resolveConfirmationKey("x", {}), { type: "none" });
});
