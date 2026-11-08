/**
 * AgentWorkstation.app releases for the Mac, one channel per CPU: `mac` (Apple Silicon, arm64; also what already installed apps
 * query) and `mac-intel` (x86_64). Open routes like /healthz (no user header):
 *
 *   GET /api/app/:platform/latest      newest release.json of the platform
 *   GET /api/app/:platform/download    newest .dmg
 *   GET /api/app/releases              every release, newest first per platform
 *   GET /download/:platform/:version   that version's .dmg (`latest`, `<version>` or `<version>-<build>`)
 *
 * Storage: `<releasesDir>/<platform>/<version>-<build>/{AgentWorkstation.dmg,release.json}`. Every version stays; the hub never
 * deletes anything. "Latest" = the highest build. The old flat `mac/{AgentWorkstation.dmg,release.json}` is moved into its
 * versioned folder on start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { AppPlatform, AppRelease, type AppReleasesResponse } from "@agent-workstation/protocol";
import type { Hub } from "../hub.js";
import { badRequest, notFound } from "../util/errors.js";

const NO_RELEASE = "no Mac release published";
const PLATFORMS = AppPlatform.options;
const ARCH: Record<AppPlatform, string> = { mac: "arm64", "mac-intel": "intel" };
/** Folder names the hub looks at (and writes when migrating); anything else under a platform folder is ignored. */
const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
/** What a download URL may carry as the version (`latest`, `1.2.3`, `1.2.3-202610311200`). Never used as a path. */
const VERSION_PARAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DMG = "AgentWorkstation.dmg";
const JSON_FILE = "release.json";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const dirNameOf = (r: Pick<AppRelease, "version" | "build">) => `${r.version.replace(/[^A-Za-z0-9._+-]/g, "_")}-${r.build}`;
const byBuildDesc = (a: AppRelease, b: AppRelease) => {
  const x = BigInt(a.build);
  const y = BigInt(b.build);
  return x === y ? 0 : x > y ? -1 : 1;
};

function parseRelease(text: string): AppRelease | null {
  try {
    const parsed = AppRelease.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON
  }
}

/** Moves the old flat `mac/{AgentWorkstation.dmg,release.json}` into `mac/<version>-<build>/` (dmg first, json last). */
export function migrateFlatRelease(releasesDir: string): boolean {
  const dir = join(releasesDir, "mac");
  const flatJson = join(dir, JSON_FILE);
  const flatDmg = join(dir, DMG);
  if (!existsSync(flatJson) || !existsSync(flatDmg)) return false;
  let release: AppRelease | null;
  try {
    release = parseRelease(readFileSync(flatJson, "utf8"));
  } catch {
    return false;
  }
  if (!release || release.platform !== "mac") return false;
  const target = join(dir, dirNameOf(release));
  if (existsSync(join(target, JSON_FILE)) || existsSync(join(target, DMG))) return false; // never overwrite a kept version
  mkdirSync(target, { recursive: true });
  renameSync(flatDmg, join(target, DMG));
  renameSync(flatJson, join(target, JSON_FILE));
  return true;
}

interface Entry {
  release: AppRelease;
  dmgFile: string;
}

export function registerAppReleaseRoutes(app: FastifyInstance, hub: Hub): void {
  const root = hub.config.paths.releasesDir;
  try {
    if (migrateFlatRelease(root)) hub.log.info("moved the flat Mac release into its versioned folder");
  } catch (err) {
    hub.log.warn(`could not migrate the flat Mac release: ${err instanceof Error ? err.message : String(err)}`);
  }

  // release.json re-read only when its mtime/size changes. Null = invalid.
  const cache = new Map<string, { mtimeMs: number; size: number; release: AppRelease | null }>();
  async function readRelease(file: string): Promise<AppRelease | null> {
    let st;
    try {
      st = await stat(file);
    } catch {
      cache.delete(file);
      return null;
    }
    if (!st.isFile()) return null;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.release;
    let release: AppRelease | null = null;
    try {
      release = parseRelease(await readFile(file, "utf8"));
    } catch {
      // unreadable
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, release });
    return release;
  }

  /** Every valid release of a platform, newest (highest build) first. */
  async function list(platform: AppPlatform): Promise<Entry[]> {
    const base = join(root, platform);
    let names: string[];
    try {
      names = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && DIR_NAME.test(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
    const found = await Promise.all(
      names.map(async (name): Promise<Entry | null> => {
        const release = await readRelease(join(base, name, JSON_FILE));
        return release && release.platform === platform ? { release, dmgFile: join(base, name, DMG) } : null;
      }),
    );
    return found.filter((e): e is Entry => e !== null).sort((a, b) => byBuildDesc(a.release, b.release));
  }

  function platformOf(raw: string): AppPlatform {
    const parsed = AppPlatform.safeParse(raw);
    if (!parsed.success) throw notFound(`unknown platform: ${raw.slice(0, 32)}`);
    return parsed.data;
  }

  async function sendDmg(reply: FastifyReply, entry: Entry, filename: string) {
    let handle;
    try {
      handle = await open(entry.dmgFile, "r");
    } catch {
      throw notFound(NO_RELEASE);
    }
    try {
      // fstat on the open file: size and bytes come from the same inode even if deploy swaps the file meanwhile.
      const st = await handle.stat();
      if (!st.isFile() || st.size !== entry.release.sizeBytes) throw notFound("release files do not match"); // stale pair
      const stream = handle.createReadStream(); // closes the handle when done
      return reply
        .header("content-type", "application/x-apple-diskimage")
        .header("content-length", st.size)
        .header("content-disposition", `attachment; filename="${filename}"`)
        .header("cache-control", "no-store")
        .send(stream);
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  app.get("/api/app/releases", async (_req, reply): Promise<AppReleasesResponse> => {
    const lists = await Promise.all(PLATFORMS.map(list));
    void reply.header("cache-control", "no-store");
    return { releases: lists.flat().map((e) => e.release) };
  });

  app.get<{ Params: { platform: string } }>("/api/app/:platform/latest", async (req, reply): Promise<AppRelease> => {
    const latest = (await list(platformOf(req.params.platform)))[0];
    if (!latest) throw notFound(NO_RELEASE);
    void reply.header("cache-control", "no-store");
    return latest.release;
  });

  app.get<{ Params: { platform: string } }>("/api/app/:platform/download", async (req, reply) => {
    const latest = (await list(platformOf(req.params.platform)))[0];
    if (!latest) throw notFound(NO_RELEASE);
    return sendDmg(reply, latest, `Agent Workstation-${safe(latest.release.version)}-${safe(latest.release.build)}.dmg`);
  });

  app.get<{ Params: { platform: string; version: string } }>("/download/:platform/:version", async (req, reply) => {
    const platform = platformOf(req.params.platform);
    const wanted = req.params.version;
    if (!VERSION_PARAM.test(wanted)) throw badRequest("bad_version", "invalid version");
    const entries = await list(platform);
    // `wanted` is only compared with what release.json says; the file path comes from the directory listing.
    const entry =
      wanted === "latest"
        ? entries[0]
        : (entries.find((e) => `${e.release.version}-${e.release.build}` === wanted) ?? entries.find((e) => e.release.version === wanted));
    if (!entry) throw notFound(`no ${platform} release ${wanted}`);
    return sendDmg(reply, entry, `Agent Workstation-${safe(entry.release.version)}-${ARCH[platform]}.dmg`);
  });
}
