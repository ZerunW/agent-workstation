/**
 * Code sessions work only inside their working directory (the session cwd), by design.
 *
 * Claude (code sessions and their Claude subagents, which run through the same options):
 *   - Commands run in Claude Code's own sandbox (bubblewrap on Linux), settings from codeSandbox() passed inline with
 *     `--settings`, built like the chat sandbox (chatFolder.ts chatSandbox): never unsandboxed
 *     (allowUnsandboxedCommands false; failIfUnavailable: the CLI refuses to start rather than run commands bare). Unlike
 *     a chat, sandboxed commands still follow the session's permission mode and cards (autoAllowBashIfSandboxed false).
 *   - Network, by permission mode (CLI 2.1.316 decides a `SandboxNetworkAccess` itself in auto → its classifier,
 *     bypassPermissions → allowed, dontAsk → refused; only default / acceptEdits / plan reach canUseTool):
 *       default, acceptEdits, plan: no allowlist; every new host reaches canUseTool, which resolves it: loopback,
 *         private, link-local, CGNAT / tailnet and ULA addresses refused (publicHostVerdict), the known development
 *         download hosts (DEV_DOWNLOAD_HOSTS) allowed, any other public host a card (remembered for the session once
 *         allowed);
 *       auto, bypassPermissions, dontAsk: `strictAllowlist` with the known hosts only, so the CLI never decides an
 *         unknown host. A mode change across the two groups restarts the process before its next turn (runtime.ts).
 *   - Commands that send data out (outbound.ts: git push, npm publish, scp, curl -d ...): the person's own card in a
 *     PreToolUse hook, in every permission mode (runtime.ts).
 *   - Project agent settings (`.claude/**`, `.mcp.json` of the cwd): not writable by commands (denyWrite) nor file tools.
 *   - File tools (Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, LS): every path inside the cwd (symlinks
 *     resolved, codeFolderAllows), plus the attachment reads (attachments.ts) and the session's own Claude files the CLI
 *     points the model at (its process temp directory, the tool results under `<claude home>/projects/<cwd>/`); refused
 *     with CODE_FOLDER_DENIED otherwise, in every permission mode (PreToolUse and canUseTool, runtime.ts).
 * */
import { lookup } from "node:dns/promises";
import { lstatSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { CHAT_SANDBOX_DENIED_ENV, chatFileToolPaths, insideChatFolder, spellings } from "./chatFolder.js";
import { encodeProjectDir } from "./claudeFiles.js";
import { isUnder } from "./hubTools.js";
import { PROCESS_TMP_ROOT } from "./processTmp.js";

/** The Claude file tools a code session's gate checks (PreToolUse matcher). */
export const CODE_FILE_TOOLS = "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS";
const CODE_FILE_TOOL_SET = new Set(CODE_FILE_TOOLS.split("|"));
/** The read-only ones (they may also open the session's own Claude files, see codeReadDirs). */
const CODE_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

export const CODE_FOLDER_DENIED = "This session works only inside its working directory: files outside it cannot be read or changed (attachments only by their listed paths).";
export const CODE_COMMAND_CWD_DENIED = "This session works only inside its working directory: commands must start in it.";
export const CODE_UNSANDBOXED_DENIED = "Commands in this session always run in the sandbox.";
export const CODE_NETWORK_DENIED = "Commands in this session can reach public internet hosts only, not loopback, local network or tailnet addresses.";
export const CODE_HOST_NO_ASK = "This host needs the user's approval, which this session does not ask for; the known package and download hosts are reachable.";

/** The agent's own toolchains (~/.local/bin, ~/.local/share, ~/.local/lib): readable. */
export const TOOLCHAIN_DIRS = ["~/.local"] as const;

/** Variables Claude Code's sandbox unsets for a code session's commands (the same as a chat's). */
export const CODE_SANDBOX_DENIED_ENV = CHAT_SANDBOX_DENIED_ENV;

/**
 * Claude Code's sandbox for a code session's commands (the `sandbox` key of the inline `--settings`, CLI 2.1.316):
 *   - writes only to the cwd and the process's private temp directory (`tmpDir`, processTmp.ts: CLAUDE_CODE_TMPDIR and
 *     TMPDIR of the session's Claude process);
 *   - reads denied for the whole users root (other users, the user's own other projects and chats, the hub's folders),
 *     /etc/agent-workstation, the agent account's Claude credentials and transcripts, other processes' temp directories
 *     (/tmp/hs) and the CLI's shared /tmp/claude-<uid>; re-allowed: the cwd, its own temp directory, Claude's shell
 *     snapshots / session-env (each command sources them) and the agent's toolchains;
 *   - writes denied for the project's agent settings (projectSettingsPaths; the sandbox also masks them when missing);
 *   - network: `strictNetwork` false (default / acceptEdits / plan): no allowlist, each new host is a
 *     SandboxNetworkAccess request that canUseTool decides; true (auto / bypassPermissions / dontAsk): strict allowlist
 *     of the known hosts (codeAllowedDomains); no local binding either way;
 *   - commands still follow the permission mode and its cards (autoAllowBashIfSandboxed false);
 *   - the key proxy token and its URL unset for commands (CODE_SANDBOX_DENIED_ENV).
 */
export function codeSandbox(o: { cwd: string; usersRoot: string; tmpDir: string; strictNetwork?: boolean }): Record<string, unknown> {
  const folders = spellings(o.cwd);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [...folders, o.tmpDir],
      // The project's agent settings (project-settings escape): never written by the session's commands.
      denyWrite: projectSettingsPaths(o.cwd),
      denyRead: [...spellings(o.usersRoot), "/etc/agent-workstation", "~/.claude", "~/.claude.json", PROCESS_TMP_ROOT, "/tmp/claude-*"],
      allowRead: [...folders, o.tmpDir, "~/.claude/shell-snapshots", "~/.claude/session-env", ...TOOLCHAIN_DIRS],
    },
    network: o.strictNetwork
      ? { allowedDomains: codeAllowedDomains(), deniedDomains: [...DEV_UPLOAD_HOSTS], strictAllowlist: true, allowLocalBinding: false }
      : { allowedDomains: [], deniedDomains: [...DEV_UPLOAD_HOSTS], strictAllowlist: false, allowLocalBinding: false },
    credentials: { envVars: CODE_SANDBOX_DENIED_ENV.map((name) => ({ name, mode: "deny" })) },
  };
}

