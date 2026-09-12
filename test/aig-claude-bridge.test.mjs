import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { prepareMessages, startBridge } from "../scripts/aig-claude-bridge.mjs";

test("bridge separates system instructions and preserves dialogue text", () => {
  const prepared = prepareMessages([{ role: "system", content: "Judge the trace" }, { role: "user", content: "literal `command` and $VALUE" }]);
  assert.equal(prepared.system, "Judge the trace");
  assert.ok(prepared.prompt.includes("literal `command` and $VALUE"));
  assert.throws(() => prepareMessages([{ role: "tool", content: "result" }]), /text system/);
});

test("bridge returns OpenAI text chunks and rejects unsupported native tools", async () => {
  const server = startBridge({ port: 0, complete: async () => "AIG_READY" });
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const post = body => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const response = await post({ messages: [{ role: "user", content: "Ready?" }], stream: true });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6));
    assert.equal(events.at(-1), "[DONE]");
    assert.equal(events.slice(0, -1).map(e => JSON.parse(e).choices[0].delta.content ?? "").join(""), "AIG_READY");
    const rejected = await post({ messages: [{ role: "user", content: "Run" }], tools: [{ type: "function" }] });
    assert.equal(rejected.status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
