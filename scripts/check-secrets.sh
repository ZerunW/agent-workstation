#!/usr/bin/env bash
# Fails when a tracked file holds something that looks like a real secret: an Anthropic, GitHub, Tailscale, AWS, Google,
# Slack or Stripe credential, a private key block, or a committed key / certificate / .env file. Run by CI
# (`bash scripts/check-secrets.sh`); run it before committing. Tests: scripts/test/check-secrets.test.sh.
#
# The placeholder keys the tests use are allowed, token by token: a token (a run of letters, digits, `_` and `-`) that
# contains "not-a-real-key" or "sk-ant-api03-fake", or the scrambled alphabet sample (AbCdEf...) the agent wrapper tests
# use, is ignored, and the rest of the same line is still scanned.
#
# Which files: the ones git tracks. SECRETS_SCAN_ALL=1 scans every file under the repository root (minus node_modules,
# dist, .git) instead, and so does a run outside a git work tree (an archive or a copy), which must not silently scan
# nothing. When git fails for any other reason the script exits non-zero.
set -euo pipefail
# SECRETS_SCAN_ROOT: the directory to scan (default: the repository root); the tests point it at a scratch folder.
cd "${SECRETS_SCAN_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}"

SCAN_ALL="${SECRETS_SCAN_ALL:-0}"
if [ "$SCAN_ALL" != 1 ]; then
  git_rc=0
  git_out="$(git rev-parse --is-inside-work-tree 2>&1)" || git_rc=$?
  if [ "$git_rc" -ne 0 ]; then
    case "$git_out" in
      *"not a git repository"*) SCAN_ALL=1; echo "not inside a git work tree: scanning every file" >&2 ;;
      *) echo "git failed: $git_out" >&2; exit 2 ;;
    esac
  elif [ "$git_out" != true ]; then
    SCAN_ALL=1; echo "not inside a git work tree: scanning every file" >&2
  fi
fi

list_files() {
  if [ "$SCAN_ALL" = 1 ]; then
    find . -type f -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*' -not -path '*/dist/*' -not -path '*/.build/*' -print0
  else
    git ls-files -z
  fi
}

status=0

# 1. committed secret files (names)
while IFS= read -r -d '' f; do
  case "$f" in
    .env.example|*/.env.example) ;;
    *.pem|*.key|*.p12|*.crt|*.secret|.env|*/.env|.env.*|*/.env.*|anthropic.env|*/anthropic.env)
      echo "secret-looking file is tracked: $f" >&2; status=1 ;;
  esac
done < <(list_files)

# 2. contents
# A whole token holding a placeholder is removed before the line is matched again, so a placeholder never hides a real
# secret elsewhere on the same line.
PLACEHOLDER_TOKEN='[A-Za-z0-9_-]*(not-a-real-key|sk-ant-api03-fake|AbCdEfGhIjKlMnOpQrStUvWxYz)[A-Za-z0-9_-]*'
scan() { # <label> <regex>
  local hits
  hits="$(list_files | xargs -0 grep -HInE -- "$2" 2>/dev/null |
    sed -E "s/$PLACEHOLDER_TOKEN//g" | grep -E -- "$2" || true)"
  if [ -n "$hits" ]; then
    echo "$1 found:" >&2
    # Show where (file:line), never the value.
    printf '%s\n' "$hits" | cut -d: -f1,2 | head -20 >&2
    status=1
  fi
}
scan "Anthropic API key" 'sk-ant-[A-Za-z0-9_-]{20,}'
scan "GitHub token" '(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})'
scan "Tailscale key" 'tskey-[A-Za-z0-9-]{20,}'
scan "AWS access key" '(AKIA|ASIA)[0-9A-Z]{16}'
scan "Google API key" 'AIza[0-9A-Za-z_-]{35}'
scan "Slack token" 'xox[abprs]-[A-Za-z0-9-]{10,}'
scan "Stripe live key" '(sk|rk)_live_[0-9A-Za-z]{24,}'
scan "private key block" '-----BEGIN ([A-Z]+ )*PRIVATE KEY-----'

[ "$status" -eq 0 ] && echo "no secrets found"
exit "$status"
