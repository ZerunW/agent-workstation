# Changelog

## 0.1.0 (initial release)

- **Chat:** conversations with Claude with attachments (images, PDFs, files), web search and page reading, a sandboxed
  folder per chat for running code, checked downloads, memory across chats, lookup of past conversations, interactive
  visuals (SVG, HTML widgets, mermaid) and incognito chats.
- **Code:** a coding agent confined to one folder, with a streaming transcript, permission cards and five permission
  modes, model and effort pickers, `/` commands and skills, subagents, heads-up cards, a task list, end-of-turn recaps,
  rewind and fork, `@` file mentions and a command sandbox with network filtering. Commands that send data out always ask.
- **Side panel:** Overview, Files, Changes, History, Terminal (shells kept alive in tmux), Browser and Sync.
- **Server browser:** a per-user headless Chromium that keeps logins, with a live view you can drive, allowed per website
  for the agent.
- **Folder sync and review (macOS app):** link a folder, choose what syncs in a selection window, large-file support
  (chunked, resumable), cloud-only file handling, accept or reject the agent's changes per file, per hunk or all,
  snapshots per turn, restore from History, backups before every overwrite. Nothing is written to your Mac without your
  decision.
- **macOS app:** the web UI in a native window with notifications, downloads, folder sync and signed update checks.
- **Anthropic API key only:** every Claude process is paid by one API key through the hub's loopback key proxy and
  metered per request against a monthly budget, with a reserve for the hub's own helper calls (the docs assistant
  on Claude Sonnet; search ranking, session summaries, download check and the daily price check on Claude Haiku).
- **Tailscale access:** no passwords; identity comes from the caller's Tailscale login, usernames bind to the first login
  that uses them, admins are listed in the config. nginx serves HTTPS on the Tailscale address only.
- **Admin and usage:** a pause switch for remote AI use, weekly token limits, model allowlists, per-user terminal access,
  disk guard (warning at 80 %, read-only at 95 %, nothing deleted automatically), usage page and price table.
- **Status page:** metrics, health checks, API credits and timelines at `/status/`.
- **Privacy:** no analytics or tracking; agent processes (with `[agents] run_as`) run with Claude Code's telemetry and
  error reporting off; credential-shaped text in a failed process's error output is masked before it is logged;
  [PRIVACY.md](PRIVACY.md) lists what leaves the server, what stays on it and what the logs hold.
- **Install:** `deploy/install.sh` sets up any Debian or Ubuntu server (arm64 or x86-64): Node 22, the service and agent
  accounts, the root-owned agent wrapper, systemd units, the agent firewall, Claude Code (root-owned), the server
  browser and nginx on the Tailscale address (proxying to the hub's sockets, started once the Tailscale address exists
  through a systemd drop-in). `deploy/deploy.sh` ships a build from a development machine.
- **Cross-site requests:** the hub refuses (403 `cross_site`) requests and WebSocket upgrades from other web sites
  (`Origin` not allowed or `Sec-Fetch-Site: cross-site`); `[server] allowed_origins` adds origins. The macOS app and
  curl are unaffected. A cross-site navigation counts as a page view only for web pages, decided on the decoded path.
  The status page's API refuses cross-site requests the same way and asks the hub only as `[status] hub_user`.
- **Host check:** the hub refuses (421 `bad_host`) a `Host` that is not the server's own name or address (DNS rebinding),
  and nginx answers other names with 444 (`/api/health` stays open).
