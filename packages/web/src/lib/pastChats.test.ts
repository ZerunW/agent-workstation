import { describe, expect, it } from "vitest";
import { isSessionId, pastChatTool, readTargetOf, searchQueryOf, titleFromResult } from "./pastChats";
import { toolMeta } from "./toolSummary";

describe("pastChatTool", () => {
  it("matches on the suffix, whatever the server prefix", () => {
    expect(pastChatTool("mcp__workstation-history__search_conversations")).toBe("search");
    expect(pastChatTool("mcp__workstation-history__read_conversation")).toBe("read");
    expect(pastChatTool("search_conversations")).toBe("search");
    expect(pastChatTool("read_conversation")).toBe("read");
    expect(pastChatTool("workstation-history__read_conversation")).toBe("read");
  });

  it("ignores other tools", () => {
    for (const name of ["Bash", "mcp__workstation-memory__remember", "search_conversations_extra", "read_conversations", "conversation"]) expect(pastChatTool(name), name).toBeNull();
  });
});

describe("what the calls carry", () => {
  it("the search query, under any usual argument name; half-streamed input gives nothing", () => {
    expect(searchQueryOf({ query: "  deploy checklist " })).toBe("deploy checklist");
    expect(searchQueryOf({ q: "x" })).toBe("x");
    expect(searchQueryOf({ text: "y" })).toBe("y");
    expect(searchQueryOf({})).toBe("");
    expect(searchQueryOf(null)).toBe("");
    expect(searchQueryOf("nope")).toBe("");
  });

  it("the session a read call targets", () => {
    expect(readTargetOf({ session_id: "abc" })).toBe("abc");
    expect(readTargetOf({ sessionId: "def" })).toBe("def");
    expect(readTargetOf({ conversation_id: "ghi" })).toBe("ghi");
    expect(readTargetOf({ id: "jkl" })).toBe("jkl");
    expect(readTargetOf({})).toBe("");
  });

  it("recognises a session id", () => {
    expect(isSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isSessionId("not-an-id")).toBe(false);
    expect(isSessionId("")).toBe(false);
  });
});

describe("titleFromResult", () => {
  it("reads a heading, a Title: line or a JSON title", () => {
    expect(titleFromResult("# Release plan\n\n[user] hi")).toBe("Release plan");
    expect(titleFromResult("Title: Budget talk\nbody")).toBe("Budget talk");
    expect(titleFromResult('{"title":"From JSON","messages":[]}')).toBe("From JSON");
    expect(titleFromResult("no title here")).toBe("");
    expect(titleFromResult(undefined)).toBe("");
    expect(titleFromResult("{broken json")).toBe("");
  });
});

describe("toolMeta for the history tools", () => {
  it("gives a friendly label and the query or id as the summary", () => {
    expect(toolMeta("mcp__workstation-history__search_conversations", { query: "invoices" })).toMatchObject({ label: "Search past chats", summary: "invoices" });
    expect(toolMeta("mcp__workstation-history__read_conversation", { session_id: "abc" })).toMatchObject({ label: "Read past chat", summary: "abc" });
  });
});
