import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { SSE_HEADERS, SseHub, formatSse, formatSseComment } from "../src/sse.js";

describe("SSE framing", () => {
  it("emits event and data lines terminated by a blank line", () => {
    expect(formatSse({ event: "metrics", data: { t: 1, values: { a: 2 } } })).toBe('event: metrics\ndata: {"t":1,"values":{"a":2}}\n\n');
  });
  it("orders retry, id, event, data as the spec examples do", () => {
    expect(formatSse({ retry: 3000, id: 7, event: "hello", data: {} })).toBe("retry: 3000\nid: 7\nevent: hello\ndata: {}\n\n");
  });
  it("omits the event line for a plain message", () => {
    expect(formatSse({ data: "x" })).toBe("data: x\n\n");
  });
  it("splits multi-line string payloads over several data lines", () => {
    expect(formatSse({ event: "log", data: "a\nb\r\nc" })).toBe("event: log\ndata: a\ndata: b\ndata: c\n\n");
  });
  it("JSON-encoded payloads never contain raw newlines, so one data line suffices", () => {
    const frame = formatSse({ data: { text: "line1\nline2" } });
    expect(frame).toBe('data: {"text":"line1\\nline2"}\n\n');
    expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(1);
  });
  it("cannot be injected into through event names or ids", () => {
    expect(formatSse({ event: "a\nevent: evil", id: "1\ndata: x", data: 1 })).toBe("id: 1 data: x\nevent: a event: evil\ndata: 1\n\n");
  });
  it("comments start with a colon", () => {
    expect(formatSseComment("keepalive")).toBe(": keepalive\n\n");
  });
  it("uses the headers browsers and reverse proxies need", () => {
    expect(SSE_HEADERS["Content-Type"]).toContain("text/event-stream");
    expect(SSE_HEADERS["Cache-Control"]).toContain("no-cache");
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
  });
});

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  head: { status: number; headers: Record<string, string> } | null = null;
  ended = false;
  destroyed = false;
  writableLength = 0;
  socket = { setNoDelay() {}, setKeepAlive() {} };
  failWrites = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.head = { status, headers };
    return this;
  }
  write(chunk: string) {
    if (this.failWrites) throw new Error("EPIPE");
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
  get body() {
    return this.chunks.join("");
  }
}
const asRes = (r: FakeRes) => r as unknown as ServerResponse;

describe("SseHub", () => {
  it("attach sends headers, the retry hint and a hello event", () => {
    const hub = new SseHub();
    const res = new FakeRes();
    hub.attach(asRes(res), { event: "hello", data: { v: 1 } }, 2500);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["Content-Type"]).toContain("text/event-stream");
    expect(res.body).toBe('retry: 2500\nevent: hello\ndata: {"v":1}\n\n');
    expect(hub.size).toBe(1);
  });

  it("broadcasts to every subscriber and forgets closed ones", () => {
    const hub = new SseHub();
    const a = new FakeRes();
    const b = new FakeRes();
    hub.attach(asRes(a));
    hub.attach(asRes(b));
    hub.broadcast("metrics", { t: 10, values: { cpu_total_pct: 5 } });
    expect(a.body.endsWith('event: metrics\ndata: {"t":10,"values":{"cpu_total_pct":5}}\n\n')).toBe(true);
    expect(b.body).toEqual(a.body);
    a.emit("close");
    expect(hub.size).toBe(1);
    hub.broadcast("health", { checks: [] });
    expect(a.body).not.toContain("event: health");
    expect(b.body).toContain("event: health");
  });

  it("drops a subscriber whose socket throws, without hurting the others", () => {
    const hub = new SseHub();
    const bad = new FakeRes();
    const good = new FakeRes();
    hub.attach(asRes(bad));
    hub.attach(asRes(good));
    bad.failWrites = true;
    hub.broadcast("probe", {});
    expect(hub.size).toBe(1);
    expect(bad.destroyed).toBe(true);
    expect(good.body).toContain("event: probe");
  });

  it("drops hopelessly slow subscribers", () => {
    const hub = new SseHub();
    const slow = new FakeRes();
    hub.attach(asRes(slow));
    slow.writableLength = 10 * 1024 * 1024;
    hub.broadcast("metrics", {});
    expect(hub.size).toBe(0);
  });

  it("sends keep-alive comments and closes everything on shutdown", () => {
    const hub = new SseHub();
    const res = new FakeRes();
    hub.attach(asRes(res));
    hub.ping();
    expect(res.body.endsWith(": keepalive\n\n")).toBe(true);
    hub.closeAll();
    expect(res.ended).toBe(true);
    expect(hub.size).toBe(0);
  });
});
