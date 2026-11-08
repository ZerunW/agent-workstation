import { totalmem } from "node:os";

/** Which Chromium build to run when `executablePath` is not set. */
export type ChromiumFlavor = "headless-shell" | "chromium";

/** Playwright MCP capabilities beyond the core tools (all off by default). */
export type McpCapability = "vision" | "pdf";

export interface BrowserConfig {
  /** Master switch. When false, ensure()/input() throw `disabled` and start() binds nothing. */
  enabled: boolean;
  /** `<usersRoot>/<user>` must already exist; the profile lives in `<usersRoot>/<user>/.browser/profile`. */
  usersRoot: string;
  /** Absolute path of the Chromium binary. Unset = Playwright's bundled build (see `flavor`). */
  executablePath?: string;
  /**
   * `headless-shell` (default): Playwright's chrome-headless-shell — measured on a small arm64 server at ~180 MB PSS idle and
   * ~360–430 MB on real pages. `chromium`: the full browser in new-headless mode, ~370 MB idle / ~620–770 MB on the
   * same pages, a closer match to desktop Chrome.
   */
  flavor: ChromiumFlavor;
  /** Stop a user's browser after this many minutes without agent tool calls, person input or viewers. 0 = never. */
  idleMinutes: number;
  viewport: { width: number; height: number };
  /** Most browsers running at once across all users. "auto" derives it from total memory (8 GB → 3). */
  maxConcurrent: number | "auto";
  /** Refuse to launch when the system has less than this much available memory. */
  minFreeMemoryMB: number;
  /** Extra Chromium switches appended after the defaults. */
  extraArgs: string[];
  /**
   * Unsupported since the DevTools port was replaced by a pipe: the browser must be a direct child of the hub (fds 3/4
   * do not survive sudo), so a non-empty wrapper makes ensure() fail with `launch_failed`.
   */
  wrapper: string[];
  screencast: {
    /** JPEG quality 1–100. */
    quality: number;
    /** Frames per second actually produced while someone watches (Chromium is acked at this rate). */
    maxFps: number;
    /** Quiet time after a throttled burst before one screenshot makes sure the last state is shown. */
    settleMs: number;
  };
  mcp: {
    /** Loopback only; the endpoint carries a per-user bearer token. */
    host: string;
    /** 0 = random free port. */
    port: number;
    /** Extra Playwright MCP tool groups. */
    capabilities: McpCapability[];
    /** Forget an MCP session (not the browser) after this long without requests. */
    sessionIdleMinutes: number;
  };
  /** `controlledBy` falls back to null this long after the last agent tool call or person input. */
  controlIdleSeconds: number;
}

export type BrowserConfigInput = Partial<Omit<BrowserConfig, "viewport" | "screencast" | "mcp">> & {
  usersRoot: string;
  viewport?: Partial<BrowserConfig["viewport"]>;
  screencast?: Partial<BrowserConfig["screencast"]>;
  mcp?: Partial<BrowserConfig["mcp"]>;
};

export const DEFAULT_BROWSER_CONFIG: Omit<BrowserConfig, "usersRoot"> = {
  enabled: true,
  flavor: "headless-shell",
  idleMinutes: 15,
  viewport: { width: 1280, height: 800 },
  maxConcurrent: "auto",
  minFreeMemoryMB: 500,
  extraArgs: [],
  wrapper: [],
  screencast: { quality: 60, maxFps: 15, settleMs: 250 },
  mcp: { host: "127.0.0.1", port: 0, capabilities: [], sessionIdleMinutes: 24 * 60 },
  controlIdleSeconds: 20,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);

const FORBIDDEN_ARG_RE = /^--(remote-debugging-(port|address|pipe)|remote-allow-origins|user-data-dir|headless)(=|$)/;

/** The DevTools transport is the launcher's pipe and nothing else: extra switches may not open a port or move the profile. */
export function assertSafeExtraArgs(args: string[]): void {
  const bad = args.find((a) => FORBIDDEN_ARG_RE.test(a));
  if (bad) throw new Error(`browser config: extraArgs may not contain ${bad.split("=")[0]} (DevTools is reachable over the hub's pipe only)`);
}

/** Fills defaults and clamps values into sane ranges. Throws on a missing/relative usersRoot or a non-loopback host. */
export function resolveBrowserConfig(input: BrowserConfigInput): BrowserConfig {
  const d = DEFAULT_BROWSER_CONFIG;
  if (!input.usersRoot || !input.usersRoot.startsWith("/")) throw new Error("browser config: usersRoot must be an absolute path");
  const host = input.mcp?.host ?? d.mcp.host;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("browser config: mcp.host must be a loopback address");
  assertSafeExtraArgs(input.extraArgs ?? []);
  const mc = input.maxConcurrent;
  const cfg: BrowserConfig = {
    enabled: input.enabled ?? d.enabled,
    usersRoot: input.usersRoot,
    flavor: input.flavor === "chromium" ? "chromium" : "headless-shell",
    idleMinutes: Math.max(0, int(input.idleMinutes, d.idleMinutes)),
    viewport: {
      width: clamp(int(input.viewport?.width, d.viewport.width), 320, 3840),
      height: clamp(int(input.viewport?.height, d.viewport.height), 240, 2160),
    },
    maxConcurrent: mc === "auto" || mc === undefined ? "auto" : Math.max(1, int(mc, 1)),
    minFreeMemoryMB: Math.max(0, int(input.minFreeMemoryMB, d.minFreeMemoryMB)),
    extraArgs: [...(input.extraArgs ?? d.extraArgs)],
    wrapper: [...(input.wrapper ?? d.wrapper)],
    screencast: {
      quality: clamp(int(input.screencast?.quality, d.screencast.quality), 1, 100),
      maxFps: clamp(int(input.screencast?.maxFps, d.screencast.maxFps), 1, 60),
      settleMs: clamp(int(input.screencast?.settleMs, d.screencast.settleMs), 50, 5000),
    },
    mcp: {
      host,
      port: clamp(int(input.mcp?.port, d.mcp.port), 0, 65535),
      capabilities: (input.mcp?.capabilities ?? d.mcp.capabilities).filter((c): c is McpCapability => c === "vision" || c === "pdf"),
      sessionIdleMinutes: Math.max(1, int(input.mcp?.sessionIdleMinutes, d.mcp.sessionIdleMinutes)),
    },
    controlIdleSeconds: Math.max(1, int(input.controlIdleSeconds, d.controlIdleSeconds)),
  };
  if (input.executablePath) cfg.executablePath = input.executablePath;
  return cfg;
}

/** `maxConcurrent: "auto"`: keep ~2 GiB for the hub, agents and the OS, budget ~1.5 GiB per browser, 1–4. */
export function autoMaxConcurrent(totalBytes: number = totalmem()): number {
  const gib = totalBytes / 1024 ** 3;
  return clamp(Math.floor((gib - 2) / 1.5), 1, 4);
}

export function effectiveMaxConcurrent(cfg: BrowserConfig, totalBytes?: number): number {
  return cfg.maxConcurrent === "auto" ? autoMaxConcurrent(totalBytes) : cfg.maxConcurrent;
}
