import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const SKIP = new Set([".git", "node_modules", "sessions", ".DS_Store"]);

const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi,
  /(api[_-]?key\s*[:=]\s*)[^\s,}]+/gi,
  /("?pusher[_-]?key"?\s*[:=]\s*)"?[^\s,}"']+"?/gi,
  /(token|secret|password|signature|auth)\s*[:=]\s*[^\s,}]+/gi,
  /([?&](?:token|key|signature|auth|password)=[^&\s]+)/gi,
];

export function redact(value) {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "$1[REDACTED]"), value);
}

function walk(root, current = root, output = [], limit = 500, prefix = "") {
  if (output.length >= limit) return output;
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (!prefix || prefix.startsWith(`${rel}/`) || rel.startsWith(prefix) || `${rel}/`.startsWith(prefix)) {
        walk(root, full, output, limit, prefix);
      }
    } else {
      if (!prefix || rel.startsWith(prefix)) {
        output.push(rel);
      }
    }
    if (output.length >= limit) break;
  }
  return output;
}

export class WorkspaceTools {
  constructor(root = process.cwd()) {
    this.root = path.resolve(root);
  }

  resolve(relativePath) {
    const candidate = path.resolve(this.root, relativePath || ".");
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Path is outside the workspace");
    }
    return candidate;
  }

  listFiles({ prefix = "", limit = 200 } = {}) {
    return walk(this.root, this.root, [], Math.min(limit, 500), prefix);
  }

  readFile({ path: filePath, startLine = 1, endLine = null } = {}) {
    const absolute = this.resolve(filePath);
    const lines = fs.readFileSync(absolute, "utf8").split("\n");
    const first = Math.max(1, Number(startLine) || 1);
    const last = Math.min(lines.length, Number(endLine) || lines.length);
    const content = lines.slice(first - 1, last).join("\n");
    if (Buffer.byteLength(content) > 100_000) throw new Error("Requested file range is too large");
    return { path: filePath, startLine: first, endLine: last, content };
  }

  writeFile({ path: filePath, content = "" } = {}) {
    const absolute = this.resolve(filePath);
    if (Buffer.byteLength(content) > 100_000) throw new Error("File content is too large");
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return { path: filePath, bytes: Buffer.byteLength(content) };
  }

  search({ query, prefix = "", limit = 100 } = {}) {
    if (!query) throw new Error("search requires a query");
    const expression = new RegExp(query, "i");
    const matches = [];
    for (const file of this.listFiles({ prefix, limit: 500 })) {
      const absolute = this.resolve(file);
      let lines;
      try { lines = fs.readFileSync(absolute, "utf8").split("\n"); } catch { continue; }
      lines.forEach((line, index) => {
        if (expression.test(line)) matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
      });
      if (matches.length >= limit) break;
    }
    return matches.slice(0, limit);
  }

  gitDiff({ staged = false } = {}) {
    const args = ["diff", "--no-ext-diff"];
    if (staged) args.push("--cached");
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", maxBuffer: 2_000_000 });
  }

  gitStatus() {
    try {
      return execFileSync("git", ["status", "--short"], { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  }

  runScript({ name = "test" } = {}) {
    const packagePath = path.join(this.root, "package.json");
    const packageInfo = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (!packageInfo.scripts?.[name]) throw new Error(`Package script is not defined: ${name}`);
    try {
      return { name, code: 0, output: execFileSync("npm", ["run", name], { cwd: this.root, encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 }) };
    } catch (error) {
      return { name, code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  }

  inspectLogs({ prefix = "", limit = 100_000 } = {}) {
    const candidates = walk(this.root, this.root, [], 500)
      .filter((file) => /(^|\/)(logs?|log|debug)(\/|\.|$)/i.test(file) || /\.(log|out|err)$/i.test(file))
      .filter((file) => !prefix || file.startsWith(prefix));
    const entries = [];
    let total = 0;
    for (const file of candidates) {
      const text = redact(fs.readFileSync(this.resolve(file), "utf8"));
      const remaining = Math.max(0, limit - total);
      const content = text.slice(0, remaining);
      entries.push({ path: file, content, truncated: content.length < text.length });
      total += content.length;
      if (total >= limit) break;
    }
    return entries;
  }

  contextForRequest(userMessage = "") {
    const allFiles = this.listFiles({ limit: 500 });
    const message = userMessage.toLowerCase();
    const references = [...String(userMessage).matchAll(/@([\w./-]+\.(?:mjs|js|json|ts|tsx|jsx|html|css|md|txt))/gi)]
      .map((match) => match[1].toLowerCase());
    const broadFileRequest = /\b(?:read|open|show|inspect|review|scan|analy[sz]e)\b[\s\S]*\b(?:files?|source|code|project|codebase|bugs?)\b/.test(message);
    const requested = allFiles.filter((file) => {
      const name = path.basename(file);
      const configAlias = name === "configs.json" && /configs?\s+file|config\s+file/.test(message);
      return message.includes(file.toLowerCase())
        || message.includes(name.toLowerCase())
        || references.includes(file.toLowerCase())
        || configAlias;
    });
    if (broadFileRequest && requested.length === 0) {
      const priority = [
        "src/server.mjs",
        "src/workspace-tools.mjs",
        "src/gecko-client.mjs",
        "src/services/GeckoService.mjs",
        "src/tool-registry.mjs",
      ];
      const sourceFiles = allFiles.filter((file) => /^(src|public|views)\/.*\.(mjs|js|json|html|css)$/.test(file) || /^(README|package\.json)/i.test(file));
      requested.push(...priority.filter((file) => sourceFiles.includes(file)), ...sourceFiles.filter((file) => !priority.includes(file)).slice(0, 12));
    }
    const files = [];
    let total = 0;
    for (const file of requested.slice(0, 5)) {
      const raw = fs.readFileSync(this.resolve(file), "utf8");
      const content = redact(raw).slice(0, 20_000);
      files.push({ path: file, content, truncated: content.length < raw.length });
      total += content.length;
      if (total >= 50_000) break;
    }
    return files;
  }

  applyPatch({ patch } = {}) {
    if (!patch) throw new Error("apply_patch requires patch text");
    const temporary = path.join(os.tmpdir(), `tru-gecko-${Date.now()}.patch`);
    try {
      fs.writeFileSync(temporary, patch);
      execFileSync("git", ["apply", "--check", temporary], { cwd: this.root, encoding: "utf8" });
      execFileSync("git", ["apply", temporary], { cwd: this.root, encoding: "utf8" });
      return { applied: true };
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  context() {
    let packageInfo = {};
    try { packageInfo = JSON.parse(fs.readFileSync(path.join(this.root, "package.json"), "utf8")); } catch {}
    return {
      root: this.root,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      package: packageInfo.name ?? null,
      scripts: packageInfo.scripts ?? {},
      dependencies: Object.keys(packageInfo.dependencies ?? {}),
      files: this.listFiles(),
      gitStatus: this.gitStatus().trim().split("\n").filter(Boolean),
    };
  }
}
