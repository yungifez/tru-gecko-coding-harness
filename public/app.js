const state = { session: null, messages: new Map(), streaming: new Map() };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char])); }
function formatTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; }

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  const code = [];
  html = html.replace(/`([^`]+)`/g, (_match, content) => { code.push(`<code>${content}</code>`); return `\u0000${code.length - 1}\u0000`; });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => code[Number(index)]);
}

function markdownToHtml(value) {
  const lines = String(value).replace(/\r/g, "").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { const tag = list.ordered ? "ol" : "ul"; output.push(`<${tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`); list = null; } };
  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) { if (code) { output.push(`<pre><code${code.language ? ` class="language-${escapeHtml(code.language)}"` : ""}>${escapeHtml(code.lines.join("\n"))}</code></pre>`); code = null; } else { flushParagraph(); flushList(); code = { language: fence[1], lines: [] }; } continue; }
    if (code) { code.lines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flushParagraph(); flushList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    const item = line.match(/^\s*([-*+] |\d+[.)] )(.*)$/);
    if (item) { flushParagraph(); const ordered = /^\d/.test(item[1]); if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; } list.items.push(item[2]); continue; }
    flushList(); paragraph.push(line);
  }
  if (code) output.push(`<pre><code${code.language ? ` class="language-${escapeHtml(code.language)}"` : ""}>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  flushParagraph(); flushList();
  return output.join("");
}

function renderMessage(message, streaming = false) {
  if (!message?.content) return;
  const id = message.messageId ?? `${message.role}-${message.timestamp ?? Date.now()}-${message.content.slice(0, 12)}`;
  const existing = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  const body = message.role === "user" ? `<p>${escapeHtml(message.content).replace(/\n/g, "<br>")}</p>` : markdownToHtml(message.content);
  const html = `<div class="avatar">${message.role === "user" ? "YU" : "GB"}</div><div class="message-body"><div class="message-meta">${message.role === "user" ? "You" : "Geiko Bot"} · ${formatTime(message.timestamp)}</div>${body}</div>`;
  if (existing) { existing.innerHTML = html; existing.classList.toggle("streaming", streaming); }
  else { const element = document.createElement("div"); element.className = `message ${message.role} ${streaming ? "streaming" : ""}`; element.dataset.messageId = id; element.innerHTML = html; $("#messages").append(element); }
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function renderSessions(sessions) {
  $("#sessions").innerHTML = sessions.map((item) => `<button class="session ${item.id === state.session?.id ? "active" : ""}" data-session="${item.id}">${escapeHtml(item.title ?? "Untitled session")}<small>${item.messages.length} messages · ${formatTime(item.updatedAt)}</small></button>`).join("");
  document.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => resume(button.dataset.session)));
}

function renderContext(workspace) {
  $("#inspector-content").innerHTML = `<div class="info-group"><h3>RUNTIME</h3><div class="info-row"><span>Package</span><span>${escapeHtml(workspace.package ?? "unknown")}</span></div><div class="info-row"><span>Node</span><span>${escapeHtml(workspace.node)}</span></div><div class="info-row"><span>Platform</span><span>${escapeHtml(workspace.platform)}</span></div></div><div class="info-group"><h3>SCRIPTS</h3><div class="file-list">${Object.keys(workspace.scripts ?? {}).map(escapeHtml).join("<br>") || "None"}</div></div><div class="info-group"><h3>FILES</h3><div class="file-list">${(workspace.files ?? []).map(escapeHtml).join("<br>")}</div></div>`;
}
function renderSetup(data) { $("#conversation-setup").classList.toggle("hidden", !data.needsConversation); }

async function getJson(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Request failed"); return data; }
async function loadState() { const data = await getJson("/api/state"); state.session = data.session; $("#session-title").textContent = state.session?.id?.slice(-12) ?? "Geiko Bot"; $("#messages").innerHTML = ""; (state.session?.messages ?? []).filter((message) => message.role === "user" || message.role === "assistant").forEach((message) => renderMessage(message)); renderContext(data.workspace); renderSetup(data); setConnection(data.connected); const sessions = await getJson("/api/sessions"); renderSessions(sessions); }
async function loadRemoteHistory() { const data = await getJson("/api/conversation/history"); $("#messages").innerHTML = ""; data.messages.forEach((message, index) => renderMessage({ ...message, messageId: `remote-${index}-${message.timestamp}` })); }
function setConnection(connected) { $("#connection-dot").classList.toggle("online", connected); $("#connection-label").textContent = connected ? "Gecko connected" : "Disconnected"; }
async function resume(id) { await getJson(`/api/sessions/${id}/resume`, { method: "POST" }); await loadState(); }
async function send(content) { await getJson("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); }

$("#composer").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#message-input"); const content = input.value.trim(); if (!content) return; input.value = ""; try { await send(content); } catch (error) { renderMessage({ role: "assistant", content: `Error: ${error.message}` }); } });
$("#message-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } });
$("#new-session").addEventListener("click", async () => { await getJson("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); await loadState(); });
$("#context-button").addEventListener("click", () => $("#inspector").classList.toggle("hidden"));
$("#history-button").addEventListener("click", async () => { try { await loadRemoteHistory(); } catch (error) { renderMessage({ role: "assistant", content: `Unable to load remote history: ${error.message}` }); } });
$("#close-inspector").addEventListener("click", () => $("#inspector").classList.add("hidden"));
$("#setup-form").addEventListener("submit", async (event) => { event.preventDefault(); const conversationId = $("#conversation-id").value.trim(); const channel = $("#conversation-channel").value.trim(); try { await getJson("/api/conversation/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, channel }) }); await loadState(); } catch (error) { window.alert(error.message); } });
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#message-input").value = button.dataset.prompt; $("#message-input").focus(); }));

const source = new EventSource("/events");
source.onmessage = (event) => { const data = JSON.parse(event.data); if (data.type === "connection") setConnection(data.connected); if (data.type === "message") { renderMessage(data.message); loadState(); } if (data.type === "gecko_event") { if (data.event === "botTyping") document.body.classList.toggle("bot-typing", Boolean(data.data?.typing)); if (data.event === "botMessageStreamed") { const id = data.data?.messageId ?? data.data?.message?.id; const text = data.data?.entryText ?? data.data?.message?.entryText; if (id && text) { const previous = state.streaming.get(id) ?? ""; const current = previous && text.startsWith(previous) ? text : previous + text; state.streaming.set(id, current); renderMessage({ role: "assistant", content: current, messageId: id }, true); } } if (data.event === "botMessageStreamCompleted") { const id = data.data?.messageId ?? data.data?.message?.id; state.streaming.delete(id); } } };
loadState().catch((error) => renderMessage({ role: "assistant", content: `Unable to load harness: ${error.message}` }));
