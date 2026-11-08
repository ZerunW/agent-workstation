-- workstation-hub SQLite schema (WAL). Applied idempotently at startup.
-- Timestamps are ISO-8601 UTC strings (lexicographically sortable).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  name                TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  -- new users start without a terminal unless they are admins (UserService.ensure)
  terminal_enabled    INTEGER NOT NULL DEFAULT 0,
  -- 0 = follow the admin default weekly limit; 1 = weekly_token_limit is authoritative (NULL = unlimited)
  weekly_limit_custom INTEGER NOT NULL DEFAULT 0,
  weekly_token_limit  INTEGER,
  model_allowlist     TEXT,              -- JSON array or NULL
  hidden              INTEGER NOT NULL DEFAULT 0, -- internal users such as _system
  -- the user's own defaults for new sessions; NULL = follow the server default (admin settings / config)
  default_model       TEXT,
  default_effort      TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  user              TEXT NOT NULL REFERENCES users(name),
  kind              TEXT NOT NULL CHECK (kind IN ('chat', 'code')),
  title             TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  model             TEXT NOT NULL,
  permission_mode   TEXT NOT NULL,
  effort            TEXT,
  status            TEXT NOT NULL DEFAULT 'idle',
  claude_session_id TEXT,
  claude_history    TEXT,               -- JSON array of earlier claude session ids (before /clear)
  created_at        TEXT NOT NULL,
  last_active_at    TEXT NOT NULL,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  usage_cumulative  TEXT,               -- JSON: last cumulative modelUsage seen from `result`
  hidden            INTEGER NOT NULL DEFAULT 0
  -- context_usage TEXT (JSON protocol ContextUsage after the last turn), next_step TEXT (JSON protocol NextStep, the
  -- agent's end-of-turn box; NULL = none), incognito INTEGER and parent_session_id TEXT (subagent sessions: the
  -- session that started them; NULL = a normal session) are added by Store.migrate()
  -- Rewind / fork / pins (also added by Store.migrate()):
  --   pinned_messages TEXT    JSON array of pinned message uuids, in pin order (NULL = none)
  --   resume_from     TEXT    the session id the next process resumes from as a fork (rewind / fork)
  --   resume_at       TEXT    the message uuid it resumes at (`resumeSessionAt`, with `forkSession`)
);
CREATE INDEX IF NOT EXISTS sessions_user_kind ON sessions (user, kind, last_active_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  uuid       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,             -- raw SDK message JSON
  at         TEXT NOT NULL,
  delivery   TEXT,                      -- user messages: pending | sent | cancelled
  -- rewound INTEGER (1 = left the transcript by a rewind; kept, never shown) and turn INTEGER (user messages: the
  -- session's turn_count when it was handed to the agent = the snapshot holding the state before its turn) are added
  -- by Store.migrate()
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS messages_uuid ON messages (session_id, uuid);

CREATE TABLE IF NOT EXISTS permissions_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user         TEXT NOT NULL,
  session_id   TEXT,                    -- NULL = applies to all of the user's sessions
  tool_name    TEXT NOT NULL,
  rule_content TEXT,                    -- NULL = any input
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS permissions_rules_user ON permissions_rules (user, tool_name);

-- Websites (origins, scheme://host[:port]) the user always allows the server browser on ("always allow" on a
-- browser site card). "Allow this session" answers stay in memory. permissions_rules never satisfy a site check.
CREATE TABLE IF NOT EXISTS browser_site_grants (
  user         TEXT NOT NULL,
  origin       TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (user, origin)
);

-- Heads-ups the user marked "Knew this already" (max 200 per user, oldest dropped; text unique case-insensitively).
-- The agent's context lists them so it does not raise them again.
CREATE TABLE IF NOT EXISTS known_heads_ups (
  id    TEXT PRIMARY KEY,
  user  TEXT NOT NULL,
  text  TEXT NOT NULL,
  at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS known_heads_ups_user_text ON known_heads_ups (user, text COLLATE NOCASE);

-- One row per (result, model) with the delta against the previous cumulative totals.
-- Not cascaded on session delete so that deleting a chat does not reset weekly usage.
CREATE TABLE IF NOT EXISTS turns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  user                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL,
  cache_create_tokens INTEGER NOT NULL,
  cost_usd            REAL NOT NULL,
  duration_ms         INTEGER NOT NULL,
  at                  TEXT NOT NULL
  -- purpose TEXT (NULL = a session turn) and effort TEXT are added by Store.migrate()
);
CREATE INDEX IF NOT EXISTS turns_user_at ON turns (user, at);
CREATE INDEX IF NOT EXISTS turns_at ON turns (at);

CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT NOT NULL,
  user        TEXT NOT NULL,
  path        TEXT NOT NULL,            -- requested target path (relative to the user root)
  chunk_total INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  received    TEXT NOT NULL,            -- JSON array of received chunk indexes
  final_path  TEXT,                     -- set once assembled
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user, id)
);

