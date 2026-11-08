/**
 * chrome-headless-shell has no ProcessSingleton: a second instance on the same profile starts happily and both write
 * the same cookie/storage databases (measured). The manager already keeps one browser per user per process; this pid
 * file in `<user>/.browser/` also covers a second hub process (dev + prod) and a browser orphaned by a hub crash.
 * A live holder is never killed — ensure() fails with `profile_in_use` and names the pid.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { BrowserError } from "./errors.js";

interface LockInfo {
  pid: number;
  profileDir: string;
  host: string;
  startedAt: string;
}

/**
 * Creates `dir` (and parents) if needed and makes sure it is mode 0700 and owned by the running account: the profile
 * holds the user's cookies, so no other local account may read it. Refuses a directory owned by someone else.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  if (uid !== undefined && statSync(dir).uid !== uid) throw new BrowserError("launch_failed", `${dir} is not owned by the account running the hub (uid ${uid}).`);
  chmodSync(dir, 0o700);
}

const lockPath = (browserDir: string): string => join(browserDir, "browser.pid.json");

function alive(pid: number, profileDir: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
  if (platform() !== "linux") return true;
  try {
    // guard against pid reuse after a reboot: the holder must be a browser for this very profile
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(profileDir);
  } catch {
    return false;
  }
}

function read(browserDir: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(browserDir), "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** Throws `profile_in_use` when another live browser holds this profile. A stale lock is simply overwritten later. */
export function assertProfileFree(browserDir: string, profileDir: string): void {
  const info = read(browserDir);
  if (!info || info.host !== hostname()) return;
  if (alive(info.pid, profileDir)) throw new BrowserError("profile_in_use", `Another browser (pid ${info.pid}, started ${info.startedAt}) is using this profile. Stop it first.`);
}

export function writeProfileLock(browserDir: string, pid: number | undefined, profileDir: string): void {
  if (!pid) return;
  const info: LockInfo = { pid, profileDir, host: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(lockPath(browserDir), JSON.stringify(info), { mode: 0o600 });
}

/** Removes the pid file if it still names `pid` (our own runtime marker, not user data). */
export function clearProfileLock(browserDir: string, pid: number | undefined): void {
  const info = read(browserDir);
  if (info && info.pid === pid) rmSync(lockPath(browserDir), { force: true });
}
