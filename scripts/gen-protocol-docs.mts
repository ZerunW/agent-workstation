#!/usr/bin/env -S npx tsx
/**
 * Generates docs/PROTOCOL.md from the zod schemas in packages/protocol.
 *
 *   npx tsx scripts/gen-protocol-docs.mts           write docs/PROTOCOL.md
 *   npx tsx scripts/gen-protocol-docs.mts --check   exit 1 if the file is out of date (CI drift check)
 *
 * Prerequisite: `npm run build -w packages/protocol` (the script imports the built package).
 *
 * How it works
 * - Schemas come from the *runtime* exports of `@agent-workstation/protocol` (every exported zod schema is
 *   converted with zod's `z.toJSONSchema`; named schemas stay named references) and are rendered as
 *   compact TypeScript-like listings.
 * - Prose that cannot be recovered from the runtime (JSDoc, declaration order, section banners) is
 *   read from packages/protocol/src/index.ts by a small comment extractor.
 * - The protocol does not link routes to schemas, so ENDPOINTS below maps `METHOD /path` to the
 *   schema names. Adding a route to ROUTES without a mapping is reported (and fails `--check`).
 * - Output is deterministic: no timestamps, no absolute paths, stable ordering.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths and flags
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SOURCE_PATH = resolve(repoRoot, "packages/protocol/src/index.ts");
const DIST_PATH = resolve(repoRoot, "packages/protocol/dist/index.js");
const OUT_PATH = resolve(repoRoot, "docs/PROTOCOL.md");
const REGEN_CMD = "npx tsx scripts/gen-protocol-docs.mts";
const checkMode = process.argv.includes("--check");

/** Problems that make `--check` fail (missing schema mappings). */
const problems: string[] = [];
/** Non-fatal hints (missing descriptions). */
const warnings: string[] = [];

// ---------------------------------------------------------------------------
// Hand-maintained mappings (the only part of this file that follows the protocol by hand)
// ---------------------------------------------------------------------------

/** A schema reference: a named protocol export, or a literal type text (optionally naming schemas it uses). */
type Ref = string | { text: string; names?: string[] };
interface EndpointSpec {
  query?: Ref;
  body?: Ref;
  response?: Ref;
  /** Extra markdown shown under the endpoint heading. */
  extra?: string;
}

const BINARY = (what: string): Ref => ({ text: `binary  // ${what}` });

