#!/usr/bin/env node
import blessed from "blessed";
import { spawnSync } from "node:child_process";
import { GeckoClient } from "./gecko-client.mjs";
import { resolveSystemPrompt, ensureGeikoIdentity, compactHistory } from "./prompts.mjs";
import { SessionStore } from "./session-store.mjs";
import { HARNESS_SKILLS, collectLocalContext } from "./local-context.mjs";
import { ToolRegistry } from "./tool-registry.mjs";
import { cleanHarnessContent, fetchTranscript } from "./gecko-transcript.mjs";
import { ensureSessionTitle } from "./session-title.mjs";
import { parseToolCall, TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from "./geiko-tool-calls.mjs";
import { listConfigEntries, resolveSessionConfig, normalizeConfig } from "./config.mjs";
import { markdownToTerminal } from "./markdown.mjs";
import { mintConversation } from "./new-conversation.mjs";

const args = new Set(process.argv.slice(2));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
};

const screen = blessed.screen({ smartCSR: true, fullUnicode: true, mouse: true, title: "Geiko Bot" });
const header = blessed.box({ top: 0, left: 0, width: "100%", height: 2, tags: true, padding: { left: 3, right: 2 }, content: "{cyan-fg}{bold}Geiko Bot{/bold}{/cyan-fg}  {gray-fg}independent coding harness{/gray-fg}" });
// The conversation wraps its own rows (see renderConversation) so mouse rows map
// to selectable text. autoFocus: false stops clicks from taking focus away from
// the composer.
const conversation = blessed.box({ top: 2, left: 0, right: 0, bottom: 6, tags: true, wrap: false, scrollable: true, alwaysScroll: true, keys: true, mouse: true, autoFocus: false, padding: { left: 3, right: 3, top: 1, bottom: 1 } });
// The composer keypress handler below edits the value directly. blessed's
// readInput() loop is not used: it attaches its key listener on a later tick and
// can leave a second listener behind, which types every key twice.
const composer = blessed.textarea({ bottom: 2, left: 1, right: 1, height: 4, keys: false, mouse: false, input: true, inputOnFocus: false, scrollable: true, padding: { left: 2, right: 2, top: 0 }, border: { type: "line" }, style: { fg: "white", bg: "#242424", border: { fg: "#4b4b4b" }, focus: { fg: "white", bg: "#242424", border: { fg: "#8b8b8b" } } }, label: " ›  message · Enter to send · Ctrl+C to exit " });
const footer = blessed.box({ bottom: 0, left: 0, width: "100%", height: 2, tags: true, padding: { left: 3 }, content: "{gray-fg}Connecting…  ·  /menu actions  ·  /history remote transcript  ·  /sessions switch session{/gray-fg}" });
const commandSuggestions = blessed.box({ bottom: 6, left: 3, right: 3, height: 1, hidden: true, tags: true, padding: { left: 1, right: 1 }, border: { type: "line" }, label: " Commands · Tab to complete ", style: { border: { fg: "#596780" }, bg: "#171b25", selected: { fg: "white", bg: "#5146b8" } } });
const slashCommands = ["/help", "/menu", "/compose", "/history", "/sessions", "/config", "/new", "/resume", "/clear", "/rename", "/status", "/doctor", "/context", "/tools", "/refresh", "/system", "/test", "/websearch", "/google", "/exit"];
screen.append(header); screen.append(conversation); screen.append(composer); screen.append(footer);
screen.append(commandSuggestions);

const store = new SessionStore();
const requestedSessionId = valueAfter("--session") ?? process.env.GECKO_SESSION_ID;
const restoreRemoteHistory = Boolean(requestedSessionId || args.has("--resume") || process.env.GECKO_RESUME === "1");
let session = requestedSessionId ? store.load(requestedSessionId) : store.create({ systemPrompt: resolveSystemPrompt(valueAfter("--system-prompt") ?? "coding"), persist: false });
if (!session) throw new Error(`Session not found: ${requestedSessionId}`);
const registry = new ToolRegistry({
  sessionProvider: () => session,
  onResult: (result) => {
    if (session.messages.some(({ role }) => role === "user")) {
      store.append(session, { role: "tool", content: JSON.stringify(result), tool: result.tool });
    }
  },
});
let localContext = collectLocalContext();
let loadingStartedAt = null;
let loadingTimer = null;
let loadingStopTimer = null;
let connectionFooter = "Connecting…  ·  /menu actions  ·  /history remote transcript  ·  drag to select · Ctrl+C copy";
const toolActivityLines = new Map();
const inputHistory = [];
let historyIndex = -1;
let workMarkerShown = false;
let cancelledTurn = false;
const conversationLines = [];
// Rendered rows. Each row is a { line, start, end } slice of one line's body.
let conversationRows = [];
let selectionAnchor = null;
let selectionFocus = null;
let selecting = false;
let selectionDragged = false;

