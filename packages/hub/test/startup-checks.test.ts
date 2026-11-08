/** The safe defaults of the configuration and the checks the hub makes before it listens. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultListen, parseConfig } from "../src/config.js";
import { FIREWALL_WATCH_INTERVAL_MS, FirewallWatch, startupChecks } from "../src/startupChecks.js";
import { hubFixture } from "./helpers.js";

const cfg = (obj: Record<string, unknown> = {}) => parseConfig(obj, null, {});

describe("configuration defaults", () => {
  it("are closed: loopback, Tailscale identity, no LAN, no admin by name, no project hooks or MCP servers", () => {
    const c = cfg();
    expect(c.server.host).toBe("127.0.0.1");
    expect(c.auth).toMatchObject({ tailscaleIdentity: true, lanAccess: "deny", adminUsernames: [], adminLogins: [] });
    expect(c.sessions.projectSettings).toBe(false);
  });

  it("listen: sockets on Linux in production, a TCP port everywhere else, unless set", () => {
    expect(defaultListen({ INVOCATION_ID: "abc" }, "linux")).toBe("unix");
    expect(defaultListen({ NODE_ENV: "production" }, "linux")).toBe("unix");
    expect(defaultListen({}, "linux")).toBe("tcp");
    expect(defaultListen({ NODE_ENV: "production" }, "darwin")).toBe("tcp");
    expect(parseConfig({}, null, { INVOCATION_ID: "abc" }).server.listen).toBe(process.platform === "linux" ? "unix" : "tcp");
    expect(parseConfig({ server: { listen: "tcp" } }, null, { INVOCATION_ID: "abc" }).server.listen).toBe("tcp");
    expect(parseConfig({}, null, {}).server).toMatchObject({ socket: "/run/agent-workstation/hub.sock", localSocket: "/run/agent-workstation/hub-local.sock", proxyGroup: "workstation-proxy" });
  });

  it("[sessions] project_settings can be switched on", () => {
    expect(cfg({ sessions: { project_settings: true } }).sessions.projectSettings).toBe(true);
  });
});

describe("startup checks", () => {
  const quiet = { env: {}, firewallActive: async () => true };

  it("refuse to start with Tailscale identity on and no admin login", async () => {
    const r = await startupChecks(cfg(), quiet);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("admin_logins");
    expect((await startupChecks(cfg({ auth: { admin_logins: ["boss@example.com"] } }), quiet)).errors).toEqual([]);
    expect((await startupChecks(cfg({ auth: { tailscale_identity: false } }), quiet)).errors).toEqual([]);
  });

  it("warn when agents run as a separate account and the firewall unit is not active", async () => {
    const c = cfg({ auth: { admin_logins: ["boss@example.com"] }, agents: { run_as: "workstation-agent" } });
    expect((await startupChecks(c, { env: {}, firewallActive: async () => true })).warnings).toEqual([]);
    const w = (await startupChecks(c, { env: {}, firewallActive: async () => false })).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("workstation-agent-firewall");
  });

  it('refuse `listen = "tcp"` in production with run_as set, and only then', async () => {
    const base = { auth: { admin_logins: ["boss@example.com"] } };
    const tcp = cfg({ ...base, server: { listen: "tcp" }, agents: { run_as: "workstation-agent" } });
    for (const env of [{ NODE_ENV: "production" }, { INVOCATION_ID: "abc" }]) {
      expect((await startupChecks(tcp, { ...quiet, env })).errors[0]).toContain('listen = "tcp"');
    }
    expect((await startupChecks(tcp, quiet)).errors).toEqual([]); // development machine
    const unix = cfg({ ...base, server: { listen: "unix" }, agents: { run_as: "workstation-agent" } });
    expect((await startupChecks(unix, { ...quiet, env: { NODE_ENV: "production" } })).errors).toEqual([]);
    expect((await startupChecks(cfg({ ...base, server: { listen: "tcp" } }), { ...quiet, env: { NODE_ENV: "production" } })).errors).toEqual([]); // no run_as
  });

  it("warn about an empty run_as in production (NODE_ENV=production or systemd) only", async () => {
    const c = cfg({ auth: { admin_logins: ["boss@example.com"] } });
    expect((await startupChecks(c, quiet)).warnings).toEqual([]);
    expect((await startupChecks(c, { ...quiet, env: { NODE_ENV: "production" } })).warnings[0]).toContain("run_as");
    expect((await startupChecks(c, { ...quiet, env: { INVOCATION_ID: "abc" } })).warnings[0]).toContain("run_as");
  });
});

describe("firewall watch", () => {
  afterEach(() => vi.useRealTimers());

  const watchWith = (state: { active: boolean }, inactive: string[], active: string[] = []) =>
    new FirewallWatch({ runAs: "workstation-agent", active: async () => state.active, onInactive: (m) => inactive.push(m), onActive: (m) => active.push(m) });

  it("checks every 10 minutes, tells admins on every failed check and once when it is back", async () => {
    vi.useFakeTimers();
    const state = { active: true };
    const inactive: string[] = [];
    const active: string[] = [];
    const w = watchWith(state, inactive, active);
    expect(FIREWALL_WATCH_INTERVAL_MS).toBe(600_000);
    w.start();
    await vi.advanceTimersByTimeAsync(FIREWALL_WATCH_INTERVAL_MS);
    expect(inactive).toEqual([]);
    state.active = false;
    await vi.advanceTimersByTimeAsync(FIREWALL_WATCH_INTERVAL_MS);
    expect(inactive).toHaveLength(1);
    expect(inactive[0]).toContain("workstation-agent-firewall");
    await vi.advanceTimersByTimeAsync(FIREWALL_WATCH_INTERVAL_MS);
    expect(inactive).toHaveLength(2);
    state.active = true;
    await vi.advanceTimersByTimeAsync(FIREWALL_WATCH_INTERVAL_MS);
    expect(inactive).toHaveLength(2);
    expect(active).toHaveLength(1);
    w.stop();
    state.active = false;
    await vi.advanceTimersByTimeAsync(FIREWALL_WATCH_INTERVAL_MS * 2);
    expect(inactive).toHaveLength(2);
  });

  it("a check that throws counts as inactive", async () => {
    const inactive: string[] = [];
    const w = new FirewallWatch({ runAs: "a", active: async () => Promise.reject(new Error("no systemd")), onInactive: (m) => inactive.push(m), onActive: () => undefined });
    await w.check();
    expect(inactive).toHaveLength(1);
  });

  it("the hub only has one when agents run as a separate account", async () => {
    const plain = await hubFixture();
    expect(plain.hub.firewallWatch).toBeNull();
    await plain.close();
    const f = await hubFixture({ agentExec: null, firewallActive: async () => false }, () => ({ agents: { run_as: "workstation-agent" } }));
    expect(f.hub.firewallWatch).not.toBeNull();
    await f.close();
  });
});
