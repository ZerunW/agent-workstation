/** The status API's origin policy: this server's Tailscale name and addresses from `tailscale status --json`. */
import { describe, expect, it } from "vitest";
import { normalizedPath, normalizeOrigin, OriginPolicy, tailscaleSelfFromExec } from "../src/origin.js";
import { enoent, exit, fakeExec, ok, testConfig } from "./helpers.js";

const STATUS = JSON.stringify({ Self: { DNSName: "Workstation.Tailnet.ts.net.", TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"] } });

describe("tailscaleSelfFromExec", () => {
  it("reads the name (lower case, no trailing dot) and the addresses", async () => {
    const exec = fakeExec({ "tailscale status --json --peers=false": ok(STATUS) });
    expect(await tailscaleSelfFromExec(exec)()).toEqual({ dnsName: "workstation.tailnet.ts.net", ips: ["100.64.0.9", "fd7a:115c:a1e0::9"] });
  });

  it("rejects when tailscale is missing or fails, and is null without a Self", async () => {
    await expect(tailscaleSelfFromExec(fakeExec({ "tailscale status --json --peers=false": enoent() }))()).rejects.toThrow();
    await expect(tailscaleSelfFromExec(fakeExec({ "tailscale status --json --peers=false": exit(1) }))()).rejects.toThrow();
    expect(await tailscaleSelfFromExec(fakeExec({ "tailscale status --json --peers=false": ok("{}") }))()).toBeNull();
  });
});

describe("OriginPolicy", () => {
  it("caches the answer and retries soon after a failure", async () => {
    let calls = 0;
    let now = 1_000_000;
    let fail = true;
    const p = new OriginPolicy(
      testConfig(),
      async () => {
        calls++;
        if (fail) throw new Error("down");
        return { dnsName: "w.tailnet.ts.net", ips: [] };
      },
      undefined,
      () => now,
    );
    expect(await p.allowed("https://w.tailnet.ts.net")).toBe(false);
    expect(await p.allowed("https://w.tailnet.ts.net")).toBe(false);
    expect(calls).toBe(1);
    fail = false;
    now += 16_000;
    expect(await p.allowed("https://w.tailnet.ts.net")).toBe(true);
    now += 60_000;
    expect(await p.allowed("https://w.tailnet.ts.net")).toBe(true);
    expect(calls).toBe(2);
    expect(await p.allowed("https://w.tailnet.ts.net.evil.example")).toBe(false);
  });

  it("normalizes origins and paths", () => {
    expect(normalizeOrigin("https://Example.com:443/x")).toBe("https://example.com");
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizedPath("//status/./%61pi/x/../metrics?x=1")).toBe("/status/api/metrics");
    expect(normalizedPath("/%zz")).toBeNull();
  });
});
