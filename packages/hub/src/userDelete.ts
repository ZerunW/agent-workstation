/**
 * Admin-only user deletion (DELETE /api/users/:name). An explicit admin action,
 * so it is allowed to remove everything the user owns — but, like project
 * delete, it refuses while a project still holds unaccepted changes or files
 * that were never downloaded, unless the admin passes `force`.
 */
import { existsSync } from "node:fs";
import { lstat, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Hub } from "./hub.js";
import { isValidUsername } from "./identity.js";
import { RESERVED_USERS } from "./users.js";
import { errorMessage, forbidden, HttpError, notFound } from "./util/errors.js";

async function removePath(p: string): Promise<void> {
  let st;
  try {
    st = await lstat(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) await unlink(p);
  else await rm(p, { recursive: true, force: true });
}

export async function deleteUser(hub: Hub, name: string, force: boolean): Promise<void> {
  if (!isValidUsername(name)) throw notFound("no such user");
  if (RESERVED_USERS.has(name) || hub.config.auth.adminUsernames.includes(name) || hub.users.isAdmin(name)) {
    throw forbidden("reserved_user", `${name} is reserved or an admin and cannot be deleted`);
  }
  const root = hub.users.root(name);
  if (!hub.store.getUser(name) && !existsSync(root)) throw notFound("no such user");

  const projects = hub.store.listProjectRows(name);
  if (!force) {
    const blocked: { id: string; name: string; pendingFiles: number; undownloadedFiles: number }[] = [];
    for (const p of projects) {
      const can = await (await hub.projects.repo(p)).canDelete();
      if (!can.ok) blocked.push({ id: p.id, name: p.name, pendingFiles: can.pendingFiles, undownloadedFiles: can.undownloadedFiles });
    }
    if (blocked.length) {
      throw new HttpError(409, "user_not_empty", `${name} has ${blocked.length} project(s) with unaccepted changes or undownloaded files; pass force=true to delete anyway`, { projects: blocked });
    }
  }

  const warn = (what: string) => (err: unknown) => hub.log.warn({ user: name, err: errorMessage(err) }, `user delete: ${what} failed`);
  hub.ws.disconnectUser(name, "This user was deleted by an admin.");
  // The browser holds its profile in <root>/.browser: stop it (gracefully) before the folder goes.
  await hub.browsers.stop(name).catch(warn("browser stop"));
  // Sessions: closes live processes, deletes rows + messages + session rules + Claude's transcripts.
  for (const id of hub.store.sessionIdsForUser(name)) await hub.sessions.delete(id).catch(warn("session delete"));
  for (const t of hub.store.listTerminals(name)) await hub.terminals.remove(name, t.id).catch(warn("terminal delete"));
  for (const p of projects) await hub.projects.remove(p, true).catch(warn("project delete"));
  hub.store.deleteUserData(name);
  await hub.watchers.forget(name);
  hub.users.forget(name);
  await removePath(root);
  await removePath(join(hub.config.paths.dataDir, "uploads", name));
  await removePath(join(hub.config.paths.dataDir, "skill-overlays", name));
  hub.log.info({ user: name, force, projects: projects.length }, "user deleted");
}
