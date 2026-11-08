import type { SearchHit } from "@agent-workstation/protocol";

export interface SnippetPart {
  text: string;
  mark: boolean;
}

/**
 * Split a keyword-search snippet into plain and highlighted parts: the hub wraps matched terms in `«` `»`. Rendered as
 * <mark> elements by the caller (never as HTML). Whitespace runs collapse to one space; an unclosed `«` marks the rest,
 * a stray `»` is dropped.
 */
export function parseSnippet(snippet: string | null | undefined): SnippetPart[] {
  if (!snippet) return [];
  const flat = snippet.replace(/\s+/g, " ").trim();
  const parts: SnippetPart[] = [];
  let i = 0;
  while (i < flat.length) {
    const open = flat.indexOf("«", i);
    if (open < 0) {
      parts.push({ text: flat.slice(i), mark: false });
      break;
    }
    if (open > i) parts.push({ text: flat.slice(i, open), mark: false });
    const close = flat.indexOf("»", open + 1);
    const end = close < 0 ? flat.length : close;
    if (end > open + 1) parts.push({ text: flat.slice(open + 1, end), mark: true });
    i = close < 0 ? flat.length : close + 1;
  }
  return parts.map((p) => (p.mark ? p : { ...p, text: p.text.replaceAll("»", "") })).filter((p) => p.text !== "");
}

/** Newest first by the hit's own timestamp (stable for equal times; unparsable times go last). */
export function newestFirst(hits: readonly SearchHit[]): SearchHit[] {
  const time = (h: SearchHit) => {
    const t = Date.parse(h.at);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return hits.map((h, i) => ({ h, i })).sort((a, b) => time(b.h) - time(a.h) || a.i - b.i).map((x) => x.h);
}
