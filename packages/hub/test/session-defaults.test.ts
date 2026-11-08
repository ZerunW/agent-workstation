/**
 * Default model / effort for new sessions: client body → the user's own preference (PATCH /api/me/preferences) →
 * the server default (admin settings, seeded from config: opus / high).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorBody, Me, Session, User } from "@agent-workstation/protocol";
import { hubFixture, type HubFixture } from "./helpers.js";

let f: HubFixture;
beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

const create = async (user: string, body: Record<string, unknown> = {}) => {
  const r = await f.app.inject({ method: "POST", url: "/api/sessions", headers: f.as(user), payload: { kind: "chat", ...body } });
  expect(r.statusCode).toBe(201);
  return Session.parse(r.json());
};

describe("new-session defaults", () => {
  it("server default is opus / high and is visible in /api/me", async () => {
    const me = Me.parse((await f.app.inject({ url: "/api/me", headers: f.as("alice") })).json());
    expect(me.settings.defaultModel).toBe("opus");
    expect(me.settings.defaultEffort).toBe("high");
    expect(me.user.defaultModel).toBeNull();
    expect(me.user.defaultEffort).toBeNull();

    const s = await create("alice");
    expect(s.model).toBe("opus");
    expect(s.effort).toBe("high");
  });

  it("an explicit body wins over every default", async () => {
    const s = await create("alice", { model: "haiku", effort: null });
    expect(s.model).toBe("haiku");
    expect(s.effort).toBeNull();
  });

  it("the user's own preference wins over the server default and follows the name", async () => {
    const r = await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("alice"), payload: { defaultModel: "haiku", defaultEffort: "medium" } });
    expect(r.statusCode).toBe(200);
    const u = User.parse(r.json());
    expect(u.defaultModel).toBe("haiku");
    expect(u.defaultEffort).toBe("medium");

    const s = await create("alice");
    expect(s.model).toBe("haiku");
    expect(s.effort).toBe("medium");

    // another user is untouched
    const other = await create("bob");
    expect(other.model).toBe("opus");
    expect(other.effort).toBe("high");

    // omitted fields are kept; null goes back to the server default
    const r2 = await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("alice"), payload: { defaultEffort: null } });
    const u2 = User.parse(r2.json());
    expect(u2.defaultModel).toBe("haiku");
    expect(u2.defaultEffort).toBeNull();
    const s2 = await create("alice");
    expect(s2.model).toBe("haiku");
    expect(s2.effort).toBe("high");

    await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("alice"), payload: { defaultModel: null } });
    expect((await create("alice")).model).toBe("opus");
  });

  it("validates the body and respects the admin allowlist", async () => {
    const bad = await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("alice"), payload: { defaultEffort: "turbo" } });
    expect(bad.statusCode).toBe(400);
    expect((await f.app.inject({ method: "PATCH", url: "/api/me/preferences", payload: { defaultModel: "haiku" } })).statusCode).toBe(401);

    // admin restricts carol to haiku: her preference may not point elsewhere, and the server default falls back
    await f.app.inject({ method: "POST", url: "/api/users", payload: { name: "carol" } });
    expect((await f.app.inject({ method: "PATCH", url: "/api/users/carol", headers: f.as("admin"), payload: { modelAllowlist: ["haiku"] } })).statusCode).toBe(200);
    const refused = await f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as("carol"), payload: { defaultModel: "opus" } });
    expect(refused.statusCode).toBe(403);
    expect(ErrorBody.parse(refused.json()).code).toBe("model_not_allowed");
    const s = await create("carol");
    expect(s.model).toBe("haiku");
    expect(s.effort).toBe("high");
  });

  it("admins can move the server default at runtime", async () => {
    const r = await f.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: f.as("admin"), payload: { defaultModel: "haiku", defaultEffort: "low" } });
    expect(r.statusCode).toBe(200);
    const s = await create("bob");
    expect(s.model).toBe("haiku");
    expect(s.effort).toBe("low");
    expect((await f.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: f.as("admin"), payload: { defaultModel: "" } })).statusCode).toBe(400);
    // restore for the other specs
    await f.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: f.as("admin"), payload: { defaultModel: "opus", defaultEffort: "high" } });
  });
});
