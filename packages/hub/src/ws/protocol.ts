/**
 * Event fan-out abstraction. Services publish ServerEvents through a
 * Broadcaster; the WebSocket server implements it, tests use RecordingBus.
 *
 * Routing:
 *   toSession — connections subscribed to that session (messages, deltas)
 *   toUser    — every connection of a user (session list state, permission prompts, file events)
 *   toAll     — every connection (usage limits, global notices)
 *   toEachUser— one event per connected user, computed lazily (per-user disk breakdown)
 */
import type { ServerEvent } from "@agent-workstation/protocol";

export interface Broadcaster {
  toSession(sessionId: string, event: ServerEvent): void;
  toUser(user: string, event: ServerEvent): void;
  toAll(event: ServerEvent): void;
  toEachUser(make: (user: string) => ServerEvent | null): void;
}

export const nullBus: Broadcaster = {
  toSession() {},
  toUser() {},
  toAll() {},
  toEachUser() {},
};

export interface RecordedEvent {
  scope: "session" | "user" | "all";
  target: string | null;
  event: ServerEvent;
}

/** Test helper: records everything. */
export class RecordingBus implements Broadcaster {
  readonly events: RecordedEvent[] = [];
  users: string[] = [];
  toSession(sessionId: string, event: ServerEvent): void {
    this.events.push({ scope: "session", target: sessionId, event });
  }
  toUser(user: string, event: ServerEvent): void {
    this.events.push({ scope: "user", target: user, event });
  }
  toAll(event: ServerEvent): void {
    this.events.push({ scope: "all", target: null, event });
  }
  toEachUser(make: (user: string) => ServerEvent | null): void {
    for (const u of this.users) {
      const e = make(u);
      if (e) this.toUser(u, e);
    }
  }
  ofType<T extends ServerEvent["type"]>(type: T): Extract<ServerEvent, { type: T }>[] {
    return this.events.filter((e) => e.event.type === type).map((e) => e.event as Extract<ServerEvent, { type: T }>);
  }
  clear(): void {
    this.events.length = 0;
  }
}