/** `METHOD /path` (without the query string) -> schemas. "(none)" means the protocol defines no body. */
const ENDPOINTS: Record<string, EndpointSpec> = {
  "GET /api/health": { response: "HubHealth" },
  "GET /healthz": { extra: "Plain-text `ok` liveness probe for systemd, nginx and the status service. Needs no user header." },
  "GET /api/me": { response: "Me" },
  "GET /api/browser": { response: "BrowserState" },
  "GET /api/app/:platform/latest": { response: "AppRelease", extra: "The newest AgentWorkstation.app on the server; 404 not_found when none was deployed. Needs no user header." },
  "GET /api/app/:platform/download": { response: BINARY("AgentWorkstation.dmg (application/x-apple-diskimage)"), extra: "Needs no user header." },
  "GET /api/sessions/:id/outputs": { response: "SessionOutputsResponse", extra: "Files the session created or changed, newest first (one entry per path)." },
  "GET /api/app/releases": { response: "AppReleasesResponse", extra: "No user header; for the download page." },
  "GET /download/:platform/:version": { extra: "No user header; the .dmg of that version (`latest` = newest); 404 when unknown." },
  "GET /api/readme/:doc": { response: "ReadmeDocResponse", extra: "No user header; 404 for an unknown doc." },
  "PUT /api/projects/:id/excludes": { body: "ProjectExcludesBody", extra: "204. Replaces the server's exclude list for this project." },
  "PUT /api/projects/:id/large": { response: "LargeFileUploadResponse", extra: "Body: one raw chunk (≤ LARGE_FILE_CHUNK_BYTES). 409 offset mismatch (body says where to resume), 422 sha256 mismatch, 507 disk_block." },
  "GET /api/projects/:id/large": { response: "LargeFileUploadResponse", extra: "Progress of a large-file upload, for resuming." },
  "GET /api/visual-cdn/:host/*": { extra: "Open route. Only cdnjs.cloudflare.com/ajax/libs/ and cdn.jsdelivr.net/npm/ paths, no query; scripts, styles, fonts, JSON, wasm ≤ 8 MB; cached on the server. The web UI rewrites a visual's CDN URLs to this route so devices never contact a CDN." },
  "POST /api/readme/ask": { body: "ReadmeAskBody", extra: "SSE stream (delta / done / error); Tailscale callers; 403 api_unavailable without credits; rate limited." },
  "GET /api/whoami": { response: "WhoAmIResponse", extra: "No user header needed; 403 for refused callers like every other route." },
  "GET /api/me/heads-up/known": { response: "KnownHeadsUpsResponse", extra: "Heads-ups the user marked as already known, newest first." },
  "POST /api/me/heads-up/known": { body: "KnownHeadsUpBody", response: "KnownHeadsUp", extra: "Knew this already: stored per user (max 200); the agent's context lists them." },
  "DELETE /api/me/heads-up/known": { extra: "?id= removes one (204)." },
  "POST /api/sessions/:id/rewind": { body: "RewindBody", response: "RewindResponse", extra: "404 unknown message, 400 not a user message, 409 unsupported (files without a snapshot)." },
  "POST /api/sessions/:id/fork": { body: "ForkBody", response: "ForkResponse", extra: "201; the new session is a normal session of the same user." },
  "PUT /api/sessions/:id/pins/:messageUuid": { response: "Session", extra: "Pins a message of the session (Session.pinnedMessages); session_updated is broadcast." },
  "DELETE /api/sessions/:id/pins/:messageUuid": { response: "Session", extra: "Unpins it." },
  "POST /api/sessions/:id/tasks/:taskId/stop": { extra: "Stops one background task of the session (SDK stopTask); 204, 404 when the task or a live process is gone." },
  "GET /api/me/browser-sites": { response: "BrowserSitesResponse", extra: "Websites the user always allows the server browser on, most recently used first." },
  "DELETE /api/me/browser-sites": { query: "BrowserSiteQuery", extra: "Revokes one site (204); the next browser call there asks again." },
  "GET /api/admin/pricing": { response: "AdminPricingResponse" },
  "POST /api/admin/pricing/refresh": { response: "AdminPricingRefreshResponse", extra: "Runs the price check now: the hub fetches Anthropic's pricing page and Claude Haiku reads it." },
  "POST /api/browser/start": { response: "BrowserState", extra: "Starts the user's server browser (also started on demand by agent tool calls)." },
  "POST /api/browser/stop": { response: "BrowserState", extra: "Stops it; the profile (logins) is kept." },
  "GET /api/search": { query: "SearchQuery", response: "SearchResponse", extra: "Keyword results, newest first." },
  "GET /api/search/relevant": { query: "SearchQuery", response: "RelevantSearchResponse", extra: "Results ranked by Claude Haiku. 503 api_unavailable without an API key or budget; 502 search_failed when the model gave no usable answer." },
  "GET /api/me/memories": { response: "MemoriesResponse", extra: "Newest first. Memories are per user and follow the username to every device." },
  "POST /api/me/memories": { body: "MemoryBody", response: "Memory", extra: "Adds a memory written by the person (`source: user`). Claude adds its own through the `remember` tool in Chat sessions." },
  "PATCH /api/me/memories/:id": { body: "MemoryBody", response: "Memory" },
  "DELETE /api/me/memories/:id": { extra: "204. Nothing else ever deletes a memory: Claude's `forget` tool only runs when the person asks it to." },
  "PATCH /api/me/preferences": {
    body: "UserPreferencesBody",
    response: "User",
    extra: "The caller's own defaults for new sessions. Omitted fields are kept; null means \"follow the server default\" (`AdminSettings.defaultModel` / `defaultEffort`, opus / high unless configured). A model outside the caller's `modelAllowlist` is refused with 403 `model_not_allowed`.",
  },
  "GET /api/models": { response: "ModelsResponse" },
  "GET /api/commands": { query: "CommandsQuery", response: "CommandsResponse" },
  "GET /api/users": { response: "UsersResponse", extra: "Admin only. Login screens never call it: a username is typed, not picked from a list, and the same name on any device is the same user." },
  "POST /api/users": {
    body: "CreateUserBody",
    response: "User",
    extra: "Needs no user header. Creates the user if it does not exist yet (`201`); otherwise returns the existing user (`200`). There is no password: picking a name is how a workspace is created.",
  },
  "PATCH /api/users/:name": { body: "PatchUserBody", response: "User" },
  "DELETE /api/users/:name": { query: "DeleteUserQuery" },
  "GET /api/sessions": { query: "SessionsQuery", response: "SessionsResponse" },
  "POST /api/sessions": { body: "CreateSessionBody", response: "Session" },
  "GET /api/sessions/:id": { response: "Session" },
  "PATCH /api/sessions/:id": { body: "PatchSessionBody", response: "Session" },
  "DELETE /api/sessions/:id": {},
  "GET /api/sessions/:id/messages": { query: "MessagesQuery", response: "MessagesResponse" },
  "POST /api/sessions/:id/messages": {
    body: "SendMessageBody",
    response: "SendMessageResponse",
    extra: "`200 { state: \"accepted\" }` when the turn starts, `202 { state: \"queued\", position }` when it waits for a process slot. The hub runs its pre-send checks first (see [Errors](#errors)).",
  },
  "PATCH /api/sessions/:id/settings": {
    body: "SessionSettings",
    response: "Session",
    extra: "The change takes effect on the server and is broadcast to every subscriber as a `session_settings` event (last writer wins).",
  },
  "POST /api/sessions/:id/stop": { response: "Session", extra: "Interrupts the running turn, cancels pending permission requests and marks queued messages cancelled." },
  "POST /api/sessions/:id/close": { response: "Session", extra: "Releases the process slot. The session and its history are kept." },
  "GET /api/files/tree": { query: "TreeQuery", response: "TreeResponse" },
  "GET /api/files/content": { query: "PathQuery", response: "FileContentResponse" },
  "GET /api/files/download": { query: "DownloadQuery", response: BINARY("file bytes, or a zip for a directory / several paths") },
  "PUT /api/files/upload": {
    body: BINARY("one chunk; metadata travels in the X-Upload-* headers"),
    response: "UploadChunkResponse",
    extra: "Chunked; the headers and resume rules are described under [Chunked upload](#chunked-upload).",
  },
  "GET /api/files/upload": { query: "UploadStatusQuery", response: "UploadChunkResponse" },
  "DELETE /api/files": { query: "PathQuery" },
  "POST /api/files/mkdir": { body: "MkdirBody", response: "FileEntry" },
  "GET /api/projects": { response: "ProjectsResponse" },
  "POST /api/projects": { body: "CreateProjectBody", response: "Project" },
  "GET /api/projects/:id": { response: "Project" },
  "DELETE /api/projects/:id": {
    query: "DeleteProjectQuery",
    body: "DeleteProjectBody",
    extra: "Removes the server copy of the project and its review repository. Refused while there are pending changes or undownloaded files unless `discardRemaining` is true.",
  },
  "POST /api/projects/:id/baseline": {
    body: BINARY("tar.zst archive of the local folder, after ignore rules"),
    extra: "Send `X-Baseline-Encoding: tar` for an uncompressed tar. A re-import first saves the current work tree in a trash ref.",
  },
  "POST /api/projects/:id/manifest": { body: "ManifestBody", response: "ManifestResponse" },
  "PUT /api/projects/:id/files": { body: "SyncBody", response: "SyncResult" },
  "GET /api/projects/:id/review": { response: "ReviewResponse" },
  "GET /api/projects/:id/review/diff": { query: "PathQuery", response: "FileDiff" },
  "GET /api/projects/:id/review/patch": { response: { text: "string  // text/x-diff: one git diff of all pending changes (renames, binaries marked, empty new files)" } },
  "POST /api/projects/:id/review/accept": { body: "AcceptBody", response: "AcceptResponse" },
  "POST /api/projects/:id/review/reject": { body: "RejectBody", response: "RejectResponse" },
  "GET /api/projects/:id/history": { query: "HistoryQuery", response: "HistoryResponse" },
  "POST /api/projects/:id/restore": { body: "RestoreBody", response: "RestoreResponse" },
  "GET /api/projects/:id/raw": { query: "RawQuery", response: BINARY("bytes of the file in the working tree, or at `ref` when given") },
  "GET /api/projects/:id/backups": { response: "ProjectBackupsResponse", extra: "Newest first." },
  "POST /api/projects/:id/backups": { body: "ProjectBackupBody", response: "ProjectBackup", extra: "Stores client-side versions in `refs/backups/…`; never touches `local`, the working tree, review or snapshots." },
  "GET /api/skills": { response: "SkillsResponse" },
  "GET /api/skills/:name": { query: "SkillQuery", response: "SkillDetail" },
  "POST /api/skills": { body: "SkillBody", response: "Skill" },
  "PUT /api/skills/:name": { body: "SkillBody", response: "Skill" },
  "DELETE /api/skills/:name": { query: "SkillQuery" },
  "GET /api/usage/limits": { response: "UsageLimits" },
  "GET /api/usage/me": { query: "UsageRangeQuery", response: "MyUsageResponse" },
  "GET /api/disk": { response: "DiskStatus" },
  "GET /api/admin/overview": { response: "AdminOverview" },
  "GET /api/admin/usage": { query: "UsageRangeQuery", response: "AdminUsageResponse" },
  "GET /api/admin/settings": { response: "AdminSettings" },
  "PATCH /api/admin/settings": { body: "PatchAdminSettingsBody", response: "AdminSettings" },
  "GET /api/terminals": { response: "TerminalsResponse", extra: "The list is empty when the terminal is disabled globally or for this user." },
  "POST /api/terminals": { body: "CreateTerminalBody", response: "TerminalInfo" },
  "DELETE /api/terminals/:id": {},
};

const STATUS_ENDPOINTS: Record<string, EndpointSpec> = {
  "GET /status/api/metrics": { response: "MetricsResponse" },
  "GET /status/api/health": { response: "HealthResponse" },
  "GET /status/api/stream": { response: { text: "text/event-stream  // SSE; the event payload shapes are not defined in the protocol" } },
  "POST /status/api/speedtest": {},
  "GET /status/api/system": {},
};

/** Route-key prefix (`/api/<segment>`) -> group heading. Unknown segments fall back to a capitalised name. */
const GROUPS: Record<string, string> = {
  health: "Meta",
  me: "Meta",
  models: "Meta",
  commands: "Meta",
  users: "Users",
  sessions: "Sessions",
  files: "Files",
  projects: "Projects (sync and review)",
  skills: "Skills",
  usage: "Usage",
  disk: "Disk",
  admin: "Admin",
  terminals: "Terminals",
};

