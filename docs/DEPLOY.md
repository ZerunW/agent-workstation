# Operations and configuration reference

Reference for a running Agent Workstation: the config file and every key, the API key and budget, day-to-day operations
and recovery. To install, start with [INSTALL.md](INSTALL.md); [../deploy/README.md](../deploy/README.md) describes
exactly what the scripts, accounts, units and firewall do.

Placeholders: the server's Tailscale address is `100.x.y.z`, its tailnet name is `server.<tailnet>.ts.net`, the admin
account is `admin`. None of them is stored in the repository.

## Modes

| | Development (TCP) | Tailnet (the install, recommended) |
|---|---|---|
| Who can connect | Whoever can reach `[server] host:port` | Only your own devices on the tailnet, through nginx |
| Hub listens on | One TCP port (`[server] listen = "tcp"`, default on macOS and outside systemd) | Two Unix sockets in `/run/agent-workstation` (the default under systemd on Linux), no TCP port |
| TLS | None | Tailscale's certificate (`tailscale cert`) |
| Admin identity | `auth.admin_usernames` with `auth.tailscale_identity = false` and `auth.lan_access = "legacy"` | `auth.admin_logins` with `auth.tailscale_identity = true` (the default) |
| Firewall | Unchanged | Optional: everything closed except the tailnet and SSH from an admin network |

