import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "@agent-workstation/protocol";
import { encodeProjectDir } from "../src/sessions/claudeFiles.js";
import { INCOGNITO_NOTE } from "../src/sessions/runtime.js";
import { hubFixture, msgBody, tempDir, until, type HubFixture } from "./helpers.js";

let h: HubFixture | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const create = (body: Record<string, unknown>, user = "alice") => h!.app.inject({ method: "POST", url: "/api/sessions", headers: h!.as(user), payload: { kind: "chat", model: "opus", ...body } });
const say = async (id: string, text: string) => {
  const before = h!.hub.store.getSession(id)!.turnCount;
  const r = await h!.app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, headers: h!.as("alice"), payload: msgBody(text) });
  expect(r.statusCode).toBe(200);
  await until(() => h!.hub.store.getSession(id)!.turnCount > before && h!.hub.sessions.statusOf(id).status === "idle", 3000, "turn");
};
/** A Claude transcript file where Claude Code keeps it for this session (what delete must remove). */
function fakeTranscript(claudeHome: string, cwdAbs: string, claudeId: string): string {
  const dir = join(claudeHome, "projects", encodeProjectDir(cwdAbs));
  mkdirSync(join(dir, claudeId), { recursive: true });
  const file = join(dir, `${claudeId}.jsonl`);
  writeFileSync(file, '{"type":"user","message":{"content":"secret"}}\n');
  return file;
}

describe("incognito chats", () => {
  it("are chat-only, never listed or indexed, and get no memory or past-conversation tools (web and visuals stay)", async () => {
    h = await hubFixture();
    expect((await create({ kind: "code", incognito: true })).statusCode).toBe(400);
    await h.app.inject({ method: "POST", url: "/api/me/memories", headers: h.as("alice"), payload: { text: "Lives in Springfield." } });
    const normal = (await create({ title: "Normal" })).json() as Session;
    const r = await create({ incognito: true });
    expect(r.statusCode).toBe(201);
    const s = r.json() as Session;
    expect(s).toMatchObject({ kind: "chat", incognito: true });
    expect(normal.incognito).toBe(false);

    await say(s.id, "a private question about zebras");
    const opts = h.sdk.last.options;
    expect(String(opts.systemPrompt)).toContain(INCOGNITO_NOTE);
    expect(String(opts.systemPrompt)).not.toContain("Springfield");
    // run_subagents stays: an incognito chat's subagents are incognito too. So does download_file (its own folder), and
    // Agent Workstation's own docs (read_workstation_docs).
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["workstation-visual", "workstation_turn", "workstation_subagent", "workstation_fetch", "workstation_docs"]);
    expect(opts.allowedTools).toEqual(["mcp__workstation-visual__show_visual", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents", "mcp__workstation_fetch__download_file", "mcp__workstation_docs__read_workstation_docs"]);
    expect(opts.tools).toEqual(["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(opts.cwd).toBe(join(h.root, "alice", ".chat", s.id));
    expect(String(opts.systemPrompt)).toContain("WebSearch");
    // A normal chat of the same user does get memory, the past-conversation tools and the (read-only) server browser.
    await say(normal.id, "hello");
    expect(Object.keys(h.sdk.last.options.mcpServers ?? {})).toEqual(["browser", "workstation-memory", "workstation-history", "workstation-visual", "workstation_turn", "workstation_subagent", "workstation_fetch", "workstation_docs"]);

    const list = (await h.app.inject({ method: "GET", url: "/api/sessions", headers: h.as("alice") })).json() as Session[];
    expect(list.map((x) => x.id)).toEqual([normal.id]);
    expect((await h.app.inject({ method: "GET", url: `/api/sessions/${s.id}`, headers: h.as("alice") })).json()).toMatchObject({ id: s.id, incognito: true });
    expect((await h.app.inject({ method: "GET", url: `/api/sessions/${s.id}`, headers: h.as("bob") })).statusCode).toBe(404);
    const search = (await h.app.inject({ method: "GET", url: "/api/search?q=zebras", headers: h.as("alice") })).json() as { hits: unknown[] };
    expect(search.hits).toEqual([]);
    expect(h.hub.store.db.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE session_id = ?").get(s.id)).toEqual({ n: 0 });
    // The history tools of the normal chat cannot read it either.
    const read = h.sdk.mcpServers.get("workstation-history")!.find((t) => t.name === "read_conversation")!;
    expect(await read.handler({ sessionId: s.id })).toEqual({ text: "No conversation with that id.", isError: true });
  });

  it("DELETE removes messages, the session and Claude's transcript; token numbers stay", async () => {
    h = await hubFixture();
    const s = (await create({ incognito: true })).json() as Session;
    await say(s.id, "remember nothing");
    const row = h.hub.store.getSession(s.id)!;
    const folder = join(h.root, "alice", ".chat", s.id);
    expect(row.cwd).toBe(`.chat/${s.id}`);
    writeFileSync(join(folder, "scratch.py"), "print(1)");
    const file = fakeTranscript(h.hub.config.paths.claudeHome, folder, row.claudeSessionId!);
    expect((await h.app.inject({ method: "DELETE", url: `/api/sessions/${s.id}`, headers: h.as("alice") })).statusCode).toBe(204);
    expect(h.hub.store.getSession(s.id)).toBeNull();
    expect(existsSync(folder)).toBe(false); // the chat's own folder goes with it
    expect(h.hub.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(s.id)).toEqual({ n: 0 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file.replace(/\.jsonl$/, ""))).toBe(false);
    const turns = h.hub.store.db.prepare("SELECT input_tokens, output_tokens FROM turns WHERE session_id = ?").all(s.id);
    expect(turns).toEqual([{ input_tokens: 10, output_tokens: 5 }]);
  });

  it("the hub purges incognito chats left over at start (with their transcripts), and leaves others alone", async () => {
    const t = tempDir();
    const dbFile = join(t.dir, "hub.sqlite");
    const claudeHome = join(t.dir, "claude-home");
    // both hub instances share the users root (each fixture's own temp dir goes away on close)
    const usersRoot = join(t.dir, "users");
    const paths = { claude_home: claudeHome, users_root: usersRoot };
    try {
      h = await hubFixture({ dbFile }, () => ({ paths }));
      const keep = (await create({ title: "Keep me" })).json() as Session;
      const s = (await create({ incognito: true })).json() as Session;
      await say(s.id, "leftover");
      const folder = join(usersRoot, "alice", ".chat", s.id);
      const file = fakeTranscript(claudeHome, folder, h.hub.store.getSession(s.id)!.claudeSessionId!);
      await h.close(); // the client never sent DELETE
      expect(existsSync(folder)).toBe(true);
      h = await hubFixture({ dbFile }, () => ({ paths }));
      expect(h.hub.store.getSession(s.id)).toBeNull();
      expect(h.hub.store.getSession(keep.id)).not.toBeNull();
      expect(existsSync(file)).toBe(false);
      expect(existsSync(folder)).toBe(false);
    } finally {
      await h?.close();
      h = null;
      t.cleanup();
    }
  });
});
