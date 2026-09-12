function roleForSpeaker(speaker = "") {
  return /^bot$/i.test(speaker.trim()) ? "assistant" : "user";
}

export function cleanHarnessContent(value = "") {
  let content = String(value)
    .replace(/\[HARNESS_CONTEXT_CHUNK[^\]]*\][\s\S]*?\[\/HARNESS_CONTEXT_CHUNK\]/g, "")
    .replace(/\[\[HARNESS_(?:CONTINUE|ACK|CHUNK|DONE)\]\]/g, "")
    .replace(/\[LOCAL HARNESS INSTRUCTIONS\][\s\S]*?\[\/LOCAL HARNESS INSTRUCTIONS\]/g, "")
    .replace(/\[WORKSPACE CONTEXT(?: CHUNK \d+\/\d+)?\][\s\S]*?\[\/WORKSPACE CONTEXT\]/g, "")
    .replace(/\[RECENT SESSION\][\s\S]*?\[\/RECENT SESSION\]/g, "")
    .replace(/\[\[GEIKO_TOOL_CALL\]\][\s\S]*?\[\[\/GEIKO_TOOL_CALL\]\]/g, "")
    .replace(/\[\[GEIKO_TOOL_RESULT\]\][\s\S]*?\[\[\/GEIKO_TOOL_RESULT\]\]/g, "")
    .replace(/```[^\n]*\n[\s\S]*?(?:workspace|network|session|gecko)\.[\s\S]*?```/gi, "")
    .replace(/^\s*(?:workspace|network|session|gecko)\.[\w.]+\([^\n]*\)\s*$/gim, "");
  const request = content.match(/\[USER REQUEST\]([\s\S]*?)\[\/USER REQUEST\]/);
  if (request) content = request[1];
  const harnessCommand = /^\/(?:help|context|tools?|tool|files?|read|write|search|diff|test|logs?|network|refresh|system|history|sessions?|new|resume|clear|rename|status|doctor|save|exit|apply|menu|compose|websearch|google)(?:\s|$)/i;
  return content.split("\n").filter((line) => !harnessCommand.test(line.trim())).join("\n").trim();
}

export function parseTranscript(text) {
  const messages = [];
  let current = null;
  const header = /^\[([^\]]+)\]\s+([^(:]+?)(?:\s*\(([^)]+)\))?:\s*$/;

  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(header);
    if (match) {
      if (current) current.content = cleanHarnessContent(current.content.join("\n"));
      current = {
        timestamp: match[1],
        speaker: match[2].trim(),
        participant: match[3]?.trim() ?? null,
        role: roleForSpeaker(match[2]),
        content: [],
      };
      messages.push(current);
    } else if (current) {
      current.content.push(line);
    }
  }
  if (current) current.content = cleanHarnessContent(current.content.join("\n"));
  return messages.filter((message) => message.content);
}

export async function fetchTranscript(config) {
  if (!config.accountName || !config.conversationId) {
    throw new Error("A configured account name and conversation ID are required for transcript history");
  }
  const endpoint = `https://${config.accountName}.api.geckoengage.com/conversations/${encodeURIComponent(config.conversationId)}/download-transcript-public`;
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data?.transcript_url) {
    throw new Error(`Transcript request failed (${response.status})`);
  }
  const transcriptResponse = await fetch(body.data.transcript_url);
  if (!transcriptResponse.ok) throw new Error(`Transcript download failed (${transcriptResponse.status})`);
  const text = await transcriptResponse.text();
  return {
    conversationId: config.conversationId,
    accountName: config.accountName,
    messages: parseTranscript(text),
  };
}
