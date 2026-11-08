#!/usr/bin/env bash
# Install or refresh Agent Workstation on a Debian or Ubuntu machine (arm64 or x86-64). Idempotent: safe to run as
# often as you like.
#
# Run ON THE MACHINE as the admin account that deploys; it needs passwordless sudo and the repo in /opt/agent-workstation
# (deploy/deploy.sh puts it there from your development machine, or clone it there yourself):
#
#   bash /opt/agent-workstation/deploy/install.sh              # install everything; starts both services once the
#                                                              # configuration is finished (admin login, API key)
#   bash /opt/agent-workstation/deploy/install.sh --start      # start the services even if it is not
#   bash /opt/agent-workstation/deploy/install.sh --no-start   # install only (deploy.sh does this, then restarts)
#   bash /opt/agent-workstation/deploy/install.sh --no-nginx   # leave nginx and Tailscale alone
#   --insecure-http, --disable-default-site                    # passed to nginx-tailscale.sh (see its header)
#
# Accounts (created here if missing):
#   workstation        runs workstation-hub and workstation-status (and the browser). No sudo except the rules below.
#   workstation-agent  runs Claude Code, terminal shells and everything they spawn. No sudo at all; cannot read the
#                 hub's data dir, config, API key file or browser profile.
#   workstation-proxy  group that may connect to the hub's public socket and the status service's socket (mode 0660,
#                 /run/agent-workstation): members are workstation and nginx's worker account (normally www-data), NEVER
#                 workstation-agent. The install fails when the agent account is in it.
#   workstation-work   group of both: the users' workspaces (users_root) are setgid workstation-work, group rw (umask 0002),
#                 and so is the agent's transcript folder ~workstation-agent/.claude/projects, which the hub reads and
#                 deletes. The agent's home and ~/.claude are 0710 (enter, not list).
#
# What it does
#   - installs the packages it needs with apt (curl, git, tmux, bubblewrap, build tools for the native modules, nginx)
#   - installs Node 22 from nodejs.org (integrity checked against nodejs.org's SHASUMS256.txt) when the machine has no Node 22 or newer, and makes sure
#     /usr/local/bin/node exists (the units' ExecStart)
#   - creates the groups and both accounts, and removes them from sudo/admin/wheel; creates workstation-proxy and adds
#     workstation and nginx's account to it (and fails if the agent account is a member)
#   - creates /opt/agent-workstation (owned by the admin), /var/lib/agent-workstation (workstation, 0750) and
#     /etc/agent-workstation (workstation, 0750)
#   - creates /etc/agent-workstation/workstation.toml from config/workstation.example.toml if it does not exist yet, and
#     sets [agents] run_as = "workstation-agent"
#   - sets up the users workspace root and the agent's transcript folder (group, setgid, g+rw)
#   - installs Claude Code root-owned in /opt/agent-workstation/claude (npm, mode 0755: the agent account runs it but
#     cannot change it), pinned to the version the Agent SDK bundles (CLAUDE_CODE_VERSION overrides it)
#   - installs the agent wrapper /opt/agent-workstation/bin/workstation-agent-exec (root, 0755; rendered with this
#     machine's account names and paths) and the sudoers drop-in /etc/sudoers.d/workstation-agent (checked with visudo
#     first) that allows exactly:
#       workstation ALL=(workstation-agent) NOPASSWD: /opt/agent-workstation/bin/workstation-agent-exec
#       workstation ALL=(root) NOPASSWD: /usr/sbin/smartctl -j -H -A /dev/<[status] nvme_device>   (only when smartctl
#                                                                                      and that device exist)
#   - installs the browser for the hub's account: Playwright's chromium-headless-shell for the deployed playwright-core
#     revision, under ~workstation/.cache/ms-playwright
#   - creates /run/agent-workstation (tmpfiles.d entry /etc/tmpfiles.d/agent-workstation.conf, 0755, owned by the service
#     account): the folder of the sockets, shared by the hub and status units
#   - installs /usr/local/sbin/workstation-hub-prestart (creates the users workspace root and the socket folder as root)
#   - installs the workstation-hub and workstation-status systemd units (User=workstation; both use the socket folder
#     /run/agent-workstation for their Unix sockets, there is no TCP listener in production), the agent firewall unit
#   - sets up nginx on the Tailscale address (HTTPS with Tailscale's certificate when the tailnet has HTTPS
#     certificates enabled, else plain HTTP on the tailnet address), proxying to the sockets, and a drop-in that makes
#     nginx wait for that address at boot, when Tailscale is installed and connected
#   - enables both services (and starts them unless --no-start, or unless the configuration is unfinished and --start is not given)
#
# A fresh install (no workstation.toml yet) writes the configuration from the example and does NOT start the services,
# nor does a run while the configuration is unfinished (no [auth] admin_logins, or no API key): the hub refuses to
# start without an admin, and no session can start without the key. Follow the next steps it prints, then start the
# services (or rerun this script with --start).
#
# The Anthropic API key is NOT created here: put it in /etc/agent-workstation/anthropic.env yourself (one line,
# ANTHROPIC_API_KEY=sk-ant-...; file owned by workstation, mode 0600). Without it no session can start.
#
# What it deliberately does NOT do: install Tailscale, configure a firewall or harden sshd (see deploy/README.md).
#
# The agent firewall (deploy/workstation-agent-firewall) is part of the install, as defense in depth: it blocks the agent
# account from nginx (ports 80 and 443 of this machine) and from the hub and status TCP ports ([server] port, [status]
# port), which are unused in production. The install fails when it cannot be applied. After changing either port, run
# this script again.
#
# Environment overrides: CLAUDE_CODE_VERSION (the Claude Code release installed for the agent account; default: the
# version bundled with the deployed Agent SDK, else 2.1.316), WORKSTATION_SERVICE_USER (workstation), WORKSTATION_AGENT_USER (workstation-agent),
# WORKSTATION_WORK_GROUP (workstation-work), WORKSTATION_DIR (/opt/agent-workstation), WORKSTATION_DATA_DIR
# (/var/lib/agent-workstation), WORKSTATION_CONF_DIR (/etc/agent-workstation).
set -euo pipefail

