/**
 * A chat's own folder: `<user root>/.chat/<session id>/`, where the chat's agent runs code and keeps the files it makes.
 * It is the chat's stored cwd (set at creation), so Claude's transcripts stay under one cwd across resume, rewind and
 * fork. Created when the chat's process starts (runtime.ts), removed only when the person deletes the chat (and with
 * the incognito purge, which is the person's own deletion), once no other chat uses it (a fork shares its source's
 * folder); never otherwise. It is part of the user's workspace, so it counts towards their disk usage, and the files
 * the agent wrote are listed by the session's outputs route. A chat's (research-only) subagents share their parent's
 * folder but get no file or command tools.
 *
 * File tools (Read, Write, Edit, Glob, Grep) may only touch this folder, plus the
 * attachment reads that exist for every chat (attachments.ts): chatFolderAllows() is the gate, enforced in PreToolUse
 * and canUseTool. Commands run in Claude Code's own sandbox (bubblewrap on Linux), settings from chatSandbox() passed
 * inline with `--settings`; sandboxed commands need no permission card (autoAllowBashIfSandboxed), never run
 * unsandboxed (allowUnsandboxedCommands false; failIfUnavailable: the CLI refuses to start rather than run commands
 * bare). The chat's Claude process has a private temp directory of its own (processTmp.ts), removed when it ends.
 * Files from the internet: the one-way download_file tool (download.ts) saves them under `downloads/`.
 */
import { lstatSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isUnder } from "./hubTools.js";
import { PROCESS_TMP_ROOT } from "./processTmp.js";

/** The parent of every chat folder, relative to the user root (a chat session's stored cwd). */
export const CHAT_DIR = ".chat";

/** Built-in Claude Code tools a chat (not a research subagent) runs in its folder, on top of the web tools. */
export const CHAT_EXEC_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
/** The file tools among them (path-checked). */
export const CHAT_FILE_TOOLS = "Read|Write|Edit|Glob|Grep";

export const CHAT_FOLDER_DENIED = "In this chat, files can only be read and written inside the chat's own folder (and the attachments by their listed paths).";

const CHAT_FOLDER_RE = /^\.chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The folder of a new chat (its stored cwd, relative to the user root); its forks and subagents inherit it. */
export function chatFolderRel(sessionId: string): string {
  return `${CHAT_DIR}/${sessionId}`;
}

/**
 * Whether a chat's stored cwd is a folder of its own. Chats created before chats had folders keep the shared `.chat`
 * (their Claude transcripts live under that cwd): they run without commands or file writes.
 */
export function isChatFolder(cwd: string): boolean {
  return CHAT_FOLDER_RE.test(cwd);
}

/** Both spellings (as configured and realpath) of a folder; the realpath only when it exists. */
export function spellings(dir: string): string[] {
  try {
    const real = realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}

/**
 * Whether `requested` (absolute, or relative to `cwdAbs`) is inside the chat folder: lexically under one of its
 * spellings, no `..` segment, and its deepest existing ancestor resolves (symlinks included) inside the folder's
 * realpath. A dangling symlink is refused (a write would follow it out of the folder).
 */
export function insideChatFolder(requested: unknown, cwdAbs: string, folder: string): boolean {
  if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) return false;
  let raw = requested.trim();
  if (raw.startsWith("file://")) {
    try {
      raw = decodeURIComponent(raw.slice("file://".length));
    } catch {
      return false;
    }
  }
  if (raw.split(/[\\/]+/).includes("..")) return false;
  const abs = resolve(cwdAbs, raw);
  const names = spellings(folder);
  if (!names.some((f) => isUnder(abs, f))) return false;
  const folderReal = names[names.length - 1]!;
  let cur = abs;
  for (;;) {
    try {
      lstatSync(cur);
    } catch {
      const up = dirname(cur);
      if (up === cur) return false;
      cur = up;
      continue;
    }
    try {
      return isUnder(realpathSync(cur), folderReal);
    } catch {
      return false; // a dangling symlink (or a loop)
    }
  }
}

/**
 * The paths a Claude file tool call names (null for other tools). Glob's `pattern` and Grep's `glob` are relative to
 * the search directory: a `..` segment in them is returned as is so the gate refuses it; an absolute Glob pattern is
 * checked as a path (up to its first wildcard). Read / Write / Edit need a `file_path`; Glob / Grep default to the cwd.
 */
