/** Sessions, messages, rewind/fork/pins, settings, stop/close, models and commands. */
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  CommandsQuery,
  CreateSessionBody,
  ForkBody,
  MessagesQuery,
  PatchSessionBody,
  RewindBody,
  SendMessageBody,
  SessionSettings,
  SessionsQuery,
} from "@agent-workstation/protocol";
import { ownedSession, parse, requireUser } from "../auth.js";
import { storedMessageJson } from "../db/store.js";
import { resolveInRoot } from "../files/paths.js";
import type { Hub } from "../hub.js";
import { PROJECTS_DIR } from "../projects/service.js";
import { presendCheck } from "../sessions/gate.js";
import { FALLBACK_MODELS } from "../sessions/catalog.js";
import { annotateModels } from "../sessions/models.js";
import { badRequest, HttpError, notFound } from "../util/errors.js";
import { isUuid } from "../util/ids.js";

const OUTPUTS_LIMIT = 200;

const idParam =(params: unknown): string => {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || !isUuid(id)) throw notFound("no such session");
  return id;
};

export function registerSessionRoutes(app: FastifyInstance, hub: Hub): void {
  /** Newest first; incognito sessions are never listed (GET /api/sessions/:id still serves them to their creator). */
  app.get("/api/sessions", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(SessionsQuery, req.query, "query");
    return hub.store.listSessions(u.name, q.kind).map((s) => hub.sessions.toProtocol(s));
  });

  app.post("/api/sessions", async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(CreateSessionBody, req.body ?? {}, "body");
    if (body.incognito && body.kind !== "chat") throw badRequest("invalid_request", "only chat sessions can be incognito");
    let cwd = ".chat";
    if (body.kind === "code") {
      const r = await resolveInRoot(hub.users.root(u.name), body.cwd ?? "", { allowRoot: true });
      if (!r.exists || !(await stat(r.abs)).isDirectory()) throw badRequest("invalid_cwd", `cwd "${r.rel}" is not an existing directory in your workspace`);
      cwd = r.rel;
    }
    // Omitted model / effort → the user's own defaults, else the server default (opus / high out of the box).
    const defaults = hub.users.newSessionDefaults(u.row);
    const model = body.model ?? defaults.model;
    const effort = body.effort !== undefined ? body.effort : defaults.effort;
    if (!hub.users.modelAllowed(u.row, model)) throw new HttpError(403, "model_not_allowed", `model ${model} is not allowed for ${u.name}`);
    hub.billing.assertAvailable();
    const row = hub.sessions.create({
      user: u.name,
      kind: body.kind,
      title: body.title,
      cwd,
      model,
      permissionMode: body.permissionMode ?? "default",
      effort,
      incognito: body.incognito === true,
    });
    const session = hub.sessions.toProtocol(row);
    hub.ws.toUser(u.name, { type: "session_updated", session });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions/:id", async (req) => {
    const u = requireUser(hub, req);
    return hub.sessions.toProtocol(ownedSession(hub, u.name, idParam(req.params)));
  });

  app.patch("/api/sessions/:id", async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const body = parse(PatchSessionBody, req.body ?? {}, "body");
    if (body.notify !== undefined) hub.sessions.setNotify(s.id, body.notify);
    return body.title !== undefined ? hub.sessions.rename(s.id, body.title) : hub.sessions.toProtocol(hub.store.getSession(s.id)!);
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    await hub.sessions.delete(s.id);
    return reply.code(204).send();
  });

  /** Files the session's agent wrote (one entry per path, newest touch first, at most 200); `missing` = gone from the user's root. */
  app.get("/api/sessions/:id/outputs", async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const root = hub.users.root(u.name);
    const touches = hub.store
      .sessionTouches(s.id, OUTPUTS_LIMIT)
      .flatMap((t) => {
        if (t.projectId && !t.projectName) return []; // project deleted
        return [{ ...t, path: t.projectName ? `${PROJECTS_DIR}/${t.projectName}/${t.path}` : t.path }];
      });
    const outputs = await Promise.all(
      touches.map(async (t) => {
        const missing = await resolveInRoot(root, t.path).then(
          (r) => !r.exists,
          () => true,
        );
        return { path: t.path, tool: t.tool, turn: t.turn, at: t.at, missing };
      }),
    );
    return { outputs };
  });

  app.get("/api/sessions/:id/messages", async (req, reply) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const q = parse(MessagesQuery, req.query, "query");
    const rows = hub.store.listMessages(s.id, q.after, q.limit);
    return reply.type("application/json; charset=utf-8").send(`[${rows.map(storedMessageJson).join(",")}]`);
  });

  app.post("/api/sessions/:id/messages", { bodyLimit: 48 * 1024 * 1024 }, async (req, reply) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const body = parse(SendMessageBody, req.body ?? {}, "body");
    presendCheck(hub, u);
    if (!hub.users.modelAllowed(hub.users.get(u.name) ?? u.row, s.model)) throw new HttpError(403, "model_not_allowed", `model ${s.model} is not allowed for ${u.name}`);
    const r = await hub.sessions.send(s.id, body);
    return reply.code(r.state === "queued" ? 202 : 200).send(r);
  });

  /**
   * Rewind to just before one of the session's user messages (RewindBody / RewindResponse). With `resend`, the message
   * goes out again through the normal send path: the same checks as POST messages run first.
   */
  app.post("/api/sessions/:id/rewind", { bodyLimit: 1024 * 1024 }, async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const body = parse(RewindBody, req.body ?? {}, "body");
    if (body.resend) {
      presendCheck(hub, u);
      if (!hub.users.modelAllowed(hub.users.get(u.name) ?? u.row, s.model)) throw new HttpError(403, "model_not_allowed", `model ${s.model} is not allowed for ${u.name}`);
    }
    const r = await hub.sessions.rewind(s.id, body);
    return { draft: r.draft, filesRestored: r.filesRestored };
  });

  /** A new session with this one's conversation up to a message (ForkBody → 201 ForkResponse); the source is not touched. */
  app.post("/api/sessions/:id/fork", async (req, reply) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const body = parse(ForkBody, req.body ?? {}, "body");
    if (!hub.users.modelAllowed(hub.users.get(u.name) ?? u.row, s.model)) throw new HttpError(403, "model_not_allowed", `model ${s.model} is not allowed for ${u.name}`);
    const { row, draft } = hub.sessions.fork(s.id, body.messageUuid);
    const session = hub.sessions.toProtocol(row);
    hub.ws.toUser(u.name, { type: "session_updated", session });
    return reply.code(201).send({ session, draft });
  });

  /** Pin / unpin a message of the session (`Session.pinnedMessages`; at most 200, the oldest go first). */
  for (const method of ["PUT", "DELETE"] as const) {
    app.route<{ Params: { id: string; messageUuid: string } }>({
      method,
      url: "/api/sessions/:id/pins/:messageUuid",
      handler: async (req) => {
        const u = requireUser(hub, req);
        const s = ownedSession(hub, u.name, idParam(req.params));
        return hub.sessions.setPin(s.id, req.params.messageUuid, method === "PUT");
      },
    });
  }

  app.patch("/api/sessions/:id/settings", async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    const body = parse(SessionSettings, req.body ?? {}, "body");
    if (body.model !== undefined && !hub.users.modelAllowed(u.row, body.model)) throw new HttpError(403, "model_not_allowed", `model ${body.model} is not allowed for ${u.name}`);
    return hub.sessions.updateSettings(s.id, body);
  });

  app.post("/api/sessions/:id/stop", async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    return hub.sessions.stop(s.id);
  });

  app.post<{ Params: { id: string; taskId: string } }>("/api/sessions/:id/tasks/:taskId/stop", async (req, reply) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    if (!(await hub.sessions.stopTask(s.id, req.params.taskId))) throw notFound();
    return reply.code(204).send();
  });

  app.post("/api/sessions/:id/close", async (req) => {
    const u = requireUser(hub, req);
    const s = ownedSession(hub, u.name, idParam(req.params));
    return hub.sessions.close(s.id);
  });

  /** The Claude models (from the catalog, else the built-in aliases), each with family / legacy; the user's default and the server default are never legacy. */
  app.get("/api/models", async (req) => {
    const u = requireUser(hub, req);
    const models = hub.catalog.getModels() ?? [...FALLBACK_MODELS];
    const annotated = annotateModels(models, [u.row.defaultModel, hub.settings.get().defaultModel]);
    const allow = u.row.modelAllowlist;
    return allow ? annotated.filter((m) => allow.includes(m.value)) : annotated;
  });

  /**
   * With a sessionId: that session's own list (from its live process's supportedCommands(),
   * skills included). Without one (or before the session's first spawn): the global catalog
   * plus the caller's user and global skills read from disk (code sessions will load them).
   */
  app.get("/api/commands", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(CommandsQuery, req.query, "query");
    const session = q.sessionId ? ownedSession(hub, u.name, q.sessionId) : null;
    const own = q.sessionId ? hub.catalog.sessionCommands(q.sessionId) : null;
    if (own) return own;
    const base = hub.catalog.getCommands() ?? [];
    if (session?.kind === "chat") return base;
    const names = new Set(base.map((c) => c.name));
    return [...base, ...(await hub.skills.commandInfos(u.name, !hub.config.sessions.projectSettings)).filter((c) => !names.has(c.name))];
  });
}
