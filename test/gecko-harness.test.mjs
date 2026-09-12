import test from "node:test";
import assert from "node:assert/strict";
import { GeckoHarness } from "../src/gecko-harness.mjs";
import { buildHarnessMessage } from "../src/prompts.mjs";
import { parseToolCall } from "../src/geiko-tool-calls.mjs";
import { ConversationController } from "../src/controllers/ConversationController.mjs";

test("joins cumulative and delta bot stream packets", () => {
  const lines = [];
  const harness = new GeckoHarness({ output: (line) => lines.push(line) });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "m1", entryText: "Hello" } });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "m1", entryText: "Hello world" } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId: "m1" } });
  assert.equal(lines.at(-1), "Geiko Bot [stream]: Hello world");
});

test("does not render the same message twice", () => {
  const lines = [];
  const harness = new GeckoHarness({ output: (line) => lines.push(line) });
  const message = { event: "messageWasAdded", data: { message: { id: "m1", messageType: "Bot", entryText: "Done" } } };
  harness.renderEvent(message);
  harness.renderEvent(message);
  assert.deepEqual(lines, ["Geiko Bot: Done"]);
});

test("records completed streamed responses once", () => {
  const messages = [];
  const harness = new GeckoHarness({ onMessage: (message) => messages.push(message) });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "m2", entryText: "Ready" } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId: "m2" } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId: "m2" } });
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
    { role: "assistant", content: "Ready" },
  ]);
});

test("records a reply once when messageWasAdded arrives before stream completion", () => {
  const messages = [];
  const harness = new GeckoHarness({ onMessage: (message) => messages.push(message) });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "m4", entryText: "Hi" } });
  harness.renderEvent({ event: "messageWasAdded", data: { message: { id: "m4", messageType: "Bot", entryText: "Hi" } } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { message: { id: "m4" } } });
  assert.deepEqual(messages.map(({ content }) => content), ["Hi"]);
});

test("records a reply once when its stream and stored copies use different IDs", () => {
  const messages = [];
  const harness = new GeckoHarness({ onMessage: (message) => messages.push(message) });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "stream-1", entryText: "Same reply" } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId: "stream-1" } });
  harness.renderEvent({ event: "messageWasAdded", data: { message: { id: "stored-1", messageType: "Bot", entryText: "Same reply" } } });
  assert.deepEqual(messages.map(({ content }) => content), ["Same reply"]);
});

test("records the same reply again after a new outbound message", () => {
  const messages = [];
  const harness = new GeckoHarness({ onMessage: (message) => messages.push(message) });
  const reply = (id) => ({ event: "messageWasAdded", data: { message: { id, messageType: "Bot", entryText: "I am Geiko Bot." } } });
  harness.renderEvent({ event: "client-sendMessage", data: { messageId: "u1", entryText: "who are you" } });
  harness.renderEvent(reply("b1"));
  harness.renderEvent({ event: "client-sendMessage", data: { messageId: "u2", entryText: "who are you" } });
  harness.renderEvent(reply("b2"));
  assert.deepEqual(messages.filter(({ role }) => role === "assistant").map(({ messageId }) => messageId), ["b1", "b2"]);
});

test("does not emit chat text when the caller owns message rendering", () => {
  const lines = [];
  const messages = [];
  const harness = new GeckoHarness({ output: (line) => lines.push(line), onMessage: (message) => messages.push(message) });
  harness.renderEvent({ event: "botMessageStreamed", data: { messageId: "m3", entryText: "Hello" } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId: "m3" } });
  assert.deepEqual(lines, []);
  assert.equal(messages[0].content, "Hello");
});

test("builds a local harness message with skills and workspace context", () => {
  const message = buildHarnessMessage({
    systemPrompt: "Be precise.",
    skills: [{ name: "workspace-context", description: "Inspect files." }],
    localContext: { root: "/tmp/project", files: ["src/app.js"] },
    history: [{ role: "user", content: "Earlier request" }],
    userMessage: "What files are here?",
    tools: [{ name: "workspace.list_files", description: "List files." }],
  });
  assert.match(message, /Be precise\./);
  assert.match(message, /src\/app\.js/);
  assert.match(message, /What files are here\?/);
  assert.match(message, /workspace\.list_files/);
  assert.match(message, /If identity questions arise, answer them briefly/);
});

test("conversation controller sends the server-parsed request body", async () => {
  const controller = new ConversationController({ gecko: { send: (content) => ({ content }) } });
  let response;
  await controller.send({ body: { content: "Hello" } }, { json: (value) => { response = value; } });
  assert.deepEqual(response, { content: "Hello" });
});

test("recovers a valid tool call when the model omits the closing marker", () => {
  const call = parseToolCall('[[GEIKO_TOOL_CALL]]{"name":"workspace.write_file","arguments":{"path":"lipsum.txt","content":"Lorem ipsum"}}I’ve sent the write request.');
  assert.deepEqual(call, {
    name: "workspace.write_file",
    arguments: { path: "lipsum.txt", content: "Lorem ipsum" },
  });
});
