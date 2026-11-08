/**
 * Agent Workstation's own subagents: the `run_subagents` tool. Claude Code's built-in Agent tool runs inside one process
 * and chats have none, so the hub offers one tool that runs tasks in child sessions (each a session of its own, visible
 * to the person) and returns their answers. The agent proposes a batch; the person approves the whole batch once.
 *
 * - Tool: the in-process MCP server `workstation_subagent` (recorded as `mcp__workstation_subagent__run_subagents`,
 *   pre-approved by name: the approval is the card below). Input RunSubagentsInput `{ agents: SubagentSpec[1..6] }`,
 *   each `{ model?, description (≤ 80), task (≤ 8,000), paths? (code: required) }`.
 * - Approval: after validation (every model allowed), ONE permission request for the call through the
 *   normal broker: `toolName` = the recorded name, `input` = the validated agents with the models filled in. Never
 *   answered by the permission mode or by rules; "remember" answers allow once (permissions.ts `alwaysAsk`).
 *   Denied, timed out or stopped → no child starts.
 * - Child: a normal session row with `parentSessionId` (same user, kind, cwd, permission mode, incognito flag). Never listed or searched; readable by id. It has
 *   no `run_subagents` (depth 1) and no `wrap_up`; a chat child only searches and reads the web.
 * - Limits: all subagents on the server share at most `max_active_processes` − SUBAGENT_RESERVED_SLOTS running slots
 *   (by design: the reserved slots always stay free for normal conversations); the rest of an approved batch
 *   waits in one server-wide FIFO queue. The process pool and memory gate still apply. 30 minutes per child (then
 *   stopped). Stopping the parent's turn stops its children and drops its waiting ones.
 * - While a child runs it is a background task of the parent (`type` = `workstation_subagent`, `taskId` = the child id).
 * - Areas (code sessions): every agent of a call gives `paths`, 1–MAX_AREA_PATHS globs relative to the
 *   working directory (normalised; absolute paths, `..` escapes and empty patterns refuse the whole call with one
 *   error naming each bad agent, before any card). Chats' subagents cannot write: their `paths` are ignored. The
 *   card's input carries the normalised `paths`, and the child's task starts with a hub-built preamble naming its
 *   area and the two rules below (subagentPrompt).
 * - Write guard (checkWrite; the runtime calls it for Write / Edit / MultiEdit / NotebookEdit in every permission mode, before the normal permission card): a target outside the child's globs (resolved
 *   against its cwd, symlinks resolved) is denied; across the running children of one parent the first child whose
 *   file-changing call passes on a path owns it until that child ends, and siblings are denied. A claim whose call the
 *   person or the mode then refuses is dropped again (writeRefused). Bash cannot be checked precisely: its permission
 *   path is unchanged, and the preamble asks the child to keep shell writes inside its area too.
 * - Result: one section per agent in input order, separated by a line `--- subagent ---`. A section is
 *   `session: <child id>`, a blank line, the child's final answer (≤ 20 KB) and, for code sessions, a `Files: a, b`
 *   line with the files it touched; errors after the child was created still start with the session line, a child
 *   that never started has only its error text.
 *
 * The runtime (runtime.ts) implements SubagentHost; permission forwarding to the parent lives in permissions.ts.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BackgroundTask, EffortLevel, RunSubagentsInput } from "@agent-workstation/protocol";
import type { MessageRow, SessionRow } from "../db/store.js";
import { errorMessage } from "../util/errors.js";
import type { HubToolResult, HubToolSpec } from "./sdk.js";

export const SUBAGENT_SERVER = "workstation_subagent";
export const SUBAGENT_TOOL = "run_subagents";
/** The recorded tool name. */
export const SUBAGENT_TOOL_NAME = `mcp__${SUBAGENT_SERVER}__${SUBAGENT_TOOL}`;
/** BackgroundTask.type of a running child. */
export const SUBAGENT_TASK_TYPE = "workstation_subagent";
export const MAX_SUBAGENT_TASK = 8000;
export const MAX_SUBAGENT_DESCRIPTION = 80;
export const MAX_SUBAGENT_ANSWER_BYTES = 20 * 1024;
export const MAX_SUBAGENTS_PER_CALL = 6;
export const SUBAGENT_TIMEOUT_MS = 30 * 60_000;
/** The line between two agents' sections of the result. */
export const SUBAGENT_SECTION_SEPARATOR = "--- subagent ---";
export const SUBAGENTS_DECLINED = "The user declined to start these subagents.";
/** At most this many globs per agent's `paths`, each at most MAX_AREA_PATH characters. */
export const MAX_AREA_PATHS = 20;
export const MAX_AREA_PATH = 200;
/** The line between the hub's preamble and the task in a code child's first message. */
export const SUBAGENT_TASK_HEADING = "Your task:";

