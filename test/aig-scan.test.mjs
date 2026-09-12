import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILLS, scanPlan, ensureVenv, ensureServices } from "../scripts/aig-scan.mjs";

test("claude judge uses the local bridge and all detection skills", () => {
  const plan = scanPlan({ judge: "claude", root: "/repo", output: "out.json", env: {} });
  assert.deepEqual(plan.args.slice(plan.args.indexOf("-m"), plan.args.indexOf("-m") + 4), ["-m", "claude-cli", "-u", "http://127.0.0.1:4185/v1"]);
  assert.equal(plan.args[plan.args.indexOf("--skills") + 1].split(",").length, SKILLS.length);
  assert.equal(plan.env.LLM_API_KEY, "local-cli");
  assert.equal(plan.log, "/repo/out.log");
  assert.deepEqual(plan.health, ["http://127.0.0.1:4184/health", "http://127.0.0.1:4185/health"]);
});

test("openrouter judge keeps the key out of arguments and ignores other provider keys", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-test", OPENAI_API_KEY: "sk-openai", THINKING_BASE_URL: "https://elsewhere" };
  const plan = scanPlan({ judge: "openrouter", root: "/repo", env });
  assert.ok(!plan.args.some(arg => arg.includes("sk-")));
  assert.equal(plan.args[plan.args.indexOf("-m") + 1], "deepseek/deepseek-v3.2");
  assert.equal(plan.env.LLM_API_KEY, "sk-or-test");
  assert.equal(plan.env.THINKING_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(plan.env.CODING_MODEL, "deepseek/deepseek-v3.2");
  assert.deepEqual(plan.health, ["http://127.0.0.1:4184/health"]);
});

test("openrouter judge requires a key and accepts a model override", () => {
  assert.throws(() => scanPlan({ judge: "openrouter", env: {} }), /OPENROUTER_API_KEY/);
  assert.throws(() => scanPlan({ judge: "gpt", env: {} }), /Unknown judge/);
  const plan = scanPlan({ judge: "openrouter", model: "qwen/qwen3-235b-a22b", env: { OPENROUTER_API_KEY: "k" } });
  assert.equal(plan.env.FAST_MODEL, "qwen/qwen3-235b-a22b");
});

test("ensureVenv returns existing python path without re-creating venv", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "venv-test-"));
  const fakePython = path.join(tmp, "python");
  fs.writeFileSync(fakePython, "");
  const result = ensureVenv({ root: tmp, pythonPath: fakePython });
  assert.equal(result, fakePython);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ensureServices handles empty list and returns cleanup function", async () => {
  const cleanup = await ensureServices([]);
  assert.equal(typeof cleanup, "function");
  assert.doesNotThrow(() => cleanup());
});

