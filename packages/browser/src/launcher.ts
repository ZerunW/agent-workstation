/**
 * The only place in this package that starts a browser. Everything about how Chromium is started — binary lookup,
 * switches, environment, the DevTools transport and termination — lives here. The manager only sees `BrowserLauncher`.
 *
 * Chromium is launched through playwright-core's `launchPersistentContext`, which hands it `--remote-debugging-pipe`
 * (fds 3/4 of this process). There is no DevTools port: only the hub process can drive the browser, and it dies with
 * the hub (the pipe closes).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertSafeExtraArgs, type ChromiumFlavor } from "./config.js";
import { BrowserError } from "./errors.js";
import { loadPlaywright, type PwContext } from "./playwright.js";

export interface LaunchSpec {
  executablePath: string;
  /** Switches from `chromiumArgs` (no profile dir, no DevTools transport: those are set by the launcher). */
  args: string[];
  profileDir: string;
  viewport: { width: number; height: number };
  /** Command prefix (e.g. sudo -n -u <account> --). Unsupported: the pipe cannot cross it. */
  wrapper: string[];
  startTimeoutMs?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LaunchedBrowser {
  /** Chromium's main process id when it could be determined (Linux), for the profile lock and signals. */
  pid: number | undefined;
  /** The pipe-connected BrowserContext: shared by the manager's CDP sessions and the agents' Playwright MCP. */
  context: PwContext;
  exited: Promise<ExitInfo>;
  kill(signal?: NodeJS.Signals): void;
  /** Last few KB of Chromium's log output, for error messages. */
  stderrTail(): string;
}

export type BrowserLauncher = (spec: LaunchSpec) => Promise<LaunchedBrowser>;

const DISABLED_FEATURES = [
  "Translate",
  "MediaRouter",
  "DialMediaRouteProvider",
  "OptimizationHints",
  "AutofillServerCommunication",
  "InterestFeedContentSuggestions",
  "CertificateTransparencyComponentUpdater",
  "HeavyAdIntervention",
  "LensOverlay",
  // memory: no pre-spawned spare renderer, no back/forward page cache
  "SpareRendererForSitePerProcess",
  "BackForwardCache",
];

/**
 * Switches for a headless, memory-conscious Chromium. Deliberately absent: any `--remote-debugging-port/-address`
 * (the DevTools transport is the pipe Playwright adds), `--headless` and `--user-data-dir` (set by the launcher).
 */
