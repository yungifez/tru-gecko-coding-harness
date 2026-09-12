import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const SKILLS = [
  "data-leakage-detection", "tool-abuse-detection", "indirect-injection-detection", "authorization-bypass-detection",
  "web-exfiltration-detection", "agentic-supply-chain-detection", "unexpected-code-execution-detection",
  "inter-agent-comm-security-detection", "cascading-failure-detection", "human-agent-trust-exploit-detection",
  "direct-injection-detection", "memory-poisoning-detection", "file-path-traversal-detection", "hardcoded-secret-detection",
];

export const JUDGES = {
  claude: { model: "claude-cli", baseUrl: "http://127.0.0.1:4185/v1", bridge: "http://127.0.0.1:4185/health" },
  openrouter: { model: "deepseek/deepseek-v3.2", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
};

export function ensureVenv({ root = process.cwd(), pythonPath } = {}) {
  const python = pythonPath ?? path.join(root, ".aig-venv/bin/python");
  if (fs.existsSync(python)) return python;

  const venvDir = path.join(root, ".aig-venv");
  const reqPath = path.join(root, "vendor/ai-infra-guard/agent-scan/requirements.txt");

  console.log(`Setting up .aig-venv virtual environment at ${venvDir}...`);
  const venvRes = spawnSync("python3", ["-m", "venv", venvDir], { stdio: "inherit" });
  if (venvRes.status !== 0) {
    throw new Error(`Failed to create python virtual environment at ${venvDir}`);
  }

  const pip = path.join(venvDir, "bin/pip");
  if (fs.existsSync(reqPath)) {
    console.log(`Installing AIG dependencies from ${reqPath}...`);
    const pipRes = spawnSync(pip, ["install", "-r", reqPath], { stdio: "inherit" });
    if (pipRes.status !== 0) {
      throw new Error(`Failed to install AIG dependencies into ${venvDir}`);
    }
  }

  return python;
}

export async function ensureServices(healthUrls = []) {
  const started = [];
  for (const url of healthUrls) {
    const isHealthy = await fetch(url).then(r => r.ok, () => false);
    if (isHealthy) continue;

    const parsed = new URL(url);
    if (parsed.port === "4184") {
      const { startServer } = await import("./aig-tru-adapter.mjs");
      const server = startServer({ port: 4184 });
      started.push(server);
    } else if (parsed.port === "4185") {
      const { startBridge } = await import("./aig-claude-bridge.mjs");
      const bridge = startBridge({ port: 4185 });
      started.push(bridge);
    } else {
      throw new Error(`Service at ${url} is not responding and cannot be auto-started.`);
    }

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      ready = await fetch(url).then(r => r.ok, () => false);
      if (ready) break;
    }
    if (!ready) {
      throw new Error(`Timed out waiting for service at ${url} to become healthy.`);
    }
  }

  return () => {
    for (const server of started) {
      try {
        server.closeAllConnections?.();
        server.close?.();
      } catch {}
    }
  };
}

export function scanPlan({ judge = "claude", model, skills = SKILLS, output, root = process.cwd(), env = process.env } = {}) {
  const config = JUDGES[judge];
  if (!config) throw new Error(`Unknown judge "${judge}". Use: ${Object.keys(JUDGES).join(", ")}`);
  const key = config.keyEnv ? env[config.keyEnv]?.trim() : "local-cli";
  if (!key) throw new Error(`Set ${config.keyEnv} in the environment to use the ${judge} judge`);
  model ??= config.model;
  output = path.resolve(root, output ?? `reports/aig-tru/agent-scan-${judge}-${Date.now()}.json`);
  // AIG reads LLM_API_KEY before OPENAI_API_KEY, so an unrelated key cannot reach the judge host.
  // Its thinking, coding, and fast models default to OpenRouter; point them at the selected judge too.
  const childEnv = { ...env, LLM_API_KEY: key };
  for (const purpose of ["THINKING", "CODING", "FAST"]) {
    Object.assign(childEnv, { [`${purpose}_MODEL`]: model, [`${purpose}_BASE_URL`]: config.baseUrl, [`${purpose}_API_KEY`]: key });
  }
  const args = [path.join(root, "vendor/ai-infra-guard/agent-scan/main.py"),
    "--agent_provider", path.join(root, "scripts/aig-tru-provider.yaml"),
    "-m", model, "-u", config.baseUrl, "--language", "en", "--skills", skills.join(","), "-o", output];
  const health = ["http://127.0.0.1:4184/health", config.bridge].filter(Boolean);
  return { python: path.join(root, ".aig-venv/bin/python"), args, env: childEnv, output, log: output.replace(/\.json$/, ".log"), health };
}

async function main() {
  const { values } = parseArgs({ options: { judge: { type: "string", default: "claude" }, model: { type: "string" },
    skills: { type: "string" }, output: { type: "string" } } });
  const plan = scanPlan({ ...values, skills: values.skills?.split(",") });
  ensureVenv({ pythonPath: plan.python });
  const cleanupServices = await ensureServices(plan.health);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    cleanupServices();
  };
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });
  process.once("exit", cleanup);

  try {
    console.log(`Judge: ${values.judge} (${plan.args[plan.args.indexOf("-m") + 1]})\nLog: ${plan.log}`);
    const log = fs.createWriteStream(plan.log);
    const child = spawn(plan.python, plan.args, { env: plan.env, stdio: ["inherit", "pipe", "pipe"] });
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", chunk => { sink.write(chunk); log.write(chunk); });
    }
    const [code] = await new Promise(resolve => child.on("close", (...result) => resolve(result)));
    log.end();
    console.log(fs.existsSync(plan.output) ? `Report: ${plan.output}` : "No report was written; check the log.");
    process.exitCode = code ?? 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

