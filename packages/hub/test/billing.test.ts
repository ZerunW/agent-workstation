import { writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as protocol from "@agent-workstation/protocol";
import { AdminOverview, AdminSettings as AdminSettingsSchema, CreateSessionBody, ERROR_CODES, Me, Session, UsageLimits, UserPreferencesBody, type AdminSettings } from "@agent-workstation/protocol";
import { ApiKeyStore, apiPeriod, BillingService, billingEnv, isCreditBalanceText, parseKeyFile } from "../src/billing.js";
import { KeyProxy, PROXY_TOKEN_RE } from "../src/keyProxy.js";
import { silentLogger, type Logger } from "../src/util/log.js";
import { hubFixture, msgBody, runtimeFixture, tempDir, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

/** Fake keys only: these strings must never show up in logs. */
const FAKE_KEY = "sk-ant-api03-TESTKEY-not-a-real-key-000000";
const OTHER_KEY = "sk-ant-api03-OTHERKEY-not-a-real-key-11111";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (obj: unknown, msg?: string) => void lines.push(JSON.stringify(obj) + " " + (msg ?? ""));
  return { lines, debug: rec, info: rec, warn: rec, error: rec };
}

describe("API key file", () => {
  it("parses KEY=value (export, quotes, comments) and bare keys", () => {
    expect(parseKeyFile(`ANTHROPIC_API_KEY=${FAKE_KEY}\n`)).toBe(FAKE_KEY);
    expect(parseKeyFile(`# comment\nexport ANTHROPIC_API_KEY="${FAKE_KEY}"\n`)).toBe(FAKE_KEY);
    expect(parseKeyFile(`OTHER=1\nANTHROPIC_API_KEY='${FAKE_KEY}'`)).toBe(FAKE_KEY);
    expect(parseKeyFile(`${FAKE_KEY}\n`)).toBe(FAKE_KEY);
    expect(parseKeyFile("ANTHROPIC_API_KEY=\n")).toBeNull();
    expect(parseKeyFile("\n# nothing\n")).toBeNull();
    expect(parseKeyFile("OTHER=1\n")).toBeNull();
  });

  it("reloads on mtime change and on demand, keeps the key in memory only, never logs it", () => {
    const t = tempDir();
    const file = join(t.dir, "anthropic.env");
    const log = recordingLogger();
    const changes: boolean[] = [];
    const keys = new ApiKeyStore({ file, log, pollMs: 0, onChange: (p) => changes.push(p) });
    try {
      keys.start();
      expect(keys.key()).toBeNull();
      writeFileSync(file, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
      expect(keys.checkMtime()).toBe(true);
      expect(keys.key()).toBe(FAKE_KEY);
      expect(keys.checkMtime()).toBe(false); // unchanged
      writeFileSync(file, `ANTHROPIC_API_KEY=${OTHER_KEY}\n`);
      utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      expect(keys.checkMtime()).toBe(true);
      expect(keys.key()).toBe(OTHER_KEY);
      unlinkSync(file);
      expect(keys.checkMtime()).toBe(true);
      expect(keys.present()).toBe(false);
      expect(changes).toEqual([true, true, false]);
      expect(process.env.ANTHROPIC_API_KEY).not.toBe(FAKE_KEY);
      const logged = log.lines.join("\n");
      expect(logged).not.toContain("TESTKEY");
      expect(logged).not.toContain("OTHERKEY");
    } finally {
      keys.stop();
      t.cleanup();
    }
  });

  it("child environment: the key, auth token and base URL are replaced by the proxy and a token, never a key", () => {
    const cred = { baseUrl: "http://127.0.0.1:41234", token: `hsk-${"a".repeat(43)}` };
    const api = billingEnv({ ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: "y", ANTHROPIC_BASE_URL: "http://elsewhere", PATH: "/bin" }, cred);
    expect(api).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: cred.token, ANTHROPIC_BASE_URL: cred.baseUrl });
    expect(() => billingEnv({}, null)).toThrow(expect.objectContaining({ status: 503, code: "api_unavailable" }));
    // A regression that hands the real key over fails closed.
    expect(() => billingEnv({}, { baseUrl: cred.baseUrl, token: FAKE_KEY })).toThrow(/proxy token/);
    expect(isCreditBalanceText("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")).toBe(true);
    expect(isCreditBalanceText("You've hit your weekly limit")).toBe(false);
  });
});

