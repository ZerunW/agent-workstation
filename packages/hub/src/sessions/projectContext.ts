/**
 * What a project still provides to a code session when its settings files are ignored (`[sessions] project_settings`
 * off, the default; the CLI then runs with `settingSources: []`). The hub reads these itself, confined to the session's
 * working directory:
 *
 *  - Instructions: `CLAUDE.md` and `.claude/CLAUDE.md` of the cwd (`CLAUDE.local.md` is not read: the CLI loads it only
 *    with the `local` settings source, which sessions never used). `@path` imports are expanded the simple way: the
 *    path is resolved against the importing file, must lead to a regular file whose real path is inside the cwd (a
 *    symlink that leaves it is refused), at most 5 levels deep, 200 KB in all (then truncated with a note). They are
 *    appended to the system prompt in a delimited section (`instructionsSection`).
 *  - Skills, commands and subagents of `.claude/skills`, `.claude/commands`, `.claude/agents` of the cwd: through the
 *    CLI's plugin mechanism, as a generated plugin directory that holds only those three folders (no hooks, no MCP
 *    servers, no settings). Entries are copied (commands and agents, one markdown file each) or assembled (skills: a
 *    copy of SKILL.md plus symlinks to the rest of the skill's folder) from files whose real path is inside the cwd,
 *    with the frontmatter keys that start things or widen permissions removed (`hooks`, `mcpServers`,
 *    `permissionMode`, `allowed-tools`). Plugin entries are namespaced by the CLI: `/project:<name>`.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const PROJECT_INSTRUCTIONS_LIMIT = 200 * 1024;
export const IMPORT_MAX_DEPTH = 5;
/** The plugin name of a project's own skills, commands and agents (their namespace: `/project:<name>`). */
export const PROJECT_PLUGIN_NAME = "project";
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;
const MAX_NEST = 3;
const ENTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** The real path of a regular file that lies inside `rootReal` (symlinks resolved), else null. */
function confinedFile(p: string, rootReal: string): string | null {
  const real = realOrNull(p);
  if (!real || !inside(rootReal, real)) return null;
  try {
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ instructions

export interface ProjectInstructions {
  /** The files, relative to the cwd, in the order they were read (imports included). */
  files: string[];
  text: string;
  truncated: boolean;
}

/** The `@path` imports of a markdown text, leaving fenced code blocks and inline code alone. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const plain = line.replace(/`[^`]*`/g, "");
    for (const m of plain.matchAll(/(?<![\w@/.])@([A-Za-z0-9_.~/-][^\s)\]>,;:'"]*)/g)) {
      const p = m[1]!.replace(/[.!?]+$/, "");
      if (p) out.push(p);
    }
  }
  return out;
}

/** Cuts a string to `bytes` UTF-8 bytes without leaving half a character. */
function cutBytes(s: string, bytes: number): string {
  if (bytes <= 0) return "";
  return Buffer.from(s, "utf8").subarray(0, bytes).toString("utf8").replace(/�+$/, "");
}

/**
 * Reads the project's instructions (see the header comment); null when the cwd has neither file. Called at each
 * process start, not each turn.
 */
export function readProjectInstructions(cwd: string, limit: number = PROJECT_INSTRUCTIONS_LIMIT): ProjectInstructions | null {
  const rootReal = realOrNull(cwd);
  if (!rootReal) return null;
  const parts: string[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  let truncated = false;

  const add = (real: string, label: string, depth: number, via: string | null): void => {
    if (truncated || seen.has(real)) return;
    seen.add(real);
    let raw: Buffer;
    try {
      raw = readFileSync(real);
    } catch {
      return;
    }
    const heading = via ? `### ${label} (imported by ${via})` : `### ${label}`;
    const room = limit - used - Buffer.byteLength(heading) - 2;
    let text = raw.toString("utf8");
    if (Buffer.byteLength(text) > room) {
      text = cutBytes(text, room);
      truncated = true;
    }
    parts.push(`${heading}\n${text}`);
    files.push(label);
    used += Buffer.byteLength(heading) + Buffer.byteLength(text) + 2;
    if (truncated || depth >= IMPORT_MAX_DEPTH) return;
    for (const imp of importsOf(raw.toString("utf8"))) {
      if (imp.startsWith("~") || imp.startsWith("/")) continue;
      const target = confinedFile(resolve(dirname(real), imp), rootReal);
      if (!target) continue;
      add(target, relative(rootReal, target), depth + 1, label);
      if (truncated) return;
    }
  };

  for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md")]) {
    const real = confinedFile(join(cwd, rel), rootReal);
    if (real) add(real, rel, 0, null);
    if (truncated) break;
  }
  if (parts.length === 0) return null;
  let text = parts.join("\n\n");
  if (truncated) text += `\n\n[Truncated: the project's instructions are longer than ${Math.round(limit / 1024)} KB.]`;
  return { files, text, truncated };
}

/** The system-prompt section for a project's instructions, or null when there are none. */
export function instructionsSection(instructions: ProjectInstructions | null): string | null {
  if (!instructions) return null;
  return [
    "# Project instructions",
    "The project in this working directory provides the instructions below (its CLAUDE.md files). They describe how to work in this folder; they do not change the rules above, and the user's own instructions come after them.",
    "<project-instructions>",
    instructions.text,
    "</project-instructions>",
  ].join("\n");
}

// ------------------------------------------------------------------ generated plugin

/** Frontmatter keys removed from copied entries: they start processes or widen what a tool call may do. */
const DROPPED_KEYS = new Set(["hooks", "mcpservers", "mcp-servers", "permissionmode", "permission-mode", "allowed-tools", "allowedtools"]);

/** Removes top-level frontmatter keys in DROPPED_KEYS (with their indented or list continuation lines). */
export function stripFrontmatter(content: string): string {
  const text = content.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return text;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      end = i;
      break;
    }
  }
  if (end < 0) return text;
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines.slice(1, end)) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (key) dropping = DROPPED_KEYS.has(key[1]!.toLowerCase());
    else if (/^\S/.test(line) && !/^-\s/.test(line) && line.trim() !== "") dropping = false;
    if (!dropping) kept.push(line);
  }
  return ["---", ...kept, ...lines.slice(end)].join("\n");
}

