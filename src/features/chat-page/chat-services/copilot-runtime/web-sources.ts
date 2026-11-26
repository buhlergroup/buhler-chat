/**
 * Web sources of the Copilot path's web_search (provider-tools.ts) as
 * markdown links.
 *
 * On the AI SDK path the provider-hosted web search writes its sources into
 * the answer text as markdown links, and the chat renders them (the UI
 * stream carries no `source-url` parts: toUIMessageStream sends none by
 * default and the chat has no renderer for them). On the Copilot path the
 * sources came back only inside the tool result, and an answer that did not
 * cite them showed no link. event-mapper.ts adds a "Sources" line of these
 * links to such an answer, so the sources show in the same form.
 */

export const WEB_SEARCH_TOOL = "web_search";
/** Links in one Sources line at most. */
export const MAX_SOURCE_LINKS = 10;

export interface WebSource {
  url: string;
  title?: string;
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** The http(s) sources of a web_search output ({ citations }), first of each URL. */
export function webSearchSources(output: unknown): WebSource[] {
  const list = output && typeof output === "object" ? (output as { citations?: unknown }).citations : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const c of list) {
    const url = c && typeof c === "object" ? (c as { url?: unknown }).url : undefined;
    if (typeof url !== "string" || !HTTP_URL.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = (c as { title?: unknown }).title;
    out.push({ url, ...(typeof title === "string" && title.trim() ? { title } : {}) });
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

/** `[title](url)`, with the characters that would break the link escaped. */
export function markdownLink(source: WebSource): string {
  const label = (source.title ?? hostOf(source.url))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[[\]\\]/g, "")
    .trim()
    .slice(0, 120) || hostOf(source.url);
  const href = source.url.replace(/[()<>\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${label}](${href})`;
}

/** The URL without the tracking parameter the provider adds (utm_source=openai). */
function withoutTracking(url: string): string {
  return url.replace(/([?&])utm_source=openai(&|$)/, (_m, sep: string, end: string) => (end ? sep : "")).replace(/[?&]$/, "");
}

/** True when the answer links at least one of the sources. */
export function citesAnySource(text: string, sources: ReadonlyArray<WebSource>): boolean {
  return sources.some((s) => text.includes(s.url) || text.includes(withoutTracking(s.url)));
}

/** The Sources line for the answer ("" when there is none). */
export function sourcesMarkdown(sources: ReadonlyArray<WebSource>): string {
  const shown = sources.slice(0, MAX_SOURCE_LINKS);
  if (shown.length === 0) return "";
  return `\n\n**Sources:** ${shown.map(markdownLink).join(" · ")}\n`;
}