describe("budget period", () => {
  const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
  it("runs from the most recent reset day (local midnight) to the same day next month", () => {
    expect(apiPeriod(local(2026, 10, 31, 15), 1)).toEqual({ start: local(2026, 10, 1), end: local(2026, 11, 1) });
    expect(apiPeriod(local(2026, 10, 14, 23, 59), 15)).toEqual({ start: local(2026, 9, 15), end: local(2026, 10, 15) });
    expect(apiPeriod(local(2026, 10, 15, 0, 0), 15)).toEqual({ start: local(2026, 10, 15), end: local(2026, 11, 15) }); // exactly at the reset
    expect(apiPeriod(local(2027, 1, 10), 15)).toEqual({ start: local(2026, 12, 15), end: local(2027, 1, 15) }); // across the new year
    expect(apiPeriod(local(2026, 12, 20), 15)).toEqual({ start: local(2026, 12, 15), end: local(2027, 1, 15) });
    expect(apiPeriod(local(2026, 3, 1), 28)).toEqual({ start: local(2026, 2, 28), end: local(2026, 3, 28) }); // February
    expect(apiPeriod(local(2026, 2, 28, 0, 1), 28)).toEqual({ start: local(2026, 2, 28), end: local(2026, 3, 28) });
    expect(apiPeriod(local(2026, 5, 3), 0).start).toEqual(local(2026, 5, 1)); // out-of-range days clamp
    expect(apiPeriod(local(2026, 5, 30), 31).start).toEqual(local(2026, 5, 28));
  });
});

describe("billing service", () => {
  function service(o: { key?: string | null; limit?: number; spent?: number; resetDay?: number; now?: Date } = {}) {
    const spent = { v: o.spent ?? 0 };
    const settings = { v: { apiMonthlyLimitUsd: o.limit ?? 200, apiResetDay: o.resetDay ?? 1 } as AdminSettings };
    const calls: [string, string][] = [];
    const svc = new BillingService({
      store: { apiSpend: (a, b) => (calls.push([a, b]), spent.v) },
      settings: { get: () => settings.v },
      keys: { key: () => (o.key === undefined ? FAKE_KEY : o.key), present: () => (o.key === undefined ? true : o.key !== null) },
      clock: () => o.now ?? new Date(2026, 9, 31, 12),
    });
    return { svc, spent, settings, calls };
  }

  it("refuses without a key (503) or with a budget of 0, and when the budget is down to the service reserve (429)", () => {
    const { svc, spent } = service({ limit: 100 });
    expect(svc.available()).toBe(true);
    expect(() => svc.assertAvailable()).not.toThrow();
    expect(() => svc.assertCanSend()).not.toThrow();
    spent.v = 98; // $2.00 left = the default service reserve
    expect(svc.serviceReserveUsd()).toBe(2);
    expect(svc.overBudget()).toBe(true);
    expect(() => svc.assertCanSend()).toThrow(expect.objectContaining({ status: 429, code: "api_limit_reached" }));
    expect(svc.servicesAvailable()).toBe(true); // the services may use the reserve
    spent.v = 97.99;
    expect(svc.overBudget()).toBe(false);
    spent.v = 100;
    expect(svc.servicesAvailable()).toBe(false);

    const noKey = service({ key: null }).svc;
    expect(noKey.available()).toBe(false);
    expect(noKey.servicesAvailable()).toBe(false);
    expect(() => noKey.assertAvailable()).toThrow(expect.objectContaining({ status: 503, code: "api_unavailable" }));
    expect(() => noKey.assertCanSend()).toThrow(expect.objectContaining({ status: 503, code: "api_unavailable" }));
    const zero = service({ limit: 0 }).svc;
    expect(zero.available()).toBe(false);
    expect(() => zero.assertCanSend()).toThrow(expect.objectContaining({ status: 503, code: "api_unavailable" }));
  });

  it("the service reserve is an admin setting; exhausted credits reported by the API hold sends for a while", () => {
    const { svc, spent, settings } = service({ limit: 200 });
    settings.v = { ...settings.v, serviceReserveUsd: 30 };
    spent.v = 170; // exactly $30.00 left
    expect(svc.overBudget()).toBe(true);
    spent.v = 169.99;
    expect(svc.overBudget()).toBe(false);
    settings.v = { ...settings.v, serviceReserveUsd: 0 };
    spent.v = 199.99;
    expect(svc.overBudget()).toBe(false);
    spent.v = 200;
    expect(svc.overBudget()).toBe(true);
    spent.v = 0;
    svc.markCreditsExhausted();
    expect(svc.overBudget()).toBe(true);
    expect(svc.servicesAvailable()).toBe(false);
    svc.clearCreditsExhausted();
    expect(svc.overBudget()).toBe(false);
  });

  it("reports UsageLimits.api over the current period with the usual severity thresholds", () => {
    const { svc, spent, calls } = service({ limit: 200, resetDay: 15, now: new Date(2026, 9, 31, 12) });
    expect(svc.limits()).toMatchObject({ spentUsd: 0, limitUsd: 200, percent: 0, severity: "normal", periodStart: new Date(2026, 9, 15).toISOString(), resetsAt: new Date(2026, 10, 15).toISOString() });
    expect(calls.at(-1)).toEqual([new Date(2026, 9, 15).toISOString(), new Date(2026, 10, 15).toISOString()]);
    spent.v = 162;
    expect(svc.limits()).toMatchObject({ percent: 81, severity: "warning" });
    spent.v = 190;
    expect(svc.limits()).toMatchObject({ percent: 95, severity: "critical" });
    spent.v = 250;
    expect(svc.limits()).toMatchObject({ percent: 125, severity: "critical" });
    expect(service({ key: null }).svc.limits()).toBeNull();
    expect(service({ limit: 0 }).svc.limits()).toMatchObject({ percent: null, severity: "unknown", limitUsd: 0 });
    // A credit error from the API holds API sends for a while.
    const s2 = service({ limit: 100 });
    expect(s2.svc.overBudget()).toBe(false);
    s2.svc.markCreditsExhausted();
    expect(s2.svc.overBudget()).toBe(true);
    expect(s2.svc.limits()!.severity).toBe("critical");
    s2.svc.clearCreditsExhausted();
    expect(s2.svc.overBudget()).toBe(false);
  });
});

