/** Admin-only DELETE /api/users/:name. */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorBody, ServerEvent, UsersResponse } from "@agent-workstation/protocol";
import { WS_UPGRADE, hubFixture, until, type HubFixture } from "./helpers.js";

let f: HubFixture;
beforeAll(async () => {
  f = await hubFixture();
});
afterAll(async () => {
  await f.close();
});

const count = (sql: string, ...args: unknown[]) => (f.hub.store.db.prepare(sql).get(...args) as { n: number }).n;

describe("DELETE /api/users/:name", () => {
  it("guards: admin only, reserved names, unknown users", async () => {
    await f.app.inject({ method: "POST", url: "/api/users", payload: { name: "e2e-guard" } });
    const notAdmin = await f.app.inject({ method: "DELETE", url: "/api/users/e2e-guard", headers: f.as("bob") });
    expect(notAdmin.statusCode).toBe(403);
    expect(ErrorBody.parse(notAdmin.json()).code).toBe("admin_required");
    for (const name of ["_system", "_global", "admin"]) {
      const r = await f.app.inject({ method: "DELETE", url: `/api/users/${name}`, headers: f.as("admin") });
      expect(r.statusCode).toBe(403);
      expect(ErrorBody.parse(r.json()).code).toBe("reserved_user");
    }
    expect((await f.app.inject({ method: "DELETE", url: "/api/users/nobody-here", headers: f.as("admin") })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "DELETE", url: "/api/users/..", headers: f.as("admin") })).statusCode).toBe(404);
  });

  it("refuses while a project has pending work, then removes everything with force=true", async () => {
    const U = f.as("e2e-full");
    // a chat turn (session, messages, turns), a project with an undownloaded file, a terminal, a rule
    const s = (await f.app.inject({ method: "POST", url: "/api/sessions", headers: U, payload: { kind: "chat" } })).json() as { id: string };
    await f.app.inject({ method: "POST", url: `/api/sessions/${s.id}/messages`, headers: U, payload: { uuid: randomUUID(), text: "hi" } });
    await until(() => f.hub.store.getSession(s.id)!.turnCount >= 1 && f.hub.sessions.statusOf(s.id).status === "idle", 3000, "turn");
    const p = (await f.app.inject({ method: "POST", url: "/api/projects", headers: U, payload: { name: "proj" } })).json() as { id: string };
    writeFileSync(join(f.root, "e2e-full", "projects", "proj", "generated.txt"), "x");
    await f.app.inject({ method: "PATCH", url: "/api/users/e2e-full", headers: f.as("admin"), payload: { terminalEnabled: true } });
    const term = await f.app.inject({ method: "POST", url: "/api/terminals", headers: U, payload: {} });
    expect(term.statusCode).toBe(201);
    expect(f.hub.store.listTerminals("e2e-full")).toHaveLength(1);
    f.hub.store.insertRule({ user: "e2e-full", sessionId: null, toolName: "Bash", ruleContent: "ls:*" });

    const sock = await f.app.injectWS("/ws", WS_UPGRADE);
    const events: ServerEvent[] = [];
    let closedCode: number | null = null;
    sock.on("message", (d) => events.push(ServerEvent.parse(JSON.parse(String(d)))));
    sock.on("close", (code) => (closedCode = code));
    sock.send(JSON.stringify({ type: "hello", user: "e2e-full", protocolVersion: 1 }));
    await until(() => events.some((e) => e.type === "welcome"), 2000, "welcome");

    const refused = await f.app.inject({ method: "DELETE", url: "/api/users/e2e-full", headers: f.as("admin") });
    expect(refused.statusCode).toBe(409);
    const err = ErrorBody.parse(refused.json());
    expect(err.code).toBe("user_not_empty");
    expect(err.details).toEqual({ projects: [{ id: p.id, name: "proj", pendingFiles: 1, undownloadedFiles: 1 }] });
    expect(existsSync(join(f.root, "e2e-full"))).toBe(true);
    expect(f.hub.store.getUser("e2e-full")).not.toBeNull();

    const ok = await f.app.inject({ method: "DELETE", url: "/api/users/e2e-full?force=true", headers: f.as("admin") });
    expect(ok.statusCode).toBe(204);
    expect(existsSync(join(f.root, "e2e-full"))).toBe(false);
    expect(f.hub.store.getUser("e2e-full")).toBeNull();
    for (const t of ["sessions", "turns", "permissions_rules", "file_touches", "terminals", "projects", "uploads"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${t} WHERE user = ?`, "e2e-full")).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", s.id)).toBe(0);
    expect(await f.hub.terminals.list("e2e-full")).toEqual([]);
    expect(events.some((e) => e.type === "notice" && e.code === "user_deleted")).toBe(true);
    await until(() => closedCode !== null, 2000, "socket closed");
    expect(closedCode).toBe(4003);
    const users = UsersResponse.parse((await f.app.inject({ url: "/api/users", headers: f.as("admin") })).json());
    expect(users.map((u) => u.name)).not.toContain("e2e-full");
    expect(f.hub.watchers.isWatching("e2e-full")).toBe(false);

    // the name can be used again afterwards (fresh workspace)
    expect((await f.app.inject({ url: "/api/me", headers: f.as("e2e-full") })).statusCode).toBe(200);
    expect(existsSync(join(f.root, "e2e-full", "inbox"))).toBe(true);
  });

  it("deletes a user without pending work without force", async () => {
    await f.app.inject({ method: "POST", url: "/api/users", payload: { name: "e2e-light" } });
    await f.app.inject({ method: "POST", url: "/api/projects", headers: f.as("e2e-light"), payload: { name: "clean" } });
    const r = await f.app.inject({ method: "DELETE", url: "/api/users/e2e-light", headers: f.as("admin") });
    expect(r.statusCode).toBe(204);
    expect(existsSync(join(f.root, "e2e-light"))).toBe(false);
    expect(f.hub.store.listProjectRows("e2e-light")).toEqual([]);
  });
});