// ------------------------------------------------------------------ project settings

export const PROJECT_SETTINGS_DENIED = "Project agent settings can only be changed by the user.";

/**
 * The project's agent settings: `.claude/` (settings.json, settings.local.json, hooks, skills, agents, commands) and
 * `.mcp.json`, both spellings of the cwd. By default the CLI does not read them (`[sessions] project_settings` off:
 * settingSources []; the hub passes CLAUDE.md and the skills, commands and agents itself, see projectContext.ts), but
 * with it on the CLI merges project settings with the hub's flag settings by concatenating arrays (sandbox paths and
 * domains, hooks), so a file written there would widen the session's own limits. Either way commands may not write
 * them (sandbox denyWrite) and neither may the file tools (touchesProjectSettings): what the hub copies into the
 * session's plugin is read at the next process start.
 */
export function projectSettingsPaths(cwd: string): string[] {
  return spellings(cwd).flatMap((c) => [join(c, ".claude"), join(c, ".mcp.json")]);
}

/** The Claude file tools that write. */
export const CODE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Whether `requested` (absolute or relative to the cwd) is `<cwd>/.claude` or under it, or `<cwd>/.mcp.json`: lexically
 * (either spelling of the cwd) or once symlinks are resolved (its deepest existing ancestor's realpath).
 */
export function touchesProjectSettings(requested: unknown, cwdAbs: string): boolean {
  if (typeof requested !== "string" || !requested.trim()) return false;
  let raw = requested.trim();
  if (raw.startsWith("file://")) {
    try {
      raw = decodeURIComponent(raw.slice("file://".length));
    } catch {
      return false;
    }
  }
  const abs = resolve(cwdAbs, raw);
  const hit = (p: string): boolean => spellings(cwdAbs).some((c) => isUnder(p, join(c, ".claude")) || p === join(c, ".mcp.json"));
  if (hit(abs)) return true;
  // Symlinks: resolve the deepest existing ancestor and append the rest.
  let cur = abs;
  let rest = "";
  for (;;) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const up = dirname(cur);
      if (up === cur) return false;
      rest = rest ? join(basename(cur), rest) : basename(cur);
      cur = up;
    }
  }
  try {
    const real = realpathSync(cur);
    return hit(rest ? join(real, rest) : real);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ network policy

/**
 * Development download hosts a code session's commands reach without a card (subdomains included): package
 * registries, source archives, toolchain and distribution mirrors, CDNs for packages, model hubs.
 */
export const DEV_DOWNLOAD_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
  "deb.debian.org",
  "ports.ubuntu.com",
  "archive.ubuntu.com",
  "dl.google.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "huggingface.co",
] as const;

