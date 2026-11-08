/**
 * Real Chromium (skipped when no Playwright Chromium is installed): launch, screencast frames, person click, the MCP
 * endpoint driven by the official MCP client (navigate, snapshot, click, allowlist), idle restart on demand.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BrowserState } from "@agent-workstation/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager, resolveExecutable, type BrowserFrame } from "../src/index.js";

let available = false;
try {
  resolveExecutable({ flavor: "headless-shell" });
  available = true;
} catch {
  available = false;
}

const PAGE = `<!doctype html><title>start</title><style>body{margin:0;font:20px sans-serif}</style>
<h1 id="h">Hello server</h1>
<button id="b" style="position:absolute;left:100px;top:400px;width:200px;height:60px" onclick="window.n=(window.n||0)+1;document.title='clicked '+window.n;document.getElementById('h').textContent='clicked '+window.n">Click me</button>
<input id="t" style="position:absolute;left:100px;top:300px;width:300px" oninput="document.title='typed '+this.value">`;

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 15_000, what = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!available)("real Chromium", () => {
  let root: string;
  let http: Server;
  let base: string;
  let mgr: BrowserManager;
  const states: BrowserState[] = [];
  const last = (): BrowserState | undefined => states[states.length - 1];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "workstation-browser-it-"));
    mkdirSync(join(root, "alice"));
    http = createServer((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "sid=server-login; Max-Age=86400; Path=/; HttpOnly" });
        res.end("<title>logged in</title>ok");
        return;
      }
      if (req.url === "/whoami") {
        const sid = /sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "nobody";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<title>user ${sid}</title>`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE.replace("<title>start</title>", `<title>${req.url === "/two" ? "page two" : "start"}</title>`));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    mgr = new BrowserManager({ usersRoot: root, idleMinutes: 0, controlIdleSeconds: 60, minFreeMemoryMB: 0, maxConcurrent: 2 });
    mgr.on("state", (user, s) => user === "alice" && states.push(s));
    await mgr.start();
  });

  afterAll(async () => {
    await mgr?.close();
    await new Promise<void>((r) => http?.close(() => r()));
    // temp test profile only (never a real user's)
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("launches headless with the persistent profile and the configured viewport", async () => {
    const s = await mgr.ensure("alice");
    expect(s.running).toBe(true);
    expect(s.viewport).toEqual({ width: 1280, height: 800 });
    expect(existsSync(join(root, "alice", ".browser", "profile"))).toBe(true);
    expect(mgr.runningUsers()).toEqual(["alice"]);
  });

  it.skipIf(process.platform !== "linux")("controls Chromium over the pipe only: no DevTools flag, no listening socket", async () => {
    await mgr.ensure("alice");
    const profile = join(root, "alice", ".browser", "profile");
    const procs = readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .flatMap((n) => {
        try {
          const argv = readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0");
          return argv.includes(`--user-data-dir=${profile}`) ? [{ pid: Number(n), argv }] : [];
        } catch {
          return [];
        }
      });
    expect(procs.length).toBeGreaterThan(0);
    for (const p of procs) expect(p.argv.filter((a) => a.startsWith("--remote-debugging-port") || a.startsWith("--remote-debugging-address"))).toEqual([]);
    expect(procs.some((p) => p.argv.includes("--remote-debugging-pipe"))).toBe(true);

    // every TCP socket in LISTEN state (inodes from /proc/net/tcp{,6}, state 0A) must belong to nobody in the browser's process tree
    const listening = new Set<string>();
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols[3] === "0A") listening.add(cols[9]!);
      }
    }
    // the browser's own helpers (zygote, gpu, renderers, ...) are children of the main process; /proc/<pid>/stat field 4 = ppid
    const tree = new Set(procs.map((p) => p.pid));
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
        try {
          const stat = readFileSync(`/proc/${n}/stat`, "utf8");
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          if (tree.has(ppid) && !tree.has(Number(n))) (tree.add(Number(n)), (grew = true));
        } catch {
          // gone
        }
      }
    }
    for (const pid of tree) {
      let fds: string[] = [];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        let target = "";
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m) expect(listening.has(m[1]!), `pid ${pid} fd ${fd} ${target} is a listening TCP socket`).toBe(false);
      }
    }
  });

  it("streams screencast frames only while viewed, and a person click changes the page", async () => {
    await mgr.input("alice", { kind: "navigate", url: `${base}/` });
    await waitFor(() => mgr.state("alice").title === "start", 15_000, "page load");
    const frames: BrowserFrame[] = [];
    const unsubscribe = mgr.subscribeFrames("alice", "viewer-1", { maxWidth: 640 }, (f) => frames.push(f));
    await waitFor(() => frames.length > 0, 10_000, "first frame");
    expect(frames[0]!.width).toBe(1280);
    expect(frames[0]!.height).toBe(800);
    expect(Buffer.from(frames[0]!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG
    await waitFor(() => last()?.viewers === 1, 2000, "viewers=1");

    const before = frames.length;
    await mgr.input("alice", { kind: "mouse", action: "move", x: 150, y: 420 });
    await mgr.input("alice", { kind: "mouse", action: "down", x: 200, y: 430, button: "left", clickCount: 1 });
    await mgr.input("alice", { kind: "mouse", action: "up", x: 200, y: 430, button: "left", clickCount: 1 });
    await waitFor(() => mgr.state("alice").title === "clicked 1", 10_000, "click → title");
    await waitFor(() => frames.length > before, 5000, "frame after click");
    expect(mgr.state("alice").controlledBy).toBe("user");

    // typing into the input
    await mgr.input("alice", { kind: "mouse", action: "click", x: 150, y: 310 });
    await mgr.input("alice", { kind: "key", action: "press", key: "h" });
    await mgr.input("alice", { kind: "text", text: "i!" });
    await waitFor(() => mgr.state("alice").title === "typed hi!", 10_000, "typing → title");

    unsubscribe();
    await waitFor(() => last()?.viewers === 0, 2000, "viewers=0");
    await new Promise((r) => setTimeout(r, 400));
    const after = frames.length;
    await mgr.input("alice", { kind: "mouse", action: "click", x: 200, y: 430 });
    await waitFor(() => mgr.state("alice").title === "clicked 2", 10_000, "second click");
    await new Promise((r) => setTimeout(r, 500));
    expect(frames.length).toBe(after); // no viewers → no frames
  });

  it("keeps logins (cookies) across stop/start: the profile persists", async () => {
    await mgr.ensure("alice");
    await mgr.input("alice", { kind: "navigate", url: `${base}/login` });
    await waitFor(() => mgr.state("alice").title === "logged in", 10_000, "login page");
    await mgr.stop("alice");
    expect(mgr.state("alice").running).toBe(false);
    await mgr.ensure("alice");
    await mgr.input("alice", { kind: "navigate", url: `${base}/whoami` });
    await waitFor(() => mgr.state("alice").title?.startsWith("user "), 10_000, "whoami");
    expect(mgr.state("alice").title).toBe("user server-login");
  });

  it("serves the Playwright MCP tools over HTTP with a bearer token, attributed to the hub session", async () => {
    const hubSession = "11111111-2222-4333-8444-555555555555";
    const ep = mgr.mcpEndpoint("alice", { sessionId: hubSession });
    expect(ep.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alice$/);

    // wrong token → 401
    const bad = await fetch(ep.url, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(bad.status).toBe(401);

    const client = new Client({ name: "it", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ep.url), { requestInit: { headers: ep.headers } }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_click");
    expect(names).not.toContain("browser_run_code_unsafe");

    const nav = (await client.callTool({ name: "browser_navigate", arguments: { url: `${base}/two` } })) as { content: { type: string; text?: string }[]; isError?: boolean };
    expect(nav.isError).toBeFalsy();
    await waitFor(() => mgr.state("alice").title === "page two", 10_000, "agent navigation");
    expect(mgr.state("alice").controlledBy).toBe("agent");
    expect(mgr.state("alice").sessionId).toBe(hubSession);

    const snap = (await client.callTool({ name: "browser_snapshot", arguments: {} })) as { content: { type: string; text?: string }[] };
    const text = snap.content.map((c) => c.text ?? "").join("\n");
    const ref = /button "Click me" \[ref=([a-z0-9]+)\]/i.exec(text)?.[1];
    expect(ref, text).toBeTruthy();
    const click = (await client.callTool({ name: "browser_click", arguments: { element: "Click me button", target: ref } })) as { isError?: boolean };
    expect(click.isError, JSON.stringify(click)).toBeFalsy();
    await waitFor(() => mgr.state("alice").title === "clicked 1", 10_000, "agent click");

    // the live view follows the agent's tabs: a new tab becomes active, selecting a tab switches back
    const viewFrames: BrowserFrame[] = [];
    const unview = mgr.subscribeFrames("alice", "viewer-2", {}, (f) => viewFrames.push(f));
    const opened = (await client.callTool({ name: "browser_tabs", arguments: { action: "new", url: `${base}/two` } })) as { isError?: boolean };
    expect(opened.isError).toBeFalsy();
    await waitFor(() => mgr.state("alice").title === "page two", 10_000, "new tab followed");
    const selected = (await client.callTool({ name: "browser_tabs", arguments: { action: "select", index: 0 } })) as { isError?: boolean };
    expect(selected.isError).toBeFalsy();
    await waitFor(() => mgr.state("alice").title === "clicked 1", 10_000, "selected tab followed");
    const n = viewFrames.length;
    await waitFor(() => viewFrames.length > n, 5000, "frame from the selected tab");
    unview();

    const blocked = (await client.callTool({ name: "browser_run_code_unsafe", arguments: { code: "async () => process.pid" } })) as { isError?: boolean; content: { text?: string }[] };
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toMatch(/not available/);

    // stop (idle or stopped by the user) → the next tool call starts Chromium again on demand, same MCP session
    await mgr.stop("alice");
    expect(mgr.state("alice").running).toBe(false);
    expect(existsSync(join(root, "alice", ".browser", "profile"))).toBe(true);
    const again = (await client.callTool({ name: "browser_navigate", arguments: { url: `${base}/` } })) as { isError?: boolean };
    expect(again.isError).toBeFalsy();
    expect(mgr.state("alice").running).toBe(true);
    await waitFor(() => mgr.state("alice").title === "start", 10_000, "navigation after restart");
    await client.close();
  });
});
