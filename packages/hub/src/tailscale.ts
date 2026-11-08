/**
 * Who is calling from the tailnet: tailscaled's LocalAPI whois (`/localapi/v0/whois?addr=<ip>:1` over its unix socket),
 * `tailscale whois --json <ip>` as a fallback, cached per IP.
 *
 * Access: on Linux tailscaled's socket (`/run/tailscale/tailscaled.sock`) is normally mode 0666 and grants read access
 * (enough for whois) to every local account, so the hub's own account should need no group or sudo rule. Check on the
 * server with `sudo -u <hub user> tailscale whois --json <a tailnet IP>`; if it is refused, see the hub README
 * ("Identity").
 */
import { execFile } from "node:child_process";
import { request } from "node:http";
import { BlockList, isIP } from "node:net";

export const TAILSCALED_SOCKET = "/run/tailscale/tailscaled.sock";
export const WHOIS_TTL_MS = 60_000;
const WHOIS_TIMEOUT_MS = 3_000;
const MAX_CACHE = 1_000;

export interface TailscaleWho {
  /** Lower-cased login name, e.g. "someone@example.com". */
  login: string;
  /** Node (machine) name, e.g. "macbook". */
  node: string;
}

export interface TailscaleWhois {
  /** The person behind a tailnet IP; null for tagged nodes and unknown peers. Rejects when tailscaled cannot be asked. */
  lookup(ip: string): Promise<TailscaleWho | null>;
}

const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`; null when not an IP address. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

export function isTailscaleIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return TAILNET.check(ip, "ipv4");
  if (v === 6) return TAILNET.check(ip, "ipv6");
  return false;
}

export function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

interface RawWhois {
  Node?: { Name?: string; ComputedName?: string; Tags?: string[] | null } | null;
  UserProfile?: { LoginName?: string } | null;
}

/** A whois answer → identity; tagged nodes (no user login) → null. */
export function parseWhois(raw: unknown): TailscaleWho | null {
  const r = (raw ?? {}) as RawWhois;
  if (!r.Node) return null;
  if (Array.isArray(r.Node.Tags) && r.Node.Tags.length > 0) return null;
  const login = r.UserProfile?.LoginName?.trim().toLowerCase();
  if (!login || login === "tagged-devices") return null;
  const node = r.Node.ComputedName || (r.Node.Name ?? "").replace(/\.$/, "").split(".")[0] || "";
  return { login, node };
}

/** This server's own identity on the tailnet. */
export interface TailscaleSelf {
  /** MagicDNS name without the trailing dot, e.g. "workstation.tailnet.ts.net"; "" when unknown. */
  dnsName: string;
  /** Tailscale addresses of this server. */
  ips: string[];
}

export interface TailscaleSelfSource {
  self(): Promise<TailscaleSelf | null>;
}

/** A tailscaled status answer → this server's name and addresses. */
export function parseSelf(raw: unknown): TailscaleSelf | null {
  const s = (raw as { Self?: { DNSName?: string; TailscaleIPs?: unknown } } | null)?.Self;
  if (!s) return null;
  const dnsName = (s.DNSName ?? "").trim().replace(/\.$/, "").toLowerCase();
  const ips = Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs.filter((i): i is string => typeof i === "string" && isIP(i) > 0) : [];
  if (!dnsName && ips.length === 0) return null;
  return { dnsName, ips };
}

export interface WhoisOptions {
  /** tailscaled's LocalAPI socket (default /run/tailscale/tailscaled.sock). */
  socketPath?: string;
  /** CLI used when the socket cannot be used (default "tailscale" on PATH; null = no fallback). */
  cliBin?: string | null;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class TailscaleWhoisClient implements TailscaleWhois {
  private readonly cache = new Map<string, { at: number; value: Promise<TailscaleWho | null> }>();
  private readonly socketPath: string;
  private readonly cliBin: string | null;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(o: WhoisOptions = {}) {
    this.socketPath = o.socketPath ?? TAILSCALED_SOCKET;
    this.cliBin = o.cliBin === undefined ? "tailscale" : o.cliBin;
    this.ttlMs = o.ttlMs ?? WHOIS_TTL_MS;
    this.timeoutMs = o.timeoutMs ?? WHOIS_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
  }

  /** Answers (including "tagged") are cached for ttlMs per IP; failures are not cached. */
  lookup(ip: string): Promise<TailscaleWho | null> {
    const now = this.now();
    const hit = this.cache.get(ip);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = this.fetch(ip);
    this.cache.set(ip, { at: now, value });
    value.catch(() => {
      if (this.cache.get(ip)?.value === value) this.cache.delete(ip);
    });
    if (this.cache.size > MAX_CACHE) {
      for (const [k, v] of this.cache) if (now - v.at >= this.ttlMs) this.cache.delete(k);
    }
    return value;
  }

  private async fetch(ip: string): Promise<TailscaleWho | null> {
    let raw: unknown;
    try {
      raw = await this.localApi(ip);
    } catch (err) {
      if (!this.cliBin) throw err;
      raw = await this.cli(ip);
    }
    return parseWhois(raw);
  }

  /** The whois JSON; null when tailscaled knows no peer with that address (404). */
  private localApi(ip: string): Promise<unknown> {
    const addr = isIP(ip) === 6 ? `[${ip}]:1` : `${ip}:1`;
    return this.localApiGet(`/localapi/v0/whois?addr=${encodeURIComponent(addr)}`);
  }

  /** This server's own tailnet name and addresses (LocalAPI status); null when tailscaled reports none. */
  async self(): Promise<TailscaleSelf | null> {
    let raw: unknown;
    try {
      raw = await this.localApiGet("/localapi/v0/status?peers=false");
    } catch (err) {
      if (!this.cliBin) throw err;
      raw = await new Promise<unknown>((resolve, reject) => {
        execFile(this.cliBin!, ["status", "--json", "--peers=false"], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => {
          if (e) return reject(new Error(`tailscale status: ${e.message}`));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("tailscale status: invalid JSON"));
          }
        });
      });
    }
    return parseSelf(raw);
  }

  private localApiGet(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method: "GET",
          path,
          headers: { Host: "local-tailscaled.sock" },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode === 404) return resolve(null);
            if (res.statusCode !== 200) return reject(new Error(`tailscaled whois: HTTP ${res.statusCode}: ${body.trim().slice(0, 200)}`));
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("tailscaled whois: invalid JSON"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("tailscaled whois: timeout")));
      req.on("error", reject);
      req.end();
    });
  }

  private cli(ip: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(this.cliBin!, ["whois", "--json", ip], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`tailscale whois: ${err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("tailscale whois: invalid JSON"));
        }
      });
    });
  }
}
