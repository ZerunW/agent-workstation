/**
 * Server-side backups of Mac files, and raw bytes of a file at any commit / ref / blob of a project's review repo.
 *
 * POST /api/projects/:id/backups stores the uploaded files as one commit whose tree holds only those files, under
 * `refs/backups/<client-slug>/<timestamp>-<random>` of the project's bare review repo (one `git fast-import` run:
 * blobs, tree and ref in a single process, under the project lock). Nothing else is touched: not `local`, not the
 * work tree, not review, not snapshots or trash (history lists only those), and never pruned — the refs keep the
 * objects reachable for `git gc`. The commit message carries the metadata as `Workstation-*` trailers, including the file
 * list (`Workstation-Files`, JSON), so listing is one `for-each-ref`.
 *
 * Git runs like sync-core runs it: argv only (no shell), `--git-dir`, the pinned config, a sanitised environment.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { ProjectBackup, ProjectBackupBody } from "@agent-workstation/protocol";
import { assertRelPath, gitBlobOid, GIT_CONFIG, withLock, type ProjectRepo } from "@agent-workstation/sync-core";
import { badRequest, HttpError } from "../util/errors.js";

/** At most this many decoded bytes per backup request (the contract's 50 MB). */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_BACKUP_FILES = 500;
export const BACKUP_REF_PREFIX = "refs/backups/";

// ------------------------------------------------------------------ git

let baseEnv: Record<string, string> | null = null;
function gitEnv(): Record<string, string> {
  if (baseEnv) return baseEnv;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Agent Workstation",
    GIT_AUTHOR_EMAIL: "workstation@localhost",
    GIT_COMMITTER_NAME: "Agent Workstation",
    GIT_COMMITTER_EMAIL: "workstation@localhost",
    LC_ALL: "C",
  });
  baseEnv = env;
  return env;
}

const gitArgv = (gitDir: string, args: readonly string[], workTree?: string): string[] => [
  `--git-dir=${gitDir}`,
  ...(workTree ? [`--work-tree=${workTree}`] : []),
  ...GIT_CONFIG.flatMap((c) => ["-c", c]),
  ...args,
];