export interface SubagentRequest {
  task: string;
  model?: string;
  description: string;
  /** As given: validated and normalised for code sessions by Subagents.run, ignored in chats. */
  paths?: unknown;
}

const Spec = z.object({
  model: z.string().trim().min(1, "model is empty").max(200, "model is too long").optional(),
  description: z.string().trim().min(1, "description is empty").max(MAX_SUBAGENT_DESCRIPTION, `description is longer than ${MAX_SUBAGENT_DESCRIPTION} characters`),
  task: z.string().trim().min(1, "task is empty").max(MAX_SUBAGENT_TASK, `task is longer than ${MAX_SUBAGENT_TASK} characters`),
  // Checked per session kind in Subagents.run (code: required; chats: ignored).
  paths: z.unknown().optional(),
});
const Input = z.object({
  agents: z
    .array(Spec, { message: "agents must be a list of subagents" })
    .min(1, "agents is empty")
    .max(MAX_SUBAGENTS_PER_CALL, `at most ${MAX_SUBAGENTS_PER_CALL} agents per call`),
});

/** Validates a run_subagents call. */
export function parseSubagentsInput(args: Record<string, unknown>): { ok: true; reqs: SubagentRequest[] } | { ok: false; error: string } {
  const r = Input.safeParse(args);
  if (!r.success) {
    const issues = r.error.issues.map((i) => (i.path[0] === "agents" && typeof i.path[1] === "number" ? `agent ${i.path[1] + 1}: ${i.message}` : i.message));
    return { ok: false, error: `Not started: ${issues.join("; ")}.` };
  }
  return { ok: true, reqs: r.data.agents.map(({ task, model, description, paths }) => ({ ...(model ? { model } : {}), description, task, ...(paths !== undefined ? { paths } : {}) })) };
}

/**
 * A code subagent's `paths`, normalised: trimmed, `.` and empty segments dropped (so `./src/` → `src`), duplicates
 * removed. Refused: missing, not a list of strings, an empty list, more than MAX_AREA_PATHS, empty patterns, absolute
 * paths (`/x`, `~/x`, `C:x`) and `..` segments.
 */
export function normalizeAreaPaths(raw: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: false, error: "paths is missing (the files it may change, as globs relative to the working directory)" };
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) return { ok: false, error: "paths must be a list of globs" };
  if (raw.length === 0) return { ok: false, error: "paths is empty" };
  if (raw.length > MAX_AREA_PATHS) return { ok: false, error: `paths has more than ${MAX_AREA_PATHS} patterns` };
  const out: string[] = [];
  const problems: string[] = [];
  for (const p of raw as string[]) {
    const t = p.trim();
    const shown = JSON.stringify(t);
    if (!t) problems.push("paths has an empty pattern");
    else if (t.length > MAX_AREA_PATH) problems.push(`a path is longer than ${MAX_AREA_PATH} characters`);
    else if (t.includes("\0")) problems.push(`path ${JSON.stringify(t.replace(/\0/g, ""))} is not a valid pattern`);
    else if (t.startsWith("/") || t.startsWith("\\") || t.startsWith("~") || /^[A-Za-z]:/.test(t)) problems.push(`path ${shown} is absolute (give it relative to the working directory)`);
    else {
      const segs = t.split("/").filter((x) => x !== "" && x !== ".");
      if (segs.includes("..")) problems.push(`path ${shown} leaves the working directory`);
      else if (segs.length === 0) problems.push(`path ${shown} is empty (use "**" for the whole working directory)`);
      else if (!out.includes(segs.join("/"))) out.push(segs.join("/"));
    }
  }
  return problems.length ? { ok: false, error: problems.join("; ") } : { ok: true, paths: out };
}

