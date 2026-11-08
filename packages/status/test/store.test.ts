import { beforeEach, describe, expect, it } from "vitest";
import { gridBounds, selectResolution } from "../src/ranges.js";
import { Store, roundValue } from "../src/store.js";

const T0 = 1_700_000_000 - (1_700_000_000 % 3600); // an exact hour boundary
let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table} ORDER BY t, name`).all() as Array<Record<string, number | null | string>>;

describe("insert and query (raw tier)", () => {
  it("returns a gap-filled grid that all series share, with explicit nulls", () => {
    store.insertSamples(T0 + 3560, { cpu_total_pct: 10, "net_tailscale0_rx_bps": null });
    store.insertSamples(T0 + 3570, { cpu_total_pct: 20, "net_tailscale0_rx_bps": null });
    store.insertSamples(T0 + 3590, { cpu_total_pct: 40, "net_tailscale0_rx_bps": null });
    const now = T0 + 3600;
    const res = selectResolution("1h", 10);
    const series = store.queryMetrics(res, now);

    expect(series.map((s) => s.name)).toEqual(["cpu_total_pct", "net_tailscale0_rx_bps"]);
    const cpu = series[0]!;
    const { first, last, count } = gridBounds(res, now);
    expect(cpu.points).toHaveLength(count);
    expect(cpu.points[0]?.t).toBe(first);
    expect(cpu.points.at(-1)?.t).toBe(last);
    const at = (t: number) => cpu.points.find((p) => p.t === t)?.v;
    expect(at(T0 + 3560)).toBe(10);
    expect(at(T0 + 3570)).toBe(20);
    expect(at(T0 + 3580)).toBeNull(); // no sample: hole, not zero
    expect(at(T0 + 3590)).toBe(40);
    // the missing interface is a series made only of nulls
    expect(series[1]?.points.every((p) => p.v === null)).toBe(true);
    expect(series[1]?.points).toHaveLength(count);
  });

  it("rounds values to 2 decimals and stores non-finite numbers as NULL", () => {
    store.insertSamples(T0, { a: 1.23456, b: Number.NaN, c: Number.POSITIVE_INFINITY });
    const r = Object.fromEntries(rows("samples_raw").map((x) => [x.name as string, x.v]));
    expect(r).toEqual({ a: 1.23, b: null, c: null });
    expect(roundValue(undefined)).toBeNull();
  });

  it("sorts series names naturally", () => {
    store.insertSamples(T0 + 10, { cpu_core10_pct: 1, cpu_core2_pct: 2, cpu_core1_pct: 3 });
    const names = store.queryMetrics(selectResolution("1h", 10), T0 + 20).map((s) => s.name);
    expect(names).toEqual(["cpu_core1_pct", "cpu_core2_pct", "cpu_core10_pct"]);
  });
});

describe("rollup to 1 minute", () => {
  it("aggregates only completed minutes, with avg/min/max/n", () => {
    // minute 0: 10, 20, 30 ; minute 1: 50 (still open at "now")
    store.insertSamples(T0 + 0, { m: 10 });
    store.insertSamples(T0 + 10, { m: 20 });
    store.insertSamples(T0 + 20, { m: 30 });
    store.insertSamples(T0 + 60, { m: 50 });
    const r = store.rollup(T0 + 75);
    expect(r.minutes).toBe(1);
    expect(rows("samples_1m")).toEqual([{ t: T0, name: "m", v: 20, vmin: 10, vmax: 30, n: 3 }]);
  });

  it("is idempotent and picks up the next minute incrementally", () => {
    store.insertSamples(T0 + 0, { m: 10 });
    store.insertSamples(T0 + 60, { m: 50 });
    store.rollup(T0 + 75);
    store.rollup(T0 + 76);
    expect(rows("samples_1m")).toHaveLength(1);
    store.rollup(T0 + 130); // minute 1 is now complete
    expect(rows("samples_1m").map((r) => [r.t, r.v])).toEqual([
      [T0, 10],
      [T0 + 60, 50],
    ]);
    expect(store.getKvNumber("rollup_1m_upto")).toBe(T0 + 120);
  });

  it("keeps all-null buckets as NULL with n = 0 (a gap, not a zero)", () => {
    store.insertSamples(T0 + 0, { iface: null, cpu: 1 });
    store.insertSamples(T0 + 10, { iface: null, cpu: 3 });
    store.rollup(T0 + 61);
    const byName = Object.fromEntries(rows("samples_1m").map((r) => [r.name as string, r]));
    expect(byName.iface).toMatchObject({ v: null, n: 0 });
    expect(byName.cpu).toMatchObject({ v: 2, n: 2 });
  });

  it("averages only the non-null samples of a bucket", () => {
    store.insertSamples(T0 + 0, { m: 10 });
    store.insertSamples(T0 + 10, { m: null });
    store.insertSamples(T0 + 20, { m: 30 });
    store.rollup(T0 + 61);
    expect(rows("samples_1m")[0]).toMatchObject({ v: 20, n: 2, vmin: 10, vmax: 30 });
  });

  it("does nothing on an empty database", () => {
    expect(store.rollup(T0)).toEqual({ minutes: 0, hours: 0 });
  });

  it("catches up over a long gap in chunks", () => {
    store.insertSamples(T0, { m: 1 });
    store.insertSamples(T0 + 2 * 86400, { m: 3 });
    const r = store.rollup(T0 + 2 * 86400 + 120);
    expect(r.minutes).toBe(2 * 1440 + 2);
    const mins = rows("samples_1m").filter((x) => x.v !== null);
    expect(mins.map((x) => x.v)).toEqual([1, 3]);
    expect(store.getKvNumber("rollup_1m_upto")).toBe(T0 + 2 * 86400 + 120);
  });

  it("recovers when the clock went backwards (watermark in the future)", () => {
    store.insertSamples(T0, { m: 1 });
    store.rollup(T0 + 3 * 3600);
    // time jumps back two hours, fresh data arrives
    store.insertSamples(T0 + 3600 + 5, { m: 9 });
    store.rollup(T0 + 3600 + 130);
    expect(store.getKvNumber("rollup_1m_upto")).toBeLessThanOrEqual(T0 + 3600 + 130);
    store.rollup(T0 + 3600 + 190);
    expect(rows("samples_1m").some((r) => r.t === T0 + 3600 && r.v === 9)).toBe(true);
  });
});

describe("rollup to 1 hour", () => {
  it("weights minute averages by their sample counts", () => {
    // minute 0 has six samples of 10, minute 1 has a single sample of 40.
    for (let i = 0; i < 6; i++) store.insertSamples(T0 + i * 10, { m: 10 });
    store.insertSamples(T0 + 60, { m: 40 });
    const r = store.rollup(T0 + 3600 + 5);
    expect(r.hours).toBe(1);
    const hour = rows("samples_1h")[0]!;
    expect(hour.t).toBe(T0);
    expect(hour.v as number).toBeCloseTo((6 * 10 + 40) / 7, 6); // 14.2857, not the naive 25
    expect(hour.vmin).toBe(10);
    expect(hour.vmax).toBe(40);
    expect(hour.n).toBe(7);
  });

  it("only rolls up hours that are complete", () => {
    store.insertSamples(T0 + 10, { m: 10 });
    store.rollup(T0 + 1800);
    expect(rows("samples_1h")).toHaveLength(0);
    store.rollup(T0 + 3600 + 1);
    expect(rows("samples_1h")).toHaveLength(1);
  });
});

describe("queries on rolled-up tiers", () => {
  it("re-buckets the 1-minute tier to the requested step with weighted averages", () => {
    // Four minutes at 24h/120 s resolution -> two buckets.
    store.insertSamples(T0 + 0, { m: 10 });
    store.insertSamples(T0 + 60, { m: 30 });
    store.insertSamples(T0 + 120, { m: 50 });
    store.insertSamples(T0 + 180, { m: 70 });
    store.rollup(T0 + 300);
    const res = selectResolution("24h");
    const [m] = store.queryMetrics(res, T0 + 300);
    const v = (t: number) => m?.points.find((p) => p.t === t)?.v;
    expect(v(T0)).toBe(20);
    expect(v(T0 + 120)).toBe(60);
  });

  it("serves 30d from the hourly tier", () => {
    for (let i = 0; i < 6; i++) store.insertSamples(T0 + i * 10, { m: 10 });
    store.insertSamples(T0 + 3600, { m: 100 });
    store.rollup(T0 + 2 * 3600 + 1);
    const [m] = store.queryMetrics(selectResolution("30d"), T0 + 2 * 3600 + 1);
    expect(m?.points.find((p) => p.t === T0)?.v).toBe(10);
    expect(m?.points.find((p) => p.t === T0 + 3600)?.v).toBe(100);
  });
});

describe("retention", () => {
  it("drops raw after 48 h and 1-minute data after 90 d, keeps hourly forever", () => {
    const now = T0 + 200 * 86400;
    store.insertSamples(now - 49 * 3600, { m: 1 }); // old raw
    store.insertSamples(now - 47 * 3600, { m: 2 }); // recent raw
    store.db.prepare("INSERT INTO samples_1m (t, name, v, vmin, vmax, n) VALUES (?, 'm', 1, 1, 1, 6)").run(now - 91 * 86400);
    store.db.prepare("INSERT INTO samples_1m (t, name, v, vmin, vmax, n) VALUES (?, 'm', 2, 2, 2, 6)").run(now - 89 * 86400);
    store.db.prepare("INSERT INTO samples_1h (t, name, v, vmin, vmax, n) VALUES (?, 'm', 3, 3, 3, 360)").run(now - 150 * 86400);
    const r = store.prune(now);
    expect(r).toEqual({ raw: 1, minute: 1 });
    expect(rows("samples_raw").map((x) => x.v)).toEqual([2]);
    expect(rows("samples_1m").map((x) => x.v)).toEqual([2]);
    expect(rows("samples_1h")).toHaveLength(1);
  });
});

describe("events and health state", () => {
  it("lists events newest first and honours the limit", () => {
    for (let i = 0; i < 5; i++) store.recordEvent({ at: `2026-10-31T00:00:0${i}Z`, id: "hub", from: "ok", to: "fail", detail: `n${i}` });
    const list = store.listEvents(3);
    expect(list.map((e) => e.detail)).toEqual(["n4", "n3", "n2"]);
    expect(list[0]).toEqual({ at: "2026-10-31T00:00:04Z", id: "hub", from: "ok", to: "fail", detail: "n4" });
  });

  it("caps the table so it cannot grow without bound", () => {
    for (let i = 0; i < 5050; i++) store.recordEvent({ at: "t", id: "x", from: "ok", to: "fail", detail: String(i) });
    const count = (store.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    expect(count).toBeLessThanOrEqual(5001);
    expect(store.listEvents(1)[0]?.detail).toBe("5049");
  });

  it("persists the last health state per check", () => {
    store.saveHealthState({ id: "hub", state: "ok", detail: "HTTP 200", checkedAt: "2026-10-31T00:00:00Z", latencyMs: 5 });
    store.saveHealthState({ id: "hub", state: "fail", detail: "refused", checkedAt: "2026-10-31T00:01:00Z", latencyMs: null });
    const m = store.loadHealthState();
    expect(m.size).toBe(1);
    expect(m.get("hub")).toEqual({ id: "hub", state: "fail", detail: "refused", checkedAt: "2026-10-31T00:01:00Z", latencyMs: null });
  });
});
