#!/usr/bin/env bash
# Tests deploy/workstation-agent-exec without sudo: a copy whose settings point at a temp dir runs as the current user,
# with fake claude/tmux that print their argv, cwd, environment and stdin.
#
#   bash deploy/test/workstation-agent-exec.test.sh      (also run by packages/hub/test/agent-exec.test.ts)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../workstation-agent-exec"
if [ "$(uname -s)" != Linux ]; then
  # The wrapper is Linux-only (/proc, GNU realpath -e, bash >= 4).
  echo "SKIP: workstation-agent-exec runs on Linux only ($(uname -s))"
  exit 0
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "skip: the wrapper refuses to run as root; run this test as a normal user"
  exit 0
fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
T="$(realpath "$T")"
ROOT="$T/users"
mkdir -p "$ROOT/alice/proj" "$T/home/.local/bin" "$T/bin" "$T/outside"
ln -s "$T/outside" "$ROOT/alice/escape"

cat >"$T/bin/fake" <<'EOF'
#!/bin/bash
printf 'argv:'
printf ' [%s]' "$@"
printf '\ncwd: %s\n' "$PWD"
env | LC_ALL=C sort | sed 's/^/env: /'
printf 'stdin: %s\n' "$(cat)"
EOF
chmod +x "$T/bin/fake"
for b in claude tmux bwrap curl; do cp "$T/bin/fake" "$T/bin/$b"; done

configure() { # configure AGENT_USER OUT
  sed -e "s#^AGENT_USER=.*#AGENT_USER=$1#" \
    -e "s#^AGENT_HOME=.*#AGENT_HOME=$T/home#" \
    -e "s#^WORK_ROOT=.*#WORK_ROOT=$ROOT#" \
    -e "s#^PLUGINS_DIR=.*#PLUGINS_DIR=$T/plugins#" \
    -e "s#^CLAUDE_BIN=.*#CLAUDE_BIN=$T/bin/claude#" \
    -e "s#^TMUX_BIN=.*#TMUX_BIN=$T/bin/tmux#" \
    -e "s#^TMP_ROOT=.*#TMP_ROOT=$T/hs#" \
    -e "s#^BWRAP_BIN=.*#BWRAP_BIN=$T/bin/bwrap#" \
    -e "s#^CURL_BIN=.*#CURL_BIN=$T/bin/curl#" \
    -e "s#^FETCH_ROOT=.*#FETCH_ROOT=$T/hf#" \
    "$SRC" >"$2"
  chmod 0755 "$2"
}
X="$T/workstation-agent-exec"
configure "$(id -un)" "$X"
grep -q "^WORK_ROOT=$ROOT\$" "$X" || {
  echo "could not configure the wrapper copy"
  exit 1
}

# The hub's own secrets must never reach the target.
export WORKSTATION_TEST_SECRET=leaked ANTHROPIC_AUTH_TOKEN=leaked

N=0
FAILS=0
OUT=""
RC=0
pass() {
  N=$((N + 1))
  echo "ok $N - $1"
}
fail() {
  N=$((N + 1))
  FAILS=$((FAILS + 1))
  echo "not ok $N - $1"
}
run() {
  set +e
  OUT="$("$@" 2>&1)"
  RC=$?
  set -e
}
has() { # has NAME TEXT: OUT contains TEXT
  if [[ $OUT == *"$2"* ]]; then pass "$1"; else fail "$1: no '$2' in: $OUT"; fi
}
lacks() {
  if [[ $OUT != *"$2"* ]]; then pass "$1"; else fail "$1: unexpected '$2' in: $OUT"; fi
}
rc_is() {
  if [[ $RC -eq $2 ]]; then pass "$1"; else fail "$1: exit $RC (want $2): $OUT"; fi
}
refused() { # refused NAME CMD...: exit 126 and the target never ran
  local name=$1
  shift
  run "$@" </dev/null
  if [[ $RC -eq 126 && $OUT != *"argv:"* ]]; then pass "refuses: $name"; else fail "refuses: $name (exit $RC): $OUT"; fi
}

UUID=0f4c1e2a-3b5d-4c6e-8f70-1a2b3c4d5e6f
CWD="$ROOT/alice/proj"

