/**
 * Minimal ZIP reader (central directory, stored + deflate entries) so a skill archive can be imported in the
 * browser without a dependency. Deflate goes through the platform `DecompressionStream("deflate-raw")`.
 * ZIP64, encryption and multi-disk archives are rejected.
 */
export interface ZipEntry {
  name: string;
  /** Uncompressed bytes. */
  data(): Promise<Uint8Array>;
  size: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot unzip compressed archives");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as BufferSource).then(() => writer.close()).catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export function readZip(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // End of central directory: scan backwards (a comment of up to 64 KiB may follow it).
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives are not supported");
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.byteLength || view.getUint32(p, true) !== SIG_CEN) throw new Error("corrupt zip directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry
    entries.push({
      name,
      size,
      data: async () => {
        if (flags & 1) throw new Error("encrypted zip entries are not supported");
        if (localOffset + 30 > buffer.byteLength || view.getUint32(localOffset, true) !== SIG_LOC) throw new Error("corrupt zip entry");
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const raw = bytes.subarray(start, start + compSize);
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`unsupported zip compression method ${method}`);
      },
    });
  }
  return entries;
}

/** The SKILL.md of a skill archive: at the root or inside a single top-level folder (shallowest wins; other files are returned as `others`). */
export function findSkillMd(entries: readonly ZipEntry[]): { skill: ZipEntry | null; others: number } {
  const candidates = entries.filter((e) => /(^|\/)SKILL\.md$/i.test(e.name) && !e.name.startsWith("__MACOSX/")).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  const skill = candidates[0] ?? null;
  const others = entries.filter((e) => e !== skill && !e.name.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(e.name)).length;
  return { skill, others };
}
