/**
 * Tailscale identity: client IP (nginx vs direct), tailscaled whois (fake LocalAPI, cache, tagged nodes, CLI
 * fallback), username binding, admin by login, lan_access legacy/deny, the WebSocket upgrade and open routes.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerEvent } from "@agent-workstation/protocol";
import { clientAddress } from "../src/identity.js";
import { isTailscaleIp, parseWhois, TailscaleWhoisClient, type TailscaleWho, type TailscaleWhois } from "../src/tailscale.js";
import { hubFixture, tempDir, until, type HubFixture } from "./helpers.js";

const ALICE_IP = "100.100.1.1";
const BOB_IP = "100.100.1.2";
const BOSS_IP = "100.100.1.3";
const TAGGED_IP = "100.100.1.4";
const LAN_IP = "192.168.1.50";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// ------------------------------------------------------------------ client IP

describe("clientAddress", () => {
  it("loopback without X-Forwarded-For is a local tool", () => {
    expect(clientAddress("127.0.0.1", {})).toEqual({ kind: "local" });
    expect(clientAddress("::1", {})).toEqual({ kind: "local" });
    expect(clientAddress("::ffff:127.0.0.1", {})).toEqual({ kind: "local" });
  });

  it("behind nginx (loopback peer) the client is X-Forwarded-For", () => {
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": ALICE_IP })).toEqual({ kind: "remote", ip: ALICE_IP });
    expect(clientAddress("::1", { "x-forwarded-for": "fd7a:115c:a1e0::5" })).toEqual({ kind: "remote", ip: "fd7a:115c:a1e0::5" });
  });

  it("a forwarded value that is not a single IP counts as unknown (never local, never tailnet)", () => {
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": `${LAN_IP}, ${ALICE_IP}` })).toEqual({ kind: "remote", ip: null });
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": [ALICE_IP, ALICE_IP] })).toEqual({ kind: "remote", ip: null });
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "nonsense" })).toEqual({ kind: "remote", ip: null });
  });

  it("direct connections use the socket address and ignore the header", () => {
    expect(clientAddress(LAN_IP, { "x-forwarded-for": ALICE_IP })).toEqual({ kind: "remote", ip: LAN_IP });
    expect(clientAddress(`::ffff:${ALICE_IP}`, {})).toEqual({ kind: "remote", ip: ALICE_IP });
    expect(clientAddress(undefined, { "x-forwarded-for": ALICE_IP })).toEqual({ kind: "remote", ip: null });
  });

  it("Tailscale ranges", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
    expect(isTailscaleIp("100.63.255.255")).toBe(false);
    expect(isTailscaleIp("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailscaleIp("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailscaleIp(LAN_IP)).toBe(false);
  });
});

// ------------------------------------------------------------------ whois

const whoisAnswer = (login: string, name = "macbook.tail1234.ts.net.", tags?: string[]) => ({
  Node: { Name: name, ComputedName: name.split(".")[0], ...(tags ? { Tags: tags } : {}) },
  UserProfile: { LoginName: login, DisplayName: "Someone" },
});

/** A fake tailscaled LocalAPI on a unix socket. */
async function fakeLocalApi(answers: Record<string, unknown>) {
  const t = tempDir("workstation-ts-");
  const socketPath = join(t.dir, "tailscaled.sock");
  const requests: Array<{ path: string; host: string | undefined }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", host: req.headers.host });
    const addr = new URL(req.url ?? "/", "http://x").searchParams.get("addr") ?? "";
    const a = answers[addr];
    if (a === undefined) {
      res.writeHead(404).end("no match for IP:port");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(a));
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => (t.cleanup(), r()))));
  return { socketPath, requests, dir: t.dir };
}