# ---- claude ----
# A key proxy token (hsk- + 43 base64url characters), never a real key.
TOKEN=hsk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde
BASE=http://127.0.0.1:41234
run "$X" claude "$CWD" --env CLAUDE_CODE_ENTRYPOINT=sdk-ts --env LANG=C.UTF-8 --env "ANTHROPIC_BASE_URL=$BASE" --stdin-secrets -- \
  --output-format stream-json --verbose --input-format stream-json --model=opus --permission-prompt-tool=stdio \
  "--resume=$UUID" --setting-sources= --mcp-config '{"mcpServers":{"workstation-visual":{"type":"sdk","name":"workstation-visual"}}}' \
  "--add-dir=$ROOT/alice" --allow-dangerously-skip-permissions --permission-mode=bypassPermissions \
  < <(printf 'ANTHROPIC_API_KEY=%s\0\0{"type":"user"}' "$TOKEN")
rc_is "claude: session flags run" 0
has "claude: exact argv" "argv: [--output-format] [stream-json] [--verbose] [--input-format] [stream-json] [--model=opus] [--permission-prompt-tool=stdio] [--resume=$UUID] [--setting-sources=] [--mcp-config] [{\"mcpServers\":{\"workstation-visual\":{\"type\":\"sdk\",\"name\":\"workstation-visual\"}}}] [--add-dir=$ROOT/alice] [--allow-dangerously-skip-permissions] [--permission-mode=bypassPermissions]"
has "claude: fixed cwd" "cwd: $CWD"
has "claude: proxy token from stdin" "env: ANTHROPIC_API_KEY=$TOKEN"
has "claude: proxy base URL passed" "env: ANTHROPIC_BASE_URL=$BASE"
has "claude: allowlisted env passed" "env: CLAUDE_CODE_ENTRYPOINT=sdk-ts"
has "claude: HOME of the agent" "env: HOME=$T/home"
has "claude: PATH of the agent" "env: PATH=$T/home/.local/bin:/usr/local/bin:/usr/bin:/bin"
has "claude: auto-updater off" "env: DISABLE_AUTOUPDATER=1"
has "claude: telemetry off" "env: DISABLE_TELEMETRY=1"
has "claude: error reporting off" "env: DISABLE_ERROR_REPORTING=1"
lacks "claude: hub environment dropped" "WORKSTATION_TEST_SECRET"
lacks "claude: auth token dropped" "ANTHROPIC_AUTH_TOKEN"
has "claude: rest of stdin reaches the target" 'stdin: {"type":"user"}'

refused "claude auth status (no login is ever checked)" "$X" claude "$ROOT" -- auth status --json
run "$X" claude "$CWD" -- --verbose </dev/null
lacks "claude: no key without --stdin-secrets" "ANTHROPIC_API_KEY"

run "$X" claude "$ROOT" -- --version </dev/null
rc_is "claude: --version runs" 0
has "claude: --version argv" "argv: [--version]"
refused "claude --version=1 (only the bare flag)" "$X" claude "$ROOT" -- --version=1
refused "claude --version with a value" "$X" claude "$ROOT" -- --version 1
refused "claude -v" "$X" claude "$ROOT" -- -v
refused "claude --help" "$X" claude "$ROOT" -- --help
refused "claude --versions" "$X" claude "$ROOT" -- --versions
refused "claude --version=" "$X" claude "$ROOT" -- --version=

