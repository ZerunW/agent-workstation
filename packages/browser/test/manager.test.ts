import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "@agent-workstation/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager, chromiumArgs, spawnChromium, type BrowserConfigInput, type BrowserFrame } from "../src/index.js";
import { FakeClock, fakeBrowserWorld, flush, type FakeBrowserWorld } from "./fakes.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workstation-browser-unit-"));
  for (const u of ["alice", "bob", "carol"]) mkdirSync(join(root, u));
});
afterEach(() => rmSync(root, { recursive: true, force: true })); // temp dirs of this test only

function make(cfg: Partial<BrowserConfigInput> = {}, opts: { free?: number } = {}) {
  const world: FakeBrowserWorld = fakeBrowserWorld();
  const clock = new FakeClock();
  const mgr = new BrowserManager(
    { usersRoot: root, idleMinutes: 10, controlIdleSeconds: 20, maxConcurrent: 2, minFreeMemoryMB: 100, ...cfg },
    {
      launcher: world.launcher,
      connectCdp: world.connect,
      timers: clock,
      freeMemory: () => (opts.free ?? 4096) * 1024 * 1024,
      resolveExecutable: () => ({ path: "/fake/chrome-headless-shell", flavor: "headless-shell", source: "config" }),
      input: { metaAsControl: true },
    },
  );
  const states: BrowserState[] = [];
  const errors: Error[] = [];
  mgr.on("state", (u, s) => u === "alice" && states.push(s));
  mgr.on("error", (_u, e) => errors.push(e));
  return { mgr, world, clock, states, errors };
}

