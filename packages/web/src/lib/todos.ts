import type { ToolItem } from "./transcript";
import { isRecord } from "./sdk";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoStep {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

/** Claude's built-in task-list tool. */
export const isTodoTool = (name: string): boolean => name === "TodoWrite";

/** The steps of one TodoWrite input; null when the input has no usable list. */
export function parseTodos(input: unknown): TodoStep[] | null {
  if (!isRecord(input) || !Array.isArray(input.todos)) return null;
  const steps: TodoStep[] = [];
  for (const raw of input.todos) {
    if (!isRecord(raw)) continue;
    const content = typeof raw.content === "string" ? raw.content : typeof raw.activeForm === "string" ? raw.activeForm : "";
    if (!content) continue;
    const status: TodoStatus = raw.status === "completed" || raw.status === "in_progress" ? raw.status : "pending";
    steps.push({ content, activeForm: typeof raw.activeForm === "string" && raw.activeForm ? raw.activeForm : content, status });
  }
  return steps;
}

/** The steps of the session's latest TodoWrite call (tools are in message order); older calls are ignored. */
export function latestTodos(tools: ReadonlyMap<string, Pick<ToolItem, "name" | "input" | "seq">>): TodoStep[] | null {
  let latest: Pick<ToolItem, "name" | "input" | "seq"> | null = null;
  for (const tool of tools.values()) {
    if (isTodoTool(tool.name) && parseTodos(tool.input) && (!latest || tool.seq >= latest.seq)) latest = tool;
  }
  return latest ? parseTodos(latest.input) : null;
}
