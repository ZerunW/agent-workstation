#!/usr/bin/env bash
# Build Agent Workstation on this (Mac or Linux) development machine, ship it to the server and restart the services.
#
#   WORKSTATION_HOST=server.example.com WORKSTATION_USER=admin bash deploy/deploy.sh    # full deploy (or: npm run deploy)
#   bash deploy/deploy.sh --no-install    # skip `npm ci` on the server when the package files are unchanged
#   bash deploy/deploy.sh --no-build      # reuse the existing build output
#   bash deploy/deploy.sh --dry-run       # show what rsync would transfer, change nothing
#
# Steps
#   1. `npm run build` at the repo root (protocol, web, hub, status)
#   2. ssh preflight; make sure /opt/agent-workstation exists (owned by the deploying admin; /var/lib/agent-workstation belongs
#      to the `workstation` service account and is created by install.sh); copy deploy/ and the example config there (over
#      tar and ssh: a minimal server has no rsync yet) and run `install.sh --no-start --no-nginx` first, every time, so
#      the packages (rsync, build tools, Node 22), the accounts and the units exist before the repo is shipped
#   3. rsync the repo to <user>@<host>:/opt/agent-workstation, excluding node_modules, .build, apps/mac, data,
#      *.sqlite*, config/workstation.toml, /bin (the root-owned agent wrapper), /claude (the root-owned Claude Code install), /releases (the published Mac app)
#      (server-local files are never deleted)
#      then publish the Mac app from apps/mac/dist (scripts/make-app.sh): AgentWorkstation-arm64.dmg + release-arm64.json
#      (or the old AgentWorkstation.dmg + release.json) as `mac`, AgentWorkstation-intel.dmg + release-intel.json as `mac-intel`, each to
#      <dir>/releases/<platform>/<version>-<build>/ (dmg first, release.json last; a version already there is kept
#      as is, nothing is ever deleted); skipped quietly when absent
#   4. on the server: `npm ci --omit=dev --no-audit --no-fund` (native modules better-sqlite3 and node-pty compile there,
#      so the server needs Node 22, build-essential and python3: install.sh installs them, so run it once first). With
#      --no-install this is skipped when package-lock.json and the package.json files are unchanged AND the server's Node
#      version is the same (checksum stored in /opt/agent-workstation/.deploy-lock.sha256)
#   5. on the server: deploy/install.sh --no-start (units, config, nginx, helper; reloads systemd if units changed)
#   6. restart the services, wait, print `systemctl status` and, on failure, the last 20 journal lines. A server whose
#      configuration is not finished (no [auth] admin_logins, Tailscale identity on) is not restarted: the hub would
#      refuse to start; the script prints what to do instead
#
# Environment
#   WORKSTATION_HOST       server address or name           (required)
#   WORKSTATION_USER       ssh and admin user               (default: your current user name)
#   WORKSTATION_DIR        install directory on the server  (default /opt/agent-workstation)
#   WORKSTATION_SERVICES   services to restart and check    (default "workstation-hub workstation-status")
#   WORKSTATION_SSH_OPTS   extra ssh options, e.g. "-i ~/.ssh/id_ed25519 -p 2222"
#   WORKSTATION_BUILD_CMD  build command                    (default "npm run build")
#   WORKSTATION_CONF_DIR   configuration folder on the server (default /etc/agent-workstation)
#   WORKSTATION_RUN_DIR    directory of the services' Unix sockets on the server (default /run/agent-workstation); the
#                          final smoke check asks hub-local.sock and status.sock there with `curl --unix-socket`
#
# Written for macOS's bash 3.2 and the stock openrsync: no associative arrays, no rsync --info flags.
set -euo pipefail

HOST="${WORKSTATION_HOST:-}"
REMOTE_USER="${WORKSTATION_USER:-$(id -un)}"
DIR="${WORKSTATION_DIR:-/opt/agent-workstation}"
SERVICES="${WORKSTATION_SERVICES:-workstation-hub workstation-status}"
SSH_EXTRA="${WORKSTATION_SSH_OPTS:-}"
BUILD_CMD="${WORKSTATION_BUILD_CMD:-npm run build}"
CONF_DIR="${WORKSTATION_CONF_DIR:-/etc/agent-workstation}"
RUN_DIR="${WORKSTATION_RUN_DIR:-/run/agent-workstation}"

