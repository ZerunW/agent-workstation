/** Contract sanity checks: schemas parse and round-trip, constants are consistent, the route table has no duplicates. */
import { describe, expect, it } from "vitest";
import { ClientEvent, CreateTerminalBody, ERROR_CODES, ErrorBody, MAX_SYNC_FILE_BYTES, PROTOCOL_VERSION, ROUTES, TerminalInfo, USER_HEADER, Username } from "./index.js";

describe("schemas", () => {
  it("Username accepts [a-z0-9_-]{1,32} only", () => {
    for (const ok of ["alice", "a-b_c9", "x".repeat(32)]) expect(Username.safeParse(ok).success).toBe(true);
    for (const bad of ["", "Alice", "a b", "x".repeat(33), "../x"]) expect(Username.safeParse(bad).success).toBe(false);
  });

  it("ClientEvent round-trips and rejects unknown or malformed events", () => {
    const hello = { type: "hello", user: "alice", protocolVersion: PROTOCOL_VERSION };
    expect(ClientEvent.parse(hello)).toEqual(hello);
    expect(ClientEvent.parse({ type: "ping" })).toEqual({ type: "ping" });
    const sub = { type: "subscribe", sessionId: "6f1c1c8e-6a41-4c3a-9c41-0e0b5a1f3b11", lastSeq: 0 };
    expect(ClientEvent.parse(sub)).toEqual(sub);
    expect(ClientEvent.safeParse({ type: "hello", user: "Bad Name", protocolVersion: 1 }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "nope" }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "subscribe", sessionId: "not-a-uuid", lastSeq: 0 }).success).toBe(false);
  });

  it("ErrorBody and terminal bodies round-trip", () => {
    const e = { error: "refused", code: "cross_site" };
    expect(ErrorBody.parse(e)).toEqual(e);
    expect(CreateTerminalBody.parse({})).toEqual({});
    const t = { id: "t1", cwd: "projects/x", createdAt: "2026-01-01T00:00:00.000Z", tmuxSession: "ws-t1" };
    expect(TerminalInfo.parse(t)).toEqual(t);
    expect(TerminalInfo.safeParse({ id: 1 }).success).toBe(false);
  });
});

describe("constants", () => {
  it("are what the clients rely on", () => {
    expect(USER_HEADER).toBe("X-Workstation-User");
    expect(MAX_SYNC_FILE_BYTES).toBe(100 * 1024 * 1024);
  });

  it("error codes are unique lower_snake_case", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const c of ERROR_CODES) expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const c of ["cross_site", "baseline_too_large", "baseline_timeout", "baseline_unsupported_entry", "self_caller", "proxy_header_invalid", "bad_host"]) expect(ERROR_CODES).toContain(c);
  });
});

describe("ROUTES", () => {
  it("every entry is a list of `METHOD /path` and no route is declared twice", () => {
    const seen = new Map<string, string>();
    for (const [name, spec] of Object.entries(ROUTES)) {
      for (const part of spec.split(" | ")) {
        const m = /^(GET|POST|PUT|PATCH|DELETE|WS) (\/[^ ]*)/.exec(part.trim());
        expect(m, `${name}: ${part}`).not.toBeNull();
        const key = `${m![1]} ${m![2]!.split("?")[0]}`;
        expect(seen.get(key), `${key} declared by ${name} and ${seen.get(key)}`).toBeUndefined();
        seen.set(key, name);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});