refused "claude --plugin-dir" "$X" claude "$CWD" -- --plugin-dir "$ROOT/alice"
refused "claude --debug-file" "$X" claude "$CWD" -- "--debug-file=$ROOT/x"
refused "claude stdio MCP server" "$X" claude "$CWD" -- --mcp-config '{"mcpServers":{"x":{"type":"stdio","command":"sh"}}}'
refused "claude MCP server without type" "$X" claude "$CWD" -- --mcp-config '{"mcpServers":{"x":{"command":"sh"}}}'
BRW='"browser":{"type":"http","url":"http://127.0.0.1:45173/mcp/alice","headers":{"Authorization":"Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456","X-Workstation-Session":"'"$UUID"'"}}'
run "$X" claude "$CWD" -- --mcp-config '{"mcpServers":{"workstation-visual":{"type":"sdk","name":"workstation-visual"},'"$BRW"'}}' </dev/null
rc_is "claude browser MCP endpoint next to sdk servers: runs" 0
has "claude browser MCP endpoint next to sdk servers: passed through" "/mcp/alice"
refused "claude browser MCP on another host" "$X" claude "$CWD" -- --mcp-config "{\"mcpServers\":{${BRW/127.0.0.1/10.0.0.1}}}"
refused "claude browser MCP with another path" "$X" claude "$CWD" -- --mcp-config "{\"mcpServers\":{${BRW//mcp\/alice//x}}}"
refused "claude second http MCP server" "$X" claude "$CWD" -- --mcp-config "{\"mcpServers\":{$BRW,${BRW/browser/other}}}"
refused "claude url without a type" "$X" claude "$CWD" -- --mcp-config '{"mcpServers":{"x":{"url":"http://evil.example/"}}}'
refused "claude settings file path" "$X" claude "$CWD" -- --settings /etc/passwd
# Plugins: only <PLUGINS_DIR>/<uuid>/(project|workstation), never writable or owned by the agent. The test runs as the
# agent account itself, so every folder here is the agent's own and must be refused (a root-owned tree is needed for the
# accepted case, which this script cannot create without root).
PID=0123abcd-4567-89ab-cdef-0123456789ab
mkdir -p "$T/plugins/$PID/workstation" "$T/plugins/$PID/other" "$ROOT/alice/proj/plugin"
ln -s "$ROOT/alice/proj/plugin" "$T/plugins/$PID/project"
for flag in --plugin-dir --plugin-dir-no-mcp; do
  refused "claude $flag: a plugin owned by the agent" "$X" claude "$CWD" -- "$flag=$T/plugins/$PID/workstation"
  refused "claude $flag: not named project or workstation" "$X" claude "$CWD" -- "$flag=$T/plugins/$PID/other"
  refused "claude $flag: a symlink to a project folder" "$X" claude "$CWD" -- "$flag=$T/plugins/$PID/project"
  refused "claude $flag: inside a project" "$X" claude "$CWD" -- "$flag=$ROOT/alice/proj/plugin"
  refused "claude $flag: a folder that does not exist" "$X" claude "$CWD" -- "$flag=$T/plugins/$PID/missing"
  refused "claude $flag: not a uuid" "$X" claude "$CWD" -- "$flag=$T/plugins/x/workstation"
done
refused "claude --add-dir outside the root" "$X" claude "$CWD" -- "--add-dir=$T/outside"
refused "claude --add-dir through a symlink out" "$X" claude "$CWD" -- "--add-dir=$ROOT/alice/escape"
refused "claude bad --resume" "$X" claude "$CWD" -- "--resume=../../x"
refused "claude control chars in a tool list" "$X" claude "$CWD" -- --allowedTools "$(printf 'Read\nBash')"
refused "claude flag without value" "$X" claude "$CWD" -- --model
refused "claude positional argument" "$X" claude "$CWD" -- -p hello
refused "claude auth login" "$X" claude "$ROOT" -- auth login
refused "claude cwd outside the root" "$X" claude "$T/outside" -- --verbose
refused "claude cwd through a symlink out" "$X" claude "$ROOT/alice/escape" -- --verbose
refused "claude relative cwd" "$X" claude alice -- --verbose
refused "claude missing --" "$X" claude "$CWD" --verbose
refused "claude env PATH" "$X" claude "$CWD" --env PATH=/tmp -- --verbose
refused "claude env LD_PRELOAD" "$X" claude "$CWD" --env LD_PRELOAD=/tmp/x.so -- --verbose
refused "claude API key in argv" "$X" claude "$CWD" --env ANTHROPIC_API_KEY=sk -- --verbose
refused "claude CLAUDE_CODE_SHELL_PREFIX" "$X" claude "$CWD" --env CLAUDE_CODE_SHELL_PREFIX=x -- --verbose
refused "claude env value with spaces" "$X" claude "$CWD" --env "CLAUDE_CODE_ENTRYPOINT=a b" -- --verbose
run "$X" claude "$CWD" --stdin-secrets -- --verbose < <(printf 'PROMPT=hi\0\0')
rc_is "refuses: claude PROMPT record" 126
run "$X" claude "$CWD" --stdin-secrets -- --verbose < <(printf 'ANTHROPIC_API_KEY=bad key\0\0')
rc_is "refuses: malformed API key record" 126
run "$X" claude "$CWD" --stdin-secrets -- --verbose < <(printf 'ANTHROPIC_API_KEY=sk')
rc_is "refuses: unterminated secrets" 126

