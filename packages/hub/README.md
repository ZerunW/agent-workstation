# @agent-workstation/hub - workstation-hub

The backend of Agent Workstation: a personal, password-less remote coding workstation for a
Linux server (Debian or Ubuntu, arm64 or x86-64, Node 22). It runs Claude
Code through the Claude Agent SDK, stores every chat in SQLite, and exposes the REST +
WebSocket contract defined in [`@agent-workstation/protocol`](../protocol/src/index.ts). It also
serves the built web UI (`../web/dist`).

Stack: TypeScript (ESM) · Fastify 5 · @fastify/websocket · better-sqlite3 (WAL) · zod ·
pino · chokidar 4 · node-pty · archiver · smol-toml · `@anthropic-ai/claude-agent-sdk@0.3.316` (pinned) ·
[`@agent-workstation/sync-core`](../sync-core/README.md) (projects: folder sync + git review).

## Run

```bash
npm install                      # from the repo root (workspaces)
npm run build -w packages/protocol && npm run build -w packages/sync-core && npm run build -w packages/browser   # the hub imports these dists
npm run dev -w packages/hub      # tsx watch; uses $WORKSTATION_CONFIG or ../../config/workstation.toml
npm run build -w packages/hub && npm run start -w packages/hub   # node dist/main.js
npm test -w packages/hub         # unit tests (fake SDK, no Claude process)
LIVE=1 npm test -w packages/hub  # + real end-to-end tests with an Anthropic API key (LIVE_KEY_FILE, Haiku, ~20 s)
```

Endpoints: `GET /healthz` (plain `ok`) and `GET /api/health` need no username. `GET /api/usage/limits` needs one
(the status service sends `[status] hub_user`, default `status`).

On the server:
- `tmux` must be installed (terminal persistence). node-pty compiles from source
  (`build-essential`, `python3`).
- Run under systemd with `KillMode=process`, so tmux servers started by the hub
  survive hub restarts.
- An Anthropic API key must be configured (`auth.anthropic_api_key_file`, default
  `/etc/agent-workstation/anthropic.env`): without it every session is refused with `503 api_unavailable`.
- Projects need `git` ≥ 2.32 (Ubuntu 22.04 has 2.34), a `tar` that understands `--zstd` and the
  `zstd` binary (`apt install zstd`; GNU tar ≥ 1.31).

## Configuration

TOML, first existing file wins: **`$WORKSTATION_CONFIG` → `./config/workstation.toml` (cwd) →
`/etc/agent-workstation/workstation.toml` → built-in defaults** (identical to
`config/workstation.example.toml`); the start log names the file used. Keys read by the hub:

