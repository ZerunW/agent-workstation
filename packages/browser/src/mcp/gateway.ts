/**
 * The agents' browser MCP endpoint: one loopback HTTP listener for all users, `POST|GET|DELETE /mcp/<user>`
 * (Streamable HTTP, JSON responses), `Authorization: Bearer <per-user token>`, optional `X-Workstation-Session: <uuid>` to
 * attribute tool calls to a hub session.
 *
 * Each MCP session gets its own Playwright MCP server (`@playwright/mcp` createConnection) running in this process,
 * and — on its first tool call — the user's shared BrowserContext (Chromium started on demand, driven by the hub over
 * the DevTools pipe; no port). MCP sessions outlive the browser: after an idle stop the next tool call starts Chromium
 * again and the session picks up the new context, so agents never see a dead endpoint.
 *
 * Every tool result is checked before it goes back (checkPages): a page the call opened, navigated or selected on a
 * website the user has not allowed for that hub session (redirects, link clicks, popups) replaces the whole result
 * with a short notice.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadPlaywright, type McpServerLike, type PlaywrightBundle, type PwContext, type PwPage } from "../playwright.js";
import { isAllowedBrowserTool } from "./policy.js";
import { ShimTransport, type Id } from "./shim.js";

export interface GatewayHost {
  /** Constant-time check of the bearer token for this user (false for unknown users or a disabled feature). */
  checkToken(user: string, token: string): boolean;
  userDir(user: string): string;
  outputDir(user: string): string;
  /** Starts the user's browser if needed; resolves to its pipe-connected BrowserContext (shared by all MCP sessions). */
  context(user: string): Promise<PwContext>;
  toolStarted(user: string, tool: string, hubSessionId: string | null): void;
  toolFinished(user: string, tool: string): void;
  /** The agent selected a tab (Playwright bringToFront). */
  activateTarget(user: string, targetId: string): void;
  /**
   * Whether the user allowed the browser on `origin` for this hub session (a stored grant or this session's answer;
   * never asks). Checked after every tool call for the pages it left behind; absent = every origin passes.
   */
  siteAllowed?(user: string, hubSessionId: string | null, origin: string): boolean;
  capabilities: string[];
  log(msg: string, err?: unknown): void;
}

export interface GatewayOptions {
  host: string;
  port: number;
  sessionIdleMs: number;
  /** Test seam: a fake createConnection / chromium. */
  playwright?: () => PlaywrightBundle;
}

interface Session {
  id: string | null;
  user: string;
  transport: StreamableHTTPServerTransport;
  server: McpServerLike | null;
  hubSessionId: string | null;
  lastSeen: number;
  inflight: number;
  closed: boolean;
  /** The BrowserContext Playwright MCP got last (null until the first tool call needs one). */
  ctx: PwContext | null;
  /** Running tool calls: the pages (and their URLs) when the call started, to tell what the call changed. */
  calls: Map<Id, CallState>;
}

interface CallState {
  /** null = no context yet (taken when Playwright MCP asks for it, before the tool acts). */
  ctx: PwContext | null;
  before: Map<PwPage, string>;
  /** frontSeq when the call started: pages brought to front after it are the ones the call selected. */
  front: number;
}

export const siteNotAllowedMessage = (origin: string): string =>
  `The page is now on ${origin}, which the user has not allowed. Open it with browser_navigate to ask them.`;

