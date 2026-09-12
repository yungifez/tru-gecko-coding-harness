#!/usr/bin/env node
import fs from "node:fs";
import { stdout as output } from "node:process";
import { input as ask, confirm, editor, select } from "@inquirer/prompts";
import { runMockConversation } from "./mock-gecko.mjs";
import { GeckoClient } from "./gecko-client.mjs";
import { resolveSystemPrompt, ensureGeikoIdentity, compactHistory } from "./prompts.mjs";
import { SessionStore } from "./session-store.mjs";
import { HARNESS_SKILLS, collectLocalContext, formatLocalContext } from "./local-context.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { cleanHarnessContent, fetchTranscript } from "./gecko-transcript.mjs";
import { ensureSessionTitle } from "./session-title.mjs";
import { parseToolCall, TOOL_CALL_OPEN } from "./geiko-tool-calls.mjs";
import { listConfigEntries, resolveSessionConfig, normalizeConfig } from "./config.mjs";
import { mintConversation } from "./new-conversation.mjs";

const args = new Set(process.argv.slice(2));
const useColor = Boolean(output.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
const ansi = (code, value) => useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
const colors = {
  reset: (value) => ansi(0, value),
  bold: (value) => ansi(1, value),
  dim: (value) => ansi(2, value),
  red: (value) => ansi(31, value),
  green: (value) => ansi(32, value),
  yellow: (value) => ansi(33, value),
  blue: (value) => ansi(34, value),
  magenta: (value) => ansi(35, value),
  cyan: (value) => ansi(36, value),
  gray: (value) => ansi(90, value),
};

function styledOutput(value) {
  const text = String(value);
  if (!text.startsWith("[debug]") && (text.includes(TOOL_CALL_OPEN) || text.includes("[[GEIKO_TOOL"))) return;
  if (text.startsWith("Geiko Bot [stream]:")) return console.log(colors.green(text));
  if (text.startsWith("Geiko Bot:")) return console.log(colors.bold(colors.green(text)));
  if (/typing\.\.\.$/.test(text)) return console.log(colors.yellow(text));
  if (text.startsWith("[debug]")) return console.log(colors.gray(text));
  if (/^(WebSocket|Connected to Gecko|Gecko connection)/.test(text)) return console.log(colors.cyan(text));
  if (/^(Unable to connect|Gecko authentication failed|Pusher error)/.test(text)) return console.error(colors.red(text));
  if (text.startsWith("[Conversation")) return console.log(colors.magenta(text));
  return console.log(text);
}

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
};

if (args.has("--demo")) {
  await runMockConversation("Build a function that reverses a string.");
  process.exit(0);
}

const store = new SessionStore();
let localContext = collectLocalContext();
const registry = new ToolRegistry({
  onResult: (result) => {
    if (session?.messages.some(({ role }) => role === "user")) {
      store.append(session, { role: "tool", content: JSON.stringify(result), tool: result.tool });
    }
  },
  sessionProvider: () => session,
});
const requestedSessionId = valueAfter("--session") ?? process.env.GECKO_SESSION_ID;
const requestedPrompt = valueAfter("--system-prompt") ?? process.env.GECKO_SYSTEM_PROMPT ?? "coding";
let session = requestedSessionId ? store.load(requestedSessionId) : null;
if (requestedSessionId && !session) {
  console.error(`Session not found: ${requestedSessionId}`);
  process.exitCode = 1;
  process.exit();
}
if (!session) session = store.create({ systemPrompt: resolveSystemPrompt(requestedPrompt), persist: false });
session.systemPrompt = ensureGeikoIdentity(session.systemPrompt ?? requestedPrompt);

const printSession = () => {
  console.log(colors.bold(session.title ?? "Untitled session") + colors.gray(`  ·  ${session.id}  ·  ${session.messages.length} messages`));
  console.log(colors.gray(`system: ${session.systemPrompt}`));
};

const printSessionHistory = () => {
  const messages = session.messages.filter(({ role }) => role === "user" || role === "assistant");
  if (!messages.length) return;
  console.log(colors.dim("── previous messages ─────────────────────────────────────────"));
  for (const message of messages) {
    const content = cleanHarnessContent(message.content);
    if (!content) continue;
    const label = message.role === "assistant" ? "Geiko Bot" : "You";
    const painted = message.role === "assistant" ? colors.green(content) : colors.cyan(content);
    console.log(`${colors.bold(label)}: ${painted}`);
  }
  console.log(colors.dim("── continue conversation ─────────────────────────────────────"));
};