describe("TailscaleWhoisClient", () => {
  it("asks the LocalAPI over the unix socket and caches per IP for 60 s", async () => {
    const api = await fakeLocalApi({ [`${ALICE_IP}:1`]: whoisAnswer("Alice@Example.com") });
    let now = 1_000_000;
    const c = new TailscaleWhoisClient({ socketPath: api.socketPath, cliBin: null, now: () => now });
    expect(await c.lookup(ALICE_IP)).toEqual({ login: "alice@example.com", node: "macbook" });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.path).toBe(`/localapi/v0/whois?addr=${encodeURIComponent(`${ALICE_IP}:1`)}`);
    expect(api.requests[0]!.host).toBe("local-tailscaled.sock");
    now += 59_000;
    await c.lookup(ALICE_IP);
    expect(api.requests).toHaveLength(1);
    now += 2_000;
    await c.lookup(ALICE_IP);
    expect(api.requests).toHaveLength(2);
  });

  it("tagged nodes and unknown peers have no identity (cached too); IPv6 addresses are bracketed", async () => {
    const api = await fakeLocalApi({
      [`${TAGGED_IP}:1`]: whoisAnswer("tagged-devices", "server.tail1234.ts.net.", ["tag:server"]),
      "[fd7a:115c:a1e0::9]:1": whoisAnswer("v6@example.com", "phone.tail1234.ts.net."),
    });
    const c = new TailscaleWhoisClient({ socketPath: api.socketPath, cliBin: null });
    expect(await c.lookup(TAGGED_IP)).toBeNull();
    expect(await c.lookup(TAGGED_IP)).toBeNull();
    expect(await c.lookup("100.100.9.9")).toBeNull();
    expect(await c.lookup("fd7a:115c:a1e0::9")).toEqual({ login: "v6@example.com", node: "phone" });
    expect(api.requests).toHaveLength(3);
  });

  it("parseWhois: tags win over a login; missing profile → null", () => {
    expect(parseWhois(whoisAnswer("a@b.c", "x.ts.net.", ["tag:ci"]))).toBeNull();
    expect(parseWhois({ Node: { Name: "x." } })).toBeNull();
    expect(parseWhois(null)).toBeNull();
    expect(parseWhois({ Node: { Name: "laptop.tail.ts.net." }, UserProfile: { LoginName: "a@b.c" } })).toEqual({ login: "a@b.c", node: "laptop" });
  });

  it("failures reject and are not cached; the CLI is the fallback when the socket cannot be used", async () => {
    const t = tempDir("workstation-ts-cli-");
    cleanups.push(t.cleanup);
    const missing = join(t.dir, "missing.sock");
    const noCli = new TailscaleWhoisClient({ socketPath: missing, cliBin: null });
    await expect(noCli.lookup(ALICE_IP)).rejects.toThrow();
    await expect(noCli.lookup(ALICE_IP)).rejects.toThrow();

    const cli = join(t.dir, "tailscale");
    const log = join(t.dir, "calls");
    writeFileSync(cli, `#!/bin/sh\necho "$@" >> '${log}'\necho '${JSON.stringify(whoisAnswer("cli@example.com"))}'\n`);
    chmodSync(cli, 0o755);
    const c = new TailscaleWhoisClient({ socketPath: missing, cliBin: cli });
    expect(await c.lookup(ALICE_IP)).toEqual({ login: "cli@example.com", node: "macbook" });
    await c.lookup(ALICE_IP);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`whois --json ${ALICE_IP}`]);
  });
});

// ------------------------------------------------------------------ hub rules

class FakeWhois implements TailscaleWhois {
  calls: string[] = [];
  constructor(private readonly who: Record<string, TailscaleWho | null>) {}
  async lookup(ip: string): Promise<TailscaleWho | null> {
    this.calls.push(ip);
    return this.who[ip] ?? null;
  }
}

const people = () =>
  new FakeWhois({
    [ALICE_IP]: { login: "alice@example.com", node: "alice-mac" },
    [BOB_IP]: { login: "bob@example.com", node: "bob-phone" },
    [BOSS_IP]: { login: "boss@example.com", node: "boss-mac" },
    [TAGGED_IP]: null,
  });

async function tsHub(auth: Record<string, unknown> = {}, whois: FakeWhois = people()): Promise<HubFixture> {
  const f = await hubFixture({ tailscaleWhois: whois }, () => ({ auth: { tailscale_identity: true, admin_logins: ["Boss@Example.com"], ...auth } }));
  cleanups.push(f.close);
  return f;
}