describe("lifecycle", () => {
  it("starts on demand, once per user even under concurrent ensure()", async () => {
    const { mgr, world, states } = make();
    const [a, b, c] = await Promise.all([mgr.ensure("alice"), mgr.ensure("alice"), mgr.ensure("alice")]);
    expect(world.processes).toHaveLength(1);
    expect(a.running && b.running && c.running).toBe(true);
    await mgr.ensure("alice");
    expect(world.processes).toHaveLength(1);
    const spec = world.processes[0]!.spec;
    expect(spec.executablePath).toBe("/fake/chrome-headless-shell");
    expect(spec.profileDir).toBe(join(root, "alice", ".browser", "profile"));
    // DevTools only over the pipe the launcher adds: no port, no address, nothing to connect to
    expect(spec.args.filter((a) => a.startsWith("--remote-debugging") || a.startsWith("--user-data-dir"))).toEqual([]);
    // the profile (cookies) is private to the running account
    for (const d of [join(root, "alice", ".browser"), spec.profileDir]) {
      const st = statSync(d);
      expect(st.mode & 0o777).toBe(0o700);
      expect(st.uid).toBe(process.getuid!());
    }
    await flush();
    expect(states[states.length - 1]).toMatchObject({ running: true, url: "about:blank", controlledBy: null, viewers: 0, viewport: { width: 1280, height: 800 } });
    // viewport applied to the tab
    expect(world.cdp().calls.find((c) => c.method === "Browser.setContentsSize")?.params).toMatchObject({ width: 1280, height: 800 });
  });

  it("tightens an existing, too-open profile dir to 0700", async () => {
    mkdirSync(join(root, "bob", ".browser", "profile"), { recursive: true });
    chmodSync(join(root, "bob", ".browser", "profile"), 0o755);
    const { mgr } = make();
    await mgr.ensure("bob");
    expect(statSync(join(root, "bob", ".browser", "profile")).mode & 0o777).toBe(0o700);
  });

  it("refuses extra switches that would open a DevTools port or move the profile", () => {
    for (const a of ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe", "--user-data-dir=/tmp/x"]) {
      expect(() => new BrowserManager({ usersRoot: root, extraArgs: [a] }), a).toThrow(/extraArgs/);
    }
    expect(() => chromiumArgs({ viewport: { width: 800, height: 600 }, extraArgs: ["--remote-debugging-port=0"] })).toThrow(/extraArgs/);
    expect(chromiumArgs({ viewport: { width: 800, height: 600 } }).filter((a) => /remote-debugging|user-data-dir|^[^-]/.test(a))).toEqual([]);
  });

  it("rejects a command wrapper: the pipe cannot cross sudo", async () => {
    await expect(spawnChromium({ executablePath: "/x", args: [], profileDir: root, viewport: { width: 800, height: 600 }, wrapper: ["sudo", "-n", "--"] })).rejects.toMatchObject({ code: "launch_failed" });
  });

  it("stop() closes gracefully and keeps the profile; ensure() starts a new one", async () => {
    const { mgr, world, states } = make();
    await mgr.ensure("alice");
    const s = await mgr.stop("alice");
    expect(s.running).toBe(false);
    expect(world.cdp(0).count("Browser.close")).toBe(1);
    expect(world.processes[0]!.killed).toEqual([]); // no signal needed
    await flush();
    expect(states.map((x) => x.running)).toEqual([true, false]);
    await mgr.ensure("alice");
    expect(world.processes).toHaveLength(2);
  });

  it("validates users and refuses when disabled", async () => {
    const { mgr } = make();
    await expect(mgr.ensure("../etc")).rejects.toMatchObject({ code: "bad_user" });
    await expect(mgr.ensure("nobody")).rejects.toMatchObject({ code: "no_user_dir" });
    const off = make({ enabled: false });
    await expect(off.mgr.ensure("alice")).rejects.toMatchObject({ code: "disabled" });
    expect(() => off.mgr.mcpEndpoint("alice")).toThrow(/start\(\)/);
  });

  it("enforces maxConcurrent and the free-memory floor", async () => {
    const { mgr } = make({ maxConcurrent: 2 });
    await mgr.ensure("alice");
    await mgr.ensure("bob");
    await expect(mgr.ensure("carol")).rejects.toMatchObject({ code: "too_many" });
    await mgr.stop("bob");
    await expect(mgr.ensure("carol")).resolves.toMatchObject({ running: true });
    const low = make({ minFreeMemoryMB: 500 }, { free: 300 });
    await expect(low.mgr.ensure("alice")).rejects.toMatchObject({ code: "low_memory" });
  });

  it("reports a crash as running:false plus an error event", async () => {
    const { mgr, world, states, errors } = make();
    await mgr.ensure("alice");
    world.processes[0]!.exit(1);
    await flush();
    expect(mgr.state("alice").running).toBe(false);
    expect(states[states.length - 1]!.running).toBe(false);
    expect(errors[0]!.message).toMatch(/unexpectedly/);
  });
});

