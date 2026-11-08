import { basename } from "./format";
import { isRecord } from "./sdk";

/** The chats' download tool (`download_file` of the hub's fetch server). */
export const DOWNLOAD_TOOL = "mcp__workstation_fetch__download_file";
export const isDownloadTool = (name: string): boolean => name === DOWNLOAD_TOOL;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface DownloadCall {
  url: string;
  /** The host as the URL parser writes it (punycode for look-alikes); "" while the URL is missing or half-streamed. */
  host: string;
  filename: string;
  /** The safety check's reason for an unknown host; only on the permission request. */
  reason: string;
}

/** The parts of a (partial) `download_file` input: `{ url, filename?, check? }`. */
export function parseDownload(input: unknown): DownloadCall {
  const i = isRecord(input) ? input : {};
  const url = str(i.url);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* half-streamed or not a URL */
  }
  return { url, host, filename: str(i.filename), reason: isRecord(i.check) ? str(i.check.reason) : "" };
}

/** The file name a call stands for: the given one, else the URL's last path segment. */
export function downloadName(call: Pick<DownloadCall, "url" | "filename">): string {
  if (call.filename) return call.filename;
  try {
    const seg = basename(decodeURIComponent(new URL(call.url).pathname));
    if (seg) return seg;
  } catch {
    /* not a URL */
  }
  return call.url;
}

/** What the tool answers on success: the saved path (relative to the chat folder) and the size, as JSON or `path: …` / `size: …` lines. */
export function downloadResult(text: string | undefined): { path?: string; size?: number } {
  if (!text) return {};
  let path: string | undefined;
  let size: number | undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (isRecord(v)) {
      path = str(v.path) || undefined;
      size = typeof v.size === "number" ? v.size : undefined;
    }
  } catch {
    path = /^\s*path\s*[:=]\s*(.+?)\s*$/im.exec(text)?.[1];
    const n = /^\s*size\s*[:=]\s*(\d+)/im.exec(text)?.[1];
    size = n ? Number(n) : undefined;
  }
  return { ...(path ? { path } : {}), ...(size !== undefined ? { size } : {}) };
}

/** A URL cut where its query (or fragment) starts, so the two can be styled apart. */
export function splitUrl(url: string): { base: string; rest: string } {
  const i = url.search(/[?#]/);
  return i < 0 ? { base: url, rest: "" } : { base: url.slice(0, i), rest: url.slice(i) };
}
