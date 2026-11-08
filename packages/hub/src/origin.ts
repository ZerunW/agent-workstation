/**
 * Who may talk to the hub from a web page, and under which names.
 *
 * 1. Host check (DNS rebinding). A web page can point its own DNS name at this server's address and then call the hub
 *    "same-origin" from the browser, with the Tailscale identity of the device it is open on. The hub therefore refuses
 *    (421 `bad_host`) a request whose `Host` is not one of this server's names: `[server] public_url`, the hosts of
 *    `[server] allowed_origins`, this server's Tailscale DNS name and addresses, loopback names and addresses, and,
 *    with `auth.lan_access` not "deny", the machine's own interface addresses. Ports are not compared (the name is what
 *    rebinding abuses). `/api/health` and `/healthz` stay open.
 * 2. Cross-site protection. Who is calling comes from the caller's Tailscale device, not from a cookie, so any web page
 *    open in a browser on a tailnet device could otherwise make requests the hub attributes to that device's login.
 *    Browsers label such requests: WebSocket upgrades and every request with a body carry an `Origin`, and all modern
 *    browsers send `Sec-Fetch-Site`. The hub refuses (403 `cross_site`) a request that
 *    - has an `Origin` that is not allowed, or
 *    - says `Sec-Fetch-Site: cross-site` (except a top-level page navigation to a web page, which only shows the page).
 *    Requests without either header (the macOS app's native client, curl, other tools on the tailnet) pass: a web page
 *    cannot send a request without them. Plain HTTP and older Safari send no Sec-Fetch headers, which is one more
 *    reason the Host check exists.
 *
 * Allowed origins: `[server] public_url`, `https://<this server's Tailscale name>`, `http(s)://<its Tailscale address>`,
 * the hub's own loopback address and port, and `[server] allowed_origins`.
 *
 * The same cached answer about this server's own Tailscale name and addresses serves the self-caller check in
 * identity.ts (`selfAddresses`).
 */
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { HubConfig } from "./config.js";
import type { TailscaleSelfSource } from "./tailscale.js";
import { HttpError, forbidden } from "./util/errors.js";
import type { Logger } from "./util/log.js";

const SELF_TTL_MS = 5 * 60_000;
const SELF_RETRY_MS = 15_000;

/** `https://Example.com:443/x` → `https://example.com`; null when it is not an http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The host name of a URL (no port, IPv6 without brackets, lower case); null when it is not an http(s) URL. */
function hostOfUrl(raw: string): string | null {
  const o = normalizeOrigin(raw);
  return o ? hostnameOf(new URL(o).host) : null;
}

/** An IP address in one spelling (IPv4-mapped IPv6 gives the IPv4, IPv6 compressed and lower case); null when not an IP. */
export function canonicalIp(raw: string): string | null {
  let ip = raw.trim().toLowerCase();
  if (/^\[.*\]$/.test(ip)) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v !== 6) return null;
  try {
    return new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * The host name of a `Host` header value: lower case, without port, brackets and a trailing dot; IP literals in their
 * canonical spelling. Null for a value that is not a plausible host (empty, userinfo, paths, spaces).
 */
export function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  const h = value.trim().toLowerCase();
  if (!h || /[\s/@\\?#]/.test(h)) return null;
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(h);
  if (v6) return canonicalIp(v6[1]!);
  const m = /^([^:[\]]+)(?::\d{1,5})?$/.exec(h);
  if (!m) return null;
  return m[1]!.replace(/\.$/, "") || null;
}

export interface OriginPolicyConfig {
  server: Pick<HubConfig["server"], "host" | "port" | "publicUrl" | "allowedOrigins">;
  /** Only `lanAccess` is read: with "deny" the machine's own LAN addresses are not host names of this server. */
  auth?: Pick<HubConfig["auth"], "lanAccess">;
}

export class OriginPolicy {
  private readonly fixed = new Set<string>();
  /** Host names of loopback, public_url and allowed_origins. */
  private readonly fixedHosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  private readonly lan: boolean;
  private selfDns = "";
  private selfIps = new Set<string>();
  private dynamic = new Set<string>();
  private dynamicAt = 0;
  private dynamicTtl = 0;
  private pending: Promise<void> | null = null;

  constructor(
    config: OriginPolicyConfig,
    private readonly self: TailscaleSelfSource | null,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
    private readonly localAddresses: () => string[] = ownAddresses,
  ) {
    const add = (o: string | null) => o && this.fixed.add(o);
    add(normalizeOrigin(config.server.publicUrl));
    for (const o of config.server.allowedOrigins) add(normalizeOrigin(o));
    const port = config.server.port;
    add(`http://127.0.0.1:${port}`);
    add(`http://localhost:${port}`);
    add(`http://[::1]:${port}`);
    for (const u of [config.server.publicUrl, ...config.server.allowedOrigins]) {
      const host = hostOfUrl(u);
      if (host) this.fixedHosts.add(host);
    }
    this.lan = config.auth ? config.auth.lanAccess !== "deny" : false;
  }

  /** Whether a browser page from `origin` may call the hub. */
  async allowed(origin: string): Promise<boolean> {
    const o = normalizeOrigin(origin);
    if (!o) return false;
    if (this.fixed.has(o)) return true;
    await this.refresh();
    return this.dynamic.has(o);
  }

  /**
   * This server's own Tailscale addresses (canonical spelling), from the cached tailscaled answer shared with the
   * origin and host checks. Empty when tailscaled cannot be asked.
   */
  async selfAddresses(): Promise<ReadonlySet<string>> {
    await this.refresh();
    return this.selfIps;
  }

  /** Whether a `Host` header names this server (see the header comment). */
  async hostAllowed(hostHeader: string | undefined): Promise<boolean> {
    const name = hostnameOf(hostHeader);
    if (!name) return false;
    if (this.fixedHosts.has(name)) return true;
    await this.refresh();
    if (name === this.selfDns || this.selfIps.has(name)) return true;
    if (this.lan && isIP(name) > 0) return this.localAddresses().some((a) => canonicalIp(a) === name);
    return false;
  }

  private refresh(): Promise<void> {
    if (!this.self) return Promise.resolve();
    if (this.now() - this.dynamicAt < this.dynamicTtl) return Promise.resolve();
    this.pending ??= this.self
      .self()
      .then((s) => {
        const set = new Set<string>();
        const ips = new Set<string>();
        if (s?.dnsName) set.add(`https://${s.dnsName}`);
        for (const raw of s?.ips ?? []) {
          const ip = canonicalIp(raw);
          if (!ip) continue;
          ips.add(ip);
          const host = isIP(ip) === 6 ? `[${ip}]` : ip;
          set.add(`http://${host}`);
          set.add(`https://${host}`);
        }
        this.dynamic = set;
        this.selfDns = s?.dnsName.toLowerCase() ?? "";
        this.selfIps = ips;
        this.dynamicTtl = set.size ? SELF_TTL_MS : SELF_RETRY_MS;
      })
      .catch((err) => {
        this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "could not read this server's Tailscale name for the origin and host checks");
        this.dynamicTtl = SELF_RETRY_MS;
      })
      .finally(() => {
        this.dynamicAt = this.now();
        this.pending = null;
      });
    return this.pending;
  }
}

/** Addresses of this machine's network interfaces. */
function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address.split("%")[0]!));
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The health routes answer every caller, whatever the Host or origin. */
export function isHealthRoute(routeUrl: string | undefined): boolean {
  return routeUrl === "/healthz" || routeUrl === "/api/health";
}

