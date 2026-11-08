#!/usr/bin/env bash
# Runs as root before workstation-hub starts (ExecStartPre=+). Makes sure the users workspace root
# exists, is owned by the service user and shared with the agent account through the work group
# (setgid, group rw: <owner>:<group> 2770) and the socket folder /run/agent-workstation. Never recurses, never deletes.
# Installed to /usr/local/sbin/workstation-hub-prestart by deploy/install.sh.
set -euo pipefail

OWNER="${WORKSTATION_SERVICE_USER:-workstation}"
GROUP="${WORKSTATION_WORK_GROUP:-workstation-work}"
getent group "$GROUP" >/dev/null || GROUP="$OWNER"
CONFIG="${WORKSTATION_CONFIG:-/etc/agent-workstation/workstation.toml}"
ROOT="/srv/agent-workstation/users"

# users_root from [paths], if the config sets it (portable sed: works with GNU and BSD).
if [ -r "$CONFIG" ]; then
  configured="$(sed -nE 's/^[[:space:]]*users_root[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/p' "$CONFIG" | head -n 1)"
  if [ -n "$configured" ]; then ROOT="$configured"; fi
fi

case "$ROOT" in
  /) echo "workstation-hub-prestart: refusing users_root '/'" >&2; exit 1 ;;
  /*) ;;
  *) echo "workstation-hub-prestart: users_root must be an absolute path, got '$ROOT'" >&2; exit 1 ;;
esac
case "$ROOT" in
  /bin|/boot|/dev|/etc|/home|/lib|/lib64|/proc|/root|/run|/sbin|/sys|/usr|/var|/tmp)
    echo "workstation-hub-prestart: refusing system directory '$ROOT' as users_root" >&2; exit 1 ;;
esac

mkdir -p "$ROOT"
if [ "$(stat -c %U:%G "$ROOT")" != "$OWNER:$GROUP" ]; then
  chown "$OWNER:$GROUP" "$ROOT"
fi
if [ "$GROUP" != "$OWNER" ] && [ "$(stat -c %a "$ROOT")" != 2770 ]; then
  chmod 2770 "$ROOT"
fi

# The folder of the hub's and status service's sockets (tmpfiles.d creates it at boot; this covers a removed one).
# Owned by the service account, 0755: the agent account can look at it but create nothing in it.
RUN_DIR="${WORKSTATION_RUN_DIR:-/run/agent-workstation}"
install -d -o "$OWNER" -g "$OWNER" -m 0755 "$RUN_DIR"