/** One-liners for events whose declaration has no JSDoc. `ClientEvent#hello` style keys. */
const EVENT_NOTES: Record<string, string> = {
  "ClientEvent#hello": "First frame on every connection: identifies the user and the protocol version the client speaks.",
  "ClientEvent#unsubscribe": "Stop receiving events for a session. Permission requests keep arriving on the user channel.",
  "ClientEvent#permission_response": "Answer a pending permission request. The first answer from any tab wins.",
  "ClientEvent#ping": "Keep-alive; the hub answers with `pong`.",
  "ServerEvent#welcome": "Reply to `hello`. Carries the resolved user (including `isAdmin`), the server protocol version and the server clock.",
  "ServerEvent#replay": "Persisted messages with `seq` greater than the client's `lastSeq`, in order. Sent once per `subscribe`, before `snapshot`.",
  "ServerEvent#snapshot": "State of the session right now: the session row, the in-flight assistant text and any pending permission request.",
  "ServerEvent#message": "A new persisted message (user, assistant, result, system or reset). `message.seq` increases by one per session.",
  "ServerEvent#delta": "Streaming fragment of the in-flight assistant message. Never persisted; superseded by the final `message`.",
  "ServerEvent#session_state": "Status transition (idle, queued, running, requires_action, dead), with the queue position while queued.",
  "ServerEvent#session_settings": "Model, permission mode or effort changed (by any client, or by the SDK falling back from `auto`). Last writer wins.",
  "ServerEvent#session_updated": "The session row changed (title, cost, last activity, ...). Also announces new sessions.",
  "ServerEvent#session_deleted": "The session was deleted by its user.",
  "ServerEvent#permission_request": "Claude wants to use a tool that needs approval. Held by the hub until answered, cancelled or timed out.",
  "ServerEvent#permission_resolved": "A permission request was answered (by whichever client answered first).",
  "ServerEvent#permission_cancelled": "A permission request was withdrawn (turn interrupted or aborted) without an answer.",
  "ServerEvent#review_changed": "The review state of a synced project changed (debounced). Clients re-fetch `GET /api/projects/:id/review`.",
  "ServerEvent#sync_conflict": "A pushed file could not be merged with the server copy; only that file is held back.",
  "ServerEvent#usage_limits": "Fresh API-credit figures (after metered usage or a budget change).",
  "ServerEvent#disk_status": "Disk level or usage changed (ok / warn / block).",
  "ServerEvent#error": "A request on this socket failed. `sessionId` is set when the error belongs to a session.",
  "ServerEvent#pong": "Reply to `ping`.",
  "TerminalClientFrame#in": "Keystrokes (or pasted text) typed by the user.",
  "TerminalClientFrame#resize": "The terminal viewport changed size.",
  "TerminalServerFrame#out": "Output of the pty.",
  "TerminalServerFrame#exit": "The shell exited. `code` is null when no exit code is available.",
  "StreamDelta#text": "Appended assistant text.",
  "StreamDelta#thinking": "Appended extended-thinking text.",
  "StreamDelta#tool_use_start": "A tool call began; its input follows as `tool_use_input` fragments.",
  "StreamDelta#tool_use_input": "Fragment of the tool call's JSON input (concatenate `partialJson` in order).",
  "StreamDelta#message_end": "The in-flight message is complete; the persisted `message` event follows.",
};

const ERROR_CODE_NOTES: Record<string, string> = {
  invalid_request: "The request failed schema validation (bad body, query or path).",
  user_required: "No username was supplied (`X-Workstation-User` header or `?user=`).",
  reserved_user: "The username is reserved for internal use.",
  admin_required: "The route needs an admin identity.",
  not_found: "The session, project, file or route does not exist for this user.",
  remote_disabled: "An admin switched remote sessions off; new turns are refused.",
  user_disabled: "An admin disabled this user.",
  weekly_limit: "The user's rolling 7-day token limit is used up.",
  disk_block: "Disk usage is above the block threshold; writes are refused (read-only protection).",
  model_not_allowed: "The model is not in the user's allowlist.",
  memory_limit: "The user already has the maximum number of memories; remove some first.",
  api_unavailable: "No Anthropic API key is configured, or the monthly budget is 0; sessions and the hub's own API services cannot run.",
  api_limit_reached: "This month's API-credit budget is used up.",
  search_failed: "The helper model failed while ranking relevant search results.",
  user_bound: "403: the username is bound to another Tailscale login; pick a different name.",
  lan_denied: "403: Agent Workstation only answers over Tailscale (`lan_access = \"deny\"`).",
  tailscale_identity_required: "403: the calling Tailscale device has no personal login (a tagged node).",
  tailscale_unavailable: "503: tailscaled could not be asked who is calling; try again shortly.",
  busy: "409: the session is being rewound; send again in a moment.",
  rate_limited: "429: too many requests from this caller; retry after `details.retryAfterS`.",
  upstream_error: "502: the server could not fetch a visual's library from its CDN.",
  cross_site: "403: the request came from another web site (`Origin` not allowed, or `Sec-Fetch-Site: cross-site`). See SECURITY.md.",
  baseline_too_large: "413: a baseline upload exceeded the compressed-size, extracted-size or file-count limit.",
  baseline_timeout: "408: a baseline upload took longer than the time limit.",
  baseline_unsupported_entry: "400: a baseline archive holds an entry type that is not accepted (sparse, multi-volume or unknown) or a damaged tar header.",
  self_caller: "403: the request came from this server itself (a process on the server calling one of its own addresses). See SECURITY.md.",
  proxy_header_invalid: "400: the request reached the public socket without exactly one `X-Forwarded-For` IP, or the local socket with one. See SECURITY.md.",
  bad_host: "421: the request's `Host` is not one of this server's names (DNS rebinding protection). See SECURITY.md.",
  terminal_disabled: "The terminal feature is disabled for this user.",
  path_outside_workspace: "The path escapes the user's workspace root.",
  upload_incomplete: "An upload was finalised or used before all chunks arrived.",
  permission_not_found: "No pending permission request with that id.",
  stale_diff: "The diffId sent with a hunk-level accept/reject no longer matches the file; refetch the diff.",
  project_not_empty: "The project still has pending review changes or undownloaded files; pass discardRemaining to delete anyway.",
  sync_conflict: "A pushed file could not be merged with the server's working tree; resend with force or fetch the server's version.",
  project_exists: "A project with that name already exists for this user.",
  user_not_empty: "The user still has projects with unaccepted changes or undownloaded files; pass force=true to delete anyway.",
  skill_exists: "A skill with that name already exists in that scope.",
  stale: "The project's `local` branch moved since the client last looked; refetch and retry.",
  invalid_path: "A project path is absolute, contains `..`/`.git` segments or is otherwise not allowed.",
  too_large: "The request body or file exceeds a size limit (files: MAX_SYNC_FILE_BYTES).",
  binary: "A hunk-level operation was requested on a binary (or > 2 MB) file; accept or reject the whole file.",
  unsupported: "The operation does not apply to this kind of change (e.g. hunks on a rename).",
  symlink: "A symlink is in the way; symlinks are never synced or accepted.",
};

const UPLOAD_HEADER_NOTES: Record<string, string> = {
  uploadId: "Client-chosen upload id; reuse it to resume.",
  path: "Target path in the workspace, percent-encoded.",
  chunkIndex: "0-based index of this chunk.",
  chunkTotal: "Total number of chunks in the upload.",
  totalBytes: "Total size of the file in bytes.",
};

const CONST_NOTES: Record<string, string> = {
  USER_HEADER: "Request header that carries the username on every REST call (and in the WebSocket `hello`).",
  UPLOAD_CHUNK_BYTES: "Upload chunk size. Every chunk except the last must be exactly this size.",
  MAX_SYNC_FILE_BYTES: "Files larger than this are skipped by sync, accept and download, with a notice.",
  PROTOCOL_VERSION: "Wire version. Additive changes keep it; it only changes for breaking changes.",
};

// ---------------------------------------------------------------------------
// Load the built protocol package
// ---------------------------------------------------------------------------

if (!existsSync(DIST_PATH)) {
  console.error(`packages/protocol is not built (missing ${DIST_PATH}).\nRun: npm run build -w packages/protocol`);
  process.exit(2);
}
const P = (await import("@agent-workstation/protocol")) as unknown as Record<string, unknown>;

interface ZodLike {
  _zod: { def: { type?: string; innerType?: ZodLike } };
  safeParse: (v: unknown) => unknown;
  shape?: Record<string, ZodLike>;
}
const isZod = (v: unknown): v is ZodLike =>
  typeof v === "object" && v !== null && "_zod" in v && typeof (v as { safeParse?: unknown }).safeParse === "function";

// ---------------------------------------------------------------------------
// Source comment extraction (JSDoc, declaration order, section banners)
// ---------------------------------------------------------------------------

interface SourceInfo {
  headerParagraph: string;
  conventions: string;
  order: Map<string, number>;
  sectionOf: Map<string, string>;
  declDoc: Map<string, string>;
  fieldDoc: Map<string, string>;
  variantDoc: Map<string, string>;
}