/**
 * The path of a request URL the way the router sees it: query dropped, percent-escapes decoded (repeatedly, so a
 * double-encoded spelling cannot hide), backslashes read as slashes, empty and `.` segments dropped, `..` resolved.
 * Null when it cannot be decoded (not a path any route would match).
 */
export function normalizedPath(url: string): string | null {
  let p = url.split("?")[0]!.split("#")[0]!;
  for (let i = 0; i < 5; i++) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (d === p) break;
    p = d;
  }
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** Whether a normalized path belongs to the API, a WebSocket route or the internal routes (never a web page). */
export function isApiPath(path: string): boolean {
  return /^\/(api|ws|internal)(\/|$)/.test(path);
}

interface RequestForNavigation {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  routeOptions?: { url?: string | undefined };
}

/**
 * Whether a cross-site top-level navigation only shows a web page: a GET or HEAD for a document whose path (decoded
 * and normalized, not the raw URL) is not an API path and that no API or WebSocket route matched: only the static
 * files and the single-page-app fallback, which are the catch-all route or no route at all.
 */
export function isPageNavigation(req: RequestForNavigation): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (header(req.headers["sec-fetch-mode"]) !== "navigate" || header(req.headers["sec-fetch-dest"]) !== "document") return false;
  const path = normalizedPath(req.url);
  if (path === null || isApiPath(path)) return false;
  const route = req.routeOptions?.url;
  return route === undefined || route === "/*" || route === "/" || route === "*";
}

/** Public, identity-free GETs a sandboxed visual (opaque origin) loads as scripts: never cross-site sensitive. */
function isPublicAsset(req: { url: string; routeOptions?: { url?: string | undefined } }): boolean {
  if (req.routeOptions?.url !== "/api/visual-cdn/:host/*") return false;
  const path = normalizedPath(req.url);
  return path !== null && path.startsWith("/api/visual-cdn/");
}

/** Refuses requests whose `Host` is not one of this server's names (DNS rebinding), before anything else. */
export function registerHostGuard(app: FastifyInstance, policy: OriginPolicy): void {
  app.addHook("onRequest", async (req) => {
    if (isHealthRoute(req.routeOptions.url)) return;
    if (!(await policy.hostAllowed(header(req.headers.host)))) {
      throw new HttpError(421, "bad_host", "this server does not answer to that host name");
    }
  });
}

/** Refuses cross-site requests before the identity hook (and so before any route or WebSocket upgrade). */
export function registerOriginGuard(app: FastifyInstance, policy: OriginPolicy): void {
  app.addHook("onRequest", async (req) => {
    if (isPublicAsset(req)) return;
    const origin = header(req.headers.origin);
    if (origin !== undefined) {
      if (!(await policy.allowed(origin))) throw forbidden("cross_site", "requests from other web sites are refused");
      return;
    }
    if (header(req.headers["sec-fetch-site"]) === "cross-site" && !isPageNavigation(req)) {
      throw forbidden("cross_site", "requests from other web sites are refused");
    }
  });
}
