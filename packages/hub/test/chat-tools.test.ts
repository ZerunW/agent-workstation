/**
 * Chat tools of Claude sessions (fake SDK): web search / page reading without cards; a chat's own folder with
 * sandboxed Bash and file tools limited to it (no cards); attachments read through Read scoped to the session's own
 * attachment paths (large files are never inlined); chats from before chats had folders keep the old tool set; and
 * show_visual.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { ATTACHMENT_READ_DENIED } from "../src/sessions/attachments.js";
import { CHAT_FOLDER_DENIED, CHAT_NETWORK_HOSTS, CHAT_SANDBOX_DENIED_ENV } from "../src/sessions/chatFolder.js";
import { isProcessTmpDir, PROCESS_TMP_ROOT } from "../src/sessions/processTmp.js";
import { chatSystemPrompt, dateLine, INCOGNITO_NOTE } from "../src/sessions/runtime.js";
import { checkVisual, MAX_VISUAL_BYTES, VISUAL_GUIDANCE, VISUAL_TOOL_DESCRIPTION, visualTool } from "../src/sessions/visual.js";
import type { FakeQuery } from "./fakeSdk.js";
import { msgBody, runtimeFixture, until, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture;
afterEach(() => fx?.cleanup());

const idle = (id: string, turns: number) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= turns, 4000, `turn ${turns}`);
const allow = (q: FakeQuery, tool: string, input: Record<string, unknown>) => q.askPermission(tool, input);
const EXEC_TOOLS = ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"];

/** Runs the chat's PreToolUse file gate like the CLI would for `tool`; returns the hook output. */
async function fileGate(q: FakeQuery, tool: string, toolInput: Record<string, unknown>): Promise<unknown> {
  const pre = (q.options.hooks?.PreToolUse ?? []).find((m) => (m.matcher ?? "").split("|").includes(tool) && !(m.matcher ?? "").includes("MultiEdit"));
  if (!pre) throw new Error(`no gate for ${tool}`);
  const input = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, tool_use_id: "t1", session_id: q.sessionId, transcript_path: "/dev/null", cwd: q.options.cwd } as unknown as HookInput;
  return pre.hooks[0]!(input, "t1", { signal: new AbortController().signal });
}
const readGate = (q: FakeQuery, filePath: string) => fileGate(q, "Read", { file_path: filePath });
const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** A chat created before chats had folders of their own (stored cwd `.chat`). */
function oldChat(): string {
  fx.store.ensureUser("alice");
  mkdirSync(join(fx.root, "alice", ".chat"), { recursive: true });
  const id = crypto.randomUUID();
  fx.store.insertSession({ id, user: "alice", kind: "chat", title: "Old chat", cwd: ".chat", model: "default", permissionMode: "dontAsk", effort: null });
  return id;
}

