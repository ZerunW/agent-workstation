#!/usr/bin/env node
/**
 * Mock Agent Workstation hub for developing/testing packages/web without the server.
 *
 *   node mock/mock-hub.mjs                       # http://localhost:9000, serves ../dist if built
 *   PORT=9000 MOCK_ADMIN=admin MOCK_DISK=warn node mock/mock-hub.mjs
 *
 * Env:
 *   PORT          listen port (default 9000)
 *   MOCK_ADMIN    username that is admin (default "admin")
 *   MOCK_DISK     ok | warn | block (default ok)
 *   MOCK_ROOT     workspace root (default <tmp>/workstation-mock); per user: <root>/<user>/{inbox,projects}
 *   MOCK_REMOTE   "off" => remoteClaudeEnabled=false and sends 403 remote_disabled
 *   MOCK_DIST     directory with the built UI to serve (default ../dist)
 *   MOCK_REPLAY_CAP        newest messages sent in a WS replay before it is flagged `truncated` (default 1000)
 *   MOCK_NO_PROJECT_ID=1   omit Session.projectId (older hub): the UI must derive the project from the cwd
 *   MOCK_NO_RELEASES=1     GET /api/app/releases (the /download page) lists no release
 *   MOCK_README_ASSISTANT  off (GET /api/readme/:doc says assistant:false, ask answers 403) | forbidden (assistant:true, ask answers 403) | error (the answer ends with an SSE error)
 *   MOCK_NO_PROJECTS=1    answer 501 on /api/projects*, /api/skills* ("not available yet" states)
 *   MOCK_API               API credits: (default) key configured, $12.00 of $100 spent, period resets on the 1st | off (Me.apiAvailable=false,
 *                          UsageLimits.api=null, creating or sending answers 503 api_unavailable) | low (almost used up: warning/critical) |
 *                          used (budget used up: sending answers 429 api_limit_reached)
 *   MOCK_HOSTNAME          GET /api/health `hostname` (default "workstation-mock"); MOCK_NO_HOSTNAME=1 omits it (an older hub)
 *   MOCK_RELEVANT_DELAY_MS delay of GET /api/search/relevant (default 450: long enough to see the loading skeleton)
 *
 * Magic words in a user message (Code sessions unless noted):
 *   "tool" | "bash"  Bash tool_use + tool_result + text      "edit"      Edit permission request (allow/deny)
 *   "create a file <name> containing <text>"  Write permission request; Allow writes the file in the session's cwd
 *   "think"          thinking block (chat too)                "markdown"  long markdown reply (chat too)
 *   "limit"          rate_limit assistant error + notice      "long"      ~40 paragraphs
 *   "queue me"       POST answers {state:'queued'} then runs  "#429"      weekly_limit error
 *   "remember <text>" | "forget <text>"  (Chat) the hub's memory tools: a mcp__workstation-memory__remember / forget call, saved on the Memory page
 *   "background"     (Code) starts a background shell command and a subagent (Overview → Background tasks; stop via POST /api/sessions/:id/tasks/:taskId/stop)
 *   "wrap up"        (Code) a TodoWrite call (pinned task list), three ended background tasks (Overview → "3 finished") and, when the turn ends, an end-of-turn box with two actions
 *   "subagent"       the session proposes two subagents (mcp__workstation_subagent__run_subagents): "Start 2 subagents?" card (Start / Don't start), then a hidden child
 *                    session per agent (parentSessionId) with a workstation_subagent background task while it runs, then one `session: <id>` + answer section per agent
 *                    (separated by `--- subagent ---`); "one subagent" proposes one, "claude subagent" uses Claude for both, "subagent permission" makes the first child ask first (card forwarded with `subagent`)
 *   "slow"           a ~20 s turn that streams usage ticks (the live turn indicator: elapsed time + tokens)
 *   "browse <url>"   (server browser) a navigate call that asks `browserSite` permission first unless the origin is in Browser sites
 *                    (Allow this session / Always allow / Deny); GET | DELETE /api/me/browser-sites list and remove the always-allowed sites
 *   "download <https url>"  (Chat) the hub's download_file (mcp__workstation_fetch__download_file): github.com / pypi.org / arxiv.org run at once, any other host
 *                    asks first ("Download from <host>?" with the safety check's reason); a denial answers an error result
 *   "search chats <query>" | "read chat <session id>"  the hub's read-only history tools (mcp__workstation-history__search_conversations / read_conversation); not in incognito chats
 * POST /api/sessions/:id/rewind | /fork and PUT | DELETE /api/sessions/:id/pins/:uuid are served (rewind drops the messages and emits messages_rewound;
 * `files: true` answers 409 unsupported outside a projects/ folder; fork copies the history up to the message; pins live in Session.pinnedMessages).
 * "edit" in a Code session also leaves `src/util.ts` of demo-app as a pending change touched by that session.
 * Everything outgoing on /ws is checked with ServerEvent.safeParse and logged when it does not match.
 *
 * Test hooks (no auth, mock only):
 *   POST /__mock/emit   {user, event}                          push any ServerEvent to a user's sockets (sync_conflict, review_changed, …)
 *   POST /__mock/seed   {user, sessionId, count}               append `count` filler messages to a session (long-history / truncated replay)
 *   POST /__mock/seed-session {user, title, kind?, model?, incognito?, ageMinutes?, messages:[{role:"user"|"assistant", text}]}
 *                                                            create a session with a ready-made history (search and history-tool demos); answers the Session
 *   POST /__mock/api {spentUsd}                                set this period's API spend (broadcasts usage_limits)
 *   POST /__mock/browser {user, controlledBy?, url?}           (browser panel) set the server browser's controller / address and broadcast browser_state
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { structuredPatch } from "diff";
import { ServerEvent, ClientEvent, CreateSessionBody, SendMessageBody, SessionSettings, CreateUserBody, SkillBody, PROTOCOL_VERSION } from "@agent-workstation/protocol";

const PORT = Number(process.env.PORT || 9000);
const ADMIN = process.env.MOCK_ADMIN || "admin";
const DISK = process.env.MOCK_DISK || "ok";
const ROOT = process.env.MOCK_ROOT || path.join(os.tmpdir(), "workstation-mock");
const REPLAY_CAP = Number(process.env.MOCK_REPLAY_CAP || 1000);
const NO_PROJECT_ID = process.env.MOCK_NO_PROJECT_ID === "1";
const NO_PROJECTS = process.env.MOCK_NO_PROJECTS === "1";
const DIST = process.env.MOCK_DIST ? path.resolve(process.env.MOCK_DIST) + path.sep : fileURLToPath(new URL("../dist/", import.meta.url));

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUBAGENTS_TOOL = "mcp__workstation_subagent__run_subagents";
const uuid = () => crypto.randomUUID();
const uuidFrom = (s) => {
  const h = crypto.createHash("sha1").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngGradient(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 200);
      raw[o + 2] = 150;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Store-only ZIP writer. entries: [{name, data: Buffer}] */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // utf-8 names
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".txt": "text/plain; charset=utf-8" };
const IMG_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".py", ".css", ".html", ".yml", ".yaml", ".toml", ".sh", ".csv", ".log", ".mjs", ".cjs", ".rs", ".go", ".c", ".h", ".swift"]);

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const settings = { remoteClaudeEnabled: process.env.MOCK_REMOTE !== "off", diskWarnPercent: 80, diskBlockPercent: 95, defaultWeeklyTokenLimit: 5_000_000, defaultModel: "claude-opus-5-5", defaultEffort: "high", apiMonthlyLimitUsd: 100, apiResetDay: 1, serviceReserveUsd: 2 };
const users = new Map(); // name -> User
const sessions = new Map(); // id -> session record { s: Session, messages: [], partial, pending, run }
const terminals = new Map(); // id -> record
const uploads = new Map(); // `${user}:${uploadId}` -> record
const projectsByUser = new Map(); // user -> Project[] (with .pending Map)
const memoriesByUser = new Map(); // user -> Memory[] (newest first)
const browserSitesByUser = new Map(); // user -> Map<origin, BrowserSiteGrant>
const clients = new Set(); // { ws, user, subs:Set<string> }

const NO_MODEL_FLAGS = process.env.MOCK_NO_MODEL_FLAGS === "1";
const EFFORTS_5 = ["low", "medium", "high", "xhigh", "max"];
const claude = (value, displayName, family, legacy, extra = {}) => ({ value, displayName, family, legacy, supportsEffort: true, supportedEffortLevels: EFFORTS_5, supportsAutoMode: true, ...extra });
// Hub order: the newest of each family first (the top level of the model menu), then the older versions ("More models").
const ALL_MODELS = [
  // the SDK's pseudo-model: the UI hides it (its "Default" badge already marks the effective default)
  claude("default", "Default (recommended)", "default", false, { description: "Opus 5.5 with 1M context · Most capable for complex work" }),
  claude("claude-opus-5-5", "Opus 5.5", "opus", false, { description: "Most capable, best for hard problems" }),
  claude("claude-fable-5-1", "Fable 5.1", "fable", false, { description: "Frontier model, research preview", supportedEffortLevels: ["low", "medium", "high", "max"], supportsAutoMode: false }),
  claude("claude-sonnet-5-5", "Sonnet 5.5", "sonnet", false, { description: "Balanced speed and quality for everyday coding and writing tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh"] }),
  claude("claude-haiku-5-5", "Haiku 5.5", "haiku", false, { description: "Fastest, for quick answers", supportsEffort: false, supportedEffortLevels: undefined, supportsAutoMode: false }),
  claude("claude-haiku-4-5", "Haiku 4.5", "haiku", true, { supportsEffort: false, supportedEffortLevels: undefined, supportsAutoMode: false }),
  claude("claude-sonnet-5", "Sonnet 5", "sonnet", true, { supportedEffortLevels: ["low", "medium", "high", "xhigh"] }),
  claude("claude-opus-5", "Opus 5", "opus", true),
  claude("claude-fable-5", "Fable 5", "fable", true, { supportedEffortLevels: ["low", "medium", "high", "max"], supportsAutoMode: false }),
  claude("claude-opus-4-8", "Opus 4.8", "opus", true),
  claude("claude-opus-4-7", "Opus 4.7", "opus", true),
  claude("claude-opus-4-6", "Opus 4.6", "opus", true),
  claude("claude-sonnet-4-6", "Sonnet 4.6", "sonnet", true, { supportedEffortLevels: ["low", "medium", "high", "xhigh"] }),
];
/** What GET /api/models sends: the flags only when this mock plays a hub that has them. */
const servedModels = () => ALL_MODELS.map(({ family: _f, legacy: _l, ...rest }) => (NO_MODEL_FLAGS ? rest : { family: _f, legacy: _l, ...rest }));
const modelEntry = (value) => ALL_MODELS.find((m) => m.value === value);

// ---- API credits: the accounting the hub keeps for every turn ----------------------------------------------
const API_MODE = process.env.MOCK_API || "";

const README_DOCS = {
  features: `# Agent Workstation\n\nA workstation on your own server, in your browser and the Mac app.\n\n## Chat and Code\n\nChat for questions, Code for work in a project folder.\n\n<details>\n<summary>Permission modes</summary>\n\nAsk first, accept edits, or plan only.\n\n</details>\n\n<details>\n<summary>Subagents</summary>\n\nA session can hand independent work to other agents.\n\n</details>\n\n## Files and review\n\nChanges reach your Mac only after you accept them.\n\n\`\`\`\n<details> inside a code block stays code\n\`\`\`\n\n## Usage\n\nSee what each model costs you.\n`,
  "getting-started": `# Get started\n\n## Install the Mac app\n\nOpen **/download** and pick your build.\n\n## Sign in\n\nYour Tailscale account signs you in.\n\n<details open>\n<summary>Something wrong?</summary>\n\nCheck that the server is reachable.\n\n</details>\n`,
};
const round2 = (n) => Math.round(n * 100) / 100;
let apiSpend = API_MODE === "low" ? 96.5 : 12;
if (API_MODE === "used") apiSpend = settings.apiMonthlyLimitUsd;
/** UsageLimits.api: null when no key is configured / the budget is 0. */
function apiBlock() {
  if (API_MODE === "off" || !(settings.apiMonthlyLimitUsd > 0)) return null;
  const limit = settings.apiMonthlyLimitUsd;
  const n = new Date();
  let start = new Date(n.getFullYear(), n.getMonth(), settings.apiResetDay);
  if (start > n) start = new Date(n.getFullYear(), n.getMonth() - 1, settings.apiResetDay);
  const next = new Date(start.getFullYear(), start.getMonth() + 1, settings.apiResetDay);
  const percent = (apiSpend / limit) * 100;
  const severity = percent >= 95 ? "critical" : percent >= 80 ? "warning" : "normal";
  return { spentUsd: round2(apiSpend), limitUsd: limit, percent, periodStart: start.toISOString(), resetsAt: next.toISOString(), severity };
}
const COMMANDS = [
  { name: "compact", description: "Summarize the conversation to free up context", argumentHint: "[instructions]" },
  { name: "clear", description: "Start a fresh conversation (history stays in the sidebar)" },
  { name: "context", description: "Show current context usage" },
  { name: "cost", description: "Show session cost and duration" },
  { name: "usage", description: "Show API credit usage" },
  { name: "help", description: "List available commands" },
  { name: "init", description: "Create a CLAUDE.md for this project" },
  { name: "review", description: "Review a pull request", argumentHint: "[pr-number]" },
  { name: "security-review", description: "Security review of pending changes" },
  { name: "memory", description: "Edit Claude memory files" },
];

