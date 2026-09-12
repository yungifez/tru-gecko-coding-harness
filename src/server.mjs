import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "./services/EventBus.mjs";
import { SessionService } from "./services/SessionService.mjs";
import { WorkspaceService } from "./services/WorkspaceService.mjs";
import { GeckoService } from "./services/GeckoService.mjs";
import { ConversationController } from "./controllers/ConversationController.mjs";
import { SessionController } from "./controllers/SessionController.mjs";
import { WorkspaceController } from "./controllers/WorkspaceController.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "../public");
const viewsRoot = path.join(root, "../views");
const events = new EventBus();
const sessions = new SessionService();
let gecko;
const workspace = new WorkspaceService(process.cwd(), () => gecko?.session ?? null);
gecko = new GeckoService({ sessions, workspace, events });
const conversation = new ConversationController({ gecko, sessions });
const session = new SessionController({ sessions, gecko });
const workspaceController = new WorkspaceController({ workspace });
const sseClients = new Set();

function body(request) {
  return new Promise((resolve, reject) => {
    let value = "";
    request.on("data", (chunk) => {
      value += chunk;
      if (value.length > 2_000_000) reject(new Error("Request body is too large"));
    });
    request.on("end", () => {
      try { resolve(value ? JSON.parse(value) : {}); } catch { reject(new Error("Request body must be JSON")); }
    });
    request.on("error", reject);
  });
}

function responseAdapter(response) {
  return {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); },
    error(code, message) { response.statusCode = code; this.json({ error: message }); },
  };
}

function serveStatic(response, filePath, contentType) {
  try {
    response.setHeader("Content-Type", contentType);
    response.end(fs.readFileSync(filePath));
  } catch { response.statusCode = 404; response.end("Not found"); }
}

events.subscribe((event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(payload);
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "GET" && url.pathname === "/") return serveStatic(response, path.join(viewsRoot, "index.html"), "text/html; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/assets/app.js") return serveStatic(response, path.join(publicRoot, "app.js"), "text/javascript; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/assets/app.css") return serveStatic(response, path.join(publicRoot, "app.css"), "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/assets/setup.css") return serveStatic(response, path.join(publicRoot, "setup.css"), "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    sseClients.add(response);
    request.on("close", () => sseClients.delete(response));
    return;
  }

  const api = responseAdapter(response);
  try {
    if (request.method === "GET" && url.pathname === "/api/state") return conversation.state(request, api);
    if (request.method === "GET" && url.pathname === "/api/conversation/history") return conversation.history(request, api);
    if (request.method === "GET" && url.pathname === "/api/sessions") return session.index(request, api);
    if (request.method === "GET" && url.pathname === "/api/workspace/context") return workspaceController.context(request, api);
    if (request.method === "GET" && url.pathname === "/api/tools") return workspaceController.tools(request, api);
    if (request.method === "POST" && url.pathname === "/api/messages") { request.body = await body(request); return conversation.send(request, api); }
    if (request.method === "POST" && url.pathname === "/api/conversation/start") { request.body = await body(request); return conversation.start(request, api); }
    if (request.method === "POST" && url.pathname === "/api/sessions") { request.body = await body(request); return session.create(request, api); }
    if (request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/resume")) {
      request.params = { id: url.pathname.split("/")[3] };
      return conversation.resume(request, api);
    }
    if (request.method === "POST" && url.pathname === "/api/system-prompt") { request.body = await body(request); return conversation.systemPrompt(request, api); }
    if (request.method === "POST" && url.pathname === "/api/tools/invoke") { request.body = await body(request); return workspaceController.invoke(request, api); }
    response.statusCode = 404; response.end("Not found");
  } catch (error) {
    response.error?.(500, error.message) ?? (response.statusCode = 500, response.end(error.message));
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, async () => {
  console.log(`Geiko Bot harness UI: http://localhost:${port}`);
  try { await gecko.boot(process.env.GECKO_SESSION_ID ?? null); }
  catch (error) { console.error(`Gecko connection failed: ${error.message}`); events.publish({ type: "connection", connected: false, error: error.message }); }
});