BUILD=1
INSTALL_MODE=always
RESTART=1
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --no-install) INSTALL_MODE=if-changed ;;
    --no-restart) RESTART=0 ;;
    --dry-run|-n) DRY=1 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "$HOST" ] || { echo "set WORKSTATION_HOST to the server to deploy to (try --help)" >&2; exit 2; }
TARGET="$REMOTE_USER@$HOST"
SSH_BASE=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# shellcheck disable=SC2086  # SSH_EXTRA is meant to be word-split
remote() { "${SSH_BASE[@]}" $SSH_EXTRA "$TARGET" "$@"; }

# Run a script read from stdin on the server with properly quoted positional arguments
# (ssh re-parses its command line on the far side, so plain "$@" would lose quoting).
remote_script() {
  local quoted=""
  local a
  for a in "$@"; do quoted="$quoted $(printf '%q' "$a")"; done
  remote "bash -s --$quoted"
}

cd "$ROOT"
[ -f package.json ] && [ -f package-lock.json ] || die "run this from an Agent Workstation checkout (package.json / package-lock.json not found in $ROOT)"

# ---- 1. build ------------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
  say "building: $BUILD_CMD"
  bash -c "$BUILD_CMD"
else
  say "skipping build (--no-build)"
fi
[ -f packages/status/dist/main.js ] || echo "WARNING: packages/status/dist/main.js is missing (build the status package)" >&2
[ -f packages/hub/dist/main.js ] || echo "WARNING: packages/hub/dist/main.js is missing; workstation-hub will not start on the server" >&2

# ---- 2. preflight ----------------------------------------------------------------
say "checking ssh to $TARGET"
remote true || die "cannot ssh to $TARGET with key authentication (set WORKSTATION_HOST / WORKSTATION_USER / WORKSTATION_SSH_OPTS)"

if [ "$DRY" -eq 0 ]; then
  remote "sudo -n install -d -o $REMOTE_USER -g $REMOTE_USER -m 0755 $DIR" || die "could not create $DIR on the server (passwordless sudo needed)"
fi

# ---- 2b. first: deploy/ and the example config, then install.sh -------------------------------
# A minimal server has neither rsync nor Node nor the accounts. Ship the scripts with tar over ssh, then let install.sh
# prepare the machine (packages, Node 22, accounts, units) before anything else is copied.
if [ "$DRY" -eq 0 ]; then
  say "preparing the server (install.sh --no-start --no-nginx)"
  COPYFILE_DISABLE=1 tar -C "$ROOT" -cf - deploy config/workstation.example.toml | remote "tar -xf - -C $DIR" || die "could not copy deploy/ to $TARGET:$DIR"
  remote "WORKSTATION_DIR=$DIR bash $DIR/deploy/install.sh --no-start --no-nginx" || die "install.sh failed on the server (see above)"
fi

# ---- 3. rsync -------------------------------------------------------------------------
RSYNC_ARGS=(-rlptz --delete
  --exclude node_modules
  --exclude .build
  --exclude /apps/mac
  --exclude /data
  --exclude '/packages/*/data'
  --exclude '*.sqlite*'
  --exclude /config/workstation.toml
  --exclude /bin
  --exclude /claude
  --exclude /releases
  --exclude /.deploy-lock.sha256
  --exclude .git
  --exclude .DS_Store
  --exclude '*.tsbuildinfo'
  --exclude .vite
  --exclude coverage
  --exclude test-results
  --exclude playwright-report
  --exclude dist-embed)
if [ "$DRY" -eq 1 ]; then RSYNC_ARGS+=(-n -v); say "rsync (dry run) to $TARGET:$DIR"; else say "rsync to $TARGET:$DIR"; fi

SSH_CMD="ssh -o BatchMode=yes -o ConnectTimeout=10 $SSH_EXTRA"
if [ "$DRY" -eq 1 ]; then
  rsync "${RSYNC_ARGS[@]}" -e "$SSH_CMD" "$ROOT/" "$TARGET:$DIR/"
  say "dry run finished; nothing changed on the server"
  exit 0
fi
rsync "${RSYNC_ARGS[@]}" -v -e "$SSH_CMD" "$ROOT/" "$TARGET:$DIR/" | tail -n 8

# ---- 3b. Mac app releases (only when scripts/make-app.sh has produced some) --------------------
# The hub serves $DIR/releases/<platform>/<version>-<build>/{AgentWorkstation.dmg,release.json} and keeps every version.
# apps/mac/dist/ may hold AgentWorkstation-arm64.dmg + release-arm64.json (platform mac) and AgentWorkstation-intel.dmg +
# release-intel.json (platform mac-intel); the old single AgentWorkstation.dmg + release.json still counts as mac.
# A release already on the server (its folder has a release.json) is left alone. In each folder the dmg goes up first
# and release.json last (both under a temp name, then moved), so the hub never sees a release.json without its dmg.
MAC_DIST="$ROOT/apps/mac/dist"