const GLOB_CHARS = /[*?]/;

/** One normalised area glob as a RegExp over workspace-relative POSIX paths: `**` any depth, `*` / `?` within a segment. */
function areaRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether `rel` (relative to the working directory, POSIX) is inside the area: it matches one of the globs, or a glob
 * without `*` / `?` names it or a folder above it (`src/web` covers `src/web/a.ts`).
 */
export function inArea(globs: readonly string[], rel: string): boolean {
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  return globs.some((g) => (GLOB_CHARS.test(g) ? areaRegExp(g).test(rel) : rel === g || rel.startsWith(`${g}/`)));
}

/** `abs` with symlinks resolved: the realpath of its deepest existing ancestor plus the rest (the file may not exist yet). */
export function realTarget(abs: string): string {
  let head = resolve(abs);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(abs);
      rest.unshift(basename(head));
      head = up;
    }
  }
}

/** The denial of a write outside a child's area. */
export function outsideAreaMessage(globs: readonly string[]): string {
  return `Outside your area (${globs.join(", ")}): leave this file and mention it in your answer.`;
}

/** The denial of a write to a file a sibling owns. */
export function ownedByMessage(ownerDescription: string): string {
  return `${ownerDescription} is editing this file: leave it and mention it in your answer.`;
}

/**
 * A child's first message: for a code child the hub's preamble (its area and the two rules), then the task; a chat's
 * child gets the task as is.
 */
export function subagentPrompt(task: string, paths: readonly string[] | null): string {
  if (!paths) return task;
  return [
    `Your area: ${paths.map((p) => `\`${p}\``).join(", ")} (globs relative to the working directory). Other subagents work in this directory at the same time, so:`,
    "- Change only files inside your area: edits outside it are refused. Keep files your shell commands write inside it too.",
    "- A file another subagent is already editing is refused to you until that subagent finishes.",
    "When a change is refused for either reason, leave that file and mention it in your answer.",
    "",
    SUBAGENT_TASK_HEADING,
    "",
    task,
  ].join("\n");
}

export function subagentTool(run: (reqs: SubagentRequest[]) => Promise<HubToolResult>, kind: "chat" | "code"): HubToolSpec {
  const what =
    kind === "chat"
      ? "Each subagent can only search the web and read web pages; it answers its research question."
      : "Each subagent works in this working directory with the same permissions (the user answers its permission cards here) and returns its answer plus the files it touched. Give each one `paths`: the files it may change; its edits outside them are refused, and a file one subagent is editing is refused to the others until it finishes, so make the areas not overlap.";
  return {
    name: SUBAGENT_TOOL,
    description: `Propose a batch of 1–${MAX_SUBAGENTS_PER_CALL} subagents, each running one task in a separate session. The user approves or declines the whole batch first; approved, they all start (subagents share all but ${SUBAGENT_RESERVED_SLOTS} of the server's process slots; the rest wait) and the call returns when all have finished: one section per agent in the given order, separated by "${SUBAGENT_SECTION_SEPARATOR}" lines. Put every subagent you need in one call. ${what} Give self-contained tasks: subagents do not see this conversation. Each stops after ${SUBAGENT_TIMEOUT_MS / 60_000} minutes.`,
    schema: {
      agents: z
        .array(
          z.object({
            model: z.string().optional().describe("Optional model id the user may use (e.g. sonnet, opus, haiku). Default: your own model."),
            description: z.string().describe(`A short label shown to the user, 3–8 words (at most ${MAX_SUBAGENT_DESCRIPTION} characters).`),
            task: z.string().describe(`The complete, self-contained task or question (at most ${MAX_SUBAGENT_TASK} characters).`),
            ...(kind === "code"
              ? {
                  paths: z
                    .array(z.string())
                    .describe(`Required: the files this subagent may change, 1–${MAX_AREA_PATHS} globs relative to the working directory (e.g. "src/web/**", "README.md"). Do not overlap other agents' paths.`),
                }
              : {}),
          }),
        )
        .describe(`The subagents to start (1–${MAX_SUBAGENTS_PER_CALL}).`),
    },
    handler: async (args): Promise<HubToolResult> => {
      const r = parseSubagentsInput(args);
      if (!r.ok) return { text: r.error, isError: true };
      return run(r.reqs);
    },
  };
}