// ---- skills: global ones are shared, user ones are per user (SKILL.md text; description from the frontmatter)
const skillMd = (name, description, body = "Follow these steps:\n\n1. Read the input.\n2. Produce the output.\n") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`;
const globalSkills = new Map([
  ["deploy-checklist", { content: skillMd("deploy-checklist", "Walk through the release checklist before deploying"), updatedAt: now() }],
  ["release-notes", { content: skillMd("release-notes", "Draft release notes from the git log"), updatedAt: now() }],
]);
const userSkills = new Map(); // user -> Map(name -> {content, updatedAt})
const skillsOf = (user) => {
  let m = userSkills.get(user);
  if (!m) {
    m = new Map([
      ["pdf-extract", { content: skillMd("pdf-extract", "Extract text and tables from a PDF in inbox/"), updatedAt: now() }],
      ["summarize-notes", { content: skillMd("summarize-notes", "Summarize notes into bullet points"), updatedAt: now() }],
    ]);
    userSkills.set(user, m);
  }
  return m;
};
const frontmatterDescription = (content) => /^---\r?\n[\s\S]*?^description:\s*(.*?)\s*$/m.exec(content)?.[1] ?? "";
const skillView = (name, scope, rec) => ({ name, description: frontmatterDescription(rec.content), scope, updatedAt: rec.updatedAt });
const allSkills = (user) => [...skillsOf(user)].map(([n, r]) => skillView(n, "user", r)).concat([...globalSkills].map(([n, r]) => skillView(n, "global", r)));
const commandsFor = (user) => [...COMMANDS, ...allSkills(user).map((k) => ({ name: k.name, description: k.description, isSkill: true }))];

function ensureUser(name, extra = {}) {
  let u = users.get(name);
  if (!u) {
    u = { name, createdAt: now(), isAdmin: name === ADMIN, enabled: true, terminalEnabled: true, weeklyTokenLimit: name === "alice" ? 2_000_000 : null, modelAllowlist: null, instructions: "", ...extra };
    users.set(name, u);
    seedWorkspace(name);
  }
  return u;
}

function userRoot(user) {
  return path.join(ROOT, user);
}

/** Resolve a workspace-relative path; null when it escapes the user's root. */
function safePath(user, rel) {
  if (rel.includes("\0")) return null;
  const root = userRoot(user);
  const abs = path.resolve(root, rel.replace(/^\/+/, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

const APP_OLD = Array.from({ length: 70 }, (_, i) => `export function step${i + 1}(input: number): number {\n  return input + ${i + 1};\n}`).join("\n\n") + "\n";
function appNew() {
  const blocks = APP_OLD.trimEnd().split("\n\n");
  blocks[2] = "export function step3(input: number): number {\n  // changed: clamp before adding\n  return Math.max(0, input) + 3;\n}";
  blocks[30] = "export function step31(input: number): number {\n  return input * 31;\n}";
  blocks.splice(55, 0, "export function extraStep(): string {\n  return 'added by Claude';\n}");
  return blocks.join("\n\n") + "\n";
}

function seedWorkspace(user) {
  const w = (rel, data) => {
    const abs = path.join(userRoot(user), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, data);
  };
  fs.mkdirSync(path.join(userRoot(user), "inbox"), { recursive: true });
  fs.mkdirSync(path.join(userRoot(user), "projects"), { recursive: true });
  fs.mkdirSync(path.join(userRoot(user), ".chat"), { recursive: true });
  w("inbox/sample.png", pngGradient(96, 64));
  w("inbox/blob.bin", Buffer.concat([Buffer.from([0, 1, 2, 3, 0, 255, 254]), crypto.randomBytes(2048)]));
  w("inbox/readme.txt", "Drop files here — they land in inbox/.\n");
  w("docs/notes.txt", Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog`).join("\n") + "\n");
  w("docs/résumé-ünïcode.md", "# Résumé\n\nAn example file with non-ASCII characters in its name.\n");
  w("projects/demo-app/README.md", "# demo-app\n\nA tiny project used by the mock hub.\n\n```ts\nconsole.log('hi');\n```\n");
  w("projects/demo-app/package.json", JSON.stringify({ name: "demo-app", version: "1.0.0", scripts: { test: "vitest" } }, null, 2) + "\n");
  w("projects/demo-app/src/app.ts", appNew());
  w("projects/demo-app/src/util.ts", "export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);\n");
  w("projects/demo-app/src/components/Button.tsx", "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n");
  w("projects/demo-app/assets/logo.bin", crypto.randomBytes(512));
  w("projects/notes/todo.md", "- [ ] try the mock hub\n- [x] build the UI\n");

  const mk = (name) => ({
    id: uuidFrom(`${user}/${name}`),
    user,
    name,
    path: `projects/${name}`,
    createdAt: now(),
    localCommit: crypto.createHash("sha1").update(user + name).digest("hex"),
    origin: "mock-mac",
    pending: new Map(),
    touched: new Map(), // path -> lastTouchedBy
    undownloaded: name === "demo-app" ? 3 : 0,
    history: [],
  });
  const demo = mk("demo-app");
  demo.pending.set("src/app.ts", { oldText: APP_OLD, newText: appNew(), binary: false });
  demo.pending.set("src/new-file.ts", { oldText: "", newText: "export const hello = 'world';\nexport const answer = 42;\n", binary: false });
  demo.pending.set("assets/logo.bin", { oldText: null, newText: null, binary: true });
  const earlier = uuidFrom(`${user}/earlier-session`);
  demo.touched.set("src/app.ts", { sessionId: earlier, turn: 2, tool: "Edit", at: now() });
  demo.touched.set("src/new-file.ts", { sessionId: earlier, turn: 3, tool: "Write", at: now() });
  const notes = mk("notes");
  for (const p of [demo, notes]) seedHistory(p, earlier);
  projectsByUser.set(user, [demo, notes]);
}

const refOf = (seed) => crypto.createHash("sha1").update(seed).digest("hex");
function seedHistory(p, sessionId) {
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const add = (kind, message, minutesAgo, extra = {}) => p.history.push({ ref: refOf(`${p.id}/${kind}/${message}/${minutesAgo}`), sessionId: null, turn: null, at: ago(minutesAgo), message, kind, ...extra });
  add("sync", "Sync from mock-mac: 12 files", 600);
  add("sync", "Sync from mock-mac: 3 files", 90);
  add("snapshot", "Turn 1: add the util module", 240, { sessionId, turn: 1 });
  add("snapshot", "Turn 2: clamp before adding", 200, { sessionId, turn: 2 });
  add("snapshot", "Turn 3: new-file.ts", 120, { sessionId, turn: 3 });
  add("accept", "Accepted src/util.ts", 180);
  add("accept", "Accepted 2 hunks of README.md", 100);
  add("trash", "Before restore of src/util.ts", 60);
}

function dirSize(abs) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {}
  return total;
}

function projectView(user, p) {
  const { pending: _pending, touched: _touched, undownloaded: _undownloaded, history: _history, ...rest } = p;
  return { ...rest, pendingFiles: p.pending.size, sizeBytes: dirSize(safePath(user, p.path) ?? "") };
}

ensureUser(ADMIN);
ensureUser("alice");
if (!users.has("admin")) ensureUser("admin", { isAdmin: false });

// ---------------------------------------------------------------------------
// websocket plumbing
// ---------------------------------------------------------------------------
function sendRaw(c, ev) {
  const parsed = ServerEvent.safeParse(ev);
  if (!parsed.success) log("WARN outgoing event failed ServerEvent.safeParse:", ev?.type, JSON.stringify(parsed.error.issues[0]));
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(ev));
}

// ---------------------------------------------------------------------------
// browser (the server's per-user Chromium): state + generated JPEG frames
// ---------------------------------------------------------------------------
// Baseline JPEG, 4:4:4, DC-only (every 8x8 block is one flat colour), so no dependency is needed to make real frames.
function huffCodes(bits, vals) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes.set(vals[k++], { code: code++, len });
    code <<= 1;
  }
  return codes;
}
const JPEG_DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const JPEG_DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const JPEG_DC = huffCodes(JPEG_DC_BITS, JPEG_DC_VALS);
const JPEG_AC_EOB = { code: 0, len: 1 }; // AC table holds one symbol (0x00 = end of block)

/** `colorAt(bx, by)` -> [r, g, b] for the 8x8 block at (bx, by); returns a Buffer. */
function encodeFlatJpeg(width, height, colorAt) {
  const bw = Math.ceil(width / 8);
  const bh = Math.ceil(height / 8);
  const seg = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 8)])); // DC step 8 => level = sample - 128
  const sof = seg(0xc0, Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]));
  const dht = (cls, bits, vals) => seg(0xc4, Buffer.concat([Buffer.from([(cls << 4) | 0]), Buffer.from(bits), Buffer.from(vals)]));
  const acBits = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const sos = seg(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));
  const out = [];
  let acc = 0;
  let nbits = 0;
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const prev = [0, 0, 0];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const [r, g, b] = colorAt(bx, by);
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      [yy, cb, cr].forEach((v, ci) => {
        const level = Math.max(-128, Math.min(127, Math.round(v) - 128));
        const diff = level - prev[ci];
        prev[ci] = level;
        const cat = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
        const h = JPEG_DC.get(cat);
        put(h.code, h.len);
        if (cat) put(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
        put(JPEG_AC_EOB.code, JPEG_AC_EOB.len);
      });
    }
  }
  if (nbits) put(0x7f, 8 - nbits);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sof, dht(0, JPEG_DC_BITS, JPEG_DC_VALS), dht(1, acBits, [0]), sos, Buffer.from(out), Buffer.from([0xff, 0xd9])]);
}

const browsers = new Map(); // user -> { running, url, title, controlledBy, sessionId, history, idx, tick }
const BROWSER_VIEWPORT = { width: 1280, height: 800 };
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};
function browserFor(userName) {
  let b = browsers.get(userName);
  if (!b) browsers.set(userName, (b = { running: false, url: null, title: null, controlledBy: null, sessionId: null, history: [], idx: -1, tick: 0, lastInput: null }));
  return b;
}
const browserViewers = (userName) => [...clients].filter((c) => c.user === userName && c.browserView?.on).length;
function browserState(userName) {
  const b = browserFor(userName);
  return { running: b.running, url: b.running ? b.url : null, title: b.running ? b.title : null, controlledBy: b.running ? b.controlledBy : null, sessionId: b.sessionId, viewers: browserViewers(userName), viewport: BROWSER_VIEWPORT };
}
function broadcastBrowser(userName) {
  emit(userName, { type: "browser_state", state: browserState(userName) });
}
function browserGo(b, url) {
  b.history = b.history.slice(0, b.idx + 1);
  b.history.push(url);
  b.idx = b.history.length - 1;
  b.url = url;
  b.title = hostOf(url) || url;
}
function browserHistory(b, action) {
  if (action === "back" && b.idx > 0) b.idx--;
  else if (action === "forward" && b.idx < b.history.length - 1) b.idx++;
  b.url = b.history[b.idx] ?? b.url;
  b.title = hostOf(b.url) || b.url;
}
function browserInput(userName, input) {
  const b = browserFor(userName);
  if (!b.running) return;
  b.lastInput = input;
  // down + up (derived click) and wheel move the marker; plain hover moves do not
  if ((input.kind === "mouse" && input.action === "up") || input.kind === "wheel" || input.kind === "key" || input.kind === "text") b.tick++;
  if (input.kind === "navigate") browserGo(b, input.url);
  else if (input.kind === "history") browserHistory(b, input.action);
  b.controlledBy = "user";
  broadcastBrowser(userName);
}
/** The "page": header bar, sidebar, text lines, and a marker block that moves with every input so frames visibly change. */
function browserFrame(userName, maxWidth) {
  const b = browserFor(userName);
  const w = Math.max(160, Math.min(Number(maxWidth) || 640, 640)) & ~7;
  const h = Math.round((w * BROWSER_VIEWPORT.height) / BROWSER_VIEWPORT.width) & ~7;
  const hash = crypto.createHash("md5").update(b.url || "").digest();
  const hue = [hash[0], hash[1], hash[2]].map((x) => 90 + (x % 120));
  const bw = w / 8;
  const bh = h / 8;
  const mx = (b.tick * 3) % Math.max(1, Math.floor(bw) - 3);
  const jpeg = encodeFlatJpeg(w, h, (x, y) => {
    if (y < 3) return hue;
    if (x >= mx + 2 && x < mx + 5 && y >= bh - 6 && y < bh - 3) return [220, 60, 60];
    if (x < 6) return [236, 238, 242];
    if (y > 5 && y % 3 === 0 && x > 8 && x < bw - 8 - ((y * 7) % 13)) return [140, 146, 158];
    return [252, 252, 253];
  });
  return { type: "browser_frame", data: jpeg.toString("base64"), width: w, height: h, at: now() };
}
let browserTimer = null;
function ensureBrowserTimer() {
  if (browserTimer) return;
  browserTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.browserView?.on || !browserFor(c.user).running) continue;
      sendRaw(c, browserFrame(c.user, c.browserView.maxWidth));
    }
  }, 250);
  browserTimer.unref?.();
}

// ---------------------------------------------------------------------------
// memory (per user): the Memory page's REST routes and the Chat tools Claude calls
// ---------------------------------------------------------------------------
const memoriesOf = (user) => {
  let m = memoriesByUser.get(user);
  if (!m) memoriesByUser.set(user, (m = []));
  return m;
};
const knownHeadsUpsByUser = new Map();
const pricingChecks = [];
const mockPricing = () => {
  const period = (model, input, output, cacheRead, source = "builtin") => ({ model, from: null, inputPerMtok: input, outputPerMtok: output, cacheReadFactor: cacheRead / input, cacheReadPerMtok: cacheRead, source });
  const models = [
    { model: "claude-opus-5-5", current: period("claude-opus-5-5", 5, 25, 0.5), periods: [] },
    { model: "claude-sonnet-5-5", current: period("claude-sonnet-5-5", 3, 15, 0.3), periods: [] },
    { model: "claude-haiku-5-5", current: period("claude-haiku-5-5", 1, 5, 0.1), periods: [] },
  ];
  return {
    models,
    lastCheck: pricingChecks[0] ?? null,
    checks: pricingChecks,
    nextCheckAt: null,
  };
};
const browserSitesOf = (user) => {
  let m = browserSitesByUser.get(user);
  if (!m) browserSitesByUser.set(user, (m = new Map()));
  return m;
};
const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
const originOf = (u) => {
  try {
    return new URL(withScheme(u)).origin;
  } catch {
    return null;
  }
};
const cleanMemory = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

function addMemory(user, text, source, sessionId = null) {
  const clean = cleanMemory(text);
  const list = memoriesOf(user);
  const dup = list.find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (dup) return dup;
  const at = now();
  const m = { id: uuid(), text: clean, source, sessionId, createdAt: at, updatedAt: at };
  list.unshift(m);
  emit(user, { type: "memories_changed" });
  return m;
}

