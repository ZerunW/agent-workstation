#!/usr/bin/env bash
# nginx in front of Agent Workstation, listening on the Tailscale address only (run on the machine as the admin account;
# uses sudo where needed; deploy/install.sh calls it). Idempotent.
#
#   bash deploy/nginx-tailscale.sh [--insecure-http] [--disable-default-site] <tailscale IPv4> [<name>.<tailnet>.ts.net]
#
# - With a ts.net name: HTTPS on 443 (80 redirects to 443). The certificate comes from Tailscale (`tailscale cert`;
#   enable HTTPS Certificates in the Tailscale admin console) and is refreshed weekly by workstation-ts-cert.timer, which
#   reloads nginx. When the certificate cannot be issued the script stops with an error before it changes nginx or
#   the system; it never falls back to plain HTTP by itself.
# - --insecure-http: serve plain HTTP on port 80 of the tailnet address instead (no name given, or the certificate
#   cannot be issued). The tailnet itself is encrypted, but browsers treat plain HTTP as an insecure context.
# - nginx's stock site (/etc/nginx/sites-enabled/default) listens on every interface. When it is the unmodified Debian /
#   Ubuntu file, it is disabled: the symlink is moved to /etc/nginx/workstation-disabled-sites/ (the script says so;
#   to restore it, move it back). When the file differs from the stock one, the script stops and asks; pass
#   --disable-default-site to disable it anyway.
# - nginx binds the tailnet address, which tailscaled assigns to tailscale0 some time after boot or a reconnect. A systemd
#   drop-in for nginx (/etc/systemd/system/nginx.service.d/workstation-wait-address.conf) runs
#   /usr/local/sbin/workstation-wait-address as ExecStartPre (polls `ip -o addr` for up to 60 s) and sets
#   Restart=on-failure, RestartSec=5: nginx starts when the address is there, and is started again 5 s after a failed
#   start. A running nginx keeps its listening socket when the address goes away and comes back. No machine-wide
#   setting such as net.ipv4.ip_nonlocal_bind is needed.
# - `/` and WebSockets go to the hub's public Unix socket (/run/agent-workstation/hub.sock), `/status/` to the status
#   service's (status.sock): `proxy_pass http://unix:<socket>:`. Both are mode 0660, group workstation-proxy, and nginx's
#   account is in that group (this script adds it; the agent account is not and cannot connect). The hub trusts a
#   request by the socket it arrived on and reads the client address from the single X-Forwarded-For value nginx sets
#   to $remote_addr (a client-supplied value never passes through). One shared block of proxy_set_header lines is
#   repeated in every proxying location (nginx does not inherit them into a location that sets any of its own), and the
#   site does not use the realip module: $remote_addr must stay the connection's own address (checked first, read-only,
#   by proxy-trust.sh on the whole effective configuration, before anything is changed).
# - Only the server's own names are served: `server_name` is the ts.net name (and the address), and a default server on
#   80 (and 443) answers every other Host with 444 (connection closed). That keeps a web page that rebinds its own
#   DNS name to the tailnet address from reaching the hub; the hub checks the Host header as well.
# - Neither the LAN nor the internet can reach it: nginx binds the Tailscale address only.
set -euo pipefail

INSECURE_HTTP=0
DISABLE_DEFAULT=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --insecure-http) INSECURE_HTTP=1 ;;
    --disable-default-site) DISABLE_DEFAULT=1 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) ARGS+=("$a") ;;
  esac