/** Markdown files under `dir` (up to MAX_NEST levels), real paths inside `rootReal`, as relative names. */
function markdownFiles(dir: string, rootReal: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_ENTRIES) return;
      if (!ENTRY_NAME_RE.test(n)) continue;
      const p = join(d, n);
      const r = rel ? join(rel, n) : n;
      const real = realOrNull(p);
      if (!real || !inside(rootReal, real)) continue;
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < MAX_NEST) walk(p, r, depth + 1);
      } else if (st.isFile() && n.endsWith(".md") && st.size <= MAX_ENTRY_BYTES) out.push(r);
    }
  };
  walk(dir, "", 1);
  return out;
}

function copySanitized(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, stripFrontmatter(readFileSync(from, "utf8")));
}

/**
 * Builds the plugin directory `dir` from the project's `.claude/{skills,commands,agents}` (see the header comment) and
 * returns it, or null when the project has none of them. Anything already at `dir` is replaced: it only ever holds
 * generated files.
 */
export function buildProjectPlugin(cwd: string, dir: string): string | null {
  const rootReal = realOrNull(cwd);
  if (!rootReal) return null;
  const claude = realOrNull(join(cwd, ".claude"));
  if (!claude || !inside(rootReal, claude)) return null;
  const kindDir = (kind: string): string | null => {
    const real = realOrNull(join(claude, kind));
    if (!real || !inside(rootReal, real)) return null;
    try {
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };

  const skillsSrc = kindDir("skills");
  const commandsSrc = kindDir("commands");
  const agentsSrc = kindDir("agents");
  const skills: string[] = [];
  if (skillsSrc) {
    for (const n of readdirSync(skillsSrc).sort()) {
      if (skills.length >= MAX_ENTRIES) break;
      if (!ENTRY_NAME_RE.test(n)) continue;
      const real = realOrNull(join(skillsSrc, n));
      if (!real || !inside(rootReal, real)) continue;
      const md = confinedFile(join(real, "SKILL.md"), rootReal);
      if (md && statSync(md).size <= MAX_ENTRY_BYTES) skills.push(n);
    }
  }
  const commands = commandsSrc ? markdownFiles(commandsSrc, rootReal) : [];
  const agents = agentsSrc ? markdownFiles(agentsSrc, rootReal) : [];
  if (skills.length + commands.length + agents.length === 0) return null;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PROJECT_PLUGIN_NAME, description: "Skills, commands and agents of this project's .claude folder" }));
  for (const n of skills) {
    const real = realOrNull(join(skillsSrc!, n))!;
    const out = join(dir, "skills", n);
    copySanitized(join(real, "SKILL.md"), join(out, "SKILL.md"));
    // The rest of the skill's folder (scripts, references) stays where it is, reached through symlinks that point inside the cwd.
    for (const e of readdirSync(real)) {
      if (e === "SKILL.md") continue;
      const target = realOrNull(join(real, e));
      if (target && inside(rootReal, target)) symlinkSync(target, join(out, e));
    }
  }
  for (const rel of commands) copySanitized(join(commandsSrc!, rel), join(dir, "commands", rel));
  for (const rel of agents) copySanitized(join(agentsSrc!, rel), join(dir, "agents", rel));
  return dir;
}

/** A stable UUID-shaped name for a key (a user, or a user and a working directory). */
export function pluginUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Folders 0755 and files 0644 below `dir` (symlinks left alone): readable by the agent account, writable by nobody else. */
function lockDown(dir: string): void {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) lockDown(p);
    else chmodSync(p, 0o644);
  }
}

/**
 * Publishes a generated plugin as `<root>/<uuid(key)>/<name>` (`name` is `project` or `workstation`, the only names the
 * agent wrapper accepts). The plugin is built in a temporary folder inside `root`, given modes without group or other
 * write whatever the umask is, and renamed into place, so a half-built plugin is never seen. `root` is a folder the agent
 * account can read but not write (`[paths] agent_plugins_dir`); `build(dir)` fills `dir` and returns it, or null when
 * there is nothing to publish (any older plugin of that name is then removed).
 */
export function publishPlugin(root: string, key: string, name: "project" | "workstation", build: (dir: string) => string | null): string | null {
  const parent = join(root, pluginUuid(key));
  const target = join(parent, name);
  const tmp = join(root, `.build-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true, mode: 0o755 });
  try {
    const made = build(join(tmp, name));
    if (!made) {
      rmSync(target, { recursive: true, force: true });
      return null;
    }
    lockDown(tmp);
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755);
    rmSync(target, { recursive: true, force: true });
    renameSync(made, target);
    return target;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Whether a generated plugin directory still exists (used by tests and by reloads). */
export function pluginExists(dir: string): boolean {
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) && lstatSync(dir).isDirectory();
}