/** What the hub's in-process tool answers (Chat sessions). */
const DOWNLOAD_TOOL = "mcp__workstation_fetch__download_file";
/** The hub's download_file: saves a small stand-in file in the chat folder; answers its path (relative to the folder) and size. */
function runDownload(rec, toolUse) {
  const name = String(toolUse.input.filename || "download.bin").replace(/[\\/]/g, "_");
  const data = `Downloaded from ${toolUse.input.url}\n`;
  const abs = safePath(rec.s.user, rec.s.cwd ? `${rec.s.cwd}/${name}` : name);
  if (abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
  return `path: ${name}\nsize: ${Buffer.byteLength(data)}\ncontent type: application/octet-stream`;
}

function runMemoryTool(rec, toolUse) {
  const user = rec.s.user;
  if (users.get(user)?.memoryEnabled === false) return "Memory is turned off for this user; nothing was saved.";
  const text = cleanMemory(toolUse.input?.text);
  if (toolUse.name.endsWith("__remember")) return `Saved: ${addMemory(user, text, "claude", rec.s.id).text}`;
  const list = memoriesOf(user);
  const hit = list.find((m) => m.text.toLowerCase() === text.toLowerCase()) ?? list.find((m) => m.text.toLowerCase().includes(text.toLowerCase()));
  if (!hit) return "No memory matches that text; nothing was removed.";
  list.splice(list.indexOf(hit), 1);
  emit(user, { type: "memories_changed" });
  return `Removed: ${hit.text}`;
}

/** Context-window usage after a turn: grows with every turn, like the real thing. */
function contextUsageFor(rec) {
  rec.turnCount = (rec.turnCount ?? 0) + 1;
  const memory = Math.ceil(memoriesOf(rec.s.user).reduce((n, m) => n + m.text.length, 0) / 4);
  const breakdown = [
    { key: "system_prompt", label: "System prompt", tokens: 8_500 },
    { key: "system_tools", label: "System tools", tokens: 14_200 },
    { key: "skills", label: "Skills", tokens: 3_000 },
    { key: "memory", label: "Memory", tokens: memory },
    { key: "messages", label: "Messages", tokens: 6_000 * rec.turnCount + 21_000 },
    { key: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000 },
  ];
  const usedTokens = breakdown.filter((b) => b.key !== "autocompact_buffer").reduce((n, b) => n + b.tokens, 0);
  return { usedTokens, windowTokens: 1_000_000, model: rec.s.model, breakdown, updatedAt: now() };
}

/** scope: a sessionId => only subscribers of that session; null => every connection of the user. */
function emit(user, ev, sessionId = null) {
  for (const c of clients) {
    if (c.user !== user) continue;
    if (sessionId && !c.subs.has(sessionId)) continue;
    sendRaw(c, ev);
  }
}

// ---------------------------------------------------------------------------
// sessions + conversation simulation
// ---------------------------------------------------------------------------
function newSession(user, body) {
  const kind = body.kind;
  const t = now();
  const u = users.get(user);
  const model = body.model || u?.defaultModel || settings.defaultModel;
  const s = {
    id: uuid(),
    user,
    kind,
    title: body.title || (kind === "chat" ? "New chat" : "New session"),
    cwd: kind === "chat" ? ".chat" : body.cwd ?? "",
    model,
    permissionMode: body.permissionMode || (kind === "chat" ? "dontAsk" : "default"),
    effort: body.effort === undefined ? (u?.defaultEffort ?? settings.defaultEffort ?? null) : body.effort,
    status: "idle",
    queuePosition: null,
    claudeSessionId: null,
    createdAt: t,
    lastActiveAt: t,
    lastSeq: 0,
    costUsd: 0,
    ...(body.incognito ? { incognito: true } : {}),
  };
  if (!NO_PROJECT_ID) s.projectId = projectIdForCwd(user, s.cwd);
  const rec = { s, messages: [], partial: emptyPartial(), pending: null, run: null, titled: !!body.title };
  sessions.set(s.id, rec);
  return rec;
}

/** `projects/<name>[/...]` → that project's id (null outside projects). Mirrors the hub's nullable Session.projectId. */
function projectIdForCwd(user, cwd) {
  const m = /^projects\/([^/]+)/.exec(cwd);
  return m ? ((projectsByUser.get(user) ?? []).find((p) => p.name === m[1])?.id ?? null) : null;
}

const emptyPartial = () => ({ messageId: null, text: "", thinking: "", currentTool: null });

function persist(rec, kind, payload, uuidOverride) {
  const s = rec.s;
  const seq = s.lastSeq + 1;
  s.lastSeq = seq;
  s.lastActiveAt = now();
  const m = { seq, sessionId: s.id, uuid: uuidOverride || payload.uuid || uuid(), kind, payload, at: now() };
  rec.messages.push(m);
  emit(s.user, { type: "message", sessionId: s.id, message: m }, s.id);
  return m;
}

function setStatus(rec, status, queuePosition = null) {
  rec.s.status = status;
  rec.s.queuePosition = queuePosition;
  emit(rec.s.user, { type: "session_state", sessionId: rec.s.id, status, queuePosition }, rec.s.id);
  emit(rec.s.user, { type: "session_updated", session: { ...rec.s } });
}

const userPayload = (rec, id, content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: id, session_id: rec.s.id });
const asstPayload = (rec, msgId, block, extra = {}) => ({
  type: "assistant",
  message: { id: msgId, role: "assistant", model: rec.s.model, content: [block], stop_reason: null },
  parent_tool_use_id: null,
  uuid: uuid(),
  session_id: rec.s.id,
  ...extra,
});

const ABORT = Symbol("abort");

/** Builds the scripted "API messages" (each: blocks[]) for a prompt. */
function script(rec, text) {
  const lower = text.toLowerCase();
  const code = rec.s.kind === "code";
  const messages = [];
  const textBlock = (t) => ({ type: "text", text: t });
  if (!code && !rec.s.incognito && /^(remember|forget)\b/i.test(text.trim())) {
    const m = /^(remember|forget)\s+(?:that\s+)?(.+?)\.?\s*$/i.exec(text.trim());
    const tool = m?.[1].toLowerCase() === "forget" ? "forget" : "remember";
    messages.push({ blocks: [textBlock(tool === "forget" ? "Let me remove that." : "I'll keep that in mind."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: `mcp__workstation-memory__${tool}`, input: { text: m?.[2] ?? text.trim() } }], tool: "memory" });
    messages.push({ blocks: [textBlock(tool === "forget" ? "Done, it's removed." : "Saved to your memory.")] });
  } else if (!rec.s.incognito && /^search (?:past )?chats?\b/i.test(text.trim())) {
    const query = text.trim().replace(/^search (?:past )?chats?\s*(?:for\s+)?/i, "") || "release";
    messages.push({ blocks: [textBlock("Let me look through your past chats."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "mcp__workstation-history__search_conversations", input: { query } }], tool: "history" });
    messages.push({ blocks: [textBlock("That is what I found.")] });
  } else if (!rec.s.incognito && /^read chat\s+\S+/i.test(text.trim())) {
    const id = /^read chat\s+(\S+)/i.exec(text.trim())[1];
    messages.push({ blocks: [textBlock("Opening that chat."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "mcp__workstation-history__read_conversation", input: { session_id: id } }], tool: "history" });
    messages.push({ blocks: [textBlock("Got it.")] });
  } else if (/^browse\s+\S+/i.test(text.trim()) && originOf(/^browse\s+(\S+)/i.exec(text.trim())[1])) {
    const url = withScheme(/^browse\s+(\S+)/i.exec(text.trim())[1]);
    const origin = originOf(url);
    messages.push({ blocks: [textBlock(`Opening ${new URL(origin).host}.`), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "mcp__browser__browser_navigate", input: { url }, needsPermission: true, browserSite: { origin } }], tool: "browser" });
    messages.push({ blocks: [textBlock("The page is open.")], denied: [textBlock("Understood, I did not open the page.")] });
  } else if (/^download\s+https:\/\/\S+/i.test(text.trim())) {
    // the chats' download tool: a well-known host is fetched at once, any other asks first (card with the safety check's reason)
    const url = /^download\s+(https:\/\/\S+)/i.exec(text.trim())[1];
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL: the call goes through unchecked */
    }
    const known = /(^|\.)(github\.com|githubusercontent\.com|pypi\.org|arxiv\.org)$/.test(host);
    const input = { url, filename: decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "") || "download.bin", ...(known ? {} : { check: { safe: false, reason: "The path and query look random; the file may carry data out." } }) };
    messages.push({ blocks: [textBlock("Fetching that file."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "mcp__workstation_fetch__download_file", input, needsPermission: !known }], tool: "download" });
    messages.push({ blocks: [textBlock("The file is in the chat folder.")], denied: [textBlock("Understood, I did not download it.")] });
  } else if (lower.includes("subagent")) {
    // the hub's run_subagents: the person approves the batch first (Start / Don't start)
    // ("one subagent": just the first); "permission" makes the first child ask for a tool
    const agents = [
      { task: "Read the sync engine and list how conflicts are resolved.", model: "claude-haiku-5-5", description: "Audit the sync engine", paths: ["notes/**"] },
      { task: "Write tests for the conflict resolver.\nCover ties and clock skew.", model: "claude-haiku-5-5", description: "Write the tests", paths: ["src/sync/**/*.test.ts", "test/**"] },
    ].slice(0, lower.includes("one subagent") ? 1 : 2);
    rec.subagentAsks = lower.includes("permission");
    messages.push({ blocks: [textBlock(`Handing this to ${agents.length} subagent${agents.length === 1 ? "" : "s"}.`), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: SUBAGENTS_TOOL, input: { agents }, needsPermission: true }], tool: "subagent" });
    messages.push({ blocks: [textBlock("The subagents are done; their answers are above.")], denied: [textBlock("Understood, I did not start the subagents.")] });
  } else if (code && lower.includes("background")) {
    startBackgroundTasks(rec);
    messages.push({ blocks: [textBlock("Started a dev server and an explore agent in the background.")] });
  } else if (code && lower.includes("wrap up")) {
    startWrapUp(rec);
    const todos = [
      { content: "Run the tests", activeForm: "Running the tests", status: "completed" },
      { content: "Write up the audit", activeForm: "Writing up the audit", status: "in_progress" },
      { content: "Open the changes", activeForm: "Opening the changes", status: "pending" },
    ];
    messages.push({ blocks: [textBlock("Planning the last steps."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "TodoWrite", input: { todos } }], tool: "todo" });
    messages.push({ blocks: [textBlock("Everything is in place.")] });
  } else if (lower.includes("slow")) messages.push({ blocks: [textBlock("Took my time, but here it is.")], slow: 20_000 });
  else if (lower.includes("think")) messages.push({ blocks: [{ type: "thinking", thinking: "The user wants me to think this through. Let me consider the constraints, weigh the options, and then answer concisely." }, textBlock("I thought about it: the simplest option wins.")] });
  else if (lower.includes("markdown")) messages.push({ blocks: [textBlock(MARKDOWN_REPLY)] });
  else if (lower.includes("long")) messages.push({ blocks: [textBlock(Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)}`).join("\n\n"))], fast: true });
  else if (lower.includes("limit")) messages.push({ rateLimit: true, blocks: [textBlock("You've hit your session limit · resets 3pm")] });
  else if (code && /create a file \S+ containing /i.test(text)) {
    const m = /create a file (\S+) containing (.+?)\.?\s*$/i.exec(text.trim());
    const name = m[1].replace(/[`'"]/g, "");
    const file = rec.s.cwd ? `${rec.s.cwd}/${name}` : name;
    messages.push({ blocks: [textBlock(`I'll create \`${name}\`.`), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "Write", input: { file_path: file, content: `${m[2]}\n` }, needsPermission: true }], tool: "write" });
    messages.push({ blocks: [textBlock(`Created \`${name}\`.`)], denied: [textBlock("Understood, I did not create the file.")] });
  } else if (code && lower.includes("edit")) {
    messages.push({
      blocks: [textBlock("I'll update `src/app.ts`."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "Edit", input: { file_path: "projects/demo-app/src/util.ts", old_string: "export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);", new_string: "export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);\nexport const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);" }, needsPermission: true }],
      tool: "edit",
    });
    messages.push({ blocks: [textBlock("Done — `mean` is now exported from `util.ts`.")], denied: [textBlock("Understood, I left the file untouched.")] });
  } else if (code && (lower.includes("tool") || lower.includes("bash"))) {
    messages.push({ blocks: [textBlock("Let me look at the project."), { type: "tool_use", id: `toolu_${uuid().slice(0, 8)}`, name: "Bash", input: { command: "ls -la projects/demo-app", description: "List the demo project" } }], tool: "bash" });
    messages.push({ blocks: [textBlock("The project has a `src/` folder, a `package.json` and a `README.md`.")] });
  } else if (code && /(^|\s)@\S+/.test(text)) {
    // "Claude reads it": echo the first lines of every @-mentioned workspace file
    const parts = [...text.matchAll(/(?:^|\s)@(\S+)/g)].map((m) => {
      const abs = safePath(rec.s.user, m[1]);
      return abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? `${m[1]} says: ${fs.readFileSync(abs, "utf8").slice(0, 300).trim()}` : `${m[1]} was not found`;
    });
    messages.push({ blocks: [textBlock(parts.join("\n\n"))] });
  } else {
    const t = text.trim();
    messages.push({ blocks: [textBlock(/say ok/i.test(t) ? "OK" : `OK — you said: "${t.slice(0, 120)}"`)] });
  }
  return messages;
}

const MARKDOWN_REPLY = `# Release notes

Here is a **quick tour** of the new build, with _everything_ you asked for.

## Highlights

1. Faster startup
2. A new \`--watch\` flag
3. Fewer allocations

## Comparison

| Version | Cold start | Memory |
|---------|-----------:|-------:|
| 1.0     | 820 ms     | 140 MB |
| 1.1     | 410 ms     | 96 MB  |

## Example

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

- Bullet one
- Bullet two with a [link](https://example.com)
  - nested item

> A closing quote from the docs.
`;

/** Output tokens of the running turn so far (`usage` deltas; the snapshot carries the total for a late joiner). */
function bumpTokens(rec, msgId, n) {
  if (!rec.turn) return;
  rec.turn.tokens += n;
  rec.turn.message += n;
  emit(rec.s.user, { type: "delta", sessionId: rec.s.id, delta: { part: "usage", messageId: msgId, outputTokens: rec.turn.message, turnOutputTokens: rec.turn.tokens } }, rec.s.id);
}

async function streamText(rec, run, msgId, kind, text, fast) {
  const size = fast ? 60 : 11;
  for (let i = 0; i < text.length; i += size) {
    if (run.aborted) throw ABORT;
    const chunk = text.slice(i, i + size);
    if (kind === "text") rec.partial.text += chunk;
    else rec.partial.thinking += chunk;
    rec.partial.messageId = msgId;
    emit(rec.s.user, { type: "delta", sessionId: rec.s.id, delta: { part: kind, messageId: msgId, text: chunk } }, rec.s.id);
    bumpTokens(rec, msgId, Math.ceil(chunk.length / 4));
    await sleep(fast ? 8 : 28);
  }
}

