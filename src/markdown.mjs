function inlineMarkdown(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

export function markdownToTerminal(value = "") {
  const output = [];
  let inCode = false;
  for (const rawLine of String(value).replace(/\r/g, "").split("\n")) {
    const fence = rawLine.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      output.push(inCode ? "  └────────────────" : `  ┌─ code${fence[1] ? ` · ${fence[1]}` : ""} ─────────────`);
      inCode = !inCode;
      continue;
    }
    if (inCode) { output.push(`  │ ${rawLine}`); continue; }
    const heading = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (heading) { output.push(`▌ ${inlineMarkdown(heading[1])}`); continue; }
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (quote) { output.push(`│ ${inlineMarkdown(quote[1])}`); continue; }
    const bullet = rawLine.match(/^(\s*)([-*+] |\d+[.)] )(.*)$/);
    if (bullet) { output.push(`${bullet[1]}${bullet[2]}${inlineMarkdown(bullet[3])}`); continue; }
    output.push(inlineMarkdown(rawLine));
  }
  if (inCode) output.push("  └────────────────");
  return output.join("\n");
}
