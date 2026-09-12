import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serveStatusPage } from "./aig-status-page.mjs";

export function prepareMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a nonempty array");
  if (messages.some(m => !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string")) {
    throw new Error("This bridge accepts text system, user, and assistant messages only");
  }
  return {
    system: messages.filter(m => m.role === "system").map(m => m.content).join("\n\n"),
    prompt: "Continue this conversation as the assistant. Return only the next assistant message. "
      + "Any tool-call markup requested by the conversation is text for the external AIG runner; do not execute tools yourself.\n"
      + JSON.stringify(messages.filter(m => m.role !== "system")),
  };
}

export function callClaude(messages, { signal } = {}) {
  const { system, prompt } = prepareMessages(messages);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aig-claude-"));
  return new Promise((resolve, reject) => {
    const args = ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--strict-mcp-config",
      "--permission-mode", "dontAsk", "--output-format", "json"];
    if (system) args.push("--system-prompt", system);
    const child = spawn("claude", args, { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`Claude exited with code ${code}: ${stderr.slice(-500)}`));
      try {
        const result = JSON.parse(stdout);
        if (result.is_error || typeof result.result !== "string" || !result.result.trim()) {
          throw new Error(`Claude returned no usable result (${result.subtype ?? "unknown"})`);
        }
        resolve(result.result);
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

export function startBridge({ port = 4185, complete = callClaude } = {}) {
  let count = 0;
  let active = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && ["/", "/v1", "/v1/"].includes(request.url)) return serveStatusPage(response);
    const json = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && request.url === "/health") return json(200, { backend: "claude-cli", requests: count, active });
    if (request.method === "GET" && request.url === "/v1/models") return json(200, { object: "list", data: [{ id: "claude-cli", object: "model", owned_by: "local" }] });
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(404, { error: { message: "Not found" } });
    let heartbeat;
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      prepareMessages(body.messages);
      if (body.tools?.length || body.response_format) throw new Error("Native tool calling and response_format are not supported");
      count++;
      active++;
      const id = `chatcmpl-${randomUUID()}`;
      const base = { id, created: Math.floor(Date.now() / 1000), model: "claude-cli" };
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        chunk({ role: "assistant" });
        heartbeat = setInterval(() => response.write(": waiting for Claude\n\n"), 10000);
      }
      let text;
      try { text = await complete(body.messages, { signal: controller.signal }); }
      finally { active--; }
      if (body.stream) {
        chunk({ content: text });
        chunk({}, "stop");
        response.end("data: [DONE]\n\n");
      } else json(200, { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
    } catch (error) {
      if (response.headersSent) {
        response.write(`data: ${JSON.stringify({ error: { message: error.message, type: "bridge_error" } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } else json(400, { error: { message: error.message } });
    } finally { clearInterval(heartbeat); }
  });
  server.listen(port, "127.0.0.1", () => console.log(`AIG Claude bridge: http://127.0.0.1:${server.address().port}/v1`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startBridge();