# ---- claude: the key proxy (never a real key) ----
for key in sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefgh SK-ANT-x sk-ant-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde; do
  run "$X" claude "$CWD" --env "ANTHROPIC_BASE_URL=$BASE" --stdin-secrets -- --verbose < <(printf 'ANTHROPIC_API_KEY=%s\0\0' "$key")
  if [[ $RC -eq 126 && $OUT == *"real Anthropic API key"* && $OUT != *"argv:"* ]]; then pass "refuses: real key ${key:0:10}..."; else fail "refuses: real key ${key:0:10}... (exit $RC): $OUT"; fi
done
for key in "${TOKEN}x" "${TOKEN:0:46}" "hsk-short" "xsk-${TOKEN#hsk-}" "hsk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab/de"; do
  run "$X" claude "$CWD" --env "ANTHROPIC_BASE_URL=$BASE" --stdin-secrets -- --verbose < <(printf 'ANTHROPIC_API_KEY=%s\0\0' "$key")
  rc_is "refuses: malformed proxy token ${key:0:12}" 126
done
run "$X" claude "$CWD" --stdin-secrets -- --verbose < <(printf 'ANTHROPIC_API_KEY=%s\0\0' "$TOKEN")
rc_is "refuses: proxy token without ANTHROPIC_BASE_URL" 126
run "$X" claude "$CWD" --env ANTHROPIC_BASE_URL=http://127.0.0.1:65535 --env ANTHROPIC_BASE_URL=http://127.0.0.1:1 -- --verbose </dev/null
rc_is "claude: base URL ports 1 and 65535 run" 0
has "claude: base URL without a token" "env: ANTHROPIC_BASE_URL=http://127.0.0.1:1"
for url in http://127.0.0.1:0 http://127.0.0.1:65536 http://127.0.0.1:099999 http://127.0.0.1:08080 http://127.0.0.1 \
  http://127.0.0.1:8080/ http://127.0.0.1:8080/v1 https://127.0.0.1:8080 http://localhost:8080 http://127.0.0.2:8080 \
  http://[::1]:8080 http://127.0.0.1:8080@evil.example http://evil.example:80 "http://127.0.0.1:80 x"; do
  refused "claude ANTHROPIC_BASE_URL=$url" "$X" claude "$CWD" --env "ANTHROPIC_BASE_URL=$url" -- --verbose
done
refused "tmux ANTHROPIC_BASE_URL" "$X" tmux "$ROOT" --env "ANTHROPIC_BASE_URL=$BASE" -- list-sessions -F '#{session_name}'

# ---- claude: the process's private temp directory ----
TMPA="$T/hs/AbCdEfGhIjKlMnOpQrSt_-"
run "$X" claude "$CWD" --env "CLAUDE_CODE_TMPDIR=$TMPA" --env "TMPDIR=$TMPA" -- --verbose </dev/null
rc_is "claude: with a temp directory runs" 0
has "claude: CLAUDE_CODE_TMPDIR passed" "env: CLAUDE_CODE_TMPDIR=$TMPA"
has "claude: TMPDIR passed" "env: TMPDIR=$TMPA"
if [[ -d $TMPA && ! -L $TMPA && $(stat -c %a "$TMPA") == 700 && $(stat -c %a "$T/hs") == 700 ]]; then pass "claude: temp directory created 0700"; else fail "claude: temp directory not created 0700"; fi
refused "claude temp directory that exists already" "$X" claude "$CWD" --env "CLAUDE_CODE_TMPDIR=$TMPA" -- --verbose
for bad in /tmp/claude-1000 "$T/hs/short" "$T/hs/AbCdEfGhIjKlMnOpQrSt_-x" "$T/hs/AbCdEfGhIjKlMnOpQrSt.." "$T/hs/AbCdEfGhIjKlMnOpQrSt_-/x" "$T/hsx/AbCdEfGhIjKlMnOpQrSt_-" "$T/hs"; do
  refused "claude CLAUDE_CODE_TMPDIR=$bad" "$X" claude "$CWD" --env "CLAUDE_CODE_TMPDIR=$bad" -- --verbose
