// `co-od notify` command surface: config writes, merge semantics, and the
// negative paths (bad args set exitCode=1 and print usage). The config file is
// redirected to a temp path via CO_OD_NOTIFY_CONFIG before the module loads.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "co-od-notify-test-"));
process.env.CO_OD_NOTIFY_CONFIG = join(tempDir, "notify.json");
delete process.env.CO_OD_TELEGRAM_BOT_TOKEN;
delete process.env.CO_OD_TELEGRAM_CHAT_ID;

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { run } = await import("../dist/commands/notify.js");

after(() => rmSync(tempDir, { recursive: true, force: true }));

const readConfig = () => JSON.parse(readFileSync(process.env.CO_OD_NOTIFY_CONFIG, "utf8"));

function captureOutput() {
  const lines = { out: [], err: [] };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.out.push(args.join(" "));
  console.error = (...args) => lines.err.push(args.join(" "));
  return {
    lines,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

test("set telegram writes config and preserves desktop; off clears telegram only", async () => {
  const capture = captureOutput();
  try {
    await run(["set", "desktop", "off"]);
    await run(["set", "telegram", "tok-123", "chat-456"]);
    assert.deepEqual(readConfig(), { desktop: false, telegram: { botToken: "tok-123", chatId: "chat-456" } });

    await run(["off"]);
    const cleared = readConfig();
    assert.equal(cleared.telegram, undefined);
    assert.equal(cleared.desktop, false, "off only clears telegram, desktop choice survives");
  } finally {
    capture.restore();
  }
});

test("status reports the configured state", async () => {
  const capture = captureOutput();
  try {
    await run(["set", "telegram", "tok-123", "chat-456"]);
    capture.lines.out.length = 0;
    await run([]);
    const output = capture.lines.out.join("\n");
    assert.match(output, /telegram: configured \(chat chat-456\)/);
    assert.ok(!output.includes("tok-123"), "the bot token is never echoed");
  } finally {
    capture.restore();
  }
});

test("negative paths set exitCode 1 and print usage", async () => {
  const capture = captureOutput();
  try {
    process.exitCode = 0;
    await run(["set", "telegram", "only-token"]);
    assert.equal(process.exitCode, 1);
    assert.match(capture.lines.err.join("\n"), /usage: co-od notify set telegram/);

    process.exitCode = 0;
    await run(["set", "desktop", "maybe"]);
    assert.equal(process.exitCode, 1);

    process.exitCode = 0;
    await run(["frobnicate"]);
    assert.equal(process.exitCode, 1);
    assert.match(capture.lines.err.join("\n"), /Unknown notify command: frobnicate/);
  } finally {
    capture.restore();
    process.exitCode = 0;
  }
});
