import { describe, expect, it } from "vitest";
import { candidatePaths, hostFromPublicUrl, loadConfig, resolveConfig } from "../src/config.js";

const files = (map: Record<string, string>) => ({
  exists: (p: string) => p in map,
  read: (p: string) => map[p] ?? "",
});

describe("config loading", () => {
  it("falls back to defaults when no file exists", () => {
    const c = loadConfig({ env: {}, cwd: "/work", ...files({}) });
    expect(c.source).toBeNull();
    expect(c).toMatchObject({
      host: "127.0.0.1",
      port: 9100,
      sampleIntervalS: 10,
      healthIntervalS: 60,
      interfaces: ["tailscale0"],
      speedProbeIntervalMin: 60,
      hubUrl: "http://127.0.0.1:9000",
      dataDir: "/var/lib/agent-workstation",
      dbPath: "/var/lib/agent-workstation/status.sqlite",
      usersRoot: "/srv/agent-workstation/users",
      diskWarnPercent: 80,
      diskBlockPercent: 95,
    });
  });

  it("looks at $WORKSTATION_CONFIG, ./config/workstation.toml, /etc/agent-workstation/workstation.toml in that order", () => {
    expect(candidatePaths({ WORKSTATION_CONFIG: "/x/a.toml" }, "/work")).toEqual(["/x/a.toml", "/work/config/workstation.toml", "/etc/agent-workstation/workstation.toml"]);
    expect(candidatePaths({}, "/work")).toEqual(["/work/config/workstation.toml", "/etc/agent-workstation/workstation.toml"]);

    const all = files({ "/work/config/workstation.toml": "[status]\nport = 9200", "/etc/agent-workstation/workstation.toml": "[status]\nport = 9300", "/x/a.toml": "[status]\nport = 9400" });
    expect(loadConfig({ env: { WORKSTATION_CONFIG: "/x/a.toml" }, cwd: "/work", ...all }).port).toBe(9400);
    expect(loadConfig({ env: {}, cwd: "/work", ...all }).port).toBe(9200);
    expect(loadConfig({ env: {}, cwd: "/elsewhere", ...all }).port).toBe(9300);
  });

  it("fails fast when WORKSTATION_CONFIG points at a missing file", () => {
    expect(() => loadConfig({ env: { WORKSTATION_CONFIG: "/nope.toml" }, cwd: "/work", ...files({}) })).toThrow(/does not exist/);
  });

  it("reads the example config shipped with the repo", () => {
    const toml = `
[server]
host = "0.0.0.0"
port = 9000
public_url = "http://100.64.0.1:9000"
[paths]
users_root = "/srv/agent-workstation/users"
data_dir = "/var/lib/agent-workstation"
[auth]
admin_usernames = ["admin"]
[limits]
disk_warn_percent = 80
disk_block_percent = 95
[status]
host = "127.0.0.1"
port = 9100
sample_interval_s = 10
health_interval_s = 60
interfaces = ["eth0", "tailscale0"]
speed_probe_interval_min = 60
`;
    const c = loadConfig({ env: { WORKSTATION_CONFIG: "/c.toml" }, cwd: "/", ...files({ "/c.toml": toml }) });
    expect(c.host).toBe("127.0.0.1");
    expect(resolveConfig({ status: { host: "100.64.0.1" } }).host).toBe("100.64.0.1");
    expect(c.publicUrl).toBe("http://100.64.0.1:9000");
    expect(c.warnings).toEqual([]);
    expect(c.dnsCheckHost).toBeNull(); // public_url is an IP: the DNS check reports "unknown"
  });

  it("reports unparsable and invalid files clearly", () => {
    expect(() => loadConfig({ env: { WORKSTATION_CONFIG: "/c.toml" }, cwd: "/", ...files({ "/c.toml": "[status\nport = " }) })).toThrow(/cannot parse/);
    expect(() => resolveConfig({ status: { sample_interval_s: 0 } })).toThrow(/sample_interval_s/);
    expect(() => resolveConfig({ status: { port: 99999 } })).toThrow(/invalid configuration/);
  });

  it("warns about unknown [status] keys but does not fail", () => {
    const c = resolveConfig({ status: { port: 9101, sample_interval: 5 } });
    expect(c.warnings).toEqual(["unknown key [status].sample_interval ignored"]);
  });
});

describe("derived values", () => {
  it("hub URL: explicit, wildcard host -> loopback, concrete host kept", () => {
    expect(resolveConfig({ server: { host: "0.0.0.0", port: 9001 } }).hubUrl).toBe("http://127.0.0.1:9001");
    expect(resolveConfig({ server: { host: "100.64.0.1", port: 9000 } }).hubUrl).toBe("http://100.64.0.1:9000");
    expect(resolveConfig({ server: { host: "::", port: 9000 } }).hubUrl).toBe("http://127.0.0.1:9000");
    expect(resolveConfig({ status: { hub_url: "http://hub.internal:8000/" } }).hubUrl).toBe("http://hub.internal:8000");
  });

  it("DNS check host: explicit wins, else the public_url host if it is a name", () => {
    expect(hostFromPublicUrl("https://workstation.example.com")).toBe("workstation.example.com");
    expect(hostFromPublicUrl("http://100.64.0.1:9000")).toBeNull();
    expect(hostFromPublicUrl("http://localhost:9000")).toBeNull();
    expect(hostFromPublicUrl("http://[::1]:9000")).toBeNull();
    expect(hostFromPublicUrl("not a url")).toBeNull();
    expect(hostFromPublicUrl(undefined)).toBeNull();
    expect(resolveConfig({ server: { public_url: "https://workstation.example.com" } }).dnsCheckHost).toBe("workstation.example.com");
    expect(resolveConfig({ server: { public_url: "https://workstation.example.com" }, status: { dns_check_host: "other.example.com" } }).dnsCheckHost).toBe("other.example.com");
  });
});
