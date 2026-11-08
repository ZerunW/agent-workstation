/**
 * Permission broker: the hub's `canUseTool` implementation.
 *
 * - Remembered rules (permissions_rules) are evaluated hub-side first — except for browser-site questions
 *   (`browserSite`, see browserSites.ts), which rules never answer; their "always" is a browser_site_grants row.
 * - Otherwise the request is held in a pending map that is independent of
 *   any WebSocket: closing every tab does not end it; snapshots re-send it.
 * - The first answer wins; later answers get `permission_not_found`.
 * - The SDK's abort signal → `permission_cancelled`.
 * - Timeout → deny with `interrupt: true`, so the turn stops instead of
 *   Claude carrying on unattended.
 * - `alwaysAsk` requests (the approval of a run_subagents batch, see subagents.ts): no rule answers them, they carry
 *   no suggestions, a "remember" answer only allows this once (no rule is stored) and the input is never replaced.
 * - Subagent sessions (Agent Workstation's run_subagents, see subagents.ts): their requests are shown in the parent session —
 *   `request.sessionId` is the parent and `request.subagent` names the child — while the entry still belongs to the
 *   child (its status, cancelSession, the answer resolves the child's call). The parent's session rules apply too.
 */
import type { PermissionRequest, PermissionResponse } from "@agent-workstation/protocol";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../db/store.js";
import type { Logger } from "../util/log.js";
import { iso, type Clock, systemClock } from "../util/time.js";
import { uuid } from "../util/ids.js";
import type { Broadcaster } from "../ws/protocol.js";
import { BROWSER_SITE_DENIED } from "./browserTools.js";
import { ruleMatches, rulesFromSuggestions } from "./rules.js";

export type { PermissionResult };

export interface PermissionContext {
  sessionId: string;
  user: string;
  /** Absolute cwd of the session (for relative path rules). */
  cwd: string;
}

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolUseID?: string;
  requestId?: string;
  suggestions?: unknown[];
  /** Ask whether the server browser may be used on this website (no rules, no suggestions, input never replaced). */
  browserSite?: { origin: string };
  /** Always a card: no rules, no suggestions, "remember" = allow once, input never replaced (subagent batches). */
  alwaysAsk?: boolean;
}

interface Entry {
  request: PermissionRequest;
  /** The session whose tool call waits (the child for a forwarded subagent request, else `request.sessionId`). */
  owner: string;
  user: string;
  input: Record<string, unknown>;
  alwaysAsk: boolean;
  resolve: (r: PermissionResult) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface PermissionBrokerDeps {
  store: Store;
  bus: Broadcaster;
  timeoutMs: () => number;
  log: Logger;
  /** Called when a session gains or loses a pending request (status requires_action ↔ running). */
  onChange: (sessionId: string) => void;
  clock?: Clock;
  /** A subagent session's parent and how to name the child on the card; null = a normal session. */
  subagentOf?: (sessionId: string) => { parentSessionId: string; description: string } | null;
}

export const TIMEOUT_DENY_MESSAGE = "The user is unavailable to approve this action; the turn was stopped.";

export class PermissionBroker {
  private readonly pending = new Map<string, Entry>();

  constructor(private readonly deps: PermissionBrokerDeps) {}