| key | default | meaning |
|---|---|---|
| `server.listen` | `unix` on Linux under systemd (or `NODE_ENV=production`), else `tcp` | `unix`: the public and local sockets, no TCP port; `tcp`: `host` and `port`, development only (the hub refuses to start with it in production while `agents.run_as` is set) |
| `server.socket`, `server.local_socket` | `/run/agent-workstation/hub.sock`, `hub-local.sock` | public socket (0660, group `proxy_group`; nginx) and local socket (0600, the service account's; the status service) |
| `server.proxy_group` | `workstation-proxy` | group of the public socket |
| `server.host`, `server.port` | `127.0.0.1`, `9000` | with `listen = "tcp"` only |
| `server.public_url` | `http://localhost:9000` | public base URL used in links and notifications |
| `server.allowed_origins` | `[]` | web origins besides `public_url`, this server's Tailscale name and addresses and loopback whose pages may call the hub (others: `403 cross_site`) |
| `paths.users_root` | `/srv/agent-workstation/users` | per-user workspaces |
| `paths.data_dir` | `/var/lib/agent-workstation` | `hub.sqlite`, upload scratch |
| `paths.claude_bin` | `""` | Claude Code binary (absolute or on PATH). Empty or missing → the binary bundled with the SDK (with `agents.run_as` the wrapper starts the agent account's own) |
| `paths.web_dist` | `<hub>/../web/dist` | built web UI (optional key) |
| `paths.claude_home` | the `agents.run_as` account's `~/.claude`, else `$CLAUDE_CONFIG_DIR` or `~/.claude` | where Claude keeps `settings.json` and `projects/*.jsonl` (optional key) |
| `paths.releases_dir`, `paths.docs_dir` | `<app dir>/releases`, `<app dir>/docs` | published Mac builds, and the repo's `docs/` (the readme pages are `docs/readme/*.md`, read on every request) |
| `paths.agent_plugins_dir` | `/var/lib/agent-workstation-plugins` with `agents.run_as`, else `<data_dir>/agent-plugins` | where the hub publishes the generated plugins for code sessions; the agent account must read it, never write |
| `auth.anthropic_api_key_file` | `/etc/agent-workstation/anthropic.env` | the Anthropic API key (`ANTHROPIC_API_KEY=...`), read into memory only |
| `auth.admin_usernames` | `[]` | admins among header-identity callers (LAN in legacy mode, local tools on the server) |
| `auth.tailscale_identity` | `true` | identify tailnet clients by their Tailscale login (see [Identity](#identity-srcidentityts-srctailscalets)) |
| `auth.admin_logins` | `[]` | Tailscale logins that are admin; must not be empty while `tailscale_identity` is on (the hub refuses to start) |
| `auth.lan_access` | `"deny"` | non-tailnet clients: `legacy` = header identity, `deny` = `403 lan_denied` |
| `sessions.max_active_processes` | `6` | live Claude processes at once |
| `sessions.min_free_mem_mib` | `1536` | no new process while MemAvailable is below this |
| `sessions.idle_minutes` | `10` | reap an idle process after this |
| `sessions.permission_timeout_s` | `600` | unanswered permission → deny + interrupt |
| `sessions.default_model`, `sessions.default_effort` | `opus`, `high` | what a new session starts with when the user has no default of their own |
| `sessions.tool_memory_limit_mb` | `0` | memory cap (MiB) for the commands of each session (`CLAUDE_CODE_TOOL_MEMORY_LIMIT`); 0 = off, needs the cgroup setup in `deploy/README.md` |
| `sessions.project_settings` | `false` | read a project's own `.claude/settings.json` and `.mcp.json` in code sessions (they run as the agent account) |
| `limits.disk_warn_percent` | `80` | disk level `warn` (admin can override at runtime) |
| `limits.disk_block_percent` | `95` | disk level `block` (no new turns / uploads) |
| `limits.default_weekly_token_limit` | `0` | per-user rolling-7-day input+output cap, 0 = unlimited |
| `limits.remote_claude_enabled` | `true` | global kill switch (admin can flip at runtime) |
| `billing.api_monthly_limit_usd` | `100` | monthly API budget (USD; 0 = nothing may start); admin settings override it |
| `billing.api_reset_day` | `1` | day of month (1–28) the budget resets |
| `billing.service_reserve_usd` | `2` | the last this-many USD of the period are kept for the hub's own API services |
| `billing.proxy_port`, `billing.upstream` | `0`, `https://api.anthropic.com` | the loopback key proxy's port (0 = random) and where it forwards |
| `pricing.check_time` | `04:30` | hub-local time of the daily price check |
| `agents.run_as`, `agents.exec`, `agents.sudo`, `agents.home` | `""`, `/opt/agent-workstation/bin/workstation-agent-exec`, `/usr/bin/sudo`, `/home/<run_as>` | the account every agent process and terminal shell runs as, through the root-owned wrapper; empty = the hub's own user (development) |
| `chats.download_max_mb`, `chats.download_timeout_s` | `2048`, `600` | limits of a chat's `download_file` |
| `baseline.max_compressed_bytes`, `.max_extracted_bytes`, `.max_files`, `.max_minutes` | 4 GiB, 8 GiB, `200000`, `30` | limits of one baseline upload |
| `terminal.enabled` | `true` | web terminal on/off |
| `terminal.shell` | `/bin/bash` | shell started in new tmux sessions |
| `browser.enabled` | `true` | the per-user browser ([`@agent-workstation/browser`](../browser/README.md)); the MCP endpoint binds at hub start |
| `browser.executable_path` | `""` | Chromium binary; empty = Playwright's bundled build (`browser.flavor`: `headless-shell` / `chromium`) |
| `browser.idle_minutes`, `.max_concurrent`, `.min_free_memory_mb`, `.extra_args`, `.control_idle_seconds` | package defaults | see the package README; `[browser.viewport]` `width`/`height`, `[browser.screencast]` `quality`/`max_fps`/`settle_ms`, `[browser.mcp]` `host` (loopback only)/`port` (0 = random per start)/`capabilities`/`session_idle_minutes`. No `wrapper`: Chromium is a direct child of the hub |

Environment overrides (dev): `WORKSTATION_HUB_HOST`, `WORKSTATION_HUB_PORT`, `WORKSTATION_USERS_ROOT`,
`WORKSTATION_DATA_DIR`, `WORKSTATION_CLAUDE_BIN`, `WORKSTATION_WEB_DIST`, `WORKSTATION_CLAUDE_HOME`, `LOG_LEVEL`. The `[status]` section belongs to the status service and is ignored.
Admin overrides (`PATCH /api/admin/settings`) are stored in SQLite and win over the file.

## Data layout

```
<users_root>/<user>/            created on first sight of a username
  inbox/                        drag-and-drop uploads land here
  projects/<name>/              synced project work trees (Claude's cwd; no .git inside)
  .sync/<name>.git              bare review repo per project (branch `local` = what the Mac has)
  .chat/<session id>/           each chat's own folder (its cwd; sandboxed commands, downloads/)
  .claude/skills/<name>/SKILL.md  the user's skills
  .browser/                     browser profile + agent output (0700, hub account): hidden from listings,
                                the watcher, the files API and the agents' file tools
<users_root>/_global/skills/<name>/SKILL.md   admin-provided global skills (`_global` is a reserved username)
<users_root>/.claude/skills -> ../_global/skills   symlink created at startup (skill discovery, see Skills)
<data_dir>/
  hub.sqlite (+ -wal, -shm)     everything the hub knows
  uploads/<user>/<id>/<n>.part  in-flight upload chunks (removed after assembly)
  tmp/baseline-*                scratch where a baseline archive is extracted (removed after import)
  skill-overlays/<user>/.claude/skills/   symlinks, only for sessions inside nested git repos
~/.claude/                      Claude Code's own state
  settings.json                 hub adds cleanupPeriodDays = 36500 if absent
  projects/<cwd>/<id>.jsonl     transcripts - deleted only when a user deletes the session
```

**Iron rule: the hub never deletes user data on its own.** No expiry, no cleanup timers.
Deletes happen only on explicit user actions (DELETE session / file / terminal / skill /
project - the last one refuses while changes are pending or generated files were never
downloaded, unless the user passes `discardRemaining`). Before reject, restore, forced sync and
re-baseline, sync-core saves the work tree in a `refs/trash/*` ref; snapshot and trash refs are
never pruned. The disk monitor measures and warns; at `block` it refuses new turns, uploads,
baselines and sync pushes (review, accept, download and delete keep working).

## SQLite schema (`src/db/schema.sql`)

| table | purpose |
|---|---|
| `users` | name, enabled, terminal_enabled, weekly limit (+ "custom" flag: otherwise the admin default applies), model allowlist, hidden (`_system`), `tailscale_login` (bound login, NULL = none) |
| `sessions` | kind chat/code, title, cwd, model, permission_mode, effort, status, `claude_session_id` (+ `claude_history` of ids before `/clear`), last_seq, cost, turn_count, last cumulative usage |
| `messages` | `(session_id, seq)` PK, unique `(session_id, uuid)`, kind, raw SDK JSON payload, delivery state for user messages |
| `permissions_rules` | hub-side "always allow" rules (user- or session-scoped) |
| `turns` | per-result, per-model **deltas** (tokens, cost, duration) - survives session deletion |
| `uploads` | resumable chunked uploads |
| `file_touches` | which session/turn/tool wrote a file (PostToolUse); `project_id` + project-relative `path` for files inside a project (→ `ReviewFile.lastTouchedBy`), otherwise a user-root-relative `path` |
| `terminals` | tmux-backed terminals (`exited_at` once the tmux session is gone) |
| `projects` | id, user, name (unique per user), origin, created_at (`local_commit` unused: the repo is authoritative) |
| `kv` | admin settings overrides, cached models/commands/account, last usage limits |
| `memories`, `known_heads_ups`, `browser_site_grants` | the user's saved memories, the heads-ups marked "Knew this already", the per-website browser grants |
| `search_docs`, `session_summaries` | the keyword search index and the session summaries |
| `api_requests` | one row per API-billed Claude request metered by the key proxy (session, user, model, input / 5m and 1h cache writes / cache reads / output tokens, web searches, speed, cost, complete) - the API-credit spend; never bodies, prompts, keys or tokens |
| `pricing_overrides` | hub-owned price periods appended by the daily Claude price check (merged over config / built-in periods; Claude periods with cache-read price, cache-write factors, fast factor, long-prompt tier) |
| `pricing_checks` | every price-check run: outcome (updated / unchanged / rejected / failed), reported prices, previous prices, reason |

`seq` is allocated with `UPDATE … SET last_seq = last_seq + 1 RETURNING` inside the insert
transaction, so it is gap-free and monotonic per session. All access uses prepared
statements; replay streams rows with `iterate()`.

## Session lifecycle

A session is a SQLite row plus a `claude_session_id`; the Claude Code process is a
disposable cache. Sessions are unlimited; processes are limited.

```
 POST /messages ─► pre-send checks ─► persist user row (uuid, delivery=pending) ─► FIFO
                                                                                   │
                ┌──────────────── process alive? ──────────── yes ─► feed (one turn at a time)
                │ no                                                               │
                ▼                                                                  ▼
       pool slot free? ── no ─► reclaim an idle process? ── no ─► status queued (position N)
                │ yes                       │ yes                         │ (slot freed / memory freed)
                ▼                           ▼                             ▼
     reconcile getSessionMessages ─► query({ resume, cwd, model, permissionMode, effort, … })
                                                                                   │
   stream: stream_event → in-memory partial + `delta` broadcasts                   │
           assistant / user(tool results) / system(init,status,compact,…) / reset → persisted + `message`
           result → usage delta → `turns`; next queued message or idle timer       │
                                                                                   ▼
   idle_minutes without activity → close() (slot released, next message resumes)
   process dies mid-turn → status dead + hub_process_died row; next message respawns (resume)
```

- **Statuses**: `idle`, `queued` (with `queuePosition`), `running`, `requires_action`
  (a permission is pending), `dead`.
- **Lock**: at most one live process per session and per Claude session id; a respawn
  waits for the previous process to exit.
- **Live settings** without restart: `setModel()`, `setPermissionMode()`,
  `applyFlagSettings({ effortLevel })` (next turn; `null` clears). A `system/status`
  carrying a new `permissionMode` (e.g. auto → default after a model switch) is written
  back and broadcast as `session_settings`.
- **Stop** = `interrupt()`, wait 10 s for the `result`, otherwise `close()`
  (`hub_stop_timeout`); queued messages are cancelled (`hub_cancelled`), pending
  permissions cancelled. **Close** = `close()`, history kept. **Delete** = rows + Claude's
  transcript files for every Claude id the session ever used.
- **Chat** kind: `tools: ['WebSearch', 'WebFetch']` (plus `Read` once the session has file
  attachments; a chat with its own folder also gets sandboxed Bash and the file tools there), `strictMcpConfig`, a plain assistant `systemPrompt` (search the web, cite sources
  as links; show_visual guidance), cwd `.chat/<session id>`, `settingSources: []`. The stored mode stays
  `dontAsk`, but the CLI runs in `default` so every call that is not pre-approved reaches the
  chat `canUseTool`, which never shows a card: web tools allowed, `Read` only for the session's
  own attachment paths (exact path, no `..`, no symlink below the user root, regular file -
  `src/sessions/attachments.ts`; a PreToolUse gate on `Read` enforces the same before any
  permission rule), anything else denied. A first file attachment recycles an idle process (or
  the busy one before its next turn) so the resumed process has `Read`. With memory on, the
  in-process `workstation-memory` MCP server (`remember` / `forget`); every chat (incognito included) and
  every code session gets `workstation-visual` (`show_visual`, `src/sessions/visual.ts`); hub MCP tools are
  pre-approved through `allowedTools`. **Code** kind: cwd = workspace root or a subdirectory,
  `systemPrompt: claude_code preset` (show_visual guidance and memories in `append`),
  `settingSources: []` (no project settings file is read) unless `sessions.project_settings` is on (default off), when it
  is `['project']`. With it off the inline settings also carry `disableAllHooks: true` and the options `strictMcpConfig: true`
  (belt and braces; the hub's own SDK hooks and MCP servers run), the project's `CLAUDE.md` / `.claude/CLAUDE.md` are
  read by the hub and appended to the system prompt after the guide (`src/sessions/projectContext.ts`), and the skills,
  commands and agents come as generated plugins (see Skills).
- **Chat attachments**: small images and PDFs (≤ 5 MB) and text files (≤ 256 KB) are inlined;
  anything else is listed in the message with its absolute path, type and size and how to read it
  (`Read`, PDFs by `pages`, text by `offset`/`limit`).
  Code sessions also get the project hooks (see Projects) and their plugins (see Skills; with `project_settings` on,
  inside a nested git repository, one `additionalDirectories` entry for skills instead).
  Both get `includePartialMessages`, `allowDangerouslySkipPermissions`, env
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, flag setting `cleanupPeriodDays: 36500`, and
  `pathToClaudeCodeExecutable` when `paths.claude_bin` exists.
- **Chat downloads** (`src/sessions/download.ts`): a chat with its own folder (not
  research subagents) gets `download_file {url, filename?}` (`mcp__workstation_fetch__download_file`);
  its sandboxed commands reach only PyPI. https only, public addresses only (pinned for the fetch),
  redirects re-validated (≤ 5); well-known download hosts are fetched directly, any other host is
  judged by Claude Haiku (URL only, through `helper.ts`) and, when not clearly safe or when the helper is unavailable, asks the person on a card. curl runs in
  bubblewrap through the wrapper's `fetch` / `fetchmv` / `fetchrm` modes; the file lands in
  `<chat folder>/downloads/` (never overwritten). `[chats] download_max_mb` (2048),
  `download_timeout_s` (600).
- **Dedupe**: the client's message uuid is the stored uuid and `SDKUserMessage.uuid`; a
  re-POST returns the existing seq, and echoed user messages are dropped.
- **Usage**: `result.modelUsage` is a session total (it includes earlier processes after
  `resume`, verified live). The hub stores the last cumulative per session and writes the
  delta; a drop (after `/clear`, verified live) counts as a fresh start.
- **Memory** (`src/memory.ts`, table `memories`, `/api/me/memories`): per-user facts. Chat
  sessions get them in the system prompt plus the `remember` / `forget` tools; Code sessions get
  them appended to the Claude Code prompt (read-only). Every change bumps a per-user version;
  a process built from an older version (or memory preference) is closed on the next message
  when it is idle and resumed with the new prompt. Changes a process made through its own tools
  do not recycle it.
- **Live token counter**: `message_start` / `message_delta` output tokens (plus a
  characters-based estimate between them), summed over the turn including subagents →
  `delta { part: "usage" }`; the snapshot carries `partial.turnOutputTokens` and `turnStartedAt`.
- **Context usage**: at every `result`, used = input + cache creation + cache read of the
  turn's last main-loop request, window = `modelUsage[model].contextWindow`; the breakdown comes
  from the CLI's `get_context_usage` control request (`summary`: no model turn, nothing in the
  transcript). Stored in `sessions.context_usage`, broadcast as `context_usage` +
  `session_updated`.
- **Reconciliation**: on every spawn with `resume`, `getSessionMessages()` is compared with
  the stored uuids and missing transcript messages after the last known one are imported.
- **Restart**: every session becomes `idle`; undelivered user messages are marked
  cancelled with a `hub_cancelled` row.

## Permissions

`canUseTool` → (1) hub-side rules from `permissions_rules` (Bash prefix `cmd:*` / exact,
path globs, `domain:`; compound shell commands never match a prefix rule) → (2) otherwise
a pending request in memory, broadcast as `permission_request` to all of the user's
connections. Closing tabs does not end it; `snapshot.pendingPermission` re-sends it. The
first `permission_response` wins (`permission_resolved`); later answers get
`permission_not_found`. The SDK's abort signal → `permission_cancelled`. Timeout
(`permission_timeout_s`) → `{ behavior: 'deny', interrupt: true }`. `remember:
'session' | 'user'` stores rules from the SDK's `addRules` suggestions (or the whole tool).

## Queueing and memory

The pool admits a new process when `active < max_active_processes` **and**
`MemAvailable ≥ min_free_mem_mib` (`/proc/meminfo`; the gate is off where `/proc` does
not exist). Otherwise it closes the least recently used *idle* process (never one in a
turn, with pending input, or waiting on a permission) and swaps it in; if none, the
request waits in a FIFO queue (HTTP 202 `{state:"queued", position}`, `session_state`
events with `queuePosition`). The queue is pumped on every release, at every turn end, and
every 5 s (memory can free up on its own). Measured on macOS: a Claude Code 2.1.316
process is ≈ 270 MiB RSS after a first Haiku turn.

## WebSocket (`/ws`)

`hello{user}` → `welcome` + `usage_limits` + `disk_status` (+ notices). The upgrade passes the
identity hook and `hello` the username rules ([Identity](#identity-srcidentityts-srctailscalets)). `subscribe{sessionId,
lastSeq}` → `replay` (seq > lastSeq, chunks of 200, at most the newest 500 - then every chunk
carries `truncated: true` and the client backfills older messages via
`GET /api/sessions/:id/messages`) → `snapshot` (session, in-flight
partial, pending permission) → live `message` / `delta` / `session_state` / … Replay and
snapshot are produced synchronously in one tick after registering the subscriber, so no
live event can slip in between. Browsers cannot set headers on WebSocket upgrades or
`<a href>` downloads: every route also accepts `?user=<name>`. Deltas are dropped for
clients with > 4 MB buffered (the next snapshot recovers).

## Server browser

One headless Chromium per user ([`@agent-workstation/browser`](../browser/README.md)), started on demand,
running as the hub account (DevTools over a pipe, no port). `GET /api/browser` → `BrowserState`,
`POST /api/browser/start` / `stop`; `BrowserError` → HTTP status with code `browser_<code>`
(`disabled`/`not_installed`/`too_many`/`low_memory` 503, `profile_in_use`/`not_running` 409, …).
WebSocket: `hello` also sends `browser_state`, and every change goes to the user's connections;
`browser_view{on}` streams `browser_frame` to that connection (dropped while > 1 MB is buffered);
`browser_input` → the page, errors as `error{code: "browser_<code>"}`. Sessions get the browser's
MCP server, looked up on every spawn because the port is random per hub start (`mcpServers.browser`, type `http`).
Permissions, per call: tools the package does not offer are refused, and so are `act` tools in
chats and while the person controls the browser (`controlledBy: "user"`). Then the **website
check** (like Claude in Chrome): the origin the call touches (`browser_navigate` / `browser_tabs`
new → the target URL; a call naming a tab → that tab; anything else → the active tab;
`about:blank` needs nothing; non-http(s) URLs are refused) must have a stored grant
(`browser_site_grants`, `last_used_at` updated on use) or an "allow this session" answer (in memory,
dropped when the session closes). Otherwise a `permission_request` with `browserSite: { origin }`
asks - in every permission mode and in chats; `dontAsk` sessions are denied. Allow = this session,
allow + `remember: "user"` = stored grant, deny = the call is denied. Remembered tool rules never
answer it. After that, `read` tools run and `act` tools follow the permission mode (a card in
`default`, denied in `plan`). A PreToolUse hook (timeout longer than the card's) enforces this in
every mode, and keeps the file tools out of `<user>/.browser/`. Chats get read tools only; incognito
chats get no browser. `GET /api/me/browser-sites` → `BrowserSitesResponse` (most recently used
first), `DELETE /api/me/browser-sites?origin=` → 204 (404 when absent; also drops open sessions'
answers for it). Deleting a user stops their browser first and deletes their grants; hub shutdown
(SIGTERM) closes all browsers.

## Files, uploads, watcher

All paths are POSIX, relative to the user root, no `..`, and confined after `realpath`
(symlinks out of the workspace are rejected; zips skip symlinks). Uploads: chunked
`PUT /api/files/upload` (see `UPLOAD_HEADERS`; path header percent-encoded), resumable via
`GET /api/files/upload?uploadId=`, assembled into a temp file and hard-linked into place
(never overwrites: `name (1).ext`). chokidar watches a user's root while they have a
connection (ignores `node_modules`, `.git`, `.chat`, `.DS_Store`, the top-level `.sync/` and every
`.claude/skills` folder), coalesces events every 250 ms and tags `file_event` with the session
whose turn is running; changes under `projects/<name>/` also trigger a debounced `review_changed`.
The file tree hides `.sync/` and `.claude/skills` too, and sets `FileEntry.reviewStatus` for
files inside a project that differ from `local`. The files API refuses to write into `.sync/`
or to delete a project root (`409`; use `DELETE /api/projects/:id`).

## Terminal

`POST /api/terminals` creates tmux session `term-<user>-<id>` (row in SQLite);
`WS /ws/terminal/:id` attaches a node-pty running `tmux attach-session -t =<name>`;
closing the socket only detaches. Hub shutdown never kills tmux; startup reconciles rows
with `tmux list-sessions` (gone → `exited_at`). Only `DELETE /api/terminals/:id` kills the
tmux session. Without tmux (dev Macs) shells run in a hub-owned pty with a 256 KB
scrollback and do not survive restarts. With `agents.run_as` set, tmux and every shell run as the agent account through the
wrapper (no sudo, no access to the hub's data); without it the shell is a real shell as the hub's OS user, and workspace
isolation is directory-level only.

## Usage, limits, admin

- `UsageLimits` is `{ api }`: the API credits of this period (`ApiCredits`: spent, limit, percent, period start, reset,
  severity; null without a key). It is broadcast as `usage_limits` after every metered request and budget change.
  There is no plan-limit probe: the models / commands catalog is filled by the first live process of a session
  (until then `GET /api/models` serves the aliases `opus` / `sonnet` / `haiku`).
- Pre-send checks (chat and code alike): `403 remote_disabled`, `403 user_disabled`,
  `429 weekly_limit`, `507 disk_block`, `503 api_unavailable` (no key / budget 0), `429 api_limit_reached` (budget used
  up down to the service reserve). Creating a session also needs a key (`503 api_unavailable`). Users get notices at
  80 % and 100 % of their weekly limit.
- Rate-limit signals (`assistant.error === 'rate_limit'`, `system/api_retry`) become `notice{code:"rate_limit"}`.
- **Service reserve** (`AdminSettings.serviceReserveUsd`, config `billing.service_reserve_usd`, $2):
  sessions are refused (`429 api_limit_reached`, queued messages cancelled) once remaining ≤ the reserve; Agent
  Workstation's own API services - the docs assistant and the Claude Haiku helpers (`src/helper.ts`: relevant search
  ranking, session summaries, the download check, the price check) - run while anything remains, and are off without a
  key (relevant search `503 api_unavailable`, no summaries, downloads from unfamiliar hosts ask the person, the price
  check is skipped). Each helper call is one `api_requests` row with its purpose and user, session NULL; prompts and
  answers are never logged or stored.
- **API spend** (`src/keyProxy.ts`, `src/billing.ts`): every 2xx `POST /v1/messages` through the
  key proxy is metered from Anthropic's own usage (SSE `message_start` / `message_delta`, or the
  JSON body; a copy of the bytes is parsed as they pass, the client's stream is never held back)
  and stored in `api_requests` when it ends - also when the client disconnects or upstream fails
  mid-stream. Errors, `count_tokens` and model lookups are free (no row). API credits
  (UsageLimits.api, admin `apiSpentUsd`) = the period's `api_requests` (the hub's own calls included). Turn costs
  (`turns.cost_usd`: the SDK's figure, else the table's estimate) are usage figures only.
- **Prices** (`src/pricing.ts`, `src/pricingCheck.ts`): built-in Claude list prices (USD/MTok,
  explicit cache-read price, cache writes 1.25× / 2× input, Haiku 5.5 long-prompt tier, Opus 5.5
  fast mode 2×, web search $10 / 1,000); ids match by prefix (longest
  first); an unknown Claude model is priced like the most expensive family (warned once). Costs use
  the period valid at each request/turn (config / built-in periods with the hub-owned
  `pricing_overrides` merged over them; stored costs are never recomputed). Daily at
  `[pricing] check_time` (hub local, default 04:30; failures retried after 6 h, at
  most 3 a day; nothing without a key or budget) and on `POST /api/admin/pricing/refresh`,
  the hub fetches https://platform.claude.com/docs/en/about-claude/pricing.md itself (https GET, 30 s, size cap),
  reduces it to text and Claude Haiku (no tools) reads that text from the prompt and answers strict JSON. A page that
  cannot be fetched fails the run. Each
  model's prices within 3× of the current ones → a new period (now, or the announced future date)
  unless unchanged, and `notice{info, pricing_updated}`; otherwise nothing changes and
  `notice{warning, pricing_check_failed}`. The helper unavailable → one failed row, prices stay.
  `GET /api/admin/pricing` = `{models (AdminPricedModel per priced model), lastCheck, checks, nextCheckAt}`;
  the refresh returns `{check (the first row), checks (every row of the run), pricing}`.

## Projects (sync + review)

`src/projects/` mounts [`@agent-workstation/sync-core`](../sync-core/README.md): one `ProjectRepo` per
project, opened lazily and cached, `lockKey = project.id`. Work tree
`<user root>/projects/<name>`, bare repo `<user root>/.sync/<name>.git`.

| route | what it does |
|---|---|
| `GET /api/projects` | the caller's projects (`Project` with `localCommit`/`pendingFiles`/`sizeBytes` from `projectStats()`) |
| `POST /api/projects` | `{name, origin?}`; name `[A-Za-z0-9._-]{1,64}`, not starting with `.`, not ending in `.git`/`.lock`; `openProject` creates both directories; `409 project_exists` on a duplicate |
| `GET /api/projects/:id` | one project (404 for other users' projects) |
| `DELETE /api/projects/:id` | `canDelete()`; `409 project_not_empty` (`details: {pendingFiles, undownloadedFiles}`) unless `discardRemaining: true` (JSON body, or `?discardRemaining=true`). Then live sessions inside the project are closed (history kept), the work tree and the review repo are removed, and the row + its `file_touches` go. **The only code path that deletes a project.** |
| `POST /baseline` | raw body streamed to `importBaseline` (tar.zst); `X-Baseline-Encoding: tar` (or `Content-Type: application/x-tar`) = uncompressed tar. Both are extracted into a scratch folder first under the `[baseline]` limits (upload bytes, extracted bytes, entries, time): `413 baseline_too_large` / `408 baseline_timeout`. `507 disk_block` at the block level |
| `POST /manifest` | `manifest(entries)` (64 MB body limit); large files are compared by the real sha256/size in their pointer on `local` (and are needed again when the store lacks that version) |
| `PUT /files` | `applyOps(ops)` (160 MB body limit, `507 disk_block` at the block level). Deletes of large files and large → small writes are ordinary ops; a write over `MAX_SYNC_FILE_BYTES` is `skipped`/`too_large` (large files use `PUT /large`). Any `conflict` → `409` with the `SyncResult` body plus `error`/`code: "sync_conflict"` (the rest of the batch is applied) and one WS `sync_conflict{projectId, path, reason}` per conflict |
| `PUT /large?path=&sha256=&size=&mode=&offset=&baseHash=&force=` | large files (`src/projects/largeFiles.ts`; pointer design, see the sync-core README): one raw chunk (≤ `LARGE_FILE_CHUNK_BYTES`) streamed to `<user root>/.sync/<name>.large/uploads/<sha256(path)>.part`; chunks in order, wrong `offset` → `409` with the `LargeFileUploadResponse` body (+ `code: "stale"`); a new sha256/size for the path starts over. A version the store already holds completes at the first request (no bytes kept). On the last byte: `repo.applyLargeWrite` checks the sha256 (`422 hash_mismatch`, partial dropped), moves the bytes into the store (`<name>.large/objects/…`) and applies a normal sync write of the pointer to `local` + the work tree (baseHash = the real sha256 the Mac last saw; merge/conflict/force like small writes; a `conflict` is `result` with HTTP 200 plus WS `sync_conflict`). `400` for sizes ≤ `MAX_SYNC_FILE_BYTES` or bad paths/baseHash, `422 symlink` through/at symlinks, `409` on a directory, `507 disk_block`. Large files then show in review (`large: true`, whole-file accept/reject), snapshots, trash and history like any file |
| `GET /large?path=&sha256=&size=` | progress for resuming: `{path, received, complete}` (complete when `local` already points at that exact version) |
| `GET /review` | `{project, files}`; `lastTouchedBy` = latest `file_touches` row per path (or the rename's old path) |
| `GET /review/diff?path=` | `diffFile(path)` plus `diffId` (sha256 of the canonical unified diff; sync-core's own `diffId` wins once it provides one) and sync-core's `status`/`oldPath`/`tooLarge` |
| `POST /review/accept`, `/review/reject` | `{path}`, `{path, hunks, diffId}` or `{all: true}`. With `hunks`, `diffId` is required (400 otherwise); the diff is recomputed under the project lock and a mismatch (or sync-core `stale`) is `409 stale_diff` with `details.diffId` = the current one |
| `GET /history?limit=` | `history()` (snapshots, syncs, accepts, trash refs; newest first) |
| `POST /restore` | `restore({ref, path?})` (trash ref written first; `local` never changes) |
| `GET /raw?path=&ref=` | streamed, with HTTP Range (`Accept-Ranges: bytes`; one `bytes=` range → 206 + `Content-Range`; unsatisfiable → 416). Without `ref`: the work-tree file (`inline=1` to preview, `Content-Security-Policy: sandbox`), then `markDownloaded` once the last byte was sent (counts for `canDelete`). With `ref` (commit id, `local`, `refs/backups\|snapshots\|trash/…`, or a blob id): that version from the review repo - a large file's pointer resolved from the store (`500 large_missing` when the store lacks it) - nothing marked; unknown ref / path / not a regular file → 404, other refs → 400 |
| `POST /backups` | `ProjectBackupBody` (≤ 500 files, ≤ 50 MB decoded → `413 too_large`; paths relative, no `..`/`.`/empty segments/`.git` → `400 invalid_path`; `507 disk_block` at the block level). One `git fast-import` under the project lock writes a parentless commit whose tree holds only those files to `refs/backups/<client-slug>/<timestamp>-<random>` (metadata and the file list as `Workstation-*` trailers). Never touches `local`, the work tree, review, snapshots or trash; never pruned. → 201 `ProjectBackup` |
| `GET /backups` | `{backups}` newest first (one `for-each-ref`) |

`SyncCoreError.code` → HTTP: `invalid_path`/`invalid_argument` 400 · `not_found` 404 · `stale` 409 ·
`binary`/`unsupported`/`symlink` 422 · `too_large` 413 · `unreadable`/`git`/`tool`/`large_missing` 500 (the code
is passed through in `ErrorBody.code`). Every mutation (baseline, push, accept, reject, restore,
download, turn snapshot, Write/Edit in the project, watcher events) triggers `review_changed{projectId,
localCommit, pendingFiles}` - debounced per project to at most one per second, computed only when
the user has a live WebSocket.

**Hooks and the project lock** (code sessions; in-process SDK hooks, matcher
`Write|Edit|MultiEdit|NotebookEdit`). The project is resolved from the tool's target path (any
session can write into a project, not only those whose cwd is inside it):

- `PreToolUse` takes the project lock (`acquireLock(project.id, {autoReleaseMs: 10 min})`, waiting at
  most 90 s - after that the tool runs without a hold) and keeps it under the tool-use id. Mac pushes,
  review reads and accepts for that project wait until the write is complete; other projects never wait.
- `canUseTool` suspends the hold while a permission prompt is pending (released, and re-acquired only
  if the user allows), so an unanswered prompt never blocks the project.
- `PostToolUse` records `file_touches(project_id, path, session_id, turn, tool, at)` (turn = the
  session's turn number, the same number the snapshot gets) and releases the hold;
  `PostToolUseFailure` and `PermissionDenied` release it too. Bash writes are not recorded
  (the turn snapshot still captures them).
- Every `result` releases whatever the session still holds, then calls
  `repo.snapshot({sessionId, turn, message: first line of the prompt})` for the cwd's project and
  every project the turn wrote to (`refs/snapshots/<session>/<turn>`), then `review_changed`.
  A dying process also releases its holds.
- Hub code that needs the repo from inside a hold would use `hold.run(...)`; the hub itself never
  calls the repo while holding a tool lock.

`Session.projectId` (derived, not stored) is set for code sessions whose cwd is `projects/<name>` or
below. `DiskStatus.projects[]` lists `{id, name, pendingFiles, undownloadedFiles, bytes}` (bytes =
work tree + review repo) for the caller (all users for an admin), refreshed with the `du`
breakdown, which has a "Project history" (`.sync`) row.

## Skills

Storage: user skills `<user root>/.claude/skills/<name>/SKILL.md`, global skills
`<users_root>/_global/skills/<name>/SKILL.md` (frontmatter `name`/`description`). Routes:
`GET /api/skills` (user then global), `GET /api/skills/:name?scope=` (`SkillDetail`; without scope
the user skill wins), `POST /api/skills`, `PUT /api/skills/:name` (a different `body.name` renames),
`DELETE /api/skills/:name?scope=` (default user). Global writes need admin (`403 admin_required`);
duplicates are `409 skill_exists`. The hub keeps/adds the frontmatter and forces `name:` to the
skill name (a missing description becomes the first line of the body). After every change the live
code processes concerned (that user's, or everyone's for a global skill) get `reloadSkills()` and
their slash-command list is refreshed.

**Default: no settings files.** With `sessions.project_settings` off (the default) code sessions run with
`settingSources: []`, which loads no `.claude/skills` at all, so skills come as local plugins (`plugins: [{ type: "local",
path, skipMcpDiscovery: true }]`, passed by the SDK as `--plugin-dir-no-mcp`, which the agent wrapper accepts only for
`<paths.agent_plugins_dir>/<uuid>/(project|workstation)` with nothing on the path writable by the agent):
`<uuid(user)>/workstation` (manifest name `workstation`, `skills/` = symlinks to the user's and the global skills) and
`<uuid(user, cwd)>/project` (name `project`, built by
`buildProjectPlugin` from the cwd's `.claude/skills|commands|agents`: copies with `hooks`, `mcpServers`, `permissionMode`
and `allowed-tools` removed from the frontmatter, skills' other files symlinked, everything confined to the cwd; no
hooks, no MCP, no settings; each is built in a temp folder inside the plugins dir, chmod 0755/0644 and renamed into place by `publishPlugin`). Both are rebuilt at every spawn (and by `reloadSkills`). Claude Code names plugin entries
`<plugin>:<name>` (verified with 2.1.316: `workstation:<skill>`, `project:<skill|command|agent>`); `GET /api/commands`
without a process qualifies the caller's skills the same way. With `settingSources: []` neither `--add-dir`
directories nor project folders load skills, and `CLAUDE.md` is not read (verified; `CLAUDE.local.md` is read only with
the `local` source, which sessions never used), hence the hub-side reading. The rest of this section is the behaviour
with `project_settings` on.

**How sessions find them** (verified live on macOS with Claude Code 2.1.316, see
`test/live.test.ts` and the experiment notes below). With `settingSources: ['project']`, Claude Code
loads `.claude/skills/*` from the cwd **and every parent directory up to the enclosing git
repository root** (the file-system root when there is none); symlinked skill folders are followed,
even when they point outside the cwd. Every code-session cwd lies inside the user root, so:

- user skills need nothing: `<user root>/.claude/skills` is an ancestor of every cwd;
- global skills need one symlink, `<users_root>/.claude/skills -> ../_global/skills`, created at
  startup. It lives outside every workspace, so nothing is ever written into a project (no review
  noise, no sync excludes needed) or into a user's own skills folder;
- synced projects have no `.git` in their work tree, so the walk-up always reaches both. Only a cwd
  inside a **nested git repository** (a clone made in the terminal) stops the walk-up at that repo; such
  sessions get `additionalDirectories: [<data_dir>/skill-overlays/<user>]`, whose
  `.claude/skills/` holds symlinks to the user's and the global skills (user wins on a name clash),
  rebuilt at every spawn. (Claude Code loads `.claude/skills` from additional directories.)

Experiments behind this (each a fresh `query()` + `supportedCommands()`, no model turn): cwd = user
root → user skill; cwd = `projects/p` → user skill (walk-up); per-skill symlinks in the cwd → found
even pointing outside; `<users_root>/.claude/skills` dir symlink → global skill from both the user
root and a project; cwd = a git repo root or a subdirectory of one → nothing; same + overlay
`additionalDirectories` → both; a local plugin → namespaced `<plugin>:<skill>` (rejected for that
reason). Skills show up in `supportedCommands()` **without** `builtin` (Claude Code's own commands
and bundled skills carry `builtin: true`), which is how `CommandInfo.isSkill` is derived.
`GET /api/commands?sessionId=` returns the session process's own list; without a session (or
before its first spawn) it is the global catalog plus the caller's skills read from disk.
Chat sessions run with `settingSources: []` and see no skills.

## Deleting users (admin)

`DELETE /api/users/:name?force=` (admin only, `204`). Reserved names (`_system`, `_global`) and admin
usernames are refused (`403 reserved_user`). While one of the user's projects has unaccepted changes
or undownloaded files the answer is `409 user_not_empty` (`details.projects[]` = `{id, name,
pendingFiles, undownloadedFiles}`) unless `force=true`. Then the user's WebSockets get a
`notice{code:"user_deleted"}` and are closed (4003), every session is deleted like a user-initiated
session delete (process closed, rows, Claude's transcripts), terminals are killed, projects removed,
all remaining rows (turns, rules, touches, uploads, terminals, projects, sessions, user) deleted and
`<users_root>/<name>` plus the user's upload scratch and skill overlay removed
(`src/userDelete.ts`). Using the name again later starts a fresh workspace.

Deleting a user also drops its Tailscale binding; the name is free for any login again.

## Identity (`src/identity.ts`, `src/tailscale.ts`)

The username always comes from `X-Workstation-User` / `?user=` (WebSocket: `hello.user`); who may use it
depends on where the request comes from. An `onRequest` hook (`src/auth.ts`) classifies every request
(on the open routes `/healthz`, `/api/health`, `/api/readme/:doc`, `/api/visual-cdn/*`, `/api/app/*`
(Mac app releases, per platform `mac` / `mac-intel`, stored as `<releases dir>/<platform>/<version>-<build>/`),
`/download/:platform/:version` and the web page `/download`, no username is needed and only the LAN refusal below
applies, plus the self-caller refusal below), after the `Host` check (`registerHostGuard`: `421 bad_host` unless the
host is `public_url`'s, an `allowed_origins` host, this server's Tailscale name or address, loopback, or with
`lan_access` not `deny` one of the machine's addresses; the health routes are exempt) and the cross-site check:

1. **Which socket.** The trust level comes from the listener the request arrived on (`src/listen.ts` tags every connection),
   never from headers (invariants at the top of `src/identity.ts`). *Public socket* (nginx): exactly one `X-Forwarded-For`
   value that is an IP address (nginx sets `$remote_addr`) or `400 proxy_header_invalid`, on every route and WebSocket
   upgrade (the health routes may answer without it). *Local socket* (the status service): the local service caller,
   header identity; an `X-Forwarded-For` header there is `400 proxy_header_invalid`. With `server.listen = "tcp"`
   (development): a loopback peer without the header is a local tool, a loopback peer with it is nginx on the same
   machine, any other peer is its own address.
2. **This server's own address** (the client address is loopback, any address of the machine's interfaces read live, or one
   of the addresses tailscaled reports for this node, cached by the origin policy, `src/origin.ts`): `403 self_caller`, on
   every route and WebSocket upgrade except `/api/health` and `/healthz`. A process on the server calling its own tailnet
   name would otherwise arrive as the node's owner.
3. **Tailscale address** (100.64.0.0/10, fd7a:115c:a1e0::/48) with `auth.tailscale_identity = true`:
   tailscaled is asked who it is (LocalAPI `GET /localapi/v0/whois?addr=<ip>:1` over
   `/run/tailscale/tailscaled.sock`, `tailscale whois --json <ip>` when the socket cannot be used);
   answers are cached 60 s per IP, failures are not cached. The caller is the person's login
   (lower-cased) and node name. Tagged nodes and unknown peers have no login → `403
   tailscale_identity_required`; tailscaled not answering → `503 tailscale_unavailable`.
   With `tailscale_identity = false` tailnet clients keep header identity.
4. **Anything else** (the LAN): `auth.lan_access = "legacy"` keeps header identity; `"deny"` answers
   `403 lan_denied` (the WebSocket upgrade, the web UI and unknown paths included).

Rules: a Tailscale caller may use any username, but the first login that uses a name binds it
(`users.tailscale_login`, also on `POST /api/users` and WebSocket `hello`); another login gets
`403 user_bound` (WebSocket: `error{code:"user_bound"}`, then close 4001). A login may use several
names. Admin = the login is in `auth.admin_logins` (`admin_usernames` does not count for Tailscale
callers). Header-identity callers may use any name (bound or not) and are admin only via
`auth.admin_usernames`. Outside a request (admin user list, disk status, delete protection) a
user bound to a login is admin when that login is, an unbound one when its name is in
`admin_usernames`. `GET /api/users` / `PATCH /api/users/:name` add `tailscaleLogin` (bound login or
null) to each user.

Access to tailscaled: on Linux the socket is normally `srw-rw-rw-` and grants every local account
read access, which is all whois needs, so the hub's account needs nothing extra. Check on the server
with `sudo -u <hub user> tailscale whois --json <tailnet IP of another device>`. If that fails, check that tailscaled
is running; no operator setting is needed for whois, so do not hand the hub's account control of tailscaled.

## Not implemented

- Pasted images are stored inline (base64) in the message payload.
- Skills: zip upload of a skill folder with supporting files (the API writes `SKILL.md` only).
