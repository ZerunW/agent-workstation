/** /api/skills — user skills (own scope) and global skills (admin writes). */
import type { FastifyInstance } from "fastify";
import { SkillBody, SkillQuery } from "@agent-workstation/protocol";
import { parse, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { errorMessage, notFound } from "../util/errors.js";
import { SKILL_NAME_RE } from "./service.js";

const nameOf = (params: unknown): string => {
  const n = (params as { name?: unknown }).name;
  if (typeof n !== "string" || !SKILL_NAME_RE.test(n)) throw notFound("no such skill");
  return n;
};

export function registerSkillRoutes(app: FastifyInstance, hub: Hub): void {
  /** Running code sessions rescan their skill directories (non-blocking for the request). */
  const reload = (user: string | null) => {
    void hub.sessions.reloadSkills(user).catch((err: unknown) => hub.log.warn({ err: errorMessage(err) }, "skill reload failed"));
  };

  app.get("/api/skills", async (req) => {
    const u = requireUser(hub, req);
    return hub.skills.list(u.name);
  });

  app.get("/api/skills/:name", async (req) => {
    const u = requireUser(hub, req);
    const q = parse(SkillQuery, req.query ?? {}, "query");
    return hub.skills.get(u.name, nameOf(req.params), q.scope);
  });

  app.post("/api/skills", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(SkillBody, req.body ?? {}, "body");
    const skill = await hub.skills.create(u.name, body, u.isAdmin);
    reload(body.scope === "global" ? null : u.name);
    return reply.code(201).send(skill);
  });

  app.put("/api/skills/:name", { bodyLimit: 1024 * 1024 }, async (req) => {
    const u = requireUser(hub, req);
    const body = parse(SkillBody, req.body ?? {}, "body");
    const skill = await hub.skills.update(u.name, nameOf(req.params), body, u.isAdmin);
    reload(body.scope === "global" ? null : u.name);
    return skill;
  });

  app.delete("/api/skills/:name", async (req, reply) => {
    const u = requireUser(hub, req);
    const q = parse(SkillQuery, req.query ?? {}, "query");
    const scope = q.scope ?? "user";
    await hub.skills.remove(u.name, nameOf(req.params), scope, u.isAdmin);
    reload(scope === "global" ? null : u.name);
    return reply.code(204).send();
  });
}
