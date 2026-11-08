# deploy/

Everything that puts Agent Workstation on a Linux server (Debian or Ubuntu, arm64 or x86-64) and, optionally, locks it down.

| File | What it is |
|---|---|
| `install.sh` | Run on the machine (deploy.sh calls it): packages, Node 22, accounts, directories, config, Claude Code for the agent account (pinned), agent wrapper + sudoers drop-in, systemd units, agent firewall, nginx on the Tailscale address, enable services (start only once configured) |
| `deploy.sh` | Run on your development machine: build, `install.sh --no-start --no-nginx` first, rsync to the server, `npm ci`, `install.sh`, restart, verify |
| `workstation-agent-exec` | the root-owned wrapper (`/opt/agent-workstation/bin`) through which the hub starts Claude Code and tmux as `workstation-agent`; `test/workstation-agent-exec.test.sh` tests it without sudo |
| `systemd/workstation-hub.service` | the hub (web UI, API, sessions); sockets in the runtime directory `/run/agent-workstation` |
| `systemd/workstation-status.service` | metrics, health checks, status page; its socket in the same runtime directory |
| `systemd/workstation-agent-firewall.service` + `workstation-agent-firewall` | the agent firewall (defense in depth: the agent account cannot reach nginx or the hub and status TCP ports) |
| `proxy-trust.sh` | read-only checks `nginx-tailscale.sh` runs first: no nginx realip directive, no unexpected member in `workstation-proxy`; `test/proxy-trust.test.sh` tests it |
| `workstation-hub-prestart.sh` | root helper run before the hub starts; creates the users workspace root and the socket folder |
| `nginx-tailscale.sh` | nginx on the Tailscale address (HTTPS with Tailscale's certificate; plain HTTP only with `--insecure-http`), `/status/` to the status socket, everything else to the hub's public socket; the nginx drop-in that waits for the address |
| `workstation-wait-address.sh` | `/usr/local/sbin/workstation-wait-address`: waits until an address is assigned to an interface (the nginx drop-in's `ExecStartPre`) |
| `nftables.conf` | optional firewall: drop everything but the tailnet, loopback and SSH from an admin network |
| `sshd-hardening.conf` | optional: keys only, no root login |

## Install

The step-by-step guide is [../docs/INSTALL.md](../docs/INSTALL.md). In short: a Debian or Ubuntu server with systemd and an
admin account with passwordless sudo, Tailscale joined on the server and your devices, and an Anthropic API key. Either
build on the server (`install.sh --no-start --no-nginx`, `npm ci`, `npm run build`, `install.sh`) or run `deploy.sh` from
a development machine:

```sh
npm ci                                        # once, on the development machine
WORKSTATION_HOST=server.example.com WORKSTATION_USER=admin bash deploy/deploy.sh      # or: npm run deploy
```

Then finish the configuration on the server before the first start (`install.sh` does not start the services until the
admin login and the API key are in place). Set `[auth] admin_logins` in `/etc/agent-workstation/workstation.toml`, then
create the API key (it is read into the hub's memory only and never logged):

```sh
sudo install -m 0600 -o workstation -g workstation /dev/null /etc/agent-workstation/anthropic.env
sudoedit /etc/agent-workstation/anthropic.env        # one line: ANTHROPIC_API_KEY=sk-ant-...
sudo systemctl start workstation-hub workstation-status      # first start (a running hub re-reads the key with HUP, below)
sudo systemctl kill --kill-who=main -s HUP workstation-hub    # re-read the key now (it is also re-read every minute)
```

Without the key every session is refused with `503 api_unavailable` and the hub's own API services (docs assistant, search
ranking, summaries, download check, price check) are off.

### What `deploy.sh` does

1. `npm run build` at the repo root (protocol, web, hub, status). Skip with `--no-build`.
2. Checks SSH, creates `/opt/agent-workstation` owned by the admin (`sudo install -d`), copies `deploy/` and the example
   config there with tar over ssh (a minimal server has no rsync yet) and runs `install.sh --no-start --no-nginx` every
   time: packages (rsync, build tools, iptables), Node 22, accounts, units, the agent firewall.
3. `rsync -rlptz --delete` of the repo to `/opt/agent-workstation`. Excluded and never deleted on the server:
   `node_modules`, `.build`, `apps/mac`, `data`, `packages/*/data`, `*.sqlite*`, `config/workstation.toml`, `.git`,
   `/bin` (the root-owned agent wrapper), `/claude` (the root-owned Claude Code install), `/releases`, `.deploy-lock.sha256`. `dist/` folders **are** shipped (the server
   does not build TypeScript or the web UI). When `apps/mac/dist` holds a signed build, it is published to `/opt/agent-workstation/releases`
   (an existing version is never replaced).
4. `npm ci --omit=dev --no-audit --no-fund` on the server, so `better-sqlite3` and `node-pty` compile for its CPU.
   The services are stopped first because `npm ci` replaces `node_modules`. With `--no-install` this step is skipped when
   `package-lock.json` and every `package.json` hash to the value stored in `.deploy-lock.sha256` *and* the Node version is
   unchanged.
5. `deploy/install.sh --no-start` (units, config, nginx).
6. `systemctl restart workstation-hub workstation-status`, waits for both to be
   active (not done while `[auth] admin_logins` is still empty with Tailscale identity on: the hub would refuse to start, so the script prints what
   to configure instead), waits a few more seconds to catch a crash loop (`Restart=always` would hide it from `is-active`), prints
   `systemctl status` for each and the last 20 journal lines of any failing unit, plus a `curl /healthz` smoke check of `hub-local.sock` and `status.sock`
   (run as root). Exit code 1 on failure. It ends with the links to open: the nginx site on the tailnet, or a note that no nginx
   site is set up.

Flags: `--no-build`, `--no-install`, `--no-restart`, `--dry-run` (rsync `-n -v`, changes nothing).

Environment: `WORKSTATION_HOST` (required), `WORKSTATION_USER` (default: your user name), `WORKSTATION_DIR`
(`/opt/agent-workstation`), `WORKSTATION_SERVICES` (`"workstation-hub workstation-status"`), `WORKSTATION_SSH_OPTS` (extra
ssh options), `WORKSTATION_BUILD_CMD` (`npm run build`), `WORKSTATION_CONF_DIR` (`/etc/agent-workstation`),
`WORKSTATION_RUN_DIR` (the sockets' directory for the smoke check, `/run/agent-workstation`). The script is written for macOS (bash 3.2, the stock `openrsync`) and works on Linux too.

### What `install.sh` does

On the server, as the admin (passwordless sudo; not as `workstation` or `workstation-agent`):

```sh
bash /opt/agent-workstation/deploy/install.sh              # install, enable both services, start them once configured
bash /opt/agent-workstation/deploy/install.sh --start      # start them even if the configuration is unfinished
bash /opt/agent-workstation/deploy/install.sh --no-start   # install and enable, do not start
bash /opt/agent-workstation/deploy/install.sh --no-nginx   # no nginx / Tailscale setup
bash /opt/agent-workstation/deploy/install.sh --sysctl     # also raise fs.inotify limits (524288 watches)
```

It is idempotent. It installs the apt packages it needs (curl, git, tmux, bubblewrap, build tools, rsync, iptables, nginx),
Node 22 from nodejs.org when the machine has none (the download is checked against nodejs.org's `SHASUMS256.txt`),
creates the accounts and directories, installs Claude Code root-owned in `/opt/agent-workstation/claude` (mode 0755, so
the agent account runs it but cannot change it), pinned to the version the Agent SDK bundles
(`sudo npm install -g --prefix /opt/agent-workstation/claude @anthropic-ai/claude-code@<version>`; `CLAUDE_CODE_VERSION`
overrides it), renders and installs the
agent wrapper and the sudoers drop-in, installs the browser (Playwright's headless shell) for the hub's account, installs the
units and the agent firewall (the install fails if the firewall cannot be applied), creates the group `workstation-proxy`
(the group of the sockets nginx connects to) with the service account and nginx's account in it and fails if the agent account
is in it, and, when Tailscale is connected, sets up nginx on the tailnet address. On a fresh install it writes the configuration from the example and stops before the
first start with the steps to do (API key, `[auth] admin_logins`, `systemctl start`); it also holds the start while either
is missing. It does **not** install Tailscale, a firewall or sshd hardening, and it never creates the API key.

### Accounts

| Account | Runs | sudo |
|---|---|---|
| your admin account | you: deploys, administers | full (passwordless) |
| `workstation` | `workstation-hub`, `workstation-status`, the browser | only `workstation ALL=(workstation-agent) NOPASSWD: /opt/agent-workstation/bin/workstation-agent-exec` and, when smartctl and the device exist, `workstation ALL=(root) NOPASSWD: /usr/sbin/smartctl -j -H -A /dev/<nvme_device>` (`/etc/sudoers.d/workstation-agent`) |
| `workstation-agent` | Claude Code, terminal shells (tmux) and everything they start | none |

Both service accounts are in `workstation-work`, the group of the users' workspaces (setgid, group rw, umask 0002).
`workstation-agent` cannot read `/var/lib/agent-workstation`, `/etc/agent-workstation` (config, API key) or the browser
profile; the hub reads the agent's transcripts through `workstation-work` (`~workstation-agent/.claude/projects`; the home
and `~/.claude` themselves are enter-only). The hub starts every agent process as
`sudo -n -u workstation-agent -- /opt/agent-workstation/bin/workstation-agent-exec <claude|tmux> <cwd> ... -- <args>`; the
wrapper checks every argument, rebuilds the environment from an allowlist and takes secrets from stdin, never argv
(`packages/hub/src/sessions/agentExec.ts`). Claude never gets the Anthropic API key: it gets
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (the hub's key proxy, `[billing] proxy_port`, random by default) and a
per-process `hsk-` token, which the proxy swaps for the key; the wrapper refuses anything that looks like a real key. Every
Claude process gets a private temp directory `/tmp/hs/<22 characters>` (`CLAUDE_CODE_TMPDIR`), which the wrapper creates 0700
as `workstation-agent` before starting Claude and removes in its `rmtmp` mode when the process has ended. Chats' downloads
run curl in bubblewrap through the wrapper's `fetch` modes.

### Where things live

| Path | Content |
|---|---|
| `/opt/agent-workstation` | the code (rsync target), `node_modules`, `packages/*/dist`, `.deploy-lock.sha256` |
| `/opt/agent-workstation/bin/workstation-agent-exec` | the agent wrapper (root, 0755; rendered from `deploy/workstation-agent-exec`) |
| `/etc/agent-workstation/workstation.toml` | the one config file both services read (`WORKSTATION_CONFIG`); `workstation`, 0640 |
| `/etc/agent-workstation/anthropic.env` | the API key (`ANTHROPIC_API_KEY=...`); `workstation`, 0600; created by you |
| `/etc/sudoers.d/workstation-agent` | the sudo rules of `workstation` |
| `/var/lib/agent-workstation` | SQLite databases (`status.sqlite`, the hub's DB), uploads, browser profiles; `workstation`, 0750 |
| `/srv/agent-workstation/users/<name>` | per-user workspaces (created by `workstation-hub-prestart`; `workstation:workstation-work` 2770); `~hub/` there is the hub's scratch folder for agent processes |
| `/var/lib/agent-workstation-plugins` | the plugins the hub generates for code sessions; `workstation:workstation-work` 0750, written only by the hub, `PLUGINS_DIR` of the wrapper |
| `/home/workstation-agent/.claude` | the agent's Claude settings and transcripts |
| `/opt/agent-workstation/claude/bin/claude` | Claude Code; root-owned 0755 (`/opt/agent-workstation/claude` is kept by `deploy.sh`), the wrapper's `CLAUDE_BIN`, with `DISABLE_AUTOUPDATER=1` |
| `/etc/systemd/system/{workstation-hub,workstation-status}.service` | the units |
| `/usr/local/sbin/workstation-hub-prestart` | root helper, run via `ExecStartPre=+` |
| `/usr/local/bin/node` | Node 22 (the units' `ExecStart`) |

### Systemd units

Both: `User=workstation`, `WorkingDirectory=/opt/agent-workstation`, `Environment=WORKSTATION_CONFIG=/etc/agent-workstation/workstation.toml`,
`PATH=/usr/local/bin:...` (system dirs only), `Restart=always` (`RestartSec=3`, no start limit), logs to journald. The hub
also has `SupplementaryGroups=workstation-work` and `UMask=0002`, and no `NoNewPrivileges=` (it needs its sudo rule).

- `workstation-hub.service`: `ExecStart=/usr/local/bin/node packages/hub/dist/main.js`. `ExecStartPre=+/usr/local/sbin/workstation-hub-prestart`
  runs as root and makes sure the users workspace root exists as `workstation:workstation-work` 2770 (reads
  `paths.users_root` from the config; it refuses system directories, never recurses, never deletes). `KillMode=process`:
  only the hub is signalled on a restart, so the tmux servers behind the web terminal survive it.
- `workstation-status.service`: `ExecStart=/usr/local/bin/node packages/status/dist/main.js`, `Nice=5`, `MemoryMax=300M`.
  Its health checks call `systemctl`, `ping`, `sudo -n smartctl` (exact command), `tailscale` and the hub's own API;
  anything missing is shown as "unknown / not installed", never as an error.

```sh
journalctl -u workstation-hub -u workstation-status -f        # live logs of both
sudo systemctl restart workstation-hub                        # after editing /etc/agent-workstation/workstation.toml
systemctl status workstation-hub workstation-status --no-pager
sudo curl -s --unix-socket /run/agent-workstation/status.sock http://localhost/healthz
sudo curl -s --unix-socket /run/agent-workstation/hub-local.sock http://localhost/healthz
```

### Per-command memory limits (off; needs root steps)

Goal: loose caps on the commands agents run (about 3 GB of memory per Claude process's commands), so one runaway build
cannot take the machine down. The machine-wide guard stays as it is (the hub starts no new session below
`[sessions] min_free_mem_mib`). **State: off.** The hub can set the cap (`[sessions] tool_memory_limit_mb`, default 0), but it
only takes effect after the root steps below, so it stays 0.

What Claude Code offers:

- `CLAUDE_CODE_TOOL_MEMORY_LIMIT`: a size in bytes or with a `k`/`m`/`g`/`t` suffix (powers of 1024, `3072m` = 3 GiB);
  `0`/`false`/`none` = off. The hub passes it in the inline settings' `env`, for code sessions and chats with their own folder.
- Linux and cgroup v2 only. The CLI reads its cgroup from `/proc/self/cgroup`, creates `claude-code-bash` **as a sibling
  of its own cgroup** (in the parent directory), writes the size to its `memory.max` and moves every command it starts
  there. One cap for all commands of that Claude process.
- When it cannot (no memory controller, parent directory not writable) it logs `tool cgroup: disabled (...)` in its debug
  log and runs the commands uncapped. It fails open.

Why the unit file is not enough: Claude runs inside the hub's cgroup (`/system.slice/workstation-hub.service`), so the CLI
would create its group in `/system.slice`, which belongs to root. `Delegate=yes` would give the hub its own subtree, but the
agent account would then need write access to a cgroup that also holds the hub, and in cgroup v2 that is enough to move the
hub's processes into a group with a tiny limit. The agent account is the security boundary, so the caps have to live inside
`workstation-agent`'s own systemd user manager:

1. Keep its user manager running and give it the memory, CPU and pids controllers:
   ```sh
   sudo loginctl enable-linger workstation-agent
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/workstation-delegate.conf
   sudo systemctl daemon-reload
   sudo systemctl restart "user@$(id -u workstation-agent).service"
   U=$(id -u workstation-agent); cat /sys/fs/cgroup/user.slice/user-$U.slice/user@$U.service/cgroup.controllers   # must list memory
   ```
2. Code change (not implemented in this release): `deploy/workstation-agent-exec` (mode `claude`) starts the CLI in a delegated scope of that
   user manager (`systemd-run --user --scope -p Delegate=yes -p CPUQuota=200% -p TasksMax=512`), moves into a `cli` leaf
   and enables memory for the scope's children, so the CLI's parent directory belongs to `workstation-agent`.
3. Turn the cap on: `[sessions] tool_memory_limit_mb = 3072` in `/etc/agent-workstation/workstation.toml`, then
   `sudo systemctl restart workstation-hub`.
4. Check while a session runs a command: `systemd-cgls --user-unit` (as `workstation-agent`) shows a `run-*.scope` with `cli`
   and `claude-code-bash`; `cat <scope>/claude-code-bash/memory.max` prints `3221225472`.

### HTTPS on the tailnet (`nginx-tailscale.sh`)

`install.sh` runs it when Tailscale is connected: `bash deploy/nginx-tailscale.sh [--insecure-http] [--disable-default-site] <tailscale IPv4> <name>.<tailnet>.ts.net`
(`install.sh` passes both flags on). Before it changes nginx it checks the effective configuration (`nginx -T`) and stops
if any `real_ip_header` / `set_real_ip_from` is present or `workstation-proxy` has a member other than the service account
and nginx's worker account (see docs/SECURITY.md, "What this rests on").
nginx listens on the Tailscale address only: 443, with 80 redirecting to 443, using the certificate `tailscale cert` issues for
the name. When no certificate can be issued the script stops with an error and instructions (enable HTTPS Certificates in the
Tailscale admin console); plain HTTP on port 80 needs `--insecure-http`. `/` and WebSockets go to the hub's public socket
(`/run/agent-workstation/hub.sock`), `/status/` to the status service's (`status.sock`): `proxy_pass http://unix:<socket>:`.
Both sockets are mode 0660, group `workstation-proxy`, and nginx's worker account (read from `nginx -T`, normally `www-data`)
is a member; the agent account is not and gets `EACCES`. One block of `proxy_set_header` lines (Host, `X-Forwarded-For
$remote_addr`, `X-Forwarded-Proto`, Upgrade, Connection) is written into every location that proxies, because nginx does not
inherit those lines into a location that sets any of its own; the site has no `real_ip_header` or `set_real_ip_from`, so
`$remote_addr` stays the connection's own address (the hub accepts exactly one `X-Forwarded-For` value on the public socket).
Folder sync uploads
(`/api/projects/<id>/{baseline,large,files,manifest,backups}`) have no nginx body cap and are streamed unbuffered (the hub
enforces their limits), everything else is capped at 64m. The certificate is refreshed weekly by `workstation-ts-cert.timer`.
Afterwards set `server.public_url` to the https name; the hub and the status page have no TCP port.

The stock site `/etc/nginx/sites-enabled/default` listens on every interface. The script moves it to
`/etc/nginx/workstation-disabled-sites/default` when it is the unmodified Debian or Ubuntu file; when it differs, the script
stops and asks, and `--disable-default-site` moves it anyway. Nothing is deleted.

nginx binds the Tailscale address, which tailscaled assigns after boot or a reconnect. The script installs
`/usr/local/sbin/workstation-wait-address` and the drop-in `/etc/systemd/system/nginx.service.d/workstation-wait-address.conf`
(`ExecStartPre=` that polls `ip -o addr` for up to 60 seconds, `Restart=on-failure`, `RestartSec=5`): at boot nginx starts when
the address is there, or is retried every 5 seconds after a start that found none; a running nginx keeps its socket across a
Tailscale disconnect and reconnect, and a restart while Tailscale is down waits for the address again. No global
`net.ipv4.ip_nonlocal_bind` setting is used. [INSTALL.md](../docs/INSTALL.md#10-uninstall) lists every system change the scripts make and how to reverse each one.

### The hub's sockets and the runtime directory

The hub and the status service share `/run/agent-workstation` (mode 0755, owned by the service account). It is created by a
tmpfiles.d entry (`/etc/tmpfiles.d/agent-workstation.conf`, installed and applied by `install.sh`) and recreated with the same
owner and mode by `workstation-hub-prestart` if it is missing, not by a systemd `RuntimeDirectory=`: systemd may re-chown a
RuntimeDirectory's contents when its ownership differs from the unit's, which would reset the public socket's group and lock
nginx out, while tmpfiles does not touch the sockets. Stopping either service leaves the directory alone (each service removes
its own socket files on a clean exit and a stale one from a crash before it listens).
Files in it: `hub.sock` (0660, group `workstation-proxy`, for nginx), `hub-local.sock` (0600, the service account's; the status
service and `deploy.sh`'s smoke check connect here) and `status.sock` (0660, group `workstation-proxy`). See
[../docs/SECURITY.md](../docs/SECURITY.md#the-hubs-sockets).

### Agent firewall (always on)

The hub is closed to the agent account by file permissions on its sockets (see above); `workstation-agent-firewall.service`
(installed and started by `install.sh`) is a second layer. It rejects outbound TCP from the `workstation-agent` account to the
hub (`[server] port`, default 9000) and status (`[status] port`, default 9100) TCP ports, which only a development setup uses
(`install.sh` renders them into the unit, so run it again after changing a port), and resets its connections to ports 80 and
443 of any address of this machine (`WORKSTATION_AGENT_LOCAL_BLOCKED_PORTS`, default `80,443`; `-m addrtype --dst-type LOCAL`):
nginx on the Tailscale address forwards to the hub, so the server's own Tailscale name would otherwise be another way in (the
hub refuses such callers with `403 self_caller` as well). It owns one iptables/ip6tables chain `WORKSTATION_AGENT` plus one
jump from `OUTPUT`; inbound traffic is untouched. It needs `iptables` (installed by `install.sh`, which fails when the
rule cannot be applied); the hub checks every 10 minutes that the unit is active while agents run as a separate
account, logs a warning and tells admins when it is not (nothing is refused meanwhile). Check:
`sudo /usr/local/sbin/workstation-agent-firewall status`. See
[../docs/DEPLOY.md](../docs/DEPLOY.md#when-the-agent-firewall-notice-appears-agent_firewall_inactive).
`deploy/nftables.conf` never flushes other rules and carries the same rule in its `agent_output` chain. Ubuntu's stock
`/etc/nftables.conf` does `flush ruleset`: the unit is ordered after `nftables.service`, restarted with it
(`PartOf=`) and reloaded with it (`ReloadPropagatedFrom=`), so the rule comes back right after such a reload.

## Optional hardening: sshd and a firewall

**Order matters.** Verify each step before the next; the firewall comes last because it is the one that can cut you off.

1. Tailscale on the machine and your devices; verify `ssh <tailnet address> hostname` from another device.
2. `install.sh` (nginx on the tailnet address), then verify `https://<name>.<tailnet>.ts.net/` and `/status/` from a tailnet device.
3. Check that the services have no TCP port (`[server] listen` and `[status] listen` default to `"unix"` under systemd):
   `ss -ltnp | grep -E ':(9000|9100)'` prints nothing.
4. sshd hardening (below).
5. Firewall (below), with the automatic rollback.

### sshd hardening (`sshd-hardening.conf`)

Keys only, no root login, `MaxAuthTries 3`. Install it as `00-workstation-hardening.conf`: sshd uses the first value it reads
per keyword and drop-ins are read in lexical order, so an earlier-sorting file such as `50-cloud-init.conf` could otherwise
keep passwords on.

```sh
sudo install -m 644 /opt/agent-workstation/deploy/sshd-hardening.conf /etc/ssh/sshd_config.d/00-workstation-hardening.conf
sudo sshd -t                                    # no output = valid
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
sudo systemctl reload ssh                       # keep your current session open
ssh <admin>@<tailnet address> true              # in a SECOND terminal: key login must still work
```

Revert: `sudo rm /etc/ssh/sshd_config.d/00-workstation-hardening.conf && sudo systemctl reload ssh`.

### Firewall (`nftables.conf`)

Edit the admin network placeholder first. Everything except loopback and `tailscale0` is dropped (replies to connections the
machine started, ICMP/ICMPv6, DHCP, Tailscale's UDP port and SSH from the admin network are allowed). The file owns one table,
`inet workstation_filter`; it never flushes the whole ruleset (Tailscale's own rules survive) and only filters INPUT.
Established connections keep working when it loads, so the SSH session you are typing in survives.

**Test it with a 10-minute automatic rollback before making it persistent:**

```sh
# 0. Prerequisites: Tailscale works (you reached the machine over the tailnet), `at` is installed and running.
sudo apt install -y at && sudo systemctl enable --now atd

# 1. Arm the safety net FIRST: in 10 minutes the table is deleted again, whatever happens.
echo '/usr/sbin/nft delete table inet workstation_filter' | sudo at now + 10 minutes
sudo atq                                           # note the job number

# 2. Load the rules (temporary, not persistent).
sudo nft -f /opt/agent-workstation/deploy/nftables.conf
sudo nft list table inet workstation_filter

# 3. Check, from OTHER terminals / devices, within the 10 minutes:
#    tailnet device:   ssh <admin>@<tailnet address> hostname           -> works
#    tailnet device:   the https address and /status/                   -> work
#    LAN-only device:  nc -z -w2 <lan address> 443               -> fails (timeout)

# 4a. Something is wrong: do nothing and wait (the job removes the rules), or remove them now:
sudo nft delete table inet workstation_filter

# 4b. Everything is right: cancel the rollback, then make it persistent.
sudo atrm <job-number>
sudo cp /etc/nftables.conf /etc/nftables.conf.orig
sudo install -m 644 /opt/agent-workstation/deploy/nftables.conf /etc/nftables.conf
sudo systemctl enable --now nftables
```

Before the first **reboot** with the persistent rules, arm another rollback (`at` jobs survive a reboot and run when the time
has passed), reboot, verify, then `atrm` it. Do not `systemctl stop nftables` to "turn the firewall off": Ubuntu's unit flushes
the entire ruleset on stop (including Tailscale's rules). Use `sudo nft delete table inet workstation_filter` instead.

### Emergency access (locked out of SSH or the network)

Keep a way to reach the machine's own console (monitor and keyboard, a serial console or your hosting provider's console).
From there:

```sh
sudo nft delete table inet workstation_filter                 # firewall off immediately
sudo systemctl disable --now nftables                         # and stay off after reboot
sudo rm -f /etc/ssh/sshd_config.d/00-workstation-hardening.conf && sudo systemctl reload ssh   # passwords/root as before
sudo tailscale up                                             # if the tailnet went away
```

## Troubleshooting

- **`deploy.sh` stops at "cannot ssh"**: check `ssh -o BatchMode=yes <user>@<host> true`; set `WORKSTATION_HOST`,
  `WORKSTATION_USER` or `WORKSTATION_SSH_OPTS`.
- **`npm ci` fails compiling a native module**: `sudo apt install -y build-essential python3 make g++` on the server and
  re-run. The failing module's log is in the script output.
- **A service shows `NRestarts` > 0 or fails**: `journalctl -u <unit> -n 50 --no-pager`. A missing
  `packages/hub/dist/main.js` means the hub was not built before deploying.
- **Sessions fail with `api_unavailable`**: `/etc/agent-workstation/anthropic.env` is missing, empty or unreadable by
  `workstation`, or the monthly budget is 0 (`[billing] api_monthly_limit_usd`, or the admin settings).
- **Status page shows grey dots**: that is intentional for things not installed (Tailscale, the DNS check, SMART).
- **Config edits ignored**: the units read `/etc/agent-workstation/workstation.toml`, not `/opt/agent-workstation/config/`.
  Restart the services after editing.
- **Root filesystem on SD cards**: some images for single-board computers mount `/` with `data=writeback` and `commit=600`; after a power loss
  files written in the last minutes can come back empty. Use the default ordered mode (`sudo tune2fs -o ^journal_data_writeback <root device>`,
  remove `commit=600` from `/etc/fstab`, reboot). If `node_modules` is ever damaged: stop the services, run
  `npm ci --omit=dev` in `/opt/agent-workstation`, start them again.
