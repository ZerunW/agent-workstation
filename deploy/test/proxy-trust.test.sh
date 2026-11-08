#!/usr/bin/env bash
# Tests deploy/proxy-trust.sh (the read-only nginx checks of nginx-tailscale.sh). Runs anywhere bash does, no nginx needed.
#
#   bash deploy/test/proxy-trust.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../proxy-trust.sh
. "$HERE/../proxy-trust.sh"

n=0
fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }
detects() { if realip_in_config "$2"; then ok "detects: $1"; else bad "detects: $1"; fi; }
passes() { if realip_in_config "$2"; then bad "passes: $1"; else ok "passes: $1"; fi; }

SAFE='map $http_upgrade $connection_upgrade { default upgrade; "" close; }
server {
  listen 100.64.0.1:443 ssl;
  server_name ws.example.com;
  location / {
    proxy_pass http://unix:/run/agent-workstation/hub.sock:;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}'
passes "the generated site" "$SAFE"
passes "a longer name that only contains the word" "log_format my_real_ip_header_note '\$remote_addr';"
detects "a directive on its own line" "http {
  real_ip_header X-Forwarded-For;
}"
detects "a directive split over lines" "http {
  real_ip_header
      X-Forwarded-For;
  set_real_ip_from
      0.0.0.0/0;
}"
detects "directives sharing one line" 'http { real_ip_header X-Forwarded-For; set_real_ip_from 0.0.0.0/0; }'
detects "a directive right after a brace" 'server{set_real_ip_from 10.0.0.0/8;}'
detects "real_ip_recursive" 'real_ip_recursive on;'
detects "a mention in a comment (refused on purpose)" '# real_ip_header was here'
# A long configuration with the directive near the start: through a pipe with pipefail, grep -q would exit early and the
# writer's SIGPIPE would turn the match into a failure.
long="http { real_ip_header X-Forwarded-For; }
$(for _ in $(seq 1 20000); do echo "  # filler line to make the configuration long ............"; done)"
[ "${#long}" -gt 500000 ] || { bad "long configuration is long"; }
detects "a long configuration ($(( ${#long} / 1024 )) KiB) with the directive first" "$long"

# Group membership, with getent replaced by fixtures.
GROUP_LINE=""
PASSWD_LINES=""
getent() {
  case "$1" in
    group) [ -n "$GROUP_LINE" ] && printf '%s\n' "$GROUP_LINE" || return 2 ;;
    passwd) printf '%s\n' "$PASSWD_LINES" ;;
  esac
}
PASSWD_LINES='workstation:x:990:990::/var/lib/workstation:/usr/sbin/nologin
www-data:x:33:33::/var/www:/usr/sbin/nologin
workstation-agent:x:991:991::/home/workstation-agent:/bin/bash'
GROUP_LINE='workstation-proxy:x:980:workstation,www-data'
[ -z "$(unexpected_group_members workstation-proxy workstation www-data)" ] && ok "group: expected members only" || bad "group: expected members only"
GROUP_LINE='workstation-proxy:x:980:workstation,www-data,workstation-agent'
[ "$(unexpected_group_members workstation-proxy workstation www-data)" = workstation-agent ] && ok "group: an extra listed member" || bad "group: an extra listed member"
GROUP_LINE='workstation-proxy:x:980:workstation,www-data'
PASSWD_LINES="$PASSWD_LINES
intruder:x:1500:980::/home/intruder:/bin/bash"
[ "$(unexpected_group_members workstation-proxy workstation www-data)" = intruder ] && ok "group: a member through its primary group" || bad "group: a member through its primary group"
GROUP_LINE=""
[ -z "$(unexpected_group_members workstation-proxy workstation www-data)" ] && ok "group: a missing group has no members" || bad "group: a missing group has no members"

GROUP_LINE='workstation-proxy:x:980:workstation,www-data'
PASSWD_LINES='www-data:x:33:33::/var/www:/usr/sbin/nologin'
if check_proxy_trust "$SAFE" workstation-proxy workstation www-data 2>/dev/null; then ok "check: a safe setup passes"; else bad "check: a safe setup passes"; fi
if check_proxy_trust "$long" workstation-proxy workstation www-data 2>/dev/null; then bad "check: realip is refused"; else ok "check: realip is refused"; fi
GROUP_LINE='workstation-proxy:x:980:workstation,www-data,other'
if check_proxy_trust "$SAFE" workstation-proxy workstation www-data 2>/dev/null; then bad "check: an extra member is refused"; else ok "check: an extra member is refused"; fi

echo "1..$n"
[ "$fail" -eq 0 ] && echo "all $n passed" || { echo "$fail of $n failed"; exit 1; }
