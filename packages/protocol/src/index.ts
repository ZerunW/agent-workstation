/**
 * @agent-workstation/protocol - the single source of truth for everything that crosses
 * the wire between workstation-hub (server), the web UI and the macOS app.
 *
 * Conventions
 * - Every REST route lives under `/api`. The status service is a separate
 *   process and lives under `/status/api`.
 * - Identity is a username only (no password). Clients send it in the
 *   `X-Workstation-User` header on every request and in the WebSocket `hello`.
 *   Reachability is enforced by the network layer (Tailscale; see docs/SECURITY.md).
 * - Paths in file APIs are POSIX, relative to the user's workspace root and
 *   never contain `..`; the hub rejects anything that escapes the root.
 * - Timestamps are ISO 8601 strings (UTC). Sizes are bytes. Percentages 0–100.
 * - Schemas are zod; the exported `type`s are inferred from them so the hub
 *   can validate at runtime and the clients get the same static types.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const USER_HEADER = "X-Workstation-User";
/**
 * Fallback for requests that cannot carry custom headers (browser WebSocket
 * upgrades, `<a href>` downloads, `<img src>` previews): `?user=<name>`.
 * The header wins when both are present.
 */
export const USER_QUERY_PARAM = "user";
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/**
 * Files up to this size are stored in the server's review git as they are. Larger files are "large files": the review
 * git stores a small pointer instead (LARGE_FILE_POINTER: their sha256 and size) and the content lives in the
 * project's content-addressed large-file store on the server (one copy per distinct version). Everything else is the
 * same as for small files: they sync both ways, show in Changes (accept or reject the whole file; no line diff), get
 * snapshots and appear in History, and restore like any file. Uploads go in resumable chunks
 * (ROUTES.projectLargeFile); downloads use HTTP Range on ROUTES.projectFileRaw.
 */
export const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;
/**
 * The pointer the review git stores for a large file (exact bytes, LF line ends): "workstation-large v1\n" +
 * "sha256 <64 hex>\n" + "size <decimal bytes>\n". A blob that starts with the first line is a pointer.
 */
export const LARGE_FILE_POINTER_HEADER = "workstation-large v1";
/**
 * A file larger than this never syncs until the person approves it in the Sync panel, even inside an approved folder,
 * because every version of it is kept on the server. The pending item carries that reason, e.g.
 * "2.3 GB large file: each synced version is kept on the server".
 */
export const SYNC_LARGE_FILE_PROMPT_BYTES = MAX_SYNC_FILE_BYTES;
/** Chunk size for large-file uploads (the last chunk may be shorter). */
export const LARGE_FILE_CHUNK_BYTES = 16 * 1024 * 1024;
/**
 * POST /api/projects/:id/baseline body encoding: absent (or "tar.zst") = zstd-compressed tar
 * (the default the Mac app sends); "tar" = an uncompressed tar.
 */
export const BASELINE_ENCODING_HEADER = "X-Baseline-Encoding";
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------

export const Username = z.string().regex(/^[a-z0-9_-]{1,32}$/, "username must match [a-z0-9_-]{1,32}");
export type Username = z.infer<typeof Username>;

export const SessionKind = z.enum(["chat", "code"]);
export type SessionKind = z.infer<typeof SessionKind>;

// Billing: every Claude process (sessions, subagents, the hub's own helpers) is billed to the Anthropic API key
// configured on the server, against the admin's monthly budget (`AdminSettings.apiMonthlyLimitUsd`). Claude processes
// never see the key: they talk to the hub's loopback key proxy with a per-process token. Without a key, sessions
// cannot start (503 `api_unavailable`).

/** Mirrors the Agent SDK's PermissionMode. `manual` is not used (it is an alias of default). */
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/**
 * idle            - no turn running; a CLI process may or may not be alive.
 * queued          - a user message is waiting for a process slot.
 * running         - a turn is in progress.
 * requires_action - waiting on a permission answer from the user.
 * dead            - the CLI process died mid-turn; next message respawns it.
 */
export const SessionStatus = z.enum(["idle", "queued", "running", "requires_action", "dead"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0"), "path must be relative and must not escape the workspace");
export type RelPath = z.infer<typeof RelPath>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Longest `User.instructions` the hub stores (characters). */
export const MAX_USER_INSTRUCTIONS = 12_000;

export const User = z.object({
  name: Username,
  createdAt: z.string(),
  isAdmin: z.boolean(),
  enabled: z.boolean(),
  terminalEnabled: z.boolean(),
  /** Rolling 7-day input+output token cap. null = unlimited. */
  weeklyTokenLimit: z.number().int().nonnegative().nullable(),
  /** Model ids the user may pick. null = all models the hub offers. */
  modelAllowlist: z.array(z.string()).nullable(),
  /**
   * The user's own default for new sessions when the client sends no `model`.
   * null = follow the server default (`AdminSettings.defaultModel`, "opus" unless configured).
   */
  defaultModel: z.string().nullable().optional(),
  /** The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort` ("high" unless configured). */
  defaultEffort: EffortLevel.nullable().optional(),
  /** Whether Claude keeps and uses memories for this user (default true). */
  memoryEnabled: z.boolean().optional(),
  /**
   * The user's own instructions for every agent (like Claude's personal preferences): free text, included verbatim in
   * the system context of every Chat and Code session, after Agent Workstation's own guide. Empty = none.
   */
  instructions: z.string().max(MAX_USER_INSTRUCTIONS).optional(),
  /**
   * Global notification switch (the Mac app's system notifications); absent = on. Off: no session notifies, whatever
   * its own switch says.
   */
  notificationsEnabled: z.boolean().optional(),
  /** Admin views only (GET /api/users, PATCH /api/users/:name): the Tailscale login this username is bound to; null = none. */
  tailscaleLogin: z.string().nullable().optional(),
});
export type User = z.infer<typeof User>;

export const ModelInfo = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(EffortLevel).optional(),
  supportsAutoMode: z.boolean().optional(),
  /** Model family for grouping, e.g. "opus", "fable", "sonnet", "haiku". */
  family: z.string().optional(),
  /**
   * true for older versions of a family (anything but the newest per family): pickers show them under a
   * "More models" submenu, like the Claude apps. The newest of each family, the user's default and the
   * session's current model are always at the top level.
   */
  legacy: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const CommandInfo = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  /** true when the command is a user skill rather than a built-in. */
  isSkill: z.boolean().optional(),
});
export type CommandInfo = z.infer<typeof CommandInfo>;

/**
 * Context-window usage of a session, like Claude Code's `/context`: how full the model's window is and, when the
 * hub could obtain it, what fills it. Refreshed by the hub when a turn ends (`context_usage` event; also on the
 * Session object). `breakdown` is null when only the totals are known.
 */
