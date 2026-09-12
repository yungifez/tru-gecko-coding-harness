import test from "node:test";
import assert from "node:assert/strict";
import { listConfigEntries, loadConfig, resolveSessionConfig } from "../src/config.mjs";

test("lists transport-only profiles for explicit selection", () => {
  const entries = listConfigEntries();
  assert.ok(entries.length >= 3);
  const selected = loadConfig({ index: entries.length - 1 });
  assert.equal(selected.accountName, entries.at(-1).accountName);
});

test("every active account can be selected explicitly", () => {
  const entries = listConfigEntries();
  const active = entries.filter((entry) => entry.channel);
  const accounts = active.map((entry) => loadConfig({ index: entries.indexOf(entry) }).accountName);
  assert.deepEqual(new Set(accounts), new Set(active.map((entry) => entry.accountName)));
  assert.ok(accounts.includes("herts"));
  assert.ok(accounts.some((account) => account !== "herts"));
});

test("supports selecting a named account for startup", () => {
  const selected = loadConfig({ accountName: "uci" });
  assert.equal(selected.accountName, "uci");
});

test("resolves a clean tru session config without leaking herts fields", () => {
  const hertsConfig = loadConfig({ accountName: "herts" });
  assert.equal(hertsConfig.accountName, "herts");
  assert.equal(hertsConfig.region, "eu");

  const truSessionGecko = {
    accountName: "tru",
    channel: "private-conversation-01M28ZN3XX43N4RKP4VZ8WQJ21",
    conversationId: "01M28ZN3XX43N4RKP4VZ8WQJ21",
    participantId: "01M28ZN3EH8M0CVQ25JBYT6FAY",
  };

  const resolved = resolveSessionConfig(truSessionGecko);
  assert.equal(resolved.accountName, "tru");
  assert.equal(resolved.channel, "private-conversation-01M28ZN3XX43N4RKP4VZ8WQJ21");
  assert.equal(resolved.conversationId, "01M28ZN3XX43N4RKP4VZ8WQJ21");
  assert.equal(resolved.region, undefined);
  assert.notEqual(resolved.widgetId, hertsConfig.widgetId);
  assert.equal(resolved.pusherCluster, "mt1");
});

test("resolveSessionConfig returns null for empty or invalid session gecko", () => {
  assert.equal(resolveSessionConfig(null), null);
  assert.equal(resolveSessionConfig({}), null);
  assert.equal(resolveSessionConfig(undefined), null);
});

