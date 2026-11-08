/**
 * Skills (SKILL.md folders) per user plus admin-provided global ones.
 *
 *   user    <users_root>/<user>/.claude/skills/<name>/SKILL.md
 *   global  <users_root>/_global/skills/<name>/SKILL.md
 *
 * How sessions see them (verified live against Claude Code 2.1.316, see README):
 * code sessions load `settingSources: ['project']`, and Claude Code looks for
 * `.claude/skills` in the cwd and every parent directory up to the enclosing git
 * repository root (or the file-system root when there is none). Every code-session
 * cwd lies inside the user root, so
 *   - user skills are found as-is (`<user root>/.claude/skills` is an ancestor), and
 *   - global skills are found through ONE symlink, `<users_root>/.claude/skills ->
 *     ../_global/skills`, which is an ancestor of every user root. It lives outside
 *     every workspace, so nothing is ever written into a project or a user's folder.
 * Synced projects have no `.git` in their work tree (the review repo is outside),
 * so the walk-up always reaches both. Only a cwd inside a nested git repository
 * (a clone the user made in the terminal) stops the walk-up early; for those the
 * session gets one extra `additionalDirectories` entry: a hub-owned overlay
 * `<data_dir>/skill-overlays/<user>/.claude/skills/` with symlinks to the user's
 * and the global skills, rebuilt at every spawn.
 *
 * With `[sessions] project_settings` off (the default) sessions load no settings files at all, so none of the above
 * applies: the user's and the global skills reach the CLI as one generated plugin (`workstation`, symlinks to the skill
 * folders) and the project's own `.claude/skills|commands|agents` as another (`project`, see sessions/projectContext.ts),
 * both rebuilt at every spawn. Plugin skills are namespaced by the CLI: `/workstation:<name>`, `/project:<name>`.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { CommandInfo, Skill, SkillDetail } from "@agent-workstation/protocol";
import { HttpError, notFound } from "../util/errors.js";
import { buildProjectPlugin, publishPlugin } from "../sessions/projectContext.js";
import { shortId } from "../util/ids.js";
import type { Logger } from "../util/log.js";

export type SkillScope = "user" | "global";

export const SKILL_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const SKILL_FILE = "SKILL.md";
export const GLOBAL_USER_DIR = "_global";
export const MAX_SKILL_BYTES = 512 * 1024;
/** The plugin name of the user's and the global skills when project settings are ignored (their namespace: `/workstation:<name>`). */
export const SKILLS_PLUGIN_NAME = "workstation";

export interface SkillServiceDeps {
  usersRoot: string;
  userRoot: (user: string) => string;
  dataDir: string;
  /** Parent of the per-user overlays (default `<dataDir>/skill-overlays`; with run_as a folder the agent can read). */
  overlayRoot?: string;
  /**
   * Where the generated plugins are published (`[paths] agent_plugins_dir`): a folder the agent account can read but not
   * write. Default `<dataDir>/agent-plugins`.
   */
  pluginsDir?: string;
  log: Logger;
}

// --------------------------------------------------------------- frontmatter

/** Splits a leading `---` YAML block from the body. */
export function splitFrontmatter(text: string): { fm: string[] | null; body: string } {
  const t = text.replace(/^﻿/, "");
  if (!/^---\r?\n/.test(t)) return { fm: null, body: t };
  const lines = t.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") return { fm: lines.slice(1, i), body: lines.slice(i + 1).join("\n") };
  }
  return { fm: null, body: t };
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Reads a top-level scalar (plain, quoted, or `>`/`|` block) from frontmatter lines. */
export function frontmatterValue(fm: string[], key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < fm.length; i++) {
    const m = re.exec(fm[i]!);
    if (!m) continue;
    const v = (m[1] ?? "").trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block: string[] = [];
      for (let j = i + 1; j < fm.length && (/^\s+/.test(fm[j]!) || fm[j] === ""); j++) block.push(fm[j]!.trim());
      return v.startsWith(">") ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    }
    return unquote(v);
  }
  return null;
}

/** Ensures a frontmatter block whose `name:` equals the skill name (adds a description when missing). */
export function normalizeSkillContent(name: string, content: string): string {
  const { fm, body } = splitFrontmatter(content);
  if (!fm) {
    const first = body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0);
    const description = (first ?? name).slice(0, 200);
    return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.replace(/^\s*\n/, "")}`;
  }
  const lines = [...fm];
  const idx = lines.findIndex((l) => /^name:/.test(l));
  if (idx >= 0) lines[idx] = `name: ${name}`;
  else lines.unshift(`name: ${name}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export function skillDescription(content: string): string {
  const { fm, body } = splitFrontmatter(content);
  const d = fm ? frontmatterValue(fm, "description") : null;
  if (d) return d;
  return (
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0) ?? ""
  ).slice(0, 200);
}

// ------------------------------------------------------------------- service

export class SkillService {
  readonly globalDir: string;

  constructor(private readonly deps: SkillServiceDeps) {
    this.globalDir = join(deps.usersRoot, GLOBAL_USER_DIR, "skills");
  }

