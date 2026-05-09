#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-gateway}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/edgespark/$ALIAS"
SERVER_DIR="$PROJECT_DIR/server"
TARGET_SRC="$SERVER_DIR/src/index.ts"

: "${EDGESPARK_API_KEY:?Missing EDGESPARK_API_KEY}"
: "${BLOOME_API_KEY:?Missing BLOOME_API_KEY}"
: "${CLIENT_API_KEY:?Missing CLIENT_API_KEY}"

export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"

if [[ ! -f "$PROJECT_DIR/edgespark.toml" ]]; then
  echo "Missing EdgeSpark scaffold: $PROJECT_DIR/edgespark.toml"
  echo "Run: bloome-cli edgespark project create --alias $ALIAS"
  exit 1
fi

if [[ ! -f "$TARGET_SRC" ]]; then
  echo "Missing target source file: $TARGET_SRC"
  echo "Run: cd $PROJECT_DIR && edgespark pull"
  exit 1
fi

echo "==> Syncing runtime vars"
(cd "$PROJECT_DIR" && edgespark var set \
  "BLOOME_API_KEY=${BLOOME_API_KEY}" \
  "CLIENT_API_KEY=${CLIENT_API_KEY}")

echo "==> Syncing gateway code into EdgeSpark scaffold"
cp "$ROOT_DIR/src/index.ts" "$TARGET_SRC"

if ! grep -q '^import { vars } from "edgespark";$' "$TARGET_SRC"; then
  sed -i '1s/^/import { vars } from "edgespark";\n/' "$TARGET_SRC"
fi

sed -i 's|// __EDGESPARK_INJECT_VARS__|try { const v = vars.get(key as RuntimeKey); if (v) return v; } catch(e) {}|' "$TARGET_SRC"

if ! grep -q '^import { installBloomeBridge } from "\./bloome-bridge";$' "$TARGET_SRC"; then
  sed -i '1a import { installBloomeBridge } from "./bloome-bridge";' "$TARGET_SRC"
fi

if ! grep -q '^installBloomeBridge(app);$' "$TARGET_SRC"; then
  sed -i 's|const app = new Hono();|const app = new Hono();\n\ninstallBloomeBridge(app);|' "$TARGET_SRC"
fi

echo "==> Pulling generated types"
(cd "$PROJECT_DIR" && edgespark pull)

echo "==> Installing server deps"
(cd "$SERVER_DIR" && npm install)

echo "==> Deploying"
(cd "$PROJECT_DIR" && edgespark deploy)
