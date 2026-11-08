/** The global notification switch (users.notifications_enabled) and each session's own switch (sessions.notify). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Me, Session } from "@agent-workstation/protocol";
import { hubFixture, type HubFixture } from "./helpers.js";

describe("notification switches", () => {
  let f: HubFixture;
  beforeAll(async () => {
    f = await hubFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const me = async (user: string) => Me.parse((await f.app.inject({ url: "/api/me", headers: f.as(user) })).json());
  const create = async (user: string) =>
    Session.parse((await f.app.inject({ method: "POST", url: "/api/sessions", headers: f.as(user), payload: { kind: "chat" } })).json());
  const patchSession = (user: string, id: string, payload: object) => f.app.inject({ method: "PATCH", url: `/api/sessions/${id}`, headers: f.as(user), payload });

  it("the global switch is on by default and can be turned off and on", async () => {
    expect((await me("nina")).user.notificationsEnabled).toBeUndefined();
    const off = await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("nina"), payload: { notificationsEnabled: false } });
    expect(off.statusCode).toBe(200);
    expect((await me("nina")).user.notificationsEnabled).toBe(false);
    await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("nina"), payload: { notificationsEnabled: true } });
    expect((await me("nina")).user.notificationsEnabled).toBeUndefined();
  });

  it("a session's switch is on by default; PATCH notify turns it off without renaming", async () => {
    const s = await create("omar");
    expect(s.notify).toBeUndefined();
    const res = await patchSession("omar", s.id, { notify: false });
    expect(res.statusCode).toBe(200);
    const after = Session.parse(res.json());
    expect(after.notify).toBe(false);
    expect(after.title).toBe(s.title);
    const again = Session.parse((await f.app.inject({ url: `/api/sessions/${s.id}`, headers: f.as("omar") })).json());
    expect(again.notify).toBe(false);
    expect(Session.parse((await patchSession("omar", s.id, { notify: true })).json()).notify).toBeUndefined();
  });

  it("renaming still works, an empty patch is refused, and nobody else can change the switch", async () => {
    const s = await create("pia");
    expect(Session.parse((await patchSession("pia", s.id, { title: "Renamed" })).json()).title).toBe("Renamed");
    expect((await patchSession("pia", s.id, {})).statusCode).toBe(400);
    expect((await patchSession("quinn", s.id, { notify: false })).statusCode).toBe(404);
  });
});
