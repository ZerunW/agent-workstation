/**
 * The gateway's post-call website check, driven over HTTP by the official MCP client against a scripted stand-in for
 * Playwright MCP (current tab, redirects, link clicks, popups, tab selection) on fake pages: a page the call left on an
 * origin the hub does not allow for that session replaces the whole result.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../src/index.js";
import { McpGateway, pageSite, siteNotAllowedMessage, type GatewayHost } from "../src/mcp/gateway.js";
import type { PlaywrightBundle, PwContext, PwPage } from "../src/playwright.js";

class FakePage implements PwPage {
  constructor(public u: string) {}
  url(): string {
    return this.u;
  }
  async bringToFront(): Promise<void> {}
}

class FakeContext {
  readonly list: FakePage[] = [];
  private readonly onPage: ((p: PwPage) => void)[] = [];
  constructor(urls: string[]) {
    for (const u of urls) this.list.push(new FakePage(u));
  }
  pages(): PwPage[] {
    return [...this.list];
  }
  on(event: string, h: (p: PwPage) => void): void {
    if (event === "page") this.onPage.push(h);
  }
  newPage(url: string): FakePage {
    const p = new FakePage(url);
    this.list.push(p);
    for (const h of this.onPage) h(p);
    return p;
  }
  async newCDPSession() {
    return { send: async () => ({ targetInfo: { targetId: "T1" } }), detach: async () => undefined, on: () => undefined };
  }
  browser() {
    return null;
  }
  async close(): Promise<void> {}
}

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_G = "99999999-8888-4777-8666-555555555555";

/** Playwright MCP stand-in: tools act on its own current tab, every result carries a snapshot and a screenshot. */
function fakePlaywright(ctx: FakeContext, redirects: Map<string, string>): PlaywrightBundle {
  return {
    chromium: {} as PlaywrightBundle["chromium"],
    mcpVersion: "test",
    coreVersion: "test",
    createConnection: async (_config, getContext) => {
      const server = new Server({ name: "fake-playwright", version: "1" }, { capabilities: { tools: {} } });
      let current: FakePage | null = null;
      const page = (text: string) => ({
        content: [
          { type: "text", text: `${text}\n### Page\n- Page URL: ${current!.u}\n### Snapshot\n- SECRET page text` },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["browser_navigate", "browser_click", "browser_tabs", "browser_snapshot"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const c = (await getContext()) as unknown as FakeContext;
        current ??= c.list[0]!;
        const args = (req.params.arguments ?? {}) as Record<string, string | number>;
        switch (req.params.name) {
          case "browser_navigate": {
            const url = String(args.url);
            current.u = redirects.get(url) ?? url;
            return page("navigated");
          }
          case "browser_click":
            // a link in the same tab, or one that opens a new tab (Playwright MCP keeps its current tab then)
            if (args.popup) c.newPage(String(args.popup));
            else current.u = String(args.to);
            return page("clicked");
          case "browser_tabs": {
            const tab = c.list[Number(args.index)]!;
            await tab.bringToFront();
            current = tab;
            return page("selected");
          }
          default:
            return page("snapshot");
        }
      });
      return server;
    },
  };
}

describe("gateway: website check after every tool call", () => {
  let gw: McpGateway | null = null;
  const clients: Client[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await gw?.close();
    gw = null;
  });

  async function setup(opts: { siteCheck?: boolean } = {}) {
    const ctx = new FakeContext(["about:blank", "https://private.example/inbox"]);
    const redirects = new Map<string, string>();
    /** hub session id ("" = none) → origins allowed for it; "*" = stored grants (every session). */
    const allowed = new Map<string, Set<string>>([["*", new Set(["https://a.example"])]]);
    const asked: [string, string | null, string][] = [];
    const host: GatewayHost = {
      checkToken: (user, token) => user === "alice" && token === "tok",
      userDir: () => "/nonexistent/alice",
      outputDir: () => "/nonexistent/alice/.browser/output",
      context: async () => ctx as unknown as PwContext,
      toolStarted: () => undefined,
      toolFinished: () => undefined,
      activateTarget: () => undefined,
      capabilities: [],
      log: () => undefined,
      ...(opts.siteCheck === false
        ? {}
        : {
            siteAllowed: (user: string, sid: string | null, origin: string) => {
              asked.push([user, sid, origin]);
              return !!allowed.get("*")?.has(origin) || !!allowed.get(sid ?? "")?.has(origin);
            },
          }),
    };
    gw = new McpGateway(host, { host: "127.0.0.1", port: 0, sessionIdleMs: 60_000, playwright: () => fakePlaywright(ctx, redirects) });
    const port = await gw.listen();
    const connect = async (hubSessionId?: string) => {
      const client = new Client({ name: "agent", version: "1" });
      const headers: Record<string, string> = { Authorization: "Bearer tok", ...(hubSessionId ? { "X-Workstation-Session": hubSessionId } : {}) };
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/alice`), { requestInit: { headers } }));
      clients.push(client);
      return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    };
    return { ctx, redirects, allowed, asked, connect };
  }

  const redacted = (origin: string) => ({ content: [{ type: "text", text: siteNotAllowedMessage(origin) }], isError: true });

  it("navigate to an allowed site that redirects elsewhere → only the notice (no snapshot, no screenshot)", async () => {
    const w = await setup();
    w.redirects.set("https://a.example/login", "https://evil.example/landing");
    const call = await w.connect(SESSION_A);
    const r = await call("browser_navigate", { url: "https://a.example/login" });
    expect(r).toEqual(redacted("https://evil.example"));
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(w.asked).toContainEqual(["alice", SESSION_A, "https://evil.example"]);
    // the user's own tab elsewhere, untouched by the call, is not looked at
    expect(w.asked.some(([, , o]) => o === "https://private.example")).toBe(false);
  });

  it("an allowed page comes back whole; about:blank needs nothing", async () => {
    const w = await setup();
    const call = await w.connect(SESSION_A);
    const r = await call("browser_navigate", { url: "https://a.example/docs" });
    expect(r.isError).toBeFalsy();
    expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(r.content[0]!.text).toContain("SECRET");
    const blank = await call("browser_navigate", { url: "about:blank" });
    expect(blank.content).toHaveLength(2);
    expect(w.asked.map(([, , o]) => o)).toEqual(["https://a.example"]);
  });

  it("a click that navigates to, or opens a tab on, another origin → the notice", async () => {
    const w = await setup();
    const call = await w.connect(SESSION_A);
    expect((await call("browser_navigate", { url: "https://a.example/" })).content).toHaveLength(2);
    expect(await call("browser_click", { to: "https://evil.example/next" })).toEqual(redacted("https://evil.example"));

    expect((await call("browser_navigate", { url: "https://a.example/" })).content).toHaveLength(2);
    expect(await call("browser_click", { popup: "https://popup.example/ad" })).toEqual(redacted("https://popup.example"));
    // a click that stays on the allowed site is fine
    expect((await call("browser_click", { to: "https://a.example/page2" })).content).toHaveLength(2);
  });

  it("selecting a tab on a site nobody allowed → the notice", async () => {
    const w = await setup();
    const call = await w.connect(SESSION_A);
    expect(await call("browser_tabs", { action: "select", index: 1 })).toEqual(redacted("https://private.example"));
  });

  it("the same origin allowed for this session → the whole response", async () => {
    const w = await setup();
    w.redirects.set("https://a.example/login", "https://sso.example/auth");
    w.allowed.set(SESSION_A, new Set(["https://sso.example"]));
    const call = await w.connect(SESSION_A);
    const r = await call("browser_navigate", { url: "https://a.example/login" });
    expect(r.content).toHaveLength(2);
    expect(r.content[0]!.text).toContain("https://sso.example/auth");
  });

  it("every session goes through the same check, with its own hub session", async () => {
    const w = await setup();
    w.redirects.set("https://a.example/login", "https://sso.example/auth");
    w.allowed.set(SESSION_A, new Set(["https://sso.example"]));
    // Another session connects to the same endpoint with its own X-Workstation-Session header
    const other = await w.connect(SESSION_G);
    expect(await other("browser_navigate", { url: "https://a.example/login" })).toEqual(redacted("https://sso.example"));
    expect(w.asked).toContainEqual(["alice", SESSION_G, "https://sso.example"]);
    // no session header: stored grants only
    w.asked.length = 0;
    const anon = await w.connect();
    expect(await anon("browser_click", { to: "https://sso.example/x" })).toEqual(redacted("https://sso.example"));
    expect(w.asked).toEqual([["alice", null, "https://sso.example"]]);
  });

  it("without a site check (no hub wiring) results pass unchanged", async () => {
    const w = await setup({ siteCheck: false });
    w.redirects.set("https://a.example/login", "https://evil.example/landing");
    const call = await w.connect(SESSION_A);
    expect((await call("browser_navigate", { url: "https://a.example/login" })).content).toHaveLength(2);
  });

  it("BrowserManager hands the hub's check (setSiteCheck) to the gateway; none set = everything passes", () => {
    const mgr = new BrowserManager({ usersRoot: "/nonexistent" });
    const host = (mgr as unknown as { gateway: { host: GatewayHost } }).gateway.host;
    expect(host.siteAllowed!("alice", null, "https://x.example")).toBe(true);
    const seen: unknown[] = [];
    mgr.setSiteCheck((user, sid, origin) => (seen.push([user, sid, origin]), origin === "https://ok.example"));
    expect(host.siteAllowed!("alice", SESSION_A, "https://ok.example")).toBe(true);
    expect(host.siteAllowed!("alice", SESSION_A, "https://x.example")).toBe(false);
    expect(seen).toEqual([["alice", SESSION_A, "https://ok.example"], ["alice", SESSION_A, "https://x.example"]]);
  });

  it("pageSite: origins of web pages, nothing for about:blank / error pages, the scheme for opaque URLs", () => {
    expect(pageSite("https://a.example:8443/x?y")).toBe("https://a.example:8443");
    expect(pageSite("about:blank")).toBeNull();
    expect(pageSite("")).toBeNull();
    expect(pageSite("chrome-error://chromewebdata/")).toBeNull();
    expect(pageSite("data:text/html,<p>x</p>")).toBe("data:");
    expect(pageSite("blob:https://a.example/123")).toBe("https://a.example");
  });
});