/** The strict sandbox allowlist: every known host and its subdomains (`*.host` does not cover the host itself). */
export function codeAllowedDomains(): string[] {
  return DEV_DOWNLOAD_HOSTS.flatMap((h) => [h, `*.${h}`]);
}

/**
 * Upload endpoints under the known download domains: never automatic (a card in the asking modes, refused in the
 * strict ones), so "subdomains included" does not let pushes through.
 */
export const DEV_UPLOAD_HOSTS = ["api.github.com", "uploads.github.com", "gist.github.com", "upload.pypi.org", "test.pypi.org"] as const;

/** Whether a (normalized) host is one of DEV_DOWNLOAD_HOSTS or a subdomain of one, and not an upload endpoint. */
export function knownDevHost(host: string | null): boolean {
  if (!host) return false;
  if ((DEV_UPLOAD_HOSTS as readonly string[]).includes(host)) return false;
  return DEV_DOWNLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Permission modes in which the hub cannot ask about a host (CLI 2.1.316 decides SandboxNetworkAccess itself: `auto`
 * → its classifier, `bypassPermissions` → allowed, `dontAsk` → refused; canUseTool only sees it in `default`,
 * `acceptEdits` and `plan`): there the sandbox runs with a strict allowlist of the known hosts.
 */
export function strictNetworkMode(mode: string): boolean {
  return mode === "auto" || mode === "bypassPermissions" || mode === "dontAsk";
}

/**
 * Environment of a code session's sandboxed commands (settings `env`): package caches in the process's temp directory
 * (the agent's home is not writable inside the sandbox).
 */
export function codeCommandEnv(tmpDir: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(tmpDir, "cache"),
    npm_config_cache: join(tmpDir, "npm"),
    PIP_CACHE_DIR: join(tmpDir, "pip"),
  };
}

/**
 * Claude Code's memory cap for a session's commands (settings `env`, which the agent wrapper passes through unchanged
 * inside `--settings`), CLI 2.1.316: `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is a size in bytes or with a k/m/g/t suffix
 * (powers of 1024; "0" / "false" / "none" = off). On Linux with cgroup v2 the CLI then creates `claude-code-bash`
 * as a sibling of its own cgroup (the parent of `/proc/self/cgroup`'s path), writes the size to its `memory.max` and
 * moves every command it starts into it: one cap for all commands of that Claude process, not one per command. When
 * it cannot (no memory controller, the parent not writable for the CLI's account) it logs "tool cgroup: disabled" in
 * its debug log and runs commands uncapped. The CLI has no CPU or process-count counterpart. `mb` 0 = nothing set.
 */
export function toolLimitEnv(mb: number): Record<string, string> {
  return Number.isInteger(mb) && mb > 0 ? { CLAUDE_CODE_TOOL_MEMORY_LIMIT: `${mb}m` } : {};
}

/**
 * Directories a code session's read-only file tools may open besides the cwd: its process temp directory (the CLI's
 * background-task output files) and its Claude transcript folder `<claude home>/projects/<encoded cwd>/` (tool results
 * the CLI saved for the model to Read), both spellings of the cwd.
 */
export function codeReadDirs(o: { cwd: string; tmpDir: string; claudeHome: string }): string[] {
  return [o.tmpDir, ...spellings(o.cwd).map((c) => join(o.claudeHome, "projects", encodeProjectDir(c)))];
}

/** The paths a Claude file tool call names (null for other tools): chat's file tools plus MultiEdit, NotebookEdit, LS. */
export function codeFileToolPaths(toolName: string, input: Record<string, unknown>, cwdAbs: string): unknown[] | null {
  if (!CODE_FILE_TOOL_SET.has(toolName)) return null;
  switch (toolName) {
    case "MultiEdit":
      return [input.file_path];
    case "NotebookEdit":
      return [input.notebook_path ?? input.file_path];
    case "LS":
      return [input.path ?? cwdAbs];
    default:
      return chatFileToolPaths(toolName, input, cwdAbs);
  }
}

