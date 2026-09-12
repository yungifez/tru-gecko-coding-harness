import test from "node:test";
import assert from "node:assert/strict";
import { GeckoClient } from "../src/gecko-client.mjs";

test("uses ordered chunk transfer for an oversized context", () => {
  const sent = [];
  const client = new GeckoClient({ output: () => {} });
  client.subscribed = true;
  client.socket = { readyState: 1 };
  client.sendRaw = (message) => sent.push(message);
  client.sendMessage("Inspect this project", {
    systemPrompt: "x".repeat(2_000),
    history: Array.from({ length: 20 }, () => ({ role: "assistant", content: "history ".repeat(200) })),
    localContext: { root: "/tmp/project", files: Array.from({ length: 800 }, (_, index) => `src/file-${index}.js`) },
    skills: [],
    tools: [],
  });
  clearTimeout(client.activeTransfer?.timeout);
  assert.equal(sent.length, 1);
  assert.ok(sent.every((message) => Buffer.byteLength(JSON.stringify(message)) <= 10_240));
  const first = JSON.parse(sent[0].data);
  assert.equal(first.chunked, true);
  assert.equal(first.chunkIndex, 0);
  assert.ok(first.chunkTotal > 1);
  assert.equal(client.activeTransfer.index, 0);
  assert.equal(client.harness.streamedMessages.size, 0);
});

test("records the original user request for chunked sends", () => {
  const messages = [];
  const client = new GeckoClient({ output: () => {}, onMessage: (message) => messages.push(message) });
  client.subscribed = true;
  client.socket = { readyState: 1 };
  client.sendRaw = () => {};
  const request = "Inspect this project ".repeat(1_000);
  client.sendMessage(request, { systemPrompt: "x".repeat(2_000), localContext: { files: [] } });
  clearTimeout(client.activeTransfer?.timeout);
  assert.equal(messages.filter((message) => message.role === "user" && message.content === request).length, 1);
});

test("closing a client cancels pending context transfer", () => {
  const client = new GeckoClient({ output: () => {} });
  client.subscribed = true;
  client.socket = { readyState: 1, close() {} };
  client.sendRaw = () => {};
  client.sendMessage("Context ".repeat(4_000));
  assert.ok(client.activeTransfer);
  client.close();
  assert.equal(client.activeTransfer, null);
  assert.equal(client.subscribed, false);
});

test("sends the refreshed session prompt and tool manifest after a config switch", () => {
  const sent = [];
  const client = new GeckoClient({ output: () => {}, pusherKey: "test", pusherCluster: "mt1", authUrl: "https://example.test/auth" });
  client.subscribed = true;
  client.socket = { readyState: 1 };
  client.sendRaw = (message) => sent.push(message);
  client.setSessionContext({
    sessionId: "fresh-session",
    systemPrompt: "You are a coding assistant.",
    skills: [{ name: "workspace-context", description: "Inspect files." }],
    tools: [{ name: "workspace.read_file", description: "Read a file." }],
    history: [],
    localContext: { root: "/tmp/project" },
  });
  client.sendMessage("Read the source", {});
  const payload = JSON.parse(sent[0].data);
  assert.equal(payload.sessionId, "fresh-session");
  assert.match(payload.entryText, /HARNESS ROLE/);
  assert.match(payload.entryText, /Geiko Bot/);
  assert.match(payload.entryText, /workspace\.read_file/);
  assert.match(payload.entryText, /HARNESS ROLE REMINDER/);
  assert.match(payload.systemPrompt, /use the name Geiko Bot/);
  assert.doesNotMatch(payload.entryText, /You are TRU Bot/);
  assert.doesNotMatch(payload.entryText, /TRU Gecko coding harness/);
});