describe("billing in the session runtime", () => {
  let fx: RuntimeFixture;
  let svc: BillingService;
  const key = { v: FAKE_KEY as string | null };
  const settings = { v: { apiMonthlyLimitUsd: 5, apiResetDay: 1 } as AdminSettings };
  const apiUsage: string[] = [];
  let proxy: KeyProxy;
  afterEach(async () => {
    fx?.cleanup();
    await proxy?.stop();
  });

  const setup = async () => {
    key.v = FAKE_KEY;
    settings.v = { apiMonthlyLimitUsd: 5, apiResetDay: 1 } as AdminSettings;
    apiUsage.length = 0;
    proxy = new KeyProxy({ key: () => key.v, log: silentLogger, upstream: "http://127.0.0.1:9" });
    await proxy.start();
    fx = runtimeFixture(({ store }) => {
      svc = new BillingService({ store, settings: { get: () => settings.v }, keys: { key: () => key.v, present: () => key.v !== null } });
      return { billing: svc, apiProxy: proxy, onApiUsage: (u) => void apiUsage.push(u), extraEnv: { ANTHROPIC_API_KEY: "sk-from-the-hub-env", ANTHROPIC_AUTH_TOKEN: "tok-from-the-hub-env", ANTHROPIC_BASE_URL: "http://from-the-hub-env" } };
    });
    return fx;
  };
  const expectProxyEnv = (env: Record<string, string | undefined>) => {
    expect(env.ANTHROPIC_API_KEY).toMatch(PROXY_TOKEN_RE);
    expect(env.ANTHROPIC_BASE_URL).toBe(proxy.baseUrl);
    expect(JSON.stringify(env)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(env)).not.toContain("sk-from-the-hub-env");
  };
  const idle = (id: string, turns: number) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= turns, 3000, `turn ${turns}`);
  const newSession = () => {
    fx.store.ensureUser("alice");
    return fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null }).id;
  };

  it("every process gets a key proxy token (never the key) in its own env, whatever the hub's own env holds", async () => {
    await setup();
    const id = newSession();
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    const env = fx.sdk.last.options.env!;
    expectProxyEnv(env);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(FAKE_KEY);
    // Accounting: the turn counts towards the budget through the proxy's metering (api_requests), not the turn row.
    expect(svc.spentUsd()).toBe(0);
    expect(apiUsage).toEqual(["alice"]);
  });

  it("without a key no process starts: 503 api_unavailable", async () => {
    await setup();
    const id = newSession();
    key.v = null;
    await expect(fx.sessions.send(id, msgBody("hi"))).rejects.toMatchObject({ status: 503, code: "api_unavailable" });
    expect(fx.sdk.queries).toHaveLength(0);
  });

  it("refuses sends over budget (429) and maps the API's credit error to api_limit_reached", async () => {
    await setup();
    const id = newSession();
    fx.sdk.behavior = (q) => {
      const mid = "msg_credit";
      q.init();
      q.assistant(mid, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", { error: "billing_error" });
      q.emitResultWithTotals({ input: 0, output: 0, cost: 0 }, { subtype: "success", is_error: true, result: "Your credit balance is too low to access the Anthropic API." });
    };
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    const notices = fx.bus.ofType("notice").filter((n) => n.code === "api_limit_reached");
    expect(notices).toHaveLength(1);
    expect(fx.bus.ofType("error").filter((e) => e.code === "api_limit_reached" && e.sessionId === id)).toHaveLength(1);
    expect(svc.overBudget()).toBe(true);
    await expect(fx.sessions.send(id, msgBody("again"))).rejects.toMatchObject({ status: 429, code: "api_limit_reached" });
    // The hold ends with the next key or settings change; a bigger budget lets sends through again.
    svc.clearCreditsExhausted();
    await expect(fx.sessions.send(id, msgBody("more"))).resolves.toMatchObject({ state: "accepted" });
  });
});