  userDir(user: string): string {
    return join(this.deps.userRoot(user), ".claude", "skills");
  }

  dirFor(user: string, scope: SkillScope): string {
    return scope === "global" ? this.globalDir : this.userDir(user);
  }

  /** Creates the global dir and the `<users_root>/.claude/skills -> ../_global/skills` link. */
  init(): void {
    mkdirSync(this.globalDir, { recursive: true });
    const linkDir = join(this.deps.usersRoot, ".claude");
    const link = join(linkDir, "skills");
    const target = join("..", GLOBAL_USER_DIR, "skills");
    mkdirSync(linkDir, { recursive: true });
    let st;
    try {
      st = lstatSync(link);
    } catch {
      symlinkSync(target, link);
      this.deps.log.info({ link, target }, "global skills linked for session discovery");
      return;
    }
    if (!st.isSymbolicLink()) {
      this.deps.log.warn({ link }, "users_root/.claude/skills exists and is not a symlink; global skills are only visible where it lists them");
    } else if (readlinkSync(link) !== target) {
      this.deps.log.warn({ link, current: readlinkSync(link), expected: target }, "users_root/.claude/skills points elsewhere; leaving it");
    }
  }

  private async readSkill(dir: string, name: string, scope: SkillScope): Promise<SkillDetail | null> {
    if (!SKILL_NAME_RE.test(name)) return null;
    const file = join(dir, name, SKILL_FILE);
    try {
      const st = await stat(file);
      if (!st.isFile()) return null;
      const content = await readFile(file, "utf8");
      return { name, description: skillDescription(content), scope, updatedAt: st.mtime.toISOString(), content };
    } catch {
      return null;
    }
  }

