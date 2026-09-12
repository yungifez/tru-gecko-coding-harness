const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_HOST = "html.duckduckgo.com";
const GOOGLE_SEARCH_ENDPOINT = "https://www.google.com/search";
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 10;
const MAX_RESPONSE_BYTES = 1_000_000;

function decodeHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ").trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function resultUrl(value) {
  try {
    const decoded = decodeHtml(value);
    const url = decoded.startsWith("//") ? `https:${decoded}` : new URL(decoded, SEARCH_ENDPOINT).toString();
    const parsed = new URL(url);
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname === "/l/") {
      const target = parsed.searchParams.get("uddg");
      if (target) return new URL(target).toString();
    }
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch { return null; }
}

export function parseSearchResults(html, limit = MAX_RESULTS) {
  const results = [];
  const blocks = String(html).split(/<div[^>]+class=["']result(?:\s[^"']*)?["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = resultUrl(attribute(titleMatch[0], "href"));
    const title = decodeHtml(titleMatch[1]);
    const snippetMatch = block.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet = decodeHtml(snippetMatch?.[1] ?? "");
    if (url && title) results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

async function readBounded(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("Search response is too large");
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Search response is too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class WebSearch {
  constructor({ fetcher = globalThis.fetch, endpoint = SEARCH_ENDPOINT } = {}) {
    this.fetcher = fetcher;
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.hostname !== SEARCH_HOST) throw new Error(`Web search endpoint must be https://${SEARCH_HOST}`);
    this.endpoint = parsed.toString();
  }

  async search({ query, limit = MAX_RESULTS, domains = [] } = {}) {
    const originalQuery = String(query ?? "").trim();
    if (!originalQuery) throw new Error("web.search requires a query");
    if (originalQuery.length > MAX_QUERY_LENGTH) throw new Error(`Search query is limited to ${MAX_QUERY_LENGTH} characters`);
    const count = Math.max(1, Math.min(Number(limit) || MAX_RESULTS, MAX_RESULTS));
    const domainList = Array.isArray(domains) ? domains.filter(Boolean).slice(0, 5) : [];
    const scopedQuery = domainList.length ? `${originalQuery} ${domainList.map((domain) => `site:${String(domain).replace(/[^\w.-]/g, "")}`).join(" ")}` : originalQuery;
    const url = new URL(this.endpoint);
    url.searchParams.set("q", scopedQuery);
    const response = await this.fetcher(url, { headers: { accept: "text/html", "user-agent": "geiko-harness/0.1" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Web search returned HTTP ${response.status}`);
    const googleUrl = new URL(GOOGLE_SEARCH_ENDPOINT);
    googleUrl.searchParams.set("q", scopedQuery);
    return { query: originalQuery, searchUrl: googleUrl.toString(), results: parseSearchResults(await readBounded(response), count), provider: "DuckDuckGo results with Google search link", searchedAt: new Date().toISOString() };
  }
}
