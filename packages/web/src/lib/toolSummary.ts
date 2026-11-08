import { pastChatTool, readTargetOf, searchQueryOf } from "./pastChats";
import { downloadName, isDownloadTool, parseDownload } from "./download";
import { isRecord } from "./sdk";
import { basename, truncate } from "./format";

export type ToolIcon = "bash" | "read" | "edit" | "write" | "grep" | "glob" | "web" | "task" | "todo" | "plan" | "mcp" | "other";

export interface ToolMeta {
  icon: ToolIcon;
  /** Display name, e.g. "Bash", "github · create_issue" */
  label: string;
  /** One-line summary derived from the input. */
  summary: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i);
}

export function toolMeta(name: string, input: unknown): ToolMeta {
  const i = isRecord(input) ? input : {};
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return { icon: "bash", label: name, summary: truncate(str(i.description) || firstLine(str(i.command)) || str(i.bash_id) || str(i.shell_id), 140) };
    case "Read":
      return { icon: "read", label: name, summary: str(i.file_path) ? basename(str(i.file_path)) + rangeSuffix(i) : "" };
    case "Edit":
      return { icon: "edit", label: name, summary: str(i.file_path) };
    case "MultiEdit":
      return { icon: "edit", label: name, summary: `${str(i.file_path)}${Array.isArray(i.edits) ? ` (${i.edits.length} edits)` : ""}` };
    case "Write":
      return { icon: "write", label: name, summary: str(i.file_path) };
    case "NotebookEdit":
      return { icon: "edit", label: name, summary: str(i.notebook_path) };
    case "Grep":
      return { icon: "grep", label: name, summary: truncate(`${str(i.pattern)}${i.path ? ` in ${str(i.path)}` : ""}`, 140) };
    case "Glob":
      return { icon: "glob", label: name, summary: truncate(`${str(i.pattern)}${i.path ? ` in ${str(i.path)}` : ""}`, 140) };
    case "WebFetch":
      return { icon: "web", label: name, summary: truncate(str(i.url), 140) };
    case "WebSearch":
      return { icon: "web", label: name, summary: truncate(str(i.query), 140) };
    case "Task":
    case "Agent":
      return { icon: "task", label: name === "Agent" ? "Agent" : "Task", summary: truncate(str(i.description) || str(i.subagent_type) || firstLine(str(i.prompt)), 140) };
    case "TodoWrite":
      return { icon: "todo", label: "Todos", summary: Array.isArray(i.todos) ? `${i.todos.length} items` : "" };
    case "ExitPlanMode":
      return { icon: "plan", label: "Plan", summary: "Ready to code?" };
    default:
      break;
  }
  if (isDownloadTool(name)) {
    const call = parseDownload(i);
    return { icon: "mcp", label: "Download", summary: truncate(call.host ? `${downloadName(call)} · ${call.host}` : call.url, 140) };
  }
  const past = pastChatTool(name);
  if (past) return { icon: "mcp", label: past === "search" ? "Search past chats" : "Read past chat", summary: truncate(past === "search" ? searchQueryOf(i) : readTargetOf(i), 140) };
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "mcp";
    const tool = parts.slice(2).join("__") || name;
    return { icon: "mcp", label: `${server} · ${tool}`, summary: firstStringValue(i) };
  }
  return { icon: "other", label: name, summary: firstStringValue(i) };
}

function rangeSuffix(i: Record<string, unknown>): string {
  if (typeof i.offset === "number" || typeof i.limit === "number") {
    const start = typeof i.offset === "number" ? i.offset : 1;
    return typeof i.limit === "number" ? ` :${start}-${start + i.limit - 1}` : ` :${start}-`;
  }
  return "";
}

function firstStringValue(i: Record<string, unknown>): string {
  for (const v of Object.values(i)) if (typeof v === "string" && v) return truncate(firstLine(v), 140);
  return "";
}

export interface EditSpec {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  /** Write replaces the whole file; the old content is unknown so the diff is all additions. */
  isWrite: boolean;
}

/** Extract an inline-diffable edit from Edit / MultiEdit / Write tool input. */
export function extractEdit(name: string, input: unknown): EditSpec | null {
  if (!isRecord(input)) return null;
  const path = str(input.file_path);
  if (name === "Edit" && path && typeof input.new_string === "string") {
    return { path, isWrite: false, edits: [{ oldText: str(input.old_string), newText: input.new_string }] };
  }
  if (name === "MultiEdit" && path && Array.isArray(input.edits)) {
    const edits = input.edits.filter(isRecord).map((e) => ({ oldText: str(e.old_string), newText: str(e.new_string) }));
    if (edits.length) return { path, isWrite: false, edits };
  }
  if (name === "Write" && path && typeof input.content === "string") {
    return { path, isWrite: true, edits: [{ oldText: "", newText: input.content }] };
  }
  return null;
}

export const DIFFABLE_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
