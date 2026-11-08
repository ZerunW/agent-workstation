import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createHub, startHub, stopHub, type Hub, type HubOverrides } from "../src/hub.js";
import { Store } from "../src/db/store.js";
import { SessionService, type RuntimeBilling, type SessionServiceDeps } from "../src/sessions/runtime.js";
import { silentLogger } from "../src/util/log.js";
import { RecordingBus } from "../src/ws/protocol.js";
import { FakeSdk } from "./fakeSdk.js";

export function tempDir(prefix = "workstation-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Polls until `fn` returns truthy (or throws after `ms`). */
export async function until<T>(fn: () => T | Promise<T>, ms = 3000, what = "condition"): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

export interface RuntimeFixture {
  store: Store;
  sdk: FakeSdk;
  bus: RecordingBus;
  sessions: SessionService;
  root: string;
  mem: { available: number };
  limits: { max: number; minFree: number; idleMs: number; permissionTimeoutMs: number };
  cleanup: () => void;
  newSession: (kind?: "chat" | "code", user?: string) => string;
}

/** A billing service with a key and no budget limit, and a key proxy that hands out placeholder credentials. */
export const fakeBilling = (): RuntimeBilling => ({ apiKey: () => "sk-ant-api03-fake", available: () => true, overBudget: () => false, assertCanSend: () => {}, assertAvailable: () => {}, markCreditsExhausted: () => {} });
export const fakeApiProxy = () => ({ issue: () => ({ token: `hsk-${"a".repeat(43)}`, baseUrl: "http://127.0.0.1:9" }), revoke: () => {}, revokeOwner: () => {} });

/** `overrides` may be a function of the fixture's store and bus (for deps built on them, e.g. a MemoryService). */
export function runtimeFixture(
  overrides: Partial<SessionServiceDeps> | ((base: { store: Store; bus: RecordingBus }) => Partial<SessionServiceDeps>) = {},
  limits: Partial<RuntimeFixture["limits"]> = {},
): RuntimeFixture {
  const t = tempDir();
  const root = join(t.dir, "users");
  const store = new Store(":memory:");
  const sdk = new FakeSdk();
  const bus = new RecordingBus();
  const mem = { available: 100_000 };
  const lim = { max: 4, minFree: 1000, idleMs: 60_000, permissionTimeoutMs: 60_000, ...limits };
  const userRoot = (u: string) => {
    const p = join(root, u);
    mkdirSync(join(p, ".chat"), { recursive: true });
    return p;
  };
  const sessions = new SessionService({
    store,
    sdk,
    bus,
    log: silentLogger,
    limits: {
      maxActiveProcesses: () => lim.max,
      minFreeMemMib: () => lim.minFree,
      idleMs: () => lim.idleMs,
      permissionTimeoutMs: () => lim.permissionTimeoutMs,
      stopGraceMs: 150,
    },
    memAvailableMiB: () => mem.available,
    userRoot,
    captureProcess: false,
    billing: fakeBilling(),
    apiProxy: fakeApiProxy(),
    ...(typeof overrides === "function" ? overrides({ store, bus }) : overrides),
  });
  const newSession = (kind: "chat" | "code" = "chat", user = "alice") => {
    store.ensureUser(user);
    userRoot(user);
    return sessions.create({ user, kind, cwd: kind === "chat" ? ".chat" : "", model: "default", permissionMode: "default", effort: null }).id;
  };
  return {
    store,
    sdk,
    bus,
    sessions,
    root,
    mem,
    limits: lim,
    newSession,
    cleanup: () => {
      void sessions.shutdown();
      store.close();
      t.cleanup();
    },
  };
}

export const msgBody = (text: string) => ({ uuid: crypto.randomUUID(), text });

// ---------------------------------------------------------------- full hub + app


export interface HubFixture {
  hub: Hub;
  app: FastifyInstance;
  sdk: FakeSdk;
  dir: string;
  root: string;
  disk: { used: number };
  as: (user: string, extra?: Record<string, string>) => Record<string, string>;
  close: () => Promise<void>;
}

/** A real hub (fake SDK, real files and sync-core) in a temp dir, plus its Fastify app. */
export async function hubFixture(
  overrides: Partial<HubOverrides> | ((dir: string) => Partial<HubOverrides>) = {},
  configOverrides: (dir: string) => Record<string, Record<string, unknown>> = () => ({}),
): Promise<HubFixture> {
  const t = tempDir();
  const root = join(t.dir, "users");
  const sdk = new FakeSdk();
  const disk = { used: 40 };
  const extra = configOverrides(t.dir);
  // A key by default (sessions need one); a test that wants none writes an empty key file first.
  if (!existsSync(join(t.dir, "anthropic.env"))) writeFileSync(join(t.dir, "anthropic.env"), "ANTHROPIC_API_KEY=sk-ant-api03-fixture-not-a-real-key\n");
  const config = parseConfig(
    {
      ...extra,
      paths: { users_root: root, data_dir: join(t.dir, "data"), claude_bin: "", claude_home: join(t.dir, "claude-home"), ...(extra.paths ?? {}) },
      // The fixtures act as local tools with header identities; tests of the strict defaults pass their own values.
      auth: { admin_usernames: ["admin"], tailscale_identity: false, lan_access: "legacy", anthropic_api_key_file: join(t.dir, "anthropic.env"), ...(extra.auth ?? {}) },
    },
    null,
    {},
  );
  const hub = createHub(config, {
    log: silentLogger,
    sdk,
    dbFile: ":memory:",
    captureProcess: false,
    tmuxBin: null,
    statfs: async () => ({ totalBytes: 100 * 2 ** 30, freeBytes: (100 - disk.used) * 2 ** 30, usedPercent: disk.used }),
    du: async (paths) => new Map(paths.map((p) => [p, 1024])),
    reviewNotifyMs: 30,
    ...(typeof overrides === "function" ? overrides(t.dir) : overrides),
  });
  await startHub(hub, { timers: false, retention: false });
  const app = await buildApp(hub);
  await app.ready();
  return {
    hub,
    app,
    sdk,
    dir: t.dir,
    root,
    disk,
    as: (user, extra = {}) => ({ "x-workstation-user": user, ...extra }),
    close: async () => {
      await app.close();
      await stopHub(hub);
      t.cleanup();
    },
  };
}

/** Upgrade context for `app.injectWS`: real WebSocket clients always send a Host header, and the hub refuses requests without one. */
export const WS_UPGRADE = { headers: { host: "localhost" } } as never;
