import { isRecord } from "./sdk";
import { basename, truncate } from "./format";

/**
 * Web / attachment tools shown as compact chips: WebSearch / WebFetch / Read.
 */
export type WebTool = "search" | "fetch" | "read";

export interface WebLink {
  title: string;
  url?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const first = (input: unknown, keys: readonly string[]): string => {
  if (!isRecord(input)) return "";
  for (const k of keys) {
    const v = str(input[k]);
    if (v) return v;
  }
  return "";
};

export function webTool(name: string, chat: boolean): WebTool | null {
  if (name === "WebSearch") return "search";
  if (name === "WebFetch") return "fetch";
  if (chat && name === "Read") return "read";
  return null;
}

export const searchQuery = (input: unknown): string => first(input, ["query", "q", "search_query", "searchQuery", "text"]);
export const fetchUrl = (input: unknown): string => first(input, ["url", "Url", "URL", "uri"]);

/** "example.com/docs/page" — host without www plus the path, shortened; falls back to the raw text. */
export function shortUrl(url: string, max = 48): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`.replace(/\/$/, "");
    return truncate(`${u.host.replace(/^www\./, "")}${path}`, max);
  } catch {
    return truncate(url.replace(/^https?:\/\//i, ""), max);
  }
}

/** "(pages 3–5)" when the Read input names a page range, else "". */
export function pagesSuffix(input: unknown): string {
  if (!isRecord(input)) return "";
  const num = (k: string) => (typeof input[k] === "number" || (typeof input[k] === "string" && /^\d+$/.test(input[k] as string)) ? Number(input[k]) : undefined);
  let a: number | undefined;
  let b: number | undefined;
  const p = input.pages ?? input.page;
  if (typeof p === "number") a = b = p;
  else if (typeof p === "string" && p.trim()) {
    const m = /^\s*(\d+)\s*(?:[-–—]|to)?\s*(\d+)?\s*$/.exec(p);
    if (!m) return `(pages ${p.trim()})`;
    a = Number(m[1]);
    b = m[2] ? Number(m[2]) : a;
  } else {
    a = num("page_start") ?? num("pageStart") ?? num("first_page") ?? num("start_page");
    b = num("page_end") ?? num("pageEnd") ?? num("last_page") ?? num("end_page") ?? a;
  }
  if (a === undefined) return "";
  return a === b || b === undefined ? `(page ${a})` : `(pages ${a}–${b})`;
}

export function attachmentLabel(input: unknown): string {
  const path = first(input, ["file_path", "path", "absolute_path", "filePath", "file"]);
  if (!path) return "";
  const name = basename(path);
  const suffix = pagesSuffix(input);
  return suffix ? `${name} ${suffix}` : name;
}

/** Result titles/links from a search result, parsed leniently: JSON objects, markdown links, then bare URLs. */
export function parseLinks(text: string | undefined): WebLink[] {
  if (!text) return [];
  const out: WebLink[] = [];
  const seen = new Set<string>();
  const add = (title: string, url?: string) => {
    const key = `${title}|${url ?? ""}`;
    if (!title && !url) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title: title || url || "", url });
  };
  const fromJson = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(fromJson);
    else if (isRecord(v)) {
      const url = str(v.url) || str(v.link) || str(v.uri);
      const title = str(v.title) || str(v.name);
      if (url || title) add(title, url || undefined);
      else Object.values(v).forEach((x) => typeof x === "object" && fromJson(x));
    }
  };
  for (const m of text.matchAll(/(\[\s*\{[\s\S]*?\}\s*\])/g)) {
    try {
      fromJson(JSON.parse(m[1]!));
    } catch {
      /* not JSON */
    }
  }
  if (out.length === 0) {
    try {
      fromJson(JSON.parse(text));
    } catch {
      /* not JSON */
    }
  }
  if (out.length === 0) for (const m of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) add(m[1]!.trim(), m[2]);
  if (out.length === 0) for (const m of text.matchAll(/^\s*(?:[-*\d.)]+\s*)?(.*?)\s*[:–-]?\s*(https?:\/\/[^\s)>\]]+)/gm)) add(m[1]!.trim().replace(/[:–-]+$/, "").trim(), m[2]);
  return out;
}
