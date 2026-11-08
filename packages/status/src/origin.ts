/**
 * Cross-site protection of the status API, the same rule as the hub's (packages/hub/src/origin.ts): a web page open in
 * a browser on a tailnet device could otherwise call this service as that device. The API (`/status/api/*`, every
 * method) refuses (403 `cross_site`) a request that
 * - has an `Origin` that is not allowed, or
 * - says `Sec-Fetch-Site: cross-site`.
 * Requests without either header (curl, other tools) pass: a web page cannot send a request without them.
 *
 * Allowed origins: `[server] public_url`, `https://<this server's Tailscale name>`, `http(s)://<its Tailscale address>`
 * and loopback with the status or hub port. The Tailscale name and addresses come from `tailscale status --json` and
 * are cached; when they cannot be read only the fixed origins are allowed.
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { ExecFn } from "./health/exec.js";

const SELF_TTL_MS = 5 * 60_000;
const SELF_RETRY_MS = 15_000;

export interface TailscaleSelf {
  dnsName: string;
  ips: string[];
}

/** `https://Example.com:443/x` → `https://example.com`; null when it is not an http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** This server's name and addresses from `tailscale status --json --peers=false`. */
export function tailscaleSelfFromExec(exec: ExecFn): () => Promise<TailscaleSelf | null> {
  return async () => {
    const r = await exec("tailscale", ["status", "--json", "--peers=false"], { timeoutMs: 5000 });
    if (r.error || r.code !== 0) throw new Error(r.message ?? `tailscale status exited ${r.code}`);
    const self = (JSON.parse(r.stdout) as { Self?: { DNSName?: string; TailscaleIPs?: unknown } }).Self;
    if (!self) return null;
    const dnsName = (self.DNSName ?? "").trim().replace(/\.$/, "").toLowerCase();
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((i): i is string => typeof i === "string") : [];
    return dnsName || ips.length > 0 ? { dnsName, ips } : null;
  };
}

export class OriginPolicy {
  private readonly fixed = new Set<string>();
  private dynamic = new Set<string>();
  private at = 0;
  private ttl = 0;
  private pending: Promise<void> | null = null;

  constructor(
    config: Pick<AppConfig, "publicUrl" | "port" | "hubPort">,
    private readonly self: (() => Promise<TailscaleSelf | null>) | null,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
  ) {
    const add = (o: string | null) => o && this.fixed.add(o);
    if (config.publicUrl) add(normalizeOrigin(config.publicUrl));
    for (const port of new Set([config.port, config.hubPort])) {
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) add(`http://${host}:${port}`);
    }
  }

  async allowed(origin: string): Promise<boolean> {
    const o = normalizeOrigin(origin);
    if (!o) return false;
    if (this.fixed.has(o)) return true;
    await this.refresh();
    return this.dynamic.has(o);
  }

  private refresh(): Promise<void> {
    if (!this.self) return Promise.resolve();
    if (this.now() - this.at < this.ttl) return Promise.resolve();
    this.pending ??= this.self()
      .then((s) => {
        const set = new Set<string>();
        if (s?.dnsName) set.add(`https://${s.dnsName}`);
        for (const ip of s?.ips ?? []) {
          const host = ip.includes(":") ? `[${ip}]` : ip;
          set.add(`http://${host}`);
          set.add(`https://${host}`);
        }
        this.dynamic = set;
        this.ttl = set.size ? SELF_TTL_MS : SELF_RETRY_MS;
      })
      .catch((err) => {
        this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "could not read this server's Tailscale name for the origin check");
        this.ttl = SELF_RETRY_MS;
      })
      .finally(() => {
        this.at = this.now();
        this.pending = null;
      });
    return this.pending;
  }
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The path as the router sees it: percent-escapes decoded (repeatedly), `//` and dot segments resolved; null when undecodable. */
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

/** Whether a request belongs to the status API (by its route or by its decoded path). */
function isApi(routeUrl: string | undefined, url: string): boolean {
  if (routeUrl?.startsWith("/status/api")) return true;
  const path = normalizedPath(url);
  return path === null || path === "/status/api" || path.startsWith("/status/api/");
}

/** Refuses cross-site requests to the status API (see the header comment). */
export function registerOriginGuard(app: FastifyInstance<any, any, any, any>, policy: OriginPolicy): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isApi(req.routeOptions.url, req.url)) return;
    const origin = header(req.headers.origin);
    const refuse = () => reply.code(403).send({ error: "requests from other web sites are refused", code: "cross_site" });
    if (origin !== undefined) {
      if (!(await policy.allowed(origin))) return refuse();
      return;
    }
    if (header(req.headers["sec-fetch-site"]) === "cross-site") return refuse();
  });
}
