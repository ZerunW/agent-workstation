/** Fastify application: plugins, routes, error mapping, static web UI. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import { registerIdentityHook } from "./auth.js";
import { isApiPath, normalizedPath, registerHostGuard, registerOriginGuard } from "./origin.js";
import type { Hub } from "./hub.js";
import { registerProjectRoutes } from "./projects/index.js";
import { toHttpError } from "./projects/errors.js";
import { registerSkillRoutes } from "./skills/routes.js";
import { registerAppReleaseRoutes } from "./routes/appRelease.js";
import { registerBrowserRoutes } from "./routes/browser.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerReadmeRoutes } from "./routes/readme.js";
import { registerVisualCdnRoutes } from "./routes/visualCdn.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { appCspForFile, COMMON_SECURITY_HEADERS } from "./securityHeaders.js";
import { HttpError } from "./util/errors.js";

export interface AppOptions {
  /** A pino logger for Fastify; omit (tests) to disable Fastify's own logging. */
  logger?: FastifyBaseLogger;
}

export async function buildApp(hub: Hub, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    bodyLimit: 2 * 1024 * 1024,
  });

  app.setErrorHandler((rawErr: FastifyError | HttpError, req, reply) => {
    const err = toHttpError(rawErr) as FastifyError | HttpError;
    if (err instanceof HttpError) {
      if (err.status === 500) hub.log.error({ err: err.message, code: err.code, url: req.url, method: req.method }, "request failed");
      return reply.code(err.status).send({ error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status < 500) {
      return reply.code(status).send({ error: err.message, code: err.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "too_large" : err.code ? String(err.code).toLowerCase() : "bad_request" });
    }
    hub.log.error({ err: err.message, stack: err.stack, url: req.url, method: req.method }, "request failed");
    return reply.code(500).send({ error: "internal error", code: "internal" });
  });

  // nosniff + Referrer-Policy on every response (the app CSP is added to the HTML pages by the static handler).
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(COMMON_SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });

  // Per-request logs only at warn+ (requests themselves are not logged).
  app.addHook("onRoute", (route) => {
    route.logLevel ??= "warn";
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  // A Host that is not this server's (DNS rebinding) is refused first, then cross-site requests (other web sites in a
  // tailnet device's browser), upgrades included.
  registerHostGuard(app, hub.origins);
  registerOriginGuard(app, hub.origins);

  // Who is calling (Tailscale login / legacy header identity); 403 for refused callers. Before every route.
  registerIdentityHook(app, hub);

  hub.ws.register(app);
  registerSystemRoutes(app, hub);
  registerAppReleaseRoutes(app, hub);
  registerSessionRoutes(app, hub);
  registerFileRoutes(app, hub);
  registerUsageRoutes(app, hub);
  registerTerminalRoutes(app, hub);
  registerProjectRoutes(app, hub);
  registerSkillRoutes(app, hub);
  registerSearchRoutes(app, hub);
  registerBrowserRoutes(app, hub);
  registerReadmeRoutes(app, hub);
  registerVisualCdnRoutes(app, { cacheDir: join(hub.config.paths.dataDir, "visual-cdn") });

  const webDist = hub.config.paths.webDist;
  const hasWeb = existsSync(join(webDist, "index.html"));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: true,
      index: ["index.html"],
      // The web app's pages (index.html, embed.html, and index.html as the SPA fallback) get the strict CSP.
      setHeaders: (reply, path) => {
        if (path.endsWith(".html")) reply.header("Content-Security-Policy", appCspForFile(path));
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url;
    // /internal/* lives on the hub's loopback listener only (internalServer.ts): a plain 404 here, never the SPA page.
    // Decided on the decoded, normalized path: `/%61pi/...` is an API path too.
    const path = normalizedPath(url);
    const isApi = path === null || isApiPath(path) || url.startsWith("/ws");
    if (!isApi && hasWeb && (req.method === "GET" || req.method === "HEAD")) {
      // SPA fallback: client-side routes (/usage, /admin, ...) get index.html.
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: `not found: ${req.method} ${url.split("?")[0]}`, code: "not_found" });
  });

  return app;
}
