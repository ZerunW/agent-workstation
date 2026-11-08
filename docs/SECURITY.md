# Security model

## Threat model

Agent Workstation is a **personal** system: one person, their own server, their own devices. It is not built to be shared
and is not a multi-tenant service (see [Limits between users](#limits-between-users)). It runs AI agents that execute code, so the design assumes an agent can be misled
(prompt injection from web pages, files or downloads) and limits what any agent process can reach. Security rests on
three layers: who can reach the server at all, who a caller is, and what an agent process may do.

## Reachability

- The server needs no public address and no inbound port from the internet.
- nginx listens only on the server's Tailscale address; the hub and status services have no TCP port in production, they
  listen on Unix sockets that only nginx (and the service account) can open, see [The hub's sockets](#the-hubs-sockets).
  The server's `<name>.<tailnet>.ts.net` name resolves to the `100.x` Tailscale address, unroutable from the internet.
- nftables (optional, `deploy/nftables.conf`): inbound traffic is allowed from Tailscale, plus SSH from an admin network;
  everything else is dropped (ICMP, DHCP replies and established flows aside). `lan_access = "deny"` makes the hub refuse
  LAN callers outright.
- SSH can be made key-only with root login off (`deploy/sshd-hardening.conf`).
- Sharing the server with another tailnet does not share your LAN (shared machines do not carry subnet routes).

## Identity without passwords

With `auth.tailscale_identity = true` (recommended) the hub asks `tailscale whois` who the caller's device
belongs to. A username is bound to the first Tailscale login that uses it; another login gets `user_bound`, so a
header cannot impersonate someone else's name. Devices without a personal login (tagged devices) are refused. Admin
rights come from the Tailscale logins in `auth.admin_logins`. Login screens never list other people's names, and
`GET /api/users` is admin-only.

Without Tailscale identity (development, or a trusted LAN) the hub trusts the `X-Workstation-User` header and admin comes
from `auth.admin_usernames`; anyone who can reach the hub can then pick any name.

## Requests from other web sites

The hub knows who is calling from the caller's Tailscale device, not from a cookie. Without a further check, any web
page open in a browser on a tailnet device could make requests, or open a WebSocket, that the hub attributes to that
device's login. The hub therefore refuses (`403 cross_site`) every request, WebSocket upgrades (`/ws`, terminals, the
live browser view) included, that carries an `Origin` that is not allowed or `Sec-Fetch-Site: cross-site`. Allowed origins
are `[server] public_url`, `https://<the server's Tailscale name>`, `http(s)://<its Tailscale address>`, the hub's own
loopback address and port, and `[server] allowed_origins`. Browsers always send these headers on WebSocket upgrades and on
requests with a body, and send `Sec-Fetch-Site` on every request, and a page cannot remove them. Native clients (the macOS
app's networking, curl) send neither and are not affected. Two narrow exceptions: a cross-site top-level navigation to a
web page (following a link to the server) is allowed because it only shows the page (decided on the decoded, normalized
path and the matched route, so `/%61pi/...` or `//api/...` is still an API request), and the visual libraries route
`/api/visual-cdn/` (public files, no identity) is not checked because sandboxed frames load it as a script.

Plain HTTP (`--insecure-http`) and older Safari send no `Sec-Fetch-*` headers, so on those the check rests on `Origin`
alone. That is one reason for the **Host check**: a page can point its own DNS name at the server's Tailscale address
and then call the hub as "same-origin" (DNS rebinding). The hub refuses (`421 bad_host`) a request whose `Host` is not
`[server] public_url`'s host, a host of `[server] allowed_origins`, the server's Tailscale name or addresses, a loopback
name or address, or, with `lan_access` not `"deny"`, one of the machine's own addresses. Ports are not compared.
`/api/health` and `/healthz` stay open. nginx (`deploy/nginx-tailscale.sh`) enforces the same one step earlier: its
`server_name` is the `.ts.net` name (and the address), and a default server on ports 80 and 443 closes the connection
(444) for any other name.

The status page's API (`/status/api/*`) refuses cross-site requests the same way (`403 cross_site`; allowed origins are
`public_url`, the Tailscale name and addresses, and loopback), and the status service asks the hub only as the configured
`[status] hub_user`, never as a name a caller sends.

## The hub's sockets

The boundary is structural, not a guess about who is calling: the listener the users' requests arrive on cannot be
reached by the agent account at all, and the kernel enforces that with file permissions. Identity only has to classify callers that came through nginx. The same rules are at the top of
`packages/hub/src/identity.ts`.

1. **In production the hub has no TCP listener for the user API.** It listens on two Unix sockets in
   `/run/agent-workstation` (a tmpfiles.d entry, mode 0755, owned by the service account):
   - the **public socket** `hub.sock`: mode 0660, group `workstation-proxy` (members: nginx's worker account, normally
     `www-data`, and the service account, which owns the file). Only nginx connects here.
   - the **local socket** `hub-local.sock`: mode 0600, owned by the service account. Only that account (the status service
     runs as it) and root can connect.
   The agent account is in neither group and owns nothing in that directory, so `connect()` fails with `EACCES`. The
   install fails if the agent account is in `workstation-proxy`.
2. **Trust comes from which socket a request arrived on, never from its headers.**
   - Public socket: the request must carry exactly one `X-Forwarded-For` value that is an IP address (nginx sets it to
     `$remote_addr`). Missing, repeated, comma-separated or unparsable: `400 proxy_header_invalid`, for every route and
     WebSocket upgrade (`/api/health` and `/healthz` may answer without it). The address then decides: one of this
     machine's own addresses (loopback, any interface address read live, the Tailscale self addresses) is `403
     self_caller` (the health routes excepted); a Tailscale address goes to `tailscale whois`; anything else follows
     `lan_access`. The tailnet maps the server's own Tailscale address to the server node's owner, so without the
     `self_caller` refusal a process on the server calling its own Tailscale name or LAN address would reach nginx and
     arrive as someone else, possibly an admin.
   - Local socket: the caller is the local service caller (legacy, the user name comes from `X-Workstation-User`). An
     `X-Forwarded-For` header there is `400 proxy_header_invalid`: nginx never connects to this socket.
   - There is no "loopback peer" and no "no `X-Forwarded-For` means local" rule in production.
3. **Development** (macOS, tests, no nginx): `[server] listen = "tcp"` gives one TCP listener (`host`, `port`), and the hub
   treats loopback callers as local (a loopback peer without `X-Forwarded-For` is a local tool). The hub
   refuses to start with `listen = "tcp"` under systemd (`INVOCATION_ID`) or with `NODE_ENV=production` while `[agents]
   run_as` is set. The default is `"unix"` on Linux in production and `"tcp"` everywhere else.
4. **The status service** listens only on its own socket `status.sock` (0660, group `workstation-proxy`) in production,
   and refuses to start with `[status] listen = "tcp"` there (its API has no user identity, so a TCP port would be open
   to every local account); `tcp` is for development. It keeps its own Origin guard and calls the hub through the hub's local
   socket (`[status] hub_socket`, default `[server] local_socket`; `hub_url` is for TCP development). It never forwards a
   caller's identity headers.
5. **Socket files are created safely.** Each socket is bound under a process umask that already gives its final mode
   (no moment with a wider mode); the public one is then given to `workstation-proxy` (the service account must be a
   member, which `install.sh` arranges). A stale socket file from a crash is removed before listening, anything else in
   the way stops the start, and both files are removed on shutdown. The directory comes from tmpfiles.d (and the
   hub's pre-start step), not from a unit's `RuntimeDirectory=`: systemd may re-chown a RuntimeDirectory's contents when its
   ownership differs from the unit's, which would reset the public socket's group and lock nginx out. tmpfiles does not
   touch the sockets, and stopping one unit does not remove the other's.

nginx (`deploy/nginx-tailscale.sh`) proxies to the sockets with one block of `proxy_set_header` lines repeated in every
location (nginx does not inherit them into a location that sets its own), sets `X-Forwarded-For` to `$remote_addr`, and
has no `real_ip_header` or `set_real_ip_from`: the address must be the connection's own, never one a client supplied.

**What this rests on**, checked by `deploy/nginx-tailscale.sh` on the effective configuration (`nginx -T`) every time it
runs, which refuses to continue otherwise:

- No realip directive (`real_ip_header`, `set_real_ip_from`, `real_ip_recursive`) anywhere in nginx's configuration,
  other sites included: realip would let a request header replace `$remote_addr`, and so choose the address the hub
  classifies. The check looks for the names as whole words in the whole `nginx -T` text, comments included, rather
  than parsing nginx's syntax (a directive may span lines or share one), and runs before the script changes anything.
- `workstation-proxy` has exactly two kinds of member: the service account and nginx's worker account. Any member can
  connect to the public socket and claim any client address. nginx's worker account is usually `www-data`, shared by
  every site and PHP-style application on the machine that runs as it; on a server that hosts other web applications,
  run them under other accounts or keep Agent Workstation on a machine of its own.
- The status service runs as the service account, so it can use the hub's local socket. That is by design (it is part
  of the same trusted installation), not a separate sandbox: a compromise of the status service is a compromise of the
  hub.

**The agent firewall** (`deploy/workstation-agent-firewall`, and the same rules in `deploy/nftables.conf`) stays as defense
in depth. It resets the agent account's TCP connections to ports 80 and 443 of any address of this machine, the Tailscale
address included (`-m addrtype --dst-type LOCAL`; `fib daddr type local` in nftables), and to the hub and status TCP
ports, which only a development setup uses. The hub checks every 10 minutes that the firewall unit is active while
agents run as a separate account; an inactive unit is a warning in the log and an error notice to admins. Nothing is
gated on it: the sockets, not the firewall, keep the agent off the hub.

## Limits between users

Users are separated in the web UI and the API: each sees only their own sessions, files and projects, and the hub checks
every path against the user's workspace. The agent processes are **not** separated. Every user's Claude Code sessions
and terminals run as the same unprivileged account (`workstation-agent`) and all workspaces are group-writable by it, so:

- one user's agent or terminal can read, change or delete another user's workspace files;
- they can see each other's processes (`ps`, `/proc`) and temporary files;
- Claude Code's sandbox confines a code session to its working directory, but that is a guard against mistakes and
  prompt injection, not a boundary between people, and a terminal has no sandbox at all.

Use Agent Workstation alone; do not share it with other people. New users who are
not admins start with the terminal off (`[terminal] enabled` is the master switch; admins turn it on per user), which
removes the easiest route but not the others. As extra hardening, mount `/proc` with `hidepid=2,gid=<group>` (an `/etc/fstab` line such as
`proc /proc proc defaults,hidepid=2,gid=proc-viewers 0 0`), where the group contains only the hub's account (the hub reads
its Claude processes' memory use from `/proc`), so accounts that are not in it cannot see other accounts' processes.
Do not use `workstation-work` for it: the agent account is a member. This reduces what agents can see; it does not
isolate workspaces.

## Agent processes

- Claude Code and terminal shells run as the unprivileged `workstation-agent` account through the root-owned
  wrapper `/opt/agent-workstation/bin/workstation-agent-exec`, which validates every flag, rebuilds the environment and refuses
  anything shaped like a real API key. `workstation-agent` has no sudo and cannot read Agent Workstation's data, configuration
  or browser profiles; it cannot reach the hub's API either: the sockets are closed to it by file permissions (see
  [The hub's sockets](#the-hubs-sockets)).
- Claude Code is installed root-owned in `/opt/agent-workstation/claude` (mode 0755): the agent account runs it but
  cannot change it, so one unsandboxed run cannot patch the program every later session starts, and its auto-updater is
  off (`DISABLE_AUTOUPDATER=1` in the wrapper). The plugins the hub generates for code sessions (skills, commands, agents; the CLI loads
  them outside the sandbox) live in `/var/lib/agent-workstation-plugins` (`[paths] agent_plugins_dir`), which is owned by
  the hub's account, mode 0750 (the agent's group reads, nobody else writes), below root-owned folders: the agent account
  can neither add content to a plugin nor rename a folder to put its own in place. The wrapper accepts `--plugin-dir` and
  `--plugin-dir-no-mcp` only for `<that folder>/<uuid>/(project|workstation)` (real path, no symlink), and only while that
  folder, every parent up to `/` and everything inside are neither owned by the agent account nor writable by group or
  others; it refuses otherwise. A plugin holds a manifest with only `name` and `description` plus `skills/`, `commands/`
  and `agents/`: no hooks, MCP servers, settings, status line or language servers, and the hub also runs sessions with
  `disableAllHooks` and without the plugin's MCP discovery. The hub builds each plugin in a temporary folder, sets modes
  without group or other write whatever its umask, and renames it into place.
- Claude processes get a per-process token for a loopback key proxy instead of the real key. The proxy refuses requests
  once the monthly budget is used up and requests for a model outside the user's allowlist.
- The agent firewall unit (`workstation-agent-firewall`) rejects the agent account's connections to ports 80 and 443 of
  this machine and to the hub and status TCP ports, as defense in depth; the install fails if it cannot be applied. It is
  re-applied when `nftables.service` reloads (`ReloadPropagatedFrom=`), and the hub checks every 10 minutes that the unit
  is active while agents run as a separate account: an inactive unit is a warning in the log and an error notice to admins.
- **Code sessions** are confined to their working directory: file tools refuse other paths; Claude's commands run in
  Claude Code's sandbox (bubblewrap) and can write only there and to their own temp dir. Network: well-known package
  and code hosts; another host asks the user (or is refused in the automatic permission modes); loopback, LAN and
  tailnet addresses are refused. Commands that send data out (push, publish, upload, ssh/scp, POST requests) always
  ask, in every mode.
- **Chats** run code only in their own folder, in the same sandbox, with network access to PyPI only and no
  credentials in the environment. Files from the internet come through `download_file`, which validates the URL,
  pins the resolved public address, fetches in an isolated environment, and asks the user for unfamiliar hosts.
- Everything agents read from web pages, files, tool output and attachments is treated as data; the agent guide
  tells them never to follow instructions found there.
- The browser holds the user's logins; it is allowed per website by the user, and agents' acting tools follow
  the permission mode.

## Project-provided agent settings

Claude Code reads a project's own settings files: `.claude/settings.json` (hooks, permissions, environment, helper
commands such as `apiKeyHelper`, sandbox additions) and `.mcp.json` (MCP servers) in the working directory. A synced
folder or a cloned repository can therefore carry a command that Claude Code would start as the agent account at session
start, outside the sandbox's command rules.

By default (`[sessions] project_settings = false`) code sessions **read no settings file at all** (`settingSources: []`),
with `disableAllHooks` and `strictMcpConfig` on as well. So everything in `.claude/settings.json`, `.claude/settings.local.json`
and `.mcp.json` is ignored: hooks, `env`, `apiKeyHelper` and the other helper keys, permission rules, sandbox additions
and MCP servers. What a project still provides, the hub passes itself:

- **Instructions:** `CLAUDE.md` and `.claude/CLAUDE.md` of the working directory (not `CLAUDE.local.md`, `.claude/rules/`
  or files above the directory), read when the session's process starts and added to the system prompt in a delimited
  section after the Agent Workstation guide. `@path` imports are followed only to regular files whose real path is inside
  the working directory (a symlink that leaves it is refused), at most 5 levels deep and 200 KB in all (then cut with a
  note).
- **Skills, commands and subagents** of `.claude/skills`, `.claude/commands` and `.claude/agents`, as a generated plugin
  that holds only those folders: no hooks, no MCP servers, no settings. Entries whose real path leaves the working
  directory are skipped, and the frontmatter keys that start things or widen permissions (`hooks`, `mcpServers`,
  `permissionMode`, `allowed-tools`) are removed from the copies. Claude Code names plugin entries by their plugin:
  `/project:<name>` for the project's, `/workstation:<name>` for your own and the global skills (which reach sessions the
  same way). The plugin is rebuilt at every process start.

With `project_settings = true` the behaviour is Claude Code's own (`settingSources: ["project"]`, hooks and MCP servers
on). Use it only for projects you wrote yourself: the hub blocks the agent's file tools and commands from writing `.claude/`
and `.mcp.json` inside a code session, but a file that arrives by sync or `git clone` is then loaded as is, and its
commands run as the agent account.

## Data handling

- **Every AI call is made by the server.** Claude (Agent SDK through the API key proxy) and the hub's own
  calls (the docs assistant, which uses Claude Sonnet and needs a signed-in user, and the Claude Haiku helpers for search
  ranking, summaries, download checks and price checks) run on the server with the API key stored there. The Mac app and
  browsers talk only to the hub.
- **A person's devices contact nothing but the hub.** External images in answers are never fetched (they show as
  links); libraries for interactive visuals are fetched and cached by the server (`/api/visual-cdn/`), and a visual's
  frame may load scripts from nowhere else; read aloud uses on-device voices only; no fonts, analytics or update
  servers outside the hub. Links open in the browser only when clicked.
- **Folder sync uploads only what the person left checked.** A window shows the folder before anything is uploaded;
  unchecked paths (and `.git`) never leave the Mac and are excluded on the server too (no built-in rules, no AI
  pass). Cloud-only files (`dataless`: OneDrive, iCloud Drive, Google Drive, Dropbox, Box) are never read, so nothing
  is fetched from a cloud provider as a side effect. Files over 100 MB always ask first.
- **Uploaded archives are read defensively.** A folder's first upload (a tar or tar.zst) is extracted into a scratch folder
  under limits (size, extracted size, entries, time). The hub reads the tar headers the way GNU tar does and refuses
  sparse, multi-volume and unknown entry types and damaged headers (`400 baseline_unsupported_entry`); it also measures
  the scratch folder's real size while it is written and stops the extraction past the limit.
- The visual libraries cache is a cache, not user data: at 200 MB or 500 files the least recently used files are evicted,
  and at most four libraries download at once.
- Nothing else is deleted automatically: no expiry, no cleanup jobs. Disk: warning at 80 %, read-only at 95 %.
- Nothing is written to a user's Mac without their decision (accepting in Changes, restoring from History); the
  Mac app's writer backs up what it overwrites and sends deletions to the Trash.
- Secrets (`/etc/agent-workstation/anthropic.env`) live on the server, readable by the service account only, and are
  never committed. The repository's example config holds placeholders only.
- File APIs are confined to the user's workspace (realpath check, `..` and symlink escapes rejected).
- The docs assistant and incognito chats keep nothing after the page closes (token counts aside).

## What is NOT protected

- A compromised device signed in to an allowed Tailscale account has that person's full access.
- Other users of the same server: their agents and terminals share one account (see [Limits between users](#limits-between-users)).
- The terminal is a real shell as `workstation-agent` (no sudo). It is off for new non-admin users; admins switch it on or off per person.
- Outbound-command detection reads the command line; it cannot see inside scripts (e.g. `npm run deploy`).
- Per-person token limits are a budgeting tool, not a security control.