SERVICE_USER="${WORKSTATION_SERVICE_USER:-workstation}"
AGENT_USER="${WORKSTATION_AGENT_USER:-workstation-agent}"
WORK_GROUP="${WORKSTATION_WORK_GROUP:-workstation-work}"
APP_DIR="${WORKSTATION_DIR:-/opt/agent-workstation}"
DATA_DIR="${WORKSTATION_DATA_DIR:-/var/lib/agent-workstation}"
CONF_DIR="${WORKSTATION_CONF_DIR:-/etc/agent-workstation}"
UNIT_DIR="/etc/systemd/system"
SERVICES=(workstation-hub workstation-status)
PROXY_GROUP="workstation-proxy" # the default of [server] proxy_group; the units create the sockets with it
WRAPPER="$APP_DIR/bin/workstation-agent-exec"
CLAUDE_DIR="$APP_DIR/claude"
CLAUDE_BIN="$CLAUDE_DIR/bin/claude"
SUDOERS_FILE="/etc/sudoers.d/workstation-agent"
SMARTCTL_BIN="/usr/sbin/smartctl" # the path workstation-status's check calls (packages/status/src/health/checks.ts)

START=1
FORCE_START=0
NGINX=1
SYSCTL=0
NGINX_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START=0 ;;
    --start) FORCE_START=1 ;;
    --no-nginx) NGINX=0 ;;
    --sysctl) SYSCTL=1 ;;
    --insecure-http|--disable-default-site) NGINX_ARGS+=("$1") ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      echo "Flags: --start (start the services even though the configuration is unfinished), --no-start (enable but do not start), --no-nginx (no nginx / Tailscale setup), --sysctl (also raise inotify limits), --insecure-http (nginx: plain HTTP when there is no certificate), --disable-default-site (nginx: also disable a modified default site)"
      exit 0
      ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---- preflight --------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "this script installs systemd units and must run on the Linux server, not on a Mac"
[ -d /run/systemd/system ] || die "systemd is not running on this host"
command -v apt-get >/dev/null 2>&1 || die "apt-get not found: this script supports Debian and Ubuntu"
case "$(uname -m)" in
  aarch64|arm64) NODE_ARCH=arm64 ;;
  x86_64|amd64) NODE_ARCH=x64 ;;
  *) die "unsupported CPU architecture $(uname -m) (arm64 and x86-64 are supported)" ;;
esac
[ "$(id -u)" -ne 0 ] || die "run as the admin account, not as root; the script uses sudo where it needs to"
ADMIN_USER="$(id -un)"
case "$ADMIN_USER" in
  "$SERVICE_USER"|"$AGENT_USER") die "run as the admin account that deploys, not as $ADMIN_USER" ;;
