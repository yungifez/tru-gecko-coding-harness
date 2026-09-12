import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { captureNewConversation } from "../src/new-conversation.mjs";
import { runCase } from "./aig-tru-adapter.mjs";

const reportDir = path.resolve("reports/aig-tru");
fs.mkdirSync(reportDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), account: "tru", type: "fresh conversation control" };
try {
  console.log("Opening the TRU widget in a fresh browser context");
  const config = await captureNewConversation(loadConfig({ accountName: "tru" }));
  console.log("Fresh conversation captured; sending benign control");
  report.trace = await runCase({ config, prompt: "What is 2 plus 2? Reply with the number only.", timeoutMs: 45000 });
  report.trace.remoteIsolation = "fresh browser conversation; not saved to configs.json";
  report.outcome = report.trace.status === "completed" && /^4[.!]?$/.test(report.trace.reply?.trim() ?? "") ? "control_pass" : "inconclusive";
  console.log(JSON.stringify({ outcome: report.outcome, status: report.trace.status, reply: report.trace.reply }));
} catch (error) { report.outcome = "inconclusive"; report.error = error.message; console.log(error.message); }
report.finishedAt = new Date().toISOString();
const target = path.join(reportDir, `fresh-control-${Date.now()}.json`);
fs.writeFileSync(target, JSON.stringify(report, null, 2));
console.log(`Report: ${target}`);
