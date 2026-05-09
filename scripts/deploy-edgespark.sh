#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-gateway}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/edgespark/$ALIAS"
SERVER_DIR="$PROJECT_DIR/server"

: "${EDGESPARK_API_KEY:?Missing EDGESPARK_API_KEY}"
: "${BLOOME_API_KEY:?Missing BLOOME_API_KEY}"
: "${CLIENT_API_KEY:?Missing CLIENT_API_KEY}"

export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"

mkdir -p "$PROJECT_DIR"

echo "==> Syncing runtime vars"
(cd "$PROJECT_DIR" && edgespark var set \
  "BLOOME_API_KEY=${BLOOME_API_KEY}" \
  "CLIENT_API_KEY=${CLIENT_API_KEY}")

echo "==> Syncing gateway code into EdgeSpark scaffold"
cp "$ROOT_DIR/src/index.ts" "$SERVER_DIR/src/index.ts"
sed -i '1s/^/import { vars } from "edgespark";\n/' "$SERVER_DIR/src/index.ts"
sed -i 's|// __EDGESPARK_INJECT_VARS__|try { const v = vars.get(key as RuntimeKey); if (v) return v; } catch(e) {}|' "$SERVER_DIR/src/index.ts"
if ! grep -q 'installBloomeBridge(app);' "$SERVER_DIR/src/index.ts"; then
  sed -i '1a import { installBloomeBridge } from "./bloome-bridge";' "$SERVER_DIR/src/index.ts"
  sed -i 's|const app = new Hono();|const app = new Hono();\n\ninstallBloomeBridge(app);|' "$SERVER_DIR/src/index.ts"
fi

echo "==> Pulling generated types"
(cd "$PROJECT_DIR" && edgespark pull)

echo "==> Installing server deps"
(cd "$SERVER_DIR" && npm install)

echo "==> Deploying"
(cd "$PROJECT_DIR" && edgespark deploy)
