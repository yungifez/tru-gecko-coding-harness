import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GeckoClient } from "../src/gecko-client.mjs";
import { loadConfig } from "../src/config.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";
import { parseToolCall } from "../src/geiko-tool-calls.mjs";
import { resolveSystemPrompt } from "../src/prompts.mjs";
import { serveStatusPage } from "./aig-status-page.mjs";

export function createFixture(content = "The release date is 19 October 2026.") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tru-aig-case-"));
  fs.writeFileSync(path.join(root, "notes.txt"), content);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "aig-fixture", scripts: {} }));
  const registry = new ToolRegistry({ workspace: new WorkspaceTools(root) });
  // Record external actions without giving the test access to external sinks.
  for (const name of ["workspace.run_script", "network.diagnostics", "web.search"]) {
    const tool = registry.tools.get(name);
    tool.handler = () => { throw new Error("Intercepted by test fixture; no external action executed"); };
  }
  return { root, registry };
}

export async function runCase({ prompt, content, timeoutMs = 90000, Client = GeckoClient, config = loadConfig({ accountName: "tru" }) }) {
  const { root, registry } = createFixture(content);
  const trace = { id: randomUUID(), account: "tru", startedAt: new Date().toISOString(),
    workspace: root, remoteIsolation: "saved TRU conversation reused; prior server context may persist",
    prompt, messages: [], tools: [], events: {}, status: "running" };
  const context = { sessionId: trace.id, systemPrompt: resolveSystemPrompt("coding"), skills: [],
    tools: registry.manifest(), history: [], localContext: { root, files: ["notes.txt", "package.json"] } };
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  let completed = false;
  const end = (status, error) => {
    if (completed) return;
    completed = true;
    trace.status = status;
    if (error) trace.error = error;
    finish();
  };
  const client = new Client({ ...config, ...context, output: () => {},
    onEvent: ({ event, data }) => {
      trace.events[event] = (trace.events[event] ?? 0) + 1;
      if (event === "botMessageStreamCompleted") {
        trace.completionShape = { keys: Object.keys(data ?? {}), messageKeys: Object.keys(data?.message ?? {}),
          entryTextLength: String(data?.entryText ?? "").length,
          messageTextLength: String(data?.message?.entryText ?? "").length };
      }
    },
    onMessage: message => {
      if (completed || message.role !== "assistant") return;
      const text = String(message.content ?? "").replace(/\[\[HARNESS_(?:CONTINUE|ACK|CHUNK|DONE)\]\]/g, "").trim();
      if (!text) return;
      trace.messages.push({ role: "assistant", content: text });
      const call = parseToolCall(text);
      if (!call) { trace.reply = text; end("completed"); return; }
      const record = { ...call, approved: false, intercepted: ["workspace.run_script", "network.diagnostics", "web.search"].includes(call.name) };
      trace.tools.push(record);
      void registry.invoke(call.name, call.arguments).then(result => {
        record.result = result;
        if (completed) return;
        client.sendMessage(`[[GEIKO_TOOL_RESULT]]\n${JSON.stringify({ name: call.name, ...result })}\n[[/GEIKO_TOOL_RESULT]]`, context);
      }).catch(error => end("error", error.message));
    },
  });
  const timer = setTimeout(() => { end("timeout", "No completed response within the case deadline"); client.close(); }, timeoutMs);
  try {
    await Promise.race([client.connect(), done]);
    if (!completed) client.sendMessage(prompt, context);
    await done;
  } catch (error) { end("error", error.message); }
  finally { clearTimeout(timer); client.close(); }
  trace.finishedAt = new Date().toISOString();
  trace.fixtureFiles = registry.workspace.listFiles({});
  return trace;
}

export function startServer({ port = 4184, reportDir = path.resolve("reports/aig-tru") } = {}) {
  fs.mkdirSync(reportDir, { recursive: true });
  let busy = false;
  let cases = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") return serveStatusPage(response);
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && request.url === "/health") return send(200, { account: "tru", busy, cases });
    if (request.method !== "POST" || request.url !== "/chat") return send(404, { error: "Not found" });
    if (busy) return send(409, { error: "The TRU conversation is busy; retry serially" });
    busy = true;
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (typeof body.message !== "string" || !body.message.trim()) throw new Error("message must be a nonempty string");
      cases++;
      // AIG's HTTP provider times out at 30 seconds. Return before that
      // deadline so a stalled Gecko response cannot hold the adapter busy.
      const trace = await runCase({ prompt: body.message, timeoutMs: 25000 });
      fs.writeFileSync(path.join(reportDir, `${trace.id}.json`), JSON.stringify(trace, null, 2));
      send(trace.status === "completed" ? 200 : 502, { reply: trace.reply ?? "", status: trace.status, traceId: trace.id });
    } catch (error) { send(400, { error: error.message }); }
    finally { busy = false; }
  });
  server.listen(port, "127.0.0.1", () => console.log(`AIG TRU adapter: http://127.0.0.1:${server.address().port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
