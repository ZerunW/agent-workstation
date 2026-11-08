import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadFile = vi.fn(async (file: File, opts: { path: string; onProgress?: (p: { sentBytes: number; totalBytes: number; chunksDone: number; chunksTotal: number }) => void }) => {
  opts.onProgress?.({ sentBytes: file.size, totalBytes: file.size, chunksDone: 1, chunksTotal: 1 });
  return { path: opts.path, uploadId: "u" };
});
vi.mock("./upload", () => ({ uploadFile: (...a: unknown[]) => uploadFile(...(a as [File, { path: string }])) }));

import { useApp } from "../store/app";
import { useToasts } from "../store/toasts";
import { collectFolder, dropEntries, handleFolderDrop, MAX_FOLDER_BYTES, MAX_FOLDER_FILES, uploadFolder } from "./folderDrop";

type Node = { name: string; size?: number; children?: Node[] };

/** A FileSystemEntry tree; readEntries hands out two entries per call, like a browser's batches. */
function entry(node: Node): FileSystemEntry {
  if (!node.children) {
    return { name: node.name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(fakeFile(node.name, node.size ?? 1)) } as unknown as FileSystemEntry;
  }
  const kids = node.children.map(entry);
  return {
    name: node.name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          const batch = kids.slice(at, at + 2);
          at += 2;
          ok(batch);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function fakeFile(name: string, size: number): File {
  const f = new File([""], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const dir = (name: string, ...children: Node[]): Node => ({ name, children });
const file = (name: string, size = 1): Node => ({ name, size });

function dropOf(...nodes: Node[]): DataTransfer {
  return { items: nodes.map((n) => ({ kind: "file", webkitGetAsEntry: () => entry(n) })), files: nodes.map((n) => fakeFile(n.name, 0)) } as unknown as DataTransfer;
}

const toasts = () => useToasts.getState().toasts;

beforeEach(() => {
  uploadFile.mockClear();
  useToasts.setState({ toasts: [] });
  useApp.setState({ disk: null });
  delete window.__workstationShell;
});

describe("collectFolder", () => {
  it("walks recursively across read batches and keeps relative paths", async () => {
    const root = entry(dir("proj", file("a.txt"), dir("src", file("b.ts"), dir("deep", file("c.ts"))), file("d.txt"), file("e.txt"))) as FileSystemDirectoryEntry;
    const files = await collectFolder(root);
    expect(files.map((f) => f.rel).sort()).toEqual(["a.txt", "d.txt", "e.txt", "src/b.ts", "src/deep/c.ts"]);
  });

  it("skips .git, node_modules and .DS_Store at any depth", async () => {
    const root = entry(
      dir("proj", file("keep.txt"), file(".DS_Store"), dir(".git", file("HEAD")), dir("node_modules", file("x.js")), dir("sub", file("ok.txt"), file(".DS_Store"), dir("node_modules", file("y.js")))),
    ) as FileSystemDirectoryEntry;
    expect((await collectFolder(root)).map((f) => f.rel).sort()).toEqual(["keep.txt", "sub/ok.txt"]);
  });

  it("rejects more than 2,000 files", async () => {
    const ok = entry(dir("p", ...Array.from({ length: MAX_FOLDER_FILES }, (_, i) => file(`f${i}`)))) as FileSystemDirectoryEntry;
    expect(await collectFolder(ok)).toHaveLength(MAX_FOLDER_FILES);
    const many = entry(dir("p", ...Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => file(`f${i}`)))) as FileSystemDirectoryEntry;
    await expect(collectFolder(many)).rejects.toThrow("too large");
  });

  it("rejects more than 500 MB", async () => {
    const big = entry(dir("p", file("a", MAX_FOLDER_BYTES), file("b", 1))) as FileSystemDirectoryEntry;
    await expect(collectFolder(big)).rejects.toThrow("too large");
  });
});

describe("uploadFolder", () => {
  it("uploads to inbox/<name>/<relative path> and reports progress", async () => {
    const root = entry(dir("proj", file("a.txt", 10), dir("src", file("b.ts", 30)), dir(".git", file("HEAD")))) as FileSystemDirectoryEntry;
    expect(await uploadFolder(root)).toBe("inbox/proj");
    expect(uploadFile.mock.calls.map((c) => c[1].path).sort()).toEqual(["inbox/proj/a.txt", "inbox/proj/src/b.ts"]);
    const t = toasts()[0]!;
    expect(t.tone).toBe("success");
    expect(t.progress).toBe(1);
  });

  it("uploads empty files of the folder (they are real files)", async () => {
    const root = entry(dir("proj", file("__init__.py", 0))) as FileSystemDirectoryEntry;
    expect(await uploadFolder(root)).toBe("inbox/proj");
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("over the caps: one error toast, nothing uploaded", async () => {
    const root = entry(dir("big", ...Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => file(`f${i}`)))) as FileSystemDirectoryEntry;
    expect(await uploadFolder(root)).toBeNull();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ tone: "error", title: expect.stringContaining("2,000 files / 500 MB") });
  });

  it("a failed upload is an error toast and no path", async () => {
    uploadFile.mockRejectedValueOnce(new Error("boom"));
    const root = entry(dir("proj", file("a.txt"))) as FileSystemDirectoryEntry;
    expect(await uploadFolder(root)).toBeNull();
    expect(toasts()[0]).toMatchObject({ tone: "error", title: expect.stringContaining("boom") });
  });
});

describe("handleFolderDrop", () => {
  it("a dropped folder is handled as a folder: uploaded, then the new Code route opens", async () => {
    const navigate = vi.fn();
    expect(handleFolderDrop(dropOf(dir("my proj", file("a.txt"))), navigate)).toBe(true);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/?new=code&cwd=inbox%2Fmy+proj"));
    // only the folder's real file went up: never the 0-byte stand-in for the folder
    expect(uploadFile.mock.calls.map((c) => c[1].path)).toEqual(["inbox/my proj/a.txt"]);
  });

  it("plain file drops are left to the file path", () => {
    const navigate = vi.fn();
    expect(handleFolderDrop(dropOf(file("a.txt", 5)), navigate)).toBe(false);
    expect(handleFolderDrop({ items: [], files: [] } as unknown as DataTransfer, navigate)).toBe(false);
    expect(handleFolderDrop(null, navigate)).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("browsers without webkitGetAsEntry fall back to files", () => {
    const dt = { items: [{ kind: "file" }], files: [fakeFile("x", 3)] } as unknown as DataTransfer;
    expect(dropEntries(dt)).toEqual([]);
    expect(handleFolderDrop(dt, vi.fn())).toBe(false);
  });

  it("inside the app a folder that reaches the page is swallowed, never uploaded", async () => {
    window.__workstationShell = { pickFolder: () => {} };
    const navigate = vi.fn();
    expect(handleFolderDrop(dropOf(dir("proj", file("a.txt"))), navigate)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(uploadFile).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
