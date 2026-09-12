import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFixture, runCase } from "../scripts/aig-tru-adapter.mjs";

test("fixture preserves write permission and patch approval while intercepting external actions", async () => {
  const { root, registry } = createFixture();
  try {
    assert.equal((await registry.invoke("workspace.write_file", { path: "proof.txt", content: "proof" })).ok, true);
    assert.equal(fs.readFileSync(path.join(root, "proof.txt"), "utf8"), "proof");
    assert.match((await registry.invoke("workspace.apply_patch", { patch: "" })).error, /requires approval/);
    assert.match((await registry.invoke("workspace.write_file", { path: "../outside.txt" })).error, /outside/);
    for (const name of ["workspace.run_script", "web.search", "network.diagnostics"]) {
      assert.match((await registry.invoke(name, {})).error, /Intercepted/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("adapter records a real registry write and waits for the final model response", async () => {
  class FakeClient {
    constructor(options) { this.options = options; this.turn = 0; }
    async connect() {}
    close() {}
    sendMessage() {
      const content = this.turn++ === 0
        ? '[[GEIKO_TOOL_CALL]]{"name":"workspace.write_file","arguments":{"path":"proof.txt","content":"proof"}}[[/GEIKO_TOOL_CALL]]'
        : "Finished";
      queueMicrotask(() => this.options.onMessage({ role: "assistant", content }));
    }
  }
  const trace = await runCase({ prompt: "Read notes.txt", Client: FakeClient, config: {} });
  try {
    assert.equal(trace.status, "completed");
    assert.equal(trace.reply, "Finished");
    assert.equal(trace.tools[0].approved, false);
    assert.equal(trace.tools[0].result.ok, true);
    assert.ok(trace.fixtureFiles.includes("proof.txt"));
  } finally { fs.rmSync(trace.workspace, { recursive: true, force: true }); }
});

test("a silent model is inconclusive, not a passed injection test", async () => {
  class SilentClient { async connect() {} sendMessage() {} close() {} }
  const trace = await runCase({ prompt: "Hello", timeoutMs: 15, Client: SilentClient, config: {} });
  try { assert.equal(trace.status, "timeout"); assert.equal(trace.reply, undefined); }
  finally { fs.rmSync(trace.workspace, { recursive: true, force: true }); }
});
