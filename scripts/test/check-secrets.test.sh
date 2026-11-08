#!/usr/bin/env bash
# Tests scripts/check-secrets.sh on scratch folders (SECRETS_SCAN_ROOT). Runs anywhere bash and git do.
#
#   bash scripts/test/check-secrets.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/check-secrets.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

n=0
fail=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
bad() { n=$((n + 1)); fail=$((fail + 1)); echo "not ok $n - $1"; }

# run <label> <expect: pass|fail> <file name> <content>: scans a folder holding just that file.
run() {
  local d="$T/case$n"
  mkdir -p "$d"
  printf '%s\n' "$4" >"$d/$3"
  if SECRETS_SCAN_ROOT="$d" SECRETS_SCAN_ALL=1 bash "$SCRIPT" >/dev/null 2>"$d.err"; then got=pass; else got=fail; fi
  if [ "$got" = "$2" ]; then ok "$1"; else bad "$1 (expected $2, got $got)"; fi
  # A report names the place, never the value.
  if [ "$got" = fail ] && grep -q -- "${5:-@@none@@}" "$d.err"; then bad "$1: the report shows the value"; fi
}

# Built at run time so this file holds no secret-shaped string itself.
rep() { local s="" i; for ((i = 0; i < $2; i++)); do s="$s$1"; done; printf '%s' "$s"; }
ANTHROPIC="sk-ant-api03-$(rep Zq9 12)"
GITHUB="ghp_$(rep a1B2 9)"
GITHUB_FINE="github_pat_$(rep x9Y8 11)"
TAILSCALE="tskey-auth-$(rep k7Q 8)"
AWS="AKIA$(rep Q7 8)"
GOOGLE="AIza$(rep Sy3 11)Ab"
SLACK="xoxb-$(rep 12 6)-$(rep ab 6)"
STRIPE="sk_live_$(rep 9z 13)"
PEM_HEADER="-----BEGIN OPENSSH PRIV""ATE KEY-----"

run "clean file" pass a.ts 'const x = 1;'
run "Anthropic key" fail a.ts "const k = \"$ANTHROPIC\";" "$ANTHROPIC"
run "GitHub classic token" fail a.ts "token=$GITHUB" "$GITHUB"
run "GitHub fine-grained token" fail a.ts "token=$GITHUB_FINE" "$GITHUB_FINE"
run "Tailscale auth key" fail a.sh "TS_AUTHKEY=$TAILSCALE" "$TAILSCALE"
run "AWS access key id" fail a.env.txt "id=$AWS" "$AWS"
run "Google API key" fail a.js "key: '$GOOGLE'" "$GOOGLE"
run "Slack token" fail a.yml "slack: $SLACK" "$SLACK"
run "Stripe live key" fail a.rb "Stripe.api_key = '$STRIPE'" "$STRIPE"
run "private key block" fail a.txt "$PEM_HEADER"
run "a placeholder key alone" pass a.test.ts 'const k = "sk-ant-api03-not-a-real-key-0000000000000000";'
run "the fake prefix alone" pass a.test.ts 'const k = "sk-ant-api03-fake-aaaaaaaaaaaaaaaaaaaaaaaa";'
run "a placeholder does not hide a real key on the same line" fail a.test.ts \
  "const k = \"sk-ant-api03-not-a-real-key-0000\", real = \"$ANTHROPIC\";" "$ANTHROPIC"
run "a placeholder does not hide another kind of secret" fail a.test.ts \
  "const k = \"sk-ant-api03-not-a-real-key-0000\"; // $GITHUB" "$GITHUB"
run "a committed .env file" fail .env 'X=1'
run "a .env.example is fine" pass .env.example 'X='

echo "1..$n"
[ "$fail" -eq 0 ] && echo "all $n passed" || { echo "$fail of $n failed"; exit 1; }
