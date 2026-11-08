/**
 * Per-user memory, like the memory feature of claude.ai: short facts Claude keeps about a person across
 * conversations. Stored on the hub (table `memories`), so the same username sees the same memories on every
 * device.
 *
 * - Chat sessions get the memories in their system prompt plus two in-process tools, `remember` and `forget`,
 *   that Claude calls on its own when the person shares something durable, or when they ask it to.
 * - Code sessions get the memories appended to the Claude Code system prompt (read-only there).
 * - The Memory page (web) and window (Mac) list, add, edit and delete them; nothing deletes a memory on its own.
 *
 * Every change bumps a per-user version: a running Claude process whose prompt was built from an older version
 * is recycled before the next turn, so new memories are seen within one message.
 */
import { randomUUID } from "node:crypto";
import type { Memory } from "@agent-workstation/protocol";
import { z } from "zod";
import type { Broadcaster } from "./ws/protocol.js";
import type { MemoryRow, Store } from "./db/store.js";
import { MEMORY_TOOL_GUIDANCE } from "./sessions/guide.js";
import type { HubToolResult, HubToolSpec } from "./sessions/sdk.js";
import { badRequest, errorMessage, notFound } from "./util/errors.js";

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 2000;
export const MEMORY_SERVER = "workstation-memory";

export class MemoryService {
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly store: Pick<Store, "listMemories" | "getMemory" | "insertMemory" | "updateMemory" | "deleteMemory" | "getUser">,
    private readonly bus: Pick<Broadcaster, "toUser">,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Whether memory is on for this user (default on; a user preference turns it off). */
  enabled(user: string): boolean {
    return this.store.getUser(user)?.memoryEnabled !== false;
  }

  /** Bumped on every change; a Claude process built from an older version is recycled before its next turn. */
  version(user: string): number {
    return this.versions.get(user) ?? 0;
  }

  list(user: string): Memory[] {
    return this.store.listMemories(user).map(toProtocol);
  }

  create(user: string, text: string, source: "claude" | "user", sessionId: string | null = null): Memory {
    const clean = normalize(text);
    const existing = this.store.listMemories(user);
    const dup = existing.find((m) => m.text.toLowerCase() === clean.toLowerCase());
    if (dup) return toProtocol(dup);
    if (existing.length >= MAX_MEMORIES) throw badRequest("memory_limit", `at most ${MAX_MEMORIES} memories per user — remove some first`);
    const now = new Date(this.clock()).toISOString();
    const row: MemoryRow = { id: randomUUID(), user, text: clean, source, sessionId, createdAt: now, updatedAt: now };
    this.store.insertMemory(row);
    this.bump(user);
    return toProtocol(row);
  }

  update(user: string, id: string, text: string): Memory {
    const row = this.store.getMemory(user, id);
    if (!row) throw notFound("no such memory");
    const updated = this.store.updateMemory(user, id, normalize(text), new Date(this.clock()).toISOString());
    this.bump(user);
    return toProtocol(updated ?? { ...row, text: normalize(text) });
  }

  remove(user: string, id: string): void {
    if (!this.store.getMemory(user, id)) throw notFound("no such memory");
    this.store.deleteMemory(user, id);
    this.bump(user);
  }

  /** The system-prompt section listing what Claude knows, or null when there is nothing / memory is off. */
  promptSection(user: string): string | null {
    if (!this.enabled(user)) return null;
    const rows = this.store.listMemories(user);
    if (rows.length === 0) return null;
    const lines = rows
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => `- ${m.text}`);
    return ["# What you remember about this user", "Facts and preferences from earlier conversations (use them naturally; do not recite them unprompted):", ...lines].join("\n");
  }

  /** Instructions for Chat sessions on when to call the memory tools (the Agent Workstation guide's memory bullet). */
  toolGuidance(): string {
    return MEMORY_TOOL_GUIDANCE;
  }

  /** The in-process tools for a Chat session of `user`. */
  tools(user: string, sessionId: string): HubToolSpec[] {
    return [
      {
        name: "remember",
        description: "Save one short, durable fact about the user for future conversations (a preference, their work, how they like answers). Not for secrets or one-off details.",
        schema: { text: z.string().min(1).max(MAX_MEMORY_CHARS).describe("The memory, one sentence, written in the third person, e.g. 'Prefers short answers with code first.'") },
        handler: async (args) => {
          if (!this.enabled(user)) return noop("Memory is turned off for this user; nothing was saved.");
          try {
            const m = this.create(user, String(args.text ?? ""), "claude", sessionId);
            return `Saved: ${m.text}`;
          } catch (err) {
            return noop(`Not saved: ${errorMessage(err)}`);
          }
        },
      },
      {
        name: "forget",
        description: "Remove a saved memory. Pass the memory's text (or a distinctive part of it) as the user asked to forget it.",
        schema: { text: z.string().min(1).max(MAX_MEMORY_CHARS).describe("Text of the memory to remove, or a distinctive substring of it.") },
        handler: async (args) => {
          if (!this.enabled(user)) return noop("Memory is turned off for this user; nothing was removed.");
          const needle = String(args.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!needle) return noop("No memory text given; nothing was removed.");
          const rows = this.store.listMemories(user);
          const exact = rows.find((m) => m.text.toLowerCase() === needle);
          const partial = exact ? [] : rows.filter((m) => m.text.toLowerCase().includes(needle));
          if (!exact && partial.length > 1) {
            return noop(`Several memories match; nothing was removed. Call forget again with the exact text of one of them:\n${partial.map((m) => `- ${m.text}`).join("\n")}`);
          }
          const hit = exact ?? partial[0];
          if (!hit) return noop("No memory matches that text; nothing was removed.");
          this.remove(user, hit.id);
          return `Removed: ${hit.text}`;
        },
      },
    ];
  }

  private bump(user: string): void {
    this.versions.set(user, this.version(user) + 1);
    this.bus.toUser(user, { type: "memories_changed" });
  }
}

/** A tool call that saved or removed nothing: flagged so clients do not show it as done. */
const noop = (text: string): HubToolResult => ({ text, isError: true });

function normalize(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw badRequest("invalid_request", "memory text is empty");
  if (clean.length > MAX_MEMORY_CHARS) throw badRequest("invalid_request", `memory text is longer than ${MAX_MEMORY_CHARS} characters`);
  return clean;
}

function toProtocol(r: MemoryRow): Memory {
  return { id: r.id, text: r.text, source: r.source, sessionId: r.sessionId, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
