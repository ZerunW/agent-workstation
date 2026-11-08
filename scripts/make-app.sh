#!/usr/bin/env bash
# Builds apps/mac into two signed apps using only the Command Line Tools (no Xcode), one per
# architecture, each with its own update channel. Never launches the app.
#
#   bash scripts/make-app.sh                 # ad-hoc signed (default)
#   SIGN_IDENTITY="Developer ID Application: …" NOTARY_PROFILE=workstation bash scripts/make-app.sh
#                                            # Developer ID + notarization (needs an Apple Developer account)
#
# Output (same version and build for both):
#   apps/mac/dist/AgentWorkstation.app        + AgentWorkstation-arm64.dmg + release-arm64.json   Apple Silicon, channel "mac"
#   apps/mac/dist/AgentWorkstation-Intel.app  + AgentWorkstation-intel.dmg + release-intel.json   Intel x86_64, channel "mac-intel"
# The x86_64 build is cross-compiled (--triple x86_64-apple-macosx14.0, own scratch path .build/x86_64-scratch);
# each bundle's XPC writer is built for the same architecture. Inside each dmg the app is named AgentWorkstation.app.
# The old single AgentWorkstation.dmg / release.json are no longer written (removed after a successful run).
#
# Release signing: release.json (what the server offers as the newest app) is signed with an Ed25519
# key kept in the login Keychain (generic password, service io.github.agentworkstation.release, account
# ed25519). It is created on the first run in a terminal and never leaves this Mac; the app embeds
# the matching public key (Info.plist WorkstationReleasePublicKey) and refuses releases it did not sign.
#   WORKSTATION_RELEASE_KEY_FILE=<file>   use the base64 key in <file> instead of the Keychain (tests only)
#   WORKSTATION_RELEASE_ONLY=<dmg>        only write <dmg>'s signed release.json next to it (tests);
#                                    WORKSTATION_RELEASE_PLATFORM=mac|mac-intel picks the channel (default mac)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC="$ROOT/apps/mac"
DIST="$MAC/dist"
X86_TRIPLE="x86_64-apple-macosx14.0"
# Version: apps/mac/VERSION holds the last released version; every real build bumps according to the version judge (Claude Haiku through the hub)
# (or WORKSTATION_BUMP override) and writes it back once the build succeeded. WORKSTATION_VERSION overrides; test runs
# (WORKSTATION_RELEASE_KEY_FILE / WORKSTATION_RELEASE_ONLY) never bump.
VERSION_FILE="$ROOT/apps/mac/VERSION"
BUMPED_VERSION=""
if [ -n "${WORKSTATION_VERSION:-}" ]; then
  VERSION="$WORKSTATION_VERSION"
elif [ -n "${WORKSTATION_RELEASE_KEY_FILE:-}" ] || [ -n "${WORKSTATION_RELEASE_ONLY:-}" ]; then
  VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo 0.1.0)"
else
  LAST="$(cat "$VERSION_FILE" 2>/dev/null || echo 0.1.0)"
  [[ $LAST =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "bad version in $VERSION_FILE: $LAST" >&2; exit 1; }
  MAJOR="${BASH_REMATCH[1]}"
  MINOR="${BASH_REMATCH[2]}"
  PATCH="${BASH_REMATCH[3]}"

  if [ -n "${WORKSTATION_BUMP:-}" ]; then
    BUMP="$(echo "$WORKSTATION_BUMP" | tr '[:upper:]' '[:lower:]')"
    REASON="${WORKSTATION_BUMP_REASON:-WORKSTATION_BUMP override}"
  else
    JUDGE_ERR="$(mktemp "${TMPDIR:-/tmp}/judge-err.XXXXXX")"
    BUMP="$(node "$ROOT/scripts/version-judge.mts" --base "$MAC/.release-base" --current "$MAC" 2>"$JUDGE_ERR" || true)"
    REASON="$(cat "$JUDGE_ERR" 2>/dev/null || true)"
    rm -f "$JUDGE_ERR"
    BUMP="$(echo "$BUMP" | tr -d '[:space:]')"
    [ -n "$BUMP" ] || BUMP="patch"
    [ -n "$REASON" ] || REASON="fallback: judge produced no reason"
  fi

  case "$BUMP" in
    major) VERSION="$((MAJOR + 1)).0.0" ;;
    minor) VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
    patch|*) BUMP="patch"; VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  esac
  BUMPED_VERSION="$VERSION"
  echo "version: $LAST -> $VERSION ($BUMP: $REASON)"
