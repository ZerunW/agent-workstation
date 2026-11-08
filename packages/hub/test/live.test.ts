/**
 * Opt-in live test against the real Agent SDK and an Anthropic API key (LIVE_KEY_FILE, default
 * /etc/agent-workstation/anthropic.env):
 *   LIVE=1 npm test -w packages/hub
 * Uses Haiku to keep it cheap. Workspaces/DB live in a temp dir; Claude's own
 * transcripts go to the real ~/.claude/projects (only the test's own session
 * transcript is deleted at the end, exercising the explicit-delete path).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { createHub, startHub, stopHub } from "../src/hub.js";
import { transcriptPaths } from "../src/sessions/claudeFiles.js";
import { loadRealSdk } from "../src/sessions/sdk.js";
import { parseCumulative } from "../src/sessions/usage.js";
import { silentLogger } from "../src/util/log.js";
import { tempDir, tick, until } from "./helpers.js";

const LIVE = process.env.LIVE === "1";
const MODEL = process.env.LIVE_MODEL ?? "haiku";
const LIVE_KEY_FILE = process.env.LIVE_KEY_FILE ?? "/etc/agent-workstation/anthropic.env";

function rssMiB(pid: number | null): number | null {
  if (!pid) return null;
  try {
    return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024);
  } catch {
    return null;
  }
}

describe.skipIf(!LIVE)("live Agent SDK", () => {
  it(
    "chat turn (fills the model catalog), resume with delta accounting, code turn with a permission, delete",
    async () => {
      const t = tempDir("workstation-live-");
      const claudeHome = join(homedir(), ".claude");
      const config = parseConfig(
        {
          paths: { users_root: join(t.dir, "users"), data_dir: join(t.dir, "data"), claude_bin: "", claude_home: claudeHome },
          auth: { anthropic_api_key_file: LIVE_KEY_FILE },
          sessions: { permission_timeout_s: 120 },
        },
        null,
        {},
      );
      const hub = createHub(config, { log: silentLogger, sdk: await loadRealSdk(), dbFile: join(t.dir, "data", "hub.sqlite") });
      await startHub(hub, { timers: false, retention: false });
      const report: Record<string, unknown> = { model: MODEL };
      try {
        // chat turn
        hub.users.ensure("livetest");
        const chat = hub.sessions.create({ user: "livetest", kind: "chat", cwd: ".chat", model: MODEL, permissionMode: "default", effort: null });
        const idle = (id: string, turns: number, ms = 120_000) => until(() => hub.store.getSession(id)!.turnCount >= turns && hub.sessions.statusOf(id).status === "idle", ms, `turn ${turns}`);
        let t1 = Date.now();
        await hub.sessions.send(chat.id, { uuid: randomUUID(), text: "Reply with exactly the word PONG and nothing else." });
        const proc = await until(() => hub.sessions.liveProcesses()[0], 30_000, "process");
        await idle(chat.id, 1);
        report.rssMiBAfterFirstTurn = rssMiB(proc.pid);
        report.firstTurnMs = Date.now() - t1;
        const text = (id: string) =>
          hub.store
            .listMessages(id, 0, 1000)
            .filter((m) => m.kind === "assistant")
            .map((m) => (JSON.parse(m.payload) as { message: { content: { type: string; text?: string }[] } }).message.content.map((c) => c.text ?? "").join(""))
            .join(" | ");
        report.chatReply = text(chat.id);
        expect(String(report.chatReply)).toContain("PONG");
        const claudeId = hub.store.getSession(chat.id)!.claudeSessionId;
        expect(claudeId).toBeTruthy();

        // 3) close → resume; usage must be stored as deltas
        await hub.sessions.close(chat.id);
        t1 = Date.now();
        await hub.sessions.send(chat.id, { uuid: randomUUID(), text: "Now reply with exactly the word PING." });
        await idle(chat.id, 2);
        report.resumeTurnMs = Date.now() - t1;
        report.resumedSameClaudeSession = hub.store.getSession(chat.id)!.claudeSessionId === claudeId;
        const turns = hub.store.db.prepare("SELECT model, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_create_tokens AS cc, cost_usd AS c FROM turns WHERE session_id = ? ORDER BY id").all(chat.id) as {
          model: string;
          i: number;
          o: number;
          cr: number;
          cc: number;
          c: number;
        }[];
        const cum = parseCumulative(hub.store.getSession(chat.id)!.usageCumulative)!;
        report.turns = turns;
        report.cumulative = cum.models;
        for (const [model, totals] of Object.entries(cum.models)) {
          const rows = turns.filter((r) => r.model === model);
          expect(rows.reduce((s, r) => s + r.o, 0)).toBe(totals.output);
          expect(rows.reduce((s, r) => s + r.i, 0)).toBe(totals.input);
        }
        expect(turns.length).toBeGreaterThanOrEqual(2);

        // 3b) /clear starts a new Claude conversation; accounting must stay non-negative and complete.
        await hub.sessions.send(chat.id, { uuid: randomUUID(), text: "/clear" });
        await idle(chat.id, 3);
        await hub.sessions.send(chat.id, { uuid: randomUUID(), text: "Reply with exactly the word OK." });
        await idle(chat.id, 4);
        const afterClear = hub.store.getSession(chat.id)!;
        const turns2 = hub.store.db.prepare("SELECT input_tokens AS i, output_tokens AS o, cost_usd AS c FROM turns WHERE session_id = ? ORDER BY id").all(chat.id) as { i: number; o: number; c: number }[];
        report.clear = {
          claudeSessionChanged: afterClear.claudeSessionId !== claudeId,
          history: afterClear.claudeHistory,
          resetRows: hub.store.listMessages(chat.id, 0, 1000).filter((m) => m.kind === "reset").length,
          turnsAfterClear: turns2.slice(turns.length),
          cumulativeAfterClear: parseCumulative(afterClear.usageCumulative)?.models,
        };
        expect(turns2.every((r) => r.i >= 0 && r.o >= 0 && r.c >= 0)).toBe(true);

        // 4) code turn with a real permission prompt answered through the hub
        const code = hub.sessions.create({ user: "livetest", kind: "code", cwd: "", model: MODEL, permissionMode: "default", effort: null });
        // `mkdir` writes to disk, so default mode must ask (read-only commands like `echo` are auto-approved by Claude Code).
        await hub.sessions.send(code.id, { uuid: randomUUID(), text: "Use the Bash tool to run exactly this command: mkdir workstation-live-check — then reply with the single word workstation-live-check." });
        await until(() => hub.sessions.permissions.pendingFor(code.id)[0] || hub.store.getSession(code.id)!.turnCount > 0, 120_000, "permission request");
        const req = hub.sessions.permissions.pendingFor(code.id)[0];
        if (!req) {
          report.codeWithoutPermission = { kinds: hub.store.listMessages(code.id, 0, 1000).map((m) => m.kind), reply: text(code.id) };
          throw new Error("the code turn finished without asking for permission");
        }
        report.permissionRequest = { toolName: req.toolName, input: req.input, suggestions: req.suggestions?.length ?? 0 };
        expect(hub.sessions.statusOf(code.id).status).toBe("requires_action");
        expect(hub.sessions.respondPermission("livetest", code.id, { requestId: req.requestId, behavior: "allow" })).toEqual({ ok: true });
        await idle(code.id, 1);
        const kinds = hub.store.listMessages(code.id, 0, 1000).map((m) => m.kind);
        report.codeKinds = kinds;
        report.codeReply = text(code.id);
        expect(kinds).toContain("user"); // tool_result
        expect(String(report.codeReply)).toContain("workstation-live-check");
        expect(existsSync(join(t.dir, "users", "livetest", "workstation-live-check"))).toBe(true);

        // 5) explicit delete removes Claude's transcript too
        const ids = new Set([claudeId!, ...(hub.store.getSession(chat.id)!.claudeSessionId ? [hub.store.getSession(chat.id)!.claudeSessionId!] : [])]);
        const before = await transcriptPaths(claudeHome, ids);
        await hub.sessions.delete(chat.id);
        const after = await transcriptPaths(claudeHome, ids);
        report.transcriptFiles = { before: before.length, after: after.length };
        expect(before.length).toBeGreaterThan(0);
        expect(after.length).toBe(0);
        const codeClaude = hub.store.getSession(code.id)!.claudeSessionId;
        await hub.sessions.delete(code.id);
        if (codeClaude) expect((await transcriptPaths(claudeHome, new Set([codeClaude]))).length).toBe(0);
        expect(existsSync(join(t.dir, "data", "hub.sqlite"))).toBe(true);
      } finally {
        console.log("LIVE REPORT\n" + JSON.stringify(report, null, 2));
        await stopHub(hub);
        t.cleanup();
      }
    },
    420_000,
  );
  it(
    "project + skills: skills discovered by a code session, a real Write lands in review with lastTouchedBy, accept moves local",
    async () => {
      const t = tempDir("workstation-live-proj-");
      const claudeHome = join(homedir(), ".claude");
      const config = parseConfig(
        {
          paths: { users_root: join(t.dir, "users"), data_dir: join(t.dir, "data"), claude_bin: "", claude_home: claudeHome },
          auth: { admin_usernames: ["liveadmin"], anthropic_api_key_file: LIVE_KEY_FILE },
          sessions: { permission_timeout_s: 120 },
        },
        null,
        {},
      );
      const hub = createHub(config, { log: silentLogger, sdk: await loadRealSdk(), dbFile: join(t.dir, "data", "hub.sqlite"), reviewNotifyMs: 100 });
      await startHub(hub, { timers: false, retention: false });
      const app = await buildApp(hub);
      await app.ready();
      const H = (user = "liveproj") => ({ "x-workstation-user": user });
      const report: Record<string, unknown> = { model: MODEL };
      let sessionId: string | null = null;
      try {
        // skills: one user skill, one global skill (admin)
        expect((await app.inject({ method: "POST", url: "/api/skills", headers: H(), payload: { name: "workstation-live-skill", content: "---\ndescription: Live test user skill\n---\nSay OK." } })).statusCode).toBe(201);
        expect((await app.inject({ method: "POST", url: "/api/skills", headers: H("liveadmin"), payload: { name: "workstation-live-global", content: "---\ndescription: Live test global skill\n---\nSay GLOBAL.", scope: "global" } })).statusCode).toBe(201);

        // project with a tar.zst baseline
        const pr = await app.inject({ method: "POST", url: "/api/projects", headers: H(), payload: { name: "livep", origin: "live-test" } });
        expect(pr.statusCode).toBe(201);
        const project = pr.json() as { id: string; localCommit: string };
        const src = join(t.dir, "src");
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, "README.md"), "# live project\n");
        execFileSync("tar", ["-c", "--zstd", "-f", join(t.dir, "b.tar.zst"), "-C", src, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        const bl = await app.inject({ method: "POST", url: `/api/projects/${project.id}/baseline`, headers: { ...H(), "content-type": "application/octet-stream" }, payload: readFileSync(join(t.dir, "b.tar.zst")) });
        expect(bl.statusCode).toBe(200);
        const localBefore = (bl.json() as { localCommit: string }).localCommit;

        // code session inside the project; acceptEdits lets Claude Code allow the Write itself
        const sr = await app.inject({ method: "POST", url: "/api/sessions", headers: H(), payload: { kind: "code", cwd: "projects/livep", model: MODEL, permissionMode: "acceptEdits" } });
        expect(sr.statusCode).toBe(201);
        const session = sr.json() as { id: string; projectId: string };
        sessionId = session.id;
        expect(session.projectId).toBe(project.id);
        const send = await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/messages`,
          headers: H(),
          payload: { uuid: randomUUID(), text: "Use the Write tool to create the file hello.txt in the current directory containing exactly: hello from workstation\nThen reply with the single word done." },
        });
        expect(send.statusCode).toBe(200);
        // Safety net: allow anything the hub is asked about (should not be needed with acceptEdits).
        let asked = 0;
        await until(() => {
          const req = hub.sessions.permissions.pendingFor(session.id)[0];
          if (req) {
            asked++;
            hub.sessions.respondPermission("liveproj", session.id, { requestId: req.requestId, behavior: "allow" });
          }
          return hub.store.getSession(session.id)!.turnCount >= 1 && hub.sessions.statusOf(session.id).status === "idle";
        }, 180_000, "code turn");
        report.permissionPromptsAnswered = asked;
        const wt = join(t.dir, "users", "liveproj", "projects", "livep", "hello.txt");
        report.helloTxt = readFileSync(wt, "utf8");
        expect(String(report.helloTxt)).toContain("hello from workstation");

        // skills: the live process's supportedCommands() includes both, marked isSkill
        const cmds = (await app.inject({ url: `/api/commands?sessionId=${session.id}`, headers: H() })).json() as { name: string; isSkill?: boolean }[];
        report.skillCommands = cmds.filter((c) => c.isSkill).map((c) => c.name);
        expect(cmds.find((c) => c.name === "workstation-live-skill")?.isSkill).toBe(true);
        expect(cmds.find((c) => c.name === "workstation-live-global")?.isSkill).toBe(true);
        // a skill created while the process is alive appears after the hub's reloadSkills()
        expect((await app.inject({ method: "POST", url: "/api/skills", headers: H(), payload: { name: "workstation-live-late", content: "Late skill." } })).statusCode).toBe(201);
        const late = await until(async () => {
          const c = (await app.inject({ url: `/api/commands?sessionId=${session.id}`, headers: H() })).json() as { name: string; isSkill?: boolean }[];
          return c.find((x) => x.name === "workstation-live-late");
        }, 20_000, "late skill after reloadSkills");
        report.lateSkill = late;
        expect(late.isSkill).toBe(true);

        // review: hello.txt added, touched by Write in turn 1 of this session
        const review = (await app.inject({ url: `/api/projects/${project.id}/review`, headers: H() })).json() as { files: { path: string; status: string; lastTouchedBy: unknown }[]; project: { localCommit: string } };
        report.review = review.files;
        const hello = review.files.find((f) => f.path === "hello.txt");
        expect(hello).toMatchObject({ status: "added", lastTouchedBy: { sessionId: session.id, turn: 1, tool: "Write" } });
        expect(review.project.localCommit).toBe(localBefore);

        // the turn-end snapshot exists
        const history = await until(async () => {
          const h = (await app.inject({ url: `/api/projects/${project.id}/history`, headers: H() })).json() as { kind: string; sessionId: string | null; turn: number | null; message: string }[];
          return h.some((x) => x.kind === "snapshot") ? h : null;
        }, 10_000, "snapshot");
        report.snapshot = history.find((x) => x.kind === "snapshot");
        expect(report.snapshot).toMatchObject({ sessionId: session.id, turn: 1 });

        // accept → local moves, nothing pending
        const diff = (await app.inject({ url: `/api/projects/${project.id}/review/diff?path=hello.txt`, headers: H() })).json() as { diffId: string; hunks: unknown[] };
        expect(diff.diffId).toMatch(/^[0-9a-f]{64}$/);
        const acc = await app.inject({ method: "POST", url: `/api/projects/${project.id}/review/accept`, headers: H(), payload: { path: "hello.txt" } });
        expect(acc.statusCode).toBe(200);
        const accBody = acc.json() as { localCommit: string; files: { path: string; contentBase64: string }[] };
        expect(Buffer.from(accBody.files[0]!.contentBase64, "base64").toString("utf8")).toContain("hello from workstation");
        const after = (await app.inject({ url: `/api/projects/${project.id}`, headers: H() })).json() as { localCommit: string; pendingFiles: number };
        report.local = { before: localBefore, after: after.localCommit, pending: after.pendingFiles };
        expect(after.localCommit).toBe(accBody.localCommit);
        expect(after.localCommit).not.toBe(localBefore);
        expect(after.pendingFiles).toBe(0);
        await tick(50);
      } finally {
        console.log("LIVE PROJECT REPORT\n" + JSON.stringify(report, null, 2));
        if (sessionId) await hub.sessions.delete(sessionId).catch(() => undefined);
        await app.close();
        await stopHub(hub);
        t.cleanup();
      }
    },
    300_000,
  );
});
