import type { BackgroundTask } from "@agent-workstation/protocol";
import { isRecord } from "./sdk";

/** The hub's subagent tool: the session's agent proposes a batch of child sessions, approved once. */
export const SUBAGENTS_TOOL = "mcp__workstation_subagent__run_subagents";
/** `BackgroundTask.type` of a running subagent run (`taskId` = the child session id). */
export const SUBAGENT_TASK_TYPE = "workstation_subagent";

export const isSubagentTool = (name: string): boolean => name === SUBAGENTS_TOOL;

/** One agent of a batch (`SubagentSpec`), as far as the (possibly half-streamed) input says. */
export interface SubagentCall {
  model: string;
  description: string;
  task: string;
  /** The globs the agent may write (`SubagentSpec.paths`); empty when unset. */
  paths: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agents of a call's input; tolerant of half-streamed input. */
export function subagentCalls(input: unknown): SubagentCall[] {
  const agents = isRecord(input) && Array.isArray(input.agents) ? input.agents : [];
  return agents.filter(isRecord).map((a) => ({ model: str(a.model), description: str(a.description).trim(), task: str(a.task), paths: Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string" && p !== "") : [] }));
}

const GLOB = /[*?[\]{}]/;
const segments = (p: string): string[] => p.replace(/^(\.\/)+/, "").split("/").filter(Boolean);
/** One glob segment as a regex (`*` = any run, `?` = one char). */
const segmentRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const segmentsMeet = (a: string, b: string): boolean => {
  if (a === b || a === "**" || b === "**") return true;
  const ga = GLOB.test(a);
  const gb = GLOB.test(b);
  if (!ga && !gb) return false;
  if (ga && gb) return true;
  const [glob, lit] = ga ? [a, b] : [b, a];
  return /[[\]{}]/.test(glob) || segmentRe(glob).test(lit);
};

/** Whether two path globs can match a common path. Conservative: `**`, braces and classes count as a match. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = segments(a);
  const y = segments(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === "**" || y[i] === "**") return true;
    if (!segmentsMeet(x[i]!, y[i]!)) return false;
  }
  return true; // equal, or one is a directory prefix of the other
}

/** Per agent: the descriptions of the other agents whose paths can overlap its own. */
export function overlapsOf(calls: readonly SubagentCall[]): string[][] {
  return calls.map((c, i) => calls.flatMap((o, j) => (j !== i && c.paths.some((p) => o.paths.some((q) => pathsOverlap(p, q))) ? [o.description || String(j + 1)] : [])));
}

export interface SubagentResult {
  /** The child session, from the first `session:` line (absent when the call failed before one existed). */
  sessionId: string | null;
  /** The child's final answer (or the error text). */
  answer: string;
  files: string[];
}

const SEPARATOR = /^[ \t]*--- subagent ---[ \t]*\r?$/m;

/** One section per agent in input order, split on the `--- subagent ---` line. */
export function parseSubagentsResult(text: string): SubagentResult[] {
  return text.split(SEPARATOR).map((section) => parseSubagentResult(section.replace(/^\s+/, "")));
}

/** Nothing started: the call failed or was declined, so no section names a child. */
export const subagentsNotStarted = (result: { text: string; isError?: boolean } | undefined): boolean => !!result?.isError && !parseSubagentsResult(result.text).some((r) => r.sessionId);

/** `session: <uuid>`, blank line, answer, optionally a last line `Files: a, b`. */
export function parseSubagentResult(text: string): SubagentResult {
  const m = /^session:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/.exec(text);
  let rest = m ? text.slice(m[0].length) : text;
  const sessionId = m && UUID.test(m[1]!) ? m[1]! : null;
  if (m) rest = rest.replace(/^[ \t]*\r?\n/, "");
  let files: string[] = [];
  const f = /(?:^|\n)Files:[ \t]*([^\n]*)\s*$/.exec(rest);
  if (f) {
    files = f[1]!.split(",").map((x) => x.trim()).filter(Boolean);
    rest = rest.slice(0, f.index);
  }
  return { sessionId, answer: rest.trim(), files };
}

/** The task of the `nth` agent carrying this description (running ones first): it names the child before the result arrives. */
export function subagentTask(tasks: readonly BackgroundTask[] | undefined, description: string, nth = 0): BackgroundTask | undefined {
  const same = (tasks ?? []).filter((x) => x.type === SUBAGENT_TASK_TYPE && x.description === description);
  const running = same.filter((x) => !x.status || x.status === "running");
  const list = running.length ? running : same;
  return list[Math.min(nth, list.length - 1)];
}

/** `subagentType` is the model, optionally prefixed with `claude:`. */
export function splitSubagentType(subagentType: string | undefined): { model: string } {
  const raw = subagentType ?? "";
  return { model: raw.startsWith("claude:") ? raw.slice("claude:".length) : raw };
}