esac
sudo -n true 2>/dev/null || die "passwordless sudo is required for $ADMIN_USER"
for name in "$SERVICE_USER" "$AGENT_USER" "$WORK_GROUP"; do
  [[ $name =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "not a valid account/group name: $name"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---- packages ---------------------------------------------------------------
# curl, git (sync), tmux (terminals), bubblewrap (the sandbox of chats' commands and downloads), xz-utils (Node's
# tarball), build tools and python3 (better-sqlite3 and node-pty compile when no prebuilt binary fits), sudo, rsync,
# iptables (the agent firewall).
PACKAGES=(ca-certificates curl git tmux bubblewrap xz-utils build-essential python3 sudo rsync iptables)
[ "$NGINX" -eq 0 ] || PACKAGES+=(nginx)
missing=()
for p in "${PACKAGES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ "${#missing[@]}" -gt 0 ]; then
  say "apt: installing ${missing[*]}"
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq --no-install-recommends "${missing[@]}"
fi
command -v visudo >/dev/null 2>&1 || [ -x /usr/sbin/visudo ] || die "visudo not found (install the sudo package)"

# ---- Node 22 ----------------------------------------------------------------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""
for c in /usr/local/bin/node "$(command -v node || true)"; do
  if [ -n "$c" ] && [ -x "$c" ] && [ "$(node_major "$c")" -ge 22 ]; then NODE_BIN="$c"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  say "installing Node 22 from nodejs.org (linux-$NODE_ARCH, integrity checked against SHASUMS256.txt)"
  base="https://nodejs.org/dist/latest-v22.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "could not download $base/SHASUMS256.txt"
  tarball="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$NODE_ARCH\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n 1)"
  [ -n "$tarball" ] || die "no Node 22 tarball for linux-$NODE_ARCH in $base/SHASUMS256.txt"
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball" || die "could not download $base/$tarball"
  (cd "$tmp" && grep -F " $tarball" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "checksum mismatch for $tarball"
  node_dir="/opt/${tarball%.tar.xz}"
  sudo mkdir -p "$node_dir"
  sudo tar -xJf "$tmp/$tarball" -C "$node_dir" --strip-components=1
  for b in node npm npx corepack; do sudo ln -sfn "$node_dir/bin/$b" "/usr/local/bin/$b"; done
  NODE_BIN=/usr/local/bin/node
fi
[ "$(node_major "$NODE_BIN")" -ge 22 ] || die "Node $("$NODE_BIN" -v) is too old; Node 22 or newer is required"
if [ ! -x /usr/local/bin/node ]; then
  say "linking /usr/local/bin/node -> $NODE_BIN (the units' ExecStart)"
  sudo ln -s "$NODE_BIN" /usr/local/bin/node
fi
NPM_BIN="$(dirname "$(readlink -f "$NODE_BIN")")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"

# ---- accounts -------------------------------------------------------------------------
say "accounts: $SERVICE_USER (services), $AGENT_USER (AI processes), group $WORK_GROUP"
getent group "$WORK_GROUP" >/dev/null || sudo groupadd --system "$WORK_GROUP"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  sudo useradd --system --user-group --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
if ! id "$AGENT_USER" >/dev/null 2>&1; then
  # A normal (non-system) login shell account, so `sudo -u workstation-agent -i` works for maintenance; no password.
  sudo useradd --user-group --create-home --home-dir "/home/$AGENT_USER" --shell /bin/bash "$AGENT_USER"
fi
for u in "$SERVICE_USER" "$AGENT_USER"; do
  id -nG "$u" | tr ' ' '\n' | grep -qx "$WORK_GROUP" || sudo usermod -aG "$WORK_GROUP" "$u"
  for g in sudo admin wheel; do
    if id -nG "$u" | tr ' ' '\n' | grep -qx "$g"; then
      warn "removing $u from group $g (it must not have general sudo)"
      sudo gpasswd -d "$u" "$g" >/dev/null
    fi
  done
done
# The sockets' group: the hub and the status service (the service account) create their public sockets in it, and nginx's
# worker account connects through it. The agent account must never be a member: that is what keeps it off the hub.
getent group "$PROXY_GROUP" >/dev/null || sudo groupadd --system "$PROXY_GROUP"
id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx "$PROXY_GROUP" || sudo usermod -aG "$PROXY_GROUP" "$SERVICE_USER"
NGINX_USER=""
if command -v nginx >/dev/null 2>&1 || [ -x /usr/sbin/nginx ]; then
  NGINX_USER="$(sudo nginx -T 2>/dev/null | sed -n 's/^[[:space:]]*user[[:space:]][[:space:]]*\([^[:space:];]*\).*/\1/p' | head -n 1)"
  NGINX_USER="${NGINX_USER:-www-data}"
  if id "$NGINX_USER" >/dev/null 2>&1; then
    [ "$NGINX_USER" != "$AGENT_USER" ] || die "nginx runs as the agent account $AGENT_USER; the agent account must not be able to connect to the hub's sockets"
    id -nG "$NGINX_USER" | tr ' ' '\n' | grep -qx "$PROXY_GROUP" || sudo usermod -aG "$PROXY_GROUP" "$NGINX_USER"
  else
    warn "nginx's worker account $NGINX_USER does not exist; add nginx's account to group $PROXY_GROUP once nginx is installed (deploy/nginx-tailscale.sh does)"
    NGINX_USER=""
  fi
fi
if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx "$PROXY_GROUP"; then
  die "the agent account $AGENT_USER is in group $PROXY_GROUP, which can connect to the hub's sockets; remove it (sudo gpasswd -d $AGENT_USER $PROXY_GROUP) and run this script again"
fi
say "socket group $PROXY_GROUP: $SERVICE_USER${NGINX_USER:+, $NGINX_USER} (not $AGENT_USER)"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] && [ -n "$AGENT_HOME" ] || die "cannot determine the home directories of $SERVICE_USER / $AGENT_USER"
# The hub's home (browser caches, npm) stays private to it.
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$SERVICE_HOME"

# ---- directories, config ------------------------------------------------------
say "directories"
sudo install -d -o "$ADMIN_USER" -g "$ADMIN_USER" -m 0755 "$APP_DIR"
sudo install -d -o root -g root -m 0755 "$APP_DIR/bin"
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$CONF_DIR"

FRESH=0
if ! sudo test -e "$CONF_DIR/workstation.toml"; then
  FRESH=1
  example="$APP_DIR/config/workstation.example.toml"
  if [ -f "$example" ]; then
    say "creating $CONF_DIR/workstation.toml from the example (set admin_logins in it before the first start)"
    sudo install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0640 "$example" "$CONF_DIR/workstation.toml"
  else
    warn "$example not found; run deploy/deploy.sh first so the repo is on the machine. The services will use built-in defaults."
  fi
else
  say "keeping existing $CONF_DIR/workstation.toml"
fi
# Config and API key: the service account only (the agent account must not read them).
for f in "$CONF_DIR/workstation.toml" "$CONF_DIR/anthropic.env"; do
  sudo test -e "$f" || continue
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$f"
done
if sudo test -e "$CONF_DIR/workstation.toml"; then sudo chmod 0640 "$CONF_DIR/workstation.toml"; fi
if sudo test -e "$CONF_DIR/anthropic.env"; then sudo chmod 0600 "$CONF_DIR/anthropic.env"; fi

USERS_ROOT="/srv/agent-workstation/users"
PLUGINS_DIR="/var/lib/agent-workstation-plugins" # [paths] agent_plugins_dir
HUB_PORT=9000    # [server] port
STATUS_PORT=9100 # [status] port
NVME_DEVICE="nvme0n1" # [status] nvme_device, the disk workstation-status runs smartctl on
if sudo test -r "$CONF_DIR/workstation.toml"; then
  # The services run as $SERVICE_USER, which has no Claude install: AI processes must run as the agent.
  if ! sudo grep -qE '^[[:space:]]*\[agents\]' "$CONF_DIR/workstation.toml"; then
    say "adding [agents] run_as = \"$AGENT_USER\" to $CONF_DIR/workstation.toml"
    printf '\n[agents]\n# Claude Code and terminal shells run as this account (added by install.sh).\nrun_as = "%s"\nexec = "%s"\n' \
      "$AGENT_USER" "$WRAPPER" | sudo tee -a "$CONF_DIR/workstation.toml" >/dev/null
  elif sudo grep -qE '^[[:space:]]*run_as[[:space:]]*=[[:space:]]*""' "$CONF_DIR/workstation.toml"; then
    say "setting [agents] run_as = \"$AGENT_USER\" in $CONF_DIR/workstation.toml"
    sudo sed -i -E "s/^([[:space:]]*run_as[[:space:]]*=[[:space:]]*)\"\"/\\1\"$AGENT_USER\"/" "$CONF_DIR/workstation.toml"
  elif ! sudo grep -qE '^[[:space:]]*run_as[[:space:]]*=' "$CONF_DIR/workstation.toml"; then
    say "adding run_as = \"$AGENT_USER\" to [agents] in $CONF_DIR/workstation.toml"
    sudo sed -i -E "/^[[:space:]]*\\[agents\\]/a run_as = \"$AGENT_USER\"" "$CONF_DIR/workstation.toml"
  fi
  if ! sudo grep -qE "^[[:space:]]*run_as[[:space:]]*=[[:space:]]*\"$AGENT_USER\"" "$CONF_DIR/workstation.toml"; then
    warn "$CONF_DIR/workstation.toml: [agents] run_as is not \"$AGENT_USER\"; the hub will not use the agent account"
  fi
  if sudo grep -qE '^[[:space:]]*exec[[:space:]]*=' "$CONF_DIR/workstation.toml" && ! sudo grep -qE "^[[:space:]]*exec[[:space:]]*=[[:space:]]*\"$WRAPPER\"" "$CONF_DIR/workstation.toml"; then
    warn "$CONF_DIR/workstation.toml: [agents] exec is not \"$WRAPPER\" (the only command the sudoers rule allows)"
  fi
  # The ports of the hub and the status service, for the agent firewall (the value of `port` inside each section).
  if sudo awk '/^[[:space:]]*\[/ { in_sec = ($0 ~ "^[[:space:]]*\\[server\\]") } in_sec && /^[[:space:]]*listen[[:space:]]*=[[:space:]]*"tcp"/ { found = 1 } END { exit !found }' "$CONF_DIR/workstation.toml"; then
    warn "$CONF_DIR/workstation.toml: [server] listen = \"tcp\" is for development machines; the hub refuses to start with it while [agents] run_as is set. Remove the line (the default in production is \"unix\")."
  fi
  conf_port() {
    sudo awk -v sec="$1" '/^[[:space:]]*\[/ { in_sec = ($0 ~ "^[[:space:]]*\\[" sec "\\]") } in_sec && /^[[:space:]]*port[[:space:]]*=/ { v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]*(#.*)?$/, "", v); print v; exit }' "$CONF_DIR/workstation.toml"
  }
  p="$(conf_port server)"; [ -z "$p" ] || HUB_PORT="$p"
  p="$(conf_port status)"; [ -z "$p" ] || STATUS_PORT="$p"
  nvme_conf="$(sudo sed -nE 's/^[[:space:]]*nvme_device[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' "$CONF_DIR/workstation.toml" | head -n 1)"
  [ -z "$nvme_conf" ] || NVME_DEVICE="$nvme_conf"
  configured="$(sudo sed -nE 's/^[[:space:]]*users_root[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' "$CONF_DIR/workstation.toml" | head -n 1)"
  [ -z "$configured" ] || USERS_ROOT="$configured"
  configured="$(sudo sed -nE 's/^[[:space:]]*agent_plugins_dir[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' "$CONF_DIR/workstation.toml" | head -n 1)"
  [ -z "$configured" ] || PLUGINS_DIR="$configured"
  while IFS= read -r line; do
    warn "$CONF_DIR/workstation.toml: '$line' points outside $AGENT_HOME; with run_as the hub must read the agent's files. Remove the line (the default follows run_as)."
  done < <(sudo grep -E '^[[:space:]]*claude_home[[:space:]]*=' "$CONF_DIR/workstation.toml" | grep -v "\"$AGENT_HOME/" || true)
fi
case "$USERS_ROOT" in
  /*) ;;
  *) die "users_root must be an absolute path, got '$USERS_ROOT'" ;;
esac
for port in "$HUB_PORT" "$STATUS_PORT"; do
  [[ $port =~ ^[0-9]{1,5}$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "[server] port / [status] port must be numbers from 1 to 65535, got '$port'"
done
[[ $NVME_DEVICE =~ ^[a-z0-9]+$ ]] || die "[status] nvme_device must be a plain device name (e.g. nvme0n1), got '$NVME_DEVICE'"

case "$PLUGINS_DIR" in
  /*) ;;
  *) die "[paths] agent_plugins_dir must be an absolute path, got '$PLUGINS_DIR'" ;;
esac

# ---- shared workspaces ------------------------------------------------------------
say "workspaces: $USERS_ROOT (group $WORK_GROUP, setgid, g+rw)"
sudo install -d -o "$SERVICE_USER" -g "$WORK_GROUP" -m 2770 "$USERS_ROOT"

# ---- generated plugins: the hub writes, the agent account only reads ----------------------
# The hub publishes the skills, commands and agents it passes to Claude Code here. The folder is the hub's (0750, group
# read for the agent through $WORK_GROUP, no group write, no setgid) and every parent must be root-owned and not writable by
# others, so the agent account can neither change a plugin nor rename a folder to put its own in place.
say "generated plugins: $PLUGINS_DIR ($SERVICE_USER writes, $WORK_GROUP reads)"
sudo install -d -o "$SERVICE_USER" -g "$WORK_GROUP" -m 0750 "$PLUGINS_DIR"
sudo chown "$SERVICE_USER:$WORK_GROUP" "$PLUGINS_DIR"
sudo chmod 0750 "$PLUGINS_DIR"
p="$(dirname "$PLUGINS_DIR")"
while :; do
  info="$(sudo stat -c '%U %a' "$p")"
  [ "${info%% *}" = root ] && [ $((8#${info##* } & 8#022)) -eq 0 ] || die "$p must be owned by root and not writable by group or others (it holds $PLUGINS_DIR, which the agent account must not be able to replace)"
  [ "$p" = / ] && break
  p="$(dirname "$p")"
done

# ---- the agent's home: logins private, transcripts shared ---------------------------------
say "agent home: $AGENT_HOME (private, the transcript folder shared with $SERVICE_USER)"
as_agent() { sudo -u "$AGENT_USER" -- "$@"; }
sudo chgrp "$WORK_GROUP" "$AGENT_HOME"
sudo chmod 0710 "$AGENT_HOME"
sudo install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0755 "$AGENT_HOME/.local" "$AGENT_HOME/.local/bin"
# Enter-only for the hub: it reaches the shared folder below but cannot list or read what is next to it.
sudo install -d -o "$AGENT_USER" -g "$WORK_GROUP" -m 0710 "$AGENT_HOME/.claude"
sudo install -d -o "$AGENT_USER" -g "$WORK_GROUP" -m 2770 "$AGENT_HOME/.claude/projects"
# Claude ages transcripts out after 30 days unless told otherwise (every session also passes this setting).
if ! sudo test -e "$AGENT_HOME/.claude/settings.json"; then
  printf '{\n  "cleanupPeriodDays": 36500\n}\n' | as_agent tee "$AGENT_HOME/.claude/settings.json" >/dev/null
elif ! sudo grep -q cleanupPeriodDays "$AGENT_HOME/.claude/settings.json"; then
  warn "$AGENT_HOME/.claude/settings.json has no cleanupPeriodDays; add \"cleanupPeriodDays\": 36500 so transcripts are kept"
fi

# ---- Claude Code for the agent account ----------------------------------------------------
# Pinned: the release the deployed Agent SDK bundles (its package.json "claudeCodeVersion"), unless CLAUDE_CODE_VERSION
# says otherwise. A fresh checkout without node_modules falls back to the version this script was written against.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-}"
if [ -z "$CLAUDE_CODE_VERSION" ] && [ -f "$APP_DIR/packages/hub/node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]; then
  CLAUDE_CODE_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).claudeCodeVersion || ""' "$APP_DIR/packages/hub/node_modules/@anthropic-ai/claude-agent-sdk/package.json" 2>/dev/null || true)"
fi
if [ -z "$CLAUDE_CODE_VERSION" ] && [ -f "$APP_DIR/node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]; then
  CLAUDE_CODE_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).claudeCodeVersion || ""' "$APP_DIR/node_modules/@anthropic-ai/claude-agent-sdk/package.json" 2>/dev/null || true)"
fi
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.316}"
[[ $CLAUDE_CODE_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "CLAUDE_CODE_VERSION must look like 2.1.316, got '$CLAUDE_CODE_VERSION'"
# Installed root-owned outside the agent's home, so no process running as the agent account can patch the program every
# later session starts. The agent account may read and run it (0755) but not change it; its own auto-updater is off
# (the wrapper sets DISABLE_AUTOUPDATER=1).
CLAUDE_INSTALL_CMD="cd / && sudo $NPM_BIN install -g --prefix $CLAUDE_DIR @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
if sudo test -x "$CLAUDE_BIN"; then
  have="$(sudo -u "$AGENT_USER" -H env DISABLE_AUTOUPDATER=1 "$CLAUDE_BIN" --version 2>/dev/null | head -n 1 || true)"
  case "$have" in
    "$CLAUDE_CODE_VERSION"*) say "Claude Code $CLAUDE_CODE_VERSION is already installed ($CLAUDE_DIR)" ;;
    *) say "Claude Code is already installed (${have:-unknown version}); the pinned release is $CLAUDE_CODE_VERSION. To switch: $CLAUDE_INSTALL_CMD" ;;
  esac
else
  say "installing Claude Code $CLAUDE_CODE_VERSION (npm, root-owned $CLAUDE_DIR)"
  sudo install -d -o root -g root -m 0755 "$CLAUDE_DIR"
  if ! (cd / && sudo env HOME=/root PATH="/usr/local/bin:/usr/bin:/bin" "$NPM_BIN" install -g --prefix "$CLAUDE_DIR" --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"); then
    warn "installing Claude Code failed (network?); sessions cannot start until it is installed: $CLAUDE_INSTALL_CMD"
  fi
fi
if sudo test -d "$CLAUDE_DIR"; then
  # Root-owned and not writable by anyone else, whatever the package's file modes were.
  sudo chown -R root:root "$CLAUDE_DIR"
  sudo chmod -R go-w,a+rX "$CLAUDE_DIR"
fi
[ -x /usr/bin/bwrap ] || warn "/usr/bin/bwrap is missing: sudo apt install -y bubblewrap (chats' commands and downloads need it)"

# ---- agent wrapper + sudoers drop-in ------------------------------------------------
TMUX_BIN="$(command -v tmux || echo /usr/bin/tmux)"
sed -e "s#^AGENT_USER=.*#AGENT_USER=$AGENT_USER#" \
    -e "s#^AGENT_HOME=.*#AGENT_HOME=$AGENT_HOME#" \
    -e "s#^WORK_ROOT=.*#WORK_ROOT=$USERS_ROOT#" \
    -e "s#^PLUGINS_DIR=.*#PLUGINS_DIR=$PLUGINS_DIR#" \
    -e "s#^CLAUDE_BIN=.*#CLAUDE_BIN=$CLAUDE_BIN#" \
    -e "s#^TMUX_BIN=.*#TMUX_BIN=$TMUX_BIN#" \
    "$SCRIPT_DIR/workstation-agent-exec" > "$tmp/workstation-agent-exec"
bash -n "$tmp/workstation-agent-exec" || die "the rendered agent wrapper does not parse"
grep -qx "WORK_ROOT=$USERS_ROOT" "$tmp/workstation-agent-exec" || die "could not render the agent wrapper's settings"
if sudo cmp -s "$tmp/workstation-agent-exec" "$WRAPPER" 2>/dev/null; then
  say "agent wrapper $WRAPPER is up to date"
else
  say "installing agent wrapper $WRAPPER (root, 0755)"
  sudo install -o root -g root -m 0755 "$tmp/workstation-agent-exec" "$WRAPPER"
fi

SMARTCTL_RULE=""
if [ -x "$SMARTCTL_BIN" ] && [ -e "/dev/$NVME_DEVICE" ]; then
  SMARTCTL_RULE="$SERVICE_USER ALL=(root) NOPASSWD: $SMARTCTL_BIN -j -H -A /dev/$NVME_DEVICE"
fi
{
  echo "# Installed by deploy/install.sh. The hub's account may run the agent wrapper as the agent account, and"
  echo "# nothing else; the wrapper validates every argument. The optional second rule is the exact smartctl command of"
  echo "# workstation-status's nvme-smart check. Neither account has any other sudo rule."
  echo "$SERVICE_USER ALL=($AGENT_USER) NOPASSWD: $WRAPPER"
  [ -z "$SMARTCTL_RULE" ] || echo "$SMARTCTL_RULE"
} > "$tmp/sudoers"
sudo visudo -cf "$tmp/sudoers" >/dev/null || die "the sudoers drop-in does not validate (visudo -cf); nothing installed"
if sudo cmp -s "$tmp/sudoers" "$SUDOERS_FILE" 2>/dev/null; then
  say "sudoers drop-in $SUDOERS_FILE is up to date"
else
  say "installing sudoers drop-in $SUDOERS_FILE"
  sudo install -o root -g root -m 0440 "$tmp/sudoers" "$SUDOERS_FILE"
  if ! sudo visudo -c >/dev/null; then
    sudo rm -f "$SUDOERS_FILE"
    die "sudo's configuration does not validate with the drop-in; removed it again"
  fi
fi
# What the two accounts may do with sudo now (the agent: nothing; the hub: the wrapper and the one smartctl command).
if ! sudo -l -U "$AGENT_USER" 2>/dev/null | grep -q "not allowed to run sudo"; then
  warn "$AGENT_USER has sudo rules (sudo -l -U $AGENT_USER); remove them: the agent account must have no sudo"
fi
extra="$(sudo -l -U "$SERVICE_USER" 2>/dev/null | sed -n '/may run the following commands/,$p' | tail -n +2 | grep -vF -e "($AGENT_USER) NOPASSWD: $WRAPPER" -e "(root) NOPASSWD: $SMARTCTL_BIN -j -H -A /dev/$NVME_DEVICE" | grep -v '^[[:space:]]*$' || true)"
[ -z "$extra" ] || warn "$SERVICE_USER has sudo rules besides the agent wrapper (sudo -l -U $SERVICE_USER): $extra"

# ---- browser ------------------------------------------------------------------
# The hub (User=$SERVICE_USER, HOME=$SERVICE_HOME) launches Chromium from its own Playwright cache
# ($SERVICE_HOME/.cache/ms-playwright). Install the headless shell for the deployed playwright-core revision as that
# account (Playwright skips a revision it already has).
BROWSER_INSTALLER="$APP_DIR/packages/browser/scripts/install-browser.mjs"
if [ ! -f "$BROWSER_INSTALLER" ] || [ ! -d "$APP_DIR/node_modules/@playwright/mcp" ]; then
  warn "$BROWSER_INSTALLER or $APP_DIR/node_modules/@playwright/mcp is missing: deploy the repo first (deploy/deploy.sh), then run this script again so $SERVICE_USER gets the browser"
else
  say "browser: Playwright's headless shell for $SERVICE_USER ($SERVICE_HOME/.cache/ms-playwright)"
  sudo install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$SERVICE_HOME/.cache"
  # From / : the admin's cwd may not be readable by $SERVICE_USER. No PLAYWRIGHT_BROWSERS_PATH / XDG_CACHE_HOME from
  # the admin's shell; HOME is the service account's, as in the unit.
  if ! (cd / && sudo -u "$SERVICE_USER" -H -- env -u PLAYWRIGHT_BROWSERS_PATH -u XDG_CACHE_HOME HOME="$SERVICE_HOME" \
      "$NODE_BIN" "$BROWSER_INSTALLER" headless-shell); then
    warn "installing the browser for $SERVICE_USER failed (network?); browser tools stay off until it is installed: cd / && sudo -u $SERVICE_USER -H $NODE_BIN $BROWSER_INSTALLER"
  fi
fi

# ---- the socket folder ---------------------------------------------------------
# /run/agent-workstation holds hub.sock (0660, group workstation-proxy), hub-local.sock (0600) and status.sock (0660,
# group workstation-proxy). It is owned by tmpfiles.d, not by a RuntimeDirectory= of one unit: systemd may re-chown a
# RuntimeDirectory's contents when its ownership differs from the unit's, which would reset the public socket's group and
# lock nginx out; tmpfiles does not touch the sockets. The folder is 0755 and owned by $SERVICE_USER so the agent account
# can look at it but create nothing in it. (workstation-hub-prestart creates it as well, in case it was removed.)
say "socket folder /run/agent-workstation (tmpfiles.d, $SERVICE_USER, 0755)"
printf '# Installed by deploy/install.sh: the folder of the hub and status sockets.\nd /run/agent-workstation 0755 %s %s -\n' "$SERVICE_USER" "$SERVICE_USER" | sudo tee /etc/tmpfiles.d/agent-workstation.conf >/dev/null
sudo systemd-tmpfiles --create /etc/tmpfiles.d/agent-workstation.conf

# ---- prestart helper ---------------------------------------------------------
say "installing /usr/local/sbin/workstation-hub-prestart"
sudo install -m 0755 -o root -g root "$SCRIPT_DIR/workstation-hub-prestart.sh" /usr/local/sbin/workstation-hub-prestart

# ---- units ----------------------------------------------------------------------
# The unit files in the repo use the defaults (workstation, workstation-work, /opt/agent-workstation). Render them for other values.
render_unit() {
  sed -e "s#/opt/agent-workstation#$APP_DIR#g" \
      -e "s#^User=workstation\$#User=$SERVICE_USER#" \
      -e "s#^Group=workstation\$#Group=$SERVICE_USER#" \
      -e "s#^SupplementaryGroups=workstation-work\$#SupplementaryGroups=$WORK_GROUP#" \
      -e "s#^Environment=WORKSTATION_SERVICE_USER=workstation\$#Environment=WORKSTATION_SERVICE_USER=$SERVICE_USER#" \
      -e "s#^Environment=WORKSTATION_WORK_GROUP=workstation-work\$#Environment=WORKSTATION_WORK_GROUP=$WORK_GROUP#" \
      -e "s#/etc/agent-workstation/workstation.toml#$CONF_DIR/workstation.toml#g" \
      "$1"
}

UNITS_CHANGED=0
for svc in "${SERVICES[@]}"; do
  src="$SCRIPT_DIR/systemd/$svc.service"
  [ -f "$src" ] || die "missing $src"
  render_unit "$src" > "$tmp/$svc.service"
  if sudo cmp -s "$tmp/$svc.service" "$UNIT_DIR/$svc.service" 2>/dev/null; then
    say "unit $svc.service is up to date"
  else
    say "installing unit $svc.service"
    sudo install -m 0644 -o root -g root "$tmp/$svc.service" "$UNIT_DIR/$svc.service"
    UNITS_CHANGED=1
  fi
done
if [ "$UNITS_CHANGED" -eq 1 ]; then
  say "systemctl daemon-reload"
  sudo systemctl daemon-reload
fi

# ---- agent firewall (defense in depth) ----------------------------------------------
# The hub is reachable only through Unix sockets the agent account cannot open; this adds a second layer. Always on, also
# with --no-start: outbound TCP from $AGENT_USER to the hub ($HUB_PORT) and status ($STATUS_PORT) ports is rejected (unused
# in production), and so is TCP to ports 80 and 443 of any local address, nginx's (deploy/workstation-agent-firewall).
# Own chain + one OUTPUT jump only; inbound traffic and other rules untouched. The install fails when it cannot be applied.
if ! command -v iptables >/dev/null 2>&1 && ! sudo test -x /usr/sbin/iptables; then
  die "iptables is not installed (sudo apt install -y iptables): the agent firewall cannot be applied"
fi
BLOCKED_PORTS="$HUB_PORT,$STATUS_PORT"
[ "$HUB_PORT" != "$STATUS_PORT" ] || BLOCKED_PORTS="$HUB_PORT"
say "agent firewall: $AGENT_USER cannot connect to ports $BLOCKED_PORTS or to ports 80 and 443 of this machine (nginx)"
sudo install -m 0755 -o root -g root "$SCRIPT_DIR/workstation-agent-firewall" /usr/local/sbin/workstation-agent-firewall
sed -e "s#^ExecStart=/usr/local/sbin/workstation-agent-firewall start\$#Environment=WORKSTATION_AGENT_USER=$AGENT_USER\nEnvironment=WORKSTATION_AGENT_BLOCKED_PORTS=$BLOCKED_PORTS\nExecStart=/usr/local/sbin/workstation-agent-firewall start#" \
  "$SCRIPT_DIR/systemd/workstation-agent-firewall.service" > "$tmp/workstation-agent-firewall.service"
grep -q "^Environment=WORKSTATION_AGENT_BLOCKED_PORTS=$BLOCKED_PORTS\$" "$tmp/workstation-agent-firewall.service" || die "could not render the agent firewall unit"
if ! sudo cmp -s "$tmp/workstation-agent-firewall.service" "$UNIT_DIR/workstation-agent-firewall.service" 2>/dev/null; then
  sudo install -m 0644 -o root -g root "$tmp/workstation-agent-firewall.service" "$UNIT_DIR/workstation-agent-firewall.service"
  sudo systemctl daemon-reload
fi
sudo systemctl enable workstation-agent-firewall.service >/dev/null 2>&1 || die "could not enable workstation-agent-firewall (journalctl -u workstation-agent-firewall)"
sudo systemctl restart workstation-agent-firewall.service || die "workstation-agent-firewall failed to start (journalctl -u workstation-agent-firewall)"
sudo systemctl is-active --quiet workstation-agent-firewall.service || die "workstation-agent-firewall is not active after starting it"
sudo /usr/local/sbin/workstation-agent-firewall status | sed 's/^/  /'

# ---- optional: inotify limits -------------------------------------------------
if [ "$SYSCTL" -eq 1 ]; then
  say "raising inotify limits (/etc/sysctl.d/90-workstation.conf)"
  printf 'fs.inotify.max_user_watches = 524288\nfs.inotify.max_user_instances = 1024\n' | sudo tee /etc/sysctl.d/90-workstation.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/90-workstation.conf >/dev/null
fi

# ---- nginx on the Tailscale address -----------------------------------------------------
NGINX_NOTE=""
if [ "$NGINX" -eq 1 ]; then
  if command -v tailscale >/dev/null 2>&1 && TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1)" && [ -n "$TS_IP" ]; then
    TS_NAME="$(tailscale status --json 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).Self.DNSName;process.stdout.write(String(n||"").replace(/\.$/,""))}catch{}})' || true)"
    say "nginx on the Tailscale address $TS_IP${TS_NAME:+ ($TS_NAME)}"
    if WORKSTATION_AGENT_USER="$AGENT_USER" bash "$SCRIPT_DIR/nginx-tailscale.sh" ${NGINX_ARGS[@]+"${NGINX_ARGS[@]}"} "$TS_IP" "$TS_NAME"; then
      NGINX_NOTE="nginx listens on $TS_IP and proxies to the hub and status service through their Unix sockets in /run/agent-workstation."
    else
      warn "the nginx setup stopped (see above); nothing listens on the tailnet yet. Fix what it says and run this script again (flags --insecure-http and --disable-default-site are passed on to it)."
    fi
  else
    warn "Tailscale is not installed or not connected: nginx was not set up. Install Tailscale (https://tailscale.com/download), join your tailnet, then run this script again."
  fi
fi

# ---- enable / start -------------------------------------------------------------
# Not started before the operator has configured it: the hub refuses to start without an admin login (Tailscale
# identity is on by default) and no session can start without the API key. A fresh install, or one whose configuration
# is still unfinished, is enabled but held, unless --start says otherwise.
CONFIG_READY=0
if sudo test -r "$CONF_DIR/workstation.toml" \
  && { sudo grep -Eq '^[[:space:]]*tailscale_identity[[:space:]]*=[[:space:]]*false' "$CONF_DIR/workstation.toml" \
    || sudo grep -Eq '^[[:space:]]*admin_logins[[:space:]]*=[[:space:]]*\[[^]]*"' "$CONF_DIR/workstation.toml"; } \
  && sudo test -s "$CONF_DIR/anthropic.env"; then
  CONFIG_READY=1
fi
HOLD_NOTE=0
if [ "$START" -eq 1 ] && [ "$FORCE_START" -eq 0 ] && { [ "$FRESH" -eq 1 ] || [ "$CONFIG_READY" -eq 0 ]; }; then
  START=0
  HOLD_NOTE=1
fi
for svc in "${SERVICES[@]}"; do
  if [ "$START" -eq 1 ]; then
    say "enable --now $svc"
    sudo systemctl enable --now "$svc.service"
  else
    say "enable $svc (not starting)"
    sudo systemctl enable "$svc.service"
  fi
done

# ---- warnings about missing build output and the key ------------------------------------
[ -f "$APP_DIR/packages/hub/dist/main.js" ] || warn "$APP_DIR/packages/hub/dist/main.js is missing: workstation-hub cannot start until the repo is deployed (deploy/deploy.sh)"
[ -f "$APP_DIR/packages/status/dist/main.js" ] || warn "$APP_DIR/packages/status/dist/main.js is missing: workstation-status cannot start until the repo is deployed"
[ -d "$APP_DIR/node_modules" ] || warn "$APP_DIR/node_modules is missing: run 'npm ci --omit=dev' in $APP_DIR (deploy.sh does this)"
sudo test -s "$CONF_DIR/anthropic.env" || warn "$CONF_DIR/anthropic.env is missing or empty: create it (ANTHROPIC_API_KEY=sk-ant-..., file owned by $SERVICE_USER, mode 0600). No session can start without the key."

echo
for svc in "${SERVICES[@]}"; do
  printf '%-18s enabled=%s active=%s\n' "$svc" "$(systemctl is-enabled "$svc" 2>/dev/null || true)" "$(systemctl is-active "$svc" 2>/dev/null || true)"
done
echo
[ -z "$NGINX_NOTE" ] || echo "$NGINX_NOTE"
echo "Not touched: Tailscale itself, a firewall, sshd hardening. See $APP_DIR/deploy/README.md."
if [ "$HOLD_NOTE" -eq 1 ]; then
  cat <<NEXT

The services are enabled but not started: the configuration is not finished. Next steps:
  1. API key:  sudo install -o $SERVICE_USER -g $SERVICE_USER -m 0600 /dev/null $CONF_DIR/anthropic.env
               sudoedit $CONF_DIR/anthropic.env     (one line: ANTHROPIC_API_KEY=sk-ant-...)
  2. Admin:    sudoedit $CONF_DIR/workstation.toml  (set [auth] admin_logins = ["you@example.com"], your Tailscale login;
               the hub refuses to start while it is empty. Review the other settings in the same file.)
  3. Start:    sudo systemctl start workstation-hub workstation-status
               (or run this script again with --start)
NEXT
else
  echo "API key: sudoedit $CONF_DIR/anthropic.env (ANTHROPIC_API_KEY=sk-ant-...), then: sudo systemctl kill --kill-who=main -s HUP workstation-hub"
fi
