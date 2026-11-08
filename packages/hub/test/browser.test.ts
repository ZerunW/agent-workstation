/**
 * Server browser integration (@agent-workstation/browser): `[browser]` config, REST, WebSocket (state, live view, input), the
 * browser MCP server and its permission policy in sessions, user delete, and `.browser/` kept away
 * from file tools and listings. The BrowserManager is replaced by a fake with the same surface.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserError, type BrowserManager } from "@agent-workstation/browser";
import { BrowserSitesResponse, ServerEvent, type BrowserInput, type BrowserState } from "@agent-workstation/protocol";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { parseConfig } from "../src/config.js";
import { hiddenFromTree } from "../src/files/tree.js";
import { isIgnoredPath } from "../src/files/watcher.js";
import { Pricing } from "../src/pricing.js";
import {
  BROWSER_BAD_URL,
  BROWSER_CHAT_GUIDANCE,
  BROWSER_CHAT_READ_ONLY,
  BROWSER_DIR_DENIED,
  BROWSER_GUIDANCE,
  BROWSER_SITE_DENIED,
  BROWSER_SITE_NO_ASK,
  BROWSER_TOOL_UNAVAILABLE,
  BROWSER_USER_CONTROL,
  browserSiteTarget,
  type SessionBrowser,
} from "../src/sessions/browserTools.js";
import { silentLogger } from "../src/util/log.js";
import { BROWSER_FRAME_MAX_BUFFERED } from "../src/ws/server.js";
import type { FakeQuery } from "./fakeSdk.js";
import { WS_UPGRADE, hubFixture, msgBody, runtimeFixture, tempDir, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

// ------------------------------------------------------------------ fakes

/** BrowserManager stand-in: same methods and events, no Chromium. */
class FakeBrowsers extends EventEmitter {
  config = { enabled: true };
  port = 41001;
  started = 0;
  closed = 0;
  stops: string[] = [];
  inputs: [string, BrowserInput][] = [];
  failEnsure: BrowserError | null = null;
  private readonly running = new Set<string>();
  readonly controlled = new Map<string, "agent" | "user" | null>();
  readonly viewers = new Map<string, Map<string, { maxWidth?: number; cb: (f: { data: string; width: number; height: number; at: string }) => void }>>();

  async start(): Promise<void> {
    this.started++;
  }
  async close(): Promise<void> {
    this.closed++;
  }
  state(user: string): BrowserState {
    if (!/^[a-z0-9_-]{1,32}$/.test(user)) throw new BrowserError("bad_user", "bad user");
    return { running: this.running.has(user), url: null, title: null, controlledBy: this.controlled.get(user) ?? null, sessionId: null, viewers: this.viewers.get(user)?.size ?? 0, viewport: { width: 1280, height: 800 } };
  }
  async ensure(user: string): Promise<BrowserState> {
    if (this.failEnsure) throw this.failEnsure;
    this.running.add(user);
    this.emit("state", user, this.state(user));
    return this.state(user);
  }
  async stop(user: string): Promise<BrowserState> {
    this.stops.push(user);
    this.running.delete(user);
    this.emit("state", user, this.state(user));
    return this.state(user);
  }
  subscribeFrames(user: string, viewerId: string, opts: { maxWidth?: number }, cb: (f: { data: string; width: number; height: number; at: string }) => void): () => void {
    const m = this.viewers.get(user) ?? new Map();
    const entry = { ...opts, cb };
    m.set(viewerId, entry);
    this.viewers.set(user, m);
    return () => {
      if (m.get(viewerId) === entry) m.delete(viewerId);
    };
  }
  async input(user: string, input: BrowserInput): Promise<void> {
    if (!this.running.has(user)) throw new BrowserError("not_running", "The browser is not running.");
    this.inputs.push([user, input]);
  }
  mcpEndpoint(user: string, opts: { sessionId?: string } = {}): { url: string; headers: Record<string, string> } {
    return { url: `http://127.0.0.1:${this.port}/mcp/${user}`, headers: { Authorization: `Bearer tok-${user}`, ...(opts.sessionId ? { "X-Workstation-Session": opts.sessionId } : {}) } };
  }
  frame(user: string, n: number): void {
    for (const v of this.viewers.get(user)?.values() ?? []) v.cb({ data: `jpeg${n}`, width: 1280, height: 800, at: new Date().toISOString() });
  }
  /** The gateway's post-call website check, as the hub wired it. */
  siteCheck: ((user: string, hubSessionId: string | null, origin: string) => boolean) | null = null;
  setSiteCheck(fn: ((user: string, hubSessionId: string | null, origin: string) => boolean) | null): void {
    this.siteCheck = fn;
  }
}

/** The runtime's view of the browser, with a switchable port (a new hub start), control state, active page and tabs. */
function fakeSessionBrowser() {
  const b = { port: 41001, controlledBy: null as "agent" | "user" | null, calls: 0, url: null as string | null, tabs: [] as string[] };
  const dep: SessionBrowser = {
    endpoint: (user, sessionId) => {
      b.calls++;
      return { url: `http://127.0.0.1:${b.port}/mcp/${user}`, headers: { Authorization: `Bearer tok-${user}`, "X-Workstation-Session": sessionId } };
    },
    controlledBy: () => b.controlledBy,
    pageUrl: (_user, tab) => (tab === undefined ? b.url : (b.tabs[tab] ?? null)),
  };
  return { b, dep };
}

let h: HubFixture | null = null;
let fx: RuntimeFixture | null = null;
let cleanups: (() => void)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  fx?.cleanup();
  fx = null;
  for (const c of cleanups.splice(0)) c();
});