/** The answer cut to `max` bytes (UTF-8), with a note when it was cut. */
export function truncateAnswer(text: string, sessionId: string, max = MAX_SUBAGENT_ANSWER_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return text;
  const note = `\n\n[Truncated: the answer was ${Math.ceil(bytes / 1024)} KB; only the first part is shown. The full answer is in session ${sessionId}.]`;
  const room = Math.max(0, max - Buffer.byteLength(note, "utf8"));
  // A cut through a multi-byte character decodes to U+FFFD: drop it.
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "");
  return head + note;
}

/** The tool result text: the session line, the answer, and (code) the files the child touched. */
export function subagentResultText(sessionId: string, answer: string, files: string[] = []): string {
  return `session: ${sessionId}\n\n${truncateAnswer(answer.trim(), sessionId)}${files.length ? `\n\nFiles: ${files.join(", ")}` : ""}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

/**
 * The child's final answer from its stored messages: the text of its last main-loop assistant message (the content
 * blocks of one message joined), else the result's text. A turn that ended in an error (or a dead process) is an error.
 */
export function finalAnswer(rows: Iterable<MessageRow>): { text: string; isError: boolean } {
  let lastId: string | null = null;
  let lastText = "";
  let result: { ok: boolean; text: string } | null = null;
  let died: string | null = null;
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.kind === "assistant" && !p.parent_tool_use_id) {
      const msg = (p.message ?? {}) as { id?: unknown; content?: unknown };
      const text = textOf(msg.content);
      if (!text.trim()) continue;
      const id = typeof msg.id === "string" ? msg.id : r.uuid;
      if (id === lastId) lastText += text;
      else {
        lastId = id;
        lastText = text;
      }
    } else if (r.kind === "result") {
      const errors = Array.isArray(p.errors) ? p.errors.map(String).join("; ") : "";
      result = { ok: p.is_error !== true, text: typeof p.result === "string" && p.result.trim() ? p.result : errors };
      died = null;
    } else if (r.kind === "system" && p.subtype === "hub_process_died") {
      died = typeof p.error === "string" && p.error ? p.error : "its process ended";
      result = null;
    }
  }
  const last = lastText.trim();
  if (result?.ok) {
    const text = last || result.text.trim();
    return text ? { text, isError: false } : { text: "The subagent finished without an answer.", isError: true };
  }
  const why = result ? result.text.trim() || "its turn ended with an error" : (died ?? "it ended before finishing its turn");
  return { text: `The subagent failed: ${why}${last ? `\n\nIts last message:\n${last}` : ""}`, isError: true };
}

/** What the subagent runner needs from the session runtime. */
export interface SubagentHost {
  session(id: string): SessionRow | null;
  /** The child's model and effort, or why the requested model is refused. */
  resolveModel(parent: SessionRow, model: string | undefined): { model: string; effort: EffortLevel | null } | { error: string };
  createChild(parent: SessionRow, c: { model: string; effort: EffortLevel | null; description: string }): SessionRow;
  /** Resolves when the session's next run ends (idle or dead after having been busy). Register before send(). */
  watch(sessionId: string): { done: Promise<void>; cancel(): void };
  send(sessionId: string, text: string): Promise<void>;
  /** Stops the session's turn (interrupt, then close after the grace period). */
  stop(sessionId: string): Promise<void>;
  /** The child is done: release its process. */
  release(sessionId: string): Promise<void>;
  messages(sessionId: string): Iterable<MessageRow>;
  /** Files the session's agent wrote, workspace-relative. */
  touchedFiles(sessionId: string): string[];
  taskStarted(parentId: string, task: BackgroundTask): void;
  taskEnded(parentId: string, taskId: string, status: "completed" | "failed" | "stopped"): void;
  now(): Date;
  /**
   * The person's answer to one batch: a permission request shown in the parent (never answered by mode or rules).
   * "cancelled" = the request ended without an answer other than by timeout (the turn stopped, the session closed).
   */
  approve(parent: SessionRow, input: RunSubagentsInput, signal: AbortSignal): Promise<{ answer: "allow" | "deny" | "cancelled" } | { answer: "timeout"; message: string }>;
}

/** Process slots that subagents never take, so normal conversations do not queue behind a batch. */
export const SUBAGENT_RESERVED_SLOTS = 2;

interface SlotWaiter {
  parentId: string;
  grant: () => void;
  abort: () => void;
}

interface RunningChild {
  parentId: string;
  stopped: boolean;
  description: string;
  area: string[] | null;
  /** Tool call id → the paths that call newly claimed. */
  claims: Map<string, string[]>;
}

const err = (text: string): HubToolResult => ({ text, isError: true });

export class Subagents {
  /** Running subagents on the whole server, and the batches' children waiting for one of their slots (FIFO). */
  private runningSlots = 0;
  private readonly waiters: SlotWaiter[] = [];
  /**
   * Running children: child id → parent id, whether it was stopped (by the parent's stop or the task stop route), its
   * label, its area (code: the normalised globs; chats: null) and the paths it claimed per tool call (writeRefused).
   */
  private readonly running = new Map<string, RunningChild>();
  /** Per parent: the files its running children own (symlink-resolved absolute path → child id). */
  private readonly owners = new Map<string, Map<string, string>>();
  /** Batches waiting for the person's approval, per parent (aborted when the parent's turn stops). */
  private readonly approvals = new Map<string, Set<AbortController>>();

  constructor(
    private readonly host: SubagentHost,
    /** `maxRunning`: server-wide subagent slots (the runtime passes max_active_processes − SUBAGENT_RESERVED_SLOTS). */
    private readonly opts: { timeoutMs?: () => number; maxRunning?: () => number } = {},
  ) {}

  /** The tool of one parent session. */
  tool(parent: Pick<SessionRow, "id" | "kind">): HubToolSpec {
    return subagentTool((reqs) => this.run(parent.id, reqs), parent.kind);
  }

  isRunning(childId: string): boolean {
    return this.running.has(childId);
  }

  /**
   * The write guard of a file-changing tool call of `sessionId` (targets absolute or relative to `cwdAbs`): null when
   * it may go on to the normal permission path (not a running code child, or every target is inside its area and
   * owned by no sibling; unowned targets are then claimed for it), else the denial text. Call it before any card.
   */
  checkWrite(sessionId: string, cwdAbs: string, targets: readonly unknown[], toolUseId?: string): string | null {
    const r = this.running.get(sessionId);
    if (!r?.area) return null;
    const paths = targets.filter((t): t is string => typeof t === "string" && t.trim() !== "");
    // A file-changing call whose target the hub cannot see is not let through.
    if (paths.length === 0) return outsideAreaMessage(r.area);
    const cwdReal = realTarget(cwdAbs);
    const reals: string[] = [];
    for (const p of paths) {
      let clean = p.trim();
      if (clean.startsWith("file://")) {
        try {
          clean = decodeURIComponent(clean.slice("file://".length));
        } catch {
          return outsideAreaMessage(r.area);
        }
      }
      const real = realTarget(resolve(cwdAbs, clean));
      if (!inArea(r.area, relative(cwdReal, real).split(sep).join("/"))) return outsideAreaMessage(r.area);
      reals.push(real);
    }
    let owned = this.owners.get(r.parentId);
    for (const real of reals) {
      const owner = owned?.get(real);
      if (owner && owner !== sessionId) return ownedByMessage(this.running.get(owner)?.description ?? "Another subagent");
    }
    if (!owned) this.owners.set(r.parentId, (owned = new Map()));
    const fresh = reals.filter((real) => !owned.has(real));
    for (const real of fresh) owned.set(real, sessionId);
    if (fresh.length && toolUseId) r.claims.set(toolUseId, [...(r.claims.get(toolUseId) ?? []), ...fresh]);
    return null;
  }

  /** The call `toolUseId` of `sessionId` was refused after checkWrite passed it (card denied, mode): drop its claims. */
  writeRefused(sessionId: string, toolUseId: string | undefined): void {
    const r = toolUseId ? this.running.get(sessionId) : undefined;
    const fresh = r?.claims.get(toolUseId!);
    if (!r || !fresh) return;
    r.claims.delete(toolUseId!);
    const owned = this.owners.get(r.parentId);
    for (const real of fresh) if (owned?.get(real) === sessionId) owned.delete(real);
    if (owned?.size === 0) this.owners.delete(r.parentId);
  }

  /** A child ended: it owns nothing any more. */
  private releaseOwnership(parentId: string, childId: string): void {
    const owned = this.owners.get(parentId);
    if (!owned) return;
    for (const [path, owner] of owned) if (owner === childId) owned.delete(path);
    if (owned.size === 0) this.owners.delete(parentId);
  }

  /** The person stopped a running child (its own Stop, or the parent's task stop route): it ends as "stopped". */
  markStopped(childId: string): void {
    const r = this.running.get(childId);
    if (r) r.stopped = true;
  }

  /** Stops one running child of `parentId` (task stop route). False when it is not one. */
  async stopChild(parentId: string, childId: string): Promise<boolean> {
    const r = this.running.get(childId);
    if (!r || r.parentId !== parentId) return false;
    r.stopped = true;
    await this.host.stop(childId);
    return true;
  }

  /**
   * The parent's turn stopped (or its process ended): batches waiting for approval or a slot give up (nothing more
   * starts) and running children stop.
   */
  stopAll(parentId: string): void {
    for (const ac of this.approvals.get(parentId) ?? []) ac.abort();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.parentId === parentId) this.waiters.splice(i, 1)[0]!.abort();
    }
    for (const [childId, r] of this.running) {
      if (r.parentId !== parentId || r.stopped) continue;
      r.stopped = true;
      void this.host.stop(childId).catch(() => undefined);
    }
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs?.() ?? SUBAGENT_TIMEOUT_MS;
  }

  /** Server-wide subagent slots (at least 1). */
  private maxRunning(): number {
    return Math.max(1, this.opts.maxRunning?.() ?? Number.POSITIVE_INFINITY);
  }

  /**
   * A server-wide subagent slot for a child of `parentId`: "ok", or "stopped" when the parent's turn stopped while
   * waiting. No timeout of its own: every running child ends within its timeout, so a slot always frees up.
   */
  private acquire(parentId: string): Promise<"ok" | "stopped"> {
    if (this.waiters.length === 0 && this.runningSlots < this.maxRunning()) {
      this.runningSlots++;
      return Promise.resolve("ok");
    }
    return new Promise((resolve) => {
      this.waiters.push({
        parentId,
        grant: () => {
          this.runningSlots++;
          resolve("ok");
        },
        abort: () => resolve("stopped"),
      });
    });
  }

  private releaseSlot(_parentId: string): void {
    this.runningSlots = Math.max(0, this.runningSlots - 1);
    while (this.waiters.length > 0 && this.runningSlots < this.maxRunning()) this.waiters.shift()!.grant();
  }

  /**
   * One run_subagents call of `parentId`: validates every agent's model, asks the person once for the whole batch,
   * then runs all children (server-wide subagent slots; the rest wait) and returns one section per agent in input order.
   */
  async run(parentId: string, reqs: SubagentRequest[]): Promise<HubToolResult> {
    const parent = this.host.session(parentId);
    if (!parent) return err("This session no longer exists.");
    if (parent.parentSessionId) return err("A subagent cannot start subagents of its own.");
    if (reqs.length === 0) return err("Not started: agents is empty.");
    const models: { model: string; effort: EffortLevel | null }[] = [];
    // Code: each agent's area (normalised); chats' subagents cannot write, so their `paths` are ignored.
    const areas: (string[] | null)[] = [];
    const problems: string[] = [];
    reqs.forEach((req, i) => {
      const why: string[] = [];
      const r = this.host.resolveModel(parent, req.model);
      if ("error" in r) why.push(r.error.replace(/^Not started: /, "").replace(/\.$/, ""));
      else models.push(r);
      if (parent.kind === "code") {
        const a = normalizeAreaPaths(req.paths);
        if (a.ok) areas.push(a.paths);
        else why.push(a.error);
      } else areas.push(null);
      if (why.length) problems.push(reqs.length > 1 ? `agent ${i + 1} (${req.description}): ${why.join("; ")}` : why.join("; "));
    });
    if (problems.length) return err(`Not started: ${problems.join("; ")}.`);

    // One card for the batch, with the models and (code) the normalised areas filled in (what will actually run).
    const input: RunSubagentsInput = {
      agents: reqs.map((req, i) => ({ model: models[i]!.model, description: req.description, task: req.task, ...(areas[i] ? { paths: areas[i]! } : {}) })),
    };
    const ac = new AbortController();
    let batches = this.approvals.get(parentId);
    if (!batches) this.approvals.set(parentId, (batches = new Set()));
    batches.add(ac);
    try {
      let answer: Awaited<ReturnType<SubagentHost["approve"]>>;
      try {
        answer = await this.host.approve(parent, input, ac.signal);
      } catch (e) {
        return err(`Not started: ${errorMessage(e)}`);
      }
      if (ac.signal.aborted || answer.answer === "cancelled") return err("Not started: the turn was stopped.");
      if (answer.answer === "timeout") return err(answer.message);
      if (answer.answer !== "allow") return err(SUBAGENTS_DECLINED);
      const results = await Promise.all(reqs.map((req, i) => this.runOne(parent, req, models[i]!, areas[i]!, ac.signal)));
      const text = results.map((r) => (typeof r === "string" ? r : r.text)).join(`\n\n${SUBAGENT_SECTION_SEPARATOR}\n\n`);
      // An error only when nothing succeeded (the sections say which ones failed).
      return { text, isError: results.every((r) => typeof r !== "string" && !!r.isError) };
    } finally {
      batches.delete(ac);
      if (batches.size === 0 && this.approvals.get(parentId) === batches) this.approvals.delete(parentId);
    }
  }

  /** One approved child: waits for a slot, runs the child to completion, returns its section. */
  private async runOne(parent: SessionRow, req: SubagentRequest, resolved: { model: string; effort: EffortLevel | null }, area: string[] | null, batch: AbortSignal): Promise<HubToolResult> {
    const parentId = parent.id;
    const timeoutMs = this.timeoutMs();
    const minutes = Math.round(timeoutMs / 60_000);
    const slot = await this.acquire(parentId);
    if (slot === "stopped") return err("Not started: the turn was stopped.");
    if (batch.aborted) {
      this.releaseSlot(parentId);
      return err("Not started: the turn was stopped.");
    }

    let child: SessionRow;
    try {
      child = this.host.createChild(parent, { model: resolved.model, effort: resolved.effort, description: req.description });
    } catch (e) {
      this.releaseSlot(parentId);
      return err(`Not started: ${errorMessage(e)}`);
    }
    const state: RunningChild = { parentId, stopped: false, description: req.description, area, claims: new Map() };
    this.running.set(child.id, state);
    this.host.taskStarted(parentId, {
      taskId: child.id,
      type: SUBAGENT_TASK_TYPE,
      description: req.description,
      subagentType: child.model,
      startedAt: this.host.now().toISOString(),
      status: "running",
      endedAt: null,
    });
    let end: "completed" | "failed" | "stopped" = "failed";
    const fail = (text: string): HubToolResult => ({ text: subagentResultText(child.id, text), isError: true });
    try {
      const watch = this.host.watch(child.id);
      try {
        await this.host.send(child.id, subagentPrompt(req.task, area));
      } catch (e) {
        watch.cancel();
        return fail(`The subagent could not start: ${errorMessage(e)}`);
      }
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        watch.done.then(() => true),
        new Promise<false>((res) => {
          timer = setTimeout(() => res(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!finished) {
        watch.cancel();
        state.stopped = true;
        await this.host.stop(child.id).catch(() => undefined);
        return fail(`The subagent did not finish within ${minutes} minutes and was stopped.`);
      }
      if (state.stopped) {
        end = "stopped";
        return fail("The subagent was stopped before it finished.");
      }
      const answer = finalAnswer(this.host.messages(child.id));
      end = answer.isError ? "failed" : "completed";
      const files = parent.kind === "code" ? this.host.touchedFiles(child.id) : [];
      return { text: subagentResultText(child.id, answer.text, files), isError: answer.isError };
    } finally {
      this.running.delete(child.id);
      this.releaseOwnership(parentId, child.id);
      this.host.taskEnded(parentId, child.id, end);
      this.releaseSlot(parentId);
      void this.host.release(child.id).catch(() => undefined);
    }
  }
}
