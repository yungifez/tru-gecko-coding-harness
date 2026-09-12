import { WorkspaceTools } from "./workspace-tools.mjs";
import { WebSearch } from "./web-search.mjs";

export class ToolRegistry {
  constructor({ workspace = new WorkspaceTools(), webSearch = new WebSearch(), onResult = null, sessionProvider = () => null } = {}) {
    this.workspace = workspace;
    this.webSearch = webSearch;
    this.onResult = onResult;
    this.sessionProvider = sessionProvider;
    this.tools = new Map();
    this.registerDefaults();
  }

  register(name, description, handler, { requiresApproval = false } = {}) {
    this.tools.set(name, { name, description, handler, requiresApproval });
  }

  registerDefaults() {
    this.register("workspace.list_files", "List visible workspace files.", (args) => this.workspace.listFiles(args));
    this.register("workspace.read_file", "Read a bounded range from a workspace file.", (args) => this.workspace.readFile(args));
    this.register("workspace.write_file", "Create or modify one bounded workspace file after the user requests that change.", (args) => this.workspace.writeFile(args));
    this.register("workspace.search", "Search visible workspace text with a regular expression.", (args) => this.workspace.search(args));
    this.register("workspace.git_diff", "Show the current Git diff.", (args) => this.workspace.gitDiff(args));
    this.register("workspace.git_status", "Show Git status.", () => this.workspace.gitStatus());
    this.register("workspace.run_script", "Run a named npm package script.", (args) => this.workspace.runScript(args));
    this.register("workspace.inspect_logs", "Read local harness logs with secrets redacted.", (args) => this.workspace.inspectLogs(args));
    this.register("workspace.apply_patch", "Apply a checked unified Git patch.", (args) => this.workspace.applyPatch(args), { requiresApproval: true });
    this.register("session.active", "Show the active session ID and recent state.", () => {
      const session = this.sessionProvider();
      return session ? { id: session.id, systemPrompt: session.systemPrompt, messageCount: session.messages.length, recent: session.messages.slice(-8) } : null;
    });
    this.register("gecko.interpret_event", "Classify a Gecko event and identify its relevant fields.", ({ event, data = {} } = {}) => ({
      event,
      category: event?.includes("Typing") || event === "botTyping" ? "typing" : event?.includes("Stream") ? "stream" : event?.includes("conversation") ? "lifecycle" : event?.includes("message") || event?.includes("Message") ? "message" : "protocol",
      messageId: data.messageId ?? data.message?.id ?? null,
      textPresent: Boolean(data.entryText ?? data.message?.entryText),
    }));
    this.register("network.diagnostics", "Inspect or safely check configured Gecko endpoints without credentials.", async ({ endpoints = null, check = false } = {}) => {
      const list = endpoints ?? ["https://api-ca.geckoform.com/conversations/socket/auth", "https://mytru.tru.ca/", "wss://ws-mt1.pusher.com/"];
      const safe = list.map((endpoint) => {
        const url = new URL(endpoint);
        if (!["api-ca.geckoform.com", "mytru.tru.ca", "ws-mt1.pusher.com"].includes(url.hostname)) {
          throw new Error(`Network diagnostics do not allow host: ${url.hostname}`);
        }
        return { endpoint: `${url.protocol}//${url.host}${url.pathname}`, protocol: url.protocol, host: url.host, pathname: url.pathname };
      });
      if (!check) return safe;
      return Promise.all(safe.filter(({ protocol }) => protocol === "http:" || protocol === "https:").map(async (item) => {
        try {
          const response = await fetch(`${item.endpoint}?diagnostic=1`, { method: "GET", signal: AbortSignal.timeout(8_000) });
          return { ...item, status: response.status, ok: response.ok };
        } catch (error) {
          return { ...item, ok: false, error: error.message };
        }
      }));
    });
    this.register("web.search", "Search the public web and return bounded titles, URLs, and snippets.", (args) => this.webSearch.search(args));
  }

  manifest() {
    return [...this.tools.values()].map(({ name, description, requiresApproval }) => ({ name, description, requiresApproval }));
  }

  async invoke(name, args = {}, { approved = false } = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      const record = { tool: name, ok: false, error: `Unknown tool: ${name}`, timestamp: new Date().toISOString() };
      this.onResult?.(record);
      return record;
    }
    try {
      if (tool.requiresApproval && !approved) throw new Error(`Tool requires approval: ${name}`);
      const result = await tool.handler(args);
      const record = { tool: name, ok: true, result, timestamp: new Date().toISOString() };
      this.onResult?.(record);
      return record;
    } catch (error) {
      const record = { tool: name, ok: false, error: error.message, timestamp: new Date().toISOString() };
      this.onResult?.(record);
      return record;
    }
  }
}
