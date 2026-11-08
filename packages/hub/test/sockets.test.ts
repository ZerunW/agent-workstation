/**
 * The hub listens on two Unix sockets and trusts a request by the socket it arrived on (identity.ts, listen.ts):
 * real sockets in a temp directory.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenHub, type Listening } from "../src/listen.js";
import type { TailscaleWho, TailscaleWhois } from "../src/tailscale.js";
import { hubFixture, type HubFixture } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const ALICE_IP = "100.64.0.20";
const OWN_LAN_IP = "192.168.77.5";
const whois: TailscaleWhois = { lookup: async (ip: string): Promise<TailscaleWho | null> => (ip === ALICE_IP ? { login: "alice@example.com", node: "alice-mac" } : null) };

interface Rig {
  f: HubFixture;
  listening: Listening;
  pub: string;
  local: string;
}

async function rig(): Promise<Rig> {
  const f = await hubFixture(
    { tailscaleWhois: whois, identityHost: { addresses: () => ["127.0.0.1", OWN_LAN_IP] } },
    (dir) => ({
      server: { listen: "unix", socket: join(dir, "s", "hub.sock"), local_socket: join(dir, "s", "hub-local.sock"), proxy_group: String(process.getgid!()) },
      auth: { tailscale_identity: true, lan_access: "legacy", admin_logins: ["alice@example.com"], admin_usernames: ["admin"] },
    }),
  );
  const listening = await listenHub(f.app, f.hub.config);
  cleanups.push(() => f.close());
  cleanups.push(() => listening.close());
  return { f, listening, pub: f.hub.config.server.socket, local: f.hub.config.server.localSocket };
}

type Headers = Record<string, string | string[]>;

function get(socketPath: string, headers: Headers = {}, path = "/api/me"): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, path, agent: false, headers: { host: "localhost", "x-workstation-user": "alice", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: body.startsWith("{") ? JSON.parse(body) : {} }));
    });
    r.on("error", reject);
    r.end();
  });
}

/** A WebSocket handshake: "upgraded" or the status of the refusal. */
function upgrade(socketPath: string, headers: Headers = {}): Promise<number | "upgraded"> {
  return new Promise((resolve, reject) => {
    const r = request({
      socketPath,
      path: "/ws",
      agent: false,
      headers: { host: "localhost", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "x-workstation-user": "alice", ...headers },
    });
    let done = false;
    const finish = (v: number | "upgraded") => {
      done = true;
      resolve(v);
    };
    r.on("upgrade", (_res, socket) => {
      socket.destroy();
      finish("upgraded");
    });
    r.on("response", (res) => {
      res.resume();
      finish(res.statusCode ?? 0);
    });
    r.on("error", (e) => (done ? undefined : reject(e)));
    r.end();
  });
}

describe("the public socket (nginx)", () => {
  it("needs exactly one X-Forwarded-For IP on every route, WebSocket upgrades included; health answers without it", async () => {
    const { pub, f } = await rig();
    for (const headers of [{}, { "x-forwarded-for": [ALICE_IP, ALICE_IP] }, { "x-forwarded-for": `${ALICE_IP}, 10.0.0.1` }, { "x-forwarded-for": "not-an-ip" }] as Headers[]) {
      const r = await get(pub, headers);
      expect([r.status, r.json.code], JSON.stringify(headers)).toEqual([400, "proxy_header_invalid"]);
    }
    expect((await get(pub, {}, "/api/readme/features")).json.code).toBe("proxy_header_invalid");
    expect(await upgrade(pub)).toBe(400);
    expect(await upgrade(pub, { "x-forwarded-for": `${ALICE_IP}, ${ALICE_IP}` })).toBe(400);
    expect((await get(pub, {}, "/healthz")).status).toBe(200);
    expect((await get(pub, {}, "/api/health")).status).toBe(200);
    expect(f.hub.store.getUser("alice")).toBeNull();
    expect(await upgrade(pub, { "x-forwarded-for": ALICE_IP })).toBe("upgraded");
  });

  it("refuses this machine's own addresses (loopback, an interface address) as 403 self_caller, health excepted", async () => {
    const { pub } = await rig();
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", OWN_LAN_IP]) {
      const r = await get(pub, { "x-forwarded-for": ip });
      expect([r.status, r.json.code], ip).toEqual([403, "self_caller"]);
    }
    expect((await get(pub, { "x-forwarded-for": "127.0.0.1" }, "/healthz")).status).toBe(200);
  });

  it("classifies by the forwarded address: a Tailscale address goes through whois, the LAN follows lan_access", async () => {
    const { pub } = await rig();
    const alice = await get(pub, { "x-forwarded-for": ALICE_IP });
    expect(alice.status).toBe(200);
    expect(alice.json.user).toMatchObject({ name: "alice", isAdmin: true }); // admin_logins
    expect((await get(pub, { "x-forwarded-for": "100.64.0.99" })).json.code).toBe("tailscale_identity_required");
    const lan = await get(pub, { "x-forwarded-for": "192.168.1.50" }, "/api/me");
    expect(lan.status).toBe(200); // lan_access = "legacy"
  });
});

