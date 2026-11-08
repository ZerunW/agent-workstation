import { describe, expect, it } from "vitest";
import { groupSessions } from "./groups";
import { dayBucket, formatBytes, formatCost, formatCountdown, formatDuration, relativeTime } from "./format";
import { session } from "../test/fixtures";
import type { ProjectInfo } from "./api";

const NOW = new Date("2026-10-31T12:00:00");
const at = (d: string) => new Date(d).toISOString();

describe("groupSessions", () => {
  it("groups code sessions by cwd, newest group first, newest session first", () => {
    const list = [
      session({ id: "a", cwd: "projects/x", lastActiveAt: at("2026-10-30T10:00:00") }),
      session({ id: "b", cwd: "projects/y", lastActiveAt: at("2026-10-31T09:00:00") }),
      session({ id: "c", cwd: "projects/x", lastActiveAt: at("2026-10-31T10:00:00") }),
      session({ id: "d", cwd: "", lastActiveAt: at("2026-10-01T10:00:00") }),
      session({ id: "e", kind: "chat", cwd: ".chat" }),
    ];
    const g = groupSessions(list, "code", "", NOW);
    expect(g.map((x) => x.label)).toEqual(["x", "y", ""]);
    expect(g[0]!.sessions.map((s) => s.id)).toEqual(["c", "a"]);
  });

  it("groups code sessions by project (projectId or cwd), everything else under Workspace", () => {
    const P_ID = "33333333-3333-4333-8333-333333333333";
    const projects: ProjectInfo[] = [{ id: P_ID, user: "alice", name: "demo-app", path: "projects/demo-app", createdAt: "2026-10-01T00:00:00Z", localCommit: null, pendingFiles: 2, sizeBytes: 0, origin: null }];
    const list = [
      session({ id: "a", cwd: "projects/demo-app/src", lastActiveAt: at("2026-10-31T10:00:00") }),
      session({ id: "b", cwd: "elsewhere", projectId: P_ID, lastActiveAt: at("2026-10-31T09:00:00") } as never),
      session({ id: "c", cwd: "docs", lastActiveAt: at("2026-10-31T08:00:00") }),
      session({ id: "d", cwd: "", lastActiveAt: at("2026-10-31T07:00:00") }),
      session({ id: "e", cwd: "projects/ghost", lastActiveAt: at("2026-10-31T06:00:00") }),
    ];
    const g = groupSessions(list, "code", "", NOW, projects);
    expect(g.map((x) => [x.key, x.label, x.cwd])).toEqual([
      ["project:demo-app", "demo-app", "projects/demo-app"],
      ["workspace", "", ""],
      ["project:ghost", "ghost", "projects/ghost"],
    ]);
    expect(g[0]!.sessions.map((s) => s.id)).toEqual(["a", "b"]); // cwd match and projectId match land together
    expect(g[0]!.projectId).toBe(P_ID);
    expect(g[1]!.sessions.map((s) => s.id)).toEqual(["c", "d"]); // non-project cwds are all "Workspace"
    expect(g[2]!.projectId).toBeNull(); // a project the list does not know has no id yet
  });

  it("groups chat sessions by day buckets in order and filters by query", () => {
    const list = [
      session({ id: "1", kind: "chat", title: "Today chat", lastActiveAt: at("2026-10-31T08:00:00") }),
      session({ id: "2", kind: "chat", title: "Yesterday chat", lastActiveAt: at("2026-10-30T08:00:00") }),
      session({ id: "3", kind: "chat", title: "Old chat", lastActiveAt: at("2026-08-01T08:00:00") }),
    ];
    expect(groupSessions(list, "chat", "", NOW).map((g) => g.bucket)).toEqual(["today", "yesterday", "older"]);
    expect(groupSessions(list, "chat", "old", NOW).flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["3"]);
  });
});

describe("format helpers", () => {
  it("formats bytes, durations, costs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(12_300)).toBe("12s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatCost(0.0123)).toBe("$0.012");
    expect(formatCost(2.5)).toBe("$2.50");
  });
  it("buckets days and formats relative/countdown times", () => {
    expect(dayBucket("2026-10-31T01:00:00", NOW)).toBe("today");
    expect(dayBucket("2026-10-30T23:00:00", NOW)).toBe("yesterday");
    expect(dayBucket("2026-10-27T23:00:00", NOW)).toBe("week");
    expect(relativeTime(new Date(NOW.getTime() - 30_000).toISOString(), NOW.getTime())).toBe("now");
    expect(formatCountdown(new Date(NOW.getTime() + (2 * 3600 + 15 * 60) * 1000).toISOString(), NOW.getTime())).toBe("2h 15m");
    expect(formatCountdown(new Date(NOW.getTime() - 1000).toISOString(), NOW.getTime())).toBe("now");
  });
});
