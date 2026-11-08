/**
 * Where the hub listens (see the invariants at the top of identity.ts).
 *
 * `[server] listen = "unix"` (production): the public socket (mode 0660, group `proxy_group`) for nginx and the local
 * socket (mode 0600) for the status service. Each socket is bound under a process umask that already gives its final
 * mode, so it is never wider than it should be; the public one is then handed to `proxy_group` (the service account
 * must be a member). A stale socket file from a crash is removed before listening, and both files are removed on
 * shutdown. Every connection is tagged with the listener it came in on; that tag, not any header, is the trust level.
 *
 * `[server] listen = "tcp"` (development): one TCP listener on `host` and `port`.
 */
import { execFile } from "node:child_process";
import { chown, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import type { HubConfig } from "./config.js";
import type { ListenerKind } from "./identity.js";
import type { Logger } from "./util/log.js";

const LISTENER = Symbol("workstation.listener");

type Tagged = Socket & { [LISTENER]?: ListenerKind };

/** The listener a connection came in on; undefined for a connection that was not accepted by this module (tests that inject requests). */
export function listenerOf(socket: Socket | undefined): ListenerKind | undefined {
  return (socket as Tagged | undefined)?.[LISTENER];
}

function tag(server: Server, kind: ListenerKind): void {
  server.on("connection", (s: Socket) => {
    (s as Tagged)[LISTENER] = kind;
  });
}

/** Mode of a socket file bound under `umask`: 0666 minus the umask (the kernel creates sockets with 0777 & ~umask). */
export const PUBLIC_SOCKET_MODE = 0o660;
export const LOCAL_SOCKET_MODE = 0o600;

/** A numeric group id, or the id of a group name (`getent group`). */
export async function resolveGid(group: string): Promise<number> {
  if (/^\d+$/.test(group)) return Number(group);
  const line = await new Promise<string>((resolve, reject) => {
    execFile("getent", ["group", group], { timeout: 5000 }, (err, stdout) => (err ? reject(new Error(`group ${group} does not exist (create it and add the service and nginx accounts; deploy/install.sh does)`)) : resolve(stdout)));
  });
  const gid = Number(line.trim().split(":")[2]);
  if (!Number.isInteger(gid)) throw new Error(`cannot read the id of group ${group}`);
  return gid;
}

/** Removes a leftover socket file; refuses to touch anything else that is in the way. */
async function removeStale(path: string): Promise<void> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!st) return;
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; not removing it`);
  await unlink(path);
}

/** Binds `server` to a Unix socket path with the file created under `umask`; resolves when it listens. */
function bind(server: Server, path: string, umask: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    // The socket file is created synchronously inside listen(); the umask is process-wide, so keep the window to that call.
    const previous = process.umask(umask);
    try {
      server.listen(path);
    } finally {
      process.umask(previous);
    }
  });
}

export interface Listening {
  /** Paths of the socket files (unix) or null (tcp). */
  sockets: { public: string; local: string } | null;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/** Starts listening as configured. The app must be built (routes registered); it is made ready here. */
export async function listenHub(app: FastifyInstance, config: HubConfig, log?: Logger): Promise<Listening> {
  const { server } = config;
  if (server.listen === "tcp") {
    tag(app.server, "tcp");
    await app.listen({ host: server.host, port: server.port });
    log?.info({ host: server.host, port: server.port }, "listening (tcp, development)");
    return { sockets: null, close: () => app.close() };
  }

  await app.ready();
  const gid = await resolveGid(server.proxyGroup);
  await mkdir(dirname(server.socket), { recursive: true, mode: 0o755 });
  if (dirname(server.localSocket) !== dirname(server.socket)) await mkdir(dirname(server.localSocket), { recursive: true, mode: 0o755 });
  await removeStale(server.socket);
  await removeStale(server.localSocket);

  const pub = app.server;
  tag(pub, "public");
  // The same request handler (and so the same hooks and routes) behind a second listener; no WebSocket upgrades there.
  const local = createServer(app.routing);
  tag(local, "local");

  const cleanup = async () => {
    await Promise.all([closeServer(pub), closeServer(local)]);
    await Promise.all([removeStale(server.socket).catch(() => undefined), removeStale(server.localSocket).catch(() => undefined)]);
  };
  try {
    await bind(local, server.localSocket, 0o777 & ~LOCAL_SOCKET_MODE);
    await bind(pub, server.socket, 0o777 & ~PUBLIC_SOCKET_MODE);
    await chown(server.socket, -1, gid).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`cannot give ${server.socket} to group ${server.proxyGroup} (${err.code}); the service account must be a member of it`);
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  log?.info({ public: server.socket, local: server.localSocket, group: server.proxyGroup }, "listening (unix sockets)");
  return {
    sockets: { public: server.socket, local: server.localSocket },
    close: async () => {
      await cleanup();
      await app.close();
    },
  };
}