# publish_release <platform> <dmg> <release.json>
publish_release() {
  local platform="$1" dmg="$2" json="$3" name rel_dir
  # <version>-<build>, spelled as the hub spells it (version characters outside A-Za-z0-9._+- become _)
  name="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (typeof r.version !== "string" || !/^[0-9]{1,20}$/.test(String(r.build))) process.exit(1);
    process.stdout.write(r.version.replace(/[^A-Za-z0-9._+-]/g, "_") + "-" + r.build);
  ' "$json")" || die "cannot read version and build from $json"
  case "$name" in [A-Za-z0-9]*) ;; *) die "unusable release folder name '$name' from $json" ;; esac
  rel_dir="$DIR/releases/$platform/$name"
  if remote "test -f '$rel_dir/release.json'"; then
    echo "Mac app release $platform $name already on the server; left as is"
    return 0
  fi
  remote "mkdir -p '$rel_dir'"
  rsync -t -e "$SSH_CMD" "$dmg" "$TARGET:$rel_dir/.AgentWorkstation.dmg.tmp"
  remote "chmod 644 '$rel_dir/.AgentWorkstation.dmg.tmp' && mv -f '$rel_dir/.AgentWorkstation.dmg.tmp' '$rel_dir/AgentWorkstation.dmg'"
  rsync -t -e "$SSH_CMD" "$json" "$TARGET:$rel_dir/.release.json.tmp"
  remote "chmod 644 '$rel_dir/.release.json.tmp' && mv -f '$rel_dir/.release.json.tmp' '$rel_dir/release.json'"
  echo "Mac app release published: $dmg -> $TARGET:$rel_dir ($platform)"
}

if [ -f "$MAC_DIST/AgentWorkstation-arm64.dmg" ] && [ -f "$MAC_DIST/release-arm64.json" ]; then
  publish_release mac "$MAC_DIST/AgentWorkstation-arm64.dmg" "$MAC_DIST/release-arm64.json"
elif [ -f "$MAC_DIST/AgentWorkstation.dmg" ] && [ -f "$MAC_DIST/release.json" ]; then
  publish_release mac "$MAC_DIST/AgentWorkstation.dmg" "$MAC_DIST/release.json"
fi
if [ -f "$MAC_DIST/AgentWorkstation-intel.dmg" ] && [ -f "$MAC_DIST/release-intel.json" ]; then
  publish_release mac-intel "$MAC_DIST/AgentWorkstation-intel.dmg" "$MAC_DIST/release-intel.json"
fi

# ---- 4. npm ci -----------------------------------------------------------------------
LOCK_SUM="$(cat package-lock.json package.json packages/*/package.json | shasum -a 256 | cut -d' ' -f1)"
say "dependencies on the server (mode: $INSTALL_MODE)"
remote_script "$DIR" "$LOCK_SUM" "$INSTALL_MODE" "$SERVICES" <<'REMOTE'
set -euo pipefail
dir=$1; sum=$2; mode=$3; services=$4
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$dir"
# Not in /var/lib/agent-workstation: that belongs to the workstation service account, this runs as the deploying admin.
state="$dir/.deploy-lock.sha256"
want="$sum $(node -v)"
have="$(cat "$state" 2>/dev/null || true)"
if [ "$mode" = "if-changed" ] && [ "$want" = "$have" ] && [ -d node_modules/better-sqlite3 ]; then
  echo "npm ci skipped: package files and Node version unchanged ($(node -v))"
  exit 0
fi
# npm ci replaces node_modules: stop the services first so nothing runs against a half-installed tree.
for s in $services; do sudo -n systemctl stop "$s" 2>/dev/null || true; done
npm ci --omit=dev --no-audit --no-fund
echo "$want" > "$state"
echo "npm ci done ($(node -v))"
REMOTE

# ---- 5. units, config, helper ------------------------------------------------------------
say "installing units and config (install.sh --no-start)"
remote "WORKSTATION_DIR=$DIR bash $DIR/deploy/install.sh --no-start"

# ---- 6. restart and verify ---------------------------------------------------------------
if [ "$RESTART" -eq 0 ]; then
  say "skipping restart (--no-restart)"
  exit 0
