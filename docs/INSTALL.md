# Install guide

How to install Agent Workstation on a fresh Linux server, reach it from your devices over Tailscale, and keep it up to
date. This is the main guide; [DEPLOY.md](DEPLOY.md) is the configuration and operations reference and
[../deploy/README.md](../deploy/README.md) describes exactly what the scripts do.

Placeholders used below: the server's tailnet name is `server.example-tailnet.ts.net`, its Tailscale address is
`100.101.102.103`, the admin account on the server is `admin`, and your Tailscale login is `alice@example.com`. None of
them is stored in the repository.

## Before you start: who this is for

Agent Workstation is for personal use: one person, on their own server, with their own Anthropic API key. It is not
built to be shared. All usernames on a server run their Claude Code sessions and terminals as the same unprivileged
account (`workstation-agent`), so they can read each other's workspaces and see each other's processes; the sandbox
confines a code session to its working directory but does not separate usernames.
[SECURITY.md](SECURITY.md#limits-between-users) has the details.

## What you need

- A server running Debian or Ubuntu with systemd (arm64 or x86-64, 4 GB of RAM or more) and an account with passwordless
  sudo. Run `install.sh` as that admin account, never as root.
- An Anthropic API key from the [Anthropic Console](https://console.anthropic.com).
- A Tailscale account (a free personal one is enough) and Tailscale on the server and on every device you use.
- Optional: a Mac with Swift 6 if you want to build the macOS app yourself.

## 1. Tailscale

Tailscale is why the server needs no public address. Your tailnet is the access control: only devices you have added can
reach the server, and your Tailscale login is your identity in Agent Workstation. See the README for the full reasoning.

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS
   Certificates**. HTTPS certificates give the server a valid `https://` name.
2. On the server, install Tailscale and join your tailnet:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale ip -4          # the Tailscale address, 100.x.y.z
   tailscale status         # shows the machine name; the full name is <name>.<tailnet>.ts.net
   ```

3. Install Tailscale on your Mac, PC and phone ([tailscale.com/download](https://tailscale.com/download)) and sign in
   with the same account. Each device must be connected while you use Agent Workstation.

## 2. Get the code onto the server

Choose one of two ways. Both end with the same installation under `/opt/agent-workstation`.

### Option A: build on the server

```bash
sudo install -d -o "$USER" -g "$USER" /opt/agent-workstation
git clone <repository URL> /opt/agent-workstation
cd /opt/agent-workstation

# 1. packages, Node 22, accounts, units (no nginx yet, nothing started)
bash deploy/install.sh --no-start --no-nginx

# 2. dependencies and build
npm ci
npm run build

# 3. everything else: browser, nginx on the tailnet (the services stay stopped until you have configured them)
bash deploy/install.sh
```

The first `install.sh` run warns that the build output is missing; that is expected. Running it again after the build is
safe (it is idempotent). It does not start the services until the configuration is finished (steps 3 and 4 below); it
prints what is missing.

### Option B: deploy from a development machine

On a Mac or Linux computer with the repository, Node 22, `ssh` and `rsync`, and key-based SSH to the server:

```bash
npm ci
WORKSTATION_HOST=server.example-tailnet.ts.net WORKSTATION_USER=admin bash deploy/deploy.sh
```

`deploy.sh` builds locally, copies `deploy/` to the server and runs `install.sh --no-start --no-nginx` there first (so
a minimal server gets rsync, Node 22 and the build tools before anything else), copies the repository to
`/opt/agent-workstation`, runs `npm ci --omit=dev`, runs `install.sh --no-start` again and restarts the services. Run it
after `tailscale up`, so nginx is set up on the first run. On a fresh server it stops before the restart and prints
the configuration still to do (steps 3 and 4 below); run `sudo systemctl start workstation-hub workstation-status` once
that is done.

### What `install.sh` does

It is idempotent. It takes four flags: `--no-start` (enable the services but do not start them), `--start` (start them
even though the configuration is unfinished), `--no-nginx` (leave nginx and Tailscale alone) and `--sysctl` (raise the
inotify limits for large synced folders), and passes `--insecure-http` and `--disable-default-site` on to
`nginx-tailscale.sh`. In order:

1. Installs the apt packages it needs: curl, git, tmux, bubblewrap, build tools, python3, rsync, sudo, iptables and nginx.
2. Installs Node 22 from nodejs.org when the server has no Node 22 or newer, after checking the download against
   nodejs.org's `SHASUMS256.txt` (an integrity check of the download, not a signature check).
3. Creates the accounts: `workstation` runs the hub and the status service; `workstation-agent` runs Claude Code and
   terminal shells and has no sudo at all; both are in the group `workstation-work`. It also creates the group
   `workstation-proxy` (the group of the hub's public socket) with `workstation` and nginx's worker account (normally
   `www-data`) in it. The agent account is never in it, and the install fails if it is.
4. Creates `/opt/agent-workstation`, `/var/lib/agent-workstation` and `/etc/agent-workstation`, copies
   `config/workstation.example.toml` to `/etc/agent-workstation/workstation.toml` if it does not exist, and sets
   `[agents] run_as`.
5. Installs Claude Code root-owned in `/opt/agent-workstation/claude` (the agent account can run it but not change it),
   pinned to the version the Agent SDK bundles (set `CLAUDE_CODE_VERSION` to use another release), the folder for the
   plugins the hub generates (`/var/lib/agent-workstation-plugins`, hub-owned 0750, under root-owned parents), the root-owned agent wrapper `bin/workstation-agent-exec` and the sudoers
   rule that lets `workstation` run only that wrapper.
6. Installs Chromium's headless shell for the hub account (the server browser).
7. Installs the systemd units `workstation-hub` and `workstation-status` (they listen on Unix sockets in
   `/run/agent-workstation`, no TCP port) and the agent firewall unit, a second layer that keeps the agent account away
   from nginx on ports 80 and 443 of the machine and from the hub and status TCP ports (taken from `[server] port` and
   `[status] port`; run `install.sh` again after changing either). The install fails when the firewall rule cannot be
   applied.
8. When Tailscale is connected, runs `nginx-tailscale.sh` to put nginx on the Tailscale address.
9. Enables both services and starts them, unless `--no-start` is given or the configuration is unfinished (a fresh
   install always is). A fresh install writes the configuration from the example and stops with the next steps.

It does not install Tailscale, create the API key, configure a firewall or harden sshd.

## 3. The API key

Every Claude process is paid by one Anthropic API key. Create the key file as the admin (the editor opens an empty
file; type one line, `ANTHROPIC_API_KEY=sk-ant-...`):

```bash
sudo install -m 0600 -o workstation -g workstation /dev/null /etc/agent-workstation/anthropic.env
sudoedit /etc/agent-workstation/anthropic.env
sudo systemctl kill --kill-who=main -s HUP workstation-hub     # re-read the key now
```

The hub reads the key into memory only. It never logs it and never gives it to a Claude process. Without a key every
session is refused (`api_unavailable`) and the hub's own helper calls (docs assistant, search ranking, summaries, the
download check, the price check) are off.

## 4. Configuration

Edit `/etc/agent-workstation/workstation.toml` with `sudoedit` before the first start. The example the installer copies
is already closed by default: the hub and the status page listen on Unix sockets that only nginx can open (no TCP port),
`tailscale_identity` is on, `lan_access` is `deny` and `admin_usernames` is empty. What you must set is the admin:

```toml
[server]
public_url = "https://server.example-tailnet.ts.net"

[auth]
tailscale_identity = true                           # the default: identify callers by their Tailscale login
admin_logins = ["alice@example.com"]                # required: these logins are admins
lan_access = "deny"                                 # the default: refuse callers that are not on the tailnet

[billing]
api_monthly_limit_usd = 100                         # monthly budget; 0 = nothing may start
api_reset_day = 1

[sessions]
max_active_processes = 6                            # each Claude process needs roughly 0.2-0.5 GB
```

The hub refuses to start (and says so in `journalctl -u workstation-hub`) while `tailscale_identity` is on and
`admin_logins` is empty. Without `tailscale_identity = true`, the hub trusts the username a client sends and anyone who
can reach it can pick any name, including an admin's; leave it on. After the first start, restart after every edit:

```bash
sudo systemctl restart workstation-hub workstation-status
```

[DEPLOY.md](DEPLOY.md#keys) lists every key. Two keys worth knowing about now: `[terminal] enabled` is the master
switch of the terminal (new users who are not admins start with their own terminal off; admins turn it on per user), and
`[sessions] project_settings` (default `false`) decides whether a synced project's own settings files (`.claude/settings.json`,
`.mcp.json`) are read at all; by default they are not, and the hub passes the project's `CLAUDE.md` and skills itself ([SECURITY.md](SECURITY.md#project-provided-agent-settings)).

## 5. Start and verify

With the key (step 3) and the admin login (step 4) in place, start the services (or run `bash deploy/install.sh --start`):

```bash
sudo systemctl start workstation-hub workstation-status
systemctl status workstation-hub workstation-status --no-pager
sudo curl -s --unix-socket /run/agent-workstation/hub-local.sock http://localhost/healthz    # ok
sudo curl -s --unix-socket /run/agent-workstation/status.sock http://localhost/healthz       # {"ok":true,...}
journalctl -u workstation-hub -f                      # live logs
```

From another device on the tailnet, open `https://server.example-tailnet.ts.net/status/`. The status page shows service
health and, once the key works, the API credits. Two more checks: `sudo ss -ltnp` shows no hub or status port (`9000`, `9100`), and from a device that is not on your tailnet the `.ts.net` name does not answer.

## 6. HTTPS on the tailnet (nginx)

`install.sh` sets this up when Tailscale is connected. To run it yourself, or to repeat it after joining the tailnet
later:

```bash
bash /opt/agent-workstation/deploy/nginx-tailscale.sh 100.101.102.103 server.example-tailnet.ts.net
```

Arguments: the server's Tailscale IPv4 address (required, it must be a `100.x` address) and its
`<name>.<tailnet>.ts.net` name. Flags: `--insecure-http` and `--disable-default-site` (below); `install.sh` passes both
on. What it does, in order:

- With a name: asks Tailscale for a certificate (`tailscale cert`). **If the certificate cannot be issued, it stops with
  an error before it changes nginx**: turn on **HTTPS Certificates** in the Tailscale admin console, then run it again. It
  never falls back to plain HTTP by itself. With `--insecure-http` it serves plain HTTP on port 80 of the Tailscale
  address instead (also the way to run it without a name). The tailnet is encrypted either way, but browsers treat plain
  HTTP as an insecure context, so a few features such as the clipboard API are unavailable.
- With a certificate: serves HTTPS on port 443 of the Tailscale address, redirects port 80 to 443, and installs
  `workstation-ts-cert.timer`, which renews the certificate weekly and reloads nginx.
- Serves only the server's own names: `server_name` is the `.ts.net` name (and the address on port 80), and a default
  server on port 80 (and 443) closes the connection (444) for any other `Host`, which keeps a web page that rebinds its
  own DNS name to the Tailscale address away from the hub (the hub checks `Host` as well). Open the server by its
  `.ts.net` name or its Tailscale address.
- Installs nginx if needed. nginx's stock site (`/etc/nginx/sites-enabled/default`) listens on every interface, so it is
  disabled: when the file is the unmodified Debian or Ubuntu one, the script moves it to
  `/etc/nginx/workstation-disabled-sites/default` and says so. When the file has been changed, the script stops and asks:
  look at it, and if disabling it is fine run the script again with `--disable-default-site` (the file is moved, never
  deleted).
- Makes nginx wait for the Tailscale address. tailscaled assigns it to `tailscale0` some time after boot or a reconnect,
  and nginx cannot bind an address the machine does not have yet. A systemd drop-in
  (`/etc/systemd/system/nginx.service.d/workstation-wait-address.conf`) runs `/usr/local/sbin/workstation-wait-address`
  before nginx starts (it polls `ip -o addr` for up to 60 seconds) and sets `Restart=on-failure`, `RestartSec=5`. At boot
  nginx therefore starts when the address is there, or is retried every 5 seconds after a start that found none. A running
  nginx keeps its socket when Tailscale disconnects and reconnects; after `systemctl restart nginx` while Tailscale is
  down it waits for the address again.
- Adds nginx's worker account to the group `workstation-proxy` (the hub's and the status service's public sockets belong to
  it, mode 0660) and fails if the agent account is in that group.
- Routes `/status/` to the status service's socket (`/run/agent-workstation/status.sock`) and everything else, WebSockets
  included, to the hub's public socket (`hub.sock`). The client address is passed in `X-Forwarded-For` (`$remote_addr`,
  one value, overwriting any the client sent); the same block of proxy headers is in every location, and there is no
  `real_ip_header`.
