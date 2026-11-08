/**
 * The caller's server browser: state, start, stop (the live view and input go over the WebSocket), and the websites
 * they always allow it on (ROUTES.browserSites).
 */
import type { FastifyInstance } from "fastify";
import { BrowserSiteQuery, type BrowserSitesResponse, type BrowserState } from "@agent-workstation/protocol";
import { isBrowserError, type BrowserErrorCode } from "@agent-workstation/browser";
import { parse, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { HttpError, notFound } from "../util/errors.js";

/** BrowserError.code → HTTP status (packages/browser/README.md). */
export const BROWSER_ERROR_STATUS: Record<BrowserErrorCode, number> = {
  disabled: 503,
  bad_user: 400,
  no_user_dir: 404,
  not_installed: 503,
  too_many: 503,
  low_memory: 503,
  launch_failed: 500,
  profile_in_use: 409,
  not_running: 409,
  bad_url: 400,
  not_started: 500,
};

/** A BrowserError as an HttpError with code `browser_<code>` (other errors pass through). */
export function browserHttpError(err: unknown): unknown {
  return isBrowserError(err) ? new HttpError(BROWSER_ERROR_STATUS[err.code] ?? 500, `browser_${err.code}`, err.message) : err;
}

async function mapped<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw browserHttpError(err);
  }
}

export function registerBrowserRoutes(app: FastifyInstance, hub: Hub): void {
  app.get("/api/browser", async (req): Promise<BrowserState> => {
    const u = requireUser(hub, req);
    return mapped(() => hub.browsers.state(u.name));
  });

  app.post("/api/browser/start", async (req): Promise<BrowserState> => {
    const u = requireUser(hub, req);
    return mapped(() => hub.browsers.ensure(u.name));
  });

  /** The profile (logins) stays on disk. */
  app.post("/api/browser/stop", async (req): Promise<BrowserState> => {
    const u = requireUser(hub, req);
    return mapped(() => hub.browsers.stop(u.name));
  });

  /** Websites with an "always allow" grant, most recently used first. */
  app.get("/api/me/browser-sites", async (req): Promise<BrowserSitesResponse> => {
    const u = requireUser(hub, req);
    return { sites: hub.store.listSiteGrants(u.name) };
  });

  /** Revokes a grant (and the answers open sessions hold for that website): the next visit asks again. */
  app.delete("/api/me/browser-sites", async (req, reply) => {
    const u = requireUser(hub, req);
    const q = parse(BrowserSiteQuery, req.query ?? {}, "query");
    if (!hub.sessions.browserSites.revoke(u.name, q.origin)) throw notFound("no such website grant");
    return reply.code(204).send();
  });
}