export function chatFileToolPaths(toolName: string, input: Record<string, unknown>, cwdAbs: string): unknown[] | null {
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return [input.file_path];
    case "Glob":
    case "Grep": {
      const paths: unknown[] = [input.path ?? cwdAbs];
      const pattern = toolName === "Glob" ? input.pattern : input.glob;
      if (typeof pattern === "string") {
        if (pattern.split(/[\\/]+/).includes("..")) paths.push("..");
        else if (isAbsolute(pattern)) paths.push(pattern.split(/[*?[{]/)[0] || "/");
      }
      return paths;
    }
    default:
      return null;
  }
}

/** Whether every path of a Claude file tool call is inside the chat folder (false for a call without paths). */
export function chatFolderAllows(toolName: string, input: Record<string, unknown>, cwdAbs: string, folder: string): boolean {
  const paths = chatFileToolPaths(toolName, input, cwdAbs);
  return !!paths && paths.length > 0 && paths.every((p) => insideChatFolder(p, cwdAbs, folder));
}

/**
 * The only hosts a chat's sandboxed commands may reach: PyPI's index and its file host, which only serve downloads
 * (uploads go to upload.pypi.org, which is not listed). Every other file from the internet comes through the chat's
 * one-way download_file tool (download.ts), which cannot send the chat's files out.
 */
export const CHAT_NETWORK_HOSTS = ["pypi.org", "files.pythonhosted.org"] as const;

/** True when `host` (from a SandboxNetworkAccess request) is one of CHAT_NETWORK_HOSTS (exact match, case-insensitive). */
export function chatHostAllowed(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  return (CHAT_NETWORK_HOSTS as readonly string[]).includes(h);
}

/**
 * Variables Claude Code's sandbox unsets for a chat's commands (`credentials.envVars`, mode `deny`: bubblewrap
 * `--unsetenv`): the key proxy token and its URL, and any other Anthropic credential the CLI might be given. The CLI
 * itself keeps them (its own API access is untouched).
 */
export const CHAT_SANDBOX_DENIED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Claude Code's sandbox for a chat's commands (the `sandbox` key of the inline `--settings`), as CLI 2.1.316 /
 * SDK 0.3.316 define it:
 *   - writes only to the chat folder (the cwd) and the process's private temp directory (`tmpDir`: CLAUDE_CODE_TMPDIR
 *     and TMPDIR of the chat's Claude process, processTmp.ts);
 *   - reads denied for the whole users root (other users' workspaces, other chats' folders, the user's own files
 *     outside this chat, the hub's ~hub folder), /etc/agent-workstation, the agent account's Claude
 *     credentials and transcripts, and all of /tmp (other processes' temp directories under /tmp/hs, the CLI's shared
 *     /tmp/claude-<uid>, the agent's tmux socket ...), with the chat folder, its own temp directory and Claude's shell
 *     snapshots / session-env (each command sources them) re-allowed. /tmp/hs and /tmp/claude-* are named on top of
 *     /tmp so they stay hidden should anything re-open part of /tmp;
 *   - network (assuming a web page may have talked the agent into a hostile command): only PyPI
 *     (CHAT_NETWORK_HOSTS; other files come in through download_file), every other host refused by the sandbox's proxy itself (`strictAllowlist`: no
 *     prompt, no classifier), so loopback, LAN and tailnet addresses (the key proxy, the hub, the browser endpoint)
 *     stay out of reach; should the CLI ever ask instead, canUseTool denies the host (runtime.ts, second line).
 *     The proxy is reached through a Unix socket that the CLI creates in its os.tmpdir(): the chat's Claude process
 *     gets TMPDIR = `tmpDir`, which the sandbox re-binds; in /tmp itself the socket would be hidden by the /tmp deny
 *     and every connection would fail ("Proxy CONNECT aborted");
 *   - the key proxy token and its URL unset for commands (CHAT_SANDBOX_DENIED_ENV).
 * Resource limits (CPU time, memory, processes): the sandbox has no setting for them. The CLI's tool memory cgroup
 * (CLAUDE_CODE_TOOL_MEMORY_LIMIT) needs a cgroup the agent account may write, which the hub's unit does not delegate.
 */
export function chatSandbox(o: { folder: string; usersRoot: string; tmpDir: string }): Record<string, unknown> {
  const folders = spellings(o.folder);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [...folders, o.tmpDir],
      denyRead: [...spellings(o.usersRoot), "/etc/agent-workstation", "~/.claude", "~/.claude.json", "/tmp", PROCESS_TMP_ROOT, "/tmp/claude-*"],
      allowRead: [...folders, o.tmpDir, "~/.claude/shell-snapshots", "~/.claude/session-env"],
    },
    network: { allowedDomains: [...CHAT_NETWORK_HOSTS], strictAllowlist: true, allowLocalBinding: false },
    credentials: { envVars: CHAT_SANDBOX_DENIED_ENV.map((name) => ({ name, mode: "deny" })) },
  };
}

/**
 * Environment of a sandboxed chat's commands (settings `env`): package caches and `pip install --user` land in the chat
 * folder (the agent's home is not writable inside the sandbox).
 */
export function chatCommandEnv(folder: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(folder, ".cache"),
    npm_config_cache: join(folder, ".cache", "npm"),
    PYTHONUSERBASE: join(folder, ".local"),
  };
}

const SCAN_SKIP = new Set(["node_modules", "__pycache__"]);

/**
 * Regular files in the chat folder changed at or after `sinceMs` (what a command just produced, for the session's
 * outputs), absolute paths, newest first. Bounded: depth 4, at most 2000 entries looked at and `limit` returned;
 * dot-folders (.cache, .venv, .local, .git) and node_modules / __pycache__ are skipped; symlinks are not followed.
 */
export function filesChangedSince(folder: string, sinceMs: number, limit = 50): string[] {
  const found: { path: string; mtime: number }[] = [];
  let budget = 2000;
  const walk = (dir: string, depth: number): void => {
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (--budget < 0) return;
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < 4 && !d.name.startsWith(".") && !SCAN_SKIP.has(d.name)) walk(p, depth + 1);
      } else if (d.isFile()) {
        try {
          const m = statSync(p).mtimeMs;
          if (m >= sinceMs) found.push({ path: p, mtime: m });
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  walk(folder, 1);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
}

/** Removes a chat folder (only on the person's deletion of the last chat using it). Throws on failure. */
export function removeChatFolder(userRoot: string, cwd: string): void {
  if (!isChatFolder(cwd)) return;
  rmSync(join(userRoot, cwd), { recursive: true, force: true });
}
