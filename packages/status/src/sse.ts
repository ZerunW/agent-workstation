/** Server-Sent Events: wire framing and a tiny broadcast hub. */
import type { ServerResponse } from "node:http";

export interface SseMessage {
  event?: string;
  data: unknown;
  id?: string | number;
  /** Reconnection delay hint for the browser, in milliseconds. */
  retry?: number;
}

/**
 * Serialise one SSE message. `data` is JSON-encoded unless it already is a string; embedded
 * newlines in strings are split over several `data:` lines as the spec requires. The message
 * ends with the mandatory blank line.
 */
export function formatSse(msg: SseMessage): string {
  let out = "";
  if (msg.retry !== undefined) out += `retry: ${Math.max(0, Math.floor(msg.retry))}\n`;
  if (msg.id !== undefined) out += `id: ${String(msg.id).replace(/[\r\n]/g, " ")}\n`;
  if (msg.event) out += `event: ${msg.event.replace(/[\r\n]/g, " ")}\n`;
  const payload = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
  for (const line of payload.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** A comment line: ignored by EventSource, keeps proxies and NATs from idling the connection out. */
export function formatSseComment(text: string): string {
  return `: ${text.replace(/[\r\n]/g, " ")}\n\n`;
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Drop a subscriber that is this far behind (bytes buffered in the socket). */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  get size(): number {
    return this.clients.size;
  }

  /** Start streaming on `res` (headers + retry hint) and register it. Returns a function that unregisters it. */
  attach(res: ServerResponse, hello?: SseMessage, retryMs = 3000): () => void {
    res.writeHead(200, SSE_HEADERS);
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true);
    res.write(formatSse({ retry: retryMs, event: hello?.event ?? "hello", data: hello?.data ?? {} }));
    this.clients.add(res);
    const remove = () => {
      this.clients.delete(res);
    };
    res.on("close", remove);
    res.on("error", remove);
    return remove;
  }

  /** Send to every subscriber; a failing or hopelessly slow client is dropped. */
  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    this.write(formatSse({ event, data }));
  }

  /** Send a keep-alive comment to everyone. */
  ping(): void {
    if (this.clients.size === 0) return;
    this.write(formatSseComment("keepalive"));
  }

  startHeartbeat(everyMs = 15_000): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.ping(), everyMs);
    this.heartbeat.unref();
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }

  private write(frame: string): void {
    for (const res of [...this.clients]) {
      try {
        if (res.writableLength > MAX_BUFFERED_BYTES) throw new Error("slow client");
        res.write(frame);
      } catch {
        this.clients.delete(res);
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