done
TS_IP="${ARGS[0]:?usage: nginx-tailscale.sh [--insecure-http] [--disable-default-site] <tailscale IPv4> [<name>.<tailnet>.ts.net]}"
TS_NAME="${ARGS[1]:-}"
[[ $TS_IP =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "not a tailscale IPv4: $TS_IP" >&2; exit 2; }
[ -z "$TS_NAME" ] || [[ $TS_NAME =~ ^[a-z0-9.-]+\.ts\.net$ ]] || { echo "not a ts.net name: $TS_NAME" >&2; exit 2; }
say() { printf '==> %s\n' "$*"; }
TLS=/etc/nginx/tls

RUN_DIR="${WORKSTATION_RUN_DIR:-/run/agent-workstation}"
HUB_SOCK="$RUN_DIR/hub.sock"
STATUS_SOCK="$RUN_DIR/status.sock"
PROXY_GROUP="workstation-proxy"

# Without a name there is no certificate: plain HTTP needs the explicit flag.
if [ -z "$TS_NAME" ] && [ "$INSECURE_HTTP" -ne 1 ]; then
  cat >&2 <<MSG
ERROR: no <name>.<tailnet>.ts.net given, so there is no HTTPS certificate. Pass the server's name (see \`tailscale status\`),
or --insecure-http to serve plain HTTP on $TS_IP:80 (the tailnet is encrypted, but browsers treat plain HTTP as an
insecure context).
MSG
  exit 2
fi

# The certificate comes first: when it cannot be issued, nothing on the machine has been changed yet.
HTTPS=0
if [ -n "$TS_NAME" ]; then
  say "certificate for $TS_NAME (tailscale cert)"
  sudo install -d -m 0750 -o root -g root "$TLS"
  if sudo tailscale cert --cert-file "$TLS/ts.crt" --key-file "$TLS/ts.key" "$TS_NAME" >/dev/null 2>&1; then
    sudo chmod 600 "$TLS/ts.key"
    HTTPS=1
  elif [ "$INSECURE_HTTP" -eq 1 ]; then
    echo "WARNING: could not get a certificate for $TS_NAME; serving plain HTTP on $TS_IP:80 (--insecure-http)" >&2
  else
    cat >&2 <<MSG
ERROR: could not get a certificate for $TS_NAME from Tailscale.
  1. In the Tailscale admin console (https://login.tailscale.com/admin/dns) turn on MagicDNS and HTTPS Certificates.
  2. Check that the name is the server's full name (\`tailscale status\`) and that tailscaled is running.
  3. Run this script again.
To serve plain HTTP on $TS_IP:80 instead, run it again with --insecure-http.
MSG
    exit 1
  fi
fi

command -v nginx >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq nginx >/dev/null

# Read-only checks first, before this script changes anything in nginx or the groups: the hub trusts nginx's
# $remote_addr and the members of the socket group (deploy/proxy-trust.sh, docs/SECURITY.md "What this rests on").
# shellcheck source=proxy-trust.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/proxy-trust.sh"
NGINX_CONF="$(sudo nginx -T 2>/dev/null)" || { echo "nginx -T failed: fix nginx's configuration first" >&2; exit 1; }
NGINX_USER="$(sed -n 's/^[[:space:]]*user[[:space:]][[:space:]]*\([^[:space:];]*\).*/\1/p' <<<"$NGINX_CONF" | head -n 1)"
NGINX_USER="${NGINX_USER:-www-data}"
id "$NGINX_USER" >/dev/null 2>&1 || { echo "nginx's worker account $NGINX_USER does not exist" >&2; exit 1; }
SERVICE_USER="${WORKSTATION_SERVICE_USER:-workstation}"
AGENT_USER="${WORKSTATION_AGENT_USER:-workstation-agent}"
[ "$NGINX_USER" != "$AGENT_USER" ] || { echo "nginx runs as the agent account $AGENT_USER; refusing to continue" >&2; exit 1; }
check_proxy_trust "$NGINX_CONF" "$PROXY_GROUP" "$SERVICE_USER" "$NGINX_USER" || exit 1

# The stock site listens on every interface; Agent Workstation's site should be the only one. Only the unmodified
# Debian / Ubuntu file is disabled without asking.
DEFAULT_SITE=/etc/nginx/sites-enabled/default
DISABLED_DIR=/etc/nginx/workstation-disabled-sites
if sudo test -e "$DEFAULT_SITE" || sudo test -L "$DEFAULT_SITE"; then
  # What is left of the file without comments and whitespace differences.
  normalize() { sed -e 's/#.*$//' | tr -s ' \t\n' ' ' | sed -E 's/ ?([{};]) ?/ \1 /g; s/  +/ /g; s/^ //; s/ $//'; }
  stock="$(printf '%s' 'server { listen 80 default_server; listen [::]:80 default_server; root /var/www/html; index index.html index.htm index.nginx-debian.html; server_name _; location / { try_files $uri $uri/ =404; } }' | normalize)"
  actual="$(sudo cat "$DEFAULT_SITE" 2>/dev/null | normalize)"
  if [ "$actual" = "$stock" ] || [ "$DISABLE_DEFAULT" -eq 1 ]; then
    sudo install -d -m 0755 "$DISABLED_DIR"
    sudo mv "$DEFAULT_SITE" "$DISABLED_DIR/default"
    say "disabled nginx's default site: moved $DEFAULT_SITE to $DISABLED_DIR/default (move it back to restore)"
  else
    cat >&2 <<MSG
ERROR: $DEFAULT_SITE exists and is not the stock Debian / Ubuntu default site, so it was left alone. It may listen on
every interface (the LAN included). Look at it (sudo cat $DEFAULT_SITE); if it is safe to disable, run this script again
with --disable-default-site (it is moved to $DISABLED_DIR/default, not deleted), or disable it yourself.
MSG
    exit 1
  fi
fi

# nginx's account must be in the group of the sockets (the hub and the status service are created with it by their units).
# Its members were checked above (the service account and nginx's worker account only; never the agent account).
getent group "$PROXY_GROUP" >/dev/null || sudo groupadd --system "$PROXY_GROUP"
id -nG "$NGINX_USER" | tr ' ' '\n' | grep -qx "$PROXY_GROUP" || { say "adding $NGINX_USER to group $PROXY_GROUP"; sudo usermod -aG "$PROXY_GROUP" "$NGINX_USER"; }

# nginx binds the tailnet address, which may not be assigned yet when it starts: wait for it (see the header).
say "nginx waits for $TS_IP before it starts (drop-in nginx.service.d/workstation-wait-address.conf)"
sudo install -m 0755 -o root -g root "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workstation-wait-address.sh" /usr/local/sbin/workstation-wait-address
sudo install -d -m 0755 -o root -g root /etc/systemd/system/nginx.service.d
sudo tee /etc/systemd/system/nginx.service.d/workstation-wait-address.conf >/dev/null <<UNIT
# Written by deploy/nginx-tailscale.sh: start nginx once the Tailscale address $TS_IP is assigned to an interface.
[Service]
ExecStartPre=/usr/local/sbin/workstation-wait-address $TS_IP 60
Restart=on-failure
RestartSec=5
UNIT
sudo systemctl daemon-reload

if [ "$HTTPS" -eq 1 ]; then
  sudo tee /etc/systemd/system/workstation-ts-cert.service >/dev/null <<UNIT
[Unit]
Description=Agent Workstation: refresh the Tailscale HTTPS certificate for $TS_NAME
After=tailscaled.service
[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale cert --cert-file $TLS/ts.crt --key-file $TLS/ts.key $TS_NAME
ExecStartPost=/bin/systemctl reload nginx
UNIT
  sudo tee /etc/systemd/system/workstation-ts-cert.timer >/dev/null <<'UNIT'
[Unit]
Description=Agent Workstation: weekly Tailscale certificate refresh
[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now workstation-ts-cert.timer >/dev/null 2>&1
fi

say "nginx site"
# The one block of proxy headers, written into every location that proxies: nginx does not inherit proxy_set_header into a
# location that sets any of its own, so a location without the full block would lose X-Forwarded-For.
proxy_common='proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;'
locations() {
  cat <<LOC
  client_max_body_size 64m;

  location /status/ {
    proxy_pass http://unix:$STATUS_SOCK:;
    $proxy_common
  }
  # Folder sync uploads (first upload, large-file chunks, pushes, manifest, backups) can exceed 64m: the hub sets
  # their limits itself (and refuses at the disk block line), so nginx streams them through without a cap.
  location ~ ^/api/projects/[^/]+/(baseline|large|files|manifest|backups)\$ {
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_pass http://unix:$HUB_SOCK:;
    $proxy_common
  }
  location / {
    proxy_pass http://unix:$HUB_SOCK:;
    $proxy_common
  }
LOC
}
{
  echo "# Generated by deploy/nginx-tailscale.sh: Agent Workstation on the tailnet only."
  echo "# The hub identifies a caller by the one X-Forwarded-For value set below (\$remote_addr) and by the socket it came in on."
  echo "# Do not enable nginx's realip module here or anywhere else: \$remote_addr must stay the address of the connection itself."
  echo 'map $http_upgrade $connection_upgrade { default upgrade; "" close; }'
  # Only the server's own names are served; a request with any other Host (DNS rebinding from a web page, a stray
  # name pointed at the address) gets the default server and is dropped without an answer (444).
  echo "server { listen $TS_IP:80 default_server; server_name _; return 444; }"
  if [ "$HTTPS" -eq 1 ]; then
    echo "server { listen $TS_IP:80; server_name $TS_NAME $TS_IP; return 301 https://$TS_NAME\$request_uri; }"
    echo "server {"
    echo "  listen $TS_IP:443 ssl http2 default_server;"
    echo "  server_name _;"
    echo "  ssl_certificate $TLS/ts.crt;"
    echo "  ssl_certificate_key $TLS/ts.key;"
    echo "  ssl_protocols TLSv1.2 TLSv1.3;"
    echo "  return 444;"
    echo "}"
    echo "server {"
    echo "  listen $TS_IP:443 ssl http2;"
    echo "  server_name $TS_NAME;"
    echo "  ssl_certificate $TLS/ts.crt;"
    echo "  ssl_certificate_key $TLS/ts.key;"
    echo "  ssl_protocols TLSv1.2 TLSv1.3;"
  else
    echo "server {"
    echo "  listen $TS_IP:80;"
    echo "  server_name $TS_IP $TS_NAME;"
  fi
  locations
  echo "}"
} | sudo tee /etc/nginx/sites-available/workstation >/dev/null
sudo ln -sf /etc/nginx/sites-available/workstation /etc/nginx/sites-enabled/workstation
sudo nginx -t -q
sudo systemctl enable nginx >/dev/null 2>&1
sudo systemctl reload-or-restart nginx
if [ "$HTTPS" -eq 1 ]; then say "done: https://$TS_NAME/"; else say "done: http://$TS_IP/"; fi
