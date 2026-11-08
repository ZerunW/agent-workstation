import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { Pricing, PricingService, pricingTable } from "../src/pricing.js";
import { canonicalUsageModel, modelDisplayName } from "../src/sessions/models.js";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
const T = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({ input, output, cacheRead, cacheCreate });

describe("pricing estimates", () => {
  it("switches a model's prices at local midnight of a period's start", () => {
    const p = new Pricing({
      "claude-test-1": [
        { from: null, input: 1, output: 5, cacheReadFactor: 0.25 },
        { from: "2027-01-01", input: 2, output: 10, cacheReadFactor: 0.25 },
      ],
    });
    const before = local(2026, 12, 31, 23, 59, 59);
    const after = local(2027, 1, 1, 0, 0, 0);
    expect(p.rateAt("claude-test-1", before)).toMatchObject({ input: 1, output: 5, cacheReadFactor: 0.25 });
    expect(p.rateAt("claude-test-1", after)).toMatchObject({ input: 2, output: 10 });
    expect(p.rateAt("claude-test-1", "2020-01-01T00:00:00Z")).toMatchObject({ input: 1 }); // before every dated period
    // 1M input + 1M output; cache reads at 25 % of the input price; cache creation as input.
    expect(p.cost("claude-test-1", T(1_000_000, 1_000_000), before)).toBeCloseTo(6, 9);
    expect(p.cost("claude-test-1", T(1_000_000, 1_000_000), after)).toBeCloseTo(12, 9);
    expect(p.cost("claude-test-1", T(0, 0, 1_000_000), before)).toBeCloseTo(0.25, 9);
    expect(p.cost("other-model", T(10, 10), after)).toBeNull(); // not priced, not Claude
  });

  it("Claude list prices: per model, cache reads, 5m / 1h cache writes, fast mode, web search", () => {
    const p = new Pricing();
    const M = 1_000_000;
    const at = local(2026, 10, 31);
    const rows: [string, number, number, number][] = [
      ["claude-fable-5-1", 10, 50, 0.25],
      ["claude-fable-5", 10, 50, 1],
      ["claude-opus-5-5", 4, 20, 0.2],
      ["claude-opus-5", 5, 25, 0.5],
      ["claude-opus-4-8", 5, 25, 0.5],
      ["claude-opus-4-7", 5, 25, 0.5],
      ["claude-opus-4-6", 5, 25, 0.5],
      ["claude-sonnet-5-5", 2, 10, 0.2],
      ["claude-sonnet-5", 2, 10, 0.2],
      ["claude-sonnet-4-6", 3, 15, 0.3],
      ["claude-haiku-5-5", 0.1, 0.5, 0.01],
      ["claude-haiku-4-5", 1, 5, 0.1],
    ];
    // 50K tokens per class (below Haiku 5.5's long-prompt tier).
    const N = 50_000;
    for (const [model, input, output, read] of rows) {
      expect(p.cost(model, T(N, 0), at), model).toBeCloseTo((input * N) / M, 12);
      expect(p.cost(model, T(0, N), at), model).toBeCloseTo((output * N) / M, 12);
      expect(p.cost(model, T(0, 0, N), at), model).toBeCloseTo((read * N) / M, 12);
    }
    // Cache writes: 1.25× (5 minutes) and 2× (1 hour) the input price; Haiku 5.5 kept below its tier.
    expect(p.cost("claude-sonnet-4-6", T(0, 0, 0, M), at)).toBeCloseTo(3.75, 9);
    expect(p.cost("claude-sonnet-4-6", { ...T(0, 0), cacheCreate1h: M }, at)).toBeCloseTo(6, 9);
    expect(p.cost("claude-haiku-5-5", { ...T(0, 0, 0, 40_000), cacheCreate1h: 40_000 }, at)).toBeCloseTo((40_000 * 0.125 + 40_000 * 0.2) / M, 12);
    // Fast mode on Opus 5.5: 2× ($8 / $40); other models ignore it. Web search: $10 per 1,000.
    expect(p.cost("claude-opus-5-5", { ...T(M, M), speed: "fast" }, at)).toBeCloseTo(48, 9);
    expect(p.cost("claude-opus-5", { ...T(M, M), speed: "fast" }, at)).toBeCloseTo(30, 9);
    expect(p.cost("claude-opus-5-5", { ...T(0, 0), webSearchRequests: 1000 }, at)).toBeCloseTo(10, 9);
  });

  it("matches dated / suffixed ids by prefix, longest first; never a further version", () => {
    const p = new Pricing();
    expect(p.entryFor("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(p.entryFor("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(p.entryFor("claude-opus-5-5")).toBe("claude-opus-5-5"); // not claude-opus-5
    expect(p.entryFor("claude-fable-5-1-20261001")).toBe("claude-fable-5-1");
    expect(p.entryFor("claude-fable-5-20260601")).toBe("claude-fable-5");
    expect(p.entryFor("claude-sonnet-5-20260101")).toBe("claude-sonnet-5");
    expect(p.entryFor("claude-opus-5-6")).toBeNull(); // another version
    expect(p.entryFor("claude-opus-50")).toBeNull();
    expect(p.entryFor("other-vendor-model-1")).toBeNull();
  });

  it("Haiku 5.5: a request with more than 100K input + cache tokens is billed at the long-prompt prices", () => {
    const p = new Pricing();
    const at = local(2026, 10, 31);
    const M = 1_000_000;
    // Exactly 100K: base prices.
    expect(p.cost("claude-haiku-5-5", { input: 60_000, cacheRead: 40_000, cacheCreate: 0, output: 1000 }, at)).toBeCloseTo((60_000 * 0.1 + 40_000 * 0.01 + 1000 * 0.5) / M, 12);
    // One token more (cache writes count too): every class at the tier price (0.50 / 2.50 / 0.05).
    expect(p.cost("claude-haiku-5-5", { input: 60_000, cacheRead: 40_000, cacheCreate: 1, output: 1000 }, at)).toBeCloseTo((60_000 * 0.5 + 40_000 * 0.05 + 1 * 0.5 * 1.25 + 1000 * 2.5) / M, 12);
    // A turn row (a sum of requests) stays at the base prices.
    expect(p.cost("claude-haiku-5-5", T(M, 0), at, { aggregate: true })).toBeCloseTo(0.1, 9);
  });

  it("an unknown Claude model is priced like the most expensive family, with one warning per model", () => {
    const warnings: unknown[] = [];
    const svc = new PricingService(pricingTable(undefined), { listPricingOverrides: () => [] }, { warn: (obj) => void warnings.push(obj) });
    const at = local(2026, 10, 31);
    expect(svc.cost("claude-mystery-9", T(1_000_000, 1_000_000), at)).toBeCloseTo(60, 9); // Fable 10 + 50
    expect(svc.cost("claude-mystery-9", T(1, 0), at)).toBeGreaterThan(0);
    expect(svc.cost("mystery", T(1_000_000, 0), at)).toBeNull();
    expect(svc.cost("mystery", T(1_000_000, 0), at, { fallback: true })).toBeCloseTo(10, 9);
    expect(warnings).toEqual([{ model: "claude-mystery-9" }, { model: "mystery" }]);
  });

  it("reads Claude cache prices and check_time from [pricing]", () => {
    const cfg = parseConfig({ pricing: { check_time: "05:15", "claude-sonnet-5-5": [{ input_per_mtok: 3, output_per_mtok: 12, cache_read_per_mtok: 0.3, cache_write_1h_factor: 3 }] } }, null, {});
    expect(cfg.pricingCheckTime).toBe("05:15");
    const p = new Pricing(cfg.pricing);
    const at = local(2026, 10, 31);
    expect(p.cost("claude-sonnet-5-5", T(0, 0, 1_000_000), at)).toBeCloseTo(0.3, 9);
    expect(p.cost("claude-sonnet-5-5", T(0, 0, 0, 1_000_000), at)).toBeCloseTo(3.75, 9); // 5m default 1.25×
    expect(p.cost("claude-sonnet-5-5", { ...T(0, 0), cacheCreate1h: 1_000_000 }, at)).toBeCloseTo(9, 9);
    expect(p.cost("claude-opus-5-5", T(1_000_000, 0), at)).toBeCloseTo(4, 9); // built-ins kept
    expect(parseConfig({}, null, {}).pricingCheckTime).toBe("04:30");
    // The example config's [pricing] section parses ([pricing] check_time next to [[pricing."<model>"]] periods).
    const example = parseConfig(readFileSync(fileURLToPath(new URL("../../../config/workstation.example.toml", import.meta.url)), "utf8"), null, {});
    expect(example.pricingCheckTime).toBe("04:30");
    expect(new Pricing(example.pricing).rateAt("claude-opus-5-5", local(2027, 6, 1))).toMatchObject({ input: 4, output: 20 });
    expect(() => parseConfig({ pricing: { check_time: "4:30pm" } }, null, {})).toThrow();
  });

  it("reads [pricing] from the config, replacing a model's built-in periods", () => {
    const cfg = parseConfig(
      { pricing: { "claude-sonnet-5-5": [{ input_per_mtok: 1, output_per_mtok: 2 }, { from: "2026-11-15", input_per_mtok: 3, output_per_mtok: 4, cache_read_factor: 0.1 }], "other-model": [{ input_per_mtok: 5, output_per_mtok: 6 }] } },
      null,
      {},
    );
    const p = new Pricing(cfg.pricing);
    expect(p.rateAt("claude-sonnet-5-5", local(2026, 11, 14))).toEqual({ from: null, input: 1, output: 2, cacheReadFactor: 0.25 });
    expect(p.rateAt("claude-sonnet-5-5", local(2027, 6, 1))).toEqual({ from: "2026-11-15", input: 3, output: 4, cacheReadFactor: 0.1 });
    expect(p.rateAt("other-model", local(2027, 6, 1))).toMatchObject({ input: 5 });
    expect(new Pricing(parseConfig({}, null, {}).pricing).rateAt("claude-sonnet-5-5", local(2027, 6, 1))).toMatchObject({ input: 2, output: 10 });
    expect(() => parseConfig({ pricing: { x: [{ input_per_mtok: -1, output_per_mtok: 1 }] } }, null, {})).toThrow();
  });

  it("canonical usage model ids and display names", () => {
    expect(canonicalUsageModel("claude-opus-5-5", "high")).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(canonicalUsageModel("claude-opus-5-5")).toEqual({ model: "claude-opus-5-5", effort: null });
    const catalog = [{ value: "opus", displayName: "Opus 5.5" }, { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5 (catalog)" }];
    expect(modelDisplayName("opus", catalog)).toBe("Opus 5.5");
    expect(modelDisplayName("claude-haiku-4-5-20251001", catalog)).toBe("Haiku 4.5 (catalog)");
    expect(modelDisplayName("claude-opus-5-5[1m]", catalog)).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-5-20260101")).toBe("Sonnet 5");
    expect(modelDisplayName("fake-model")).toBe("fake-model");
  });
});

describe("usage rows", () => {
  let store: Store | null = null;
  afterEach(() => store?.close());

  it("estimates a turn's cost at the row's time when none was reported, and keeps reported costs", () => {
    store = new Store(":memory:");
    store.ensureUser("alice");
    store.insertSession({ id: "c", user: "alice", kind: "code", title: "C", cwd: "", model: "opus", permissionMode: "default", effort: "high" });
    store.setPricing(new Pricing({ "claude-test-1": [{ from: null, input: 1, output: 5, cacheReadFactor: 0.25 }, { from: "2027-01-01", input: 2, output: 10, cacheReadFactor: 0.25 }] }));
    const turn = (at: Date, costUsd: number, effort: string | null = null) =>
      store!.insertTurn({ sessionId: "c", user: "alice", kind: "code", model: "claude-test-1", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd, durationMs: 1, at: at.toISOString(), effort });
    expect(turn(local(2026, 12, 31, 12), 0)).toBeCloseTo(1, 9); // 2026 price
    expect(turn(local(2027, 1, 2, 12), 0)).toBeCloseTo(2, 9); // 2027 price
    expect(turn(local(2027, 3, 1), 0.25, "max")).toBe(0.25); // the reported figure wins
    expect(store.db.prepare("SELECT model, effort, cost_usd FROM turns ORDER BY id").all()).toEqual([
      { model: "claude-test-1", effort: null, cost_usd: 1 },
      { model: "claude-test-1", effort: null, cost_usd: 2 },
      { model: "claude-test-1", effort: "max", cost_usd: 0.25 },
    ]);
  });
});

describe("usage endpoints", () => {
  let h: HubFixture;
  afterEach(async () => {
    await h?.close();
  });

  it("usage buckets carry display names and estimated costs, per model", async () => {
    h = await hubFixture();
    h.hub.store.ensureUser("alice");
    const now = new Date().toISOString();
    const turn = (model: string, costUsd = 0) =>
      h.hub.store.insertTurn({ sessionId: "s", user: "alice", kind: "chat", model, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd, durationMs: 1, at: now });
    turn("claude-opus-5-5", 0.02);
    turn("claude-opus-5-5", 0.03);
    turn("claude-sonnet-5-5");
    const r = (await h.app.inject({ method: "GET", url: "/api/usage/me?range=today", headers: h.as("alice") })).json() as {
      buckets: { model: string; displayName: string; inputTokens: number; costUsd: number; turns: number }[];
    };
    const of = (model: string) => r.buckets.filter((b) => b.model === model);
    expect(of("claude-opus-5-5")).toHaveLength(1);
    expect(of("claude-opus-5-5")[0]).toMatchObject({ displayName: "Opus 5.5", inputTokens: 2000, turns: 2 });
    expect(of("claude-opus-5-5")[0]!.costUsd).toBeCloseTo(0.05, 9);
    expect(of("claude-sonnet-5-5")[0]).toMatchObject({ displayName: "Sonnet 5.5" });
    expect(of("claude-sonnet-5-5")[0]!.costUsd).toBeGreaterThan(0);
    expect(r.buckets.every((b) => !("billing" in b) && !("backend" in b))).toBe(true);
    const admin = (await h.app.inject({ method: "GET", url: "/api/admin/usage?range=today", headers: h.as("admin") })).json() as { buckets: { model: string; displayName: string }[] };
    expect(admin.buckets.find((b) => b.model === "claude-opus-5-5")?.displayName).toBe("Opus 5.5");
  });
});
