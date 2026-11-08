/**
 * Known heads-ups (the user's "Knew this already" list: store, routes, the agent-context section) and the snapshot's
 * rewound seq ranges.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnownHeadsUp, KnownHeadsUpsResponse, SessionSnapshot } from "@agent-workstation/protocol";
import { Store } from "../src/db/store.js";
import { MAX_KNOWN_HEADS_UPS } from "../src/routes/system.js";
import { KNOWN_HEADS_UPS_LEAD, knownHeadsUpsSection, MAX_KNOWN_HEADS_UPS_BYTES, USER_INSTRUCTIONS_HEADING } from "../src/sessions/guide.js";
import { hubFixture, msgBody, runtimeFixture, until, type HubFixture, type RuntimeFixture } from "./helpers.js";

describe("known heads-ups: store", () => {
  let store: Store;
  beforeAll(() => {
    store = new Store(":memory:");
  });
  afterAll(() => store.close());

  it("adds trimmed texts newest first, dedupes case-insensitively (same id, becomes newest), deletes by id per user", () => {
    const a = store.addKnownHeadsUp("alice", "  Deleting the cache slows the next build.  ", "2026-10-31T10:00:00.000Z");
    expect(a).toMatchObject({ text: "Deleting the cache slows the next build.", at: "2026-10-31T10:00:00.000Z" });
    const b = store.addKnownHeadsUp("alice", "The server has 8 GB of memory.", "2026-10-31T10:01:00.000Z");
    expect(store.listKnownHeadsUps("alice").map((k) => k.id)).toEqual([b.id, a.id]);
    const again = store.addKnownHeadsUp("alice", "DELETING THE CACHE slows the next build.", "2026-10-31T10:02:00.000Z");
    expect(again).toEqual({ id: a.id, text: "Deleting the cache slows the next build.", at: "2026-10-31T10:02:00.000Z" });
    expect(store.listKnownHeadsUps("alice").map((k) => k.id)).toEqual([a.id, b.id]);
    // Per user: bob's list is separate and cannot delete alice's entries.
    store.addKnownHeadsUp("bob", "The server has 8 GB of memory.");
    expect(store.listKnownHeadsUps("bob")).toHaveLength(1);
    expect(store.deleteKnownHeadsUp("bob", a.id)).toBe(false);
    expect(store.deleteKnownHeadsUp("alice", a.id)).toBe(true);
    expect(store.deleteKnownHeadsUp("alice", a.id)).toBe(false);
    expect(store.listKnownHeadsUps("alice").map((k) => k.id)).toEqual([b.id]);
    for (const k of store.listKnownHeadsUps("alice")) expect(KnownHeadsUp.parse(k)).toEqual(k);
  });

  it("keeps at most the newest 200, the oldest dropped; deleting the user removes the list", () => {
    for (let i = 0; i < 205; i++) store.addKnownHeadsUp("carol", `caveat ${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), MAX_KNOWN_HEADS_UPS);
    const list = store.listKnownHeadsUps("carol");
    expect(list).toHaveLength(200);
    expect(list[0]!.text).toBe("caveat 204");
    expect(list.at(-1)!.text).toBe("caveat 5");
    store.ensureUser("carol");
    store.deleteUserData("carol");
    expect(store.listKnownHeadsUps("carol")).toEqual([]);
  });
});

describe("known heads-ups: the context section", () => {
  it("lists the texts newest first under the lead line; null when empty; newlines folded; capped near 3 KB", () => {
    expect(knownHeadsUpsSection([])).toBeNull();
    expect(knownHeadsUpsSection(["  "])).toBeNull();
    expect(knownHeadsUpsSection(["Newest.", "Older\nwith a newline."])).toBe(`${KNOWN_HEADS_UPS_LEAD}\n- Newest.\n- Older with a newline.`);
    expect(KNOWN_HEADS_UPS_LEAD).toBe("The user already knows (do not raise these again as heads-ups):");
    const many = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(290)}`);
    const s = knownHeadsUpsSection(many)!;
    const body = s.slice(KNOWN_HEADS_UPS_LEAD.length + 1);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_KNOWN_HEADS_UPS_BYTES);
    expect(s).toContain("- 000 ");
    expect(s).not.toContain("- 199 ");
  });

  describe("in the agent's prompt (Claude)", () => {
    let fx: RuntimeFixture;
    afterEach(() => fx?.cleanup());
    const idle = (id: string, n: number) => until(() => fx.sessions.statusOf(id).status === "idle" && fx.store.getSession(id)!.turnCount >= n, 4000, `turn ${n}`);
    const promptOf = (): string => {
      const p = fx.sdk.last.options.systemPrompt;
      return typeof p === "string" ? p : String((p as { append?: string }).append ?? "");
    };

    it("code, chat and incognito chat: after the user's instructions, before the memories; a change recycles an idle process", async () => {
      const known = { list: ["The server has 8 GB of memory."] };
      fx = runtimeFixture({ instructions: () => "Be terse.", knownHeadsUps: () => known.list });
      const code = fx.newSession("code");
      await fx.sessions.send(code, msgBody("hi"));
      await idle(code, 1);
      const text = promptOf();
      const section = `${KNOWN_HEADS_UPS_LEAD}\n- The server has 8 GB of memory.`;
      expect(text).toContain(section);
      expect(text.indexOf(`${USER_INSTRUCTIONS_HEADING}\nBe terse.`)).toBeLessThan(text.indexOf(section));

      const chat = fx.newSession("chat");
      await fx.sessions.send(chat, msgBody("hi"));
      await idle(chat, 1);
      expect(promptOf()).toContain(section);

      fx.store.ensureUser("alice");
      const inc = fx.sessions.create({ user: "alice", kind: "chat", cwd: ".chat", model: "default", permissionMode: "default", effort: null, incognito: true }).id;
      await fx.sessions.send(inc, msgBody("hi"));
      await idle(inc, 1);
      expect(promptOf()).toContain(section);

      // Unchanged: same process; changed: the idle process is recycled and the new one lists the new entry first.
      const before = fx.sdk.queries.length;
      await fx.sessions.send(code, msgBody("two"));
      await idle(code, 2);
      expect(fx.sdk.queries.length).toBe(before);
      known.list = ["Deleting the cache slows the next build.", ...known.list];
      await fx.sessions.send(code, msgBody("three"));
      await idle(code, 3);
      expect(fx.sdk.queries.length).toBe(before + 1);
      expect(promptOf()).toContain(`${KNOWN_HEADS_UPS_LEAD}\n- Deleting the cache slows the next build.\n- The server has 8 GB of memory.`);
    });

    it("no section when the list is empty", async () => {
      fx = runtimeFixture({ knownHeadsUps: () => [] });
      const id = fx.newSession("chat");
      await fx.sessions.send(id, msgBody("hi"));
      await idle(id, 1);
      expect(promptOf()).not.toContain(KNOWN_HEADS_UPS_LEAD);
    });
  });
});

describe("known heads-ups: routes", () => {
  let f: HubFixture;
  beforeAll(async () => {
    f = await hubFixture();
  });
  afterAll(async () => {
    await f.close();
  });
  const url = "/api/me/heads-up/known";

  it("GET / POST / DELETE ?id= for the caller's own list; POST trims and dedupes; bad input refused", async () => {
    const A = f.as("alice");
    expect(KnownHeadsUpsResponse.parse((await f.app.inject({ url, headers: A })).json())).toEqual({ known: [] });
    expect((await f.app.inject({ url })).statusCode).toBe(401);

    const r1 = await f.app.inject({ method: "POST", url, headers: A, payload: { text: "  Pushing to main deploys.  " } });
    expect(r1.statusCode).toBe(201);
    const k1 = KnownHeadsUp.parse(r1.json());
    expect(k1.text).toBe("Pushing to main deploys.");
    const r2 = await f.app.inject({ method: "POST", url, headers: A, payload: { text: "pushing to MAIN deploys." } });
    expect(KnownHeadsUp.parse(r2.json()).id).toBe(k1.id);
    await f.app.inject({ method: "POST", url, headers: A, payload: { text: "The server sleeps at night." } });
    const list = KnownHeadsUpsResponse.parse((await f.app.inject({ url, headers: A })).json()).known;
    expect(list.map((k) => k.text)).toEqual(["The server sleeps at night.", "Pushing to main deploys."]);

    for (const payload of [{}, { text: "" }, { text: "   " }, { text: "x".repeat(301) }, { text: 5 }]) {
      expect((await f.app.inject({ method: "POST", url, headers: A, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }

    // Own entries only: bob sees his own (empty) list and cannot delete alice's entry.
    const B = f.as("bob");
    expect(KnownHeadsUpsResponse.parse((await f.app.inject({ url, headers: B })).json()).known).toEqual([]);
    expect((await f.app.inject({ method: "DELETE", url: `${url}?id=${k1.id}`, headers: B })).statusCode).toBe(404);

    expect((await f.app.inject({ method: "DELETE", url, headers: A })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "DELETE", url: `${url}?id=${k1.id}`, headers: A })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "DELETE", url: `${url}?id=${k1.id}`, headers: A })).statusCode).toBe(404);
    expect(KnownHeadsUpsResponse.parse((await f.app.inject({ url, headers: A })).json()).known.map((k) => k.text)).toEqual(["The server sleeps at night."]);
  });

  it("the list reaches the agent's context through the real hub", async () => {
    const A = f.as("dave");
    await f.app.inject({ method: "POST", url, headers: A, payload: { text: "Rebuilding takes ten minutes." } });
    const s = await f.app.inject({ method: "POST", url: "/api/sessions", headers: A, payload: { kind: "chat" } });
    const id = (s.json() as { id: string }).id;
    expect((await f.app.inject({ method: "POST", url: `/api/sessions/${id}/messages`, headers: A, payload: { uuid: randomUUID(), text: "hi" } })).statusCode).toBe(200);
    await until(() => f.sdk.queries.length > 0 && f.hub.store.getSession(id)!.turnCount >= 1, 5000, "turn");
    expect(String(f.sdk.last.options.systemPrompt)).toContain(`${KNOWN_HEADS_UPS_LEAD}\n- Rebuilding takes ten minutes.`);
  });
});

describe("snapshot: rewound seq ranges", () => {
  let fx: RuntimeFixture;
  afterEach(() => fx?.cleanup());
  const turnEnd = (id: string, n: number) => until(() => fx.store.getSession(id)!.turnCount >= n && fx.sessions.statusOf(id).status === "idle", 4000, `turn ${n}`);
  const lastSeq = (id: string) => fx.store.getSession(id)!.lastSeq;

  it("absent before any rewind; one range after one rewind; two ranges after a second, separate rewind", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    const a = msgBody("one");
    await fx.sessions.send(id, a);
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    expect(fx.sessions.snapshot(id).rewound).toBeUndefined();

    const bSeq = fx.store.getMessageByUuid(id, b.uuid)!.seq;
    const end1 = lastSeq(id);
    await fx.sessions.rewind(id, { messageUuid: b.uuid });
    expect(SessionSnapshot.parse(fx.sessions.snapshot(id)).rewound).toEqual([[bSeq, end1]]);

    // A kept message after the first range, then a second rewind further on: two separate ranges.
    const c = msgBody("three");
    await fx.sessions.send(id, c);
    await turnEnd(id, 3);
    const d = msgBody("four");
    await fx.sessions.send(id, d);
    await turnEnd(id, 4);
    const dSeq = fx.store.getMessageByUuid(id, d.uuid)!.seq;
    const end2 = lastSeq(id);
    await fx.sessions.rewind(id, { messageUuid: d.uuid });
    expect(SessionSnapshot.parse(fx.sessions.snapshot(id)).rewound).toEqual([
      [bSeq, end1],
      [dSeq, end2],
    ]);
  });

  it("adjacent rewinds merge into one range", async () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    await fx.sessions.send(id, msgBody("one"));
    await turnEnd(id, 1);
    const b = msgBody("two");
    await fx.sessions.send(id, b);
    await turnEnd(id, 2);
    const bSeq = fx.store.getMessageByUuid(id, b.uuid)!.seq;
    await fx.sessions.rewind(id, { messageUuid: b.uuid });
    // The very next message is rewound too: nothing kept between the two runs.
    const c = msgBody("three");
    await fx.sessions.send(id, c);
    await turnEnd(id, 3);
    await fx.sessions.rewind(id, { messageUuid: c.uuid });
    expect(fx.sessions.snapshot(id).rewound).toEqual([[bSeq, lastSeq(id)]]);
  });

  it("Store.rewoundRanges keeps the newest `limit` ranges, oldest first", () => {
    fx = runtimeFixture();
    const id = fx.newSession("code");
    // kept, rewound, kept, rewound, ... (seq 1..8): ranges [2,2], [4,4], [6,6], [8,8]
    for (let i = 0; i < 8; i++) fx.store.appendMessage(id, { uuid: `m${i}`, kind: "user", payload: { type: "user" } });
    for (const seq of [2, 4, 6, 8]) fx.store.db.prepare("UPDATE messages SET rewound = 1 WHERE session_id = ? AND seq = ?").run(id, seq);
    expect(fx.store.rewoundRanges(id)).toEqual([
      [2, 2],
      [4, 4],
      [6, 6],
      [8, 8],
    ]);
    expect(fx.store.rewoundRanges(id, 2)).toEqual([
      [6, 6],
      [8, 8],
    ]);
  });
});