function cleanJsDoc(raw: string): string {
  const lines = raw.split("\n").map((l, i) => (i === 0 ? l.trim() : l.replace(/^\s*\*\s?/, "").replace(/\s+$/, "")));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function parseSource(raw: string): SourceInfo {
  const text = raw.replace(/\r\n/g, "\n");
  const banners = [...text.matchAll(/^\/\/ -{10,}\n\/\/ (.+)\n\/\/ -{10,}$/gm)].map((m) => ({ index: m.index ?? 0, title: (m[1] ?? "").trim() }));
  const decls = [...text.matchAll(/^export\s+const\s+(\w+)\b/gm)].map((m) => ({ name: m[1] ?? "", index: m.index ?? 0 }));
  const order = new Map<string, number>();
  const sectionOf = new Map<string, string>();
  decls.forEach((d, i) => {
    order.set(d.name, i);
    let section = "";
    for (const b of banners) if (b.index < d.index) section = b.title;
    sectionOf.set(d.name, section);
  });

  const declDoc = new Map<string, string>();
  const fieldDoc = new Map<string, string>();
  const variantDoc = new Map<string, string>();
  let headerParagraph = "";
  let conventions = "";

  for (const m of text.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const index = m.index ?? 0;
    const doc = cleanJsDoc(m[1] ?? "");
    if (!doc) continue;
    if (index === 0) {
      const lines = doc.split("\n");
      const at = lines.findIndex((l) => l.trim() === "Conventions");
      headerParagraph = (at === -1 ? lines : lines.slice(0, at)).join("\n").trim();
      conventions = at === -1 ? "" : lines.slice(at + 1).join("\n").trim();
      continue;
    }
    const after = text.slice(index + m[0].length, index + m[0].length + 400);
    const declMatch = /^\s*export\s+(?:const|type)\s+(\w+)/.exec(after);
    if (declMatch?.[1]) {
      if (!declDoc.has(declMatch[1])) declDoc.set(declMatch[1], doc);
      continue;
    }
    let enclosing = "";
    for (const d of decls) if (d.index < index) enclosing = d.name;
    if (!enclosing) continue;
    const fieldMatch = /^\s*(\w+)\??\s*:/.exec(after);
    if (fieldMatch?.[1]) {
      const key = `${enclosing}.${fieldMatch[1]}`;
      if (!fieldDoc.has(key)) fieldDoc.set(key, doc);
      continue;
    }
    const variantMatch = /^\s*z\.object\(\{\s*(\w+):\s*z\.literal\(\s*"([^"]+)"/.exec(after);
    if (variantMatch?.[2]) {
      const key = `${enclosing}#${variantMatch[2]}`;
      if (!variantDoc.has(key)) variantDoc.set(key, doc);
    }
  }
  return { headerParagraph, conventions, order, sectionOf, declDoc, fieldDoc, variantDoc };
}

const src = parseSource(readFileSync(SOURCE_PATH, "utf8"));
// The protocol source puts the StoredMessage JSDoc on the declaration above it (StoredMessageKind).
{
  const misplaced = src.declDoc.get("StoredMessageKind");
  if (misplaced?.startsWith("Persisted message") && !src.declDoc.has("StoredMessage")) {
    src.declDoc.set("StoredMessage", misplaced);
    src.declDoc.delete("StoredMessageKind");
  }
}

type SectionKind = "const" | "rest" | "ws" | "status" | "shared";
function kindOfSection(title: string): SectionKind {
  if (/^Constants/i.test(title)) return "const";
  if (/^REST/i.test(title)) return "rest";
  if (/^WebSocket/i.test(title)) return "ws";
  if (/^Status/i.test(title)) return "status";
  return "shared";
}
const kindOf = (name: string): SectionKind => kindOfSection(src.sectionOf.get(name) ?? "");
const orderOf = (name: string): number => src.order.get(name) ?? Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Schemas -> JSON Schema (named schemas stay named)
// ---------------------------------------------------------------------------

const exportNames = Object.keys(P).sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
const zodSchemas = new Map<string, ZodLike>();
/** alias name -> canonical name (two exports that are the very same schema object, e.g. `RejectBody = AcceptBody`). */
const aliasOf = new Map<string, string>();
{
  const byDef = new Map<unknown, string>();
  for (const name of exportNames) {
    const v = P[name];
    if (!isZod(v)) continue;
    const seen = byDef.get(v._zod.def);
    if (seen) {
      aliasOf.set(name, seen);
      continue;
    }
    byDef.set(v._zod.def, name);
    zodSchemas.set(name, v);
  }
}
const namedSet = new Set(zodSchemas.keys());

type J = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, J>;
  required?: string[];
  additionalProperties?: boolean | J;
  items?: J | J[];
  anyOf?: J[];
  oneOf?: J[];
  allOf?: J[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
};

const defs: Record<string, J> = (() => {
  if (zodSchemas.size === 0) throw new Error("@agent-workstation/protocol exports no zod schemas");
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of zodSchemas) registry.add(schema as never, { id: name });
  const out = z.toJSONSchema(registry, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
    uri: (id) => `#/definitions/${id}`,
  }) as { schemas?: Record<string, J & { $schema?: string; $id?: string }> };
  if (!out.schemas) throw new Error("z.toJSONSchema returned no schemas");
  // zod 4 emits discriminated unions as `oneOf` (plain unions as `anyOf`); the listings treat both as one list.
  const anyOfOnly = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(anyOfOnly);
    if (typeof v !== "object" || v === null) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === "oneOf" ? "anyOf" : k, anyOfOnly(x)]));
  };
  const result: Record<string, J> = {};
  for (const [name, { $schema: _s, $id: _i, ...rest }] of Object.entries(out.schemas)) result[name] = anyOfOnly(rest) as J;
  return result;
})();

const decodePtr = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Resolves `$ref`. References to a named schema stay named. zod also emits pointers into the
 * middle of other schemas when two schemas share a field object (pick/partial/extend); those are inlined.
 */