- Folder sync uploads have no nginx body size cap and are streamed (the hub enforces its own limits, see
  [DEPLOY.md](DEPLOY.md)); everything else is capped at 64 MB.
- nginx binds the Tailscale address only, so neither the LAN nor the internet can reach it.

The hub and the status page have no TCP port by default (`[server] listen` and `[status] listen` default to `"unix"` under
systemd), so nginx is the only listener on the network. Keep them that way; the hub refuses `listen = "tcp"` while agents run
as a separate account.

## 7. Open the web UI and add devices

1. On any device that has Tailscale connected, open `https://server.example-tailnet.ts.net/`.
2. Choose a username the first time (letters, digits, `-`, `_`). With `tailscale_identity = true` the name is bound to
   your Tailscale login, so every device signed in to that login opens straight into your workspace.
3. Logins listed in `admin_logins` get the admin page.

To add another device of yours, install Tailscale on it and sign in to the same Tailscale account. Nothing changes on
the server.

To use the server from another Tailscale account of your own (a work account, for example): open the Tailscale admin
console, Machines, the server's menu, **Share**, and accept the invite with that account. A shared machine gives that
account nothing else on your network. Agent Workstation is for one person: do not share the server with other people
(see "Before you start").

Devices added with a Tailscale tag (servers, shared infrastructure) have no personal login and are refused.