async function browserHub(): Promise<{ f: HubFixture; fake: FakeBrowsers }> {
  const fake = new FakeBrowsers();
  h = await hubFixture({ browsers: fake as unknown as BrowserManager });
  return { f: h, fake };
}

// ------------------------------------------------------------------ config

describe("[browser] config", () => {
  const base = (browser: Record<string, unknown> = {}) => parseConfig({ paths: { users_root: "/srv/u" }, browser }, null, {});

  it("defaults to the package defaults with usersRoot = paths.users_root and no wrapper", () => {
    const c = base().browser;
    expect(c).toMatchObject({ enabled: true, usersRoot: "/srv/u", flavor: "headless-shell", idleMinutes: 15, maxConcurrent: "auto", wrapper: [] });
    expect(c.mcp).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(c.executablePath).toBeUndefined();
  });

  it("maps snake_case keys (nested tables too) and rejects unsafe values", () => {
    const c = base({
      enabled: false,
      executable_path: "/opt/chrome/chrome",
      flavor: "chromium",
      idle_minutes: 5,
      max_concurrent: 2,
      min_free_memory_mb: 300,
      extra_args: ["--lang=de"],
      control_idle_seconds: 30,
      viewport: { width: 1024, height: 700 },
      screencast: { quality: 50, max_fps: 10, settle_ms: 300 },
      mcp: { port: 45555, capabilities: ["pdf"], session_idle_minutes: 60 },
    }).browser;
    expect(c).toMatchObject({ enabled: false, executablePath: "/opt/chrome/chrome", flavor: "chromium", idleMinutes: 5, maxConcurrent: 2, minFreeMemoryMB: 300, extraArgs: ["--lang=de"], controlIdleSeconds: 30, wrapper: [] });
    expect(c.viewport).toEqual({ width: 1024, height: 700 });
    expect(c.screencast).toEqual({ quality: 50, maxFps: 10, settleMs: 300 });
    expect(c.mcp).toMatchObject({ port: 45555, capabilities: ["pdf"], sessionIdleMinutes: 60 });
    expect(() => base({ mcp: { host: "0.0.0.0" } })).toThrow(/loopback/);
    expect(() => base({ extra_args: ["--remote-debugging-port=9222"] })).toThrow(/remote-debugging/);
  });
});

// ------------------------------------------------------------------ website of a tool call

describe("browserSiteTarget", () => {
  const page = (active: string | null, tabs: string[] = []) => (tab?: number) => (tab === undefined ? active : (tabs[tab] ?? null));
  const t = (tool: string, input: Record<string, unknown>, active: string | null = null, tabs: string[] = []) => browserSiteTarget(`mcp__browser__${tool}`, input, page(active, tabs));
  const origin = (o: string) => ({ kind: "origin", origin: o });

  it("browser_navigate → the target URL's origin (completed like Playwright MCP does)", () => {
    expect(t("browser_navigate", { url: "https://Mail.Example.com/inbox?q=1#x" }, "https://other.example/")).toEqual(origin("https://mail.example.com"));
    expect(t("browser_navigate", { url: "http://example.com:80/" })).toEqual(origin("http://example.com"));
    expect(t("browser_navigate", { url: "https://user:pw@example.com:8443/a" })).toEqual(origin("https://example.com:8443"));
    expect(t("browser_navigate", { url: "example.com/path" })).toEqual(origin("https://example.com"));
    expect(t("browser_navigate", { url: "localhost:3000/x" })).toEqual(origin("http://localhost:3000"));
    expect(t("browser_navigate", { url: "about:blank" }, "https://x.example/")).toEqual({ kind: "none" });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "", 42]) {
      expect(t("browser_navigate", { url }), String(url)).toEqual({ kind: "refused", message: BROWSER_BAD_URL });
    }
  });

  it("other tools → the active tab's page; a tool naming a tab → that tab", () => {
    for (const tool of ["browser_snapshot", "browser_take_screenshot", "browser_click", "browser_evaluate", "browser_navigate_back", "browser_wait_for", "browser_console_messages"]) {
      expect(t(tool, {}, "https://app.example/page"), tool).toEqual(origin("https://app.example"));
    }
    expect(t("browser_snapshot", {}, null)).toEqual({ kind: "none" });
    expect(t("browser_snapshot", {}, "about:blank")).toEqual({ kind: "none" });
    expect(t("browser_snapshot", {}, "data:text/html,x")).toEqual({ kind: "refused", message: BROWSER_BAD_URL });
    // Other prefixes are stripped too.
    expect(browserSiteTarget("browser/browser_snapshot", {}, page("https://g.example/"))).toEqual(origin("https://g.example"));

    const tabs = ["https://a.example/", "https://b.example/x"];
    expect(t("browser_tabs", { action: "select", index: 1 }, "https://a.example/", tabs)).toEqual(origin("https://b.example"));
    expect(t("browser_tabs", { action: "close", index: 0 }, "https://b.example/", tabs)).toEqual(origin("https://a.example"));
    // Unknown tab: the active tab.
    expect(t("browser_tabs", { action: "select", index: 7 }, "https://a.example/", tabs)).toEqual(origin("https://a.example"));
    expect(t("browser_tabs", { action: "close" }, "https://b.example/", tabs)).toEqual(origin("https://b.example"));
    expect(t("browser_tabs", { action: "list" }, "https://a.example/", tabs)).toEqual(origin("https://a.example"));
    expect(t("browser_tabs", { action: "new" }, "https://a.example/")).toEqual({ kind: "none" });
    expect(t("browser_tabs", { action: "new", url: "https://c.example/z" }, "https://a.example/")).toEqual(origin("https://c.example"));
    expect(t("browser_tabs", { action: "new", url: "file:///" })).toEqual({ kind: "refused", message: BROWSER_BAD_URL });
  });
});

