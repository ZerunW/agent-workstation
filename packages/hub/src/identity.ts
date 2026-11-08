/**
 * Who is calling.
 *
 * The username comes from the `X-Workstation-User` header (or `?user=` where headers are impossible). Who sent it is
 * decided as follows. The invariants (also in docs/SECURITY.md):
 *
 * 1. In production the hub has no TCP listener for the user API. It listens on two Unix sockets (listen.ts):
 *    - the public socket (`[server] socket`): mode 0660, group `[server] proxy_group` (the nginx account's group). Only
 *      nginx connects here.
 *    - the local socket (`[server] local_socket`): mode 0600, owned by the service account. Only that account (the
 *      status service runs as it) and root can connect.
 *    The agent account is in neither group and owns nothing in the socket directory, so connect() fails with EACCES:
 *    the kernel enforces who can reach the hub, and this file only classifies callers that came through nginx.
 * 2. A request's trust level comes from which socket it arrived on, never from its headers:
 *    - public socket: the request must carry exactly one `X-Forwarded-For` value that is an IP address (nginx sets it
 *      to `$remote_addr`). Missing, repeated, comma-separated or unparsable: 400 `proxy_header_invalid`, for every
 *      route and WebSocket upgrades too (the health routes answer without it, auth.ts). Then the address decides:
 *        - one of this machine's own addresses (loopback, any interface address read live, the Tailscale self
 *          addresses): 403 `self_caller` (a process on the server calling its own tailnet name or LAN address reaches
 *          nginx, which would hand it on as that address; the tailnet maps a Tailscale address to the node's owner);
 *        - a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) with `auth.tailscale_identity` on: tailscaled whois
 *          (cached 60 s per IP), the caller is that person's Tailscale login; tagged nodes have no login: 403. With
 *          `tailscale_identity` off, tailnet clients are legacy;
 *        - anything else (the LAN): legacy with `auth.lan_access = "legacy"`, 403 `lan_denied` with "deny".
 *    - local socket: the local service caller (LOCAL_CALLER, legacy; the username comes from the user header). An
 *      `X-Forwarded-For` header here: 400 `proxy_header_invalid` (nginx never connects here; no confusion).
 *    - There is no "loopback peer" or "no X-Forwarded-For means local" rule in production.
 * 3. Development only (`[server] listen = "tcp"`, macOS, tests, no nginx): one TCP listener, and the hub behaves as
 *    before the sockets existed for loopback callers: the client IP is the socket peer, except when the peer is
 *    loopback, where it is the single `X-Forwarded-For` value (nginx on the same machine), and loopback without that
 *    header is a local tool (legacy). The hub refuses to start with `listen = "tcp"` in production when `[agents]
 *    run_as` is set (startupChecks.ts).
 *
 * Legacy callers may use any username; admin = `auth.admin_usernames`. Tailscale callers may use any username that is
 * not bound to another login (UserService.authorize); admin = `auth.admin_logins`.
 */
import { USER_HEADER, USER_QUERY_PARAM, Username } from "@agent-workstation/protocol";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { HubConfig } from "./config.js";
import { canonicalIp } from "./origin.js";
import { isLoopbackIp, isTailscaleIp, normalizeIp, TailscaleWhoisClient, type TailscaleWhois } from "./tailscale.js";
import { forbidden, HttpError, errorMessage } from "./util/errors.js";
import type { Logger } from "./util/log.js";

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  query?: unknown;
}

export type Caller =
  /** A person identified by their Tailscale login. */
  | { kind: "tailscale"; ip: string; login: string; node: string }
  /** Header identity: a local tool on the server, the LAN, or the tailnet while tailscale_identity is off. */
  | { kind: "legacy"; ip: string | null; source: "local" | "lan" | "tailnet" };

/** Requests that never passed the identity hook (e.g. built outside the app) count as local tools. */
export const LOCAL_CALLER: Caller = { kind: "legacy", ip: null, source: "local" };

/** Which listener a request arrived on (listen.ts): the public socket, the local socket, or the development TCP port. */
export type ListenerKind = "public" | "local" | "tcp";

export interface RequestSource {
  listener: ListenerKind;
  /** The socket peer; only read on the tcp listener. */
  remoteAddress?: string | undefined;
}

export interface IdentityResolver {
  /** Username the request claims, or null when none was sent. Throws nothing; validation happens in auth.ts. */
  username(req: RequestLike): string | null;
  /**
   * Admin flag of a username without a request (user lists, disk status, delete protection): with Tailscale identity
   * on, a user bound to a login is admin when that login is; otherwise `admin_usernames`.
   */
  isAdmin(username: string, boundLogin?: string | null): boolean;
  /** Admin flag of a request: Tailscale callers by login, legacy callers by username. */
  callerIsAdmin(caller: Caller, username: string): boolean;
  /** Classifies a request by the listener it arrived on, the socket peer (tcp listener only) and its headers. Throws HttpError 400/403/503 for callers that are refused. */
  caller(source: RequestSource, headers: RequestLike["headers"]): Promise<Caller>;
}

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * The client's IP: `local` for loopback without X-Forwarded-For, otherwise the address (null when nginx's header is
 * not a single IP — such a request is treated as coming from the LAN).
 */