  private async listScope(user: string, scope: SkillScope): Promise<Skill[]> {
    const dir = this.dirFor(user, scope);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => SKILL_NAME_RE.test(n)).sort();
    } catch {
      return [];
    }
    const out: Skill[] = [];
    for (const n of names) {
      const s = await this.readSkill(dir, n, scope);
      if (s) out.push({ name: s.name, description: s.description, scope: s.scope, updatedAt: s.updatedAt });
    }
    return out;
  }

  /** The user's skills, then the global ones. */
  async list(user: string): Promise<Skill[]> {
    return [...(await this.listScope(user, "user")), ...(await this.listScope(user, "global"))];
  }

  /** Without `scope`, the user's skill wins over a global one of the same name. */
  async get(user: string, name: string, scope?: SkillScope): Promise<SkillDetail> {
    for (const sc of scope ? [scope] : (["user", "global"] as const)) {
      const s = await this.readSkill(this.dirFor(user, sc), name, sc);
      if (s) return s;
    }
    throw notFound(`no such skill: ${name}`);
  }

  private assertWritable(scope: SkillScope, isAdmin: boolean): void {
    if (scope === "global" && !isAdmin) throw new HttpError(403, "admin_required", "only an admin can change global skills");
  }

  private assertName(name: string): void {
    if (!SKILL_NAME_RE.test(name)) throw new HttpError(400, "invalid_request", "skill name must match [a-z0-9-]{1,64}");
  }

  private async write(dir: string, name: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new HttpError(413, "too_large", `SKILL.md must be at most ${MAX_SKILL_BYTES} bytes`);
    const skillDir = join(dir, name);
    await mkdir(skillDir, { recursive: true });
    const tmp = join(skillDir, `.${SKILL_FILE}.${shortId(6)}.tmp`);
    await writeFile(tmp, normalizeSkillContent(name, content), "utf8");
    await rename(tmp, join(skillDir, SKILL_FILE));
  }

  private exists(dir: string, name: string): boolean {
    return existsSync(join(dir, name));
  }

  async create(user: string, body: { name: string; content: string; scope: SkillScope }, isAdmin: boolean): Promise<Skill> {
    this.assertName(body.name);
    this.assertWritable(body.scope, isAdmin);
    const dir = this.dirFor(user, body.scope);
    if (this.exists(dir, body.name)) throw new HttpError(409, "skill_exists", `a ${body.scope} skill named ${body.name} already exists`);
    await this.write(dir, body.name, body.content);
    return this.summary(await this.get(user, body.name, body.scope));
  }

  /** PUT: replaces SKILL.md; a different `body.name` renames the skill folder. */
  async update(user: string, name: string, body: { name: string; content: string; scope: SkillScope }, isAdmin: boolean): Promise<Skill> {
    this.assertName(name);
    this.assertName(body.name);
    this.assertWritable(body.scope, isAdmin);
    const dir = this.dirFor(user, body.scope);
    if (!this.exists(dir, name)) throw notFound(`no such ${body.scope} skill: ${name}`);
    if (body.name !== name) {
      if (this.exists(dir, body.name)) throw new HttpError(409, "skill_exists", `a ${body.scope} skill named ${body.name} already exists`);
      await rename(join(dir, name), join(dir, body.name));
    }
    await this.write(dir, body.name, body.content);
    return this.summary(await this.get(user, body.name, body.scope));
  }

  /** User-initiated delete of one skill folder. */
  async remove(user: string, name: string, scope: SkillScope, isAdmin: boolean): Promise<void> {
    this.assertName(name);
    this.assertWritable(scope, isAdmin);
    const dir = this.dirFor(user, scope);
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      throw notFound(`no such ${scope} skill: ${name}`);
    }
    if (st.isSymbolicLink()) unlinkSync(p);
    else await rm(p, { recursive: true, force: false });
    this.deps.log.info({ user, name, scope }, "skill deleted");
  }

  /** Skills as slash commands (for the palette before a session process exists); `qualified`: as the plugin names them. */
  async commandInfos(user: string, qualified = false): Promise<CommandInfo[]> {
    const seen = new Set<string>();
    const out: CommandInfo[] = [];
    for (const s of await this.list(user)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      // As a plugin the CLI names them `workstation:<name>`.
      out.push({ name: qualified ? `${SKILLS_PLUGIN_NAME}:${s.name}` : s.name, description: s.description, isSkill: true });
    }
    return out;
  }

  private summary(d: SkillDetail): Skill {
    return { name: d.name, description: d.description, scope: d.scope, updatedAt: d.updatedAt };
  }

  // ------------------------------------------------- nested git repositories

  /**
   * `additionalDirectories` for a code session: empty unless the cwd is inside a
   * git repository nested in the user root (where Claude Code's upward search for
   * `.claude/skills` stops). Then: the rebuilt per-user overlay directory.
   */
  skillDirsFor(user: string, cwdAbs: string): string[] {
    const root = this.deps.userRoot(user);
    const rel = relative(root, cwdAbs);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return [];
    let nested = false;
    for (let cur = cwdAbs; cur !== root && cur.startsWith(root + sep); cur = dirname(cur)) {
      if (existsSync(join(cur, ".git"))) {
        nested = true;
        break;
      }
    }
    if (!nested) return [];
    try {
      return [this.buildOverlay(user)];
    } catch (err) {
      this.deps.log.warn({ user, err: String(err) }, "could not build the skills overlay");
      return [];
    }
  }

  private overlayBase(): string {
    return this.deps.overlayRoot ?? join(this.deps.dataDir, "skill-overlays");
  }

  /**
   * Plugin directories for a code session that loads no settings files: the user's and the global skills (when there
   * are any) and the project's own skills, commands and agents (when the cwd has them), published as
   * `<plugins dir>/<uuid>/(workstation|project)` (sessions/projectContext.ts publishPlugin). Rebuilt on every call.
   */
  pluginsFor(user: string, cwdAbs: string): string[] {
    const root = this.deps.pluginsDir ?? join(this.deps.dataDir, "agent-plugins");
    const out: string[] = [];
    try {
      const dir = publishPlugin(root, `workstation:${user}`, "workstation", (tmp) => this.buildSkillsPlugin(user, tmp));
      if (dir) out.push(dir);
    } catch (err) {
      this.deps.log.warn({ user, err: String(err) }, "could not build the skills plugin");
    }
    try {
      const dir = publishPlugin(root, `project:${user}:${cwdAbs}`, "project", (tmp) => buildProjectPlugin(cwdAbs, tmp));
      if (dir) out.push(dir);
    } catch (err) {
      this.deps.log.warn({ user, err: String(err) }, "could not build the project plugin");
    }
    return out;
  }

  /** Fills `dir` with a plugin whose `skills/` holds symlinks to the user's and global skills; null when there are none. */
  buildSkillsPlugin(user: string, base: string): string | null {
    const dir = join(base, "skills");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(base, ".claude-plugin"), { recursive: true });
    writeFileSync(join(base, ".claude-plugin", "plugin.json"), JSON.stringify({ name: SKILLS_PLUGIN_NAME, description: "Your skills and the global skills" }));
    let n = 0;
    const add = (srcDir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(srcDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!SKILL_NAME_RE.test(name) || existsSync(join(dir, name)) || !existsSync(join(srcDir, name, SKILL_FILE))) continue;
        symlinkSync(join(srcDir, name), join(dir, name));
        n++;
      }
    };
    add(this.userDir(user));
    add(this.globalDir);
    return n > 0 ? base : null;
  }

  /** `<data_dir>/skill-overlays/<user>/.claude/skills/<name>` → symlinks (user wins over global). */
  buildOverlay(user: string): string {
    const base = join(this.overlayBase(), user);
    const dir = join(base, ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) unlinkSync(join(dir, e.name)); // only our links live here
    }
    const add = (srcDir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(srcDir);
      } catch {
        return;
      }
      for (const n of names) {
        if (!SKILL_NAME_RE.test(n) || existsSync(join(dir, n)) || !existsSync(join(srcDir, n, SKILL_FILE))) continue;
        symlinkSync(join(srcDir, n), join(dir, n));
      }
    };
    add(this.userDir(user));
    add(this.globalDir);
    return base;
  }
}
