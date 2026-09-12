import test from "node:test";
import assert from "node:assert/strict";
import { mintConversation } from "../src/new-conversation.mjs";

test("mintConversation generates a fresh conversation id and channel", () => {
  const base = {
    pusherKey: "abc",
    authUrl: "https://example.test/auth",
    accountUuid: "acct-1",
    conversationId: "OLD",
    channel: "private-conversation-OLD",
  };
  const fresh = mintConversation(base);
  assert.notEqual(fresh.conversationId, "OLD");
  assert.equal(fresh.channel, `private-conversation-${fresh.conversationId}`);
  assert.equal(fresh.generatedConversation, true);
});

test("mintConversation keeps the profile transport data", () => {
  const base = { pusherKey: "abc", authUrl: "https://example.test/auth", accountUuid: "acct-1" };
  const fresh = mintConversation(base);
  assert.equal(fresh.pusherKey, "abc");
  assert.equal(fresh.authUrl, "https://example.test/auth");
  assert.equal(fresh.accountUuid, "acct-1");
});

test("mintConversation returns a different id each call", () => {
  const a = mintConversation({});
  const b = mintConversation({});
  assert.notEqual(a.conversationId, b.conversationId);
});