done
refused "claude TMPDIR without CLAUDE_CODE_TMPDIR" "$X" claude "$CWD" --env "TMPDIR=$T/hs/BbCdEfGhIjKlMnOpQrSt_-" -- --verbose
refused "claude TMPDIR other than CLAUDE_CODE_TMPDIR" "$X" claude "$CWD" --env "CLAUDE_CODE_TMPDIR=$T/hs/CbCdEfGhIjKlMnOpQrSt_-" --env TMPDIR=/tmp -- --verbose
refused "tmux TMPDIR" "$X" tmux "$ROOT" --env "TMPDIR=$T/hs/EbCdEfGhIjKlMnOpQrSt_-" -- list-sessions -F '#{session_name}'
mkdir -p "$TMPA/claude-1000/x" && echo out >"$TMPA/claude-1000/x/o.txt" && ln -s "$T/outside" "$TMPA/link"
run "$X" rmtmp "$TMPA" </dev/null
rc_is "rmtmp: runs" 0
if [[ ! -e $TMPA && -d $T/outside ]]; then pass "rmtmp: the directory is gone (symlink targets untouched)"; else fail "rmtmp: $TMPA still there"; fi
run "$X" rmtmp "$TMPA" </dev/null
rc_is "rmtmp: an absent directory is fine" 0
refused "rmtmp outside the temp root" "$X" rmtmp "$T/outside"
refused "rmtmp the temp root itself" "$X" rmtmp "$T/hs"
refused "rmtmp a bad name" "$X" rmtmp "$T/hs/../outside"
refused "rmtmp two arguments" "$X" rmtmp "$TMPA" "$TMPA"
ln -s "$T/outside" "$T/hs/FbCdEfGhIjKlMnOpQrSt_-"
refused "rmtmp a symlink" "$X" rmtmp "$T/hs/FbCdEfGhIjKlMnOpQrSt_-"
if [[ -d $T/outside ]]; then pass "rmtmp: symlink target untouched"; else fail "rmtmp: followed a symlink"; fi
mv "$T/hs" "$T/hs-real" && ln -s "$T/hs-real" "$T/hs"
refused "claude temp root that is a symlink" "$X" claude "$CWD" --env "CLAUDE_CODE_TMPDIR=$T/hs/GbCdEfGhIjKlMnOpQrSt_-" -- --verbose
mkdir "$T/hs-real/HbCdEfGhIjKlMnOpQrSt_-"
refused "rmtmp under a temp root that is a symlink" "$X" rmtmp "$T/hs/HbCdEfGhIjKlMnOpQrSt_-"
rm "$T/hs" && mv "$T/hs-real" "$T/hs"

refused "claude --sandbox" "$X" claude "$CWD" --sandbox -- --verbose
refused "claude --bind" "$X" claude "$CWD" --bind "$ROOT/alice/proj" -- --verbose
refused "tmux --sandbox" "$X" tmux "$ROOT" --sandbox -- list-sessions -F '#{session_name}'

# ---- tmux ----
run "$X" tmux "$CWD" --env LANG=C.UTF-8 -- new-session -d -s term-alice-Ab3_x9 -c "$CWD" -x 120 -y 32 /bin/bash </dev/null
rc_is "tmux: new-session runs" 0
has "tmux: new-session argv" "argv: [new-session] [-d] [-s] [term-alice-Ab3_x9] [-c] [$CWD] [-x] [120] [-y] [32] [/bin/bash]"
run "$X" tmux "$CWD" --env TERM=xterm-256color --env WORKSTATION_USER=alice -- attach-session -t =term-alice-Ab3_x9 </dev/null
rc_is "tmux: attach runs" 0
has "tmux: terminal env passed" "env: WORKSTATION_USER=alice"
run "$X" tmux "$ROOT" -- list-sessions -F '#{session_name}' </dev/null
rc_is "tmux: list-sessions runs" 0
refused "tmux kill-server" "$X" tmux "$ROOT" -- kill-server
refused "tmux send-keys" "$X" tmux "$ROOT" -- send-keys -t =term-alice-x 'rm -rf ~' Enter
refused "tmux other shell" "$X" tmux "$CWD" -- new-session -d -s term-alice-x -c "$CWD" -x 120 -y 32 /usr/bin/python3
refused "tmux session dir outside the root" "$X" tmux "$CWD" -- new-session -d -s term-alice-x -c "$T/outside" -x 120 -y 32 /bin/bash
refused "tmux extra argument" "$X" tmux "$CWD" -- new-session -d -s term-alice-x -c "$CWD" -x 120 -y 32 /bin/bash -l
refused "tmux bad session name" "$X" tmux "$ROOT" -- has-session -t '=other;rm'
refused "tmux stdin secrets" "$X" tmux "$ROOT" --stdin-secrets -- list-sessions -F '#{session_name}'