fi
BUILD="${WORKSTATION_BUILD:-$(date +%Y%m%d%H%M)}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { echo "make-app.sh: $*" >&2; exit 1; }

cd "$MAC"

# ---- release signing key (resolved first: no build without it) ----
KEY_SERVICE="io.github.agentworkstation.release"
KEY_ACCOUNT="ed25519"
SIGNER="$MAC/.build/release-sign"
if [ ! -x "$SIGNER" ] || [ "$MAC/scripts/release-sign.swift" -nt "$SIGNER" ]; then
  mkdir -p "$MAC/.build"
  swiftc -O "$MAC/scripts/release-sign.swift" -o "$SIGNER"
fi
read_release_key() {
  if [ -n "${WORKSTATION_RELEASE_KEY_FILE:-}" ]; then
    cat "$WORKSTATION_RELEASE_KEY_FILE" 2>/dev/null || true
  else
    security find-generic-password -s "$KEY_SERVICE" -a "$KEY_ACCOUNT" -w 2>/dev/null || true
  fi
}
RELEASE_KEY="$(read_release_key)"
if [ -z "$RELEASE_KEY" ]; then
  [ -z "${WORKSTATION_RELEASE_KEY_FILE:-}" ] || die "no release signing key in $WORKSTATION_RELEASE_KEY_FILE"
  [ -t 0 ] || die "release signing key missing from the login Keychain ($KEY_SERVICE) - run scripts/make-app.sh once in Terminal to create it"
  log "creating the release signing key in the login Keychain ($KEY_SERVICE)"
  NEW_KEY="$("$SIGNER" genkey)"
  # Through security's own command reader, so the key never appears in a process argument list.
  printf 'add-generic-password -s %s -a %s -l AgentWorkstation-release-signing -w %s\n' "$KEY_SERVICE" "$KEY_ACCOUNT" "$NEW_KEY" | security -i >/dev/null
  unset NEW_KEY
  RELEASE_KEY="$(read_release_key)"
  [ -n "$RELEASE_KEY" ] || die "could not store the release signing key in the login Keychain"
fi
RELEASE_PUBKEY="$(printf '%s' "$RELEASE_KEY" | "$SIGNER" pubkey)" || die "the release signing key is not a valid Ed25519 key"

write_release_json() { # <dmg> <out.json> <platform>
  printf '%s' "$RELEASE_KEY" | "$SIGNER" release "$1" "$VERSION" "$BUILD" "$2" "$3" || die "could not sign the release"
}

if [ -n "${WORKSTATION_RELEASE_ONLY:-}" ]; then
  write_release_json "$WORKSTATION_RELEASE_ONLY" "$(dirname "$WORKSTATION_RELEASE_ONLY")/release.json" "${WORKSTATION_RELEASE_PLATFORM:-mac}"
  echo "public key: $RELEASE_PUBKEY"
  exit 0
fi