- **The hub is closed to the agent account by file permissions:** in production the hub and the status service have no TCP
  port. The hub listens on a public Unix socket (mode 0660, group `workstation-proxy`, only nginx connects) and a local
  socket (mode 0600, the service account's, the status service connects); the agent account is in neither group and gets
  `EACCES`. A request's trust level is the socket it arrived on, never a header: on the public socket exactly one
  `X-Forwarded-For` IP is required (else 400 `proxy_header_invalid`, WebSocket upgrades included; health answers without
  it), the server's own addresses are refused (403 `self_caller`), and the local socket takes none. Sockets are created
  with a umask that gives their final mode and removed on shutdown; `[server] listen = "tcp"` is the development escape,
  refused at start in production while `[agents] run_as` is set. The agent firewall stays as defense in depth, and the hub
  tells admins when its unit is not active (`agent_firewall_inactive`).
- **Baseline uploads** have limits: compressed size (4 GiB), extracted size (8 GiB), entries (200 000) and time (30
  minutes), all configurable in `[baseline]`; over a limit the upload answers 413 or 408 and leaves nothing behind. The
  archive's tar headers are read the way GNU tar reads them (sparse, multi-volume and unknown entry types and damaged
  headers answer 400 `baseline_unsupported_entry`) and the scratch folder's real size is watched while it is extracted.
- **Visual libraries:** a file over 8 MB stops downloading as soon as it passes the limit, and redirects are followed by
  hand (at most 3, each only to https on the same CDN host; anything else is a 502 and is never requested).
- **Install:** `nginx-tailscale.sh` stops when no HTTPS certificate can be issued (`--insecure-http` allows plain HTTP),
  moves nginx's stock default site aside instead of deleting it (asks when it was modified), and the install guide's
  uninstall section covers every change the scripts make.
- **Docs:** the README states that Agent Workstation is for personal use and lists the third-party software
  it integrates; CI scans for committed secrets.
- **Closed by default:** the hub and the status page have no TCP port, Tailscale identity is on, the local network is
  refused (`lan_access = "deny"`, open routes included) and no username is an admin by default. The hub refuses to start
  while `tailscale_identity` is on and `admin_logins` is empty. `install.sh` writes the configuration and stops before
  the first start until the admin login and the API key are set (or `--start` is given); `deploy.sh` prepares a minimal
  server first and does not restart a server that is not configured yet. The install guide configures before it
  starts.
- **Agent firewall:** `iptables` is installed with the packages, the install fails when the rule cannot be applied, the
  blocked ports follow `[server] port` and `[status] port`, and the hub warns at start when the firewall unit is not
  active (and when `run_as` is empty in production).
- **Between users:** new non-admin users start with the terminal off. The docs say plainly that all users' agents and
  terminals share one account and can read each other's workspaces. It is for personal use.
- **Key proxy:** Claude processes are refused (429) once the monthly budget is used up, and requests for a model outside
  the user's allowlist are refused (403).
- **Helper calls:** the Haiku helpers send no thinking and low effort, with room for their answers; the unavailable reasons
  tell "credits exhausted" from "budget used up", and a rejected API key is reported as such.
- **Project settings files** (`.claude/settings.json`, `.mcp.json`) are not read in code sessions unless
  `[sessions] project_settings = true`: no hooks, `env`, helper commands, permission or sandbox additions or MCP servers
  from a project. The hub passes the project's `CLAUDE.md` and `.claude/CLAUDE.md` in the system prompt (`@path` imports
  confined to the working directory) and its skills, commands and agents as a plugin (`/project:<name>`; your own and
  the global skills are `/workstation:<name>`). The plugins are published in `/var/lib/agent-workstation-plugins`
  (`[paths] agent_plugins_dir`), which the agent account can read but not write, and the agent wrapper loads a plugin only
  from there and only while nothing on its path is writable by the agent.
- **Docs assistant:** needs a signed-in user and uses Claude Sonnet. `/api/usage/limits` needs a user too (the status
  service sends `[status] hub_user`, default `status`).
- **Visual libraries cache:** holds at most 200 MB or 500 files and evicts the least recently used when full; at most four
  libraries download from the CDNs at once.
- **Install:** Claude Code is installed root-owned in `/opt/agent-workstation/claude` (the agent account runs it but cannot
  change it) and pinned to the version the Agent SDK bundles (`CLAUDE_CODE_VERSION` overrides it); the Node download is
  checked against nodejs.org's SHASUMS256.txt.
- **Key proxy:** the request body forwarded to the API is the one whose `model` was checked.
- **Uninstall:** the guide stops the service and agent accounts' processes before deleting the accounts, removes the
  sandboxes' temp folders and removes the nginx drop-in and the `workstation-proxy` group.
