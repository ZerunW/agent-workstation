/** The status service listens on its own Unix socket and calls the hub through the hub's local socket. */
import Fastify from "fastify";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultListen, resolveConfig } from "../src/config.js";
import { hubAwareFetch } from "../src/hubFetch.js";
import { listenStatus } from "../src/listen.js";
import { UsageProxy } from "../src/usage.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ws-status-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PRODUCTION = { INVOCATION_ID: "abc" };

describe("configuration", () => {
  it("listens on a socket and calls the hub's local socket in production on Linux, over TCP elsewhere", () => {
    expect(defaultListen(PRODUCTION, "linux")).toBe("unix");
    expect(defaultListen({}, "linux")).toBe("tcp");
    expect(defaultListen(PRODUCTION, "darwin")).toBe("tcp");
    const linux = resolveConfig({}, null, { ...PRODUCTION }, "linux");
    const tcp = resolveConfig({}, null, {});
    expect(tcp).toMatchObject({ listen: "tcp", hubSocket: null, hubUrl: "http://127.0.0.1:9000" });
    expect(linux).toMatchObject({ listen: "unix", socket: "/run/agent-workstation/status.sock", hubSocket: "/run/agent-workstation/hub-local.sock", hubUrl: "http://localhost", proxyGroup: "workstation-proxy" });
    // Explicit settings: listen = "tcp" for the status service, a hub on sockets, a hub_url for a hub elsewhere.
    expect(resolveConfig({ status: { listen: "unix" }, server: { listen: "unix", local_socket: "/x/l.sock" } }, null, {})).toMatchObject({ listen: "unix", hubSocket: "/x/l.sock" });
    expect(resolveConfig({ server: { listen: "unix" }, status: { hub_url: "http://hub.internal:8000" } }, null, {})).toMatchObject({ hubSocket: null, hubUrl: "http://hub.internal:8000" });
    expect(resolveConfig({ server: { listen: "unix" }, status: { hub_socket: "/y/h.sock" } }, null, {}).hubSocket).toBe("/y/h.sock");
  });

  it("refuses a TCP port in production on Linux, and allows it for development", () => {
    expect(() => resolveConfig({ status: { listen: "tcp" } }, null, { ...PRODUCTION }, "linux")).toThrow(/refused in production/);
    expect(() => resolveConfig({ status: { listen: "tcp" } }, null, { NODE_ENV: "production" }, "linux")).toThrow(/refused in production/);
    expect(resolveConfig({ status: { listen: "tcp" } }, null, {}, "linux").listen).toBe("tcp");
    expect(resolveConfig({ status: { listen: "tcp" } }, null, { ...PRODUCTION }, "darwin").listen).toBe("tcp");
  });
});

describe("calling the hub through its local socket", () => {
  it("a fake hub on a temp socket answers the usage proxy; other URLs use plain fetch", async () => {
    const dir = tmp();
    const sock = join(dir, "hub-local.sock");
    const seen: Array<{ url?: string; host?: string; user?: string | string[]; forwarded?: string | string[] }> = [];
    const hub: Server = createServer((req, res) => {
      seen.push({ ...(req.url ? { url: req.url } : {}), ...(req.headers.host ? { host: req.headers.host } : {}), user: req.headers["x-workstation-user"], forwarded: req.headers["x-forwarded-for"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ api: null }));
    });
    await new Promise<void>((r) => hub.listen(sock, r));
    cleanups.push(() => new Promise((r) => hub.close(r)));

    const config = resolveConfig({ server: { listen: "unix", local_socket: sock } }, null, {});
    const other: string[] = [];
    const base = (async (u: string) => (other.push(String(u)), new Response("elsewhere"))) as unknown as typeof fetch;
    const f = hubAwareFetch(config, base);
    const usage = new UsageProxy({ hubUrl: config.hubUrl, defaultUser: config.hubUser, fetch: f });
    expect(await usage.get()).toEqual({ api: null });
    expect(seen).toEqual([{ url: "/api/usage/limits", host: "localhost", user: "status" }].map((s) => ({ ...s, forwarded: undefined })));
    expect(await (await f("https://api.anthropic.com", { method: "HEAD" })).text()).toBe("elsewhere");
    expect(other).toEqual(["https://api.anthropic.com"]);
  });

  it("a hub that is not there fails like a refused connection", async () => {
    const f = hubAwareFetch({ hubUrl: "http://localhost", hubSocket: join(tmp(), "none.sock") });
    const err = await f("http://localhost/healthz").catch((e: unknown) => e);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("ENOENT");
  });

  it("without a socket it is plain fetch", () => {
    const base = (() => undefined) as unknown as typeof fetch;
    expect(hubAwareFetch({ hubUrl: "http://127.0.0.1:9000", hubSocket: null }, base)).toBe(base);
  });
});

describe("the status socket", () => {
  it("is mode 0660 in the configured group, answers, and is removed on close", async () => {
    const dir = tmp();
    const socket = join(dir, "run", "status.sock");
    const app = Fastify();
    app.get("/healthz", async () => ({ ok: true }));
    const l = await listenStatus(app, { listen: "unix", socket, proxyGroup: String(process.getgid!()), host: "127.0.0.1", port: 9100 });
    expect(statSync(socket).mode & 0o777).toBe(0o660);
    expect(statSync(socket).gid).toBe(process.getgid!());
    const body = await new Promise<string>((resolve, reject) => {
      request({ socketPath: socket, path: "/healthz", agent: false }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      })
        .on("error", reject)
        .end();
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
    await l.close();
    expect(existsSync(socket)).toBe(false);
  });
});