const STYLE_TAG = /\{\/?(?:(?:light-|bright-)?(?:black|red|green|yellow|blue|magenta|cyan|white|gray|grey|default)-(?:fg|bg)|#[0-9a-f]{3,6}-(?:fg|bg)|bold|underline|blink|inverse|invisible)\}|\{\/\}/gi;

// Remove only blessed style tags. Braces in code and JSON are conversation text.
function plainConversationText(value) {
  return String(value)
    .replace(STYLE_TAG, "")
    .replace(/\{open\}/g, "{")
    .replace(/\{close\}/g, "}")
    .replace(/\t/g, "    ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

const LINE_STYLES = [
  ["Geiko Bot", "{green-fg}{bold}", "{/bold}{/green-fg}"],
  ["⏺", "{yellow-fg}{bold}", "{/bold}{/yellow-fg}"],
  ["✔", "{green-fg}{bold}", "{/bold}{/green-fg}"],
  ["⚠", "{red-fg}{bold}", "{/bold}{/red-fg}"],
  ["─ Worked for", "{white-fg}", "{/white-fg}"],
];
// A "You:" line shows a "› " marker before the message. The marker is not
// selectable, so copied text is only the message.
function linePresentation(text) {
  if (text.startsWith("You:")) return { marker: "{cyan-fg}{bold}›{/bold}{/cyan-fg} ", indent: 2, body: text.slice(4).trimStart(), open: "{white-fg}", close: "{/white-fg}" };
  const [, open = "", close = ""] = LINE_STYLES.find(([prefix]) => text.startsWith(prefix)) ?? [];
  return { marker: "", indent: 0, body: text, open, close };
}

const charSize = (text, index) => (text.codePointAt(index) > 0xffff ? 2 : 1);

// Split text into rows of at most `width` terminal cells. Break after a space
// when possible. Each row is a [start, end) index range.
function wrapRows(text, width) {
  const rows = [];
  let start = 0;
  do {
    let end = start;
    let cells = 0;
    let breakAt = -1;
    while (end < text.length) {
      const cellWidth = blessed.unicode.charWidth(text, end);
      if (cells + cellWidth > width && end > start) break;
      cells += cellWidth;
      end += charSize(text, end);
      if (text[end - 1] === " ") breakAt = end;
    }
    if (end < text.length && breakAt > start) end = breakAt;
    rows.push([start, end]);
    start = end;
  } while (start < text.length);
  return rows;
}

// Index of the character at terminal cell `cell` of the row [start, end).
function indexAtCell(text, start, end, cell) {
  let index = start;
  let cells = 0;
  while (index < end) {
    const cellWidth = blessed.unicode.charWidth(text, index);
    if (cells + cellWidth > cell) break;
    cells += cellWidth;
    index += charSize(text, index);
  }
  return Math.min(index, Math.max(start, end - 1));
}

// Points are { line, column }, where column is the index of the character under
// the pointer. The range end includes the character at the far point.
function normalizedSelection() {
  if (!selectionAnchor || !selectionFocus) return null;
  const start = selectionAnchor.line < selectionFocus.line || (selectionAnchor.line === selectionFocus.line && selectionAnchor.column <= selectionFocus.column) ? selectionAnchor : selectionFocus;
  const last = start === selectionAnchor ? selectionFocus : selectionAnchor;
  const body = linePresentation(conversationLines[last.line] ?? "").body;
  return { start, end: { line: last.line, column: Math.min(body.length, last.column + (body.length ? charSize(body, last.column) : 0)) } };
}

// The selected [start, end) columns of one line, or null.
function selectedColumns(index, length) {
  const range = normalizedSelection();
  if (!range || index < range.start.line || index > range.end.line) return null;
  return [index === range.start.line ? range.start.column : 0, index === range.end.line ? range.end.column : length];
}

function selectedText() {
  const range = normalizedSelection();
  if (!range) return "";
  const lines = [];
  for (let index = range.start.line; index <= range.end.line; index += 1) {
    const { body } = linePresentation(conversationLines[index] ?? "");
    lines.push(body.slice(...selectedColumns(index, body.length)));
  }
  return lines.join("\n");
}

function clearSelection() {
  selectionAnchor = null;
  selectionFocus = null;
  selecting = false;
}

function renderRow({ line: index, start, end, first }) {
  const { marker, indent, body, open, close } = linePresentation(conversationLines[index]);
  const lead = first ? marker : " ".repeat(indent);
  const columns = selectedColumns(index, body.length);
  const from = columns ? Math.min(Math.max(columns[0], start), end) : end;
  const to = columns ? Math.min(Math.max(columns[1], start), end) : end;
  const highlighted = to > from
    ? `${blessed.escape(body.slice(start, from))}{black-fg}{yellow-bg}${blessed.escape(body.slice(from, to))}{/yellow-bg}{/black-fg}${blessed.escape(body.slice(to, end))}`
    : blessed.escape(body.slice(start, end));
  return `${lead}${open}${highlighted}${close}`;
}

function renderConversation({ preserveScroll = false } = {}) {
  const width = Math.max(1, conversation.width - conversation.iwidth);
  conversationRows = conversationLines.flatMap((text, index) => {
    const { indent, body } = linePresentation(text);
    return wrapRows(body, width - indent).map(([start, end], row) => ({ line: index, start, end, first: row === 0 }));
  });
  conversation.setContent(conversationRows.map(renderRow).join("\n"));
  if (!preserveScroll) conversation.setScrollPerc(100);
  screen.render();
}

function clearConversation() {
  conversationLines.length = 0;
  clearSelection();
  renderConversation();
}

// Appending and replacing lines keep the selection: line indexes do not move.
function line(text = "") {
  conversationLines.push(...plainConversationText(text).split("\n"));
  renderConversation({ preserveScroll: selecting });
}

function replaceLine(index, text) {
  if (index < 0 || index >= conversationLines.length) return;
  conversationLines[index] = plainConversationText(text).replace(/\n/g, " ");
  renderConversation({ preserveScroll: true });
}
screen.on("resize", () => renderConversation({ preserveScroll: true }));

function toolActivityLabel(call) {
  const args = call.arguments ?? {};
  if (call.name === "workspace.write_file") return `Edit ${args.path ?? "file"}`;
  if (call.name === "workspace.apply_patch") return "Apply code patch";
  if (call.name === "workspace.read_file") return `Read ${args.path ?? "file"}`;
  if (call.name === "workspace.list_files") return `List files${args.prefix ? ` in ${args.prefix}` : ""}`;
  if (call.name === "workspace.search") return `Search workspace for ${args.query ?? "pattern"}`;
  if (call.name === "workspace.run_script") return `Run npm ${args.name ?? "test"}`;
  if (call.name === "web.search") return `Search the web for ${args.query ?? "query"}`;
  if (call.name === "workspace.git_diff") return "Inspect Git diff";
  if (call.name === "workspace.git_status") return "Inspect Git status";
  if (call.name === "workspace.inspect_logs") return "Inspect harness logs";
  return call.name;
}

async function requestToolApproval(call) {
  const list = blessed.list({
    top: "center", left: "center", width: 58, height: 7, keys: true, vi: true, mouse: true,
    label: " Permission required ", border: { type: "line" },
    style: { border: { fg: "yellow" }, selected: { bg: "yellow", fg: "black" } },
    items: [`Allow once · ${toolActivityLabel(call)}`, "Deny"],
  });
  screen.append(list);
  list.focus();
  screen.render();
  return new Promise((resolve) => {
    let closed = false;
    const close = (approved) => {
      if (closed) return;
      closed = true;
      list.destroy();
      focusComposer();
      resolve(approved);
    };
    list.key(["escape", "q", "C-c"], () => close(false));
    list.once("select", (_item, index) => close(index === 0));
  });
}

function beginToolActivity(call) {
  conversationLines.push(plainConversationText(`⏺ ${toolActivityLabel(call)}`).replace(/\n/g, " "));
  renderConversation({ preserveScroll: selecting });
  return conversationLines.length - 1;
}

function setFooter(text) { footer.setContent(`{gray-fg}${blessed.escape(text)}{/gray-fg}`); screen.render(); }
function scrollConversation(amount) {
  conversation.scroll(amount);
  screen.render();
}
conversation.on("wheeldown", () => scrollConversation(4));
conversation.on("wheelup", () => scrollConversation(-4));

// Map a mouse position to a { line, column } point. childBase is the first
// visible row. getScroll() also counts the viewport height once scrolled.
function selectionPoint(mouse) {
  if (!conversationRows.length) return { line: 0, column: 0 };
  const top = conversation.lpos.yi + conversation.itop;
  const left = conversation.lpos.xi + conversation.ileft;
  const row = conversationRows[Math.max(0, Math.min(conversationRows.length - 1, conversation.childBase + mouse.y - top))];
  const { indent, body } = linePresentation(conversationLines[row.line]);
  return { line: row.line, column: indexAtCell(body, row.start, row.end, Math.max(0, mouse.x - left - indent)) };
}

function copySelection() {
  const text = selectedText();
  if (!text) return false;
  const commands = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
  let copied = false;
  for (const [command, commandArgs] of commands) {
    const result = spawnSync(command, commandArgs, { input: text, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    if (!result.error && result.status === 0) { copied = true; break; }
  }
  // OSC 52 also works in terminals that expose clipboard access through the terminal.
  try { screen.program.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`); copied = true; } catch {}
  setFooter(`${copied ? "Copied" : "Selected"} ${text.length} characters · Esc or click clears the selection`);
  focusComposer();
  return true;
}

function isConversationPoint(mouse) {
  const top = conversation.lpos.yi + conversation.itop;
  const bottom = conversation.lpos.yl - conversation.ibottom;
  return mouse.x >= conversation.lpos.xi && mouse.x < conversation.lpos.xl && mouse.y >= top && mouse.y < bottom;
}

// Menus, pickers, and the approval prompt are blessed lists.
const popupOpen = () => screen.focused?.type === "list" && !screen.focused.detached;

screen.on("mouse", (mouse) => {
  const leftPress = mouse.action === "mousedown" && mouse.button === "left";
  // Most terminals report a drag as repeated left mousedown events. blessed
  // turns them into mousemove only on VTE, so a press during a selection
  // extends the selection.
  if (selecting && (leftPress || mouse.action === "mousemove" || mouse.action === "mouseup")) {
    selectionFocus = selectionPoint(mouse);
    selectionDragged ||= selectionFocus.line !== selectionAnchor.line || selectionFocus.column !== selectionAnchor.column;
    if (mouse.action === "mouseup") {
      selecting = false;
      // A click without a drag clears the selection.
      if (!selectionDragged) clearSelection();
    }
    renderConversation({ preserveScroll: true });
    return;
  }
  if (!leftPress || popupOpen()) return;
  // A left click anywhere gives keyboard focus back to the composer.
  focusComposer();
  if (!isConversationPoint(mouse)) return;
  selecting = true;
  selectionDragged = false;
  selectionAnchor = selectionPoint(mouse);
  selectionFocus = selectionAnchor;
  renderConversation({ preserveScroll: true });
});
function startLoading() {
  if (loadingStartedAt || workMarkerShown) return;
  loadingStartedAt = Date.now();
  const update = () => {
    if (!loadingStartedAt) return;
    const seconds = ((Date.now() - loadingStartedAt) / 1000).toFixed(1);
    footer.setContent(`{yellow-fg}⠋ Geiko Bot is thinking… ${seconds}s{/yellow-fg}`);
    screen.render();
  };
  update();
  loadingTimer = setInterval(update, 100);
}
function stopLoading() {
  if (!loadingStartedAt) return;
  const seconds = ((Date.now() - loadingStartedAt) / 1000).toFixed(1);
  clearInterval(loadingTimer);
  loadingTimer = null;
  loadingStartedAt = null;
  workMarkerShown = true;
  line(`{white-fg}─ Worked for ${seconds}s ─{/white-fg}`);
  setFooter(connectionFooter);
}
function scheduleStopLoading() {
  clearTimeout(loadingStopTimer);
  loadingStopTimer = setTimeout(() => {
    loadingStopTimer = null;
    stopLoading();
  }, 0);
}
function cancelScheduledStop() {
  clearTimeout(loadingStopTimer);
  loadingStopTimer = null;
}

function cancelWorking() {
  const wasWorking = Boolean(loadingStartedAt || toolActivityLines.size);
  if (!wasWorking) return false;
  const seconds = loadingStartedAt ? ((Date.now() - loadingStartedAt) / 1000).toFixed(1) : "0.0";
  clearInterval(loadingTimer);
  loadingTimer = null;
  loadingStartedAt = null;
  cancelScheduledStop();
  toolActivityLines.clear();
  cancelledTurn = true;
  workMarkerShown = true;
  line(`{white-fg}─ Stopped after ${seconds}s ─{/white-fg}`);
  setFooter(`${connectionFooter} · stopped`);
  focusComposer();
  return true;
}
function updateCommandSuggestions() {
  const value = composer.getValue();
  const token = value.match(/^\/[^\s]*$/)?.[0];
  if (!token) {
    commandSuggestions.hide();
    return;
  }
  const matches = slashCommands.filter((command) => command.startsWith(token));
  if (!matches.length) {
    commandSuggestions.hide();
    return;
  }
  commandSuggestions.height = Math.min(matches.length + 2, 7);
  commandSuggestions.setContent(`{bold}{white-fg}› ${matches[0]}{/white-fg}{/bold}${matches.slice(1, 6).map((command) => `\n  {gray-fg}${command}{/gray-fg}`).join("")}`);
  commandSuggestions.show();
}
function completeCommand() {
  const value = composer.getValue();
  const token = value.match(/^\/[^\s]*/)?.[0];
  const match = slashCommands.find((command) => command.startsWith(token ?? ""));
  if (!match) return;
  composer.setValue(`${match} `);
  commandSuggestions.hide();
  screen.render();
}
// Popups keep focus until they close. Closing a popup calls this again.
function focusComposer() {
  if (popupOpen()) return;
  if (screen.focused !== composer) composer.focus();
  screen.render();
}
// Show the terminal cursor at the insertion point while the composer has focus.
composer.on("focus", () => screen.program.showCursor());
composer.on("blur", () => screen.program.hideCursor());
function showSession() { line(`{bold}${blessed.escape(session.title ?? "Untitled session")}{/bold}  {gray-fg}${session.id} · ${session.messages.length} messages{/gray-fg}`); }
function showHistory(messages) {
  for (const message of messages.filter(({ role }) => role === "user" || role === "assistant")) {
    const content = cleanHarnessContent(message.content);
    if (content) line(`${message.role === "assistant" ? "Geiko Bot" : "You"}: ${message.role === "assistant" ? markdownToTerminal(content) : content}`);
  }
}
function syncContext() {
  session.systemPrompt = ensureGeikoIdentity(session.systemPrompt);
  const tools = registry.manifest();
  client.setSessionContext({ sessionId: session.id, systemPrompt: session.systemPrompt, history: compactHistory(session.messages), skills: HARNESS_SKILLS, localContext, tools });
  if (args.has("--debug")) line(`{gray-fg}[debug] session context synced · prompt=${session.systemPrompt.length} chars · tools=${tools.length}{/gray-fg}`);
}

async function handleToolCall(message, existingActivityLine = null) {
  const call = parseToolCall(message.content);
  if (!call) return;
  const activityLine = existingActivityLine ?? beginToolActivity(call);
  setFooter(`Running ${call.name}…`);
  const manifestEntry = registry.manifest().find((tool) => tool.name === call.name);
  const approved = manifestEntry?.requiresApproval ? await requestToolApproval(call) : false;
  let result;
  try {
    result = await registry.invoke(call.name, call.arguments, { approved });
  } catch (error) {
    result = { tool: call.name, ok: false, error: error.message, timestamp: new Date().toISOString() };
  }
  if (cancelledTurn) return;
  replaceLine(activityLine, `${result.ok ? "✔" : "⚠"} ${toolActivityLabel(call)} ${result.ok ? "· done" : `· ${String(result.error).slice(0, 160)}`}`);
  const resultText = `[[GEIKO_TOOL_RESULT]]\n${JSON.stringify({ name: call.name, ...result })}\n[[/GEIKO_TOOL_RESULT]]`;
  client.sendMessage(resultText, {
    sessionId: session.id,
    systemPrompt: session.systemPrompt,
    history: compactHistory(session.messages),
    skills: HARNESS_SKILLS,
    localContext,
    tools: registry.manifest(),
  });
  setFooter(connectionFooter);
}

async function remoteHistory() {
  setFooter("Loading remote Gecko transcript…");
  const transcript = await fetchTranscript(client.config);
  clearConversation();
  showSession();
  showHistory(transcript.messages);
  setFooter(`Remote history · ${transcript.messages.length} messages  ·  /menu actions`);
}

function saveConversationProfile() {
  session.gecko = normalizeConfig(client.config);
}

async function activateSession(nextSession) {
  const transport = { ...client.config };
  session = nextSession;
  const sessionConfig = session.gecko?.channel ? resolveSessionConfig(session.gecko) : null;
  client.close();
  // A saved session reconnects to its conversation; a fresh session starts a
  // new remote conversation on the current transport with a generated ULID.
  client.config = sessionConfig?.channel ? { ...sessionConfig } : mintConversation(transport);
  try {
    await client.connect();
    connectionFooter = sessionConfig?.channel
      ? `Connected · ${client.config.accountName ?? "Gecko"} · drag to select · Ctrl+C copy`
      : `Connected · ${client.config.accountName ?? "Gecko"} · fresh session · /menu actions`;
  } catch (error) {
    connectionFooter = `Connection failed: ${error.message}`;
    line(`Unable to connect: ${error.message}`);
  }
  syncContext();
  clearConversation();
  showSession();
  if (session.gecko?.channel) await remoteHistory().catch(() => showHistory(session.messages));
  else showHistory(session.messages);
  setFooter(connectionFooter);
}

async function requestContext(prompt) {
  const context = {
    ...localContext,
    requestedFiles: registry.workspace.contextForRequest(prompt),
  };
  const explicitScript = prompt.match(/\bnpm\s+run\s+([a-z0-9:_-]+)/i)?.[1]
    ?? (/\b(?:run|execute|perform|do|try|start|check|can\s+you)\b[\s\S]*\btests?\b/i.test(prompt) || /\bnpm\s+test\b/i.test(prompt) ? "test" : null);
  if (explicitScript) {
    const result = await registry.invoke("workspace.run_script", { name: explicitScript });
    context.commandResults = [{ script: explicitScript, ...(result.result ?? { error: result.error }) }];
  }
  return context;
}

async function chooseSession() {
  const sessions = store.list().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const list = blessed.list({ top: "center", left: "center", width: "70%", height: "60%", keys: true, vi: true, mouse: true, label: " Relaunch session ", border: { type: "line" }, style: { border: { fg: "#7c6cff" }, selected: { bg: "#7c6cff", fg: "white" } }, items: sessions.map((item) => `${item.title ?? "Untitled session"} · ${item.messages.length} messages`) });
  screen.append(list); list.focus(); screen.render();
  await new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      list.destroy();
      focusComposer();
      resolve();
    };
    list.key(["escape", "q", "C-c"], close);
    list.once("select", async (_item, index) => {
      if (closed) return;
      closed = true;
      const loaded = store.load(sessions[index].id);
      list.destroy();
      focusComposer();
      await activateSession(loaded);
      resolve();
    });
  });
}

async function chooseConfig() {
  const configs = listConfigEntries();
  const list = blessed.list({
    top: "center", left: "center", width: "78%", height: Math.min(configs.length + 4, 14),
    keys: true, vi: true, mouse: true, label: " Select config · starts a fresh session ", border: { type: "line" },
    style: { border: { fg: "#7c6cff" }, selected: { bg: "#7c6cff", fg: "white" } },
    items: configs.map((config, index) => `${index + 1}. ${config.accountName ?? "unnamed"} · ${config.messageUrl ?? "no page"} · ${config.channel ? "conversation ready" : "no active conversation"}`),
  });
  screen.append(list); list.focus(); screen.render();
  await new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      list.destroy();
      focusComposer();
      resolve();
    };
    list.key(["escape", "q", "C-c"], close);
    list.once("select", async (_item, index) => {
      if (closed) return;
      const selected = configs[index];
      closed = true;
      list.destroy();
      setFooter(`Starting a new ${selected.accountName ?? "Gecko"} conversation…`);
      client.close();
      session = store.create({ systemPrompt: session.systemPrompt, persist: false });
      const baseConfig = resolveSessionConfig(selected) ?? selected;
      client.config = mintConversation(baseConfig);
      syncContext();
      clearConversation();
      showSession();
      cancelledTurn = false;
      workMarkerShown = false;
      try {
        await client.connect();
        connectionFooter = `Connected · ${client.config.accountName ?? "Gecko"} · fresh session · /menu actions`;
        setFooter(connectionFooter);
      } catch (error) {
        connectionFooter = `Connection failed: ${error.message}`;
        setFooter(connectionFooter);
        line(`Unable to connect to selected config: ${error.message}`);
      }
      focusComposer();
      resolve();
    });
  });
}

async function menu() {
  const choices = ["Compose message", "Remote history", "Relaunch session", "Gecko config", "New session", "Workspace context", "Tools", "Close"];
  const list = blessed.list({ top: "center", left: "center", width: 38, height: choices.length + 4, keys: true, vi: true, mouse: true, label: " Actions ", border: { type: "line" }, style: { border: { fg: "#7c6cff" }, selected: { bg: "#7c6cff", fg: "white" } }, items: choices });
  screen.append(list); list.focus(); screen.render();
  await new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      list.destroy();
      focusComposer();
      resolve();
    };
    list.key(["escape", "q", "C-c"], close);
    list.once("select", async (_item, index) => {
      if (closed) return;
      closed = true;
      list.destroy();
      if (index === 0) focusComposer();
      if (index === 1) await remoteHistory().catch((error) => line(`History error: ${error.message}`));
      if (index === 2) await chooseSession();
      if (index === 3) await chooseConfig();
      if (index === 4) { const fresh = store.create({ systemPrompt: session.systemPrompt, persist: false }); await activateSession(fresh); }
      if (index === 5) line(JSON.stringify(localContext, null, 2));
      if (index === 6) line(JSON.stringify(registry.manifest(), null, 2));
      focusComposer();
      resolve();
      screen.render();
    });
  });
}

async function handleInput(value) {
  const prompt = value.trim();
  if (!prompt) return;
  if (prompt === "/exit") return quit();
  if (prompt === "/help") return line([
    "Commands",
    "  /menu                 open actions",
    "  /history              load the remote transcript",
    "  /sessions             switch to a saved session",
    "  /new                  start a fresh unsaved session",
    "  /clear                clear the visible transcript",
    "  /rename NAME          name the current session",
    "  /status               show session and connection state",
    "  /doctor               diagnose connection and harness state",
    "  /context              show workspace context",
    "  /tools                show callable tools",
    "  /test [script]        run a package script",
    "  /websearch QUERY      search the web",
    "  /google QUERY         create a Google search URL",
    "  Ctrl+C                copy selection, stop work, or exit",
  ].join("\n"));
  if (prompt === "/menu") return menu();
  if (prompt === "/history") return remoteHistory().catch((error) => line(`History error: ${error.message}`));
  if (prompt === "/sessions") return chooseSession();
  if (prompt === "/config") return chooseConfig();
  if (prompt === "/new") {
    const fresh = store.create({ systemPrompt: session.systemPrompt, persist: false });
    await activateSession(fresh);
    return;
  }
  if (prompt === "/clear") { clearConversation(); showSession(); return; }
  if (prompt.startsWith("/rename ")) {
    const title = prompt.slice(8).trim().slice(0, 64);
    if (!title) return line("Usage: /rename NAME");
    session.title = title;
    if (session.messages.length) store.save(session);
    clearConversation();
    showSession();
    return;
  }
  if (prompt === "/status") return line(JSON.stringify({ sessionId: session.id, title: session.title, messages: session.messages.length, connected: client.subscribed, cancelledTurn }, null, 2));
  if (prompt === "/doctor") {
    const diagnostics = await registry.invoke("network.diagnostics", { check: true });
    return line(JSON.stringify({ sessionId: session.id, connected: client.connected, subscribed: client.subscribed, account: client.config.accountName ?? null, channel: client.config.channel ?? null, diagnostics: diagnostics.result ?? diagnostics.error }, null, 2));
  }
  if (prompt.startsWith("!")) {
    const command = prompt.slice(1).trim().match(/^npm\s+run\s+([a-z0-9:_-]+)$/i);
    if (!command) return line("Only !npm run SCRIPT is allowed.");
    const result = await registry.invoke("workspace.run_script", { name: command[1] });
    return line(result.result?.output ?? result.error);
  }
  if (prompt === "/context") return line(JSON.stringify(localContext, null, 2));
  if (prompt === "/tools") return line(JSON.stringify(registry.manifest(), null, 2));
  if (prompt.startsWith("/read ")) { const result = await registry.invoke("workspace.read_file", { path: prompt.slice(6).trim() }); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt === "/files" || prompt.startsWith("/files ")) { const result = await registry.invoke("workspace.list_files", { prefix: prompt.slice(6).trim() }); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt.startsWith("/search ")) { const result = await registry.invoke("workspace.search", { query: prompt.slice(8).trim() }); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt.startsWith("/websearch ")) { const result = await registry.invoke("web.search", { query: prompt.slice(11).trim() }); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt.startsWith("/google ")) { const result = await registry.invoke("web.search", { query: prompt.slice(8).trim() }); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt === "/diff") { const result = await registry.invoke("workspace.git_diff"); return line(result.result ?? result.error); }
  if (prompt === "/logs") { const result = await registry.invoke("workspace.inspect_logs"); return line(JSON.stringify(result.result ?? result.error, null, 2)); }
  if (prompt === "/refresh") { localContext = collectLocalContext(); syncContext(); return setFooter("Workspace context refreshed · /menu actions"); }
  if (prompt.startsWith("/resume ")) {
    const next = store.load(prompt.slice(8).trim());
    if (!next) return line("Session not found.");
    await activateSession(next);
    return;
  }
  if (prompt.startsWith("/test")) { const result = await registry.invoke("workspace.run_script", { name: prompt.slice(5).trim() || "test" }); return line(result.result?.output ?? result.error); }
  ensureSessionTitle(session, prompt);
  saveConversationProfile();
  cancelledTurn = false;
  workMarkerShown = false;
  line(`You: ${prompt}`);
  store.save(session);
  client.sendMessage(prompt, { sessionId: session.id, systemPrompt: session.systemPrompt, history: compactHistory(session.messages), skills: HARNESS_SKILLS, localContext: await requestContext(prompt), tools: registry.manifest() });
}

function quit() { client.close(); screen.destroy(); process.exit(0); }
// Ctrl+C copies a selection first, so a running reply cannot block copying.
function handleCopyOrQuit() {
  if (popupOpen()) return; // Popups close themselves on Ctrl+C.
  if (copySelection()) return;
  if (cancelWorking()) return;
  quit();
}
screen.key(["C-c"], handleCopyOrQuit);
screen.key(["pageup"], () => scrollConversation(-6));
screen.key(["pagedown"], () => scrollConversation(6));

function setComposerValue(value) {
  composer.setValue(value);
  updateCommandSuggestions();
  screen.render();
}

function submitComposer() {
  const value = composer.getValue();
  const submitted = value.trim();
  if (submitted && inputHistory.at(-1) !== submitted) inputHistory.push(submitted);
  historyIndex = -1;
  setComposerValue("");
  handleInput(value)
    .catch((error) => line(`Error: ${error.message}`))
    .finally(focusComposer);
}

// This is the only handler that edits the composer. Screen keys (Ctrl+C,
// Page Up, Page Down) also arrive here and are ignored.
composer.on("keypress", (ch, key) => {
  const value = composer.getValue();
  if (key.name === "up" && !key.ctrl && !value.includes("\n")) {
    if (inputHistory.length) {
      historyIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
      setComposerValue(inputHistory[inputHistory.length - 1 - historyIndex]);
    }
    return;
  }
  if (key.name === "down" && !key.ctrl && !value.includes("\n")) {
    if (historyIndex > 0) {
      historyIndex -= 1;
      setComposerValue(inputHistory[inputHistory.length - 1 - historyIndex]);
    } else if (historyIndex === 0) {
      historyIndex = -1;
      setComposerValue("");
    }
    return;
  }
  if (key.ctrl && key.name === "up") return scrollConversation(-6);
  if (key.ctrl && key.name === "down") return scrollConversation(6);
  if (key.name === "tab" && value.startsWith("/")) return completeCommand();
  // The terminal Enter key ("\r") arrives as "enter" and then as "return".
  if (key.name === "return") return;
  if (key.name === "enter") return submitComposer();
  if (key.name === "linefeed") return setComposerValue(`${value}\n`); // Ctrl+J
  if (key.name === "escape") {
    clearSelection();
    commandSuggestions.hide();
    renderConversation({ preserveScroll: true });
    return;
  }
  if (key.name === "backspace") {
    const size = value.length >= 2 && blessed.unicode.isSurrogate(value, value.length - 2) ? 2 : 1;
    return setComposerValue(value.slice(0, value.length - size));
  }
  // Drop control characters, as blessed's textarea does.
  if (ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch)) setComposerValue(value + ch);
});

const client = new GeckoClient({
  debug: args.has("--debug"), sessionId: session.id, systemPrompt: session.systemPrompt,
  history: compactHistory(session.messages), skills: HARNESS_SKILLS, localContext, tools: registry.manifest(),
  output: (text) => {
    if (cancelledTurn) return;
    if (/^Geiko Bot is typing\.\.\.$|^Geiko Bot stopped typing\.$/.test(String(text))) return;
    if (!String(text).startsWith("[debug]") && (String(text).includes(TOOL_CALL_OPEN) || String(text).includes("[[GEIKO_TOOL"))) return;
    if (String(text).startsWith("You:")) return;
    line(text);
  },
  onMessage: (message) => {
    store.append(session, message);
    if (message.role === "assistant") {
      const toolCall = parseToolCall(message.content);
      if (cancelledTurn) return;
      if (toolCall) cancelScheduledStop();
      // Protocol-only messages clean to empty text and are not shown.
      const reply = toolCall ? "" : markdownToTerminal(cleanHarnessContent(message.content));
      if (reply) line(`Geiko Bot: ${reply}`);
      if (toolCall) {
        const activityLine = toolActivityLines.get(message.messageId) ?? null;
        toolActivityLines.delete(message.messageId);
        handleToolCall(message, activityLine).catch((error) => line(`Tool error: ${error.message}`));
      } else {
        // Render the final fallback message before closing the loading state.
        stopLoading();
      }
    }
  },
  onEvent: (event) => {
    if (event.event === "botTyping" && event.data?.typing && !cancelledTurn) startLoading();
    if (event.event === "botMessageStreamed") {
      const messageId = event.data?.messageId ?? event.data?.message?.id;
      const streamText = event.data?.message?.entryText ?? event.data?.entryText ?? "";
      const toolCall = parseToolCall(streamText);
      if (!cancelledTurn && messageId && toolCall && !toolActivityLines.has(messageId)) {
        toolActivityLines.set(messageId, beginToolActivity(toolCall));
        setFooter(`Running ${toolCall.name}…`);
      }
    }
    if (event.event === "botMessageStreamCompleted") {
      const text = cleanHarnessContent(event.data?.message?.entryText ?? event.data?.entryText ?? "");
      if (text && !parseToolCall(text)) scheduleStopLoading();
    }
  },
});
// A saved session owns its Gecko conversation. Apply it before the first
// socket connection so the randomly selected top-level profile cannot leak in.
if (session.gecko?.channel) {
  const sessionConfig = resolveSessionConfig(session.gecko);
  if (sessionConfig) client.config = { ...sessionConfig };
} else if (!requestedSessionId) {
  // A fresh session starts a new remote conversation instead of resuming the
  // profile's saved chat. The server accepts our client-generated ULID.
  client.config = mintConversation(client.config);
}
showSession(); showHistory(session.messages); focusComposer();
if (requestedSessionId && !session.gecko?.channel) {
  client.close();
  client.config = {};
  connectionFooter = "No Gecko config bound · /config to connect · /menu actions";
  setFooter(connectionFooter);
  line("This session has no bound Gecko config. Choose /config before sending a message.");
} else {
  connectionFooter = `Connected · ${client.config.accountName ?? "Gecko"} · /menu actions`;
  try {
    await client.connect();
    connectionFooter = `Connected · ${client.config.accountName ?? "Gecko"} · drag to select · Ctrl+C copy`;
    setFooter(connectionFooter);
    if (restoreRemoteHistory) await remoteHistory().catch(() => {});
  } catch (error) { connectionFooter = `Connection failed: ${error.message}`; setFooter(connectionFooter); line(`Unable to connect: ${error.message}`); }
}
focusComposer();
screen.render();
