import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_UA, BandwidthProbe, DOWN_URL, MANUAL_MIN_INTERVAL_MS, UP_URL, mbps, type ProbeState } from "../src/probe.js";
import { Store } from "../src/store.js";

interface Call {
  url: string;
  method: string;
  ua: string | null;
  bodyBytes: number | null;
}

let store: Store;
let wall: number;

beforeEach(() => {
  store = new Store(":memory:");
  wall = Date.parse("2026-10-31T12:00:00Z");
});

function harness(opts: { downStatus?: number; upStatus?: number; clock?: number[]; downBytes?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body as Uint8Array | undefined;
    calls.push({ url, method: init?.method ?? "GET", ua: headers.get("user-agent"), bodyBytes: body ? body.byteLength : null });
    if (url.startsWith("https://speed.cloudflare.com/__down")) {
      return opts.downStatus && opts.downStatus !== 200 ? new Response("forbidden", { status: opts.downStatus }) : new Response(new Uint8Array(opts.downBytes ?? 2_000_000));
    }
    return new Response("ok", { status: opts.upStatus ?? 200 });
  }) as unknown as typeof fetch;
  const ticks = [...(opts.clock ?? [0, 100, 1100, 1200, 2200])];
  const changes: ProbeState[] = [];
  const probe = new BandwidthProbe({
    store,
    fetch: fetchImpl,
    clock: () => ticks.shift() ?? 0,
    now: () => wall,
    uploadBytes: 1_000_000,
    onChange: (s) => changes.push(s),
  });
  return { probe, calls, changes };
}

const metricRows = () => store.db.prepare("SELECT name, v FROM samples_raw WHERE name LIKE 'probe_%' ORDER BY name").all() as Array<{ name: string; v: number }>;

describe("bandwidth probe", () => {
  it("downloads and uploads against the Cloudflare endpoints with a browser-like User-Agent", async () => {
    const { probe, calls } = harness();
    const r = await probe.run("manual");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", DOWN_URL],
      ["POST", UP_URL],
    ]);
    expect(DOWN_URL).toBe("https://speed.cloudflare.com/__down?bytes=20000000");
    expect(calls[0]?.ua).toBe(BROWSER_UA);
    expect(calls[1]?.ua).toBe(BROWSER_UA);
    expect(BROWSER_UA).toMatch(/Mozilla\/5\.0 .*Chrome/);
    expect(calls[1]?.bodyBytes).toBe(1_000_000);
    expect(r?.error).toBeNull();
  });

  it("computes Mbps from the bytes moved and the measured time", async () => {
    // download: 2 MB between first byte (100 ms) and the end (1100 ms) = 16 Mbps
    // upload: 1 MB in 1000 ms = 8 Mbps
    const { probe } = harness();
    const r = await probe.run("manual");
    expect(r?.downMbps).toBeCloseTo(16, 6);
    expect(r?.upMbps).toBeCloseTo(8, 6);
    expect(mbps(20_000_000, 1000)).toBe(160);
  });

  it("records the results as probe_down_mbps and probe_up_mbps metrics", async () => {
    const { probe } = harness();
    await probe.run("timer");
    expect(metricRows()).toEqual([
      { name: "probe_down_mbps", v: 16 },
      { name: "probe_up_mbps", v: 8 },
    ]);
    expect(store.getKvNumber("probe_last_at")).toBe(wall);
  });

  it("an HTTP 403 on download is reported, the upload still runs", async () => {
    const { probe, calls } = harness({ downStatus: 403, clock: [0, 100, 1100] });
    const r = await probe.run("manual");
    expect(r?.downMbps).toBeNull();
    expect(r?.upMbps).toBeCloseTo(8, 6);
    expect(r?.error).toBe("download: HTTP 403");
    expect(calls).toHaveLength(2);
    expect(metricRows().map((m) => m.name)).toEqual(["probe_up_mbps"]);
  });

  it("runs are serialised and publish running / finished states", async () => {
    const { probe, changes } = harness();
    const first = probe.run("manual");
    expect(probe.state().running).toBe(true);
    expect(await probe.run("timer")).toBeNull();
    await first;
    expect(changes.map((s) => s.running)).toEqual([true, false]);
    expect(probe.state().last?.downMbps).toBeCloseTo(16, 6);
  });

  it("limits manual runs to one per minute", async () => {
    const { probe } = harness({ clock: [0, 100, 1100, 1200, 2200, 0, 100, 1100, 1200, 2200] });
    expect(probe.canRunManual()).toEqual({ ok: true });
    expect(probe.requestManual()).toEqual({ ok: true });
    expect(probe.requestManual()).toMatchObject({ ok: false, reason: "running" });
    await vi.waitFor(() => expect(probe.state().running).toBe(false));

    wall += 20_000;
    expect(probe.requestManual()).toEqual({ ok: false, reason: "rate_limited", retryAfterS: 40 });
    expect(probe.state().nextManualAt).toBe(wall - 20_000 + MANUAL_MIN_INTERVAL_MS);

    wall += 41_000;
    expect(probe.requestManual()).toEqual({ ok: true });
    await vi.waitFor(() => expect(probe.state().running).toBe(false));
  });

  it("scheduled runs are not subject to the manual limit", async () => {
    const { probe } = harness({ clock: [0, 100, 1100, 1200, 2200, 0, 100, 1100, 1200, 2200] });
    probe.requestManual();
    await vi.waitFor(() => expect(probe.state().running).toBe(false));
    expect(await probe.run("timer")).not.toBeNull();
  });
});