const clientOptions = {
  output: styledOutput,
  debug: args.has("--debug"),
  sessionId: session.id,
  systemPrompt: session.systemPrompt,
  history: compactHistory(session.messages),
  skills: HARNESS_SKILLS,
  localContext,
  tools: registry.manifest(),
  onMessage: async (message) => {
    store.append(session, message);
    if (message.role !== "assistant") return;
    const call = parseToolCall(message.content);
    if (!call) {
      console.log(colors.bold(colors.green(`Geiko Bot: ${cleanHarnessContent(message.content)}`)));
      return;
    }
    console.log(colors.yellow(`⏺ ${call.name}`));
    let result;
    try {
      result = await registry.invoke(call.name, call.arguments);
    } catch (error) {
      result = { tool: call.name, ok: false, error: error.message, timestamp: new Date().toISOString() };
    }
    console.log(result.ok ? colors.green(`✔ ${call.name} · done`) : colors.red(`⚠ ${call.name} · ${result.error}`));
    client.sendMessage(`[[GEIKO_TOOL_RESULT]]\n${JSON.stringify({ name: call.name, ...result })}\n[[/GEIKO_TOOL_RESULT]]`, {
      sessionId: session.id,
      systemPrompt: session.systemPrompt,
      history: compactHistory(session.messages),
      skills: HARNESS_SKILLS,
      localContext,
      tools: registry.manifest(),
    });
  },
};
if (process.env.GECKO_PARTICIPANT_ID) clientOptions.participantId = process.env.GECKO_PARTICIPANT_ID;
if (process.env.GECKO_ACCOUNT_UUID) clientOptions.accountUuid = process.env.GECKO_ACCOUNT_UUID;
const client = new GeckoClient(clientOptions);
// A saved session owns its Gecko conversation. Apply it before connecting so
// startup cannot use a different randomly selected profile.
if (session.gecko?.channel) {
  const sessionConfig = resolveSessionConfig(session.gecko);
  if (sessionConfig) client.config = { ...sessionConfig };
} else {
  // A fresh session starts a new remote conversation instead of resuming the
  // profile's saved chat. The server accepts our client-generated ULID.
  client.config = mintConversation(client.config);
}
try {
  await client.connect();
} catch (error) {
  console.error(`Unable to connect to Gecko: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

function saveConversationProfile() {
  session.gecko = normalizeConfig(client.config);
}

console.log(colors.bold(colors.cyan("╭─ Geiko Bot coding harness")));
console.log(colors.cyan("╰─ live conversation"));
printSession();
printSessionHistory();
console.log(colors.dim("Type /menu for actions · /compose for a multiline message · Ctrl+C or /exit to leave\n"));

try {
  while (true) {
    console.log(colors.dim("╭─ message ───────────────────────────────────────────────────────────────"));
    let prompt = (await ask({
      message: "",
      prefix: colors.cyan("│"),
      transformer: (value) => colors.cyan(value),
    })).trim();
    console.log(colors.dim("╰─────────────────────────────────────────────────────────────────────────"));
    if (!prompt || prompt.toLowerCase() === "exit") break;
    if (prompt === "/compose") {
      prompt = (await editor({
        message: "Compose message",
        instructions: "Write a multiline message. Save and close the editor when finished.",
      })).trim();
      if (!prompt) continue;
    }
    if (prompt === "/menu") {
      const action = await select({
        message: "Choose an action",
        choices: [
          { name: "Compose message", value: "compose" },
          { name: "System prompt", value: "system" },
          { name: "Session history", value: "history" },
          { name: "Sessions", value: "sessions" },
          { name: "Workspace context", value: "context" },
          { name: "Local tools", value: "tools" },
          { name: "Refresh workspace", value: "refresh" },
          { name: "Save session", value: "save" },
          { name: "Close", value: "close" },
        ],
      });
      if (action === "close") continue;
      if (action === "compose") {
        prompt = (await editor({ message: "Compose message", instructions: "Save and close the editor when finished." })).trim();
        if (!prompt) continue;
      } else if (action === "system") {
        prompt = "/system";
      } else {
        prompt = `/${action}`;
      }
    }
    if (prompt === "/help") {
      console.log("/system <preset or text>  set the system prompt");
      console.log("/history                 show saved messages");
      console.log("/sessions                list resumable sessions");
      console.log("/config                 choose a Gecko config and start fresh");
      console.log("/new                     start a new local session");
      console.log("/resume <session-id>     resume a saved session");
      console.log("/clear                  clear the visible transcript");
      console.log("/rename NAME             name the current session");
      console.log("/status                 show session and connection state");
      console.log("/doctor                diagnose connection and harness state");
      console.log("/save                    save the current session");
      console.log("/context                 show the local development context");
      console.log("/refresh                 refresh local files, runtime, and Git status");
      console.log("/tools                   list available local tools");
      console.log("/tool NAME JSON          invoke a local tool");
      console.log("/files [prefix]          list workspace files");
      console.log("/read PATH               read a workspace file");
      console.log("/write PATH              create or modify a file with approval");
      console.log("/search REGEX            search workspace text");
      console.log("/diff                    show the Git diff");
      console.log("/test [script]           run an npm script, default: test");
      console.log("/logs                    inspect redacted local logs");
      console.log("/network [check]         inspect safe Gecko endpoint diagnostics");
      console.log("/websearch QUERY         search the public web");
      console.log("/google QUERY            create a Google search link");
      console.log("/apply PATCH_FILE        review and apply a checked Git patch");
      console.log("/exit                    close the harness");
      console.log("/menu                    open the action menu");
      console.log("/compose                 write a multiline message");
      continue;
    }
    if (prompt === "/save") {
      store.save(session);
      console.log(`Saved ${session.id}`);
      continue;
    }
    if (prompt === "/clear") {
      console.clear();
      printSession();
      continue;
    }
    if (prompt.startsWith("/rename ")) {
      const title = prompt.slice(8).trim().slice(0, 64);
      if (!title) { console.log("Usage: /rename NAME"); continue; }
      session.title = title;
      if (session.messages.length) store.save(session);
      printSession();
      continue;
    }
    if (prompt === "/status") {
      console.log(JSON.stringify({ sessionId: session.id, title: session.title, messages: session.messages.length, connected: client.subscribed }, null, 2));
      continue;
    }
    if (prompt === "/doctor") {
      const diagnostics = await registry.invoke("network.diagnostics", { check: true });
      console.log(JSON.stringify({ sessionId: session.id, connected: client.connected, subscribed: client.subscribed, account: client.config.accountName ?? null, channel: client.config.channel ?? null, diagnostics: diagnostics.result ?? diagnostics.error }, null, 2));
      continue;
    }
    if (prompt.startsWith("!")) {
      const command = prompt.slice(1).trim().match(/^npm\s+run\s+([a-z0-9:_-]+)$/i);
      if (!command) { console.log("Only !npm run SCRIPT is allowed."); continue; }
      const result = await registry.invoke("workspace.run_script", { name: command[1] });
      console.log(result.result?.output ?? result.error);
      continue;
    }
    if (prompt === "/context") {
      console.log(formatLocalContext(localContext));
      continue;
    }
    if (prompt === "/tools") {
      console.log(JSON.stringify(registry.manifest(), null, 2));
      continue;
    }
    if (prompt.startsWith("/tool ")) {
      const match = prompt.match(/^\/tool\s+(\S+)(?:\s+(.*))?$/);
      if (!match) { console.log("Usage: /tool NAME JSON"); continue; }
      let argumentsObject = {};
      try { argumentsObject = match[2] ? JSON.parse(match[2]) : {}; } catch { console.log("Tool arguments must be valid JSON."); continue; }
      const result = await registry.invoke(match[1], argumentsObject);
      console.log(JSON.stringify(result, null, 2));
      continue;
    }
    if (prompt === "/files" || prompt.startsWith("/files ")) {
      const result = await registry.invoke("workspace.list_files", { prefix: prompt.slice(6).trim() });
      console.log(JSON.stringify(result.result, null, 2));
      continue;
    }
    if (prompt.startsWith("/read ")) {
      const result = await registry.invoke("workspace.read_file", { path: prompt.slice(6).trim() });
      console.log(JSON.stringify(result, null, 2));
      continue;
    }
    if (prompt.startsWith("/write ")) {
      const filePath = prompt.slice(7).trim();
      const lines = [];
      console.log("Enter file contents. Type .done on its own line when finished.");
      while (true) {
        const line = await ask({ message: "│", transformer: (value) => colors.gray(value) });
        if (line === ".done") break;
        lines.push(line);
      }
      const approved = await confirm({ message: `Write ${filePath}?`, default: false });
      if (!approved) { console.log("File not changed."); continue; }
      const result = await registry.invoke("workspace.write_file", { path: filePath, content: `${lines.join("\n")}\n` }, { approved: true });
      console.log(JSON.stringify(result, null, 2));
      localContext = collectLocalContext();
      client.config.localContext = localContext;
      continue;
    }
    if (prompt.startsWith("/search ")) {
      const result = await registry.invoke("workspace.search", { query: prompt.slice(8).trim() });
      console.log(JSON.stringify(result.result, null, 2));
      continue;
    }
    if (prompt === "/diff") {
      const result = await registry.invoke("workspace.git_diff");
      console.log(result.result);
      continue;
    }
    if (prompt === "/logs") {
      const result = await registry.invoke("workspace.inspect_logs");
      console.log(JSON.stringify(result.result, null, 2));
      continue;
    }
    if (prompt === "/network" || prompt === "/network check") {
      const result = await registry.invoke("network.diagnostics", { check: prompt.endsWith("check") });
      console.log(JSON.stringify(result.result, null, 2));
      continue;
    }
    if (prompt.startsWith("/websearch ")) {
      const result = await registry.invoke("web.search", { query: prompt.slice(11).trim() });
      console.log(JSON.stringify(result.result ?? result.error, null, 2));
      continue;
    }
    if (prompt.startsWith("/google ")) {
      const result = await registry.invoke("web.search", { query: prompt.slice(8).trim() });
      console.log(JSON.stringify(result.result ?? result.error, null, 2));
      continue;
    }
    if (prompt === "/test" || prompt.startsWith("/test ")) {
      const result = await registry.invoke("workspace.run_script", { name: prompt.slice(5).trim() || "test" });
      console.log(result.result?.output ?? result.error);
      continue;
    }
    if (prompt.startsWith("/apply ")) {
      const patchPath = prompt.slice(7).trim();
      let patchText;
      try { patchText = fs.readFileSync(registry.workspace.resolve(patchPath), "utf8"); }
      catch (error) { console.log(`Cannot read patch: ${error.message}`); continue; }
      const approved = await confirm({ message: `Apply ${patchPath}?`, default: false });
      if (!approved) { console.log("Patch not applied."); continue; }
      const result = await registry.invoke("workspace.apply_patch", { patch: patchText }, { approved: true });
      console.log(JSON.stringify(result, null, 2));
      localContext = collectLocalContext();
      client.config.localContext = localContext;
      continue;
    }
    if (prompt === "/refresh") {
      localContext = collectLocalContext();
      client.config.localContext = localContext;
      client.config.tools = registry.manifest();
      console.log("Local development context refreshed.");
      continue;
    }
    if (prompt === "/history") {
      try {
        const transcript = await fetchTranscript(client.config);
        console.log(colors.cyan(`Remote Gecko history · ${transcript.messages.length} messages`));
        for (const message of transcript.messages) {
          const label = message.role === "assistant" ? "Geiko Bot" : (message.participant ?? message.speaker);
          console.log(colors.gray(`[${message.timestamp}]`) + ` ${colors.bold(label)}: ${message.content}`);
        }
      } catch (error) {
        console.log(colors.yellow(`Remote history unavailable: ${error.message}`));
        console.log(colors.gray("Local session history:"));
        for (const message of session.messages.filter(({ role }) => role === "user" || role === "assistant")) {
          const content = cleanHarnessContent(message.content);
          if (content) console.log(`${message.role}: ${content}`);
        }
      }
      continue;
    }
    if (prompt === "/sessions") {
      const sessions = store.list();
      if (!sessions.length) {
        console.log("No saved sessions.");
        continue;
      }
      const selectedId = await select({
        message: "Relaunch a session",
        choices: [
          ...sessions.map((item) => ({
            name: `${item.id} · ${item.messages.length} messages · ${item.updatedAt}`,
            value: item.id,
          })),
          { name: "Cancel", value: null },
        ],
      });
      if (!selectedId) continue;
      const resumed = store.load(selectedId);
      if (!resumed) {
        console.log("Session not found.");
        continue;
      }
      session = resumed;
      client.close();
      if (session.gecko?.channel) {
        const sessionConfig = resolveSessionConfig(session.gecko);
        client.config = sessionConfig ? { ...sessionConfig } : { ...session.gecko };
        await client.connect();
      } else {
        client.config = {};
      }
      client.setSessionContext({
        sessionId: session.id,
        systemPrompt: session.systemPrompt,
        history: compactHistory(session.messages),
        skills: HARNESS_SKILLS,
        localContext,
        tools: registry.manifest(),
      });
      console.log(colors.green(`Relaunched session ${session.id}`));
      printSession();
      printSessionHistory();
      continue;
    }
    if (prompt === "/config") {
      const configs = listConfigEntries();
      const selectedIndex = await select({
        message: "Choose a Gecko config",
        choices: configs.map((config, index) => ({
          name: `${index + 1}. ${config.accountName ?? "unnamed"} · ${config.messageUrl ?? "no page"} · ${config.channel ? "conversation ready" : "no active conversation"}`,
          value: index,
        })),
      });
      const selected = configs[selectedIndex];
      console.log(colors.dim(`Starting a new ${selected.accountName ?? "Gecko"} conversation…`));
      client.close();
      session = store.create({ systemPrompt: session.systemPrompt, persist: false });
      session.systemPrompt = ensureGeikoIdentity(session.systemPrompt);
      const baseConfig = resolveSessionConfig(selected) ?? selected;
      client.config = mintConversation(baseConfig);
      client.setSessionContext({ sessionId: session.id, systemPrompt: session.systemPrompt, history: [], skills: HARNESS_SKILLS, localContext, tools: registry.manifest() });
      try {
        await client.connect();
        console.log(colors.green(`Connected to ${client.config.accountName ?? "Gecko"}; started fresh session ${session.id}`));
        printSession();
      } catch (error) {
        console.log(colors.red(`Unable to connect to selected config: ${error.message}`));
      }
      continue;
    }
    if (prompt === "/new") {
      const transport = { ...client.config };
      session = store.create({ systemPrompt: session.systemPrompt, persist: false });
      client.close();
      client.config = mintConversation(transport);
      client.setSessionContext({ sessionId: session.id, systemPrompt: session.systemPrompt, history: [], skills: HARNESS_SKILLS, localContext, tools: registry.manifest() });
      try {
        await client.connect();
        console.log(colors.green(`Started fresh session ${session.id}`));
        printSession();
      } catch (error) {
        console.log(colors.red(`Unable to start a new conversation: ${error.message}`));
      }
      continue;
    }
    if (prompt.startsWith("/resume ")) {
      const resumed = store.load(prompt.slice(8).trim());
      if (!resumed) console.log("Session not found.");
      else {
        session = resumed;
        if (session.gecko?.channel) {
          client.close();
          const sessionConfig = resolveSessionConfig(session.gecko);
          client.config = sessionConfig ? { ...sessionConfig } : { ...session.gecko };
          await client.connect();
        } else {
          client.close();
          client.config = {};
          console.log(colors.yellow("This session has no bound Gecko config. Choose /config before sending a message."));
        }
        client.setSessionContext({ sessionId: session.id, systemPrompt: session.systemPrompt, history: compactHistory(session.messages) });
        client.config.skills = HARNESS_SKILLS;
        client.config.localContext = localContext;
        client.config.tools = registry.manifest();
        printSession();
      }
      continue;
    }
    if (prompt === "/system" || prompt.startsWith("/system ")) {
      const selectedPrompt = prompt === "/system"
        ? await select({
          message: "Choose a system prompt",
          choices: [
            { name: "Coding", value: "coding" },
            { name: "Concise", value: "concise" },
            { name: "Debugging", value: "debugging" },
            { name: "Custom", value: "custom" },
          ],
        })
        : prompt.slice(8).trim();
      const customPrompt = selectedPrompt === "custom"
        ? await editor({ message: "Custom system prompt", instructions: "Save and close the editor when finished." })
        : selectedPrompt;
      session.systemPrompt = resolveSystemPrompt(customPrompt);
      client.setSessionContext({ sessionId: session.id, systemPrompt: session.systemPrompt, history: compactHistory(session.messages) });
      client.config.skills = HARNESS_SKILLS;
      client.config.localContext = localContext;
      client.config.tools = registry.manifest();
      store.save(session);
      console.log(`System prompt updated for ${session.id}`);
      continue;
    }
    if (ensureSessionTitle(session, prompt)) store.save(session);
    saveConversationProfile();
    store.save(session);
    client.sendMessage(prompt, {
      sessionId: session.id,
      systemPrompt: session.systemPrompt,
      history: compactHistory(session.messages),
      skills: HARNESS_SKILLS,
      localContext: { ...localContext, requestedFiles: registry.workspace.contextForRequest(prompt) },
      tools: registry.manifest(),
    });
    console.log();
  }
} finally {
  client.close();
}