## 8. The macOS app

The app adds folder sync, review and history, notifications and updates to the web UI. It needs Tailscale on the Mac.

- **Download.** If a build has been published to the server, open `https://server.example-tailnet.ts.net/download`. The
  page recommends the Apple Silicon or the Intel build. Open the disk image and drag the app to Applications.
- **Build it yourself.** On a Mac with Swift 6 and macOS 14 or newer:

  ```bash
  WORKSTATION_VERSION=0.1.0 bash scripts/make-app.sh
  open apps/mac/dist/AgentWorkstation.app
  ```

  Run it once in a Terminal: it creates an update-signing key in your login Keychain. To publish the build for download
  (so other Macs and the in-app updater get it), run `deploy/deploy.sh` from the same Mac: it copies `apps/mac/dist` to
  the server's `/opt/agent-workstation/releases`. See [MAC-APP.md](MAC-APP.md) for signing options.
- **First launch.** The app is signed ad hoc, so macOS says it cannot verify it. Open System Settings, Privacy &
  Security, scroll to Security and click **Open Anyway**. This is needed once per Mac.
- **Connect.** Enter `https://server.example-tailnet.ts.net` when asked. Settings, General changes it later.

## 9. Updates

**Option B (deploy.sh).** From your development machine, after pulling the new version:

