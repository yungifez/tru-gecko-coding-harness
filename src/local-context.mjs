import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "sessions", ".DS_Store"]);

export const HARNESS_SKILLS = [
  { name: "workspace-context", description: "Inspect the provided project path, runtime, package scripts, files, and Git status." },
  { name: "file-editing", description: "Create small checked patches or modify one approved workspace file." },
  { name: "command-execution", description: "Run named package scripts such as test, demo, or build." },
  { name: "session-memory", description: "Use the provided session ID, system prompt, and recent transcript to continue work." },
  { name: "gecko-events", description: "Interpret Gecko typing, message, streaming, completion, and conversation lifecycle events." },
  { name: "log-inspection", description: "Inspect local logs with credentials and secret-like values redacted." },
  { name: "network-diagnostics", description: "Inspect configured Gecko endpoints and check connectivity without sending credentials." },
  { name: "web-search", description: "Search the public web with bounded results and source URLs." },
];

function listFiles(root, current = root, result = [], limit = 200) {
  if (result.length >= limit) return result;
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) listFiles(root, fullPath, result, limit);
    else result.push(path.relative(root, fullPath));
    if (result.length >= limit) break;
  }
  return result;
}

function gitStatus(root) {
  try {
    return execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function collectLocalContext(root = process.cwd()) {
  let packageInfo = {};
  try { packageInfo = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch { /* non-Node project */ }
  return {
    root,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    host: os.hostname(),
    package: packageInfo.name ?? null,
    scripts: packageInfo.scripts ?? {},
    dependencies: Object.keys(packageInfo.dependencies ?? {}),
    files: listFiles(root),
    gitStatus: gitStatus(root),
  };
}

export function formatLocalContext(context) {
  return JSON.stringify(context, null, 2);
}
