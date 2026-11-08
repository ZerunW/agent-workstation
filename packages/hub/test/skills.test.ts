/** Skills CRUD, discovery wiring (global symlink, nested-git overlay), exclusions; replay cap. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { CommandsResponse, ErrorBody, ServerEvent, Skill, SkillDetail, SkillsResponse } from "@agent-workstation/protocol";
import { isIgnoredPath } from "../src/files/watcher.js";
import { hiddenFromTree } from "../src/files/tree.js";
import { frontmatterValue, normalizeSkillContent, skillDescription, splitFrontmatter } from "../src/skills/service.js";
import { REPLAY_MAX } from "../src/ws/server.js";
import { WS_UPGRADE, hubFixture, until, type HubFixture } from "./helpers.js";

let f: HubFixture;
beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

describe("frontmatter helpers", () => {
  it("parses plain, quoted and block descriptions", () => {
    const { fm, body } = splitFrontmatter("---\nname: x\ndescription: \"a: b\"\n---\nbody\n");
    expect(fm).toEqual(["name: x", 'description: "a: b"']);
    expect(body).toBe("body\n");
    expect(frontmatterValue(["description: >", "  folded", "  text", "other: 1"], "description")).toBe("folded text");
    expect(frontmatterValue(["description: 'it''s'"], "description")).toBe("it's");
    expect(skillDescription("# Title line\n\nmore")).toBe("Title line");
  });

  it("forces the name and adds missing frontmatter", () => {
    expect(normalizeSkillContent("my-skill", "---\nname: other\ndescription: d\n---\nBody")).toBe("---\nname: my-skill\ndescription: d\n---\nBody");
    expect(normalizeSkillContent("s", "---\ndescription: d\n---\nB")).toBe("---\nname: s\ndescription: d\n---\nB");
    const n = normalizeSkillContent("s", "# Greets people\n\nSay hi.");
    expect(splitFrontmatter(n).fm).toEqual(["name: s", 'description: "Greets people"']);
  });

  it("exclusions: .sync and every .claude/skills folder", () => {
    for (const p of [".sync", ".sync/sample-app.git/HEAD", ".claude/skills", ".claude/skills/x/SKILL.md", "projects/p/.claude/skills/y"]) {
      expect(isIgnoredPath(p)).toBe(true);
      expect(hiddenFromTree(p)).toBe(true);
    }
    for (const p of ["projects/p/.sync", ".claude", ".claude/settings.json", "projects/p/skills"]) {
      expect(isIgnoredPath(p)).toBe(false);
      expect(hiddenFromTree(p)).toBe(false);
    }
  });
});

describe("skills API", () => {
  const A = () => f.as("alice");

  it("links global skills for discovery at startup and reserves _global", async () => {
    const link = join(f.root, ".claude", "skills");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join("..", "_global", "skills"));
    expect(realpathSync(link)).toBe(realpathSync(join(f.root, "_global", "skills")));
    expect((await f.app.inject({ url: "/api/me", headers: f.as("_global") })).statusCode).toBe(403);
  });

  it("creates, lists, reads, renames and deletes user skills", async () => {
    const r = await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "greet", content: "# Greets people politely\n\nSay hello." } });
    expect(r.statusCode).toBe(201);
    expect(Skill.parse(r.json())).toMatchObject({ name: "greet", scope: "user", description: "Greets people politely" });
    const file = join(f.root, "alice", ".claude", "skills", "greet", "SKILL.md");
    expect(readFileSync(file, "utf8")).toMatch(/^---\nname: greet\ndescription: "Greets people politely"\n---\n/);

    const dup = await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "greet", content: "x" } });
    expect(dup.statusCode).toBe(409);
    expect(ErrorBody.parse(dup.json()).code).toBe("skill_exists");
    expect((await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "Bad_Name", content: "x" } })).statusCode).toBe(400);

    const d = SkillDetail.parse((await f.app.inject({ url: "/api/skills/greet", headers: A() })).json());
    expect(d.content).toContain("Say hello.");
    expect((await f.app.inject({ url: "/api/skills/greet", headers: f.as("bob") })).statusCode).toBe(404);

    const put = await f.app.inject({ method: "PUT", url: "/api/skills/greet", headers: A(), payload: { name: "greet-v2", content: "---\nname: whatever\ndescription: Second version\n---\nHi!" } });
    expect(put.statusCode).toBe(200);
    expect(Skill.parse(put.json())).toMatchObject({ name: "greet-v2", description: "Second version" });
    expect(existsSync(join(f.root, "alice", ".claude", "skills", "greet"))).toBe(false);
    expect(readFileSync(join(f.root, "alice", ".claude", "skills", "greet-v2", "SKILL.md"), "utf8")).toContain("name: greet-v2");
    expect((await f.app.inject({ method: "PUT", url: "/api/skills/missing", headers: A(), payload: { name: "missing", content: "x" } })).statusCode).toBe(404);

    expect((await f.app.inject({ method: "DELETE", url: "/api/skills/greet-v2", headers: A() })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "DELETE", url: "/api/skills/greet-v2", headers: A() })).statusCode).toBe(404);
  });

  it("global skills need admin and are visible to everyone; user wins on a name clash", async () => {
    const no = await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "house-style", content: "x", scope: "global" } });
    expect(no.statusCode).toBe(403);
    expect(ErrorBody.parse(no.json()).code).toBe("admin_required");
    const ok = await f.app.inject({ method: "POST", url: "/api/skills", headers: f.as("admin"), payload: { name: "house-style", content: "---\ndescription: Our style\n---\nUse tabs.", scope: "global" } });
    expect(ok.statusCode).toBe(201);
    expect(existsSync(join(f.root, "_global", "skills", "house-style", "SKILL.md"))).toBe(true);
    // visible through the users_root symlink (what Claude Code's upward search finds)
    expect(existsSync(join(f.root, ".claude", "skills", "house-style", "SKILL.md"))).toBe(true);

    await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "house-style", content: "mine" } });
    const list = SkillsResponse.parse((await f.app.inject({ url: "/api/skills", headers: A() })).json());
    expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual(["user:house-style", "global:house-style"]);
    expect(SkillDetail.parse((await f.app.inject({ url: "/api/skills/house-style", headers: A() })).json()).scope).toBe("user");
    expect(SkillDetail.parse((await f.app.inject({ url: "/api/skills/house-style?scope=global", headers: A() })).json()).content).toContain("Use tabs.");
    const bob = SkillsResponse.parse((await f.app.inject({ url: "/api/skills", headers: f.as("bob") })).json());
    expect(bob.map((s) => `${s.scope}:${s.name}`)).toEqual(["global:house-style"]);

    // the palette (no session yet) offers skills, named as the CLI names plugin skills (sessions read no settings files by default)
    const cmds = CommandsResponse.parse((await f.app.inject({ url: "/api/commands", headers: f.as("bob") })).json());
    expect(cmds.find((c) => c.name === "workstation:house-style")).toMatchObject({ isSkill: true, description: "Our style" });

    expect((await f.app.inject({ method: "DELETE", url: "/api/skills/house-style?scope=global", headers: A() })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "DELETE", url: "/api/skills/house-style?scope=global", headers: f.as("admin") })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "DELETE", url: "/api/skills/house-style", headers: A() })).statusCode).toBe(204);
  });

  it("asks live code processes to reload skills after a change", async () => {
    const s = (await f.app.inject({ method: "POST", url: "/api/sessions", headers: A(), payload: { kind: "code" } })).json() as { id: string };
    await f.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: A(), payload: { uuid: randomUUID(), text: "hi" } });
    await until(() => f.hub.store.getSession(s.id)!.turnCount >= 1 && f.hub.sessions.statusOf(s.id).status === "idle", 3000, "turn");
    const q = f.sdk.last;
    await f.app.inject({ method: "POST", url: "/api/skills", headers: A(), payload: { name: "reloaded", content: "x" } });
    await until(() => q.reloaded > 0, 2000, "reloadSkills");
    // a session with a live process answers with its own (SDK-reported) list
    const cmds = CommandsResponse.parse((await f.app.inject({ url: `/api/commands?sessionId=${s.id}`, headers: A() })).json());
    expect(cmds.find((c) => c.name === "my-skill")?.isSkill).toBe(true);
  });

  it("hides .claude/skills from the file tree and builds the overlay only inside nested git repos", async () => {
    const tree = (await f.app.inject({ url: "/api/files/tree?depth=4", headers: A() })).json() as { path: string }[];
    expect(tree.some((e) => e.path === ".claude")).toBe(true);
    expect(tree.some((e) => e.path.startsWith(".claude/skills"))).toBe(false);

    const root = f.hub.users.root("alice");
    expect(f.hub.skills.skillDirsFor("alice", root)).toEqual([]);
    expect(f.hub.skills.skillDirsFor("alice", join(root, "projects"))).toEqual([]);
    const repo = join(root, "code", "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await f.app.inject({ method: "POST", url: "/api/skills", headers: f.as("admin"), payload: { name: "g-one", content: "x", scope: "global" } });
    const dirs = f.hub.skills.skillDirsFor("alice", join(repo, "src"));
    expect(dirs).toHaveLength(1);
    const overlay = join(dirs[0]!, ".claude", "skills");
    expect(readdirSync(overlay).sort()).toEqual(["g-one", "reloaded"]);
    expect(lstatSync(join(overlay, "reloaded")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(overlay, "reloaded"))).toBe(realpathSync(join(root, ".claude", "skills", "reloaded")));
    // With project settings off a spawn there gets the skills as a plugin and no additionalDirectories; with them on it
    // passes the overlay as additionalDirectories (the CLI walks up for .claude/skills, which stops at the nested repo).
    const spawn = async (): Promise<(typeof f.sdk)["last"]> => {
      const s = (await f.app.inject({ method: "POST", url: "/api/sessions", headers: A(), payload: { kind: "code", cwd: "code/repo/src" } })).json() as { id: string };
      await f.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: A(), payload: { uuid: randomUUID(), text: "hi" } });
      await until(() => f.hub.store.getSession(s.id)!.turnCount >= 1, 3000, "turn");
      return f.sdk.last;
    };
    const off = await spawn();
    expect(off.options.additionalDirectories).toBeUndefined();
    expect((off.options.plugins as Array<{ path: string }>).map((p) => readdirSync(join(p.path, "skills")).sort())).toEqual([["g-one", "reloaded"]]);
    (f.hub.config.sessions as { projectSettings: boolean }).projectSettings = true;
    const on = await spawn();
    expect(on.options.additionalDirectories).toEqual(dirs);
    expect(on.options.plugins).toBeUndefined();
    (f.hub.config.sessions as { projectSettings: boolean }).projectSettings = false;
    writeFileSync(join(root, "plain.txt"), "x");
  });
});

describe("replay cap and permission toolUseId", () => {
  it(`replays only the newest ${REPLAY_MAX} messages with truncated: true`, async () => {
    f.hub.users.ensure("carol");
    const row = f.hub.sessions.create({ user: "carol", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null });
    for (let i = 0; i < REPLAY_MAX + 20; i++) f.hub.store.appendMessage(row.id, { uuid: randomUUID(), kind: "system", payload: { type: "system", subtype: "informational", i } });
    const ws: WebSocket = await f.app.injectWS("/ws", WS_UPGRADE);
    const events: ServerEvent[] = [];
    ws.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
    ws.send(JSON.stringify({ type: "hello", user: "carol", protocolVersion: 1 }));
    await until(() => events.some((e) => e.type === "welcome"), 2000, "welcome");
    ws.send(JSON.stringify({ type: "subscribe", sessionId: row.id, lastSeq: 0 }));
    await until(() => events.some((e) => e.type === "snapshot"), 2000, "snapshot");
    const replays = events.filter((e): e is Extract<ServerEvent, { type: "replay" }> => e.type === "replay");
    const seqs = replays.flatMap((r) => r.messages.map((m) => m.seq));
    expect(seqs).toHaveLength(REPLAY_MAX);
    expect(seqs[0]).toBe(21);
    expect(seqs[seqs.length - 1]).toBe(REPLAY_MAX + 20);
    expect(replays.every((r) => r.truncated === true)).toBe(true);

    // a client that is nearly up to date gets no truncation flag
    events.length = 0;
    ws.send(JSON.stringify({ type: "subscribe", sessionId: row.id, lastSeq: REPLAY_MAX + 10 }));
    await until(() => events.some((e) => e.type === "snapshot"), 2000, "snapshot 2");
    const r2 = events.find((e): e is Extract<ServerEvent, { type: "replay" }> => e.type === "replay")!;
    expect(r2.messages).toHaveLength(10);
    expect(r2.truncated).toBeUndefined();
    ws.terminate();
  });

  it("always forwards canUseTool's toolUseID", async () => {
    const s = (await f.app.inject({ method: "POST", url: "/api/sessions", headers: f.as("dave"), payload: { kind: "code" } })).json() as { id: string };
    f.sdk.behavior = async (q) => {
      q.init();
      const r = await q.options.canUseTool!("Bash", { command: "rm -rf x" }, { signal: new AbortController().signal, toolUseID: "toolu_abc", requestId: randomUUID() });
      q.assistant("m1", r?.behavior ?? "?");
      q.result();
    };
    await f.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: f.as("dave"), payload: { uuid: randomUUID(), text: "go" } });
    const req = await until(() => f.hub.sessions.permissions.pendingFor(s.id)[0], 3000, "permission");
    expect(req.toolUseId).toBe("toolu_abc");
    f.hub.sessions.respondPermission("dave", s.id, { requestId: req.requestId, behavior: "deny" });
    await until(() => f.hub.store.getSession(s.id)!.turnCount >= 1, 3000, "turn");
  });
});