describe("billing through the hub", () => {
  let h: HubFixture;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.close();
  });
  const keyHub = (key: string | null, extra: Record<string, Record<string, unknown>> = {}) =>
    hubFixture({}, (dir) => {
      writeFileSync(join(dir, "anthropic.env"), key ? `ANTHROPIC_API_KEY=${key}\n` : "");
      return extra;
    });
  const create = (body: Record<string, unknown> = {}, user = "alice") => h.app.inject({ method: "POST", url: "/api/sessions", headers: h.as(user), payload: { kind: "chat", ...body } });

  it("Me.apiAvailable, UsageLimits.api, admin settings (defaults from config, validation, broadcast)", async () => {
    h = await keyHub(FAKE_KEY, { billing: { api_monthly_limit_usd: 120, api_reset_day: 10 } });
    const me = Me.parse((await h.app.inject({ method: "GET", url: "/api/me", headers: h.as("alice") })).json());
    expect(me.apiAvailable).toBe(true);
    expect(me.settings).toMatchObject({ apiMonthlyLimitUsd: 120, apiResetDay: 10, serviceReserveUsd: 2 });
    const limits = UsageLimits.parse((await h.app.inject({ method: "GET", url: "/api/usage/limits", headers: h.as("alice") })).json());
    expect(limits.api).toMatchObject({ spentUsd: 0, limitUsd: 120, percent: 0, severity: "normal" });

    for (const bad of [{ apiResetDay: 29 }, { apiResetDay: 0 }, { apiResetDay: 2.5 }, { apiMonthlyLimitUsd: -1 }, { apiMonthlyLimitUsd: 2_000_000 }, { serviceReserveUsd: -1 }, { serviceReserveUsd: 2_000_000 }]) {
      const r = await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("alice"), payload: { serviceReserveUsd: 0 } })).statusCode).toBe(403);
    const toAll = vi.spyOn(h.hub.ws, "toAll");
    const ok = await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { apiMonthlyLimitUsd: 0, apiResetDay: 28 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ apiMonthlyLimitUsd: 0, apiResetDay: 28 });
    expect(toAll.mock.calls.some(([e]) => e.type === "usage_limits" && e.limits.api?.limitUsd === 0)).toBe(true);
    expect(((await h.app.inject({ method: "GET", url: "/api/me", headers: h.as("alice") })).json() as Me).apiAvailable).toBe(false);
    expect((await create()).json()).toMatchObject({ code: "api_unavailable" });
  });

  it("reads billing.service_reserve_usd from the config; the admin overrides it", async () => {
    h = await keyHub(FAKE_KEY, { billing: { service_reserve_usd: 5 } });
    expect((await h.app.inject({ method: "GET", url: "/api/admin/settings", headers: h.as("admin") })).json()).toMatchObject({ serviceReserveUsd: 5 });
    const ok = await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { serviceReserveUsd: 10 } });
    expect(ok.json()).toMatchObject({ serviceReserveUsd: 10 });
    expect(h.hub.billing.serviceReserveUsd()).toBe(10);
  });

  it("no key: sessions are refused with a clear error, the services are off, UsageLimits.api is null", async () => {
    h = await keyHub(null);
    expect(((await h.app.inject({ method: "GET", url: "/api/me", headers: h.as("alice") })).json() as Me).apiAvailable).toBe(false);
    expect(((await h.app.inject({ method: "GET", url: "/api/usage/limits", headers: h.as("alice") })).json() as UsageLimits).api).toBeNull();
    const r = await create();
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "api_unavailable", error: expect.stringContaining("API key") });
    expect(h.hub.billing.servicesAvailable()).toBe(false);
    // The key appearing later is picked up on reload.
    writeFileSync(join(h.dir, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    h.hub.apiKeys.reload();
    expect((await create()).statusCode).toBe(201);
  });

  it("enforces the budget on send (429), broadcasts usage_limits after metered requests", async () => {
    h = await keyHub(FAKE_KEY);
    const s = (await create()).json() as { id: string };
    const toAll = vi.spyOn(h.hub.ws, "toAll");
    const send = (text: string) => h.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: h.as("alice"), payload: msgBody(text) });
    expect((await send("hi")).statusCode).toBe(200);
    await until(() => h.hub.store.getSession(s.id)!.turnCount === 1 && h.hub.sessions.statusOf(s.id).status === "idle");
    // Spend is what the proxy metered.
    h.hub.store.insertApiRequest({ at: new Date().toISOString(), sessionId: s.id, user: "alice", model: "claude-opus-5-5", input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, webSearchRequests: 0, speed: null, costUsd: 0.5, complete: true });
    h.hub.usageLimits.broadcast();
    expect(toAll.mock.calls.some(([e]) => e.type === "usage_limits" && (e.limits.api?.spentUsd ?? 0) >= 0.5)).toBe(true);

    await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { apiMonthlyLimitUsd: 2.4 } });
    const blocked = await send("more"); // $1.90 left < the $2 service reserve
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "api_limit_reached" });
    await h.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: h.as("admin"), payload: { apiMonthlyLimitUsd: 50 } });
    expect((await send("more")).statusCode).toBe(200);
  });
});

