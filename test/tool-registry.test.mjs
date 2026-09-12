import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../src/workspace-tools.mjs";
import { WebSearch, parseSearchResults } from "../src/web-search.mjs";

test("lists and invokes safe workspace tools", async () => {
  const registry = new ToolRegistry();
  assert.ok(registry.manifest().some((tool) => tool.name === "workspace.list_files"));
  const result = await registry.invoke("workspace.list_files", { prefix: "src/" });
  assert.equal(result.ok, true);
  assert.ok(result.result.includes("src/cli.mjs"));
});

test("requires approval before applying patches", async () => {
  const registry = new ToolRegistry();
  const result = await registry.invoke("workspace.apply_patch", { patch: "" });
  assert.equal(result.ok, false);
  assert.match(result.error, /requires approval/);
});

test("allows bounded requested file writes inside the workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-write-"));
  const registry = new ToolRegistry({ workspace: new WorkspaceTools(directory) });
  const result = await registry.invoke("workspace.write_file", { path: "lipsum.txt", content: "Lorem ipsum." });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(directory, "lipsum.txt"), "utf8"), "Lorem ipsum.");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("resolves @ file references into requested workspace context", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-context-"));
  fs.mkdirSync(path.join(directory, "src"));
  fs.writeFileSync(path.join(directory, "src", "app.mjs"), "export const app = true;\n");
  const files = new WorkspaceTools(directory).contextForRequest("review @src/app.mjs");
  assert.equal(files[0].path, "src/app.mjs");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("redacts secrets when inspecting logs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tru-gecko-logs-"));
  fs.mkdirSync(path.join(directory, "logs"));
  fs.writeFileSync(path.join(directory, "logs", "harness.log"), "auth=secret-value authorization: Bearer abc123\n");
  const logs = new WorkspaceTools(directory).inspectLogs();
  assert.match(logs[0].content, /REDACTED/);
  assert.doesNotMatch(logs[0].content, /secret-value|abc123/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("restricts network diagnostics to configured hosts", async () => {
  const registry = new ToolRegistry();
  const result = await registry.invoke("network.diagnostics", { endpoints: ["https://example.com"] });
  assert.equal(result.ok, false);
  assert.match(result.error, /do not allow host/);
});

test("returns a structured error for unknown tools", async () => {
  const result = await new ToolRegistry().invoke("workspace.missing", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test("parses and invokes bounded public web search", async () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; Docs</a><div class="result__snippet">A useful <b>snippet</b>.</div></div>`;
  assert.deepEqual(parseSearchResults(html), [{ title: "Example & Docs", url: "https://example.com/docs", snippet: "A useful snippet." }]);
  const search = new WebSearch({ fetcher: async () => ({ ok: true, headers: new Headers(), text: async () => html }) });
  const registry = new ToolRegistry({ webSearch: search });
  const result = await registry.invoke("web.search", { query: "example" });
  assert.equal(result.ok, true);
  assert.equal(result.result.results[0].url, "https://example.com/docs");
  assert.match(result.result.searchUrl, /^https:\/\/www\.google\.com\/search\?q=example$/);
});