export function chromiumArgs(opts: { viewport: { width: number; height: number }; extraArgs?: string[] }): string[] {
  assertSafeExtraArgs(opts.extraArgs ?? []);
  const args = [
    `--window-size=${opts.viewport.width},${opts.viewport.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--no-service-autorun",
    "--metrics-recording-only",
    "--mute-audio",
    "--force-color-profile=srgb",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    platform() === "darwin" ? "--use-mock-keychain" : "--password-store=basic",
  ];
  return [...args, ...(opts.extraArgs ?? [])];
}

/** Minimal environment: no hub secrets leak into the browser. */
function browserEnv(): Record<string, string> {
  const keep = ["HOME", "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "FONTCONFIG_PATH", "FONTCONFIG_FILE"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Chromium's main process (Linux): our child whose command line names this profile and is not a `--type=` helper. */
function findBrowserPid(profileDir: string): number | undefined {
  if (platform() !== "linux") return undefined;
  const flag = `--user-data-dir=${profileDir}`;
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
        if (!argv.includes(flag) || argv.some((a) => a.startsWith("--type="))) continue;
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === process.pid) return Number(name);
      } catch {
        // process gone or not ours to read
      }
    }
  } catch {
    // no /proc
  }
  return undefined;
}
const PROFILE_IN_USE_RE = /ProcessSingleton|profile appears to be in use|SingletonLock/i;

/** Default launcher: Chromium as a child of this process, DevTools over `--remote-debugging-pipe` (no TCP port). */
export const spawnChromium: BrowserLauncher = async (spec) => {
  if (spec.wrapper.length) {
    throw new BrowserError("launch_failed", "browser.wrapper is not supported: the DevTools pipe (fds 3/4) cannot cross sudo/su, and the browser must be a direct child of the hub.");
  }
  let tail = "";
  let context: PwContext;
  try {
    context = await loadPlaywright().chromium.launchPersistentContext(spec.profileDir, {
      executablePath: spec.executablePath,
      headless: true,
      args: spec.args,
      env: browserEnv(),
      viewport: null,
      chromiumSandbox: true,
      // the manager shuts browsers down gracefully; do not let Playwright's signal handlers kill them behind its back
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: spec.startTimeoutMs ?? 30_000,
      logger: {
        isEnabled: (name) => name === "browser",
        log: (_name, _severity, message) => {
          tail = (tail + String(message) + "\n").slice(-4096);
        },
      },
    });
  } catch (e) {
    const msg = `${(e as Error).message}\n${tail}`;
    throw PROFILE_IN_USE_RE.test(msg) ? new BrowserError("profile_in_use", `The browser profile is in use by another Chromium. ${msg.slice(-600)}`) : new BrowserError("launch_failed", `Could not start Chromium: ${msg.slice(-600)}`);
  }
  let gone = false;
  const exited = new Promise<ExitInfo>((resolve) => {
    const done = (): void => {
      gone = true;
      resolve({ code: null, signal: null });
    };
    context.on("close", done);
    context.browser()?.on("disconnected", done);
  });
  const pid = findBrowserPid(spec.profileDir);
  return {
    pid,
    context,
    exited,
    kill: (signal = "SIGTERM") => {
      if (gone) return;
      try {
        if (pid) process.kill(pid, signal);
        else void context.close().catch(() => undefined);
      } catch {
        // already gone
      }
    },
    stderrTail: () => tail,
  };
};

// ---------------------------------------------------------------------------
// Executable lookup
// ---------------------------------------------------------------------------

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Playwright's browser cache: $PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright (Linux), ~/Library/Caches/ms-playwright (macOS). */
export function playwrightCacheDir(): string {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env && env !== "0") return env;
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
}

/** The binary inside one installed revision dir (chromium-<rev> or chromium_headless_shell-<rev>), or null. */
function binaryIn(revisionDir: string, flavor: ChromiumFlavor): string | null {
  let subdirs: string[];
  try {
    subdirs = readdirSync(revisionDir);
  } catch {
    return null;
  }
  for (const sub of subdirs) {
    const base = join(revisionDir, sub);
    const candidates =
      flavor === "headless-shell"
        ? [join(base, "chrome-headless-shell")]
        : [join(base, "chrome"), join(base, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"), join(base, "Chromium.app", "Contents", "MacOS", "Chromium")];
    for (const c of candidates) if (isFile(c)) return c;
  }
  return null;
}

/** Installed revisions of one flavor in the cache dir, newest first. */
function installedRevisions(cacheDir: string, flavor: ChromiumFlavor): string[] {
  const prefix = flavor === "headless-shell" ? "chromium_headless_shell-" : "chromium-";
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
    .map((n) => join(cacheDir, n));
}

export interface ResolvedExecutable {
  path: string;
  flavor: ChromiumFlavor;
  /** "config" | "playwright" (the pinned revision) | "cache" (another installed revision). */
  source: "config" | "playwright" | "cache";
}

/**
 * Finds the Chromium to run: the configured path; else the revision pinned by the bundled playwright-core (preferred
 * flavor first, then the other); else the newest revision found in Playwright's cache. Throws `not_installed`.
 */
export function resolveExecutable(opts: { executablePath?: string; flavor: ChromiumFlavor }): ResolvedExecutable {
  if (opts.executablePath) {
    if (!isFile(opts.executablePath)) throw new BrowserError("not_installed", `Configured Chromium not found: ${opts.executablePath}`);
    return { path: opts.executablePath, flavor: /headless-shell/.test(basename(opts.executablePath)) ? "headless-shell" : "chromium", source: "config" };
  }
  const order: ChromiumFlavor[] = opts.flavor === "headless-shell" ? ["headless-shell", "chromium"] : ["chromium", "headless-shell"];
  let pinned: { cacheDir: string; revision: string } | null = null;
  try {
    // e.g. ~/.cache/ms-playwright/chromium-1252/chrome-linux-arm64/chrome
    const full = loadPlaywright().chromium.executablePath();
    const m = /^(.*)[\\/]chromium-(\d+)[\\/]/.exec(full);
    if (m) pinned = { cacheDir: m[1]!, revision: m[2]! };
  } catch {
    // playwright-core missing or unsupported platform: fall through to the cache scan
  }
  if (pinned) {
    for (const flavor of order) {
      const dir = join(pinned.cacheDir, `${flavor === "headless-shell" ? "chromium_headless_shell" : "chromium"}-${pinned.revision}`);
      const bin = binaryIn(dir, flavor);
      if (bin) return { path: bin, flavor, source: "playwright" };
    }
  }
  const cacheDirs = [...new Set([pinned?.cacheDir, playwrightCacheDir()].filter((d): d is string => !!d && existsSync(d)))];
  for (const flavor of order) {
    for (const cacheDir of cacheDirs) {
      for (const rev of installedRevisions(cacheDir, flavor)) {
        const bin = binaryIn(rev, flavor);
        if (bin) return { path: bin, flavor, source: "cache" };
      }
    }
  }
  throw new BrowserError("not_installed", `No Chromium found${pinned ? ` (looked for revision ${pinned.revision} in ${pinned.cacheDir})` : ""}. Run: npm run install-browser -w packages/browser`);
}

/** For error messages / diagnostics. */
export const describeExecutable = (r: ResolvedExecutable): string => `${r.flavor} at ${dirname(r.path)} (${r.source})`;