/** The site a page URL belongs to for the post-call check; null = no website (about:blank, Chromium's error page). */
export function pageSite(url: string): string | null {
  if (url === "" || url.startsWith("about:blank") || url.startsWith("chrome-error://")) return null;
  try {
    const u = new URL(url);
    return u.origin !== "null" ? u.origin : u.protocol;
  } catch {
    return url;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^\/mcp\/([a-z0-9_-]{1,32})\/?$/;
const MAX_BODY = 4 * 1024 * 1024;

export const tokenEquals = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class McpGateway {
  private server: Server | null = null;
  private boundPort = 0;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Session>();
  /** Contexts whose tab selection is already reported to the live view. */
  private readonly followed = new WeakSet<PwContext>();
  /** Page → frontSeq of its last bringToFront (the tab Playwright MCP selected). */
  private readonly fronted = new WeakMap<PwPage, number>();
  private frontSeq = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: GatewayHost,
    private readonly opts: GatewayOptions,
  ) {}

  get port(): number {
    return this.boundPort;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  async listen(): Promise<number> {
    if (this.server) return this.boundPort;
    const server = createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
    return this.boundPort;
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all([...this.sessions.values(), ...this.pending].map((s) => this.drop(s)));
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  /** Open MCP sessions (optionally for one user). */
  sessionCount(user?: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (!user || s.user === user) n++;
    return n;
  }

  private pw(): PlaywrightBundle {
    return (this.opts.playwright ?? loadPlaywright)();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = PATH_RE.exec(url.pathname);
      if (!m) return plain(res, 404, "Not found");
      const hostHeader = (req.headers.host ?? "").toLowerCase();
      const okHosts = [`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`, `[::1]:${this.boundPort}`];
      if (!okHosts.includes(hostHeader)) return plain(res, 403, "Forbidden host");
      const user = m[1]!;
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token || !this.host.checkToken(user, token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="workstation-browser"');
        return plain(res, 401, "Unauthorized");
      }
      const hubHeader = req.headers["x-workstation-session"];
      const hubSessionId = typeof hubHeader === "string" && UUID_RE.test(hubHeader) ? hubHeader.toLowerCase() : null;
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readJson(req);
        } catch (e) {
          return rpcError(res, 400, -32700, `Parse error: ${(e as Error).message}`);
        }
      }
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string" && sid) {
        const s = this.sessions.get(sid);
        if (!s || s.user !== user) return rpcError(res, 404, -32001, "Session not found");
        s.lastSeen = Date.now();
        if (hubSessionId) s.hubSessionId = hubSessionId;
        await s.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== "POST" || !isInitialize(body)) return rpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
      const s = await this.createSession(user, hubSessionId);
      await s.transport.handleRequest(req, res, body);
    } catch (e) {
      this.host.log("mcp request failed", e);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
      else res.end();
    }
  }

  private async createSession(user: string, hubSessionId: string | null): Promise<Session> {
    const s: Session = {
      id: null,
      user,
      transport: undefined as unknown as StreamableHTTPServerTransport,
      server: null,
      hubSessionId,
      lastSeen: Date.now(),
      inflight: 0,
      closed: false,
      ctx: null,
      calls: new Map(),
    };
    s.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        s.id = id;
        this.pending.delete(s);
        this.sessions.set(id, s);
      },
      onsessionclosed: () => void this.drop(s),
    });
    const shim = new ShimTransport(s.transport, {
      roots: () => [{ uri: pathToFileURL(this.host.userDir(user)).href, name: user }],
      isAllowed: isAllowedBrowserTool,
      onToolCall: (tool, _args, _extra, callId) => {
        s.inflight++;
        s.lastSeen = Date.now();
        if (callId !== undefined) s.calls.set(callId, { ctx: s.ctx, before: pageUrls(s.ctx), front: this.frontSeq });
        this.host.toolStarted(user, tool, s.hubSessionId);
      },
      onToolDone: (tool, _isError, callId) => {
        s.inflight = Math.max(0, s.inflight - 1);
        s.lastSeen = Date.now();
        if (callId !== undefined) s.calls.delete(callId);
        this.host.toolFinished(user, tool);
      },
      checkResult: async (tool, callId, result) => this.checkPages(s, tool, callId, result),
    });
    this.pending.add(s);
    const config = {
      browser: { browserName: "chromium" },
      capabilities: this.host.capabilities,
      outputDir: this.host.outputDir(user),
      imageResponses: "allow",
      codegen: "none",
      webmcp: false,
      sharedBrowserContext: false,
      allowUnrestrictedFileAccess: false,
    };
    const server = await this.pw().createConnection(config, () => this.contextFor(s));
    s.server = server;
    await server.connect(shim);
    const protocolOnClose = shim.onclose;
    shim.onclose = () => {
      protocolOnClose?.();
      void this.drop(s);
    };
    return s;
  }

  /**
   * contextGetter for Playwright MCP: the user's running Chromium (started on demand) as the BrowserContext the hub
   * itself launched over the DevTools pipe — the same object for every MCP session, no second connection. When the
   * browser stops, the context closes and Playwright MCP asks again for the next one.
   */
  private async contextFor(s: Session): Promise<PwContext> {
    const ctx = await this.host.context(s.user);
    if (s.closed) throw new Error("MCP session closed");
    if (!this.followed.has(ctx)) {
      this.followed.add(ctx);
      this.followTabSelection(s.user, ctx);
    }
    // Running calls that started without this context (first call, browser restarted): their "before" is now,
    // before Playwright MCP acts on it.
    s.ctx = ctx;
    for (const c of s.calls.values()) {
      if (c.ctx !== ctx) {
        c.ctx = ctx;
        c.before = pageUrls(ctx);
      }
    }
    return ctx;
  }

  /**
   * After a tool call, before its result goes back: the pages the call opened, navigated (redirects, link clicks) or
   * selected must be on websites the user allowed for this session (or about:blank). Otherwise the whole result is
   * replaced by one text block, so no snapshot, screenshot or console output of that page reaches the agent.
   */
  private checkPages(s: Session, tool: string, callId: Id, result: unknown): unknown {
    const call = s.calls.get(callId);
    const allowed = this.host.siteAllowed;
    if (!call?.ctx || !allowed) return result;
    let pages: PwPage[];
    try {
      pages = call.ctx.pages();
    } catch {
      return result;
    }
    for (const page of pages) {
      let url: string;
      try {
        url = page.url();
      } catch {
        continue;
      }
      const touched = !call.before.has(page) || call.before.get(page) !== url || (this.fronted.get(page) ?? -1) > call.front;
      if (!touched) continue;
      const site = pageSite(url);
      if (site === null) continue;
      let ok = false;
      try {
        ok = allowed.call(this.host, s.user, s.hubSessionId, site);
      } catch (e) {
        this.host.log("site check failed", e);
      }
      if (!ok) {
        this.host.log(`${tool} left a page on ${site} (not allowed for this session): result withheld`);
        return { content: [{ type: "text", text: siteNotAllowedMessage(site) }], isError: true };
      }
    }
    return result;
  }

  /** Playwright MCP selects tabs with page.bringToFront(); report the tab so the live view follows the agent. */
  private followTabSelection(user: string, ctx: PwContext): void {
    const wrap = (page: PwPage): void => {
      const original = page.bringToFront.bind(page);
      (page as { bringToFront: () => Promise<void> }).bringToFront = async () => {
        this.fronted.set(page, ++this.frontSeq);
        await original();
        try {
          const cdp = await ctx.newCDPSession(page);
          const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
          await cdp.detach().catch(() => undefined);
          this.host.activateTarget(user, targetInfo.targetId);
        } catch {
          // the tab may already be gone
        }
      };
    };
    for (const p of ctx.pages()) wrap(p);
    ctx.on("page", wrap);
  }

  private async drop(s: Session): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    if (s.id) this.sessions.delete(s.id);
    this.pending.delete(s);
    // closing the server closes the shim, which reports still-running tool calls as finished
    // (the BrowserContext is the hub's own and shared: dropping a session never closes it)
    await s.server?.close().catch(() => undefined);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.opts.sessionIdleMs;
    for (const s of this.sessions.values()) if (s.inflight === 0 && s.lastSeen < cutoff) void this.drop(s);
  }
}

/** Each page of `ctx` with its URL now (empty without a context, or when it is gone). */
function pageUrls(ctx: PwContext | null): Map<PwPage, string> {
  const out = new Map<PwPage, string>();
  try {
    for (const p of ctx?.pages() ?? []) out.set(p, p.url());
  } catch {
    // the context closed
  }
  return out;
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize");
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
