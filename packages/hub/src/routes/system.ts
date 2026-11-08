/** Health, identity (`/api/me`) and user management. */
import { hostname } from "node:os";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateUserBody,
  DeleteUserQuery,
  KnownHeadsUpBody,
  MemoryBody,
  PatchUserBody,
  PROTOCOL_VERSION,
  UserPreferencesBody,
  type HubHealth,
  type KnownHeadsUp,
  type KnownHeadsUpsResponse,
  type Me,
  type WhoAmIResponse,
  type MemoriesResponse,
} from "@agent-workstation/protocol";
import { callerOf, parse, requireAdmin, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { deleteUser } from "../userDelete.js";
import { notFound } from "../util/errors.js";

/** Known heads-ups kept per user (the oldest dropped beyond). */
export const MAX_KNOWN_HEADS_UPS = 200;
const KnownHeadsUpQuery = z.object({ id: z.string().min(1) });

export function registerSystemRoutes(app: FastifyInstance, hub: Hub): void {
  app.get("/healthz", async (_req, reply) => reply.type("text/plain").send("ok"));

  app.get("/api/health", async (): Promise<HubHealth> => ({
    ok: true,
    version: hub.version,
    protocolVersion: PROTOCOL_VERSION,
    uptimeS: Math.round((Date.now() - hub.startedAt) / 1000),
    serverTime: new Date().toISOString(),
    hostname: hostname(),
    agents: hub.agentVersions.current(),
    processes: hub.sessions.processCounts(),
  }));

  app.get("/api/me", async (req): Promise<Me> => {
    const u = requireUser(hub, req);
    return {
      user: hub.users.toProtocol(u.row, u.isAdmin),
      settings: hub.settings.get(),
      disk: hub.disk.level,
      apiAvailable: hub.billing.available(),
      protocolVersion: PROTOCOL_VERSION,
    };
  });

  /**
   * Who the hub thinks is calling, without a username (not an open route: refused callers get their 403 from the
   * identity hook). Only usernames bound to the caller's own login are ever listed.
   */
  app.get("/api/whoami", async (req): Promise<WhoAmIResponse> => {
    const caller = callerOf(req);
    if (caller.kind !== "tailscale") return { tailscale: null, users: [], suggested: null };
    const users = hub.users.usernamesFor(caller);
    return { tailscale: { login: caller.login, node: caller.node }, users, suggested: users[0] ?? null };
  });

  /** Self-service: the model / effort new sessions start with (null = follow the server default). */
  app.patch("/api/me/preferences", async (req) => {
    const u = requireUser(hub, req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    // The limit applies after trailing whitespace is dropped.
    const body = parse(UserPreferencesBody, typeof raw.instructions === "string" ? { ...raw, instructions: raw.instructions.trimEnd() } : raw, "body");
    return hub.users.setPreferences(u.row, body);
  });

  // ---- memory (per user; Claude writes through its remember/forget tools, people through these routes) ----
  app.get("/api/me/memories", async (req): Promise<MemoriesResponse> => {
    const u = requireUser(hub, req);
    return { memories: hub.memories.list(u.row.name) };
  });
  app.post("/api/me/memories", async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(MemoryBody, req.body ?? {}, "body");
    return reply.code(201).send(hub.memories.create(u.row.name, body.text, "user"));
  });
  app.patch<{ Params: { id: string } }>("/api/me/memories/:id", async (req) => {
    const u = requireUser(hub, req);
    const body = parse(MemoryBody, req.body ?? {}, "body");
    return hub.memories.update(u.row.name, req.params.id, body.text);
  });
  app.delete<{ Params: { id: string } }>("/api/me/memories/:id", async (req, reply) => {
    const u = requireUser(hub, req);
    hub.memories.remove(u.row.name, req.params.id);
    return reply.code(204).send();
  });

  // ---- known heads-ups ("Knew this already" on a heads-up card; the agent's context lists them) ----
  app.get("/api/me/heads-up/known", async (req): Promise<z.infer<typeof KnownHeadsUpsResponse>> => {
    const u = requireUser(hub, req);
    return { known: hub.store.listKnownHeadsUps(u.row.name) };
  });
  /** Trimmed; a text already listed (case-insensitively) keeps its id and becomes the newest; max 200, oldest dropped. */
  app.post("/api/me/heads-up/known", async (req, reply): Promise<KnownHeadsUp> => {
    const u = requireUser(hub, req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = parse(KnownHeadsUpBody, typeof raw.text === "string" ? { ...raw, text: raw.text.trim() } : raw, "body");
    return reply.code(201).send(hub.store.addKnownHeadsUp(u.row.name, body.text, new Date().toISOString(), MAX_KNOWN_HEADS_UPS));
  });
  app.delete("/api/me/heads-up/known", async (req, reply) => {
    const u = requireUser(hub, req);
    const q = parse(KnownHeadsUpQuery, req.query ?? {}, "query");
    if (!hub.store.deleteKnownHeadsUp(u.row.name, q.id)) throw notFound("no such known heads-up");
    return reply.code(204).send();
  });

  /** Admin: the full user list. Login screens never enumerate users — a name is typed, not picked. */
  app.get("/api/users", async (req) => {
    requireAdmin(hub, req);
    return hub.users.list();
  });

  /**
   * Public: typing a username creates it if new, returns it if it exists (no passwords; reachability is the network's
   * job). A Tailscale caller binds the name to its login here (403 user_bound when another login owns it).
   */
  app.post("/api/users", async (req, reply) => {
    const body = parse(CreateUserBody, req.body ?? {}, "body");
    const existed = !!hub.users.get(body.name);
    const { row, isAdmin } = hub.users.authorize(body.name, callerOf(req));
    return reply.code(existed ? 200 : 201).send(hub.users.toProtocol(row, isAdmin));
  });

  app.patch("/api/users/:name", async (req) => {
    requireAdmin(hub, req);
    const name = (req.params as { name?: string }).name ?? "";
    if (!hub.users.get(name)) throw notFound("no such user");
    const body = parse(PatchUserBody, req.body ?? {}, "body");
    const user = hub.users.patch(name, body);
    hub.ws.toUser(name, { type: "notice", level: "info", code: "user_updated", message: "Your account settings were changed by the admin.", at: new Date().toISOString() });
    return user;
  });

  /** Admin: delete a user and everything they own (409 user_not_empty unless force=true). */
  app.delete("/api/users/:name", async (req, reply) => {
    const admin = requireAdmin(hub, req);
    const name = (req.params as { name?: string }).name ?? "";
    const q = parse(DeleteUserQuery, req.query ?? {}, "query");
    await deleteUser(hub, name, q.force === true);
    hub.log.info({ admin: admin.name, user: name, force: q.force === true }, "user deleted by admin");
    return reply.code(204).send();
  });
}
