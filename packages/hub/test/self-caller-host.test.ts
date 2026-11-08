/**
 * The server calling itself (self_caller), the Host check against DNS rebinding (bad_host) and the cross-site
 * navigation exception decided on the decoded path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIp, hostnameOf, isPageNavigation, normalizedPath, OriginPolicy } from "../src/origin.js";
import type { TailscaleSelf, TailscaleWho, TailscaleWhois } from "../src/tailscale.js";
import { hubFixture, type HubFixture } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SELF: TailscaleSelf = { dnsName: "workstation.tailnet.ts.net", ips: ["100.64.0.9", "fd7a:115c:a1e0::9"] };
const OWNER_IP = "100.64.0.20";

function whoisOf(): TailscaleWhois & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: async (ip: string): Promise<TailscaleWho | null> => {
      calls.push(ip);
      // The server node itself maps to its owner, exactly the confusion the self_caller check closes.
      return ip === OWNER_IP || ip === "100.64.0.9" || ip === "fd7a:115c:a1e0::9" ? { login: "owner@example.com", node: "owner" } : { login: "alice@example.com", node: "laptop" };
    },
  };
}

async function fixture(opts: { identity?: boolean; lan?: "legacy" | "deny"; allowed?: string[]; selfCalls?: { n: number }; selfFails?: boolean; web?: boolean } = {}): Promise<HubFixture & { whois: ReturnType<typeof whoisOf> }> {
  const whois = whoisOf();
  const f = await hubFixture(
    {
      tailscaleWhois: whois,
      tailscaleSelf: {
        self: async () => {
          if (opts.selfCalls) opts.selfCalls.n++;
          if (opts.selfFails) throw new Error("tailscaled down");
          return SELF;
        },
      },
    },
    () => ({
      server: { public_url: "https://ws.example.com", allowed_origins: opts.allowed ?? [] },
      auth: { tailscale_identity: opts.identity ?? true, lan_access: opts.lan ?? "deny", admin_logins: ["owner@example.com"], admin_usernames: ["admin"] },
    }),
  );
  cleanups.push(() => f.close());
  return Object.assign(f, { whois });
}

/** A request through nginx: loopback peer, X-Forwarded-For = the client address. */
const via = (f: HubFixture, ip: string | null, url = "/api/me", user = "admin") =>
  f.app.inject({ method: "GET", url, headers: { "x-workstation-user": user, ...(ip ? { "x-forwarded-for": ip } : {}) } });

/** Upgrade context of a WebSocket client behind nginx. */
const upgrade = (headers: Record<string, string>) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-workstation-user": "admin", ...headers } }) as never;

describe("self_caller", () => {
  it("refuses requests whose client address is one of this server's own Tailscale addresses, whatever the user header", async () => {
    for (const identity of [true, false]) {
      const f = await fixture({ identity });
      for (const ip of ["100.64.0.9", "fd7a:115c:a1e0::9", "FD7A:115C:A1E0:0:0:0:0:9"]) {
        const r = await via(f, ip, "/api/admin/settings?user=admin");
        expect(r.statusCode, `${identity} ${ip}`).toBe(403);
        expect(r.json().code).toBe("self_caller");
      }
      // Directly from the address (no nginx) and through the IPv4-mapped spelling.
      const direct = await f.app.inject({ method: "GET", url: "/api/me", remoteAddress: "100.64.0.9", headers: { "x-workstation-user": "admin" } });
      expect(direct.json().code).toBe("self_caller");
      const mapped = await f.app.inject({ method: "GET", url: "/api/me", remoteAddress: "::ffff:100.64.0.9", headers: { "x-workstation-user": "admin" } });
      expect(mapped.json().code).toBe("self_caller");
      expect(f.hub.store.getUser("admin")).toBeNull();
    }
  });

  it("does not ask tailscaled whois about the server itself and queries tailscaled for its address only once", async () => {
    const selfCalls = { n: 0 };
    const f = await fixture({ selfCalls });
    for (let i = 0; i < 3; i++) await via(f, "100.64.0.9");
    await via(f, OWNER_IP);
    expect(f.whois.calls).toEqual([OWNER_IP]);
    expect(selfCalls.n).toBe(1);
  });

  it("the health routes still answer it; other open routes and WebSocket upgrades do not", async () => {
    const f = await fixture();
    for (const url of ["/api/health", "/healthz"]) expect((await via(f, "100.64.0.9", url)).statusCode, url).toBe(200);
    for (const url of ["/api/readme/features", "/api/app/releases", "/api/visual-cdn/cdn.jsdelivr.net/x.js", "/download"]) {
      const r = await via(f, "100.64.0.9", url);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code, url).toBe("self_caller");
    }
    await expect(f.app.injectWS("/ws", upgrade({ host: "localhost", "x-forwarded-for": "100.64.0.9" }))).rejects.toThrow(/403/);
    const ok = await f.app.injectWS("/ws", upgrade({ host: "localhost", "x-forwarded-for": OWNER_IP }));
    ok.terminate();
  });

  it("loopback tools (no X-Forwarded-For) and other tailnet devices are not affected", async () => {
    const f = await fixture();
    const local = await via(f, null);
    expect(local.statusCode).toBe(200);
    const other = await via(f, "100.64.0.21", "/api/me", "alice");
    expect(other.statusCode).toBe(200);
    expect(other.json().user.isAdmin).toBe(false);
    const owner = await via(f, OWNER_IP, "/api/me", "boss");
    expect(owner.json().user.isAdmin).toBe(true);
  });

  it("when tailscaled cannot be asked the check cannot tell and the request is handled as usual", async () => {
    const f = await fixture({ selfFails: true, identity: false });
    expect((await via(f, "100.64.0.9")).statusCode).toBe(200);
  });
});

