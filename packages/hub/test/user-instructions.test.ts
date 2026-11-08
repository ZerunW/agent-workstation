/** Per-user instructions: the users.instructions column, PATCH /api/me/preferences and where the user is returned. */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ErrorBody, MAX_USER_INSTRUCTIONS, Me, User } from "@agent-workstation/protocol";
import { Store } from "../src/db/store.js";
import { hubFixture, tempDir, type HubFixture } from "./helpers.js";

describe("migration", () => {
  it("adds the column to an existing database and keeps its users", () => {
    const t = tempDir();
    try {
      const file = join(t.dir, "hub.db");
      let store = new Store(file);
      store.ensureUser("alice");
      store.close();
      const raw = new Database(file);
      raw.exec("ALTER TABLE users DROP COLUMN instructions");
      raw.close();

      store = new Store(file);
      try {
        expect(store.getUser("alice")?.instructions).toBe("");
        expect(store.userInstructions("alice")).toBe("");
        store.updateUser("alice", { instructions: "Be terse." });
        expect(store.listUsers().map((u) => [u.name, u.instructions])).toEqual([["alice", "Be terse."]]);
      } finally {
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("PATCH /api/me/preferences instructions", () => {
  let f: HubFixture;
  beforeAll(async () => {
    f = await hubFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const patch = (user: string, payload: unknown) => f.app.inject({ method: "PATCH", url: "/api/me/preferences", headers: f.as(user), payload: payload as object });
  const me = async (user: string) => Me.parse((await f.app.inject({ url: "/api/me", headers: f.as(user) })).json());

  it("is empty by default", async () => {
    expect((await me("alice")).user.instructions).toBe("");
  });

  it("stores, returns on /api/me and the admin list, and clears", async () => {
    const r = await patch("alice", { instructions: "Answer in French.\n- be brief" });
    expect(r.statusCode).toBe(200);
    expect(User.parse(r.json()).instructions).toBe("Answer in French.\n- be brief");
    expect((await me("alice")).user.instructions).toBe("Answer in French.\n- be brief");
    expect((await me("bob")).user.instructions).toBe("");

    // other preferences leave it alone
    await patch("alice", { memoryEnabled: false });
    expect((await me("alice")).user.instructions).toBe("Answer in French.\n- be brief");

    const list = (await f.app.inject({ url: "/api/users", headers: f.as("admin") })).json() as User[];
    expect(list.find((u) => u.name === "alice")?.instructions).toBe("Answer in French.\n- be brief");

    const cleared = await patch("alice", { instructions: "" });
    expect(User.parse(cleared.json()).instructions).toBe("");
    expect((await me("alice")).user.instructions).toBe("");
  });

  it("drops trailing whitespace and rejects text over the limit", async () => {
    const trimmed = await patch("alice", { instructions: "keep  \n\n  " });
    expect(User.parse(trimmed.json()).instructions).toBe("keep");

    const max = "x".repeat(MAX_USER_INSTRUCTIONS);
    const ok = await patch("alice", { instructions: `${max}   \n` });
    expect(ok.statusCode).toBe(200);
    expect(User.parse(ok.json()).instructions).toBe(max);

    const tooLong = await patch("alice", { instructions: max + "y" });
    expect(tooLong.statusCode).toBe(400);
    expect(ErrorBody.parse(tooLong.json()).code).toBe("invalid_request");
    expect((await me("alice")).user.instructions).toBe(max);

    expect((await patch("alice", { instructions: 5 })).statusCode).toBe(400);
  });
});
