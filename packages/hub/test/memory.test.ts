import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorBody, Me, MemoriesResponse, Memory } from "@agent-workstation/protocol";
import { MAX_MEMORY_CHARS, MemoryService } from "../src/memory.js";
import { chatSystemPrompt } from "../src/sessions/runtime.js";
import { VISUAL_GUIDANCE } from "../src/sessions/visual.js";
import { toCallToolResult, type HubToolSpec } from "../src/sessions/sdk.js";
import { hubFixture, msgBody, runtimeFixture, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

// ------------------------------------------------------------------ routes

describe("memory routes", () => {
  let fx: HubFixture;
  beforeAll(async () => {
    fx = await hubFixture();
  });
  afterAll(async () => {
    await fx.close();
  });

  const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, user: string | null, payload?: unknown) =>
    fx.app.inject({ method, url, headers: user ? fx.as(user) : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("creates, lists (newest first), edits and deletes a memory", async () => {
    const a = await api("POST", "/api/me/memories", "alice", { text: "  Prefers   metric units. " });
    expect(a.statusCode).toBe(201);
    const first = Memory.parse(a.json());
    expect(first).toMatchObject({ text: "Prefers metric units.", source: "user", sessionId: null });

    const second = Memory.parse((await api("POST", "/api/me/memories", "alice", { text: "Works on Agent Workstation." })).json());
    // the same text again (any case) is not stored twice
    const dup = await api("POST", "/api/me/memories", "alice", { text: "works on AGENT WORKSTATION." });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().id).toBe(second.id);

    const list = MemoriesResponse.parse((await api("GET", "/api/me/memories", "alice")).json());
    expect(list.memories.map((m) => m.id)).toEqual([second.id, first.id]);

    const patched = await api("PATCH", `/api/me/memories/${first.id}`, "alice", { text: "Prefers imperial units." });
    expect(patched.statusCode).toBe(200);
    expect(Memory.parse(patched.json())).toMatchObject({ id: first.id, text: "Prefers imperial units.", createdAt: first.createdAt });

    expect((await api("DELETE", `/api/me/memories/${first.id}`, "alice")).statusCode).toBe(204);
    const after = MemoriesResponse.parse((await api("GET", "/api/me/memories", "alice")).json());
    expect(after.memories.map((m) => m.id)).toEqual([second.id]);

    const gone = await api("DELETE", `/api/me/memories/${first.id}`, "alice");
    expect(gone.statusCode).toBe(404);
    expect(ErrorBody.parse(gone.json()).code).toBe("not_found");
    expect((await api("PATCH", `/api/me/memories/${first.id}`, "alice", { text: "x" })).statusCode).toBe(404);
  });

  it("rejects empty and over-long text", async () => {
    for (const payload of [{ text: "" }, { text: "   " }, { text: "x".repeat(MAX_MEMORY_CHARS + 1) }, {}, { text: 5 }]) {
      const r = await api("POST", "/api/me/memories", "carol", payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(ErrorBody.parse(r.json()).code).toBe("invalid_request");
    }
    const ok = Memory.parse((await api("POST", "/api/me/memories", "carol", { text: "x".repeat(MAX_MEMORY_CHARS) })).json());
    expect((await api("PATCH", `/api/me/memories/${ok.id}`, "carol", { text: " " })).statusCode).toBe(400);
    expect((await api("PATCH", `/api/me/memories/${ok.id}`, "carol", { text: "y".repeat(MAX_MEMORY_CHARS + 1) })).statusCode).toBe(400);
  });

  it("keeps every user's memories to themselves", async () => {
    const m = Memory.parse((await api("POST", "/api/me/memories", "dave", { text: "Uses a standing desk." })).json());
    const bob = MemoriesResponse.parse((await api("GET", "/api/me/memories", "bob")).json());
    expect(bob.memories.some((x) => x.id === m.id)).toBe(false);
    expect((await api("PATCH", `/api/me/memories/${m.id}`, "bob", { text: "hijacked" })).statusCode).toBe(404);
    expect((await api("DELETE", `/api/me/memories/${m.id}`, "bob")).statusCode).toBe(404);
    const dave = MemoriesResponse.parse((await api("GET", "/api/me/memories", "dave")).json());
    expect(dave.memories.map((x) => x.text)).toEqual(["Uses a standing desk."]);
  });

  it("requires a username", async () => {
    expect((await api("GET", "/api/me/memories", null)).statusCode).toBe(401);
    expect((await api("POST", "/api/me/memories", null, { text: "x" })).statusCode).toBe(401);
    expect((await api("PATCH", "/api/me/memories/abc", null, { text: "x" })).statusCode).toBe(401);
    expect((await api("DELETE", "/api/me/memories/abc", null)).statusCode).toBe(401);
  });

  it("exposes the memory preference on the user", async () => {
    expect(Me.parse((await api("GET", "/api/me", "erin")).json()).user.memoryEnabled).toBe(true);
    const r = await api("PATCH", "/api/me/preferences", "erin", { memoryEnabled: false });
    expect(r.statusCode).toBe(200);
    expect(r.json().memoryEnabled).toBe(false);
    expect(Me.parse((await api("GET", "/api/me", "erin")).json()).user.memoryEnabled).toBe(false);
    expect(fx.hub.memories.enabled("erin")).toBe(false);
  });
});

// ----------------------------------------------------------------- runtime

describe("memory in sessions", () => {
  let fx: RuntimeFixture;
  let memories: MemoryService;
  afterEach(() => fx?.cleanup());

  const setup = () => {
    fx = runtimeFixture(({ store, bus }) => {
      memories = new MemoryService(store, bus);
      return { memories };
    });
    return fx;
  };
  const idle = (id: string, turns: number) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= turns, 3000, `turn ${turns}`);
  const tool = (name: string): HubToolSpec => {
    const t = fx.sdk.mcpServers.get("workstation-memory")?.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  it("gives Chat sessions the memory tools, guidance and saved memories", async () => {
    setup();
    const id = fx.newSession("chat");
    memories.create("alice", "Prefers short answers.", "user");
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    const o = fx.sdk.last.options;
    expect(o.tools).toEqual(["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["workstation-memory", "workstation-visual", "workstation_turn", "workstation_subagent"]);
    expect(o.allowedTools).toEqual(["mcp__workstation-memory__remember", "mcp__workstation-memory__forget", "mcp__workstation-visual__show_visual", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents"]);
    expect(o.permissionMode).toBe("default");
    const prompt = String(o.systemPrompt);
    expect(prompt).toContain(memories.toolGuidance());
    expect(prompt).toContain("- Prefers short answers.");
    expect(prompt).not.toContain("You have no tools in this conversation");
  });

  it("remember / forget handlers save and remove the user's memories", async () => {
    setup();
    const id = fx.newSession("chat");
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    fx.bus.clear();

    expect(await tool("remember").handler({ text: "Lives in Springfield." })).toBe("Saved: Lives in Springfield.");
    expect(await tool("remember").handler({ text: "Likes green tea." })).toBe("Saved: Likes green tea.");
    const saved = memories.list("alice");
    expect(saved.map((m) => [m.text, m.source, m.sessionId])).toEqual(
      expect.arrayContaining([
        ["Lives in Springfield.", "claude", id],
        ["Likes green tea.", "claude", id],
      ]),
    );
    expect(fx.bus.ofType("memories_changed").length).toBe(2);
    expect(memories.list("bob")).toEqual([]);

    // Calls that change nothing come back flagged as errors (the text is kept for Claude).
    const noop = (text: RegExp) => ({ text: expect.stringMatching(text), isError: true });
    expect(await tool("forget").handler({ text: "Li" })).toEqual(noop(/^Several memories match; nothing was removed/));
    expect(await tool("forget").handler({ text: "no such thing" })).toEqual(noop(/^No memory matches/));
    expect(await tool("forget").handler({ text: "   " })).toEqual(noop(/^No memory text given/));
    expect(await tool("forget").handler({ text: "springfield" })).toBe("Removed: Lives in Springfield.");
    // what the SDK tool hands back over MCP
    expect(toCallToolResult("Removed: x")).toEqual({ content: [{ type: "text", text: "Removed: x" }] });
    expect(toCallToolResult(await tool("forget").handler({ text: "nothing like it" }))).toEqual({
      content: [{ type: "text", text: "No memory matches that text; nothing was removed." }],
      isError: true,
    });
    expect(memories.list("alice").map((m) => m.text)).toEqual(["Likes green tea."]);
    expect(await tool("remember").handler({ text: "   " })).toEqual(noop(/^Not saved:/));
    // a duplicate is already saved: a success
    expect(await tool("remember").handler({ text: "likes green tea." })).toBe("Saved: Likes green tea.");

    fx.store.updateUser("alice", { memoryEnabled: false });
    expect(await tool("remember").handler({ text: "Secret." })).toEqual(noop(/turned off/));
    expect(await tool("forget").handler({ text: "green" })).toEqual(noop(/turned off/));
    expect(memories.list("alice")).toHaveLength(1);
  });

  it("Chat sessions without memory get no memory tools", async () => {
    setup();
    fx.store.ensureUser("alice");
    fx.store.updateUser("alice", { memoryEnabled: false });
    memories.create("alice", "Prefers short answers.", "user");
    const id = fx.newSession("chat");
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    const o = fx.sdk.last.options;
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["workstation-visual", "workstation_turn", "workstation_subagent"]);
    expect(o.allowedTools).toEqual(["mcp__workstation-visual__show_visual", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents"]);
    expect(o.systemPrompt).toBe(chatSystemPrompt(null, false, { subagents: true, exec: true, read: true, cwdAbs: join(fx.root, "alice", ".chat", id) }));
  });

  it("Code sessions get the memories appended to the Claude Code prompt (read-only)", async () => {
    setup();
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("one"));
    await idle(id, 1);
    const first = fx.sdk.last.options.systemPrompt as { type: string; preset: string; append: string };
    expect(first).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(first.append).toContain(VISUAL_GUIDANCE);
    expect(first.append).not.toContain("What you remember");

    memories.create("alice", "Uses pnpm, never npm.", "user");
    await fx.sessions.send(id, msgBody("two"));
    await idle(id, 2);
    expect(fx.sdk.queries).toHaveLength(2);
    const o = fx.sdk.last.options;
    expect(o.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect((o.systemPrompt as { append?: string }).append).toContain("- Uses pnpm, never npm.");
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["workstation-visual", "workstation_turn", "workstation_subagent"]);
    expect(o.allowedTools).toEqual(["mcp__workstation-visual__show_visual", "mcp__workstation_turn__wrap_up", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents"]);
  });

  it("recycles an idle process after a memory change so the resumed one sees it", async () => {
    setup();
    const id = fx.newSession("chat");
    await fx.sessions.send(id, msgBody("one"));
    await idle(id, 1);
    const first = fx.sdk.last;
    const claudeId = fx.store.getSession(id)!.claudeSessionId;

    // No change: the live process is reused.
    await fx.sessions.send(id, msgBody("two"));
    await idle(id, 2);
    expect(fx.sdk.queries).toHaveLength(1);

    memories.create("alice", "Prefers tabs over spaces.", "user");
    await fx.sessions.send(id, msgBody("three"));
    await idle(id, 3);
    expect(first.closed).toBe(true);
    expect(fx.sdk.queries).toHaveLength(2);
    expect(fx.sdk.last.options.resume).toBe(claudeId);
    expect(String(fx.sdk.last.options.systemPrompt)).toContain("- Prefers tabs over spaces.");

    // Turning memory off is a change too.
    fx.store.updateUser("alice", { memoryEnabled: false });
    await fx.sessions.send(id, msgBody("four"));
    await idle(id, 4);
    expect(fx.sdk.queries).toHaveLength(3);
    expect(fx.sdk.last.options.systemPrompt).toBe(chatSystemPrompt(null, false, { subagents: true, exec: true, read: true, cwdAbs: join(fx.root, "alice", ".chat", id) }));
  });

  it("does not recycle a process for memories it saved itself", async () => {
    setup();
    const id = fx.newSession("chat");
    await fx.sessions.send(id, msgBody("one"));
    await idle(id, 1);
    await tool("remember").handler({ text: "Uses dark mode." });
    await fx.sessions.send(id, msgBody("two"));
    await idle(id, 2);
    expect(fx.sdk.queries).toHaveLength(1);

    // A change from elsewhere still counts.
    memories.create("alice", "Works in UTC.", "user");
    await fx.sessions.send(id, msgBody("three"));
    await idle(id, 3);
    expect(fx.sdk.queries).toHaveLength(2);
    expect(String(fx.sdk.last.options.systemPrompt)).toContain("- Uses dark mode.");
    expect(String(fx.sdk.last.options.systemPrompt)).toContain("- Works in UTC.");
  });
});