The defaults are the tailnet setup: the hub and the status service have no TCP port, identity comes from Tailscale, the LAN
is refused and the hub will not start until `admin_logins` names an admin. The TCP listener is for a development machine:
the hub refuses to start with `listen = "tcp"` under systemd or with `NODE_ENV=production` while `[agents] run_as` is set,
because a port is reachable by the agent account (see [SECURITY.md](SECURITY.md#the-hubs-sockets)). There is no password
anywhere in Agent Workstation (see [SECURITY.md](SECURITY.md)). Plain HTTP is also not a browser "secure context", so a few
browser APIs (for example the async clipboard) are unavailable there. [INSTALL.md](INSTALL.md) sets up the tailnet mode.

## Configuration

### Where the config is read from

Both Node services read the same TOML file. The first file that exists wins; a key that is missing falls back to the
built-in default (which mirrors `config/workstation.example.toml`).

| Order | Hub (`workstation-hub`) | Status (`workstation-status`) |
|---|---|---|
| 1 | `$WORKSTATION_CONFIG` | `$WORKSTATION_CONFIG` (startup fails if it is set but missing) |
| 2 | `./config/workstation.toml` (relative to the process working directory) | same |
| 3 | `/etc/agent-workstation/workstation.toml` | same |
| 4 | built-in defaults | built-in defaults |

On the server use `/etc/agent-workstation/workstation.toml`; the systemd units set `WORKSTATION_CONFIG` to it. On a
development machine `scripts/bootstrap.sh` creates the git-ignored `config/workstation.toml` (`npm run dev:hub` points
`WORKSTATION_CONFIG` at it). The hub's start line names the file it loaded (`config`) and the API key file (`apiKeyFile`).

A few environment variables override the file, mainly for development and tests: `WORKSTATION_HUB_HOST`,
`WORKSTATION_HUB_PORT`, `WORKSTATION_USERS_ROOT`, `WORKSTATION_DATA_DIR`, `WORKSTATION_CLAUDE_BIN`, `WORKSTATION_WEB_DIST`,
`WORKSTATION_CLAUDE_HOME`.

### Keys

Keys marked * are accepted by the code but not listed in the example file.

| Key | Default | Meaning |
|---|---|---|
| `[server] listen` | `"unix"` on Linux under systemd (or `NODE_ENV=production`), else `"tcp"` | `"unix"`: the public and local sockets below, no TCP port. `"tcp"`: `host` and `port`, development only; the hub refuses to start with it in production while `[agents] run_as` is set. Leave it unset. |
| `[server] socket` / `local_socket` | `/run/agent-workstation/hub.sock` / `hub-local.sock` | The public socket (mode 0660, group `proxy_group`; nginx connects here) and the local socket (mode 0600, the service account's; the status service connects here). |
| `[server] proxy_group` | `"workstation-proxy"` | Group of the public socket: nginx's account and the service account are members, never the agent account (`install.sh` arranges it). |
| `[server] host` / `port` | `"127.0.0.1"` / `9000` | With `listen = "tcp"` only. |
| `[server] public_url` | `"http://localhost:9000"` | Base URL used in links and notifications. In tailnet mode the https name. The status service also derives its DNS check name from it when it is a DNS name. |
| `[server] allowed_origins` | `[]` | Web origins whose pages may call the hub, besides `public_url`, this server's Tailscale name and address, and `http://127.0.0.1:<port>` / `http://localhost:<port>`. A request from any other site (`Origin` not allowed, or `Sec-Fetch-Site: cross-site`) gets `403 cross_site`; requests without these headers (the macOS app, curl) are unaffected. Add the web dev server (`"http://localhost:5173"`) for development. The hosts of `public_url` and of these origins are also the `Host` names the hub answers to (any other `Host` gets `421 bad_host`, see [SECURITY.md](SECURITY.md#requests-from-other-web-sites)). |
| `[paths] users_root` | `"/srv/agent-workstation/users"` | Root of all per-user workspaces. |
| `[paths] data_dir` | `"/var/lib/agent-workstation"` | SQLite databases (hub and status) and other mutable state. |
| `[paths] claude_bin` | `""` | Claude Code binary (absolute path or a name on `PATH`). Empty uses the binary bundled with the Agent SDK. With `[agents] run_as` this key is not used: the wrapper starts `/opt/agent-workstation/claude/bin/claude` (root-owned, installed by `install.sh`). |
| `[paths] agent_plugins_dir` | `/var/lib/agent-workstation-plugins` with `[agents] run_as`, else `<data_dir>/agent-plugins` | Where the hub publishes the plugins it generates for code sessions. `install.sh` creates it owned by the hub's account, mode 0750 (the agent's group reads, no group write), under root-owned parents; the wrapper refuses plugins anywhere else or writable by the agent. Run `install.sh` again after changing it. |
| `[paths] web_dist` | `<repo>/packages/web/dist` | Built web UI served by the hub. |
| `[paths] claude_home` | `<[agents] home>/.claude` with `[agents] run_as`, else `$CLAUDE_CONFIG_DIR` or `~/.claude` | Claude's config directory (settings, session files). |
| `[paths] docs_dir` | `<repo>/docs` | The deployed docs folder; the readme pages are `readme/features.md` and `readme/getting-started.md`, read on every request. |
| `[paths] releases_dir` * | `<repo>/releases` | Published macOS builds, `<releases_dir>/<platform>/<version>-<build>/` (served at `/download`; `deploy.sh` publishes them). |
| `[auth] anthropic_api_key_file` | `/etc/agent-workstation/anthropic.env` | File with the Anthropic API key (`ANTHROPIC_API_KEY=...`). |
| `[auth] admin_usernames` | `[]` | Usernames that get admin rights for requests without a Tailscale identity (needs `tailscale_identity = false` or `lan_access = "legacy"` to matter). A username is only a label, so keep it unguessable if the network is not fully trusted. |
| `[auth] tailscale_identity` | `true` | Identity and admin are decided from the tailnet login that `tailscale whois` reports for the request's source IP. |
| `[auth] admin_logins` | `[]` | Tailnet login names (emails) that are admins when `tailscale_identity` is on. Required then: the hub refuses to start with an empty list. Tagged nodes have no login and are never admin. |
| `[auth] lan_access` | `"deny"` | `"deny"` refuses requests that do not come from a Tailscale address, open routes included; `"legacy"` accepts them with the header identity. |
| `[sessions] max_active_processes` | `6` | Maximum Claude Code processes alive at once (each is roughly 0.2-0.5 GB). Sessions themselves are unlimited; extra messages queue. |
| `[sessions] default_model` / `default_effort` | `"opus"` / `"high"` | What a new session starts with when the user has no default of their own. Admins can change both at runtime. |
| `[sessions] min_free_mem_mib` | `1536` | Do not start a new process while `MemAvailable` is below this; idle processes are reclaimed first. |
| `[sessions] idle_minutes` | `10` | Reclaim a process after this many idle minutes. The next message resumes the session transparently. |
| `[sessions] permission_timeout_s` | `600` | Seconds to wait for a permission answer before denying and stopping the turn. |
| `[sessions] project_settings` | `false` | Read a project's own settings files (`.claude/settings.json`, `.mcp.json`) in code sessions. Off: none is read (hooks, `env`, helper commands, permission and sandbox additions, MCP servers are ignored); the hub passes the project's `CLAUDE.md` files and its skills, commands and agents itself. On: Claude Code's own behaviour, and the project's commands run as the agent account; see [SECURITY.md](SECURITY.md#project-provided-agent-settings). |
| `[sessions] tool_memory_limit_mb` | `0` | Memory cap (MiB) for the commands of each Claude code session and chat with its own folder. 0 = off; it has no effect until the cgroup steps in [deploy/README.md](../deploy/README.md) (which include a wrapper change not in this release) are done. |
| `[billing] api_monthly_limit_usd` | `100` | Monthly API budget in USD; `0` = nothing may start. Admins can change it at runtime. |
| `[billing] api_reset_day` | `1` | Day of month (1-28, hub local time) the budget resets. |
| `[billing] service_reserve_usd` | `2` | The last this-many USD of the period are kept for the hub's own API services; sessions stop starting turns once only that is left. |
| `[billing] proxy_port` / `upstream` | `0` / `https://api.anthropic.com` | The loopback key proxy's port (0 = random) and where it forwards. |
| `[limits] disk_warn_percent` | `80` | Disk usage (of the `users_root` filesystem) at which every client is told to pull content back. Must be lower than the block threshold. |
| `[limits] disk_block_percent` | `95` | Disk usage at which the hub goes read-only (no new messages, uploads or sync pushes) until space is freed. Nothing is deleted automatically. |
| `[limits] default_weekly_token_limit` | `0` | Default rolling 7-day input+output token cap per user. `0` is unlimited. Admins can override per user at runtime. |
| `[limits] remote_claude_enabled` | `true` | Global kill switch for new Claude turns. Admins can flip it at runtime. |
| `[terminal] enabled` | `true` | Web/app terminal (a real shell on the server). New users who are not admins start with their terminal off; admins turn it on or off per user. |
| `[terminal] shell` | `"/bin/bash"` | Shell started inside the user's tmux session. |
| `[browser] enabled` * | `true` | The per-user server browser. The other `[browser]` keys (`flavor`, `idle_minutes`, `max_concurrent`, `viewport`, `screencast`, `mcp`, ...) are described in [../packages/browser/README.md](../packages/browser/README.md). |
| `[baseline] max_compressed_bytes` / `max_extracted_bytes` / `max_files` / `max_minutes` * | `4 GiB` / `8 GiB` / `200000` / `30` | Limits of one baseline upload (the first upload of a folder): bytes received, total bytes extracted, entries in the archive, minutes to receive and extract. Over a limit the hub kills the extraction, removes its scratch folder and answers `413 baseline_too_large` or `408 baseline_timeout`. The archive's tar headers are read the way GNU tar reads them: sparse, multi-volume and unknown entry types and damaged headers are refused (`400 baseline_unsupported_entry`), and the scratch folder's real size is measured while it is extracted. |
| `[chats] download_max_mb` / `download_timeout_s` * | `2048` / `600` | Size and time limits of a chat's `download_file`. |
| `[agents] run_as` / `exec` / `home` | `""` / `/opt/agent-workstation/bin/workstation-agent-exec` / `/home/<run_as>` | The account that runs every AI process, the wrapper the sudoers rule allows and the account's home; `install.sh` sets `run_as`. |
| `[status] listen` / `socket` | same default rule as `[server] listen` / `/run/agent-workstation/status.sock` | The status service's public socket (mode 0660, group `[server] proxy_group`; nginx proxies `/status/` to it). `"tcp"` (development) uses `host` and `port`; the service refuses to start with it in production. |
| `[status] hub_socket` / `hub_url` | `[server] local_socket` / unset (derived from `[server] host` and `port` when the hub listens on TCP) | How the status service asks the hub (`/api/health`, API credits): through the hub's local socket, or over TCP at `hub_url` (development). |
| `[status] host` / `port` | `"127.0.0.1"` / `9100` | With `listen = "tcp"` only. The agent firewall blocks this port and `[server] port` for the agent account; run `install.sh` again after changing either. |
| `[status] sample_interval_s` | `10` | Metric sampling interval (2-300). |
| `[status] health_interval_s` | `60` | Health check interval (5-3600). |
| `[status] interfaces` | `["tailscale0"]` | Network interfaces to graph. Use `ip -br link` to find yours. |
| `[status] speed_probe_interval_min` | `60` | Periodic bandwidth probe (about 20 MB down, 10 MB up). `0` disables it; the page still has a manual button. |
| `[status] hub_user` | `"status"` | Username sent as `X-Workstation-User` when the status service calls the hub (`/api/usage/limits` needs a user). |
| `[status] dns_check_host` | host of `public_url` if it is a DNS name | Name that must resolve to the server's Tailscale address (health check). |
| `[status] nvme_device` | `"nvme0n1"` | Block device whose IO is graphed and whose SMART health is checked. |
| `[pricing] check_time` | `"04:30"` | Hub-local time of the daily price check; `[[pricing."<model>"]]` periods replace a model's built-in prices. |

## API key and budget

Every Claude process is paid by one Anthropic API key. Create `/etc/agent-workstation/anthropic.env` yourself (one line,
`ANTHROPIC_API_KEY=sk-ant-...`, file owned by `workstation`, mode 0600). The hub reads it into memory only (at start, on `SIGHUP` and
when the file changes), never logs it and never gives it to a Claude process: Claude talks to a loopback proxy of the hub with
a per-process token. Without a key (or with a budget of 0) every session is refused with `503 api_unavailable`, and the hub's
own API services (docs assistant, relevant search, summaries, the download check, the price check) are off; the rest keeps
working.

The budget period runs from the most recent `api_reset_day` to the same day next month. Spend is what the proxy metered
(plus the hub's own API calls), priced with the hub's price table. `service_reserve_usd` of it is kept for those services:
sessions stop starting turns (`429 api_limit_reached`) once only that is left. Admins change the budget, the reset day and the
reserve at runtime (`PATCH /api/admin/settings`).

## Operations

```bash
journalctl -u workstation-hub -f              # hub logs
journalctl -u workstation-status -f           # status service logs
sudo systemctl restart workstation-hub workstation-status
WORKSTATION_HOST=... npm run deploy           # new release from the dev machine
```

- **State.** Everything mutable is in `/var/lib/agent-workstation` (SQLite) and `/srv/agent-workstation/users`
  (workspaces, review repositories). Back both up if the content matters:
  `sqlite3 /var/lib/agent-workstation/<db>.sqlite ".backup /path/backup.sqlite"` is safe while the hub is running.
- **Disk.** At 80 % every client is warned; at 95 % the hub is read-only. Nothing is ever deleted automatically; users pull
  projects back from the UI and then remove the server copy.
- **Memory.** Each live Claude Code process is roughly 0.2-0.5 GB. Lower `sessions.max_active_processes` if the server swaps.
- **Claude Code updates.** `cd / && sudo npm install -g --prefix /opt/agent-workstation/claude @anthropic-ai/claude-code@<version> && sudo chown -R root:root /opt/agent-workstation/claude && sudo chmod -R go-w,a+rX /opt/agent-workstation/claude` (the install is root-owned so the agent account cannot change it).

## Emergency console

If a firewall or sshd mistake locks you out, you do not need the network: use the server's console (monitor and keyboard, a
serial console or your hosting provider's console) and undo the change:

```bash
sudo nft delete table inet workstation_filter    # drop the optional firewall (deploy/nftables.conf) right now
sudo systemctl disable --now nftables            # keep it off across reboots (if you made it permanent)
sudo rm /etc/ssh/sshd_config.d/00-workstation-hardening.conf && sudo systemctl reload ssh   # re-allow password login if needed
sudo tailscale up                                # re-authenticate if the key expired
```

## DNS rebind fallback

If a router filters DNS answers that point at private ranges ("DNS rebind protection"), the `<server>.<tailnet>.ts.net` name
may not resolve on some networks. Tailscale's own resolver answers it: turn on Tailscale DNS (MagicDNS) on the device, or use
split DNS. The install serves only that name and the Tailscale address; any other name is refused.

## When the agent firewall notice appears (`agent_firewall_inactive`)

While `[agents] run_as` is set, the hub checks every 10 minutes that `workstation-agent-firewall.service` is active; when it
is not, admins see an error notice (and an info note when it is back) and the hub log has the reason. Nothing is refused:
the hub's sockets, not the firewall, keep the agent account away from the hub, and the firewall is defense in depth
(see [SECURITY.md](SECURITY.md#the-hubs-sockets)).

1. `sudo systemctl status workstation-agent-firewall` and `sudo /usr/local/sbin/workstation-agent-firewall status`. An
   inactive unit or a missing `WORKSTATION_AGENT` chain: `sudo systemctl enable --now workstation-agent-firewall`.
2. After changing `[server] port` or `[status] port`, run `bash /opt/agent-workstation/deploy/install.sh --no-start` again so
   the rules match.