  /** Implements the SDK's canUseTool for one session. */
  async request(ctx: PermissionContext, toolName: string, input: Record<string, unknown>, opts: CanUseToolOptions): Promise<PermissionResult> {
    const site = opts.browserSite;
    const sub = this.deps.subagentOf?.(ctx.sessionId) ?? null;
    // A subagent also follows its parent's "allow in this session" rules (the person answered its cards there).
    const rules = site || opts.alwaysAsk ? [] : [...this.deps.store.rulesFor(ctx.user, toolName, ctx.sessionId), ...(sub ? this.deps.store.rulesFor(ctx.user, toolName, sub.parentSessionId) : [])];
    for (const rule of rules) {
      if (ruleMatches(rule, toolName, input, ctx.cwd)) {
        this.deps.log.debug({ sessionId: ctx.sessionId, toolName, ruleId: rule.id }, "permission auto-allowed by rule");
        return { behavior: "allow", updatedInput: input };
      }
    }
    if (opts.signal.aborted) return { behavior: "deny", message: "cancelled" };

    const requestId = opts.requestId && !this.pending.has(opts.requestId) ? opts.requestId : uuid();
    // Shown in the parent's view when a subagent asks; the entry stays the child's.
    const shownIn = sub ? sub.parentSessionId : ctx.sessionId;
    const request: PermissionRequest = {
      requestId,
      sessionId: shownIn,
      toolName,
      input,
      ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
      ...(!site && !opts.alwaysAsk && opts.suggestions && opts.suggestions.length ? { suggestions: opts.suggestions } : {}),
      ...(site ? { browserSite: { origin: site.origin } } : {}),
      ...(sub ? { subagent: { sessionId: ctx.sessionId, description: sub.description } } : {}),
      at: iso((this.deps.clock ?? systemClock)()),
    };

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        if (this.settle(requestId, { behavior: "deny", message: "cancelled" })) {
          this.deps.bus.toUser(ctx.user, { type: "permission_cancelled", sessionId: shownIn, requestId });
        }
      };
      const timer = setTimeout(() => {
        if (this.settle(requestId, { behavior: "deny", message: TIMEOUT_DENY_MESSAGE, interrupt: true })) {
          this.deps.log.info({ sessionId: ctx.sessionId, requestId, toolName }, "permission request timed out");
          this.deps.bus.toUser(ctx.user, { type: "permission_resolved", sessionId: shownIn, requestId, behavior: "deny" });
          this.deps.bus.toUser(ctx.user, {
            type: "notice",
            level: "warning",
            code: "permission_timeout",
            message: `No answer to the ${toolName} permission request; the turn was stopped.`,
            at: iso(),
          });
        }
      }, this.deps.timeoutMs());
      timer.unref?.();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        request,
        owner: ctx.sessionId,
        user: ctx.user,
        input,
        alwaysAsk: !!opts.alwaysAsk,
        resolve,
        timer,
        cleanup: () => opts.signal.removeEventListener("abort", onAbort),
      });
      this.deps.bus.toUser(ctx.user, { type: "permission_request", request });
      this.changed(request.sessionId, ctx.sessionId);
    });
  }

  /**
   * Applies a user's answer. First answer wins. A subagent's request can be answered through the parent (where it is
   * shown) or the child session.
   */
  respond(user: string, sessionId: string, response: PermissionResponse): { ok: true } | { ok: false; code: string; message: string } {
    const entry = this.pending.get(response.requestId);
    if (!entry || (entry.request.sessionId !== sessionId && entry.owner !== sessionId) || entry.user !== user) {
      return { ok: false, code: "permission_not_found", message: "This permission request was already answered, cancelled or timed out." };
    }
    let result: PermissionResult;
    const site = entry.request.browserSite;
    if (site) {
      // A website question: the tool input stays as asked (it decided the origin); "always" stores a site grant.
      if (response.behavior === "allow") {
        result = { behavior: "allow", updatedInput: entry.input };
        if (response.remember === "user") this.deps.store.insertSiteGrant(user, site.origin, iso((this.deps.clock ?? systemClock)()));
      } else {
        result = { behavior: "deny", message: response.message?.trim() || BROWSER_SITE_DENIED };
      }
    } else if (response.behavior === "allow" && entry.alwaysAsk) {
      // Allow once, exactly as asked: no rule is stored, the input is not replaced.
      result = { behavior: "allow", updatedInput: entry.input };
    } else if (response.behavior === "allow") {
      const updated = response.updatedInput;
      const updatedInput = updated && typeof updated === "object" && !Array.isArray(updated) ? (updated as Record<string, unknown>) : entry.input;
      result = { behavior: "allow", updatedInput };
      if (response.remember) {
        for (const r of rulesFromSuggestions(entry.request.toolName, entry.request.suggestions)) {
          this.deps.store.insertRule({
            user,
            // "This session" = where the card was shown (the parent, for a subagent's request).
            sessionId: response.remember === "session" ? entry.request.sessionId : null,
            toolName: r.toolName,
            ruleContent: r.ruleContent,
          });
        }
      }
    } else {
      result = { behavior: "deny", message: response.message?.trim() || "The user denied this action." };
    }
    this.settle(response.requestId, result);
    this.deps.bus.toUser(user, { type: "permission_resolved", sessionId: entry.request.sessionId, requestId: response.requestId, behavior: response.behavior });
    return { ok: true };
  }

  /** Cancels every pending request of a session (Stop / Close / process exit); a subagent's go with the subagent. */
  cancelSession(sessionId: string, message = "The turn was stopped."): number {
    let n = 0;
    for (const [id, e] of [...this.pending]) {
      if (e.owner !== sessionId) continue;
      if (this.settle(id, { behavior: "deny", message, interrupt: true })) {
        this.deps.bus.toUser(e.user, { type: "permission_cancelled", sessionId: e.request.sessionId, requestId: id });
        n++;
      }
    }
    return n;
  }

  /** Requests waiting in a session or shown in it (a parent also gets its subagents' requests). */
  pendingFor(sessionId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const e of this.pending.values()) if (e.request.sessionId === sessionId || e.owner === sessionId) out.push(e.request);
    return out;
  }

  hasPending(sessionId: string): boolean {
    for (const e of this.pending.values()) if (e.request.sessionId === sessionId || e.owner === sessionId) return true;
    return false;
  }

  private changed(shownIn: string, owner: string): void {
    this.deps.onChange(owner);
    if (shownIn !== owner) this.deps.onChange(shownIn);
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(requestId: string, result: PermissionResult): boolean {
    const e = this.pending.get(requestId);
    if (!e) return false;
    this.pending.delete(requestId);
    clearTimeout(e.timer);
    e.cleanup();
    e.resolve(result);
    this.changed(e.request.sessionId, e.owner);
    return true;
  }
}