describe("Claude chat: its own folder, sandboxed commands, web search and page reading", () => {
  it("runs in .chat/<id> with the web tools, Bash and the file tools; Claude Code's sandbox settings; no cards", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    const folder = join(fx.root, "alice", ".chat", id);
    expect(fx.store.getSession(id)!.cwd).toBe(`.chat/${id}`);
    expect(existsSync(folder)).toBe(false); // created when the process starts
    await fx.sessions.send(id, msgBody("what's new?"));
    await idle(id, 1);
    const q = fx.sdk.last;
    expect(q.options.cwd).toBe(folder);
    expect(existsSync(folder)).toBe(true);
    expect(q.options.tools).toEqual(EXEC_TOOLS);
    expect(q.options.permissionMode).toBe("default");
    expect(q.options.allowedTools).toEqual(["mcp__workstation-visual__show_visual", "mcp__workstation_turn__heads_up", "mcp__workstation_subagent__run_subagents"]);

    // The sandbox: inline settings (the agent wrapper accepts --settings JSON), never unsandboxed, no card for Bash.
    const settings = q.options.settings as unknown as { cleanupPeriodDays: number; sandbox: Record<string, any>; env: Record<string, string> };
    expect(settings.cleanupPeriodDays).toBeGreaterThan(1000);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    const fs = settings.sandbox.filesystem as { allowWrite: string[]; denyRead: string[]; allowRead: string[] };
    // The process's private temp directory: short enough that the CLI keeps sandboxed commands' $TMPDIR in it (never
    // the shared /tmp/claude-<uid>), and the CLI's own TMPDIR (the sandbox's network bridge sockets go there).
    const env = q.options.env as Record<string, string>;
    const tmp = env.CLAUDE_CODE_TMPDIR!;
    expect(isProcessTmpDir(tmp)).toBe(true);
    expect(Buffer.byteLength(`${tmp}/claude-${process.getuid?.() ?? 0}`)).toBeLessThanOrEqual(44);
    expect(env.TMPDIR).toBe(tmp);
    expect(fs.allowWrite).toEqual(expect.arrayContaining([folder, tmp]));
    expect(fs.allowWrite.every((p) => p.startsWith(folder) || p.startsWith(realpathSync(folder)) || p === tmp)).toBe(true);
    // Other users, other chats, the user's own files outside the chat, Agent Workstation's config, the agent's credentials, /tmp
    // (other processes' temp directories and the CLI's shared one named on top).
    expect(fs.denyRead).toEqual(expect.arrayContaining([fx.root, "/etc/agent-workstation", "~/.claude", "~/.claude.json", "/tmp", PROCESS_TMP_ROOT, "/tmp/claude-*"]));
    expect(fs.allowRead).toEqual(expect.arrayContaining([folder, tmp, "~/.claude/shell-snapshots"]));
    expect(fs.allowRead.filter((p) => p.startsWith("/tmp/") && !p.startsWith(folder) && !p.startsWith(realpathSync(folder)))).toEqual([tmp]);
    // Network: only the package / code hosts, enforced by the sandbox's proxy (no prompt); everything else (loopback,
    // LAN, tailnet, the open web) is refused.
    expect(settings.sandbox.network).toEqual({ allowedDomains: [...CHAT_NETWORK_HOSTS], strictAllowlist: true, allowLocalBinding: false });
    // The key proxy token and its URL never reach a command's environment.
    expect(settings.sandbox.credentials).toEqual({ envVars: CHAT_SANDBOX_DENIED_ENV.map((name) => ({ name, mode: "deny" })) });
    expect(CHAT_SANDBOX_DENIED_ENV).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]));
    expect(settings.env.XDG_CACHE_HOME).toBe(join(folder, ".cache"));
    expect(settings.env).not.toHaveProperty("ANTHROPIC_API_KEY");

    fx.bus.clear();
    expect(await allow(q, "WebSearch", { query: "news" })).toEqual({ behavior: "allow", updatedInput: { query: "news" } });
    expect(await allow(q, "WebFetch", { url: "https://example.com", prompt: "x" })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "mcp__workstation-visual__show_visual", { title: "x", svg: "<svg/>" })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Bash", { command: "python3 -c 'print(2**64)'" })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Bash", { command: "cat /etc/agent-workstation/hub.toml", dangerouslyDisableSandbox: true })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "SandboxNetworkAccess", { host: "pypi.org" })).toMatchObject({ behavior: "allow" });
    for (const host of ["127.0.0.1", "localhost", "192.168.1.50", "100.64.0.10", "workstation.example.com", "api.anthropic.com", "evil.example", "pypi.org.evil.example"]) {
      expect(await allow(q, "SandboxNetworkAccess", { host }), host).toMatchObject({ behavior: "deny" });
    }
    expect(await allow(q, "Write", { file_path: join(folder, "plot.py"), content: "print(1)" })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Write", { file_path: "notes.md", content: "x" })).toMatchObject({ behavior: "allow" }); // relative to the folder
    expect(await allow(q, "Read", { file_path: "/etc/passwd" })).toEqual({ behavior: "deny", message: CHAT_FOLDER_DENIED });
    expect(await allow(q, "Write", { file_path: join(fx.root, "alice", "notes.txt"), content: "x" })).toEqual({ behavior: "deny", message: CHAT_FOLDER_DENIED });
    expect(await allow(q, "mcp__other__tool", {})).toMatchObject({ behavior: "deny" });
    expect(fx.bus.ofType("permission_request")).toEqual([]);
    expect(fx.sessions.statusOf(id).status).toBe("idle");

    const prompt = String(q.options.systemPrompt);
    expect(prompt).toBe(chatSystemPrompt(null, false, { subagents: true, exec: true, read: true, cwdAbs: folder }));
    expect(prompt).toContain(dateLine(new Date()));
    expect(prompt).toContain("When web results are newer than your training data, trust the results.");
    expect(prompt).toContain("search the web (WebSearch) and read web pages (WebFetch)");
    expect(prompt).toContain("cite the sources");
    expect(prompt).toContain("Markdown links");
    expect(prompt).toContain(`Your folder: this chat has its own folder, \`${folder}\``);
    expect(prompt).toContain("Python 3, Node, shell");
    expect(prompt).toContain("no long-running servers");
    expect(prompt).not.toContain("You cannot run commands");
    expect(prompt).toContain(VISUAL_GUIDANCE);
  });

  it("file tools only inside the folder (PreToolUse runs before any rule): no way out by path, .. or symlink; writes are its outputs", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    const root = join(fx.root, "alice");
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "inbox", "report.csv"), "a,b\n");
    await fx.sessions.send(id, { ...msgBody("chart this"), attachments: [{ type: "file_ref", path: "inbox/report.csv" }] });
    await idle(id, 1);
    const q = fx.sdk.last;
    const folder = join(root, ".chat", id);
    const other = join(root, ".chat", "00000000-0000-4000-8000-000000000000");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "secret.txt"), "another chat's");
    writeFileSync(join(folder, "data.csv"), "1,2\n");
    mkdirSync(join(folder, "sub"));
    symlinkSync("/etc/hosts", join(folder, "hosts"));
    symlinkSync(join(other, "secret.txt"), join(folder, "peek.txt"));
    symlinkSync(join(root, "nowhere.txt"), join(folder, "dangling.txt"));
    symlinkSync(other, join(folder, "otherdir"));

    for (const [tool, input] of [
      ["Read", { file_path: join(folder, "data.csv") }],
      ["Read", { file_path: join(realpathSync(folder), "data.csv") }],
      ["Read", { file_path: "data.csv" }],
      ["Write", { file_path: join(folder, "sub", "new", "out.txt"), content: "x" }],
      ["Edit", { file_path: join(folder, "data.csv"), old_string: "1", new_string: "3" }],
      ["Glob", { pattern: "**/*.csv" }],
      ["Glob", { pattern: "*.py", path: join(folder, "sub") }],
      ["Grep", { pattern: "/api/", path: folder }],
      ["Read", { file_path: join(realpathSync(root), "inbox", "report.csv") }], // the attachment
    ] as const) {
      expect(await fileGate(q, tool, input)).toEqual({});
      expect(await allow(q, tool, input)).toMatchObject({ behavior: "allow" });
    }
    for (const [tool, input] of [
      ["Read", { file_path: join(other, "secret.txt") }],
      ["Read", { file_path: join(root, "inbox", "other.txt") }],
      ["Read", { file_path: "/etc/agent-workstation/hub.toml" }],
      ["Read", { file_path: `${folder}/../${"00000000-0000-4000-8000-000000000000"}/secret.txt` }],
      ["Read", { file_path: join(folder, "hosts") }],
      ["Read", { file_path: join(folder, "peek.txt") }],
      ["Read", { file_path: join(folder, "otherdir", "secret.txt") }],
      ["Write", { file_path: join(folder, "dangling.txt"), content: "x" }],
      ["Write", { file_path: join(root, "projects", "x.txt"), content: "x" }],
      ["Edit", { file_path: join(other, "secret.txt"), old_string: "a", new_string: "b" }],
      ["Glob", { pattern: "*", path: root }],
      ["Glob", { pattern: "../*/secret.txt" }],
      ["Glob", { pattern: `${other}/*` }],
      ["Grep", { pattern: "x", path: join(root, ".chat") }],
      ["Grep", { pattern: "x", glob: "../**" }],
      ["Write", { content: "x" }],
    ] as const) {
      expect(await fileGate(q, tool, input)).toEqual(denied(CHAT_FOLDER_DENIED));
      expect(await allow(q, tool, input)).toEqual({ behavior: "deny", message: CHAT_FOLDER_DENIED });
    }

    // What the agent wrote with Write / Edit inside the folder is listed as the session's outputs (root-relative).
    await q.runHooks("PostToolUse", "Write", { file_path: join(folder, "chart.png") }, "w1");
    await q.runHooks("PostToolUse", "Edit", { file_path: "data.csv" }, "w2");
    await q.runHooks("PostToolUse", "Write", { file_path: join(root, "elsewhere.txt") }, "w3");
    expect(fx.store.sessionTouches(id, 10).map((t) => [t.path, t.tool]).sort()).toEqual([
      [`.chat/${id}/chart.png`, "Write"],
      [`.chat/${id}/data.csv`, "Edit"],
    ]);

    // A command: what it left in the folder (changed since it started) joins them; caches, venvs and older files not.
    const past = new Date(Date.now() - 60_000);
    for (const f of ["data.csv", "sub"]) utimesSync(join(folder, f), past, past);
    await q.runHooks("PreToolUse", "Bash", { command: "python3 plot.py" }, "b1");
    const later = new Date(Date.now() + 60_000);
    mkdirSync(join(folder, "out"), { recursive: true });
    mkdirSync(join(folder, ".venv", "lib"), { recursive: true });
    for (const f of ["out/plot.png", "summary.md", ".venv/lib/x.py"]) {
      writeFileSync(join(folder, f), "x");
      utimesSync(join(folder, f), later, later);
    }
    await q.runHooks("PostToolUse", "Bash", { command: "python3 plot.py" }, "b1");
    expect(fx.store.sessionTouches(id, 10).filter((t) => t.tool === "Bash").map((t) => t.path).sort()).toEqual([`.chat/${id}/out/plot.png`, `.chat/${id}/summary.md`]);
  });

  it("incognito chats get the same tools in their own folder and the incognito note", async () => {
    fx = runtimeFixture();
    fx.store.ensureUser("alice");
    const id = fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id;
    await fx.sessions.send(id, msgBody("hi"));
    await idle(id, 1);
    const q = fx.sdk.last;
    expect(q.options.cwd).toBe(join(fx.root, "alice", ".chat", id));
    expect(q.options.tools).toEqual(EXEC_TOOLS);
    expect(await allow(q, "WebSearch", { query: "x" })).toMatchObject({ behavior: "allow" });
    expect(String(q.options.systemPrompt)).toContain(INCOGNITO_NOTE);
    expect(String(q.options.systemPrompt)).toContain("WebFetch");
  });

  it("the folder is kept on close, shared with forks, and removed with the last chat using it; incognito purge removes it", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    const first = msgBody("hello");
    await fx.sessions.send(id, first);
    await idle(id, 1);
    const folder = join(fx.root, "alice", ".chat", id);
    writeFileSync(join(folder, "result.txt"), "42");
    await fx.sessions.close(id);
    expect(existsSync(join(folder, "result.txt"))).toBe(true);

    const { row: fork } = fx.sessions.fork(id, first.uuid);
    expect(fork.cwd).toBe(`.chat/${id}`);
    await fx.sessions.delete(id);
    expect(existsSync(join(folder, "result.txt"))).toBe(true); // the fork still works there
    await fx.sessions.delete(fork.id);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(fx.root, "alice", ".chat"))).toBe(true);

    // Deleting a chat from before chats had folders leaves the shared .chat alone.
    writeFileSync(join(fx.root, "alice", ".chat", "keep.txt"), "x");
    await fx.sessions.delete(oldChat());
    expect(existsSync(join(fx.root, "alice", ".chat", "keep.txt"))).toBe(true);

    // The incognito purge (the person's own choice) removes an incognito chat's folder with it.
    const inc = fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id;
    await fx.sessions.send(inc, msgBody("secret"));
    await idle(inc, 1);
    expect(existsSync(join(fx.root, "alice", ".chat", inc))).toBe(true);
    await fx.sessions.close(inc);
    expect(await fx.sessions.purgeIncognito()).toBe(1);
    expect(existsSync(join(fx.root, "alice", ".chat", inc))).toBe(false);
  });

  it("a chat from before chats had folders keeps working in the shared .chat with the web tools only, no sandbox", async () => {
    fx = runtimeFixture();
    const id = oldChat();
    await fx.sessions.send(id, msgBody("what's new?"));
    await idle(id, 1);
    const q = fx.sdk.last;
    expect(q.options.cwd).toBe(join(fx.root, "alice", ".chat"));
    expect(q.options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect((q.options.settings as unknown as Record<string, unknown>).sandbox).toBeUndefined();
    fx.bus.clear();
    expect(await allow(q, "WebSearch", { query: "news" })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Bash", { command: "ls" })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "SandboxNetworkAccess", { host: "pypi.org" })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "Read", { file_path: "/etc/passwd" })).toEqual({ behavior: "deny", message: ATTACHMENT_READ_DENIED });
    expect(await allow(q, "Write", { file_path: join(fx.root, "alice", ".chat", "x.txt"), content: "x" })).toMatchObject({ behavior: "deny" });
    expect(fx.bus.ofType("permission_request")).toEqual([]);
    const prompt = String(q.options.systemPrompt);
    expect(prompt).toBe(chatSystemPrompt(null, false, { subagents: true, cwdAbs: join(fx.root, "alice", ".chat") }));
    expect(prompt).not.toContain("Your folder");
    expect(prompt).not.toContain("Read tool");
  });
});

