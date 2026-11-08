import { describe, expect, it } from "vitest";
import { isTodoTool, latestTodos, parseTodos } from "./todos";

const tool = (seq: number, input: unknown, name = "TodoWrite") => ({ name, input, seq });

describe("todos", () => {
  it("parses statuses and activeForm; unknown statuses are pending, entries without text are dropped", () => {
    expect(
      parseTodos({
        todos: [
          { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
          { content: "Ship", status: "completed" },
          { content: "Later", activeForm: "Doing later", status: "whatever" },
          { status: "pending" },
          "junk",
        ],
      }),
    ).toEqual([
      { content: "Write tests", activeForm: "Writing tests", status: "in_progress" },
      { content: "Ship", activeForm: "Ship", status: "completed" },
      { content: "Later", activeForm: "Doing later", status: "pending" },
    ]);
    expect(parseTodos({})).toBeNull();
    expect(parseTodos(null)).toBeNull();
  });

  it("takes the latest TodoWrite call only", () => {
    const tools = new Map([
      ["a", tool(2, { todos: [{ content: "old", status: "pending" }] })],
      ["b", tool(5, { todos: [{ content: "new", status: "completed" }] })],
      ["c", tool(7, { command: "ls" }, "Bash")],
    ]);
    expect(latestTodos(tools)?.map((t) => t.content)).toEqual(["new"]);
    expect(latestTodos(new Map([["c", tool(7, {}, "Bash")]]))).toBeNull();
    expect(isTodoTool("TodoWrite")).toBe(true);
    expect(isTodoTool("Bash")).toBe(false);
  });
});
