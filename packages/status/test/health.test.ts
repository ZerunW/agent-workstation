import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { HealthMonitor, applyOutcome, retryDelayMs } from "../src/health/monitor.js";
import {
  smartctlArgs,
  claudeProcsCheck,
  defaultChecks,
  dnsCheck,
  describeFetchError,
  apiCreditsCheck,
  evaluateApiUsage,
  httpsCheck,
  httpsProxyCheck,
  hubCheck,
  inotifyCheck,
  parsePingLatency,
  parseSmartHealth,
  pingCheck,
  smartCheck,
  tailscaleCheck,
  unitCheck,
} from "../src/health/checks.js";
import type { CheckDef, CheckOutcome } from "../src/health/types.js";
import { Store } from "../src/store.js";
import type { UsageLimits } from "@agent-workstation/protocol";
import { exit, fakeExec, fakeReaders, makeCtx, ok, testConfig } from "./helpers.js";

describe("applyOutcome (transition rule)", () => {
  const at = "2026-10-31T00:00:00.000Z";
  it("the first observation is not a transition", () => {
    const r = applyOutcome(undefined, "hub", { state: "fail", detail: "x" }, at);
    expect(r.event).toBeNull();
    expect(r.next).toEqual({ id: "hub", state: "fail", detail: "x", checkedAt: at, latencyMs: null });
  });
  it("same state again produces no event, even when the detail changes", () => {
    expect(applyOutcome({ state: "ok" }, "hub", { state: "ok", detail: "12 ms" }, at).event).toBeNull();
  });
  it("a change produces an event with from, to and the new detail", () => {
    const r = applyOutcome({ state: "ok" }, "hub", { state: "fail", detail: "connection refused", latencyMs: 5 }, at);
    expect(r.event).toEqual({ at, id: "hub", from: "ok", to: "fail", detail: "connection refused" });
    expect(r.next.latencyMs).toBe(5);
  });
});

