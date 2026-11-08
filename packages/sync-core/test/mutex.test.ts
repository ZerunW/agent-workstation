import { describe, expect, it } from "vitest";
import { acquireLock, holdsLock, withLock } from "../src/index.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withLock / acquireLock", () => {
  it("serializes callers on the same key in FIFO order", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      withLock("k1", async () => {
        log.push(`${name}+`);
        await sleep(ms);
        log.push(`${name}-`);
      });
    await Promise.all([job("a", 20), job("b", 1), job("c", 5)]);
    expect(log).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
  });

  it("does not serialize different keys", async () => {
    const log: string[] = [];
    await Promise.all([
      withLock("x", async () => {
        log.push("x+");
        await sleep(20);
        log.push("x-");
      }),
      withLock("y", async () => {
        log.push("y+");
        await sleep(1);
        log.push("y-");
      }),
    ]);
    expect(log.indexOf("y-")).toBeLessThan(log.indexOf("x-"));
  });

  it("is re-entrant within one async call chain", async () => {
    const r = await withLock("k2", async () => {
      expect(holdsLock("k2")).toBe(true);
      return withLock("k2", async () => withLock("k2", async () => 42));
    });
    expect(r).toBe(42);
    expect(holdsLock("k2")).toBe(false);
  });

  it("releases after a throwing callback", async () => {
    await expect(withLock("k3", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock("k3", async () => "ok")).toBe("ok");
  });

  it("holds across calls with a handle; handle.run lets the holder call locked code", async () => {
    const handle = await acquireLock("k4");
    let otherRan = false;
    const other = withLock("k4", async () => {
      otherRan = true;
    });
    await sleep(10);
    expect(otherRan).toBe(false);
    expect(await handle.run(() => withLock("k4", async () => "inner"))).toBe("inner");
    handle.release();
    handle.release(); // idempotent
    await other;
    expect(otherRan).toBe(true);
  });

  it("auto-releases a lost hold and supports acquisition timeouts", async () => {
    await acquireLock("k5", { autoReleaseMs: 30 });
    const started = Date.now();
    await withLock("k5", async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);

    const held = await acquireLock("k6");
    await expect(acquireLock("k6", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    let ran = false;
    const after = withLock("k6", async () => {
      ran = true;
    });
    await sleep(10);
    expect(ran).toBe(false); // the timed-out waiter must not let anyone jump the holder
    held.release();
    await after;
    expect(ran).toBe(true);
  });
});
