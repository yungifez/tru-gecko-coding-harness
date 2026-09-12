import test from "node:test";
import assert from "node:assert/strict";
import { byteLength, chunkText, prepareTransportData, SAFE_EVENT_BUDGET_BYTES } from "../src/chunking.mjs";

test("splits UTF-8 text without exceeding the chunk budget", () => {
  const chunks = chunkText("🙂".repeat(5000), 700);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => byteLength(chunk) <= 700));
  assert.equal(chunks.join(""), "🙂".repeat(5000));
});

test("keeps a transport event below the Pusher budget", () => {
  const result = prepareTransportData({
    channel: "private-conversation-test",
    entryText: "request",
    rawEntryText: "request",
    history: Array.from({ length: 20 }, () => ({ role: "assistant", content: "x".repeat(1000) })),
    skills: [],
    tools: [],
    localContext: { root: "/tmp", files: Array.from({ length: 500 }, (_, index) => `src/file-${index}.js`) },
  }, "x".repeat(7000));
  assert.ok(result.bytes <= SAFE_EVENT_BUDGET_BYTES);
});