function spawnGit(gitDir: string, args: readonly string[], o: { workTree?: string; env?: Record<string, string> } = {}) {
  return spawn("git", gitArgv(gitDir, args, o.workTree), { cwd: o.workTree ?? gitDir, env: { ...gitEnv(), ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
}

/** Runs git to completion. Exit codes outside `ok` reject. */
export function git(
  gitDir: string,
  args: readonly string[],
  o: { input?: Buffer | string; ok?: number[]; workTree?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(gitDir, args, o);
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      const c = code ?? -1;
      if (!(o.ok ?? [0]).includes(c)) reject(new Error(`git ${args[0]} exited ${c}: ${stderr.trim().slice(0, 500)}`));
      else resolve({ code: c, stdout: Buffer.concat(out), stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(o.input ?? "");
  });
}

// ------------------------------------------------------------------ backups

/** `mac:Alices-MacBook.local` → `mac-alices-macbook-local` (a safe ref component). */
export function clientSlug(client: string): string {
  return (
    client
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 64)
      .replace(/[-_]+$/, "") || "client"
  );
}

/** C-style quoted path for fast-import (always quoted, so any byte but NUL is safe). */
function quotePath(p: string): string {
  let out = '"';
  for (const ch of p) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

interface DecodedFile {
  path: string;
  data: Buffer;
  mode: "100644" | "100755";
}

/** Validates and decodes a backup body: paths, base64, duplicates, file/directory clashes, the 50 MB limit. */
export function decodeBackup(body: ProjectBackupBody): DecodedFile[] {
  if (body.files.length > MAX_BACKUP_FILES) throw badRequest("invalid_request", `at most ${MAX_BACKUP_FILES} files per backup`);
  let estimate = 0;
  for (const f of body.files) estimate += Math.floor((f.dataBase64.length * 3) / 4);
  if (estimate > MAX_BACKUP_BYTES + 3 * body.files.length) throw new HttpError(413, "too_large", "a backup request holds at most 50 MB of file data; split it");
  const seen = new Set<string>();
  const out: DecodedFile[] = [];
  let total = 0;
  for (const f of body.files) {
    const path = assertRelPath(f.path);
    if (seen.has(path)) throw badRequest("invalid_path", `${path} appears twice in the backup`);
    seen.add(path);
    const b64 = f.dataBase64.replace(/\s+/g, "");
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw badRequest("invalid_request", `${path}: dataBase64 is not valid base64`);
    const data = Buffer.from(b64, "base64");
    total += data.length;
    if (total > MAX_BACKUP_BYTES) throw new HttpError(413, "too_large", "a backup request holds at most 50 MB of file data; split it");
    out.push({ path, data, mode: f.mode !== undefined && (f.mode & 0o111) !== 0 ? "100755" : "100644" });
  }
  for (const p of seen) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (seen.has(dir)) throw badRequest("invalid_path", `${dir} is both a file and a directory in the backup`);
    }
  }
  return out;
}

/** Stores a backup in the project's review repo (refs/backups/…). */
export async function createBackup(repo: ProjectRepo, body: ProjectBackupBody, now: Date = new Date()): Promise<ProjectBackup> {
  const files = decodeBackup(body);
  const at = now.toISOString();
  const id = `${at.replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
  const ref = `${BACKUP_REF_PREFIX}${clientSlug(body.client)}/${id}`;
  const listed = files.map((f) => ({ path: f.path, blob: gitBlobOid(f.data), size: f.data.length }));
  return withLock(repo.lockKey, async () => {
    const local = await repo.localCommit();
    const message =
      [
        `backup: ${body.reason} from ${oneLine(body.client)}`,
        "",
        "Workstation-Kind: backup",
        `Workstation-At: ${at}`,
        `Workstation-Client: ${oneLine(body.client)}`,
        `Workstation-Reason: ${body.reason}`,
        `Workstation-Local: ${local ?? "none"}`,
        `Workstation-Files: ${JSON.stringify(listed)}`,
      ].join("\n") + "\n";
    const parts: Buffer[] = [];
    const text = (s: string) => parts.push(Buffer.from(s, "utf8"));
    files.forEach((f, i) => {
      text(`blob\nmark :${i + 1}\ndata ${f.data.length}\n`);
      parts.push(f.data);
      text("\n");
    });
    const msg = Buffer.from(message, "utf8");
    text(`commit ${ref}\ncommitter Agent Workstation <workstation@localhost> ${Math.floor(now.getTime() / 1000)} +0000\ndata ${msg.length}\n`);
    parts.push(msg);
    text("\n");
    files.forEach((f, i) => text(`M ${f.mode} :${i + 1} ${quotePath(f.path)}\n`));
    text("\ndone\n");
    await git(repo.gitDir, ["fast-import", "--quiet", "--done"], { input: Buffer.concat(parts) });
    const commit = (await git(repo.gitDir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.toString().trim();
    return { id, ref, commit, client: body.client, reason: body.reason, at, files: listed };
  });
}

function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^(Workstation-[A-Za-z]+): (.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const REASONS = new Set(["overwrite", "delete", "manual"]);

/** All backups of the project, newest first. */
export async function listBackups(repo: ProjectRepo): Promise<ProjectBackup[]> {
  const r = await git(repo.gitDir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents)%00", "refs/backups"]);
  const fields = r.stdout.toString("utf8").split("\0");
  const out: ProjectBackup[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const ref = fields[i]!.replace(/^\n/, "");
    const commit = fields[i + 1]!;
    const t = parseTrailers(fields[i + 2]!);
    let files: ProjectBackup["files"] | null = null;
    try {
      const parsed = JSON.parse(t["Workstation-Files"] ?? "null") as unknown;
      if (Array.isArray(parsed)) files = parsed.filter((f): f is ProjectBackup["files"][number] => !!f && typeof f.path === "string" && typeof f.blob === "string" && typeof f.size === "number");
    } catch {
      files = null;
    }
    files ??= await treeFiles(repo.gitDir, commit);
    const reason = t["Workstation-Reason"] ?? "manual";
    out.push({
      id: ref.split("/").pop() ?? ref,
      ref,
      commit,
      client: t["Workstation-Client"] ?? ref.slice(BACKUP_REF_PREFIX.length).split("/")[0] ?? "",
      reason: (REASONS.has(reason) ? reason : "manual") as ProjectBackup["reason"],
      at: t["Workstation-At"] ?? "",
      files,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.ref < b.ref ? 1 : -1));
}

/** Blob files of a commit's tree (fallback when a backup commit carries no file list). */
async function treeFiles(gitDir: string, commit: string): Promise<ProjectBackup["files"]> {
  const r = await git(gitDir, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]);
  const out: ProjectBackup["files"] = [];
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(rec);
    if (m && m[2] === "blob") out.push({ path: m[5]!, blob: m[3]!, size: m[4] === "-" ? 0 : Number(m[4]) });
  }
  return out;
}

// ------------------------------------------------------------------ raw at ref

const HEX_RE = /^[0-9a-f]{7,64}$/i;
const NAMED_REF_RE = /^(?:local|refs\/heads\/local|refs\/(?:backups|snapshots|trash)\/[A-Za-z0-9._\-/]+)$/;

/** A ref the raw route accepts: a hex object id, `local`, or one of the hub's own ref namespaces. */
export function validRawRef(ref: string): boolean {
  if (HEX_RE.test(ref)) return true;
  if (!NAMED_REF_RE.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/")) return false;
  return ref.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

/**
 * The blob `path` names at `ref` (a commit id, `local`, a refs/backups|snapshots|trash ref), or the blob `ref` itself
 * when it is a blob id. null = no such ref, path, or regular file there.
 */
export async function blobAt(repo: ProjectRepo, ref: string, path: string): Promise<{ oid: string; size: number } | null> {
  if (!validRawRef(ref)) throw badRequest("invalid_request", `invalid ref: ${ref}`);
  const gitDir = repo.gitDir;
  const name = ref === "local" ? "refs/heads/local" : ref;
  if (HEX_RE.test(name)) {
    const t = await git(gitDir, ["cat-file", "-t", name], { ok: [0, 1, 128] });
    if (t.code === 0 && t.stdout.toString().trim() === "blob") {
      const oid = (await git(gitDir, ["rev-parse", "--verify", "--end-of-options", `${name}^{blob}`])).stdout.toString().trim();
      return { oid, size: await blobSize(gitDir, oid) };
    }
  }
  const c = await git(gitDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`], { ok: [0, 1, 128] });
  const commit = c.stdout.toString().trim();
  if (c.code !== 0 || !commit) return null;
  const ls = await git(gitDir, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", path]);
  for (const rec of ls.stdout.toString("utf8").split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (!m || m[4] !== path) continue;
    if (m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) return null;
    return { oid: m[3]!, size: await blobSize(gitDir, m[3]!) };
  }
  return null;
}

async function blobSize(gitDir: string, oid: string): Promise<number> {
  return Number((await git(gitDir, ["cat-file", "-s", oid])).stdout.toString().trim());
}

/** The bytes of a blob as a stream. */
export function blobStream(repo: ProjectRepo, oid: string): Readable {
  const child = spawnGit(repo.gitDir, ["cat-file", "blob", oid]);
  child.stdin.end();
  child.stderr.resume();
  child.on("error", (err) => child.stdout.destroy(err));
  return child.stdout;
}
