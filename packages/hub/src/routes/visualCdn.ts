/**
 * GET /api/visual-cdn/:host/* — the script libraries HTML visuals may load (`cdnjs.cloudflare.com/ajax/libs/…`,
 * `cdn.jsdelivr.net/npm/…`), fetched by the server and cached on its disk. The web UI rewrites those URLs in a visual to
 * this route, so a person's device never contacts a CDN: everything it loads comes from the hub.
 *
 * Open route (the visual's sandboxed frame has an opaque origin and cannot send the user header); still reachable only
 * by callers the hub lets in at all (not the LAN under `lan_access = "deny"`). Only the two hosts and path prefixes above, no query strings, scripts / styles /
 * fonts / JSON / wasm, at most 8 MB per file (the upstream body is read as a stream and the download is aborted past
 * that). Redirects are followed by hand: at most 3, each only to https on the same host; anything else is a 502 and is
 * never requested. The cache is a cache, not user data: it holds at most MAX_CACHE_BYTES and MAX_CACHE_FILES, and a new file
 * evicts the least recently used ones to make room (a file is re-downloaded when it is needed again). At most
 * MAX_DOWNLOADS libraries are fetched from the CDNs at the same time; further requests wait their turn, and when
 * too many wait they get 503.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../util/errors.js";

export const VISUAL_CDN_PREFIX = "/api/visual-cdn";
const ALLOWED: Record<string, string> = { "cdnjs.cloudflare.com": "ajax/libs/", "cdn.jsdelivr.net": "npm/" };
const MAX_BYTES = 8 * 1024 * 1024;
/** The cache holds at most this many bytes (files and their .json notes) or files; the least recently used are evicted. */
export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const MAX_CACHE_FILES = 500;
/** Upstream downloads in progress at the same time, and how many requests may wait for a turn. */
export const MAX_DOWNLOADS = 4;
const MAX_WAITING = 64;
const TIMEOUT_MS = 15_000;
/** Redirects followed per library (each to the same host over https, see fetchFollowing). */
const MAX_REDIRECTS = 3;
const SAFE_PATH = /^[A-Za-z0-9@._+~\-/]{1,400}$/;
const TYPES = [/javascript/i, /^text\/css/i, /json/i, /^application\/wasm/i, /^font\//i, /^application\/font/i, /^application\/x-font/i];

/** `cdn.jsdelivr.net` + `npm/chart.js@4.4.1/dist/chart.umd.min.js` → the upstream URL, or null when not allowed. */
export function visualCdnUpstream(host: string, path: string): string | null {
  const prefix = ALLOWED[host];
  if (!prefix || !path.startsWith(prefix) || !SAFE_PATH.test(path)) return null;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return `https://${host}/${path}`;
}

/** The response body, read as a stream: more than MAX_BYTES aborts the download at once (413). */
async function readCapped(res: Response, abort: AbortController): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "too_large", "larger than 8 MB");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "upstream_error", "the CDN download failed or timed out");
  }
  return Buffer.concat(chunks);
}

interface Cached {
  contentType: string;
  body: Buffer;
}