async function runTurn(rec, text) {
  const s = rec.s;
  const run = { aborted: false, started: Date.now() };
  rec.run = run;
  rec.turn = { startedAt: now(), tokens: 0, message: 0 };
  setStatus(rec, "running");
  let lastText = "";
  let turns = 0;
  try {
    await sleep(120);
    for (const apiMsg of script(rec, text)) {
      if (run.aborted) throw ABORT;
      turns++;
      const msgId = `msg_${uuid().slice(0, 12)}`;
      rec.partial = { ...emptyPartial(), messageId: msgId };
      rec.turn.message = 0;
      for (let waited = 0; waited < (apiMsg.slow ?? 0); waited += 250) {
        if (run.aborted) throw ABORT;
        await sleep(250);
        bumpTokens(rec, msgId, 12);
      }
      const toolBlocks = [];
      for (const block of apiMsg.blocks) {
        if (run.aborted) throw ABORT;
        if (block.type === "thinking") {
          await streamText(rec, run, msgId, "thinking", block.thinking, false);
          persist(rec, "assistant", asstPayload(rec, msgId, { type: "thinking", thinking: block.thinking, signature: "mock" }));
          rec.partial.thinking = "";
        } else if (block.type === "text") {
          await streamText(rec, run, msgId, "text", block.text, apiMsg.fast);
          if (apiMsg.rateLimit) {
            persist(rec, "assistant", asstPayload(rec, msgId, { type: "text", text: block.text }, { error: "rate_limit" }));
            emit(s.user, { type: "notice", level: "warning", code: "rate_limit", message: block.text, at: now() });
          } else persist(rec, "assistant", asstPayload(rec, msgId, { type: "text", text: block.text }));
          rec.partial.text = "";
          lastText = block.text;
        } else if (block.type === "tool_use") {
          const { needsPermission: _np, browserSite: _bs, ...toolUse } = block;
          rec.partial.currentTool = { toolUseId: toolUse.id, toolName: toolUse.name, partialJson: "" };
          emit(s.user, { type: "delta", sessionId: s.id, delta: { part: "tool_use_start", messageId: msgId, toolUseId: toolUse.id, toolName: toolUse.name } }, s.id);
          const json = JSON.stringify(toolUse.input);
          for (let i = 0; i < json.length; i += 24) {
            if (run.aborted) throw ABORT;
            const part = json.slice(i, i + 24);
            rec.partial.currentTool.partialJson += part;
            emit(s.user, { type: "delta", sessionId: s.id, delta: { part: "tool_use_input", messageId: msgId, toolUseId: toolUse.id, partialJson: part } }, s.id);
            await sleep(15);
          }
          persist(rec, "assistant", asstPayload(rec, msgId, toolUse));
          rec.partial.currentTool = null;
          toolBlocks.push({ toolUse, needsPermission: !!block.needsPermission, browserSite: block.browserSite });
        }
      }
      emit(s.user, { type: "delta", sessionId: s.id, delta: { part: "message_end", messageId: msgId } }, s.id);
      rec.partial = emptyPartial();

      let denied = false;
      for (const { toolUse, needsPermission, browserSite } of toolBlocks) {
        const grant = browserSite ? browserSitesOf(s.user).get(browserSite.origin) : null;
        if (grant) grant.lastUsedAt = now(); // an always-allowed site: no question
        if (needsPermission && !grant) {
          const decision = await askPermission(rec, run, toolUse, browserSite);
          denied = decision.behavior === "deny";
          if (browserSite && !denied && decision.remember === "user") {
            const at = now();
            browserSitesOf(s.user).set(browserSite.origin, { origin: browserSite.origin, grantedAt: at, lastUsedAt: at });
          }
          if (denied) {
            persist(rec, "user", userPayload(rec, uuid(), [{ type: "tool_result", tool_use_id: toolUse.id, content: decision.message || "The user doesn't want to proceed with this tool use.", is_error: true }]));
            continue;
          }
          if (browserSite) {
            // nothing to write: the server browser would open the page
          } else if (toolUse.name === "Write") {
            const abs = safePath(s.user, String(toolUse.input.file_path));
            if (abs) {
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, String(toolUse.input.content ?? ""));
            }
          }
          if (!browserSite && toolUse.name !== DOWNLOAD_TOOL) {
            emit(s.user, { type: "file_event", path: toolUse.input.file_path, kind: toolUse.name === "Write" ? "add" : "change", sessionId: s.id, at: now() });
            applyEditToProject(rec, toolUse, turns);
          }
        }
        await sleep(250);
        const subagentOut = toolUse.name === SUBAGENTS_TOOL ? await runSubagents(rec, run, toolUse) : null;
        const historyOut = toolUse.name.endsWith("__search_conversations") ? searchConversationsAnswer(s.user, toolUse.input?.query) : toolUse.name.endsWith("__read_conversation") ? (readConversationAnswer(s.user, toolUse.input?.session_id) ?? "No such conversation.") : null;
        const downloadOut = toolUse.name === DOWNLOAD_TOOL ? runDownload(rec, toolUse) : null;
        const out = subagentOut ?? historyOut ?? downloadOut ?? (toolUse.name.startsWith("mcp__workstation-memory__") ? runMemoryTool(rec, toolUse) : toolUse.name === "mcp__browser__browser_navigate" ? `Opened ${toolUse.input.url}.` : toolUse.name === "TodoWrite" ? "Todos have been modified successfully." : toolUse.name === "Bash" ? "total 24\ndrwxr-xr-x  5 user user 4096 README.md\ndrwxr-xr-x  3 user user 4096 src\n-rw-r--r--  1 user user  118 package.json\n" : `The file ${toolUse.input.file_path} has been updated successfully.`);
        // like the hub: a memory call that changed nothing ("turned off", "no match") comes back as an error result
        const noop = toolUse.name.startsWith("mcp__workstation-memory__") && !/^(Saved|Removed):/.test(out);
        persist(rec, "user", userPayload(rec, uuid(), [{ type: "tool_result", tool_use_id: toolUse.id, content: out, ...(noop ? { is_error: true } : {}) }]));
      }
      if (denied && apiMsg.denied) {
        const id2 = `msg_${uuid().slice(0, 12)}`;
        // replace the follow-up message with the "denied" text
        rec.partial = { ...emptyPartial(), messageId: id2 };
        for (const b of apiMsg.denied) {
          await streamText(rec, run, id2, "text", b.text, false);
          persist(rec, "assistant", asstPayload(rec, id2, b));
          lastText = b.text;
        }
        emit(s.user, { type: "delta", sessionId: s.id, delta: { part: "message_end", messageId: id2 } }, s.id);
        rec.partial = emptyPartial();
        break;
      }
    }
    const duration = Date.now() - run.started;
    const cost = 0.0123 + turns * 0.004;
    s.costUsd = Math.round((s.costUsd + cost) * 10000) / 10000;
    if (apiBlock()) {
      apiSpend += 0.42 + turns * 0.1;
      emit(s.user, { type: "usage_limits", limits: limits() });
    }
    persist(rec, "result", {
      type: "result",
      subtype: "success",
      is_error: text.toLowerCase().includes("limit"),
      duration_ms: duration,
      duration_api_ms: Math.round(duration * 0.8),
      num_turns: turns,
      result: lastText,
      total_cost_usd: Math.round(cost * 10000) / 10000,
      usage: { input_tokens: 1200, output_tokens: 340 },
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: s.id,
    });
    s.contextUsage = contextUsageFor(rec);
    emit(s.user, { type: "context_usage", sessionId: s.id, usage: s.contextUsage });
    rec.turn = null;
    setStatus(rec, "idle");
    if (rec.pendingNextStep) {
      setNextStep(rec, rec.pendingNextStep);
      rec.pendingNextStep = null;
    }
  } catch (e) {
    if (e !== ABORT) {
      log("turn error", e);
      persist(rec, "result", { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: Date.now() - run.started, num_turns: turns, total_cost_usd: 0, errors: [String(e)], uuid: uuid(), session_id: s.id });
    }
    rec.partial = emptyPartial();
    rec.turn = null;
    setStatus(rec, "idle");
  } finally {
    rec.run = null;
  }
}

/** An allowed Edit inside `projects/<name>/` becomes a pending change of that project, touched by this session. */
function applyEditToProject(rec, toolUse, turn) {
  if (toolUse.name !== "Edit") return;
  const file = String(toolUse.input.file_path || "");
  const m = /^projects\/([^/]+)\/(.+)$/.exec(file);
  const project = m && (projectsByUser.get(rec.s.user) ?? []).find((p) => p.name === m[1]);
  const abs = project && safePath(rec.s.user, file);
  if (!project || !abs || !fs.existsSync(abs)) return;
  const before = fs.readFileSync(abs, "utf8");
  const after = before.includes(toolUse.input.old_string) ? before.replace(toolUse.input.old_string, toolUse.input.new_string) : `${before}${toolUse.input.new_string}\n`;
  fs.writeFileSync(abs, after);
  const rel = m[2];
  const prev = project.pending.get(rel);
  project.pending.set(rel, { oldText: prev ? prev.oldText : before, newText: after, binary: false });
  project.touched.set(rel, { sessionId: rec.s.id, turn, tool: "Edit", at: now() });
  emit(rec.s.user, { type: "review_changed", projectId: project.id, localCommit: project.localCommit, pendingFiles: project.pending.size });
}

/**
 * The hub's run_subagents (approved before it runs): one child session per agent (hidden from lists and search,
 * `parentSessionId` set) runs its task while the parent's background tasks list it (`workstation_subagent`, taskId = child id).
 * Result text: one section per agent in input order, separated by a `--- subagent ---` line; each section is
 * `session: <id>`, blank line, answer, `Files: …` (no session line when the child never started).
 */
async function runSubagents(rec, run, toolUse) {
  const { agents } = toolUse.input;
  const sections = await Promise.all(agents.map((agent, i) => runSubagent(rec, run, agent, i === 0)));
  return sections.join("\n--- subagent ---\n");
}

async function runSubagent(rec, run, { model, description, task }, mayAsk) {
  const kid = newSession(rec.s.user, { kind: "code", title: description, model, cwd: rec.s.cwd, permissionMode: rec.s.permissionMode });
  kid.s.parentSessionId = rec.s.id;
  const startedAt = now();
  setBackgroundTasks(rec, [...(rec.tasks ?? []), { taskId: kid.s.id, type: "workstation_subagent", description, subagentType: model, startedAt }]);
  setStatus(kid, "running");
  persist(kid, "user", userPayload(kid, uuid(), [{ type: "text", text: task }]));
  await sleep(600);
  const readId = `toolu_${uuid().slice(0, 8)}`;
  persist(kid, "assistant", asstPayload(kid, `msg_${uuid().slice(0, 12)}`, { type: "text", text: "Reading the conflict resolver first." }));
  persist(kid, "assistant", asstPayload(kid, `msg_${uuid().slice(0, 12)}`, { type: "tool_use", id: readId, name: "Read", input: { file_path: "projects/demo-app/src/util.ts" } }));
  await sleep(400);
  persist(kid, "user", userPayload(kid, uuid(), [{ type: "tool_result", tool_use_id: readId, content: "export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);\n" }]));
  if (rec.subagentAsks && mayAsk) {
    // the child's request shows up in the parent's stream, labelled with the child
    const bashId = `toolu_${uuid().slice(0, 8)}`;
    const bash = { id: bashId, name: "Bash", input: { command: "npm test", description: "Run the tests" } };
    persist(kid, "assistant", asstPayload(kid, `msg_${uuid().slice(0, 12)}`, { type: "tool_use", ...bash }));
    const decision = await askPermission(rec, run, bash, undefined, { sessionId: kid.s.id, description });
    persist(kid, "user", userPayload(kid, uuid(), [{ type: "tool_result", tool_use_id: bashId, content: decision.behavior === "deny" ? "The user doesn't want to proceed with this tool use." : "Tests passed.", ...(decision.behavior === "deny" ? { is_error: true } : {}) }]));
  }
  const answer = "Conflicts are resolved by the newer mtime; ties keep the Mac copy and park the server copy as a backup.";
  persist(kid, "assistant", asstPayload(kid, `msg_${uuid().slice(0, 12)}`, { type: "text", text: answer }));
  setStatus(kid, "idle");
  setBackgroundTasks(rec, (rec.tasks ?? []).filter((x) => x.taskId !== kid.s.id));
  return `session: ${kid.s.id}\n\n${answer}\nFiles: projects/demo-app/src/util.ts`;
}

function askPermission(rec, run, toolUse, browserSite, subagent) {
  const request = { requestId: `perm_${uuid().slice(0, 8)}`, sessionId: rec.s.id, toolName: toolUse.name, input: toolUse.input, toolUseId: toolUse.id, suggestions: [], ...(browserSite ? { browserSite } : {}), ...(subagent ? { subagent } : {}), at: now() };
  return new Promise((resolve) => {
    rec.pending = { request, resolve, run };
    setStatus(rec, "requires_action");
    emit(rec.s.user, { type: "permission_request", request }, rec.s.id);
  }).then((decision) => {
    rec.pending = null;
    if (decision.cancelled) throw ABORT;
    emit(rec.s.user, { type: "permission_resolved", sessionId: rec.s.id, requestId: request.requestId, behavior: decision.behavior }, rec.s.id);
    setStatus(rec, "running");
    return decision;
  });
}

/** The session's background tasks changed: remember the list and push the full current set (`background_tasks`). */
function setBackgroundTasks(rec, tasks) {
  rec.tasks = tasks;
  emit(rec.s.user, { type: "background_tasks", sessionId: rec.s.id, tasks }, rec.s.id);
}

/** The end-of-turn box was set (or cleared: null). */
function setNextStep(rec, step) {
  rec.nextStep = step;
  emit(rec.s.user, { type: "next_step", sessionId: rec.s.id, step }, rec.s.id);
}

/** "wrap up" in a message: three ended background tasks (completed, failed, stopped) and, once the turn ends, an end-of-turn box. */
function startWrapUp(rec) {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const id = uuid().slice(0, 8);
  setBackgroundTasks(rec, [
    ...(rec.tasks ?? []),
    { taskId: `bash_${id}`, type: "local_bash", description: "npm test", startedAt: ago(8 * 60_000), status: "completed", endedAt: ago(5 * 60_000) },
    { taskId: `agent_${id}`, type: "local_agent", description: "Audit the sync engine", subagentType: "Explore", startedAt: ago(20 * 60_000), status: "failed", endedAt: ago(15 * 60_000) },
    { taskId: `dev_${id}`, type: "local_bash", description: "npm run dev -- --port 5173", startedAt: ago(30 * 60_000), status: "stopped", endedAt: ago(26 * 60_000) },
  ]);
  rec.pendingNextStep = { recap: "Tests pass and the sync audit is written up.", ask: "Open the changes for review?", actions: [{ label: "Review changes" }, { label: "Keep going" }], at: now() };
}

/** "background" in a message: a background shell command and a subagent start (they stay until stopped). */
function startBackgroundTasks(rec) {
  const startedAt = now();
  const id = uuid().slice(0, 8);
  setBackgroundTasks(rec, [
    ...(rec.tasks ?? []),
    { taskId: `bash_${id}`, type: "local_bash", description: "npm run dev -- --port 5173", startedAt },
    { taskId: `agent_${id}`, type: "local_agent", description: "Explore how the sync engine resolves conflicts", subagentType: "Explore", startedAt },
  ]);
}

