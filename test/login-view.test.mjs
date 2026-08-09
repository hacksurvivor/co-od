import test from "node:test";
import assert from "node:assert/strict";

import {
  loginApprovalText,
  loginManualApprovalText,
  loginStartText,
  loginSuccessText,
  tokenLoginSuccessText,
} from "../dist/login-view.js";

const stripAnsi = (text) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

test("login ceremony uses room language instead of raw auth logs", () => {
  const text = stripAnsi(loginStartText("https://co-od.dev"));
  assert.match(text, /co.ode/);
  assert.match(text, /join your coding room/);
  assert.doesNotMatch(text, /\[co-od\]/);
  assert.doesNotMatch(text, /Starting browser authentication/);
});

test("login approval text exposes url and code in a stable ceremony", () => {
  const text = stripAnsi(loginApprovalText("https://co-od.dev/cli/approve?code=abc", "abc"));
  assert.match(text, /browser opened/);
  assert.match(text, /approve this device/);
  assert.match(text, /https:\/\/co-od\.dev\/cli\/approve\?code=abc/);
  assert.match(text, /code\s+abc/s);
  assert.match(text, /waiting for approval/);
});

test("login manual fallback keeps the same product framing", () => {
  const text = stripAnsi(loginManualApprovalText("https://co-od.dev/cli/approve?code=abc", "abc"));
  assert.match(text, /could not open automatically/);
  assert.match(text, /approve this device/);
  assert.match(text, /code\s+abc/s);
});

test("login success names the next command", () => {
  assert.match(stripAnsi(loginSuccessText("you")), /signed in as you/);
  assert.match(stripAnsi(loginSuccessText("you")), /run\s+co-od tui/);
  assert.match(stripAnsi(tokenLoginSuccessText()), /token saved/);
  assert.match(stripAnsi(tokenLoginSuccessText()), /run\s+co-od tui/);
});
