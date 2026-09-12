import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session-store.mjs";
import { SessionService } from "../src/services/SessionService.mjs";

test("creates, saves, loads, and lists resumable sessions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-session-"));
  const store = new SessionStore(directory);
  const session = store.create({ id: "session-test", systemPrompt: "Be concise." });
  store.append(session, { role: "user", content: "Hello" });
  const loaded = store.load("session-test");
  assert.equal(loaded.systemPrompt, "Be concise.");
  assert.equal(loaded.messages[0].content, "Hello");
  assert.equal(store.list().length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("can keep an empty session in memory without storing it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-empty-session-"));
  const store = new SessionStore(directory);
  const session = store.create({ systemPrompt: "Be concise.", persist: false });
  assert.equal(store.load(session.id), null);
  store.append(session, { role: "user", content: "Hello" });
  assert.equal(store.load(session.id).messages.length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("persists the Gecko profile that belongs to a session", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-profile-session-"));
  const store = new SessionStore(directory);
  const session = store.create({
    id: "profile-session",
    systemPrompt: "Be concise.",
    gecko: { accountName: "uci", channel: "private-conversation-uci-session" },
  });
  const loaded = store.load(session.id);
  assert.equal(loaded.gecko.accountName, "uci");
  assert.equal(loaded.gecko.channel, "private-conversation-uci-session");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("can create a provisional session without persisting an empty file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-provisional-session-"));
  const service = new SessionService(new SessionStore(directory));
  const session = service.create("coding", null, { persist: false });
  assert.equal(service.store.load(session.id), null);
  service.append(session, { role: "user", content: "Hello" });
  assert.equal(service.store.load(session.id).messages.length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});