describe("Claude chat: attachments of any size", () => {
  it("lists a 16 MB PDF by path instead of inlining it; Read is allowed for exactly the session's attachments", async () => {
    fx = runtimeFixture();
    // A chat without a folder of its own: Read joins with the first attachment.
    const id = oldChat();
    const root = join(fx.root, "alice");
    const rootReal = realpathSync(root);
    mkdirSync(join(root, "inbox"), { recursive: true });
    const big = Buffer.alloc(16 * 1024 * 1024, 0x20);
    big.write("%PDF-1.7\n");
    writeFileSync(join(root, "inbox", "manual.pdf"), big);
    writeFileSync(join(root, "inbox", "secret.txt"), "not attached");
    writeFileSync(join(root, "inbox", "small.md"), "# small");
    symlinkSync(join(root, "inbox", "manual.pdf"), join(root, "inbox", "alias.pdf"));
    symlinkSync("/etc/hosts", join(root, "inbox", "hosts"));

    // First turn without attachments: no Read tool.
    await fx.sessions.send(id, msgBody("hello"));
    await idle(id, 1);
    const first = fx.sdk.last;
    expect(first.options.tools).toEqual(["WebSearch", "WebFetch"]);
    const claudeId = fx.store.getSession(id)!.claudeSessionId;

    await fx.sessions.send(id, { ...msgBody("summarize chapter 3"), attachments: [{ type: "file_ref", path: "inbox/manual.pdf" }, { type: "file_ref", path: "inbox/small.md" }] });
    await idle(id, 2);
    // The process without Read was recycled; the resumed one has Read and says how to use it.
    expect(first.closed).toBe(true);
    const q = fx.sdk.last;
    expect(q).not.toBe(first);
    expect(q.options.resume).toBe(claudeId);
    expect(q.options.tools).toEqual(["WebSearch", "WebFetch", "Read"]);
    expect(String(q.options.systemPrompt)).toContain("with the Read tool");
    expect(String(q.options.systemPrompt)).toContain("`pages`");

    // The PDF is not inlined (no document block, no base64); the small text file is.
    const content = q.received.at(-1)!.message.content as { type: string; text?: string }[];
    expect(JSON.stringify(content).length).toBeLessThan(10_000);
    expect(content.map((b) => b.type)).toEqual(["text", "text"]);
    expect(content[0]!.text).toContain("# small");
    const pdf = join(rootReal, "inbox", "manual.pdf");
    expect(content[1]!.text).toContain("summarize chapter 3");
    expect(content[1]!.text).toContain(`- \`${pdf}\` (PDF, 16.0 MB) — read a few pages at a time with \`pages\``);
    // People still see the typed text and the file chips.
    const stored = JSON.parse(fx.store.listMessages(id, 0, 100).filter((m) => m.kind === "user").at(-1)!.payload);
    expect(stored.hub).toMatchObject({ text: "summarize chapter 3", attachments: [{ path: "inbox/manual.pdf", size: 16 * 1024 * 1024, mediaType: "application/pdf" }, { path: "inbox/small.md" }] });

    // Read: the attachments (by either root spelling), with page ranges — no card.
    fx.bus.clear();
    expect(await allow(q, "Read", { file_path: pdf, pages: "1-20" })).toEqual({ behavior: "allow", updatedInput: { file_path: pdf, pages: "1-20" } });
    expect(await allow(q, "Read", { file_path: join(root, "inbox", "manual.pdf") })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox", "small.md") })).toMatchObject({ behavior: "allow" });
    expect(await allow(q, "Read", { file_path: "../inbox/manual.pdf" })).toMatchObject({ behavior: "deny" }); // traversal, even to the same file
    expect(await allow(q, "Read", { file_path: `${rootReal}/inbox/../inbox/manual.pdf` })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox", "secret.txt") })).toEqual({ behavior: "deny", message: ATTACHMENT_READ_DENIED });
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox", "alias.pdf") })).toMatchObject({ behavior: "deny" }); // symlink to the attachment
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox", "hosts") })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "Read", { file_path: "/etc/passwd" })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox") })).toMatchObject({ behavior: "deny" });
    expect(await allow(q, "Read", {})).toMatchObject({ behavior: "deny" });
    expect(fx.bus.ofType("permission_request")).toEqual([]);

    // The PreToolUse gate refuses other paths before any permission rule (e.g. Claude Code's own cwd read rule).
    expect(await readGate(q, pdf)).toEqual({});
    expect(await readGate(q, join(rootReal, ".chat", "notes.txt"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ATTACHMENT_READ_DENIED } });
    expect(await readGate(q, join(rootReal, "inbox", "alias.pdf"))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    // An attachment later replaced by a symlink pointing outside the workspace is refused.
    const { rmSync } = await import("node:fs");
    rmSync(join(root, "inbox", "small.md"));
    symlinkSync("/etc/hosts", join(root, "inbox", "small.md"));
    expect(await allow(q, "Read", { file_path: join(rootReal, "inbox", "small.md") })).toMatchObject({ behavior: "deny" });

    // Another session of the same user cannot read this session's attachments.
    const other = oldChat();
    await fx.sessions.send(other, { ...msgBody("look"), attachments: [{ type: "file_ref", path: "inbox/secret.txt" }] });
    await idle(other, 1);
    const oq = fx.sdk.last;
    expect(await allow(oq, "Read", { file_path: pdf })).toMatchObject({ behavior: "deny" });
    expect(await allow(oq, "Read", { file_path: join(rootReal, "inbox", "secret.txt") })).toMatchObject({ behavior: "allow" });
  });

  it("a session with attachments starts with Read after a restart (attachments come from the stored messages)", async () => {
    fx = runtimeFixture();
    const id = oldChat();
    const root = join(fx.root, "alice");
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "inbox", "log.txt"), "x\n".repeat(200_000));
    await fx.sessions.send(id, { ...msgBody("check the log"), attachments: [{ type: "file_ref", path: "inbox/log.txt" }] });
    await idle(id, 1);
    const content = fx.sdk.last.received[0]!.message.content as { text?: string }[];
    expect(content.at(-1)!.text).toContain("(text, 390.6 KB) — read it in parts with `offset` and `limit`");
    await fx.sessions.close(id);
    // A fresh runtime over the same store: nothing cached.
    await fx.sessions.send(id, msgBody("again"));
    await idle(id, 2);
    const q = fx.sdk.last;
    expect(q.options.tools).toEqual(["WebSearch", "WebFetch", "Read"]);
    expect(await allow(q, "Read", { file_path: join(realpathSync(root), "inbox", "log.txt"), offset: 1000, limit: 200 })).toMatchObject({ behavior: "allow" });
  });
});