describe("HealthMonitor", () => {
  let store: Store;
  let nowMs: number;
  beforeEach(() => {
    store = new Store(":memory:");
    nowMs = Date.parse("2026-10-31T12:00:00Z");
  });

  const mk = (checks: CheckDef[], defaultIntervalS = 60) =>
    new HealthMonitor({ checks, ctx: makeCtx(), store, defaultIntervalS, nowMs: () => nowMs });
  const scripted = (id: string, outcomes: CheckOutcome[], extra: Partial<CheckDef> = {}): CheckDef => {
    let i = 0;
    return { id, label: id.toUpperCase(), run: async () => outcomes[Math.min(i++, outcomes.length - 1)] as CheckOutcome, ...extra };
  };

  it("records an event only when the state changes, newest first, and persists them", async () => {
    const m = mk([scripted("a", [{ state: "ok" }, { state: "ok" }, { state: "fail", detail: "down" }, { state: "fail", detail: "still down" }, { state: "ok", detail: "back" }])]);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await m.runDue(true);
      seen.push(...s.transitions.map((e) => `${e.from}>${e.to}`));
    }
    expect(seen).toEqual(["ok>fail", "fail>ok"]);
    const events = m.events();
    expect(events.map((e) => [e.from, e.to, e.detail])).toEqual([
      ["fail", "ok", "back"],
      ["ok", "fail", "down"],
    ]);
    expect(store.listEvents()).toHaveLength(2);
  });

  it("does not invent a transition at restart: the persisted state is the baseline", async () => {
    const first = mk([scripted("a", [{ state: "ok" }])]);
    await first.runDue(true);
    // new process, same database, the check is now failing
    const second = mk([scripted("a", [{ state: "fail", detail: "boom" }])]);
    expect(second.checks()[0]?.state).toBe("ok"); // shown before its first run
    const s = await second.runDue(true);
    expect(s.transitions).toEqual([expect.objectContaining({ id: "a", from: "ok", to: "fail", detail: "boom" })]);

    const third = mk([scripted("a", [{ state: "fail" }])]);
    expect((await third.runDue(true)).transitions).toEqual([]);
  });

  it("shows never-run checks as unknown / not checked yet", () => {
    const m = mk([scripted("a", [{ state: "ok" }])]);
    expect(m.checks()).toEqual([{ id: "a", label: "A", state: "unknown", detail: "not checked yet", checkedAt: "2026-10-31T12:00:00.000Z", latencyMs: null }]);
  });

  it("runs checks in parallel", async () => {
    const order: string[] = [];
    const slow = (id: string, ms: number): CheckDef => ({
      id,
      label: id,
      run: async () => {
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end-${id}`);
        return { state: "ok" };
      },
    });
    const m = mk([slow("a", 40), slow("b", 10)]);
    await m.runDue(true);
    expect(order).toEqual(["start-a", "start-b", "end-b", "end-a"]);
  });

  it("turns a hung check into unknown after its timeout, and a crashing one into unknown", async () => {
    const hang: CheckDef = { id: "hang", label: "hang", timeoutMs: 30, run: () => new Promise(() => undefined) };
    const crash: CheckDef = { id: "crash", label: "crash", run: async () => Promise.reject(new Error("kaput")) };
    const m = mk([hang, crash]);
    const s = await m.runDue(true);
    expect(s.ran).toEqual(["hang", "crash"]);
    const byId = Object.fromEntries(m.checks().map((c) => [c.id, c]));
    expect(byId.hang).toMatchObject({ state: "unknown", detail: "check timed out after 30 ms" });
    expect(byId.crash).toMatchObject({ state: "unknown", detail: "check crashed: kaput" });
  });

  it("honours per-check intervals", async () => {
    let fast = 0;
    let slow = 0;
    const m = mk(
      [
        { id: "fast", label: "fast", run: async () => (fast++, { state: "ok" }) },
        { id: "slow", label: "slow", intervalS: 600, run: async () => (slow++, { state: "ok" }) },
      ],
      60,
    );
    await m.runDue(); // everything is due on the first tick
    nowMs += 60_000;
    await m.runDue();
    nowMs += 60_000;
    await m.runDue();
    expect([fast, slow]).toEqual([3, 1]);
    nowMs += 480_000; // 10 min since the first slow run
    await m.runDue();
    expect([fast, slow]).toEqual([4, 2]);
  });

  it("is not skipped when the tick fires a hair early", async () => {
    let slow = 0;
    const m = mk([{ id: "slow", label: "slow", intervalS: 120, run: async () => (slow++, { state: "ok" }) }], 60);
    await m.runDue();
    nowMs += 118_000; // 2 s early
    await m.runDue();
    expect(slow).toBe(2);
  });

  describe("retry of checks that cannot reach the hub", () => {
    const down: CheckOutcome = { state: "unknown", detail: "hub unreachable: connection refused", retry: true };
    const up: CheckOutcome = { state: "ok", detail: "fine" };

    it("backs off 30 s, 60 s, 120 s and stops at the normal interval", () => {
      expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, 300_000))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
      expect([1, 2, 3].map((n) => retryDelayMs(n, 90_000))).toEqual([30_000, 60_000, 90_000]);
    });

    it("runs again after 30 s, then 60 s, then 120 s, then returns to the normal schedule once the hub answers", async () => {
      let runs = 0;
      const script = [down, down, down, up, up];
      const m = mk([{ id: "g", label: "G", intervalS: 300, run: async () => script[runs++] as CheckOutcome }], 60);
      const tick = async (afterMs: number) => {
        nowMs += afterMs;
        await m.runDue();
        return runs;
      };
      expect(await tick(0)).toBe(1); // down: next in 30 s
      expect(m.nextRetryInMs()).toBe(30_000);
      expect(await tick(20_000)).toBe(1); // not yet
      expect(await tick(10_000)).toBe(2); // 30 s later (down again): next in 60 s
      expect(m.nextRetryInMs()).toBe(60_000);
      expect(await tick(50_000)).toBe(2);
      expect(await tick(10_000)).toBe(3); // down again: next in 120 s
      expect(m.nextRetryInMs()).toBe(120_000);
      expect(await tick(110_000)).toBe(3);
      expect(await tick(10_000)).toBe(4); // the hub answers: back to the 300 s interval
      expect(m.nextRetryInMs()).toBeNull();
      expect(await tick(60_000)).toBe(4);
      expect(await tick(235_000)).toBe(5);
    });

    it("a check that fails for another reason keeps its normal interval", async () => {
      let runs = 0;
      const m = mk([{ id: "g", label: "G", intervalS: 300, run: async () => (runs++, { state: "unknown", detail: "hub answered HTTP 502" }) }], 60);
      await m.runDue();
      expect(m.nextRetryInMs()).toBeNull();
      nowMs += 60_000;
      await m.runDue();
      expect(runs).toBe(1);
    });

    it("a forced run counts too and the retry is never later than the normal interval", async () => {
      const m = mk([{ id: "g", label: "G", intervalS: 45, run: async () => down }], 60);
      await m.runDue(true);
      expect(m.nextRetryInMs()).toBe(30_000);
      nowMs += 30_000;
      await m.runDue();
      expect(m.nextRetryInMs()).toBe(45_000);
    });
  });

  it("collects metrics reported by checks", async () => {
    const m = mk([scripted("p", [{ state: "ok", metrics: { latency_ping_ms: 12.5 } }])]);
    expect((await m.runDue(true)).metrics).toEqual({ latency_ping_ms: 12.5 });
  });

  it("ignores overlapping runDue calls", async () => {
    let n = 0;
    const m = mk([{ id: "a", label: "a", run: async () => (await new Promise((r) => setTimeout(r, 20)), n++, { state: "ok" }) }]);
    const [a, b] = await Promise.all([m.runDue(true), m.runDue(true)]);
    expect(n).toBe(1);
    expect(a.ran.length + b.ran.length).toBe(1);
  });

  it("ships the checks the status page needs", () => {
    expect(defaultChecks(testConfig()).map((c) => c.id)).toEqual([
      "unit-workstation-hub",
      "hub",
      "unit-workstation-status",
      "unit-ssh",
      "https-proxy",
      "unit-tailscaled",
      "tailscale",
      "dns",
      "internet-ping",
      "internet-https",
      "api-credits",
      "claude-procs",
      "nvme-smart",
      "inotify",
    ]);
  });
});

describe("systemd unit checks", () => {
  const run = (c: CheckDef, table: Parameters<typeof fakeExec>[0]) => c.run(makeCtx({ exec: fakeExec(table) }));
  const required = unitCheck({ id: "u", label: "U", unit: "workstation-hub" });
  const optional = unitCheck({ id: "c", label: "C", unit: "extra-svc", optional: true });

  it("active is ok", async () => {
    expect(await run(required, { "systemctl is-active workstation-hub": ok("active\n") })).toEqual({ state: "ok", detail: "active" });
  });
  it("activating is a warning", async () => {
    expect((await run(required, { "systemctl is-active workstation-hub": exit(3, "activating\n") })).state).toBe("warn");
  });
  it("installed but stopped is a failure", async () => {
    const r = await run(required, { "systemctl is-active workstation-hub": exit(3, "failed\n"), "systemctl show workstation-hub --property=LoadState --value": ok("loaded\n") });
    expect(r).toEqual({ state: "fail", detail: "failed" });
  });
  it("a required unit that does not exist fails; an optional one is unknown 'not installed'", async () => {
    const table = {
      "systemctl is-active workstation-hub": exit(3, "inactive\n"),
      "systemctl show workstation-hub --property=LoadState --value": ok("not-found\n"),
      "systemctl is-active extra-svc": exit(3, "inactive\n"),
      "systemctl show extra-svc --property=LoadState --value": ok("not-found\n"),
    };
    expect(await run(required, table)).toEqual({ state: "fail", detail: "unit not found" });
    expect(await run(optional, table)).toEqual({ state: "unknown", detail: "not installed" });
  });
  it("no systemctl (macOS, containers) is unknown", async () => {
    expect((await run(required, {})).state).toBe("unknown");
    const r = await run(required, { "systemctl is-active workstation-hub": exit(1, "", "System has not been booted with systemd as init system") });
    expect(r).toEqual({ state: "unknown", detail: "systemd not running on this host" });
  });
});

describe("hub /healthz check", () => {
  const clockCtx = (fetchImpl: typeof fetch) => {
    const readers = fakeReaders();
    let t = 0;
    readers.monotonicMs = () => (t += 25);
    return makeCtx({ fetch: fetchImpl, readers });
  };
  it("ok with latency and version", async () => {
    const urls: string[] = [];
    const ctx = clockCtx((async (u: string) => (urls.push(u), new Response(JSON.stringify({ ok: true, version: "0.1.0" })))) as unknown as typeof fetch);
    const r = await hubCheck.run(ctx);
    expect(urls).toEqual(["http://127.0.0.1:9000/healthz"]);
    expect(r).toEqual({ state: "ok", detail: "HTTP 200, v0.1.0", latencyMs: 25 });
  });
  it("falls back to /api/health when /healthz is 404", async () => {
    const urls: string[] = [];
    const ctx = clockCtx((async (u: string) => (urls.push(u), u.endsWith("/healthz") ? new Response("nf", { status: 404 }) : new Response("ok"))) as unknown as typeof fetch);
    expect((await hubCheck.run(ctx)).state).toBe("ok");
    expect(urls).toEqual(["http://127.0.0.1:9000/healthz", "http://127.0.0.1:9000/api/health"]);
  });
  it("HTTP 500 fails; connection refused fails with a readable reason", async () => {
    expect(await hubCheck.run(clockCtx((async () => new Response("x", { status: 500 })) as unknown as typeof fetch))).toMatchObject({ state: "fail", detail: "HTTP 500" });
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    expect(await hubCheck.run(clockCtx(refused))).toEqual({ state: "fail", detail: "connection refused" });
  });
  it("describes common network errors", () => {
    expect(describeFetchError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timed out");
    expect(describeFetchError({ cause: { code: "ENOTFOUND" } })).toBe("DNS lookup failed");
    expect(describeFetchError({ cause: { code: "EHOSTUNREACH" } })).toBe("network unreachable");
  });
});

describe("internet checks", () => {
  it("parses ping output", () => {
    expect(parsePingLatency("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms")).toBe(12.3);
    expect(parsePingLatency("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time<1 ms")).toBe(1);
    expect(parsePingLatency("Request timeout")).toBeNull();
  });
  it("ping ok / warn / fail / not installed", async () => {
    const line = (ms: string) => `PING 1.1.1.1\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=${ms} ms\n`;
    const run = (table: Parameters<typeof fakeExec>[0]) => pingCheck.run(makeCtx({ exec: fakeExec(table) }));
    expect(await run({ "ping -c1 -W2 1.1.1.1": ok(line("12.3")) })).toMatchObject({ state: "ok", latencyMs: 12, metrics: { latency_ping_ms: 12.3 } });
    expect((await run({ "ping -c1 -W2 1.1.1.1": ok(line("450")) })).state).toBe("warn");
    expect(await run({ "ping -c1 -W2 1.1.1.1": exit(1, "PING 1.1.1.1\n--- 0 received, 100% packet loss") })).toMatchObject({ state: "fail", metrics: { latency_ping_ms: null } });
    expect((await run({})).state).toBe("unknown");
  });
  it("HTTPS HEAD: any answer is reachable, 5xx degraded, errors fail", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const mkFetch = (status: number) => (async (u: string, init?: RequestInit) => (calls.push([u, init?.method]), new Response(null, { status }))) as unknown as typeof fetch;
    const readers = fakeReaders();
    let t = 0;
    readers.monotonicMs = () => (t += 100);
    expect(await httpsCheck.run(makeCtx({ fetch: mkFetch(404), readers }))).toMatchObject({ state: "ok", detail: "HTTP 404", latencyMs: 100, metrics: { latency_https_ms: 100 } });
    expect(calls[0]).toEqual(["https://api.anthropic.com", "HEAD"]);
    expect((await httpsCheck.run(makeCtx({ fetch: mkFetch(503), readers }))).state).toBe("warn");
    const failing = (async () => {
      throw Object.assign(new Error("x"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await httpsCheck.run(makeCtx({ fetch: failing, readers }))).toMatchObject({ state: "fail", detail: "timed out" });
  });
});

describe("tailscale and DNS checks (not installed)", () => {
  it("tailscale CLI missing is unknown 'not installed'", async () => {
    expect(await tailscaleCheck.run(makeCtx({ exec: fakeExec({}) }))).toEqual({ state: "unknown", detail: "not installed" });
  });
  it("reads BackendState and Self.Online from `tailscale status --json`", async () => {
    const run = (j: unknown) => tailscaleCheck.run(makeCtx({ exec: fakeExec({ "tailscale status --json": ok(JSON.stringify(j)) }) }));
    expect(await run({ BackendState: "Running", Self: { Online: true, TailscaleIPs: ["100.64.0.7"] } })).toEqual({ state: "ok", detail: "online, 100.64.0.7" });
    expect((await run({ BackendState: "Running", Self: { Online: false } })).state).toBe("fail");
    expect((await run({ BackendState: "NeedsLogin" })).state).toBe("fail");
    expect((await run({ BackendState: "Starting" })).state).toBe("warn");
    const down = await tailscaleCheck.run(makeCtx({ exec: fakeExec({ "tailscale status --json": exit(1, "", "failed to connect to local tailscaled") }) }));
    expect(down).toEqual({ state: "fail", detail: "failed to connect to local tailscaled" });
  });
  it("DNS check is unknown without a DNS name or without tailscale0", async () => {
    expect((await dnsCheck.run(makeCtx())).state).toBe("unknown");
    const cfg = testConfig({ server: { public_url: "https://workstation.example.com" } });
    expect(await dnsCheck.run(makeCtx({ config: cfg }))).toEqual({ state: "unknown", detail: "tailscale not installed or down (no tailscale0)" });
  });
  it("DNS check compares the resolved address with the tailscale IP", async () => {
    const cfg = testConfig({ server: { public_url: "https://workstation.example.com" } });
    const readers = fakeReaders({ interfaces: { tailscale0: ["100.64.0.7"] } });
    const good = await dnsCheck.run(makeCtx({ config: cfg, readers, lookupHost: async () => ["100.64.0.7"] }));
    expect(good).toMatchObject({ state: "ok", detail: "workstation.example.com → 100.64.0.7" });
    const bad = await dnsCheck.run(makeCtx({ config: cfg, readers, lookupHost: async () => ["203.0.113.9"] }));
    expect(bad).toMatchObject({ state: "fail", detail: "workstation.example.com → 203.0.113.9, expected 100.64.0.7" });
    const gone = await dnsCheck.run(makeCtx({ config: cfg, readers, lookupHost: async () => Promise.reject(new Error("ENOTFOUND")) }));
    expect(gone).toMatchObject({ state: "fail", detail: "workstation.example.com does not resolve" });
  });
});

describe("hardware and OS checks", () => {
  const passed = "smartctl 7.2\n=== START OF SMART DATA SECTION ===\nSMART overall-health self-assessment test result: PASSED\n";
  it("parses smartctl -H", () => {
    expect(parseSmartHealth(passed)).toEqual({ state: "ok", detail: "SMART overall health: PASSED" });
    expect(parseSmartHealth("SMART overall-health self-assessment test result: FAILED!")?.state).toBe("fail");
    expect(parseSmartHealth("nothing useful")).toBeNull();
  });
  it("smartctl: runs exactly the sudoers command; ok / fail / unknown", async () => {
    const cmd = "sudo -n /usr/sbin/smartctl -j -H -A /dev/nvme0n1";
    const check = smartCheck("nvme0n1");
    const via = fakeExec({ [cmd]: ok(JSON.stringify({ smart_status: { passed: true } })) });
    expect(await check.run(makeCtx({ exec: via }))).toEqual({ state: "ok", detail: "SMART overall health: PASSED" });
    expect(via.calls).toEqual([cmd]);
    const failed = fakeExec({ [cmd]: exit(4, JSON.stringify({ smart_status: { passed: false } })) });
    expect((await check.run(makeCtx({ exec: failed }))).state).toBe("fail");
    const noSudo = fakeExec({ [cmd]: exit(1, "", "sudo: a password is required") });
    expect((await check.run(makeCtx({ exec: noSudo }))).state).toBe("unknown");
    expect((await check.run(makeCtx({ exec: fakeExec({}) }))).state).toBe("unknown");
    const other = fakeExec({});
    await smartCheck("nvme1n1").run(makeCtx({ exec: other }));
    expect(other.calls).toEqual(["sudo -n /usr/sbin/smartctl -j -H -A /dev/nvme1n1"]);
  });
  it("the install script's sudoers text allows that command and nothing broader", () => {
    const script = readFileSync(fileURLToPath(new URL("../../../deploy/install.sh", import.meta.url)), "utf8");
    const render = (t: string) =>
      t
        .replaceAll("$SERVICE_USER", "workstation")
        .replaceAll("$AGENT_USER", "workstation-agent")
        .replaceAll("$WRAPPER", "/opt/agent-workstation/bin/workstation-agent-exec")
        .replaceAll("$SMARTCTL_BIN", "/usr/sbin/smartctl")
        .replaceAll("$NVME_DEVICE", "nvme0n1");
    // The only two places the script writes a sudo rule.
    expect(script.match(/\$SERVICE_USER ALL=/g)).toHaveLength(2);
    const rules = [/echo "(\$SERVICE_USER ALL=\(\$AGENT_USER\) NOPASSWD: \$WRAPPER)"/, /SMARTCTL_RULE="(\$SERVICE_USER [^"]*)"/].map((re) => render(re.exec(script)?.[1] ?? ""));
    expect(rules).toEqual([
      "workstation ALL=(workstation-agent) NOPASSWD: /opt/agent-workstation/bin/workstation-agent-exec",
      "workstation ALL=(root) NOPASSWD: /usr/sbin/smartctl -j -H -A /dev/nvme0n1",
    ]);
    for (const rule of rules) {
      expect(rule).not.toMatch(/[*?]|\bALL\s*$|NOPASSWD:\s*ALL/);
      expect(rule).not.toMatch(/\$/);
    }
    // the check runs exactly the allowed command
    expect(rules[1]?.split("NOPASSWD: ")[1]).toBe(["/usr/sbin/smartctl", ...smartctlArgs("/dev/nvme0n1")].join(" "));
  });
  it("inotify: counts watches against the user limit", async () => {
    const readers = fakeReaders({ files: { "/proc/sys/fs/inotify/max_user_watches": "524288\n" } });
    const exec = (n: number) => fakeExec({ "sh -c": ok(`${n}\n`) });
    const r = await inotifyCheck.run(makeCtx({ readers, exec: exec(12_000) }));
    expect(r.state).toBe("ok");
    expect(r.detail).toContain("12,000 of 524,288 used (2.3%)");
    expect((await inotifyCheck.run(makeCtx({ readers, exec: exec(480_000) }))).state).toBe("warn");
    expect((await inotifyCheck.run(makeCtx({ readers, exec: exec(520_000) }))).state).toBe("fail");
    expect((await inotifyCheck.run(makeCtx({ exec: exec(1) }))).state).toBe("unknown"); // no /proc (macOS)
  });
  describe("agent processes, from the hub's /api/health", () => {
    const health = (extra: Record<string, unknown>) => ({ ok: true, version: "0.1.0", protocolVersion: 1, uptimeS: 5, serverTime: "2026-10-31T12:00:00Z", ...extra });
    const hubFetch = (body: unknown, status = 200) => {
      const urls: string[] = [];
      const f = (async (u: string) => (urls.push(u), new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))) as unknown as typeof fetch;
      return { f, urls };
    };
    it("shows the Claude count and stores it as a metric (never counts command lines)", async () => {
      const hub = hubFetch(health({ processes: { claude: 3 } }));
      const exec = fakeExec({});
      const r = await claudeProcsCheck.run(makeCtx({ fetch: hub.f, exec }));
      expect(r).toEqual({ state: "ok", detail: "Claude 3", metrics: { claude_procs: 3 } });
      expect(hub.urls).toEqual(["http://127.0.0.1:9000/api/health"]);
      expect(exec.calls).toEqual([]);
    });
    it("zero processes is ok", async () => {
      expect(await claudeProcsCheck.run(makeCtx({ fetch: hubFetch(health({ processes: { claude: 0 } })).f }))).toMatchObject({ state: "ok", detail: "Claude 0" });
    });
    it("an older hub without the field, an unreadable answer or an unreachable hub is unknown (only unreachable retries)", async () => {
      expect(await claudeProcsCheck.run(makeCtx({ fetch: hubFetch(health({})).f }))).toEqual({ state: "unknown", detail: "the hub does not report processes" });
      expect(await claudeProcsCheck.run(makeCtx({ fetch: hubFetch("x", 502).f }))).toEqual({ state: "unknown", detail: "hub answered HTTP 502" });
      expect((await claudeProcsCheck.run(makeCtx({ fetch: hubFetch("nope").f }))).detail).toBe("hub returned an unexpected health payload");
      const refused = (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }) as unknown as typeof fetch;
      expect(await claudeProcsCheck.run(makeCtx({ fetch: refused }))).toEqual({ state: "unknown", detail: "hub unreachable: connection refused", retry: true });
    });
  });
});

describe("HTTPS proxy check (nginx or caddy, whichever is installed)", () => {
  const run = (table: Parameters<typeof fakeExec>[0]) => httpsProxyCheck.run(makeCtx({ exec: fakeExec(table) }));
  const missing = (unit: string) => ({
    [`systemctl is-active ${unit}`]: exit(4, "inactive\n"),
    [`systemctl show ${unit} --property=LoadState --value`]: ok("not-found\n"),
  });
  const stopped = (unit: string) => ({
    [`systemctl is-active ${unit}`]: exit(3, "inactive\n"),
    [`systemctl show ${unit} --property=LoadState --value`]: ok("loaded\n"),
  });
  const active = (unit: string) => ({ [`systemctl is-active ${unit}`]: ok("active\n") });

  it("is labelled for nginx and is in the default set instead of a separate proxy unit", () => {
    expect(httpsProxyCheck.label).toBe("HTTPS proxy (nginx)");
    const checks = defaultChecks(testConfig());
    expect(checks.map((c) => c.id)).not.toContain("unit-extra");
    expect(checks.find((c) => c.id === httpsProxyCheck.id)).toBe(httpsProxyCheck);
  });
  it("nginx active is ok", async () => {
    expect(await run({ ...active("nginx"), ...missing("caddy") })).toEqual({ state: "ok", detail: "nginx active" });
  });
  it("nginx installed but stopped fails", async () => {
    expect(await run({ ...stopped("nginx"), ...missing("caddy") })).toEqual({ state: "fail", detail: "nginx inactive" });
  });
  it("only caddy installed: active is ok, stopped fails", async () => {
    expect(await run({ ...missing("nginx"), ...active("caddy") })).toEqual({ state: "ok", detail: "caddy active" });
    expect(await run({ ...missing("nginx"), ...stopped("caddy") })).toEqual({ state: "fail", detail: "caddy inactive" });
  });
  it("a leftover stopped caddy does not hide a running nginx", async () => {
    expect(await run({ ...active("nginx"), ...stopped("caddy") })).toEqual({ state: "ok", detail: "nginx active" });
    expect(await run({ ...stopped("nginx"), ...active("caddy") })).toEqual({ state: "ok", detail: "caddy active" });
  });
  it("neither installed is unknown 'not installed'", async () => {
    expect(await run({ ...missing("nginx"), ...missing("caddy") })).toEqual({ state: "unknown", detail: "not installed" });
  });
  it("no systemd is unknown", async () => {
    expect((await run({})).state).toBe("unknown");
  });
});

describe("API credits check, derived from the hub's usage endpoint", () => {
  const api = (over: Partial<NonNullable<UsageLimits["api"]>> = {}): NonNullable<UsageLimits["api"]> => ({
    spentUsd: 12,
    limitUsd: 100,
    percent: 12,
    periodStart: "2026-12-15T00:00:00Z",
    resetsAt: "2027-01-15T00:00:00Z",
    severity: "normal",
    ...over,
  });
  const withApi = (a: UsageLimits["api"]): UsageLimits => ({ api: a });

  it("is ok below the warning level and says how much is used", () => {
    expect(evaluateApiUsage(withApi(api()))).toEqual({ state: "ok", detail: "$12.00 of $100.00 used (12%)" });
  });

  it("warns at warning severity", () => {
    expect(evaluateApiUsage(withApi(api({ spentUsd: 85, percent: 85, severity: "warning" })))).toEqual({ state: "warn", detail: "$85.00 of $100.00 used (85%)" });
  });

  it("fails at critical severity, and at 100% whatever the severity says", () => {
    expect(evaluateApiUsage(withApi(api({ spentUsd: 97, percent: 97, severity: "critical" })))).toEqual({ state: "fail", detail: "$97.00 of $100.00 used (97%)" });
    expect(evaluateApiUsage(withApi(api({ spentUsd: 100, percent: 100, severity: "normal" })))).toEqual({ state: "fail", detail: "budget used up: $100.00 of $100.00 used (100%)" });
    expect(evaluateApiUsage(withApi(api({ spentUsd: 115, percent: 115, severity: "warning" }))).state).toBe("fail");
  });

  it("works out the percentage itself when the hub sends none; unknown when there is no limit to measure against", () => {
    expect(evaluateApiUsage(withApi(api({ spentUsd: 50, percent: null, severity: "normal" })))).toEqual({ state: "ok", detail: "$50.00 of $100.00 used (50%)" });
    expect(evaluateApiUsage(withApi(api({ spentUsd: 5, limitUsd: 0, percent: null, severity: "unknown" })))).toEqual({ state: "unknown", detail: "$5.00 spent, no limit set" });
  });

  it("is unknown when API billing is not set up (null) or the hub does not report it (absent)", () => {
    expect(evaluateApiUsage(withApi(null))).toEqual({ state: "unknown", detail: "API billing is not set up on the hub" });
    expect(evaluateApiUsage({} as UsageLimits)).toEqual({ state: "unknown", detail: "the hub does not report API credits" });
  });

  const hubSays = (body: unknown, status = 200) => {
    const calls: Array<[string, Record<string, string> | undefined]> = [];
    const f = (async (u: string, init?: RequestInit) => (calls.push([u, init?.headers as Record<string, string>]), new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))) as unknown as typeof fetch;
    return { f, calls };
  };

  it("reads GET /api/usage/limits as the configured hub user and never shells out", async () => {
    const hub = hubSays(withApi(api()));
    const exec = fakeExec({});
    const r = await apiCreditsCheck.run(makeCtx({ fetch: hub.f, exec, config: testConfig({ status: { hub_user: "alice" } }) }));
    expect(r).toEqual({ state: "ok", detail: "$12.00 of $100.00 used (12%)" });
    expect(hub.calls[0]?.[0]).toBe("http://127.0.0.1:9000/api/usage/limits");
    expect(hub.calls[0]?.[1]).toMatchObject({ "X-Workstation-User": "alice" });
    expect(exec.calls).toEqual([]);
  });

  it("maps warning / critical / null through the endpoint", async () => {
    expect((await apiCreditsCheck.run(makeCtx({ fetch: hubSays(withApi(api({ severity: "warning", percent: 82 }))).f }))).state).toBe("warn");
    expect((await apiCreditsCheck.run(makeCtx({ fetch: hubSays(withApi(api({ severity: "critical", percent: 96 }))).f }))).state).toBe("fail");
    expect((await apiCreditsCheck.run(makeCtx({ fetch: hubSays(withApi(null)).f }))).state).toBe("unknown");
  });

  it("is unknown (not failing) when the hub is down, answers an error or sends garbage: the hub check owns those", async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    expect(await apiCreditsCheck.run(makeCtx({ fetch: refused }))).toEqual({ state: "unknown", detail: "hub unreachable: connection refused", retry: true });
    expect(await apiCreditsCheck.run(makeCtx({ fetch: hubSays("x", 502).f }))).toEqual({ state: "unknown", detail: "hub answered HTTP 502" });
    expect(await apiCreditsCheck.run(makeCtx({ fetch: hubSays("not json").f }))).toEqual({ state: "unknown", detail: "hub returned an unexpected usage payload" });
    expect(await apiCreditsCheck.run(makeCtx({ fetch: hubSays({ api: "nope" }).f }))).toEqual({ state: "unknown", detail: "hub returned an unexpected usage payload" });
  });
});
