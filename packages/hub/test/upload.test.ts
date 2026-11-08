import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_BYTES, UPLOAD_HEADERS } from "@agent-workstation/protocol";
import { Store } from "../src/db/store.js";
import { parseUploadHeaders, UploadService } from "../src/files/upload.js";
import { silentLogger } from "../src/util/log.js";
import { tempDir } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function fixture(free: number | null = null) {
  const t = tempDir();
  const store = new Store(":memory:");
  cleanups.push(() => store.close(), t.cleanup);
  const root = join(t.dir, "users", "alice");
  mkdirSync(join(root, "inbox"), { recursive: true });
  const svc = new UploadService({ store, dataDir: join(t.dir, "data"), userRoot: () => root, log: silentLogger, freeBytes: () => free });
  return { store, svc, root, dataDir: join(t.dir, "data") };
}

const headers = (id: string, path: string, index: number, total: number, bytes: number) => ({
  [UPLOAD_HEADERS.uploadId.toLowerCase()]: id,
  [UPLOAD_HEADERS.path.toLowerCase()]: encodeURIComponent(path),
  [UPLOAD_HEADERS.chunkIndex.toLowerCase()]: String(index),
  [UPLOAD_HEADERS.chunkTotal.toLowerCase()]: String(total),
  [UPLOAD_HEADERS.totalBytes.toLowerCase()]: String(bytes),
});

describe("chunked upload", () => {
  it("assembles out-of-order chunks atomically and resumes", async () => {
    const { svc, root, dataDir } = fixture();
    const total = UPLOAD_CHUNK_BYTES * 2 + 1234;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i++) data[i] = (i * 31) % 251;
    const chunks = [0, 1, 2].map((i) => data.subarray(i * UPLOAD_CHUNK_BYTES, Math.min(total, (i + 1) * UPLOAD_CHUNK_BYTES)));
    const id = "upload-abc123";
    const path = "inbox/数据 report.bin";

    const r2 = await svc.putChunk("alice", parseUploadHeaders(headers(id, path, 2, 3, total)), chunks[2]!);
    expect(r2).toMatchObject({ received: [2], complete: false });
    const r0 = await svc.putChunk("alice", parseUploadHeaders(headers(id, path, 0, 3, total)), chunks[0]!);
    expect(r0.received).toEqual([0, 2]);
    // resend (resume) is idempotent
    await svc.putChunk("alice", parseUploadHeaders(headers(id, path, 0, 3, total)), chunks[0]!);
    expect(svc.status("alice", id)).toMatchObject({ received: [0, 2], complete: false });
    expect(existsSync(join(root, path))).toBe(false);

    const r1 = await svc.putChunk("alice", parseUploadHeaders(headers(id, path, 1, 3, total)), chunks[1]!);
    expect(r1).toMatchObject({ complete: true, path, received: [0, 1, 2] });
    expect(readFileSync(join(root, path)).equals(data)).toBe(true);
    expect(existsSync(join(dataDir, "uploads", "alice", id))).toBe(false);
    // a late duplicate chunk just reports completion
    expect(await svc.putChunk("alice", parseUploadHeaders(headers(id, path, 1, 3, total)), chunks[1]!)).toMatchObject({ complete: true, path });
  });

  it("never overwrites an existing file", async () => {
    const { svc, root } = fixture();
    writeFileSync(join(root, "inbox", "a.txt"), "original");
    const r = await svc.putChunk("alice", parseUploadHeaders(headers("upload-dup01", "inbox/a.txt", 0, 1, 3)), Buffer.from("new"));
    expect(r.path).toBe("inbox/a (1).txt");
    expect(readFileSync(join(root, "inbox", "a.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "inbox", "a (1).txt"), "utf8")).toBe("new");
  });

  it("handles empty files and creates parent folders", async () => {
    const { svc, root } = fixture();
    const r = await svc.putChunk("alice", parseUploadHeaders(headers("upload-empty1", "inbox/x/y/empty.txt", 0, 1, 0)), Buffer.alloc(0));
    expect(r.complete).toBe(true);
    expect(readFileSync(join(root, "inbox/x/y/empty.txt")).length).toBe(0);
  });

  it("validates headers, chunk sizes, path escapes, mismatches and free space", async () => {
    const { svc } = fixture();
    expect(() => parseUploadHeaders(headers("short", "inbox/a", 0, 1, 1))).toThrow(/X-Upload-Id/);
    expect(() => parseUploadHeaders(headers("upload-xyz12", "../etc/passwd", 0, 1, 1))).toThrow();
    expect(() => parseUploadHeaders(headers("upload-xyz12", "inbox/a", 0, 2, 10))).toThrow(/chunk total/);
    expect(() => parseUploadHeaders(headers("upload-xyz12", "inbox/a", 1, 1, 1))).toThrow(/out of range/);
    await expect(svc.putChunk("alice", parseUploadHeaders(headers("upload-xyz12", "inbox/a", 0, 1, 5)), Buffer.from("abc"))).rejects.toThrow(/must be 5 bytes/);
    await svc.putChunk("alice", parseUploadHeaders(headers("upload-mis01", "inbox/m", 1, 2, UPLOAD_CHUNK_BYTES + 1)), Buffer.from("z"));
    await expect(svc.putChunk("alice", parseUploadHeaders(headers("upload-mis01", "inbox/other", 0, 2, UPLOAD_CHUNK_BYTES + 1)), Buffer.alloc(UPLOAD_CHUNK_BYTES))).rejects.toMatchObject({ status: 409 });

    const small = fixture(1000);
    await expect(small.svc.putChunk("alice", parseUploadHeaders(headers("upload-big01", "inbox/b", 0, 1, 10)), Buffer.alloc(10))).rejects.toMatchObject({ status: 507, code: "disk_block" });
  });
});
