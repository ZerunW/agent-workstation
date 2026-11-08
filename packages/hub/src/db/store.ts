/**
 * SQLite persistence (better-sqlite3, WAL). All access goes through prepared
 * statements; nothing here reads a whole table per message.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel, PermissionMode, SessionKind, SessionStatus, StoredMessageKind } from "@agent-workstation/protocol";
import { messagePlainText } from "../search/text.js";
import { canonicalUsageModel } from "../sessions/models.js";
import { isClaudeModel, type LongPromptTier, type Pricing } from "../pricing.js";
import { iso } from "../util/time.js";

type Db = Database.Database;
type Stmt = Database.Statement;

export interface UserRow {
  name: string;
  createdAt: string;
  enabled: boolean;
  terminalEnabled: boolean;
  weeklyLimitCustom: boolean;
  weeklyTokenLimit: number | null;
  modelAllowlist: string[] | null;
  /** User's own default model for new sessions; null = server default. */
  defaultModel: string | null;
  /** User's own default effort (an EffortLevel value); null = server default. */
  defaultEffort: string | null;
  /** Memory feature on for this user (default true). */
  memoryEnabled: boolean;
  /** Global notification switch (default true; the Mac app's system notifications). */
  notificationsEnabled: boolean;
  /** The user's own instructions for every agent ("" = none). */
  instructions: string;
  hidden: boolean;
  /** Tailscale login the username is bound to (the first one that used it); null = not bound. */
  tailscaleLogin: string | null;
}

export interface MemoryRow {
  id: string;
  user: string;
  text: string;
  source: "claude" | "user";
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  user: string;
  kind: SessionKind;
  title: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  status: SessionStatus;
  claudeSessionId: string | null;
  claudeHistory: string[];
  createdAt: string;
  lastActiveAt: string;
  lastSeq: number;
  costUsd: number;
  turnCount: number;
  usageCumulative: string | null;
  /** JSON of the protocol ContextUsage after the last turn (null before the first). */
  contextUsage: string | null;
  /** JSON of the protocol NextStep (the agent's end-of-turn box; null when none). */
  nextStep: string | null;
  /** Incognito chat: never listed, searched or summarized; purged on delete and at hub start. */
  incognito: boolean;
  hidden: boolean;
  /** A subagent's session (Agent Workstation's run_subagents): the session that started it. Never listed, searched or summarized. */
  parentSessionId: string | null;
  /** Uuids of the pinned messages, in pin order (at most MAX_PINS). */
  pinnedMessages: string[];
  /** This session's notification switch (default true). */
  notify: boolean;
  /** The next process resumes from this session id as a fork, at `resumeAt` (set by rewind / fork). */
  resumeFrom: string | null;
  /** The message uuid the next process resumes at (`resumeSessionAt`, with `forkSession: true`). */
  resumeAt: string | null;
}

/** Pins kept per session (the oldest go first). */
export const MAX_PINS = 200;

export interface MessageRow {
  sessionId: string;
  seq: number;
  uuid: string;
  kind: StoredMessageKind;
  /** Raw JSON text of the SDK message. */
  payload: string;
  at: string;
  delivery: "pending" | "sent" | "cancelled" | null;
}

export interface RuleRow {
  id: number;
  user: string;
  sessionId: string | null;
  toolName: string;
  ruleContent: string | null;
  createdAt: string;
}

/** A website the user always allows the server browser on (protocol BrowserSiteGrant). */
export interface SiteGrantRow {
  origin: string;
  grantedAt: string;
  lastUsedAt: string | null;
}

/** A heads-up the user marked "Knew this already" (protocol KnownHeadsUp). */
export interface KnownHeadsUpRow {
  id: string;
  text: string;
  at: string;
}

export interface TurnInsert {
  /** "" for runs that belong to no session (relevant search). */
  sessionId: string;
  user: string;
  /** Session kind, or "search" for a relevant-search run. */
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  durationMs: number;
  at: string;
  /** null/absent = a session turn. */
  purpose?: string | null;
  /** Effort the turn ran with, when known. */
  effort?: string | null;
}

export interface SummaryRow {
  sessionId: string;
  user: string;
  summary: string;
  model: string;
  messageSeq: number;
  updatedAt: string;
}

/** One search_docs row. */
export interface SearchDocRow {
  sessionId: string;
  seq: number;
  role: "title" | "user" | "assistant";
  at: string;
  text: string;
}