function deref(n: J, depth = 0): { named: string | null; node: J } {
  if (!n.$ref) return { named: null, node: n };
  const m = /^#\/definitions\/([^/]+)$/.exec(n.$ref);
  const name = m?.[1] ? decodePtr(m[1]) : null;
  if (name && namedSet.has(name)) return { named: name, node: n };
  if (depth > 20) return { named: null, node: {} };
  let cur: unknown = { definitions: defs };
  for (const seg of n.$ref.replace(/^#\//, "").split("/").map(decodePtr)) {
    cur = (cur as Record<string, unknown> | undefined)?.[seg];
  }
  if (!cur || typeof cur !== "object") return { named: null, node: {} };
  const { $ref: _ignored, ...rest } = n;
  return deref({ ...(cur as J), ...rest }, depth + 1);
}

// ---------------------------------------------------------------------------
// Field documentation, including docs inherited by derived schemas (pick / partial / extend)
// ---------------------------------------------------------------------------

const fieldOrigin = new Map<ZodLike, { decl: string; key: string }>();
const unwrapZod = (s: ZodLike): ZodLike[] => {
  const chain: ZodLike[] = [];
  let cur: ZodLike | undefined = s;
  while (cur && cur._zod) {
    chain.push(cur);
    const type: string | undefined = cur._zod.def.type;
    const inner: ZodLike | undefined = cur._zod.def.innerType;
    cur = type === "optional" || type === "nullable" || type === "default" || type === "prefault" ? inner : undefined;
  }
  return chain;
};
for (const [name, schema] of zodSchemas) {
  if (schema._zod.def.type !== "object" || !schema.shape) continue;
  for (const [key, field] of Object.entries(schema.shape)) {
    for (const candidate of unwrapZod(field)) if (!fieldOrigin.has(candidate)) fieldOrigin.set(candidate, { decl: name, key });
  }
}

function fieldDocFor(decl: string, key: string): string | undefined {
  const direct = src.fieldDoc.get(`${decl}.${key}`);
  if (direct) return direct;
  const schema = zodSchemas.get(decl);
  const field = schema?.shape?.[key];
  if (!field) return undefined;
  for (const candidate of unwrapZod(field)) {
    const origin = fieldOrigin.get(candidate);
    if (origin && origin.decl !== decl) {
      const inherited = src.fieldDoc.get(`${origin.decl}.${origin.key}`);
      if (inherited) return inherited;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON Schema -> compact TypeScript-like text
// ---------------------------------------------------------------------------

const pad = (n: number): string => " ".repeat(n);
const lit = (v: unknown): string => JSON.stringify(v);
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();
const WIDTH = 96;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function constraints(n0: J, kind: "string" | "integer" | "number"): string[] {
  const c: string[] = [];
  let n = n0;
  if (kind === "integer") {
    // zod 4 states the safe-integer range of every `.int()` explicitly; that is the implicit range, not a constraint.
    const { minimum, maximum, ...rest } = n0;
    n = { ...rest };
    if (minimum !== undefined && minimum !== Number.MIN_SAFE_INTEGER) n.minimum = minimum;
    if (maximum !== undefined && maximum !== Number.MAX_SAFE_INTEGER) n.maximum = maximum;
  }
  if (kind === "string") {
    if (n.format) c.push(n.format);
    // The pattern of a built-in format (uuid, ...) is part of the format, not a separate constraint.
    if (n.pattern && !n.format) c.push(`/${n.pattern}/`);
    if (n.minLength !== undefined && n.maxLength !== undefined) c.push(`len ${n.minLength}..${n.maxLength}`);
    else if (n.minLength !== undefined) c.push(`len ≥${n.minLength}`);
    else if (n.maxLength !== undefined) c.push(`len ≤${n.maxLength}`);
    return c;
  }
  if (n.minimum !== undefined && n.maximum !== undefined) return [`${n.minimum}..${n.maximum}`];
  if (n.minimum !== undefined) c.push(`≥${n.minimum}`);
  else if (n.exclusiveMinimum !== undefined) c.push(`>${n.exclusiveMinimum}`);
  if (n.maximum !== undefined) c.push(`≤${n.maximum}`);
  else if (n.exclusiveMaximum !== undefined) c.push(`<${n.exclusiveMaximum}`);
  return c;
}

function scalarStr(t: string, n: J): string {
  const base = t === "integer" ? "int" : t;
  const c = t === "string" || t === "integer" || t === "number" ? constraints(n, t) : [];
  return c.length ? `${base}(${c.join(", ")})` : base;
}

/** Joins alternatives inline when short, otherwise as a vertical `| a` list. A leading "\n" marks the vertical form. */
function unionStr(gen: (indent: number) => string[], ind: number): string {
  const flat = [...new Set(gen(ind))];
  if (flat.length === 1) return flat[0] ?? "unknown";
  const joined = flat.join(" | ");
  if (!joined.includes("\n") && joined.length + ind <= 84) return joined;
  const parts = [...new Set(gen(ind + 4))];
  return "\n" + parts.map((p) => `${pad(ind + 2)}| ${p}`).join("\n");
}

function typeStr(n: J, ind: number, decl: string): string {
  const d = deref(n);
  if (d.named) return d.named;
  const node = d.node;
  if (node.const !== undefined) return lit(node.const);
  if (node.enum) {
    const vals = node.enum.map(lit);
    if (Array.isArray(node.type) && node.type.includes("null") && !node.enum.includes(null)) vals.push("null");
    return unionStr(() => vals, ind);
  }
  const alts = node.anyOf ?? node.oneOf;
  if (alts) return unionStr((i) => alts.map((a) => typeStr(a, i, decl)), ind);
  if (node.allOf) return node.allOf.map((a) => typeStr(a, ind, decl)).join(" & ");
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length === 0) return "unknown";
  return unionStr((i) => types.map((t) => oneType(t, node, i, decl)), ind);
}

function oneType(t: string, n: J, ind: number, decl: string): string {
  switch (t) {
    case "object":
      return objectStr(n, ind, decl);
    case "array":
      return arrayStr(n, ind, decl);
    case "null":
      return "null";
    default:
      return scalarStr(t, n);
  }
}

function arrayStr(n: J, ind: number, decl: string): string {
  const items = Array.isArray(n.items) ? n.items[0] : n.items;
  const it = items ? typeStr(items, ind, decl) : "unknown";
  const itemNode = items ? deref(items) : null;
  const unionLike =
    !!itemNode &&
    !itemNode.named &&
    !!(itemNode.node.anyOf || itemNode.node.oneOf || (itemNode.node.enum && itemNode.node.enum.length > 1) || (Array.isArray(itemNode.node.type) && itemNode.node.type.length > 1));
  const c: string[] = [];
  if (n.minItems !== undefined) c.push(`len ≥${n.minItems}`);
  if (n.maxItems !== undefined) c.push(`len ≤${n.maxItems}`);
  const base = it.includes("\n") ? `Array<${it}>` : unionLike ? `(${it})[]` : `${it}[]`;
  return c.length ? `${base}(${c.join(", ")})` : base;
}

interface FieldLine {
  head: string;
  note: string;
}

function fieldLine(key: string, v: J, required: boolean, ind: number, decl: string): FieldLine {
  const type = typeStr(v, ind, decl);
  const k = `${key}${required ? "" : "?"}`;
  const head = type.startsWith("\n") ? `${k}:${type}` : `${k}: ${type}`;
  const parts: string[] = [];
  const doc = fieldDocFor(decl, key);
  if (doc) parts.push(oneLine(doc));
  if (v.default !== undefined) parts.push(doc ? `(default: ${lit(v.default)})` : `default: ${lit(v.default)}`);
  return { head, note: parts.join(" ") };
}

function objectStr(n: J, ind: number, decl: string): string {
  const props = Object.entries(n.properties ?? {});
  if (props.length === 0) {
    if (n.additionalProperties && typeof n.additionalProperties === "object") return `Record<string, ${typeStr(n.additionalProperties, ind, decl)}>`;
    return n.additionalProperties === true ? "Record<string, unknown>" : "{}";
  }
  const required = new Set(n.required ?? []);
  const fields = props.map(([k, v]) => fieldLine(k, v, required.has(k), ind + 2, decl));
  if (fields.every((f) => !f.note && !f.head.includes("\n"))) {
    const single = `{ ${fields.map((f) => f.head).join(", ")} }`;
    if (single.length + ind <= WIDTH) return single;
  }
  const lines: string[] = ["{"];
  for (const f of fields) {
    if (f.note && !f.head.includes("\n") && f.head.length + f.note.length + ind + 6 <= WIDTH + 8) {
      lines.push(`${pad(ind + 2)}${f.head}  // ${f.note}`);
      continue;
    }
    if (f.note) for (const l of wrap(f.note, Math.max(40, WIDTH - ind - 5))) lines.push(`${pad(ind + 2)}// ${l}`);
    lines.push(`${pad(ind + 2)}${f.head}`);
  }
  lines.push(`${pad(ind)}}`);
  return lines.join("\n");
}

/** `type Name = ...` for a named schema. */
function declStr(name: string): string {
  const def = defs[name];
  if (!def) throw new Error(`no JSON schema for ${name}`);
  const t = typeStr(def, 0, name);
  return t.startsWith("\n") ? `type ${name} =${t}` : `type ${name} = ${t}`;
}

/** Type text for a Ref used in an endpoint listing. Named schemas of the shared kind stay by-name. */
function refText(ref: Ref, placed: Set<string>): string {
  if (typeof ref !== "string") {
    for (const n of ref.names ?? []) assertKnown(n, `ref text "${ref.text}"`);
    return ref.text;
  }
  const canonical = aliasOf.get(ref) ?? ref;
  assertKnown(canonical, `endpoint mapping ${ref}`);
  if (kindOf(canonical) === "shared") return canonical;
  placed.add(canonical);
  const def = defs[canonical];
  if (!def) throw new Error(`no JSON schema for ${canonical}`);
  return typeStr(def, 0, canonical);
}

function assertKnown(name: string, where: string): void {
  if (!namedSet.has(name)) throw new Error(`${where}: "${name}" is not a schema exported by @agent-workstation/protocol (update ENDPOINTS in scripts/gen-protocol-docs.mts)`);
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

const out: string[] = [];
const emit = (...lines: string[]): void => {
  out.push(...lines);
};
const blank = (): void => {
  if (out.length && out[out.length - 1] !== "") out.push("");
};
const fence = (lang: string, body: string): void => {
  blank();
  emit("```" + lang, body, "```", "");
};
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string): string => "`" + s + "`";

/** Reflows JSDoc text: prose lines join into paragraphs, `- ` bullets stay bullets, indented lines become a text block. */
function reflow(text: string): string {
  const lines = text.split("\n");
  const res: string[] = [];
  let mode: "none" | "para" | "pre" | "list" = "none";
  let buf: string[] = [];
  const flush = (): void => {
    if (mode === "para") res.push(buf.join(" "), "");
    else if (mode === "pre") {
      const indent = Math.min(...buf.map((l) => l.length - l.trimStart().length));
      res.push("```text", ...buf.map((l) => l.slice(indent)), "```", "");
    } else if (mode === "list") res.push(...buf.map((l) => `- ${l}`), "");
    buf = [];
    mode = "none";
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line);
    const indented = /^\s{2,}\S/.test(line);
    if (bullet) {
      if (mode !== "list") flush();
      mode = "list";
      buf.push(bullet[1] ?? "");
    } else if (indented && mode === "list") {
      buf[buf.length - 1] = `${buf[buf.length - 1] ?? ""} ${line.trim()}`;
    } else if (indented) {
      if (mode !== "pre") flush();
      mode = "pre";
      buf.push(line);
    } else {
      if (mode !== "para") flush();
      mode = "para";
      buf.push(line.trim());
    }
  }
  flush();
  return res.join("\n").trimEnd();
}

/** Doc text -> markdown (a table when every line is `value - meaning`). */
function docMarkdown(text: string): string {
  const lines = text.split("\n");
  const rows = lines.map((l) => /^(\w+)\s{2,}- (.*)$/.exec(l));
  if (lines.length >= 2 && rows.every(Boolean)) {
    return ["| Value | Meaning |", "|---|---|", ...rows.map((r) => `| ${code(r?.[1] ?? "")} | ${cell(r?.[2] ?? "")} |`)].join("\n");
  }
  return reflow(text);
}

function stripRoutePrefix(doc: string): string {
  const rest = doc.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+\S+\s*(-\s*)?/, "").trim();
  if (/^→\s*\w+$/.test(rest)) return "";
  return rest;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
}

function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && v % 1024 === 0 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Route {
  key: string;
  method: string;
  path: string;
  query: string;
  note: string;
}

function parseRoutes(table: Record<string, string>): Route[] {
  const routes: Route[] = [];
  for (const [key, value] of Object.entries(table)) {
    for (const alt of value.split(" | ")) {
      const m = /^(GET|POST|PUT|PATCH|DELETE|WS)\s+(\S+)(?:\s+\((.*)\))?\s*$/.exec(alt.trim());
      if (!m) {
        problems.push(`cannot parse route "${alt}" (key ${key})`);
        continue;
      }
      const [pathOnly = "", query = ""] = (m[2] ?? "").split("?");
      routes.push({ key, method: m[1] ?? "", path: pathOnly, query, note: m[3] ?? "" });
    }
  }
  return routes;
}

function queryFromRoute(query: string): string | null {
  if (!query) return null;
  const parts = query.split("&").map((p) => {
    const [k = "", v = ""] = p.split("=");
    return v.includes("|") ? `${k}?: ${v.split("|").map(lit).join(" | ")}` : `${k}?: string`;
  });
  return `{ ${parts.join(", ")} }`;
}

function groupOf(path: string): string {
  const seg = path.split("/")[2] ?? "";
  return GROUPS[seg] ?? (seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Other");
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function noteText(note: string): string {
  if (!note) return "";
  if (note === "admin") return "Admin only";
  return note.charAt(0).toUpperCase() + note.slice(1);
}

function endpointBlock(route: Route, specs: Record<string, EndpointSpec>, placed: Set<string>, level: string): void {
  const spec = specs[`${route.method} ${route.path}`];
  emit("", `${level} ${code(`${route.method} ${route.path}`)}`, "");
  const notes: string[] = [];
  if (spec?.extra) notes.push(spec.extra);
  const docRefs = [spec?.query, spec?.body, spec?.response].filter((r): r is string => typeof r === "string");
  for (const r of docRefs) {
    const canonical = aliasOf.get(r);
    if (canonical) notes.push(`${code(r)} is the same schema as ${code(canonical)}.`);
    const doc = src.declDoc.get(aliasOf.get(r) ?? r);
    const text = doc ? capitalise(stripRoutePrefix(doc)) : "";
    if (text && !notes.includes(text)) notes.push(text);
  }
  if (notes.length === 0 && route.note) notes.push(`${noteText(route.note)}.`);
  if (notes.length) emit(notes.join(" "), "");
  if (!spec) {
    emit("_No schema mapping in the generator for this route._", "");
    return;
  }
  const lines: string[] = [];
  const add = (label: string, ref: Ref | undefined): void => {
    if (!ref) return;
    const t = refText(ref, placed);
    lines.push(t.startsWith("\n") ? `${label}:${t}` : `${label}: ${t}`);
  };
  if (!spec.query) {
    const q = queryFromRoute(route.query);
    if (q) lines.push(`query: ${q}`);
  }
  add("query", spec.query);
  add("body", spec.body);
  add("response", spec.response);
  if (lines.length === 0) lines.push("// no request or response body defined by the protocol");
  fence("ts", lines.join("\n"));
}

function refNames(ref: Ref | undefined): string {
  if (!ref) return "";
  if (typeof ref === "string") return code(ref);
  return code(ref.text.replace(/\s+\/\/.*$/, ""));
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const placedNames = new Set<string>();

function renderSharedTypes(): void {
  const shared = [...zodSchemas.keys()].filter((n) => kindOf(n) === "shared");
  const isScalar = (n: string): boolean => {
    const d = defs[n];
    return !!d && !d.properties && d.type !== "object" && d.type !== "array" && !d.anyOf;
  };
  const scalars = shared.filter(isScalar);
  const objects = shared.filter((n) => !isScalar(n));

  emit("", "## Shared types", "");
  emit("Scalars, enums and entities that appear in several routes and events. Named types in later listings refer to these.", "");
  emit("### Scalars and enums", "");
  const lines: string[] = [];
  for (const name of scalars) {
    placedNames.add(name);
    const doc = src.declDoc.get(name);
    if (doc) {
      if (doc.includes("\n")) for (const l of doc.split("\n")) lines.push(`// ${l}`.trimEnd());
      else for (const l of wrap(doc, WIDTH - 3)) lines.push(`// ${l}`);
    }
    const note = name === "RelPath" ? "  // non-empty; no leading '/', no '..' segment, no NUL (custom refinement)" : "";
    lines.push(declStr(name) + note, "");
  }
  fence("ts", lines.join("\n").trimEnd());
  for (const name of objects) {
    placedNames.add(name);
    emit("", `### ${name}`, "");
    const doc = src.declDoc.get(name);
    if (doc) emit(docMarkdown(doc), "");
    fence("ts", declStr(name));
  }
}

function renderConstants(): void {
  emit("", "## Constants", "");
  const rows: string[] = [];
  const specials = new Set(["UPLOAD_HEADERS", "ERROR_CODES", "HUB_SYSTEM_SUBTYPES", "ROUTES", "STATUS_ROUTES"]);
  const others: string[] = [];
  for (const name of exportNames) {
    const v = P[name];
    if (isZod(v) || typeof v === "function" || specials.has(name)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const shown = typeof v === "number" && name.endsWith("_BYTES") ? `${v} (${formatBytes(v)})` : String(v);
      const note = CONST_NOTES[name] ?? (src.declDoc.get(name) ? oneLine(src.declDoc.get(name) ?? "") : "");
      if (!note) warnings.push(`constant ${name} has no description`);
      rows.push(`| ${code(name)} | ${code(shown)} | ${cell(note)} |`);
    } else others.push(name);
  }
  emit("| Name | Value | Meaning |", "|---|---|---|", ...rows, "");
  for (const name of others) {
    emit(`${code(name)}:`, "");
    fence("json", JSON.stringify(P[name], null, 2));
    warnings.push(`constant ${name} rendered as raw JSON (no dedicated section)`);
  }
}

function renderErrors(): void {
  emit("", "### Errors", "");
  emit("Every non-2xx response carries a JSON `ErrorBody`. Clients branch on `code` when present and show `error` to the user.", "");
  fence("ts", declStr("ErrorBody"));
  placedNames.add("ErrorBody");
  const codes = (P.ERROR_CODES ?? []) as readonly string[];
  const doc = src.declDoc.get("ERROR_CODES") ?? "";
  const status = new Map<string, string>();
  for (const m of doc.matchAll(/(\d{3})\s+([a-z_]+)/g)) if (m[1] && m[2]) status.set(m[2], m[1]);
  const rows = codes.map((c) => {
    const note = ERROR_CODE_NOTES[c];
    if (!note) warnings.push(`error code ${c} has no description`);
    return `| ${code(c)} | ${status.get(c) ?? ""} | ${cell(note ?? "")} |`;
  });
  emit("Error codes (`ERROR_CODES`, non-exhaustive). The HTTP column is filled for the codes the protocol maps to a status; for the others the hub picks the status that fits the failure.", "");
  emit("| `code` | HTTP | Meaning |", "|---|---|---|", ...rows, "");
  if (status.size) emit(`The pre-send checks on \`POST /api/sessions/:id/messages\` fail with ${[...status].map(([c, h]) => `${h} ${code(c)}`).join(", ")}.`, "");
}

function renderUploadSection(): void {
  emit("", "### Chunked upload", "");
  const doc = src.declDoc.get("UPLOAD_HEADERS");
  if (doc) emit(docMarkdown(doc), "");
  const headers = (P.UPLOAD_HEADERS ?? {}) as Record<string, string>;
  emit(
    "| Key | Header | Meaning |",
    "|---|---|---|",
    ...Object.entries(headers).map(([k, v]) => {
      const note = UPLOAD_HEADER_NOTES[k];
      if (!note) warnings.push(`upload header ${k} has no description`);
      return `| ${code(k)} | ${code(v)} | ${cell(note ?? "")} |`;
    }),
    "",
  );
  emit(`To resume an interrupted upload, call \`GET /api/files/upload?uploadId=\`: the response's \`received\` array lists the chunk indexes the hub already holds, so only the missing chunks need to be sent. Chunk size is \`UPLOAD_CHUNK_BYTES\`.`, "");
}

function renderRest(): void {
  const routes = parseRoutes((P.ROUTES ?? {}) as Record<string, string>).filter((r) => r.method !== "WS");
  const placed = new Set<string>();
  emit("", "## REST API", "");
  emit("All routes live under `/api` and need the user header (see [Conventions](#conventions)). JSON bodies use `Content-Type: application/json`.", "");
  emit("`// no request or response body defined by the protocol` means the protocol declares no body for that direction; clients must not depend on one. The reference hub answers creation with `201` and deletion with `204` and no body. Routes under `/api/admin` and routes marked admin only require an admin identity and fail with the error code `admin_required` otherwise.", "");
  renderErrors();

  emit("", "### Route index", "");
  const rows = routes.map((r) => {
    const spec = ENDPOINTS[`${r.method} ${r.path}`];
    const req = [spec?.query ? `query ${refNames(spec.query)}` : "", spec?.body ? `body ${refNames(spec.body)}` : ""].filter(Boolean).join(", ");
    return `| ${r.method} | ${cell(code(r.path + (r.query ? "?" + r.query : "")))} | ${cell(req)} | ${cell(refNames(spec?.response))} | ${cell(noteText(r.note))} |`;
  });
  emit("| Method | Path | Request | Response | Notes |", "|---|---|---|---|---|", ...rows, "");

  for (const r of routes) {
    if (!ENDPOINTS[`${r.method} ${r.path}`]) problems.push(`route "${r.method} ${r.path}" (ROUTES.${r.key}) has no entry in ENDPOINTS`);
  }
  const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
  for (const key of Object.keys(ENDPOINTS)) if (!known.has(key)) problems.push(`ENDPOINTS has "${key}" but ROUTES does not define it`);

  const groups: string[] = [];
  for (const r of routes) if (!groups.includes(groupOf(r.path))) groups.push(groupOf(r.path));
  emit("### Endpoints", "");
  for (const g of groups) {
    emit("", `#### ${g}`);
    for (const r of routes.filter((x) => groupOf(x.path) === g)) endpointBlock(r, ENDPOINTS, placed, "#####");
  }
  renderUploadSection();

  // Named REST schemas that are only referenced from other schemas.
  const leftovers = [...zodSchemas.keys()].filter((n) => kindOf(n) === "rest" && !placed.has(n) && !placedNames.has(n));
  if (leftovers.length) {
    emit("", "### Supporting types", "");
    emit("Named schemas referenced from the listings above.", "");
    const lines: string[] = [];
    for (const n of leftovers) {
      placedNames.add(n);
      const doc = src.declDoc.get(n);
      if (doc) for (const l of wrap(stripRoutePrefix(doc) || doc, WIDTH - 3)) lines.push(`// ${l}`);
      lines.push(declStr(n), "");
    }
    fence("ts", lines.join("\n").trimEnd());
  }
  for (const n of placed) placedNames.add(n);
}

function discriminatorOf(def: J): string | null {
  const variants = (def.anyOf ?? []).map((v) => deref(v).node);
  if (variants.length === 0) return null;
  const first = variants[0]?.properties ?? {};
  for (const key of Object.keys(first)) {
    if (variants.every((v) => v.properties?.[key]?.const !== undefined)) return key;
  }
  return null;
}

/** Lists every variant of a discriminated union as an annotated type listing. */
const usedEventNotes = new Set<string>();
function unionListing(name: string): string {
  const def = defs[name];
  if (!def) throw new Error(`no JSON schema for ${name}`);
  const key = discriminatorOf(def);
  const lines: string[] = [];
  for (const raw of def.anyOf ?? []) {
    const variant = deref(raw).node;
    const value = key ? String(variant.properties?.[key]?.const) : "";
    usedEventNotes.add(`${name}#${value}`);
    const note = src.variantDoc.get(`${name}#${value}`) ?? EVENT_NOTES[`${name}#${value}`];
    if (!note) warnings.push(`${name} variant "${value}" has no description (add it to EVENT_NOTES)`);
    else for (const l of wrap(oneLine(note), WIDTH - 3)) lines.push(`// ${l}`);
    lines.push(typeStr(raw, 0, name), "");
  }
  placedNames.add(name);
  return lines.join("\n").trimEnd();
}

function renderWebSocket(): void {
  emit("", "## WebSocket", "");
  emit("One WebSocket per client at `/ws`, multiplexed by `sessionId`. Frames are JSON text; every frame has a `type`. Client frames are `ClientEvent`, server frames are `ServerEvent`.", "");
  emit("### Connecting and handshake", "");
  emit(
    "1. Open `ws://<host>/ws` (or `wss://` behind TLS). Browsers cannot set headers on a WebSocket upgrade, so the username may also be passed as `?user=<name>`; the header wins when both are present.",
    "2. Send `hello { user, protocolVersion }` as the first frame. `protocolVersion` is `PROTOCOL_VERSION`.",
    "3. The hub answers `welcome { user, protocolVersion, serverTime }`. Compare `protocolVersion` with your own and refuse to continue on a mismatch; the version only changes for breaking changes.",
    "4. For each session the client shows, send `subscribe { sessionId, lastSeq }`, where `lastSeq` is the highest `seq` the client already holds (0 for none). The hub replies in this order:",
    "   1. `replay` with every persisted message whose `seq` is greater than `lastSeq`;",
    "   2. `snapshot` with the session row, the in-flight assistant text (`partial`) and any pending permission request;",
    "   3. live events: `message`, `delta`, `session_state`, `session_settings`, `permission_*`, and so on.",
    "5. Keep `lastSeq` up to date from `replay` and `message` events. After a reconnect, repeat `hello` and `subscribe` with the stored `lastSeq`; if a live `message` ever skips a `seq`, re-subscribe the same way.",
    "6. Send `ping` periodically; the hub answers `pong`.",
    "",
  );
  emit("Behaviour worth knowing:", "");
  emit(
    "- **Several tabs, one session.** Every subscriber receives every event for the session. Model, permission mode and effort are applied on the server and broadcast as `session_settings`; the last writer wins.",
    "- **Permissions belong to the hub, not the tab.** A `permission_request` stays pending when a tab closes and is re-delivered in the next `snapshot.pendingPermission`. The first `permission_response` from any client wins and is announced with `permission_resolved`; an interrupted turn produces `permission_cancelled`. Unanswered requests are denied (and the turn stopped) after the configured timeout (`sessions.permission_timeout_s`, default 600 s).",
    "- **Deltas are ephemeral.** `delta` events are folded into `snapshot.partial` for late joiners and are never persisted; the final assistant message arrives as a `message` event.",
    "- **User messages are deduplicated by `uuid`.** The client generates the UUID in `POST /api/sessions/:id/messages`; the persisted user message echoes it.",
    "- **Event scope (design).** Session events (`message`, `delta`, `session_state`, ...) go to subscribers of that session; per-user events (session list changes, permission prompts, file and review events) to every connection of the user; global events (`usage_limits`, `notice`) to everyone. See [ARCHITECTURE.md](ARCHITECTURE.md) for the session runtime.",
    "",
  );

  emit("### Client → server events", "");
  fence("ts", unionListing("ClientEvent"));
  emit("### Server → client events", "");
  fence("ts", unionListing("ServerEvent"));
  emit("### StreamDelta", "");
  emit("Payload of the `delta` event. A message streams as zero or more `text` / `thinking` fragments and tool-call fragments, then `message_end`.", "");
  fence("ts", unionListing("StreamDelta"));
  emit("### SessionSnapshot", "");
  emit("Payload of the `snapshot` event.", "");
  fence("ts", declStr("SessionSnapshot"));
  placedNames.add("SessionSnapshot");

  emit("### Hub system messages", "");
  const sysDoc = src.declDoc.get("HUB_SYSTEM_SUBTYPES");
  if (sysDoc) emit(docMarkdown(sysDoc), "");
  const subtypes = (P.HUB_SYSTEM_SUBTYPES ?? []) as readonly string[];
  emit(`Subtypes: ${subtypes.map(code).join(", ")}.`, "");

  emit("## Terminal WebSocket", "");
  emit("`WS /ws/terminal/:id` attaches to a terminal created with `POST /api/terminals`. The user comes from `?user=` or the `X-Workstation-User` header. Frames are JSON text.", "");
  emit("Client → server:", "");
  fence("ts", unionListing("TerminalClientFrame"));
  emit("Server → client:", "");
  fence("ts", unionListing("TerminalServerFrame"));

  const leftovers = [...zodSchemas.keys()].filter((n) => kindOf(n) === "ws" && !placedNames.has(n));
  if (leftovers.length) {
    emit("### Other WebSocket types", "");
    fence("ts", leftovers.map((n) => (placedNames.add(n), declStr(n))).join("\n\n"));
  }
}

function renderStatus(): void {
  emit("", "## Status service", "");
  emit("`workstation-status` is a separate process (default port 9100) and lives under `/status/api`; the reverse proxy routes `/status*` to it. It does not use the `X-Workstation-User` header.", "");
  const routes = parseRoutes((P.STATUS_ROUTES ?? {}) as Record<string, string>);
  const placed = new Set<string>();
  emit("### Routes", "");
  const rows = routes.map((r) => {
    const spec = STATUS_ENDPOINTS[`${r.method} ${r.path}`];
    return `| ${r.method} | ${cell(code(r.path + (r.query ? "?" + r.query : "")))} | ${cell(refNames(spec?.response))} | ${cell(noteText(r.note))} |`;
  });
  emit("| Method | Path | Response | Notes |", "|---|---|---|---|", ...rows, "");
  for (const r of routes) {
    if (!STATUS_ENDPOINTS[`${r.method} ${r.path}`]) problems.push(`status route "${r.method} ${r.path}" has no entry in STATUS_ENDPOINTS`);
  }
  emit("### Endpoints", "");
  for (const r of routes) endpointBlock(r, STATUS_ENDPOINTS, placed, "####");
  for (const n of placed) placedNames.add(n);

  const leftovers = [...zodSchemas.keys()].filter((n) => kindOf(n) === "status" && !placed.has(n) && !placedNames.has(n));
  if (leftovers.length) {
    emit("### Status types", "");
    fence("ts", leftovers.map((n) => (placedNames.add(n), declStr(n))).join("\n\n"));
  }
}

function renderOther(): void {
  const leftovers = [...zodSchemas.keys()].filter((n) => !placedNames.has(n));
  if (!leftovers.length) return;
  emit("", "## Other schemas", "");
  emit("Exported schemas that no route or event section above covers.", "");
  fence("ts", leftovers.map((n) => declStr(n)).join("\n\n"));
  for (const n of leftovers) warnings.push(`schema ${n} is not referenced by any route/event section (listed under "Other schemas")`);
}

function build(): string {
  const version = P.PROTOCOL_VERSION;
  emit(
    "<!-- GENERATED FILE. Do not edit by hand. -->",
    `<!-- Source: packages/protocol/src/index.ts. Regenerate with: ${REGEN_CMD} -->`,
    "",
    "# Protocol reference",
    "",
  );
  emit(oneLine(src.headerParagraph).replace(/^@agent-workstation\/protocol - /, "`@agent-workstation/protocol` is "), "");
  emit(`Protocol version: **${String(version)}**. This file is generated from the zod schemas in \`packages/protocol\` by \`scripts/gen-protocol-docs.mts\`; to change the protocol, edit the schemas and regenerate (see [CONTRIBUTING.md](CONTRIBUTING.md)).`, "");
  emit(
    "Contents: [Conventions](#conventions) · [Notation](#notation) · [Constants](#constants) · [Shared types](#shared-types) · [REST API](#rest-api) · [WebSocket](#websocket) · [Terminal WebSocket](#terminal-websocket) · [Status service](#status-service)",
    "",
  );

  emit("## Conventions", "");
  emit(reflow(src.conventions), "");

  emit("## Notation", "");
  emit("Listings are TypeScript-like and derived from the zod schemas.", "");
  emit(
    "| Notation | Meaning |",
    "|---|---|",
    "| `key: T` / `key?: T` | required key / key may be absent |",
    "| `T \\| null` | key present, value may be `null` (nullable) |",
    "| `int` | integer; `number` is any JSON number |",
    "| `string(uuid)`, `string(/re/)` | string with a format or regular expression |",
    "| `string(len ≤200)`, `int(≥0)`, `number(0..100)` | length / numeric bounds |",
    "| `T[]`, `T[](len ≥1)` | array, optionally with a minimum length |",
    "| `unknown` | any JSON value; zod infers `unknown` keys as optional, so receivers must tolerate a missing key |",
    "| `Name` | a named type defined elsewhere in this document |",
    "| `// default: x` | value used when the key is omitted (request side) |",
    "",
  );
  renderConstants();
  renderSharedTypes();
  renderRest();
  renderWebSocket();
  renderStatus();
  renderOther();
  for (const key of Object.keys(EVENT_NOTES)) if (!usedEventNotes.has(key)) warnings.push(`EVENT_NOTES has "${key}" but the protocol has no such variant`);
  // Anchor sanity: the links above must exist.
  const headings = new Set(out.filter((l) => /^#{2,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
  for (const a of ["conventions", "notation", "constants", "shared-types", "rest-api", "websocket", "terminal-websocket", "status-service", "errors"]) {
    if (!headings.has(a)) problems.push(`internal link #${a} has no matching heading`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const next = build();
for (const w of warnings) console.warn(`warning: ${w}`);
for (const p of problems) console.error(`problem: ${p}`);

if (checkMode) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
  let failed = false;
  if (current !== next) {
    const a = current.split("\n");
    const b = next.split("\n");
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
    console.error(`docs/PROTOCOL.md is out of date (first difference at line ${line + 1}).\nRun: ${REGEN_CMD}`);
    failed = true;
  }
  if (problems.length) {
    console.error("The protocol changed in a way the generator does not cover yet; see the problems above (scripts/gen-protocol-docs.mts).");
    failed = true;
  }
  if (failed) process.exit(1);
  console.log("docs/PROTOCOL.md is up to date");
} else {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : null;
  if (current === next) console.log("docs/PROTOCOL.md already up to date");
  else {
    writeFileSync(OUT_PATH, next);
    console.log(`wrote docs/PROTOCOL.md (${next.split("\n").length - 1} lines)`);
  }
  if (problems.length) process.exitCode = 1;
}