# ---- build: arm64 (default scratch path) and x86_64 (cross-compiled, own scratch path) ----
build_arch() { # <arch> → prints the bin dir
  local arch="$1"
  local flags=(-c release)
  if [ "$arch" = "x86_64" ]; then flags+=(--triple "$X86_TRIPLE" --scratch-path "$MAC/.build/x86_64-scratch"); fi
  ./scripts/swiftpm.sh build "${flags[@]}" --product AgentWorkstation >&2
  ./scripts/swiftpm.sh build "${flags[@]}" --product WorkstationWriter >&2
  local bin
  bin="$(./scripts/swiftpm.sh build "${flags[@]}" --show-bin-path 2>/dev/null | tail -1)"
  [ -x "$bin/AgentWorkstation" ] || die "release binary not found in $bin"
  [ -x "$bin/WorkstationWriter" ] || die "writer binary not found in $bin"
  for b in "$bin/AgentWorkstation" "$bin/WorkstationWriter"; do
    [ "$(lipo -archs "$b")" = "$arch" ] || die "$b is $(lipo -archs "$b"), expected $arch"
  done
  printf '%s\n' "$bin"
}

log "swift build -c release (arm64)"
BIN_ARM64="$(build_arch arm64)"
log "swift build -c release --triple $X86_TRIPLE (x86_64)"
BIN_X86="$(build_arch x86_64)"

log "drawing the app icon"
ICON_TOOL="$MAC/.build/make-icon"
if [ ! -x "$ICON_TOOL" ] || [ "$MAC/scripts/make-icon.swift" -nt "$ICON_TOOL" ]; then
  mkdir -p "$MAC/.build"
  swiftc -O "$MAC/scripts/make-icon.swift" -o "$ICON_TOOL"
fi
ICONSET="$MAC/.build/AppIcon.iconset"
"$ICON_TOOL" "$ICONSET" >/dev/null
ICNS="$MAC/.build/AppIcon.icns"
iconutil -c icns "$ICONSET" -o "$ICNS"
mkdir -p "$DIST"
cp "$ICONSET/icon_512x512@2x.png" "$DIST/AppIcon-1024.png"