export const ContextUsage = z.object({
  /** Tokens in the last request's context (input + cache read + cache creation). */
  usedTokens: z.number().int().nonnegative(),
  /** The model's context window. */
  windowTokens: z.number().int().positive(),
  model: z.string().nullable(),
  /** Categories in display order, e.g. system_prompt, system_tools, mcp_tools, skills, memory, messages, autocompact_buffer. */
  breakdown: z.array(z.object({ key: z.string(), label: z.string(), tokens: z.number().int().nonnegative() })).nullable(),
  updatedAt: z.string(),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

export const Session = z.object({
  id: z.guid(),
  user: Username,
  kind: SessionKind,
  title: z.string(),
  /** Working directory relative to the user's workspace root ("" = root; "projects/foo" for a synced project; ".chat" for chat). */
  cwd: z.string(),
  /** Derived (not stored): absolute path of `cwd` on the server. Absent on older hubs. */
  cwdAbs: z.string().optional(),
  model: z.string(),
  permissionMode: PermissionMode,
  effort: EffortLevel.nullable(),
  status: SessionStatus,
  /** Position in the process queue when status === "queued" (1-based). */
  queuePosition: z.number().int().positive().nullable(),
  claudeSessionId: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  /** Sequence number of the last persisted message (0 when empty). */
  lastSeq: z.number().int().nonnegative(),
  /** Estimated cost (USD, list price) accumulated from result messages. */
  costUsd: z.number().nonnegative(),
  /**
   * Derived (not stored): the synced project whose work tree contains `cwd` (`projects/<name>` or
   * below), null for code sessions outside any project. Omitted by older hubs.
   */
  projectId: z.guid().nullable().optional(),
  /** Context-window usage after the last turn; null/absent before the first turn. */
  contextUsage: ContextUsage.nullable().optional(),
  /**
   * Set on a subagent's session: the session whose agent started it (with the Agent Workstation subagent tool). Such sessions are
   * hidden from session lists and search; they are opened from the parent's transcript. Absent/null = a normal session.
   */
  parentSessionId: z.guid().nullable().optional(),
  /** This session's notification switch; absent = on. Only effective while the user's global switch is on. */
  notify: z.boolean().optional(),
  /** Uuids of the messages the user pinned in this session (Code sessions), in pin order; absent = none. */
  pinnedMessages: z.array(z.string()).optional(),
  /**
   * Incognito chat (like claude.ai): never listed in GET /api/sessions or search, never reads or writes memory, no
   * search summary. Its messages (in the hub and in the CLI transcript) are deleted when the
   * person ends it (DELETE - the client sends it on "New chat" or when leaving the session) and, as a safety net,
   * when the hub restarts. Token usage is still counted (numbers only, no content).
   */
  incognito: z.boolean().optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * Persisted message. `payload` is the raw Agent SDK message
 * (SDKUserMessage / SDKAssistantMessage / SDKResultMessage / SDKSystemMessage / ...)
 * stored verbatim; the UI renders from it. Partial `stream_event`s are never persisted.
 *
 * kind "reset" = the SDK's `conversation_reset` message, stored verbatim:
 *   `{ type: "conversation_reset", uuid, session_id, new_conversation_id,
 *      trigger?: "clear" | "plan_mode_exit" | "fresh_session" | "onboarding",
 *      user_message_uuid?, timestamp? }`
 * It marks the point where Claude started a fresh conversation (/clear, /reset, /new, plan-mode
 * exit with "clear context"); messages before it are no longer in Claude's context. The session
 * keeps its id and history; the next `system/init` carries the new `claudeSessionId`.
 */
export const StoredMessageKind = z.enum(["user", "assistant", "result", "system", "reset"]);
export type StoredMessageKind = z.infer<typeof StoredMessageKind>;

export const StoredMessage = z.object({
  seq: z.number().int().positive(),
  sessionId: z.guid(),
  uuid: z.string(),
  kind: StoredMessageKind,
  payload: z.unknown().optional(),
  at: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

export const Attachment = z.discriminatedUnion("type", [
  /** Inline image pasted/dropped into the composer. */
  z.object({ type: z.literal("image"), mediaType: z.string(), dataBase64: z.string(), name: z.string().optional() }),
  /** Reference to a file already in the user's workspace (uploaded earlier). */
  z.object({ type: z.literal("file_ref"), path: RelPath }),
]);
export type Attachment = z.infer<typeof Attachment>;

/** A file attachment as shown back to people (name, size and type resolved by the hub). */
export const FileRefMeta = z.object({
  type: z.literal("file_ref"),
  path: RelPath,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
});
export type FileRefMeta = z.infer<typeof FileRefMeta>;

/**
 * Extra `hub` key on a stored user message payload, present when the message carried attachments: the text the
 * person typed and the files they attached, for display as chips. The SDK content blocks hold the prompt as sent
 * to Claude (file pointers in Code sessions, inlined documents in Chat sessions).
 */
export const UserMessageMeta = z.object({ text: z.string(), attachments: z.array(FileRefMeta) });
export type UserMessageMeta = z.infer<typeof UserMessageMeta>;

/**
 * One thing Claude remembers about a user across Chat sessions (and reads in Code sessions). Saved by Claude
 * through its `remember` tool when the user shares something durable or asks it to, or added by the user on the
 * Memory page. Per user, stored on the hub, so it follows the username to every device.
 */
export const Memory = z.object({
  id: z.string(),
  text: z.string(),
  /** `claude` = saved by Claude during a conversation, `user` = typed on the Memory page / in the app. */
  source: z.enum(["claude", "user"]),
  /** The session Claude saved it from, when `source` is `claude`. */
  sessionId: z.guid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Memory = z.infer<typeof Memory>;
export const MemoryBody = z.object({ text: z.string().trim().min(1).max(2000) });
export type MemoryBody = z.infer<typeof MemoryBody>;
/** GET /api/me/memories - newest first. */
export const MemoriesResponse = z.object({ memories: z.array(Memory) });
export type MemoriesResponse = z.infer<typeof MemoriesResponse>;

/**
 * Search across the user's sessions (Chat and Code; incognito sessions never appear). Two result
 * lists shown side by side, not a mode switch:
 * - keyword (GET /api/search): full-text + trigram fuzzy match over titles and message text, newest first, with a
 *   highlighted snippet (`«…»` marks the matched terms);
 * - relevant (GET /api/search/relevant): Claude Haiku ranks sessions by meaning using per-session summaries the
 *   hub keeps (written by Haiku after a session goes idle), each hit with a one-line `reason`. Needs the API key and
 *   budget; otherwise 503 `api_unavailable` (clients hide the list).
 */
export const SearchHit = z.object({
  session: z.lazy(() => Session),
  /** Matched text with `«` `»` around the hits (keyword), or the session summary (relevant). */
  snippet: z.string().nullable(),
  /** When the matched message was written (keyword) or the session's last activity (relevant). */
  at: z.string(),
  /** Relevant results only: why the model thinks this session matches (one sentence). */
  reason: z.string().optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/**
 * Mac-side backups kept on the server. Before a client overwrites or deletes a local file that has edits the server
 * has never seen, it uploads that local version here. Backups live in their own ref namespace
 * (`refs/backups/<client>/<id>`) of the project's review repo: they never touch the `local` branch, the working tree
 * Claude edits, review, or history snapshots. Never pruned automatically.
 */
export const RawQuery = z.object({
  path: z.string().min(1),
  /** A commit id, ref name (e.g. "local", "refs/backups/mac/…") or blob id; omitted = working tree. */
  ref: z.string().optional(),
  /** "1"/"true" = inline preview (served with a `sandbox` CSP); anything else = download. */
  inline: z.enum(["0", "1", "true", "false"]).optional(),
});
export type RawQuery = z.infer<typeof RawQuery>;
export const ProjectBackupBody = z.object({
  /** Who is backing up (e.g. "mac:<hostname>"). */
  client: z.string().min(1).max(100),
  reason: z.enum(["overwrite", "delete", "manual"]),
  /** At most 50 MB decoded per request; split larger batches. */
  files: z.array(z.object({ path: z.string().min(1), dataBase64: z.string(), mode: z.number().int().optional() })).min(1).max(500),
});
export type ProjectBackupBody = z.infer<typeof ProjectBackupBody>;
// POST /backups → 201 ProjectBackup; 413 too_large (> 500 files or > 50 MB decoded); 400 invalid_path (absolute, "..",
// empty/"."/".git" segments, duplicates, file-vs-folder clash); 507 disk_block when the disk is at block level.
export const ProjectBackup = z.object({
  id: z.string(),
  ref: z.string(),
  commit: z.string(),
  client: z.string(),
  reason: z.enum(["overwrite", "delete", "manual"]),
  at: z.string(),
  files: z.array(z.object({ path: z.string(), blob: z.string(), size: z.number().int().nonnegative() })),
});
export type ProjectBackup = z.infer<typeof ProjectBackup>;
export const ProjectBackupsResponse = z.object({ backups: z.array(ProjectBackup) });
export type ProjectBackupsResponse = z.infer<typeof ProjectBackupsResponse>;

/**
 * Show a visual inline in the transcript (chat and code). Stored tool name:
 * `mcp__workstation-visual__show_visual`; input `{ title (≤120 chars), svg | html (exactly one, ≤200 KB) }`.
 */
export const ShowVisualInput = z.object({ title: z.string().max(120), svg: z.string().optional(), html: z.string().optional() });
export type ShowVisualInput = z.infer<typeof ShowVisualInput>;

/**
 * List prices (USD per million tokens) per model and period: built-in, config and price-check overrides; costs use the
 * period valid at each request/turn. Entries carry explicit cache prices (`cacheReadPerMtok`, cache-write factors)
 * where known; `cacheReadFactor` × input otherwise.
 */
export const PricePeriodInfo = z.object({
  model: z.string(),
  from: z.string().nullable(),
  inputPerMtok: z.number().positive(),
  outputPerMtok: z.number().positive(),
  cacheReadFactor: z.number().nonnegative(),
  cacheReadPerMtok: z.number().nonnegative().optional(),
  cacheWrite5mFactor: z.number().nonnegative().optional(),
  cacheWrite1hFactor: z.number().nonnegative().optional(),
  source: z.enum(["builtin", "config", "override"]),
});
export type PricePeriodInfo = z.infer<typeof PricePeriodInfo>;
export const PricingCheck = z.object({
  id: z.number().int(),
  at: z.string(),
  trigger: z.enum(["schedule", "admin"]),
  outcome: z.enum(["updated", "unchanged", "rejected", "failed"]),
  model: z.string(),
  inputPerMtok: z.number().nullable(),
  outputPerMtok: z.number().nullable(),
  cacheReadPerMtok: z.number().nullable(),
  effectiveFrom: z.string().nullable(),
  previousInputPerMtok: z.number().nullable(),
  previousOutputPerMtok: z.number().nullable(),
  message: z.string().nullable(),
});
export type PricingCheck = z.infer<typeof PricingCheck>;
/** One priced model in the admin view. */
export const AdminPricedModel = z.object({
  model: z.string(),
  current: PricePeriodInfo.nullable(),
  periods: z.array(PricePeriodInfo),
});
export type AdminPricedModel = z.infer<typeof AdminPricedModel>;
/** Every priced model, the price checks and the next scheduled one. */
export const AdminPricingResponse = z.object({
  models: z.array(AdminPricedModel),
  lastCheck: PricingCheck.nullable(),
  checks: z.array(PricingCheck),
  nextCheckAt: z.string().nullable(),
});
export type AdminPricingResponse = z.infer<typeof AdminPricingResponse>;
export const AdminPricingRefreshResponse = z.object({ check: PricingCheck, pricing: AdminPricingResponse });
export type AdminPricingRefreshResponse = z.infer<typeof AdminPricingRefreshResponse>;

/**
 * Notice codes the hub broadcasts (ServerEvent `notice`). Clients may show unknown codes as plain notices.
 * remote_disabled, weekly_limit, disk_warn / disk_block, api_limit_warning / api_limit_reached / api_unavailable,
 * pricing_updated (info), pricing_check_failed (warning), process_died, agent_firewall_inactive (error, admins only: the agent firewall unit is
 * not active while agents run as a separate account; re-checked every 10 minutes; an info notice with the same code when it is back).
 */
export const NOTICE_CODES = [
  "remote_disabled", "weekly_limit", "disk_warn", "disk_block", "api_limit_warning", "api_limit_reached", "api_unavailable", "pricing_updated",
  "pricing_check_failed", "process_died", "agent_firewall_inactive",
] as const;
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(500), limit: z.coerce.number().int().min(1).max(100).optional() });
export type SearchQuery = z.infer<typeof SearchQuery>;
export const SearchResponse = z.object({ hits: z.array(SearchHit) });
export type SearchResponse = z.infer<typeof SearchResponse>;
/** 503 api_unavailable without an API key or budget; `cached` = served from the hub's per-query cache. */
export const RelevantSearchResponse = z.object({ hits: z.array(SearchHit), model: z.string(), cached: z.boolean() });
export type RelevantSearchResponse = z.infer<typeof RelevantSearchResponse>;

export const FileEntry = z.object({
  path: RelPath,
  name: z.string(),
  kind: z.enum(["file", "dir", "symlink"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  /** Set for files under a synced project that are new/modified relative to `local`. */
  reviewStatus: z.enum(["added", "modified", "deleted", "renamed"]).optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const Project = z.object({
  id: z.guid(),
  user: Username,
  name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  /** Always `projects/<name>` relative to the workspace root. */
  path: z.string(),
  createdAt: z.string(),
  /** Commit hash of the `local` branch (what the Mac has). */
  localCommit: z.string().nullable(),
  pendingFiles: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  /** Origin machine identifier chosen by the Mac app (hostname), informational. */
  origin: z.string().nullable(),
});
export type Project = z.infer<typeof Project>;

export const ReviewFile = z.object({
  path: RelPath,
  status: z.enum(["added", "modified", "deleted", "renamed", "typechange"]),
  oldPath: RelPath.optional(),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  /** A large file (> MAX_SYNC_FILE_BYTES on either side): whole-file accept/reject only; `binary` is true. */
  large: z.boolean().optional(),
  /** Large files: the size on the `local` side (the Mac's version) when there is one. */
  oldSizeBytes: z.number().int().nonnegative().optional(),
  lastTouchedBy: z
    .object({ sessionId: z.guid(), turn: z.number().int(), tool: z.string(), at: z.string() })
    .nullable(),
});
export type ReviewFile = z.infer<typeof ReviewFile>;

export const Hunk = z.object({
  /** Stable id = index in the unified diff for this file at `localCommit`. */
  index: z.number().int().nonnegative(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  header: z.string(),
  /** Raw hunk body lines including the leading ' ', '+', '-' markers. */
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof Hunk>;

export const FileDiff = z.object({
  path: RelPath,
  localCommit: z.string().nullable(),
  /** sha256 of the unified diff this listing was computed from. Send it back with hunk-level accept/reject; a mismatch means the file changed meanwhile (409 `stale_diff`). */
  diffId: z.string(),
  binary: z.boolean(),
  /** Full text of both sides for side-by-side rendering (omitted for binary / > 2 MB). */
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
  hunks: z.array(Hunk),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const Snapshot = z.object({
  ref: z.string(),
  sessionId: z.guid().nullable(),
  turn: z.number().int().nullable(),
  at: z.string(),
  message: z.string(),
  /** "snapshot" = end of an agent turn, "sync" = local push, "trash" = pre-destructive backup, "accept" = review accept. */
  kind: z.enum(["snapshot", "sync", "trash", "accept"]),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const Skill = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/),
  description: z.string(),
  scope: z.enum(["user", "global"]),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof Skill>;

/**
 * API-credit spend this budget month: the metered requests of every Claude process and of the hub's own helpers, at
 * list price. `percent` = spent / limit (null when the limit is 0); severity warning from 80 %, critical from 95 %.
 */
export const ApiCredits = z.object({
  spentUsd: z.number().nonnegative(),
  limitUsd: z.number().nonnegative(),
  percent: z.number().min(0).nullable(),
  periodStart: z.string(),
  resetsAt: z.string(),
  severity: z.enum(["normal", "warning", "critical", "unknown"]),
});
export type ApiCredits = z.infer<typeof ApiCredits>;
/** GET /api/usage/limits and the `usage_limits` event. `api` is null when no API key is configured. */
export const UsageLimits = z.object({ api: ApiCredits.nullable() });
export type UsageLimits = z.infer<typeof UsageLimits>;

export const TokenUsageBucket = z.object({
  /** ISO date or datetime that starts the bucket. */
  bucket: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheCreateTokens: z.number().int(),
  costUsd: z.number(),
  turns: z.number().int(),
  /** Model display name from the catalog (clients fall back to `model`). */
  displayName: z.string().optional(),
});
export type TokenUsageBucket = z.infer<typeof TokenUsageBucket>;

export const DiskLevel = z.enum(["ok", "warn", "block"]);
export type DiskLevel = z.infer<typeof DiskLevel>;
export const DiskStatus = z.object({
  level: DiskLevel,
  usedPercent: z.number(),
  totalBytes: z.number().int(),
  freeBytes: z.number().int(),
  warnPercent: z.number(),
  blockPercent: z.number(),
  /** Breakdown for the current user (and all users for admin). */
  breakdown: z.array(z.object({ label: z.string(), user: Username.nullable(), path: z.string(), bytes: z.number().int() })),
  /** Per-project pending counts so the warning can say what to pull back. */
  projects: z.array(z.object({ id: z.guid(), name: z.string(), pendingFiles: z.number().int(), undownloadedFiles: z.number().int(), bytes: z.number().int() })),
});
export type DiskStatus = z.infer<typeof DiskStatus>;

export const AdminSettings = z.object({
  remoteClaudeEnabled: z.boolean(),
  diskWarnPercent: z.number(),
  diskBlockPercent: z.number(),
  defaultWeeklyTokenLimit: z.number().int().nonnegative(),
  /** Server-wide default model for new sessions; a user's own `User.defaultModel` wins over it. Config `sessions.default_model`, "opus" out of the box. */
  defaultModel: z.string(),
  /** Server-wide default effort for new sessions (null = the CLI's own default); `User.defaultEffort` wins over it. Config `sessions.default_effort`, "high" out of the box. */
  defaultEffort: EffortLevel.nullable(),
  /** Monthly API budget in USD (admin-set; 0 = no session can start). Default 100. */
  apiMonthlyLimitUsd: z.number().nonnegative().optional(),
  /** Day of month (1–28) the API budget resets, in the hub's local time. Default 1. */
  apiResetDay: z.number().int().min(1).max(28).optional(),
  /**
   * The last this-many USD of the period's API budget are kept for Agent Workstation's own services (the docs assistant,
   * search, summaries, the download check, the price check): sessions are refused once remaining ≤ this; the services
   * run until the budget is spent.
   * Default 2.
   */
  serviceReserveUsd: z.number().nonnegative().optional(),
});
export type AdminSettings = z.infer<typeof AdminSettings>;

export const PermissionRequest = z.object({
  requestId: z.string(),
  sessionId: z.guid(),
  toolName: z.string(),
  input: z.unknown().optional(),
  toolUseId: z.string().optional(),
  /** Suggestions from the SDK (e.g. "always allow Bash(npm test)"). Opaque, echoed back on allow. */
  suggestions: z.array(z.unknown()).optional(),
  /**
   * Set when the question is whether the server browser may be used on a website at all (like Claude in Chrome's site
   * permission): the first browser call that would load or read a page of an origin this user has not granted.
   * Answers: allow (this session only), allow + `remember: "user"` (always, stored as a BrowserSiteGrant), deny.
   */
  browserSite: z.object({ origin: z.string() }).optional(),
  /**
   * Set when the request comes from a subagent of this session (Agent Workstation's run_subagent): the child session that asked.
   * `sessionId` stays the parent (the card shows in the parent's view); answering resolves the child's request.
   */
  subagent: z.object({ sessionId: z.guid(), description: z.string() }).optional(),
  at: z.string(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** A website the user always allows the server browser on (scheme://host[:port]). */
export const BrowserSiteGrant = z.object({ origin: z.string(), grantedAt: z.string(), lastUsedAt: z.string().nullable() });
export type BrowserSiteGrant = z.infer<typeof BrowserSiteGrant>;
export const BrowserSitesResponse = z.object({ sites: z.array(BrowserSiteGrant) });
export type BrowserSitesResponse = z.infer<typeof BrowserSitesResponse>;
export const BrowserSiteQuery = z.object({ origin: z.string().min(1).max(300) });
export type BrowserSiteQuery = z.infer<typeof BrowserSiteQuery>;

export const PermissionResponse = z.object({
  requestId: z.string(),
  behavior: z.enum(["allow", "deny"]),
  /** Only with allow: replaces the tool input. */
  updatedInput: z.unknown().optional(),
  /** Only with deny: shown to Claude. */
  message: z.string().optional(),
  /** Persist a rule so the same tool/input pattern is auto-allowed for this session or user. */
  remember: z.enum(["session", "user"]).optional(),
});
export type PermissionResponse = z.infer<typeof PermissionResponse>;

// ---------------------------------------------------------------------------
// REST - request/response bodies
// ---------------------------------------------------------------------------

export const ErrorBody = z.object({ error: z.string(), code: z.string().optional(), details: z.unknown().optional() });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const Me = z.object({
  user: User,
  settings: AdminSettings,
  disk: DiskLevel,
  /** An Anthropic API key is configured on the server and the monthly budget is > 0; false = sessions cannot start. */
  apiAvailable: z.boolean(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type Me = z.infer<typeof Me>;

export const CreateUserBody = z.object({ name: Username });
export const PatchUserBody = User.pick({ enabled: true, terminalEnabled: true, weeklyTokenLimit: true, modelAllowlist: true }).partial();

/**
 * PATCH /api/me/preferences - a user's own defaults for new sessions. Omit a field to leave it; send null to go back
 * to the server default. A `defaultModel` outside the user's `modelAllowlist` is refused with 403 `model_not_allowed`.
 */
export const UserPreferencesBody = z.object({
  defaultModel: z.string().min(1).nullable().optional(),
  defaultEffort: EffortLevel.nullable().optional(),
  memoryEnabled: z.boolean().optional(),
  /** Replaces the user's instructions ("" clears them). Running sessions pick them up at their next turn. */
  instructions: z.string().max(MAX_USER_INSTRUCTIONS).optional(),
  /** The global notification switch (see User.notificationsEnabled). */
  notificationsEnabled: z.boolean().optional(),
});
export type UserPreferencesBody = z.infer<typeof UserPreferencesBody>;

export const CreateSessionBody = z.object({
  kind: SessionKind,
  title: z.string().max(200).optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  effort: EffortLevel.nullable().optional(),
  /** Chat sessions only (400 for code). */
  incognito: z.boolean().optional(),
});
/** Rename and/or set the session's notification switch (at least one field). */
export const PatchSessionBody = z
  .object({ title: z.string().max(200).optional(), notify: z.boolean().optional() })
  .refine((b) => b.title !== undefined || b.notify !== undefined, { message: "nothing to change" });
export const SessionSettings = z.object({ model: z.string().optional(), permissionMode: PermissionMode.optional(), effort: EffortLevel.nullable().optional() });
export type SessionSettings = z.infer<typeof SessionSettings>;

export const SendMessageBody = z.object({
  /** Client-generated UUID; the hub dedupes on it and echoes it on the persisted user message. */
  uuid: z.guid(),
  text: z.string(),
  attachments: z.array(Attachment).optional(),
});
export const SendMessageResponse = z.object({ state: z.enum(["accepted", "queued"]), position: z.number().int().nullable(), seq: z.number().int() });

/**
 * POST /api/sessions/:id/rewind - the conversation goes back to just before the user message `messageUuid`: that
 * message and everything after it leave the transcript (kept in the database, marked rewound, never deleted; clients
 * get `messages_rewound`). A running turn is stopped first. The agent continues from the kept part (the SDK resumes at
 * the last kept message).
 * `files`: also put the session's synced project back to the snapshot taken before that message's turn (the current
 * state goes to refs/trash first); 409 `unsupported` when there is no such snapshot. `resend`: send the message again
 * right away, with its original attachments and `text` instead of the original text when given (chat Edit / Retry).
 */
export const RewindBody = z.object({
  messageUuid: z.string(),
  files: z.boolean().optional(),
  resend: z.object({ text: z.string().optional() }).optional(),
});
/** `draft`: the removed message's text, for the composer (rewind without resend). */
export const RewindResponse = z.object({ draft: z.string(), filesRestored: z.boolean() });

/**
 * POST /api/sessions/:id/fork - a new session (same kind, cwd, model, mode, effort) whose
 * conversation is this one up to the message `messageUuid`: an assistant message is included; for a user message the
 * fork ends just before it and its text comes back as `draft` for the new session's composer.
 */
export const ForkBody = z.object({ messageUuid: z.string() });
export const ForkResponse = z.object({ session: Session, draft: z.string().nullable() });

/**
 * Heads-ups (the agent's `heads_up` tool, recorded as `mcp__workstation_turn__heads_up` with input HeadsUpInput): a short
 * caveat card under the message with Learn more (shows `detail`), Knew this already and a menu. "Knew this already"
 * stores the text per user (max 200, oldest dropped); the agent's context lists them so it does not repeat them.
 */
/**
 * Agent Workstation's subagent tool `run_subagents` (recorded as `mcp__workstation_subagent__run_subagents`): the
 * agent proposes a batch and the person approves it once (a permission request whose `toolName` is that name and
 * whose `input` is RunSubagentsInput; no "always allow"). Approved: all start (at most 2 run at once, the rest
 * queue); denied: none. The result text holds one section per agent in input order, sections separated by a line
 * `--- subagent ---`; each section starts `session: <child uuid>` (absent when it never started), a blank line,
 * the answer, optionally a last line `Files: a, b`.
 */
export const SubagentSpec = z.object({
  model: z.string().optional(),
  description: z.string().min(1).max(80),
  task: z.string().min(1).max(8000),
  /**
   * Code sessions (required there; chats' subagents only read the web): the files this subagent may change, as globs
   * relative to the working directory (`src/web/**`, `README.md`). The hub refuses its file edits outside them, and
   * within a batch the first subagent to write a file owns it until it finishes (siblings are refused). Shown on the
   * approval card.
   */
  paths: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type SubagentSpec = z.infer<typeof SubagentSpec>;
export const RunSubagentsInput = z.object({ agents: z.array(SubagentSpec).min(1).max(6) });
export type RunSubagentsInput = z.infer<typeof RunSubagentsInput>;

/**
 * Chats' download tool `download_file` (recorded as `mcp__workstation_fetch__download_file`): the hub fetches
 * one https URL in an isolated environment (no access to the server's files; GET only, no body, cookies or auth headers;
 * public addresses only; size and time limits) and moves the file into the chat's folder. Well-known download hosts
 * are fetched directly; any other host is first judged by Claude Haiku: "safe" → fetched, otherwise (or when the check
 * cannot run: no API key or budget) the person decides on a permission request whose `input` is the DownloadFileInput
 * plus `check`.
 */
export const DownloadFileInput = z.object({ url: z.string().url().max(2048), filename: z.string().max(200).optional() });
export type DownloadFileInput = z.infer<typeof DownloadFileInput>;
export const DownloadCheck = z.object({ safe: z.boolean(), reason: z.string().max(400) });
export type DownloadCheck = z.infer<typeof DownloadCheck>;

export const HeadsUpInput = z.object({ text: z.string().min(1).max(300), detail: z.string().max(2000).optional() });
export type HeadsUpInput = z.infer<typeof HeadsUpInput>;
export const KnownHeadsUp = z.object({ id: z.string(), text: z.string().max(300), at: z.string() });
export type KnownHeadsUp = z.infer<typeof KnownHeadsUp>;
export const KnownHeadsUpBody = z.object({ text: z.string().min(1).max(300) });
export const KnownHeadsUpsResponse = z.object({ known: z.array(KnownHeadsUp) });

/**
 * GET /api/whoami - answered without a username. With Tailscale identity: the caller's login and node, the usernames
 * bound to that login (most recently active first) and `suggested` (the first of them; null when none is bound yet, so
 * the client asks for a name once and the first request with it binds it). Legacy callers (LAN while allowed, local
 * tools): `tailscale` null, `users` empty.
 */
export const WhoAmIResponse = z.object({
  tailscale: z.object({ login: z.string(), node: z.string() }).nullable(),
  users: z.array(z.string()),
  suggested: z.string().nullable(),
});
export type WhoAmIResponse = z.infer<typeof WhoAmIResponse>;

/**
 * The readme (`/readme` in the web app and the Mac app): two Markdown pages kept in the repo (docs/readme/*.md) and
 * served by the hub. They may use `<details><summary>…</summary>…</details>` for folded detail. Agents in sessions can
 * read the same pages (the `workstation_docs` tool).
 */
export const ReadmeDocName = z.enum(["features", "getting-started"]);
export type ReadmeDocName = z.infer<typeof ReadmeDocName>;
/** `assistant`: whether the docs assistant can be used right now (API key present and budget not spent). */
export const ReadmeDocResponse = z.object({ doc: ReadmeDocName, markdown: z.string(), assistant: z.boolean() });
export type ReadmeDocResponse = z.infer<typeof ReadmeDocResponse>;
/**
 * The docs assistant: Claude Sonnet 5.5 at medium effort through the API key, answering only from the two pages.
 * `messages` is the short conversation so far (≤ 20 turns, each ≤ 4,000 chars); the answer streams back as SSE
 * events `delta` `{ text }` then `done` `{ costUsd }` (or `error` `{ code, message }`). Billed to API credits like
 * every API-key request; 403 `api_unavailable` when no key is configured or the budget is spent (it may use the
 * service reserve, `AdminSettings.serviceReserveUsd`).
 */
export const ReadmeAskBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(4000) })).min(1).max(20),
});
export type ReadmeAskBody = z.infer<typeof ReadmeAskBody>;

/**
 * Sync selection (AgentWorkstation.app). Which paths of a linked folder go to the server:
 * - when a folder is first linked, a window shows its first level and up to 3 second-level items per folder, all
 *   checked; the person unchecks what should stay on the Mac (no built-in rules, no .gitignore, no AI);
 * - every folder and file then has a decision: `sync`, `skip`, or none (undecided, follows its ancestor);
 * - an unchecked folder (`skip`) never syncs anything inside it, new or old, and never asks;
 * - a new or changed item whose folder contains anything unchecked waits for the person (the Sync tab); in a folder
 *   with nothing unchecked it syncs automatically; the linked root follows the same rule;
 * - files > SYNC_LARGE_FILE_PROMPT_BYTES always ask first (with the reason); `.git` never syncs; cloud-only files
 *   (dataless) are never read and wait until they are local.
 * Deciding `skip` for something already on the server only stops syncing it; the server copy stays (never deleted
 * automatically). The web opens the Sync tab with `?panel=sync` on a session URL or a new-session URL
 * (`/?new=code&cwd=projects/<name>&panel=sync`). `SyncDecisionSource` values `rule` and `ai` only appear on links
 * made before this design; new decisions are `you`.
 */
export const SyncDecisionSource = z.enum(["rule", "ai", "you"]);
export type SyncDecisionSource = z.infer<typeof SyncDecisionSource>;
/** One row of the Sync panel tree (AgentWorkstation.app → web, through the shell bridge). */
export const SyncEntry = z.object({
  path: RelPath,
  kind: z.enum(["folder", "file"]),
  /** Own decision; null = undecided (follows its ancestor, or waits). */
  decision: z.enum(["sync", "skip"]).nullable(),
  /** The decision that applies (own or inherited); null = waiting for the person. */
  effective: z.enum(["sync", "skip"]).nullable(),
  /** Folders: some contents decided differently from the folder (a "mixed" folder when the folder itself is `sync`). */
  mixed: z.boolean().optional(),
  source: SyncDecisionSource.nullable(),
  /** Short reason for a rule or AI decision (rules: a fixed sentence; AI: its own). */
  reason: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  /** Folders: number of files beneath. */
  files: z.number().int().nonnegative().optional(),
});
export type SyncEntry = z.infer<typeof SyncEntry>;
/** A new item waiting for the person (undecided parent, the root, or a large file). */
export const SyncPendingItem = z.object({
  path: RelPath,
  kind: z.enum(["folder", "file"]),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative().optional(),
  /** What the rules / the AI suggest; null while the AI is still thinking or when nothing suggested anything. */
  suggestion: z.enum(["sync", "skip"]).nullable(),
  source: z.enum(["rule", "ai"]).nullable(),
  reason: z.string().nullable(),
  /** > SYNC_LARGE_FILE_PROMPT_BYTES (a large file). */
  large: z.boolean().optional(),
  detectedAt: z.string(),
});
export type SyncPendingItem = z.infer<typeof SyncPendingItem>;
/** The person's answer for one path (pending item or any tree row). `null` clears the own decision. */
export const SyncDecisionInput = z.object({ path: RelPath, kind: z.enum(["folder", "file"]), decision: z.enum(["sync", "skip"]).nullable() });
export type SyncDecisionInput = z.infer<typeof SyncDecisionInput>;

/**
 * Large files (> MAX_SYNC_FILE_BYTES): PUT ROUTES.projectLargeFile with query `path` (RelPath), `sha256` (hex of the
 * whole file), `size`, `mode`, `offset` (bytes already sent), `baseHash` (the real sha256 of the version the Mac last
 * saw; empty for a new file) and optionally `force=true` ("keep mine" after a conflict, as SyncOp.force); body = raw bytes of one chunk (≤ LARGE_FILE_CHUNK_BYTES,
 * `application/octet-stream`). Chunks must arrive in order; a chunk whose `offset` does not match what the hub holds →
 * 409 with the response below (resume from `received`). When `received` reaches `size` the hub checks the sha256,
 * moves the file into the working tree (tmp + rename) and records it; `complete: true`. GET with `path`, `sha256` and
 * `size` reports progress for resuming. A sha256 mismatch → 422 and the partial upload is dropped. 507 disk_block like
 * other pushes. Completing an upload is a sync write like any other (it updates the `local` branch with the
 * pointer, merges against server-side changes the same way, and can conflict). The project manifest
 * (ROUTES.projectManifest) covers large files too (by their real sha256 and size); a `delete` SyncOp works as for
 * small files. A chunk the hub already holds in its large-file store (same sha256) completes at once.
 */
/**
 * PUT ROUTES.projectExcludes: the paths the person unchecked on the Mac (own `skip` decisions, not inherited ones). The
 * server excludes exactly these plus `.git`: they never enter the project from the Mac, and files the agent creates there
 * (a build/ folder, node_modules/) stay out of review. Nothing else is excluded on the server: no built-in defaults, no
 * in-tree .gitignore. Replaces the previous list; 204. AgentWorkstation.app sends it after linking and whenever decisions change.
 */
export const ProjectExcludesBody = z.object({
  paths: z.array(z.object({ path: RelPath, kind: z.enum(["folder", "file"]) })).max(10_000),
});
export type ProjectExcludesBody = z.infer<typeof ProjectExcludesBody>;

export const LargeFileUploadResponse = z.object({
  path: RelPath,
  received: z.number().int().nonnegative(),
  complete: z.boolean(),
  /**
   * On completion: the sync write's outcome, exactly as a SyncResult entry would report it (`conflict` comes back here
   * with HTTP 200 - 409 means only an offset mismatch).
   */
  result: z.object({ status: z.enum(["applied", "noop", "merged", "conflict", "skipped"]), reason: z.string().optional() }).optional(),
  /** On completion: the `local` commit after the write. */
  localCommit: z.string().nullable().optional(),
});
export type LargeFileUploadResponse = z.infer<typeof LargeFileUploadResponse>;

export const MessagesQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().positive().max(1000).default(500) });

export const TreeQuery = z.object({ path: z.string().default(""), depth: z.coerce.number().int().min(1).max(10).default(1) });
export const FileContentResponse = z.object({ path: RelPath, size: z.number().int(), truncated: z.boolean(), text: z.string().nullable(), mediaType: z.string() });

/**
 * Chunked upload: PUT /api/files/upload with these headers; body = raw chunk bytes
 * (any Content-Type; `application/octet-stream` recommended).
 * - X-Upload-Id: client-chosen id, [A-Za-z0-9_-]{8,64}; reuse it to resume.
 * - X-Upload-Path: target path relative to the workspace root, percent-encoded
 *   (`encodeURIComponent`) so non-ASCII names survive HTTP headers.
 * - X-Chunk-Index is 0-based; every chunk except the last must be UPLOAD_CHUNK_BYTES.
 * The hub never overwrites an existing file: if the target exists the file is
 * stored as "name (1).ext" etc. and the final path is returned in `path`.
 */
export const UPLOAD_HEADERS = {
  uploadId: "X-Upload-Id",
  path: "X-Upload-Path",
  chunkIndex: "X-Chunk-Index",
  chunkTotal: "X-Chunk-Total",
  totalBytes: "X-Total-Bytes",
} as const;
export const UploadChunkResponse = z.object({ uploadId: z.string(), received: z.array(z.number().int()), complete: z.boolean(), path: RelPath.optional() });

export const CreateProjectBody = z.object({ name: Project.shape.name, origin: z.string().optional() });

export const ManifestEntry = z.object({ path: RelPath, hash: z.string(), size: z.number().int(), mode: z.number().int() });
export const ManifestBody = z.object({ entries: z.array(ManifestEntry) });
export const ManifestResponse = z.object({ need: z.array(RelPath), delete: z.array(RelPath), localCommit: z.string().nullable() });

export const SyncOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), path: RelPath, hash: z.string(), size: z.number().int(), mode: z.number().int(), /** sha256 of the `local` blob the client last saw, or null for a new file */ baseHash: z.string().nullable(), contentBase64: z.string().optional(), force: z.boolean().optional() }),
  z.object({ op: z.literal("delete"), path: RelPath, baseHash: z.string().nullable(), force: z.boolean().optional() }),
]);
export const SyncBody = z.object({ ops: z.array(SyncOp) });
export const SyncResult = z.object({
  localCommit: z.string().nullable(),
  results: z.array(z.object({ path: RelPath, status: z.enum(["applied", "noop", "merged", "conflict", "need_content", "skipped"]), reason: z.string().optional() })),
});

export const ReviewResponse = z.object({ project: Project, files: z.array(ReviewFile) });
export const AcceptBody = z
  .object({ path: RelPath, hunks: z.array(z.number().int()).optional(), /** required when `hunks` is given: the FileDiff.diffId the indices refer to */ diffId: z.string().optional() })
  .or(z.object({ all: z.literal(true) }));
export const AcceptResponse = z.object({
  localCommit: z.string(),
  /**
   * Large files come with `contentBase64: null`, `deleted: false`, `large: true`, `sha256` and `size`: download them
   * with ROUTES.projectFileRaw at `ref = localCommit` (HTTP Range) and check the sha256.
   */
  files: z.array(z.object({ path: RelPath, contentBase64: z.string().nullable(), deleted: z.boolean(), large: z.boolean().optional(), sha256: z.string().optional(), size: z.number().int().nonnegative().optional() })),
  /** Paths that could not be accepted (binary over the size limit, symlinks, ...). */
  skipped: z.array(z.object({ path: RelPath, reason: z.string() })).optional(),
});
export const RejectBody = AcceptBody;
export const RestoreBody = z.object({ ref: z.string(), path: RelPath.optional() });
export const DeleteProjectBody = z.object({ /** Must be true to delete when pending changes or undownloaded files exist. */ discardRemaining: z.boolean().default(false) });

/** `content` is the whole SKILL.md text, frontmatter (`name`, `description`) included. */
export const SkillDetail = Skill.extend({ content: z.string() });
export type SkillDetail = z.infer<typeof SkillDetail>;
/**
 * POST /api/skills and PUT /api/skills/:name. `content` = the SKILL.md text; the hub keeps or adds a
 * frontmatter block and forces its `name:` to the skill name. A PUT whose `name` differs from the
 * route renames the skill. `scope: "global"` needs admin.
 */
export const SkillBody = z.object({ name: Skill.shape.name, content: z.string(), scope: z.enum(["user", "global"]).default("user") });

export const UsageRange = z.enum(["today", "7d", "30d"]);
export const MyUsageResponse = z.object({
  range: UsageRange,
  buckets: z.array(TokenUsageBucket),
  weeklyTokens: z.number().int(),
  weeklyLimit: z.number().int().nullable(),
});
export const AdminUsageResponse = z.object({ users: z.array(z.object({ user: Username, weeklyTokens: z.number().int(), weeklyLimit: z.number().int().nullable(), costUsd: z.number(), sessions: z.number().int() })), buckets: z.array(TokenUsageBucket.extend({ user: Username })) });

export const CreateTerminalBody = z.object({ cwd: z.string().optional() });
export const TerminalInfo = z.object({ id: z.string(), cwd: z.string(), createdAt: z.string(), tmuxSession: z.string() });

// Inferred types for the request/response bodies above (added by the hub; additive).
export type CreateUserBody = z.infer<typeof CreateUserBody>;
export type PatchUserBody = z.infer<typeof PatchUserBody>;
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;
export type PatchSessionBody = z.infer<typeof PatchSessionBody>;
export type SendMessageBody = z.infer<typeof SendMessageBody>;
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;
export type FileContentResponse = z.infer<typeof FileContentResponse>;
export type UploadChunkResponse = z.infer<typeof UploadChunkResponse>;
export type UsageRange = z.infer<typeof UsageRange>;
export type MyUsageResponse = z.infer<typeof MyUsageResponse>;
export type AdminUsageResponse = z.infer<typeof AdminUsageResponse>;
export type CreateTerminalBody = z.infer<typeof CreateTerminalBody>;
export type TerminalInfo = z.infer<typeof TerminalInfo>;

// ---------------------------------------------------------------------------
// REST route table (for docs and client helpers)
// ---------------------------------------------------------------------------

export const ROUTES = {
  healthz: "GET /healthz (plain-text \"ok\", no auth)",
  health: "GET /api/health (no auth)",
  me: "GET /api/me",
  mePreferences: "PATCH /api/me/preferences",
  memories: "GET /api/me/memories | POST /api/me/memories",
  memory: "PATCH /api/me/memories/:id | DELETE /api/me/memories/:id",
  search: "GET /api/search?q=&limit=",
  browser: "GET /api/browser | POST /api/browser/start | POST /api/browser/stop",
  adminPricing: "GET /api/admin/pricing (admin) | POST /api/admin/pricing/refresh (admin)",
  searchRelevant: "GET /api/search/relevant?q=&limit=",
  models: "GET /api/models",
  commands: "GET /api/commands?sessionId=",
  users: "GET /api/users (admin) | POST /api/users",
  user: "PATCH /api/users/:name (admin)",
  userDelete: "DELETE /api/users/:name?force= (admin)",
  sessions: "GET /api/sessions?kind= | POST /api/sessions",
  session: "GET /api/sessions/:id | PATCH /api/sessions/:id | DELETE /api/sessions/:id",
  sessionMessages: "GET /api/sessions/:id/messages?after=&limit= | POST /api/sessions/:id/messages",
  sessionSettings: "PATCH /api/sessions/:id/settings",
  sessionStop: "POST /api/sessions/:id/stop",
  sessionClose: "POST /api/sessions/:id/close",
  appRelease: "GET /api/app/:platform/latest (platform = mac or mac-intel; no user header; 404 when the server has no release)",
  appDownload: "GET /api/app/:platform/download (no user header; the latest .dmg)",
  appReleases: "GET /api/app/releases (no user header; every release, for the download page)",
  appFile: "GET /download/:platform/:version (no user header; that version's .dmg, latest = the newest; /download itself is the web download page)",
  sessionOutputs: "GET /api/sessions/:id/outputs",
  sessionTaskStop: "POST /api/sessions/:id/tasks/:taskId/stop",
  sessionRewind: "POST /api/sessions/:id/rewind",
  sessionFork: "POST /api/sessions/:id/fork",
  sessionPin: "PUT /api/sessions/:id/pins/:messageUuid | DELETE /api/sessions/:id/pins/:messageUuid",
  readmeDoc: "GET /api/readme/:doc (doc = features or getting-started; no user header; the Markdown of that page)",
  readmeAsk: "POST /api/readme/ask (the docs assistant; Tailscale callers; only while API credits remain)",
  whoami: "GET /api/whoami (no user header: who the hub thinks is calling, for signing in without typing a name)",
  headsUpKnown: "GET /api/me/heads-up/known | POST /api/me/heads-up/known | DELETE /api/me/heads-up/known?id=",
  filesTree: "GET /api/files/tree?path=&depth=",
  filesContent: "GET /api/files/content?path=",
  filesDownload: "GET /api/files/download?path= (multiple path= → zip)",
  filesUpload: "PUT /api/files/upload (chunked, see UPLOAD_HEADERS)",
  filesUploadStatus: "GET /api/files/upload?uploadId= (which chunks the hub already has, for resuming)",
  filesDelete: "DELETE /api/files?path= (user-initiated only)",
  filesMkdir: "POST /api/files/mkdir",
  projects: "GET /api/projects | POST /api/projects",
  project: "GET /api/projects/:id | DELETE /api/projects/:id",
  projectBaseline: "POST /api/projects/:id/baseline (tar.zst body)",
  projectManifest: "POST /api/projects/:id/manifest",
  projectExcludes: "PUT /api/projects/:id/excludes (the unchecked paths; the server excludes only these and .git)",
  projectFiles: "PUT /api/projects/:id/files",
  projectLargeFile: "PUT /api/projects/:id/large?path=&sha256=&size=&mode=&offset= | GET /api/projects/:id/large?path=&sha256=&size=",
  visualCdn: "GET /api/visual-cdn/:host/* (libraries for HTML visuals, fetched and cached by the server; open route)",
  projectReview: "GET /api/projects/:id/review",
  projectReviewDiff: "GET /api/projects/:id/review/diff?path=",
  browserSites: "GET /api/me/browser-sites | DELETE /api/me/browser-sites?origin=",
  projectReviewPatch: "GET /api/projects/:id/review/patch (text/x-diff: every pending change between local and the work tree)",
  projectAccept: "POST /api/projects/:id/review/accept",
  projectReject: "POST /api/projects/:id/review/reject",
  projectHistory: "GET /api/projects/:id/history",
  projectRestore: "POST /api/projects/:id/restore",
  projectFileRaw: "GET /api/projects/:id/raw?path=&ref= (working-tree bytes; with ref = that commit/ref/blob's bytes; large files resolved from the store; supports Range)",
  projectBackups: "GET /api/projects/:id/backups | POST /api/projects/:id/backups",
  skills: "GET /api/skills | POST /api/skills | PUT /api/skills/:name | DELETE /api/skills/:name",
  skill: "GET /api/skills/:name?scope=user|global (SkillDetail; without scope the user skill wins over a global one)",
  usageLimits: "GET /api/usage/limits (no auth: the status service proxies it anonymously)",
  usageMe: "GET /api/usage/me?range=",
  disk: "GET /api/disk",
  adminOverview: "GET /api/admin/overview",
  adminUsage: "GET /api/admin/usage?range=",
  adminSettings: "GET /api/admin/settings | PATCH /api/admin/settings",
  terminals: "GET /api/terminals | POST /api/terminals | DELETE /api/terminals/:id",
  ws: "WS /ws",
  wsTerminal: "WS /ws/terminal/:id",
} as const;

// ---------------------------------------------------------------------------
// REST - response shapes and query strings not covered above (added by the hub, v1 additive)
// ---------------------------------------------------------------------------

/** GET /api/users */
export const UsersResponse = z.array(User);
/** GET /api/sessions - newest first. */
export const SessionsQuery = z.object({ kind: SessionKind.optional() });
export const SessionsResponse = z.array(Session);
/** GET /api/sessions/:id/messages */
export const MessagesResponse = z.array(StoredMessage);
/** GET /api/models (already filtered by the user's modelAllowlist) */
export const ModelsResponse = z.array(ModelInfo);
/** GET /api/commands - names come without the leading "/". */
export const CommandsQuery = z.object({ sessionId: z.guid().optional() });
export const CommandsResponse = z.array(CommandInfo);
/** GET /api/files/tree - flat, depth-first list (dirs first, then files, by name); capped at 5000 entries. */
export const TreeResponse = z.array(FileEntry);
export const PathQuery = z.object({ path: RelPath });
/** GET /api/files/download?path=a&path=b - one file streams as-is (add `inline=1` to preview); a dir or several paths → zip. */
export const DownloadQuery = z.object({ path: z.union([RelPath, z.array(RelPath).min(1)]), inline: z.enum(["0", "1"]).optional() });
/** POST /api/files/mkdir → FileEntry (201). Creates parents as needed. */
export const MkdirBody = z.object({ path: RelPath });
/** GET /api/files/upload?uploadId= → UploadChunkResponse */
export const UploadStatusQuery = z.object({ uploadId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });
/** GET /api/terminals */
export const TerminalsResponse = z.array(TerminalInfo);
/** ?range= for usage endpoints; default "7d". */
export const UsageRangeQuery = z.object({ range: UsageRange.default("7d") });
/** PATCH /api/admin/settings → AdminSettings */
export const PatchAdminSettingsBody = AdminSettings.partial();

/**
 * DELETE /api/users/:name - admin only, 204 on success. Refused with 409 `user_not_empty` (details.projects lists
 * `{ id, name, pendingFiles, undownloadedFiles }`) while one of the user's projects has unaccepted
 * changes or undownloaded files, unless `force=true`. Reserved names and admin usernames: 403
 * `reserved_user`. Removes everything: live processes, sessions (and Claude's transcripts), usage
 * rows, permission rules, terminals (tmux killed), projects and `<users_root>/<name>`.
 */
export const DeleteUserQuery = z.object({
  force: z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]).optional(),
});
export type DeleteUserQuery = z.infer<typeof DeleteUserQuery>;

/** GET /api/projects - the caller's projects, by name. */
export const ProjectsResponse = z.array(Project);
/** DELETE /api/projects/:id also accepts `?discardRemaining=true` (for clients that cannot send a DELETE body). */
export const DeleteProjectQuery = z.object({ discardRemaining: z.enum(["true", "false", "1", "0"]).optional() });
/** GET /api/projects/:id/history - newest first. */
export const HistoryQuery = z.object({ limit: z.coerce.number().int().positive().max(5000).optional() });
export const HistoryResponse = z.array(Snapshot);
/** POST /api/projects/:id/review/reject → paths whose working-tree content was reverted (a trash ref is written first). */
export const RejectResponse = z.object({ localCommit: z.string(), trashRef: z.string().nullable(), paths: z.array(RelPath) });
/** POST /api/projects/:id/restore → the trash ref holding the previous work tree and the commit restored from. */
export const RestoreResponse = z.object({ localCommit: z.string(), trashRef: z.string(), commit: z.string() });
/** GET/DELETE /api/skills/:name?scope= - which copy to read or delete (DELETE defaults to "user"). */
export const SkillQuery = z.object({ scope: z.enum(["user", "global"]).optional() });
/** GET /api/skills - the caller's skills plus the global ones. */
export const SkillsResponse = z.array(Skill);
export type RejectResponse = z.infer<typeof RejectResponse>;
export type RestoreResponse = z.infer<typeof RestoreResponse>;
export type SkillBody = z.infer<typeof SkillBody>;

/** GET /api/health */
export const HubHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  uptimeS: z.number(),
  serverTime: z.string(),
  /** The server's host name (os.hostname()), shown as the machine a session runs on. Absent on older hubs. */
  hostname: z.string().optional(),
  /** Claude Code's version as the agent account runs it (null = not installed / not known). */
  agents: z.object({ claude: z.string().nullable() }).optional(),
  /** Live Claude processes (one per running session process). */
  processes: z.object({ claude: z.number().int().nonnegative() }).optional(),
});
export type HubHealth = z.infer<typeof HubHealth>;

/**
 * The newest AgentWorkstation.app the server offers (written by deploy from apps/mac/dist/release.json). The app compares `build`
 * (the CFBundleVersion timestamp, digits) with its own, downloads `GET /api/app/mac/download` and checks `sha256`.
 */
/** Release channels of the Mac app: `mac` = Apple Silicon (arm64, also the default), `mac-intel` = x86_64. */
export const AppPlatform = z.enum(["mac", "mac-intel"]);
export type AppPlatform = z.infer<typeof AppPlatform>;
export const AppRelease = z.object({
  platform: AppPlatform,
  version: z.string(),
  build: z.string().regex(/^\d{1,20}$/),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.string(),
  /**
   * Ed25519 signature (base64) over the UTF-8 string `workstation-release-v1|<platform>|<version>|<build>|<sizeBytes>|<sha256>`,
   * made on the build Mac by scripts/make-app.sh with a private key that never leaves that Mac. The app verifies it
   * with the public key built into it and refuses a release without a valid signature (the server only relays it).
   */
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type AppRelease = z.infer<typeof AppRelease>;
/** GET /api/app/releases - every published release (no user header), newest first per platform; for the download page. */
export const AppReleasesResponse = z.object({ releases: z.array(AppRelease) });
export type AppReleasesResponse = z.infer<typeof AppReleasesResponse>;

/** GET /api/admin/overview */
export const AdminOverview = z.object({
  settings: AdminSettings,
  usageLimits: UsageLimits,
  disk: z.object({ level: DiskLevel, usedPercent: z.number(), totalBytes: z.number().int(), freeBytes: z.number().int() }),
  memory: z.object({ totalMiB: z.number().nullable(), availableMiB: z.number().nullable(), minFreeMiB: z.number() }),
  pool: z.object({ active: z.number().int(), max: z.number().int(), queued: z.number().int() }),
  /** Live Claude Code processes (one per session at most). rssMiB is null where /proc is unavailable. */
  processes: z.array(
    z.object({ sessionId: z.guid(), user: Username, kind: SessionKind, status: SessionStatus, pid: z.number().int().nullable(), rssMiB: z.number().nullable(), startedAt: z.string(), lastActiveAt: z.string() }),
  ),
  users: z.array(z.object({ user: Username, enabled: z.boolean(), sessions: z.number().int(), weeklyTokens: z.number().int(), weeklyLimit: z.number().int().nullable() })),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

/**
 * Error codes the hub puts in ErrorBody.code (non-exhaustive). The pre-send
 * checks on POST /api/sessions/:id/messages map to:
 *   403 remote_disabled · 403 user_disabled · 429 weekly_limit · 507 disk_block · 503 api_unavailable ·
 *   429 api_limit_reached
 * Projects: 409 project_exists (POST, same name) · 409 project_not_empty (DELETE without
 * discardRemaining; details = { pendingFiles, undownloadedFiles }) · 409 stale_diff (hunk accept/reject
 * with an outdated diffId; details = { diffId } of the current diff) · 409 stale (local moved) ·
 * 409 sync_conflict (PUT files: the body is the SyncResult plus error/code) · 400 invalid_path ·
 * 413 too_large · 422 binary / unsupported / symlink · 507 disk_block (baseline and pushes only).
 * Skills: 409 skill_exists · 403 admin_required (global scope).
 */
export const ERROR_CODES = [
  "invalid_request",
  "user_required",
  "reserved_user",
  "admin_required",
  "not_found",
  "remote_disabled",
  "user_disabled",
  "weekly_limit",
  "disk_block",
  "model_not_allowed",
  "terminal_disabled",
  "path_outside_workspace",
  "upload_incomplete",
  "permission_not_found",
  "stale_diff",
  "project_not_empty",
  "sync_conflict",
  "project_exists",
  "user_not_empty",
  "skill_exists",
  "stale",
  "invalid_path",
  "too_large",
  "binary",
  "unsupported",
  "symlink",
  /** More than the per-user maximum number of memories (remove some first). */
  "memory_limit",
  /** No Anthropic API key is configured on the server, or the monthly budget is 0 (503). */
  "api_unavailable",
  /** This month's API budget is used up (down to the service reserve); wait for the reset or raise the budget (429). */
  "api_limit_reached",
  /** The model failed while ranking search results (502). */
  "search_failed",
  /** The username is bound to another Tailscale login (403). */
  "user_bound",
  /** Agent Workstation only answers over Tailscale (`lan_access = "deny"`, 403). */
  "lan_denied",
  /** The calling Tailscale device has no personal login (tagged node, 403). */
  "tailscale_identity_required",
  /** tailscaled could not be asked who is calling (503). */
  "tailscale_unavailable",
  /** The session is being rewound; send again in a moment (409). */
  "busy",
  /** Too many requests from this caller; retry after `details.retryAfterS` (429). */
  "rate_limited",
  /** The server could not fetch a visual's library from its CDN (502). */
  "upstream_error",
  /** The request came from another web site (disallowed `Origin`, or `Sec-Fetch-Site: cross-site`); refused (403). */
  "cross_site",
  /** A baseline upload exceeded its compressed-size, extracted-size or file-count limit (413). */
  "baseline_too_large",
  /** A baseline upload took longer than its time limit (408). */
  "baseline_timeout",
  /** A baseline archive holds an entry type the extractor does not accept (sparse, multi-volume, unknown) or a damaged header (400). */
  "baseline_unsupported_entry",
  /** The request came from this server itself (a process on the server calling one of its own addresses); refused (403). */
  "self_caller",
  /** The request reached the public socket without exactly one `X-Forwarded-For` IP, or the local socket with one; refused (400). */
  "proxy_header_invalid",
  /** The request's `Host` is not one of this server's names (DNS rebinding protection); refused (421). */
  "bad_host",
] as const;

/**
 * Hub-originated messages persisted alongside SDK messages (kind "system",
 * payload `{ type: "system", subtype, ... }`):
 *   hub_cancelled      { message_uuids: string[], reason }  queued user messages dropped by Stop/Close
 *   hub_process_died   { error }                            the CLI process crashed mid-turn (status → dead)
 *   hub_stop_timeout   {}                                   interrupt got no result within 10 s; process closed
 * SDK system messages that are persisted: init (first per process), status (only with
 * permissionMode/compact_result), compact_boundary, local_command_output, informational.
 * POST /api/sessions/:id/messages answers 200 {state:"accepted"} or 202 {state:"queued", position}.
 */
export const HUB_SYSTEM_SUBTYPES = ["hub_cancelled", "hub_process_died", "hub_stop_timeout"] as const;

// ---------------------------------------------------------------------------
// WebSocket - one connection per client, multiplexed by sessionId
// ---------------------------------------------------------------------------

/**
 * The per-user browser on the server: one Chromium with a persistent profile (logins stick), driven by Claude through
 * a browser-automation MCP server, viewable and controllable live from the client ("Browser" panel).
 * Frames are only produced while at least one client has the view open.
 */
export const BrowserState = z.object({
  running: z.boolean(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  /** Who acted last: the agent (tool calls) or the person (input from the live view); null when idle. */
  controlledBy: z.enum(["agent", "user"]).nullable(),
  /** Session whose agent last used the browser, if any. */
  sessionId: z.guid().nullable(),
  viewers: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
});
export type BrowserState = z.infer<typeof BrowserState>;
export const BrowserInput = z.discriminatedUnion("kind", [
  /** Coordinates in viewport CSS pixels. */
  /**
   * Raw pointer events only: clients send down/up (and throttled move); the browser derives click and double-click
   * itself from `clickCount` (the DOM event's `detail`: 1 for a single click, 2 for the second press of a double).
   * "click"/"dblclick" are accepted for compatibility but clients must not send them together with down/up.
   */
  z.object({ kind: z.literal("mouse"), action: z.enum(["move", "down", "up", "click", "dblclick"]), x: z.number(), y: z.number(), button: z.enum(["left", "middle", "right"]).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ kind: z.literal("wheel"), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }),
  /** A key press with DOM `key` and modifiers. */
  z.object({ kind: z.literal("key"), action: z.enum(["down", "up", "press"]), key: z.string(), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional() }),
  /** Inserted text (IME / paste). */
  z.object({ kind: z.literal("text"), text: z.string().max(10000) }),
  z.object({ kind: z.literal("navigate"), url: z.string().url() }),
  z.object({ kind: z.literal("history"), action: z.enum(["back", "forward", "reload"]) }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;

export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), user: Username, protocolVersion: z.number().int() }),
  /** Subscribe to a session; the hub replies with `replay` then `snapshot`, then live events. */
  z.object({ type: z.literal("subscribe"), sessionId: z.guid(), lastSeq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("unsubscribe"), sessionId: z.guid() }),
  z.object({ type: z.literal("permission_response"), sessionId: z.guid(), response: PermissionResponse }),
  z.object({ type: z.literal("ping") }),
  /** Open/close the live browser view for this connection (frames flow while on). */
  z.object({ type: z.literal("browser_view"), on: z.boolean(), maxWidth: z.number().int().positive().optional() }),
  /** Person's input into the live browser view. */
  z.object({ type: z.literal("browser_input"), input: BrowserInput }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

export const StreamDelta = z.discriminatedUnion("part", [
  z.object({ part: z.literal("text"), messageId: z.string(), text: z.string() }),
  z.object({ part: z.literal("thinking"), messageId: z.string(), text: z.string() }),
  z.object({ part: z.literal("tool_use_start"), messageId: z.string(), toolUseId: z.string(), toolName: z.string() }),
  z.object({ part: z.literal("tool_use_input"), messageId: z.string(), toolUseId: z.string(), partialJson: z.string() }),
  z.object({ part: z.literal("message_end"), messageId: z.string() }),
  /** Output tokens so far: `outputTokens` for this message, `turnOutputTokens` summed over the whole turn (shown live while Claude works). */
  z.object({ part: z.literal("usage"), messageId: z.string(), outputTokens: z.number().int().nonnegative(), turnOutputTokens: z.number().int().nonnegative() }),
]);
export type StreamDelta = z.infer<typeof StreamDelta>;

/**
 * A background task of a running Claude session (a background shell command or a subagent), from the SDK's
 * `background_tasks_changed` message. The list is the SDK's current set; it is empty when nothing runs in the background.
 */
export const BackgroundTask = z.object({
  taskId: z.string(),
  /** SDK task_type, e.g. "local_bash", "local_agent". */
  type: z.string(),
  description: z.string(),
  subagentType: z.string().optional(),
  /** When the hub first saw it. */
  startedAt: z.string(),
  /** Running, or how it ended (SDK task_notification / gone from the list = completed). Absent on older hubs = running. */
  status: z.enum(["running", "completed", "failed", "stopped"]).optional(),
  /** When it ended (null/absent while running). */
  endedAt: z.string().nullable().optional(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

/** A file a session's agent created or changed (from the hub's file_touches; newest touch per path). */
export const SessionOutput = z.object({
  /** Workspace-relative path. */
  path: RelPath,
  /** The tool of the last touch (Write, Edit, MultiEdit, NotebookEdit, …). */
  tool: z.string(),
  turn: z.number().int(),
  at: z.string(),
  /** The file no longer exists in the workspace. */
  missing: z.boolean(),
});
export type SessionOutput = z.infer<typeof SessionOutput>;
export const SessionOutputsResponse = z.object({ outputs: z.array(SessionOutput) });
export type SessionOutputsResponse = z.infer<typeof SessionOutputsResponse>;

/**
 * The agent's end-of-turn box (like the Claude desktop app's "next step"): a short recap and, when the turn leaves the
 * user a decision, one question with 1–3 answer buttons. Set by the agent's `wrap_up` tool; cleared when the user sends
 * the next message. A button sends its label as the user's next message.
 */
export const NextStep = z.object({
  recap: z.string().min(1).max(600),
  ask: z.string().max(200).optional(),
  actions: z.array(z.object({ label: z.string().min(1).max(40) })).max(3).optional(),
  at: z.string(),
});
export type NextStep = z.infer<typeof NextStep>;

export const SessionSnapshot = z.object({
  session: Session,
  /** In-flight assistant content folded from stream deltas (empty when idle). */
  partial: z.object({
    messageId: z.string().nullable(),
    text: z.string(),
    thinking: z.string(),
    currentTool: z.object({ toolUseId: z.string(), toolName: z.string(), partialJson: z.string() }).nullable(),
    /** Output tokens of the running turn so far (0 when idle). */
    turnOutputTokens: z.number().int().nonnegative().optional(),
  }),
  /** When the running turn started (null when idle), for the live elapsed-time indicator. */
  turnStartedAt: z.string().nullable().optional(),
  pendingPermission: PermissionRequest.nullable(),
  /** Background tasks of the session: running ones and those that ended (newest last), absent on older hubs. */
  backgroundTasks: z.array(BackgroundTask).optional(),
  /** The current end-of-turn box (null when none). */
  nextStep: NextStep.nullable().optional(),
  /** Seq ranges (inclusive) that were rewound: a reconnecting client drops the messages it holds in them. */
  rewound: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), user: User, protocolVersion: z.number().int(), serverTime: z.string() }),
  /** `truncated` = only the newest `messages` were sent (long sessions); fetch older ones via GET /api/sessions/:id/messages. */
  z.object({ type: z.literal("replay"), sessionId: z.guid(), messages: z.array(StoredMessage), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("snapshot"), sessionId: z.guid(), snapshot: SessionSnapshot }),
  z.object({ type: z.literal("message"), sessionId: z.guid(), message: StoredMessage }),
  z.object({ type: z.literal("delta"), sessionId: z.guid(), delta: StreamDelta }),
  z.object({ type: z.literal("session_state"), sessionId: z.guid(), status: SessionStatus, queuePosition: z.number().int().nullable() }),
  z.object({ type: z.literal("session_settings"), sessionId: z.guid(), settings: z.object({ model: z.string(), permissionMode: PermissionMode, effort: EffortLevel.nullable() }) }),
  /** Includes incognito sessions (`session.incognito: true`): clients must keep them out of session lists. */
  z.object({ type: z.literal("session_updated"), session: Session }),
  z.object({ type: z.literal("session_deleted"), sessionId: z.guid() }),
  z.object({ type: z.literal("permission_request"), request: PermissionRequest }),
  z.object({ type: z.literal("permission_resolved"), sessionId: z.guid(), requestId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ type: z.literal("permission_cancelled"), sessionId: z.guid(), requestId: z.string() }),
  /** Workspace file created/modified/deleted (chokidar). */
  z.object({ type: z.literal("file_event"), path: RelPath, kind: z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]), sessionId: z.guid().nullable(), at: z.string() }),
  z.object({ type: z.literal("review_changed"), projectId: z.guid(), localCommit: z.string().nullable(), pendingFiles: z.number().int() }),
  z.object({ type: z.literal("sync_conflict"), projectId: z.guid(), path: RelPath, reason: z.string() }),
  z.object({ type: z.literal("usage_limits"), limits: UsageLimits }),
  z.object({ type: z.literal("disk_status"), status: DiskStatus }),
  /** The user's memories changed (Claude saved/removed one, or another device edited them): refetch GET /api/me/memories. */
  z.object({ type: z.literal("memories_changed") }),
  /** The hub refreshed a session's context-window usage (at turn end). */
  z.object({ type: z.literal("context_usage"), sessionId: z.guid(), usage: ContextUsage }),
  /** The session's background tasks changed (the full list: running and ended). */
  z.object({ type: z.literal("background_tasks"), sessionId: z.guid(), tasks: z.array(BackgroundTask) }),
  /** The end-of-turn box was set (or cleared: null). */
  z.object({ type: z.literal("next_step"), sessionId: z.guid(), step: NextStep.nullable() }),
  /** A rewind: messages with seq >= fromSeq left the transcript (drop them; later messages continue with higher seqs). */
  z.object({ type: z.literal("messages_rewound"), sessionId: z.guid(), fromSeq: z.number().int().positive() }),
  /**
   * Live cost of the running turn (list-price estimate from message usage while it runs; `final` with the exact value at
   * the result). `sessionCostUsd` includes the turn. Sent to the session's subscribers.
   */
  z.object({ type: z.literal("cost_update"), sessionId: z.guid(), turnCostUsd: z.number().nonnegative(), sessionCostUsd: z.number().nonnegative(), final: z.boolean() }),
  /** The user's server browser changed (started/stopped, navigated, control switched, viewers). */
  z.object({ type: z.literal("browser_state"), state: BrowserState }),
  /** One JPEG frame of the live browser view (only to connections with the view on). */
  z.object({ type: z.literal("browser_frame"), data: z.string(), width: z.number().int(), height: z.number().int(), at: z.string() }),
  /** Global notices: remote Claude disabled, weekly limit reached, API budget used up, etc. */
  z.object({ type: z.literal("notice"), level: z.enum(["info", "warning", "error"]), code: z.string(), message: z.string(), at: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), sessionId: z.guid().optional() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/**
 * Terminal WebSocket (/ws/terminal/:id) - frames are JSON text:
 *   client → { t: "in",  data }            keystrokes
 *   client → { t: "resize", cols, rows }
 *   server → { t: "out", data }            pty output
 *   server → { t: "exit", code }
 */
export const TerminalClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), data: z.string() }),
  z.object({ t: z.literal("resize"), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);
export const TerminalServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("out"), data: z.string() }),
  z.object({ t: z.literal("exit"), code: z.number().int().nullable() }),
]);

// ---------------------------------------------------------------------------
// Status service (separate process) - /status/api
// ---------------------------------------------------------------------------

export const MetricPoint = z.object({ t: z.number().int(), v: z.number().nullable() });
export const MetricSeries = z.object({ name: z.string(), unit: z.string(), points: z.array(MetricPoint) });
export const MetricsResponse = z.object({ range: z.string(), stepS: z.number().int(), series: z.array(MetricSeries) });
export const HealthCheck = z.object({ id: z.string(), label: z.string(), state: z.enum(["ok", "warn", "fail", "unknown"]), detail: z.string().nullable(), checkedAt: z.string(), latencyMs: z.number().nullable() });
export const HealthResponse = z.object({ checks: z.array(HealthCheck), events: z.array(z.object({ at: z.string(), id: z.string(), from: z.string(), to: z.string(), detail: z.string().nullable() })) });
export const STATUS_ROUTES = {
  metrics: "GET /status/api/metrics?range=1h|6h|24h|7d|30d",
  health: "GET /status/api/health",
  stream: "GET /status/api/stream (SSE: metrics + health)",
  speedtest: "POST /status/api/speedtest",
  system: "GET /status/api/system (static info: model, kernel, uptime, disks)",
} as const;