describe("live view gating", () => {
  it("runs no screencast without viewers; starts on the first, stops after the last", async () => {
    const { mgr, world, states, clock } = make();
    await mgr.ensure("alice");
    const cdp = world.cdp();
    await flush();
    expect(cdp.count("Page.startScreencast")).toBe(0);

    const frames: BrowserFrame[] = [];
    const off = mgr.subscribeFrames("alice", "ws-1", { maxWidth: 640 }, (f) => frames.push(f));
    await flush();
    expect(cdp.count("Page.startScreencast")).toBe(1);
    const [session, params] = [...cdp.screencasts.entries()][0]!;
    expect(params).toMatchObject({ format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 400, everyNthFrame: 1 });
    expect(states[states.length - 1]!.viewers).toBe(1);

    cdp.frame(session);
    await clock.advance(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ data: "JPEG1", width: 1280, height: 800 });
    expect(frames[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(cdp.acks(session)).toEqual([1]);

    off();
    await flush();
    expect(cdp.screencasts.size).toBe(0);
    expect(cdp.count("Page.stopScreencast")).toBe(1);
    expect(states[states.length - 1]!.viewers).toBe(0);
  });

  it("uses the widest viewer (capped at the viewport) and restarts when it changes", async () => {
    const { mgr, world } = make();
    await mgr.ensure("alice");
    const cdp = world.cdp();
    const offA = mgr.subscribeFrames("alice", "a", { maxWidth: 500 }, () => undefined);
    await flush();
    mgr.subscribeFrames("alice", "b", { maxWidth: 4000 }, () => undefined);
    await flush();
    expect([...cdp.screencasts.values()][0].maxWidth).toBe(1280);
    expect(cdp.count("Page.startScreencast")).toBe(2);
    offA();
    await flush();
    expect(cdp.count("Page.startScreencast")).toBe(2); // demand unchanged (b still 1280)
  });

  it("viewers registered before start get frames once the browser runs", async () => {
    const { mgr, world, clock } = make();
    const frames: BrowserFrame[] = [];
    mgr.subscribeFrames("alice", "early", {}, (f) => frames.push(f));
    expect(world.processes).toHaveLength(0); // subscribing does not start the browser
    await mgr.ensure("alice");
    await flush();
    const cdp = world.cdp();
    expect(cdp.count("Page.startScreencast")).toBe(1);
    cdp.frame();
    await clock.advance(0);
    expect(frames).toHaveLength(1);
  });

  it("follows a new tab: the screencast moves to it", async () => {
    const { mgr, world } = make();
    await mgr.ensure("alice");
    const cdp = world.cdp();
    mgr.subscribeFrames("alice", "v", {}, () => undefined);
    await flush();
    const first = [...cdp.screencasts.keys()][0]!;
    const popup = cdp.addTarget({ url: "https://login.test/oauth" });
    await flush();
    expect(cdp.screencasts.has(first)).toBe(false);
    const now = [...cdp.screencasts.keys()][0]!;
    expect(cdp.sessions.get(now)).toBe(popup.targetId);
    expect(mgr.state("alice").url).toBe("https://login.test/oauth");
    cdp.destroyTarget(popup.targetId);
    await flush();
    expect(cdp.sessions.get([...cdp.screencasts.keys()][0]!)).toBe("T1");
  });
});

describe("person input", () => {
  it("dispatches to the active tab and marks controlledBy=user, which expires", async () => {
    const { mgr, world, clock, states } = make({ controlIdleSeconds: 20 });
    await mgr.start();
    await mgr.ensure("alice");
    const cdp = world.cdp();
    await mgr.input("alice", { kind: "mouse", action: "down", x: 10, y: 10, clickCount: 2 });
    const press = cdp.calls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed")!;
    expect(press.params.clickCount).toBe(2);
    expect(cdp.sessions.get(press.sessionId!)).toBe("T1");
    await flush();
    expect(states[states.length - 1]!.controlledBy).toBe("user");
    await clock.advance(25_000);
    expect(mgr.state("alice").controlledBy).toBeNull();
    await mgr.close();
  });

  it("navigates and walks history via the Page domain; rejects non-web URLs and stopped browsers", async () => {
    const { mgr, world } = make();
    await expect(mgr.input("alice", { kind: "history", action: "back" })).rejects.toMatchObject({ code: "not_running" });
    await mgr.ensure("alice");
    const cdp = world.cdp();
    await mgr.input("alice", { kind: "navigate", url: "https://example.com/" });
    expect(cdp.calls.find((c) => c.method === "Page.navigate")?.params.url).toBe("https://example.com/");
    await expect(mgr.input("alice", { kind: "navigate", url: "file:///etc/passwd" })).rejects.toMatchObject({ code: "bad_url" });
    cdp.history = { currentIndex: 1, entries: [{ id: 7, url: "a" }, { id: 8, url: "b" }] };
    await mgr.input("alice", { kind: "history", action: "back" });
    expect(cdp.calls.find((c) => c.method === "Page.navigateToHistoryEntry")?.params.entryId).toBe(7);
    await mgr.input("alice", { kind: "history", action: "reload" });
    expect(cdp.count("Page.reload")).toBe(1);
    await mgr.input("alice", { kind: "key", action: "press", key: "a", modifiers: ["Meta"] });
    expect(cdp.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params.modifiers)).toEqual([2, 2]);
  });
});

