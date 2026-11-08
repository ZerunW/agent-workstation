import { describe, expect, it, vi } from "vitest";
import { UPLOAD_CHUNK_BYTES } from "@agent-workstation/protocol";
import { ApiError, encodeHeaderPath } from "./api";
import { planChunks, uploadFile } from "./upload";

describe("planChunks", () => {
  it("splits on the 4 MB boundary by default", () => {
    const size = UPLOAD_CHUNK_BYTES * 2 + 10;
    const plan = planChunks(size);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual({ index: 0, start: 0, end: UPLOAD_CHUNK_BYTES });
    expect(plan[2]).toEqual({ index: 2, start: UPLOAD_CHUNK_BYTES * 2, end: size });
  });
  it("makes exactly N chunks for an exact multiple and one empty chunk for an empty file", () => {
    expect(planChunks(UPLOAD_CHUNK_BYTES * 2)).toHaveLength(2);
    expect(planChunks(0)).toEqual([{ index: 0, start: 0, end: 0 }]);
    expect(planChunks(5, 5)).toHaveLength(1);
    expect(planChunks(6, 5)).toHaveLength(2);
  });
});

function fakeFile(size: number, name = "a.bin") {
  const blob = new Blob([new Uint8Array(size)]);
  return Object.assign(blob, { name, lastModified: 1 });
}

describe("uploadFile", () => {
  it("uploads every chunk in order with the same uploadId and reports progress", async () => {
    const calls: Array<{ index: number; total: number; uploadId: string; size: number; path: string; totalBytes: number }> = [];
    const sendChunk = vi.fn(async (a: any) => {
      calls.push({ index: a.index, total: a.total, uploadId: a.uploadId, size: a.body.size, path: a.path, totalBytes: a.totalBytes });
      return { uploadId: a.uploadId, received: [a.index], complete: a.index === a.total - 1, path: a.index === a.total - 1 ? "inbox/a.bin" : undefined };
    });
    const progress: number[] = [];
    const res = await uploadFile(fakeFile(25), { path: "inbox/a.bin", chunkBytes: 10, sendChunk: sendChunk as any, onProgress: (p) => progress.push(p.sentBytes) });
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(calls.map((c) => c.size)).toEqual([10, 10, 5]);
    expect(new Set(calls.map((c) => c.uploadId)).size).toBe(1);
    expect(calls.every((c) => c.total === 3 && c.totalBytes === 25 && c.path === "inbox/a.bin")).toBe(true);
    expect(progress[progress.length - 1]).toBe(25);
    expect(res.path).toBe("inbox/a.bin");
  });

  it("retries a failed chunk with backoff, then continues", async () => {
    let failures = 2;
    const sleeps: number[] = [];
    const sendChunk = vi.fn(async (a: any) => {
      if (a.index === 1 && failures-- > 0) throw new ApiError(503, "busy");
      return { uploadId: a.uploadId, received: [a.index], complete: a.index === a.total - 1 };
    });
    await uploadFile(fakeFile(20), { path: "inbox/b.bin", chunkBytes: 10, sendChunk: sendChunk as any, sleep: async (ms) => void sleeps.push(ms) });
    expect(sendChunk).toHaveBeenCalledTimes(4); // chunk0, chunk1 x3
    expect(sleeps).toEqual([400, 800]);
  });

  it("gives up on a non-retriable error (4xx) immediately", async () => {
    const sendChunk = vi.fn(async () => {
      throw new ApiError(507, "disk full", "disk_block");
    });
    await expect(uploadFile(fakeFile(20), { path: "inbox/c.bin", chunkBytes: 10, sendChunk: sendChunk as any, sleep: async () => {} })).rejects.toMatchObject({ code: "disk_block" });
    expect(sendChunk).toHaveBeenCalledTimes(1);
  });

  it("fails after exhausting retries and reuses the uploadId on the next attempt (resume)", async () => {
    const ids: string[] = [];
    const flaky = vi.fn(async (a: any) => {
      ids.push(a.uploadId);
      throw new ApiError(0, "network");
    });
    const f = fakeFile(10, "resume.bin");
    await expect(uploadFile(f, { path: "inbox/resume.bin", chunkBytes: 10, retries: 1, sendChunk: flaky as any, sleep: async () => {} })).rejects.toBeInstanceOf(ApiError);
    const ok = vi.fn(async (a: any) => {
      ids.push(a.uploadId);
      return { uploadId: a.uploadId, received: [0], complete: true };
    });
    await uploadFile(f, { path: "inbox/resume.bin", chunkBytes: 10, sendChunk: ok as any });
    expect(new Set(ids).size).toBe(1);
  });

  it("asks the hub for received chunks when resuming a known upload and only sends the rest", async () => {
    const f = fakeFile(30, "resume2.bin");
    const first = vi.fn(async (a: any) => {
      if (a.index === 1) throw new ApiError(400, "bad");
      return { uploadId: a.uploadId, received: [a.index], complete: false };
    });
    await expect(uploadFile(f, { path: "inbox/resume2.bin", chunkBytes: 10, sendChunk: first as any })).rejects.toBeInstanceOf(ApiError);
    const sent: number[] = [];
    const getStatus = vi.fn(async (id: string) => ({ uploadId: id, received: [0, 1], complete: false }));
    const second = vi.fn(async (a: any) => {
      sent.push(a.index);
      return { uploadId: a.uploadId, received: [a.index], complete: a.index === 2 };
    });
    await uploadFile(f, { path: "inbox/resume2.bin", chunkBytes: 10, sendChunk: second as any, getStatus: getStatus as any });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([2]);
  });

  it("skips chunks the server already has", async () => {
    const sent: number[] = [];
    const sendChunk = vi.fn(async (a: any) => {
      sent.push(a.index);
      return { uploadId: a.uploadId, received: a.index === 0 ? [0, 1] : [a.index], complete: true };
    });
    await uploadFile(fakeFile(30), { path: "inbox/d.bin", chunkBytes: 10, sendChunk: sendChunk as any });
    expect(sent).toEqual([0, 2]);
  });

  it("aborts via signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(uploadFile(fakeFile(10), { path: "inbox/e.bin", signal: ctrl.signal, sendChunk: vi.fn() as any })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("encodeHeaderPath", () => {
  it("leaves ASCII paths verbatim and percent-encodes non-ASCII and %", () => {
    expect(encodeHeaderPath("inbox/report v2.pdf")).toBe("inbox/report v2.pdf");
    expect(encodeHeaderPath("inbox/报告.pdf")).toBe("inbox/%E6%8A%A5%E5%91%8A.pdf");
    expect(encodeHeaderPath("inbox/100%.txt")).toBe("inbox/100%25.txt");
    expect(decodeURIComponent(encodeHeaderPath("inbox/报告 100%.pdf"))).toBe("inbox/报告 100%.pdf");
  });
});
