import {
  UPLOAD_HEADERS,
  USER_HEADER,
  type AdminOverview,
  type AdminPricingRefreshResponse,
  type AdminPricingResponse,
  type AdminSettings,
  type AppRelease,
  type BrowserState,
  type ForkResponse,
  type RelevantSearchResponse,
  type RewindBody,
  type RewindResponse,
  type SearchResponse,
  type AdminUsageResponse as _AdminUsageResponseSchema,
  type BrowserSiteGrant,
  type CommandInfo,
  type DiskStatus,
  type FileEntry,
  type KnownHeadsUp,
  type Memory,
  type Me,
  type ModelInfo,
  type PermissionMode,
  type ReadmeAskBody,
  type ReadmeDocName,
  type ReadmeDocResponse,
  type Session,
  type SessionKind,
  type SessionOutput,
  type SessionSettings,
  type Skill,
  type SkillDetail,
  type Snapshot,
  type StoredMessage,
  type UsageLimits,
  type User,
  type WhoAmIResponse,
} from "@agent-workstation/protocol";
import type { z } from "zod";
import {
  AdminUsageResponse,
  FileContentResponse,
  MyUsageResponse,
  Project,
  SendMessageResponse,
  TerminalInfo as TerminalInfoSchema,
  UploadChunkResponse,
} from "@agent-workstation/protocol";

export type AdminUsage = z.infer<typeof AdminUsageResponse>;
export type FileContent = z.infer<typeof FileContentResponse>;
export type MyUsage = z.infer<typeof MyUsageResponse>;
export type SendResult = z.infer<typeof SendMessageResponse>;
export type RewindRequest = z.infer<typeof RewindBody>;
export type RewindResult = z.infer<typeof RewindResponse>;
export type ForkResult = z.infer<typeof ForkResponse>;
export type UploadChunkResult = z.infer<typeof UploadChunkResponse>;
export type ProjectInfo = z.infer<typeof Project>;
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;
export type UsageRange = "today" | "7d" | "30d";
export type SkillScope = Skill["scope"];
export type { _AdminUsageResponseSchema };

export type { AdminOverview } from "@agent-workstation/protocol";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Connection context (user + base URL). The embed overrides the base URL.
// ---------------------------------------------------------------------------
let currentUser: string | null = null;
let baseUrl = "";

export function setApiUser(user: string | null): void {
  currentUser = user;
}
export function getApiUser(): string | null {
  return currentUser;
}
export function setApiBase(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}
export function getApiBase(): string {
  return baseUrl;
}

/** ws:// or wss:// URL for a hub path, honoring `setApiBase` and the page origin. */
export function wsUrl(path: string, query?: Record<string, string | undefined>): string {
  let origin = baseUrl;
  if (!origin) origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  const u = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

type Query = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, String(item));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Send no username (whoami is answered before anyone has signed in). */
  anonymous?: boolean;
}

async function parseError(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  let code: string | undefined;
  let details: unknown;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text);
        if (body && typeof body === "object") {
          message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : message;
          code = typeof body.code === "string" ? body.code : undefined;
          details = body.details;
        }
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {}
  return new ApiError(res.status, message, code, details);
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (currentUser) {
    h[USER_HEADER] = currentUser;
  }
  return h;
}

