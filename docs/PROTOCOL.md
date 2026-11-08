<!-- GENERATED FILE. Do not edit by hand. -->
<!-- Source: packages/protocol/src/index.ts. Regenerate with: npx tsx scripts/gen-protocol-docs.mts -->

# Protocol reference

`@agent-workstation/protocol` is the single source of truth for everything that crosses the wire between workstation-hub (server), the web UI and the macOS app.

Protocol version: **1**. This file is generated from the zod schemas in `packages/protocol` by `scripts/gen-protocol-docs.mts`; to change the protocol, edit the schemas and regenerate (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Contents: [Conventions](#conventions) · [Notation](#notation) · [Constants](#constants) · [Shared types](#shared-types) · [REST API](#rest-api) · [WebSocket](#websocket) · [Terminal WebSocket](#terminal-websocket) · [Status service](#status-service)

## Conventions

- Every REST route lives under `/api`. The status service is a separate process and lives under `/status/api`.
- Identity is a username only (no password). Clients send it in the `X-Workstation-User` header on every request and in the WebSocket `hello`. Reachability is enforced by the network layer (Tailscale; see docs/SECURITY.md).
- Paths in file APIs are POSIX, relative to the user's workspace root and never contain `..`; the hub rejects anything that escapes the root.
- Timestamps are ISO 8601 strings (UTC). Sizes are bytes. Percentages 0–100.
- Schemas are zod; the exported `type`s are inferred from them so the hub can validate at runtime and the clients get the same static types.

## Notation

Listings are TypeScript-like and derived from the zod schemas.

| Notation | Meaning |
|---|---|
| `key: T` / `key?: T` | required key / key may be absent |
| `T \| null` | key present, value may be `null` (nullable) |
| `int` | integer; `number` is any JSON number |
| `string(uuid)`, `string(/re/)` | string with a format or regular expression |
| `string(len ≤200)`, `int(≥0)`, `number(0..100)` | length / numeric bounds |
| `T[]`, `T[](len ≥1)` | array, optionally with a minimum length |
| `unknown` | any JSON value; zod infers `unknown` keys as optional, so receivers must tolerate a missing key |
| `Name` | a named type defined elsewhere in this document |
| `// default: x` | value used when the key is omitted (request side) |

## Constants

| Name | Value | Meaning |
|---|---|---|
| `USER_HEADER` | `X-Workstation-User` | Request header that carries the username on every REST call (and in the WebSocket `hello`). |
| `USER_QUERY_PARAM` | `user` | Fallback for requests that cannot carry custom headers (browser WebSocket upgrades, `<a href>` downloads, `<img src>` previews): `?user=<name>`. The header wins when both are present. |
| `UPLOAD_CHUNK_BYTES` | `4194304 (4 MiB)` | Upload chunk size. Every chunk except the last must be exactly this size. |
| `MAX_SYNC_FILE_BYTES` | `104857600 (100 MiB)` | Files larger than this are skipped by sync, accept and download, with a notice. |
| `LARGE_FILE_POINTER_HEADER` | `workstation-large v1` | The pointer the review git stores for a large file (exact bytes, LF line ends): "workstation-large v1\n" + "sha256 <64 hex>\n" + "size <decimal bytes>\n". A blob that starts with the first line is a pointer. |
| `SYNC_LARGE_FILE_PROMPT_BYTES` | `104857600 (100 MiB)` | A file larger than this never syncs until the person approves it in the Sync panel, even inside an approved folder, because every version of it is kept on the server. The pending item carries that reason, e.g. "2.3 GB large file: each synced version is kept on the server". |
| `LARGE_FILE_CHUNK_BYTES` | `16777216 (16 MiB)` | Chunk size for large-file uploads (the last chunk may be shorter). |
| `BASELINE_ENCODING_HEADER` | `X-Baseline-Encoding` | POST /api/projects/:id/baseline body encoding: absent (or "tar.zst") = zstd-compressed tar (the default the Mac app sends); "tar" = an uncompressed tar. |
| `PROTOCOL_VERSION` | `1` | Wire version. Additive changes keep it; it only changes for breaking changes. |
| `MAX_USER_INSTRUCTIONS` | `12000` | Longest `User.instructions` the hub stores (characters). |

`NOTICE_CODES`:

```json
[
  "remote_disabled",
  "weekly_limit",
  "disk_warn",
  "disk_block",
  "api_limit_warning",
  "api_limit_reached",
  "api_unavailable",
  "pricing_updated",
  "pricing_check_failed",
  "process_died",
  "agent_firewall_inactive"
]
```

## Shared types

Scalars, enums and entities that appear in several routes and events. Named types in later listings refer to these.

### Scalars and enums

```ts
type Username = string(/^[a-z0-9_-]{1,32}$/)

type SessionKind = "chat" | "code"

// Mirrors the Agent SDK's PermissionMode. `manual` is not used (it is an alias of default).
type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

// idle            - no turn running; a CLI process may or may not be alive.
// queued          - a user message is waiting for a process slot.
// running         - a turn is in progress.
// requires_action - waiting on a permission answer from the user.
// dead            - the CLI process died mid-turn; next message respawns it.
type SessionStatus = "idle" | "queued" | "running" | "requires_action" | "dead"

type RelPath = string(len ≥1)  // non-empty; no leading '/', no '..' segment, no NUL (custom refinement)

type StoredMessageKind = "user" | "assistant" | "result" | "system" | "reset"

type DiskLevel = "ok" | "warn" | "block"
```

### User

```ts
type User = {
  name: Username
  createdAt: string
  isAdmin: boolean
  enabled: boolean
  terminalEnabled: boolean
  weeklyTokenLimit: int(≥0) | null  // Rolling 7-day input+output token cap. null = unlimited.
  modelAllowlist: string[] | null  // Model ids the user may pick. null = all models the hub offers.
  // The user's own default for new sessions when the client sends no `model`. null = follow the
  // server default (`AdminSettings.defaultModel`, "opus" unless configured).
  defaultModel?: string | null
  // The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort`
  // ("high" unless configured).
  defaultEffort?: EffortLevel | null
  memoryEnabled?: boolean  // Whether Claude keeps and uses memories for this user (default true).
  // The user's own instructions for every agent (like Claude's personal preferences): free
  // text, included verbatim in the system context of every Chat and Code session, after Agent
  // Workstation's own guide. Empty = none.
  instructions?: string(len ≤12000)
  // Global notification switch (the Mac app's system notifications); absent = on. Off: no
  // session notifies, whatever its own switch says.
  notificationsEnabled?: boolean
  // Admin views only (GET /api/users, PATCH /api/users/:name): the Tailscale login this
  // username is bound to; null = none.
  tailscaleLogin?: string | null
}
```

### ModelInfo

```ts
type ModelInfo = {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: EffortLevel[]
  supportsAutoMode?: boolean
  family?: string  // Model family for grouping, e.g. "opus", "fable", "sonnet", "haiku".
  // true for older versions of a family (anything but the newest per family): pickers show them
  // under a "More models" submenu, like the Claude apps. The newest of each family, the user's
  // default and the session's current model are always at the top level.
  legacy?: boolean
}
```

### CommandInfo

```ts
type CommandInfo = {
  name: string
  description: string
  argumentHint?: string
  isSkill?: boolean  // true when the command is a user skill rather than a built-in.
}
```

### ContextUsage

Context-window usage of a session, like Claude Code's `/context`: how full the model's window is and, when the hub could obtain it, what fills it. Refreshed by the hub when a turn ends (`context_usage` event; also on the Session object). `breakdown` is null when only the totals are known.

```ts
type ContextUsage = {
  usedTokens: int(≥0)  // Tokens in the last request's context (input + cache read + cache creation).
  windowTokens: int(>0)  // The model's context window.
  model: string | null
  // Categories in display order, e.g. system_prompt, system_tools, mcp_tools, skills, memory,
  // messages, autocompact_buffer.
  breakdown: { key: string, label: string, tokens: int(≥0) }[] | null
  updatedAt: string
}
```

### Session

```ts
type Session = {
  id: string(uuid)
  user: Username
  kind: SessionKind
  title: string
  // Working directory relative to the user's workspace root ("" = root; "projects/foo" for a
  // synced project; ".chat" for chat).
  cwd: string
  cwdAbs?: string  // Derived (not stored): absolute path of `cwd` on the server. Absent on older hubs.
  model: string
  permissionMode: PermissionMode
  // The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort`
  // ("high" unless configured).
  effort: EffortLevel | null
  status: SessionStatus
  queuePosition: int(>0) | null  // Position in the process queue when status === "queued" (1-based).
  claudeSessionId: string | null
  createdAt: string
  lastActiveAt: string
  lastSeq: int(≥0)  // Sequence number of the last persisted message (0 when empty).
  costUsd: number(≥0)  // Estimated cost (USD, list price) accumulated from result messages.
  // Derived (not stored): the synced project whose work tree contains `cwd` (`projects/<name>`
  // or below), null for code sessions outside any project. Omitted by older hubs.
  projectId?: string(uuid) | null
  // Context-window usage after the last turn; null/absent before the first turn.
  contextUsage?: ContextUsage | null
  // Set on a subagent's session: the session whose agent started it (with the Agent Workstation
  // subagent tool). Such sessions are hidden from session lists and search; they are opened
  // from the parent's transcript. Absent/null = a normal session.
  parentSessionId?: string(uuid) | null
  // This session's notification switch; absent = on. Only effective while the user's global
  // switch is on.
  notify?: boolean
  // Uuids of the messages the user pinned in this session (Code sessions), in pin order; absent
  // = none.
  pinnedMessages?: string[]
  // Incognito chat (like claude.ai): never listed in GET /api/sessions or search, never reads
  // or writes memory, no search summary. Its messages (in the hub and in the CLI transcript)
  // are deleted when the person ends it (DELETE - the client sends it on "New chat" or when
  // leaving the session) and, as a safety net, when the hub restarts. Token usage is still
  // counted (numbers only, no content).
  incognito?: boolean
}
```

### StoredMessage

Persisted message. `payload` is the raw Agent SDK message (SDKUserMessage / SDKAssistantMessage / SDKResultMessage / SDKSystemMessage / ...) stored verbatim; the UI renders from it. Partial `stream_event`s are never persisted.

kind "reset" = the SDK's `conversation_reset` message, stored verbatim:

```text
`{ type: "conversation_reset", uuid, session_id, new_conversation_id,
   trigger?: "clear" | "plan_mode_exit" | "fresh_session" | "onboarding",
   user_message_uuid?, timestamp? }`
```

It marks the point where Claude started a fresh conversation (/clear, /reset, /new, plan-mode exit with "clear context"); messages before it are no longer in Claude's context. The session keeps its id and history; the next `system/init` carries the new `claudeSessionId`.

```ts
type StoredMessage = {
  seq: int(>0)
  sessionId: string(uuid)
  uuid: string
  kind: StoredMessageKind
  payload?: unknown
  at: string
}
```

### Attachment

```ts
type Attachment =
  | { type: "image", mediaType: string, dataBase64: string, name?: string }
  | { type: "file_ref", path: RelPath }
```

### FileRefMeta

A file attachment as shown back to people (name, size and type resolved by the hub).

```ts
type FileRefMeta = { type: "file_ref", path: RelPath, name: string, size: int(≥0), mediaType: string }
```

### UserMessageMeta

Extra `hub` key on a stored user message payload, present when the message carried attachments: the text the person typed and the files they attached, for display as chips. The SDK content blocks hold the prompt as sent to Claude (file pointers in Code sessions, inlined documents in Chat sessions).

```ts
type UserMessageMeta = { text: string, attachments: FileRefMeta[] }
```

### Memory

One thing Claude remembers about a user across Chat sessions (and reads in Code sessions). Saved by Claude through its `remember` tool when the user shares something durable or asks it to, or added by the user on the Memory page. Per user, stored on the hub, so it follows the username to every device.

```ts
type Memory = {
  id: string
  text: string
  // `claude` = saved by Claude during a conversation, `user` = typed on the Memory page / in
  // the app.
  source: "claude" | "user"
  sessionId: string(uuid) | null  // The session Claude saved it from, when `source` is `claude`.
  createdAt: string
  updatedAt: string
}
```

### MemoryBody

```ts
type MemoryBody = { text: string(len 1..2000) }
```

### MemoriesResponse

GET /api/me/memories - newest first.

```ts
type MemoriesResponse = { memories: Memory[] }
```

### SearchHit

Search across the user's sessions (Chat and Code; incognito sessions never appear). Two result lists shown side by side, not a mode switch:

- keyword (GET /api/search): full-text + trigram fuzzy match over titles and message text, newest first, with a highlighted snippet (`«…»` marks the matched terms);
- relevant (GET /api/search/relevant): Claude Haiku ranks sessions by meaning using per-session summaries the hub keeps (written by Haiku after a session goes idle), each hit with a one-line `reason`. Needs the API key and budget; otherwise 503 `api_unavailable` (clients hide the list).

```ts
type SearchHit = {
  session: Session
  // Matched text with `«` `»` around the hits (keyword), or the session summary (relevant).
  snippet: string | null
  // When the matched message was written (keyword) or the session's last activity (relevant).
  at: string
  reason?: string  // Relevant results only: why the model thinks this session matches (one sentence).
}
```

### RawQuery

Mac-side backups kept on the server. Before a client overwrites or deletes a local file that has edits the server has never seen, it uploads that local version here. Backups live in their own ref namespace (`refs/backups/<client>/<id>`) of the project's review repo: they never touch the `local` branch, the working tree Claude edits, review, or history snapshots. Never pruned automatically.

```ts
type RawQuery = {
  path: string(len ≥1)
  // A commit id, ref name (e.g. "local", "refs/backups/mac/…") or blob id; omitted = working
  // tree.
  ref?: string
  // "1"/"true" = inline preview (served with a `sandbox` CSP); anything else = download.
  inline?: "0" | "1" | "true" | "false"
}
```

### ProjectBackupBody

```ts
type ProjectBackupBody = {
  client: string(len 1..100)  // Who is backing up (e.g. "mac:<hostname>").
  reason: "overwrite" | "delete" | "manual"
  // At most 50 MB decoded per request; split larger batches.
  files: { path: string(len ≥1), dataBase64: string, mode?: int }[](len ≥1, len ≤500)
}
```

### ProjectBackup

```ts
type ProjectBackup = {
  id: string
  ref: string
  commit: string
  client: string
  reason: "overwrite" | "delete" | "manual"
  at: string
  files: { path: string, blob: string, size: int(≥0) }[]
}
```

### ProjectBackupsResponse

```ts
type ProjectBackupsResponse = { backups: ProjectBackup[] }
```

### ShowVisualInput

Show a visual inline in the transcript (chat and code). Stored tool name: `mcp__workstation-visual__show_visual`; input `{ title (≤120 chars), svg | html (exactly one, ≤200 KB) }`.

```ts
type ShowVisualInput = { title: string(len ≤120), svg?: string, html?: string }
```

### PricePeriodInfo

List prices (USD per million tokens) per model and period: built-in, config and price-check overrides; costs use the period valid at each request/turn. Entries carry explicit cache prices (`cacheReadPerMtok`, cache-write factors) where known; `cacheReadFactor` × input otherwise.

```ts
type PricePeriodInfo = {
  model: string
  from: string | null
  inputPerMtok: number(>0)
  outputPerMtok: number(>0)
  cacheReadFactor: number(≥0)
  cacheReadPerMtok?: number(≥0)
  cacheWrite5mFactor?: number(≥0)
  cacheWrite1hFactor?: number(≥0)
  source: "builtin" | "config" | "override"
}
```

### PricingCheck

```ts
type PricingCheck = {
  id: int
  at: string
  trigger: "schedule" | "admin"
  outcome: "updated" | "unchanged" | "rejected" | "failed"
  model: string
  inputPerMtok: number | null
  outputPerMtok: number | null
  cacheReadPerMtok: number | null
  effectiveFrom: string | null
  previousInputPerMtok: number | null
  previousOutputPerMtok: number | null
  message: string | null
}
```

### AdminPricedModel

One priced model in the admin view.

```ts
type AdminPricedModel = { model: string, current: PricePeriodInfo | null, periods: PricePeriodInfo[] }
```

### AdminPricingResponse

Every priced model, the price checks and the next scheduled one.

```ts
type AdminPricingResponse = {
  models: AdminPricedModel[]
  lastCheck: PricingCheck | null
  checks: PricingCheck[]
  nextCheckAt: string | null
}
```

### AdminPricingRefreshResponse

```ts
type AdminPricingRefreshResponse = { check: PricingCheck, pricing: AdminPricingResponse }
```

### SearchQuery

```ts
type SearchQuery = { q: string(len 1..500), limit?: int(1..100) }
```

### SearchResponse

```ts
type SearchResponse = { hits: SearchHit[] }
```

### RelevantSearchResponse

503 api_unavailable without an API key or budget; `cached` = served from the hub's per-query cache.

```ts
type RelevantSearchResponse = { hits: SearchHit[], model: string, cached: boolean }
```

### FileEntry

```ts
type FileEntry = {
  path: RelPath
  name: string
  kind: "file" | "dir" | "symlink"
  size: int(≥0)
  mtime: string
  // Set for files under a synced project that are new/modified relative to `local`.
  reviewStatus?: "added" | "modified" | "deleted" | "renamed"
}
```

### Project

```ts
type Project = {
  id: string(uuid)
  user: Username
  name: string(/^[A-Za-z0-9._-]{1,64}$/)
  path: string  // Always `projects/<name>` relative to the workspace root.
  createdAt: string
  localCommit: string | null  // Commit hash of the `local` branch (what the Mac has).
  pendingFiles: int(≥0)
  sizeBytes: int(≥0)
  origin: string | null  // Origin machine identifier chosen by the Mac app (hostname), informational.
}
```

### ReviewFile

```ts
type ReviewFile = {
  path: RelPath
  status: "added" | "modified" | "deleted" | "renamed" | "typechange"
  oldPath?: RelPath
  binary: boolean
  additions: int(≥0)
  deletions: int(≥0)
  sizeBytes: int(≥0)
  // A large file (> MAX_SYNC_FILE_BYTES on either side): whole-file accept/reject only;
  // `binary` is true.
  large?: boolean
  // Large files: the size on the `local` side (the Mac's version) when there is one.
  oldSizeBytes?: int(≥0)
  lastTouchedBy: { sessionId: string(uuid), turn: int, tool: string, at: string } | null
}
```

### Hunk

```ts
type Hunk = {
  index: int(≥0)  // Stable id = index in the unified diff for this file at `localCommit`.
  oldStart: int
  oldLines: int
  newStart: int
  newLines: int
  header: string
  lines: string[]  // Raw hunk body lines including the leading ' ', '+', '-' markers.
}
```

### FileDiff

```ts
type FileDiff = {
  path: RelPath
  localCommit: string | null
  // sha256 of the unified diff this listing was computed from. Send it back with hunk-level
  // accept/reject; a mismatch means the file changed meanwhile (409 `stale_diff`).
  diffId: string
  binary: boolean
  // Full text of both sides for side-by-side rendering (omitted for binary / > 2 MB).
  oldText: string | null
  newText: string | null
  hunks: Hunk[]
}
```

### Snapshot

```ts
type Snapshot = {
  ref: string
  sessionId: string(uuid) | null
  turn: int | null
  at: string
  message: string
  // "snapshot" = end of an agent turn, "sync" = local push, "trash" = pre-destructive backup,
  // "accept" = review accept.
  kind: "snapshot" | "sync" | "trash" | "accept"
}
```

### Skill

```ts
type Skill = {
  name: string(/^[a-z0-9-]{1,64}$/)
  description: string
  scope: "user" | "global"
  updatedAt: string
}
```

### ApiCredits

API-credit spend this budget month: the metered requests of every Claude process and of the hub's own helpers, at list price. `percent` = spent / limit (null when the limit is 0); severity warning from 80 %, critical from 95 %.

```ts
type ApiCredits = {
  spentUsd: number(≥0)
  limitUsd: number(≥0)
  percent: number(≥0) | null
  periodStart: string
  resetsAt: string
  severity: "normal" | "warning" | "critical" | "unknown"
}
```

### UsageLimits

GET /api/usage/limits and the `usage_limits` event. `api` is null when no API key is configured.

```ts
type UsageLimits = { api: ApiCredits | null }
```

### TokenUsageBucket

```ts
type TokenUsageBucket = {
  bucket: string  // ISO date or datetime that starts the bucket.
  model: string
  inputTokens: int
  outputTokens: int
  cacheReadTokens: int
  cacheCreateTokens: int
  costUsd: number
  turns: int
  displayName?: string  // Model display name from the catalog (clients fall back to `model`).
}
```

### DiskStatus

```ts
type DiskStatus = {
  level: DiskLevel
  usedPercent: number
  totalBytes: int
  freeBytes: int
  warnPercent: number
  blockPercent: number
  // Breakdown for the current user (and all users for admin).
  breakdown: { label: string, user: Username | null, path: string, bytes: int }[]
  // Per-project pending counts so the warning can say what to pull back.
  projects: { id: string(uuid), name: string, pendingFiles: int, undownloadedFiles: int, bytes: int }[]
}
```

### AdminSettings

```ts
type AdminSettings = {
  remoteClaudeEnabled: boolean
  diskWarnPercent: number
  diskBlockPercent: number
  defaultWeeklyTokenLimit: int(≥0)
  // Server-wide default model for new sessions; a user's own `User.defaultModel` wins over it.
  // Config `sessions.default_model`, "opus" out of the box.
  defaultModel: string
  // Server-wide default effort for new sessions (null = the CLI's own default);
  // `User.defaultEffort` wins over it. Config `sessions.default_effort`, "high" out of the box.
  defaultEffort: EffortLevel | null
  // Monthly API budget in USD (admin-set; 0 = no session can start). Default 100.
  apiMonthlyLimitUsd?: number(≥0)
  // Day of month (1–28) the API budget resets, in the hub's local time. Default 1.
  apiResetDay?: int(1..28)
  // The last this-many USD of the period's API budget are kept for Agent Workstation's own
  // services (the docs assistant, search, summaries, the download check, the price check):
  // sessions are refused once remaining ≤ this; the services run until the budget is spent.
  // Default 2.
  serviceReserveUsd?: number(≥0)
}
```

### PermissionRequest

```ts
type PermissionRequest = {
  requestId: string
  sessionId: string(uuid)
  toolName: string
  input?: unknown
  toolUseId?: string
  // Suggestions from the SDK (e.g. "always allow Bash(npm test)"). Opaque, echoed back on
  // allow.
  suggestions?: unknown[]
  // Set when the question is whether the server browser may be used on a website at all (like
  // Claude in Chrome's site permission): the first browser call that would load or read a page
  // of an origin this user has not granted. Answers: allow (this session only), allow +
  // `remember: "user"` (always, stored as a BrowserSiteGrant), deny.
  browserSite?: { origin: string }
  // Set when the request comes from a subagent of this session (Agent Workstation's
  // run_subagent): the child session that asked. `sessionId` stays the parent (the card shows
  // in the parent's view); answering resolves the child's request.
  subagent?: { sessionId: string(uuid), description: string }
  at: string
}
```

### BrowserSiteGrant

A website the user always allows the server browser on (scheme://host[:port]).

```ts
type BrowserSiteGrant = { origin: string, grantedAt: string, lastUsedAt: string | null }
```

### BrowserSitesResponse

```ts
type BrowserSitesResponse = { sites: BrowserSiteGrant[] }
```

### BrowserSiteQuery

```ts
type BrowserSiteQuery = { origin: string(len 1..300) }
```

### PermissionResponse

```ts
type PermissionResponse = {
  requestId: string
  behavior: "allow" | "deny"
  updatedInput?: unknown  // Only with allow: replaces the tool input.
  message?: string  // Only with deny: shown to Claude.
  // Persist a rule so the same tool/input pattern is auto-allowed for this session or user.
  remember?: "session" | "user"
}
```

## REST API

All routes live under `/api` and need the user header (see [Conventions](#conventions)). JSON bodies use `Content-Type: application/json`.

`// no request or response body defined by the protocol` means the protocol declares no body for that direction; clients must not depend on one. The reference hub answers creation with `201` and deletion with `204` and no body. Routes under `/api/admin` and routes marked admin only require an admin identity and fail with the error code `admin_required` otherwise.

### Errors

Every non-2xx response carries a JSON `ErrorBody`. Clients branch on `code` when present and show `error` to the user.

```ts
type ErrorBody = { error: string, code?: string, details?: unknown }
```

Error codes (`ERROR_CODES`, non-exhaustive). The HTTP column is filled for the codes the protocol maps to a status; for the others the hub picks the status that fits the failure.

| `code` | HTTP | Meaning |
|---|---|---|
| `invalid_request` |  | The request failed schema validation (bad body, query or path). |
| `user_required` |  | No username was supplied (`X-Workstation-User` header or `?user=`). |
| `reserved_user` |  | The username is reserved for internal use. |
| `admin_required` | 403 | The route needs an admin identity. |
| `not_found` |  | The session, project, file or route does not exist for this user. |
| `remote_disabled` | 403 | An admin switched remote sessions off; new turns are refused. |
| `user_disabled` | 403 | An admin disabled this user. |
| `weekly_limit` | 429 | The user's rolling 7-day token limit is used up. |
| `disk_block` | 507 | Disk usage is above the block threshold; writes are refused (read-only protection). |
| `model_not_allowed` |  | The model is not in the user's allowlist. |
| `terminal_disabled` |  | The terminal feature is disabled for this user. |
| `path_outside_workspace` |  | The path escapes the user's workspace root. |
| `upload_incomplete` |  | An upload was finalised or used before all chunks arrived. |
| `permission_not_found` |  | No pending permission request with that id. |
| `stale_diff` | 409 | The diffId sent with a hunk-level accept/reject no longer matches the file; refetch the diff. |
| `project_not_empty` | 409 | The project still has pending review changes or undownloaded files; pass discardRemaining to delete anyway. |
| `sync_conflict` | 409 | A pushed file could not be merged with the server's working tree; resend with force or fetch the server's version. |
| `project_exists` | 409 | A project with that name already exists for this user. |
| `user_not_empty` |  | The user still has projects with unaccepted changes or undownloaded files; pass force=true to delete anyway. |
| `skill_exists` | 409 | A skill with that name already exists in that scope. |
| `stale` | 409 | The project's `local` branch moved since the client last looked; refetch and retry. |
| `invalid_path` | 400 | A project path is absolute, contains `..`/`.git` segments or is otherwise not allowed. |
| `too_large` | 413 | The request body or file exceeds a size limit (files: MAX_SYNC_FILE_BYTES). |
| `binary` | 422 | A hunk-level operation was requested on a binary (or > 2 MB) file; accept or reject the whole file. |
| `unsupported` |  | The operation does not apply to this kind of change (e.g. hunks on a rename). |
| `symlink` |  | A symlink is in the way; symlinks are never synced or accepted. |
| `memory_limit` |  | The user already has the maximum number of memories; remove some first. |
| `api_unavailable` | 503 | No Anthropic API key is configured, or the monthly budget is 0; sessions and the hub's own API services cannot run. |
| `api_limit_reached` | 429 | This month's API-credit budget is used up. |
| `search_failed` |  | The helper model failed while ranking relevant search results. |
| `user_bound` |  | 403: the username is bound to another Tailscale login; pick a different name. |
| `lan_denied` |  | 403: Agent Workstation only answers over Tailscale (`lan_access = "deny"`). |
| `tailscale_identity_required` |  | 403: the calling Tailscale device has no personal login (a tagged node). |
| `tailscale_unavailable` |  | 503: tailscaled could not be asked who is calling; try again shortly. |
| `busy` |  | 409: the session is being rewound; send again in a moment. |
| `rate_limited` |  | 429: too many requests from this caller; retry after `details.retryAfterS`. |
| `upstream_error` |  | 502: the server could not fetch a visual's library from its CDN. |
| `cross_site` |  | 403: the request came from another web site (`Origin` not allowed, or `Sec-Fetch-Site: cross-site`). See SECURITY.md. |
| `baseline_too_large` |  | 413: a baseline upload exceeded the compressed-size, extracted-size or file-count limit. |
| `baseline_timeout` |  | 408: a baseline upload took longer than the time limit. |
| `baseline_unsupported_entry` |  | 400: a baseline archive holds an entry type that is not accepted (sparse, multi-volume or unknown) or a damaged tar header. |
| `self_caller` |  | 403: the request came from this server itself (a process on the server calling one of its own addresses). See SECURITY.md. |
| `proxy_header_invalid` |  | 400: the request reached the public socket without exactly one `X-Forwarded-For` IP, or the local socket with one. See SECURITY.md. |
| `bad_host` |  | 421: the request's `Host` is not one of this server's names (DNS rebinding protection). See SECURITY.md. |

The pre-send checks on `POST /api/sessions/:id/messages` fail with 403 `remote_disabled`, 403 `user_disabled`, 429 `weekly_limit`, 507 `disk_block`, 503 `api_unavailable`, 429 `api_limit_reached`, 409 `project_exists`, 409 `project_not_empty`, 409 `stale_diff`, 409 `stale`, 409 `sync_conflict`, 400 `invalid_path`, 413 `too_large`, 422 `binary`, 409 `skill_exists`, 403 `admin_required`.

### Route index

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/healthz` |  |  | Plain-text "ok", no auth |
| GET | `/api/health` |  | `HubHealth` | No auth |
| GET | `/api/me` |  | `Me` |  |
| PATCH | `/api/me/preferences` | body `UserPreferencesBody` | `User` |  |
| GET | `/api/me/memories` |  | `MemoriesResponse` |  |
| POST | `/api/me/memories` | body `MemoryBody` | `Memory` |  |
| PATCH | `/api/me/memories/:id` | body `MemoryBody` | `Memory` |  |
| DELETE | `/api/me/memories/:id` |  |  |  |
| GET | `/api/search?q=&limit=` | query `SearchQuery` | `SearchResponse` |  |
| GET | `/api/browser` |  | `BrowserState` |  |
| POST | `/api/browser/start` |  | `BrowserState` |  |
| POST | `/api/browser/stop` |  | `BrowserState` |  |
| GET | `/api/admin/pricing` |  | `AdminPricingResponse` | Admin only |
| POST | `/api/admin/pricing/refresh` |  | `AdminPricingRefreshResponse` | Admin only |
| GET | `/api/search/relevant?q=&limit=` | query `SearchQuery` | `RelevantSearchResponse` |  |
| GET | `/api/models` |  | `ModelsResponse` |  |
| GET | `/api/commands?sessionId=` | query `CommandsQuery` | `CommandsResponse` |  |
| GET | `/api/users` |  | `UsersResponse` | Admin only |
| POST | `/api/users` | body `CreateUserBody` | `User` |  |
| PATCH | `/api/users/:name` | body `PatchUserBody` | `User` | Admin only |
| DELETE | `/api/users/:name?force=` | query `DeleteUserQuery` |  | Admin only |
| GET | `/api/sessions?kind=` | query `SessionsQuery` | `SessionsResponse` |  |
| POST | `/api/sessions` | body `CreateSessionBody` | `Session` |  |
| GET | `/api/sessions/:id` |  | `Session` |  |
| PATCH | `/api/sessions/:id` | body `PatchSessionBody` | `Session` |  |
| DELETE | `/api/sessions/:id` |  |  |  |
| GET | `/api/sessions/:id/messages?after=&limit=` | query `MessagesQuery` | `MessagesResponse` |  |
| POST | `/api/sessions/:id/messages` | body `SendMessageBody` | `SendMessageResponse` |  |
| PATCH | `/api/sessions/:id/settings` | body `SessionSettings` | `Session` |  |
| POST | `/api/sessions/:id/stop` |  | `Session` |  |
| POST | `/api/sessions/:id/close` |  | `Session` |  |
| GET | `/api/app/:platform/latest` |  | `AppRelease` | Platform = mac or mac-intel; no user header; 404 when the server has no release |
| GET | `/api/app/:platform/download` |  | `binary` | No user header; the latest .dmg |
| GET | `/api/app/releases` |  | `AppReleasesResponse` | No user header; every release, for the download page |
| GET | `/download/:platform/:version` |  |  | No user header; that version's .dmg, latest = the newest; /download itself is the web download page |
| GET | `/api/sessions/:id/outputs` |  | `SessionOutputsResponse` |  |
| POST | `/api/sessions/:id/tasks/:taskId/stop` |  |  |  |
| POST | `/api/sessions/:id/rewind` | body `RewindBody` | `RewindResponse` |  |
| POST | `/api/sessions/:id/fork` | body `ForkBody` | `ForkResponse` |  |
| PUT | `/api/sessions/:id/pins/:messageUuid` |  | `Session` |  |
| DELETE | `/api/sessions/:id/pins/:messageUuid` |  | `Session` |  |
| GET | `/api/readme/:doc` |  | `ReadmeDocResponse` | Doc = features or getting-started; no user header; the Markdown of that page |
| POST | `/api/readme/ask` | body `ReadmeAskBody` |  | The docs assistant; Tailscale callers; only while API credits remain |
| GET | `/api/whoami` |  | `WhoAmIResponse` | No user header: who the hub thinks is calling, for signing in without typing a name |
| GET | `/api/me/heads-up/known` |  | `KnownHeadsUpsResponse` |  |
| POST | `/api/me/heads-up/known` | body `KnownHeadsUpBody` | `KnownHeadsUp` |  |
| DELETE | `/api/me/heads-up/known?id=` |  |  |  |
| GET | `/api/files/tree?path=&depth=` | query `TreeQuery` | `TreeResponse` |  |
| GET | `/api/files/content?path=` | query `PathQuery` | `FileContentResponse` |  |
| GET | `/api/files/download?path=` | query `DownloadQuery` | `binary` | Multiple path= → zip |
| PUT | `/api/files/upload` | body `binary` | `UploadChunkResponse` | Chunked, see UPLOAD_HEADERS |
| GET | `/api/files/upload?uploadId=` | query `UploadStatusQuery` | `UploadChunkResponse` | Which chunks the hub already has, for resuming |
| DELETE | `/api/files?path=` | query `PathQuery` |  | User-initiated only |
| POST | `/api/files/mkdir` | body `MkdirBody` | `FileEntry` |  |
| GET | `/api/projects` |  | `ProjectsResponse` |  |
| POST | `/api/projects` | body `CreateProjectBody` | `Project` |  |
| GET | `/api/projects/:id` |  | `Project` |  |
| DELETE | `/api/projects/:id` | query `DeleteProjectQuery`, body `DeleteProjectBody` |  |  |
| POST | `/api/projects/:id/baseline` | body `binary` |  | Tar.zst body |
| POST | `/api/projects/:id/manifest` | body `ManifestBody` | `ManifestResponse` |  |
| PUT | `/api/projects/:id/excludes` | body `ProjectExcludesBody` |  | The unchecked paths; the server excludes only these and .git |
| PUT | `/api/projects/:id/files` | body `SyncBody` | `SyncResult` |  |
| PUT | `/api/projects/:id/large?path=&sha256=&size=&mode=&offset=` |  | `LargeFileUploadResponse` |  |
| GET | `/api/projects/:id/large?path=&sha256=&size=` |  | `LargeFileUploadResponse` |  |
| GET | `/api/visual-cdn/:host/*` |  |  | Libraries for HTML visuals, fetched and cached by the server; open route |
| GET | `/api/projects/:id/review` |  | `ReviewResponse` |  |
| GET | `/api/projects/:id/review/diff?path=` | query `PathQuery` | `FileDiff` |  |
| GET | `/api/me/browser-sites` |  | `BrowserSitesResponse` |  |
| DELETE | `/api/me/browser-sites?origin=` | query `BrowserSiteQuery` |  |  |
| GET | `/api/projects/:id/review/patch` |  | `string` | Text/x-diff: every pending change between local and the work tree |
| POST | `/api/projects/:id/review/accept` | body `AcceptBody` | `AcceptResponse` |  |
| POST | `/api/projects/:id/review/reject` | body `RejectBody` | `RejectResponse` |  |
| GET | `/api/projects/:id/history` | query `HistoryQuery` | `HistoryResponse` |  |
| POST | `/api/projects/:id/restore` | body `RestoreBody` | `RestoreResponse` |  |
| GET | `/api/projects/:id/raw?path=&ref=` | query `RawQuery` | `binary` | Working-tree bytes; with ref = that commit/ref/blob's bytes; large files resolved from the store; supports Range |
| GET | `/api/projects/:id/backups` |  | `ProjectBackupsResponse` |  |
| POST | `/api/projects/:id/backups` | body `ProjectBackupBody` | `ProjectBackup` |  |
| GET | `/api/skills` |  | `SkillsResponse` |  |
| POST | `/api/skills` | body `SkillBody` | `Skill` |  |
| PUT | `/api/skills/:name` | body `SkillBody` | `Skill` |  |
| DELETE | `/api/skills/:name` | query `SkillQuery` |  |  |
| GET | `/api/skills/:name?scope=user\|global` | query `SkillQuery` | `SkillDetail` | SkillDetail; without scope the user skill wins over a global one |
| GET | `/api/usage/limits` |  | `UsageLimits` | No auth: the status service proxies it anonymously |
| GET | `/api/usage/me?range=` | query `UsageRangeQuery` | `MyUsageResponse` |  |
| GET | `/api/disk` |  | `DiskStatus` |  |
| GET | `/api/admin/overview` |  | `AdminOverview` |  |
| GET | `/api/admin/usage?range=` | query `UsageRangeQuery` | `AdminUsageResponse` |  |
| GET | `/api/admin/settings` |  | `AdminSettings` |  |
| PATCH | `/api/admin/settings` | body `PatchAdminSettingsBody` | `AdminSettings` |  |
| GET | `/api/terminals` |  | `TerminalsResponse` |  |
| POST | `/api/terminals` | body `CreateTerminalBody` | `TerminalInfo` |  |
| DELETE | `/api/terminals/:id` |  |  |  |

### Endpoints

#### Other

##### `GET /healthz`

Plain-text `ok` liveness probe for systemd, nginx and the status service. Needs no user header.

```ts
// no request or response body defined by the protocol
```

#### Meta

##### `GET /api/health`

No auth.

```ts
response: {
  ok: true
  version: string
  protocolVersion: 1
  uptimeS: number
  serverTime: string
  // The server's host name (os.hostname()), shown as the machine a session runs on. Absent on
  // older hubs.
  hostname?: string
  // Claude Code's version as the agent account runs it (null = not installed / not known).
  agents?: { claude: string | null }
  processes?: { claude: int(≥0) }  // Live Claude processes (one per running session process).
}
```

##### `GET /api/me`

```ts
response: {
  user: User
  settings: AdminSettings
  disk: DiskLevel
  // An Anthropic API key is configured on the server and the monthly budget is > 0; false =
  // sessions cannot start.
  apiAvailable: boolean
  protocolVersion: 1
}
```

##### `PATCH /api/me/preferences`

The caller's own defaults for new sessions. Omitted fields are kept; null means "follow the server default" (`AdminSettings.defaultModel` / `defaultEffort`, opus / high unless configured). A model outside the caller's `modelAllowlist` is refused with 403 `model_not_allowed`. A user's own defaults for new sessions. Omit a field to leave it; send null to go back
to the server default. A `defaultModel` outside the user's `modelAllowlist` is refused with 403 `model_not_allowed`.

```ts
body: {
  defaultModel?: string(len ≥1) | null
  // The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort`
  // ("high" unless configured).
  defaultEffort?: EffortLevel | null
  memoryEnabled?: boolean
  // Replaces the user's instructions ("" clears them). Running sessions pick them up at their
  // next turn.
  instructions?: string(len ≤12000)
  notificationsEnabled?: boolean  // The global notification switch (see User.notificationsEnabled).
}
response: User
```

##### `GET /api/me/memories`

Newest first. Memories are per user and follow the username to every device. Newest first.

```ts
response: MemoriesResponse
```

##### `POST /api/me/memories`

Adds a memory written by the person (`source: user`). Claude adds its own through the `remember` tool in Chat sessions. One thing Claude remembers about a user across Chat sessions (and reads in Code sessions). Saved by Claude
through its `remember` tool when the user shares something durable or asks it to, or added by the user on the
Memory page. Per user, stored on the hub, so it follows the username to every device.

```ts
body: MemoryBody
response: Memory
```

##### `PATCH /api/me/memories/:id`

One thing Claude remembers about a user across Chat sessions (and reads in Code sessions). Saved by Claude
through its `remember` tool when the user shares something durable or asks it to, or added by the user on the
Memory page. Per user, stored on the hub, so it follows the username to every device.

```ts
body: MemoryBody
response: Memory
```

##### `DELETE /api/me/memories/:id`

204. Nothing else ever deletes a memory: Claude's `forget` tool only runs when the person asks it to.

```ts
// no request or response body defined by the protocol
```

##### `GET /api/models`

(already filtered by the user's modelAllowlist)

```ts
response: ModelInfo[]
```

##### `GET /api/commands`

Names come without the leading "/".

```ts
query: { sessionId?: string(uuid) }
response: CommandInfo[]
```

##### `GET /api/me/heads-up/known`

Heads-ups the user marked as already known, newest first.

```ts
response: { known: KnownHeadsUp[] }
```

##### `POST /api/me/heads-up/known`

Knew this already: stored per user (max 200); the agent's context lists them.

```ts
body: { text: string(len 1..300) }
response: { id: string, text: string(len ≤300), at: string }
```

##### `DELETE /api/me/heads-up/known`

?id= removes one (204).

```ts
query: { id?: string }
```

##### `GET /api/me/browser-sites`

Websites the user always allows the server browser on, most recently used first.

```ts
response: BrowserSitesResponse
```

##### `DELETE /api/me/browser-sites`

Revokes one site (204); the next browser call there asks again.

```ts
query: BrowserSiteQuery
```

#### Search

##### `GET /api/search`

Keyword results, newest first.

```ts
query: SearchQuery
response: SearchResponse
```

##### `GET /api/search/relevant`

Results ranked by Claude Haiku. 503 api_unavailable without an API key or budget; 502 search_failed when the model gave no usable answer. 503 api_unavailable without an API key or budget; `cached` = served from the hub's per-query cache.

```ts
query: SearchQuery
response: RelevantSearchResponse
```

#### Browser

##### `GET /api/browser`

The per-user browser on the server: one Chromium with a persistent profile (logins stick), driven by Claude through
a browser-automation MCP server, viewable and controllable live from the client ("Browser" panel).
Frames are only produced while at least one client has the view open.

```ts
response: {
  running: boolean
  url: string | null
  title: string | null
  // Who acted last: the agent (tool calls) or the person (input from the live view); null when
  // idle.
  controlledBy: "agent" | "user" | null
  sessionId: string(uuid) | null  // Session whose agent last used the browser, if any.
  viewers: int(≥0)
  viewport: { width: int(>0), height: int(>0) }
}
```

##### `POST /api/browser/start`

Starts the user's server browser (also started on demand by agent tool calls). The per-user browser on the server: one Chromium with a persistent profile (logins stick), driven by Claude through
a browser-automation MCP server, viewable and controllable live from the client ("Browser" panel).
Frames are only produced while at least one client has the view open.

```ts
response: {
  running: boolean
  url: string | null
  title: string | null
  // Who acted last: the agent (tool calls) or the person (input from the live view); null when
  // idle.
  controlledBy: "agent" | "user" | null
  sessionId: string(uuid) | null  // Session whose agent last used the browser, if any.
  viewers: int(≥0)
  viewport: { width: int(>0), height: int(>0) }
}
```

##### `POST /api/browser/stop`

Stops it; the profile (logins) is kept. The per-user browser on the server: one Chromium with a persistent profile (logins stick), driven by Claude through
a browser-automation MCP server, viewable and controllable live from the client ("Browser" panel).
Frames are only produced while at least one client has the view open.

```ts
response: {
  running: boolean
  url: string | null
  title: string | null
  // Who acted last: the agent (tool calls) or the person (input from the live view); null when
  // idle.
  controlledBy: "agent" | "user" | null
  sessionId: string(uuid) | null  // Session whose agent last used the browser, if any.
  viewers: int(≥0)
  viewport: { width: int(>0), height: int(>0) }
}
```

#### Admin

##### `GET /api/admin/pricing`

Every priced model, the price checks and the next scheduled one.

```ts
response: AdminPricingResponse
```

##### `POST /api/admin/pricing/refresh`

Runs the price check now: the hub fetches Anthropic's pricing page and Claude Haiku reads it.

```ts
response: AdminPricingRefreshResponse
```

##### `GET /api/admin/overview`

```ts
response: {
  settings: AdminSettings
  usageLimits: UsageLimits
  disk: { level: DiskLevel, usedPercent: number, totalBytes: int, freeBytes: int }
  memory: { totalMiB: number | null, availableMiB: number | null, minFreeMiB: number }
  pool: { active: int, max: int, queued: int }
  // Live Claude Code processes (one per session at most). rssMiB is null where /proc is
  // unavailable.
  processes: Array<{
    sessionId: string(uuid)
    user: Username
    kind: SessionKind
    status: SessionStatus
    pid: int | null
    rssMiB: number | null
    startedAt: string
    lastActiveAt: string
  }>
  users: Array<{
    user: Username
    enabled: boolean
    sessions: int
    weeklyTokens: int
    weeklyLimit: int | null
  }>
}
```

##### `GET /api/admin/usage`

?range= for usage endpoints; default "7d".

```ts
query: {
  range?: UsageRange  // default: "7d"
}
response: {
  users: { user: Username, weeklyTokens: int, weeklyLimit: int | null, costUsd: number, sessions: int }[]
  buckets: Array<{
    bucket: string
    model: string
    inputTokens: int
    outputTokens: int
    cacheReadTokens: int
    cacheCreateTokens: int
    costUsd: number
    turns: int
    displayName?: string
    user: Username
  }>
}
```

##### `GET /api/admin/settings`

```ts
response: AdminSettings
```

##### `PATCH /api/admin/settings`

```ts
body: {
  remoteClaudeEnabled?: boolean
  diskWarnPercent?: number
  diskBlockPercent?: number
  defaultWeeklyTokenLimit?: int(≥0)
  // Server-wide default model for new sessions; a user's own `User.defaultModel` wins over it.
  // Config `sessions.default_model`, "opus" out of the box.
  defaultModel?: string
  // Server-wide default effort for new sessions (null = the CLI's own default);
  // `User.defaultEffort` wins over it. Config `sessions.default_effort`, "high" out of the box.
  defaultEffort?: EffortLevel | null
  // Monthly API budget in USD (admin-set; 0 = no session can start). Default 100.
  apiMonthlyLimitUsd?: number(≥0)
  // Day of month (1–28) the API budget resets, in the hub's local time. Default 1.
  apiResetDay?: int(1..28)
  // The last this-many USD of the period's API budget are kept for Agent Workstation's own
  // services (the docs assistant, search, summaries, the download check, the price check):
  // sessions are refused once remaining ≤ this; the services run until the budget is spent.
  // Default 2.
  serviceReserveUsd?: number(≥0)
}
response: AdminSettings
```

#### Users

##### `GET /api/users`

Admin only. Login screens never call it: a username is typed, not picked from a list, and the same name on any device is the same user.

```ts
response: User[]
```

##### `POST /api/users`

Needs no user header. Creates the user if it does not exist yet (`201`); otherwise returns the existing user (`200`). There is no password: picking a name is how a workspace is created.

```ts
body: { name: Username }
response: User
```

##### `PATCH /api/users/:name`

Admin only.

```ts
body: {
  enabled?: boolean
  terminalEnabled?: boolean
  weeklyTokenLimit?: int(≥0) | null  // Rolling 7-day input+output token cap. null = unlimited.
  modelAllowlist?: string[] | null  // Model ids the user may pick. null = all models the hub offers.
}
response: User
```

##### `DELETE /api/users/:name`

Admin only, 204 on success. Refused with 409 `user_not_empty` (details.projects lists
`{ id, name, pendingFiles, undownloadedFiles }`) while one of the user's projects has unaccepted
changes or undownloaded files, unless `force=true`. Reserved names and admin usernames: 403
`reserved_user`. Removes everything: live processes, sessions (and Claude's transcripts), usage
rows, permission rules, terminals (tmux killed), projects and `<users_root>/<name>`.

```ts
query: { force?: boolean | "0" | "1" | "true" | "false" }
```

#### Sessions

##### `GET /api/sessions`

Newest first.

```ts
query: { kind?: SessionKind }
response: Session[]
```

##### `POST /api/sessions`

```ts
body: {
  kind: SessionKind
  title?: string(len ≤200)
  cwd?: string
  model?: string
  permissionMode?: PermissionMode
  // The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort`
  // ("high" unless configured).
  effort?: EffortLevel | null
  incognito?: boolean  // Chat sessions only (400 for code).
}
response: Session
```

##### `GET /api/sessions/:id`

```ts
response: Session
```

##### `PATCH /api/sessions/:id`

Rename and/or set the session's notification switch (at least one field).

```ts
body: { title?: string(len ≤200), notify?: boolean }
response: Session
```

##### `DELETE /api/sessions/:id`

```ts
// no request or response body defined by the protocol
```

##### `GET /api/sessions/:id/messages`

```ts
query: {
  after?: int(≥0)  // default: 0
  limit?: int(>0, ≤1000)  // default: 500
}
response: StoredMessage[]
```

##### `POST /api/sessions/:id/messages`

`200 { state: "accepted" }` when the turn starts, `202 { state: "queued", position }` when it waits for a process slot. The hub runs its pre-send checks first (see [Errors](#errors)).

```ts
body: {
  // Client-generated UUID; the hub dedupes on it and echoes it on the persisted user message.
  uuid: string(uuid)
  text: string
  attachments?: Attachment[]
}
response: { state: "accepted" | "queued", position: int | null, seq: int }
```

##### `PATCH /api/sessions/:id/settings`

The change takes effect on the server and is broadcast to every subscriber as a `session_settings` event (last writer wins).

```ts
body: {
  model?: string
  permissionMode?: PermissionMode
  // The user's own default effort for new sessions. null = follow `AdminSettings.defaultEffort`
  // ("high" unless configured).
  effort?: EffortLevel | null
}
response: Session
```

##### `POST /api/sessions/:id/stop`

Interrupts the running turn, cancels pending permission requests and marks queued messages cancelled.

```ts
response: Session
```

##### `POST /api/sessions/:id/close`

Releases the process slot. The session and its history are kept.

```ts
response: Session
```

##### `GET /api/sessions/:id/outputs`

Files the session created or changed, newest first (one entry per path).

```ts
response: { outputs: SessionOutput[] }
```

##### `POST /api/sessions/:id/tasks/:taskId/stop`

Stops one background task of the session (SDK stopTask); 204, 404 when the task or a live process is gone.

```ts
// no request or response body defined by the protocol
```

##### `POST /api/sessions/:id/rewind`

404 unknown message, 400 not a user message, 409 unsupported (files without a snapshot). The conversation goes back to just before the user message `messageUuid`: that
message and everything after it leave the transcript (kept in the database, marked rewound, never deleted; clients
get `messages_rewound`). A running turn is stopped first. The agent continues from the kept part (the SDK resumes at
the last kept message).
`files`: also put the session's synced project back to the snapshot taken before that message's turn (the current
state goes to refs/trash first); 409 `unsupported` when there is no such snapshot. `resend`: send the message again
right away, with its original attachments and `text` instead of the original text when given (chat Edit / Retry). `draft`: the removed message's text, for the composer (rewind without resend).

```ts
body: { messageUuid: string, files?: boolean, resend?: { text?: string } }
response: { draft: string, filesRestored: boolean }
```

##### `POST /api/sessions/:id/fork`

201; the new session is a normal session of the same user. A new session (same kind, cwd, model, mode, effort) whose
conversation is this one up to the message `messageUuid`: an assistant message is included; for a user message the
fork ends just before it and its text comes back as `draft` for the new session's composer.

```ts
body: { messageUuid: string }
response: { session: Session, draft: string | null }
```

##### `PUT /api/sessions/:id/pins/:messageUuid`

Pins a message of the session (Session.pinnedMessages); session_updated is broadcast.

```ts
response: Session
```

##### `DELETE /api/sessions/:id/pins/:messageUuid`

Unpins it.

```ts
response: Session
```

#### App

##### `GET /api/app/:platform/latest`

The newest AgentWorkstation.app on the server; 404 not_found when none was deployed. Needs no user header.

```ts
response: {
  platform: AppPlatform
  version: string
  build: string(/^\d{1,20}$/)
  sizeBytes: int(>0)
  sha256: string(/^[0-9a-f]{64}$/)
  publishedAt: string
  // Ed25519 signature (base64) over the UTF-8 string
  // `workstation-release-v1|<platform>|<version>|<build>|<sizeBytes>|<sha256>`, made on the
  // build Mac by scripts/make-app.sh with a private key that never leaves that Mac. The app
  // verifies it with the public key built into it and refuses a release without a valid
  // signature (the server only relays it).
  signature: string(/^[A-Za-z0-9+/]{86}==$/)
}
```

##### `GET /api/app/:platform/download`

Needs no user header.

```ts
response: binary  // AgentWorkstation.dmg (application/x-apple-diskimage)
```

##### `GET /api/app/releases`

No user header; for the download page. Every published release (no user header), newest first per platform; for the download page.

```ts
response: { releases: AppRelease[] }
```

#### :platform

##### `GET /download/:platform/:version`

No user header; the .dmg of that version (`latest` = newest); 404 when unknown.

```ts
// no request or response body defined by the protocol
```

#### Readme

##### `GET /api/readme/:doc`

No user header; 404 for an unknown doc. `assistant`: whether the docs assistant can be used right now (API key present and budget not spent).

```ts
response: { doc: ReadmeDocName, markdown: string, assistant: boolean }
```

##### `POST /api/readme/ask`

SSE stream (delta / done / error); Tailscale callers; 403 api_unavailable without credits; rate limited. The docs assistant: Claude Sonnet 5.5 at medium effort through the API key, answering only from the two pages.
`messages` is the short conversation so far (≤ 20 turns, each ≤ 4,000 chars); the answer streams back as SSE
events `delta` `{ text }` then `done` `{ costUsd }` (or `error` `{ code, message }`). Billed to API credits like
every API-key request; 403 `api_unavailable` when no key is configured or the budget is spent (it may use the
service reserve, `AdminSettings.serviceReserveUsd`).

```ts
body: { messages: { role: "user" | "assistant", text: string(len 1..4000) }[](len ≥1, len ≤20) }
```

#### Whoami

##### `GET /api/whoami`

No user header needed; 403 for refused callers like every other route. Answered without a username. With Tailscale identity: the caller's login and node, the usernames
bound to that login (most recently active first) and `suggested` (the first of them; null when none is bound yet, so
the client asks for a name once and the first request with it binds it). Legacy callers (LAN while allowed, local
tools): `tailscale` null, `users` empty.

```ts
response: { tailscale: { login: string, node: string } | null, users: string[], suggested: string | null }
```

#### Files

##### `GET /api/files/tree`

Flat, depth-first list (dirs first, then files, by name); capped at 5000 entries.

```ts
query: {
  path?: string  // default: ""
  depth?: int(1..10)  // default: 1
}
response: FileEntry[]
```

##### `GET /api/files/content`

```ts
query: { path: RelPath }
response: { path: RelPath, size: int, truncated: boolean, text: string | null, mediaType: string }
```

##### `GET /api/files/download`

One file streams as-is (add `inline=1` to preview); a dir or several paths → zip.

```ts
query: { path: RelPath | RelPath[](len ≥1), inline?: "0" | "1" }
response: binary  // file bytes, or a zip for a directory / several paths
```

##### `PUT /api/files/upload`

Chunked; the headers and resume rules are described under [Chunked upload](#chunked-upload).

```ts
body: binary  // one chunk; metadata travels in the X-Upload-* headers
response: { uploadId: string, received: int[], complete: boolean, path?: RelPath }
```

##### `GET /api/files/upload`

Which chunks the hub already has, for resuming.

```ts
query: { uploadId: string(/^[A-Za-z0-9_-]{8,64}$/) }
response: { uploadId: string, received: int[], complete: boolean, path?: RelPath }
```

##### `DELETE /api/files`

User-initiated only.

```ts
query: { path: RelPath }
```

##### `POST /api/files/mkdir`

→ FileEntry (201). Creates parents as needed.

```ts
body: { path: RelPath }
response: FileEntry
```

#### Projects (sync and review)

##### `GET /api/projects`

The caller's projects, by name.

```ts
response: Project[]
```

##### `POST /api/projects`

```ts
body: { name: string(/^[A-Za-z0-9._-]{1,64}$/), origin?: string }
response: Project
```

##### `GET /api/projects/:id`

```ts
response: Project
```

##### `DELETE /api/projects/:id`

Removes the server copy of the project and its review repository. Refused while there are pending changes or undownloaded files unless `discardRemaining` is true. Also accepts `?discardRemaining=true` (for clients that cannot send a DELETE body).

```ts
query: { discardRemaining?: "0" | "1" | "true" | "false" }
body: {
  // Must be true to delete when pending changes or undownloaded files exist. (default: false)
  discardRemaining?: boolean
}
```

##### `POST /api/projects/:id/baseline`

Send `X-Baseline-Encoding: tar` for an uncompressed tar. A re-import first saves the current work tree in a trash ref.

```ts
body: binary  // tar.zst archive of the local folder, after ignore rules
```

##### `POST /api/projects/:id/manifest`

```ts
body: { entries: ManifestEntry[] }
response: { need: RelPath[], delete: RelPath[], localCommit: string | null }
```

##### `PUT /api/projects/:id/excludes`

204. Replaces the server's exclude list for this project. The paths the person unchecked on the Mac (own `skip` decisions, not inherited ones). The
server excludes exactly these plus `.git`: they never enter the project from the Mac, and files the agent creates there
(a build/ folder, node_modules/) stay out of review. Nothing else is excluded on the server: no built-in defaults, no
in-tree .gitignore. Replaces the previous list; 204. AgentWorkstation.app sends it after linking and whenever decisions change.

```ts
body: { paths: { path: RelPath, kind: "folder" | "file" }[](len ≤10000) }
```

##### `PUT /api/projects/:id/files`

```ts
body: { ops: SyncOp[] }
response: {
  localCommit: string | null
  results: Array<{
    path: RelPath
    status: "applied" | "noop" | "merged" | "conflict" | "need_content" | "skipped"
    reason?: string
  }>
}
```

##### `PUT /api/projects/:id/large`

Body: one raw chunk (≤ LARGE_FILE_CHUNK_BYTES). 409 offset mismatch (body says where to resume), 422 sha256 mismatch, 507 disk_block.

```ts
query: { path?: string, sha256?: string, size?: string, mode?: string, offset?: string }
response: {
  path: RelPath
  received: int(≥0)
  complete: boolean
  // On completion: the sync write's outcome, exactly as a SyncResult entry would report it
  // (`conflict` comes back here with HTTP 200 - 409 means only an offset mismatch).
  result?: { status: "applied" | "noop" | "merged" | "conflict" | "skipped", reason?: string }
  localCommit?: string | null  // On completion: the `local` commit after the write.
}
```

##### `GET /api/projects/:id/large`

Progress of a large-file upload, for resuming.

```ts
query: { path?: string, sha256?: string, size?: string }
response: {
  path: RelPath
  received: int(≥0)
  complete: boolean
  // On completion: the sync write's outcome, exactly as a SyncResult entry would report it
  // (`conflict` comes back here with HTTP 200 - 409 means only an offset mismatch).
  result?: { status: "applied" | "noop" | "merged" | "conflict" | "skipped", reason?: string }
  localCommit?: string | null  // On completion: the `local` commit after the write.
}
```

##### `GET /api/projects/:id/review`

```ts
response: { project: Project, files: ReviewFile[] }
```

##### `GET /api/projects/:id/review/diff`

```ts
query: { path: RelPath }
response: FileDiff
```

##### `GET /api/projects/:id/review/patch`

Text/x-diff: every pending change between local and the work tree.

```ts
response: string  // text/x-diff: one git diff of all pending changes (renames, binaries marked, empty new files)
```

##### `POST /api/projects/:id/review/accept`

```ts
body:
  | {
      path: RelPath
      hunks?: int[]
      diffId?: string  // required when `hunks` is given: the FileDiff.diffId the indices refer to
    }
  | { all: true }
response: {
  localCommit: string
  // Large files come with `contentBase64: null`, `deleted: false`, `large: true`, `sha256` and
  // `size`: download them with ROUTES.projectFileRaw at `ref = localCommit` (HTTP Range) and
  // check the sha256.
  files: Array<{
    path: RelPath
    contentBase64: string | null
    deleted: boolean
    large?: boolean
    sha256?: string
    size?: int(≥0)
  }>
  // Paths that could not be accepted (binary over the size limit, symlinks, ...).
  skipped?: { path: RelPath, reason: string }[]
}
```

##### `POST /api/projects/:id/review/reject`

`RejectBody` is the same schema as `AcceptBody`. → paths whose working-tree content was reverted (a trash ref is written first).

```ts
body:
  | {
      path: RelPath
      hunks?: int[]
      diffId?: string  // required when `hunks` is given: the FileDiff.diffId the indices refer to
    }
  | { all: true }
response: { localCommit: string, trashRef: string | null, paths: RelPath[] }
```

##### `GET /api/projects/:id/history`

Newest first.

```ts
query: { limit?: int(>0, ≤5000) }
response: Snapshot[]
```

##### `POST /api/projects/:id/restore`

→ the trash ref holding the previous work tree and the commit restored from.

```ts
body: { ref: string, path?: RelPath }
response: { localCommit: string, trashRef: string, commit: string }
```

##### `GET /api/projects/:id/raw`

Mac-side backups kept on the server. Before a client overwrites or deletes a local file that has edits the server
has never seen, it uploads that local version here. Backups live in their own ref namespace
(`refs/backups/<client>/<id>`) of the project's review repo: they never touch the `local` branch, the working tree
Claude edits, review, or history snapshots. Never pruned automatically.

```ts
query: RawQuery
response: binary  // bytes of the file in the working tree, or at `ref` when given
```

##### `GET /api/projects/:id/backups`

Newest first.

```ts
response: ProjectBackupsResponse
```

##### `POST /api/projects/:id/backups`

Stores client-side versions in `refs/backups/…`; never touches `local`, the working tree, review or snapshots.

```ts
body: ProjectBackupBody
response: ProjectBackup
```

#### Visual-cdn

##### `GET /api/visual-cdn/:host/*`

Open route. Only cdnjs.cloudflare.com/ajax/libs/ and cdn.jsdelivr.net/npm/ paths, no query; scripts, styles, fonts, JSON, wasm ≤ 8 MB; cached on the server. The web UI rewrites a visual's CDN URLs to this route so devices never contact a CDN.

```ts
// no request or response body defined by the protocol
```

#### Skills

##### `GET /api/skills`

The caller's skills plus the global ones.

```ts
response: Skill[]
```

##### `POST /api/skills`

And PUT /api/skills/:name. `content` = the SKILL.md text; the hub keeps or adds a
frontmatter block and forces its `name:` to the skill name. A PUT whose `name` differs from the
route renames the skill. `scope: "global"` needs admin.

```ts
body: {
  name: string(/^[a-z0-9-]{1,64}$/)
  content: string
  scope?: "user" | "global"  // default: "user"
}
response: Skill
```

##### `PUT /api/skills/:name`

And PUT /api/skills/:name. `content` = the SKILL.md text; the hub keeps or adds a
frontmatter block and forces its `name:` to the skill name. A PUT whose `name` differs from the
route renames the skill. `scope: "global"` needs admin.

```ts
body: {
  name: string(/^[a-z0-9-]{1,64}$/)
  content: string
  scope?: "user" | "global"  // default: "user"
}
response: Skill
```

##### `DELETE /api/skills/:name`

GET/DELETE /api/skills/:name?scope= - which copy to read or delete (DELETE defaults to "user").

```ts
query: { scope?: "user" | "global" }
```

##### `GET /api/skills/:name`

GET/DELETE /api/skills/:name?scope= - which copy to read or delete (DELETE defaults to "user"). `content` is the whole SKILL.md text, frontmatter (`name`, `description`) included.

```ts
query: { scope?: "user" | "global" }
response: {
  name: string(/^[a-z0-9-]{1,64}$/)
  description: string
  scope: "user" | "global"
  updatedAt: string
  content: string
}
```

#### Usage

##### `GET /api/usage/limits`

And the `usage_limits` event. `api` is null when no API key is configured.

```ts
response: UsageLimits
```

##### `GET /api/usage/me`

?range= for usage endpoints; default "7d".

```ts
query: {
  range?: UsageRange  // default: "7d"
}
response: { range: UsageRange, buckets: TokenUsageBucket[], weeklyTokens: int, weeklyLimit: int | null }
```

#### Disk

##### `GET /api/disk`

```ts
response: DiskStatus
```

#### Terminals

##### `GET /api/terminals`

The list is empty when the terminal is disabled globally or for this user.

```ts
response: TerminalInfo[]
```

##### `POST /api/terminals`

```ts
body: { cwd?: string }
response: { id: string, cwd: string, createdAt: string, tmuxSession: string }
```

##### `DELETE /api/terminals/:id`

```ts
// no request or response body defined by the protocol
```

### Chunked upload

Chunked upload: PUT /api/files/upload with these headers; body = raw chunk bytes (any Content-Type; `application/octet-stream` recommended).

- X-Upload-Id: client-chosen id, [A-Za-z0-9_-]{8,64}; reuse it to resume.
- X-Upload-Path: target path relative to the workspace root, percent-encoded (`encodeURIComponent`) so non-ASCII names survive HTTP headers.
- X-Chunk-Index is 0-based; every chunk except the last must be UPLOAD_CHUNK_BYTES.

The hub never overwrites an existing file: if the target exists the file is stored as "name (1).ext" etc. and the final path is returned in `path`.

| Key | Header | Meaning |
|---|---|---|
| `uploadId` | `X-Upload-Id` | Client-chosen upload id; reuse it to resume. |
| `path` | `X-Upload-Path` | Target path in the workspace, percent-encoded. |
| `chunkIndex` | `X-Chunk-Index` | 0-based index of this chunk. |
| `chunkTotal` | `X-Chunk-Total` | Total number of chunks in the upload. |
| `totalBytes` | `X-Total-Bytes` | Total size of the file in bytes. |

To resume an interrupted upload, call `GET /api/files/upload?uploadId=`: the response's `received` array lists the chunk indexes the hub already holds, so only the missing chunks need to be sent. Chunk size is `UPLOAD_CHUNK_BYTES`.

### Supporting types

Named schemas referenced from the listings above.

```ts
// Agent Workstation's subagent tool `run_subagents` (recorded as
// `mcp__workstation_subagent__run_subagents`): the agent proposes a batch and the person
// approves it once (a permission request whose `toolName` is that name and whose `input` is
// RunSubagentsInput; no "always allow"). Approved: all start (at most 2 run at once, the rest
// queue); denied: none. The result text holds one section per agent in input order, sections
// separated by a line `--- subagent ---`; each section starts `session: <child uuid>` (absent
// when it never started), a blank line, the answer, optionally a last line `Files: a, b`.
type SubagentSpec = {
  model?: string
  description: string(len 1..80)
  task: string(len 1..8000)
  // Code sessions (required there; chats' subagents only read the web): the files this subagent
  // may change, as globs relative to the working directory (`src/web/**`, `README.md`). The hub
  // refuses its file edits outside them, and within a batch the first subagent to write a file
  // owns it until it finishes (siblings are refused). Shown on the approval card.
  paths?: string(len 1..200)[](len ≤20)
}

type RunSubagentsInput = { agents: SubagentSpec[](len ≥1, len ≤6) }

// Chats' download tool `download_file` (recorded as `mcp__workstation_fetch__download_file`):
// the hub fetches one https URL in an isolated environment (no access to the server's files;
// GET only, no body, cookies or auth headers; public addresses only; size and time limits) and
// moves the file into the chat's folder. Well-known download hosts are fetched directly; any
// other host is first judged by Claude Haiku: "safe" → fetched, otherwise (or when the check
// cannot run: no API key or budget) the person decides on a permission request whose `input` is
// the DownloadFileInput plus `check`.
type DownloadFileInput = { url: string(uri, len ≤2048), filename?: string(len ≤200) }

type DownloadCheck = { safe: boolean, reason: string(len ≤400) }

type HeadsUpInput = { text: string(len 1..300), detail?: string(len ≤2000) }

// The readme (`/readme` in the web app and the Mac app): two Markdown pages kept in the repo
// (docs/readme/*.md) and served by the hub. They may use
// `<details><summary>…</summary>…</details>` for folded detail. Agents in sessions can read the
// same pages (the `workstation_docs` tool).
type ReadmeDocName = "features" | "getting-started"

// Sync selection (AgentWorkstation.app). Which paths of a linked folder go to the server: -
// when a folder is first linked, a window shows its first level and up to 3 second-level items
// per folder, all checked; the person unchecks what should stay on the Mac (no built-in rules,
// no .gitignore, no AI); - every folder and file then has a decision: `sync`, `skip`, or none
// (undecided, follows its ancestor); - an unchecked folder (`skip`) never syncs anything inside
// it, new or old, and never asks; - a new or changed item whose folder contains anything
// unchecked waits for the person (the Sync tab); in a folder with nothing unchecked it syncs
// automatically; the linked root follows the same rule; - files > SYNC_LARGE_FILE_PROMPT_BYTES
// always ask first (with the reason); `.git` never syncs; cloud-only files (dataless) are never
// read and wait until they are local. Deciding `skip` for something already on the server only
// stops syncing it; the server copy stays (never deleted automatically). The web opens the Sync
// tab with `?panel=sync` on a session URL or a new-session URL
// (`/?new=code&cwd=projects/<name>&panel=sync`). `SyncDecisionSource` values `rule` and `ai`
// only appear on links made before this design; new decisions are `you`.
type SyncDecisionSource = "rule" | "ai" | "you"

// One row of the Sync panel tree (AgentWorkstation.app → web, through the shell bridge).
type SyncEntry = {
  path: RelPath
  kind: "folder" | "file"
  decision: "sync" | "skip" | null  // Own decision; null = undecided (follows its ancestor, or waits).
  // The decision that applies (own or inherited); null = waiting for the person.
  effective: "sync" | "skip" | null
  // Folders: some contents decided differently from the folder (a "mixed" folder when the
  // folder itself is `sync`).
  mixed?: boolean
  source: SyncDecisionSource | null
  // Short reason for a rule or AI decision (rules: a fixed sentence; AI: its own).
  reason: string | null
  bytes: int(≥0)
  files?: int(≥0)  // Folders: number of files beneath.
}

// A new item waiting for the person (undecided parent, the root, or a large file).
type SyncPendingItem = {
  path: RelPath
  kind: "folder" | "file"
  bytes: int(≥0)
  files?: int(≥0)
  // What the rules / the AI suggest; null while the AI is still thinking or when nothing
  // suggested anything.
  suggestion: "sync" | "skip" | null
  source: "rule" | "ai" | null
  reason: string | null
  large?: boolean  // > SYNC_LARGE_FILE_PROMPT_BYTES (a large file).
  detectedAt: string
}

// The person's answer for one path (pending item or any tree row). `null` clears the own
// decision.
type SyncDecisionInput = { path: RelPath, kind: "folder" | "file", decision: "sync" | "skip" | null }

type ManifestEntry = { path: RelPath, hash: string, size: int, mode: int }

type SyncOp =
  | {
      op: "write"
      path: RelPath
      hash: string
      size: int
      mode: int
      baseHash: string | null  // sha256 of the `local` blob the client last saw, or null for a new file
      contentBase64?: string
      force?: boolean
    }
  | {
      op: "delete"
      path: RelPath
      baseHash: string | null  // sha256 of the `local` blob the client last saw, or null for a new file
      force?: boolean
    }

type UsageRange = "today" | "7d" | "30d"

// Release channels of the Mac app: `mac` = Apple Silicon (arm64, also the default), `mac-intel`
// = x86_64.
type AppPlatform = "mac" | "mac-intel"
```

## WebSocket

One WebSocket per client at `/ws`, multiplexed by `sessionId`. Frames are JSON text; every frame has a `type`. Client frames are `ClientEvent`, server frames are `ServerEvent`.

### Connecting and handshake

1. Open `ws://<host>/ws` (or `wss://` behind TLS). Browsers cannot set headers on a WebSocket upgrade, so the username may also be passed as `?user=<name>`; the header wins when both are present.
2. Send `hello { user, protocolVersion }` as the first frame. `protocolVersion` is `PROTOCOL_VERSION`.
3. The hub answers `welcome { user, protocolVersion, serverTime }`. Compare `protocolVersion` with your own and refuse to continue on a mismatch; the version only changes for breaking changes.
4. For each session the client shows, send `subscribe { sessionId, lastSeq }`, where `lastSeq` is the highest `seq` the client already holds (0 for none). The hub replies in this order:
   1. `replay` with every persisted message whose `seq` is greater than `lastSeq`;
   2. `snapshot` with the session row, the in-flight assistant text (`partial`) and any pending permission request;
   3. live events: `message`, `delta`, `session_state`, `session_settings`, `permission_*`, and so on.
5. Keep `lastSeq` up to date from `replay` and `message` events. After a reconnect, repeat `hello` and `subscribe` with the stored `lastSeq`; if a live `message` ever skips a `seq`, re-subscribe the same way.
6. Send `ping` periodically; the hub answers `pong`.

Behaviour worth knowing:

- **Several tabs, one session.** Every subscriber receives every event for the session. Model, permission mode and effort are applied on the server and broadcast as `session_settings`; the last writer wins.
- **Permissions belong to the hub, not the tab.** A `permission_request` stays pending when a tab closes and is re-delivered in the next `snapshot.pendingPermission`. The first `permission_response` from any client wins and is announced with `permission_resolved`; an interrupted turn produces `permission_cancelled`. Unanswered requests are denied (and the turn stopped) after the configured timeout (`sessions.permission_timeout_s`, default 600 s).
- **Deltas are ephemeral.** `delta` events are folded into `snapshot.partial` for late joiners and are never persisted; the final assistant message arrives as a `message` event.
- **User messages are deduplicated by `uuid`.** The client generates the UUID in `POST /api/sessions/:id/messages`; the persisted user message echoes it.
- **Event scope (design).** Session events (`message`, `delta`, `session_state`, ...) go to subscribers of that session; per-user events (session list changes, permission prompts, file and review events) to every connection of the user; global events (`usage_limits`, `notice`) to everyone. See [ARCHITECTURE.md](ARCHITECTURE.md) for the session runtime.

### Client → server events

```ts
// First frame on every connection: identifies the user and the protocol version the client
// speaks.
{ type: "hello", user: Username, protocolVersion: int }

// Subscribe to a session; the hub replies with `replay` then `snapshot`, then live events.
{ type: "subscribe", sessionId: string(uuid), lastSeq: int(≥0) }

// Stop receiving events for a session. Permission requests keep arriving on the user channel.
{ type: "unsubscribe", sessionId: string(uuid) }

// Answer a pending permission request. The first answer from any tab wins.
{ type: "permission_response", sessionId: string(uuid), response: PermissionResponse }

// Keep-alive; the hub answers with `pong`.
{ type: "ping" }

// Open/close the live browser view for this connection (frames flow while on).
{ type: "browser_view", on: boolean, maxWidth?: int(>0) }

// Person's input into the live browser view.
{ type: "browser_input", input: BrowserInput }
```

### Server → client events

```ts
// Reply to `hello`. Carries the resolved user (including `isAdmin`), the server protocol
// version and the server clock.
{ type: "welcome", user: User, protocolVersion: int, serverTime: string }

// `truncated` = only the newest `messages` were sent (long sessions); fetch older ones via GET
// /api/sessions/:id/messages.
{ type: "replay", sessionId: string(uuid), messages: StoredMessage[], truncated?: boolean }

// State of the session right now: the session row, the in-flight assistant text and any pending
// permission request.
{ type: "snapshot", sessionId: string(uuid), snapshot: SessionSnapshot }

// A new persisted message (user, assistant, result, system or reset). `message.seq` increases
// by one per session.
{ type: "message", sessionId: string(uuid), message: StoredMessage }

// Streaming fragment of the in-flight assistant message. Never persisted; superseded by the
// final `message`.
{ type: "delta", sessionId: string(uuid), delta: StreamDelta }

// Status transition (idle, queued, running, requires_action, dead), with the queue position
// while queued.
{
  type: "session_state"
  sessionId: string(uuid)
  status: SessionStatus
  queuePosition: int | null
}

// Model, permission mode or effort changed (by any client, or by the SDK falling back from
// `auto`). Last writer wins.
{
  type: "session_settings"
  sessionId: string(uuid)
  settings: { model: string, permissionMode: PermissionMode, effort: EffortLevel | null }
}

// Includes incognito sessions (`session.incognito: true`): clients must keep them out of
// session lists.
{ type: "session_updated", session: Session }

// The session was deleted by its user.
{ type: "session_deleted", sessionId: string(uuid) }

// Claude wants to use a tool that needs approval. Held by the hub until answered, cancelled or
// timed out.
{ type: "permission_request", request: PermissionRequest }

// A permission request was answered (by whichever client answered first).
{
  type: "permission_resolved"
  sessionId: string(uuid)
  requestId: string
  behavior: "allow" | "deny"
}

// A permission request was withdrawn (turn interrupted or aborted) without an answer.
{ type: "permission_cancelled", sessionId: string(uuid), requestId: string }

// Workspace file created/modified/deleted (chokidar).
{
  type: "file_event"
  path: RelPath
  kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir"
  sessionId: string(uuid) | null
  at: string
}

// The review state of a synced project changed (debounced). Clients re-fetch `GET
// /api/projects/:id/review`.
{
  type: "review_changed"
  projectId: string(uuid)
  localCommit: string | null
  pendingFiles: int
}

// A pushed file could not be merged with the server copy; only that file is held back.
{ type: "sync_conflict", projectId: string(uuid), path: RelPath, reason: string }

// Fresh API-credit figures (after metered usage or a budget change).
{ type: "usage_limits", limits: UsageLimits }

// Disk level or usage changed (ok / warn / block).
{ type: "disk_status", status: DiskStatus }

// The user's memories changed (Claude saved/removed one, or another device edited them):
// refetch GET /api/me/memories.
{ type: "memories_changed" }

// The hub refreshed a session's context-window usage (at turn end).
{ type: "context_usage", sessionId: string(uuid), usage: ContextUsage }

// The session's background tasks changed (the full list: running and ended).
{ type: "background_tasks", sessionId: string(uuid), tasks: BackgroundTask[] }

// The end-of-turn box was set (or cleared: null).
{ type: "next_step", sessionId: string(uuid), step: NextStep | null }

// A rewind: messages with seq >= fromSeq left the transcript (drop them; later messages
// continue with higher seqs).
{ type: "messages_rewound", sessionId: string(uuid), fromSeq: int(>0) }

// Live cost of the running turn (list-price estimate from message usage while it runs; `final`
// with the exact value at the result). `sessionCostUsd` includes the turn. Sent to the
// session's subscribers.
{
  type: "cost_update"
  sessionId: string(uuid)
  turnCostUsd: number(≥0)
  sessionCostUsd: number(≥0)
  final: boolean
}

// The user's server browser changed (started/stopped, navigated, control switched, viewers).
{ type: "browser_state", state: BrowserState }

// One JPEG frame of the live browser view (only to connections with the view on).
{ type: "browser_frame", data: string, width: int, height: int, at: string }

// Global notices: remote Claude disabled, weekly limit reached, API budget used up, etc.
{
  type: "notice"
  level: "info" | "warning" | "error"
  code: string
  message: string
  at: string
}

// A request on this socket failed. `sessionId` is set when the error belongs to a session.
{ type: "error", code: string, message: string, sessionId?: string(uuid) }

// Reply to `ping`.
{ type: "pong" }
```

### StreamDelta

Payload of the `delta` event. A message streams as zero or more `text` / `thinking` fragments and tool-call fragments, then `message_end`.

```ts
// Appended assistant text.
{ part: "text", messageId: string, text: string }

// Appended extended-thinking text.
{ part: "thinking", messageId: string, text: string }

// A tool call began; its input follows as `tool_use_input` fragments.
{ part: "tool_use_start", messageId: string, toolUseId: string, toolName: string }

// Fragment of the tool call's JSON input (concatenate `partialJson` in order).
{ part: "tool_use_input", messageId: string, toolUseId: string, partialJson: string }

// The in-flight message is complete; the persisted `message` event follows.
{ part: "message_end", messageId: string }

// Output tokens so far: `outputTokens` for this message, `turnOutputTokens` summed over the
// whole turn (shown live while Claude works).
{ part: "usage", messageId: string, outputTokens: int(≥0), turnOutputTokens: int(≥0) }
```

### SessionSnapshot

Payload of the `snapshot` event.

```ts
type SessionSnapshot = {
  session: Session
  // In-flight assistant content folded from stream deltas (empty when idle).
  partial: {
    messageId: string | null
    text: string
    thinking: string
    currentTool: { toolUseId: string, toolName: string, partialJson: string } | null
    turnOutputTokens?: int(≥0)  // Output tokens of the running turn so far (0 when idle).
  }
  // When the running turn started (null when idle), for the live elapsed-time indicator.
  turnStartedAt?: string | null
  pendingPermission: PermissionRequest | null
  // Background tasks of the session: running ones and those that ended (newest last), absent on
  // older hubs.
  backgroundTasks?: BackgroundTask[]
  nextStep?: NextStep | null  // The current end-of-turn box (null when none).
  // Seq ranges (inclusive) that were rewound: a reconnecting client drops the messages it holds
  // in them.
  rewound?: int(>0)[](len ≥2, len ≤2)[]
}
```

### Hub system messages

Hub-originated messages persisted alongside SDK messages (kind "system", payload `{ type: "system", subtype, ... }`):

```text
hub_cancelled      { message_uuids: string[], reason }  queued user messages dropped by Stop/Close
hub_process_died   { error }                            the CLI process crashed mid-turn (status → dead)
hub_stop_timeout   {}                                   interrupt got no result within 10 s; process closed
```

SDK system messages that are persisted: init (first per process), status (only with permissionMode/compact_result), compact_boundary, local_command_output, informational. POST /api/sessions/:id/messages answers 200 {state:"accepted"} or 202 {state:"queued", position}.

Subtypes: `hub_cancelled`, `hub_process_died`, `hub_stop_timeout`.

## Terminal WebSocket

`WS /ws/terminal/:id` attaches to a terminal created with `POST /api/terminals`. The user comes from `?user=` or the `X-Workstation-User` header. Frames are JSON text.

Client → server:

```ts
// Keystrokes (or pasted text) typed by the user.
{ t: "in", data: string }

// The terminal viewport changed size.
{ t: "resize", cols: int(>0), rows: int(>0) }
```

Server → client:

```ts
// Output of the pty.
{ t: "out", data: string }

// The shell exited. `code` is null when no exit code is available.
{ t: "exit", code: int | null }
```

### Other WebSocket types

```ts
type BrowserInput =
  | {
      kind: "mouse"
      action: "move" | "down" | "up" | "click" | "dblclick"
      x: number
      y: number
      button?: "left" | "middle" | "right"
      clickCount?: int(1..3)
    }
  | { kind: "wheel", x: number, y: number, deltaX: number, deltaY: number }
  | {
      kind: "key"
      action: "down" | "up" | "press"
      key: string
      modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[]
    }
  | { kind: "text", text: string(len ≤10000) }
  | { kind: "navigate", url: string(uri) }
  | { kind: "history", action: "back" | "forward" | "reload" }

type BackgroundTask = {
  taskId: string
  type: string  // SDK task_type, e.g. "local_bash", "local_agent".
  description: string
  subagentType?: string
  startedAt: string  // When the hub first saw it.
  // Running, or how it ended (SDK task_notification / gone from the list = completed). Absent
  // on older hubs = running.
  status?: "running" | "completed" | "failed" | "stopped"
  endedAt?: string | null  // When it ended (null/absent while running).
}

type SessionOutput = {
  path: RelPath  // Workspace-relative path.
  tool: string  // The tool of the last touch (Write, Edit, MultiEdit, NotebookEdit, …).
  turn: int
  at: string
  missing: boolean  // The file no longer exists in the workspace.
}

type NextStep = {
  recap: string(len 1..600)
  ask?: string(len ≤200)
  actions?: { label: string(len 1..40) }[](len ≤3)
  at: string
}
```

## Status service

`workstation-status` is a separate process (default port 9100) and lives under `/status/api`; the reverse proxy routes `/status*` to it. It does not use the `X-Workstation-User` header.

### Routes

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/status/api/metrics?range=1h\|6h\|24h\|7d\|30d` | `MetricsResponse` |  |
| GET | `/status/api/health` | `HealthResponse` |  |
| GET | `/status/api/stream` | `text/event-stream` | SSE: metrics + health |
| POST | `/status/api/speedtest` |  |  |
| GET | `/status/api/system` |  | Static info: model, kernel, uptime, disks |

### Endpoints

#### `GET /status/api/metrics`

```ts
query: { range?: "1h" | "6h" | "24h" | "7d" | "30d" }
response: { range: string, stepS: int, series: MetricSeries[] }
```

#### `GET /status/api/health`

```ts
response: {
  checks: HealthCheck[]
  events: { at: string, id: string, from: string, to: string, detail: string | null }[]
}
```

#### `GET /status/api/stream`

SSE: metrics + health.

```ts
response: text/event-stream  // SSE; the event payload shapes are not defined in the protocol
```

#### `POST /status/api/speedtest`

```ts
// no request or response body defined by the protocol
```

#### `GET /status/api/system`

Static info: model, kernel, uptime, disks.

```ts
// no request or response body defined by the protocol
```

### Status types

```ts
type MetricPoint = { t: int, v: number | null }

type MetricSeries = { name: string, unit: string, points: MetricPoint[] }

type HealthCheck = {
  id: string
  label: string
  state: "ok" | "warn" | "fail" | "unknown"
  detail: string | null
  checkedAt: string
  latencyMs: number | null
}
```