describe("idle stop", () => {
  it("stops after idleMinutes without activity; viewers and running tool calls hold it", async () => {
    const { mgr, world, clock } = make({ idleMinutes: 10 });
    await mgr.start();
    await mgr.ensure("alice");
    const off = mgr.subscribeFrames("alice", "v", {}, () => undefined);
    await clock.advance(11 * 60_000);
    expect(mgr.state("alice").running).toBe(true); // watched
    off();
    await clock.advance(9 * 60_000);
    expect(mgr.state("alice").running).toBe(true);
    // an agent tool call in flight holds it too
    const host = (mgr as unknown as { gateway: { host: { toolStarted(u: string, t: string, s: string | null): void; toolFinished(u: string, t: string): void } } }).gateway.host;
    host.toolStarted("alice", "browser_navigate", "11111111-2222-4333-8444-555555555555");
    await flush();
    expect(mgr.state("alice")).toMatchObject({ controlledBy: "agent", sessionId: "11111111-2222-4333-8444-555555555555" });
    await clock.advance(20 * 60_000);
    expect(mgr.state("alice").running).toBe(true);
    host.toolFinished("alice", "browser_navigate");
    await clock.advance(10 * 60_000 + 30_000);
    expect(mgr.state("alice").running).toBe(false);
    expect(world.cdp().count("Browser.close")).toBe(1);
    await mgr.close();
  });

  it("idleMinutes 0 never stops", async () => {
    const { mgr, clock } = make({ idleMinutes: 0 });
    await mgr.start();
    await mgr.ensure("alice");
    await clock.advance(3 * 60 * 60_000);
    expect(mgr.state("alice").running).toBe(true);
    await mgr.close();
  });
});

describe("mcpEndpoint", () => {
  it("returns a loopback URL with a stable per-user bearer token and the hub session header", async () => {
    const { mgr } = make();
    await mgr.start();
    const a1 = mgr.mcpEndpoint("alice", { sessionId: "11111111-2222-4333-8444-555555555555" });
    const a2 = mgr.mcpEndpoint("alice");
    const b = mgr.mcpEndpoint("bob");
    expect(a1.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/alice$/);
    expect(a1.headers.Authorization).toBe(a2.headers.Authorization);
    expect(a1.headers.Authorization).not.toBe(b.headers.Authorization);
    expect(a1.headers["X-Workstation-Session"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(a2.headers["X-Workstation-Session"]).toBeUndefined();
    await mgr.close();
  });
});

describe("profile lock", () => {
  it("refuses to start when another live process holds the profile, and takes over a stale lock", async () => {
    const { writeFileSync } = await import("node:fs");
    const { hostname } = await import("node:os");
    const browserDir = join(root, "alice", ".browser");
    mkdirSync(join(browserDir, "profile"), { recursive: true });
    const profileDir = join(browserDir, "profile");
    // a live holder: this test process (on Linux its cmdline must mention the profile, so use a dead pid there)
    if (process.platform !== "linux") {
      writeFileSync(join(browserDir, "browser.pid.json"), JSON.stringify({ pid: process.pid, profileDir, host: hostname(), startedAt: "x" }));
      const { mgr } = make();
      await expect(mgr.ensure("alice")).rejects.toMatchObject({ code: "profile_in_use" });
    }
    writeFileSync(join(browserDir, "browser.pid.json"), JSON.stringify({ pid: 999_999, profileDir, host: hostname(), startedAt: "x" }));
    const { mgr, world } = make();
    await expect(mgr.ensure("alice")).resolves.toMatchObject({ running: true });
    const { readFileSync, existsSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(browserDir, "browser.pid.json"), "utf8")).pid).toBe(world.processes[0]!.pid);
    await mgr.stop("alice");
    await flush();
    expect(existsSync(join(browserDir, "browser.pid.json"))).toBe(false);
    expect(existsSync(profileDir)).toBe(true);
  });
});
