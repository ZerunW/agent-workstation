#!/usr/bin/env bash
# Headless verification of the macOS app: it builds and tests the app without launching it or touching the
# desktop (no osascript, no screencapture, no `open`):
#   1. swift build -c release
#   2. swift test  (WorkstationCoreTests + WorkstationUITests: offscreen snapshots + mock-hub flow)
#   3. scripts/make-app.sh  (bundle, icon, ad-hoc signature, dmg)
#   4. list the snapshot PNGs and the .app / .dmg paths
# Clicking through the real app is done by hand on a Mac.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$ROOT/apps/mac"
cd "$MAC"

step() { printf '\n\033[1;34m==== %s ====\033[0m\n' "$*"; }

step "1/4 swift build -c release"
./scripts/swiftpm.sh build -c release

step "2/4 swift test"
LOG="$MAC/.build/test-output.log"
set +e
./scripts/swiftpm.sh test 2>&1 | tee "$LOG" | grep -E "Test run|recorded an issue|error:|passed after|failed after"
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then echo "swift test failed (exit $status) - full log: $LOG"; exit "$status"; fi

step "3/4 package"
bash "$ROOT/scripts/make-app.sh"

step "4/4 artifacts"
echo "Snapshots (offscreen renders, light + dark):"
ls -1 "$MAC/.build/snapshots/"*.png
echo
echo "App: $MAC/dist/AgentWorkstation.app"
echo "DMGs: $MAC/dist/AgentWorkstation-arm64.dmg, $MAC/dist/AgentWorkstation-intel.dmg"
echo "Test log: $LOG"
