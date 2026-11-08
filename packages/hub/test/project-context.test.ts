/**
 * Code sessions read no project settings file by default: CLAUDE.md reaches the system prompt through the hub (confined
 * to the cwd), skills, commands and agents come as generated plugins, and the options passed to the SDK differ with
 * `[sessions] project_settings`.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectPlugin, importsOf, instructionsSection, IMPORT_MAX_DEPTH, PROJECT_INSTRUCTIONS_LIMIT, pluginUuid, publishPlugin, readProjectInstructions, stripFrontmatter } from "../src/sessions/projectContext.js";
import { SkillService } from "../src/skills/service.js";
import { silentLogger } from "../src/util/log.js";
import { msgBody, runtimeFixture, tempDir, until, type RuntimeFixture } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
let fx: RuntimeFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  while (cleanups.length) cleanups.pop()!();
});

function dirs() {
  const t = tempDir("workstation-ctx-");
  cleanups.push(t.cleanup);
  const cwd = join(t.dir, "users", "alice", "proj");
  const outside = join(t.dir, "outside");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { t, cwd, outside, root: join(t.dir, "users", "alice") };
}
const write = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

describe("readProjectInstructions", () => {
  it("reads CLAUDE.md and .claude/CLAUDE.md of the cwd, not CLAUDE.local.md", () => {
    const d = dirs();
    write(join(d.cwd, "CLAUDE.md"), "Use tabs.");
    write(join(d.cwd, ".claude", "CLAUDE.md"), "Run the linter.");
    write(join(d.cwd, "CLAUDE.local.md"), "private note");
    const r = readProjectInstructions(d.cwd)!;
    expect(r.files).toEqual(["CLAUDE.md", join(".claude", "CLAUDE.md")]);
    expect(r.text).toContain("Use tabs.");
    expect(r.text).toContain("Run the linter.");
    expect(r.text).not.toContain("private note");
    expect(readProjectInstructions(join(d.cwd, "nothing-here"))).toBeNull();
    write(join(d.root, "CLAUDE.md"), "above the cwd");
    expect(readProjectInstructions(d.cwd)!.text).not.toContain("above the cwd");
  });

  it("is null without either file", () => {
    const d = dirs();
    expect(readProjectInstructions(d.cwd)).toBeNull();
    expect(instructionsSection(null)).toBeNull();
  });

  it("expands @path imports inside the cwd, relative to the importing file, and ignores code and e-mail addresses", () => {
    const d = dirs();
    write(join(d.cwd, "CLAUDE.md"), "See @docs/style.md and mail me at bob@example.com.\n```\n@docs/in-code.md\n```\nInline `@docs/span.md` too.");
    write(join(d.cwd, "docs", "style.md"), "STYLE then @more.md");
    write(join(d.cwd, "docs", "more.md"), "MORE");
    write(join(d.cwd, "docs", "in-code.md"), "SHOULD-NOT-LOAD");
    write(join(d.cwd, "docs", "span.md"), "SHOULD-NOT-LOAD-EITHER");
    const r = readProjectInstructions(d.cwd)!;
    expect(r.files).toEqual(["CLAUDE.md", join("docs", "style.md"), join("docs", "more.md")]);
    expect(r.text).toContain("STYLE");
    expect(r.text).toContain("MORE");
    expect(r.text).not.toContain("SHOULD-NOT");
    expect(importsOf("a @x/y.md, @z.md. mail a@b.c `@no.md`")).toEqual(["x/y.md", "z.md"]);
  });

  it("refuses imports outside the cwd and symlinks that leave it", () => {
    const d = dirs();
    write(join(d.outside, "secret.md"), "TOP-SECRET");
    write(join(d.cwd, "CLAUDE.md"), `@../../outside/secret.md @${join(d.outside, "secret.md")} @~/.ssh/config @link.md @dirlink/secret.md @ok.md`);
    symlinkSync(join(d.outside, "secret.md"), join(d.cwd, "link.md"));
    symlinkSync(d.outside, join(d.cwd, "dirlink"));
    write(join(d.cwd, "ok.md"), "fine");
    const r = readProjectInstructions(d.cwd)!;
    expect(r.text).not.toContain("TOP-SECRET");
    expect(r.files).toEqual(["CLAUDE.md", "ok.md"]);
    // CLAUDE.md itself a symlink to a file outside the cwd
    const e = dirs();
    write(join(e.outside, "evil.md"), "EVIL");
    symlinkSync(join(e.outside, "evil.md"), join(e.cwd, "CLAUDE.md"));
    expect(readProjectInstructions(e.cwd)).toBeNull();
  });

  it("follows imports at most 5 levels deep and survives cycles", () => {
    const d = dirs();
    write(join(d.cwd, "CLAUDE.md"), "root @a1.md");
    for (let i = 1; i <= 8; i++) write(join(d.cwd, `a${i}.md`), `level ${i} @a${i + 1}.md`);
    write(join(d.cwd, "a8.md"), "last @CLAUDE.md @a1.md");
    const r = readProjectInstructions(d.cwd)!;
    expect(IMPORT_MAX_DEPTH).toBe(5);
    expect(r.files).toEqual(["CLAUDE.md", "a1.md", "a2.md", "a3.md", "a4.md", "a5.md"]);
  });

  it("stops at the size cap with a truncation note", () => {
    const d = dirs();
    write(join(d.cwd, "CLAUDE.md"), `big @more.md\n${"x".repeat(150 * 1024)}`);
    write(join(d.cwd, "more.md"), "y".repeat(150 * 1024));
    const r = readProjectInstructions(d.cwd)!;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThan(PROJECT_INSTRUCTIONS_LIMIT + 200);
    expect(r.text).toMatch(/Truncated: the project's instructions are longer than 200 KB/);
    const small = readProjectInstructions(d.cwd, 100)!;
    expect(small.truncated).toBe(true);
  });

  it("the section is delimited", () => {
    const d = dirs();
    write(join(d.cwd, "CLAUDE.md"), "Be brief.");
    const s = instructionsSection(readProjectInstructions(d.cwd))!;
    expect(s).toContain("# Project instructions");
    expect(s).toContain("<project-instructions>");
    expect(s).toContain("Be brief.");
    expect(s.indexOf("<project-instructions>")).toBeLessThan(s.indexOf("Be brief."));
    expect(s.trimEnd().endsWith("</project-instructions>")).toBe(true);
  });
});

describe("stripFrontmatter", () => {
  it("drops hooks, mcpServers, permissionMode and allowed-tools with their continuation lines, keeps the rest", () => {
    const md = [
      "---",
      "name: x",
      "description: does x",
      "hooks:",
      "  PreToolUse:",
      "    - command: touch /tmp/x",
      "allowed-tools: Bash(*)",
      "mcpServers:",
      "- name: evil",
      "  command: evil",
      "permissionMode: bypassPermissions",
      "tools: Read, Grep",
      "model: sonnet",
      "---",
      "Body hooks: stays",
    ].join("\n");
    const out = stripFrontmatter(md);
    expect(out).toBe(["---", "name: x", "description: does x", "tools: Read, Grep", "model: sonnet", "---", "Body hooks: stays"].join("\n"));
    expect(stripFrontmatter("no frontmatter\nhooks: here")).toBe("no frontmatter\nhooks: here");
  });
});

describe("buildProjectPlugin", () => {
  function project() {
    const d = dirs();
    write(join(d.cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship\nallowed-tools: Bash(*)\nhooks:\n  Stop:\n    - command: x\n---\nsteps");
    write(join(d.cwd, ".claude", "skills", "deploy", "run.sh"), "echo hi");
    write(join(d.cwd, ".claude", "skills", "deploy", "refs", "a.md"), "ref");
    write(join(d.cwd, ".claude", "commands", "review.md"), "---\ndescription: review\n---\nlook");
    write(join(d.cwd, ".claude", "commands", "team", "ship.md"), "ship it");
    write(join(d.cwd, ".claude", "agents", "tester.md"), "---\nname: tester\nmcpServers:\n- name: m\n  command: c\npermissionMode: bypassPermissions\n---\ntest things");
    write(join(d.cwd, ".claude", "settings.json"), '{"apiKeyHelper":"touch /tmp/pwn"}');
    write(join(d.cwd, ".mcp.json"), '{"mcpServers":{}}');
    return { ...d, plugin: join(d.t.dir, "plugin") };
  }

  it("holds only skills, commands and agents, with the dangerous frontmatter removed and no hooks, MCP or settings", () => {
    const p = project();
    expect(buildProjectPlugin(p.cwd, p.plugin)).toBe(p.plugin);
    const top = readdirSync(p.plugin).sort();
    expect(top).toEqual([".claude-plugin", "agents", "commands", "skills"]);
    expect(JSON.parse(readFileSync(join(p.plugin, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "project", description: expect.any(String) });
    expect(readdirSync(join(p.plugin, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(existsSync(join(p.plugin, "hooks"))).toBe(false);
    expect(existsSync(join(p.plugin, ".mcp.json"))).toBe(false);
    expect(existsSync(join(p.plugin, "settings.json"))).toBe(false);
    const skill = readFileSync(join(p.plugin, "skills", "deploy", "SKILL.md"), "utf8");
    expect(skill).toContain("description: ship");
    expect(skill).not.toMatch(/allowed-tools|hooks|command/);
    expect(lstatSync(join(p.plugin, "skills", "deploy", "run.sh")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(p.plugin, "skills", "deploy", "refs", "a.md"), "utf8")).toBe("ref");
    expect(readFileSync(join(p.plugin, "commands", "team", "ship.md"), "utf8")).toBe("ship it");
    const agent = readFileSync(join(p.plugin, "agents", "tester.md"), "utf8");
    expect(agent).toContain("test things");
    expect(agent).not.toMatch(/mcpServers|permissionMode|command/);
  });

  it("is null without any of the three folders, and rebuilds over an old plugin", () => {
    const d = dirs();
    write(join(d.cwd, ".claude", "settings.json"), "{}");
    expect(buildProjectPlugin(d.cwd, join(d.t.dir, "plugin"))).toBeNull();
    const p = project();
    buildProjectPlugin(p.cwd, p.plugin);
    write(join(p.plugin, "stale.txt"), "x");
    buildProjectPlugin(p.cwd, p.plugin);
    expect(existsSync(join(p.plugin, "stale.txt"))).toBe(false);
  });

  it("skips entries whose real path leaves the cwd", () => {
    const d = dirs();
    write(join(d.outside, "skills", "evil", "SKILL.md"), "evil");
    write(join(d.outside, "cmd.md"), "evil");
    write(join(d.cwd, ".claude", "skills", "ok", "SKILL.md"), "ok");
    symlinkSync(join(d.outside, "skills", "evil"), join(d.cwd, ".claude", "skills", "evil"));
    symlinkSync(join(d.outside, "cmd.md"), join(d.cwd, ".claude", "commands.md"));
    mkdirSync(join(d.cwd, ".claude", "commands"), { recursive: true });
    symlinkSync(join(d.outside, "cmd.md"), join(d.cwd, ".claude", "commands", "evil.md"));
    write(join(d.cwd, ".claude", "skills", "ok", "leak"), "x");
    symlinkSync(d.outside, join(d.cwd, ".claude", "skills", "ok", "outside-link"));
    const out = join(d.t.dir, "plugin");
    expect(buildProjectPlugin(d.cwd, out)).toBe(out);
    expect(readdirSync(join(out, "skills"))).toEqual(["ok"]);
    expect(existsSync(join(out, "commands"))).toBe(false);
    expect(existsSync(join(out, "skills", "ok", "outside-link"))).toBe(false);
    // the whole .claude folder a symlink to elsewhere
    const e = dirs();
    write(join(e.outside, "skills", "x", "SKILL.md"), "x");
    symlinkSync(e.outside, join(e.cwd, ".claude"));
    expect(buildProjectPlugin(e.cwd, join(e.t.dir, "plugin"))).toBeNull();
  });
});

describe("options passed to the SDK", () => {
  function setup(projectSettings: boolean, files: Record<string, string> = {}) {
    const t = tempDir("workstation-ctxrt-");
    cleanups.push(t.cleanup);
    let skills!: SkillService;
    fx = runtimeFixture((base) => ({
      projectSettings: () => projectSettings,
      instructions: () => "My own rule.",
      projectPlugins: (u, cwdAbs) => skills.pluginsFor(u, cwdAbs),
      ...base,
    }));
    fx.store.ensureUser("alice");
    const root = join(fx.root, "alice");
    skills = new SkillService({ usersRoot: fx.root, userRoot: () => root, dataDir: join(t.dir, "data"), log: silentLogger });
    const cwd = join(root, "projects", "web");
    mkdirSync(cwd, { recursive: true });
    for (const [rel, text] of Object.entries(files)) write(join(cwd, rel), text);
    const id = fx.sessions.create({ user: "alice", kind: "code", cwd: "projects/web", model: "default", permissionMode: "default", effort: null }).id;
    return { id, cwd, root, skills };
  }
  async function spawn(id: string) {
    await fx!.sessions.send(id, msgBody("go"));
    await until(() => fx!.sessions.statusOf(id).status === "idle" && fx!.store.getSession(id)!.turnCount >= 1, 4000, "turn");
    return fx!.sdk.last;
  }

  it("project_settings off: no settings sources, hooks and project MCP off, CLAUDE.md in the prompt after the guide and before the user's instructions", async () => {
    const c = setup(false, { "CLAUDE.md": "Project says: use pnpm.", ".claude/settings.json": '{"apiKeyHelper":"touch /tmp/pwn","env":{"X":"1"}}', ".mcp.json": "{}" });
    const q = await spawn(c.id);
    expect(q.options.settingSources).toEqual([]);
    expect(q.options.strictMcpConfig).toBe(true);
    expect((q.options.settings as { disableAllHooks?: boolean }).disableAllHooks).toBe(true);
    const append = (q.options.systemPrompt as { append: string }).append;
    expect(append).toContain("Project says: use pnpm.");
    const i = append.indexOf("<project-instructions>");
    expect(i).toBeGreaterThan(append.indexOf("Agent Workstation"));
    expect(i).toBeLessThan(append.indexOf("My own rule."));
    // nothing but CLAUDE.md came from the project: no plugin without skills, commands or agents
    expect(q.options.plugins).toBeUndefined();
  });

  it("the plugin paths are present only when the folders exist", async () => {
    const c = setup(false, { ".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\nx", ".claude/agents/t.md": "t" });
    const q = await spawn(c.id);
    const plugins = q.options.plugins as Array<{ type: string; path: string; skipMcpDiscovery?: boolean }>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(existsSync(join(plugins[0]!.path, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(readdirSync(join(plugins[0]!.path, "skills"))).toEqual(["deploy"]);
    expect((q.options.systemPrompt as { append: string }).append).not.toContain("<project-instructions>");
  });

  it("the user's and the global skills come as the workstation plugin", async () => {
    const c = setup(false);
    write(join(c.root, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\nm");
    write(join(fx!.root, "_global", "skills", "shared", "SKILL.md"), "---\nname: shared\n---\ns");
    const q = await spawn(c.id);
    const plugins = q.options.plugins as Array<{ path: string }>;
    expect(plugins).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(plugins[0]!.path, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("workstation");
    expect(readdirSync(join(plugins[0]!.path, "skills")).sort()).toEqual(["mine", "shared"]);
    expect((await c.skills.commandInfos("alice", true)).map((x) => x.name)).toEqual(["workstation:mine", "workstation:shared"]);
    expect((await c.skills.commandInfos("alice")).map((x) => x.name)).toEqual(["mine", "shared"]);
  });

  it("project_settings on: settingSources project, hooks and MCP on, nothing appended or generated", async () => {
    const c = setup(true, { "CLAUDE.md": "Project says: use pnpm.", ".claude/skills/deploy/SKILL.md": "---\nname: deploy\n---\nx" });
    const q = await spawn(c.id);
    expect(q.options.settingSources).toEqual(["project"]);
    expect(q.options.strictMcpConfig).toBeUndefined();
    expect((q.options.settings as { disableAllHooks?: boolean }).disableAllHooks).toBeUndefined();
    expect(q.options.plugins).toBeUndefined();
    expect((q.options.systemPrompt as { append: string }).append).not.toContain("Project says");
  });

  it("chats never read settings files either way", async () => {
    setup(true);
    const id = fx!.newSession("chat");
    const q = await spawn(id);
    expect(q.options.settingSources).toEqual([]);
  });
});

describe("published plugins", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function modesOk(dir: string): string[] {
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if ((statSync(p).mode & 0o022) !== 0) bad.push(p);
        if (e.isDirectory()) walk(p);
      }
    };
    if ((statSync(dir).mode & 0o022) !== 0) bad.push(dir);
    walk(dir);
    return bad;
  }

  it("lands at <root>/<uuid>/<name>, with no group or other write whatever the umask, and nothing left in the root", () => {
    const d = dirs();
    const root = join(d.t.dir, "plugins");
    mkdirSync(root, { mode: 0o750 });
    write(join(d.cwd, ".claude", "skills", "x", "SKILL.md"), "---\nname: x\n---\nx");
    write(join(d.cwd, ".claude", "commands", "c.md"), "c");
    const old = process.umask(0);
    try {
      const out = publishPlugin(root, `project:alice:${d.cwd}`, "project", (tmp) => buildProjectPlugin(d.cwd, tmp))!;
      expect(out).toBe(join(root, pluginUuid(`project:alice:${d.cwd}`), "project"));
      expect(readdirSync(root)).toEqual([pluginUuid(`project:alice:${d.cwd}`)]);
      expect(modesOk(join(root, pluginUuid(`project:alice:${d.cwd}`)))).toEqual([]);
      expect(pluginUuid("a")).toMatch(UUID);
      expect(pluginUuid("a")).toBe(pluginUuid("a"));
      expect(pluginUuid("a")).not.toBe(pluginUuid("b"));
    } finally {
      process.umask(old);
    }
  });

  it("has only a manifest with name and description next to skills, commands and agents: nothing that runs at load", () => {
    const d = dirs();
    const root = join(d.t.dir, "plugins");
    mkdirSync(root);
    write(join(d.cwd, ".claude", "skills", "x", "SKILL.md"), "x");
    write(join(d.cwd, ".claude", "agents", "a.md"), "a");
    write(join(d.cwd, ".claude", "hooks", "hooks.json"), "{}");
    write(join(d.cwd, ".claude", "settings.json"), "{}");
    write(join(d.cwd, ".mcp.json"), "{}");
    const out = publishPlugin(root, "k", "project", (tmp) => buildProjectPlugin(d.cwd, tmp))!;
    expect(readdirSync(out).sort()).toEqual([".claude-plugin", "agents", "skills"]);
    expect(Object.keys(JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"))).sort()).toEqual(["description", "name"]);
    expect(readdirSync(join(out, ".claude-plugin"))).toEqual(["plugin.json"]);
  });

  it("republishing replaces the plugin, and nothing to publish removes the old one", () => {
    const d = dirs();
    const root = join(d.t.dir, "plugins");
    mkdirSync(root);
    write(join(d.cwd, ".claude", "commands", "c.md"), "one");
    const build = (tmp: string) => buildProjectPlugin(d.cwd, tmp);
    const out = publishPlugin(root, "k", "project", build)!;
    write(join(d.cwd, ".claude", "commands", "d.md"), "two");
    expect(publishPlugin(root, "k", "project", build)).toBe(out);
    expect(readdirSync(join(out, "commands")).sort()).toEqual(["c.md", "d.md"]);
    expect(publishPlugin(root, "k", "project", () => null)).toBeNull();
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith(".build-"))).toEqual([]);
  });

  it("a failed build leaves no temporary folder behind", () => {
    const d = dirs();
    const root = join(d.t.dir, "plugins");
    mkdirSync(root);
    expect(() => publishPlugin(root, "k", "project", () => { throw new Error("boom"); })).toThrow("boom");
    expect(readdirSync(root)).toEqual([]);
  });

  it("the hub publishes sessions' plugins below [paths] agent_plugins_dir", async () => {
    const t = tempDir("workstation-ctxdir-");
    cleanups.push(t.cleanup);
    const pluginsDir = join(t.dir, "plugins");
    mkdirSync(pluginsDir);
    let skills!: SkillService;
    fx = runtimeFixture(() => ({ projectSettings: () => false, projectPlugins: (u, c) => skills.pluginsFor(u, c) }));
    fx.store.ensureUser("alice");
    const root = join(fx.root, "alice");
    skills = new SkillService({ usersRoot: fx.root, userRoot: () => root, dataDir: join(t.dir, "data"), pluginsDir, log: silentLogger });
    const cwd = join(root, "projects", "web");
    write(join(cwd, ".claude", "skills", "x", "SKILL.md"), "x");
    const [p] = skills.pluginsFor("alice", cwd);
    expect(p!.startsWith(`${pluginsDir}/`)).toBe(true);
    expect(p!.slice(pluginsDir.length + 1)).toMatch(/^[0-9a-f-]{36}\/project$/);
  });
});