-- Which session/turn/tool last wrote a file (feeds ReviewFile.lastTouchedBy).
-- Written by the in-process PostToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
-- project_id set   → path is relative to the project's work tree (projects/<name>)
-- project_id NULL  → path is relative to the user root
-- (project_id is added by Store.migrate() on databases created before projects existed.)
CREATE TABLE IF NOT EXISTS file_touches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user       TEXT NOT NULL,
  path       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  at         TEXT NOT NULL,
  project_id TEXT
);
CREATE INDEX IF NOT EXISTS file_touches_user_path ON file_touches (user, path, id DESC);

-- Synced projects: work tree <user root>/projects/<name>, bare review repo <user root>/.sync/<name>.git.
-- local_commit is unused (the repo is authoritative; kept for older databases).
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user         TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  local_commit TEXT,
  origin       TEXT,
  UNIQUE (user, name)
);

-- Large files (> MAX_SYNC_FILE_BYTES) have no table: the project's review git holds a pointer and sync-core's
-- large-file store the content (<user root>/.sync/<name>.large).

CREATE TABLE IF NOT EXISTS terminals (
  id           TEXT PRIMARY KEY,
  user         TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  exited_at    TEXT                     -- set when the tmux session is found gone; hidden from lists
);

-- Small JSON blobs: admin settings overrides, cached models/commands.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-user memories (Chat sessions read and write them through Claude's remember/forget tools; the Memory page edits them).
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL,             -- claude | user
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_user ON memories (user, created_at DESC);

-- Search (GET /api/search): the plain text of each session's title (seq 0) and user/assistant messages, maintained
-- on append / rename / delete. Incognito and hidden sessions are never indexed. The FTS5 index over `text`
-- (search_fts, trigram tokenizer, external content = this table) is created by Store when SQLite supports it; the
-- table alone serves the LIKE fallback (and terms shorter than a trigram).
CREATE TABLE IF NOT EXISTS search_docs (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  user       TEXT NOT NULL,
  seq        INTEGER NOT NULL,          -- message seq; 0 = the session title
  role       TEXT NOT NULL,             -- title | user | assistant
  at         TEXT NOT NULL,
  text       TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS search_docs_user_at ON search_docs (user, at DESC);

-- Per-session summaries written by Claude Haiku after a session goes idle (relevant search, past-conversation tools).
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id  TEXT PRIMARY KEY,
  user        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  model       TEXT NOT NULL,
  message_seq INTEGER NOT NULL,         -- sessions.last_seq the summary covers
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_summaries_user ON session_summaries (user);

-- One row per Claude request metered by the key proxy (keyProxy.ts): the usage Anthropic billed on, priced when the
-- request ended. The source of the API-credit spend. Never holds bodies, prompts, keys or tokens.
-- The hub's own API calls (routes/messagesApi.ts: the docs assistant and the Haiku helpers) bypass the proxy and add
-- their row themselves: session_id NULL, purpose readme | summary | search | download | pricing.
CREATE TABLE IF NOT EXISTS api_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  at                  TEXT NOT NULL,
  session_id          TEXT,                      -- the proxy token's owner (NULL = a hub request without a session)
  user                TEXT NOT NULL,             -- that session's user ("" when unknown; the caller for hub requests)
  purpose             TEXT,                      -- NULL = a session's request; else the hub's own request
  model               TEXT NOT NULL,
  input               INTEGER NOT NULL,
  cache_write_5m      INTEGER NOT NULL,
  cache_write_1h      INTEGER NOT NULL,
  cache_read          INTEGER NOT NULL,
  output              INTEGER NOT NULL,
  web_search_requests INTEGER NOT NULL,
  speed               TEXT,
  cost_usd            REAL NOT NULL,
  complete            INTEGER NOT NULL           -- 0 = the stream ended early (client gone, upstream failed)
);
CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests (at);
CREATE INDEX IF NOT EXISTS api_requests_user_at ON api_requests (user, at);

-- Hub-owned price periods (merged over config / built-in periods; see pricing.ts). Appended by the daily price check;
-- never rewritten, so every turn keeps the cost of the period valid at its time.
-- cache_read_per_mtok, cache_write_5m_factor, cache_write_1h_factor, fast_factor and long_prompt (JSON) are added by
-- Store.migrate().
CREATE TABLE IF NOT EXISTS pricing_overrides (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  model             TEXT NOT NULL,
  from_at           TEXT NOT NULL,             -- "YYYY-MM-DD" (hub local midnight) or an ISO timestamp
  input_per_mtok    REAL NOT NULL,
  output_per_mtok   REAL NOT NULL,
  cache_read_factor REAL NOT NULL,
  source            TEXT NOT NULL,             -- price_check
  check_id          INTEGER,
  created_at        TEXT NOT NULL
);

-- History of price checks (each run, whatever its outcome).
CREATE TABLE IF NOT EXISTS pricing_checks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  at                  TEXT NOT NULL,
  trigger             TEXT NOT NULL,           -- schedule | admin
  outcome             TEXT NOT NULL,           -- updated | unchanged | rejected | failed
  model               TEXT NOT NULL,
  input_per_mtok      REAL,
  output_per_mtok     REAL,
  cache_read_per_mtok REAL,
  effective_from      TEXT,
  previous_input      REAL,
  previous_output     REAL,
  message             TEXT,
  response            TEXT                     -- the model's answer (truncated), for diagnosis
);
CREATE INDEX IF NOT EXISTS pricing_checks_at ON pricing_checks (at DESC);