describe("the contract carries only API-key billing", () => {
  const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);

  it("the schemas carry no billing choice, backend, login or plan-limit fields", () => {
    for (const [name, schema] of [["Session", Session], ["CreateSessionBody", CreateSessionBody], ["AdminSettings", AdminSettingsSchema], ["UserPreferencesBody", UserPreferencesBody], ["Me", Me], ["AdminOverview", AdminOverview]] as const) {
      const keys = keysOf(schema as never).join(" ");
      expect(keys, name).not.toMatch(/billing|backend|subscription/i);
    }
    expect(keysOf(UsageLimits as never)).toEqual(["api"]);
    expect(Object.keys(protocol).filter((k) => /subscription|backend|billingsource/i.test(k))).toEqual([]);
    expect(ERROR_CODES.filter((c) => /backend|subscription/.test(c))).toEqual([]);
  });

  it("the usage endpoint serves only API credits (spent / limit / period)", async () => {
    const h = await hubFixture();
    try {
      const body = (await h.app.inject({ method: "GET", url: "/api/usage/limits", headers: h.as("alice") })).json() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["api"]);
      expect(Object.keys(body.api as object).sort()).toEqual(["limitUsd", "percent", "periodStart", "resetsAt", "severity", "spentUsd"]);
      const me = (await h.app.inject({ method: "GET", url: "/api/usage/me?range=today", headers: h.as("alice") })).json() as Record<string, unknown>;
      expect(Object.keys(me).sort()).toEqual(["buckets", "range", "weeklyLimit", "weeklyTokens"]);
      expect((await h.app.inject({ method: "GET", url: "/api/usage/limits/history", headers: h.as("alice") })).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
