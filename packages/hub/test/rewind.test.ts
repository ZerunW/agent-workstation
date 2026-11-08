/**
 * Rewind, fork and pins: sessions against the fake SDK, and the routes against a real hub (real git for the files part).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorBody, ForkResponse, HistoryResponse, Project, RewindResponse, Session, StoredMessage } from "@agent-workstation/protocol";
import { MAX_PINS, type MessageRow, type SessionRow } from "../src/db/store.js";
import { sessionTranscript } from "../src/search/summaries.js";
import { hubFixture, msgBody, runtimeFixture, tempDir, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

let fx: RuntimeFixture;
const cleanups: (() => void)[] = [];
afterEach(() => {
  fx?.cleanup();
  for (const c of cleanups.splice(0)) c();
});

const status = (id: string) => fx.sessions.statusOf(id).status;
const turnEnd = (id: string, n: number) => until(() => fx.store.getSession(id)!.turnCount >= n && status(id) === "idle", 4000, `turn ${n}`);
const raw = (id: string) => fx.store.db.prepare("SELECT seq, uuid, kind, rewound, delivery FROM messages WHERE session_id = ? ORDER BY seq").all(id) as { seq: number; uuid: string; kind: string; rewound: number; delivery: string | null }[];
const visible = (id: string) => fx.store.listMessages(id, 0, 1000);
const ofKind = (id: string, kind: string) => visible(id).filter((m) => m.kind === kind);
const payload = (m: MessageRow) => JSON.parse(m.payload) as Record<string, any>;

describe("rewind", () => {
  it("marks the message and everything after it rewound, hides them everywhere, and resumes at the last kept message as a fork", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const a = msgBody("first question");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    const q1 = fx.sdk.last;
    const claude1 = fx.store.getSession(id)!.claudeSessionId!;
    const keptAssistant = ofKind(id, "assistant")[0]!;
    const b = msgBody("second question");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    const before = raw(id);
    const target = fx.store.getMessageByUuid(id, b.uuid)!;
    expect(fx.store.sessionDocs(id).some((d) => d.text.includes("second question"))).toBe(true);

    fx.bus.clear();
    const r = await fx.sessions.rewind(id, { messageUuid: b.uuid });
    expect(r).toEqual({ draft: "second question", filesRestored: false, resent: null });

    // Rows are kept (none deleted) and marked from the target on.
    const after = raw(id);
    expect(after.map((m) => m.uuid)).toEqual(before.map((m) => m.uuid));
    for (const m of after) expect(m.rewound).toBe(m.seq >= target.seq ? 1 : 0);
    expect(fx.bus.ofType("messages_rewound")).toEqual([{ type: "messages_rewound", sessionId: id, fromSeq: target.seq }]);
    expect(fx.bus.ofType("session_updated").length).toBeGreaterThan(0);

    // Left out of the transcript, search, history tools and summaries.
    expect(visible(id).every((m) => m.seq < target.seq)).toBe(true);
    expect(fx.store.sessionDocs(id).some((d) => d.text.includes("second question"))).toBe(false);
    expect(fx.store.sessionDocs(id).some((d) => d.text.includes("first question"))).toBe(true);
    expect(sessionTranscript(fx.store, id).map((t) => t.text)).toEqual(["first question", "echo: first question"]);

    // The process is gone; the next one forks Claude's conversation at the last kept message.
    expect(q1.closed).toBe(true);
    const row = fx.store.getSession(id)!;
    expect(row).toMatchObject({ claudeSessionId: null, resumeFrom: claude1, resumeAt: keptAssistant.uuid });
    expect(row.claudeHistory).toContain(claude1);

    const c = msgBody("third question");
    const sent = await fx.sessions.send(id, c);
    expect(sent.seq).toBeGreaterThan(Math.max(...before.map((m) => m.seq)));
    await turnEnd(id, 3);
    const q2 = fx.sdk.last;
    expect(q2).not.toBe(q1);
    expect(q2.options).toMatchObject({ resume: claude1, resumeSessionAt: keptAssistant.uuid, forkSession: true });
    const done = fx.store.getSession(id)!;
    expect(done.claudeSessionId).toBe(q2.sessionId);
    expect(done.claudeSessionId).not.toBe(claude1);
    expect(done.claudeHistory).toContain(claude1);
    expect(done).toMatchObject({ resumeFrom: null, resumeAt: null });
    expect(sessionTranscript(fx.store, id).map((t) => t.text)).toEqual(["first question", "echo: first question", "third question", "echo: third question"]);

    // Later processes resume the new conversation normally.
    await fx.sessions.close(id);
    await fx.sessions.send(id, msgBody("fourth"));
    await turnEnd(id, 4);
    expect(fx.sdk.last.options.resume).toBe(q2.sessionId);
    expect(fx.sdk.last.options.forkSession).toBeUndefined();
  });

  it("rewinding to the first message starts a fresh conversation and re-titles from the message sent next", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("chat");
    const a = msgBody("hello there");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    expect(fx.store.getSession(id)!.title).toBe("hello there");
    const r = await fx.sessions.rewind(id, { messageUuid: a.uuid, resend: { text: "a new start" } });
    expect(r.draft).toBe("hello there");
    expect(r.resent?.state).toBe("accepted");
    await turnEnd(id, 2);
    const q = fx.sdk.last;
    expect(q.options.resume).toBeUndefined();
    expect(q.options.forkSession).toBeUndefined();
    expect(String(q.received[0]!.message.content)).toBe("a new start");
    expect(fx.store.getSession(id)!.title).toBe("a new start");
    expect(sessionTranscript(fx.store, id).map((t) => t.text)).toEqual(["a new start", "echo: a new start"]);
  });

  it("stops a running turn and cancels queued messages first", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    fx.sdk.behavior = (q, m) => {
      const text = String(m.message.content);
      if (text !== "slow") return q.reply(`echo: ${text}`);
      q.init();
      q.streamText("msg_slow", "working on it");
      q.onInterrupt = (qq) => qq.result();
    };
    await fx.sessions.send(id, msgBody("first"));
    await turnEnd(id, 1);
    const slow = msgBody("slow");
    await fx.sessions.send(id, slow);
    await until(() => fx.sdk.last.received.length === 2, 2000, "slow turn");
    const queued = msgBody("queued");
    await fx.sessions.send(id, queued);
    expect(status(id)).toBe("running");
    const q = fx.sdk.last;

    const r = await fx.sessions.rewind(id, { messageUuid: slow.uuid });
    expect(r.draft).toBe("slow");
    expect(q.interrupted).toBe(1);
    expect(q.closed).toBe(true);
    expect(status(id)).toBe("idle");
    const rows = raw(id);
    const from = rows.find((m) => m.uuid === slow.uuid)!.seq;
    expect(rows.filter((m) => m.seq >= from).every((m) => m.rewound === 1)).toBe(true);
    expect(rows.find((m) => m.uuid === queued.uuid)).toMatchObject({ delivery: "cancelled", rewound: 1 });
    // Nothing of the stopped turn lands later.
    await new Promise((res) => setTimeout(res, 50));
    expect(visible(id).every((m) => m.seq < from)).toBe(true);
  });

  it("resend keeps the original attachments, with and without new text", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    writeFileSync(join(fx.root, "alice", "notes.txt"), "some notes\n");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const first = { uuid: randomUUID(), text: "look at this", attachments: [{ type: "file_ref" as const, path: "notes.txt" }, { type: "image" as const, mediaType: "image/png", dataBase64: png }] };
    await fx.sessions.send(id, first);
    await turnEnd(id, 1);
    const original = payload(fx.store.getMessageByUuid(id, first.uuid)!);

    // Same text.
    await fx.sessions.rewind(id, { messageUuid: first.uuid, resend: {} });
    await turnEnd(id, 2);
    const again = ofKind(id, "user")[0]!;
    expect(again.uuid).not.toBe(first.uuid);
    expect(payload(again).hub).toEqual(original.hub);
    expect(payload(again).message.content).toEqual(original.message.content);
    expect(fx.sdk.last.received[0]!.message.content).toEqual(original.message.content);

    // New text: the attachments stay, the typed text changes.
    const r = await fx.sessions.rewind(id, { messageUuid: again.uuid, resend: { text: "and now this" } });
    expect(r.draft).toBe("look at this");
    await turnEnd(id, 3);
    const edited = ofKind(id, "user")[0]!;
    const p = payload(edited);
    expect(p.hub).toEqual({ text: "and now this", attachments: original.hub.attachments });
    const blocks = p.message.content as { type: string; text?: string; source?: { data: string } }[];
    expect(blocks.find((b) => b.type === "image")?.source?.data).toBe(png);
    const text = blocks.find((b) => b.type === "text")!.text!;
    expect(text.startsWith("and now this\n\nAttached files")).toBe(true);
    expect(text).toContain("notes.txt");
    expect(text).not.toContain("look at this");
    expect(fx.store.getSession(id)!.turnCount).toBe(3);
  });

  it("refuses non-user targets, unknown and rewound messages, and subagent sessions", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const a = msgBody("one");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    const assistant = ofKind(id, "assistant")[0]!;
    await expect(fx.sessions.rewind(id, { messageUuid: assistant.uuid })).rejects.toMatchObject({ status: 400 });
    await expect(fx.sessions.rewind(id, { messageUuid: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(fx.sessions.rewind(id, { messageUuid: a.uuid, files: true })).rejects.toMatchObject({ status: 409, code: "unsupported" });
    expect(raw(id).every((m) => m.rewound === 0)).toBe(true);
    await fx.sessions.rewind(id, { messageUuid: b.uuid });
    await expect(fx.sessions.rewind(id, { messageUuid: b.uuid })).rejects.toMatchObject({ status: 404 });
    expect(() => fx.sessions.fork(id, b.uuid)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => fx.sessions.fork(id, ofKind(id, "result")[0]!.uuid)).toThrow(expect.objectContaining({ status: 400 }));

    // A subagent's session (parentSessionId) has neither.
    const get = fx.store.getSession.bind(fx.store);
    fx.store.getSession = (sid: string) => {
      const r = get(sid);
      return r && sid === id ? ({ ...r, parentSessionId: randomUUID() } as SessionRow) : r;
    };
    await expect(fx.sessions.rewind(id, { messageUuid: a.uuid })).rejects.toMatchObject({ status: 400 });
    expect(() => fx.sessions.fork(id, assistant.uuid)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("rewind with files (runtime)", () => {
  it("restores the snapshot taken before the message's turn; 409 and nothing changes without one", async () => {
    const calls: string[] = [];
    const snapshots = new Set<string>();
    fx = runtimeFixture({
      projects: {
        projectForPath: () => null,
        projectIdForCwd: () => "p1",
        beforeWrite: async () => undefined,
        releaseTool: () => undefined,
        suspendHold: () => null,
        releaseSession: () => undefined,
        turnEnded: (t) => void snapshots.add(`refs/snapshots/${t.sessionId}/${t.turn}`),
        changed: () => undefined,
        turnSnapshot: async (_u, _c, sid, turn) => (snapshots.has(`refs/snapshots/${sid}/${turn}`) ? `refs/snapshots/${sid}/${turn}` : null),
        restoreSnapshot: async (_u, _c, ref) => {
          calls.push(ref);
          return { trashRef: "refs/trash/1" };
        },
      },
    });
    const id = fx.newSession("code");
    const a = msgBody("one");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    // Before the first turn there is no snapshot.
    await expect(fx.sessions.rewind(id, { messageUuid: a.uuid, files: true })).rejects.toMatchObject({ status: 409, code: "unsupported" });
    expect(raw(id).every((m) => m.rewound === 0)).toBe(true);
    expect(calls).toEqual([]);
    const r = await fx.sessions.rewind(id, { messageUuid: b.uuid, files: true });
    expect(r).toMatchObject({ draft: "two", filesRestored: true });
    expect(calls).toEqual([`refs/snapshots/${id}/1`]);
  });
});

describe("fork", () => {
  it("copies the conversation up to an assistant message / just before a user message and never touches the source", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await fx.sessions.updateSettings(id, { effort: "max", permissionMode: "acceptEdits" });
    const a = msgBody("one");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    const src = fx.store.getSession(id)!;
    const srcRows = raw(id);
    const q = fx.sdk.last;
    const assistant1 = ofKind(id, "assistant")[0]!;

    fx.bus.clear();
    const f1 = fx.sessions.fork(id, assistant1.uuid);
    expect(f1.draft).toBeNull();
    expect(f1.row).toMatchObject({ kind: "code", cwd: src.cwd, model: src.model, permissionMode: "acceptEdits", effort: "max", incognito: false, title: `${src.title} (fork)` });
    expect(f1.row).toMatchObject({ claudeSessionId: null, resumeFrom: src.claudeSessionId, resumeAt: assistant1.uuid });
    const copied = visible(f1.row.id);
    const upTo = srcRows.filter((m) => m.seq <= assistant1.seq);
    expect(copied.map((m) => m.uuid)).toEqual(upTo.map((m) => m.uuid));
    expect(copied.map((m) => m.seq)).toEqual(upTo.map((_, i) => i + 1));
    expect(fx.store.sessionDocs(f1.row.id).some((d) => d.text === "one")).toBe(true);

    const f2 = fx.sessions.fork(id, b.uuid);
    expect(f2.draft).toBe("two");
    expect(visible(f2.row.id).map((m) => m.uuid)).toEqual(srcRows.filter((m) => m.seq < fx.store.getMessageByUuid(id, b.uuid)!.seq).map((m) => m.uuid));
    expect(f2.row.resumeAt).toBe(assistant1.uuid);

    // The source: same rows, same conversation, its process untouched.
    expect(raw(id)).toEqual(srcRows);
    expect(fx.store.getSession(id)!.claudeSessionId).toBe(src.claudeSessionId);
    expect(q.closed).toBe(false);
    expect(fx.bus.ofType("messages_rewound")).toEqual([]);

    // The fork's first process forks the source's Claude conversation at the copied message.
    await fx.sessions.send(f1.row.id, msgBody("three"));
    await turnEnd(f1.row.id, 1);
    const fq = fx.sdk.last;
    expect(fq).not.toBe(q);
    expect(fq.options).toMatchObject({ resume: src.claudeSessionId, resumeSessionAt: assistant1.uuid, forkSession: true });
    const forked = fx.store.getSession(f1.row.id)!;
    expect(forked.claudeSessionId).toBe(fq.sessionId);
    // Deleting the fork must never delete the source's transcript.
    expect(forked.claudeHistory).not.toContain(src.claudeSessionId);
    expect(raw(id)).toEqual(srcRows);
  });
});

describe("pins", () => {
  it("adds and removes pins, keeps at most MAX_PINS and drops pins of rewound messages", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("one"));
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    const [a1, a2] = ofKind(id, "assistant");
    fx.bus.clear();
    expect(fx.sessions.setPin(id, a1!.uuid, true).pinnedMessages).toEqual([a1!.uuid]);
    expect(fx.sessions.setPin(id, a2!.uuid, true).pinnedMessages).toEqual([a1!.uuid, a2!.uuid]);
    expect(fx.sessions.setPin(id, a1!.uuid, true).pinnedMessages).toEqual([a2!.uuid, a1!.uuid]);
    expect(fx.bus.ofType("session_updated").at(-1)?.session.pinnedMessages).toEqual([a2!.uuid, a1!.uuid]);
    expect(fx.sessions.setPin(id, a2!.uuid, false).pinnedMessages).toEqual([a1!.uuid]);
    expect(() => fx.sessions.setPin(id, "nope", true)).toThrow(expect.objectContaining({ status: 404 }));
    expect(fx.sessions.toProtocol(fx.store.getSession(id)!).pinnedMessages).toEqual([a1!.uuid]);

    // Pin a2 again, then rewind to "two": its pin goes, a1's stays; a rewound message cannot be pinned.
    fx.sessions.setPin(id, a2!.uuid, true);
    await fx.sessions.rewind(id, { messageUuid: b.uuid });
    expect(fx.store.getSession(id)!.pinnedMessages).toEqual([a1!.uuid]);
    expect(() => fx.sessions.setPin(id, a2!.uuid, true)).toThrow(expect.objectContaining({ status: 404 }));
    expect(fx.sessions.setPin(id, a1!.uuid, false).pinnedMessages).toBeUndefined();

    // Limit: the oldest pins are dropped.
    const extra = Array.from({ length: MAX_PINS + 5 }, () => fx.store.appendMessage(id, { uuid: randomUUID(), kind: "system", payload: { type: "system", subtype: "informational" } })!.uuid);
    for (const u of extra) fx.sessions.setPin(id, u, true);
    const pins = fx.store.getSession(id)!.pinnedMessages;
    expect(pins).toHaveLength(MAX_PINS);
    expect(pins).toEqual(extra.slice(5));
  });
});

// ------------------------------------------------------------------ routes (real hub)

describe("routes", () => {
  let f: HubFixture;
  beforeAll(async () => {
    f = await hubFixture();
  });
  afterAll(async () => {
    await f.close();
  });
  const A = () => f.as("alice");
  const settled = (id: string, n: number) => until(() => f.hub.store.getSession(id)!.turnCount >= n && f.hub.sessions.statusOf(id).status === "idle", 5000, `turn ${n}`);
  const send = async (id: string, text: string) => {
    const uuid = randomUUID();
    const r = await f.app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, headers: A(), payload: { uuid, text } });
    expect(r.statusCode).toBe(200);
    return uuid;
  };

  it("rewind with files restores the project to the snapshot before the message (trash ref first); 409 without a snapshot", async () => {
    const pr = await f.app.inject({ method: "POST", url: "/api/projects", headers: A(), payload: { name: "rw" } });
    expect(pr.statusCode).toBe(201);
    const project = Project.parse(pr.json());
    const cwdAbs = join(f.root, "alice", "projects", "rw");
    const cr = await f.app.inject({ method: "POST", url: "/api/sessions", headers: A(), payload: { kind: "code", cwd: "projects/rw" } });
    const id = (cr.json() as { id: string }).id;
    f.sdk.behavior = async (q, m) => {
      q.init();
      writeFileSync(join(cwdAbs, "a.txt"), `${String(m.message.content)}\n`);
      q.assistant(`msg_${randomUUID().slice(0, 6)}`, "written");
      q.result();
    };
    const history = async () => HistoryResponse.parse((await f.app.inject({ url: `/api/projects/${project.id}/history`, headers: A() })).json());
    const u1 = await send(id, "v1");
    await settled(id, 1);
    await until(async () => (await history()).some((s) => s.ref === `refs/snapshots/${id}/1`), 4000, "snapshot 1");
    const u2 = await send(id, "v2");
    await settled(id, 2);
    await until(async () => (await history()).some((s) => s.ref === `refs/snapshots/${id}/2`), 4000, "snapshot 2");
    expect(readFileSync(join(cwdAbs, "a.txt"), "utf8")).toBe("v2\n");

    // The first message's turn has no snapshot before it: 409, nothing changes.
    const no = await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: A(), payload: { messageUuid: u1, files: true } });
    expect(no.statusCode).toBe(409);
    expect(ErrorBody.parse(no.json()).code).toBe("unsupported");
    expect(f.hub.store.listMessages(id, 0, 100).some((m) => m.uuid === u2)).toBe(true);

    const trashBefore = (await history()).filter((s) => s.kind === "trash").length;
    const r = await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: A(), payload: { messageUuid: u2, files: true } });
    expect(r.statusCode).toBe(200);
    expect(RewindResponse.parse(r.json())).toEqual({ draft: "v2", filesRestored: true });
    expect(readFileSync(join(cwdAbs, "a.txt"), "utf8")).toBe("v1\n");
    expect((await history()).filter((s) => s.kind === "trash").length).toBe(trashBefore + 1);

    // GET messages leaves the rewound ones out.
    const msgs = (await f.app.inject({ url: `/api/sessions/${id}/messages`, headers: A() })).json() as StoredMessage[];
    expect(msgs.some((m) => m.uuid === u2)).toBe(false);
    expect(msgs.some((m) => m.uuid === u1)).toBe(true);
  });

  it("fork returns 201 + ForkResponse, pins answer with the session; other users get 404; rewind validates its body", async () => {
    const cr = await f.app.inject({ method: "POST", url: "/api/sessions", headers: A(), payload: { kind: "chat" } });
    const id = (cr.json() as { id: string }).id;
    f.sdk.behavior = (q, m) => q.reply(`echo: ${String(m.message.content)}`);
    const u1 = await send(id, "hi");
    await settled(id, 1);
    const assistant = f.hub.store.listMessages(id, 0, 100).find((m) => m.kind === "assistant")!;

    const fk = await f.app.inject({ method: "POST", url: `/api/sessions/${id}/fork`, headers: A(), payload: { messageUuid: u1 } });
    expect(fk.statusCode).toBe(201);
    const fr = ForkResponse.parse(fk.json());
    expect(fr.draft).toBe("hi");
    expect(fr.session).toMatchObject({ kind: "chat", title: "hi (fork)", lastSeq: 0 });

    const pin = await f.app.inject({ method: "PUT", url: `/api/sessions/${id}/pins/${assistant.uuid}`, headers: A() });
    expect(pin.statusCode).toBe(200);
    expect(Session.parse(pin.json()).pinnedMessages).toEqual([assistant.uuid]);
    const unpin = await f.app.inject({ method: "DELETE", url: `/api/sessions/${id}/pins/${assistant.uuid}`, headers: A() });
    expect(Session.parse(unpin.json()).pinnedMessages).toBeUndefined();
    expect((await f.app.inject({ method: "PUT", url: `/api/sessions/${id}/pins/nope`, headers: A() })).statusCode).toBe(404);

    const bob = f.as("bob");
    expect((await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: bob, payload: { messageUuid: u1 } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: `/api/sessions/${id}/fork`, headers: bob, payload: { messageUuid: u1 } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "PUT", url: `/api/sessions/${id}/pins/${assistant.uuid}`, headers: bob })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "DELETE", url: `/api/sessions/${id}/pins/${assistant.uuid}`, headers: bob })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: A(), payload: {} })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: A(), payload: { messageUuid: assistant.uuid } })).statusCode).toBe(400);

    const rw = await f.app.inject({ method: "POST", url: `/api/sessions/${id}/rewind`, headers: A(), payload: { messageUuid: u1, resend: { text: "hello again" } } });
    expect(RewindResponse.parse(rw.json())).toEqual({ draft: "hi", filesRestored: false });
    await settled(id, 2);
    const texts = f.hub.store.listMessages(id, 0, 100).filter((m) => m.kind === "user").map((m) => JSON.parse(m.payload).message.content);
    expect(texts).toEqual(["hello again"]);
  });
});
