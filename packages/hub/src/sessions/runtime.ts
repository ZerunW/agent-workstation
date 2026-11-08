/**
 * Session service — the heart of the hub.
 *
 * A session is a row in SQLite plus a `claude_session_id`. The Claude Code
 * process is a disposable cache: it is spawned lazily (always through the
 * same `resume` path) when a message arrives, reaped after `idle_minutes`,
 * and can be evicted while idle when the pool is full. One live process per
 * session (and per Claude session id) at most.
 *
 * Message flow:
 *   POST message → persist user row (delivery=pending, our uuid) → hub-side FIFO
 *   → slot from the pool (or queued with a position) → spawn/resume → feed one
 *   message per turn → persist SDK messages as they stream → `result` ends the
 *   turn → feed the next one or start the idle timer.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  Attachment,
  UserMessageMeta,
  BackgroundTask,
  ContextUsage,
  EffortLevel,
  NextStep,
  PermissionMode,
  PermissionResponse,
  Session,
  SessionKind,
  SessionSettings,
  SessionSnapshot,
  SessionStatus,
  StoredMessage,
  StoredMessageKind,
  StreamDelta,
} from "@agent-workstation/protocol";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { MAX_PINS, storedMessageJson, type MessageRow, type SessionPatch, type SessionRow, type Store } from "../db/store.js";
import { isPrompt, parsePayload, promptTextOf, resendTurn, resumePoint } from "./rewind.js";
import { toRelPath } from "../files/paths.js";
import { billingEnv, isCreditBalanceText } from "../billing.js";
import type { ApiCredential, ApiCredentials } from "../keyProxy.js";
import { MEMORY_SERVER } from "../memory.js";
import { badRequest, errorMessage, HttpError, notFound } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import { uuid as newUuid } from "../util/ids.js";
import { childLogger, type Logger } from "../util/log.js";
import { iso, settlesWithin, type Clock, systemClock } from "../util/time.js";
import type { Broadcaster } from "../ws/protocol.js";
import type { AgentExec } from "./agentExec.js";
import type { Catalog } from "./catalog.js";
import { deleteTranscripts, RETENTION_DAYS } from "./claudeFiles.js";
import { breakdownFromCli, contextWindowFor, DEFAULT_CONTEXT_WINDOW, estimateTokens, primaryModel, requestContextTokens } from "./context.js";
import { PermissionBroker, type PermissionResult } from "./permissions.js";
import { ProcessPool } from "./pool.js";
import { buildUserTurn, titleFromText } from "./prompt.js";
import { PushQueue } from "./pushQueue.js";
import type { HubQuery, HubToolSpec, SdkContextUsage, SDKMessage, SdkDeps, SdkOptions, SDKUserMessage, SessionMessage } from "./sdk.js";
import { TurnCost, type TurnPricer } from "./turnCost.js";
import { TurnTokens } from "./turnTokens.js";
import { computeUsageDelta, parseCumulative, type UsageDelta, type UsageLimitsService } from "./usage.js";
import { DOCS_SERVER, docsTool, type DocsReader } from "./docs.js";
import { bashSuggestion, HISTORY_SERVER } from "./hubTools.js";
import { DOWNLOAD_SERVER, DOWNLOAD_TOOL_NAME, type DownloadApproval, type DownloadService } from "./download.js";
import { SUBAGENT_RESERVED_SLOTS, SUBAGENT_SERVER, SUBAGENT_TASK_TYPE, SUBAGENT_TOOL_NAME, Subagents, type SubagentHost } from "./subagents.js";
import { TIMEOUT_DENY_MESSAGE } from "./permissions.js";
import { ATTACHMENT_READ_DENIED, attachmentReadPath } from "./attachments.js";
import { VISUAL_SERVER, visualTool } from "./visual.js";
import { HEADS_UP_TOOL_NAME, headsUpTool, TURN_SERVER, wrapUpTool } from "./turn.js";
import { instructionsSection, readProjectInstructions } from "./projectContext.js";
import { dateLine, workstationGuide, INCOGNITO_NOTE, knownHeadsUpsSection, userInstructionsSection, type GuideContext } from "./guide.js";
import {
  BROWSER_DIR_DENIED,
  BROWSER_SERVER,
  browserSiteTarget,
  browserToolClass,
  browserVerdict,
  CLAUDE_FILE_TOOLS,
  claudeFileToolPaths,
  touchesBrowserDir,
  type SessionBrowser,
} from "./browserTools.js";
import { BrowserSites, type SiteDecision } from "./browserSites.js";
import { claudeProcessOptions, newProcessTmpDir } from "./processTmp.js";
import {
  CHAT_DIR,
  CHAT_EXEC_TOOLS,
  CHAT_FILE_TOOLS,
  CHAT_FOLDER_DENIED,
  chatCommandEnv,
  chatFileToolPaths,
  chatFolderAllows,
  chatFolderRel,
  chatHostAllowed,
  chatSandbox,
  filesChangedSince,
  insideChatFolder,
  isChatFolder,
  removeChatFolder,
} from "./chatFolder.js";
import {
  CODE_COMMAND_CWD_DENIED,
  CODE_FILE_TOOLS,
  CODE_FOLDER_DENIED,
  CODE_NETWORK_DENIED,
  CODE_HOST_NO_ASK,
  CODE_UNSANDBOXED_DENIED,
  CODE_WRITE_TOOLS,
  codeCommandEnv,
  codeFileToolPaths,
  codeFolderAllows,
  codeReadDirs,
  codeSandbox,
  insideCwd,
  knownDevHost,
  PROJECT_SETTINGS_DENIED,
  publicHostVerdict,
  strictNetworkMode,
  touchesProjectSettings,
  toolLimitEnv,
  type HostResolver,
} from "./codeSandbox.js";
import { OUTBOUND_DENIED, OUTBOUND_NO_ASK, outboundCommand } from "./outbound.js";

/** The agent-facing wording lives in guide.ts; re-exported for the callers that imported it from here. */
export { dateLine, INCOGNITO_NOTE };

/** Built-in Claude Code tools of a Chat session: web search and page reading; Read joins once files are attached. */
export const CHAT_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

/**
 * System prompt of a Claude Chat session: the Agent Workstation guide for a chat (web search and page reading always; with
 * `memory`, the memory tools; with `history`, the past-conversation tools; with `read`, the Read tool for the attached
 * files; with `exec`, its own folder `cwdAbs` with sandboxed commands and file tools; with `browser`, the read-only
 * server browser tools; with `subagents`, run_subagents; show_visual), then the user's instructions, the heads-ups they
 * already know (`knownHeadsUps`, the section) and the saved memories.
 * `subagent`: the chat is itself a (research-only) subagent.
 */
export function chatSystemPrompt(
  memory: { section: string | null } | null,
  history = false,
  o: { read?: boolean; exec?: boolean; download?: boolean; incognito?: boolean; now?: Date; browser?: boolean; subagents?: boolean; subagent?: boolean; cwdAbs?: string; instructions?: string; knownHeadsUps?: string | null; docs?: boolean } = {},
): string {
  const guide = workstationGuide({
    kind: "chat",
    memory: !!memory,
    history,
    incognito: !!o.incognito,
    browser: !!o.browser,
    readAttachments: !!o.read,
    chatExec: !!o.exec,
    download: !!o.exec && !!o.download,
    agentAccount: false,
    memoryGiB: null,
    cwdAbs: o.cwdAbs ?? "",
    cwdRel: CHAT_DIR,
    projectName: null,
    subagents: !!o.subagents,
    subagent: !!o.subagent,
    docs: !!o.docs,
    now: o.now ?? new Date(),
  });
  return [guide, userInstructionsSection(o.instructions ?? ""), o.knownHeadsUps, memory?.section].filter((x): x is string => !!x).join("\n\n");
}

/** Total memory of the server in GiB (the guide's "N GB in all"); null when it cannot be told. */
function serverMemoryGiB(): number | null {
  const gib = Math.round(totalmem() / 2 ** 30);
  return gib > 0 ? gib : null;
}

const CHAT_TOOL_DENIED = "In this chat you can search the web, read web pages, open the files the user attached and show visuals; nothing else is available.";
const CHAT_EXEC_TOOL_DENIED =
  "In this chat you can search the web, read web pages, run code and use files in the chat's own folder, open the files the user attached and show visuals; nothing else is available.";
/** The permission request Claude Code's sandbox sends for a host outside `allowedDomains` (input `{ host }`). */
const SANDBOX_NETWORK_TOOL = "SandboxNetworkAccess";
const CHAT_NETWORK_DENIED = "Commands in this chat can only reach PyPI; to get a file from the internet use download_file.";
const RESEARCH_TOOL_DENIED = "As a research subagent you can only search the web and read web pages; nothing else is available.";

/** Waits for `p` at most `ms`; null on timeout or rejection. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const CONTEXT_USAGE_TIMEOUT_MS = 3000;

const TOUCH_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const TOUCH_TOOL_SET = new Set(TOUCH_TOOLS.split("|"));

/**
 * What the session runtime needs from the projects module (implemented by
 * ProjectService). Paths are relative to the user root.
 */
export interface SessionProjects {
  /** The project whose work tree contains `rel`, with the path inside it ("" = the project root). */
  projectForPath(user: string, rel: string): { id: string; inner: string } | null;
  projectIdForCwd(user: string, cwd: string): string | null;
  /** PreToolUse of a write tool inside a project: take the project lock (bounded wait). */
  beforeWrite(toolUseId: string, sessionId: string, projectId: string): Promise<void>;
  /** PostToolUse / PostToolUseFailure / PermissionDenied. */
  releaseTool(toolUseId: string | undefined): void;
  /** While a permission prompt is pending: release, and return a re-acquire function (null = no hold). */
  suspendHold(toolUseId: string | undefined): (() => Promise<void>) | null;
  releaseSession(sessionId: string): void;
  /** `result`: release holds, snapshot the projects the turn worked in, announce review_changed. */
  turnEnded(t: { sessionId: string; turn: number; message: string; projectIds: string[] }): void;
  /** Something in the project changed (debounced review_changed). */
  changed(projectId: string): void;
  /**
   * Rewind with files: the turn snapshot `turn` of `sessionId` (refs/snapshots/<sessionId>/<turn>) in the synced project
   * whose work tree holds `cwd`; null when `cwd` is not in a synced project or there is no such snapshot.
   */
  turnSnapshot?(user: string, cwd: string, sessionId: string, turn: number): Promise<string | null>;
  /** Puts the work tree of the project holding `cwd` back to `ref` through the project's restore (refs/trash first). */
  restoreSnapshot?(user: string, cwd: string, ref: string): Promise<{ trashRef: string }>;
}

/** What the runtime needs from the memory module (implemented by MemoryService). */
export interface MemoryLike {
  enabled(user: string): boolean;
  /** Bumped on every change of the user's memories. */
  version(user: string): number;
  /** The system-prompt section listing the memories (null when there are none or memory is off). */
  promptSection(user: string): string | null;
  /** Chat sessions: the in-process `remember` / `forget` tools. */
  tools(user: string, sessionId: string): HubToolSpec[];
}

export interface SessionServiceDeps {
  store: Store;
  sdk: SdkDeps;
  bus: Broadcaster;
  log: Logger;
  limits: {
    maxActiveProcesses: () => number;
    minFreeMemMib: () => number;
    idleMs: () => number;
    permissionTimeoutMs: () => number;
    /** Grace after interrupt() before the process is closed (default 10 s). */
    stopGraceMs?: number;
  };
  memAvailableMiB: () => number;
  /** Absolute workspace root of a user (must exist). */
  userRoot: (user: string) => string;
  claudeExecutable?: string;
  /** `[agents] run_as`: Claude processes start through the agent wrapper. */
  agentExec?: AgentExec;
  /** Wrap the CLI spawn to learn its pid (RSS in admin overview). Default true; tests pass false. */
  captureProcess?: boolean;
  catalog?: Catalog;
  usageLimits?: UsageLimitsService;
  /** Where Claude keeps transcripts (deleted only on explicit session delete). */
  claudeHome?: string;
  /** After usage rows were written for a user (weekly-limit warnings). */
  onUsageRecorded?: (user: string) => void;
  extraEnv?: Record<string, string>;
  clock?: Clock;
  /** Projects integration (lock holds, file touches, turn snapshots, Session.projectId). */
  projects?: SessionProjects;
  /**
   * Extra `additionalDirectories` for a code session (skills discovery when the cwd sits
   * inside a nested git repository, where Claude Code stops walking up for `.claude/skills`).
   */
  skillDirs?: (user: string, cwdAbs: string) => string[];
  /**
   * Plugin directories of a code session that loads no settings files (`projectSettings` off): the user's and global
   * skills and the project's own skills, commands and agents, as generated plugins (skills/service.ts).
   */
  projectPlugins?: (user: string, cwdAbs: string) => string[];
  /** Per-user memories (Chat: prompt + remember/forget tools; Code: appended to the prompt, read-only). */
  memories?: MemoryLike;
  /** The user's own instructions for every agent (`User.instructions`, "" = none), placed after the Agent Workstation guide. */
  instructions?: (user: string) => string;
  /** The heads-ups the user marked as already known, newest first (listed after the instructions, incognito too). */
  knownHeadsUps?: (user: string) => string[];
  /** Past-conversation tools (search_conversations / read_conversation) for non-incognito sessions. */
  history?: { tools(user: string, sessionId: string): HubToolSpec[] };
  /** API-credit billing (absent = the budget is not checked; processes still need `apiProxy`). */
  billing?: RuntimeBilling;
  /**
   * The loopback API key proxy: every Claude process gets a per-process token for it instead of the key (absent =
   * processes cannot start).
   */
  apiProxy?: ApiCredentials;
  /** After a turn was accounted (usage_limits broadcast, budget notices). */
  onApiUsage?: (user: string) => void;
  /** The hub's price table for the live cost estimate of a running turn (absent = the built-in prices). */
  pricing?: TurnPricer;
  /** A turn ended and nothing is queued (session summaries). */
  onTurnIdle?: (sessionId: string) => void;
  /** A session was deleted (summary timers). */
  onSessionDeleted?: (sessionId: string) => void;
  /** The server browser's MCP endpoint and control state (absent = no browser tools). */
  browser?: SessionBrowser;
  /**
   * Whether `user` may run `model` for a subagent (the allowlist and model catalog of session creation).
   * Absent = every model.
   */
  subagentModelAllowed?: (user: string, model: string) => boolean;
  /** How long a subagent may run, and wait for a slot (default 30 minutes; tests shorten it). */
  subagentTimeoutMs?: () => number;
  /** Chats' download_file (download.ts); absent = chats have no download tool. */
  downloads?: DownloadService;
  /** Resolves the host of a code session's sandbox network request (default: the system resolver; tests fake it). */
  resolveHost?: HostResolver;
  /** Agent Workstation's readme pages for `read_workstation_docs` (docs.ts); absent = sessions have no docs tool. */
  docs?: DocsReader;
  /**
   * Memory cap (MiB) of the commands of Claude chat-folder and code sessions (CLAUDE_CODE_TOOL_MEMORY_LIMIT in the
   * inline settings' `env`); 0 / absent = none.
   */
  toolMemoryLimitMb?: () => number;
  /**
   * Whether code sessions read the project's own settings files (`.claude/settings.json`, `.mcp.json`; config
   * `[sessions] project_settings`): `settingSources: ["project"]`, hooks and MCP servers on. Absent / false = they are
   * not read at all (`settingSources: []`, hooks disabled, only the hub's own MCP servers): the hub then passes the
   * project's CLAUDE.md files in the system prompt (projectContext.ts) and its skills, commands and agents as plugins.
   */
  projectSettings?: () => boolean;
}

/** What the runtime needs from the billing service (implemented by BillingService). */
export interface RuntimeBilling {
  apiKey(): string | null;
  available(): boolean;
  overBudget(): boolean;
  /** 503 api_unavailable / 429 api_limit_reached before a turn. */
  assertCanSend(): void;
  /** 503 api_unavailable without a key or budget. */
  assertAvailable(): void;
  markCreditsExhausted(): void;
}

interface PartialState {
  messageId: string | null;
  text: string;
  thinking: string;
  currentTool: { toolUseId: string; toolName: string; partialJson: string } | null;
}

const emptyPartial = (): PartialState => ({ messageId: null, text: "", thinking: "", currentTool: null });

interface Proc {
  q: HubQuery;
  input: PushQueue<SDKUserMessage>;
  token: number;
  gen: number;
  startedAt: string;
  pid: number | null;
  stderrTail: string;
  closedByHub: boolean;
  initPersisted: boolean;
  catalogFetched: boolean;
  done: Promise<void>;
  /** Memory state (`enabled:version`) the system prompt was built from; null without a memory module. */
  memoryKey: string | null;
  /** The memory section in the system prompt (its size is reported as "Memory" in the context breakdown). */
  memorySection: string | null;
  /** The user's instructions the prompt was built with (a change recycles an idle process before the next turn). */
  instructions: string;
  /** The known heads-ups section the prompt was built with (null = none; a change recycles an idle process too). */
  knownHeadsUps: string | null;
  /** Its API key proxy token (revoked when it ends). */
  apiToken: string | null;
  /** Incognito session: no memory section (memory changes never recycle it). */
  incognito: boolean;
  /** The API's "credit balance is too low" was already reported for the current turn. */
  creditNoticeSent: boolean;
  /** Chat: started with the Read tool (the session had file attachments); a first attachment recycles it. */
  chatRead: boolean;
  /**
   * Code session: whether its sandbox runs with the strict allowlist of known hosts (auto / bypassPermissions /
   * dontAsk, codeSandbox.ts strictNetworkMode); a mode change across the groups recycles it before the next turn.
   * null for other processes.
   */
  strictNetwork: boolean | null;
  /** Bash calls whose outbound card the person allowed in PreToolUse (canUseTool then does not ask again). */
  outboundAllowed: Set<string>;
  /**
   * The person chose a strict-network mode the hub did not switch this process into (updateSettings): its own mode
   * reports are not written back (they would undo the choice); it is restarted before its next turn.
   */
  modeDeferred: boolean;
}