export function registerVisualCdnRoutes(
  app: FastifyInstance,
  opts: { cacheDir: string; fetch?: typeof fetch; maxBytes?: number; maxFiles?: number; maxDownloads?: number; maxWaiting?: number },
): void {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_CACHE_BYTES;
  const maxFiles = opts.maxFiles ?? MAX_CACHE_FILES;
  const maxDownloads = opts.maxDownloads ?? MAX_DOWNLOADS;
  const maxWaiting = opts.maxWaiting ?? MAX_WAITING;

  // ---- the cache's index: key → bytes on disk (file and note) and a use counter, least recently used first to go.
  const index = new Map<string, { bytes: number; seq: number }>();
  let bytesHeld = 0;
  let seq = 0;
  let indexed: Promise<void> | null = null;
  /** What the cache holds on disk (read on first use; files by modification time, which hits refresh). */
  const loadIndex = (): Promise<void> =>
    (indexed ??= (async () => {
      const found: Array<{ key: string; bytes: number; mtime: number }> = [];
      try {
        for (const name of await readdir(opts.cacheDir)) {
          if (name.endsWith(".json") || name.endsWith(".tmp")) continue;
          const st = await stat(join(opts.cacheDir, name)).catch(() => null);
          if (!st) continue;
          const note = await stat(join(opts.cacheDir, `${name}.json`)).catch(() => null);
          found.push({ key: name, bytes: st.size + (note?.size ?? 0), mtime: st.mtimeMs });
        }
      } catch {
        // no cache folder yet
      }
      found.sort((a, b) => a.mtime - b.mtime);
      for (const f of found) {
        index.set(f.key, { bytes: f.bytes, seq: ++seq });
        bytesHeld += f.bytes;
      }
    })());
  /** Inserts and evictions run one at a time so the counts stay true. */
  let queue: Promise<void> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const evictOne = async (): Promise<boolean> => {
    let oldest: string | null = null;
    for (const [key, e] of index) if (oldest === null || e.seq < index.get(oldest)!.seq) oldest = key;
    if (oldest === null) return false;
    const e = index.get(oldest)!;
    index.delete(oldest);
    bytesHeld -= e.bytes;
    await rm(join(opts.cacheDir, oldest), { force: true });
    await rm(join(opts.cacheDir, `${oldest}.json`), { force: true });
    return true;
  };
  async function store(key: string, body: Buffer, contentType: string, url: string): Promise<void> {
    const note = JSON.stringify({ contentType, url });
    const bytes = body.length + note.length;
    if (bytes > maxBytes) return; // bigger than the whole cache: served without being kept
    await loadIndex();
    while ((index.size >= maxFiles || bytesHeld + bytes > maxBytes) && (await evictOne())) {
      // make room, least recently used first
    }
    await mkdir(opts.cacheDir, { recursive: true });
    const file = join(opts.cacheDir, key);
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
    await writeFile(`${file}.json`, note);
    const old = index.get(key);
    if (old) bytesHeld -= old.bytes;
    index.set(key, { bytes, seq: ++seq });
    bytesHeld += bytes;
  }
  const touch = (key: string): void => {
    const e = index.get(key);
    if (e) e.seq = ++seq;
    const now = new Date();
    void utimes(join(opts.cacheDir, key), now, now).catch(() => undefined);
  };

  // ---- at most `maxDownloads` upstream downloads at once; the rest wait (up to `maxWaiting` of them)
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < maxDownloads) {
      active += 1;
      return;
    }
    if (waiting.length >= maxWaiting) throw new HttpError(503, "upstream_error", "too many library downloads in progress; try again shortly");
    await new Promise<void>((resolve) => waiting.push(resolve)); // the slot is handed over with `active` unchanged
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const pending = new Map<string, Promise<Cached>>();

  /**
   * GET `url`, following at most MAX_REDIRECTS redirects, each only when its Location resolves (against the current URL)
   * to https on exactly `host` (no other port, no credentials). Anything else is refused before it is requested.
   */
  async function fetchFollowing(url: string, host: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hops = 0; ; hops++) {
      const res = await doFetch(current, { redirect: "manual", signal });
      if (res.status < 300 || res.status >= 400) return res;
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location || hops >= MAX_REDIRECTS) throw new HttpError(502, "upstream_error", hops >= MAX_REDIRECTS ? "the CDN redirected too many times" : "the CDN sent a redirect without a target");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpError(502, "upstream_error", "the CDN sent a redirect to an invalid address");
      }
      if (next.protocol !== "https:" || next.hostname !== host || next.port !== "" || next.username !== "" || next.password !== "") {
        throw new HttpError(502, "upstream_error", "the CDN redirected elsewhere");
      }
      current = next.href;
    }
  }

  async function load(url: string, host: string): Promise<Cached> {
    const key = createHash("sha256").update(url).digest("hex");
    const file = join(opts.cacheDir, key);
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, "utf8")) as { contentType: string };
      const body = await readFile(file);
      touch(key);
      return { contentType: meta.contentType, body };
    } catch {
      // not cached (or evicted a moment ago)
    }
    await acquire();
    let body: Buffer;
    let contentType: string;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      try {
        const res = await fetchFollowing(url, host, abort.signal);
        if (res.status === 404) throw new HttpError(404, "not_found", "no such file on the CDN");
        if (!res.ok) throw new HttpError(502, "upstream_error", `the CDN answered ${res.status}`);
        contentType = res.headers.get("content-type") ?? "";
        if (!TYPES.some((t) => t.test(contentType))) throw new HttpError(415, "unsupported", `not a script, style or font (${contentType || "no type"})`);
        if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new HttpError(413, "too_large", "larger than 8 MB");
        body = await readCapped(res, abort);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
    // Keeping it is best effort: a disk problem must not fail the request.
    await exclusive(() => store(key, body, contentType, url)).catch(() => undefined);
    return { contentType, body };
  }

  app.get<{ Params: { host: string; "*": string } }>(`${VISUAL_CDN_PREFIX}/:host/*`, async (req, reply) => {
    if (req.url.includes("?")) throw new HttpError(400, "invalid_request", "no query strings");
    const url = visualCdnUpstream(req.params.host, req.params["*"]);
    if (!url) throw new HttpError(404, "not_found", "only cdnjs.cloudflare.com/ajax/libs/ and cdn.jsdelivr.net/npm/ files");
    let p = pending.get(url);
    if (!p) {
      p = load(url, req.params.host).finally(() => pending.delete(url));
      pending.set(url, p);
    }
    const { contentType, body } = await p;
    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", "public, max-age=86400");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(body);
  });
}