// ------------------------------------------------------------------ hub wiring, REST, WebSocket

describe("hub: lifecycle and REST", () => {
  it("start() at hub start, close() at hub stop", async () => {
    const fake = new FakeBrowsers();
    const f = await hubFixture({ browsers: fake as unknown as BrowserManager });
    expect(fake.started).toBe(1);
    expect(fake.closed).toBe(0);
    await f.close();
    expect(fake.closed).toBe(1);
  });

  it("gives the browser's MCP gateway the website check (stored grants and session answers, never asking)", async () => {
    const { f, fake } = await browserHub();
    const check = fake.siteCheck!;
    expect(check).toBeTypeOf("function");
    expect(check("alice", null, "https://a.example")).toBe(false);
    f.hub.store.insertSiteGrant("alice", "https://a.example");
    expect(check("alice", null, "https://a.example")).toBe(true);
    expect(check("alice", "11111111-2222-4333-8444-555555555555", "https://a.example")).toBe(true);
    expect(check("bob", null, "https://a.example")).toBe(false);
    expect(check("alice", null, "https://b.example")).toBe(false);
  });

  it("GET /api/browser, POST start/stop; BrowserError → status + browser_<code>", async () => {
    const { f, fake } = await browserHub();
    const get = await f.app.inject({ url: "/api/browser", headers: f.as("alice") });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ running: false, viewport: { width: 1280, height: 800 } });
    const start = await f.app.inject({ method: "POST", url: "/api/browser/start", headers: f.as("alice") });
    expect(start.json()).toMatchObject({ running: true });
    const stop = await f.app.inject({ method: "POST", url: "/api/browser/stop", headers: f.as("alice") });
    expect(stop.json()).toMatchObject({ running: false });
    expect(fake.stops).toEqual(["alice"]);

    fake.failEnsure = new BrowserError("too_many", "Too many browsers.");
    const busy = await f.app.inject({ method: "POST", url: "/api/browser/start", headers: f.as("alice") });
    expect([busy.statusCode, busy.json().code]).toEqual([503, "browser_too_many"]);
    fake.failEnsure = new BrowserError("profile_in_use", "Profile locked.");
    const locked = await f.app.inject({ method: "POST", url: "/api/browser/start", headers: f.as("alice") });
    expect([locked.statusCode, locked.json().code]).toEqual([409, "browser_profile_in_use"]);
    expect((await f.app.inject({ url: "/api/browser" })).statusCode).toBe(401);
  });

  it("GET /api/me/browser-sites (most recently used first), DELETE ?origin= (204, then 404)", async () => {
    const { f } = await browserHub();
    const store = f.hub.store;
    store.ensureUser("alice");
    store.insertSiteGrant("alice", "https://old.example", "2026-01-01T00:00:00.000Z");
    store.insertSiteGrant("alice", "https://new.example", "2026-02-01T00:00:00.000Z");
    store.insertSiteGrant("alice", "https://used.example", "2025-12-01T00:00:00.000Z");
    store.touchSiteGrant("alice", "https://used.example", "2026-03-01T00:00:00.000Z");
    store.insertSiteGrant("bob", "https://bob.example");

    const list = await f.app.inject({ url: "/api/me/browser-sites", headers: f.as("alice") });
    expect(list.statusCode).toBe(200);
    const body = BrowserSitesResponse.parse(list.json());
    expect(body.sites.map((s) => s.origin)).toEqual(["https://used.example", "https://new.example", "https://old.example"]);
    expect(body.sites[0]).toEqual({ origin: "https://used.example", grantedAt: "2025-12-01T00:00:00.000Z", lastUsedAt: "2026-03-01T00:00:00.000Z" });

    const del = (user: string, origin?: string) =>
      f.app.inject({ method: "DELETE", url: `/api/me/browser-sites${origin === undefined ? "" : `?origin=${encodeURIComponent(origin)}`}`, headers: f.as(user) });
    expect((await del("alice", "https://new.example")).statusCode).toBe(204);
    expect((await del("alice", "https://new.example")).statusCode).toBe(404);
    // Other users' grants are not reachable.
    expect((await del("alice", "https://bob.example")).statusCode).toBe(404);
    expect((await del("alice")).statusCode).toBe(400);
    expect(BrowserSitesResponse.parse((await f.app.inject({ url: "/api/me/browser-sites", headers: f.as("alice") })).json()).sites.map((s) => s.origin)).toEqual([
      "https://used.example",
      "https://old.example",
    ]);
    expect(store.listSiteGrants("bob")).toHaveLength(1);
    expect((await f.app.inject({ url: "/api/me/browser-sites" })).statusCode).toBe(401);
  });
});