# ---- fetch: chats' downloads (curl in bubblewrap; here a fake bwrap prints what it would run) ----
FD="$T/hf/AbCdEfGhIjKlMnOpQrSt_-"
PYPI=https://files.pythonhosted.org/packages/ab/cd/requests-2.32.3-py3-none-any.whl
run "$X" fetch "$FD" "$PYPI" 151.101.0.223 524288000 600 </dev/null
rc_is "fetch: runs" 0
has "fetch: bubblewrap namespaces" "argv: [--unshare-all] [--share-net] [--die-with-parent] [--new-session] [--tmpfs] [/]"
has "fetch: /usr read-only" "[--ro-bind] [/usr] [/usr]"
has "fetch: only the output directory writable" "[--bind] [$FD] [$FD] [--chdir] [$FD]"
lacks "fetch: no home, users root or /tmp bound" "[$T/home]"
lacks "fetch: no users root" "[$ROOT"
has "fetch: exact curl call" "[--] [$T/bin/curl] [-q] [--silent] [--show-error] [--proto] [=https] [--max-redirs] [0] [--resolve] [files.pythonhosted.org:443:151.101.0.223] [--max-filesize] [524288000] [--max-time] [600] [--globoff] [--output] [$FD/body] [--write-out] [%{http_code}\n%{content_type}\n%{redirect_url}\n%{size_download}\n] [--url] [$PYPI]"
lacks "fetch: no -L / --location" "[-L]"
lacks "fetch: no cookies" "[--cookie"
lacks "fetch: no headers" "[-H]"
has "fetch: clean environment" "env: PATH=/usr/bin:/bin"
lacks "fetch: hub environment dropped" "WORKSTATION_TEST_SECRET"
lacks "fetch: no agent HOME" "env: HOME="
if [[ -d $FD && ! -L $FD && $(stat -c %a "$FD") == 700 && $(stat -c %a "$T/hf") == 700 ]]; then pass "fetch: output directory created 0700"; else fail "fetch: output directory not created 0700"; fi
refused "fetch into a directory that exists already" "$X" fetch "$FD" "$PYPI" 151.101.0.223 1000 60
run "$X" fetch "$T/hf/BbCdEfGhIjKlMnOpQrSt_-" https://huggingface.co/x/resolve/main/model.bin 2606:4700::6810:84e5 1000 60 </dev/null
has "fetch: an IPv6 pin in brackets" "[--resolve] [huggingface.co:443:[2606:4700::6810:84e5]]"
run "$X" fetch "$T/hf/CbCdEfGhIjKlMnOpQrSt_-" "https://93.184.216.34/file.txt?a=1&b=%20" 93.184.216.34 1000 60 </dev/null
rc_is "fetch: an address literal runs" 0
lacks "fetch: an address literal is its own pin" "[--resolve]"
refused "fetch an address literal pinned elsewhere" "$X" fetch "$T/hf/DbCdEfGhIjKlMnOpQrSt_-" https://93.184.216.34/f 93.184.216.35 1000 60
n=0
for url in http://example.com/f ftp://example.com/f "https://user@example.com/f" "https://user:pw@example.com/f" https://example.com:8443/f https://example.com \
  "https://example.com/a b" "https://example.com/$(printf 'a\nb')" "https://example.com/\"x" "https://example.com/<x>" "https://example.com/$(head -c 2100 /dev/zero | tr '\0' a)" \
  https://1.2.3/f "https://-x..example/f" file:///etc/passwd; do
  n=$((n + 1))
  refused "fetch URL #$n (${url:0:40})" "$X" fetch "$T/hf/EbCdEfGhIjKlMnOpQrSt_-" "$url" 151.101.0.223 1000 60
done
for ip in 127.0.0.1 10.1.2.3 192.168.1.10 100.64.0.10 100.64.0.1 169.254.169.254 172.16.0.1 172.31.255.255 0.0.0.0 224.0.0.1 255.255.255.255 \
  192.0.2.1 198.18.0.1 203.0.113.9 1.2.3.256 01.2.3.4 ::1 :: fe80::1 fd7a:115c:a1e0::1 fc00::1 ::ffff:127.0.0.1 ::ffff:8.8.8.8 2001:db8::1 2002:c0a8::1 \
  2001:0:4136:e378::1 ff02::1 200::1 localhost "8.8.8.8 " ""; do
  refused "fetch from address '$ip'" "$X" fetch "$T/hf/FbCdEfGhIjKlMnOpQrSt_-" https://example.com/f "$ip" 1000 60