```bash
WORKSTATION_HOST=server.example-tailnet.ts.net WORKSTATION_USER=admin bash deploy/deploy.sh
```

**Option A (on the server).**

```bash
cd /opt/agent-workstation
git pull
npm ci
npm run build
bash deploy/install.sh --no-start
sudo systemctl restart workstation-hub workstation-status
```

Both restart the hub, which ends running sessions and closes the web and app connections for a moment (terminals keep
running in tmux). Update when nothing important is busy. `deploy.sh --dry-run` shows what it would copy;
`--no-install` skips `npm ci` when the package files did not change.

Claude Code itself is installed for the agent account, pinned to the release the Agent SDK bundles, and is changed
separately. To move to another release:

```bash
cd / && sudo npm install -g --prefix /opt/agent-workstation/claude @anthropic-ai/claude-code@<version>
sudo chown -R root:root /opt/agent-workstation/claude && sudo chmod -R go-w,a+rX /opt/agent-workstation/claude
```

## 10. Uninstall

This reverses every system change `install.sh` and `nginx-tailscale.sh` make. Your users' files and the databases are
not touched until the last step. Run it as the admin account.

```bash
# 1. services, units and the agent firewall rule
sudo systemctl disable --now workstation-hub workstation-status workstation-ts-cert.timer 2>/dev/null || true
sudo systemctl disable --now workstation-agent-firewall
sudo /usr/local/sbin/workstation-agent-firewall stop 2>/dev/null || true     # removes the iptables chain even if the unit did not
sudo rm -f /etc/systemd/system/workstation-hub.service /etc/systemd/system/workstation-status.service \
  /etc/systemd/system/workstation-agent-firewall.service /etc/systemd/system/workstation-ts-cert.service \
  /etc/systemd/system/workstation-ts-cert.timer
sudo systemctl daemon-reload
sudo rm -f /usr/local/sbin/workstation-hub-prestart /usr/local/sbin/workstation-agent-firewall /usr/local/sbin/workstation-wait-address
sudo rm -f /etc/tmpfiles.d/agent-workstation.conf
sudo rm -rf /run/agent-workstation

# 2. the sudo rule for the agent wrapper
sudo rm -f /etc/sudoers.d/workstation-agent

# 3. nginx: the site, the certificate, and the stock default site if the script disabled it
sudo rm -f /etc/nginx/sites-enabled/workstation /etc/nginx/sites-available/workstation
sudo rm -rf /etc/nginx/tls /etc/systemd/system/nginx.service.d/workstation-wait-address.conf
sudo rmdir /etc/systemd/system/nginx.service.d 2>/dev/null || true
sudo systemctl daemon-reload
sudo gpasswd -d "$(sed -n 's/^user[[:space:]]\+\([^ ;]*\).*/\1/p' /etc/nginx/nginx.conf | head -n 1)" workstation-proxy 2>/dev/null || true
sudo groupdel workstation-proxy 2>/dev/null || true
if [ -e /etc/nginx/workstation-disabled-sites/default ]; then
  sudo mv /etc/nginx/workstation-disabled-sites/default /etc/nginx/sites-enabled/default
  sudo rmdir /etc/nginx/workstation-disabled-sites
fi
sudo nginx -t && sudo systemctl reload nginx

# 4. sysctl file (only written by install.sh --sysctl), then reload
sudo rm -f /etc/sysctl.d/90-workstation.conf
sudo sysctl --system >/dev/null

# 5. code, configuration (the API key is in /etc/agent-workstation) and the services' data
sudo rm -rf /opt/agent-workstation /etc/agent-workstation /var/lib/agent-workstation /var/lib/agent-workstation-plugins   # /opt/agent-workstation includes the root-owned Claude Code install
```

