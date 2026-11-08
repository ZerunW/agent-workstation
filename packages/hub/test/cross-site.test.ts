/**
 * Cross-site protection: requests carrying a disallowed Origin or Sec-Fetch-Site: cross-site are refused (HTTP and every
 * WebSocket upgrade); same-origin and header-less native requests keep working.
 */
import { afterEach, describe, expect, it } from "vitest";
import { normalizeOrigin, OriginPolicy } from "../src/origin.js";
import type { TailscaleSelf } from "../src/tailscale.js";
import { hubFixture, type HubFixture } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SELF: TailscaleSelf = { dnsName: "workstation.tailnet.ts.net", ips: ["100.64.0.9"] };

async function fixture(allowed: string[] = []): Promise<HubFixture> {
  const f = await hubFixture({ tailscaleSelf: { self: async () => SELF } }, () => ({ server: { public_url: "https://ws.example.com", allowed_origins: allowed } }));
  cleanups.push(() => f.close());
  return f;
}

const get = (f: HubFixture, headers: Record<string, string>, url = "/api/me") => f.app.inject({ method: "GET", url, headers: f.as("alice", headers) });

describe("origin policy", () => {
  it("normalizes origins", () => {
    expect(normalizeOrigin("https://Example.com:443/x")).toBe("https://example.com");
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("file:///x")).toBeNull();
  });

  it("allows public_url, this server's Tailscale name and address, loopback with the hub port, and configured extras", async () => {
    const f = await fixture(["https://extra.example.com"]);
    const port = f.hub.config.server.port;
    for (const o of ["https://ws.example.com", "https://workstation.tailnet.ts.net", "http://100.64.0.9", "https://100.64.0.9", `http://127.0.0.1:${port}`, `http://localhost:${port}`, "https://extra.example.com"]) {
      expect(await f.hub.origins.allowed(o), o).toBe(true);
    }
    for (const o of ["https://evil.example", "http://ws.example.com", "https://workstation.tailnet.ts.net.evil.example", "null", "http://100.64.0.10", "http://127.0.0.1:1"]) {
      expect(await f.hub.origins.allowed(o), o).toBe(false);
    }
  });

  it("still allows the fixed origins when tailscaled cannot be asked", async () => {
    const p = new OriginPolicy({ server: { host: "127.0.0.1", port: 9000, publicUrl: "https://a.example.com", allowedOrigins: [] } }, { self: async () => Promise.reject(new Error("down")) });
    expect(await p.allowed("https://a.example.com")).toBe(true);
    expect(await p.allowed("https://b.example.com")).toBe(false);
  });
});

describe("HTTP", () => {
  it("refuses a disallowed Origin and cross-site fetches on every method, with code cross_site", async () => {
    const f = await fixture();
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const r = await f.app.inject({ method, url: "/api/me", headers: f.as("alice", { origin: "https://evil.example" }) });
      expect(r.statusCode, method).toBe(403);
      expect(r.json().code).toBe("cross_site");
    }
    const s = await get(f, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" });
    expect(s.statusCode).toBe(403);
    expect(s.json().code).toBe("cross_site");
    // ?user= GETs (downloads) are covered too
    const d = await f.app.inject({ method: "GET", url: "/api/me?user=alice", headers: { "sec-fetch-site": "cross-site" } });
    expect(d.statusCode).toBe(403);
    // open routes as well
    const h = await f.app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(h.statusCode).toBe(403);
  });

  it("allows same-origin, allowed origins and requests without Origin (native clients)", async () => {
    const f = await fixture();
    expect((await get(f, {})).statusCode).toBe(200);
    expect((await get(f, { origin: "https://ws.example.com", "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await get(f, { origin: "https://workstation.tailnet.ts.net" })).statusCode).toBe(200);
    expect((await get(f, { "sec-fetch-site": "none" })).statusCode).toBe(200);
  });

  it("a cross-site top-level navigation to a web page is not refused, to the API it is", async () => {
    const f = await fixture();
    const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect((await get(f, nav, "/")).statusCode).not.toBe(403);
    expect((await get(f, nav, "/api/me")).statusCode).toBe(403);
  });

  it("the visual library route (loaded by sandboxed frames) is exempt", async () => {
    const f = await fixture();
    const r = await f.app.inject({ method: "GET", url: "/api/visual-cdn/evil.example/x.js", headers: { origin: "null", "sec-fetch-site": "cross-site" } });
    expect(r.statusCode).toBe(404); // reached the route, not refused as cross_site
  });
});

describe("WebSocket upgrades", () => {
  const open = (f: HubFixture, url: string, headers: Record<string, string>) => f.app.injectWS(url, { headers: f.as("alice", { host: "localhost", ...headers }) } as never);

  it("/ws: a browser page from another site is refused (403), allowed and header-less clients connect", async () => {
    const f = await fixture();
    await expect(open(f, "/ws", { origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(open(f, "/ws", { origin: "null" })).rejects.toThrow(/403/);
    await expect(open(f, "/ws", { "sec-fetch-site": "cross-site" })).rejects.toThrow(/403/);
    for (const headers of [{}, { origin: "https://ws.example.com" }] as Array<Record<string, string>>) {
      const ws = await open(f, "/ws", headers);
      ws.terminate();
    }
  });

  it("/ws/terminal/:id is guarded the same way", async () => {
    const f = await fixture();
    await expect(open(f, "/ws/terminal/abc", { origin: "https://evil.example" })).rejects.toThrow(/403/);
    const ws = await open(f, "/ws/terminal/abc", { origin: "https://ws.example.com" });
    ws.terminate();
  });
});
