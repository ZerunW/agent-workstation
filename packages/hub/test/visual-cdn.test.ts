/**
 * GET /api/visual-cdn/:host/*: only the two CDN hosts and path prefixes, fetched once by the server and cached, scripts
 * and styles only, size cap, no redirects to other hosts, open route.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { isOpenRoute } from "../src/auth.js";
import { registerVisualCdnRoutes, visualCdnUpstream } from "../src/routes/visualCdn.js";

const cacheDirs = new WeakMap<object, string>();
const dirOf = (a: object): string => cacheDirs.get(a)!;

function app(fetchImpl: typeof fetch, cap: { maxBytes?: number; maxFiles?: number; maxDownloads?: number; maxWaiting?: number } = {}) {
  const a = Fastify();
  a.setErrorHandler((err: Error & { status?: number; code?: string }, _req, reply) => {
    void reply.status(err.status ?? 500).send({ code: err.code, error: err.message });
  });
  const cacheDir = mkdtempSync(join(tmpdir(), "vcdn-"));
  cacheDirs.set(a, cacheDir);
  registerVisualCdnRoutes(a, { cacheDir, fetch: fetchImpl, ...cap });
  return a;
}

const js = (body: string, over: Partial<{ status: number; type: string; url: string; length: string }> = {}) =>
  vi.fn(async (url: string | URL) => {
    const headers = new Headers({ "content-type": over.type ?? "application/javascript; charset=utf-8" });
    if (over.length) headers.set("content-length", over.length);
    const res = new Response(body, { status: over.status ?? 200, headers });
    Object.defineProperty(res, "url", { value: over.url ?? String(url) });
    return res;
  });

describe("visual CDN proxy", () => {
  it("allows only cdnjs ajax/libs and jsdelivr npm paths", () => {
    expect(visualCdnUpstream("cdn.jsdelivr.net", "npm/chart.js@4.4.1/dist/chart.umd.min.js")).toBe("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js");
    expect(visualCdnUpstream("cdnjs.cloudflare.com", "ajax/libs/d3/7.9.0/d3.min.js")).toBe("https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js");
    expect(visualCdnUpstream("cdn.jsdelivr.net", "gh/attacker/repo@data/x.js")).toBeNull();
    expect(visualCdnUpstream("evil.example", "npm/x.js")).toBeNull();
    expect(visualCdnUpstream("cdn.jsdelivr.net", "npm/../x.js")).toBeNull();
    expect(visualCdnUpstream("cdn.jsdelivr.net", "npm/x.js?a=b")).toBeNull();
    expect(isOpenRoute("/api/visual-cdn/:host/*")).toBe(true);
  });

  it("fetches once, then serves from the server's cache with script headers", async () => {
    const f = js("window.lib=1;");
    const a = app(f as unknown as typeof fetch);
    const url = "/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.0/lib.min.js";
    for (let i = 0; i < 2; i++) {
      const r = await a.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe("window.lib=1;");
      expect(r.headers["content-type"]).toMatch(/javascript/);
      expect(r.headers["access-control-allow-origin"]).toBe("*");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe("https://cdn.jsdelivr.net/npm/lib@1.0.0/lib.min.js");
  });

  it("a full cache evicts the least recently used file instead of refusing to cache", async () => {
    const f = js("window.lib=1;");
    const a = app(f as unknown as typeof fetch, { maxFiles: 2 });
    const get = (n: number) => a.inject({ method: "GET", url: `/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.${n}/lib.min.js` });
    for (const n of [1, 2]) expect((await get(n)).statusCode).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect((await get(1)).body).toBe("window.lib=1;"); // 1 is now the most recently used
    expect(f).toHaveBeenCalledTimes(2);
    expect((await get(3)).statusCode).toBe(200); // evicts 2
    expect(f).toHaveBeenCalledTimes(3);
    for (const n of [1, 3]) expect((await get(n)).body).toBe("window.lib=1;");
    expect(f).toHaveBeenCalledTimes(3); // 1 and 3 are cached
    expect((await get(2)).body).toBe("window.lib=1;");
    expect(f).toHaveBeenCalledTimes(4); // 2 was evicted and is fetched again (and now keeps the cache at two files)
    const files = readdirSync(dirOf(a)).filter((n) => !n.endsWith(".json") && !n.endsWith(".tmp"));
    expect(files).toHaveLength(2);
  });

  it("the byte limit evicts too, and a file bigger than the whole cache is served without being kept", async () => {
    const body = "0123456789".repeat(10); // 100 bytes plus its note
    const f = js(body);
    const a = app(f as unknown as typeof fetch, { maxBytes: 350 });
    const get = (n: number) => a.inject({ method: "GET", url: `/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.${n}/a.js` });
    for (const n of [1, 2, 3, 4]) expect((await get(n)).body).toBe(body);
    const held = readdirSync(dirOf(a)).filter((n) => !n.endsWith(".json") && !n.endsWith(".tmp")).length;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(4);
    const small = app(js("0123456789") as unknown as typeof fetch, { maxBytes: 5 });
    expect((await small.inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.0/a.js" })).body).toBe("0123456789");
    expect(readdirSync(dirOf(small))).toEqual([]);
  });

  it("an existing cache on disk is counted: the oldest files go first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcdn-"));
    const key = (u: string) => createHash("sha256").update(u).digest("hex");
    const url = (n: number) => `https://cdn.jsdelivr.net/npm/lib@1.0.${n}/lib.min.js`;
    for (const [n, age] of [[1, 3000], [2, 2000]] as const) {
      writeFileSync(join(dir, key(url(n))), "old");
      writeFileSync(join(dir, `${key(url(n))}.json`), JSON.stringify({ contentType: "application/javascript", url: url(n) }));
      const t = new Date(Date.now() - age * 1000);
      utimesSync(join(dir, key(url(n))), t, t);
    }
    const f = js("new");
    const a = Fastify();
    registerVisualCdnRoutes(a, { cacheDir: dir, fetch: f as unknown as typeof fetch, maxFiles: 2 });
    const get = (n: number) => a.inject({ method: "GET", url: `/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.${n}/lib.min.js` });
    expect((await get(3)).body).toBe("new");
    expect(existsSync(join(dir, key(url(1))))).toBe(false); // the oldest
    expect(existsSync(join(dir, key(url(2))))).toBe(true);
    expect((await get(2)).body).toBe("old");
  });

  it("at most four upstream downloads run at once; the others wait, and too many waiting get 503", async () => {
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const f = vi.fn(async (url: string | URL) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => gates.push(r));
      running -= 1;
      const res = new Response("x", { status: 200, headers: { "content-type": "application/javascript" } });
      Object.defineProperty(res, "url", { value: String(url) });
      return res;
    });
    const a = app(f as unknown as typeof fetch, { maxWaiting: 3 });
    const get = (n: number) => a.inject({ method: "GET", url: `/api/visual-cdn/cdn.jsdelivr.net/npm/lib@1.0.${n}/a.js` });
    const first = Array.from({ length: 7 }, (_, n) => get(n)); // 4 run, 3 wait
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    const refused = await get(99); // the 8th has no place to wait
    expect(refused.statusCode).toBe(503);
    expect(peak).toBe(4);
    // let them through, one by one: the waiting ones start as slots free up
    for (let done = 0; done < 7; done++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    const results = await Promise.all(first);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(peak).toBe(4);
  });

  it("refuses other hosts, query strings, non-script types, oversize files and cross-host redirects", async () => {
    expect((await app(js("x") as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/evil.example/npm/x.js" })).statusCode).toBe(404);
    expect((await app(js("x") as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/x.js?d=secret" })).statusCode).toBe(400);
    expect((await app(js("<html>", { type: "text/html" }) as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/x.js" })).statusCode).toBe(415);
    expect((await app(js("x", { length: String(9 * 1024 * 1024) }) as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/x.js" })).statusCode).toBe(413);
    expect((await app(js("", { status: 404 }) as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/nope.js" })).statusCode).toBe(404);
  });

  describe("redirects", () => {
    const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
    const ok = () => new Response("window.lib=2;", { status: 200, headers: { "content-type": "application/javascript" } });
    const get = (a: ReturnType<typeof app>, path = "npm/lib@1/lib.js") => a.inject({ method: "GET", url: `/api/visual-cdn/cdn.jsdelivr.net/${path}` });

    it("follows a redirect to the same host (absolute or relative) with redirect: manual", async () => {
      const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        const u = String(url);
        if (u.endsWith("/npm/lib@1/lib.js")) return redirect("/npm/lib@1.2.3/lib.js", 301);
        if (u.endsWith("/npm/lib@1.2.3/lib.js")) return redirect("https://cdn.jsdelivr.net/npm/lib@1.2.3/dist/lib.js", 307);
        return ok();
      });
      const r = await get(app(f as unknown as typeof fetch));
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe("window.lib=2;");
      expect(f.mock.calls.map((c) => String(c[0]))).toEqual([
        "https://cdn.jsdelivr.net/npm/lib@1/lib.js",
        "https://cdn.jsdelivr.net/npm/lib@1.2.3/lib.js",
        "https://cdn.jsdelivr.net/npm/lib@1.2.3/dist/lib.js",
      ]);
    });

    it("refuses any other target before requesting it", async () => {
      for (const to of ["https://evil.example/x.js", "http://cdn.jsdelivr.net/npm/x.js", "https://cdn.jsdelivr.net.evil.example/x.js", "https://cdn.jsdelivr.net:8443/x.js", "https://user@cdn.jsdelivr.net/x.js", "//evil.example/x.js", "https://cdnjs.cloudflare.com/ajax/libs/x/1/x.js"]) {
        const f = vi.fn(async () => redirect(to));
        const r = await get(app(f as unknown as typeof fetch));
        expect(r.statusCode, to).toBe(502);
        expect(r.json().code).toBe("upstream_error");
        expect(f, to).toHaveBeenCalledTimes(1); // only the original URL was requested
      }
    });

    it("gives up after three redirects and on a redirect without a target", async () => {
      const f = vi.fn(async (url: string | URL) => redirect(`${String(url)}x`));
      const r = await get(app(f as unknown as typeof fetch));
      expect(r.statusCode).toBe(502);
      expect(f).toHaveBeenCalledTimes(4); // the request and three followed redirects
      const none = vi.fn(async () => new Response(null, { status: 302 }));
      expect((await get(app(none as unknown as typeof fetch))).statusCode).toBe(502);
    });
  });

  it("aborts a body that grows past 8 MB while streaming (no content-length, never read to the end)", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk); // endless
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = vi.fn(async (url: string | URL) => {
      const res = new Response(body, { status: 200, headers: { "content-type": "application/javascript" } });
      Object.defineProperty(res, "url", { value: String(url) });
      return res;
    });
    const r = await app(f as unknown as typeof fetch).inject({ method: "GET", url: "/api/visual-cdn/cdn.jsdelivr.net/npm/huge.js" });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("too_large");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20); // stopped right after the 8 MB mark, not buffered to the end
  });
});