Step 5 deletes the configuration and the databases (sessions, usage, settings). Your users' workspaces are separate and
stay until step 6.

```bash
# 6. DELETES ALL USERS' WORKSPACES AND THE AGENT ACCOUNT'S HOME (its Claude settings and transcripts); back up first
sudo pkill -KILL -u workstation-agent || true     # userdel refuses an account that still has processes
sudo pkill -KILL -u workstation || true
sudo rm -rf /tmp/hs /tmp/hf                       # the sandboxes' temp folders (processes' private directories, chat downloads)
sudo rm -rf /srv/agent-workstation
sudo userdel -r workstation-agent
sudo userdel -r workstation
sudo groupdel workstation-work
```

What stays, because other things on the machine may use it:

- The apt packages (curl, git, tmux, bubblewrap, build tools, python3, rsync, sudo, iptables, nginx). Remove them with
  `apt remove` if nothing else needs them.
- Node 22, when `install.sh` installed it: `/usr/local/bin/node`, `npm`, `npx` and `corepack` are symlinks into
  `/opt/node-v22.*`. Remove the symlinks and that folder if nothing else uses them.
- Tailscale. Remove the server from your tailnet in the Tailscale admin console if you no longer need it.
- Settings you made yourself, which the scripts never write: `deploy/nftables.conf` and `deploy/sshd-hardening.conf`,
  if you applied them (see [DEPLOY.md](DEPLOY.md)).

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| The page does not load | Is Tailscale connected on this device and on the server (`tailscale status`)? Does `sudo curl -s --unix-socket /run/agent-workstation/hub-local.sock http://localhost/healthz` work on the server? Is nginx running (`systemctl status nginx`) and listening on the Tailscale address (`sudo ss -ltnp \| grep -E ':(80\|443)'`)? |
| Certificate or HTTPS error, or `nginx-tailscale.sh` stops with "could not get a certificate" | HTTPS Certificates must be enabled in the Tailscale admin console. Run `nginx-tailscale.sh` again with the full `.ts.net` name (or `--insecure-http` for plain HTTP). |
| `nginx-tailscale.sh` stops at the default site | `/etc/nginx/sites-enabled/default` is not the stock file. Read it; if disabling is fine, run the script again with `--disable-default-site`. |
| `lan_denied` | You reached the server by its LAN address. Use the `.ts.net` name with Tailscale connected, or set `lan_access = "legacy"`. |
| `user_bound` | That username belongs to another Tailscale login. Pick another name. |
| `tailscale_identity_required` | The device has a Tailscale tag and no personal login. Sign in with your own account on it. |
| `tailscale_unavailable` | The hub cannot ask tailscaled who the caller is. Check that tailscaled is running (`systemctl status tailscaled`) and test with `sudo -u workstation tailscale whois --json <another device's tailnet IP>`. The socket `/run/tailscale/tailscaled.sock` is normally readable by every local account, which is all `whois` needs, so no extra Tailscale setting is required. |
| The hub does not start: `admin_logins is empty` | Set `[auth] admin_logins` (step 4), or turn `tailscale_identity` off, then start the services. |
| Sessions fail with `api_unavailable` | `/etc/agent-workstation/anthropic.env` is missing, empty or not readable by `workstation`, or `api_monthly_limit_usd` is 0. |
| Sessions fail to start, agent processes exit 126 | The agent wrapper was installed unrendered. Run `bash /opt/agent-workstation/deploy/install.sh --no-start`. |
| An admin notice says the agent firewall is not active (`agent_firewall_inactive`) | Start it with `sudo systemctl enable --now workstation-agent-firewall`; see [DEPLOY.md](DEPLOY.md#when-the-agent-firewall-notice-appears-agent_firewall_inactive). Nothing is refused meanwhile. |
| nginx answers 502 | The hub or the status service is not running, or nginx's account is not in group `workstation-proxy` (`id www-data`; run `install.sh --no-start` again, then `sudo systemctl restart nginx`). |
| The hub does not start: `listen = "tcp"` | Remove `[server] listen = "tcp"` from `/etc/agent-workstation/workstation.toml`; the default under systemd is `"unix"`. |
| The hub does not start: `cannot give ... to group workstation-proxy` | The service account is not in that group: `sudo usermod -aG workstation-proxy workstation`, then restart the hub. |
| A service restarts in a loop | `journalctl -u workstation-hub -n 50 --no-pager`. A missing `packages/hub/dist/main.js` means the build did not run. |
| `npm ci` fails compiling a native module | `sudo apt install -y build-essential python3 make g++`, then run it again. |
| The browser tab says the browser is unavailable | The headless shell install failed (network). Run `cd / && sudo -u workstation -H node /opt/agent-workstation/packages/browser/scripts/install-browser.mjs headless-shell`. A minimal image may also lack Chromium's libraries; the package list is in [../packages/browser/README.md](../packages/browser/README.md). |
| Config changes have no effect | The services read `/etc/agent-workstation/workstation.toml`, not `/opt/agent-workstation/config/`. Restart both services after editing. |
| Locked out after a firewall or sshd change | Use the server's console and follow [DEPLOY.md](DEPLOY.md#emergency-console). |
