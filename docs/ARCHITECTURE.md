# Architecture

Agent Workstation is one Linux server running the hub, the status service and nginx, reached from a web UI and a macOS app
over Tailscale. The server is never exposed to the internet: Tailscale decides which devices can connect and which login
they are.

## Processes on the server

| Process | Listens on | Role |
|---|---|---|
| `workstation-hub` (`packages/hub`) | `/run/agent-workstation/hub.sock` (nginx), `hub-local.sock` (status service) | REST + WebSocket API, serves the web UI, runs Claude Agent SDK sessions, files, terminal, the API key proxy, admin, disk guard, project sync and git review. |
| `workstation-status` (`packages/status`) | `/run/agent-workstation/status.sock` | Metrics collector (10 s), health checks (60 s), bandwidth probe, SSE stream, status page. Reads the API credits from the hub. |
| nginx | 443 | TLS termination and routing (`/status/` → the status socket, everything else → the hub socket). Bound to the Tailscale address only. |
| tailscaled | n/a | Tailscale: the private network the server is reached over. |

Both Node services run as the unprivileged `workstation` user under systemd. Agent processes (Claude Code, terminal
shells) run as the separate `workstation-agent` account through the root-owned wrapper `workstation-agent-exec`
([SECURITY.md](SECURITY.md)). All per-user data lives under `<users_root>/<username>/`:

```
/srv/agent-workstation/users/<user>/
├── inbox/            drag-and-drop uploads
├── projects/<name>/  working copy of a synced folder (Claude's cwd)
├── .sync/<name>.git  bare review repository for that project (outside the cwd on purpose)
├── .chat/<id>/       each chat's own folder (sandboxed commands, downloads/)
└── .claude/skills/   the user's skills (SKILL.md per skill)
```

Mutable hub state (SQLite, upload temp files) is in `/var/lib/agent-workstation`.

## Identity

There are no passwords. A client sends `X-Workstation-User: <name>` on every request and in the
WebSocket `hello`. The name selects a workspace. Who sent it is decided by the listener the request came in on, never by a
header: the public socket (nginx, with the client address in `X-Forwarded-For`) or the local socket (the status service).
With Tailscale identity on, the hub resolves the caller's
Tailscale login with `tailscale whois` and binds each name to the first login that uses it; admin rights come
from `auth.admin_logins` (`auth.admin_usernames` without Tailscale identity). Reachability (who can connect at all) is enforced by the
network: in a tailnet install nginx listens only on the Tailscale address, the hub and the status service have no TCP port (they listen on Unix
sockets that only nginx and the service account can open, [SECURITY.md](SECURITY.md#the-hubs-sockets)), and an optional
firewall closes the other interfaces ([INSTALL.md](INSTALL.md)).

## Session service

A **session** is a SQLite row (`sessions`) plus its ordered `messages`. The Claude Code
process behind it is a disposable cache:

```
first message ──► spawn query({ resume: claude_session_id, ... })  (streaming-input mode)
                  ├─ live changes: setModel(), setPermissionMode(), applyFlagSettings({ effortLevel })
                  ├─ stream_event partials → folded into an in-memory "partial", broadcast as deltas
                  ├─ user/assistant/result/system messages → persisted with a monotonic seq
                  └─ idle 10 min, or pool full (max_active_processes / MemAvailable gate) ──► close()
next message  ──► spawn again with resume; reconcile missing messages via getSessionMessages()
```

Clients reconnect with `subscribe{sessionId,lastSeq}` and receive `replay` (persisted
messages after `lastSeq`), then a `snapshot` (session row, in-flight partial, pending
permission request), then live events. Permission prompts are held by the hub, not the
tab: closing the browser does not answer them; the first answer from any tab wins; a
timeout denies with `interrupt: true` so the turn stops instead of continuing unsupervised.

Chat mode uses the same machinery with a plain assistant system prompt and a small tool set (web search and page
reading, `Read` for attached files, and sandboxed commands and file tools in the chat's own folder). Every call outside
that set is refused without a permission card. Code sessions read no project settings files (`settingSources: []`)
unless `[sessions] project_settings` is on.

## Usage accounting

Each `result` message carries `modelUsage` keyed by model. After a `resume` the numbers are
session totals, so the hub stores the last cumulative value per session and persists the
delta into `turns`. These are usage figures only. API credits are counted from the requests the hub's key proxy meters (`api_requests`), and
from the hub's own Messages API calls (relevance search, summaries, the download check, the price check), each priced with
the hub's price table; that sum against the monthly budget is the API-credit figure everywhere.

## Folder sync and review (macOS app)

The server holds a bare git repository per project **outside** the working directory
(`.sync/<name>.git`, driven with `--git-dir/--work-tree`), so Claude never sees a `.git`
in its cwd and cannot disturb the review branch.

- What is in the repository: everything the Mac synced except `.git` and the paths the person unchecked in the
  selection window. The Mac sends those paths after confirming the window, on every decision change and at app start
  (`PUT /api/projects/:id/excludes`); the server adds no default excludes and reads no in-tree `.gitignore`, so files the
  agent creates in an unchecked folder stay out of review. Files over 100 MB are "large files": chunked resumable
  uploads, a pointer in the review git, content in a per-project store on the server.
- Branch `local` = exactly what the Mac has. Every push from the Mac commits to it
  (batched per quiet window). Pushes carry the `baseHash` the Mac last saw; if the
  working tree moved since, the hub does a three-way merge and only asks on a real
  conflict.
- The working tree = Claude's current edits. The review panel is always recomputed
  from `git status` + `git diff local` (never from event semantics).
- Accept (file / hunks / all) is computed **on the server**: `new_local = local ⊕ selected
  hunks` is committed to `local` and the resulting content is returned for the app to
  write locally with echo suppression. The working tree is untouched, so unselected hunks
  remain pending. Reject = `checkout local -- path` (or `git apply -R` for hunks).
- Every turn end writes a snapshot ref; every destructive operation writes a trash ref
  first. Nothing Claude did is lost until the user deletes the project copy.

## Status service

Collectors read `/proc` and `/sys` directly (no agents). Raw 10 s samples are kept 48 h,
1-minute rollups 90 days, hourly rollups forever. Health checks record state
transitions as events. The page is a small Vite/uPlot app served by the same process.

## macOS app

A SwiftUI shell around a WKWebView that shows the hub's full web UI (`<hub>/`), plus what needs native code: folder
sync (FSEvents watcher, selection window, a sandboxed writer service), review and history windows, notifications,
downloads and update checks. The shell observes the page through a small injected script and keeps its own WebSocket
to the hub for notifications and sync; the web app knows nothing about the shell ([MAC-APP.md](MAC-APP.md),
`apps/mac/README.md`).