/** A request as it reaches the hub: directly from `peer`, or through nginx (loopback + X-Forwarded-For). */
function call(f: HubFixture, o: { user?: string; peer?: string; via?: string; method?: "GET" | "POST"; url?: string; body?: unknown }) {
  const headers: Record<string, string> = {};
  if (o.user) headers["x-workstation-user"] = o.user;
  if (o.via) headers["x-forwarded-for"] = o.via;
  return f.app.inject({
    method: o.method ?? "GET",
    url: o.url ?? "/api/me",
    headers,
    remoteAddress: o.via ? "127.0.0.1" : (o.peer ?? "127.0.0.1"),
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });
}

describe("hub: Tailscale identity", () => {
  it("binds a username to the first login; another login gets 403 user_bound", async () => {
    const f = await tsHub();
    const r1 = await call(f, { user: "alice", via: ALICE_IP });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().user).toMatchObject({ name: "alice", isAdmin: false });
    expect(f.hub.store.getUser("alice")!.tailscaleLogin).toBe("alice@example.com");

    const r2 = await call(f, { user: "alice", via: BOB_IP });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().code).toBe("user_bound");
    expect(r2.json().error).not.toContain("alice@example.com");

    // Direct tailnet connection (no nginx) works the same way.
    expect((await call(f, { user: "alice", peer: ALICE_IP })).statusCode).toBe(200);
    expect((await call(f, { user: "alice", peer: BOB_IP })).json().code).toBe("user_bound");

    // A login may use several usernames.
    expect((await call(f, { user: "alice-work", via: ALICE_IP })).statusCode).toBe(200);
    expect(f.hub.store.getUser("alice-work")!.tailscaleLogin).toBe("alice@example.com");
  });

  it("POST /api/users binds too and refuses a name bound to someone else", async () => {
    const f = await tsHub();
    const r = await call(f, { method: "POST", url: "/api/users", via: BOB_IP, body: { name: "bob" } });
    expect(r.statusCode).toBe(201);
    expect(f.hub.store.getUser("bob")!.tailscaleLogin).toBe("bob@example.com");
    const r2 = await call(f, { method: "POST", url: "/api/users", via: ALICE_IP, body: { name: "bob" } });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().code).toBe("user_bound");
  });

  it("admin is decided by admin_logins, not admin_usernames; the admin list shows bound logins", async () => {
    const f = await tsHub();
    const asAdminName = await call(f, { user: "admin", via: ALICE_IP });
    expect(asAdminName.json().user.isAdmin).toBe(false);
    expect((await call(f, { user: "admin", via: ALICE_IP, url: "/api/users" })).json().code).toBe("admin_required");

    const boss = await call(f, { user: "boss", via: BOSS_IP });
    expect(boss.json().user.isAdmin).toBe(true);
    const list = await call(f, { user: "boss", via: BOSS_IP, url: "/api/users" });
    expect(list.statusCode).toBe(200);
    const byName = Object.fromEntries((list.json() as Array<{ name: string; tailscaleLogin: string | null; isAdmin: boolean }>).map((u) => [u.name, u]));
    expect(byName.admin).toMatchObject({ tailscaleLogin: "alice@example.com", isAdmin: false });
    expect(byName.boss).toMatchObject({ tailscaleLogin: "boss@example.com", isAdmin: true });
  });

  it("tagged nodes have no identity → 403; whois answers are asked per request through the resolver", async () => {
    const whois = people();
    const f = await tsHub({}, whois);
    const r = await call(f, { user: "ci", via: TAGGED_IP });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("tailscale_identity_required");
    expect(f.hub.store.getUser("ci")).toBeNull();
    expect(whois.calls).toEqual([TAGGED_IP]);
  });

  it("a whois failure is 503 tailscale_unavailable", async () => {
    const f = await tsHub({}, new (class extends FakeWhois {
      override async lookup(): Promise<TailscaleWho | null> {
        throw new Error("socket gone");
      }
    })({}));
    const r = await call(f, { user: "alice", via: ALICE_IP });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("tailscale_unavailable");
  });

  it("lan_access legacy: non-tailnet clients keep header identity, admin only via admin_usernames", async () => {
    const f = await tsHub();
    const lan = await call(f, { user: "carol", peer: LAN_IP });
    expect(lan.statusCode).toBe(200);
    expect(lan.json().user.isAdmin).toBe(false);
    expect((await call(f, { user: "admin", peer: LAN_IP })).json().user.isAdmin).toBe(true);
    // Through nginx from a LAN address; and a forged header from a LAN peer is ignored (stays LAN, never Alice).
    expect((await call(f, { user: "carol", via: LAN_IP })).statusCode).toBe(200);
    const forged = await f.app.inject({ url: "/api/me", headers: { "x-workstation-user": "dave", "x-forwarded-for": ALICE_IP }, remoteAddress: LAN_IP });
    expect(forged.statusCode).toBe(200);
    expect(f.hub.store.getUser("dave")!.tailscaleLogin).toBeNull();
    expect(f.hub.store.getUser("carol")!.tailscaleLogin).toBeNull();
    // Local tools on the server (loopback, no X-Forwarded-For) stay legacy.
    expect((await call(f, { user: "admin" })).json().user.isAdmin).toBe(true);
  });

  it("lan_access deny: 403 lan_denied for non-tailnet clients; loopback tools, tailnet and open routes still work", async () => {
    const f = await tsHub({ lan_access: "deny" });
    for (const r of [await call(f, { user: "carol", peer: LAN_IP }), await call(f, { user: "carol", via: LAN_IP }), await call(f, { user: "carol", via: "garbage" })]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe("lan_denied");
    }
    expect((await call(f, { peer: LAN_IP, url: "/no/such/page" })).statusCode).toBe(403);
    expect(f.hub.store.getUser("carol")).toBeNull();
    expect((await call(f, { user: "carol" })).statusCode).toBe(200);
    expect((await call(f, { user: "alice", via: ALICE_IP })).statusCode).toBe(200);

    // Open routes need no username, but the LAN is still refused; tagged nodes and local tools may read them.
    const open = ["/healthz", "/api/health", "/api/app/mac/latest", "/api/app/mac/download", "/api/app/mac-intel/latest", "/api/app/mac-intel/download", "/api/app/releases", "/download", "/download/mac/latest", "/download/mac-intel/1.0.0", "/api/readme/features", "/api/visual-cdn/cdn.jsdelivr.net/npm/x.js"];
    for (const url of open) {
      const r = await call(f, { peer: LAN_IP, url });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code, url).toBe("lan_denied");
      expect((await call(f, { via: LAN_IP, url })).statusCode, url).toBe(403);
      const t = await call(f, { via: TAGGED_IP, url });
      expect(t.statusCode, url).not.toBe(403);
      expect((await call(f, { url })).statusCode, url).not.toBe(403);
    }
    expect((await call(f, { peer: LAN_IP, url: "/healthz" })).statusCode).toBe(403);
    expect((await call(f, { url: "/healthz" })).statusCode).toBe(200);
    expect((await call(f, { via: ALICE_IP, url: "/healthz" })).statusCode).toBe(200);
    // The usage limits need a user now.
    expect((await call(f, { url: "/api/usage/limits" })).statusCode).toBe(401);
    expect((await call(f, { user: "carol", url: "/api/usage/limits" })).statusCode).toBe(200);
    expect((await call(f, { peer: LAN_IP, url: "/api/usage/limits/history", user: "carol" })).statusCode).toBe(403);
  });

  it("lan_access deny: /download is the SPA page for tailnet and local callers, the LAN is refused", async () => {
    const t = tempDir("workstation-web-");
    cleanups.push(t.cleanup);
    writeFileSync(join(t.dir, "index.html"), "<!doctype html><title>spa</title>");
    const f = await hubFixture({ tailscaleWhois: people() }, () => ({ auth: { tailscale_identity: true, lan_access: "deny" }, paths: { web_dist: t.dir } }));
    cleanups.push(f.close);
    for (const o of [{ via: TAGGED_IP }, {}]) {
      const r = await call(f, { ...o, url: "/download" });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("<title>spa</title>");
      expect((await call(f, { ...o, url: "/download?x=1" })).statusCode).toBe(200);
    }
    expect((await call(f, { peer: LAN_IP, url: "/download" })).statusCode).toBe(403);
    expect((await call(f, { peer: LAN_IP, url: "/downloads" })).statusCode).toBe(403);
    expect(f.hub.store.listUsers(true)).toEqual([]);
  });

  it("with tailscale_identity off nothing changes: tailnet clients are legacy, no whois", async () => {
    const whois = people();
    const f = await hubFixture({ tailscaleWhois: whois });
    cleanups.push(f.close);
    const r = await call(f, { user: "admin", via: ALICE_IP });
    expect(r.json().user.isAdmin).toBe(true);
    expect((await call(f, { user: "admin", via: BOB_IP })).statusCode).toBe(200);
    expect(whois.calls).toEqual([]);
    expect(f.hub.store.getUser("admin")!.tailscaleLogin).toBeNull();
  });
});

