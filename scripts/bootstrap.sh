#!/usr/bin/env bash
# One-time developer setup on a Mac: installs workspace dependencies and the
# Playwright browser. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node.js >= 22 is required (https://nodejs.org)"; exit 1; }
node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' || { echo "Node.js >= 22 is required, found $(node -v)"; exit 1; }

if [ ! -f config/workstation.toml ]; then
  # The example is closed by default (Tailscale identity, no LAN, no admin by name). A development machine serves only
  # itself, so its copy uses header identities and `admin` as the admin name.
  sed -e 's/^tailscale_identity = true/tailscale_identity = false/' \
      -e 's/^lan_access = "deny"/lan_access = "legacy"/' \
      -e 's/^admin_usernames = \[\]/admin_usernames = ["admin"]/' \
      config/workstation.example.toml > config/workstation.toml
  echo "created config/workstation.toml from the example (header identity, admin user \"admin\"); edit it for your machine"
fi

npm install
npm run build -w packages/protocol
npx --yes playwright install chromium >/dev/null 2>&1 || echo "(playwright browser install skipped)"
echo "bootstrap done"
