import type { CommandInfo } from "@agent-workstation/protocol";
import { api } from "./api";

const cache = new Map<string, { at: number; list: CommandInfo[] }>();
const TTL_MS = 60_000;

/** Slash commands for a session (cached for a minute: the hub spawns nothing, but the list is large). */
export async function loadCommands(sessionId: string | null): Promise<CommandInfo[]> {
  const key = sessionId ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const list = await api.commands(sessionId ?? undefined);
  cache.set(key, { at: Date.now(), list });
  return list;
}

/** Drop cached command lists (after skills were created, edited or deleted, so the `/` palette shows them). */
export function invalidateCommands(): void {
  cache.clear();
}