describe("Host check", () => {
  const host = (f: HubFixture, h: string | undefined, url = "/api/me") =>
    f.app.inject({ method: "GET", url, headers: { "x-workstation-user": "admin", ...(h === undefined ? {} : { host: h }) } });

  it("answers this server's names and refuses every other one with 421 bad_host", async () => {
    const f = await fixture({ allowed: ["https://extra.example.com:8443"] });
    for (const h of ["ws.example.com", "WS.Example.com:443", "workstation.tailnet.ts.net", "workstation.tailnet.ts.net.", "100.64.0.9", "100.64.0.9:80", "[fd7a:115c:a1e0::9]", "[FD7A:115C:A1E0:0:0:0:0:9]:443", "localhost:9000", "127.0.0.1:9000", "[::1]:9000", "extra.example.com"]) {
      expect((await host(f, h)).statusCode, h).toBe(200);
    }
    for (const h of ["evil.example", "evil.example:9000", "ws.example.com.evil.example", "workstation.tailnet.ts.net.evil.example", "100.64.0.10", "192.168.1.5", "attacker@ws.example.com", "ws.example.com/x"]) {
      const r = await host(f, h);
      expect(r.statusCode, String(h)).toBe(421);
      expect(r.json().code).toBe("bad_host");
    }
  });

  it("the health routes stay open for any Host", async () => {
    const f = await fixture();
    for (const url of ["/api/health", "/healthz"]) expect((await host(f, "evil.example", url)).statusCode, url).toBe(200);
    expect((await host(f, "evil.example", "/api/readme/features")).statusCode).toBe(421);
  });

  it("covers WebSocket upgrades and unknown paths", async () => {
    const f = await fixture();
    await expect(f.app.injectWS("/ws", upgrade({ host: "evil.example" }))).rejects.toThrow(/421/);
    const ws = await f.app.injectWS("/ws", upgrade({ host: "workstation.tailnet.ts.net" }));
    ws.terminate();
    expect((await host(f, "evil.example", "/no/such/page")).statusCode).toBe(421);
  });

  it("the LAN address of this machine is a name of the server only when lan_access allows LAN callers", () => {
    const cfg = (lanAccess: "legacy" | "deny") => ({ server: { host: "127.0.0.1", port: 9000, publicUrl: "https://a.example.com", allowedOrigins: [] }, auth: { lanAccess } });
    const self = { self: async () => SELF };
    const legacy = new OriginPolicy(cfg("legacy"), self, undefined, Date.now, () => ["192.168.1.50", "fe80::1"]);
    const deny = new OriginPolicy(cfg("deny"), self, undefined, Date.now, () => ["192.168.1.50"]);
    return Promise.all([
      expect(legacy.hostAllowed("192.168.1.50:9000")).resolves.toBe(true),
      expect(legacy.hostAllowed("192.168.1.51")).resolves.toBe(false),
      expect(legacy.hostAllowed("lan-name.example")).resolves.toBe(false),
      expect(deny.hostAllowed("192.168.1.50")).resolves.toBe(false),
    ]);
  });

  it("parses Host values", () => {
    expect(hostnameOf("Example.COM:8080")).toBe("example.com");
    expect(hostnameOf("example.com.")).toBe("example.com");
    expect(hostnameOf("[::1]:9000")).toBe("::1");
    expect(hostnameOf("[::ffff:100.64.0.9]")).toBe("100.64.0.9");
    expect(hostnameOf("a b")).toBeNull();
    expect(hostnameOf("a@b")).toBeNull();
    expect(hostnameOf("a:b:c")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
    expect(canonicalIp("FD7A:115C:A1E0:0:0:0:0:9")).toBe("fd7a:115c:a1e0::9");
  });
});

describe("cross-site top-level navigation decided on the decoded path", () => {
  const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const get = (f: HubFixture, url: string, method: "GET" | "POST" = "GET") => f.app.inject({ method, url, headers: { "x-workstation-user": "admin", ...nav } });

  it("refuses percent-encoded, double-encoded, dot-segment and double-slash spellings of API paths", async () => {
    const f = await fixture();
    for (const url of ["/api/me", "/%61pi/me", "/%61%70%69/me", "/%2561pi/me", "//api/me", "/./api/me", "/x/../api/me", "/%2e/api/me", "/api%2fme", "/ws", "/%77s", "/internal/x", "/api"]) {
      const r = await get(f, url);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code, url).toBe("cross_site");
    }
    expect((await get(f, "/", "POST")).statusCode).toBe(403);
  });

  it("still lets a cross-site navigation show a web page", async () => {
    const f = await fixture();
    for (const url of ["/", "/usage", "/some/page?x=1", "/download", "/index.html"]) {
      const r = await get(f, url);
      expect(r.statusCode, url).not.toBe(403);
    }
  });

  it("isPageNavigation: only the catch-all or no route, never an API path", () => {
    const headers = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const req = (url: string, routeUrl?: string, method = "GET") => ({ method, url, headers, routeOptions: { url: routeUrl } });
    expect(isPageNavigation(req("/usage"))).toBe(true);
    expect(isPageNavigation(req("/usage", "/*"))).toBe(true);
    expect(isPageNavigation(req("/%61pi/me", "/api/me"))).toBe(false);
    expect(isPageNavigation(req("/%61pi/nothing", "/*"))).toBe(false);
    expect(isPageNavigation(req("/page", "/api/me"))).toBe(false);
    expect(isPageNavigation(req("/page", undefined, "POST"))).toBe(false);
    expect(normalizedPath("//a/./b/../%63?x=1")).toBe("/a/c");
    expect(normalizedPath("/%zz")).toBeNull();
  });
});