done
for limits in "0 60" "-1 60" "abc 60" "10737418241 60" "1000 0" "1000 7201" "1000 1.5" "1000 060"; do
  read -r mx tm <<<"$limits"
  refused "fetch limits $limits" "$X" fetch "$T/hf/GbCdEfGhIjKlMnOpQrSt_-" https://example.com/f 8.8.8.8 "$mx" "$tm"
done
for d in "$T/outside/AbCdEfGhIjKlMnOpQrSt_-" "$T/hf/short" "$T/hf/AbCdEfGhIjKlMnOpQrSt_-/x" "$T/hf/../hs/AbCdEfGhIjKlMn" "$T/hf"; do
  refused "fetch into $d" "$X" fetch "$d" https://example.com/f 8.8.8.8 1000 60
done
refused "fetch with too few arguments" "$X" fetch "$T/hf/HbCdEfGhIjKlMnOpQrSt_-" https://example.com/f 8.8.8.8 1000
refused "fetch with too many arguments" "$X" fetch "$T/hf/HbCdEfGhIjKlMnOpQrSt_-" https://example.com/f 8.8.8.8 1000 60 -L
if [[ ! -e $T/hf/EbCdEfGhIjKlMnOpQrSt_- && ! -e $T/hf/FbCdEfGhIjKlMnOpQrSt_- ]]; then pass "fetch: a refused call creates nothing"; else fail "fetch: a refused call left a directory"; fi

# ---- fetchmv / fetchrm ----
CHAT="$ROOT/alice/.chat/$UUID"
mkdir -p "$CHAT"
printf 'wheel bytes' >"$FD/body"
run "$X" fetchmv "$FD" "$CHAT/downloads" requests-2.32.3-py3-none-any.whl </dev/null
rc_is "fetchmv: runs" 0
has "fetchmv: prints the path" "$CHAT/downloads/requests-2.32.3-py3-none-any.whl"
if [[ $(cat "$CHAT/downloads/requests-2.32.3-py3-none-any.whl") == "wheel bytes" && ! -e $FD ]]; then pass "fetchmv: file in the chat's downloads, temp directory gone"; else fail "fetchmv: file not moved"; fi
for k in 1 2; do
  mkdir -m 0700 "$FD" && printf 'take %s' "$k" >"$FD/body"
  run "$X" fetchmv "$FD" "$CHAT/downloads" requests-2.32.3-py3-none-any.whl </dev/null
  has "fetchmv: never overwrites (suffix $k)" "$CHAT/downloads/requests-2.32.3-py3-none-any-$k.whl"
done
if [[ $(cat "$CHAT/downloads/requests-2.32.3-py3-none-any.whl") == "wheel bytes" && $(cat "$CHAT/downloads/requests-2.32.3-py3-none-any-2.whl") == "take 2" ]]; then pass "fetchmv: earlier files untouched"; else fail "fetchmv: an earlier file changed"; fi
for k in 0 1; do
  mkdir -m 0700 "$FD" && printf 'tgz %s' "$k" >"$FD/body"
  run "$X" fetchmv "$FD" "$CHAT/downloads" pkg-1.0.tar.gz </dev/null
done
has "fetchmv: .tar.gz kept together in the suffix" "$CHAT/downloads/pkg-1.0-1.tar.gz"
mkdir -m 0700 "$FD" && printf 'x' >"$FD/body"
ln -s "$T/outside/target" "$CHAT/downloads/README"
run "$X" fetchmv "$FD" "$CHAT/downloads" README </dev/null
has "fetchmv: a symlink is never written through" "$CHAT/downloads/README-1"
if [[ ! -e $T/outside/target ]]; then pass "fetchmv: symlink target untouched"; else fail "fetchmv: wrote through a symlink"; fi
mkdir -m 0700 "$FD" && printf 'x' >"$FD/body"
for name in ../x .hidden a/b "a b" "" "$(head -c 151 /dev/zero | tr '\0' a)" "-rf" $'x\ny' $'x\n'; do
  refused "fetchmv name '${name:0:20}'" "$X" fetchmv "$FD" "$CHAT/downloads" "$name"
