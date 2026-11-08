# @agent-workstation/web

Browser workbench for Agent Workstation: Chat and Code sessions against the Claude Agent SDK, a files browser, a terminal bridge,
per-project change review and history, projects and skills management, usage and admin pages, and the `embed.html` entry
for host apps that show the transcript, a diff or a terminal in a `WKWebView`. The macOS app shows the full web UI.

Stack: Vite 8, React 18, TypeScript (strict), react-router 7, zustand, Tailwind CSS v4, Radix primitives (dialog, dropdown,
tooltip, tabs), lucide-react, react-markdown + remark-gfm, highlight.js, CodeMirror 6 (`@codemirror/merge`), xterm.js,
vitest + Testing Library, Playwright.

## Scripts

All scripts run from the repo root with `-w packages/web`, or from this directory.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173. Proxies `/api`, `/ws`, `/healthz`, `/status` to `VITE_HUB_URL` (default `http://localhost:9000`). |
| `npm run build` | `tsc --noEmit` + `vite build` → `dist/` (`index.html`, `embed.html`, hashed assets). The hub serves `dist/` at `/`. |
| `npm run build:embed` | Same code, relative asset URLs, only `embed.html` → `dist-embed/` (for a host that bundles the page instead of loading it from the hub). |
| `npm run preview` | Serve `dist/` on :4173. |
| `npm test` | vitest (jsdom). 300+ unit/component tests. |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / eslint flat config. |
| `npm run e2e` | Playwright against a live hub, see [E2E](#e2e). Skips itself when `E2E_BASE_URL` is unset. |
| `npm run mock` | Mock hub on :9000 (see [Running without a hub](#running-without-a-hub)). |

`@agent-workstation/protocol` must be built (`npm run build -w packages/protocol`) before typecheck/test/build; the repo-level `npm run build` does that first.

## Running against a hub

```bash
# a development hub on this machine (npm run dev:hub, http://localhost:9000: the default VITE_HUB_URL;
# add http://localhost:5173 to [server] allowed_origins in config/workstation.toml)
npm run dev -w packages/web                                          # http://localhost:5173
# a deployed server, through its https tailnet name (add http://localhost:5173 to its [server] allowed_origins first)
VITE_HUB_URL=https://workstation.example-tailnet.ts.net npm run dev -w packages/web
# or let the hub serve the production build
npm run build -w packages/web      # hub serves packages/web/dist at /
```

To test an unreleased build against the real server without deploying it, serve `dist/` locally and proxy `/api` + `/ws` to the hub
(`vite preview` inherits the dev proxy): `VITE_HUB_URL=https://workstation.example-tailnet.ts.net npx vite preview --host 127.0.0.1 --port 4173` (the server must list `http://127.0.0.1:4173` in `[server] allowed_origins`).

Identity is a username (on a deployed server bound to the caller's Tailscale login): the first screen (`/login`) lists `GET /api/users`, creates a user on the fly (`POST /api/users`,
`[a-z0-9_-]{1,32}`) and keeps the name in `localStorage` (`workstation.user`). Every request carries `X-Workstation-User`; WebSockets
carry `?user=` (browsers cannot set headers on a WebSocket, see `USER_QUERY_PARAM`).

### Running without a hub

`mock/mock-hub.mjs` is a dependency-light stand-in that implements the REST routes and both WebSockets the UI uses and
validates every outgoing WS event with the protocol's `ServerEvent` schema (it warns on drift).

```bash
npm run build -w packages/web && node packages/web/mock/mock-hub.mjs      # http://localhost:9000, serves dist/
```

Env: `PORT` (9000), `MOCK_ADMIN` (admin user, default `admin`; users `admin` and `alice` exist), `MOCK_DISK=ok|warn|block`,
`MOCK_ROOT` (workspace root), `MOCK_REMOTE=off`, `MOCK_DIST`,
`MOCK_REPLAY_CAP` (newest messages per WS replay before it is flagged `truncated`, default 1000),
`MOCK_NO_PROJECT_ID=1` (omit `Session.projectId`: the UI must derive the project from the cwd),
`MOCK_NO_PROJECTS=1` (501 on `/api/projects*` and `/api/skills*`: the "Not available yet" states),
`MOCK_NO_MODEL_FLAGS=1` (an older hub: no `family` / `legacy` on models),
`MOCK_NO_RELEASES=1` (the `/download` page lists no release), `MOCK_README_ASSISTANT=off|forbidden|error` (the docs assistant's states),
`MOCK_TAILSCALE="login|node"` with `MOCK_TAILSCALE_USERS="a,b"` (a Tailscale-identified caller and the names bound to other logins),
`MOCK_API=off|low|used` (API credits: default is a key with $12.00 of $100 spent, the period resetting on the 1st; `off` = `Me.apiAvailable=false`, `UsageLimits.api=null`, creating or sending answers 503 `api_unavailable`;
`low` = nearly used up; `used` = used up, so a send answers 429 `api_limit_reached`), `MOCK_RELEVANT_DELAY_MS` (delay of `GET /api/search/relevant`, default 450), `MOCK_HOSTNAME` (`GET /api/health` `hostname`, default `workstation-mock`; `MOCK_NO_HOSTNAME=1` omits it, like an older hub).
Magic words in a message drive the simulation: `tool`/`bash` (Bash tool call), `edit` (permission request for an Edit, answer over
the WS; the edit becomes a pending change of the `demo-app` project touched by that session), `create a file <name> containing <text>`
(Write permission request; Allow writes the file), `@path` mentions are answered with the file's content, `think`, `markdown`,
`long`, `limit` (rate-limit error + notice), `queue me` (202 queued), `#429` (weekly limit),
`background` (Code: a background shell command and a subagent start; stop them via `POST /api/sessions/:id/tasks/:taskId/stop`),
`search chats <query>` / `read chat <session id>` (the read-only history tools `mcp__workstation-history__search_conversations` / `read_conversation`; not in incognito chats).
`POST /__mock/seed-session {user, title, kind?, model?, incognito?, ageMinutes?, messages}` creates a
session with a ready-made history (search and history-tool demos); `POST /__mock/api {spentUsd}` sets this period's API spend. Incognito sessions are never listed or searched and
are deleted with `DELETE /api/sessions/:id`; `GET /api/search` (keyword, `«…»` snippets, newest first) and `GET /api/search/relevant` (word overlap standing in for the ranking; 503 `api_unavailable`) are implemented.

The mock implements the full project, review and skills surface: every user gets projects `demo-app` (3 pending files, 3 undownloaded, a binary file)
and `notes` with history entries of all four kinds; review diffs carry a `diffId` and hunk actions are refused with 400 without it and
409 `stale_diff` when it no longer matches; `restore` writes a trash entry; `DELETE /api/projects/:id` answers 409
`project_not_empty` unless `discardRemaining`; `/api/skills` has user and global scopes (global writes need an admin) and skills
appear in `/api/commands`. Test hooks (no auth, mock only): `POST /__mock/emit {user, event}` pushes any `ServerEvent` (e.g. a
`sync_conflict`), `POST /__mock/seed {user, sessionId, count}` appends filler messages (long history / truncated replay).

## Source layout

```
src/
  main.tsx, App.tsx          router, theme, RequireUser (owns the hub connection for the signed-in user)
  i18n.ts                    every UI string, `t(key, vars)` (sections per feature area)
  index.css                  design tokens (warm light / true dark), prose styles, third-party theming
  lib/                       framework-free logic (all unit-tested)
    api.ts                   fetch client (X-Workstation-User, ApiError, typed endpoints, downloads, upload chunk call)
    ws.ts                    HubSocket: hello/welcome, subscribe+lastSeq, backoff reconnect, ping watchdog, zod safeParse
    session-reducer.ts       pure reducer for one session (replay → snapshot → live), permissions, optimistic user bubbles
    transcript.ts            buildTranscript(messages) → render model; delta folding (foldDelta / reconcilePartial)
    sdk.ts, toolSummary.ts, lineDiff.ts   tolerant views over raw SDK payloads, tool icons/summaries, unified diff rows
    upload.ts, uploadToasts.ts            4 MB chunker with retry/resume, toast-driven batches
    projects.ts              session → project (`Session.projectId`, else the `projects/<name>` cwd), short commit
    history.ts               group a project's history by kind, validate "Restore file…" paths
    skills.ts, zip.ts        skill names/template/frontmatter; a minimal zip reader (SKILL.md of an uploaded archive)
    theme.ts                 applyRootTheme (data-theme without color fades), isDarkScheme
    commands.ts              cached `/api/commands` (invalidated when skills change), downloadToasts.ts
    models.ts                family / version of a model, legacy split (top level vs "More models"), effort + mode per model
    slash.ts, fuzzy.ts, groups.ts, format.ts, highlight.ts, clipboard.ts, storage.ts
  store/                     zustand stores
    app.ts                   user, me, mode, panels, theme, usage limits, disk, notices, send block
    sessions.ts              session list + one SessionView per open session
    hub.ts                   WebSocket ↔ stores glue (delta batching per frame, backfill, event taps)
    actions.ts               send/stop/create/rename/delete/patchSettings (optimistic, error-code aware)
    projects.ts              the user's projects (`GET /api/projects`; 404/501 → status "unavailable"), live via `review_changed`
    review.ts                per-project review version (bumped by `review_changed`) and `sync_conflict`s per file
    composer.ts, changed.ts, toasts.ts
  components/
    ui/                      Button, Banner, Progress, Modal, Menu, Tabs, Tooltip, Toaster, Skeleton …
    shell/                   Sidebar, TopBar (mode toggle), RightPanel, Banners, DiskModal, CommandPalette, PageShell
    transcript/              Transcript, Items (bubbles, result rows, notices), ToolCard, PermissionCard, DiffView, Markdown, CodeBlock
    composer/                Composer, Pickers (model menu with Effort and More models submenus, mode, effort chip), Palettes (slash, @), mentions
    overview/                Overview tab (first tab; Chat and Code): collapsible Environment, Context, Outputs and Background tasks cards
    files/                   Files tab (lazy tree, preview, upload, mkdir, delete, "changed this session")
    changes/                 Changes tab (ProjectReview: review list + DiffEmbed behind it) and History tab (ProjectHistory), shared with /projects/:id
    projects/                DeleteProjectDialog (two steps) and its pure gate (deleteState)
    skills/                  MarkdownEditor (CodeMirror 6, snapshot undo, ⌘S)
    terminal/                Terminal tab + TerminalView (xterm, reconnect, tmux reattach)
    usage/                   UsageView (reusable; the API-credits card), LimitBar, MyTokens
    admin/                   AdminDashboard, UsersTable (inline edit), GlobalSettings, charts
    diff/                    DiffViewer (CodeMirror unified/split with per-chunk accept/reject), DiffHeader
  pages/                     PickUserPage, Workbench (route `/` and `/s/:id`), UsagePage, AdminPage, ProjectsPage, ProjectReviewPage,
                             SkillsPage, SkillEditorPage
  embed/                     embed entry for host WKWebViews (see below)
e2e/                         Playwright specs
mock/                        mock hub + diff harness
```

Routes: `/login`, `/download`, `/readme/*`, `/` (new session), `/s/:sessionId`, `/usage` (`?embed=1` hides the back button), `/admin` (admins only; the guard
reads `Me.user.isAdmin`), `/memory`, `/instructions`, `/browser-sites`, `/projects` (table + delete), `/projects/:id` (review + history of one project, reached from the Projects
page, the disk modal and the sidebar's pending badge), `/skills` (list, create, upload, delete) and `/skills/:scope/:name` (editor).

### Changes, History, Projects, Skills

- **Which project?** `Session.projectId` when the hub sends it, otherwise the session's cwd (`projects/<name>[/...]`) is matched against
  `GET /api/projects` names (`lib/projects.ts`). A session outside every project (cwd `""`, `docs`, …) has none.
- **Changes tab** (right panel, Code mode): `GET /review` rows with an A/M/D/R/T badge, +/- counts, size, a `binary` flag and
  `lastTouchedBy` as "this session" / "other"; the "This session" switch filters on it; the list refetches on `review_changed`.
  A row opens the per-file diff (`DiffEmbed`, the same component the embed entry uses): unified or side-by-side (remembered),
  per-hunk Accept/Reject, file-level Accept/Reject, and "Accept all" in the list header. Hunk actions send the `diffId` of the diff
  they were computed from; **409 `stale_diff`** reloads the diff and shows a notice. `sync_conflict` events show an alert on the file's
  row and above its diff until the file is accepted/rejected or the alert is dismissed. Files whose diff has no `oldText`/`newText`
  (too large) fall back to a raw hunk list with the same per-hunk buttons. Quick reject on a row asks first.
  Without a project the tab says there is no linked project and offers "Download this session's
  files" (the files the live `file_event`s attribute to the session, as a zip) plus "Show in Files" (the Files tab's "changed" filter).
- **History tab**: `GET /history` grouped sync / snapshot / accept / trash (newest first, time, message, turn, short ref).
  "Restore file…" (asks for a project-relative path) and "Restore all" both confirm and state what is overwritten and that the hub
  writes a trash snapshot first (`POST /restore {ref, path?}`); the review and history refetch afterwards.
- **Projects page**: name, size, pending (from the project), not downloaded (from `DiskStatus.projects[]`), local commit, age; Review,
  Download zip (`/files/download?path=projects/<name>`), Delete. Delete is two steps: step 1 re-reads the counts and offers no plain
  "continue" while anything exists only on the server (review first, or "Discard and delete…"); step 2 needs the exact project name
  and, when counts are non-zero, the "discard remaining changes" box, which becomes `discardRemaining: true`. A 409 `project_not_empty`
  sends the user back to step 1 with fresh counts. Folders are linked in the macOS app; the page says so.
- **Skills page**: user and global skills; create (name `[a-z0-9-]`, SKILL.md template with frontmatter), edit in a CodeMirror
  markdown editor (⌘S saves), delete with confirmation, upload `.md` or `.zip`. A zip is read in the browser (stored + deflate):
  only its SKILL.md is imported, because `SkillBody` carries a single text file; other entries are skipped and the user is told.
  Global skills are read-only unless `me.user.isAdmin`. Every change invalidates the cached `/` palette commands.
- **Sidebar**: a top list (New ⌘N, Search ⌘K, Projects), then the session list
  (Code sessions grouped by project name from `projectId`/cwd, with a pending-count badge linking to the review, everything else under "Workspace"),
  then the footer (Usage, Admin for admins, the settings gear with notifications, Session defaults…, Instructions…, Memory…, Skills…, Browser sites…, Docs, Switch user). Incognito chats are never listed.
- **Search** (⌘K or the sidebar item; the command palette is ⌘⇧P): one input and two result columns side by side (stacked below 640px):
  "Keyword" (`GET /api/search`, live with a 150 ms debounce, newest first, `«…»` as `<mark>`) and "Relevant" (`GET /api/search/relevant`, asked 600 ms after typing
  stops, cached per query in the client, skeleton while waiting, one `reason` line per hit, one muted line without API credits). Arrow keys walk the
  left list and then the right one, Enter opens, Esc closes.
- **Incognito** (Chat): the ghost toggle on a new chat creates the session with `incognito: true`; the view gets an "Incognito" chip and a violet-grey tint.
  The client deletes the session when it is left (new chat, another session or page, `useIncognitoSession` + `store/incognito.ts`) and on `pagehide` with a
  keepalive `DELETE` (`sendBeacon` cannot: it only POSTs and carries no `X-Workstation-User`).
- **API credits** (every turn is billed to the server's API key): the "API credits used up this month." composer block (`api_limit_reached`, with Retry), a "No API credits are
  available" block while `Me.apiAvailable` is false (Retry re-reads the account), a toast for `api_unavailable`, the API-credits card on the Usage page, the context ring's popover and
  red dot (from 80 % of the budget), the sidebar dot (from the budget's severity), and an "API credits" section on the admin page (monthly limit, reset day 1–28, service reserve).
- **Math**: LaTeX in assistant Markdown and user bubbles via KaTeX (bundled, no CDN): `$…$`, `\(…\)`, `$$…$$`, `\[…\]`. Currency is not math (`lib/math.ts`: no space after the
  opening or before the closing `$`, no digit after the closing one); code is never touched; copying a selection with formulas puts the TeX source on the clipboard
  (`lib/mathCopy.ts`), and the message Copy buttons copy the raw text.
- **Agent names**: copy that talks about the session's agent ("Claude wants to use Bash") uses `lib/agent.ts`.
- **Degradation**: `GET /api/projects`, `/review`, `/history` and `/api/skills` answering 404/501 render "Not available yet" instead of
  an error, so a hub without these routes never breaks the app.

## State model

Everything about a conversation lives in one **`SessionView`** per session (`store/sessions.ts`, reduced by the pure
`reduceSessionEvent` in `lib/session-reducer.ts`):

- `messages: StoredMessage[]` sorted by `seq`, unique by `seq` (first writer wins: persisted messages are immutable);
  `lastSeq` = highest seq held.
- `partial` = in-flight assistant content folded from `delta` events (ordered blocks: text / thinking / tool_use with partial JSON).
  Persisted assistant messages are reconciled out of it block by block (`reconcilePartial`), `result`/`idle` clears it.
- `permissions[]` with status `pending | allowed | denied | cancelled | resolved`, `local` (what this tab answered) and `elsewhere`.
- `pendingUser[]` optimistic user bubbles keyed by the client UUID that the hub echoes (`sending | queued | failed`, retry/discard).
- `snapshotReceived`, `backfillAfter` (see below), `truncated` / `loadingEarlier` (a truncated replay and the
  "Load earlier messages" request, see below).

The transcript is **derived**: `buildTranscript(messages)` pairs `tool_use` blocks with the `tool_result` of the following user
message, merges consecutive assistant messages into one flow, nests sub-agent messages (`parent_tool_use_id`) under their Task
tool, and turns `result`, `compact_boundary`, `reset`, hub system messages (`hub_process_died`, `hub_stop_timeout`,
`hub_cancelled`) and slash-command echoes into rows. Nothing else is stored.

Global state (`store/app.ts`): signed-in user, `Me`, Chat/Code mode (persisted, plus the last session per mode), panel
state, theme, `UsageLimits` (live via `usage_limits`), `DiskStatus` (live via `disk_status`), banners from `notice` events, and
`sendBlock` (the 403/429/503/507 reason of the last rejected send).

Sending (`store/actions.ts`): the draft is cleared, an optimistic bubble is added, `POST /messages` runs with a client UUID. Hard
rejections (`remote_disabled`, `user_disabled`, `weekly_limit`, `api_limit_reached`, `disk_block`) remove the bubble, restore the draft and
disable the composer with an explanation; other failures leave a failed bubble with Retry. A `202 queued` response shows the queue
position. If the persisted echo does not arrive within 4 s the list is backfilled over REST.

New sessions are created lazily on the first send (no empty sessions pile up; the server never deletes anything on its own).

## WebSocket handling

One connection per signed-in user (`lib/ws.ts`, wired in `store/hub.ts`):

1. open → `hello {user, protocolVersion}` → wait for `welcome`.
2. For every desired session send `subscribe {sessionId, lastSeq}`; `lastSeq` is read from the store, so a reconnect only
   replays what was missed. The desired set (`subscribeSession`) survives reconnects and component effect ordering.
3. Hub order is `replay` → `snapshot` → live events. `subscribe_begin` marks the snapshot as pending again without dropping messages.
4. Incoming frames are `ServerEvent.safeParse`d; unknown/invalid events are dropped with `console.warn`.
5. Exponential backoff with jitter (0.5 s → 15 s), ping every 25 s with a 10 s pong watchdog, immediate reconnect when the tab
   becomes visible or the network comes back; a "Reconnected" toast and a session-list refresh follow.
6. Gap handling: if a live message skips seqs, or the snapshot reports a newer `lastSeq` than replay delivered, the store
   fills the hole with `GET /sessions/:id/messages?after=` pages (so a hub that caps replay still works).
7. `delta` events are buffered and applied once per animation frame (flushed before any ordered event).
8. A `replay` flagged `truncated` (the hub sends at most the newest 500 messages) marks the view; the transcript then shows
   "Load earlier messages" while a seq gap exists at its start. It pages backwards with `GET /messages?after=<oldest - 1 - 200>` (seq is
   gap-free per session), keeps the reading position, and hides itself once the range is exhausted.

## Terminal

`POST /api/terminals` creates a shell, `GET /api/terminals` restores existing ones as tabs after a reload, and
`WS /ws/terminal/:id?user=` streams `{t:'in'|'resize'}` / `{t:'out'|'exit'}` frames. Tabs reconnect with backoff and reattach to
the same terminal id (the hub keeps it in tmux). The hub redraws the tmux screen on every attach, so `TerminalSocket` calls `onAttach`
before the attachment's first output and `TerminalView` resets the xterm buffer there (otherwise a reconnect showed the screen twice).
⌘K clears and never reaches the app's search while the terminal has focus.

## Storage and disk banners

`disk_status` (and `GET /api/disk`) drive the UI. `warn` → persistent top banner + a dismissible modal on load listing the
breakdown and per-project unaccepted/undownloaded counts. `block` → red banner, composer disabled with the reason, uploads and
new folders disabled; viewing, downloading and deleting stay possible. The UI never offers automatic cleanup: it only points to
the Files tab where the user deletes things after seeing the size. The modal lists `DiskStatus.projects[]` with a link to each
project's review and one to the Projects page.

## Embed entry

Contract: [`docs/EMBED-BRIDGE.md`](../../docs/EMBED-BRIDGE.md). Implementation notes:

- **Entry**: `embed.html` → `src/embed/main.tsx` (second Vite input, `dist/embed.html`; or `npm run build:embed` for relative URLs).
- **Config**: `window.workstationEmbedConfig = { hubUrl, user, mode: 'transcript'|'diff'|'terminal', sessionId | projectId+path | terminalId, theme, platform }`
  injected by the host's `WKUserScript` at document start. For browser testing the same keys are read from the query string
  (`embed.html?user=alice&mode=transcript&sessionId=…`; `hubUrl` empty = same origin). Without config the page shows a
  "Not configured" state.
- **Own connection**: the page owns its REST + WebSocket connection (`setApiBase(hubUrl)`, `connectHub(user)`); no event forwarding
  from Swift. The hub refuses web origins it does not know (403 `cross_site`): load `embed.html` from the hub itself, or list the host's origin in `[server] allowed_origins`.
- **Modes**: `transcript` = message list + composer (textarea, `/` palette, `@` completion, image paste, Send; model/mode/effort
  pickers and Stop are hidden because the host's toolbar owns them); `diff` = `DiffEmbed` (CodeMirror merge view, per-hunk
  Accept/Reject call `POST /projects/:id/review/accept|reject`, the diff reloads on `review_changed`); `terminal` = one xterm.
- **Page → host** (`webkit.messageHandlers.workstation.postMessage`, `console.debug` fallback): `ready`, `state`, `settings`, `permission`,
  `permission_resolved`, `turn_done`, `open_file` (inline-code paths, diff header), `open_external` (links), `notice`, `title`.
  History replayed on connect is never reported as new (`useHostNotifier` primes itself from the first snapshot).
- **Host → page** (`window.workstationEmbed`): `setTheme`, `navigate`, `setUser`, `focusComposer`, `insertText`, `stop`, `applySettings`,
  `acceptHunks`, `acceptFile`, `rejectHunks`, `rejectFile`. All are synchronous no-ops when they do not apply.
- **Theme**: the host's `theme` (config or `setTheme('light'|'dark')`) sets `<html data-theme>` through `applyRootTheme` and every surface
  follows at once: components use the CSS tokens (composer, palettes, cards), CodeMirror gets its dark/light facet (diff viewer, skill
  editor), xterm re-themes from the tokens (MutationObserver) and `<html>` itself paints `--bg` (no white canvas around a transparent
  `<body>`). `applyRootTheme` disables transitions for ~120 ms around the change (`html[data-theme-switching]`), because a fade never
  completes in a webview that is not painting, and an inline script in `embed.html`/`index.html` sets the theme before the first paint.
  Without a theme the page follows `prefers-color-scheme`.
- The page sets the API user and base URL before the first render: diff mode fetches on mount and every request carries `X-Workstation-User`.
- Diff mode and the Changes tab share `DiffEmbed`: hunk actions carry the `diffId` and a 409 `stale_diff` reloads the diff.

## Internationalisation

All strings live in `src/i18n.ts` (`t('area.key', {vars})`). The default catalog is English, the only one shipped. `registerLocale(code, partial)` / `setLocale(code)` add languages; missing keys fall back to English.

## Testing

- **Unit/component (vitest, `npm test`)**: transcript rendering from SDK payloads (text, tool pairing, Edit diffs, result and
  error dividers, hub system messages), delta folding, session reducer (replay → snapshot → live ordering, dedupe by seq,
  gap/backfill, permissions elsewhere/cancelled), `HubSocket` (hello/welcome/subscribe, backoff, resubscribe with last seq,
  pong watchdog) against a fake WebSocket, slash palette filtering, upload chunker (retry/resume/skip), permission card flows,
  composer (Enter/Shift+Enter/IME, slash and @ palettes, disabled states), Files tab, Terminal tab, Usage and Admin pages,
  DiffViewer chunk mapping, embed bridge.
  Also covered: `DiffEmbed` (diffId, stale_diff, hunk-only fallback), `ProjectReview` (badges, counts, this-session filter, accept all,
  quick accept/reject, conflicts, detail/layout, refetch on `review_changed`, unavailable states), `ChangesTab` (project resolution,
  the no-project state and its download), `ProjectHistory` (grouping, both restore confirmations, errors), `DeleteProjectDialog` and its
  gate, `ProjectsPage`, `SkillsPage` + `SkillEditorPage` (validation, admin gating, create/upload md+zip/delete, editor save/⌘S/read-only),
  `DiskModal` links, the `loadEarlier` store action and the reducer's truncated-replay state, `TerminalSocket.onAttach` and
  `TerminalView` resetting the buffer, `applyRootTheme`, and the pure libs (`projects`, `history`, `skills`, `zip`, `groups`).
- **jsdom caveats**: Radix menus are exercised in the browser, not in jsdom; `src/test/setup.ts` polyfills Range
  geometry (CodeMirror) and `Blob.text()/arrayBuffer()`.

### E2E

```bash
npm run build -w packages/web
node packages/web/mock/mock-hub.mjs &                       # or a real hub serving dist/
E2E_BASE_URL=http://localhost:9000 npm run e2e -w packages/web

# the real server with an unreleased build: serve dist/ locally, proxy /api and /ws to the hub
VITE_HUB_URL=https://workstation.example-tailnet.ts.net npx vite preview --host 127.0.0.1 --port 4173 &
E2E_BASE_URL=http://127.0.0.1:4173 npm run e2e -w packages/web
```

Without `E2E_BASE_URL` all specs skip. Chromium comes from `npx playwright install chromium` (~190 MB, cached in
`~/Library/Caches/ms-playwright`). Every test uses a throwaway user named `e2e-<area>-<stamp>`; the hub has no delete-user route, so
on a shared server an admin can disable the leftovers by that prefix.

Specs that need a fixture the hub may not have skip themselves with a reason instead of failing:

| Spec | Covers | Runs on |
|---|---|---|
| `smoke`, `pages`, `panels` | login, chat/code/files/terminal, reload, `/usage` bars | mock and server |
| `chat` | "Reply with exactly PONG" → assistant text → result divider | both |
| `code` | default permission mode: permission card → Allow → file in Files; upload via the hidden input → `@inbox/…` → Claude reads it; `/` palette shows `/compact` | both |
| `overview` | Overview tab: machine / folder / model, context card after a turn, collapse remembered; background tasks listed and stopped, created file in Outputs → opens in Files (mock); Chat has the Overview only | both (tasks/outputs: mock) |
| `terminal` | prompt, `echo hi`; cutting the socket re-attaches without drawing the screen twice | both |
| `multi-tab` | two browser contexts on one session see the same stream (history, then a live turn) | both |
| `usage-admin` | the API-credits card; `/admin` denied for a regular user, visible for `admin` | both |
| `embed-theme` | embed `theme` via config and `setTheme()` on the composer, slash palette, canvas, terminal, diff viewer; saved dark theme before mount | both (diff part: mock) |
| `changes-live` | project created over REST, Claude edit in a project session → Changes (A badge, this session) → accept → History → Projects zip + delete | server (hub with project routes) |
| `changes`, `projects`, `earlier` | review list/diff/hunk accept/stale diff/conflict alert/accept all, history restore, sidebar grouping, Projects table and two-step delete, truncated replay + Load earlier | mock (needs its fixtures) |
| `skills` | create, edit + ⌘S, `/` palette, delete, `.md` upload, admin-only global; "Not available yet" on a hub without the routes | any hub with `/api/skills` |
| `sidebar-search` | sidebar top list and footer, the Search dialog (two columns, debounce timings, cache, keyboard, stacked on a phone, empty states) | mock (seed hook) |
| `incognito` | ghost toggle, chip and tint, hidden from sidebar and search, DELETE on new chat / switching / closing the tab / leaving the site, no memory chips | mock |
| `api-credits` | spend moves per turn, used-up block + Retry, usage page API card, admin API credits inputs | mock |
| `history-chips`, `math` | past-chat tool chips, KaTeX rendering / fonts from the bundle / selection copy / dark / embed | mock |
| `browser`, `browser-sites` | the server browser panel (frames, navigation, hidden = no frames) and the per-website question | server with `/api/browser`; sites: mock |
| `memory`, `models`, `turn-indicator` | the Memory page, the model menu, the live turn indicator | both |
| `message-actions`, `subagents` | per-message Copy / Rewind / Pin, the subagent batch card | mock |

## Assumptions about the hub

- List endpoints return bare arrays (`asList` also accepts `{users: [...]}` style envelopes); `GET /api/me` answers 401/403/404 for
  an unknown user (the UI then returns to `/login`).
- `X-Upload-Path` is sent verbatim for plain ASCII paths and percent-encoded for non-ASCII characters and `%` (header values must be Latin-1).
- Terminal and main WebSockets identify the user via `?user=` (`USER_QUERY_PARAM`).
- `GET /api/files/tree` returns a flat list; the `@` completion index asks for `depth=3` and works with whatever it gets.
- `permission_request.toolUseId` is present for tool calls so the card renders under its tool card; without it the card falls back
  to arrival order.
- Review and history paths (`ReviewFile.path`, `AcceptBody.path`, `RestoreBody.path`, `/raw?path=`, `/review/diff?path=`) are relative to the
  project root, not the workspace (`src/app.ts`, not `projects/demo/src/app.ts`).
- Hunk-level accept/reject needs the `diffId` of the `FileDiff` the indices came from (the hub answers 400 `invalid_request` without it);
  a file that is no longer in the review may answer 404 on `/review/diff` (the UI then shows "No changes").
- Skills are addressed by `?scope=user|global` on `GET`/`DELETE /api/skills/:name` (the protocol has no other way to tell a user and a
  global skill of the same name apart); `PUT` sends the scope in the body.
- Seq numbers are gap-free per session (`Load earlier messages` pages backwards with `?after=`).

## Known gaps

- Skill archives: only SKILL.md is imported from a `.zip` (the hub's `SkillBody` is a single text file); other files in the archive are
  skipped with a notice.
- Binary files in a review are not previewed (the diff view says so); the detail bar offers the working-tree bytes as a download.
- A session that reconnects after the hub truncated its replay can have a hole in the middle of the transcript; "Load earlier messages"
  then sits at the top and pages backwards through the hole.
- The `e2e` suite leaves `e2e-*` users behind on a real server (no delete-user route).
- Long transcripts are not virtualised (markdown is memoised per message, which has been enough for a few hundred rows).
- ⌘N is reserved by browsers (new window) and only works inside the macOS app; the sidebar button and ⌘K "New session" always work.