export function clientAddress(socketIp: string | undefined, headers: RequestLike["headers"]): { kind: "local" } | { kind: "remote"; ip: string | null } {
  const peer = normalizeIp(socketIp);
  if (peer && isLoopbackIp(peer)) {
    const xff = headers["x-forwarded-for"];
    if (xff === undefined) return { kind: "local" };
    // nginx overwrites the header with $remote_addr: exactly one value.
    if (Array.isArray(xff) || xff.includes(",")) return { kind: "remote", ip: null };
    return { kind: "remote", ip: normalizeIp(xff) };
  }
  return { kind: "remote", ip: peer };
}

/** Every address of this machine's network interfaces, canonical spelling. */
export function interfaceAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      const c = canonicalIp(i.address.split("%")[0]!);
      if (c) out.push(c);
    }
  }
  return out;
}

/** What Identity asks the machine; tests replace it. */
export interface IdentityHost {
  /** Interface addresses of this machine, read per classification (default: os.networkInterfaces()). */
  addresses?: () => string[];
}

/** The one IP of a public-socket request's `X-Forwarded-For` (canonical spelling); null unless it is exactly one IP. */
export function forwardedAddress(headers: RequestLike["headers"]): string | null {
  const v = headers["x-forwarded-for"];
  if (typeof v !== "string") return null; // missing, or sent more than once
  const t = v.trim();
  if (t.includes(",") || isIP(t) === 0) return null;
  return canonicalIp(t);
}

export class Identity implements IdentityResolver {
  private readonly admins: Set<string>;
  private readonly adminLogins: Set<string>;

  constructor(
    private readonly config: HubConfig,
    private readonly whois: TailscaleWhois,
    private readonly log?: Logger,
    /** This server's own Tailscale addresses (canonical spelling); default none. */
    private readonly selfAddresses: () => Promise<ReadonlySet<string>> = async () => new Set(),
    private readonly host: IdentityHost = {},
  ) {
    this.admins = new Set(config.auth.adminUsernames);
    this.adminLogins = new Set(config.auth.adminLogins);
  }

  username(req: RequestLike): string | null {
    const h = first(req.headers[USER_HEADER.toLowerCase()]);
    if (h) return h.trim().toLowerCase();
    const q = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>)[USER_QUERY_PARAM] : undefined;
    const qs = Array.isArray(q) ? q[0] : q;
    return typeof qs === "string" && qs ? qs.trim().toLowerCase() : null;
  }

  isAdmin(username: string, boundLogin?: string | null): boolean {
    if (this.config.auth.tailscaleIdentity && boundLogin) return this.adminLogins.has(boundLogin.toLowerCase());
    return this.admins.has(username);
  }

  callerIsAdmin(caller: Caller, username: string): boolean {
    return caller.kind === "tailscale" ? this.adminLogins.has(caller.login) : this.admins.has(username);
  }

  async caller(source: RequestSource, headers: RequestLike["headers"]): Promise<Caller> {
    if (source.listener === "local") {
      if (headers["x-forwarded-for"] !== undefined) throw proxyHeaderInvalid("the local socket takes no X-Forwarded-For");
      return LOCAL_CALLER;
    }
    if (source.listener === "public") {
      const ip = forwardedAddress(headers);
      if (!ip) throw proxyHeaderInvalid("exactly one X-Forwarded-For address is required");
      return this.classify(ip);
    }
    const addr = clientAddress(source.remoteAddress, headers);
    if (addr.kind === "local") return LOCAL_CALLER;
    return this.classify(addr.ip);
  }

  /** The caller behind a client address (see the header comment); null address = not one IP, treated as the LAN. */
  private async classify(ip: string | null): Promise<Caller> {
    const canon = ip ? canonicalIp(ip) : null;
    if (ip && canon) {
      if (isLoopbackIp(ip) || (isTailscaleIp(ip) && (await this.selfAddresses()).has(canon)) || (this.host.addresses ?? interfaceAddresses)().includes(canon)) {
        throw forbidden("self_caller", "requests from this server itself are refused");
      }
    }
    if (ip && isTailscaleIp(ip)) {
      if (!this.config.auth.tailscaleIdentity) return { kind: "legacy", ip, source: "tailnet" };
      let who;
      try {
        who = await this.whois.lookup(ip);
      } catch (err) {
        this.log?.warn({ ip, err: errorMessage(err) }, "tailscale whois failed");
        throw new HttpError(503, "tailscale_unavailable", "could not ask tailscaled who is calling; try again shortly");
      }
      if (!who) throw forbidden("tailscale_identity_required", "this Tailscale device has no personal login (tagged or unknown node)");
      return { kind: "tailscale", ip, login: who.login, node: who.node };
    }
    if (this.config.auth.lanAccess === "deny") throw forbidden("lan_denied", "Agent Workstation is only reachable over Tailscale");
    return { kind: "legacy", ip, source: "lan" };
  }
}

function proxyHeaderInvalid(why: string): HttpError {
  return new HttpError(400, "proxy_header_invalid", why);
}

export function isValidUsername(name: string): boolean {
  return Username.safeParse(name).success;
}

export function createIdentity(config: HubConfig, opts: { whois?: TailscaleWhois; log?: Logger; selfAddresses?: () => Promise<ReadonlySet<string>>; host?: IdentityHost } = {}): IdentityResolver {
  return new Identity(config, opts.whois ?? new TailscaleWhoisClient(), opts.log, opts.selfAddresses, opts.host);
}