assemble_app() { # <bin dir> <app path> <platform>
  local bin="$1" app="$2" platform="$3"
  log "assembling $app ($platform)"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$bin/AgentWorkstation" "$app/Contents/MacOS/AgentWorkstation"
  # SwiftPM resource bundles (none today, copied if a target ever adds resources).
  for b in "$bin"/*.bundle; do [ -e "$b" ] && cp -R "$b" "$app/Contents/Resources/"; done
  printf 'APPL????' > "$app/Contents/PkgInfo"
  cp "$ICNS" "$app/Contents/Resources/AppIcon.icns"

  # The writer: the only process allowed to change files in linked folders, and only for batches the person
  # approved in a native window. Bundled as an XPC service so only AgentWorkstation.app can talk to it.
  local xpc="$app/Contents/XPCServices/WorkstationWriter.xpc"
  mkdir -p "$xpc/Contents/MacOS"
  cp "$bin/WorkstationWriter" "$xpc/Contents/MacOS/WorkstationWriter"
  sed -e "s/\${VERSION}/${VERSION}/g" -e "s/\${BUILD}/${BUILD}/g" "$MAC/Packaging/WorkstationWriter-Info.plist" > "$xpc/Contents/Info.plist"
  plutil -lint "$xpc/Contents/Info.plist" >/dev/null

  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>AgentWorkstation</string>
  <key>CFBundleIdentifier</key><string>io.github.agentworkstation</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Agent Workstation</string>
  <key>CFBundleDisplayName</key><string>Agent Workstation</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
  <key>WorkstationReleasePublicKey</key><string>${RELEASE_PUBKEY}</string>
  <key>WorkstationPlatform</key><string>${platform}</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Agent Workstation connects to your server on the local network.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- The hub is self-hosted: plain HTTP on a LAN address, or HTTPS on the tailnet. -->
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST
  /usr/libexec/PlistBuddy -c "Merge $MAC/Packaging/DocumentTypes.plist" "$app/Contents/Info.plist" >/dev/null
  plutil -lint "$app/Contents/Info.plist" >/dev/null

  log "codesign $app (identity: ${SIGN_IDENTITY})"
  # Inside out, no --deep: the writer service first (no entitlements), then the app with the App Sandbox
  # entitlements (network client, user-selected files READ-ONLY, app-scoped bookmarks, Downloads) so macOS itself
  # stops the main process from writing into linked folders.
  local ent="$MAC/Packaging/AgentWorkstation.entitlements"
  if [ "$SIGN_IDENTITY" = "-" ]; then
    codesign --force --sign - "$xpc"
    codesign --force --sign - --entitlements "$ent" "$app"
  else
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$xpc"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" --entitlements "$ent" "$app"
  fi
  codesign --verify --deep --strict "$app"
  codesign -d --entitlements :- "$app" 2>/dev/null | grep -E "app-sandbox|read-only" >/dev/null || die "sandbox entitlements missing in $app"
  codesign -dv "$app" 2>&1 | grep -E "Identifier|Signature|Format" || true
}

STAGES=()
cleanup() { for d in ${STAGES[@]+"${STAGES[@]}"}; do rm -rf "$d"; done; }
trap cleanup EXIT

make_dmg() { # <app> <dmg>
  local app="$1" dmg="$2" stage
  log "building $dmg"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/workstation-dmg.XXXXXX")"
  STAGES+=("$stage")
  # Installed as /Applications/AgentWorkstation.app whichever architecture it is.
  cp -R "$app" "$stage/AgentWorkstation.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname "Agent Workstation" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
  if [ "$SIGN_IDENTITY" != "-" ]; then codesign --force --sign "$SIGN_IDENTITY" "$dmg"; fi
  if [ -n "${NOTARY_PROFILE:-}" ] && [ "$SIGN_IDENTITY" != "-" ]; then
    log "notarizing $dmg (keychain profile: $NOTARY_PROFILE)"
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi
}

APP_ARM64="$DIST/AgentWorkstation.app"
APP_INTEL="$DIST/AgentWorkstation-Intel.app"
DMG_ARM64="$DIST/AgentWorkstation-arm64.dmg"
DMG_INTEL="$DIST/AgentWorkstation-intel.dmg"
assemble_app "$BIN_ARM64" "$APP_ARM64" mac
assemble_app "$BIN_X86" "$APP_INTEL" mac-intel
make_dmg "$APP_ARM64" "$DMG_ARM64"
make_dmg "$APP_INTEL" "$DMG_INTEL"

log "signing release-arm64.json (mac) and release-intel.json (mac-intel)"
rm -f "$DIST/release-arm64.json" "$DIST/release-intel.json"
write_release_json "$DMG_ARM64" "$DIST/release-arm64.json" mac
write_release_json "$DMG_INTEL" "$DIST/release-intel.json" mac-intel
unset RELEASE_KEY
# The single-arch layout is gone: drop its leftovers so nothing stale gets deployed.
rm -f "$DIST/AgentWorkstation.dmg" "$DIST/release.json"

# Once per run (not per architecture): remember the released version and its source snapshot.
if [ -n "$BUMPED_VERSION" ]; then
  echo "$BUMPED_VERSION" > "$VERSION_FILE"
  rm -rf "$MAC/.release-base"
  mkdir -p "$MAC/.release-base"
  for item in Sources Packaging Package.swift; do
    [ -e "$MAC/$item" ] && cp -R "$MAC/$item" "$MAC/.release-base/"
  done
fi
log "done (version $VERSION, build $BUILD)"
echo "apple silicon: $APP_ARM64 ($(du -sh "$APP_ARM64" | cut -f1)), $DMG_ARM64 ($(du -h "$DMG_ARM64" | cut -f1)), $DIST/release-arm64.json"
echo "intel:         $APP_INTEL ($(du -sh "$APP_INTEL" | cut -f1)), $DMG_INTEL ($(du -h "$DMG_INTEL" | cut -f1)), $DIST/release-intel.json"
