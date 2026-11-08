import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, storedMessageJson } from "../src/db/store.js";
import { normalizeRelPath, numberedName, resolveInRoot, resolveInRootSync } from "../src/files/paths.js";
import { HttpError } from "../src/util/errors.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function store(): Store {
  const s = new Store(":memory:");
  cleanups.push(() => s.close());
  s.ensureUser("alice");
  return s;
}

const session = (s: Store, id = randomUUID()) =>
  s.insertSession({ id, user: "alice", kind: "chat", title: "t", cwd: ".chat", model: "default", permissionMode: "dontAsk", effort: null });

describe("messages", () => {
  it("allocates monotonic seqs per session and dedupes by uuid", () => {
    const s = store();
    const a = session(s).id;
    const b = session(s).id;
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) seqs.push(s.appendMessage(a, { uuid: randomUUID(), kind: "assistant", payload: { i } })!.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(s.appendMessage(b, { uuid: randomUUID(), kind: "user", payload: {} })!.seq).toBe(1);

    const u = randomUUID();
    expect(s.appendMessage(a, { uuid: u, kind: "user", payload: { x: 1 } })!.seq).toBe(51);
    expect(s.appendMessage(a, { uuid: u, kind: "user", payload: { x: 2 } })).toBeNull();
    // a duplicate does not consume a seq
    expect(s.appendMessage(a, { uuid: randomUUID(), kind: "user", payload: {} })!.seq).toBe(52);
    expect(s.getSession(a)!.lastSeq).toBe(52);
  });

  it("pages and streams messages after a seq; serializes StoredMessage JSON", () => {
    const s = store();
    const id = session(s).id;
    for (let i = 0; i < 10; i++) s.appendMessage(id, { uuid: `u${i}`, kind: "assistant", payload: { n: i } });
    expect(s.listMessages(id, 7, 100).map((m) => m.seq)).toEqual([8, 9, 10]);
    expect(s.listMessages(id, 0, 3).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect([...s.iterateMessages(id, 5)].map((m) => m.seq)).toEqual([6, 7, 8, 9, 10]);
    const m = s.listMessages(id, 0, 1)[0]!;
    expect(JSON.parse(storedMessageJson(m))).toEqual({ seq: 1, sessionId: id, uuid: "u0", kind: "assistant", payload: { n: 0 }, at: m.at });
  });

  it("cascades messages on session delete but keeps usage rows", () => {
    const s = store();
    const id = session(s).id;
    s.appendMessage(id, { uuid: "x", kind: "user", payload: {} });
    s.insertTurn({ sessionId: id, user: "alice", kind: "chat", model: "m", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.1, durationMs: 1, at: new Date().toISOString() });
    s.deleteSession(id);
    expect(s.getSession(id)).toBeNull();
    expect(s.listMessages(id, 0, 10)).toHaveLength(0);
    expect(s.tokensSince("alice", "2000-01-01")).toBe(10);
  });

  it("persists user patches and weekly-limit custom flag", () => {
    const s = store();
    expect(s.getUser("alice")!.weeklyLimitCustom).toBe(false);
    s.updateUser("alice", { weeklyTokenLimit: null, enabled: false, modelAllowlist: ["haiku"] });
    const u = s.getUser("alice")!;
    expect(u).toMatchObject({ weeklyLimitCustom: true, weeklyTokenLimit: null, enabled: false, modelAllowlist: ["haiku"] });
  });
});

describe("path confinement", () => {
  it("normalizes and rejects escapes", () => {
    expect(normalizeRelPath("a//b/./c/")).toBe("a/b/c");
    expect(normalizeRelPath("", true)).toBe("");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "a/\0b"]) {
      expect(() => normalizeRelPath(bad)).toThrow(HttpError);
    }
    expect(() => normalizeRelPath("")).toThrow(HttpError);
    expect(numberedName("inbox/report.pdf", 2)).toBe("inbox/report (2).pdf");
    expect(numberedName("noext", 1)).toBe("noext (1)");
  });

  it("rejects symlink escapes for existing and to-be-created paths", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const root = join(t.dir, "root");
    const outside = join(t.dir, "outside");
    mkdirSync(join(root, "inbox"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "s");
    writeFileSync(join(root, "inbox", "ok.txt"), "ok");
    symlinkSync(outside, join(root, "evil"));
    symlinkSync(join(outside, "secret.txt"), join(root, "inbox", "link.txt"));
    symlinkSync("ok.txt", join(root, "inbox", "inner-link.txt"));

    await expect(resolveInRoot(root, "inbox/ok.txt", { mustExist: true })).resolves.toMatchObject({ rel: "inbox/ok.txt", exists: true });
    await expect(resolveInRoot(root, "inbox/new/deep.txt")).resolves.toMatchObject({ exists: false });
    await expect(resolveInRoot(root, "inbox/inner-link.txt", { mustExist: true })).resolves.toBeTruthy();
    await expect(resolveInRoot(root, "evil/secret.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(resolveInRoot(root, "evil/new-file.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(resolveInRoot(root, "inbox/link.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(resolveInRoot(root, "../outside/secret.txt")).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(resolveInRoot(root, "missing.txt", { mustExist: true })).rejects.toMatchObject({ status: 404 });
    // noFollowLast lets a user delete the link itself
    await expect(resolveInRoot(root, "evil", { noFollowLast: true })).resolves.toMatchObject({ rel: "evil" });
    expect(() => resolveInRootSync(root, "evil/secret.txt")).toThrow(HttpError);
    expect(resolveInRootSync(root, "inbox/ok.txt").exists).toBe(true);
  });
});

describe("usernamesForLogin", () => {
  it("orders by session activity, else bind time, else creation; enabled and visible users only", () => {
    const s = store();
    const L = "alice@example.com";
    s.ensureUser("old", false, "2026-01-01T00:00:00.000Z");
    s.ensureUser("new", false, "2025-01-01T00:00:00.000Z");
    s.ensureUser("off", false, "2026-01-01T00:00:00.000Z");
    s.ensureUser("legacy", false, "2026-01-05T00:00:00.000Z");
    s.ensureUser("other", false, "2026-01-01T00:00:00.000Z");
    s.ensureUser("_system", true);
    s.bindTailscaleLogin("old", L, "2026-01-01T00:00:00.000Z");
    s.bindTailscaleLogin("new", L, "2026-01-02T00:00:00.000Z");
    s.bindTailscaleLogin("off", L, "2026-01-09T00:00:00.000Z");
    s.bindTailscaleLogin("_system", L, "2026-01-09T00:00:00.000Z");
    s.bindTailscaleLogin("other", "bob@example.com", "2026-01-09T00:00:00.000Z");
    s.updateUser("off", { enabled: false });
    // A binding from before bind times were recorded falls back to the creation time.
    s.bindTailscaleLogin("legacy", L, null as never);
    expect(s.usernamesForLogin(L)).toEqual(["legacy", "new", "old"]);
    const mk = (id: string, user: string, at: string) =>
      s.insertSession({ id, user, kind: "chat", title: id, cwd: ".chat", model: "default", permissionMode: "dontAsk", effort: null, createdAt: at });
    mk("a", "old", "2026-03-01T00:00:00.000Z");
    mk("b", "new", "2026-02-01T00:00:00.000Z");
    expect(s.usernamesForLogin(L)).toEqual(["old", "new", "legacy"]);
    expect(s.usernamesForLogin("bob@example.com")).toEqual(["other"]);
    expect(s.usernamesForLogin("nobody@example.com")).toEqual([]);
  });
});