describe("hub: WebSocket", () => {
  async function connect(f: HubFixture, user: string) {
    const ws = await f.app.injectWS("/ws", WS_UPGRADE);
    const events: ServerEvent[] = [];
    ws.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
    ws.send(JSON.stringify({ type: "hello", user, protocolVersion: 1 }));
    await until(() => events.some((e) => e.type === "welcome"), 2000, "welcome");
    return { ws, events, of: <T extends ServerEvent["type"]>(t: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === t) };
  }

  it("state → browser_state to the user's connections only; hello sends the current state", async () => {
    const { f, fake } = await browserHub();
    const a = await connect(f, "alice");
    const b = await connect(f, "bob");
    await until(() => a.of("browser_state").length === 1, 2000, "hello state");
    expect(a.of("browser_state")[0]!.state.running).toBe(false);
    await f.app.inject({ method: "POST", url: "/api/browser/start", headers: f.as("alice") });
    await until(() => a.of("browser_state").some((e) => e.state.running), 2000, "running state");
    expect(b.of("browser_state").every((e) => !e.state.running)).toBe(true);
    void fake;
  });

  it("browser_view on/off subscribes frames; frames are dropped while the socket is backed up; close unsubscribes", async () => {
    const { f, fake } = await browserHub();
    const a = await connect(f, "alice");
    a.ws.send(JSON.stringify({ type: "browser_view", on: true, maxWidth: 800 }));
    await until(() => fake.viewers.get("alice")?.size === 1, 2000, "viewer");
    expect([...fake.viewers.get("alice")!.values()][0]!.maxWidth).toBe(800);

    fake.frame("alice", 1);
    await until(() => a.of("browser_frame").length === 1, 2000, "frame");
    expect(a.of("browser_frame")[0]).toMatchObject({ type: "browser_frame", data: "jpeg1", width: 1280, height: 800 });

    // A slow client: the server-side socket reports a full buffer → frames are dropped, not queued.
    const conns = (f.hub.ws as unknown as { conns: Set<{ user: string | null; ws: object }> }).conns;
    const server = [...conns].find((c) => c.user === "alice")!.ws;
    let buffered = BROWSER_FRAME_MAX_BUFFERED + 1;
    Object.defineProperty(server, "bufferedAmount", { get: () => buffered, configurable: true });
    fake.frame("alice", 2);
    buffered = 0;
    fake.frame("alice", 3);
    await until(() => a.of("browser_frame").length === 2, 2000, "frame 3");
    expect(a.of("browser_frame").map((e) => e.data)).toEqual(["jpeg1", "jpeg3"]);

    a.ws.send(JSON.stringify({ type: "browser_view", on: false }));
    await until(() => fake.viewers.get("alice")?.size === 0, 2000, "unsubscribed");

    a.ws.send(JSON.stringify({ type: "browser_view", on: true }));
    await until(() => fake.viewers.get("alice")?.size === 1, 2000, "viewer again");
    a.ws.terminate();
    await until(() => fake.viewers.get("alice")?.size === 0, 2000, "unsubscribed on close");
  });

  it("browser_input → input(); BrowserError → error browser_<code>", async () => {
    const { f, fake } = await browserHub();
    const a = await connect(f, "alice");
    const click: BrowserInput = { kind: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1 };
    a.ws.send(JSON.stringify({ type: "browser_input", input: click }));
    const err = await until(() => a.of("error").find((e) => e.code.startsWith("browser_")), 2000, "error");
    expect(err).toMatchObject({ code: "browser_not_running", message: "The browser is not running." });
    await fake.ensure("alice");
    a.ws.send(JSON.stringify({ type: "browser_input", input: click }));
    await until(() => fake.inputs.length === 1, 2000, "input");
    expect(fake.inputs[0]).toEqual(["alice", click]);
  });
});

describe("hub: user delete and .browser/", () => {
  it("stops the user's browser before deleting the user", async () => {
    const { f, fake } = await browserHub();
    await f.app.inject({ url: "/api/me", headers: f.as("bob") });
    await fake.ensure("bob");
    const r = await f.app.inject({ method: "DELETE", url: "/api/users/bob?force=true", headers: f.as("admin") });
    expect(r.statusCode).toBe(204);
    expect(fake.stops).toContain("bob");
  });

  it("deleting a user deletes their website grants", async () => {
    const { f } = await browserHub();
    await f.app.inject({ url: "/api/me", headers: f.as("bob") });
    f.hub.store.insertSiteGrant("bob", "https://bob.example");
    f.hub.store.insertSiteGrant("alice", "https://alice.example");
    expect((await f.app.inject({ method: "DELETE", url: "/api/users/bob?force=true", headers: f.as("admin") })).statusCode).toBe(204);
    expect(f.hub.store.listSiteGrants("bob")).toEqual([]);
    expect(f.hub.store.listSiteGrants("alice")).toHaveLength(1);
  });

  it("hides .browser/ from listings and the watcher and refuses it in the files API", async () => {
    const { f } = await browserHub();
    await f.app.inject({ url: "/api/me", headers: f.as("alice") });
    mkdirSync(join(f.root, "alice", ".browser", "profile"), { recursive: true });
    writeFileSync(join(f.root, "alice", ".browser", "profile", "Cookies"), "secret");
    writeFileSync(join(f.root, "alice", "notes.txt"), "hi");
    const tree = (await f.app.inject({ url: "/api/files/tree?path=&depth=4", headers: f.as("alice") })).json() as { path: string }[];
    expect(tree.map((e) => e.path)).toContain("notes.txt");
    expect(tree.some((e) => e.path.startsWith(".browser"))).toBe(false);
    for (const req of [
      { method: "GET" as const, url: "/api/files/tree?path=.browser&depth=2" },
      { method: "GET" as const, url: "/api/files/content?path=.browser/profile/Cookies" },
      { method: "GET" as const, url: "/api/files/download?path=.browser/profile/Cookies" },
      { method: "GET" as const, url: "/api/files/download?path=notes.txt&path=.browser" },
      { method: "DELETE" as const, url: "/api/files?path=.browser" },
    ]) {
      expect((await f.app.inject({ ...req, headers: f.as("alice") })).statusCode, req.url).toBe(403);
    }
    expect((await f.app.inject({ method: "POST", url: "/api/files/mkdir", headers: f.as("alice"), payload: { path: ".browser/x" } })).statusCode).toBe(403);
    expect(readFileSync(join(f.root, "alice", ".browser", "profile", "Cookies"), "utf8")).toBe("secret");
    expect(isIgnoredPath(".browser/profile/Cookies")).toBe(true);
    expect(hiddenFromTree(".browser")).toBe(true);
    expect(hiddenFromTree("projects/.browser")).toBe(false);
  });
});

