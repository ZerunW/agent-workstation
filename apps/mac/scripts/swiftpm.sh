#!/usr/bin/env bash
# SwiftPM wrapper for machines that only have the Command Line Tools (no Xcode.app).
#
#   ./scripts/swiftpm.sh build [-c release]
#   ./scripts/swiftpm.sh test  [--filter X]
#
# Why it exists:
#  * Swift 6.4's default build system ("swiftbuild") fails on some Command Line Tools installs with
#    "Unknown error parsing property list", for example when the SDK folder holds broken SDKs.
#    `--build-system native` is unaffected.
#  * The CLT ship Swift Testing (Testing.framework) but not XCTest, and SwiftPM's
#    generated test runner only links Swift Testing when the framework is on the
#    compiler search path — which only command-line flags can reach.
# With Xcode installed both workarounds are skipped and plain `swift` is used.
set -euo pipefail
cd "$(dirname "$0")/.."

cmd="${1:-build}"; shift || true
dev_dir="$(xcode-select -p 2>/dev/null || true)"
extra=()

if [[ "$dev_dir" == *CommandLineTools* ]]; then
  extra+=(--build-system native)
  fw="$dev_dir/Library/Developer/Frameworks"
  lib="$dev_dir/Library/Developer/usr/lib"
  if [[ "$cmd" == "test" && -d "$fw/Testing.framework" ]]; then
    extra+=(-Xswiftc -F -Xswiftc "$fw" -Xlinker -F -Xlinker "$fw"
            -Xlinker -rpath -Xlinker "$fw" -Xlinker -rpath -Xlinker "$lib")
  fi
fi

# The native build system prints a deprecation warning on every call; hide just that line.
swift "$cmd" ${extra[@]+"${extra[@]}"} "$@" 2> >(grep -v "build-system native' has been deprecated" >&2)
