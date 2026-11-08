/**
 * Per-website permission for the server browser (like Claude in Chrome): before a browser tool touches an origin, the
 * user must have allowed it — a stored grant (browser_site_grants, "always allow"), or "allow this session" (kept here
 * in memory until the session closes). Otherwise a permission card with `browserSite: { origin }` asks, in every
 * permission mode and in chats; sessions that never ask (dontAsk) are denied. A "deny" answer is remembered for the
 * session too (no second card) until a stored grant appears. Remembered tool rules (permissions_rules) never satisfy
 * a site check. After each tool call the MCP gateway asks `allowed()` about the pages the call left (redirects, clicks).
 */
import type { Store } from "../db/store.js";
import type { Logger } from "../util/log.js";
import { iso, systemClock, type Clock } from "../util/time.js";
import { BROWSER_SITE_DENIED, BROWSER_SITE_NO_ASK } from "./browserTools.js";
import type { PermissionBroker, PermissionContext } from "./permissions.js";

export type SiteDecision = { behavior: "allow" } | { behavior: "deny"; message: string; interrupt?: boolean };

export interface SiteCheckContext extends PermissionContext {
  /** false = the session never shows cards (dontAsk): an origin without a grant is denied. */
  canAsk: boolean;
}

export interface BrowserSitesDeps {
  store: Store;
  permissions: PermissionBroker;
  log: Logger;
  clock?: Clock;
}

export class BrowserSites {
  /**
   * sessionId → the answers given in that session: origins allowed ("allow" once, or "always") and origins the user
   * denied (later calls are denied without a new card, until a stored grant appears or the session closes).
   */
  private readonly sessionGrants = new Map<string, { user: string; origins: Set<string>; denied: Set<string> }>();
  /** One card per (session, origin) at a time: parallel calls of the same session wait for the same answer. */
  private readonly asking = new Map<string, Promise<SiteDecision>>();

  constructor(private readonly deps: BrowserSitesDeps) {}

  /** Whether the browser may touch `origin` for this tool call; asks the user when it has no grant. */
  async check(ctx: SiteCheckContext, origin: string, toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID?: string }): Promise<SiteDecision> {
    const answers = this.sessionGrants.get(ctx.sessionId);
    if (answers?.origins.has(origin)) return { behavior: "allow" };
    if (this.deps.store.hasSiteGrant(ctx.user, origin)) {
      answers?.denied.delete(origin);
      this.deps.store.touchSiteGrant(ctx.user, origin, iso((this.deps.clock ?? systemClock)()));
      return { behavior: "allow" };
    }
    if (answers?.denied.has(origin)) return { behavior: "deny", message: BROWSER_SITE_DENIED };
    if (!ctx.canAsk) return { behavior: "deny", message: BROWSER_SITE_NO_ASK };
    const key = `${ctx.sessionId}\n${origin}`;
    let pending = this.asking.get(key);
    if (!pending) {
      pending = this.ask(ctx, origin, toolName, input, opts).finally(() => this.asking.delete(key));
      this.asking.set(key, pending);
    }
    return pending;
  }

  /**
   * Whether `user` allowed `origin` for hub session `sessionId` (null = no session: stored grants only), without
   * asking: an "allow" answer of that session or a stored grant. The MCP gateway checks the pages a tool call left.
   */
  allowed(user: string, sessionId: string | null, origin: string): boolean {
    const answers = sessionId ? this.sessionGrants.get(sessionId) : undefined;
    if (answers && answers.user === user && answers.origins.has(origin)) return true;
    return this.deps.store.hasSiteGrant(user, origin);
  }

  /** Origins allowed for this session only (diagnostics, tests). */
  sessionOrigins(sessionId: string): string[] {
    return [...(this.sessionGrants.get(sessionId)?.origins ?? [])];
  }

  /** The session closed: its "allow this session" answers and its denials are gone. */
  dropSession(sessionId: string): void {
    this.sessionGrants.delete(sessionId);
  }

  /**
   * Revokes `user`'s permission for `origin`: the stored grant and the answers their open sessions hold, so the next
   * visit asks again. Returns whether there was a stored grant.
   */
  revoke(user: string, origin: string): boolean {
    for (const g of this.sessionGrants.values()) if (g.user === user) g.origins.delete(origin);
    return this.deps.store.deleteSiteGrant(user, origin);
  }

  private async ask(ctx: SiteCheckContext, origin: string, toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID?: string }): Promise<SiteDecision> {
    const result = await this.deps.permissions.request(ctx, toolName, input, {
      signal: opts.signal,
      ...(opts.toolUseID ? { toolUseID: opts.toolUseID } : {}),
      browserSite: { origin },
    });
    let g = this.sessionGrants.get(ctx.sessionId);
    if (!g) this.sessionGrants.set(ctx.sessionId, (g = { user: ctx.user, origins: new Set(), denied: new Set() }));
    if (result.behavior !== "allow") {
      // The user's "deny" holds for the rest of the session (no new card); a cancelled or timed-out card does not.
      if (!result.interrupt && result.message !== "cancelled") {
        g.denied.add(origin);
        this.deps.log.debug({ sessionId: ctx.sessionId, origin }, "browser site denied");
      }
      return { behavior: "deny", message: result.message, ...(result.interrupt ? { interrupt: true } : {}) };
    }
    // "Always allow" was stored by the broker; either way this session may use the origin from now on.
    g.denied.delete(origin);
    g.origins.add(origin);
    this.deps.log.debug({ sessionId: ctx.sessionId, origin }, "browser site allowed");
    return { behavior: "allow" };
  }
}
