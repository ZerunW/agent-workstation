/** Terminals: REST management + `WS /ws/terminal/:id` byte bridge. */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { CreateTerminalBody } from "@agent-workstation/protocol";
import { parse, requireUser } from "../auth.js";
import type { Hub } from "../hub.js";
import { errorMessage, HttpError } from "../util/errors.js";

export function registerTerminalRoutes(app: FastifyInstance, hub: Hub): void {
  app.get("/api/terminals", async (req) => {
    const u = requireUser(hub, req);
    if (!hub.config.terminal.enabled || !u.row.terminalEnabled) return [];
    return hub.terminals.list(u.name);
  });

  app.post("/api/terminals", async (req, reply) => {
    const u = requireUser(hub, req);
    const body = parse(CreateTerminalBody, req.body ?? {}, "body");
    const info = await hub.terminals.create(u.name, u.row.terminalEnabled, body.cwd);
    return reply.code(201).send(info);
  });

  app.delete("/api/terminals/:id", async (req, reply) => {
    const u = requireUser(hub, req);
    await hub.terminals.remove(u.name, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get("/ws/terminal/:id", { websocket: true }, (socket, req) => {
    const ws = socket as WebSocket;
    // Buffer frames that arrive before attach() finished wiring the pty.
    const early: unknown[] = [];
    const onEarly = (d: unknown) => early.push(d);
    ws.on("message", onEarly);
    void (async () => {
      try {
        const u = requireUser(hub, req);
        await hub.terminals.attach(u.name, u.row.terminalEnabled, (req.params as { id: string }).id, ws);
        ws.off("message", onEarly);
        for (const d of early) ws.emit("message", d, false);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "out", data: `\r\n[Agent Workstation] ${errorMessage(err)}\r\n` }));
          ws.send(JSON.stringify({ t: "exit", code: null }));
        }
        ws.close(4000 + Math.min(status, 999), errorMessage(err).slice(0, 120));
      }
    })();
  });
}
