/**
 * Where the status service listens. `listen = "unix"` (production): one socket, mode 0660, group `[server] proxy_group`
 * (the nginx account's group); only nginx connects. It is bound under a process umask that already gives that mode,
 * then handed to the group (the service account must be a member). A stale socket file from a crash is removed before
 * listening and the file is removed on shutdown. `listen = "tcp"` (development): `host` and `port`.
 * The same rules as the hub's public socket (packages/hub/src/listen.ts).
 */
import { execFile } from "node:child_process";
import { chown, lstat, mkdir, unlink } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";

const SOCKET_MODE = 0o660;

async function resolveGid(group: string): Promise<number> {
  if (/^\d+$/.test(group)) return Number(group);
  const line = await new Promise<string>((resolve, reject) => {
    execFile("getent", ["group", group], { timeout: 5000 }, (err, stdout) => (err ? reject(new Error(`group ${group} does not exist (create it and add the service and nginx accounts; deploy/install.sh does)`)) : resolve(stdout)));
  });
  const gid = Number(line.trim().split(":")[2]);
  if (!Number.isInteger(gid)) throw new Error(`cannot read the id of group ${group}`);
  return gid;
}

async function removeStale(path: string): Promise<void> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!st) return;
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; not removing it`);
  await unlink(path);
}

function bind(server: Server, path: string, umask: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    // The file is created synchronously inside listen(); the umask is process-wide, so keep the window to that call.
    const previous = process.umask(umask);
    try {
      server.listen(path);
    } finally {
      process.umask(previous);
    }
  });
}

export interface Listening {
  close(): Promise<void>;
}

/** The part of a Fastify app this needs. */
interface App {
  server: Server;
  ready(): PromiseLike<unknown>;
  listen(opts: { host: string; port: number }): PromiseLike<unknown>;
  close(): PromiseLike<unknown>;
}

export async function listenStatus(app: App, config: Pick<AppConfig, "listen" | "socket" | "proxyGroup" | "host" | "port">): Promise<Listening> {
  if (config.listen === "tcp") {
    await app.listen({ host: config.host, port: config.port });
    return { close: async () => void (await app.close()) };
  }
  await app.ready();
  const gid = await resolveGid(config.proxyGroup);
  await mkdir(dirname(config.socket), { recursive: true, mode: 0o755 });
  await removeStale(config.socket);
  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      if (!app.server.listening) return resolve();
      app.server.close(() => resolve());
      app.server.closeIdleConnections();
    });
    await removeStale(config.socket).catch(() => undefined);
  };
  try {
    await bind(app.server, config.socket, 0o777 & ~SOCKET_MODE);
    await chown(config.socket, -1, gid).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`cannot give ${config.socket} to group ${config.proxyGroup} (${err.code}); the service account must be a member of it`);
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return {
    close: async () => {
      await cleanup();
      await app.close();
    },
  };
}
