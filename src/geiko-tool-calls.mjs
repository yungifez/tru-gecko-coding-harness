const OPEN = "[[GEIKO_TOOL_CALL]]";
const CLOSE = "[[/GEIKO_TOOL_CALL]]";

function jsonObjectEnd(source) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

export function parseToolCall(text = "") {
  const source = String(text);
  const start = source.indexOf(OPEN);
  if (start < 0) return null;
  const payloadStart = start + OPEN.length;
  const markerEnd = source.indexOf(CLOSE, payloadStart);
  const payload = markerEnd >= 0
    ? source.slice(payloadStart, markerEnd).trim()
    : (() => {
      const remainder = source.slice(payloadStart).trim();
      const end = jsonObjectEnd(remainder);
      return end >= 0 ? remainder.slice(0, end) : "";
    })();
  if (!payload) return null;
  try {
    const call = JSON.parse(payload);
    if (!call?.name || typeof call.name !== "string") return null;
    const argumentsObject = call.arguments ?? {};
    // Accept the compact form older Gecko responses used for package scripts.
    if (call.name === "workspace.run_script" && call.script && !argumentsObject.name) {
      argumentsObject.name = call.script;
    }
    return { name: call.name, arguments: argumentsObject };
  } catch {
    return null;
  }
}

export function toolCallInstructions(tools = []) {
  return [
    "Local tools are callable through the harness.",
    "When you need one, emit only this block and wait for the result. Do not add prose before or after it:",
    `${OPEN}{\"name\":\"workspace.read_file\",\"arguments\":{\"path\":\"src/file.mjs\"}}${CLOSE}`,
    "Use the exact tool name and JSON arguments from the tool list. Never invent tool results.",
    `Available callable tools: ${tools.map((tool) => tool.name).join(", ")}`,
  ].join(" ");
}

export { OPEN as TOOL_CALL_OPEN, CLOSE as TOOL_CALL_CLOSE };
