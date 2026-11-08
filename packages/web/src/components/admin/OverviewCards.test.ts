import { describe, expect, it } from "vitest";
import type { AdminOverview } from "../../lib/api";
import { deriveOverview } from "./OverviewCards";

const overview = {
  pool: { active: 2, max: 6, queued: 1 },
  processes: [
    { sessionId: "11111111-1111-4111-8111-111111111111", user: "alice", kind: "code", status: "running", pid: 1, rssMiB: 100, startedAt: "x", lastActiveAt: "x" },
    { sessionId: "22222222-2222-4222-8222-222222222222", user: "bob", kind: "chat", status: "idle", pid: 2, rssMiB: 90, startedAt: "x", lastActiveAt: "x" },
  ],
  users: [
    { user: "alice", enabled: true, sessions: 5, weeklyTokens: 1, weeklyLimit: null },
    { user: "bob", enabled: true, sessions: 2, weeklyTokens: 1, weeklyLimit: null },
  ],
} as unknown as AdminOverview;

describe("deriveOverview", () => {
  it("reads users, working sessions and the process pool from the protocol overview", () => {
    expect(deriveOverview(overview, undefined, undefined)).toEqual({ users: 2, sessions: { value: 1, live: true }, processes: { value: 2, max: 6, queued: 1 } });
  });
  it("falls back to the users list and usage totals when the overview is unavailable", () => {
    const v = deriveOverview(undefined, [{}, {}, {}] as never, { users: [{ sessions: 2 }, { sessions: 3 }], buckets: [] } as never);
    expect(v).toEqual({ users: 3, sessions: { value: 5, live: false }, processes: { value: null, max: null, queued: null } });
  });
});
