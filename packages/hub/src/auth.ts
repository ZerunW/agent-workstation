/** Request identity + validation helpers shared by all routes. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Hub } from "./hub.js";
import { LOCAL_CALLER, type Caller, type RequestSource } from "./identity.js";
import { listenerOf } from "./listen.js";
import { isHealthRoute } from "./origin.js";
import type { SessionRow, UserRow } from "./db/store.js";
import { HttpError, notFound } from "./util/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who sent the request (set by the identity hook; null on open routes). */
    workstationCaller: Caller | null;
  }
}

export interface AuthedUser {
  name: string;
  row: UserRow;
  isAdmin: boolean;
  caller: Caller;
}

/** Routes anyone who can reach the hub may call, without identity checks (health, status page, app updates, readme pages, visual libraries). */
export function isOpenRoute(routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  return (
    routeUrl === "/healthz" ||
    routeUrl === "/api/health" ||
    routeUrl === "/api/readme/:doc" ||
    routeUrl === "/api/visual-cdn/:host/*" ||
    routeUrl.startsWith("/api/app/") ||
    routeUrl.startsWith("/download/")
  );
}

/**
 * Open paths that have no route of their own: `/download` is the web download page, served by the static handler or the
 * SPA fallback (route `/*` or the not-found handler), so only the request path can tell it apart.
 */
export function isOpenPath(url: string): boolean {
  const path = url.split("?")[0]!;
  return path === "/download" || path === "/download/";
}

/**
 * Which listener the request came in on and its socket peer, as identity.ts needs them. A connection that no listener
 * of ours tagged (injected requests in tests) counts as the public socket when the hub is configured for sockets, and
 * as the development TCP listener otherwise.
 */
function sourceOf(hub: Hub, req: FastifyRequest): RequestSource {
  const s = req.raw.socket;
  return { listener: listenerOf(s) ?? (hub.config.server.listen === "unix" ? "public" : "tcp"), remoteAddress: s?.remoteAddress };
}

/**
 * Classifies every request (identity.ts): refused callers (LAN with `lan_access = "deny"`, tagged Tailscale nodes, this
 * server itself) get their 403 here, before any route, the WebSocket upgrade included, and so does a request with a
 * bad proxy header (400 `proxy_header_invalid`). On open routes (no username needed) only the LAN refusal, the
 * self-caller refusal and the proxy header check apply: they are still closed to the local network under
 * `lan_access = "deny"` and to processes on this server calling its own addresses, and every other caller (tagged
 * nodes, a whois that is down) may read them. Only the health routes answer the server itself and a request
 * without the proxy header.
 */
export function registerIdentityHook(app: FastifyInstance, hub: Hub): void {
  app.decorateRequest("workstationCaller", null);
  app.addHook("onRequest", async (req) => {
    if (isOpenRoute(req.routeOptions.url) || isOpenPath(req.url)) {
      try {
        req.workstationCaller = await hub.identity.caller(sourceOf(hub, req), req.headers);
      } catch (err) {
        if (err instanceof HttpError && (err.code === "lan_denied" || ((err.code === "self_caller" || err.code === "proxy_header_invalid") && !isHealthRoute(req.routeOptions.url)))) throw err;
      }
      return;
    }
    req.workstationCaller = await hub.identity.caller(sourceOf(hub, req), req.headers);
  });
}

export function callerOf(req: FastifyRequest): Caller {
  return req.workstationCaller ?? LOCAL_CALLER;
}

/** Resolves (and auto-creates) the calling user. 401 when no username was sent, 403 user_bound (UserService.authorize). */
export function requireUser(hub: Hub, req: FastifyRequest): AuthedUser {
  const name = hub.identity.username({ headers: req.headers, query: req.query });
  if (!name) throw new HttpError(401, "user_required", "send the X-Workstation-User header (or ?user=) with your username");
  const caller = callerOf(req);
  const { row, isAdmin } = hub.users.authorize(name, caller);
  return { name, row, isAdmin, caller };
}

export function requireAdmin(hub: Hub, req: FastifyRequest): AuthedUser {
  const u = requireUser(hub, req);
  if (!u.isAdmin) throw new HttpError(403, "admin_required", "admin only");
  return u;
}

/** The session if it belongs to `user`; 404 otherwise (never reveals other users' sessions). */
export function ownedSession(hub: Hub, user: string, id: string): SessionRow {
  const s = hub.store.getSession(id);
  if (!s || s.user !== user || s.hidden) throw notFound("no such session");
  return s;
}

/** Structural view of a zod (v3) schema from @agent-workstation/protocol. */
export interface Parser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

export function parse<T>(schema: Parser<T>, data: unknown, what = "request"): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "invalid_request", `invalid ${what}`, r.error.issues);
  return r.data;
}