export interface UploadRow {
  id: string;
  user: string;
  path: string;
  chunkTotal: number;
  totalBytes: number;
  received: number[];
  finalPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalRow {
  id: string;
  user: string;
  cwd: string;
  createdAt: string;
  tmuxSession: string;
}

export interface ProjectRow {
  id: string;
  user: string;
  name: string;
  createdAt: string;
  origin: string | null;
  /** gitignore patterns of the paths the person unchecked on the Mac (PUT /api/projects/:id/excludes). */
  excludes: string[];
}

export interface SessionTouchRow {
  path: string;
  projectName: string | null;
  projectId: string | null;
  turn: number;
  tool: string;
  at: string;
}

export interface TouchRow {
  path: string;
  sessionId: string;
  turn: number;
  tool: string;
  at: string;
}

export interface UsageAggRow {
  bucket: string;
  user: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  turns: number;
}

interface RawUser {
  name: string;
  created_at: string;
  enabled: number;
  terminal_enabled: number;
  weekly_limit_custom: number;
  weekly_token_limit: number | null;
  model_allowlist: string | null;
  default_model: string | null;
  default_effort: string | null;
  memory_enabled: number | null;
  notifications_enabled?: number | null;
  instructions: string | null;
  hidden: number;
  tailscale_login?: string | null;
}

interface RawMemory {
  id: string;
  user: string;
  text: string;
  source: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

const toMemory = (r: RawMemory): MemoryRow => ({ id: r.id, user: r.user, text: r.text, source: r.source === "user" ? "user" : "claude", sessionId: r.session_id, createdAt: r.created_at, updatedAt: r.updated_at });

interface RawSession {
  id: string;
  user: string;
  kind: string;
  title: string;
  cwd: string;
  model: string;
  permission_mode: string;
  effort: string | null;
  status: string;
  claude_session_id: string | null;
  claude_history: string | null;
  created_at: string;
  last_active_at: string;
  last_seq: number;
  cost_usd: number;
  turn_count: number;
  usage_cumulative: string | null;
  context_usage: string | null;
  next_step: string | null;
  incognito: number | null;
  hidden: number;
  parent_session_id: string | null;
  pinned_messages?: string | null;
  notify?: number | null;
  resume_from?: string | null;
  resume_at?: string | null;
}

function parsePins(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface RawMessage {
  session_id: string;
  seq: number;
  uuid: string;
  kind: string;
  payload: string;
  at: string;
  delivery: string | null;
}

interface RawProject {
  id: string;
  user: string;
  name: string;
  created_at: string;
  origin: string | null;
  excludes: string | null;
}

const parseExcludes = (v: string | null): string[] => {
  try {
    const a: unknown = v ? JSON.parse(v) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const toProject = (r: RawProject): ProjectRow => ({ id: r.id, user: r.user, name: r.name, createdAt: r.created_at, origin: r.origin, excludes: parseExcludes(r.excludes) });

const toUser = (r: RawUser): UserRow => ({
  name: r.name,
  createdAt: r.created_at,
  enabled: r.enabled === 1,
  terminalEnabled: r.terminal_enabled === 1,
  weeklyLimitCustom: r.weekly_limit_custom === 1,
  weeklyTokenLimit: r.weekly_token_limit,
  modelAllowlist: r.model_allowlist ? (JSON.parse(r.model_allowlist) as string[]) : null,
  defaultModel: r.default_model ?? null,
  defaultEffort: r.default_effort ?? null,
  memoryEnabled: r.memory_enabled !== 0,
  notificationsEnabled: r.notifications_enabled !== 0,
  instructions: r.instructions ?? "",
  hidden: r.hidden === 1,
  tailscaleLogin: r.tailscale_login ?? null,
});

const toSession = (r: RawSession): SessionRow => ({
  id: r.id,
  user: r.user,
  kind: r.kind as SessionKind,
  title: r.title,
  cwd: r.cwd,
  model: r.model,
  permissionMode: r.permission_mode as PermissionMode,
  effort: (r.effort as EffortLevel | null) ?? null,
  status: r.status as SessionStatus,
  claudeSessionId: r.claude_session_id,
  claudeHistory: r.claude_history ? (JSON.parse(r.claude_history) as string[]) : [],
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
  lastSeq: r.last_seq,
  costUsd: r.cost_usd,
  turnCount: r.turn_count,
  usageCumulative: r.usage_cumulative,
  contextUsage: r.context_usage ?? null,
  nextStep: r.next_step ?? null,
  incognito: r.incognito === 1,
  hidden: r.hidden === 1,
  parentSessionId: r.parent_session_id ?? null,
  pinnedMessages: parsePins(r.pinned_messages),
  notify: r.notify !== 0,
  resumeFrom: r.resume_from ?? null,
  resumeAt: r.resume_at ?? null,
});

const toMessage = (r: RawMessage): MessageRow => ({
  sessionId: r.session_id,
  seq: r.seq,
  uuid: r.uuid,
  kind: r.kind as StoredMessageKind,
  payload: r.payload,
  at: r.at,
  delivery: (r.delivery as MessageRow["delivery"]) ?? null,
});

/** Serializes a message row as protocol StoredMessage JSON without re-parsing the payload. */
export function storedMessageJson(m: MessageRow): string {
  return `{"seq":${m.seq},"sessionId":${JSON.stringify(m.sessionId)},"uuid":${JSON.stringify(m.uuid)},"kind":${JSON.stringify(m.kind)},"payload":${m.payload},"at":${JSON.stringify(m.at)}}`;
}

function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, "schema.sql");
  if (existsSync(p)) return p;
  // dist/ without copied assets: fall back to the source tree.
  return join(here, "../../src/db/schema.sql");
}

export type SessionPatch = Partial<
  Pick<
    SessionRow,
    | "title"
    | "model"
    | "permissionMode"
    | "effort"
    | "status"
    | "claudeSessionId"
    | "claudeHistory"
    | "lastActiveAt"
    | "usageCumulative"
    | "contextUsage"
    | "nextStep"
    | "cwd"
    | "pinnedMessages"
    | "notify"
    | "resumeFrom"
    | "resumeAt"
  >
>;

/** One metered API request (api_requests). */
export interface ApiRequestRow {
  id: number;
  at: string;
  /** The proxy token's owner; null for the hub's own requests (the docs assistant and the Haiku helpers). */
  sessionId: string | null;
  user: string;
  /** null = a session's request through the key proxy; else the hub's own request ("readme", "summary", "search", "download", "pricing"). */
  purpose: string | null;
  model: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  webSearchRequests: number;
  speed: string | null;
  costUsd: number;
  /** false = the stream ended early (client disconnected, upstream failed): billed for what was seen. */
  complete: boolean;
}

/** A hub-owned price period (pricing_overrides). Claude periods carry explicit cache prices. */
export interface PricingOverrideRow {
  model: string;
  from: string;
  input: number;
  output: number;
  cacheReadFactor: number;
  cacheRead?: number | null;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  fastFactor?: number | null;
  longPrompt?: LongPromptTier | null;
  source: string;
  checkId: number | null;
  createdAt: string;
}

/** One run of the price check (pricing_checks). */
export interface PricingCheckRow {
  id: number;
  at: string;
  trigger: "schedule" | "admin";
  outcome: "updated" | "unchanged" | "rejected" | "failed";
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  effectiveFrom: string | null;
  previousInput: number | null;
  previousOutput: number | null;
  message: string | null;
  response: string | null;
}

/** Bump to rebuild the search index from the messages at the next start (text extraction changed). */
export const SEARCH_INDEX_VERSION = 1;

export class Store {
  readonly db: Db;
  private readonly s: Record<string, Stmt> = {};
  /** FTS5 trigram index over search_docs available (else search falls back to LIKE). */
  readonly fts: boolean;
  /** Per-user counter bumped when what relevant search ranks changes (sessions created/renamed/deleted, summaries). */
  private readonly searchVersions = new Map<string, number>();
  /** List-price estimates for turns whose SDK reported no cost. */
  private pricing: Pick<Pricing, "cost"> | null = null;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(readFileSync(schemaPath(), "utf8"));
    this.migrate();
    this.fts = this.setupFts();
    this.prepare();
  }

  /**
   * The FTS5 index of search_docs with the trigram tokenizer (substring and CJK matching; diacritics folded where
   * the bundled SQLite supports it). Kept in sync by triggers. false = FTS5/trigram unavailable (LIKE fallback).
   */
  private setupFts(): boolean {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'").get();
    if (!exists) {
      const create = (tokenize: string) => this.db.exec(`CREATE VIRTUAL TABLE search_fts USING fts5(text, content='search_docs', content_rowid='id', tokenize='${tokenize}')`);
      try {
        create("trigram remove_diacritics 1");
      } catch {
        try {
          create("trigram");
        } catch {
          return false;
        }
      }
      // Existing rows (a database from before FTS) go in once; the triggers keep it current from here on.
      this.db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
        INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
        INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
        INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
      END;`);
    return true;
  }

  /** Additive column migrations for databases created by earlier builds. */
  private migrate(): void {
    const addColumn = (table: string, column: string, decl: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    };
    addColumn("terminals", "exited_at", "TEXT");
    addColumn("projects", "excludes", "TEXT");
    addColumn("file_touches", "project_id", "TEXT");
    addColumn("users", "default_model", "TEXT");
    addColumn("users", "default_effort", "TEXT");
    addColumn("users", "memory_enabled", "INTEGER");
    addColumn("users", "notifications_enabled", "INTEGER");
    addColumn("sessions", "notify", "INTEGER");
    addColumn("sessions", "context_usage", "TEXT");
    addColumn("sessions", "next_step", "TEXT");
    addColumn("sessions", "incognito", "INTEGER NOT NULL DEFAULT 0");
    addColumn("users", "instructions", "TEXT NOT NULL DEFAULT ''");
    addColumn("turns", "purpose", "TEXT");
    addColumn("turns", "effort", "TEXT");
    addColumn("users", "tailscale_login", "TEXT");
    addColumn("users", "tailscale_bound_at", "TEXT");
    addColumn("sessions", "parent_session_id", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL");
    addColumn("sessions", "pinned_messages", "TEXT");
    addColumn("sessions", "resume_from", "TEXT");
    addColumn("sessions", "resume_at", "TEXT");
    addColumn("messages", "rewound", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "turn", "INTEGER");
    addColumn("pricing_overrides", "cache_read_per_mtok", "REAL");
    addColumn("pricing_overrides", "cache_write_5m_factor", "REAL");
    addColumn("pricing_overrides", "cache_write_1h_factor", "REAL");
    addColumn("pricing_overrides", "fast_factor", "REAL");
    addColumn("pricing_overrides", "long_prompt", "TEXT");
    this.migrateApiRequests();
    // Large files are pointers in each project's review git now (sync-core); the separate records are gone.
    this.db.exec("DROP TABLE IF EXISTS large_files");
    this.db.exec("CREATE INDEX IF NOT EXISTS file_touches_project_path ON file_touches (project_id, path, id DESC)");
  }

  /**
   * api_requests from before the hub's own API calls: session_id was NOT NULL and there was no purpose. SQLite cannot
   * relax a constraint in place, so the table is rebuilt once (rows and ids kept) in one transaction.
   */
  private migrateApiRequests(): void {
    const cols = this.db.prepare("PRAGMA table_info(api_requests)").all() as { name: string; notnull: number }[];
    const sessionCol = cols.find((c) => c.name === "session_id");
    const hasPurpose = cols.some((c) => c.name === "purpose");
    if (sessionCol?.notnull !== 1 && hasPurpose) return;
    const columns = "id, at, session_id, user, model, input, cache_write_5m, cache_write_1h, cache_read, output, web_search_requests, speed, cost_usd, complete";
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE api_requests_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          at                  TEXT NOT NULL,
          session_id          TEXT,
          user                TEXT NOT NULL,
          purpose             TEXT,
          model               TEXT NOT NULL,
          input               INTEGER NOT NULL,
          cache_write_5m      INTEGER NOT NULL,
          cache_write_1h      INTEGER NOT NULL,
          cache_read          INTEGER NOT NULL,
          output              INTEGER NOT NULL,
          web_search_requests INTEGER NOT NULL,
          speed               TEXT,
          cost_usd            REAL NOT NULL,
          complete            INTEGER NOT NULL
        );
        INSERT INTO api_requests_new (${columns}${hasPurpose ? ", purpose" : ""}) SELECT ${columns}${hasPurpose ? ", purpose" : ""} FROM api_requests;
        DROP TABLE api_requests;
        ALTER TABLE api_requests_new RENAME TO api_requests;
        CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests (at);
        CREATE INDEX IF NOT EXISTS api_requests_user_at ON api_requests (user, at);`);
    })();
  }

