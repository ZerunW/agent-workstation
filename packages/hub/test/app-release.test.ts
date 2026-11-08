import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFixture, type HubFixture } from "./helpers.js";

const dmgOf = (tag: string) => Buffer.from(`fake-dmg-${tag}-`.repeat(1000));
const dmg = dmgOf("a");
const release = (over: Record<string, unknown> = {}, bytes: Buffer = dmg) => ({
  platform: "mac",
  version: "1.2.3",
  build: "202610311200",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  publishedAt: "2026-10-31T12:00:00Z",
  // shape only: the hub relays the signature, the Mac app verifies it
  signature: `${"A".repeat(86)}==`,
  ...over,
});

describe("Mac app release routes", () => {
  let fx: HubFixture;
  let releasesDir: string;
  const get = (url: string, headers: Record<string, string> = {}) => fx.app.inject({ method: "GET", url, headers });

  /** Writes `<platform>/<version>-<build>/{AgentWorkstation.dmg,release.json}`. */
  const put = (over: Record<string, unknown> = {}, bytes: Buffer | null = dmg, tag = bytes ?? dmg) => {
    const r = release({ ...over }, tag);
    const dir = join(releasesDir, r.platform as string, `${r.version}-${r.build}`);
    mkdirSync(dir, { recursive: true });
    if (bytes) writeFileSync(join(dir, "AgentWorkstation.dmg"), bytes);
    writeFileSync(join(dir, "release.json"), JSON.stringify(r));
    return dir;
  };
  const start = async (before?: (releasesDir: string) => void) => {
    fx = await hubFixture({}, (dir) => {
      releasesDir = join(dir, "releases");
      mkdirSync(releasesDir, { recursive: true });
      before?.(releasesDir);
      return { paths: { releases_dir: releasesDir } };
    });
  };

  afterEach(async () => {
    await fx.close();
  });

  it("serves the latest release of each platform without a user header", async () => {
    await start();
    put();
    put({ platform: "mac-intel", version: "1.2.2", build: "202610301000" });
    const mac = await get("/api/app/mac/latest");
    expect(mac.statusCode).toBe(200);
    expect(mac.json()).toEqual(release());
    expect(mac.headers["cache-control"]).toBe("no-store");
    expect((await get("/api/app/mac-intel/latest")).json()).toEqual(release({ platform: "mac-intel", version: "1.2.2", build: "202610301000" }));
    const bad = await get("/api/app/windows/latest");
    expect(bad.statusCode).toBe(404);
    expect((await get("/api/app/windows/download")).statusCode).toBe(404);
  });

  it("404s when nothing is published for the platform", async () => {
    await start();
    put();
    for (const url of ["/api/app/mac-intel/latest", "/api/app/mac-intel/download"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code).toBe("not_found");
    }
    expect((await get("/api/app/releases")).json()).toEqual({ releases: [release()] });
  });

  it("latest = highest build, compared as a number, whatever the version says", async () => {
    await start();
    put({ version: "2.0.0", build: "99" });
    put({ version: "1.0.0", build: "100" });
    put({ version: "1.5.0", build: "20" });
    expect((await get("/api/app/mac/latest")).json().build).toBe("100");
    expect((await get("/api/app/mac/download")).headers["content-disposition"]).toBe('attachment; filename="Agent Workstation-1.0.0-100.dmg"');
  });

  it("lists every release, newest first per platform", async () => {
    await start();
    put({ build: "202610311200" });
    put({ version: "1.3.0", build: "202611010900" });
    put({ version: "1.1.0", build: "202610200800" });
    put({ platform: "mac-intel", version: "1.3.0", build: "202611010901" });
    put({ platform: "mac-intel", version: "1.2.0", build: "202610311201" });
    writeFileSync(join(releasesDir, "mac", "stray.txt"), "x");
    mkdirSync(join(releasesDir, "mac", "empty-dir"));
    mkdirSync(join(releasesDir, "mac", "broken"));
    writeFileSync(join(releasesDir, "mac", "broken", "release.json"), "{not json");
    const res = await get("/api/app/releases");
    expect(res.statusCode).toBe(200);
    expect(res.json().releases.map((r: { platform: string; build: string }) => `${r.platform}:${r.build}`)).toEqual([
      "mac:202611010900",
      "mac:202610311200",
      "mac:202610200800",
      "mac-intel:202611010901",
      "mac-intel:202610311201",
    ]);
  });

  it("ignores a release whose json claims another platform, fails validation or has no dmg", async () => {
    await start();
    const wrong = put({ platform: "mac", version: "9.0.0", build: "900" });
    // move it under mac-intel with a mac json
    mkdirSync(join(releasesDir, "mac-intel", "9.0.0-900"), { recursive: true });
    writeFileSync(join(releasesDir, "mac-intel", "9.0.0-900", "release.json"), JSON.stringify(release({ version: "9.0.0", build: "900" })));
    put({ version: "8.0.0", build: "800", sha256: "nope" });
    expect(wrong).toContain("9.0.0-900");
    expect((await get("/api/app/mac-intel/latest")).statusCode).toBe(404);
    expect((await get("/api/app/mac/latest")).json().build).toBe("900");
    put({ version: "7.0.0", build: "1000" }, null); // json without dmg: listed, but no download
    expect((await get("/api/app/mac/download")).statusCode).toBe(404);
  });

  it("picks up a changed release.json (mtime) without a restart", async () => {
    await start();
    const dir = put();
    expect((await get("/api/app/mac/latest")).json().build).toBe("202610311200");
    writeFileSync(join(dir, "release.json"), JSON.stringify(release({ sizeBytes: dmg.length + 1 })));
    utimesSync(join(dir, "release.json"), new Date(), new Date(Date.now() + 5000));
    expect((await get("/api/app/mac/latest")).json().sizeBytes).toBe(dmg.length + 1);
    rmSync(join(dir, "release.json"));
    expect((await get("/api/app/mac/latest")).statusCode).toBe(404);
  });

  it("streams the latest dmg on the old and the per-platform path", async () => {
    await start();
    put();
    for (const url of ["/api/app/mac/download"]) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/x-apple-diskimage");
      expect(res.headers["content-length"]).toBe(String(dmg.length));
      expect(res.headers["content-disposition"]).toBe('attachment; filename="Agent Workstation-1.2.3-202610311200.dmg"');
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload.equals(dmg)).toBe(true);
    }
    const intel = dmgOf("intel");
    put({ platform: "mac-intel", version: "1.2.3", build: "202610311201" }, intel);
    expect((await get("/api/app/mac-intel/download")).rawPayload.equals(intel)).toBe(true);
  });

  it("refuses a stale pair (size differs from release.json)", async () => {
    await start();
    put({ sizeBytes: dmg.length + 1 });
    const res = await get("/api/app/mac/download");
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });

  describe("GET /download/:platform/:version", () => {
    const oldDmg = dmgOf("old");
    const newDmg = dmgOf("new-and-longer");
    const intelDmg = dmgOf("intel");
    const seed = async () => {
      await start();
      put({ version: "1.0.0", build: "100" }, oldDmg);
      put({ version: "1.1.0", build: "110" }, newDmg);
      put({ version: "1.1.0", build: "111" }, dmg); // a rebuild of the same version
      put({ platform: "mac-intel", version: "1.1.0", build: "112" }, intelDmg);
    };

    it("latest, with or without the build, as an attachment named after the version and the CPU", async () => {
      await seed();
      const latest = await get("/download/mac/latest");
      expect(latest.statusCode).toBe(200);
      expect(latest.headers["content-type"]).toBe("application/x-apple-diskimage");
      expect(latest.headers["content-disposition"]).toBe('attachment; filename="Agent Workstation-1.1.0-arm64.dmg"');
      expect(latest.rawPayload.equals(dmg)).toBe(true);

      expect((await get("/download/mac/1.0.0")).rawPayload.equals(oldDmg)).toBe(true);
      expect((await get("/download/mac/1.0.0-100")).rawPayload.equals(oldDmg)).toBe(true);
      expect((await get("/download/mac/1.1.0-110")).rawPayload.equals(newDmg)).toBe(true);
      expect((await get("/download/mac/1.1.0-111")).rawPayload.equals(dmg)).toBe(true);
      expect((await get("/download/mac/1.1.0")).rawPayload.equals(dmg)).toBe(true); // newest build of that version

      const intel = await get("/download/mac-intel/latest");
      expect(intel.headers["content-disposition"]).toBe('attachment; filename="Agent Workstation-1.1.0-intel.dmg"');
      expect(intel.rawPayload.equals(intelDmg)).toBe(true);
      expect((await get("/download/mac-intel/1.1.0-112")).statusCode).toBe(200);
    });

    it("404s for an unknown platform, version or build, and for a platform without releases", async () => {
      await seed();
      for (const url of ["/download/mac/9.9.9", "/download/mac/1.0.0-101", "/download/mac/1.0", "/download/windows/latest", "/download/mac-intel/1.0.0"]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(res.json().code).toBe("not_found");
      }
      rmSync(join(releasesDir, "mac-intel"), { recursive: true });
      expect((await get("/download/mac-intel/latest")).statusCode).toBe(404);
    });

    it("refuses path traversal and malformed versions", async () => {
      await seed();
      writeFileSync(join(releasesDir, "AgentWorkstation.dmg"), "secret");
      const urls = [
        "/download/mac/..",
        "/download/mac/%2e%2e",
        "/download/mac/..%2fAgentWorkstation.dmg",
        "/download/mac/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/download/mac/1.0.0%2f..%2f..%2f..",
        "/download/mac/1.0.0%00",
        "/download/mac/.hidden",
        "/download/mac/a%5cb",
        `/download/mac/${"1".repeat(200)}`,
        "/download/..%2fmac/latest",
        "/download/mac/latest/extra",
      ];
      for (const url of urls) {
        const res = await get(url);
        // 414: fastify's own param length limit; 200 only when ".." collapses the URL to /download (the web page, never a file)
        expect([200, 400, 404, 414], url).toContain(res.statusCode);
        if (res.statusCode === 200) expect(String(res.headers["content-type"]), url).toMatch(/^text\/html/);
        expect(res.rawPayload.toString()).not.toBe("secret");
        expect(res.headers["content-type"], url).not.toBe("application/x-apple-diskimage");
      }
      // a folder in the platform dir that is not a valid release folder name is never served
      mkdirSync(join(releasesDir, "mac", ".tmp"), { recursive: true });
      writeFileSync(join(releasesDir, "mac", ".tmp", "release.json"), JSON.stringify(release({ version: "0.0.1", build: "1" })));
      expect((await get("/download/mac/0.0.1")).statusCode).toBe(404);
    });

    it("the old redirect /download is gone (the web serves that page)", async () => {
      await start();
      const res = await get("/download");
      expect(res.statusCode).not.toBe(302);
      expect(res.headers.location).toBeUndefined();
    });
  });

  describe("migration of the flat layout", () => {
    const flat = (dir: string, r: Record<string, unknown> = release()) => {
      mkdirSync(join(dir, "mac"), { recursive: true });
      writeFileSync(join(dir, "mac", "AgentWorkstation.dmg"), dmg);
      writeFileSync(join(dir, "mac", "release.json"), JSON.stringify(r));
    };

    it("moves mac/{AgentWorkstation.dmg,release.json} into mac/<version>-<build>/ on start", async () => {
      await start((dir) => flat(dir));
      expect(existsSync(join(releasesDir, "mac", "AgentWorkstation.dmg"))).toBe(false);
      expect(existsSync(join(releasesDir, "mac", "release.json"))).toBe(false);
      expect(readdirSync(join(releasesDir, "mac", "1.2.3-202610311200")).sort()).toEqual(["AgentWorkstation.dmg", "release.json"]);
      expect((await get("/api/app/mac/latest")).json()).toEqual(release());
      expect((await get("/api/app/mac/download")).rawPayload.equals(dmg)).toBe(true);
      expect((await get("/download/mac/1.2.3")).statusCode).toBe(200);
    });

    it("keeps older versions next to the migrated one", async () => {
      await start((dir) => {
        flat(dir);
        const old = join(dir, "mac", "1.0.0-100");
        mkdirSync(old);
        writeFileSync(join(old, "AgentWorkstation.dmg"), dmg);
        writeFileSync(join(old, "release.json"), JSON.stringify(release({ version: "1.0.0", build: "100" })));
      });
      expect((await get("/api/app/releases")).json().releases.map((r: { build: string }) => r.build)).toEqual(["202610311200", "100"]);
    });

    it("leaves invalid or incomplete flat files alone, and never overwrites a kept version", async () => {
      await start((dir) => {
        mkdirSync(join(dir, "mac"), { recursive: true });
        writeFileSync(join(dir, "mac", "release.json"), "{not json");
        writeFileSync(join(dir, "mac", "AgentWorkstation.dmg"), dmg);
      });
      expect(existsSync(join(releasesDir, "mac", "AgentWorkstation.dmg"))).toBe(true);
      expect((await get("/api/app/mac/latest")).statusCode).toBe(404);
      await fx.close();

      await start((dir) => {
        flat(dir);
        const kept = join(dir, "mac", "1.2.3-202610311200");
        mkdirSync(kept);
        writeFileSync(join(kept, "AgentWorkstation.dmg"), "kept");
        writeFileSync(join(kept, "release.json"), "kept");
      });
      expect(existsSync(join(releasesDir, "mac", "AgentWorkstation.dmg"))).toBe(true);
      expect(readdirSync(join(releasesDir, "mac", "1.2.3-202610311200")).length).toBe(2);
    });
  });

  it("every app route is open: no user header needed", async () => {
    await start();
    put();
    for (const url of ["/api/app/mac/latest", "/api/app/mac/download", "/api/app/mac-intel/latest", "/api/app/releases", "/download/mac/latest", "/download/mac/1.2.3-202610311200"]) {
      const res = await get(url);
      expect(res.statusCode, url).not.toBe(401);
      expect(res.statusCode, url).not.toBe(403);
    }
  });
});
