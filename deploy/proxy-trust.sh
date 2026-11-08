# shellcheck shell=bash
# Read-only checks of the two things the hub trusts nginx for (docs/SECURITY.md, "What this rests on"): that
# X-Forwarded-For carries the real TCP client ($remote_addr, so nginx's realip module must not rewrite it), and that
# only the service account and nginx's worker account can connect to the public socket (the members of its group).
# Sourced by nginx-tailscale.sh; defines functions only. Tests: deploy/test/proxy-trust.test.sh.

# realip_in_config <text of `nginx -T`>: true when a realip directive name appears anywhere in it as a whole word,
# comments included. Deliberately not a parser: nginx lets a directive span lines or share a line with others, and
# refusing a configuration that merely mentions the name in a comment is better than missing a real directive. The text
# is passed as a here-string, not through a pipe, so an early exit of grep cannot turn a match into a failure under
# `set -o pipefail`.
realip_in_config() {
  grep -qwE 'real_ip_header|set_real_ip_from|real_ip_recursive' <<<"$1"
}

# unexpected_group_members <group> <allowed account>...: prints each member of <group> (listed in it, or having it as
# primary group) that is not one of the allowed accounts, one per line. Prints nothing when the group does not exist.
unexpected_group_members() {
  local group=$1 entry gid m a ok
  shift
  entry="$(getent group "$group")" || return 0
  gid="$(cut -d: -f3 <<<"$entry")"
  for m in $(cut -d: -f4 <<<"$entry" | tr ',' ' ') $(getent passwd | awk -F: -v g="$gid" '$4 == g { print $1 }'); do
    ok=0
    for a in "$@"; do [ "$m" != "$a" ] || ok=1; done
    [ "$ok" -eq 1 ] || printf '%s\n' "$m"
  done
}

# check_proxy_trust <text of `nginx -T`> <group> <allowed account>...: prints why and returns 1 when either assumption
# does not hold.
check_proxy_trust() {
  local conf=$1 group=$2 extra
  shift 2
  if realip_in_config "$conf"; then
    echo "nginx's configuration mentions real_ip_header, set_real_ip_from or real_ip_recursive. The realip module lets a request header replace \$remote_addr, and the hub relies on \$remote_addr being the real client. Remove every use (sudo nginx -T | grep -nwE 'real_ip_header|set_real_ip_from|real_ip_recursive'; a mention in a comment counts too) and run this script again." >&2
    return 1
  fi
  extra="$(unexpected_group_members "$group" "$@")"
  if [ -n "$extra" ]; then
    echo "group $group has members other than $*: $(tr '\n' ' ' <<<"$extra")Every member can connect to the hub's public socket and claim any client address. Remove them (sudo gpasswd -d <account> $group) and run this script again." >&2
    return 1
  fi
}
