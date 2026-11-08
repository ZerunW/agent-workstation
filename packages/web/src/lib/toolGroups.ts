import { t, type I18nKey } from "../i18n";
import { basename, truncate } from "./format";
import { buildDiff } from "./lineDiff";
import { downloadName, isDownloadTool, parseDownload } from "./download";
import { isRecord } from "./sdk";
import { isSubagentTool, subagentCalls } from "./subagent";
import { DIFFABLE_TOOLS, extractEdit } from "./toolSummary";

/** What a tool call does, for the one-line group summary. */
export type ToolKind = "read" | "edit" | "write" | "bash" | "search" | "web" | "fetch" | "mcp" | "download" | "subagent" | "task" | "todo" | "plan" | "other";

export interface GroupTool {
  name: string;
  input: unknown;
  running?: boolean;
  failed?: boolean;
  /** A subagent batch the person did not start. */
  declined?: boolean;
}

const BY_NAME: Record<string, ToolKind> = {
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebSearch: "web",
  WebFetch: "fetch",
  Task: "task",
  Agent: "task",
  TodoWrite: "todo",
  ExitPlanMode: "plan",
};

export function toolKind(name: string): ToolKind {
  if (isSubagentTool(name)) return "subagent";
  if (isDownloadTool(name)) return "download";
  if (name.startsWith("mcp__")) return "mcp";
  return BY_NAME[name] ?? "other";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The MCP server a call went to (`mcp__github__create_issue` → github). */
function mcpServer(name: string): string {
  if (name.startsWith("mcp__")) return name.split("__")[1] || "mcp";
  return "mcp";
}

const PATH_KEYS = ["file_path", "notebook_path", "path"];
function pathOf(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const k of PATH_KEYS) if (str(input[k])) return str(input[k]);
  return "";
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i);
}

/** "3 subagents", or "Subagents not started" for a declined batch. */
export function subagentLabel(input: unknown, declined?: boolean): string {
  if (declined) return t("tg.subagents.declined");
  const n = subagentCalls(input).length;
  return n === 1 ? t("tg.subagents.one") : t("tg.subagents.many", { n });
}

export const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function plural(one: I18nKey, many: I18nKey, n: number): string {
  return n === 1 ? t(one) : t(many, { n });
}

export interface GroupSummary {
  text: string;
  added: number;
  removed: number;
  failed: number;
}

/** "Created a.md, ran a command" plus the total diff of the edits and writes and the number of failed calls. */
export function summarizeTools(tools: readonly GroupTool[]): GroupSummary {
  const order: ToolKind[] = [];
  const by = new Map<ToolKind, GroupTool[]>();
  let added = 0;
  let removed = 0;
  let failed = 0;
  for (const tool of tools) {
    const kind = toolKind(tool.name);
    if (!by.has(kind)) {
      by.set(kind, []);
      order.push(kind);
    }
    by.get(kind)!.push(tool);
    if (tool.failed) failed++;
    if (DIFFABLE_TOOLS.has(tool.name)) {
      const spec = extractEdit(tool.name, tool.input);
      if (spec) {
        for (const e of spec.edits) {
          const { stats } = buildDiff(e.oldText, e.newText);
          added += stats.additions;
          removed += stats.deletions;
        }
      }
    }
  }

  const files = (list: GroupTool[]): string => {
    const paths = new Set<string>();
    let unnamed = 0;
    for (const x of list) {
      const p = pathOf(x.input);
      if (p) paths.add(p);
      else unnamed++;
    }
    const n = paths.size + unnamed;
    return n === 1 && paths.size === 1 ? basename([...paths][0]!) : plural("tg.file.one", "tg.file.many", n);
  };

  const parts: string[] = [];
  for (const kind of order) {
    const list = by.get(kind)!;
    switch (kind) {
      case "read":
        parts.push(t("tg.read", { what: files(list) }));
        break;
      case "edit":
        parts.push(t("tg.edit", { what: files(list) }));
        break;
      case "write":
        parts.push(t("tg.write", { what: files(list) }));
        break;
      case "bash":
        parts.push(t("tg.bash", { what: plural("tg.command.one", "tg.command.many", list.length) }));
        break;
      case "search":
        parts.push(t("tg.search"));
        break;
      case "web":
        parts.push(t("tg.web"));
        break;
      case "fetch":
        parts.push(t("tg.fetch", { what: plural("tg.page.one", "tg.page.many", list.length) }));
        break;
      case "download": {
        const names = new Set(list.map((x) => downloadName(parseDownload(x.input))));
        parts.push(t("tg.download", { what: names.size === 1 ? [...names][0]! : plural("tg.file.one", "tg.file.many", list.length) }));
        break;
      }
      case "mcp":
        for (const server of new Set(list.map((x) => mcpServer(x.name)))) parts.push(t("tg.mcp", { server }));
        break;
      case "subagent":
        for (const x of list) parts.push(subagentLabel(x.input, x.declined));
        break;
      case "task":
        parts.push(t("tg.task", { what: plural("tg.task.one", "tg.task.many", list.length) }));
        break;
      case "todo":
        parts.push(t("tg.todo"));
        break;
      case "plan":
        parts.push(t("tg.plan"));
        break;
      case "other":
        parts.push(t("tg.other", { what: plural("tg.tool.one", "tg.tool.many", list.length) }));
        break;
    }
  }
  return { text: capitalise(parts.join(", ")), added, removed, failed };
}

/** "Running npx tsc --noEmit…" / "Editing a.ts…": the group line while this call is in flight. */
export function liveLabel(tool: GroupTool): string {
  const kind = toolKind(tool.name);
  const input = isRecord(tool.input) ? tool.input : {};
  const file = basename(pathOf(tool.input));
  switch (kind) {
    case "read":
      return t("tg.live.read", { x: file || t("tg.file.one") });
    case "edit":
      return t("tg.live.edit", { x: file || t("tg.file.one") });
    case "write":
      return t("tg.live.write", { x: file || t("tg.file.one") });
    case "bash": {
      const cmd = firstLine(str(input.command)).trim();
      return t("tg.live.bash", { x: cmd ? truncate(cmd, 80) : t("tg.command.one") });
    }
    case "subagent":
      return subagentLabel(tool.input, tool.declined);
    case "mcp":
      return t("tg.live.mcp", { x: mcpServer(tool.name) });
    case "other":
      return t("tg.live.other", { x: tool.name });
    default:
      return t(`tg.live.${kind}` as I18nKey);
  }
}