// ------------------------------------------------------------------ Claude sessions

describe("Claude sessions", () => {
  const turn = async (id: string, n: number) => {
    await fx!.sessions.send(id, msgBody(`turn ${n}`));
    await until(() => fx!.store.getSession(id)!.turnCount >= n && fx!.sessions.statusOf(id).status === "idle", 3000, `turn ${n}`);
  };
  const preHook = (q: FakeQuery, matcher: string) => {
    const m = (q.options.hooks?.PreToolUse ?? []).find((x) => x.matcher === matcher);
    if (!m) throw new Error(`no PreToolUse ${matcher}`);
    return (toolName: string, toolInput: Record<string, unknown>) =>
      m.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: "t1", session_id: q.sessionId, transcript_path: "/dev/null", cwd: q.options.cwd } as unknown as HookInput, "t1", { signal: new AbortController().signal });
  };

  it("code: mcpServers.browser over HTTP with the session id; rebuilt on respawn", async () => {
    const { b, dep } = fakeSessionBrowser();
    fx = runtimeFixture({ browser: dep });
    const id = fx.newSession("code");
    await turn(id, 1);
    const q = fx.sdk.last;
    expect(q.options.mcpServers?.browser).toEqual({ type: "http", url: "http://127.0.0.1:41001/mcp/alice", headers: { Authorization: "Bearer tok-alice", "X-Workstation-Session": id } });
    // Not pre-approved by name (browser_tabs can close a tab): decided per call.
    expect((q.options.allowedTools ?? []).some((t) => t.startsWith("mcp__browser__"))).toBe(false);
    const prompt = q.options.systemPrompt as { append: string };
    expect(prompt.append).toContain(BROWSER_GUIDANCE);

    // A new hub start binds another random port: the next process gets the new endpoint.
    b.port = 42002;
    await fx.sessions.close(id);
    await turn(id, 2);
    expect(fx.sdk.queries).toHaveLength(2);
    expect((fx.sdk.last.options.mcpServers?.browser as { url: string }).url).toBe("http://127.0.0.1:42002/mcp/alice");
  });

  it("code: read tools allowed, act tools get a card, unknown tools and act under user control are refused", async () => {
    const { b, dep } = fakeSessionBrowser();
    fx = runtimeFixture({ browser: dep });
    const id = fx.newSession("code");
    await turn(id, 1);
    const q = fx.sdk.last;

    expect(await q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
    expect(await q.askPermission("mcp__browser__browser_tabs", { action: "list" })).toMatchObject({ behavior: "allow" });
    expect(await q.askPermission("mcp__browser__browser_run_code_unsafe", { code: "x" })).toEqual({ behavior: "deny", message: BROWSER_TOOL_UNAVAILABLE });
    expect(fx.bus.ofType("permission_request")).toHaveLength(0);

    const pending = q.askPermission("mcp__browser__browser_click", { element: "Buy", ref: "e1" });
    const req = await until(() => fx!.bus.ofType("permission_request")[0], 2000, "card");
    expect(req.request).toMatchObject({ sessionId: id, toolName: "mcp__browser__browser_click" });
    fx.sessions.respondPermission("alice", id, { requestId: req.request.requestId, behavior: "allow" });
    expect(await pending).toMatchObject({ behavior: "allow" });

    const closeTab = q.askPermission("mcp__browser__browser_tabs", { action: "close", index: 1 });
    const req2 = await until(() => fx!.bus.ofType("permission_request")[1], 2000, "card for closing a tab");
    fx.sessions.respondPermission("alice", id, { requestId: req2.request.requestId, behavior: "deny" });
    expect(await closeTab).toMatchObject({ behavior: "deny" });

    b.controlledBy = "user";
    expect(await q.askPermission("mcp__browser__browser_type", { text: "x" })).toEqual({ behavior: "deny", message: BROWSER_USER_CONTROL });
    expect(await q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
    expect(fx.bus.ofType("permission_request")).toHaveLength(2);
  });

  it("code: the PreToolUse gate works in every mode (bypassPermissions skips canUseTool)", async () => {
    const { b, dep } = fakeSessionBrowser();
    fx = runtimeFixture({ browser: dep });
    fx.store.ensureUser("alice");
    const id = fx.sessions.create({ user: "alice", kind: "code", cwd: "", model: "default", permissionMode: "bypassPermissions", effort: null }).id;
    await turn(id, 1);
    const q = fx.sdk.last;
    const gate = preHook(q, "mcp__browser__.*");
    // The hook may wait for a website card: it must not time out before the card does.
    expect(q.options.hooks?.PreToolUse?.find((m) => m.matcher === "mcp__browser__.*")?.timeout).toBeGreaterThan(fx.limits.permissionTimeoutMs / 1000);
    // The website card is asked even in bypassPermissions.
    const nav = gate("mcp__browser__browser_navigate", { url: "https://example.com" });
    const site = await until(() => fx!.bus.ofType("permission_request")[0], 2000, "site card");
    expect(site.request.browserSite).toEqual({ origin: "https://example.com" });
    fx.sessions.respondPermission("alice", id, { requestId: site.request.requestId, behavior: "allow" });
    expect(await nav).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    b.url = "https://example.com/";
    // Act tools then follow the mode (bypass: the CLI lets them through).
    expect(await gate("mcp__browser__browser_click", { ref: "e1" })).toEqual({});
    expect(fx.bus.ofType("permission_request")).toHaveLength(1);
    expect(await gate("mcp__browser__browser_run_code_unsafe", {})).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: BROWSER_TOOL_UNAVAILABLE } });
    b.controlledBy = "user";
    expect(await gate("mcp__browser__browser_click", { ref: "e1" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: BROWSER_USER_CONTROL } });
    // Other tools pass through untouched.
    expect(await gate("Bash", { command: "ls" })).toEqual({});
  });

  it("file tools are refused on <user root>/.browser", async () => {
    const { dep } = fakeSessionBrowser();
    fx = runtimeFixture({ browser: dep });
    const id = fx.newSession("code");
    await turn(id, 1);
    const q = fx.sdk.last;
    const root = join(fx.root, "alice");
    const gate = preHook(q, "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS");
    const denied = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSER_DIR_DENIED } };
    expect(await gate("Read", { file_path: join(root, ".browser", "profile", "Cookies") })).toEqual(denied);
    expect(await gate("Read", { file_path: join(realpathSync(root), ".browser", "profile", "Cookies") })).toEqual(denied);
    expect(await gate("Write", { file_path: ".browser/x.txt", content: "x" })).toEqual(denied);
    expect(await gate("Grep", { pattern: "session", path: join(root, ".browser") })).toEqual(denied);
    expect(await gate("Glob", { pattern: join(root, ".browser", "**") })).toEqual(denied);
    expect(await gate("Read", { file_path: join(root, "notes.txt") })).toEqual({});
    expect(await gate("Read", { file_path: join(root, "projects", ".browser", "a") })).toEqual({});
    expect(await q.askPermission("Edit", { file_path: join(root, ".browser", "profile", "Preferences"), old_string: "a", new_string: "b" })).toEqual({ behavior: "deny", message: BROWSER_DIR_DENIED });
  });

  it("chat: read tools only (no card on about:blank); incognito chats get no browser", async () => {
    const { b, dep } = fakeSessionBrowser();
    fx = runtimeFixture({ browser: dep });
    const id = fx.newSession("chat");
    await turn(id, 1);
    const q = fx.sdk.last;
    expect(q.options.mcpServers?.browser).toMatchObject({ type: "http", url: "http://127.0.0.1:41001/mcp/alice" });
    expect(String(q.options.systemPrompt)).toContain(BROWSER_CHAT_GUIDANCE);
    expect(await q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
    expect(await q.askPermission("mcp__browser__browser_click", { ref: "e1" })).toEqual({ behavior: "deny", message: BROWSER_CHAT_READ_ONLY });
    expect(await q.askPermission("mcp__browser__browser_tabs", { action: "close" })).toEqual({ behavior: "deny", message: BROWSER_CHAT_READ_ONLY });
    expect(fx.bus.ofType("permission_request")).toHaveLength(0);

    const calls = b.calls;
    const incognito = fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id;
    await turn(incognito, 1);
    expect(fx.sdk.last.options.mcpServers?.browser).toBeUndefined();
    expect(String(fx.sdk.last.options.systemPrompt)).not.toContain(BROWSER_CHAT_GUIDANCE);
    expect(b.calls).toBe(calls);
  });

  describe("website permission", () => {
    const cards = () => fx!.bus.ofType("permission_request");
    const card = (n: number) => until(() => cards()[n], 2000, `card ${n}`);
    const answer = (id: string, requestId: string, behavior: "allow" | "deny", extra: { remember?: "session" | "user"; updatedInput?: unknown } = {}) =>
      expect(fx!.sessions.respondPermission("alice", id, { requestId, behavior, ...extra })).toEqual({ ok: true });
    const codeSession = async (permissionMode: "default" | "bypassPermissions" | "dontAsk" | "acceptEdits" = "default") => {
      fx!.store.ensureUser("alice");
      const id = fx!.sessions.create({ user: "alice", kind: "code", cwd: "", model: "default", permissionMode, effort: null }).id;
      await turn(id, 1);
      return { id, q: fx!.sdk.last };
    };

    it("first visit asks; allow covers this session only (until it closes); deny denies", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      const nav = a.q.askPermission("mcp__browser__browser_navigate", { url: "https://mail.example.com/inbox?x=1" });
      const c0 = await card(0);
      expect(c0.request).toMatchObject({ sessionId: a.id, toolName: "mcp__browser__browser_navigate", input: { url: "https://mail.example.com/inbox?x=1" }, browserSite: { origin: "https://mail.example.com" } });
      // The input that decided the origin cannot be replaced from the card.
      answer(a.id, c0.request.requestId, "allow", { updatedInput: { url: "https://other.example" } });
      expect(await nav).toEqual({ behavior: "allow", updatedInput: { url: "https://mail.example.com/inbox?x=1" } });
      expect(fx.store.listSiteGrants("alice")).toEqual([]);

      // Same session, same origin (another path, the page itself): no new card.
      b.url = "https://mail.example.com/inbox";
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
      expect(await a.q.askPermission("mcp__browser__browser_navigate", { url: "mail.example.com/settings" })).toMatchObject({ behavior: "allow" });
      expect(cards()).toHaveLength(1);

      // Another session asks again; deny → denied with a short reason.
      const other = await codeSession();
      const snap = other.q.askPermission("mcp__browser__browser_snapshot", {});
      const c1 = await card(1);
      expect(c1.request).toMatchObject({ sessionId: other.id, browserSite: { origin: "https://mail.example.com" } });
      answer(other.id, c1.request.requestId, "deny");
      expect(await snap).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });

      // Closing the first session drops its answer.
      expect(fx.sessions.browserSites.sessionOrigins(a.id)).toEqual(["https://mail.example.com"]);
      await fx.sessions.close(a.id);
      expect(fx.sessions.browserSites.sessionOrigins(a.id)).toEqual([]);
      await turn(a.id, 2);
      const again = fx.sdk.last.askPermission("mcp__browser__browser_snapshot", {});
      const c2 = await card(2);
      expect(c2.request.browserSite).toEqual({ origin: "https://mail.example.com" });
      answer(a.id, c2.request.requestId, "allow");
      expect(await again).toMatchObject({ behavior: "allow" });
    });

    it("always allow stores a grant: no card next time, in a new session too; last use is recorded; revoking asks again", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      const nav = a.q.askPermission("mcp__browser__browser_navigate", { url: "https://docs.example.org:8443/a" });
      const c0 = await card(0);
      expect(c0.request.browserSite).toEqual({ origin: "https://docs.example.org:8443" });
      answer(a.id, c0.request.requestId, "allow", { remember: "user" });
      expect(await nav).toMatchObject({ behavior: "allow" });
      const [grant] = fx.store.listSiteGrants("alice");
      expect(grant).toMatchObject({ origin: "https://docs.example.org:8443", grantedAt: expect.any(String) });
      // Never a tool rule: those must not satisfy anything for the browser.
      expect(fx.store.rulesFor("alice", "mcp__browser__browser_navigate", a.id)).toEqual([]);

      fx.store.touchSiteGrant("alice", "https://docs.example.org:8443", "2020-01-01T00:00:00.000Z");
      const other = await codeSession();
      b.url = "https://docs.example.org:8443/b";
      expect(await other.q.askPermission("mcp__browser__browser_take_screenshot", {})).toMatchObject({ behavior: "allow" });
      expect(cards()).toHaveLength(1);
      expect(fx.store.listSiteGrants("alice")[0]!.lastUsedAt! > "2020-01-01T00:00:00.000Z").toBe(true);
      expect(fx.store.listSiteGrants("bob")).toEqual([]);

      // Revoked (grant and open sessions' answers): the next visit asks again.
      expect(fx.sessions.browserSites.revoke("alice", "https://docs.example.org:8443")).toBe(true);
      const snap = a.q.askPermission("mcp__browser__browser_snapshot", {});
      const c1 = await card(1);
      answer(a.id, c1.request.requestId, "deny");
      expect(await snap).toMatchObject({ behavior: "deny" });
    });

    it("remembered tool rules never satisfy the site check", async () => {
      const { dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      fx.store.insertRule({ user: "alice", sessionId: null, toolName: "mcp__browser__browser_navigate", ruleContent: null });
      fx.store.insertRule({ user: "alice", sessionId: null, toolName: "mcp__browser__browser_navigate", ruleContent: "domain:example.com" });
      const nav = a.q.askPermission("mcp__browser__browser_navigate", { url: "https://example.com" });
      const c0 = await card(0);
      expect(c0.request.browserSite).toEqual({ origin: "https://example.com" });
      expect(c0.request.suggestions).toBeUndefined();
      answer(a.id, c0.request.requestId, "allow", { remember: "session" });
      expect(await nav).toMatchObject({ behavior: "allow" });
      expect(fx.store.rulesFor("alice", "mcp__browser__browser_navigate", a.id)).toHaveLength(2);
    });

    it("refused URLs stay refused; about:blank needs no grant", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      expect(await a.q.askPermission("mcp__browser__browser_navigate", { url: "file:///etc/passwd" })).toEqual({ behavior: "deny", message: BROWSER_BAD_URL });
      expect(await a.q.askPermission("mcp__browser__browser_navigate", { url: "javascript:alert(1)" })).toEqual({ behavior: "deny", message: BROWSER_BAD_URL });
      expect(await a.q.askPermission("mcp__browser__browser_navigate", { url: "about:blank" })).toMatchObject({ behavior: "allow" });
      b.url = "about:blank";
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
      b.url = "data:text/html,<p>x</p>";
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toEqual({ behavior: "deny", message: BROWSER_BAD_URL });
      expect(cards()).toHaveLength(0);
    });

    it("dontAsk denies without a card", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession("dontAsk");
      const gate = preHook(a.q, "mcp__browser__.*");
      expect(await gate("mcp__browser__browser_navigate", { url: "https://example.com" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: BROWSER_SITE_NO_ASK } });
      b.url = "https://example.com/";
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toEqual({ behavior: "deny", message: BROWSER_SITE_NO_ASK });
      // A stored grant still counts.
      fx.store.insertSiteGrant("alice", "https://example.com");
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
      expect(cards()).toHaveLength(0);
    });

    it("act tools still follow the permission mode after the site check, and stay refused under user control", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      b.url = "https://shop.example/cart";
      const click = a.q.askPermission("mcp__browser__browser_click", { element: "Buy", ref: "e1" });
      const site = await card(0);
      expect(site.request.browserSite).toEqual({ origin: "https://shop.example" });
      answer(a.id, site.request.requestId, "allow");
      const act = await card(1);
      expect(act.request).toMatchObject({ toolName: "mcp__browser__browser_click" });
      expect(act.request.browserSite).toBeUndefined();
      answer(a.id, act.request.requestId, "allow");
      expect(await click).toMatchObject({ behavior: "allow" });
      // Granted now: the next act call only gets the mode's card.
      const type = a.q.askPermission("mcp__browser__browser_type", { ref: "e2", text: "x" });
      const act2 = await card(2);
      expect(act2.request.browserSite).toBeUndefined();
      answer(a.id, act2.request.requestId, "deny");
      expect(await type).toMatchObject({ behavior: "deny" });
      b.controlledBy = "user";
      expect(await a.q.askPermission("mcp__browser__browser_click", { ref: "e1" })).toEqual({ behavior: "deny", message: BROWSER_USER_CONTROL });
      expect(cards()).toHaveLength(3);
    });

    it("parallel calls on one origin share one card", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      b.url = "https://news.example/";
      const one = a.q.askPermission("mcp__browser__browser_snapshot", {});
      const two = a.q.askPermission("mcp__browser__browser_take_screenshot", {});
      const c0 = await card(0);
      answer(a.id, c0.request.requestId, "allow");
      expect(await one).toMatchObject({ behavior: "allow" });
      expect(await two).toMatchObject({ behavior: "allow" });
      expect(cards()).toHaveLength(1);
    });

    it("a denial holds for the session (no second card); a new session asks again; a stored grant clears it", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const origin = "https://tracker.example";
      const a = await codeSession();
      b.url = "https://tracker.example/";
      const snap = a.q.askPermission("mcp__browser__browser_snapshot", {});
      answer(a.id, (await card(0)).request.requestId, "deny", {});
      expect(await snap).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });
      // The agent retries: denied at once with the same message, no new card (navigate and page tools alike).
      expect(await a.q.askPermission("mcp__browser__browser_navigate", { url: "https://tracker.example/other" })).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });
      expect(await a.q.askPermission("mcp__browser__browser_take_screenshot", {})).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });
      expect(await preHook(a.q, "mcp__browser__.*")("mcp__browser__browser_snapshot", {})).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: BROWSER_SITE_DENIED } });
      expect(cards()).toHaveLength(1);
      expect(fx.sessions.browserSites.allowed("alice", a.id, origin)).toBe(false);
      // Other origins still ask.
      b.url = "https://news.example/";
      const news = a.q.askPermission("mcp__browser__browser_snapshot", {});
      answer(a.id, (await card(1)).request.requestId, "allow");
      expect(await news).toMatchObject({ behavior: "allow" });

      // Another session asks again (and its "allow" is its own).
      b.url = "https://tracker.example/";
      const other = await codeSession();
      const snap2 = other.q.askPermission("mcp__browser__browser_snapshot", {});
      expect((await card(2)).request).toMatchObject({ sessionId: other.id, browserSite: { origin } });
      answer(other.id, cards()[2]!.request.requestId, "allow");
      expect(await snap2).toMatchObject({ behavior: "allow" });
      expect(fx.sessions.browserSites.allowed("alice", other.id, origin)).toBe(true);
      expect(fx.sessions.browserSites.allowed("alice", a.id, origin)).toBe(false);
      expect(await a.q.askPermission("mcp__browser__browser_snapshot", {})).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });

      // Closing the session forgets the denial too.
      await fx.sessions.close(a.id);
      await turn(a.id, 2);
      const again = fx.sdk.last.askPermission("mcp__browser__browser_snapshot", {});
      expect((await card(3)).request).toMatchObject({ sessionId: a.id, browserSite: { origin } });
      answer(a.id, cards()[3]!.request.requestId, "deny");
      expect(await again).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });
      expect(await fx.sdk.last.askPermission("mcp__browser__browser_snapshot", {})).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });

      // "Always allow" given elsewhere (or added in Browser sites) wins over the denial.
      fx.store.insertSiteGrant("alice", origin);
      expect(await fx.sdk.last.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
      expect(fx.sessions.browserSites.allowed("alice", a.id, origin)).toBe(true);
      expect(cards()).toHaveLength(4);
    });

    it("a cancelled card is not a denial: the next call asks again", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const a = await codeSession();
      b.url = "https://slow.example/";
      const ac = new AbortController();
      const snap = a.q.askPermission("mcp__browser__browser_snapshot", {}, ac.signal);
      await card(0);
      ac.abort();
      expect(await snap).toMatchObject({ behavior: "deny" });
      const again = a.q.askPermission("mcp__browser__browser_snapshot", {});
      answer(a.id, (await card(1)).request.requestId, "allow");
      expect(await again).toMatchObject({ behavior: "allow" });
    });

    it("chats ask too (read tools); act tools stay refused without a card", async () => {
      const { b, dep } = fakeSessionBrowser();
      fx = runtimeFixture({ browser: dep });
      const id = fx.newSession("chat");
      await turn(id, 1);
      const q = fx.sdk.last;
      const gate = preHook(q, "mcp__browser__.*");
      const nav = gate("mcp__browser__browser_navigate", { url: "https://example.net/page" });
      const c0 = await card(0);
      expect(c0.request).toMatchObject({ sessionId: id, browserSite: { origin: "https://example.net" } });
      answer(id, c0.request.requestId, "allow");
      expect(await nav).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
      b.url = "https://example.net/page";
      expect(await q.askPermission("mcp__browser__browser_snapshot", {})).toMatchObject({ behavior: "allow" });
      expect(await q.askPermission("mcp__browser__browser_click", { ref: "e1" })).toEqual({ behavior: "deny", message: BROWSER_CHAT_READ_ONLY });
      b.url = "https://elsewhere.example/";
      const snap = q.askPermission("mcp__browser__browser_snapshot", {});
      const c1 = await card(1);
      answer(id, c1.request.requestId, "deny");
      expect(await snap).toEqual({ behavior: "deny", message: BROWSER_SITE_DENIED });
      expect(cards()).toHaveLength(2);
    });
  });

  it("no browser dependency → no server, nothing changes", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await turn(id, 1);
    expect(fx.sdk.last.options.mcpServers?.browser).toBeUndefined();
    expect((fx.sdk.last.options.systemPrompt as { append: string }).append).not.toContain(BROWSER_GUIDANCE);
  });
});

