/** Usage (limits, my tokens), disk, and admin endpoints. */
import type { FastifyInstance } from "fastify";
import type { AdminOverview, TokenUsageBucket } from "@agent-workstation/protocol";
import { PatchAdminSettingsBody, UsageRangeQuery } from "@agent-workstation/protocol";
import { parse, requireAdmin, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { modelDisplayName } from "../sessions/models.js";
import { usageBuckets, weeklyTokens, WEEK_MS, rangeStart } from "../sessions/usageReports.js";
import { readProcessRssMiB } from "../util/meminfo.js";
import { iso } from "../util/time.js";

/**
 * Each bucket carries `displayName` (the catalog name, so clients do not show raw ids). `costUsd` is the list-price
 * estimate of the turns (the SDK's when it reported one, else the hub's price table). These are usage figures: API
 * credits are counted from the key proxy's metered requests only (BillingService, `apiSpentUsd` in the admin usage).
 */
function describeBuckets<T extends TokenUsageBucket>(hub: Hub, buckets: T[]): (T & { displayName: string })[] {
  const catalog = hub.catalog.getModels();
  const names = new Map<string, string>();
  return buckets.map((b) => {
    let displayName = names.get(b.model);
    if (displayName === undefined) names.set(b.model, (displayName = modelDisplayName(b.model, catalog)));
    return { ...b, displayName };
  });
}

export function registerUsageRoutes(app: FastifyInstance, hub: Hub): void {
  /** The status service (separate process) asks with its own username ([status] hub_user) or the viewer's. */
  app.get("/api/usage/limits", async (req) => {
    requireUser(hub, req);
    return hub.usageLimits.current();
  });

  app.get("/api/usage/me", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(UsageRangeQuery, req.query, "query");
    const buckets = describeBuckets(hub, usageBuckets(hub.store, q.range, u.name)).map(({ user: _user, ...b }) => b);
    return { range: q.range, buckets, weeklyTokens: weeklyTokens(hub.store, u.name), weeklyLimit: hub.users.effectiveWeeklyLimit(u.row) };
  });

  app.get("/api/disk", async (req) => {
    const u = requireUser(hub, req);
    return hub.disk.statusForFresh(u.name);
  });

  // ----------------------------------------------------------------- admin

  app.get("/api/admin/settings", async (req) => {
    requireAdmin(hub, req);
    return hub.settings.get();
  });

  app.patch("/api/admin/settings", async (req) => {
    const admin = requireAdmin(hub, req);
    const body = parse(PatchAdminSettingsBody, req.body ?? {}, "body");
    const { before, after } = hub.settings.patch(body);
    hub.log.info({ admin: admin.name, before, after }, "admin settings changed");
    if (before.remoteClaudeEnabled !== after.remoteClaudeEnabled) {
      hub.ws.toAll({
        type: "notice",
        level: after.remoteClaudeEnabled ? "info" : "warning",
        code: after.remoteClaudeEnabled ? "remote_enabled" : "remote_disabled",
        message: after.remoteClaudeEnabled ? "Remote sessions are enabled again." : "Remote sessions were disabled by the admin. Running turns finish; new ones are refused.",
        at: iso(),
      });
    }
    if (before.diskWarnPercent !== after.diskWarnPercent || before.diskBlockPercent !== after.diskBlockPercent) await hub.disk.thresholdsChanged();
    if (before.apiMonthlyLimitUsd !== after.apiMonthlyLimitUsd || before.apiResetDay !== after.apiResetDay) {
      hub.billing.clearCreditsExhausted();
      hub.usageLimits.broadcast();
    }
    return after;
  });

  /** Every priced model with its periods in force and their source, and the price-check history. */
  app.get("/api/admin/pricing", async (req) => {
    requireAdmin(hub, req);
    return hub.priceCheck.view();
  });

  /** Runs the price check now (the hub fetches Anthropic's pricing pages and Claude Haiku reads them; up to a minute or two). */
  app.post("/api/admin/pricing/refresh", async (req) => {
    const admin = requireAdmin(hub, req);
    hub.log.info({ admin: admin.name }, "price check requested");
    const run = await hub.priceCheck.refresh("admin");
    return { check: run.check, checks: run.checks, pricing: hub.priceCheck.view() };
  });

  app.get("/api/admin/overview", async (req): Promise<AdminOverview> => {
    requireAdmin(hub, req);
    const mem = hub.memInfo();
    const disk = hub.disk.current();
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    const weekly = hub.store.tokensSinceByUser(since);
    const counts = hub.store.sessionCounts();
    return {
      settings: hub.settings.get(),
      usageLimits: hub.usageLimits.current(),
      disk: { level: disk.level, usedPercent: disk.usedPercent, totalBytes: disk.totalBytes, freeBytes: disk.freeBytes },
      memory: { totalMiB: mem?.totalMiB ?? null, availableMiB: mem?.availableMiB ?? null, minFreeMiB: hub.config.sessions.minFreeMemMib },
      pool: { active: hub.sessions.pool.activeCount, max: hub.config.sessions.maxActiveProcesses, queued: hub.sessions.pool.queuedCount },
      processes: hub.sessions.liveProcesses().map((p) => ({ ...p, rssMiB: p.pid ? readProcessRssMiB(p.pid) : null })),
      users: hub.store.listUsers(false).map((r) => ({
        user: r.name,
        enabled: r.enabled,
        sessions: counts.get(r.name) ?? 0,
        weeklyTokens: weekly.get(r.name)?.tokens ?? 0,
        weeklyLimit: hub.users.effectiveWeeklyLimit(r),
      })),
    };
  });

  app.get("/api/admin/usage", async (req) => {
    requireAdmin(hub, req);
    const q = parse(UsageRangeQuery, req.query, "query");
    const since = rangeStart(q.range, new Date()).toISOString();
    const inRange = hub.store.tokensSinceByUser(since);
    const weekly = hub.store.tokensSinceByUser(new Date(Date.now() - WEEK_MS).toISOString());
    const counts = hub.store.sessionCounts();
    // Two figures, kept apart: `costUsd` = estimated usage cost of the turns; additive `apiSpentUsd` = the
    // API credits the user's metered Claude requests used in the range (api_requests, as UsageLimits.api counts them).
    const apiSpent = hub.store.apiSpendByUser(since, new Date(Date.now() + 1000).toISOString());
    return {
      users: hub.store.listUsers(false).map((r) => ({
        user: r.name,
        weeklyTokens: weekly.get(r.name)?.tokens ?? 0,
        weeklyLimit: hub.users.effectiveWeeklyLimit(r),
        costUsd: inRange.get(r.name)?.costUsd ?? 0,
        apiSpentUsd: Math.round((apiSpent.get(r.name) ?? 0) * 10_000) / 10_000,
        sessions: counts.get(r.name) ?? 0,
      })),
      buckets: describeBuckets(hub, usageBuckets(hub.store, q.range, null).filter((b) => b.user !== "_system")),
    };
  });
}