function stopSession(rec) {
  if (rec.run) rec.run.aborted = true;
  if (rec.pending) {
    const { request, resolve } = rec.pending;
    emit(rec.s.user, { type: "permission_cancelled", sessionId: rec.s.id, requestId: request.requestId }, rec.s.id);
    resolve({ cancelled: true });
  }
  if (!rec.run && rec.s.status !== "idle") setStatus(rec, "idle");
}

// ---------------------------------------------------------------------------
// review (git diff) model for projects
// ---------------------------------------------------------------------------
function makeHunks(oldText, newText) {
  const p = structuredPatch("a", "b", oldText, newText, "", "", { context: 3 });
  return p.hunks.map((h, index) => ({ index, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines: h.lines.filter((l) => !l.startsWith("\\")) }));
}

/** old text with only the selected hunks applied (selected: Set of hunk indexes). */
function applyHunks(oldText, hunks, selected) {
  const oldLines = oldText.split("\n");
  const out = [];
  let cursor = 0; // index into oldLines (0-based)
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1);
    while (cursor < start) out.push(oldLines[cursor++]);
    const take = selected.has(h.index);
    for (const line of h.lines) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === " ") {
        out.push(body);
        cursor++;
      } else if (tag === "-") {
        if (!take) out.push(body);
        cursor++;
      } else if (tag === "+") {
        if (take) out.push(body);
      }
    }
  }
  while (cursor < oldLines.length) out.push(oldLines[cursor++]);
  return out.join("\n");
}

/** sha256 of the file's diff (the hub hashes the unified diff); changes whenever either side changes. */
const diffIdOf = (ch) => crypto.createHash("sha256").update(JSON.stringify(ch.binary ? "binary" : [ch.oldText, ch.newText])).digest("hex");

function reviewFiles(user, project) {
  const files = [];
  for (const [p, ch] of project.pending) {
    if (ch.binary) {
      files.push({ path: p, status: "modified", binary: true, additions: 0, deletions: 0, sizeBytes: 512, lastTouchedBy: project.touched.get(p) ?? null });
      continue;
    }
    const hunks = makeHunks(ch.oldText, ch.newText);
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) for (const l of h.lines) (l[0] === "+" ? additions++ : l[0] === "-" ? deletions++ : 0);
    files.push({ path: p, status: ch.oldText === "" ? "added" : "modified", binary: false, additions, deletions, sizeBytes: Buffer.byteLength(ch.newText), lastTouchedBy: project.touched.get(p) ?? null });
  }
  return files;
}

// ---------------------------------------------------------------------------
// usage / disk
// ---------------------------------------------------------------------------
function limits() {
  return { api: apiBlock() };
}

function diskStatus(user) {
  const GB = 1024 ** 3;
  const used = DISK === "block" ? 97 : DISK === "warn" ? 86 : 41;
  const total = 128 * GB;
  const projects = (projectsByUser.get(user) ?? []).map((p) => ({ id: p.id, name: p.name, pendingFiles: p.pending.size, undownloadedFiles: p.undownloaded, bytes: dirSize(safePath(user, p.path) ?? "") + (p.name === "demo-app" ? 2.4 * GB : 0.1 * GB) }));
  return {
    level: used >= settings.diskBlockPercent ? "block" : used >= settings.diskWarnPercent ? "warn" : "ok",
    usedPercent: used,
    totalBytes: total,
    freeBytes: Math.round(total * (1 - used / 100)),
    warnPercent: settings.diskWarnPercent,
    blockPercent: settings.diskBlockPercent,
    breakdown: [
      { label: "Projects", user, path: "projects", bytes: Math.round(projects.reduce((a, p) => a + p.bytes, 0)) },
      { label: "Inbox", user, path: "inbox", bytes: Math.round(0.6 * GB) },
      { label: "Claude cache", user, path: ".claude", bytes: Math.round(0.2 * GB) },
      { label: "Generated files", user, path: "docs", bytes: Math.round(0.3 * GB) },
    ],
    projects,
  };
}

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function usageBuckets(range, user) {
  const r = rng(user.length * 13 + range.length);
  const buckets = [];
  // raw ids as the hub stores them, including a dated snapshot (the UI folds it into its model)
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];
  const slots = range === "today" ? new Date().getHours() + 1 : range === "7d" ? 7 : 30;
  for (let i = slots - 1; i >= 0; i--) {
    const d = new Date();
    if (range === "today") d.setHours(d.getHours() - i, 0, 0, 0);
    else {
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
    }
    const bucket = range === "today" ? d.toISOString() : d.toISOString().slice(0, 10);
    for (const model of models) {
      if (r() < 0.35) continue;
      const input = Math.round(r() * 60_000 * (model.includes("opus") ? 1 : 0.6));
      const output = Math.round(input * 0.25);
      buckets.push({ bucket, model, inputTokens: input, outputTokens: output, cacheReadTokens: Math.round(input * 3), cacheCreateTokens: Math.round(input * 0.4), costUsd: Math.round((input * 0.00001 + output * 0.00005) * 1000) / 1000, turns: 1 + Math.round(r() * 6) });
    }
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-workstation-user,x-upload-id,x-upload-path,x-chunk-index,x-chunk-total,x-total-bytes", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-expose-headers": "content-disposition" };

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, { ...CORS, ...headers });
    return res.end();
  }
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { ...CORS, "content-type": isBuf ? "application/octet-stream" : "application/json", ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
const fail = (res, status, error, code) => send(res, status, { error, code });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return Symbol.for("bad-json");
  }
}

function fileEntry(user, abs) {
  const st = fs.statSync(abs);
  const rel = path.relative(userRoot(user), abs).split(path.sep).join("/");
  return { path: rel, name: path.basename(abs), kind: st.isDirectory() ? "dir" : "file", size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() };
}

function listDir(user, abs, depth) {
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".") && abs === userRoot(user)) continue; // hide .chat/.claude at the root
    const p = path.join(abs, e.name);
    out.push(fileEntry(user, p));
    if (e.isDirectory() && depth > 1) out.push(...listDir(user, p, depth - 1));
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

function walkFiles(abs, base = "") {
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(path.join(abs, e.name), rel));
    else out.push({ name: rel, data: fs.readFileSync(path.join(abs, e.name)) });
  }
  return out;
}

function contentDisposition(name) {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]+$/.test(name) && !name.includes('"') ? `attachment; filename="${name}"` : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sessionFor(user, id) {
  const rec = sessions.get(id);
  return rec && rec.s.user === user ? rec : null;
}

function checkSendBlock(user, text) {
  if (settings.remoteClaudeEnabled === false) return ["remote_disabled", 403, "Remote Claude is switched off by an admin"];
  const api = apiBlock();
  if (!api) return ["api_unavailable", 503, "No API key or budget is configured on the server"];
  if (api.limitUsd - api.spentUsd <= settings.serviceReserveUsd) return ["api_limit_reached", 429, "This month's API budget is used up"];
  if (diskStatus(user).level === "block") return ["disk_block", 507, "Disk is almost full: the workspace is read-only"];
  if (text.includes("#429")) return ["weekly_limit", 429, "Weekly token limit reached"];
  return null;
}

// ---- search over a user's sessions (never incognito ones) -----------------------------------------------------------------
const RELEVANT_DELAY_MS = Number(process.env.MOCK_RELEVANT_DELAY_MS ?? 450);
const relevantCache = new Map(); // `${user}\0${query}` -> hits
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const messageText = (m) => {
  const content = m.payload?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
};
const wordsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const publicSessions = (user) => [...sessions.values()].filter((r) => r.s.user === user && !r.s.incognito && !r.s.parentSessionId);

/** Keyword search: titles and message text, every word must occur; the snippet marks the matches with «…». */
function keywordSearch(user, q, limit) {
  const words = wordsOf(q);
  if (words.length === 0) return [];
  const mark = (text) => words.reduce((acc, w) => acc.replace(new RegExp(escapeRe(w), "gi"), (m) => `«${m}»`), text);
  const hits = [];
  for (const rec of publicSessions(user)) {
    const title = rec.s.title ?? "";
    const msgs = rec.messages.filter((m) => m.kind === "user" || m.kind === "assistant").map((m) => ({ at: m.at, text: messageText(m) })).filter((m) => m.text);
    const hay = [title, ...msgs.map((m) => m.text)].join("\n").toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const firstWord = words[0];
    const hitMsg = [...msgs].reverse().find((m) => m.text.toLowerCase().includes(firstWord));
    if (hitMsg) {
      const i = hitMsg.text.toLowerCase().indexOf(firstWord);
      const from = Math.max(0, i - 40);
      const part = hitMsg.text.slice(from, i + firstWord.length + 70).replace(/\s+/g, " ");
      hits.push({ session: { ...rec.s }, snippet: mark(`${from > 0 ? "…" : ""}${part}`), at: hitMsg.at });
    } else hits.push({ session: { ...rec.s }, snippet: mark(title), at: rec.s.lastActiveAt });
  }
  return hits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

const SYNONYMS = { money: ["cost", "price", "budget", "$"], debounce: ["delay", "throttle", "typing"], bug: ["error", "crash", "fix"] };
/** "Relevant": a stand-in for the ranking by meaning (word overlap plus a few synonyms), one reason line per hit. */
function relevantSearch(user, q, limit) {
  const words = wordsOf(q).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]);
  const out = [];
  for (const rec of publicSessions(user)) {
    const text = [rec.s.title, ...rec.messages.map(messageText)].join(" ").toLowerCase();
    const matched = [...new Set(words.filter((w) => text.includes(w)))];
    if (matched.length === 0) continue;
    out.push({ score: matched.length, hit: { session: { ...rec.s }, snippet: `Summary: ${(rec.messages.map(messageText).find(Boolean) ?? rec.s.title ?? "").slice(0, 90)}`, at: rec.s.lastActiveAt, reason: `Talks about ${matched.slice(0, 3).join(", ")} in "${(rec.s.title ?? "").slice(0, 40)}".` } });
  }
  return out.sort((a, b) => b.score - a.score || Date.parse(b.hit.at) - Date.parse(a.hit.at)).slice(0, limit).map((x) => x.hit);
}

