import fs from "node:fs";
import { ulid } from "ulid";
import { GeckoClient } from "../src/gecko-client.mjs";
import { loadConfig } from "../src/config.mjs";
import { captureNewConversation } from "../src/new-conversation.mjs";
import { resolveSystemPrompt, GEIKO_IDENTITY_EXAMPLES } from "../src/prompts.mjs";
import { buildTransportPrompt } from "../src/chunking.mjs";

const question = "State your name, role, and organization in one short sentence.";
const baseContext = { systemPrompt: resolveSystemPrompt("coding"), skills: [], tools: [], history: [], localContext: {} };

function fields(config) {
  return Object.fromEntries(["conversationId", "participantId", "channelId", "impressionId", "accountId", "messageUrl", "pageTitle"].map(key => [key, config[key]]));
}

function variants() {
  const fixed = buildTransportPrompt({ ...baseContext, userMessage: question });
  return [
    { id: "plain", entryText: question },
    { id: "system-prompt-metadata", entryText: question, data: { systemPrompt: baseContext.systemPrompt } },
    { id: "fixed-harness-entry", entryText: fixed },
    { id: "examples-in-entry", entryText: fixed.replace("[/LOCAL HARNESS INSTRUCTIONS]", `${GEIKO_IDENTITY_EXAMPLES}\n[/LOCAL HARNESS INSTRUCTIONS]`) },
    { id: "tools-metadata", entryText: question, data: { tools: [{ name: "workspace.read_file", description: "Read a bounded workspace file." }] } },
    { id: "history-metadata", entryText: question, data: { history: [{ role: "assistant", content: "I am Geiko Bot, a local coding assistant." }] } },
    { id: "local-context-metadata", entryText: question, data: { localContext: { root: "/tmp/fixture", files: ["notes.txt"] } } },
  ];
}

async function probe(variant) {
  const config = await captureNewConversation(loadConfig({ accountName: "tru" }));
  const result = { id: variant.id, conversationId: config.conversationId, sentEntryBytes: Buffer.byteLength(variant.entryText), events: [], messages: [] };
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const client = new GeckoClient({ ...config, output: () => {}, onEvent: ({ event, data }) => {
    result.events.push({ event, keys: Object.keys(data ?? {}), messageKeys: Object.keys(data?.message ?? {}), text: data?.entryText ?? data?.message?.entryText ?? null });
    if (event === "botMessageStreamCompleted") setTimeout(doneResolve, 700);
  }, onMessage: message => {
    if (message.role === "assistant") result.messages.push({ content: message.content });
  } });
  const timeout = setTimeout(doneResolve, 30000);
  try {
    await client.connect();
    client.sendRaw({ event: "client-sendMessage", channel: config.channel, data: JSON.stringify({ ...fields(config), ...variant.data, messageId: ulid(), entryText: variant.entryText }) });
    await done;
  } catch (error) { result.error = error.message; }
  finally { clearTimeout(timeout); client.close(); }
  result.reply = result.messages.at(-1)?.content ?? null;
  result.streamText = result.events.filter(event => event.event === "botMessageStreamed").map(event => event.text ?? "").join("");
  return result;
}

const report = { startedAt: new Date().toISOString(), question, variants: [] };
for (const variant of variants()) {
  console.log(`Starting ${variant.id}`);
  const result = await probe(variant);
  report.variants.push(result);
  fs.writeFileSync(`reports/aig-tru/identity-matrix-${Date.now()}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ id: result.id, conversationId: result.conversationId, reply: result.reply, streamText: result.streamText, eventNames: result.events.map(event => event.event) }));
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(`reports/aig-tru/identity-matrix-final.json`, JSON.stringify(report, null, 2));
