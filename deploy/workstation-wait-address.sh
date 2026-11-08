#!/usr/bin/env bash
# Waits until an IP address is assigned to a local interface (default: up to 60 seconds). nginx listens on the Tailscale
# address, which tailscaled assigns to tailscale0 some time after boot or after a reconnect; the nginx drop-in
# (/etc/systemd/system/nginx.service.d/workstation-wait-address.conf, written by deploy/nginx-tailscale.sh) runs this as
# ExecStartPre, so nginx starts once the address exists. Exit status 0 when it is there, 1 when the time ran out.
#
#   workstation-wait-address <IPv4 or IPv6 address> [seconds]
# Installed to /usr/local/sbin/workstation-wait-address by deploy/nginx-tailscale.sh.
set -euo pipefail

ADDR="${1:?usage: workstation-wait-address <address> [seconds]}"
SECS="${2:-60}"
[[ $ADDR =~ ^[0-9A-Fa-f:.]{2,45}$ ]] || { echo "workstation-wait-address: not an address: $ADDR" >&2; exit 2; }
[[ $SECS =~ ^[0-9]{1,4}$ ]] || { echo "workstation-wait-address: bad number of seconds: $SECS" >&2; exit 2; }

for ((i = 0; i <= SECS; i++)); do
  # `ip -o addr` prints one line per address: "<n>: <ifname> inet 100.64.0.9/32 ..." or "inet6 fd7a::9/128 ...".
  if ip -o addr show 2>/dev/null | grep -qE "[[:space:]]inet6?[[:space:]]+${ADDR//./\\.}/"; then exit 0; fi
  ((i == SECS)) || sleep 1
done
echo "workstation-wait-address: $ADDR was not assigned to any interface within ${SECS}s" >&2
exit 1
