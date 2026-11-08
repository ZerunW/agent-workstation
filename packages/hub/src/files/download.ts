/**
 * Downloads: a single file streams as-is; a directory or several paths are
 * streamed as a zip (archiver, never buffered). Symlinks are skipped while
 * zipping so a link can never pull in files from outside the workspace.
 */
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import type { Logger } from "../util/log.js";
import { mediaTypeFor } from "./mime.js";
import { resolveInRoot } from "./paths.js";

export type DownloadPlan =
  | { kind: "file"; abs: string; name: string; size: number; mediaType: string }
  | { kind: "zip"; name: string; items: { abs: string; name: string; dir: boolean }[] };

export async function planDownload(root: string, paths: string[]): Promise<DownloadPlan> {
  const resolved = [];
  for (const p of paths) resolved.push(await resolveInRoot(root, p, { mustExist: true }));
  if (resolved.length === 1) {
    const r = resolved[0]!;
    const st = await stat(r.abs);
    const name = basename(r.abs);
    if (st.isFile()) return { kind: "file", abs: r.abs, name, size: st.size, mediaType: mediaTypeFor(r.abs) };
    return { kind: "zip", name: `${name}.zip`, items: [{ abs: r.abs, name, dir: true }] };
  }
  const items: { abs: string; name: string; dir: boolean }[] = [];
  const used = new Set<string>();
  for (const r of resolved) {
    let name = basename(r.abs);
    for (let i = 2; used.has(name); i++) name = `${basename(r.abs)}-${i}`;
    used.add(name);
    items.push({ abs: r.abs, name, dir: (await stat(r.abs)).isDirectory() });
  }
  return { kind: "zip", name: "download.zip", items };
}

async function* walkFiles(abs: string, name: string): AsyncGenerator<{ abs: string; name: string }> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.length === 0) {
    yield { abs: "", name: `${name}/` }; // keep empty dirs
    return;
  }
  for (const e of entries) {
    const childAbs = join(abs, e.name);
    const childName = `${name}/${e.name}`;
    const st = await lstat(childAbs).catch(() => null);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walkFiles(childAbs, childName);
    else if (st.isFile()) yield { abs: childAbs, name: childName };
  }
}

/** Returns a readable zip stream; entries are appended lazily. */
export function zipStream(plan: Extract<DownloadPlan, { kind: "zip" }>, log: Logger): Readable {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("warning", (err) => log.warn({ err: String(err) }, "zip warning"));
  archive.on("error", (err) => log.error({ err: String(err) }, "zip error"));
  void (async () => {
    try {
      for (const item of plan.items) {
        if (!item.dir) {
          archive.file(item.abs, { name: item.name });
          continue;
        }
        for await (const f of walkFiles(item.abs, item.name)) {
          if (!f.abs) archive.append("", { name: f.name });
          else archive.file(f.abs, { name: f.name });
        }
      }
      await archive.finalize();
    } catch (err) {
      archive.abort();
      log.error({ err: String(err) }, "zip build failed");
    }
  })();
  return archive;
}

/** RFC 6266 Content-Disposition with a UTF-8 filename. */
export function contentDisposition(kind: "attachment" | "inline", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
