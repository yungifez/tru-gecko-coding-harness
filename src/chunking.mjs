import { ensureGeikoIdentity, GEIKO_IDENTITY_REMINDER } from "./prompts.mjs";

export const PUSHER_EVENT_LIMIT_BYTES = 10_240;
export const SAFE_EVENT_BUDGET_BYTES = 8_800;

export function byteLength(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

export function chunkText(value, maxBytes = 2_000) {
  const chunks = [];
  let current = "";
  for (const character of String(value)) {
    if (byteLength(current + character) > maxBytes && current) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

export function truncateUtf8(value, maxBytes) {
  const chunks = chunkText(value, maxBytes);
  return chunks[0].length < String(value).length ? `${chunks[0]}… [truncated]` : chunks[0];
}

export function compactTransportContext(context = {}) {
  const files = context.files ?? [];
  const requestedFiles = (context.requestedFiles ?? []).slice(0, 5);
  return {
    root: context.root,
    platform: context.platform,
    node: context.node,
    package: context.package,
    scripts: context.scripts,
    dependencies: context.dependencies?.slice(0, 30),
    // Put explicitly requested source contents first so the transport budget
    // cannot truncate them behind the general workspace inventory.
    requestedFiles,
    commandResults: (context.commandResults ?? []).slice(0, 3),
    files: files.slice(0, 70),
    filesOmitted: Math.max(0, files.length - 70),
    gitStatus: context.gitStatus?.slice(0, 30),
  };
}

export function buildTransportPrompt({ systemPrompt, skills = [], tools = [], localContext, history = [], userMessage }) {
  const context = compactTransportContext(localContext);
  const contextText = JSON.stringify(
    context.requestedFiles?.length || context.commandResults?.length
      ? { root: context.root, requestedFiles: context.requestedFiles, commandResults: context.commandResults }
      : context,
    null,
    2,
  );
  const historyText = history.slice(-4).map(({ role, content }) => `${role}: ${truncateUtf8(content, 700)}`).join("\n");
  const fixed = [
    "[LOCAL HARNESS INSTRUCTIONS]",
    truncateUtf8(ensureGeikoIdentity(systemPrompt), 1_400),
    "The harness may chunk workspace data to stay within the transport limit. Treat the supplied chunks as authoritative. If requestedFiles contains the requested file, use that content and do not claim it was unavailable.",
    `Skills: ${skills.map((skill) => skill.name).join(", ")}`,
    `Tools: ${tools.map((tool) => tool.name).join(", ")}`,
    "Callable tool protocol: emit only [[GEIKO_TOOL_CALL]]{\"name\":\"tool.name\",\"arguments\":{}}[[/GEIKO_TOOL_CALL]], with no surrounding prose, then wait for the harness result.",
    "[/LOCAL HARNESS INSTRUCTIONS]",
    "[WORKSPACE CONTEXT CHUNK 1/1]",
    truncateUtf8(contextText, 2_400),
    "[/WORKSPACE CONTEXT]",
    historyText ? `[RECENT SESSION]\n${historyText}\n[/RECENT SESSION]` : "",
    GEIKO_IDENTITY_REMINDER,
  ].filter(Boolean).join("\n\n");
  const remaining = Math.max(1_000, 7_600 - byteLength(fixed));
  return `${fixed}\n\n[USER REQUEST]\n${truncateUtf8(userMessage, remaining)}\n[/USER REQUEST]`;
}

export function buildFullHarnessPrompt({ systemPrompt, skills = [], tools = [], localContext, history = [], userMessage }) {
  return [
    "[LOCAL HARNESS INSTRUCTIONS]",
    ensureGeikoIdentity(systemPrompt),
    "The harness may send this context in ordered chunks. Do not answer until every chunk is received. Reply with [[HARNESS_CONTINUE]] after each stored chunk. Reply with [[HARNESS_DONE]] followed by your final answer after the final chunk.",
    "Skills:", ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    "Tools:", ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    "Callable tool protocol: emit only [[GEIKO_TOOL_CALL]]{\"name\":\"tool.name\",\"arguments\":{}}[[/GEIKO_TOOL_CALL]], with no surrounding prose, then wait for the harness result.",
    "[/LOCAL HARNESS INSTRUCTIONS]",
    "[WORKSPACE CONTEXT]", JSON.stringify(localContext, null, 2), "[/WORKSPACE CONTEXT]",
    history.length ? `[RECENT SESSION]\n${history.map(({ role, content }) => `${role}: ${content}`).join("\n")}\n[/RECENT SESSION]` : "",
    GEIKO_IDENTITY_REMINDER,
    `[USER REQUEST]\n${userMessage}\n[/USER REQUEST]`,
  ].filter(Boolean).join("\n\n");
}

export function prepareTransportData(data, harnessEntryText) {
  const compact = {
    ...data,
    entryText: harnessEntryText,
    rawEntryText: truncateUtf8(data.rawEntryText, 1_500),
    history: data.history.slice(-3).map(({ role, content }) => ({ role, content: truncateUtf8(content, 500) })),
    skills: data.skills.map(({ name, description }) => ({ name, description: truncateUtf8(description, 180) })),
    tools: data.tools.map(({ name, description }) => ({ name, description: truncateUtf8(description, 180) })),
    localContext: compactTransportContext(data.localContext),
  };
  const eventBytes = byteLength({ event: "client-sendMessage", channel: data.channel, data: JSON.stringify(compact) });
  if (eventBytes > SAFE_EVENT_BUDGET_BYTES) {
    compact.history = [];
    compact.tools = compact.tools.slice(0, 8);
    compact.skills = compact.skills.slice(0, 8);
    compact.localContext.files = compact.localContext.files.slice(0, 25);
    compact.localContext.filesOmitted = Math.max(0, (data.localContext.files?.length ?? 0) - 25);
    compact.entryText = truncateUtf8(compact.entryText, 5_500);
  }
  const finalBytes = byteLength({ event: "client-sendMessage", channel: data.channel, data: JSON.stringify(compact) });
  if (finalBytes > PUSHER_EVENT_LIMIT_BYTES) {
    compact.history = [];
    compact.skills = compact.skills.slice(0, 4);
    compact.tools = compact.tools.slice(0, 6);
    compact.rawEntryText = "";
    compact.entryText = truncateUtf8(compact.entryText, 2_800);
    compact.localContext.files = [];
    compact.localContext.filesOmitted = data.localContext.files?.length ?? 0;
    compact.localContext.requestedFiles = (data.localContext.requestedFiles ?? []).slice(0, 5).map((file) => ({
      ...file,
      content: truncateUtf8(file.content, 700),
    }));
    compact.localContext.commandResults = (data.localContext.commandResults ?? []).slice(0, 2).map((result) => ({
      ...result,
      output: truncateUtf8(result.output ?? JSON.stringify(result.result ?? ""), 1_200),
    }));
  }
  const boundedBytes = byteLength({ event: "client-sendMessage", channel: data.channel, data: JSON.stringify(compact) });
  if (boundedBytes > PUSHER_EVENT_LIMIT_BYTES) {
    compact.entryText = truncateUtf8(compact.entryText, 1_200);
    compact.localContext.requestedFiles = compact.localContext.requestedFiles.map((file) => ({ ...file, content: truncateUtf8(file.content, 250) }));
    compact.localContext.commandResults = [];
    compact.tools = [];
    compact.skills = [];
  }
  const safeBytes = byteLength({ event: "client-sendMessage", channel: data.channel, data: JSON.stringify(compact) });
  if (safeBytes > PUSHER_EVENT_LIMIT_BYTES) {
    throw new Error(`Message is ${safeBytes} bytes after context reduction; maximum is ${PUSHER_EVENT_LIMIT_BYTES}.`);
  }
  return { data: compact, bytes: safeBytes };
}
