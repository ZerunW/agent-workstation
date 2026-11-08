/** Admin-tunable settings: config defaults overlaid with overrides stored in kv. */
import { AdminSettings } from "@agent-workstation/protocol";
import type { HubConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { badRequest } from "./util/errors.js";

const KEY = "admin_settings";

/** The stored overrides limited to fields AdminSettings has (keys of settings that no longer exist are dropped). */
function known(o: Partial<AdminSettings>): Partial<AdminSettings> {
  const r = AdminSettings.partial().strip().safeParse(o);
  return r.success ? r.data : {};
}

export class SettingsService {
  private cache: AdminSettings | null = null;
  constructor(
    private readonly store: Store,
    private readonly config: HubConfig,
  ) {}

  get(): AdminSettings {
    if (this.cache) return this.cache;
    const defaults: AdminSettings = {
      remoteClaudeEnabled: this.config.limits.remoteClaudeEnabled,
      diskWarnPercent: this.config.limits.diskWarnPercent,
      diskBlockPercent: this.config.limits.diskBlockPercent,
      defaultWeeklyTokenLimit: this.config.limits.defaultWeeklyTokenLimit,
      defaultModel: this.config.sessions.defaultModel,
      defaultEffort: this.config.sessions.defaultEffort,
      apiMonthlyLimitUsd: this.config.billing.apiMonthlyLimitUsd,
      apiResetDay: this.config.billing.apiResetDay,
      serviceReserveUsd: this.config.billing.serviceReserveUsd,
    };
    const overrides = known(this.store.kvGet<Partial<AdminSettings>>(KEY) ?? {});
    this.cache = { ...defaults, ...overrides };
    return this.cache;
  }

  patch(p: Partial<AdminSettings>): { before: AdminSettings; after: AdminSettings } {
    const before = this.get();
    const after = { ...before, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as AdminSettings;
    if (after.diskWarnPercent <= 0 || after.diskBlockPercent > 100 || after.diskWarnPercent >= after.diskBlockPercent) {
      throw badRequest("invalid_request", "need 0 < diskWarnPercent < diskBlockPercent <= 100");
    }
    if (!after.defaultModel) throw badRequest("invalid_request", "defaultModel must be a model id");
    const limit = after.apiMonthlyLimitUsd;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > 1_000_000)) {
      throw badRequest("invalid_request", "apiMonthlyLimitUsd must be between 0 and 1000000");
    }
    const day = after.apiResetDay;
    if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 28)) throw badRequest("invalid_request", "apiResetDay must be a whole day of month from 1 to 28");
    const service = after.serviceReserveUsd;
    if (service !== undefined && (typeof service !== "number" || !Number.isFinite(service) || service < 0 || service > 1_000_000)) {
      throw badRequest("invalid_request", "serviceReserveUsd must be between 0 and 1000000");
    }
    const overrides = known({ ...(this.store.kvGet<Partial<AdminSettings>>(KEY) ?? {}), ...p });
    this.store.kvSet(KEY, overrides);
    this.cache = after;
    return { before, after };
  }
}
