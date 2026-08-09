import test from "node:test";
import assert from "node:assert/strict";
import { appendChatTurn, createEmptyTranscript } from "../dist/tui-chat-transcript.js";

test("appendChatTurn adds a chat turn with author and ownership", () => {
  const transcript = appendChatTurn(createEmptyTranscript(), {
    id: "chat-m1", author: "marco", body: "hola", at: 123,
  });
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].chat, true);
  assert.equal(transcript[0].author, "marco");
  assert.equal(transcript[0].mine, false);
  assert.equal(transcript[0].blocks[0].text, "hola");
});

test("appendChatTurn is idempotent per message id", () => {
  let transcript = appendChatTurn(createEmptyTranscript(), { id: "chat-m1", author: "you", body: "hi", mine: true });
  transcript = appendChatTurn(transcript, { id: "chat-m1", author: "you", body: "hi", mine: true });
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].mine, true);
});