describe("the local socket (the status service)", () => {
  it("is the local service caller; an X-Forwarded-For header there is refused", async () => {
    const { local } = await rig();
    const r = await get(local, { "x-workstation-user": "status" });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ name: "status", isAdmin: false });
    const forged = await get(local, { "x-forwarded-for": ALICE_IP });
    expect([forged.status, forged.json.code]).toEqual([400, "proxy_header_invalid"]);
    expect((await get(local, { "x-forwarded-for": "127.0.0.1" }, "/healthz")).status).toBe(200); // health answers anything
  });

  it("does not take the identity of a forwarded address, whatever the user header says", async () => {
    const { local } = await rig();
    const r = await get(local, { "x-workstation-user": "alice" });
    expect(r.json.user.isAdmin).toBe(false); // legacy caller: admin only by admin_usernames, not alice's login
  });
});

describe("socket files", () => {
  it("public 0660 in the configured group, local 0600, both removed on close", async () => {
    const { listening, pub, local } = await rig();
    expect(statSync(pub).mode & 0o777).toBe(0o660);
    expect(statSync(pub).gid).toBe(process.getgid!());
    expect(statSync(local).mode & 0o777).toBe(0o600);
    await listening.close();
    expect(existsSync(pub)).toBe(false);
    expect(existsSync(local)).toBe(false);
  });

  it("a stale socket file from a crash is replaced; any other file in the way stops the start", async () => {
    const g = await hubFixture({}, (dir) => ({ server: { listen: "unix", socket: join(dir, "s", "hub.sock"), local_socket: join(dir, "s", "hub-local.sock"), proxy_group: String(process.getgid!()) } }));
    cleanups.push(() => g.close());
    const { socket, localSocket } = g.hub.config.server;
    mkdirSync(join(g.dir, "s"), { recursive: true });
    // A process that binds both sockets and is killed leaves its files behind.
    const code = `const n=require("node:net");let k=0;for(const p of process.argv.slice(1))n.createServer().listen(p,()=>{if(++k===2)process.kill(process.pid,"SIGKILL")})`;
    spawnSync(process.execPath, ["-e", code, socket, localSocket]);
    expect(existsSync(socket) && existsSync(localSocket)).toBe(true);
    const l = await listenHub(g.app, g.hub.config);
    expect((await get(socket, { "x-forwarded-for": ALICE_IP }, "/healthz")).status).toBe(200);
    await l.close();

    const h = await hubFixture({}, (dir) => ({ server: { listen: "unix", socket: join(dir, "s", "hub.sock"), local_socket: join(dir, "s", "hub-local.sock"), proxy_group: String(process.getgid!()) } }));
    cleanups.push(() => h.close());
    mkdirSync(join(h.dir, "s"), { recursive: true });
    writeFileSync(join(h.dir, "s", "hub.sock"), "a regular file");
    await expect(listenHub(h.app, h.hub.config)).rejects.toThrow(/not a socket/);
    expect(existsSync(join(h.dir, "s", "hub.sock"))).toBe(true);
  });

  it("an unknown proxy group stops the start", async () => {
    const g = await hubFixture({}, (dir) => ({ server: { listen: "unix", socket: join(dir, "s", "hub.sock"), local_socket: join(dir, "s", "hub-local.sock"), proxy_group: "no-such-group-xyz" } }));
    cleanups.push(() => g.close());
    await expect(listenHub(g.app, g.hub.config)).rejects.toThrow(/group/);
  });
});