fi

# A fresh server: the hub refuses to start until an admin login is set (Tailscale identity is on by default).
CONFIGURED="$(remote_script "$CONF_DIR/workstation.toml" <<'REMOTE'
conf=$1
if sudo -n grep -Eq '^[[:space:]]*tailscale_identity[[:space:]]*=[[:space:]]*false' "$conf" 2>/dev/null; then echo yes
elif sudo -n grep -Eq '^[[:space:]]*admin_logins[[:space:]]*=[[:space:]]*\[[^]]*"' "$conf" 2>/dev/null; then echo yes
else echo no; fi
REMOTE
)"
if [ "$CONFIGURED" != "yes" ]; then
  say "deployed, not restarted: $CONF_DIR/workstation.toml has no [auth] admin_logins yet"
  echo "  The hub refuses to start without an admin (Tailscale identity is on). On the server:"
  echo "    sudoedit $CONF_DIR/workstation.toml     # [auth] admin_logins = [\"you@example.com\"]"
  echo "    sudoedit $CONF_DIR/anthropic.env        # ANTHROPIC_API_KEY=sk-ant-... (file owned by workstation, mode 0600)"
  echo "    sudo systemctl restart $SERVICES"
  exit 0
fi

say "restarting: $SERVICES"
# shellcheck disable=SC2086
remote "sudo -n systemctl restart $SERVICES"

say "verifying"
set +e
remote_script "$RUN_DIR" $SERVICES <<'REMOTE'
set +e
run_dir=$1; shift
for i in $(seq 1 25); do
  all=1
  for s in "$@"; do systemctl is-active --quiet "$s" || all=0; done
  [ "$all" -eq 1 ] && break
  sleep 1
done
# Give a crash-looping service time to show itself (Restart=always hides a crash from is-active).
sleep 4
bad=""
for s in "$@"; do
  state="$(systemctl is-active "$s")"
  restarts="$(systemctl show -p NRestarts --value "$s" 2>/dev/null)"
  if [ "$state" != "active" ] || [ "${restarts:-0}" != "0" ]; then bad="$bad $s"; fi
done
echo
for s in "$@"; do
  sudo -n systemctl --no-pager status "$s"
  echo
done
for s in $bad; do
  echo "----- last 20 journal lines of $s -----"
  sudo -n journalctl -u "$s" -n 20 --no-pager
  echo
done
# The sockets are not reachable by the admin account (the hub's local socket is 0600, the status socket is for nginx's
# group): ask them as root.
if sudo -n curl -fsS -m 5 --unix-socket "$run_dir/status.sock" "http://localhost/healthz" >/dev/null 2>&1; then echo "smoke: workstation-status answers on $run_dir/status.sock"; else echo "smoke: workstation-status does NOT answer on $run_dir/status.sock"; fi
if sudo -n curl -fsS -m 5 --unix-socket "$run_dir/hub-local.sock" "http://localhost/healthz" >/dev/null 2>&1; then echo "smoke: workstation-hub answers on $run_dir/hub-local.sock"; else echo "smoke: workstation-hub does NOT answer on $run_dir/hub-local.sock"; fi
if [ -n "$bad" ]; then echo "FAILED:$bad"; exit 1; fi
echo "all services active and stable"
REMOTE
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "deploy finished with problems; see the journal output above" >&2
  exit "$rc"
fi
say "deployed to $TARGET"

# Where to open it: the nginx site on the tailnet. The hub and status service have no TCP port in production.
LINK="$(remote_script <<'REMOTE'
site=/etc/nginx/sites-enabled/workstation
if [ -r "$site" ] && grep -q 'listen .*:443 ssl' "$site"; then
  name="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;[:space:]]*\);.*/\1/p' "$site" | grep -v '^_$' | head -n 1)"
  echo "https://$name"
elif [ -r "$site" ]; then
  ip="$(sed -n 's/^[[:space:]]*listen[[:space:]]\{1,\}\([0-9.]\{1,\}\):80.*/\1/p' "$site" | head -n 1)"
  echo "http://$ip"
fi
REMOTE
)"
if [ -n "$LINK" ]; then
  echo "  hub / web:   $LINK/    (tailnet only)"
  echo "  status page: $LINK/status/"
else
  echo "  The hub and status page listen on Unix sockets on the server only and no nginx site is set up."
  echo "  Join the server to your tailnet and run install.sh again (nginx on the Tailscale address)."
fi