/** The hub's read-only history tools. */
function searchConversationsAnswer(user, query) {
  const hits = keywordSearch(user, String(query ?? ""), 5);
  if (hits.length === 0) return "No past chats match.";
  return hits.map((h) => `- ${h.session.id}  ${h.session.title}  (${h.at.slice(0, 10)})\n  ${h.snippet.replace(/[«»]/g, "")}`).join("\n");
}
function readConversationAnswer(user, id) {
  const rec = sessionFor(user, String(id ?? ""));
  if (!rec || rec.s.incognito) return null;
  return `# ${rec.s.title}\n\n` + rec.messages.filter((m) => m.kind === "user" || m.kind === "assistant").map((m) => `[${m.kind}] ${messageText(m)}`).filter((l) => l.length > 8).join("\n\n");
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const q = url.searchParams;
  const seg = p.split("/").filter(Boolean); // ["api", ...]
  const name = req.headers["x-workstation-user"] || q.get("user");

  if (p === "/api/health") return send(res, 200, { ok: true, ...(process.env.MOCK_NO_HOSTNAME === "1" ? {} : { hostname: process.env.MOCK_HOSTNAME || "workstation-mock" }) });

  // like the hub: answered without a username. Legacy unless MOCK_TAILSCALE="login|node" (names bound: MOCK_TAILSCALE_USERS="a,b").
  if (p === "/api/whoami" && method === "GET") {
    if (!process.env.MOCK_TAILSCALE) return send(res, 200, { tailscale: null, users: [], suggested: null });
    const [login, node = "mock"] = process.env.MOCK_TAILSCALE.split("|");
    const bound = (process.env.MOCK_TAILSCALE_USERS ?? "").split(",").filter(Boolean);
    return send(res, 200, { tailscale: { login, node }, users: bound, suggested: bound[0] ?? null });
  }

  // like the hub: every release, newest first per platform, answered without a username. MOCK_NO_RELEASES=1: none yet.
  if (p === "/api/app/releases" && method === "GET") {
    if (process.env.MOCK_NO_RELEASES === "1") return send(res, 200, { releases: [] });
    const rel = (platform, version, build, sizeBytes, publishedAt) => ({ platform, version, build, sizeBytes, sha256: "0".repeat(64), publishedAt, signature: `${"A".repeat(86)}==` });
    return send(res, 200, {
      releases: [
        rel("mac", "0.3.0", "20261020120000", 14_800_000, "2026-10-20T12:00:00Z"),
        rel("mac", "0.2.1", "20261005120000", 14_500_000, "2026-10-05T12:00:00Z"),
        rel("mac", "0.2.0", "20260928120000", 14_400_000, "2026-09-28T12:00:00Z"),
        rel("mac-intel", "0.3.0", "20261020120001", 15_900_000, "2026-10-20T12:00:00Z"),
        rel("mac-intel", "0.2.1", "20261005120001", 15_600_000, "2026-10-05T12:00:00Z"),
      ],
    });
  }

  // like the hub: the two readme pages (no username) and the docs assistant (SSE). MOCK_README_ASSISTANT: off (assistant:false)
  // | forbidden (assistant:true, but POST /api/readme/ask answers 403 api_unavailable) | error (the stream ends with an `error` event).
  const readmeMatch = /^\/api\/readme\/([\w-]+)$/.exec(p);
  if (readmeMatch && readmeMatch[1] !== "ask" && method === "GET") {
    const doc = readmeMatch[1];
    if (!README_DOCS[doc]) return fail(res, 404, "unknown doc", "not_found");
    return send(res, 200, { doc, markdown: README_DOCS[doc], assistant: process.env.MOCK_README_ASSISTANT !== "off" });
  }
  if (p === "/api/readme/ask" && method === "POST") {
    const mode = process.env.MOCK_README_ASSISTANT;
    if (mode === "off" || mode === "forbidden") return fail(res, 403, "The docs assistant is not available right now", "api_unavailable");
    let asked;
    try {
      asked = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      return fail(res, 400, "bad body", "bad_request");
    }
    const last = asked?.messages?.[asked.messages.length - 1]?.text;
    if (typeof last !== "string") return fail(res, 400, "bad body", "bad_request");
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pieces = `Agent Workstation runs on your own server. You asked: "${last.slice(0, 80)}".\n\n- Start with **Get started**.\n- Everything else is under **Features**.\n`.match(/.{1,12}/gs) ?? [];
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      if (i < pieces.length) return ev("delta", { text: pieces[i++] });
      clearInterval(timer);
      if (mode === "error") ev("error", { code: "internal", message: "The assistant failed" });
      else ev("done", { costUsd: 0.002 });
      res.end();
    }, 40);
    res.on("close", () => clearInterval(timer));
    return;
  }

  if (p === "/api/users") {
    if (method === "GET") {
      // like the hub: the list is admin-only (401 without an identity, 403 for a regular user)
      const who = typeof name === "string" ? users.get(name) : undefined;
      if (!who) return fail(res, 401, "unknown user", "unknown_user");
      if (!who.isAdmin) return fail(res, 403, "admin only", "forbidden");
      return send(res, 200, [...users.values()]);
    }
    if (method === "POST") {
      const body = await readJson(req);
      const parsed = CreateUserBody.safeParse(body);
      if (!parsed.success) return fail(res, 400, "username must match [a-z0-9_-]{1,32}", "bad_request");
      if (users.has(parsed.data.name)) return fail(res, 409, "user exists", "exists");
      return send(res, 201, ensureUser(parsed.data.name));
    }
  }

  const user = typeof name === "string" ? users.get(name) : undefined;
  if (!user) return fail(res, p === "/api/me" ? 404 : 401, "unknown user", "unknown_user");
  if (!user.enabled && p !== "/api/me") return fail(res, 403, "user disabled", "user_disabled");
  const admin = () => (user.isAdmin ? true : (fail(res, 403, "admin only", "forbidden"), false));

  if (p === "/api/me") return send(res, 200, { user, settings, disk: diskStatus(user.name).level, apiAvailable: apiBlock() !== null, protocolVersion: PROTOCOL_VERSION });
  if (p === "/api/models") return send(res, 200, servedModels().filter((m) => !user.modelAllowlist || user.modelAllowlist.includes(m.value)));
  if (p === "/api/commands") return send(res, 200, commandsFor(user.name));
  if (p === "/api/search" && method === "GET") {
    const query = (q.get("q") ?? "").trim();
    if (!query) return fail(res, 400, "q is required", "invalid_request");
    return send(res, 200, { hits: keywordSearch(user.name, query, Math.min(100, Number(q.get("limit")) || 20)) });
  }
  if (p === "/api/search/relevant" && method === "GET") {
    const query = (q.get("q") ?? "").trim();
    if (!query) return fail(res, 400, "q is required", "invalid_request");
    if (apiBlock() === null) return fail(res, 503, "No API key or budget is configured on the server", "api_unavailable");
    const key = `${user.name}\0${query.toLowerCase()}`;
    const cached = relevantCache.has(key);
    if (!cached) {
      await sleep(RELEVANT_DELAY_MS);
      relevantCache.set(key, relevantSearch(user.name, query, Math.min(100, Number(q.get("limit")) || 10)));
    }
    return send(res, 200, { hits: relevantCache.get(key), model: "claude-haiku-5-5", cached });
  }
  if (p === "/api/me/preferences" && method === "PATCH") {
    const body = await readJson(req);
    for (const k of ["defaultModel", "defaultEffort", "memoryEnabled", "notificationsEnabled"]) if (body && k in body) user[k] = body[k];
    if (typeof body?.instructions === "string") {
      const text = body.instructions.trimEnd();
      if (text.length > 12_000) return fail(res, 400, "invalid body", "invalid_request");
      user.instructions = text;
    }
    return send(res, 200, user);
  }

  // ---- memory -------------------------------------------------------------
  if (p === "/api/me/memories") {
    if (method === "GET") return send(res, 200, { memories: memoriesOf(user.name) });
    if (method === "POST") {
      const text = cleanMemory((await readJson(req))?.text);
      if (!text || text.length > 2000) return fail(res, 400, "memory text must be 1..2000 characters", "invalid_request");
      return send(res, 200, addMemory(user.name, text, "user"));
    }
  }
  if (seg[1] === "me" && seg[2] === "memories" && seg[3]) {
    const list = memoriesOf(user.name);
    const m = list.find((x) => x.id === seg[3]);
    if (!m) return fail(res, 404, "no such memory", "memory_not_found");
    if (method === "PATCH") {
      const text = cleanMemory((await readJson(req))?.text);
      if (!text || text.length > 2000) return fail(res, 400, "memory text must be 1..2000 characters", "invalid_request");
      m.text = text;
      m.updatedAt = now();
      emit(user.name, { type: "memories_changed" });
      return send(res, 200, m);
    }
    if (method === "DELETE") {
      list.splice(list.indexOf(m), 1);
      emit(user.name, { type: "memories_changed" });
      return send(res, 204);
    }
  }

  // ---- known heads-ups ("Knew this already") ----------------------------------
  if (p === "/api/me/heads-up/known") {
    let list = knownHeadsUpsByUser.get(user.name);
    if (!list) knownHeadsUpsByUser.set(user.name, (list = []));
    if (method === "GET") return send(res, 200, { known: list });
    if (method === "POST") {
      const text = (await readJson(req))?.text;
      if (typeof text !== "string" || !text.trim() || text.length > 300) return fail(res, 400, "text must be 1..300 characters", "invalid_request");
      const entry = list.find((k) => k.text === text) ?? { id: uuid(), text, at: now() };
      knownHeadsUpsByUser.set(user.name, [entry, ...list.filter((k) => k !== entry)].slice(0, 200));
      return send(res, 200, entry);
    }
    if (method === "DELETE") {
      const id = q.get("id");
      if (!list.some((k) => k.id === id)) return fail(res, 404, "no such heads-up", "not_found");
      knownHeadsUpsByUser.set(user.name, list.filter((k) => k.id !== id));
      return send(res, 204);
    }
  }

  // ---- admin pricing ---------------------------------------------------------
  if (p === "/api/admin/pricing" && method === "GET") return admin() && send(res, 200, mockPricing());
  if (p === "/api/admin/pricing/refresh" && method === "POST") {
    if (!admin()) return;
    const check = { id: pricingChecks.length + 1, at: now(), trigger: "admin", outcome: "unchanged", model: "claude-haiku-5-5", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, effectiveFrom: null, previousInputPerMtok: 1, previousOutputPerMtok: 5, message: null };
    pricingChecks.unshift(check);
    return send(res, 200, { check, pricing: mockPricing() });
  }

  // ---- browser sites (always-allowed origins) -------------------------------
  if (p === "/api/me/browser-sites") {
    const grants = browserSitesOf(user.name);
    if (method === "GET") return send(res, 200, { sites: [...grants.values()].sort((a, b) => (b.lastUsedAt ?? b.grantedAt).localeCompare(a.lastUsedAt ?? a.grantedAt)) });
    if (method === "DELETE") {
      const origin = q.get("origin");
      if (!origin) return fail(res, 400, "origin is required", "invalid_request");
      if (!grants.delete(origin)) return fail(res, 404, "no such site", "site_not_found");
      return send(res, 204);
    }
  }

  // ---- sessions -----------------------------------------------------------
  if (p === "/api/sessions") {
    if (method === "GET") {
      const kind = q.get("kind");
      return send(res, 200, [...sessions.values()].map((r) => r.s).filter((s) => s.user === user.name && !s.incognito && !s.parentSessionId && (!kind || s.kind === kind)));
    }
    if (method === "POST") {
      const parsed = CreateSessionBody.safeParse(await readJson(req));
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "bad request", "bad_request");
      const wanted = parsed.data.model || user.defaultModel || settings.defaultModel;
      if (wanted && !modelEntry(wanted)) return fail(res, 400, "unknown model", "bad_request");
      if (parsed.data.incognito && parsed.data.kind !== "chat") return fail(res, 400, "incognito is for Chat sessions only", "bad_request");
      if (apiBlock() === null) return fail(res, 503, "No API key or budget is configured on the server", "api_unavailable");
      const rec = newSession(user.name, parsed.data);
      emit(user.name, { type: "session_updated", session: { ...rec.s } });
      return send(res, 201, rec.s);
    }
  }
  if (seg[1] === "sessions" && seg[2]) {
    const rec = sessionFor(user.name, seg[2]);
    if (!rec) return fail(res, 404, "session not found", "not_found");
    const sub = seg[3];
    if (!sub) {
      if (method === "GET") return send(res, 200, rec.s);
      if (method === "PATCH") {
        const body = await readJson(req);
        if (typeof body?.title !== "string" && typeof body?.notify !== "boolean") return fail(res, 400, "nothing to change", "bad_request");
        if (typeof body.title === "string") {
          rec.s.title = body.title.slice(0, 200);
          rec.titled = true;
        }
        if (typeof body.notify === "boolean") rec.s.notify = body.notify;
        emit(user.name, { type: "session_updated", session: { ...rec.s } });
        return send(res, 200, rec.s);
      }
      if (method === "DELETE") {
        stopSession(rec);
        sessions.delete(rec.s.id);
        emit(user.name, { type: "session_deleted", sessionId: rec.s.id });
        return send(res, 204);
      }
    }
    if (sub === "messages") {
      if (method === "GET") {
        const after = Number(q.get("after") || 0);
        const limit = Math.min(1000, Number(q.get("limit") || 500));
        return send(res, 200, rec.messages.filter((m) => m.seq > after).slice(0, limit));
      }
      if (method === "POST") {
        const parsed = SendMessageBody.safeParse(await readJson(req));
        if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "bad request", "bad_request");
        const { uuid: msgUuid, text, attachments } = parsed.data;
        const dup = rec.messages.find((m) => m.kind === "user" && m.uuid === msgUuid);
        if (dup) return send(res, 202, { state: "accepted", position: null, seq: dup.seq });
        const blocked = checkSendBlock(user.name, text);
        if (blocked) return fail(res, blocked[1], blocked[2], blocked[0]);
        const content = [];
        if (text) content.push({ type: "text", text });
        for (const a of attachments ?? []) if (a.type === "image") content.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 } });
        const m = persist(rec, "user", userPayload(rec, msgUuid, content), msgUuid);
        if (rec.nextStep) setNextStep(rec, null); // sending anything clears the end-of-turn box
        if (!rec.titled && text.trim()) {
          rec.s.title = text.trim().slice(0, 48);
          rec.titled = true;
        }
        emit(user.name, { type: "session_updated", session: { ...rec.s } });
        if (text.toLowerCase().includes("queue me") || rec.run) {
          setStatus(rec, "queued", 1);
          send(res, 202, { state: "queued", position: 1, seq: m.seq });
          setTimeout(() => void runTurn(rec, text), 3000);
          return;
        }
        send(res, 202, { state: "accepted", position: null, seq: m.seq });
        void runTurn(rec, text);
        return;
      }
    }
    if (sub === "settings" && method === "PATCH") {
      const parsed = SessionSettings.safeParse(await readJson(req));
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "bad request", "bad_request");
      const b = parsed.data;
      if (b.model !== undefined) {
        if (!modelEntry(b.model)) return fail(res, 400, "unknown model", "bad_request");
        rec.s.model = b.model;
      }
      if (b.permissionMode !== undefined) rec.s.permissionMode = b.permissionMode;
      if (b.effort !== undefined) rec.s.effort = b.effort;
      emit(user.name, { type: "session_settings", sessionId: rec.s.id, settings: { model: rec.s.model, permissionMode: rec.s.permissionMode, effort: rec.s.effort } }, rec.s.id);
      emit(user.name, { type: "session_updated", session: { ...rec.s } });
      return send(res, 200, rec.s);
    }
    if (sub === "stop" && method === "POST") {
      stopSession(rec);
      return send(res, 204);
    }
    if (sub === "rewind" && method === "POST") {
      const body = await readJson(req);
      const target = rec.messages.find((m) => m.kind === "user" && m.uuid === body?.messageUuid);
      if (!target) return fail(res, 404, "message not found", "not_found");
      if (body.files && !/^projects\//.test(rec.s.cwd)) return fail(res, 409, "no snapshot to restore", "unsupported");
      const draft = messageText(target);
      stopSession(rec);
      const lastHeld = rec.messages.reduce((n, m) => Math.max(n, m.seq), target.seq);
      (rec.rewound ??= []).push([target.seq, lastHeld]);
      rec.messages = rec.messages.filter((m) => m.seq < target.seq);
      if (rec.s.pinnedMessages) rec.s.pinnedMessages = rec.s.pinnedMessages.filter((u) => rec.messages.some((m) => m.uuid === u));
      if (rec.nextStep) setNextStep(rec, null);
      emit(user.name, { type: "messages_rewound", sessionId: rec.s.id, fromSeq: target.seq }, rec.s.id);
      emit(user.name, { type: "session_updated", session: { ...rec.s } });
      send(res, 200, { draft, filesRestored: !!body.files });
      if (body.resend) {
        const text = typeof body.resend.text === "string" ? body.resend.text : draft;
        const id = uuid();
        persist(rec, "user", userPayload(rec, id, [{ type: "text", text }]), id);
        void runTurn(rec, text);
      }
      return;
    }
    if (sub === "fork" && method === "POST") {
      const body = await readJson(req);
      const at = rec.messages.find((m) => m.uuid === body?.messageUuid);
      if (!at) return fail(res, 404, "message not found", "not_found");
      const fork = newSession(user.name, { kind: rec.s.kind, title: `${rec.s.title} (fork)`, cwd: rec.s.cwd, model: rec.s.model, permissionMode: rec.s.permissionMode, effort: rec.s.effort });
      const keep = at.kind === "user" ? rec.messages.filter((m) => m.seq < at.seq) : rec.messages.filter((m) => m.seq <= at.seq);
      fork.messages = keep.map((m) => ({ ...m, sessionId: fork.s.id }));
      fork.s.lastSeq = keep.length ? keep[keep.length - 1].seq : 0;
      fork.titled = true;
      emit(user.name, { type: "session_updated", session: { ...fork.s } });
      return send(res, 200, { session: fork.s, draft: at.kind === "user" ? messageText(at) : null });
    }
    if (sub === "pins" && seg[4] && (method === "PUT" || method === "DELETE")) {
      const id = decodeURIComponent(seg[4]);
      if (!rec.messages.some((m) => m.uuid === id)) return fail(res, 404, "message not found", "not_found");
      const rest = (rec.s.pinnedMessages ?? []).filter((u) => u !== id);
      rec.s.pinnedMessages = method === "PUT" ? [...rest, id] : rest;
      emit(user.name, { type: "session_updated", session: { ...rec.s } });
      return send(res, 200, rec.s);
    }
    if (sub === "close" && method === "POST") return send(res, 204);
    if (sub === "tasks" && seg[5] === "stop" && method === "POST") {
      const taskId = decodeURIComponent(seg[4] ?? "");
      if (!rec.tasks?.some((t) => t.taskId === taskId)) return fail(res, 404, "no such background task", "not_found");
      setBackgroundTasks(rec, rec.tasks.filter((t) => t.taskId !== taskId));
      return send(res, 204);
    }
  }

  // ---- files ----------------------------------------------------------------
  if (seg[1] === "files") {
    const rel = q.get("path") ?? "";
    if (seg[2] === "tree" && method === "GET") {
      const abs = safePath(user.name, rel);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return fail(res, 404, "not found", "not_found");
      return send(res, 200, listDir(user.name, abs, Math.min(10, Number(q.get("depth") || 1))));
    }
    if (seg[2] === "content" && method === "GET") {
      const abs = safePath(user.name, rel);
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return fail(res, 404, "not found", "not_found");
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const isImage = ext in IMG_TYPES;
      const head = buf.subarray(0, 4096);
      const binary = isImage || (!TEXT_EXT.has(ext) && head.includes(0)) || head.includes(0);
      const LIMIT = 256 * 1024;
      return send(res, 200, { path: rel, size: buf.length, truncated: !binary && buf.length > LIMIT, text: binary ? null : buf.subarray(0, LIMIT).toString("utf8"), mediaType: isImage ? IMG_TYPES[ext] : binary ? "application/octet-stream" : ext === ".json" ? "application/json" : "text/plain" });
    }
    if (seg[2] === "download" && method === "GET") {
      const paths = q.getAll("path");
      if (!paths.length) return fail(res, 400, "path required", "bad_request");
      const abss = paths.map((x) => safePath(user.name, x));
      if (abss.some((a) => !a || !fs.existsSync(a))) return fail(res, 404, "not found", "not_found");
      if (abss.length === 1 && !fs.statSync(abss[0]).isDirectory()) {
        const abs = abss[0];
        return send(res, 200, fs.readFileSync(abs), { "content-type": IMG_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream", "content-disposition": contentDisposition(path.basename(abs)) });
      }
      const entries = [];
      for (const [i, abs] of abss.entries()) {
        const base = path.basename(paths[i]);
        if (fs.statSync(abs).isDirectory()) for (const f of walkFiles(abs, base)) entries.push(f);
        else entries.push({ name: base, data: fs.readFileSync(abs) });
      }
      const zipName = abss.length === 1 ? `${path.basename(paths[0])}.zip` : "download.zip";
      return send(res, 200, zip(entries), { "content-type": "application/zip", "content-disposition": contentDisposition(zipName) });
    }
    if (seg[2] === "upload" && method === "PUT") {
      const h = req.headers;
      const uploadId = String(h["x-upload-id"] || "");
      let target = String(h["x-upload-path"] || "");
      try {
        target = decodeURIComponent(target);
      } catch {}
      const index = Number(h["x-chunk-index"]);
      const total = Number(h["x-chunk-total"]);
      const totalBytes = Number(h["x-total-bytes"]);
      if (!uploadId || !target || !Number.isInteger(index) || !Number.isInteger(total)) return fail(res, 400, "missing upload headers", "bad_request");
      const body = await readBody(req);
      const key = `${user.name}:${uploadId}`;
      let up = uploads.get(key);
      if (!up) uploads.set(key, (up = { path: target, total, totalBytes, chunks: new Map(), finalPath: null }));
      up.chunks.set(index, body);
      const received = [...up.chunks.keys()].sort((a, b) => a - b);
      let complete = false;
      if (received.length >= up.total) {
        let rel2 = up.path;
        let abs = safePath(user.name, rel2);
        if (!abs) return fail(res, 400, "bad path", "bad_request");
        for (let n = 1; fs.existsSync(abs); n++) {
          const ext = path.extname(up.path);
          rel2 = `${up.path.slice(0, up.path.length - ext.length)} (${n})${ext}`;
          abs = safePath(user.name, rel2);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.concat(received.map((i) => up.chunks.get(i))));
        up.finalPath = rel2;
        complete = true;
        uploads.delete(key);
        emit(user.name, { type: "file_event", path: rel2, kind: "add", sessionId: null, at: now() });
      }
      return send(res, 200, { uploadId, received, complete, ...(complete ? { path: up.finalPath } : {}) });
    }
    if (seg[2] === "mkdir" && method === "POST") {
      const body = await readJson(req);
      const abs = typeof body?.path === "string" ? safePath(user.name, body.path) : null;
      if (!abs) return fail(res, 400, "bad path", "bad_request");
      fs.mkdirSync(abs, { recursive: true });
      emit(user.name, { type: "file_event", path: body.path, kind: "addDir", sessionId: null, at: now() });
      return send(res, 204);
    }
    if (!seg[2] && method === "DELETE") {
      const abs = safePath(user.name, rel);
      if (!rel || !abs || abs === userRoot(user.name) || !fs.existsSync(abs)) return fail(res, 404, "not found", "not_found");
      const isDir = fs.statSync(abs).isDirectory();
      fs.rmSync(abs, { recursive: true, force: true });
      emit(user.name, { type: "file_event", path: rel, kind: isDir ? "unlinkDir" : "unlink", sessionId: null, at: now() });
      return send(res, 204);
    }
  }

  // ---- projects + review ------------------------------------------------------
  if (NO_PROJECTS && (p === "/api/projects" || seg[1] === "projects" || seg[1] === "skills")) return fail(res, 501, `not implemented: ${method} ${p}`, "not_implemented");
  if (p === "/api/projects" && method === "GET") return send(res, 200, (projectsByUser.get(user.name) ?? []).map((x) => projectView(user.name, x)));
  if (seg[1] === "projects" && seg[2]) {
    const project = (projectsByUser.get(user.name) ?? []).find((x) => x.id === seg[2]);
    if (!project) return fail(res, 404, "project not found", "not_found");
    if (!seg[3] && method === "GET") return send(res, 200, projectView(user.name, project));
    if (!seg[3] && method === "DELETE") {
      const body = await readJson(req);
      const discard = body && body !== Symbol.for("bad-json") && body.discardRemaining === true;
      if ((project.pending.size > 0 || project.undownloaded > 0) && !discard) return fail(res, 409, `project has ${project.pending.size} pending changes and ${project.undownloaded} undownloaded files`, "project_not_empty");
      const abs = safePath(user.name, project.path);
      if (abs) fs.rmSync(abs, { recursive: true, force: true });
      projectsByUser.set(user.name, (projectsByUser.get(user.name) ?? []).filter((x) => x !== project));
      emit(user.name, { type: "disk_status", status: diskStatus(user.name) });
      return send(res, 204);
    }
    if (seg[3] === "review" && !seg[4] && method === "GET") return send(res, 200, { project: projectView(user.name, project), files: reviewFiles(user.name, project) });
    if (seg[3] === "review" && seg[4] === "diff" && method === "GET") {
      const file = q.get("path") ?? "";
      const ch = project.pending.get(file);
      if (!ch) return send(res, 200, { path: file, localCommit: project.localCommit, diffId: diffIdOf({ oldText: "", newText: "" }), binary: false, oldText: "", newText: "", hunks: [] });
      if (ch.binary) return send(res, 200, { path: file, localCommit: project.localCommit, diffId: diffIdOf(ch), binary: true, oldText: null, newText: null, hunks: [] });
      return send(res, 200, { path: file, localCommit: project.localCommit, diffId: diffIdOf(ch), binary: false, oldText: ch.oldText, newText: ch.newText, hunks: makeHunks(ch.oldText, ch.newText) });
    }
    if (seg[3] === "review" && (seg[4] === "accept" || seg[4] === "reject") && method === "POST") {
      const body = await readJson(req);
      const accept = seg[4] === "accept";
      const targets = body?.all ? [...project.pending.keys()] : typeof body?.path === "string" ? [body.path] : [];
      if (!targets.length) return fail(res, 400, "path or all required", "bad_request");
      const hunkIdx = Array.isArray(body.hunks) ? new Set(body.hunks) : null;
      if (hunkIdx) {
        // hunk indexes only mean something for the diff they came from
        if (typeof body.diffId !== "string") return fail(res, 400, "diffId is required with hunks", "invalid_request");
        const cur = project.pending.get(body.path);
        if (!cur || diffIdOf(cur) !== body.diffId) return fail(res, 409, "the file changed since this diff was computed", "stale_diff");
      }
      const files = [];
      for (const file of targets) {
        const ch = project.pending.get(file);
        if (!ch) continue;
        if (ch.binary || !hunkIdx) {
          project.pending.delete(file);
          project.touched.delete(file);
          if (accept) files.push({ path: file, contentBase64: ch.binary ? null : Buffer.from(ch.newText).toString("base64"), deleted: false });
          else if (!ch.binary) {
            const abs = safePath(user.name, `${project.path}/${file}`);
            if (abs) ch.oldText === "" ? fs.rmSync(abs, { force: true }) : fs.writeFileSync(abs, ch.oldText);
          }
          continue;
        }
        const hunks = makeHunks(ch.oldText, ch.newText);
        if (accept) {
          ch.oldText = applyHunks(ch.oldText, hunks, hunkIdx);
          files.push({ path: file, contentBase64: Buffer.from(ch.oldText).toString("base64"), deleted: false });
        } else {
          const keep = new Set(hunks.map((h) => h.index).filter((i) => !hunkIdx.has(i)));
          ch.newText = applyHunks(ch.oldText, hunks, keep);
          const abs = safePath(user.name, `${project.path}/${file}`);
          if (abs) fs.writeFileSync(abs, ch.newText);
        }
        if (ch.oldText === ch.newText) {
          project.pending.delete(file);
          project.touched.delete(file);
        }
      }
      project.localCommit = crypto.randomBytes(20).toString("hex");
      if (accept) project.history.push({ ref: project.localCommit, sessionId: null, turn: null, at: now(), message: body.all ? "Accepted all changes" : `Accepted ${body.path}${hunkIdx ? ` (${hunkIdx.size} hunk${hunkIdx.size === 1 ? "" : "s"})` : ""}`, kind: "accept" });
      emit(user.name, { type: "review_changed", projectId: project.id, localCommit: project.localCommit, pendingFiles: project.pending.size });
      return send(res, 200, { localCommit: project.localCommit, files });
    }
    if (seg[3] === "history" && method === "GET") return send(res, 200, [...project.history]);
    if (seg[3] === "restore" && method === "POST") {
      const body = await readJson(req);
      const snap = project.history.find((h) => h.ref === body?.ref);
      if (!snap) return fail(res, 404, "unknown ref", "not_found");
      const what = typeof body.path === "string" ? body.path : "all files";
      const trash = { ref: refOf(`${project.id}/trash/${Date.now()}`), sessionId: null, turn: null, at: now(), message: `Before restore of ${what} to ${snap.ref.slice(0, 7)}`, kind: "trash" };
      project.history.push(trash);
      project.localCommit = crypto.randomBytes(20).toString("hex");
      emit(user.name, { type: "review_changed", projectId: project.id, localCommit: project.localCommit, pendingFiles: project.pending.size });
      return send(res, 200, { localCommit: project.localCommit, trash: trash.ref });
    }
    if (seg[3] === "raw" && method === "GET") {
      const abs = safePath(user.name, `${project.path}/${q.get("path") ?? ""}`);
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return fail(res, 404, "not found", "not_found");
      return send(res, 200, fs.readFileSync(abs), { "content-type": IMG_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream" });
    }
  }

  // ---- skills -------------------------------------------------------------------
  if (p === "/api/skills" && method === "GET") return send(res, 200, allSkills(user.name));
  if (p === "/api/skills" && method === "POST") {
    const parsed = SkillBody.safeParse(await readJson(req));
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "bad request", "invalid_request");
    const { name: skillName, content, scope } = parsed.data;
    if (scope === "global" && !admin()) return;
    const store = scope === "global" ? globalSkills : skillsOf(user.name);
    if (store.has(skillName)) return fail(res, 409, "skill exists", "exists");
    const rec = { content, updatedAt: now() };
    store.set(skillName, rec);
    return send(res, 201, skillView(skillName, scope, rec));
  }
  if (seg[1] === "skills" && seg[2]) {
    const skillName = decodeURIComponent(seg[2]);
    const wanted = q.get("scope");
    const scope = wanted === "global" || wanted === "user" ? wanted : skillsOf(user.name).has(skillName) ? "user" : "global";
    const store = scope === "global" ? globalSkills : skillsOf(user.name);
    const rec = store.get(skillName);
    if (!rec) return fail(res, 404, "skill not found", "not_found");
    if (method === "GET") return send(res, 200, { ...skillView(skillName, scope, rec), content: rec.content });
    if (method === "PUT") {
      if (scope === "global" && !admin()) return;
      const parsed = SkillBody.safeParse(await readJson(req));
      if (!parsed.success || parsed.data.name !== skillName) return fail(res, 400, "invalid skill", "invalid_request");
      rec.content = parsed.data.content;
      rec.updatedAt = now();
      return send(res, 200, skillView(skillName, scope, rec));
    }
    if (method === "DELETE") {
      if (scope === "global" && !admin()) return;
      store.delete(skillName);
      return send(res, 204);
    }
  }

  // ---- usage / disk / admin -------------------------------------------------
  if (p === "/api/usage/limits") return send(res, 200, limits());
  if (p === "/api/usage/me") {
    const range = ["today", "7d", "30d"].includes(q.get("range")) ? q.get("range") : "7d";
    const weeklyTokens = user.name === "alice" ? 1_740_000 : 420_000;
    return send(res, 200, { range, buckets: usageBuckets(range, user.name), weeklyTokens, weeklyLimit: user.weeklyTokenLimit });
  }
  if (p === "/api/disk") return send(res, 200, diskStatus(user.name));

  if (seg[1] === "admin") {
    if (!admin()) return;
    if (seg[2] === "overview") {
      const live = [...sessions.values()].filter((r) => r.run);
      const d = diskStatus(user.name);
      return send(res, 200, {
        settings,
        usageLimits: limits(),
        disk: { level: d.level, usedPercent: d.usedPercent, totalBytes: d.totalBytes, freeBytes: d.freeBytes },
        memory: { totalMiB: 16000, availableMiB: 4200, minFreeMiB: 1500 },
        pool: { active: live.length, max: 6, queued: [...sessions.values()].filter((r) => r.s.status === "queued").length },
        processes: live.map((r) => ({ sessionId: r.s.id, user: r.s.user, kind: r.s.kind, status: r.s.status, pid: 4000 + Math.floor(Math.random() * 999), rssMiB: 280, startedAt: r.s.createdAt, lastActiveAt: r.s.lastActiveAt })),
        users: [...users.values()].map((u) => ({ user: u.name, enabled: u.enabled, sessions: [...sessions.values()].filter((r) => r.s.user === u.name).length, weeklyTokens: 420_000, weeklyLimit: u.weeklyTokenLimit })),
      });
    }
    if (seg[2] === "usage") {
      const range = ["today", "7d", "30d"].includes(q.get("range")) ? q.get("range") : "7d";
      const list = [...users.values()];
      return send(res, 200, {
        users: list.map((u, i) => ({ user: u.name, weeklyTokens: 300_000 + i * 700_000, weeklyLimit: u.weeklyTokenLimit, costUsd: Math.round((3.2 + i * 6.1) * 100) / 100, sessions: [...sessions.values()].filter((r) => r.s.user === u.name).length })),
        buckets: list.flatMap((u) => usageBuckets(range, u.name).map((b) => ({ ...b, user: u.name }))),
      });
    }
    if (seg[2] === "settings") {
      if (method === "GET") return send(res, 200, settings);
      if (method === "PATCH") {
        const body = await readJson(req);
        if (body?.apiMonthlyLimitUsd !== undefined && !(typeof body.apiMonthlyLimitUsd === "number" && body.apiMonthlyLimitUsd >= 0)) return fail(res, 400, "apiMonthlyLimitUsd must be a number >= 0", "invalid_request");
        if (body?.apiResetDay !== undefined && !(Number.isInteger(body.apiResetDay) && body.apiResetDay >= 1 && body.apiResetDay <= 28)) return fail(res, 400, "apiResetDay must be a whole day 1-28", "invalid_request");
        if (body?.serviceReserveUsd !== undefined && !(typeof body.serviceReserveUsd === "number" && body.serviceReserveUsd >= 0 && body.serviceReserveUsd <= 1_000_000)) return fail(res, 400, "serviceReserveUsd must be between 0 and 1000000", "invalid_request");
        for (const k of ["remoteClaudeEnabled", "diskWarnPercent", "diskBlockPercent", "defaultWeeklyTokenLimit", "defaultModel", "defaultEffort", "apiMonthlyLimitUsd", "apiResetDay", "serviceReserveUsd"]) if (body?.[k] !== undefined) settings[k] = body[k];
        for (const u of users.keys()) emit(u, { type: "disk_status", status: diskStatus(u) });
        for (const u of users.keys()) emit(u, { type: "usage_limits", limits: limits() });
        return send(res, 200, settings);
      }
    }
  }
  if (seg[1] === "users" && seg[2] && method === "PATCH") {
    if (!admin()) return;
    const target = users.get(seg[2]);
    if (!target) return fail(res, 404, "user not found", "not_found");
    const body = await readJson(req);
    for (const k of ["enabled", "terminalEnabled", "weeklyTokenLimit", "modelAllowlist"]) if (body?.[k] !== undefined) target[k] = body[k];
    return send(res, 200, target);
  }

  // ---- browser ---------------------------------------------------------------
  if (p === "/api/browser" && method === "GET") return send(res, 200, browserState(user.name));
  if (p === "/api/browser/start" && method === "POST") {
    const b = browserFor(user.name);
    if (!b.running) {
      b.running = true;
      b.controlledBy = "agent";
      if (!b.url) browserGo(b, "https://example.com/");
      ensureBrowserTimer();
      broadcastBrowser(user.name);
    }
    return send(res, 200, browserState(user.name));
  }
  if (p === "/api/browser/stop" && method === "POST") {
    const b = browserFor(user.name);
    if (b.running) {
      b.running = false;
      b.controlledBy = null;
      broadcastBrowser(user.name);
    }
    return send(res, 200, browserState(user.name));
  }

  // ---- terminals --------------------------------------------------------------
  if (p === "/api/terminals") {
    if (!user.terminalEnabled) return fail(res, 403, "terminal disabled", "terminal_disabled");
    if (method === "GET") return send(res, 200, [...terminals.values()].filter((t) => t.user === user.name).map(terminalInfo));
    if (method === "POST") {
      const body = await readJson(req);
      const id = `t${crypto.randomBytes(3).toString("hex")}`;
      const t = { id, user: user.name, cwd: typeof body?.cwd === "string" ? body.cwd : "", createdAt: now(), line: "", scrollback: "", sockets: new Set(), dir: "" };
      t.scrollback = `Welcome to workstation (mock shell)\r\n${prompt(t)}`;
      terminals.set(id, t);
      return send(res, 201, terminalInfo(t));
    }
  }
  if (seg[1] === "terminals" && seg[2] && method === "DELETE") {
    const t = terminals.get(seg[2]);
    if (!t || t.user !== user.name) return fail(res, 404, "terminal not found", "not_found");
    for (const s of t.sockets) s.close();
    terminals.delete(t.id);
    return send(res, 204);
  }

  return fail(res, 404, `no route for ${method} ${p}`, "not_found");
}

const terminalInfo = (t) => ({ id: t.id, cwd: t.cwd, createdAt: t.createdAt, tmuxSession: `term-${t.user}` });

// ---------------------------------------------------------------------------
// fake shell
// ---------------------------------------------------------------------------
const prompt = (t) => `${t.user}@workstation:${t.dir ? `~/${t.dir}` : "~"}$ `;

function termOut(t, data) {
  t.scrollback = (t.scrollback + data).slice(-60_000);
  for (const ws of t.sockets) ws.send(JSON.stringify({ t: "out", data }));
}

function runCommand(t, line) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const root = path.join(userRoot(t.user), t.dir);
  switch (cmd) {
    case "":
      return "";
    case "ls": {
      try {
        return fs.readdirSync(root).filter((n) => !n.startsWith(".")).join("  ") + "\r\n";
      } catch {
        return "ls: cannot access\r\n";
      }
    }
    case "pwd":
      return `/srv/agent-workstation/users/${t.user}${t.dir ? "/" + t.dir : ""}\r\n`;
    case "echo":
      return args.join(" ") + "\r\n";
    case "whoami":
      return `${t.user}\r\n`;
    case "date":
      return new Date().toString() + "\r\n";
    case "cd": {
      const target = args[0] || "";
      const next = path.posix.normalize(path.posix.join(t.dir, target));
      if (!target || target === "~") t.dir = "";
      else if (next.startsWith("..")) return "cd: outside workspace\r\n";
      else if (fs.existsSync(path.join(userRoot(t.user), next))) t.dir = next === "." ? "" : next;
      else return `bash: cd: ${target}: No such file or directory\r\n`;
      return "";
    }
    case "clear":
      return "\x1b[2J\x1b[H";
    default:
      return `bash: ${cmd}: command not found\r\n`;
  }
}

function termInput(t, data) {
  let out = "";
  if (data.startsWith("\x1b")) return; // arrows etc.
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      const line = t.line;
      t.line = "";
      if (line.trim() === "exit") {
        for (const s of t.sockets) s.send(JSON.stringify({ t: "exit", code: 0 }));
        terminals.delete(t.id);
        return;
      }
      out += "\r\n" + runCommand(t, line) + prompt(t);
    } else if (ch === "\x7f") {
      if (t.line) {
        t.line = t.line.slice(0, -1);
        out += "\b \b";
      }
    } else if (ch === "\x03") {
      t.line = "";
      out += "^C\r\n" + prompt(t);
    } else if (ch >= " ") {
      t.line += ch;
      out += ch;
    }
  }
  if (out) termOut(t, out);
}

