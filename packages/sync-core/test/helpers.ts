import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { gitBaseEnv } from "../src/git.js";
import { hashBytes, openProject, type OpenProjectOptions, type ProjectRepo, type SyncOp } from "../src/index.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

export async function tmpRoot(): Promise<string> {
  const r = await mkdtemp(path.join(os.tmpdir(), "sync-core-"));
  roots.push(r);
  return r;
}

export type FileSpec = string | Buffer | { content: string | Buffer; mode?: number } | { symlink: string };

export async function writeFiles(dir: string, files: Record<string, FileSpec>): Promise<void> {
  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    if (typeof spec === "object" && !Buffer.isBuffer(spec) && "symlink" in spec) {
      await symlink(spec.symlink, abs);
      continue;
    }
    const content = typeof spec === "string" || Buffer.isBuffer(spec) ? spec : spec.content;
    await writeFile(abs, content);
    if (typeof spec === "object" && !Buffer.isBuffer(spec) && "mode" in spec && spec.mode !== undefined) await chmod(abs, spec.mode);
  }
}

export interface TestProject {
  root: string;
  mac: string;
  repo: ProjectRepo;
  work: string;
  /** Absolute work-tree path. */
  w(rel: string): string;
  read(rel: string): Promise<string>;
  /** Run git against the project's bare repo (for assertions). */
  git(...args: string[]): string;
}

export async function makeProject(files: Record<string, FileSpec> = {}, opts: Partial<OpenProjectOptions> = {}): Promise<TestProject> {
  const root = await tmpRoot();
  const mac = path.join(root, "mac");
  await mkdir(mac, { recursive: true });
  await writeFiles(mac, files);
  const repo = await openProject({ gitDir: path.join(root, "sync", "p.git"), workTree: path.join(root, "work"), ...opts });
  await repo.importBaseline(mac);
  return {
    root,
    mac,
    repo,
    work: repo.workTree,
    w: (rel) => path.join(repo.workTree, rel),
    read: (rel) => readFile(path.join(repo.workTree, rel), "utf8"),
    git: (...args) => gitIn(repo.gitDir, ...args),
  };
}

export function gitIn(gitDir: string, ...args: string[]): string {
  return execFileSync("git", [`--git-dir=${gitDir}`, "-c", "core.quotepath=false", ...args], {
    env: gitBaseEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Content of `rel` on the `local` branch (null if absent). */
export function localContent(p: TestProject, rel: string): string | null {
  try {
    return p.git("show", `refs/heads/local:${rel}`);
  } catch {
    return null;
  }
}

export function localMode(p: TestProject, rel: string): string | null {
  const out = p.git("ls-tree", "--full-tree", "refs/heads/local", "--", rel).trim();
  return out ? out.split(" ")[0]! : null;
}

export function commitCount(p: TestProject): number {
  return Number(p.git("rev-list", "--count", "refs/heads/local").trim());
}

export type WriteOp = Extract<SyncOp, { op: "write" }>;

export function writeOp(
  rel: string,
  content: string | Buffer,
  o: { baseHash?: string | null; mode?: number; force?: boolean; omitContent?: boolean } = {},
): WriteOp {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const op: WriteOp = {
    op: "write",
    path: rel,
    hash: hashBytes(buf),
    size: buf.length,
    mode: o.mode ?? 0o100644,
    baseHash: o.baseHash === undefined ? null : o.baseHash,
  };
  if (!o.omitContent) op.contentBase64 = buf.toString("base64");
  if (o.force) op.force = true;
  return op;
}

export function deleteOp(rel: string, baseHash: string | null, force = false): SyncOp {
  return force ? { op: "delete", path: rel, baseHash, force: true } : { op: "delete", path: rel, baseHash };
}

export const h = (s: string | Buffer): string => hashBytes(s);

export function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

/** Replace 1-based line `no` of `text`. */
export function replaceLine(text: string, no: number, value: string): string {
  const ls = text.split("\n");
  ls[no - 1] = value;
  return ls.join("\n");
}