/** One entry of the SDK's `background_tasks_changed` list. */
interface SdkBackgroundTask {
  task_id: string;
  task_type: string;
  description: string;
  subagent_type?: string;
}

type TaskEnd = "completed" | "failed" | "stopped";

/** How many ended background tasks a session keeps (the oldest go first). */
export const MAX_ENDED_TASKS = 300;
/** Rewound seq ranges a snapshot carries (the newest kept). */
export const MAX_REWOUND_RANGES = 100;

/**
 * Background tasks of one session, kept in memory across process recycles (not across hub restarts): the running ones
 * (the SDK's current list) and the ended ones, in first-seen order (newest last).
 */
interface SessionTasks {
  list: BackgroundTask[];
  /** How a task ended according to the SDK's task_notification (applied when it leaves the list). */
  notified: Map<string, TaskEnd>;
  /** Tasks the user stopped through the stop route. */
  stopRequested: Set<string>;
}

const isRunning = (t: BackgroundTask): boolean => (t.status ?? "running") === "running";

/** The SDK's task_notification status → how the task ended (null = not an end). */
function taskEndOf(status: unknown): TaskEnd | null {
  switch (typeof status === "string" ? status.toLowerCase() : "") {
    case "completed":
    case "success":
    case "succeeded":
    case "done":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
    case "canceled":
    case "aborted":
      return "stopped";
    default:
      return null;
  }
}

/** A stored NextStep (JSON column) or null. */
function parseNextStep(json: string | null): NextStep | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as NextStep;
    return v && typeof v === "object" && typeof v.recap === "string" ? v : null;
  } catch {
    return null;
  }
}

interface PendingInput {
  uuid: string;
  msg: SDKUserMessage;
}

interface Live {
  id: string;
  user: string;
  kind: SessionKind;
  proc: Proc | null;
  pending: PendingInput[];
  turn: { userUuid: string | null; startedAt: number } | null;
  waitingSlot: boolean;
  spawning: boolean;
  /** Completion of the most recent process (one-process-per-session lock). */
  exiting: Promise<void> | null;
  dead: boolean;
  partial: PartialState;
  idleTimer: NodeJS.Timeout | null;
  stopWaiters: (() => void)[];
  lastActivity: number;
  lastStatusKey: string;
  /** Projects written by Write/Edit tools during the current turn (snapshotted at `result`). */
  turnProjects: Set<string>;
  /** Live output-token counter of the current turn. */
  tokens: TurnTokens;
  /** Live list-price cost estimate of the current turn. */
  cost: TurnCost;
  /** Turn cost of the last cost_update (-1 = none yet this turn). */
  costSent: number;
  /** Context of the turn's last main-loop request (reset when a turn starts). */
  lastRequest: { tokens: number; model: string | null } | null;
  /** Bumped per context-usage refresh so a slow refresh never overwrites a newer one. */
  contextSeq: number;
}

export interface CreateSessionParams {
  user: string;
  kind: SessionKind;
  title?: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  hidden?: boolean;
  /** Incognito chat (chat sessions only). */
  incognito?: boolean;
  /** A subagent's session: the session that started it. */
  parentSessionId?: string;
}

export interface SendResult {
  state: "accepted" | "queued";
  position: number | null;
  seq: number;
}

export interface LiveProcessInfo {
  sessionId: string;
  user: string;
  kind: SessionKind;
  status: SessionStatus;
  pid: number | null;
  startedAt: string;
  lastActiveAt: string;
}

type StreamEventLike = {
  type: string;
  message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
  /** message_delta: cumulative usage of the message so far. */
  usage?: { output_tokens?: number; input_tokens?: number | null };
};

const LOCAL_COMMAND_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function parseContextUsage(json: string | null): ContextUsage | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as ContextUsage;
    return v && typeof v === "object" && typeof v.usedTokens === "number" ? v : null;
  } catch {
    return null;
  }
}