// ---------------------------------------------------------------------------
// static UI + server
// ---------------------------------------------------------------------------
function serveStatic(req, res, url) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("mock hub is running, but packages/web/dist is missing. Run `npm run build -w packages/web` or use the Vite dev server.\n");
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html"); // SPA fallback
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  fs.createReadStream(file).pipe(res);
}

/** Test hooks: push arbitrary server events / filler history from a script or curl. */
async function handleMockHook(req, res, url) {
  const body = await readJson(req);
  if (url.pathname === "/__mock/emit") {
    const parsed = ServerEvent.safeParse(body?.event);
    if (!parsed.success) return fail(res, 400, JSON.stringify(parsed.error.issues[0]), "bad_request");
    emit(String(body.user), parsed.data, typeof body.sessionId === "string" ? body.sessionId : null);
    return send(res, 204);
  }
  if (url.pathname === "/__mock/browser") {
    const b = browserFor(String(body?.user));
    if (body?.controlledBy === "agent" || body?.controlledBy === "user") b.controlledBy = body.controlledBy;
    if (typeof body?.url === "string") browserGo(b, body.url);
    broadcastBrowser(String(body?.user));
    return send(res, 200, browserState(String(body?.user)));
  }
  if (url.pathname === "/__mock/api") {
    apiSpend = Math.max(0, Number(body?.spentUsd) || 0);
    for (const u of users.keys()) emit(u, { type: "usage_limits", limits: limits() });
    return send(res, 200, { api: apiBlock() });
  }
  if (url.pathname === "/__mock/seed-session") {
    const seeded = ensureUser(String(body?.user));
    const rec = newSession(seeded.name, { kind: body?.kind === "code" ? "code" : "chat", title: String(body?.title ?? "Seeded chat"), model: body?.model, incognito: body?.incognito === true });
    for (const m of Array.isArray(body?.messages) ? body.messages : []) {
      const id = uuid();
      if (m.role === "assistant") persist(rec, "assistant", asstPayload(rec, `msg_${id.slice(0, 12)}`, { type: "text", text: String(m.text) }));
      else persist(rec, "user", userPayload(rec, id, [{ type: "text", text: String(m.text) }]), id);
    }
    rec.s.lastActiveAt = new Date(Date.now() - (Number(body?.ageMinutes) || 0) * 60_000).toISOString();
    emit(seeded.name, { type: "session_updated", session: { ...rec.s } });
    return send(res, 200, rec.s);
  }
  if (url.pathname === "/__mock/seed") {
    const rec = sessionFor(String(body?.user), String(body?.sessionId));
    if (!rec) return fail(res, 404, "session not found", "not_found");
    const n = Math.min(5000, Number(body.count) || 0);
    for (let i = 0; i < n; i++) {
      const id = uuid();
      if (i % 2 === 0) persist(rec, "user", userPayload(rec, id, [{ type: "text", text: `Filler question ${rec.s.lastSeq + 1}` }]), id);
      else persist(rec, "assistant", asstPayload(rec, `msg_${id.slice(0, 12)}`, { type: "text", text: `Filler answer ${rec.s.lastSeq + 1}` }));
    }
    return send(res, 200, { lastSeq: rec.s.lastSeq });
  }
  return fail(res, 404, "no such hook", "not_found");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") return send(res, 204);
  try {
    if (url.pathname.startsWith("/__mock/") && req.method === "POST") return await handleMockHook(req, res, url);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    log("handler error", e);
    if (!res.headersSent) fail(res, 500, String(e?.message ?? e), "internal");
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true });
const wssTerm = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const m = /^\/ws\/terminal\/([^/]+)$/.exec(url.pathname);
  if (m) {
    wssTerm.handleUpgrade(req, socket, head, (ws) => onTerminalSocket(ws, decodeURIComponent(m[1]), url.searchParams.get("user")));
  } else if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => onHubSocket(ws));
  } else socket.destroy();
});