// ------------------------------------------------------------------ whoami

describe("hub: GET /api/whoami", () => {
  const whoami = (f: HubFixture, o: { via?: string; peer?: string; user?: string } = {}) => call(f, { ...o, url: "/api/whoami" });
  const session = (f: HubFixture, id: string, user: string, at: string) =>
    f.hub.store.insertSession({ id, user, kind: "chat", title: id, cwd: ".chat", model: "default", permissionMode: "dontAsk", effort: null, createdAt: at });

  it("Tailscale caller without bound users: login and node, nothing suggested; no username header needed and nothing is created", async () => {
    const f = await tsHub();
    const r = await whoami(f, { via: ALICE_IP });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tailscale: { login: "alice@example.com", node: "alice-mac" }, users: [], suggested: null });
    expect(f.hub.store.listUsers(true)).toEqual([]);
  });

  it("one bound user is the suggestion; a direct tailnet connection works too", async () => {
    const f = await tsHub();
    await call(f, { user: "alice", via: ALICE_IP });
    expect((await whoami(f, { via: ALICE_IP })).json()).toEqual({ tailscale: { login: "alice@example.com", node: "alice-mac" }, users: ["alice"], suggested: "alice" });
    expect((await whoami(f, { peer: ALICE_IP })).json().users).toEqual(["alice"]);
  });

  it("two bound users: most recent session activity first, bind time when there is no session; other logins' names never show", async () => {
    const f = await tsHub();
    for (const [name, login, at] of [
      ["alice-old", "alice@example.com", "2026-01-01T00:00:00.000Z"],
      ["alice-new", "alice@example.com", "2026-01-02T00:00:00.000Z"],
      ["bob", "bob@example.com", "2026-01-03T00:00:00.000Z"],
    ] as const) {
      f.hub.users.ensure(name);
      f.hub.store.bindTailscaleLogin(name, login, at);
    }
    // No sessions yet: bind time decides.
    expect((await whoami(f, { via: ALICE_IP })).json()).toMatchObject({ users: ["alice-new", "alice-old"], suggested: "alice-new" });
    // Session activity beats bind time.
    session(f, "s1", "alice-old", "2026-03-01T00:00:00.000Z");
    session(f, "s2", "alice-new", "2026-02-01T00:00:00.000Z");
    const r = (await whoami(f, { via: ALICE_IP })).json();
    expect(r).toEqual({ tailscale: { login: "alice@example.com", node: "alice-mac" }, users: ["alice-old", "alice-new"], suggested: "alice-old" });
    expect(JSON.stringify(r)).not.toContain("bob");
    expect((await whoami(f, { via: BOB_IP })).json().users).toEqual(["bob"]);
    // A username header is ignored.
    expect((await whoami(f, { via: ALICE_IP, user: "bob" })).json().users).toEqual(["alice-old", "alice-new"]);
  });

  it("disabled users are left out", async () => {
    const f = await tsHub();
    await call(f, { user: "alice", via: ALICE_IP });
    await call(f, { user: "alice-work", via: ALICE_IP });
    f.hub.users.patch("alice-work", { enabled: false });
    expect((await whoami(f, { via: ALICE_IP })).json()).toMatchObject({ users: ["alice"], suggested: "alice" });
    f.hub.users.patch("alice", { enabled: false });
    expect((await whoami(f, { via: ALICE_IP })).json()).toMatchObject({ users: [], suggested: null });
  });

  it("legacy callers (local tool, LAN while allowed, tailnet with identity off) get tailscale null", async () => {
    const f = await tsHub();
    await call(f, { user: "alice", via: ALICE_IP });
    const none = { tailscale: null, users: [], suggested: null };
    expect((await whoami(f)).json()).toEqual(none);
    expect((await whoami(f, { peer: LAN_IP })).json()).toEqual(none);
    const off = await hubFixture({ tailscaleWhois: people() });
    cleanups.push(off.close);
    expect((await whoami(off, { via: ALICE_IP })).json()).toEqual(none);
  });

  it("refused callers get their 403: LAN with lan_access deny, tagged nodes", async () => {
    const f = await tsHub({ lan_access: "deny" });
    for (const r of [await whoami(f, { peer: LAN_IP }), await whoami(f, { via: LAN_IP })]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe("lan_denied");
    }
    const tagged = await whoami(f, { via: TAGGED_IP });
    expect(tagged.statusCode).toBe(403);
    expect(tagged.json().code).toBe("tailscale_identity_required");
  });

  it("GET /api/users stays admin-only", async () => {
    const f = await tsHub();
    await call(f, { user: "alice", via: ALICE_IP });
    const r = await call(f, { user: "alice", via: ALICE_IP, url: "/api/users" });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("admin_required");
    await call(f, { user: "alice", via: BOB_IP }); // user_bound, not a leak either
    expect((await call(f, { user: "boss", via: BOSS_IP, url: "/api/users" })).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------ WebSocket

describe("hub: WebSocket with Tailscale identity", () => {
  async function open(f: HubFixture, via: string | null, peer = "127.0.0.1") {
    const ws = await f.app.injectWS("/ws", { socket: { remoteAddress: via ? "127.0.0.1" : peer }, headers: { host: "localhost", ...(via ? { "x-forwarded-for": via } : {}) } } as never);
    const events: ServerEvent[] = [];
    let closed: number | null = null;
    ws.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
    ws.on("close", (code) => (closed = code));
    const hello = (user: string) => ws.send(JSON.stringify({ type: "hello", user, protocolVersion: 1 }));
    return { ws, events, hello, closed: () => closed };
  }

  it("hello binds like REST; another login's hello is refused with user_bound; admin by login", async () => {
    const f = await tsHub();
    const a = await open(f, ALICE_IP);
    a.hello("alice");
    const welcome = await until(() => a.events.find((e) => e.type === "welcome"), 2000, "welcome");
    expect(welcome.type === "welcome" && welcome.user).toMatchObject({ name: "alice", isAdmin: false });
    expect(f.hub.store.getUser("alice")!.tailscaleLogin).toBe("alice@example.com");

    const b = await open(f, BOB_IP);
    b.hello("alice");
    const err = await until(() => b.events.find((e) => e.type === "error"), 2000, "error");
    expect(err).toMatchObject({ type: "error", code: "user_bound" });
    await until(() => b.closed() === 4001, 2000, "close 4001");
    expect(f.hub.ws.connectedUsers()).toEqual(["alice"]);

    const boss = await open(f, BOSS_IP);
    boss.hello("admin");
    const w2 = await until(() => boss.events.find((e) => e.type === "welcome"), 2000, "welcome");
    expect(w2.type === "welcome" && w2.user.isAdmin).toBe(true);
    for (const c of [a, b, boss]) c.ws.terminate();
  });

  it("the upgrade itself is refused for LAN clients with lan_access deny and for tagged nodes", async () => {
    const f = await tsHub({ lan_access: "deny" });
    await expect(open(f, LAN_IP)).rejects.toThrow(/403/);
    await expect(open(f, null, LAN_IP)).rejects.toThrow(/403/);
    await expect(open(f, TAGGED_IP)).rejects.toThrow(/403/);
    const local = await open(f, null);
    local.hello("admin");
    const w = await until(() => local.events.find((e) => e.type === "welcome"), 2000, "welcome");
    expect(w.type === "welcome" && w.user.isAdmin).toBe(true);
    local.ws.terminate();
  });
});