export class SessionService {
  readonly pool: ProcessPool;
  readonly permissions: PermissionBroker;
  /** Per-website permission of the server browser (stored grants + "allow this session"). */
  readonly browserSites: BrowserSites;
  private readonly lives = new Map<string, Live>();
  private readonly claudeLocks = new Map<string, Promise<void>>();
  private gen = 0;
  private shuttingDown = false;
  private readonly clock: Clock;
  /** Attachment paths (relative to the user root) per session, loaded lazily from the stored messages. */
  private readonly attachmentCache = new Map<string, Set<string>>();
  /** Hosts the person allowed on a card for a code session's sandbox (session id → hosts; in memory). */
  private readonly sessionHosts = new Map<string, Set<string>>();
  /** Background tasks per session (running and ended); outlives the Live entry, dropped on session delete. */
  private readonly taskState = new Map<string, SessionTasks>();
  /** Agent Workstation's run_subagents: child sessions run to completion. */
  readonly subagents: Subagents;
  /** Sessions whose next run someone waits for (a subagent's parent): called once it went busy and is idle/dead again. */
  private readonly runWatchers = new Map<string, { busy: boolean; done: () => void }>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.subagents = new Subagents(this.subagentHost(), {
      ...(deps.subagentTimeoutMs ? { timeoutMs: deps.subagentTimeoutMs } : {}),
      // all subagents on the server share the pool minus the slots reserved for normal conversations
      maxRunning: () => deps.limits.maxActiveProcesses() - SUBAGENT_RESERVED_SLOTS,
    });
    this.pool = new ProcessPool({
      max: deps.limits.maxActiveProcesses,
      minFreeMiB: deps.limits.minFreeMemMib,
      memAvailableMiB: deps.memAvailableMiB,
      reclaimIdle: (except) => this.reclaimIdle(except),
      onQueueChanged: (owners) => owners.forEach((o) => this.refresh(o)),
      log: deps.log,
    });
    this.permissions = new PermissionBroker({
      store: deps.store,
      bus: deps.bus,
      timeoutMs: deps.limits.permissionTimeoutMs,
      log: deps.log,
      onChange: (id) => this.refresh(id),
      clock: this.clock,
      // A subagent's cards show in its parent's view.
      subagentOf: (id) => {
        const row = deps.store.getSession(id);
        return row?.parentSessionId ? { parentSessionId: row.parentSessionId, description: row.title } : null;
      },
    });
    this.browserSites = new BrowserSites({ store: deps.store, permissions: this.permissions, log: deps.log, clock: this.clock });
  }

  // ------------------------------------------------------------------ CRUD

  create(p: CreateSessionParams): SessionRow {
    const title = p.title?.trim() || (p.kind === "chat" ? "New chat" : "New session");
    if (p.incognito && p.kind !== "chat") throw badRequest("invalid_request", "only chat sessions can be incognito");
    const id = newUuid();
    return this.deps.store.insertSession({
      id,
      user: p.user,
      kind: p.kind,
      title,
      // A new chat works in a folder of its own (chatFolder.ts); its subagents (and forks) inherit their source's cwd.
      cwd: p.kind === "chat" && !p.parentSessionId && p.cwd === CHAT_DIR ? chatFolderRel(id) : p.cwd,
      model: p.model,
      permissionMode: p.kind === "chat" ? "dontAsk" : p.permissionMode,
      effort: p.effort,
      createdAt: iso(this.clock()),
      hidden: p.hidden ?? false,
      incognito: !!p.incognito,
      parentSessionId: p.parentSessionId ?? null,
    });
  }

  get(id: string): SessionRow | null {
    return this.deps.store.getSession(id);
  }

  /** Absolute working directory: the user's root, plus the session's relative cwd. */
  private cwdAbsOf(row: Pick<SessionRow, "user" | "cwd">): string {
    const root = this.deps.userRoot(row.user);
    return row.cwd ? join(root, row.cwd) : root;
  }

  toProtocol(row: SessionRow): Session {
    const live = this.lives.get(row.id);
    const { status, queuePosition } = live ? this.computeStatus(live) : { status: row.status === "dead" ? ("idle" as const) : row.status, queuePosition: null };
    return {
      id: row.id,
      user: row.user,
      kind: row.kind,
      title: row.title,
      cwd: row.cwd,
      cwdAbs: this.cwdAbsOf(row),
      model: row.model,
      permissionMode: row.permissionMode,
      effort: row.effort,
      status,
      queuePosition,
      claudeSessionId: row.claudeSessionId,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      lastSeq: row.lastSeq,
      costUsd: Math.max(0, row.costUsd),
      projectId: row.kind === "code" ? (this.deps.projects?.projectIdForCwd(row.user, row.cwd) ?? null) : null,
      contextUsage: parseContextUsage(row.contextUsage),
      incognito: row.incognito,
      parentSessionId: row.parentSessionId,
      ...(row.notify ? {} : { notify: false }),
      ...(row.pinnedMessages.length ? { pinnedMessages: [...row.pinnedMessages] } : {}),
    };
  }

  /** The session's notification switch (Mac app notifications); every client hears it via session_updated. */
  setNotify(id: string, notify: boolean): Session {
    const row = this.deps.store.updateSession(id, { notify });
    if (!row) throw notFound();
    const s = this.toProtocol(row);
    this.deps.bus.toUser(row.user, { type: "session_updated", session: s });
    return s;
  }

  rename(id: string, title: string): Session {
    const row = this.deps.store.updateSession(id, { title: title.trim() || "Untitled" });
    if (!row) throw notFound();
    const s = this.toProtocol(row);
    this.deps.bus.toUser(row.user, { type: "session_updated", session: s });
    return s;
  }

  snapshot(id: string): SessionSnapshot {
    const row = this.deps.store.getSession(id);
    if (!row) throw notFound();
    const live = this.lives.get(id);
    const p = live?.partial ?? emptyPartial();
    const turn = live?.turn ?? null;
    const snap: SessionSnapshot = {
      session: this.toProtocol(row),
      partial: {
        messageId: p.messageId,
        text: p.text,
        thinking: p.thinking,
        currentTool: p.currentTool ? { ...p.currentTool } : null,
        turnOutputTokens: turn && live ? live.tokens.total : 0,
      },
      turnStartedAt: turn ? new Date(turn.startedAt).toISOString() : null,
      pendingPermission: this.permissions.pendingFor(id)[0] ?? null,
      backgroundTasks: [...(this.taskState.get(id)?.list ?? [])],
      nextStep: parseNextStep(row.nextStep),
    };
    // Rewound seq ranges, so a client that was offline during a rewind drops what it still holds (absent when none).
    const rewound = this.deps.store.rewoundRanges(id, MAX_REWOUND_RANGES);
    if (rewound.length) snap.rewound = rewound;
    return snap;
  }

  /**
   * Stops one background task of the session's live process. False when there is no live process, the process
   * cannot stop tasks or the task is not running. The task ends as "stopped" when it leaves the SDK's list.
   */
  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    // A Agent Workstation subagent (task id = the child session): stop the child; its run_subagents call returns "stopped".
    if (await this.subagents.stopChild(sessionId, taskId)) return true;
    const live = this.lives.get(sessionId);
    const q = live?.proc?.q;
    const state = this.taskState.get(sessionId);
    if (!live || !q?.stopTask || !state?.list.some((t) => t.taskId === taskId && isRunning(t))) return false;
    state.stopRequested.add(taskId);
    try {
      await q.stopTask(taskId);
    } catch (err) {
      state.stopRequested.delete(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Sets (or with null clears) the session's end-of-turn box: stored on the session row (survives reloads and hub
   * restarts) and broadcast as `next_step`. Clearing a session without a box does nothing.
   */
  private setNextStep(sessionId: string, step: NextStep | null): void {
    const row = this.deps.store.getSession(sessionId);
    if (!row || (step === null && row.nextStep === null)) return;
    this.deps.store.updateSession(sessionId, { nextStep: step ? JSON.stringify(step) : null });
    this.deps.bus.toSession(sessionId, { type: "next_step", sessionId, step });
  }

  /** The `wrap_up` tool of a code session: replaces the box with the new one. */
  private wrapUp(sessionId: string): HubToolSpec {
    return wrapUpTool((s) => this.setNextStep(sessionId, { ...s, at: iso(this.clock()) }));
  }

  respondPermission(user: string, sessionId: string, response: PermissionResponse): { ok: true } | { ok: false; code: string; message: string } {
    return this.permissions.respond(user, sessionId, response);
  }

  // -------------------------------------------------------------- messages

  /** Persists the user message first, then hands it to the process (spawning/queuing as needed). */
  async send(sessionId: string, body: { uuid: string; text: string; attachments?: Attachment[] }): Promise<SendResult> {
    if (this.shuttingDown) throw new HttpError(503, "shutting_down", "the hub is restarting");
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    // A message sent while a rewind stops the session would land in the part it removes.
    if (this.rewinding.has(sessionId)) throw new HttpError(409, "busy", "the conversation is being rewound; send again in a moment");

    const existing = this.deps.store.getMessageByUuid(sessionId, body.uuid);
    if (existing) {
      const live = this.lives.get(sessionId);
      const st = live ? this.computeStatus(live) : { status: "idle" as SessionStatus, queuePosition: null };
      return { state: st.status === "queued" ? "queued" : "accepted", position: st.queuePosition, seq: existing.seq };
    }
    if (!body.text.trim() && !(body.attachments?.length)) throw badRequest("invalid_request", "message is empty");
    // A key must be configured and this month's budget must have room (503 / 429).
    this.assertCanSend();

    const root = this.deps.userRoot(row.user);
    const cwdAbs = row.cwd ? join(root, row.cwd) : root;
    const at = iso(this.clock());
    const { msg, meta } = buildUserTurn({ uuid: body.uuid, text: body.text, attachments: body.attachments, kind: row.kind, userRoot: root, cwdAbs, timestamp: at });
    return this.enqueueTurn(row, body.uuid, body.text, msg, meta, at);
  }

  /** Persists a built user turn (delivery pending), announces it and hands it to the process (spawning/queuing as needed). */
  private enqueueTurn(row: SessionRow, uuid: string, text: string, msg: SDKUserMessage, meta: UserMessageMeta | null, at: string): SendResult {
    const sessionId = row.id;
    // Claude gets `msg`; people get the same row plus `hub` (typed text + file chips) when there were attachments.
    const payload = meta ? { ...msg, hub: meta } : msg;
    const stored = this.deps.store.appendMessage(sessionId, { uuid, kind: "user", payload, delivery: "pending", at });
    if (!stored) throw new HttpError(409, "duplicate", "duplicate message uuid");
    this.publishMessage(row.user, stored, payload);
    // The user answered: the previous turn's end-of-turn box goes (a button answer is a send like any other).
    this.setNextStep(sessionId, null);
    // A cached attachment set grows here; an uncached one is loaded (with this message) when first needed.
    for (const a of meta?.attachments ?? []) this.attachmentCache.get(sessionId)?.add(a.path);

    // Auto-title from the first prompt (after a rewind to the very first message, from the one sent next).
    if ((row.title === "New chat" || row.title === "New session") && (row.lastSeq === 0 || !this.hasPromptBefore(sessionId, stored.seq))) {
      const t = titleFromText(text);
      if (t) this.rename(sessionId, t);
    } else {
      this.deps.bus.toUser(row.user, { type: "session_updated", session: this.toProtocol(this.deps.store.getSession(sessionId)!) });
    }

    const live = this.ensureLive(row);
    this.recycleIfMemoryStale(live);
    this.recycleIfInstructionsStale(live);
    this.recycleIfToolsStale(live);
    live.pending.push({ uuid, msg });
    live.dead = false;
    live.lastActivity = Date.now();
    this.kick(live);
    const st = this.computeStatus(live);
    this.refresh(sessionId);
    return { state: st.status === "queued" ? "queued" : "accepted", position: st.queuePosition, seq: stored.seq };
  }

  /** A visible prompt of the person before `seq`. */
  private hasPromptBefore(sessionId: string, seq: number): boolean {
    for (const m of this.deps.store.iterateMessages(sessionId, 0)) {
      if (m.seq >= seq) return false;
      if (isPrompt(m)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------- settings

  async updateSettings(sessionId: string, s: SessionSettings): Promise<Session> {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    const patch: { model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | null } = {};
    if (s.model !== undefined && s.model !== row.model) patch.model = s.model;
    if (s.permissionMode !== undefined && row.kind === "code" && s.permissionMode !== row.permissionMode) patch.permissionMode = s.permissionMode;
    if (s.effort !== undefined && s.effort !== row.effort) patch.effort = s.effort;

    const liveProc = this.lives.get(sessionId)?.proc;
    const q = liveProc?.q;
    // A code process started with hub-decided network (default / acceptEdits / plan) is not switched into
    // auto / bypassPermissions / dontAsk while it runs: there the CLI would decide (or allow) every host itself. It is
    // restarted with the strict allowlist instead (now when idle, else before its next turn); the running turn finishes
    // in its current mode.
    const deferMode = patch.permissionMode !== undefined && liveProc?.strictNetwork === false && strictNetworkMode(patch.permissionMode);
    if (liveProc && patch.permissionMode !== undefined) liveProc.modeDeferred = deferMode;
    if (q) {
      if (patch.model !== undefined) {
        try {
          await q.setModel(patch.model === "default" ? undefined : patch.model);
        } catch (err) {
          throw badRequest("invalid_model", `could not switch model: ${errorMessage(err)}`);
        }
      }
      if (patch.permissionMode !== undefined && !deferMode) {
        try {
          await q.setPermissionMode(patch.permissionMode);
        } catch (err) {
          throw badRequest("invalid_permission_mode", `could not switch mode: ${errorMessage(err)}`);
        }
      }
      if (patch.effort !== undefined) {
        try {
          await q.applyFlagSettings({ effortLevel: patch.effort });
        } catch (err) {
          this.deps.log.warn({ sessionId, err: errorMessage(err) }, "applyFlagSettings(effortLevel) failed; will apply on next spawn");
        }
      }
    }
    const updated = this.deps.store.updateSession(sessionId, patch)!;
    this.broadcastSettings(updated);
    if (patch.permissionMode !== undefined) {
      const live = this.lives.get(sessionId);
      if (live) this.recycleIfNetworkStale(live);
    }
    return this.toProtocol(updated);
  }

  private broadcastSettings(row: SessionRow): void {
    this.deps.bus.toUser(row.user, {
      type: "session_settings",
      sessionId: row.id,
      settings: { model: row.model, permissionMode: row.permissionMode, effort: row.effort },
    });
  }

  // ------------------------------------------------------- stop/close/delete

  /** Stop = interrupt the turn; after the grace period close the process (next message resumes). */
  async stop(sessionId: string): Promise<Session> {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    // Stopping a turn stops the subagents it started (and a stopped subagent reports "stopped" to its parent).
    this.subagents.stopAll(sessionId);
    this.deps.downloads?.abortAll(sessionId);
    this.subagents.markStopped(sessionId);
    const live = this.lives.get(sessionId);
    if (live) {
      this.cancelPending(live, "stopped");
      this.permissions.cancelSession(sessionId, "The user stopped this turn.");
      const proc = live.proc;
      if (proc && live.turn) {
        const gotResult = new Promise<void>((res) => live.stopWaiters.push(res));
        void settlesWithin(
          proc.q.interrupt().catch((err) => this.deps.log.warn({ sessionId, err: errorMessage(err) }, "interrupt failed")),
          this.deps.limits.stopGraceMs ?? 10_000,
        );
        const ok = await settlesWithin(gotResult, this.deps.limits.stopGraceMs ?? 10_000);
        if (!ok && live.proc === proc) {
          this.deps.log.warn({ sessionId }, "no result within the stop grace period; closing the process");
          this.persistSystem(live, "hub_stop_timeout", {});
          this.closeProc(live, "stop-timeout");
        }
      }
      this.refresh(sessionId);
    }
    return this.toProtocol(this.deps.store.getSession(sessionId)!);
  }

  /** Close = release the process and its slot; history is kept. */
  async close(sessionId: string): Promise<Session> {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    this.subagents.stopAll(sessionId);
    this.deps.downloads?.abortAll(sessionId);
    const live = this.lives.get(sessionId);
    if (live) {
      this.cancelPending(live, "closed");
      this.permissions.cancelSession(sessionId, "The session was closed.");
      const proc = live.proc;
      if (proc) {
        this.closeProc(live, "close");
        await settlesWithin(proc.done, 5000);
      }
      live.dead = false;
      this.refresh(sessionId);
      this.maybeForget(live);
    }
    // "Allow this session" answers for browser websites end with the session.
    this.browserSites.dropSession(sessionId);
    this.deps.apiProxy?.revokeOwner(sessionId);
    return this.toProtocol(this.deps.store.getSession(sessionId)!);
  }

  /**
   * Delete = rows + Claude's own transcript files, and a chat's
   * own folder when no other chat uses it. Only ever
   * user-initiated: an explicit DELETE, or — for incognito chats — the person's own choice when they started the chat
   * that it is not kept (the client sends DELETE when they leave it; purgeIncognito() is the restart safety net).
   * Token numbers in `turns` stay (they hold no content).
   */
  async delete(sessionId: string): Promise<void> {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    await this.close(sessionId);
    // Its subagents' sessions go with it (an incognito chat's children are incognito too).
    for (const child of this.deps.store.childSessionIds(sessionId)) {
      try {
        await this.delete(child);
      } catch (err) {
        this.deps.log.warn({ sessionId: child, err: errorMessage(err) }, "could not delete a subagent session");
      }
    }
    this.lives.delete(sessionId);
    this.deps.catalog?.forgetSession(sessionId);
    this.deps.onSessionDeleted?.(sessionId);
    this.attachmentCache.delete(sessionId);
    this.sessionHosts.delete(sessionId);
    this.taskState.delete(sessionId);
    this.deps.store.deleteSession(sessionId);
    // The chat's folder goes once no other chat works in it (a fork shares its source's; subagents went above).
    if (row.kind === "chat" && isChatFolder(row.cwd) && this.deps.store.countSessionsWithCwd(row.user, row.cwd) === 0) {
      try {
        removeChatFolder(this.deps.userRoot(row.user), row.cwd);
      } catch (err) {
        this.deps.log.warn({ sessionId, err: errorMessage(err) }, "could not delete the chat's folder");
      }
    }
    const ids = [row.claudeSessionId, ...row.claudeHistory].filter((x): x is string => !!x);
    if (this.deps.claudeHome && ids.length) {
      try {
        await deleteTranscripts(this.deps.claudeHome, ids, this.deps.log);
      } catch (err) {
        this.deps.log.warn({ sessionId, err: errorMessage(err) }, "could not delete Claude transcripts");
      }
    }
    this.deps.bus.toUser(row.user, { type: "session_deleted", sessionId });
  }

  // ------------------------------------------------------- rewind/fork/pins

  /** Sessions with a rewind in progress (a second one waits for nothing: 409). */
  private readonly rewinding = new Set<string>();

  /**
   * Rewind (protocol RewindBody): the user message `messageUuid` and everything after it leave the transcript (marked
   * rewound, never deleted; `messages_rewound`). A running turn is stopped and queued messages are cancelled first. The
   * agent continues from the kept part: Claude resumes at the last kept message as a fork (`resumeSessionAt` +
   * `forkSession`; nothing kept = a fresh session). `files`: the session's synced project goes back to the snapshot taken before that message's turn
   * (409 `unsupported` when there is none; nothing changes then). `resend`: the message is sent again (its attachments as
   * they were, `text` instead of its text when given) through the normal send path.
   */
  async rewind(sessionId: string, body: { messageUuid: string; files?: boolean; resend?: { text?: string } }): Promise<{ draft: string; filesRestored: boolean; resent: SendResult | null }> {
    if (this.shuttingDown) throw new HttpError(503, "shutting_down", "the hub is restarting");
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    this.assertNotSubagent(row, "rewound");
    const target = this.deps.store.getVisibleMessage(sessionId, body.messageUuid);
    if (!target) throw notFound("no such message");
    if (!isPrompt(target)) throw badRequest("invalid_request", "only a user message can be rewound to");
    const draft = promptTextOf(target);

    // Everything that can refuse runs before anything changes.
    let resend: ReturnType<typeof resendTurn> | null = null;
    const at = iso(this.clock());
    const resendUuid = newUuid();
    if (body.resend) {
      resend = resendTurn(target, body.resend.text ?? draft, resendUuid, at);
      if (resend.empty) throw badRequest("invalid_request", "message is empty");
      this.assertCanSend();
    }
    let snapshotRef: string | null = null;
    if (body.files) {
      const turn = this.deps.store.messageTurn(sessionId, target);
      const projects = this.deps.projects;
      if (row.kind === "code" && turn > 0 && projects?.turnSnapshot && projects.restoreSnapshot) snapshotRef = await projects.turnSnapshot(row.user, row.cwd, row.id, turn);
      if (!snapshotRef) throw new HttpError(409, "unsupported", "There is no snapshot of the files from before this message (the session's folder is not a synced project, or the message started the session).");
    }
    if (this.rewinding.has(sessionId)) throw new HttpError(409, "busy", "a rewind of this session is already in progress");
    this.rewinding.add(sessionId);
    try {
      await this.quiesce(sessionId, "The conversation was rewound.");
      let filesRestored = false;
      if (snapshotRef) {
        await this.deps.projects!.restoreSnapshot!(row.user, row.cwd, snapshotRef);
        filesRestored = true;
      }

      this.deps.store.rewindMessages(sessionId, target.seq);
      this.attachmentCache.delete(sessionId);
      const kept = [...this.deps.store.iterateMessages(sessionId, 0)];
      const keptUuids = new Set(kept.map((m) => m.uuid));
      const cur = this.deps.store.getSession(sessionId)!;
      const history = cur.claudeSessionId && !cur.claudeHistory.includes(cur.claudeSessionId) ? [...cur.claudeHistory, cur.claudeSessionId] : cur.claudeHistory;
      // The old conversation stays in the history (deleted with the session); the next process starts a new one.
      const patch: SessionPatch = { claudeSessionId: null, claudeHistory: history, pinnedMessages: cur.pinnedMessages.filter((u) => keptUuids.has(u)) };
      const point = resumePoint(kept, cur.claudeSessionId ?? cur.resumeFrom);
      patch.resumeFrom = point?.from ?? null;
      patch.resumeAt = point?.at ?? null;
      // An auto-title from the removed first message goes with it (the next first message titles the session again).
      if (!kept.some(isPrompt) && cur.title === titleFromText(draft)) patch.title = row.kind === "chat" ? "New chat" : "New session";
      const updated = this.deps.store.updateSession(sessionId, patch)!;
      this.setNextStep(sessionId, null);
      this.deps.log.info({ sessionId, fromSeq: target.seq, files: filesRestored, resumeAt: updated.resumeAt, resend: !!resend }, "session rewound");
      this.deps.bus.toSession(sessionId, { type: "messages_rewound", sessionId, fromSeq: target.seq });
      this.deps.bus.toUser(updated.user, { type: "session_updated", session: this.toProtocol(updated) });

      const resent = resend ? this.enqueueTurn(updated, resendUuid, body.resend?.text ?? draft, resend.msg, resend.meta, at) : null;
      // The summary described the removed part: a new one is written once the session rests (after the resent turn).
      if (!resent) this.deps.onTurnIdle?.(sessionId);
      return { draft, filesRestored, resent };
    } finally {
      this.rewinding.delete(sessionId);
    }
  }

  /**
   * Fork (protocol ForkBody): a new session (same kind, cwd, model, mode, effort, incognito) whose messages are copies
   * of this one's up to `messageUuid` — an assistant message included; for a user message up to just before it, its
   * text coming back as `draft`. Claude resumes from this session's conversation at the last copied message as a fork.
   * The source session is not touched.
   */
  fork(sessionId: string, messageUuid: string): { row: SessionRow; draft: string | null } {
    if (this.shuttingDown) throw new HttpError(503, "shutting_down", "the hub is restarting");
    const src = this.deps.store.getSession(sessionId);
    if (!src) throw notFound();
    this.assertNotSubagent(src, "forked");
    const target = this.deps.store.getVisibleMessage(sessionId, messageUuid);
    if (!target) throw notFound("no such message");
    let upTo: number;
    let draft: string | null = null;
    if (isPrompt(target)) {
      upTo = target.seq - 1;
      draft = promptTextOf(target);
    } else if (target.kind === "assistant" && !parsePayload(target).parent_tool_use_id) {
      upTo = target.seq;
    } else {
      throw badRequest("invalid_request", "a fork starts from a user or assistant message");
    }
    const kept: MessageRow[] = [];
    for (const m of this.deps.store.iterateMessages(sessionId, 0)) {
      if (m.seq > upTo) break;
      kept.push(m);
    }
    const point = resumePoint(kept, src.claudeSessionId ?? src.resumeFrom);
    const store = this.deps.store;
    const id = newUuid();
    const now = iso(this.clock());
    const row = store.transaction(() => {
      store.insertSession({
        id,
        user: src.user,
        kind: src.kind,
        title: `${src.title} (fork)`.slice(0, 200),
        cwd: src.cwd,
        model: src.model,
        permissionMode: src.permissionMode,
        effort: src.effort,
        createdAt: now,
        incognito: src.incognito,
        resumeFrom: point?.from ?? null,
        resumeAt: point?.at ?? null,
      });
      // Same uuids (unique per session; Claude's fork knows the messages by them), new seqs.
      for (const m of kept) {
        store.appendMessage(id, { uuid: m.uuid, kind: m.kind, payload: m.payload, at: m.at, delivery: m.delivery === "pending" ? "cancelled" : m.delivery });
      }
      return store.updateSession(id, { lastActiveAt: now })!;
    });
    this.deps.log.info({ sessionId: id, from: sessionId, messages: kept.length, resumeAt: point?.at ?? null }, "session forked");
    return { row, draft };
  }

  /** Pins (PUT) or unpins (DELETE) a visible message of the session; at most MAX_PINS (the oldest go first). */
  setPin(sessionId: string, messageUuid: string, pinned: boolean): Session {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw notFound();
    if (!this.deps.store.getVisibleMessage(sessionId, messageUuid)) throw notFound("no such message");
    const pins = row.pinnedMessages.filter((u) => u !== messageUuid);
    if (pinned) pins.push(messageUuid);
    while (pins.length > MAX_PINS) pins.shift();
    const changed = pins.length !== row.pinnedMessages.length || pins.some((u, i) => u !== row.pinnedMessages[i]);
    const updated = changed ? this.deps.store.updateSession(sessionId, { pinnedMessages: pins })! : row;
    const session = this.toProtocol(updated);
    if (changed) this.deps.bus.toUser(updated.user, { type: "session_updated", session });
    return session;
  }

  /** Subagent sessions (started by another session's agent) have no rewind or fork. */
  private assertNotSubagent(row: SessionRow, what: string): void {
    const parent = (row as SessionRow & { parentSessionId?: string | null }).parentSessionId;
    if (parent) throw badRequest("invalid_request", `a subagent's session cannot be ${what}`);
  }

  /**
   * Before a rewind: the running turn stopped (the normal Stop path), queued messages cancelled, the process closed and
   * gone, so nothing lands in the transcript after the rewind point and the next process starts from the kept part.
   */
  private async quiesce(sessionId: string, why: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    if (live.turn || live.pending.length || live.waitingSlot || live.spawning) await this.stop(sessionId);
    // A spawn in flight finishes first (its process is closed right after).
    for (let i = 0; live.spawning && i < 300; i++) await new Promise((r) => setTimeout(r, 50));
    this.cancelPending(live, "rewound");
    this.permissions.cancelSession(sessionId, why);
    const proc = live.proc;
    if (proc) {
      this.closeProc(live, "rewind");
      await settlesWithin(proc.done, 5000);
    }
    live.dead = false;
    this.refresh(sessionId);
    this.maybeForget(live);
  }

  /** Closes the live processes of `user`'s sessions whose cwd is `relDir` or below (project delete). */
  async closeSessionsUnder(user: string, relDir: string): Promise<number> {
    const ids: string[] = [];
    for (const live of this.lives.values()) {
      if (live.user !== user) continue;
      const row = this.deps.store.getSession(live.id);
      if (row && (row.cwd === relDir || row.cwd.startsWith(relDir + "/"))) ids.push(live.id);
    }
    for (const id of ids) await this.close(id);
    return ids.length;
  }

  /**
   * Skills changed on disk: ask live code processes (of `user`, or all users for
   * global skills) to rescan, and refresh their slash-command lists.
   */
  async reloadSkills(user: string | null): Promise<void> {
    for (const live of [...this.lives.values()]) {
      if (!live.proc || live.kind !== "code" || (user !== null && live.user !== user)) continue;
      const q = live.proc.q;
      try {
        // Nested-git sessions see skills through an overlay of symlinks: refresh it first.
        const row = this.deps.store.getSession(live.id);
        if (row) {
          const root = this.deps.userRoot(row.user);
          const cwdAbs = row.cwd ? join(root, row.cwd) : root;
          if (this.deps.projectSettings?.()) this.deps.skillDirs?.(row.user, cwdAbs);
          else this.deps.projectPlugins?.(row.user, cwdAbs);
        }
        if (q.reloadSkills) await q.reloadSkills();
      } catch (err) {
        this.deps.log.debug({ sessionId: live.id, err: errorMessage(err) }, "reloadSkills failed");
      }
      if (this.deps.catalog) await this.deps.catalog.refreshFrom(q, { sessionId: live.id, global: false });
    }
  }

  // ----------------------------------------------------------- introspection

  /** The running code session of `user` most likely responsible for a change at `rel`. */
  runningSessionFor(user: string, rel: string): string | null {
    let best: { id: string; score: number; at: number } | null = null;
    for (const live of this.lives.values()) {
      if (live.user !== user || !live.turn || live.kind !== "code") continue;
      const row = this.deps.store.getSession(live.id);
      if (!row) continue;
      const cwd = row.cwd;
      const score = cwd === "" ? 0 : rel === cwd || rel.startsWith(cwd + "/") ? cwd.length : -1;
      if (score < 0) continue;
      if (!best || score > best.score || (score === best.score && live.lastActivity > best.at)) best = { id: live.id, score, at: live.lastActivity };
    }
    return best?.id ?? null;
  }

  liveProcesses(): LiveProcessInfo[] {
    const out: LiveProcessInfo[] = [];
    for (const live of this.lives.values()) {
      if (!live.proc) continue;
      out.push({
        sessionId: live.id,
        user: live.user,
        kind: live.kind,
        status: this.computeStatus(live).status,
        pid: live.proc.pid,
        startedAt: live.proc.startedAt,
        lastActiveAt: new Date(live.lastActivity).toISOString(),
      });
    }
    return out;
  }

  /** Live Claude processes. */
  processCounts(): { claude: number } {
    let claude = 0;
    for (const live of this.lives.values()) if (live.proc) claude++;
    return { claude };
  }

  statusOf(sessionId: string): { status: SessionStatus; queuePosition: number | null } {
    const live = this.lives.get(sessionId);
    return live ? this.computeStatus(live) : { status: "idle", queuePosition: null };
  }

  // ----------------------------------------------------------- lifecycle

  /** Startup: nothing survives a restart. Undelivered user messages are marked cancelled. */
  recoverAfterRestart(): void {
    this.deps.store.resetAllStatuses();
    const pending = this.deps.store.pendingDeliveries();
    const bySession = new Map<string, string[]>();
    for (const m of pending) {
      this.deps.store.setDelivery(m.sessionId, m.uuid, "cancelled");
      bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m.uuid]);
    }
    for (const [sessionId, uuids] of bySession) {
      this.deps.store.appendMessage(sessionId, {
        uuid: newUuid(),
        kind: "system",
        payload: { type: "system", subtype: "hub_cancelled", message_uuids: uuids, reason: "hub_restart" },
      });
    }
  }

  /**
   * Startup safety net for incognito chats: any left over (the client could not send DELETE, the hub stopped) are
   * deleted with everything they left behind — hub rows and Claude transcripts. Incognito means the person chose, per session, that it is not kept, so this is their deletion, not
   * an automatic one (consistent with the "never auto-delete" rule). Returns how many were purged.
   */
  async purgeIncognito(): Promise<number> {
    let n = 0;
    for (const row of this.deps.store.listIncognitoSessions()) {
      if (!this.deps.store.getSession(row.id)) continue; // a subagent's, deleted with its parent
      try {
        await this.delete(row.id);
        n++;
      } catch (err) {
        this.deps.log.warn({ sessionId: row.id, err: errorMessage(err) }, "could not purge an incognito session");
      }
    }
    if (n) this.deps.log.info({ sessions: n }, "purged incognito sessions left from before the restart");
    return n;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const waits: Promise<unknown>[] = [];
    for (const live of this.lives.values()) {
      this.pool.cancel(live.id);
      live.waitingSlot = false;
      this.permissions.cancelSession(live.id, "The hub is shutting down.");
      if (live.idleTimer) clearTimeout(live.idleTimer);
      const proc = live.proc;
      if (proc) {
        this.closeProc(live, "shutdown");
        waits.push(proc.done);
      }
    }
    await settlesWithin(Promise.all(waits), 5000);
    this.pool.dispose();
  }

  // ------------------------------------------------------------ internals

  private ensureLive(row: SessionRow): Live {
    let live = this.lives.get(row.id);
    if (!live) {
      live = {
        id: row.id,
        user: row.user,
        kind: row.kind,
        proc: null,
        pending: [],
        turn: null,
        waitingSlot: false,
        spawning: false,
        exiting: null,
        dead: false,
        partial: emptyPartial(),
        idleTimer: null,
        stopWaiters: [],
        lastActivity: Date.now(),
        lastStatusKey: "",
        turnProjects: new Set(),
        tokens: new TurnTokens(),
        cost: new TurnCost(this.deps.pricing, this.clock),
        costSent: -1,
        lastRequest: null,
        contextSeq: 0,
      };
      this.lives.set(row.id, live);
    }
    return live;
  }

  /** Drops the in-memory entry once nothing is live for the session. */
  private maybeForget(live: Live): void {
    if (!live.proc && !live.spawning && !live.waitingSlot && !live.turn && live.pending.length === 0 && !live.dead && !this.permissions.hasPending(live.id)) {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      // Only this entry: a stale Live (e.g. of a process that ended after a newer one took over) must not drop the current one.
      if (this.lives.get(live.id) === live) {
        this.lives.delete(live.id);
        this.attachmentCache.delete(live.id);
      }
    }
  }

  private computeStatus(live: Live): { status: SessionStatus; queuePosition: number | null } {
    if (live.waitingSlot) return { status: "queued", queuePosition: this.pool.position(live.id) };
    if (live.turn || live.spawning) {
      return { status: this.permissions.hasPending(live.id) ? "requires_action" : "running", queuePosition: null };
    }
    if (live.dead) return { status: "dead", queuePosition: null };
    return { status: "idle", queuePosition: null };
  }

  /** Recomputes status; persists and broadcasts it when it changed. */
  private refresh(sessionId: string): void {
    const live = this.lives.get(sessionId);
    const { status, queuePosition } = live ? this.computeStatus(live) : { status: "idle" as SessionStatus, queuePosition: null };
    const watcher = this.runWatchers.get(sessionId);
    if (watcher) {
      if (status !== "idle" && status !== "dead") watcher.busy = true;
      else if (watcher.busy) {
        this.runWatchers.delete(sessionId);
        // After the current call stack: the code that ended the run may still be recording why (process died, …).
        setImmediate(watcher.done);
      }
    }
    const key = `${status}:${queuePosition ?? ""}`;
    if (live && live.lastStatusKey === key) return;
    const row = this.deps.store.getSession(sessionId);
    if (!row) return;
    if (!live && row.status === status) return;
    if (live) live.lastStatusKey = key;
    if (row.status !== status) this.deps.store.updateSession(sessionId, { status });
    this.deps.bus.toUser(row.user, { type: "session_state", sessionId, status, queuePosition });
  }

  private kick(live: Live): void {
    if (this.shuttingDown) return;
    if (live.turn || live.pending.length === 0) return;
    if (live.proc) return this.feedNext(live);
    if (live.spawning || live.waitingSlot) return;
    const token = this.pool.tryAcquire(live.id);
    if (token !== null) {
      this.spawn(live, token);
      return;
    }
    live.waitingSlot = true;
    this.pool.enqueue(live.id, (t) => {
      live.waitingSlot = false;
      if (this.shuttingDown || live.pending.length === 0 || live.proc) {
        this.pool.release(t);
        this.refresh(live.id);
        this.maybeForget(live);
        return;
      }
      this.spawn(live, t);
    });
    this.refresh(live.id);
  }

  private spawn(live: Live, token: number): void {
    live.spawning = true;
    this.refresh(live.id);
    let starting: Proc | null = null;
    void (async () => {
      try {
        if (live.exiting) await settlesWithin(live.exiting, 15_000);
        let row = this.deps.store.getSession(live.id);
        if (!row) throw new Error("session vanished");
        if (row.claudeSessionId) {
          const lock = this.claudeLocks.get(row.claudeSessionId);
          if (lock) await settlesWithin(lock, 15_000);
          await this.reconcile(live, row);
          row = this.deps.store.getSession(live.id)!;
        }
        if (this.shuttingDown) throw new Error("shutting down");
        const input = new PushQueue<SDKUserMessage>();
        const proc: Proc = {
          q: null as unknown as HubQuery,
          input,
          token,
          gen: ++this.gen,
          startedAt: iso(this.clock()),
          pid: null,
          stderrTail: "",
          closedByHub: false,
          initPersisted: false,
          catalogFetched: false,
          done: Promise.resolve(),
          memoryKey: null,
          memorySection: null,
          instructions: "",
          knownHeadsUps: null,
          apiToken: null,
          incognito: row.incognito,
          creditNoticeSent: false,
          chatRead: false,
          strictNetwork: null,
          outboundAllowed: new Set(),
          modeDeferred: false,
        };
        starting = proc;
        proc.q = this.deps.sdk.query({ prompt: input, options: this.buildOptions(row, proc) });
        live.proc = proc;
        live.dead = false;
        let release!: () => void;
        const lock = new Promise<void>((res) => (release = res));
        if (row.claudeSessionId) this.claudeLocks.set(row.claudeSessionId, lock);
        proc.done = this.consume(live, proc).finally(() => {
          release();
          if (row!.claudeSessionId && this.claudeLocks.get(row!.claudeSessionId) === lock) this.claudeLocks.delete(row!.claudeSessionId);
        });
        live.exiting = proc.done;
        this.deps.log.info(
          { sessionId: live.id, user: live.user, resume: row.claudeSessionId, forkFrom: row.claudeSessionId ? undefined : (row.resumeFrom ?? undefined), gen: proc.gen },
          "claude process spawned",
        );
        live.spawning = false;
        this.feedNext(live);
      } catch (err) {
        live.spawning = false;
        // A process that never became live must not leave its proxy token behind.
        if (starting && live.proc !== starting) this.deps.apiProxy?.revoke(starting.apiToken);
        this.pool.release(token);
        this.deps.log.error({ sessionId: live.id, err: errorMessage(err) }, "failed to spawn the agent process");
        if (!this.shuttingDown) {
          live.dead = true;
          this.persistSystem(live, "hub_process_died", { error: redactSecrets(`spawn failed: ${errorMessage(err)}`) });
          this.deps.bus.toUser(live.user, { type: "error", code: "spawn_failed", message: errorMessage(err), sessionId: live.id });
        }
      } finally {
        this.refresh(live.id);
      }
    })();
  }

  private buildOptions(row: SessionRow, proc: Proc): SdkOptions {
    const root = this.deps.userRoot(row.user);
    const cwdAbs = row.cwd ? join(root, row.cwd) : root;
    mkdirSync(cwdAbs, { recursive: true });
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      /* keep */
    }
    const sessionId = row.id;
    const user = row.user;
    // The credential: the hub's key proxy and a token of its own (never the key itself). billingEnv throws
    // (503 api_unavailable) when there is no key.
    const cred = this.deps.billing?.apiKey() && this.deps.apiProxy ? this.deps.apiProxy.issue(sessionId) : null;
    proc.apiToken = cred?.token ?? null;
    const baseEnv = billingEnv({ ...process.env, ...(this.deps.extraEnv ?? {}), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }, cred);
    // A private temp directory for this process (processTmp.ts): created before it starts, removed when it ends.
    const tmpDir = newProcessTmpDir();
    const env = { ...baseEnv, CLAUDE_CODE_TMPDIR: tmpDir };
    // A code session works only inside its cwd (codeSandbox.ts): what its read-only file tools may open besides it.
    const codeReads = row.kind === "code" ? codeReadDirs({ cwd: cwdAbs, tmpDir, claudeHome: this.deps.claudeHome ?? join(homedir(), ".claude") }) : [];
    const opts: SdkOptions = {
      cwd: cwdAbs,
      includePartialMessages: true,
      allowDangerouslySkipPermissions: true,
      permissionMode: row.kind === "chat" ? "dontAsk" : row.permissionMode,
      env,
      settings: { cleanupPeriodDays: RETENTION_DAYS },
      // A code session reads no settings files (a project's apiKeyHelper, env, hooks, permissions and sandbox
      // additions would all take effect as the agent account) unless `[sessions] project_settings` is on (see
      // `projectSettings` in the deps). strictMcpConfig and disableAllHooks stay on as well.
      settingSources: row.kind === "code" && this.deps.projectSettings?.() ? ["project"] : [],
      ...(row.kind === "code" && !this.deps.projectSettings?.() ? { strictMcpConfig: true } : {}),
      canUseTool: async (toolName, input, o) => {
        // The server browser's tools (website check, refusals) and the browser's profile folder (also enforced in
        // PreToolUse, which runs in every mode).
        const gate = await this.browserGate(row, cwdAbs, toolName, input, o);
        if (gate) return gate.behavior === "allow" ? { behavior: "allow", updatedInput: input } : gate;
        // The hub's own pre-approved MCP tools never get a card (should the CLI ask anyway).
        if (opts.allowedTools?.includes(toolName)) return { behavior: "allow", updatedInput: input };
        // Code sessions: file tools only inside the cwd (also enforced in PreToolUse), commands only sandboxed, and the
        // sandbox's network only to public hosts (known hosts without a card, others with one; codeNetworkVerdict).
        if (row.kind === "code") {
          const file = this.codeFileVerdict(row, cwdAbs, codeReads, toolName, input);
          if (file?.behavior === "deny") return file;
          if (toolName === "Bash" && input.dangerouslyDisableSandbox === true) return { behavior: "deny", message: CODE_UNSANDBOXED_DENIED };
          if (toolName === SANDBOX_NETWORK_TOOL) return this.codeNetworkVerdict(row, cwdAbs, input, o);
          // An outbound command the person just allowed on its own card (PreToolUse): not asked twice.
          if (toolName === "Bash" && o.toolUseID && proc.outboundAllowed.delete(o.toolUseID)) return { behavior: "allow", updatedInput: input };
        }
        // A subagent's write outside its area or on a sibling's file: no card (also enforced in PreToolUse).
        const guard = this.claudeWriteGuard(row, cwdAbs, toolName, input, o.toolUseID);
        if (guard) return { behavior: "deny", message: guard };
        // A project lock taken in PreToolUse must not be held while the user thinks.
        const resume = this.deps.projects?.suspendHold(o.toolUseID) ?? null;
        const result = await this.permissions.request({ sessionId, user, cwd: cwdAbs }, toolName, input, {
          signal: o.signal,
          toolUseID: o.toolUseID,
          requestId: o.requestId,
          suggestions: o.suggestions as unknown[] | undefined,
        });
        if (resume && result.behavior === "allow") await resume();
        if (result.behavior !== "allow") this.subagents.writeRefused(sessionId, o.toolUseID);
        return result;
      },
    };
    if (row.model && row.model !== "default") opts.model = row.model;
    if (row.effort) opts.effort = row.effort;
    if (row.claudeSessionId) {
      opts.resume = row.claudeSessionId;
    } else if (row.resumeFrom && row.resumeAt) {
      // After a rewind / for a fork: a new Claude session that starts as a copy of `resumeFrom` up to and including
      // the message `resumeAt` (the new session id arrives with `init`).
      opts.resume = row.resumeFrom;
      opts.resumeSessionAt = row.resumeAt;
      opts.forkSession = true;
    }
    if (this.deps.claudeExecutable) opts.pathToClaudeCodeExecutable = this.deps.claudeExecutable;
    // A subagent has no run_subagents (depth 1) and no wrap_up; a chat subagent only searches and reads the web.
    const child = !!row.parentSessionId;
    const research = child && row.kind === "chat";
    // Incognito chats: no memory (neither read nor written), no past-conversation tools.
    const memories = row.incognito || research ? undefined : this.deps.memories;
    const memoryOn = !!memories && memories.enabled(user);
    proc.memoryKey = row.incognito ? null : this.memoryKey(user);
    proc.memorySection = memoryOn ? memories.promptSection(user) : null;
    proc.instructions = this.instructionsOf(user);
    proc.knownHeadsUps = this.knownHeadsUpsOf(row);
    // search_conversations / read_conversation: pre-approved (no card), like the memory tools.
    const history = !row.incognito && !research && this.deps.history ? this.deps.history.tools(user, sessionId) : [];
    // Agent Workstation's own readme pages (read_workstation_docs): every session but research subagents.
    const docs = research ? undefined : this.deps.docs;
    const addServer =(name: string, tools: HubToolSpec[]) => {
      opts.mcpServers = { ...(opts.mcpServers ?? {}), [name]: this.deps.sdk.createMcpServer(name, tools) };
      opts.allowedTools = [...(opts.allowedTools ?? []), ...tools.map((t) => `mcp__${name}__${t.name}`)];
    };
    // The server browser (Streamable HTTP on the BrowserManager's loopback endpoint). Looked up on every spawn: the port
    // is random per hub start. Its tools are not pre-approved by name: browserGate decides per call (browser_tabs
    // closing a tab acts). Incognito chats get none: the browser's profile keeps history and cookies.
    const browser = row.incognito || research ? null : (this.deps.browser?.endpoint(user, sessionId) ?? null);
    if (browser) opts.mcpServers = { ...(opts.mcpServers ?? {}), [BROWSER_SERVER]: { type: "http", url: browser.url, headers: browser.headers } };
    /**
     * PreToolUse (runs in every permission mode, bypassPermissions included): the website check (may show a card),
     * refusals enforced, then read browser tools allowed and act tools left to the mode.
     */
    const browserHook = async (input: HookInput, id: string | undefined, ho?: { signal?: AbortSignal }) => {
      const name = String((input as { tool_name?: string }).tool_name ?? "");
      const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
      const toolUseID = (input as { tool_use_id?: string }).tool_use_id ?? id;
      const gate = await this.browserGate(row, cwdAbs, name, ti, { signal: ho?.signal ?? new AbortController().signal, ...(toolUseID ? { toolUseID } : {}) });
      if (!gate) return {};
      if (gate.behavior === "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
      return {
        // An unanswered website card stops the turn, like an unanswered permission card.
        ...(gate.interrupt ? { continue: false, stopReason: gate.message } : {}),
        hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: gate.message },
      };
    };
    // The website card may wait as long as any permission card: the hook must not time out first (a timed-out hook
    // would let the call through in bypassPermissions).
    const browserHookTimeoutS = Math.ceil(this.deps.limits.permissionTimeoutMs() / 1000) + 60;
    const browserHooks = [
      ...(browser ? [{ matcher: `mcp__${BROWSER_SERVER}__.*`, timeout: browserHookTimeoutS, hooks: [browserHook] }] : []),
      { matcher: CLAUDE_FILE_TOOLS, hooks: [browserHook] },
    ];
    if (row.kind === "chat") {
      // Built-in tools (`tools` limits Claude Code's own set; the hub's in-process MCP tools come on top): web search
      // and page reading, plus Read once the session has file attachments — for exactly those paths (canUseTool and
      // the PreToolUse gate below). strictMcpConfig: no MCP servers from the server's Claude config, only the hub's.
      // Chat runs the CLI in `default` mode so every call that is not pre-approved reaches canUseTool, which answers
      // without a permission card: web tools allowed, Read only for the attachments, anything else denied.
      // A research subagent: WebSearch and WebFetch only (no Read, no hub servers).
      // A chat with a folder of its own (chatFolder.ts) also runs code there: Bash in Claude Code's sandbox (no card;
      // writes only to the folder and a private temp dir, the rest of the users root and the credentials unreadable,
      // network on) and the file tools, path-checked to the folder (plus the attachment reads) in PreToolUse and here.
      const exec = !research && isChatFolder(row.cwd);
      proc.chatRead = !research && (exec || this.attachmentsOf(sessionId).size > 0);
      opts.tools = [...CHAT_WEB_TOOLS, ...(exec ? CHAT_EXEC_TOOLS : proc.chatRead ? ["Read"] : [])];
      opts.permissionMode = "default";
      opts.strictMcpConfig = true;
      if (exec) {
        // Inline settings (`--settings`, which the agent wrapper accepts as JSON): the CLI's `sandbox` and `env` keys.
        const settings = { cleanupPeriodDays: RETENTION_DAYS, sandbox: chatSandbox({ folder: cwdAbs, usersRoot: dirname(root), tmpDir }), env: { ...chatCommandEnv(cwdAbs), ...toolLimitEnv(this.deps.toolMemoryLimitMb?.() ?? 0) } };
        opts.settings = settings as unknown as NonNullable<SdkOptions["settings"]>;
        // TMPDIR too: the sandbox's network bridge sockets go into the CLI's os.tmpdir(), which must be a directory the
        // sandbox re-opens (in /tmp they would be hidden by the /tmp read deny and no host would be reachable).
        opts.env = { ...opts.env, TMPDIR: tmpDir };
      }
      opts.systemPrompt = chatSystemPrompt(memoryOn ? { section: proc.memorySection } : null, history.length > 0, {
        read: proc.chatRead,
        exec,
        download: exec && !!this.deps.downloads,
        incognito: row.incognito,
        now: this.clock(),
        browser: !!browser,
        subagents: !child,
        subagent: child,
        cwdAbs,
        instructions: proc.instructions,
        knownHeadsUps: proc.knownHeadsUps,
        docs: !!docs,
      });
      if (memoryOn) addServer(MEMORY_SERVER, memories.tools(user, sessionId).map((t) => this.ownMemoryTool(t, proc, user)));
      if (history.length) addServer(HISTORY_SERVER, history);
      if (!research) addServer(VISUAL_SERVER, [visualTool()]);
      // The heads-up card (pre-approved: it only shows something); not for research subagents.
      if (!child) addServer(TURN_SERVER, [headsUpTool()]);
      // run_subagents (research subagents), pre-approved by name: each batch asks the person itself (subagents.ts).
      if (!child) addServer(SUBAGENT_SERVER, [this.subagents.tool(row)]);
      // download_file (chats with a folder of their own), pre-approved by name: the tool itself checks the address and
      // asks the person when the safety check does not judge it safe (download.ts).
      if (exec && this.deps.downloads) addServer(DOWNLOAD_SERVER, [this.deps.downloads.tool(sessionId, cwdAbs, (input, signal) => this.approveDownload(row, cwdAbs, input, signal))]);
      // read_workstation_docs (read-only, pre-approved); not for research subagents.
      if (docs) addServer(DOCS_SERVER, [docsTool(docs)]);
      const preApproved = [...(opts.allowedTools ?? [])];
      opts.canUseTool = async (toolName, input, o) => this.chatCanUseTool(row, cwdAbs, exec, toolName, input, preApproved, o);
      // PreToolUse runs before any permission rule (e.g. Claude Code's own reads inside the cwd): file tools only for
      // the chat folder (exec) or the attachments.
      const fileGate = async (input: HookInput) => {
        const name = String((input as { tool_name?: string }).tool_name ?? "");
        const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
        const verdict = this.chatFileVerdict(row, cwdAbs, exec, name, ti);
        if (verdict === null || verdict.behavior === "allow") return {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: verdict.message } };
      };
      // The files the chat's agent wrote are the session's outputs (paths relative to the user root): Write / Edit
      // targets, and what a command left in the folder (files changed since it started).
      const commandStarts = new Map<string, number>();
      const toolUseIdOf = (input: HookInput, id: string | undefined): string => (input as { tool_use_id?: string }).tool_use_id ?? id ?? "";
      const outputs = (input: HookInput, id: string | undefined): void => {
        try {
          const tool = String((input as { tool_name?: string }).tool_name ?? "?");
          const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
          let files: string[];
          if (tool === "Bash") {
            const since = commandStarts.get(toolUseIdOf(input, id)) ?? Date.now();
            commandStarts.delete(toolUseIdOf(input, id));
            files = this.chatCommandOutputs(cwdAbs, since);
          } else files = typeof ti.file_path === "string" ? [resolve(cwdAbs, ti.file_path)] : [];
          const turn = (this.deps.store.getSession(sessionId)?.turnCount ?? 0) + 1;
          for (const abs of files) {
            const rel = insideChatFolder(abs, cwdAbs, cwdAbs) ? (toRelPath(rootReal, abs) ?? toRelPath(root, abs)) : null;
            if (rel) this.deps.store.insertFileTouch({ sessionId, user, path: rel, tool, turn });
          }
        } catch (err) {
          this.deps.log.debug({ err: errorMessage(err) }, "chat file touch hook failed");
        }
      };
      opts.hooks = {
        PreToolUse: [
          { matcher: exec ? CHAT_FILE_TOOLS : "Read", hooks: [fileGate] },
          ...(exec
            ? [
                {
                  matcher: "Bash",
                  hooks: [
                    async (input: HookInput, id: string | undefined) => {
                      commandStarts.set(toolUseIdOf(input, id), Date.now());
                      return {};
                    },
                  ],
                },
              ]
            : []),
          ...browserHooks,
        ],
        ...(exec
          ? {
              PostToolUse: [
                {
                  matcher: "Write|Edit|Bash",
                  hooks: [
                    async (input: HookInput, id: string | undefined) => {
                      outputs(input, id);
                      return {};
                    },
                  ],
                },
              ],
            }
          : {}),
      };
    } else {
      // The Agent Workstation guide (what this session has: browser, past conversations, show_visual, memories), the
      // user's instructions, the heads-ups they already know, then the saved memories (read-only here).
      const guide = workstationGuide(this.guideContext(row, cwdAbs, { memory: !!proc.memorySection, history: history.length > 0, browser: !!browser, subagents: !child, docs: !!docs }));
      // Without project settings the CLI reads no CLAUDE.md: the hub reads the cwd's (confined to it) and puts them after the guide.
      const projectOn = this.deps.projectSettings?.() === true;
      const projectText = row.kind === "code" && !projectOn ? this.projectInstructionsSection(cwdAbs) : null;
      const append = [guide, projectText, userInstructionsSection(proc.instructions), proc.knownHeadsUps, proc.memorySection].filter((x): x is string => !!x).join("\n\n");
      opts.systemPrompt = { type: "preset", preset: "claude_code", append };
      if (history.length) addServer(HISTORY_SERVER, history);
      addServer(VISUAL_SERVER, [visualTool()]);
      // The end-of-turn box and the heads-up card (pre-approved: they only show something). The task list is Claude
      // Code's own TodoWrite. A subagent's final message is its answer: neither.
      if (!child) addServer(TURN_SERVER, [this.wrapUp(sessionId), headsUpTool()]);
      // run_subagents (pre-approved by name: each batch asks the person itself, in every mode; the children's own
      // tool calls follow the permission mode).
      if (!child) addServer(SUBAGENT_SERVER, [this.subagents.tool(row)]);
      // read_workstation_docs (read-only, pre-approved).
      if (docs) addServer(DOCS_SERVER, [docsTool(docs)]);
      if (projectOn) {
        const extraDirs = this.deps.skillDirs?.(user, cwdAbs) ?? [];
        if (extraDirs.length) opts.additionalDirectories = extraDirs;
      } else {
        // The skills, commands and agents come as plugins that hold nothing else (no hooks, no MCP servers).
        const plugins = this.deps.projectPlugins?.(user, cwdAbs) ?? [];
        if (plugins.length) opts.plugins = plugins.map((path) => ({ type: "local" as const, path, skipMcpDiscovery: true }));
      }
      // The session works only inside its cwd (codeSandbox.ts): commands in Claude Code's sandbox (inline settings, like
      // a chat's, but following the permission mode; network to public hosts only, see below), package
      // caches in the process's temp directory, and TMPDIR = that directory (the sandbox's network bridge sockets go
      // into the CLI's os.tmpdir(), which must be a directory the sandbox re-opens). Subagents get the same options.
      // In auto / bypassPermissions / dontAsk the CLI decides network requests itself (canUseTool never sees them): the
      // sandbox then only reaches the known development hosts (strict allowlist); a mode change across the two groups
      // restarts the process before its next turn (networkStale).
      proc.strictNetwork = strictNetworkMode(row.permissionMode);
      const sandbox = codeSandbox({ cwd: cwdAbs, usersRoot: dirname(root), tmpDir, strictNetwork: proc.strictNetwork });
      // With `[sessions] tool_memory_limit_mb`, the CLI also caps its commands' memory (toolLimitEnv; off by default).
      // `disableAllHooks` silences the hooks of settings files and plugins; the hub's own hooks are SDK callbacks and keep
      // running (checked against the CLI: a project's PreToolUse command hook stays quiet, the callbacks fire).
      const settings = {
        cleanupPeriodDays: RETENTION_DAYS,
        sandbox,
        env: { ...codeCommandEnv(tmpDir), ...toolLimitEnv(this.deps.toolMemoryLimitMb?.() ?? 0) },
        ...(this.deps.projectSettings?.() ? {} : { disableAllHooks: true }),
      };
      opts.settings = settings as unknown as NonNullable<SdkOptions["settings"]>;
      opts.env = { ...opts.env, TMPDIR: tmpDir };
      // PreToolUse (every permission mode, bypassPermissions included): a command that sends data out of the session
      // (outbound.ts) waits for the person's own card. Allowed → the hook decides nothing more (the mode goes on as
      // usual; canUseTool does not ask a second time); denied / unanswered → refused (an unanswered card stops the turn).
      const outboundGate = async (input: HookInput, id: string | undefined, ho?: { signal?: AbortSignal }) => {
        const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
        const toolUseID = toolUseIdOf(input, id);
        const verdict = await this.outboundVerdict(row, cwdAbs, ti, ti.command, ho?.signal ?? new AbortController().signal, toolUseID);
        if (verdict === null) return {};
        if (verdict.behavior === "allow") {
          if (toolUseID) proc.outboundAllowed.add(toolUseID);
          return {};
        }
        return {
          ...(verdict.interrupt ? { continue: false, stopReason: verdict.message } : {}),
          hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: verdict.message },
        };
      };
      // PreToolUse (every permission mode, before any rule): file tools only inside the cwd (plus attachment reads).
      const codeFileGate = async (input: HookInput) => {
        const name = String((input as { tool_name?: string }).tool_name ?? "");
        const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
        const verdict = this.codeFileVerdict(row, cwdAbs, codeReads, name, ti);
        if (verdict === null || verdict.behavior === "allow") return {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: verdict.message } };
      };
      const projects = this.deps.projects;
      /** Target of a write tool, relative to the user root (null when outside it). */
      const targetRel = (input: HookInput): string | null => {
        const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
        const p = typeof ti.file_path === "string" ? ti.file_path : typeof ti.notebook_path === "string" ? ti.notebook_path : null;
        if (!p) return null;
        const abs = p.startsWith("/") ? p : join(cwdAbs, p);
        return toRelPath(rootReal, abs) ?? toRelPath(root, abs);
      };
      const toolUseIdOf = (input: HookInput, id: string | undefined): string | undefined => (input as { tool_use_id?: string }).tool_use_id ?? id;
      const release = async (input: HookInput, id: string | undefined) => {
        projects?.releaseTool(toolUseIdOf(input, id));
        return {};
      };
      opts.hooks = {
        PreToolUse: [
          ...browserHooks,
          { matcher: CODE_FILE_TOOLS, hooks: [codeFileGate] },
          // The card may wait as long as any permission card: the hook must not time out first (a timed-out hook would
          // let the command through in bypassPermissions).
          { matcher: "Bash", timeout: browserHookTimeoutS, hooks: [outboundGate] },
          {
            matcher: TOUCH_TOOLS,
            timeout: 120,
            hooks: [
              async (input: HookInput, id: string | undefined) => {
                // A subagent's area and its siblings' files (every permission mode, before any card).
                const ti = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
                const guard = this.claudeWriteGuard(row, cwdAbs, String((input as { tool_name?: string }).tool_name ?? ""), ti, toolUseIdOf(input, id));
                if (guard) return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: guard } };
                try {
                  const rel = projects ? targetRel(input) : null;
                  const pj = rel ? projects!.projectForPath(user, rel) : null;
                  const toolUseId = toolUseIdOf(input, id);
                  if (pj && pj.inner && toolUseId) await projects!.beforeWrite(toolUseId, sessionId, pj.id);
                } catch (err) {
                  this.deps.log.debug({ err: errorMessage(err) }, "PreToolUse hold failed");
                }
                return {};
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: TOUCH_TOOLS,
            hooks: [
              async (input: HookInput, id: string | undefined) => {
                try {
                  const rel = targetRel(input);
                  if (rel) {
                    const cur = this.deps.store.getSession(sessionId);
                    const tool = String((input as { tool_name?: string }).tool_name ?? "?");
                    const turn = (cur?.turnCount ?? 0) + 1;
                    const pj = projects?.projectForPath(user, rel) ?? null;
                    if (pj && pj.inner) {
                      this.deps.store.insertFileTouch({ sessionId, user, path: pj.inner, tool, turn, projectId: pj.id });
                      this.lives.get(sessionId)?.turnProjects.add(pj.id);
                    } else {
                      this.deps.store.insertFileTouch({ sessionId, user, path: rel, tool, turn });
                    }
                    projects?.releaseTool(toolUseIdOf(input, id));
                    if (pj && pj.inner) projects!.changed(pj.id);
                  } else {
                    projects?.releaseTool(toolUseIdOf(input, id));
                  }
                } catch (err) {
                  projects?.releaseTool(toolUseIdOf(input, id));
                  this.deps.log.debug({ err: errorMessage(err) }, "file touch hook failed");
                }
                return {};
              },
            ],
          },
        ],
        PostToolUseFailure: [{ matcher: TOUCH_TOOLS, hooks: [release] }],
        PermissionDenied: [
          {
            matcher: TOUCH_TOOLS,
            hooks: [
              async (input: HookInput, id: string | undefined) => {
                // A subagent's claim on the file goes with the refused call.
                this.subagents.writeRefused(sessionId, toolUseIdOf(input, id));
                return release(input, id);
              },
            ],
          },
        ],
      };
    }
    const capture = (child: { pid?: number | undefined; stderr: NodeJS.ReadableStream | null }) => {
      proc.pid = child.pid ?? null;
      child.stderr?.on("data", (d: Buffer) => {
        proc.stderrTail = (proc.stderrTail + d.toString("utf8")).slice(-4000);
      });
    };
    // As the agent account the pid is the sudo process (its RSS is sudo's, not Claude's). Either way the process's temp
    // directory is created before it starts and removed when it exits.
    Object.assign(
      opts,
      claudeProcessOptions({ agentExec: this.deps.agentExec, claudeExecutable: this.deps.claudeExecutable, log: childLogger(this.deps.log, { sessionId }), onChild: this.deps.captureProcess !== false ? capture : undefined }),
    );
    return opts;
  }

  /**
   * canUseTool of a Claude Chat session: never a permission card. `exec` (a chat with its own folder): Bash runs in
   * Claude Code's sandbox (never with dangerouslyDisableSandbox), the sandbox's network requests are allowed, and the
   * file tools are limited to the folder (plus the attachment reads).
   */
  private async chatCanUseTool(
    row: SessionRow,
    cwdAbs: string,
    exec: boolean,
    toolName: string,
    input: Record<string, unknown>,
    preApproved: readonly string[],
    o: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const allow: PermissionResult = { behavior: "allow", updatedInput: input };
    // Browser: read tools only (browserVerdict denies act tools in chats), after the website check (the one card a
    // chat can show).
    const gate = await this.browserGate(row, cwdAbs, toolName, input, o);
    if (gate) return gate.behavior === "allow" ? allow : gate;
    // A research subagent: WebSearch and WebFetch only.
    if (row.parentSessionId) return (CHAT_WEB_TOOLS as readonly string[]).includes(toolName) ? allow : { behavior: "deny", message: RESEARCH_TOOL_DENIED };
    if ((CHAT_WEB_TOOLS as readonly string[]).includes(toolName) || preApproved.includes(toolName)) return allow;
    if (exec && toolName === "Bash") return input.dangerouslyDisableSandbox === true ? { behavior: "deny", message: "Commands in this chat always run in the sandbox." } : allow;
    // Only the allowlisted package hosts (they are also the sandbox's allowedDomains, so this is a second line).
    if (exec && toolName === SANDBOX_NETWORK_TOOL) {
      const ok = chatHostAllowed(input.host);
      // audit trail of every network attempt from a chat's sandbox (the request carries no secrets)
      this.deps.log.info({ sessionId: row.id, input, allowed: ok }, "chat sandbox network request");
      return ok ? allow : { behavior: "deny", message: CHAT_NETWORK_DENIED };
    }
    const file = this.chatFileVerdict(row, cwdAbs, exec, toolName, input);
    if (file) return file.behavior === "allow" ? allow : file;
    return { behavior: "deny", message: exec ? CHAT_EXEC_TOOL_DENIED : CHAT_TOOL_DENIED };
  }

  /**
   * The card of a download the safety check did not judge safe: always a card (no rules; the input is never
   * replaced). An unanswered card stops the turn, like any other.
   */
  private async approveDownload(row: SessionRow, cwdAbs: string, input: Record<string, unknown>, signal: AbortSignal): Promise<DownloadApproval> {
    const result = await this.permissions.request({ sessionId: row.id, user: row.user, cwd: cwdAbs }, DOWNLOAD_TOOL_NAME, input, { signal, alwaysAsk: true });
    if (result.behavior === "allow") return { answer: "allow" };
    if (result.message === TIMEOUT_DENY_MESSAGE) {
      const live = this.lives.get(row.id);
      if (live?.proc && live.turn) void live.proc.q.interrupt().catch(() => undefined);
      return { answer: "timeout", message: TIMEOUT_DENY_MESSAGE };
    }
    return { answer: signal.aborted || result.interrupt ? "cancelled" : "deny" };
  }

  /**
   * What a command run in a chat folder produced: the files there changed since it started (minus a little slack for
   * the file system's coarse clock), absolute paths.
   */
  private chatCommandOutputs(folder: string, startedAt: number): string[] {
    return filesChangedSince(folder, startedAt - 50);
  }

  /**
   * A chat's file tool call: inside the chat's own folder (`exec`), or Read of one of the session's attachments →
   * allow; any other path → deny with the reason. null = not a file tool this chat has.
   */
  private chatFileVerdict(row: SessionRow, cwdAbs: string, exec: boolean, toolName: string, input: Record<string, unknown>): { behavior: "allow" } | { behavior: "deny"; message: string } | null {
    const fileTool = exec ? chatFileToolPaths(toolName, input, cwdAbs) !== null : toolName === "Read";
    if (!fileTool) return null;
    if (exec && chatFolderAllows(toolName, input, cwdAbs, cwdAbs)) return { behavior: "allow" };
    if (toolName === "Read" && this.attachmentPath(row, cwdAbs, input.file_path)) return { behavior: "allow" };
    return { behavior: "deny", message: exec ? CHAT_FOLDER_DENIED : ATTACHMENT_READ_DENIED };
  }

  /**
   * A Claude code session's file tool call (codeSandbox.ts): every path inside the cwd (read tools also `readDirs`), or
   * Read of one of the session's attachments → allow (the permission mode then decides as usual); any other path →
   * deny with the reason. null = not a file tool.
   */
  private codeFileVerdict(row: SessionRow, cwdAbs: string, readDirs: readonly string[], toolName: string, input: Record<string, unknown>): { behavior: "allow" } | { behavior: "deny"; message: string } | null {
    const paths = codeFileToolPaths(toolName, input, cwdAbs);
    if (paths === null) return null;
    // The project's agent settings (.claude/, .mcp.json): only the person changes them.
    if (CODE_WRITE_TOOLS.has(toolName) && paths.some((p) => touchesProjectSettings(p, cwdAbs))) return { behavior: "deny", message: PROJECT_SETTINGS_DENIED };
    if (codeFolderAllows(toolName, input, cwdAbs, readDirs)) return { behavior: "allow" };
    if (toolName === "Read" && this.attachmentPath(row, cwdAbs, input.file_path)) return { behavior: "allow" };
    return { behavior: "deny", message: CODE_FOLDER_DENIED };
  }

  /**
   * A Claude code session's SandboxNetworkAccess request (canUseTool: `default`, `acceptEdits` and `plan` modes):
   *   - loopback, private, link-local, CGNAT / tailnet and ULA addresses (or a failed lookup): refused, no card;
   *   - a known development download host (DEV_DOWNLOAD_HOSTS, subdomains included): allowed, no card;
   *   - a host the person already allowed in this session (or its parent's): allowed;
   *   - any other public host: a card (no rules; once allowed, remembered for the session); `dontAsk`: refused.
   * Every decision is logged.
   */
  private async codeNetworkVerdict(row: SessionRow, cwdAbs: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<PermissionResult> {
    const v = await publicHostVerdict(input.host, this.deps.resolveHost);
    // audit trail of every network attempt from a code session's sandbox (the request carries no secrets)
    const audit = (allowed: boolean, how: string) =>
      this.deps.log.info({ sessionId: row.id, input, addresses: v.addresses, allowed, how, ...(v.reason ? { reason: v.reason } : {}) }, "code sandbox network request");
    if (!v.allowed || !v.host) {
      audit(false, "non-public");
      return { behavior: "deny", message: CODE_NETWORK_DENIED };
    }
    const host = v.host;
    if (knownDevHost(host)) {
      audit(true, "known host");
      return { behavior: "allow", updatedInput: input };
    }
    const remembered = (id: string | null | undefined) => !!id && !!this.sessionHosts.get(id)?.has(host);
    if (remembered(row.id) || remembered(row.parentSessionId)) {
      audit(true, "allowed earlier in this session");
      return { behavior: "allow", updatedInput: input };
    }
    const mode = this.deps.store.getSession(row.id)?.permissionMode ?? row.permissionMode;
    if (mode === "dontAsk") {
      audit(false, "no card in dontAsk");
      return { behavior: "deny", message: CODE_HOST_NO_ASK };
    }
    const result = await this.permissions.request({ sessionId: row.id, user: row.user, cwd: cwdAbs }, SANDBOX_NETWORK_TOOL, input, {
      signal: o.signal,
      ...(o.toolUseID ? { toolUseID: o.toolUseID } : {}),
      alwaysAsk: true,
    });
    audit(result.behavior === "allow", "card");
    if (result.behavior !== "allow") return result;
    let set = this.sessionHosts.get(row.id);
    if (!set) this.sessionHosts.set(row.id, (set = new Set()));
    set.add(host);
    return { behavior: "allow", updatedInput: input };
  }

  /**
   * A code session's command (Bash in PreToolUse) that
   * sends data out (outbound.ts): the person's own card, in every permission mode (no rules, nothing remembered; in
   * `dontAsk` refused without one). null = not an outbound command (the mode decides as usual).
   */
  private async outboundVerdict(
    row: SessionRow,
    cwdAbs: string,
    input: Record<string, unknown>,
    command: unknown,
    signal: AbortSignal,
    toolUseID: string | undefined,
  ): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string; interrupt?: boolean } | null> {
    if (row.kind !== "code") return null;
    const what = outboundCommand(command);
    if (!what) return null;
    const mode = this.deps.store.getSession(row.id)?.permissionMode ?? row.permissionMode;
    this.deps.log.info({ sessionId: row.id, what, mode }, "outbound command");
    if (mode === "dontAsk") return { behavior: "deny", message: OUTBOUND_NO_ASK };
    const shown = { ...input, description: `Sends data out of this session (${what})` };
    const result = await this.permissions.request({ sessionId: row.id, user: row.user, cwd: cwdAbs }, "Bash", shown, {
      signal,
      ...(toolUseID ? { toolUseID } : {}),
      alwaysAsk: true,
    });
    if (result.behavior === "allow") return { behavior: "allow" };
    const timedOut = result.message === TIMEOUT_DENY_MESSAGE;
    return { behavior: "deny", message: timedOut ? TIMEOUT_DENY_MESSAGE : result.message && result.message !== "The user denied this action." ? result.message : OUTBOUND_DENIED, ...(timedOut ? { interrupt: true } : {}) };
  }

  /**
   * The hub's decision on a Claude tool call that concerns the server browser: its MCP tools (not offered, act in a chat,
   * act while the person controls the browser → deny; otherwise the website check, which may ask; then read → allow)
   * and file tools aimed at `<root>/.browser` (deny). null = not decided here (other tools; act tools in code sessions
   * that passed the website check, which follow the permission mode).
   */
  private async browserGate(row: SessionRow, cwdAbs: string, toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<SiteDecision | null> {
    const paths = claudeFileToolPaths(toolName, input);
    if (paths) {
      const root = this.deps.userRoot(row.user);
      let rootReal = root;
      try {
        rootReal = realpathSync(root);
      } catch {
        /* keep */
      }
      return touchesBrowserDir(paths, cwdAbs, [root, rootReal]) ? { behavior: "deny", message: BROWSER_DIR_DENIED } : null;
    }
    const cls = browserToolClass(toolName, input);
    if (cls === undefined) return null;
    const v = browserVerdict(cls, row.kind, this.deps.browser?.controlledBy(row.user) ?? null);
    if (v.behavior === "deny") return v;
    const site = await this.browserSiteCheck(row, cwdAbs, toolName, input, o);
    if (site.behavior === "deny") return site;
    return v.behavior === "mode" ? null : v;
  }

  /**
   * A Agent Workstation subagent's write guard for Claude's file-changing tools (Write / Edit / MultiEdit / NotebookEdit; see
   * subagents.ts checkWrite): the denial text, or null (not such a tool, not a running code child, or allowed).
   */
  private claudeWriteGuard(row: SessionRow, cwdAbs: string, toolName: string, input: Record<string, unknown>, toolUseId: string | undefined): string | null {
    if (!row.parentSessionId || row.kind !== "code" || !TOUCH_TOOL_SET.has(toolName)) return null;
    return this.subagents.checkWrite(row.id, cwdAbs, [toolName === "NotebookEdit" ? (input.notebook_path ?? input.file_path) : input.file_path], toolUseId);
  }

  /**
   * Whether the website a browser tool call touches is allowed (browserSiteTarget + BrowserSites): asked in every
   * permission mode and in chats; code sessions in dontAsk are denied instead.
   */
  private async browserSiteCheck(row: SessionRow, cwdAbs: string, toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<SiteDecision> {
    const target = browserSiteTarget(toolName, input, (tab) => this.deps.browser?.pageUrl(row.user, tab) ?? null);
    if (target.kind === "none") return { behavior: "allow" };
    if (target.kind === "refused") return { behavior: "deny", message: target.message };
    // The current mode (a code session's mode can change while its process runs).
    const mode = this.deps.store.getSession(row.id)?.permissionMode ?? row.permissionMode;
    const canAsk = row.kind === "chat" || mode !== "dontAsk";
    return this.browserSites.check({ sessionId: row.id, user: row.user, cwd: cwdAbs, canAsk }, target.origin, toolName, input, {
      signal: o.signal,
      ...(o.toolUseID ? { toolUseID: o.toolUseID } : {}),
    });
  }

  /** The session's attachment paths (relative to the user root), cached. */
  private attachmentsOf(sessionId: string): Set<string> {
    let set = this.attachmentCache.get(sessionId);
    if (!set) {
      set = new Set(this.deps.store.attachmentPaths(sessionId));
      this.attachmentCache.set(sessionId, set);
    }
    return set;
  }

  /** The absolute path a chat model may read when `requested` names one of the session's attachments (else null). */
  private attachmentPath(row: Pick<SessionRow, "id" | "user">, cwdAbs: string, requested: unknown): string | null {
    const root = this.deps.userRoot(row.user);
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      /* keep */
    }
    return attachmentReadPath({ root, rootReal, cwdAbs, attachments: this.attachmentsOf(row.id) }, requested);
  }

  /** Imports transcript messages the hub missed (e.g. the hub died mid-turn). */
  private async reconcile(live: Live, row: SessionRow): Promise<void> {
    if (!row.claudeSessionId) return;
    let msgs: SessionMessage[];
    try {
      msgs = await this.deps.sdk.getSessionMessages(row.claudeSessionId);
    } catch (err) {
      this.deps.log.debug({ sessionId: row.id, err: errorMessage(err) }, "getSessionMessages failed (new session?)");
      return;
    }
    if (!msgs.length) return;
    const known = this.deps.store.messageUuids(row.id);
    let lastKnown = -1;
    msgs.forEach((m, i) => {
      if (known.has(m.uuid)) lastKnown = i;
    });
    if (lastKnown < 0 && known.size > 0) return; // transcript shares nothing with us: do not import a foreign history
    let added = 0;
    for (const m of msgs.slice(lastKnown + 1)) {
      if (known.has(m.uuid) || (m.type !== "user" && m.type !== "assistant")) continue;
      const content = (m.message as { content?: unknown } | null)?.content;
      if (m.type === "user" && LOCAL_COMMAND_RE.test(messageText(content))) continue;
      const stored = this.deps.store.appendMessage(row.id, {
        uuid: m.uuid,
        kind: m.type,
        payload: { type: m.type, uuid: m.uuid, session_id: m.session_id, message: m.message, parent_tool_use_id: m.parent_tool_use_id, reconciled: true },
      });
      if (stored) {
        added++;
        this.publishMessage(live.user, stored);
      }
    }
    if (added) this.deps.log.info({ sessionId: row.id, added }, "reconciled messages from the Claude transcript");
  }

  private feedNext(live: Live): void {
    const proc = live.proc;
    if (!proc || live.turn || live.pending.length === 0) return;
    // A chat that got its first file attachment: the resumed process has the Read tool.
    // A code session whose mode moved across the sandbox network groups: restart it with the right settings.
    if (this.toolsStale(live, proc) || this.networkStale(live, proc)) {
      this.closeProc(live, this.toolsStale(live, proc) ? "tools-changed" : "network-mode-changed");
      this.kick(live);
      return;
    }
    // API budget down to the service reserve while messages were queued: they are not sent.
    if (this.deps.billing?.overBudget()) {
      this.cancelPending(live, "api_limit_reached");
      this.deps.bus.toUser(live.user, { type: "error", code: "api_limit_reached", message: "This month's API budget is used up for sessions (the rest is kept for Agent Workstation's own services); the queued messages were not sent.", sessionId: live.id });
      this.startIdleTimer(live);
      this.refresh(live.id);
      return;
    }
    const next = live.pending.shift()!;
    this.beginTurn(live, next.uuid);
    live.lastActivity = Date.now();
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
    const row = this.deps.store.getSession(live.id);
    this.deps.store.setDelivery(live.id, next.uuid, "sent");
    // The turn snapshot holding the state before this turn (rewind with files) is the one of the turns done so far.
    if (row) this.deps.store.setMessageTurn(live.id, next.uuid, row.turnCount);
    proc.creditNoticeSent = false;
    proc.input.push(next.msg);
    this.refresh(live.id);
  }

  private async consume(live: Live, proc: Proc): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const m of proc.q) {
        if (live.proc !== proc) break;
        try {
          this.handle(live, proc, m);
        } catch (err) {
          this.deps.log.error({ sessionId: live.id, err: errorMessage(err), type: m.type }, "failed to handle SDK message");
        }
      }
      if (!proc.closedByHub && live.turn) failure = new Error("the Claude process exited in the middle of a turn");
    } catch (err) {
      if (!proc.closedByHub) failure = err;
    } finally {
      this.pool.release(proc.token);
      proc.input.close();
      this.deps.apiProxy?.revoke(proc.apiToken);
      if (live.proc === proc) {
        live.proc = null;
        live.partial = emptyPartial();
        this.subagents.stopAll(live.id);
        this.deps.downloads?.abortAll(live.id);
        this.endRunningTasks(live.id);
        if (live.idleTimer) {
          clearTimeout(live.idleTimer);
          live.idleTimer = null;
        }
        if (live.turn) live.turn = null;
        this.permissions.cancelSession(live.id, "The Claude process ended.");
        this.deps.projects?.releaseSession(live.id);
        if (failure && !this.shuttingDown) this.onProcessDied(live, proc, failure);
      }
      const waiters = live.stopWaiters.splice(0);
      waiters.forEach((w) => w());
      this.refresh(live.id);
      if (!live.dead && !this.shuttingDown && live.pending.length > 0 && !live.proc) this.kick(live);
      else this.maybeForget(live);
      this.deps.log.info({ sessionId: live.id, gen: proc.gen, reason: proc.closedByHub ? "closed" : failure ? "died" : "exited" }, "claude process ended");
    }
  }

  private onProcessDied(live: Live, proc: Proc, err: unknown): void {
    live.dead = true;
    const message = errorMessage(err);
    // stderr can echo what the process was given: credential-shaped text is masked before it is logged or stored.
    const stderr = redactSecrets(proc.stderrTail);
    this.deps.log.error({ sessionId: live.id, err: redactSecrets(message), stderr: stderr.slice(-500) }, "claude process died");
    this.persistSystem(live, "hub_process_died", { error: redactSecrets(message), stderr: stderr.slice(-1000) || undefined });
    this.deps.bus.toUser(live.user, { type: "error", code: "process_died", message, sessionId: live.id });
  }

  private closeProc(live: Live, reason: string): void {
    const proc = live.proc;
    if (!proc) return;
    proc.closedByHub = true;
    live.proc = null;
    live.turn = null;
    this.deps.projects?.releaseSession(live.id);
    live.partial = emptyPartial();
    // The process's subagents end with it (none run outside a turn, so an idle recycle stops nothing).
    this.subagents.stopAll(live.id);
    this.deps.downloads?.abortAll(live.id);
    this.endRunningTasks(live.id);
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
    proc.input.close();
    try {
      proc.q.close();
    } catch (err) {
      this.deps.log.debug({ err: errorMessage(err) }, "close() threw");
    }
    this.deps.apiProxy?.revoke(proc.apiToken);
    this.pool.release(proc.token);
    const waiters = live.stopWaiters.splice(0);
    waiters.forEach((w) => w());
    this.deps.log.info({ sessionId: live.id, reason, gen: proc.gen }, "claude process closed by hub");
  }

  private reclaimIdle(except: string): boolean {
    let victim: Live | null = null;
    for (const live of this.lives.values()) {
      if (live.id === except || !live.proc || live.turn || live.spawning || live.pending.length || this.permissions.hasPending(live.id)) continue;
      if (!victim || live.lastActivity < victim.lastActivity) victim = live;
    }
    if (!victim) return false;
    this.closeProc(victim, "evicted");
    this.refresh(victim.id);
    return true;
  }

  private startIdleTimer(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      if (live.proc && !live.turn && live.pending.length === 0 && !this.permissions.hasPending(live.id)) {
        this.closeProc(live, "idle");
        this.refresh(live.id);
        this.maybeForget(live);
      }
    }, this.deps.limits.idleMs());
    live.idleTimer.unref?.();
  }

  private cancelPending(live: Live, reason: string): void {
    if (live.waitingSlot) {
      this.pool.cancel(live.id);
      live.waitingSlot = false;
    }
    if (!live.pending.length) return;
    const uuids = live.pending.map((p) => p.uuid);
    live.pending = [];
    for (const u of uuids) this.deps.store.setDelivery(live.id, u, "cancelled");
    this.persistSystem(live, "hub_cancelled", { message_uuids: uuids, reason });
  }

  private persistSystem(live: Live, subtype: string, extra: Record<string, unknown>): void {
    const stored = this.deps.store.appendMessage(live.id, {
      uuid: newUuid(),
      kind: "system",
      payload: { type: "system", subtype, ...extra },
    });
    if (stored) this.publishMessage(live.user, stored);
  }

  private persist(live: Live, kind: StoredMessageKind, m: SDKMessage): MessageRow | null {
    const u = (m as { uuid?: string }).uuid || newUuid();
    const stored = this.deps.store.appendMessage(live.id, { uuid: u, kind, payload: m });
    if (stored) this.publishMessage(live.user, stored, m);
    return stored;
  }

  /** Broadcasts a persisted row; pass the payload object when at hand to skip a JSON round trip. */
  private publishMessage(_user: string, m: MessageRow, payload?: unknown): void {
    const message: StoredMessage =
      payload !== undefined
        ? { seq: m.seq, sessionId: m.sessionId, uuid: m.uuid, kind: m.kind, payload, at: m.at }
        : (JSON.parse(storedMessageJson(m)) as StoredMessage);
    this.deps.bus.toSession(m.sessionId, { type: "message", sessionId: m.sessionId, message });
  }

  private delta(live: Live, delta: StreamDelta): void {
    this.deps.bus.toSession(live.id, { type: "delta", sessionId: live.id, delta });
  }

  private notice(user: string, level: "info" | "warning" | "error", code: string, message: string): void {
    this.deps.bus.toUser(user, { type: "notice", level, code, message, at: iso(this.clock()) });
  }

  private handle(live: Live, proc: Proc, m: SDKMessage): void {
    live.lastActivity = Date.now();
    switch (m.type) {
      case "stream_event":
        return this.handleStreamEvent(live, m.event as unknown as StreamEventLike, m.parent_tool_use_id);
      case "assistant": {
        if (!live.turn) this.beginTurn(live, null);
        this.persist(live, "assistant", m);
        if (!m.parent_tool_use_id) {
          live.partial = { ...emptyPartial(), messageId: live.partial.messageId };
          this.noteRequest(live, m.message as unknown as { model?: string; usage?: unknown });
        }
        {
          const msg = m.message as unknown as { id?: string; model?: string; usage?: unknown };
          if (msg.id && msg.model !== "<synthetic>") {
            live.cost.note(msg.id, msg.model, msg.usage);
            this.sendCost(live);
          }
        }
        const text = messageText((m.message as { content?: unknown }).content);
        if (m.error === "billing_error" || isCreditBalanceText(text)) {
          this.creditsExhausted(live, proc, text);
        } else if (m.error === "authentication_failed") {
          this.notice(live.user, "error", "api_unavailable", "The Anthropic API key configured on the server was rejected. Replace the key.");
        } else if (m.error === "rate_limit") {
          this.notice(live.user, "warning", "rate_limit", "The Anthropic API rate-limited this request. Try again in a moment.");
        }
        this.refresh(live.id);
        return;
      }
      case "user": {
        const u = m.uuid;
        if (u && this.deps.store.hasMessage(live.id, u)) return; // echo of our own message
        this.persist(live, "user", m);
        return;
      }
      case "result": {
        const turnUserUuid = live.turn?.userUuid ?? null;
        const lastRequest = live.lastRequest;
        this.persist(live, "result", m);
        this.accountUsage(live, proc, m);
        this.endTurnInProjects(live, turnUserUuid);
        if (m.is_error) {
          const why = [m.subtype === "success" ? m.result : "", ...(((m as { errors?: unknown }).errors as unknown[] | undefined) ?? []).map(String)].join(" ");
          if (isCreditBalanceText(why)) this.creditsExhausted(live, proc, why);
        }
        live.turn = null;
        live.tokens.reset();
        live.cost.reset();
        live.costSent = -1;
        live.lastRequest = null;
        live.partial = emptyPartial();
        void this.refreshContextUsage(live, proc, m, lastRequest);
        const waiters = live.stopWaiters.splice(0);
        waiters.forEach((w) => w());
        if (live.pending.length) this.feedNext(live);
        else {
          this.startIdleTimer(live);
          this.deps.onTurnIdle?.(live.id);
        }
        this.refresh(live.id);
        // A queued session may now take over this (idle) process's slot.
        if (!live.turn && this.pool.queuedCount > 0) this.pool.pump();
        return;
      }
      case "conversation_reset":
        // `new_conversation_id` is not a resumable session id (observed: it equals the
        // message's own uuid). The new Claude session id arrives in the next `init`, which
        // moves the old id into claude_history. Usage totals restart; computeUsageDelta
        // treats the drop as a fresh start.
        this.persist(live, "reset", m);
        return;
      case "system":
        return this.handleSystem(live, proc, m);
      default:
        return;
    }
  }

  private handleSystem(live: Live, proc: Proc, m: Extract<SDKMessage, { type: "system" }>): void {
    // How a background task ended (live state only, never part of the transcript).
    if ((m as { subtype?: string }).subtype === "task_notification") {
      const n = m as unknown as { task_id?: unknown; status?: unknown };
      const end = taskEndOf(n.status);
      if (typeof n.task_id === "string" && end) this.noteTaskEnd(live.id, n.task_id, end);
      return;
    }
    switch (m.subtype) {
      case "init": {
        const row = this.deps.store.getSession(live.id);
        if (!row) return;
        if (m.session_id && m.session_id !== row.claudeSessionId) {
          const history = row.claudeSessionId && !row.claudeHistory.includes(row.claudeSessionId) ? [...row.claudeHistory, row.claudeSessionId] : row.claudeHistory;
          // The rewind / fork start point is used up once the new conversation exists.
          const updated = this.deps.store.updateSession(live.id, {
            claudeSessionId: m.session_id,
            claudeHistory: history,
            ...(row.resumeFrom || row.resumeAt ? { resumeFrom: null, resumeAt: null } : {}),
          });
          if (updated) this.deps.bus.toUser(live.user, { type: "session_updated", session: this.toProtocol(updated) });
        }
        if (!proc.initPersisted) {
          proc.initPersisted = true;
          this.persist(live, "system", m);
          const source = (m as { apiKeySource?: string }).apiKeySource;
          if (source && source !== "ANTHROPIC_API_KEY") {
            this.deps.log.warn({ sessionId: live.id, apiKeySource: source }, "Claude process does not report the API key as its credential");
          }
        }
        if (row.kind === "code" && m.permissionMode && m.permissionMode !== row.permissionMode && !proc.modeDeferred) {
          const updated = this.deps.store.updateSession(live.id, { permissionMode: m.permissionMode });
          if (updated) this.broadcastSettings(updated);
        }
        if (!proc.catalogFetched && this.deps.catalog) {
          proc.catalogFetched = true;
          const global = this.deps.catalog.needsRefresh();
          void this.deps.catalog.refreshFrom(proc.q, { sessionId: live.id, global });
        }
        return;
      }
      case "status": {
        if (m.permissionMode || m.compact_result) this.persist(live, "system", m);
        const row = this.deps.store.getSession(live.id);
        if (row && row.kind === "code" && m.permissionMode && m.permissionMode !== row.permissionMode && !proc.modeDeferred) {
          const updated = this.deps.store.updateSession(live.id, { permissionMode: m.permissionMode });
          if (updated) this.broadcastSettings(updated);
        }
        return;
      }
      case "compact_boundary":
      case "local_command_output":
      case "informational":
        this.persist(live, "system", m);
        return;
      case "api_retry":
        if (m.error === "rate_limit") this.notice(live.user, "warning", "rate_limit", "Claude is rate limited; retrying…");
        return;
      case "commands_changed":
        this.deps.catalog?.setSessionCommands(live.id, m.commands);
        return;
      case "background_tasks_changed":
        // Live state only: never part of the transcript.
        this.setTasks(live.id, (m as unknown as { tasks?: SdkBackgroundTask[] }).tasks ?? []);
        return;
      default:
        return;
    }
  }

  private tasksOf(sessionId: string): SessionTasks {
    let s = this.taskState.get(sessionId);
    if (!s) {
      s = { list: [], notified: new Map(), stopRequested: new Set() };
      this.taskState.set(sessionId, s);
    }
    return s;
  }

  /**
   * The SDK's current list of running tasks: new ones are added (startedAt = first seen), running ones are updated, and
   * running ones that left the list end — as their task_notification said, "stopped" when the user stopped them, else
   * "completed". Subscribers get the full list (running and ended) on every change.
   */
  private setTasks(sessionId: string, current: SdkBackgroundTask[]): void {
    const s = this.tasksOf(sessionId);
    const now = iso(this.clock());
    const ids = new Set(current.map((t) => t.task_id));
    const next = s.list.map((t): BackgroundTask => {
      // Agent Workstation subagents are not the SDK's: they end when their run_subagents call does.
      if (!isRunning(t) || ids.has(t.taskId) || t.type === SUBAGENT_TASK_TYPE) return t;
      return this.endedTask(s, t, s.notified.get(t.taskId) ?? (s.stopRequested.has(t.taskId) ? "stopped" : "completed"), now);
    });
    for (const t of current) {
      const view: BackgroundTask = {
        taskId: t.task_id,
        type: t.task_type,
        description: t.description,
        ...(t.subagent_type ? { subagentType: t.subagent_type } : {}),
        startedAt: now,
        status: "running",
        endedAt: null,
      };
      const i = next.findIndex((x) => x.taskId === t.task_id && isRunning(x));
      if (i >= 0) next[i] = { ...view, startedAt: next[i]!.startedAt };
      else next.push(view);
    }
    this.commitTasks(sessionId, s, next);
  }

  /** A task_notification: remembered for when the task leaves the list; an already ended task takes the status. */
  private noteTaskEnd(sessionId: string, taskId: string, end: TaskEnd): void {
    const s = this.tasksOf(sessionId);
    const ended = [...s.list].reverse().find((t) => t.taskId === taskId);
    if (ended && !isRunning(ended)) {
      if (ended.status === end) return;
      this.commitTasks(sessionId, s, s.list.map((t) => (t === ended ? { ...t, status: end } : t)));
      return;
    }
    s.notified.set(taskId, end);
  }

  /** The process ended: its still-running tasks end with it ("stopped", unless a notification said otherwise). */
  private endRunningTasks(sessionId: string): void {
    const s = this.taskState.get(sessionId);
    if (!s) return;
    const now = iso(this.clock());
    // Agent Workstation subagents end through their run_subagents call (stopped by subagents.stopAll).
    const ends = (t: BackgroundTask) => isRunning(t) && t.type !== SUBAGENT_TASK_TYPE;
    if (s.list.some(ends)) this.commitTasks(sessionId, s, s.list.map((t) => (ends(t) ? this.endedTask(s, t, s.notified.get(t.taskId) ?? "stopped", now) : t)));
    // Nothing of the old process is pending any more.
    s.notified.clear();
    s.stopRequested.clear();
  }

  private endedTask(s: SessionTasks, t: BackgroundTask, status: TaskEnd, at: string): BackgroundTask {
    s.notified.delete(t.taskId);
    s.stopRequested.delete(t.taskId);
    return { ...t, status, endedAt: at };
  }

  /** Stores the list (the oldest ended tasks beyond MAX_ENDED_TASKS dropped) and broadcasts it when it changed. */
  private commitTasks(sessionId: string, s: SessionTasks, list: BackgroundTask[]): void {
    let drop = list.filter((t) => !isRunning(t)).length - MAX_ENDED_TASKS;
    const tasks = drop > 0 ? list.filter((t) => isRunning(t) || drop-- <= 0) : list;
    if (JSON.stringify(tasks) === JSON.stringify(s.list)) return;
    s.list = tasks;
    this.deps.bus.toSession(sessionId, { type: "background_tasks", sessionId, tasks: [...tasks] });
  }

  private handleStreamEvent(live: Live, ev: StreamEventLike, parentToolUseId: string | null): void {
    // Subagent partials (parent_tool_use_id set) are not folded, but their tokens count towards the turn.
    const thread = parentToolUseId ?? "";
    const main = !parentToolUseId;
    const p = live.partial;
    switch (ev.type) {
      case "message_start": {
        const messageId = ev.message?.id ?? newUuid();
        if (main) {
          live.partial = { ...emptyPartial(), messageId };
          if (!live.turn) this.beginTurn(live, null);
          this.noteRequest(live, ev.message);
        }
        live.tokens.start(thread, messageId, ev.message?.usage?.output_tokens);
        live.cost.note(messageId, ev.message?.model, ev.message?.usage);
        this.sendUsage(live, main);
        this.sendCost(live);
        return;
      }
      case "message_delta":
        if (live.tokens.report(thread, ev.usage?.output_tokens)) this.sendUsage(live, true);
        if (live.tokens.messageIdOf(thread)) {
          live.cost.note(live.tokens.messageIdOf(thread), null, ev.usage);
          this.sendCost(live);
        }
        return;
      case "content_block_start": {
        const b = ev.content_block;
        if (main && b?.type === "tool_use" && b.id && b.name) {
          p.currentTool = { toolUseId: b.id, toolName: b.name, partialJson: "" };
          this.delta(live, { part: "tool_use_start", messageId: p.messageId ?? "", toolUseId: b.id, toolName: b.name });
        }
        return;
      }
      case "content_block_delta": {
        const d = ev.delta;
        live.tokens.streamed(thread, d?.text ?? d?.thinking ?? d?.partial_json ?? "");
        if (main) {
          const messageId = p.messageId ?? "";
          if (d?.type === "text_delta" && d.text) {
            p.text += d.text;
            this.delta(live, { part: "text", messageId, text: d.text });
          } else if (d?.type === "thinking_delta" && d.thinking) {
            p.thinking += d.thinking;
            this.delta(live, { part: "thinking", messageId, text: d.thinking });
          } else if (d?.type === "input_json_delta" && d.partial_json && p.currentTool) {
            p.currentTool.partialJson += d.partial_json;
            this.delta(live, { part: "tool_use_input", messageId, toolUseId: p.currentTool.toolUseId, partialJson: d.partial_json });
          }
        }
        this.sendUsage(live, false);
        return;
      }
      case "message_stop":
        live.tokens.finish(thread);
        if (!main) return;
        if (p.messageId) this.delta(live, { part: "message_end", messageId: p.messageId });
        live.partial = emptyPartial();
        return;
      default:
        return;
    }
  }

  /** Starts a turn: elapsed time and the live token counter count from here. */
  private beginTurn(live: Live, userUuid: string | null): void {
    live.turn = { userUuid, startedAt: Date.now() };
    live.tokens.reset();
    live.lastRequest = null;
  }

  /** Broadcasts the live output-token count (exact counts always, estimates in USAGE_DELTA_STEP steps). */
  private sendUsage(live: Live, force: boolean): void {
    if (!live.tokens.due(force)) return;
    const m = live.tokens.mainMessage;
    this.delta(live, { part: "usage", messageId: m.messageId, outputTokens: m.outputTokens, turnOutputTokens: live.tokens.total });
    for (const f of live.tokens.inFlight()) live.cost.setOutput(f.messageId, f.outputTokens);
    this.sendCost(live);
  }

  /** Broadcasts the turn's running list-price cost estimate when it changed (the exact figure follows at `result`). */
  private sendCost(live: Live): void {
    const turn = live.cost.usd;
    if (turn === live.costSent) return;
    live.costSent = turn;
    const base = Math.max(0, this.deps.store.getSession(live.id)?.costUsd ?? 0);
    this.deps.bus.toUser(live.user, { type: "cost_update", sessionId: live.id, turnCostUsd: turn, sessionCostUsd: base + turn, final: false });
  }

  /** Remembers the context size of a main-loop request (message_start / assistant usage). */
  private noteRequest(live: Live, msg: { model?: string; usage?: unknown } | undefined): void {
    if (!msg || msg.model === "<synthetic>") return;
    const tokens = requestContextTokens(msg.usage);
    if (tokens > 0) live.lastRequest = { tokens, model: msg.model ?? live.lastRequest?.model ?? null };
  }

  /**
   * Turn end: the session's context-window usage. Totals = the turn's last main-loop request (input + cache
   * creation + cache read; the result's per-turn `usage` when no assistant message carried usage). The breakdown
   * comes from the CLI's `get_context_usage` control request (`summary`: no model turn, nothing in the
   * transcript); when the CLI does not answer in time it is null. A turn without any model request (a local
   * command such as /clear or /compact) takes the CLI's own total, or keeps the previous value.
   */
  private async refreshContextUsage(live: Live, proc: Proc, m: Extract<SDKMessage, { type: "result" }>, last: Live["lastRequest"]): Promise<void> {
    const seq = ++live.contextSeq;
    try {
      const row = this.deps.store.getSession(live.id);
      if (!row) return;
      let used = last?.tokens ?? requestContextTokens(m.usage);
      let model = last?.model ?? null;
      let cli: SdkContextUsage | null = null;
      if (proc.q.getContextUsage && live.proc === proc) cli = await within(proc.q.getContextUsage({ detail: "summary" }), CONTEXT_USAGE_TIMEOUT_MS);
      if (seq !== live.contextSeq) return;
      if (used <= 0 && cli && cli.totalTokens > 0) {
        used = Math.round(cli.totalTokens);
        model = cli.model || null;
      }
      if (used <= 0) return;
      model = model ?? (cli?.model || null) ?? primaryModel(m.modelUsage) ?? (row.model !== "default" ? row.model : null);
      const windowTokens = contextWindowFor(model, m.modelUsage) ?? (cli && cli.rawMaxTokens > 0 ? Math.round(cli.rawMaxTokens) : null) ?? DEFAULT_CONTEXT_WINDOW;
      const breakdown = cli ? breakdownFromCli(cli, { usedTokens: used, memorySectionTokens: proc.memorySection ? estimateTokens(proc.memorySection) : 0 }) : null;
      const usage: ContextUsage = { usedTokens: used, windowTokens, model, breakdown, updatedAt: iso(this.clock()) };
      const updated = this.deps.store.updateSession(live.id, { contextUsage: JSON.stringify(usage) });
      if (!updated) return;
      this.deps.bus.toUser(live.user, { type: "context_usage", sessionId: live.id, usage });
      this.deps.bus.toUser(live.user, { type: "session_updated", session: this.toProtocol(updated) });
    } catch (err) {
      this.deps.log.debug({ sessionId: live.id, err: errorMessage(err) }, "context usage refresh failed");
    }
  }


  // -------------------------------------------------------------- subagents

  /** What the run_subagents runner (subagents.ts) uses of this service. */
  private subagentHost(): SubagentHost {
    return {
      session: (id) => this.deps.store.getSession(id),
      resolveModel: (parent, model) => this.subagentModel(parent, model),
      // Same user, kind, cwd (a chat's is its chat folder), permission mode and incognito flag as the parent.
      createChild: (parent, c) =>
        this.create({
          user: parent.user,
          kind: parent.kind,
          title: c.description,
          cwd: parent.cwd,
          model: c.model,
          permissionMode: parent.permissionMode,
          effort: c.effort,
          incognito: parent.incognito,
          parentSessionId: parent.id,
        }),
      watch: (id) => this.watchRun(id),
      send: async (id, text) => {
        await this.send(id, { uuid: newUuid(), text });
      },
      stop: async (id) => {
        if (this.deps.store.getSession(id)) await this.stop(id);
      },
      release: async (id) => {
        if (this.deps.store.getSession(id)) await this.close(id);
      },
      messages: (id) => this.deps.store.iterateMessages(id, 0),
      touchedFiles: (id) =>
        this.deps.store.sessionTouches(id, 200).flatMap((t) => {
          if (t.projectId && !t.projectName) return []; // project deleted
          return [t.projectName ? `projects/${t.projectName}/${t.path}` : t.path];
        }),
      taskStarted: (parentId, task) => {
        const s = this.tasksOf(parentId);
        this.commitTasks(parentId, s, [...s.list, task]);
      },
      taskEnded: (parentId, taskId, status) => {
        const s = this.taskState.get(parentId);
        if (!s || !s.list.some((t) => t.taskId === taskId && isRunning(t))) return;
        const at = iso(this.clock());
        this.commitTasks(parentId, s, s.list.map((t) => (t.taskId === taskId && isRunning(t) ? { ...t, status, endedAt: at } : t)));
      },
      now: () => this.clock(),
      // One card per batch, in the parent's view, whatever the permission mode (bypass included) and rules: the
      // person decides. An unanswered card stops the parent's turn, like any other.
      approve: async (parent, input, signal) => {
        const root = this.deps.userRoot(parent.user);
        const result = await this.permissions.request({ sessionId: parent.id, user: parent.user, cwd: parent.cwd ? join(root, parent.cwd) : root }, SUBAGENT_TOOL_NAME, input, {
          signal,
          alwaysAsk: true,
        });
        if (result.behavior === "allow") return { answer: "allow" };
        if (result.message === TIMEOUT_DENY_MESSAGE) {
          const live = this.lives.get(parent.id);
          if (live?.proc && live.turn) void live.proc.q.interrupt().catch(() => undefined);
          return { answer: "timeout", message: TIMEOUT_DENY_MESSAGE };
        }
        return { answer: signal.aborted || result.interrupt ? "cancelled" : "deny" };
      },
    };
  }

  /**
   * A subagent's model and effort: the requested model, else the parent's. A requested model must pass the user's
   * allowlist and the model catalog, as at session creation; the parent's own model already did.
   */
  private subagentModel(parent: SessionRow, requested: string | undefined): { model: string; effort: EffortLevel | null } | { error: string } {
    const m = requested ?? parent.model;
    if (m !== parent.model && !(this.deps.subagentModelAllowed?.(parent.user, m) ?? true)) return { error: `Not started: model ${m} is not one the user may use.` };
    return { model: m, effort: parent.effort };
  }

  /** Resolves once the session's next run ended: it went busy (queued / running / waiting) and then idle or dead. */
  private watchRun(sessionId: string): { done: Promise<void>; cancel(): void } {
    let done!: () => void;
    const p = new Promise<void>((res) => (done = res));
    this.runWatchers.set(sessionId, { busy: false, done });
    return {
      done: p,
      cancel: () => {
        if (this.runWatchers.get(sessionId)?.done === done) this.runWatchers.delete(sessionId);
      },
    };
  }

  // ------------------------------------------------------------- context

  /** The guide's view of a session: kind, cwd (and its synced project), what the agent account allows. */
  private guideContext(row: SessionRow, cwdAbs: string, has: { memory: boolean; history: boolean; browser: boolean; subagents: boolean; docs: boolean }): GuideContext {
    const project = row.kind === "code" && this.deps.projects?.projectForPath(row.user, row.cwd) ? (row.cwd.split("/")[1] ?? null) : null;
    return {
      kind: row.kind,
      memory: has.memory,
      history: has.history,
      incognito: row.incognito,
      browser: has.browser,
      readAttachments: false,
      chatExec: row.kind === "chat" && !row.parentSessionId && isChatFolder(row.cwd),
      download: this.chatDownloads(row),
      agentAccount: !!this.deps.agentExec,
      memoryGiB: serverMemoryGiB(),
      cwdAbs,
      cwdRel: row.cwd,
      projectName: project,
      subagents: has.subagents,
      subagent: !!row.parentSessionId,
      docs: has.docs,
      now: this.clock(),
    };
  }

  /** Whether a session gets download_file: a chat with a folder of its own, not a research subagent. */
  private chatDownloads(row: Pick<SessionRow, "kind" | "parentSessionId" | "cwd">): boolean {
    return !!this.deps.downloads && row.kind === "chat" && !row.parentSessionId && isChatFolder(row.cwd);
  }

  /** The user's instructions for agents ("" without the dep or when empty). */
  /** The project's CLAUDE.md files as a system-prompt section; read at each process start. Never throws. */
  private projectInstructionsSection(cwdAbs: string): string | null {
    try {
      return instructionsSection(readProjectInstructions(cwdAbs));
    } catch (err) {
      this.deps.log.warn({ cwd: cwdAbs, err: errorMessage(err) }, "could not read the project's CLAUDE.md files");
      return null;
    }
  }

  private instructionsOf(user: string): string {
    return this.deps.instructions?.(user) ?? "";
  }

  /**
   * The known heads-ups section for a session's prompt (incognito chats too: it is a preference, not memory); null
   * without the dep, when the list is empty, or for subagents (they have no heads_up tool).
   */
  private knownHeadsUpsOf(row: Pick<SessionRow, "user" | "parentSessionId">): string | null {
    if (row.parentSessionId || !this.deps.knownHeadsUps) return null;
    return knownHeadsUpsSection(this.deps.knownHeadsUps(row.user));
  }

  // ----------------------------------------------------------------- memory

  /** `enabled:version` of the user's memories, or null without a memory module. */
  private memoryKey(user: string): string | null {
    const m = this.deps.memories;
    return m ? `${m.enabled(user) ? 1 : 0}:${m.version(user)}` : null;
  }

  /**
   * Memory freshness. A Claude process receives the user's memories in its system prompt when it is spawned
   * and keeps that prompt for its whole life. When the memories (or the memory preference) changed since —
   * on the Memory page, from another session, on another device — an idle process (no turn, nothing queued,
   * no permission prompt open) is closed here, before the new message is queued, so the respawn (a `resume`
   * of the same Claude session, history intact) is built with the current memories. A busy process is left
   * alone and checked again on the next message. Changes a process made itself through its own
   * remember/forget tools do not count (see ownMemoryTool): that conversation already knows about them.
   */
  private recycleIfMemoryStale(live: Live): void {
    const proc = live.proc;
    if (!proc || proc.incognito || live.turn || live.spawning || live.waitingSlot || live.pending.length || this.permissions.hasPending(live.id)) return;
    const key = this.memoryKey(live.user);
    if (key === null || proc.memoryKey === key) return;
    this.closeProc(live, "memory-changed");
    this.refresh(live.id);
  }

  /**
   * The user's instructions changed since the live process was started (preferences page, another device): an idle
   * process is closed here so the respawn carries the new text. Incognito chats too (the instructions are preferences,
   * not memory). Likewise when the known heads-ups changed.
   */
  private recycleIfInstructionsStale(live: Live): void {
    const proc = live.proc;
    if (!proc || live.turn || live.spawning || live.waitingSlot || live.pending.length || this.permissions.hasPending(live.id)) return;
    const row = this.deps.store.getSession(live.id);
    const known = row ? this.knownHeadsUpsOf(row) : proc.knownHeadsUps;
    if (this.instructionsOf(live.user) === proc.instructions && known === proc.knownHeadsUps) return;
    this.closeProc(live, "instructions-changed");
    this.refresh(live.id);
  }

  // ------------------------------------------------------------- recycling

  /** 503 api_unavailable / 429 api_limit_reached before a turn (no billing service = no budget check). */
  private assertCanSend(): void {
    if (!this.deps.apiProxy) throw new HttpError(503, "api_unavailable", "No Anthropic API key is configured on the server.");
    this.deps.billing?.assertCanSend();
  }

  /** A chat process started without the Read tool while the session now has file attachments. */
  private toolsStale(live: Live, proc: Proc): boolean {
    return live.kind === "chat" && !proc.chatRead && this.attachmentsOf(live.id).size > 0;
  }

  /**
   * A code process whose sandbox network settings no longer fit the session's permission mode (strict allowlist
   * in auto / bypassPermissions / dontAsk, hub-decided hosts otherwise; codeSandbox.ts strictNetworkMode).
   */
  private networkStale(live: Live, proc: Proc): boolean {
    if (proc.strictNetwork === null) return false;
    const row = this.deps.store.getSession(live.id);
    return !!row && strictNetworkMode(row.permissionMode) !== proc.strictNetwork;
  }

  /** Mode change across the network groups: an idle process is closed now (the next message resumes with them). */
  private recycleIfNetworkStale(live: Live): void {
    const proc = live.proc;
    if (!proc || live.turn || live.spawning || live.pending.length || this.permissions.hasPending(live.id)) return;
    if (!this.networkStale(live, proc)) return;
    this.closeProc(live, "network-mode-changed");
    this.refresh(live.id);
  }

  /** First attachment of a chat: an idle process is closed now (the next message resumes with Read). */
  private recycleIfToolsStale(live: Live): void {
    const proc = live.proc;
    if (!proc || live.turn || live.spawning || live.pending.length || this.permissions.hasPending(live.id)) return;
    if (!this.toolsStale(live, proc)) return;
    this.closeProc(live, "tools-changed");
    this.refresh(live.id);
  }

  /** The API said the organisation's credits are used up (once per turn): notice + api_limit_reached on the session. */
  private creditsExhausted(live: Live, proc: Proc, text: string): void {
    if (proc.creditNoticeSent) return;
    proc.creditNoticeSent = true;
    this.deps.billing?.markCreditsExhausted();
    this.deps.log.warn({ sessionId: live.id }, "the Anthropic API reports that the API credits are used up");
    this.notice(live.user, "error", "api_limit_reached", "The organisation's API credits are used up. Add credits in the Anthropic Console.");
    this.deps.bus.toUser(live.user, { type: "error", code: "api_limit_reached", message: text.trim().slice(0, 300) || "API credit balance is too low.", sessionId: live.id });
    this.deps.onApiUsage?.(live.user);
  }

  /** Wraps a memory tool so a change made by this process itself does not mark its own prompt stale. */
  private ownMemoryTool(t: HubToolSpec, proc: Proc, user: string): HubToolSpec {
    return {
      ...t,
      handler: async (args) => {
        const before = this.memoryKey(user);
        const out = await t.handler(args);
        if (proc.memoryKey === before) proc.memoryKey = this.memoryKey(user);
        return out;
      },
    };
  }

  /** Turn end of a code session: snapshot the project(s) it worked in (cwd project + projects it wrote to). */
  private endTurnInProjects(live: Live, userUuid: string | null): void {
    const projects = this.deps.projects;
    if (!projects) return;
    const row = this.deps.store.getSession(live.id);
    const ids = new Set(live.turnProjects);
    live.turnProjects.clear();
    if (!row || row.kind !== "code") {
      projects.releaseSession(live.id);
      return;
    }
    const cwdProject = projects.projectIdForCwd(row.user, row.cwd);
    if (cwdProject) ids.add(cwdProject);
    const message = (userUuid ? this.promptFirstLine(live.id, userUuid) : null) || `turn ${row.turnCount}`;
    projects.turnEnded({ sessionId: row.id, turn: row.turnCount, message, projectIds: [...ids] });
  }

  /** First line of a stored user prompt (snapshot commit message). */
  private promptFirstLine(sessionId: string, uuid: string): string | null {
    const m = this.deps.store.getMessageByUuid(sessionId, uuid);
    if (!m) return null;
    try {
      const payload = JSON.parse(m.payload) as { message?: { content?: unknown } };
      const text = messageText(payload.message?.content).trim();
      const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
      return line ? line.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  /** Per-turn usage deltas into `turns` (usage figures; the budget counts the metered requests). */
  private accountUsage(live: Live, proc: Proc, m: Extract<SDKMessage, { type: "result" }>): void {
    const row = this.deps.store.getSession(live.id);
    if (!row) return;
    const { deltas, next } = computeUsageDelta(parseCumulative(row.usageCumulative), m.modelUsage);
    const at = iso(this.clock());
    let cost = 0;
    let durationLeft = m.duration_ms ?? 0;
    this.deps.store.transaction(() => {
      for (const d of deltas) {
        // The stored cost: the SDK's, else the list-price estimate.
        cost += this.deps.store.insertTurn({
          sessionId: row.id,
          user: row.user,
          kind: row.kind,
          model: d.model,
          inputTokens: d.input,
          outputTokens: d.output,
          cacheReadTokens: d.cacheRead,
          cacheCreateTokens: d.cacheCreate,
          costUsd: d.cost,
          durationMs: durationLeft,
          at,
          effort: row.effort,
        });
        durationLeft = 0;
      }
      this.deps.store.addTurnCost(row.id, cost, JSON.stringify(next));
    });
    const updated = this.deps.store.getSession(row.id);
    if (updated) this.deps.bus.toUser(row.user, { type: "session_updated", session: this.toProtocol(updated) });
    this.deps.bus.toUser(row.user, { type: "cost_update", sessionId: row.id, turnCostUsd: Math.max(0, cost), sessionCostUsd: Math.max(0, updated?.costUsd ?? 0), final: true });
    if (deltas.length) this.deps.onUsageRecorded?.(row.user);
    if (deltas.length) this.deps.onApiUsage?.(row.user);
  }
}