  private prepare(): void {
    const p =(k: string, sql: string) => (this.s[k] = this.db.prepare(sql));
    // users
    p("getUser", "SELECT * FROM users WHERE name = ?");
    p("listUsers", "SELECT * FROM users WHERE hidden = 0 OR ? = 1 ORDER BY name");
    p("insertUser", "INSERT OR IGNORE INTO users (name, created_at, hidden, terminal_enabled) VALUES (?, ?, ?, ?)");
    p("bindTailscaleLogin", "UPDATE users SET tailscale_login = ?, tailscale_bound_at = ? WHERE name = ? AND tailscale_login IS NULL");
    // Enabled, visible usernames bound to a login, most recently active first (latest session activity, else bind time, else creation).
    p(
      "listUsersByLogin",
      `SELECT name FROM users WHERE tailscale_login = ? AND enabled = 1 AND hidden = 0
       ORDER BY COALESCE((SELECT MAX(last_active_at) FROM sessions WHERE sessions.user = users.name), tailscale_bound_at, created_at) DESC, name`,
    );
    // sessions
    p("getSession", "SELECT * FROM sessions WHERE id = ?");
    // Incognito and subagent sessions are never listed (they stay reachable by id for their creator).
    p("listSessions", "SELECT * FROM sessions WHERE user = ? AND hidden = 0 AND incognito = 0 AND parent_session_id IS NULL AND (? IS NULL OR kind = ?) ORDER BY last_active_at DESC");
    p("listAllSessions", "SELECT * FROM sessions WHERE hidden = 0 AND incognito = 0 AND parent_session_id IS NULL ORDER BY last_active_at DESC LIMIT ?");
    p("countSessions", "SELECT user, COUNT(*) AS n FROM sessions WHERE hidden = 0 AND incognito = 0 AND parent_session_id IS NULL GROUP BY user");
    p("listIncognito", "SELECT * FROM sessions WHERE incognito = 1");
    p("childSessionIds", "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at");
    p("countSessionsWithCwd", "SELECT COUNT(*) AS n FROM sessions WHERE user = ? AND cwd = ?");
    p(
      "insertSession",
      `INSERT INTO sessions (id, user, kind, title, cwd, model, permission_mode, effort, status, claude_session_id, created_at, last_active_at, hidden, incognito, resume_from, resume_at, parent_session_id)
       VALUES (@id, @user, @kind, @title, @cwd, @model, @permissionMode, @effort, 'idle', @claudeSessionId, @createdAt, @createdAt, @hidden, @incognito, @resumeFrom, @resumeAt, @parentSessionId)`,
    );
    p("deleteSession", "DELETE FROM sessions WHERE id = ?");
    p("nextSeq", "UPDATE sessions SET last_seq = last_seq + 1, last_active_at = ? WHERE id = ? RETURNING last_seq, user, hidden, incognito, parent_session_id");
    p("addCost", "UPDATE sessions SET cost_usd = cost_usd + ?, turn_count = turn_count + 1, usage_cumulative = ? WHERE id = ?");
    p("resetStatuses", "UPDATE sessions SET status = 'idle' WHERE status <> 'idle'");
    p("claudeIdsForUser", "SELECT claude_session_id, claude_history FROM sessions WHERE user = ?");
    // messages
    p("insertMessage", "INSERT OR IGNORE INTO messages (session_id, seq, uuid, kind, payload, at, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)");
    p("getMessageByUuid", "SELECT * FROM messages WHERE session_id = ? AND uuid = ?");
    p("getVisibleMessage", "SELECT * FROM messages WHERE session_id = ? AND uuid = ? AND rewound = 0");
    p("hasMessage", "SELECT 1 FROM messages WHERE session_id = ? AND uuid = ?");
    // Rewound messages are kept but never listed (transcript, replay, search, history tools, summaries).
    p("listMessages", "SELECT * FROM messages WHERE session_id = ? AND seq > ? AND rewound = 0 ORDER BY seq LIMIT ?");
    p("messageUuids", "SELECT uuid FROM messages WHERE session_id = ?");
    p("rewindMessages", "UPDATE messages SET rewound = 1 WHERE session_id = ? AND seq >= ? AND rewound = 0");
    // Gaps and islands: within a run of equal `rewound` values, seq rank minus rank-within-value is constant.
    p(
      "rewoundRanges",
      `SELECT MIN(seq) AS a, MAX(seq) AS b FROM (
         SELECT seq, rewound, ROW_NUMBER() OVER (ORDER BY seq) - ROW_NUMBER() OVER (PARTITION BY rewound ORDER BY seq) AS grp
         FROM messages WHERE session_id = ?
       ) WHERE rewound = 1 GROUP BY grp ORDER BY a DESC LIMIT ?`,
    );
    p("deleteDocsFrom","DELETE FROM search_docs WHERE session_id = ? AND seq >= ? AND seq > 0");
    p("setMessageTurn", "UPDATE messages SET turn = ? WHERE session_id = ? AND uuid = ?");
    p("getMessageTurn", "SELECT turn FROM messages WHERE session_id = ? AND uuid = ?");
    p("resultsBefore", "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND seq < ? AND kind = 'result'");
    p("setDelivery", "UPDATE messages SET delivery = ? WHERE session_id = ? AND uuid = ?");
    p("pendingDeliveries", "SELECT * FROM messages WHERE delivery = 'pending' ORDER BY session_id, seq");
    // rules
    p("insertRule", "INSERT INTO permissions_rules (user, session_id, tool_name, rule_content, created_at) VALUES (?, ?, ?, ?, ?)");
    p("rulesFor", "SELECT * FROM permissions_rules WHERE user = ? AND tool_name = ? AND (session_id IS NULL OR session_id = ?)");
    p("deleteSessionRules", "DELETE FROM permissions_rules WHERE session_id = ?");
    // browser site grants
    p("insertSiteGrant", "INSERT INTO browser_site_grants (user, origin, granted_at, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT (user, origin) DO UPDATE SET last_used_at = excluded.last_used_at");
    p("getSiteGrant", "SELECT 1 FROM browser_site_grants WHERE user = ? AND origin = ?");
    p("touchSiteGrant", "UPDATE browser_site_grants SET last_used_at = ? WHERE user = ? AND origin = ?");
    p("listSiteGrants", "SELECT * FROM browser_site_grants WHERE user = ? ORDER BY COALESCE(last_used_at, granted_at) DESC, origin");
    p("deleteSiteGrant", "DELETE FROM browser_site_grants WHERE user = ? AND origin = ?");
    // known heads-ups (rowid breaks ties between entries stored in the same millisecond)
    p("listKnownHeadsUps", "SELECT id, text, at FROM known_heads_ups WHERE user = ? ORDER BY at DESC, rowid DESC");
    p("findKnownHeadsUp", "SELECT id, text, at FROM known_heads_ups WHERE user = ? AND text = ? COLLATE NOCASE");
    p("insertKnownHeadsUp", "INSERT INTO known_heads_ups (id, user, text, at) VALUES (?, ?, ?, ?)");
    p(
      "trimKnownHeadsUps",
      "DELETE FROM known_heads_ups WHERE user = ? AND id NOT IN (SELECT id FROM known_heads_ups WHERE user = ? ORDER BY at DESC, rowid DESC LIMIT ?)",
    );
    p("deleteKnownHeadsUp", "DELETE FROM known_heads_ups WHERE user = ? AND id = ?");
    // turns
    p(
      "insertTurn",
      `INSERT INTO turns (session_id, user, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, duration_ms, at, purpose, effort)
       VALUES (@sessionId, @user, @kind, @model, @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreateTokens, @costUsd, @durationMs, @at, @purpose, @effort)`,
    );
    // API spend: the metered requests.
    p("apiRequestSpend", "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM api_requests WHERE at >= ? AND at < ?");
    p("apiRequestSpendByUser", "SELECT user, COALESCE(SUM(cost_usd), 0) AS cost FROM api_requests WHERE at >= ? AND at < ? GROUP BY user");
    p(
      "insertApiRequest",
      `INSERT INTO api_requests (at, session_id, user, purpose, model, input, cache_write_5m, cache_write_1h, cache_read, output, web_search_requests, speed, cost_usd, complete)
       VALUES (@at, @sessionId, @user, @purpose, @model, @input, @cacheWrite5m, @cacheWrite1h, @cacheRead, @output, @webSearchRequests, @speed, @costUsd, @complete)`,
    );
    p("tokensSince", "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM turns WHERE user = ? AND at >= ?");
    p("tokensSinceAll", "SELECT user, COALESCE(SUM(input_tokens + output_tokens), 0) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM turns WHERE at >= ? GROUP BY user");
    p(
      "usageByHour",
      `SELECT substr(at, 1, 13) AS bucket, user, model,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_create_tokens) AS cacheCreateTokens,
              SUM(cost_usd) AS costUsd, COUNT(*) AS turns
       FROM turns WHERE at >= ? AND (? IS NULL OR user = ?)
       GROUP BY bucket, user, model ORDER BY bucket`,
    );
    // uploads
    p("getUpload", "SELECT * FROM uploads WHERE user = ? AND id = ?");
    p(
      "insertUpload",
      "INSERT INTO uploads (id, user, path, chunk_total, total_bytes, received, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
    );
    p("setUploadReceived", "UPDATE uploads SET received = ?, updated_at = ? WHERE user = ? AND id = ?");
    p("completeUpload", "UPDATE uploads SET final_path = ?, updated_at = ? WHERE user = ? AND id = ?");
    // file touches
    p("insertTouch", "INSERT INTO file_touches (session_id, user, path, tool, turn, at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // Bare-column MAX(id): SQLite returns the other columns from the row holding the max.
    p(
      "lastTouches",
      "SELECT path, session_id AS sessionId, turn, tool, at, MAX(id) AS id FROM file_touches WHERE project_id = ? GROUP BY path",
    );
    // Newest touch per (project, path) of one session. A project touch's path is project-relative (workspace path = projects/<name>/<path>).
    p(
      "sessionTouches",
      `SELECT t.path, p.name AS projectName, t.project_id AS projectId, t.tool, t.turn, t.at FROM file_touches t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.session_id = ? AND t.id IN (SELECT MAX(id) FROM file_touches WHERE session_id = ? GROUP BY project_id, path)
       ORDER BY t.at DESC, t.id DESC LIMIT ?`,
    );
    p("deleteProjectTouches", "DELETE FROM file_touches WHERE project_id = ?");
    // terminals
    p("insertTerminal", "INSERT INTO terminals (id, user, cwd, created_at, tmux_session) VALUES (?, ?, ?, ?, ?)");
    p("listTerminals", "SELECT * FROM terminals WHERE user = ? AND exited_at IS NULL ORDER BY created_at");
    p("listLiveTerminals", "SELECT * FROM terminals WHERE exited_at IS NULL");
    p("markTerminalExited", "UPDATE terminals SET exited_at = ? WHERE id = ? AND exited_at IS NULL");
    p("getTerminal", "SELECT * FROM terminals WHERE id = ?");
    p("deleteTerminal", "DELETE FROM terminals WHERE id = ?");
    // memories
    p("listMemories", "SELECT * FROM memories WHERE user = ? ORDER BY created_at DESC, rowid DESC");
    p("getMemory", "SELECT * FROM memories WHERE user = ? AND id = ?");
    p("insertMemory", "INSERT INTO memories (id, user, text, source, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    p("updateMemory", "UPDATE memories SET text = ?, updated_at = ? WHERE user = ? AND id = ?");
    p("deleteMemory", "DELETE FROM memories WHERE user = ? AND id = ?");
    // kv
    // search index + summaries
    p("insertDoc", "INSERT OR IGNORE INTO search_docs (session_id, user, seq, role, at, text) VALUES (?, ?, ?, ?, ?, ?)");
    p("updateTitleDoc", "UPDATE search_docs SET text = ? WHERE session_id = ? AND seq = 0");
    p("deleteDocs", "DELETE FROM search_docs WHERE session_id = ?");
    p("sessionDocs", "SELECT session_id AS sessionId, seq, role, at, text FROM search_docs WHERE session_id = ? ORDER BY seq");
    p("firstUserDoc", "SELECT text FROM search_docs WHERE session_id = ? AND role = 'user' ORDER BY seq LIMIT 1");
    p("getSummary", "SELECT * FROM session_summaries WHERE session_id = ?");
    p(
      "upsertSummary",
      `INSERT INTO session_summaries (session_id, user, summary, model, message_seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, model = excluded.model, message_seq = excluded.message_seq, updated_at = excluded.updated_at`,
    );
    p("deleteSummary", "DELETE FROM session_summaries WHERE session_id = ?");
    p("kvGet", "SELECT value FROM kv WHERE key = ?");
    p("kvSet", "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    // projects
    p("listProjects", "SELECT * FROM projects WHERE user = ? ORDER BY name");
    p("listAllProjects", "SELECT * FROM projects ORDER BY user, name");
    p("getProject", "SELECT * FROM projects WHERE id = ?");
    p("getProjectByName", "SELECT * FROM projects WHERE user = ? AND name = ?");
    p("insertProject", "INSERT INTO projects (id, user, name, created_at, origin) VALUES (?, ?, ?, ?, ?)");
    p("deleteProject", "DELETE FROM projects WHERE id = ?");
    p("setProjectExcludes", "UPDATE projects SET excludes = ? WHERE id = ?");
  }

  private st(k: string): Stmt {
    const stmt = this.s[k];
    if (!stmt) throw new Error(`no statement ${k}`);
    return stmt;
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- users
  getUser(name: string): UserRow | null {
    const r = this.st("getUser").get(name) as RawUser | undefined;
    return r ? toUser(r) : null;
  }

  /** The user's instructions for every agent (`User.instructions`), "" when none. */
  userInstructions(name: string): string {
    return this.getUser(name)?.instructions ?? "";
  }

  listUsers(includeHidden = false): UserRow[] {
    return (this.st("listUsers").all(includeHidden ? 1 : 0) as RawUser[]).map(toUser);
  }

  /** Inserts the user if missing. Returns true when a row was created. */
  ensureUser(name: string, hidden = false, at = iso(), terminalEnabled = false): boolean {
    return this.st("insertUser").run(name, at, hidden ? 1 : 0, terminalEnabled ? 1 : 0).changes > 0;
  }

  /**
   * Binds the user to a Tailscale login unless it is already bound (first login wins, atomically).
   * Returns the login the user is bound to afterwards (null when the user does not exist).
   */
  bindTailscaleLogin(name: string, login: string, at = iso()): string | null {
    this.st("bindTailscaleLogin").run(login, at, name);
    return this.getUser(name)?.tailscaleLogin ?? null;
  }

  /** Usernames bound to a Tailscale login (enabled, not internal), most recently active first. */
  usernamesForLogin(login: string): string[] {
    return this.st("listUsersByLogin").pluck().all(login) as string[];
  }

  updateUser(
    name: string,
    patch: {
      enabled?: boolean;
      terminalEnabled?: boolean;
      weeklyTokenLimit?: number | null;
      modelAllowlist?: string[] | null;
      defaultModel?: string | null;
      defaultEffort?: string | null;
      memoryEnabled?: boolean;
      notificationsEnabled?: boolean;
      instructions?: string;
    },
  ): UserRow | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      args.push(patch.enabled ? 1 : 0);
    }
    if (patch.terminalEnabled !== undefined) {
      sets.push("terminal_enabled = ?");
      args.push(patch.terminalEnabled ? 1 : 0);
    }
    if (patch.weeklyTokenLimit !== undefined) {
      sets.push("weekly_limit_custom = 1", "weekly_token_limit = ?");
      args.push(patch.weeklyTokenLimit);
    }
    if (patch.modelAllowlist !== undefined) {
      sets.push("model_allowlist = ?");
      args.push(patch.modelAllowlist === null ? null : JSON.stringify(patch.modelAllowlist));
    }
    if (patch.defaultModel !== undefined) {
      sets.push("default_model = ?");
      args.push(patch.defaultModel);
    }
    if (patch.defaultEffort !== undefined) {
      sets.push("default_effort = ?");
      args.push(patch.defaultEffort);
    }
    if (patch.memoryEnabled !== undefined) {
      sets.push("memory_enabled = ?");
      args.push(patch.memoryEnabled ? 1 : 0);
    }
    if (patch.notificationsEnabled !== undefined) {
      sets.push("notifications_enabled = ?");
      args.push(patch.notificationsEnabled ? 1 : 0);
    }
    if (patch.instructions !== undefined) {
      sets.push("instructions = ?");
      args.push(patch.instructions);
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE name = ?`).run(...args, name);
    return this.getUser(name);
  }

  // ------------------------------------------------------------- sessions
  insertSession(row: {
    id: string;
    user: string;
    kind: SessionKind;
    title: string;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    effort: EffortLevel | null;
    claudeSessionId?: string | null;
    createdAt?: string;
    hidden?: boolean;
    incognito?: boolean;
    parentSessionId?: string | null;
    /** Fork: the Claude session to fork from and the message uuid to resume at. */
    resumeFrom?: string | null;
    resumeAt?: string | null;
  }): SessionRow {
    const createdAt = row.createdAt ?? iso();
    this.transaction(() => {
      this.st("insertSession").run({
        ...row,
        resumeFrom: row.resumeFrom ?? null,
        resumeAt: row.resumeAt ?? null,
        incognito: row.incognito ? 1 : 0,
        claudeSessionId: row.claudeSessionId ?? null,
        createdAt,
        hidden: row.hidden ? 1 : 0,
        parentSessionId: row.parentSessionId ?? null,
      });
      if (!row.hidden && !row.incognito && !row.parentSessionId) {
        this.st("insertDoc").run(row.id, row.user, 0, "title", createdAt, row.title);
        this.bumpSearch(row.user);
      }
    });
    return this.getSession(row.id)!;
  }

  getSession(id: string): SessionRow | null {
    const r = this.st("getSession").get(id) as RawSession | undefined;
    return r ? toSession(r) : null;
  }

  listSessions(user: string, kind?: SessionKind): SessionRow[] {
    const k = kind ?? null;
    return (this.st("listSessions").all(user, k, k) as RawSession[]).map(toSession);
  }

  listAllSessions(limit = 500): SessionRow[] {
    return (this.st("listAllSessions").all(limit) as RawSession[]).map(toSession);
  }

  sessionCounts(): Map<string, number> {
    const rows = this.st("countSessions").all() as { user: string; n: number }[];
    return new Map(rows.map((r) => [r.user, r.n]));
  }

  updateSession(id: string, patch: SessionPatch): SessionRow | null {
    const cols: Record<keyof SessionPatch, string> = {
      title: "title",
      model: "model",
      permissionMode: "permission_mode",
      effort: "effort",
      status: "status",
      claudeSessionId: "claude_session_id",
      claudeHistory: "claude_history",
      lastActiveAt: "last_active_at",
      usageCumulative: "usage_cumulative",
      contextUsage: "context_usage",
      nextStep: "next_step",
      cwd: "cwd",
      pinnedMessages: "pinned_messages",
      notify: "notify",
      resumeFrom: "resume_from",
      resumeAt: "resume_at",
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof SessionPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      if (k === "claudeHistory") args.push(JSON.stringify(v));
      else if (k === "pinnedMessages") args.push((v as string[]).length ? JSON.stringify(v) : null);
      else if (k === "notify") args.push(v ? 1 : 0);
      else args.push(v);
    }
    if (sets.length) this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    const row = this.getSession(id);
    if (row && patch.title !== undefined && !row.hidden && !row.incognito && !row.parentSessionId) {
      if (this.st("updateTitleDoc").run(row.title, id).changes === 0) this.st("insertDoc").run(id, row.user, 0, "title", row.createdAt, row.title);
      this.bumpSearch(row.user);
    }
    return row;
  }

  /** Removes the session row with its messages (cascade), session rules, search docs and summary. Turns stay. */
  deleteSession(id: string): void {
    const user = this.getSession(id)?.user;
    this.transaction(() => {
      this.st("deleteSessionRules").run(id);
      this.st("deleteDocs").run(id);
      this.st("deleteSummary").run(id);
      this.st("deleteSession").run(id);
    });
    if (user) this.bumpSearch(user);
  }

  /** Subagent sessions started by `parentId` (oldest first). */
  childSessionIds(parentId: string): string[] {
    return (this.st("childSessionIds").all(parentId) as { id: string }[]).map((r) => r.id);
  }

  /** How many of `user`'s sessions work in `cwd` (a chat folder is shared by the chat, its forks and subagents). */
  countSessionsWithCwd(user: string, cwd: string): number {
    return (this.st("countSessionsWithCwd").get(user, cwd) as { n: number }).n;
  }

  /** Incognito sessions (startup purge). */
  listIncognitoSessions(): SessionRow[] {
    return (this.st("listIncognito").all() as RawSession[]).map(toSession);
  }

  /** Startup: no process survives a hub restart, so every session is idle. */
  resetAllStatuses(): number {
    return this.st("resetStatuses").run().changes;
  }

  addTurnCost(sessionId: string, costUsd: number, usageCumulative: string): void {
    this.st("addCost").run(costUsd, usageCumulative, sessionId);
  }

  /** Every session id of a user, hidden ones included (user deletion). */
  sessionIdsForUser(user: string): string[] {
    return this.db.prepare("SELECT id FROM sessions WHERE user = ?").pluck().all(user) as string[];
  }

  /**
   * Admin user deletion: removes every row that belongs to `name` (sessions and their
   * messages, usage rows, rules, touches, uploads, terminals, projects, the user).
   */
  deleteUserData(name: string): void {
    this.transaction(() => {
      for (const sql of [
        "DELETE FROM permissions_rules WHERE user = ?",
        "DELETE FROM browser_site_grants WHERE user = ?",
        "DELETE FROM known_heads_ups WHERE user = ?",
        "DELETE FROM turns WHERE user = ?",
        "DELETE FROM file_touches WHERE user = ?",
        "DELETE FROM uploads WHERE user = ?",
        "DELETE FROM terminals WHERE user = ?",
        "DELETE FROM memories WHERE user = ?",
        "DELETE FROM search_docs WHERE user = ?",
        "DELETE FROM session_summaries WHERE user = ?",
        "DELETE FROM projects WHERE user = ?",
        "DELETE FROM sessions WHERE user = ?",
        "DELETE FROM users WHERE name = ?",
      ]) {
        this.db.prepare(sql).run(name);
      }
    });
  }

  claudeSessionIdsForUser(user: string): string[] {
    const rows = this.st("claudeIdsForUser").all(user) as { claude_session_id: string | null; claude_history: string | null }[];
    const out: string[] = [];
    for (const r of rows) {
      if (r.claude_session_id) out.push(r.claude_session_id);
      if (r.claude_history) out.push(...(JSON.parse(r.claude_history) as string[]));
    }
    return out;
  }

  // ------------------------------------------------------------- messages
  /**
   * Appends a message with the next seq. Returns null (and does not consume a
   * seq) when a message with the same uuid already exists in the session.
   */
  appendMessage(
    sessionId: string,
    m: { uuid: string; kind: StoredMessageKind; payload: unknown; delivery?: MessageRow["delivery"]; at?: string },
  ): MessageRow | null {
    return this.transaction(() => {
      if (this.st("hasMessage").get(sessionId, m.uuid)) return null;
      const at = m.at ?? iso();
      const r = this.st("nextSeq").get(at, sessionId) as { last_seq: number; user: string; hidden: number; incognito: number; parent_session_id: string | null } | undefined;
      if (!r) throw new Error(`session ${sessionId} not found`);
      const payload = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
      this.st("insertMessage").run(sessionId, r.last_seq, m.uuid, m.kind, payload, at, m.delivery ?? null);
      // Search index (never for incognito, hidden or subagent sessions).
      if (!r.hidden && !r.incognito && !r.parent_session_id && (m.kind === "user" || m.kind === "assistant")) {
        const doc = messagePlainText(m.kind, typeof m.payload === "string" ? m.payload : m.payload);
        if (doc) this.st("insertDoc").run(sessionId, r.user, r.last_seq, doc.role, at, doc.text);
      }
      return { sessionId, seq: r.last_seq, uuid: m.uuid, kind: m.kind, payload, at, delivery: m.delivery ?? null };
    });
  }

  getMessageByUuid(sessionId: string, uuid: string): MessageRow | null {
    const r = this.st("getMessageByUuid").get(sessionId, uuid) as RawMessage | undefined;
    return r ? toMessage(r) : null;
  }

  /** The message unless it was rewound (null for unknown and rewound uuids). */
  getVisibleMessage(sessionId: string, uuid: string): MessageRow | null {
    const r = this.st("getVisibleMessage").get(sessionId, uuid) as RawMessage | undefined;
    return r ? toMessage(r) : null;
  }

  hasMessage(sessionId: string, uuid: string): boolean {
    return this.st("hasMessage").get(sessionId, uuid) !== undefined;
  }

  /**
   * Rewind: messages with seq >= fromSeq leave the transcript (marked rewound, never deleted), with their search docs
   * and the session's summary (it described them). Returns how many messages were marked.
   */
  rewindMessages(sessionId: string, fromSeq: number): number {
    const user = this.getSession(sessionId)?.user;
    const n = this.transaction(() => {
      const changed = this.st("rewindMessages").run(sessionId, fromSeq).changes;
      this.st("deleteDocsFrom").run(sessionId, fromSeq);
      this.st("deleteSummary").run(sessionId);
      return changed;
    });
    if (user) this.bumpSearch(user);
    return n;
  }

  /**
   * The inclusive seq ranges of the session's rewound messages, oldest first: each range is a run of rewound messages
   * with no kept message between them (adjacent rewinds merge). At most `limit`, the newest kept.
   */
  rewoundRanges(sessionId: string, limit = 100): [number, number][] {
    const rows = this.st("rewoundRanges").all(sessionId, limit) as { a: number; b: number }[];
    return rows.reverse().map((r) => [r.a, r.b]);
  }

  /** User messages: the session's turn_count when the message was handed to the agent. */
  setMessageTurn(sessionId: string, uuid: string, turn: number): void {
    this.st("setMessageTurn").run(turn, sessionId, uuid);
  }

  /**
   * The session's turn_count when a user message was handed to the agent (= the number of the turn snapshot holding the
   * state before its turn). Messages from before that was recorded: the results before it (rewound ones included).
   */
  messageTurn(sessionId: string, m: Pick<MessageRow, "uuid" | "seq">): number {
    const r = this.st("getMessageTurn").get(sessionId, m.uuid) as { turn: number | null } | undefined;
    if (r && typeof r.turn === "number") return r.turn;
    return (this.st("resultsBefore").get(sessionId, m.seq) as { n: number }).n;
  }

  listMessages(sessionId: string, after: number, limit: number): MessageRow[] {
    return (this.st("listMessages").all(sessionId, after, limit) as RawMessage[]).map(toMessage);
  }

  /** Streams messages after `after` in seq order without materializing them all. */
  *iterateMessages(sessionId: string, after: number): Generator<MessageRow> {
    for (const r of this.st("listMessages").iterate(sessionId, after, -1) as IterableIterator<RawMessage>) yield toMessage(r);
  }

  messageUuids(sessionId: string): Set<string> {
    return new Set((this.st("messageUuids").pluck().all(sessionId) as string[]));
  }

  /** The file_ref attachment paths (relative to the user root) of a session's user messages (`hub.attachments`). */
  attachmentPaths(sessionId: string): string[] {
    const rows = this.db.prepare("SELECT payload FROM messages WHERE session_id = ? AND kind = 'user' AND rewound = 0 AND instr(payload, '\"hub\":') > 0 ORDER BY seq").pluck().all(sessionId) as string[];
    const out = new Set<string>();
    for (const json of rows) {
      try {
        const atts = (JSON.parse(json) as { hub?: { attachments?: unknown } }).hub?.attachments;
        if (!Array.isArray(atts)) continue;
        for (const a of atts) if (a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string") out.add((a as { path: string }).path);
      } catch {
        /* not JSON: skip */
      }
    }
    return [...out];
  }

  setDelivery(sessionId: string, uuid: string, delivery: NonNullable<MessageRow["delivery"]>): void {
    this.st("setDelivery").run(delivery, sessionId, uuid);
  }

  pendingDeliveries(): MessageRow[] {
    return (this.st("pendingDeliveries").all() as RawMessage[]).map(toMessage);
  }

  // ---------------------------------------------------------------- rules
  insertRule(r: { user: string; sessionId: string | null; toolName: string; ruleContent: string | null }): void {
    this.st("insertRule").run(r.user, r.sessionId, r.toolName, r.ruleContent, iso());
  }

  rulesFor(user: string, toolName: string, sessionId: string): RuleRow[] {
    const rows = this.st("rulesFor").all(user, toolName, sessionId) as {
      id: number;
      user: string;
      session_id: string | null;
      tool_name: string;
      rule_content: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({ id: r.id, user: r.user, sessionId: r.session_id, toolName: r.tool_name, ruleContent: r.rule_content, createdAt: r.created_at }));
  }

  // ---------------------------------------------------- browser site grants
  /** Stores "always allow the server browser on `origin`" (granting again keeps the first grant time). */
  insertSiteGrant(user: string, origin: string, at = iso()): void {
    this.st("insertSiteGrant").run(user, origin, at, at);
  }

  hasSiteGrant(user: string, origin: string): boolean {
    return !!this.st("getSiteGrant").get(user, origin);
  }

  touchSiteGrant(user: string, origin: string, at = iso()): void {
    this.st("touchSiteGrant").run(at, user, origin);
  }

  /** Most recently used first (a grant never used counts from when it was granted). */
  listSiteGrants(user: string): SiteGrantRow[] {
    const rows = this.st("listSiteGrants").all(user) as { origin: string; granted_at: string; last_used_at: string | null }[];
    return rows.map((r) => ({ origin: r.origin, grantedAt: r.granted_at, lastUsedAt: r.last_used_at }));
  }

  /** false when there was no such grant. */
  deleteSiteGrant(user: string, origin: string): boolean {
    return this.st("deleteSiteGrant").run(user, origin).changes > 0;
  }

  // ------------------------------------------------------ known heads-ups
  /** Heads-ups the user marked as already known, newest first. */
  listKnownHeadsUps(user: string): KnownHeadsUpRow[] {
    return this.st("listKnownHeadsUps").all(user) as KnownHeadsUpRow[];
  }

  /**
   * Marks a heads-up as known: `text` trimmed; a text already listed (case-insensitively) keeps its id and becomes the
   * newest. At most `max` per user, the oldest dropped. Returns the stored row.
   */
  addKnownHeadsUp(user: string, text: string, at = iso(), max = 200): KnownHeadsUpRow {
    const t = text.trim();
    return this.transaction(() => {
      const existing = this.st("findKnownHeadsUp").get(user, t) as KnownHeadsUpRow | undefined;
      const row: KnownHeadsUpRow = existing ? { ...existing, at } : { id: randomUUID(), text: t, at };
      // Re-inserted (same id), so it also wins ties with entries of the same millisecond.
      if (existing) this.st("deleteKnownHeadsUp").run(user, existing.id);
      this.st("insertKnownHeadsUp").run(row.id, user, row.text, at);
      this.st("trimKnownHeadsUps").run(user, user, max);
      return row;
    });
  }

  /** false when there was no such entry. */
  deleteKnownHeadsUp(user: string, id: string): boolean {
    return this.st("deleteKnownHeadsUp").run(user, id).changes > 0;
  }

  // ---------------------------------------------------------------- turns
  /** Where estimated costs come from (set by the hub). */
  setPricing(p: Pick<Pricing, "cost"> | null): void {
    this.pricing = p;
  }

  /**
   * Inserts a usage row under the canonical model id; a row without a reported cost gets the list-price estimate of
   * the price table at its timestamp (unknown Claude models are priced like the most expensive family). Usage figures only: the API-credit spend comes
   * from the metered requests (api_requests). Returns the cost stored.
   */
  insertTurn(t: TurnInsert): number {
    const { model, effort } = canonicalUsageModel(t.model, t.effort ?? null);
    let cost = t.costUsd;
    if (!(cost > 0) && this.pricing) {
      const tokens = { input: t.inputTokens, output: t.outputTokens, cacheRead: t.cacheReadTokens, cacheCreate: t.cacheCreateTokens };
      // A turn row sums several requests: the long-prompt tier cannot be told per request (base prices).
      cost = this.pricing.cost(model, tokens, t.at, { aggregate: true, fallback: isClaudeModel(model) }) ?? t.costUsd;
    }
    this.st("insertTurn").run({ ...t, model, effort, costUsd: cost, purpose: t.purpose ?? null });
    return cost;
  }

  // ---------------------------------------------------------------- pricing

  insertPricingOverride(o: PricingOverrideRow): number {
    const r = this.db
      .prepare(
        `INSERT INTO pricing_overrides (model, from_at, input_per_mtok, output_per_mtok, cache_read_factor, cache_read_per_mtok, cache_write_5m_factor, cache_write_1h_factor, fast_factor, long_prompt, source, check_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.model,
        o.from,
        o.input,
        o.output,
        o.cacheReadFactor,
        o.cacheRead ?? null,
        o.cacheWrite5m ?? null,
        o.cacheWrite1h ?? null,
        o.fastFactor ?? null,
        o.longPrompt ? JSON.stringify(o.longPrompt) : null,
        o.source,
        o.checkId,
        o.createdAt,
      );
    return Number(r.lastInsertRowid);
  }

  listPricingOverrides(): PricingOverrideRow[] {
    const rows = this.db.prepare("SELECT * FROM pricing_overrides ORDER BY id").all() as {
      model: string;
      from_at: string;
      input_per_mtok: number;
      output_per_mtok: number;
      cache_read_factor: number;
      cache_read_per_mtok: number | null;
      cache_write_5m_factor: number | null;
      cache_write_1h_factor: number | null;
      fast_factor: number | null;
      long_prompt: string | null;
      source: string;
      check_id: number | null;
      created_at: string;
    }[];
    const tier = (s: string | null): LongPromptTier | null => {
      if (!s) return null;
      try {
        const t = JSON.parse(s) as LongPromptTier;
        return [t.above, t.input, t.output, t.cacheRead].every((n) => typeof n === "number" && Number.isFinite(n)) ? t : null;
      } catch {
        return null;
      }
    };
    return rows.map((r) => ({
      model: r.model,
      from: r.from_at,
      input: r.input_per_mtok,
      output: r.output_per_mtok,
      cacheReadFactor: r.cache_read_factor,
      cacheRead: r.cache_read_per_mtok,
      cacheWrite5m: r.cache_write_5m_factor,
      cacheWrite1h: r.cache_write_1h_factor,
      fastFactor: r.fast_factor,
      longPrompt: tier(r.long_prompt),
      source: r.source,
      checkId: r.check_id,
      createdAt: r.created_at,
    }));
  }

  insertPricingCheck(c: Omit<PricingCheckRow, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO pricing_checks (at, trigger, outcome, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, effective_from, previous_input, previous_output, message, response)
         VALUES (@at, @trigger, @outcome, @model, @input, @output, @cacheRead, @effectiveFrom, @previousInput, @previousOutput, @message, @response)`,
      )
      .run(c);
    return Number(r.lastInsertRowid);
  }

  /** Price checks, newest first. */
  listPricingChecks(limit = 50): PricingCheckRow[] {
    const rows = this.db.prepare("SELECT * FROM pricing_checks ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      trigger: r.trigger as PricingCheckRow["trigger"],
      outcome: r.outcome as PricingCheckRow["outcome"],
      model: r.model as string,
      input: (r.input_per_mtok as number | null) ?? null,
      output: (r.output_per_mtok as number | null) ?? null,
      cacheRead: (r.cache_read_per_mtok as number | null) ?? null,
      effectiveFrom: (r.effective_from as string | null) ?? null,
      previousInput: (r.previous_input as number | null) ?? null,
      previousOutput: (r.previous_output as number | null) ?? null,
      message: (r.message as string | null) ?? null,
      response: (r.response as string | null) ?? null,
    }));
  }

  /** Records one metered API request (keyProxy.ts, or the hub's own: routes/readme.ts). Returns its id. */
  insertApiRequest(r: Omit<ApiRequestRow, "id" | "purpose"> & { purpose?: string | null }): number {
    const res = this.st("insertApiRequest").run({ ...r, purpose: r.purpose ?? null, complete: r.complete ? 1 : 0 });
    return Number(res.lastInsertRowid);
  }

  /** Metered API requests in [fromIso, toIso), oldest first. */
  listApiRequests(fromIso: string, toIso: string): ApiRequestRow[] {
    const rows = this.db.prepare("SELECT * FROM api_requests WHERE at >= ? AND at < ? ORDER BY at, id").all(fromIso, toIso) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      sessionId: (r.session_id as string | null) ?? null,
      user: r.user as string,
      purpose: (r.purpose as string | null) ?? null,
      model: r.model as string,
      input: r.input as number,
      cacheWrite5m: r.cache_write_5m as number,
      cacheWrite1h: r.cache_write_1h as number,
      cacheRead: r.cache_read as number,
      output: r.output as number,
      webSearchRequests: r.web_search_requests as number,
      speed: (r.speed as string | null) ?? null,
      costUsd: r.cost_usd as number,
      complete: r.complete === 1,
    }));
  }

  /** API-credit spend (USD) in [fromIso, toIso): the metered requests (api_requests). */
  apiSpend(fromIso: string, toIso: string): number {
    return (this.st("apiRequestSpend").get(fromIso, toIso) as { cost: number }).cost;
  }

  /** apiSpend per user. */
  apiSpendByUser(fromIso: string, toIso: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.st("apiRequestSpendByUser").all(fromIso, toIso) as { user: string; cost: number }[]) out.set(r.user, (out.get(r.user) ?? 0) + r.cost);
    return out;
  }

  tokensSince(user: string, sinceIso: string): number {
    return (this.st("tokensSince").get(user, sinceIso) as { n: number }).n;
  }

  tokensSinceByUser(sinceIso: string): Map<string, { tokens: number; costUsd: number }> {
    const rows = this.st("tokensSinceAll").all(sinceIso) as { user: string; n: number; cost: number }[];
    return new Map(rows.map((r) => [r.user, { tokens: r.n, costUsd: r.cost }]));
  }

  /** Hourly aggregates (bucket = "YYYY-MM-DDTHH" in UTC). */
  usageByHour(sinceIso: string, user: string | null): UsageAggRow[] {
    return this.st("usageByHour").all(sinceIso, user, user) as UsageAggRow[];
  }

  // -------------------------------------------------------------- uploads
  getUpload(user: string, id: string): UploadRow | null {
    const r = this.st("getUpload").get(user, id) as
      | { id: string; user: string; path: string; chunk_total: number; total_bytes: number; received: string; final_path: string | null; created_at: string; updated_at: string }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      user: r.user,
      path: r.path,
      chunkTotal: r.chunk_total,
      totalBytes: r.total_bytes,
      received: JSON.parse(r.received) as number[],
      finalPath: r.final_path,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  createUpload(u: { id: string; user: string; path: string; chunkTotal: number; totalBytes: number }): UploadRow {
    const at = iso();
    this.st("insertUpload").run(u.id, u.user, u.path, u.chunkTotal, u.totalBytes, at, at);
    return this.getUpload(u.user, u.id)!;
  }

  setUploadReceived(user: string, id: string, received: number[]): void {
    this.st("setUploadReceived").run(JSON.stringify(received), iso(), user, id);
  }

  completeUpload(user: string, id: string, finalPath: string): void {
    this.st("completeUpload").run(finalPath, iso(), user, id);
  }

  // --------------------------------------------------------- file touches
  /** `path` is relative to the project when `projectId` is set, else to the user root. */
  insertFileTouch(t: { sessionId: string; user: string; path: string; tool: string; turn: number; projectId?: string | null; at?: string }): void {
    this.st("insertTouch").run(t.sessionId, t.user, t.path, t.tool, t.turn, t.at ?? iso(), t.projectId ?? null);
  }

  /** Latest touch per project-relative path. */
  lastTouches(projectId: string): Map<string, TouchRow> {
    const rows = this.st("lastTouches").all(projectId) as (TouchRow & { id: number })[];
    return new Map(rows.map((r) => [r.path, { path: r.path, sessionId: r.sessionId, turn: r.turn, tool: r.tool, at: r.at }]));
  }

  /** The newest touch per path of a session, newest first; `projectName` is set when `path` is relative to that project. */
  sessionTouches(sessionId: string, limit: number): SessionTouchRow[] {
    return this.st("sessionTouches").all(sessionId, sessionId, limit) as SessionTouchRow[];
  }

  // ------------------------------------------------------------ terminals
  insertTerminal(t: TerminalRow): void {
    this.st("insertTerminal").run(t.id, t.user, t.cwd, t.createdAt, t.tmuxSession);
  }

  listTerminals(user: string): TerminalRow[] {
    return (this.st("listTerminals").all(user) as { id: string; user: string; cwd: string; created_at: string; tmux_session: string }[]).map((r) => ({
      id: r.id,
      user: r.user,
      cwd: r.cwd,
      createdAt: r.created_at,
      tmuxSession: r.tmux_session,
    }));
  }

  getTerminal(id: string): TerminalRow | null {
    const r = this.st("getTerminal").get(id) as { id: string; user: string; cwd: string; created_at: string; tmux_session: string; exited_at: string | null } | undefined;
    return r && !r.exited_at ? { id: r.id, user: r.user, cwd: r.cwd, createdAt: r.created_at, tmuxSession: r.tmux_session } : null;
  }

  /** Every terminal not yet marked exited (startup reconciliation with `tmux ls`). */
  listLiveTerminals(): TerminalRow[] {
    return (this.st("listLiveTerminals").all() as { id: string; user: string; cwd: string; created_at: string; tmux_session: string }[]).map((r) => ({
      id: r.id,
      user: r.user,
      cwd: r.cwd,
      createdAt: r.created_at,
      tmuxSession: r.tmux_session,
    }));
  }

  markTerminalExited(id: string): void {
    this.st("markTerminalExited").run(iso(), id);
  }

  deleteTerminal(id: string): void {
    this.st("deleteTerminal").run(id);
  }

  // ------------------------------------------------------------- memories
  listMemories(user: string): MemoryRow[] {
    return (this.st("listMemories").all(user) as RawMemory[]).map(toMemory);
  }

  getMemory(user: string, id: string): MemoryRow | null {
    const r = this.st("getMemory").get(user, id) as RawMemory | undefined;
    return r ? toMemory(r) : null;
  }

  insertMemory(m: MemoryRow): void {
    this.st("insertMemory").run(m.id, m.user, m.text, m.source, m.sessionId, m.createdAt, m.updatedAt);
  }

  updateMemory(user: string, id: string, text: string, updatedAt: string): MemoryRow | null {
    this.st("updateMemory").run(text, updatedAt, user, id);
    return this.getMemory(user, id);
  }

  deleteMemory(user: string, id: string): void {
    this.st("deleteMemory").run(user, id);
  }

  // --------------------------------------------------------- search index

  /** Version of what relevant search ranks for `user` (cache key). */
  searchVersion(user: string): number {
    return this.searchVersions.get(user) ?? 0;
  }

  private bumpSearch(user: string): void {
    this.searchVersions.set(user, this.searchVersion(user) + 1);
  }

  /**
   * Startup build, step 1 for a session: drops its docs and indexes the title. Returns the row when the session is
   * indexable (not hidden / incognito). Appends that land while the build pages through the messages insert their own
   * docs; the build's INSERT OR IGNORE then skips them, so no step needs one long transaction.
   */
  resetSessionDocs(id: string): SessionRow | null {
    return this.transaction(() => {
      this.st("deleteDocs").run(id);
      const row = this.getSession(id);
      if (!row || row.hidden || row.incognito || row.parentSessionId) return null;
      this.st("insertDoc").run(id, row.user, 0, "title", row.createdAt, row.title);
      return row;
    });
  }

  /** Startup build, step 2: indexes one page of a session's messages. Returns the number of docs written. */
  indexMessages(row: Pick<SessionRow, "id" | "user">, page: MessageRow[]): number {
    return this.transaction(() => {
      let n = 0;
      for (const m of page) {
        if (m.kind !== "user" && m.kind !== "assistant") continue;
        const doc = messagePlainText(m.kind, m.payload);
        if (doc && this.st("insertDoc").run(row.id, row.user, m.seq, doc.role, m.at, doc.text).changes > 0) n++;
      }
      return n;
    });
  }

  /** Re-indexes one session from its messages in one go. */
  reindexSession(id: string): number {
    const row = this.resetSessionDocs(id);
    if (!row) return 0;
    let n = 0;
    // Pages, not an open iterator: better-sqlite3 refuses writes while a statement is still iterating.
    for (let after = 0; ; ) {
      const page = this.listMessages(id, after, 500);
      if (!page.length) break;
      n += this.indexMessages(row, page);
      after = page[page.length - 1]!.seq;
    }
    return n;
  }

  /** Ids of every indexable session, newest activity first (startup build). */
  indexableSessionIds(): string[] {
    return this.db.prepare("SELECT id FROM sessions WHERE hidden = 0 AND incognito = 0 AND parent_session_id IS NULL ORDER BY last_active_at DESC").pluck().all() as string[];
  }

  /** The indexed docs of a session in order (title first). */
  sessionDocs(sessionId: string): SearchDocRow[] {
    return this.st("sessionDocs").all(sessionId) as SearchDocRow[];
  }

  firstUserText(sessionId: string): string | null {
    const r = this.st("firstUserDoc").get(sessionId) as { text: string } | undefined;
    return r?.text ?? null;
  }

  // ------------------------------------------------------------ summaries
  getSummary(sessionId: string): SummaryRow | null {
    const r = this.st("getSummary").get(sessionId) as { session_id: string; user: string; summary: string; model: string; message_seq: number; updated_at: string } | undefined;
    return r ? { sessionId: r.session_id, user: r.user, summary: r.summary, model: r.model, messageSeq: r.message_seq, updatedAt: r.updated_at } : null;
  }

  upsertSummary(r: SummaryRow): void {
    this.st("upsertSummary").run(r.sessionId, r.user, r.summary, r.model, r.messageSeq, r.updatedAt);
    this.bumpSearch(r.user);
  }

  // ------------------------------------------------------------------- kv
  kvGet<T>(key: string): T | null {
    const r = this.st("kvGet").get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  kvSet(key: string, value: unknown): void {
    this.st("kvSet").run(key, JSON.stringify(value), iso());
  }

  // ------------------------------------------------------------- projects
  listProjectRows(user: string): ProjectRow[] {
    return (this.st("listProjects").all(user) as RawProject[]).map(toProject);
  }

  listAllProjectRows(): ProjectRow[] {
    return (this.st("listAllProjects").all() as RawProject[]).map(toProject);
  }

  getProject(id: string): ProjectRow | null {
    const r = this.st("getProject").get(id) as RawProject | undefined;
    return r ? toProject(r) : null;
  }

  getProjectByName(user: string, name: string): ProjectRow | null {
    const r = this.st("getProjectByName").get(user, name) as RawProject | undefined;
    return r ? toProject(r) : null;
  }

  insertProject(p: { id: string; user: string; name: string; origin: string | null; createdAt?: string }): ProjectRow {
    this.st("insertProject").run(p.id, p.user, p.name, p.createdAt ?? iso(), p.origin);
    return this.getProject(p.id)!;
  }

  setProjectExcludes(id: string, patterns: readonly string[]): void {
    this.st("setProjectExcludes").run(JSON.stringify(patterns), id);
  }

  /** Removes the project row and its file touches (user-initiated project delete only). */
  deleteProject(id: string): void {
    this.transaction(() => {
      this.st("deleteProjectTouches").run(id);
      this.st("deleteProject").run(id);
    });
  }
}