describe("show_visual", () => {
  it("validates title and exactly one of svg / html within the size limits", () => {
    const svg = '<svg viewBox="0 0 680 200"><rect fill="var(--accent)" width="10" height="10"/></svg>';
    expect(checkVisual({ title: "Flow", svg })).toBe("Shown to the user.");
    expect(checkVisual({ title: "Table", html: "<table><tr><td>1</td></tr></table>" })).toBe("Shown to the user.");
    expect(checkVisual({ svg })).toEqual({ text: expect.stringContaining("title is required"), isError: true });
    expect(checkVisual({ title: "  ", svg })).toMatchObject({ isError: true });
    expect(checkVisual({ title: "x".repeat(121), svg })).toEqual({ text: expect.stringContaining("120"), isError: true });
    expect(checkVisual({ title: "x".repeat(120), svg })).toBe("Shown to the user.");
    expect(checkVisual({ title: "Flow" })).toEqual({ text: expect.stringContaining("exactly one of svg or html"), isError: true });
    expect(checkVisual({ title: "Flow", svg, html: "<p>x</p>" })).toEqual({ text: expect.stringContaining("exactly one of svg or html"), isError: true });
    expect(checkVisual({ title: "Flow", svg: `<svg>${"a".repeat(MAX_VISUAL_BYTES)}</svg>` })).toEqual({ text: expect.stringContaining("larger than 200 KB"), isError: true });
    expect(checkVisual({ title: "Flow", html: "é".repeat(MAX_VISUAL_BYTES / 2 + 1) })).toMatchObject({ isError: true }); // bytes, not characters
    // Interactive HTML (scripts) is accepted like any other HTML.
    expect(checkVisual({ title: "Slider", html: '<input type="range" oninput="o.textContent=this.value"><output id="o"></output><script>sendPrompt("x")</script>' })).toBe(
      "Shown to the user.",
    );
  });

  it("the description and the guide allow interactive HTML (scripts from inline / cdnjs / jsDelivr) but no network", () => {
    const t = visualTool();
    expect(t.description).toBe(VISUAL_TOOL_DESCRIPTION);
    for (const text of [t.description, VISUAL_GUIDANCE]) {
      expect(text).not.toMatch(/no scripts/i);
      expect(text).toMatch(/interactive/);
      expect(text).toContain("cdnjs.cloudflare.com");
      expect(text).toContain("cdn.jsdelivr.net");
      expect(text).toMatch(/no network/i);
      expect(text).toMatch(/no external images or fonts/);
      expect(text).toContain("680 px");
      expect(text).toContain("sendPrompt(text)");
      for (const v of ["--fg", "--muted", "--line", "--accent", "--surface", "--bg"]) expect(text).toContain(v);
    }
    expect(t.description).toContain("200 KB");
    expect(t.description).toMatch(/height grows to fit/);
    // Claude-app style: bare in the text, flat, thin strokes, theme colours, everything inside the graphic.
    for (const rule of ["bare in the text", "flat (no shadows or gradients)", "transparent background", "no outer frame or border box", "1–1.5 px strokes", "var(--accent) sparingly", "system sans-serif at 12–14 px", "inside the graphic", "side-by-side panels", "nothing is clipped", "never overlapping lines"]) {
      expect(t.description).toContain(rule);
    }
    expect(VISUAL_GUIDANCE).toContain("Never say the chat cannot run scripts.");
    expect(String((t.schema.html as { description?: string }).description)).toMatch(/Scripts allowed/);
  });

  it("chat and code sessions get workstation-visual pre-approved (no card), with the guidance in the prompt", async () => {
    fx = runtimeFixture();
    const chat = fx.newSession("chat");
    await fx.sessions.send(chat, msgBody("draw it"));
    await idle(chat, 1);
    const tool = fx.sdk.mcpServers.get("workstation-visual")!.find((t) => t.name === "show_visual")!;
    expect(await tool.handler({ title: "Flow", svg: "<svg/>" })).toBe("Shown to the user.");
    expect(await tool.handler({ title: "Flow" })).toMatchObject({ isError: true });
    expect(String(fx.sdk.last.options.systemPrompt)).toContain(VISUAL_GUIDANCE);

    const code = fx.newSession("code");
    await fx.sessions.send(code, msgBody("explain the architecture"));
    await idle(code, 1);
    const q = fx.sdk.last;
    expect(q.options.allowedTools).toContain("mcp__workstation-visual__show_visual");
    expect((q.options.systemPrompt as { append?: string }).append).toContain(VISUAL_GUIDANCE);
    fx.bus.clear();
    expect(await allow(q, "mcp__workstation-visual__show_visual", { title: "x", svg: "<svg/>" })).toMatchObject({ behavior: "allow" });
    expect(fx.bus.ofType("permission_request")).toEqual([]);
  });
});