/** Whether every path of a Claude file tool call is inside the cwd (or, for read tools, one of `readDirs`). */
export function codeFolderAllows(toolName: string, input: Record<string, unknown>, cwdAbs: string, readDirs: readonly string[] = []): boolean {
  const paths = codeFileToolPaths(toolName, input, cwdAbs);
  if (!paths || paths.length === 0) return false;
  const dirs = [cwdAbs, ...(CODE_READ_TOOLS.has(toolName) ? readDirs : [])];
  return paths.every((p) => dirs.some((d) => insideChatFolder(p, cwdAbs, d)));
}

/** Whether `requested` (absolute or relative to the cwd) is inside the cwd, symlinks resolved (insideChatFolder). */
export function insideCwd(requested: unknown, cwdAbs: string): boolean {
  return insideChatFolder(requested, cwdAbs, cwdAbs);
}

// ------------------------------------------------------------------ network

/** IPv4 dotted quad → 4 bytes (null when not one). */
function v4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

/** IPv6 text → 16 bytes (null when not one; a zone id is dropped; an embedded dotted quad is accepted). */
function v6Bytes(ip: string): number[] | null {
  let s = ip.split("%")[0]!.toLowerCase();
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".", lastColon)) {
    const v4 = v4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Whether an IPv4 address (4 bytes) is publicly routable. */
function publicV4(b: number[]): boolean {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && c >= 64 && c <= 127) return false; // 100.64/10: CGNAT, the tailnet
  if (a === 169 && c === 254) return false; // link-local (and cloud metadata)
  if (a === 172 && c >= 16 && c <= 31) return false; // private
  if (a === 192 && c === 168) return false; // private
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (c === 18 || c === 19)) return false; // benchmarking
  if (a === 198 && c === 51 && d === 100) return false; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Whether an IPv6 address (16 bytes) is publicly routable; v4-mapped / NAT64 / 6to4 addresses by their IPv4 part. */
function publicV6(b: number[]): boolean {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return false; // ::, ::1, deprecated IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return publicV4(b.slice(12)); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return publicV4(b.slice(2, 6)); // 6to4
  if ((b[0]! & 0xe0) !== 0x20) return false; // outside 2000::/3: ULA fc00::/7 (tailnet fd7a:115c:a1e0::/48), link-local, multicast ...
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo
  return true;
}

/** Whether `ip` (IPv4 or IPv6 text) is a public address; anything unparsable is not. */
export function isPublicAddress(ip: string): boolean {
  const v4 = isIP(ip) === 4 ? v4Bytes(ip) : null;
  if (v4) return publicV4(v4);
  const v6 = v6Bytes(ip);
  return v6 ? publicV6(v6) : false;
}

/** Resolves a host name to all its addresses (A and AAAA). */
export type HostResolver = (host: string) => Promise<string[]>;

export const systemResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The host of a SandboxNetworkAccess request without port, brackets and trailing dot, lowercased; null when unusable. */
export function normalizeHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (bracket) h = bracket[1]!;
  else if (isIP(h) !== 6 && /:\d+$/.test(h) && h.split(":").length === 2) h = h.replace(/:\d+$/, "");
  h = h.replace(/\.$/, "");
  if (!h || h.includes("/") || h.includes("@") || /\s/.test(h)) return null;
  return h;
}

export interface HostVerdict {
  allowed: boolean;
  host: string | null;
  addresses: string[];
  reason?: string;
}

/**
 * The hub's decision on a code session's SandboxNetworkAccess request: allowed when the host resolves and every one of
 * its addresses is public (an IP literal is checked as is). `localhost` names, failed lookups and hosts with any
 * non-public address are refused.
 */
export async function publicHostVerdict(host: unknown, resolve: HostResolver = systemResolver): Promise<HostVerdict> {
  const h = normalizeHost(host);
  if (!h) return { allowed: false, host: null, addresses: [], reason: "no host" };
  if (h === "localhost" || h.endsWith(".localhost")) return { allowed: false, host: h, addresses: [], reason: "localhost" };
  let addresses: string[];
  if (isIP(h)) addresses = [h];
  else {
    try {
      addresses = await resolve(h);
    } catch {
      return { allowed: false, host: h, addresses: [], reason: "lookup failed" };
    }
  }
  if (addresses.length === 0) return { allowed: false, host: h, addresses, reason: "no address" };
  const blocked = addresses.filter((a) => !isPublicAddress(a));
  return blocked.length ? { allowed: false, host: h, addresses, reason: `non-public address ${blocked[0]}` } : { allowed: true, host: h, addresses };
}
