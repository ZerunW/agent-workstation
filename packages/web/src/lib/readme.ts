import type { ReadmeDocName } from "@agent-workstation/protocol";
import { ApiError, api } from "./api";

/** The two readme pages: tab label key, route and hub doc name. */
export const README_TABS: { doc: ReadmeDocName; path: string; label: "readme.tab.features" | "readme.tab.getStarted" }[] = [
  { doc: "features", path: "/readme", label: "readme.tab.features" },
  { doc: "getting-started", path: "/readme/get-started", label: "readme.tab.getStarted" },
];

export type ReadmeBlock = { kind: "md"; text: string } | { kind: "details"; summary: string; open: boolean; body: ReadmeBlock[] };

interface Frame {
  summary: string;
  hasSummary: boolean;
  open: boolean;
  body: ReadmeBlock[];
}

const TAG = /<details(\s[^>]*)?>|<\/details\s*>|<summary[^>]*>([\s\S]*?)<\/summary\s*>/gi;

/** Markdown/HTML reduced to its visible text (summaries and headings are rendered as plain text). */
export function plainText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

/**
 * Splits Markdown into plain Markdown runs and `<details><summary>…</summary>…</details>` sections (nestable), so the
 * folded sections render as real disclosure elements without allowing raw HTML into the Markdown renderer. Tags count
 * only at the start of a line and never inside code fences.
 */
export function parseReadme(md: string): ReadmeBlock[] {
  const root: ReadmeBlock[] = [];
  const stack: Frame[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const current = () => (stack.length ? stack[stack.length - 1].body : root);
  const flush = () => {
    const text = buf.join("\n");
    buf = [];
    if (text.trim()) current().push({ kind: "md", text });
  };
  const close = () => {
    flush();
    const f = stack.pop();
    if (f) current().push({ kind: "details", summary: f.summary, open: f.open, body: f.body });
  };

  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      buf.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === "") fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      buf.push(line);
      continue;
    }
    if (!/^\s*<\/?(details|summary)\b/i.test(line)) {
      buf.push(line);
      continue;
    }
    let last = 0;
    const text = (to: number) => {
      const piece = line.slice(last, to).trim();
      if (piece) buf.push(piece);
    };
    for (const m of line.matchAll(TAG)) {
      text(m.index);
      last = m.index + m[0].length;
      if (/^<details/i.test(m[0])) {
        flush();
        stack.push({ summary: "", hasSummary: false, open: /\sopen\b/i.test(m[1] ?? ""), body: [] });
      } else if (/^<\/details/i.test(m[0])) {
        close();
      } else {
        const top = stack[stack.length - 1];
        if (top && !top.hasSummary) {
          top.summary = plainText(m[2] ?? "");
          top.hasSummary = true;
        }
      }
    }
    text(line.length);
  }
  while (stack.length) close();
  flush();
  return root;
}

/** Anchor id of a heading (the same function names the rendered `##` and its table-of-contents entry). */
export function headingId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return `readme-${slug || "section"}`;
}

export interface TocEntry {
  id: string;
  text: string;
}

/** The `##` headings outside folded sections and code fences. */
export function tableOfContents(blocks: ReadmeBlock[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const b of blocks) {
    if (b.kind !== "md") continue;
    let fence: string | null = null;
    for (const line of b.text.split("\n")) {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence) continue;
      const h = /^ {0,3}##\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      if (h) {
        const text = plainText(h[1]);
        out.push({ id: headingId(text), text });
      }
    }
  }
  return out;
}

export interface AskMessage {
  role: "user" | "assistant";
  text: string;
}

/** What goes to the hub: at most 20 turns of at most 4,000 characters, starting with a user turn. */
export function askPayload(history: AskMessage[]): AskMessage[] {
  const msgs = history.slice(-20).map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
  while (msgs.length > 1 && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

/** One parsed SSE event. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a text stream into SSE events (blank-line separated; `event:` and `data:` fields). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parse = (block: string): SseEvent | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = parse(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) yield ev;
      }
      if (done) break;
    }
    const rest = parse(buf);
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Asks the docs assistant and calls `onDelta` with each piece of the answer. Rejects with an `ApiError` (403 when the
 * assistant is not available, also for an `error` event with that code).
 */
export async function askReadme(messages: AskMessage[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await api.readmeAsk({ messages: askPayload(messages) }, signal);
  if (!res.body) throw new ApiError(res.status, "No answer", "no_body");
  for await (const ev of readSse(res.body)) {
    let data: { text?: unknown; code?: unknown; message?: unknown } = {};
    try {
      data = JSON.parse(ev.data);
    } catch {}
    if (ev.event === "delta" && typeof data.text === "string") onDelta(data.text);
    else if (ev.event === "error") {
      const code = typeof data.code === "string" ? data.code : undefined;
      throw new ApiError(code === "api_unavailable" ? 403 : 500, typeof data.message === "string" ? data.message : "Error", code);
    } else if (ev.event === "done") return;
  }
}