export async function rawRequest(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers = opts.anonymous ? { ...opts.headers } : authHeaders(opts.headers);
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseUrl}${path}${buildQuery(opts.query)}`, { method, headers, body, signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "Network error — the hub is unreachable", "network", e);
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(method, path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, "Invalid JSON from hub", "bad_json", text.slice(0, 200));
  }
}

/**
 * True when the hub does not implement a route (yet): 501, or a 404 that is not about a specific resource.
 * Screens built on newer routes (projects, skills) use this to show "not available yet" instead of an error.
 */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 501 || e.status === 404);
}

/** 409 `stale_diff`: the file changed on the server after the diff was fetched; refetch before retrying. */
export function isStaleDiff(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === "stale_diff";
}

/** Route lists are documented as arrays; tolerate `{ <key>: [] }` envelopes too. */
export function asList<T>(res: unknown, ...keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    for (const k of keys) {
      const v = (res as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
/**
 * HTTP header values must be Latin-1: percent-encode only non-ASCII characters and "%" itself.
 * Plain ASCII paths are sent verbatim, so a hub that does not decode still works for them.
 */
export function encodeHeaderPath(path: string): string {
  return path.replace(/[^\x20-\x7e]|%/g, (c) => encodeURIComponent(c));
}

export const api = {
  health: () => request<{ ok: boolean; hostname?: string }>("GET", "/api/health"),
  me: () => request<Me>("GET", "/api/me"),
  /** Who the hub thinks is calling: Tailscale login, the names bound to it, the one to sign in with. Sent without a username. */
  whoami: () => request<WhoAmIResponse>("GET", "/api/whoami", { anonymous: true }),
  /** Every published Mac app release, newest first per platform. Sent without a username: the download page needs no sign-in. */
  appReleases: async () => asList<AppRelease>(await request("GET", "/api/app/releases", { anonymous: true }), "releases"),
  /** One readme page (Markdown) and whether the docs assistant is available. Sent without a username: reading /readme needs no sign-in. */
  readmeDoc: (doc: ReadmeDocName, signal?: AbortSignal) => request<ReadmeDocResponse>("GET", `/api/readme/${doc}`, { anonymous: true, signal }),
  /** The docs assistant: an SSE response (`delta` / `done` / `error` events); 403 when it is not available, 401 without a signed-in user. */
  readmeAsk: (body: ReadmeAskBody, signal?: AbortSignal) => rawRequest("POST", "/api/readme/ask", { body, signal }),
  models: async () => asList<ModelInfo>(await request("GET", "/api/models"), "models"),
  commands: async (sessionId?: string) => asList<CommandInfo>(await request("GET", "/api/commands", { query: { sessionId } }), "commands"),

  users: async () => asList<User>(await request("GET", "/api/users"), "users"),
  createUser: (name: string) => request<User>("POST", "/api/users", { body: { name } }),
  patchUser: (name: string, body: Partial<Pick<User, "enabled" | "terminalEnabled" | "weeklyTokenLimit" | "modelAllowlist">>) =>
    request<User>("PATCH", `/api/users/${encodeURIComponent(name)}`, { body }),
  /** The caller's own defaults for new sessions (null = follow the server default). */
  patchPreferences: (body: { defaultModel?: string | null; defaultEffort?: Session["effort"]; memoryEnabled?: boolean; notificationsEnabled?: boolean; instructions?: string }) => request<User>("PATCH", "/api/me/preferences", { body }),

  /** The caller's memories, newest first. */
  memories: async () => asList<Memory>(await request("GET", "/api/me/memories"), "memories"),
  createMemory: (text: string) => request<Memory>("POST", "/api/me/memories", { body: { text } }),
  updateMemory: (id: string, text: string) => request<Memory>("PATCH", `/api/me/memories/${encodeURIComponent(id)}`, { body: { text } }),
  deleteMemory: (id: string) => request<void>("DELETE", `/api/me/memories/${encodeURIComponent(id)}`),
  /** Heads-ups the caller marked "Knew this already", newest first. */
  knownHeadsUps: async () => asList<KnownHeadsUp>(await request("GET", "/api/me/heads-up/known"), "known"),
  addKnownHeadsUp: (text: string) => request<KnownHeadsUp | undefined>("POST", "/api/me/heads-up/known", { body: { text } }),
  removeKnownHeadsUp: (id: string) => request<void>("DELETE", "/api/me/heads-up/known", { query: { id } }),
  /** Websites the caller always allows the server browser on, most recently used first. */
  browserSites: async () => asList<BrowserSiteGrant>(await request("GET", "/api/me/browser-sites"), "sites"),
  removeBrowserSite: (origin: string) => request<void>("DELETE", "/api/me/browser-sites", { query: { origin } }),

  sessions: async (kind?: SessionKind) => asList<Session>(await request("GET", "/api/sessions", { query: { kind } }), "sessions"),
  createSession: (body: { kind: SessionKind; title?: string; cwd?: string; model?: string; permissionMode?: PermissionMode; effort?: Session["effort"]; incognito?: boolean }) =>
    request<Session>("POST", "/api/sessions", { body }),
  session: (id: string) => request<Session>("GET", `/api/sessions/${id}`),
  renameSession: (id: string, title: string) => request<Session>("PATCH", `/api/sessions/${id}`, { body: { title } }),
  setSessionNotify: (id: string, notify: boolean) => request<Session>("PATCH", `/api/sessions/${id}`, { body: { notify } }),
  deleteSession: (id: string) => request<void>("DELETE", `/api/sessions/${id}`),
  messages: async (id: string, after = 0, limit = 500) => asList<StoredMessage>(await request("GET", `/api/sessions/${id}/messages`, { query: { after, limit } }), "messages"),
  sendMessage: (id: string, body: { uuid: string; text: string; attachments?: unknown[] }) => request<SendResult>("POST", `/api/sessions/${id}/messages`, { body }),
  patchSettings: (id: string, settings: SessionSettings) => request<unknown>("PATCH", `/api/sessions/${id}/settings`, { body: settings }),
  stop: (id: string) => request<void>("POST", `/api/sessions/${id}/stop`),
  /** Go back to just before a user message (the hub announces it with `messages_rewound`). */
  rewind: (id: string, body: RewindRequest) => request<RewindResult>("POST", `/api/sessions/${id}/rewind`, { body }),
  /** A new session up to a message; `draft` is the text for its composer (a user message is not included). */
  fork: (id: string, messageUuid: string) => request<ForkResult>("POST", `/api/sessions/${id}/fork`, { body: { messageUuid } }),
  pinMessage: (id: string, messageUuid: string) => request<unknown>("PUT", `/api/sessions/${id}/pins/${encodeURIComponent(messageUuid)}`),
  unpinMessage: (id: string, messageUuid: string) => request<unknown>("DELETE", `/api/sessions/${id}/pins/${encodeURIComponent(messageUuid)}`),
  close: (id: string) => request<void>("POST", `/api/sessions/${id}/close`),
  /** Stop one background task (bash command or subagent) of a session; the task list follows via `background_tasks`. */
  stopTask: (id: string, taskId: string) => request<void>("POST", `/api/sessions/${id}/tasks/${encodeURIComponent(taskId)}/stop`),

  /** Files the session's agent wrote (from the hub's file_touches), newest first. */
  sessionOutputs: async (id: string) => asList<SessionOutput>(await request("GET", `/api/sessions/${id}/outputs`), "outputs"),

  filesTree: async (path = "", depth = 1) => asList<FileEntry>(await request("GET", "/api/files/tree", { query: { path, depth } }), "entries", "files", "tree"),
  filesContent: (path: string) => request<FileContent>("GET", "/api/files/content", { query: { path } }),
  filesDelete: (path: string) => request<void>("DELETE", "/api/files", { query: { path } }),
  filesMkdir: (path: string) => request<void>("POST", "/api/files/mkdir", { body: { path } }),
  uploadChunk: (args: { uploadId: string; path: string; index: number; total: number; totalBytes: number; body: Blob | ArrayBuffer; signal?: AbortSignal; fetchImpl?: typeof fetch }) =>
    request<UploadChunkResult>("PUT", "/api/files/upload", {
      rawBody: args.body as BodyInit,
      signal: args.signal,
      fetchImpl: args.fetchImpl,
      headers: {
        "Content-Type": "application/octet-stream",
        [UPLOAD_HEADERS.uploadId]: args.uploadId,
        [UPLOAD_HEADERS.path]: encodeHeaderPath(args.path),
        [UPLOAD_HEADERS.chunkIndex]: String(args.index),
        [UPLOAD_HEADERS.chunkTotal]: String(args.total),
        [UPLOAD_HEADERS.totalBytes]: String(args.totalBytes),
      },
    }),

  /** Which chunks the hub already holds for an upload (resume after a failure/reload). */
  uploadStatus: (uploadId: string) => request<UploadChunkResult>("GET", "/api/files/upload", { query: { uploadId } }),

  projects: async () => asList<ProjectInfo>(await request("GET", "/api/projects"), "projects"),
  project: (id: string) => request<ProjectInfo>("GET", `/api/projects/${encodeURIComponent(id)}`),
  /** DELETE /api/projects/:id — `discardRemaining` must be true when pending changes / undownloaded files exist. */
  deleteProject: (id: string, discardRemaining: boolean) => request<void>("DELETE", `/api/projects/${encodeURIComponent(id)}`, { body: { discardRemaining } }),
  /** GET /api/projects/:id/history — snapshots, syncs, accepts and trash refs. */
  projectHistory: async (id: string) => asList<Snapshot>(await request("GET", `/api/projects/${encodeURIComponent(id)}/history`), "snapshots", "history", "entries"),
  /** POST /api/projects/:id/restore — one file (`path`) or the whole project; the hub writes a trash ref first. */
  restoreProject: (id: string, body: { ref: string; path?: string }) => request<unknown>("POST", `/api/projects/${encodeURIComponent(id)}/restore`, { body }),

  skills: async () => asList<Skill>(await request("GET", "/api/skills"), "skills"),
  skill: (name: string, scope: SkillScope) => request<SkillDetail>("GET", `/api/skills/${encodeURIComponent(name)}`, { query: { scope } }),
  createSkill: (body: { name: string; content: string; scope: SkillScope }) => request<Skill>("POST", "/api/skills", { body }),
  updateSkill: (name: string, body: { name: string; content: string; scope: SkillScope }) => request<Skill>("PUT", `/api/skills/${encodeURIComponent(name)}`, { body }),
  deleteSkill: (name: string, scope: SkillScope) => request<void>("DELETE", `/api/skills/${encodeURIComponent(name)}`, { query: { scope } }),

  /** GET /api/search — keyword + fuzzy match over titles and messages, newest first (`«…»` marks the hits). */
  search: (q: string, limit = 20, signal?: AbortSignal) => request<SearchResponse>("GET", "/api/search", { query: { q, limit }, signal }),
  /** GET /api/search/relevant — sessions ranked by meaning; 503 api_unavailable without API credits. */
  searchRelevant: (q: string, limit = 10, signal?: AbortSignal) => request<RelevantSearchResponse>("GET", "/api/search/relevant", { query: { q, limit }, signal }),

  usageLimits: () => request<UsageLimits>("GET", "/api/usage/limits"),
  usageMe: (range: UsageRange) => request<MyUsage>("GET", "/api/usage/me", { query: { range } }),
  disk: () => request<DiskStatus>("GET", "/api/disk"),

  adminOverview: () => request<AdminOverview>("GET", "/api/admin/overview"),
  adminUsage: (range: UsageRange) => request<AdminUsage>("GET", "/api/admin/usage", { query: { range } }),
  adminSettings: () => request<AdminSettings>("GET", "/api/admin/settings"),
  patchAdminSettings: (patch: Partial<AdminSettings>) => request<AdminSettings>("PATCH", "/api/admin/settings", { body: patch }),

  adminPricing: () => request<AdminPricingResponse>("GET", "/api/admin/pricing"),
  refreshAdminPricing: () => request<AdminPricingRefreshResponse>("POST", "/api/admin/pricing/refresh"),

  terminals: async () => asList<TerminalInfo>(await request("GET", "/api/terminals"), "terminals"),
  createTerminal: (cwd?: string) => request<TerminalInfo>("POST", "/api/terminals", { body: cwd ? { cwd } : {} }),
  deleteTerminal: (id: string) => request<void>("DELETE", `/api/terminals/${encodeURIComponent(id)}`),

  browser: () => request<BrowserState>("GET", "/api/browser"),
  startBrowser: () => request<BrowserState>("POST", "/api/browser/start"),
  stopBrowser: () => request<BrowserState>("POST", "/api/browser/stop"),
};

/**
 * DELETE a session in a way that survives the page going away (`pagehide`): a keepalive fetch. `sendBeacon` cannot be
 * used for this — it only POSTs and cannot carry the `X-Workstation-User` header (the hub has no POST delete route).
 */
export function deleteSessionKeepalive(id: string): void {
  try {
    void fetch(`${baseUrl}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders(), keepalive: true }).catch(() => {});
  } catch {
    /* page is going away anyway */
  }
}

// ---------------------------------------------------------------------------
// Downloads (fetch with the user header, then save as a blob: <a href> cannot send headers)
// ---------------------------------------------------------------------------
export async function fetchFileBlob(paths: string | string[], signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const list = Array.isArray(paths) ? paths : [paths];
  const res = await rawRequest("GET", "/api/files/download", { query: { path: list }, signal });
  const blob = await res.blob();
  let filename = "";
  const cd = res.headers.get("Content-Disposition");
  const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m?.[1]) {
    try {
      filename = decodeURIComponent(m[1]);
    } catch {
      filename = m[1];
    }
  }
  if (!filename) filename = list.length > 1 ? "download.zip" : (list[0] ?? "download").split("/").pop() || "download";
  return { blob, filename };
}

/** GET /api/projects/:id/raw?path= — the working-tree bytes of one project file (binary previews, downloads). */
export async function fetchProjectRaw(projectId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await rawRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/raw`, { query: { path }, signal });
  return res.blob();
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadFiles(paths: string | string[]): Promise<void> {
  const { blob, filename } = await fetchFileBlob(paths);
  saveBlob(blob, filename);
}