done
for dest in "$ROOT/alice/proj/downloads" "$CHAT" "$CHAT/downloads/sub" "$T/outside/.chat/$UUID/downloads" "$ROOT/alice/.chat/not-a-uuid/downloads" "$ROOT/alice/.chat/$UUID/../$UUID/downloads" "alice/.chat/$UUID/downloads"; do
  refused "fetchmv into $dest" "$X" fetchmv "$FD" "$dest" file.txt
done
mkdir -p "$T/outside/.chat/$UUID" && ln -s "$T/outside" "$ROOT/mallory"
refused "fetchmv into a chat folder through a symlink out" "$X" fetchmv "$FD" "$ROOT/mallory/.chat/$UUID/downloads" file.txt
OTHER="$ROOT/alice/.chat/1f4c1e2a-3b5d-4c6e-8f70-1a2b3c4d5e6f"
mkdir -p "$OTHER" && ln -s "$T/outside" "$OTHER/downloads"
refused "fetchmv into a downloads folder that is a symlink" "$X" fetchmv "$FD" "$OTHER/downloads" file.txt
refused "fetchmv from outside the fetch root" "$X" fetchmv "$T/outside" "$CHAT/downloads" file.txt
refused "fetchmv from a directory without a file" "$X" fetchmv "$T/hf/BbCdEfGhIjKlMnOpQrSt_-" "$CHAT/downloads" file.txt
refused "fetchmv with two arguments" "$X" fetchmv "$FD" "$CHAT/downloads"
if [[ -f $FD/body && $(ls "$T/outside") != *file.txt* ]]; then pass "fetchmv: refused calls move nothing"; else fail "fetchmv: a refused call moved something"; fi
run "$X" fetchrm "$FD" </dev/null
rc_is "fetchrm: runs" 0
if [[ ! -e $FD ]]; then pass "fetchrm: the directory is gone"; else fail "fetchrm: $FD still there"; fi
run "$X" fetchrm "$FD" </dev/null
rc_is "fetchrm: an absent directory is fine" 0
refused "fetchrm outside the fetch root" "$X" fetchrm "$T/outside"
refused "fetchrm the fetch root itself" "$X" fetchrm "$T/hf"
refused "fetchrm a process temp directory" "$X" fetchrm "$T/hs/AbCdEfGhIjKlMnOpQrSt_-"
ln -s "$T/outside" "$T/hf/IbCdEfGhIjKlMnOpQrSt_-"
refused "fetchrm a symlink" "$X" fetchrm "$T/hf/IbCdEfGhIjKlMnOpQrSt_-"
if [[ -d $T/outside ]]; then pass "fetchrm: symlink target untouched"; else fail "fetchrm: followed a symlink"; fi
rm "$T/hf/IbCdEfGhIjKlMnOpQrSt_-"
mv "$T/hf" "$T/hf-real" && ln -s "$T/hf-real" "$T/hf"
refused "fetch under a fetch root that is a symlink" "$X" fetch "$T/hf/JbCdEfGhIjKlMnOpQrSt_-" "$PYPI" 151.101.0.223 1000 60
rm "$T/hf" && mv "$T/hf-real" "$T/hf"

# ---- modes, accounts, signal ----
refused "unknown mode" "$X" bash "$CWD" -- -c id
refused "no mode" "$X"
configure nobody-workstation-test "$T/other-user"
refused "another account" "$T/other-user" claude "$ROOT" -- --version
refused "signal bad name" "$X" signal STOP 123
refused "signal bad pid" "$X" signal TERM 'x1'

bash -c 'sleep 30 & wait' &
parent=$!
for _ in $(seq 50); do
  [ -n "$(cat /proc/"$parent"/task/*/children 2>/dev/null || true)" ] && break
  ps -o pid= --ppid "$parent" 2>/dev/null | grep -q . && break
  sleep 0.1
done
run "$X" signal TERM "$parent" </dev/null
rc_is "signal: runs" 0
gone=1
for _ in $(seq 50); do
  if ! kill -0 "$parent" 2>/dev/null; then
    gone=0
    break
  fi
  sleep 0.1
done
wait "$parent" 2>/dev/null || true
if [ "$gone" -eq 0 ]; then pass "signal: the child of the given process was terminated"; else fail "signal: child still running"; fi

echo "1..$N"
if [ "$FAILS" -ne 0 ]; then
  echo "$FAILS of $N failed"
  exit 1
fi
echo "all $N passed"