function onTerminalSocket(ws, id, userName) {
  const t = terminals.get(id);
  if (!t || (userName && t.user !== userName)) return ws.close(4404, "no such terminal");
  t.sockets.add(ws);
  if (t.scrollback) ws.send(JSON.stringify({ t: "out", data: t.scrollback }));
  ws.on("message", (raw) => {
    let f;
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (f.t === "in" && typeof f.data === "string") termInput(t, f.data);
    // resize: nothing to do for the fake shell
  });
  ws.on("close", () => t.sockets.delete(ws));
}

function onHubSocket(ws) {
  const c = { ws, user: null, subs: new Set() };
  ws.on("message", (raw) => {
    let json;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const parsed = ClientEvent.safeParse(json);
    if (!parsed.success) {
      log("WARN bad client event", JSON.stringify(parsed.error.issues[0]));
      return;
    }
    const ev = parsed.data;
    if (ev.type === "hello") {
      const u = users.get(ev.user);
      if (!u) {
        sendRaw({ ws }, { type: "error", code: "unknown_user", message: "unknown user" });
        return ws.close();
      }
      c.user = u.name;
      clients.add(c);
      sendRaw(c, { type: "welcome", user: u, protocolVersion: PROTOCOL_VERSION, serverTime: now() });
      sendRaw(c, { type: "usage_limits", limits: limits() });
      if (diskStatus(u.name).level !== "ok") sendRaw(c, { type: "disk_status", status: diskStatus(u.name) });
      return;
    }
    if (!c.user) return;
    if (ev.type === "ping") return sendRaw(c, { type: "pong" });
    if (ev.type === "subscribe") {
      const rec = sessionFor(c.user, ev.sessionId);
      if (!rec) return sendRaw(c, { type: "error", code: "not_found", message: "session not found", sessionId: ev.sessionId });
      c.subs.add(ev.sessionId);
      const missed = rec.messages.filter((m) => m.seq > ev.lastSeq);
      const cut = missed.length > REPLAY_CAP;
      sendRaw(c, { type: "replay", sessionId: rec.s.id, messages: cut ? missed.slice(-REPLAY_CAP) : missed, ...(cut ? { truncated: true } : {}) });
      sendRaw(c, { type: "snapshot", sessionId: rec.s.id, snapshot: { session: { ...rec.s }, partial: { ...rec.partial, turnOutputTokens: rec.turn?.tokens ?? 0 }, turnStartedAt: rec.run ? (rec.turn?.startedAt ?? null) : null, pendingPermission: rec.pending ? rec.pending.request : null, backgroundTasks: rec.tasks ?? [], nextStep: rec.nextStep ?? null, ...(rec.rewound?.length ? { rewound: rec.rewound } : {}) } });
      return;
    }
    if (ev.type === "browser_view") {
      c.browserView = { on: ev.on, maxWidth: ev.maxWidth };
      if (ev.on) ensureBrowserTimer();
      broadcastBrowser(c.user);
      return;
    }
    if (ev.type === "browser_input") return browserInput(c.user, ev.input);
    if (ev.type === "unsubscribe") {
      c.subs.delete(ev.sessionId);
      return;
    }
    if (ev.type === "permission_response") {
      const rec = sessionFor(c.user, ev.sessionId);
      if (rec?.pending && rec.pending.request.requestId === ev.response.requestId) {
        const r = ev.response;
        rec.pending.resolve({ behavior: r.behavior, message: r.message, updatedInput: r.updatedInput, remember: r.remember });
      }
    }
  });
  ws.on("close", () => {
    clients.delete(c);
    if (c.browserView?.on && c.user) broadcastBrowser(c.user);
  });
}

server.listen(PORT, () => {
  log(`mock hub on http://localhost:${PORT}  admin=${ADMIN} disk=${DISK} root=${ROOT} ui=${fs.existsSync(DIST) ? "dist" : "(no dist)"}`);
});
process.on("SIGINT", () => process.exit(0));
