import fs from "node:fs";
import { ulid } from "ulid";
import { GeckoClient } from "../src/gecko-client.mjs";
import { loadConfig } from "../src/config.mjs";
import { resolveSystemPrompt, GEIKO_IDENTITY, GEIKO_IDENTITY_EXAMPLES } from "../src/prompts.mjs";
import { buildTransportPrompt } from "../src/chunking.mjs";

const config = loadConfig({ accountName: "tru" });
const report = { startedAt: new Date().toISOString(), probes: [] };
for (const mode of (process.argv.length > 2 ? process.argv.slice(2) : ["plain", "harness"])) {
  const probe = { mode, frames: [], messages: [] };
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const client = new GeckoClient({ ...config, output: () => {}, onMessage: message => {
    if (message.role === "assistant") probe.messages.push({ content: message.content });
  } });
  const timer = setTimeout(finish, 25000);
  try {
    await client.connect();
    client.socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.event?.startsWith("pusher:")) return;
      let data = message.data;
      try { data = typeof data === "string" ? JSON.parse(data) : data; } catch {}
      probe.frames.push({ event: message.event, channelMatches: message.channel ? message.channel === config.channel : null,
        keys: Object.keys(data ?? {}), messageKeys: Object.keys(data?.message ?? {}),
        text: data?.entryText ?? data?.message?.entryText ?? null });
      if (message.event === "botMessageStreamCompleted") setTimeout(finish, 1000);
    });
    const prompt = mode === "harness-domain" ? "Where is Thompson Rivers University located?" : "What is 2 plus 2? Reply with the number only.";
    const context = { systemPrompt: resolveSystemPrompt(mode === "concise" ? "concise" : "coding"), history: [], tools: [], skills: [], localContext: {} };
    if (mode === "coding-no-role-delimiters") context.systemPrompt = context.systemPrompt.replace(/<\|[^|]+\|>/g, "");
    const plainVariants = {
      "request-wrapper-only": `[USER REQUEST]\n${prompt}\n[/USER REQUEST]`,
      "role-only": `${GEIKO_IDENTITY}\n\n${prompt}`,
      "protocol-only": `Callable tool protocol: emit only [[GEIKO_TOOL_CALL]]{\"name\":\"tool.name\",\"arguments\":{}}[[/GEIKO_TOOL_CALL]], with no surrounding prose, then wait for the harness result.\n\n${prompt}`,
    };
    const wrapped = buildTransportPrompt({ ...context, userMessage: prompt });
    plainVariants["with-identity-examples"] = wrapped.replace("[/LOCAL HARNESS INSTRUCTIONS]", `${GEIKO_IDENTITY_EXAMPLES}\n[/LOCAL HARNESS INSTRUCTIONS]`);
    plainVariants["length-control"] = `${"Background note: this is a test conversation. ".repeat(Math.ceil(wrapped.length / 45))}\n${prompt}`;
    plainVariants["no-examples"] = wrapped.replace(/<identity_examples>[\s\S]*?<\/identity_examples>/, "");
    plainVariants["no-chunk-guidance"] = wrapped.replace(/The harness may chunk[^\n]+/, "").replace("[WORKSPACE CONTEXT CHUNK 1/1]", "[WORKSPACE CONTEXT]");
    plainVariants["no-reminder"] = wrapped.replace(/\[HARNESS ROLE REMINDER\][\s\S]*?\[\/HARNESS ROLE REMINDER\]/, "");
    if (["plain", "metadata-only", "entrytext-only"].includes(mode) || mode in plainVariants) {
      const data = Object.fromEntries(["conversationId", "participantId", "channelId", "impressionId", "accountId", "messageUrl", "pageTitle"].map(k => [k, config[k]]));
      client.sendRaw({ event: "client-sendMessage", channel: config.channel, data: JSON.stringify({ ...data,
        ...(mode === "metadata-only" ? context : {}), messageId: ulid(),
        entryText: plainVariants[mode] ?? (mode === "entrytext-only" ? buildTransportPrompt({ ...context, userMessage: prompt }) : prompt) }) });
    } else client.sendMessage(prompt, context);
    await done;
  } catch (error) { probe.error = error.message; }
  finally { clearTimeout(timer); client.close(); }
  report.probes.push(probe);
  console.log(JSON.stringify(probe));
}
fs.writeFileSync(`reports/aig-tru/response-diagnostic-${Date.now()}.json`, JSON.stringify(report, null, 2));
