#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-gateway}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/edgespark/$ALIAS"
SERVER_DIR="$PROJECT_DIR/server"
SOURCE_SRC="$ROOT_DIR/src/index.ts"
TARGET_SRC="$SERVER_DIR/src/index.ts"
TARGET_RUNTIME="$SERVER_DIR/src/defs/runtime.ts"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

require_cmd edgespark
require_cmd npm
require_cmd python3

: "${EDGESPARK_API_KEY:?Missing EDGESPARK_API_KEY}"
: "${BLOOME_API_KEY:?Missing BLOOME_API_KEY}"
: "${CLIENT_API_KEY:?Missing CLIENT_API_KEY}"

export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"

if [[ ! -f "$SOURCE_SRC" ]]; then
  echo "Missing source file: $SOURCE_SRC"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/edgespark.toml" ]]; then
  echo "Missing EdgeSpark scaffold: $PROJECT_DIR/edgespark.toml"
  echo "Run: bloome edgespark project create --alias $ALIAS (or the equivalent bloome-cli wrapper in shell environments)"
  exit 1
fi

if [[ ! -f "$TARGET_SRC" ]]; then
  echo "Missing target source file: $TARGET_SRC"
  echo "Run: cd $PROJECT_DIR && edgespark pull"
  exit 1
fi

if [[ ! -f "$TARGET_RUNTIME" ]]; then
  echo "Missing runtime defs file: $TARGET_RUNTIME"
  echo "Run: cd $PROJECT_DIR && edgespark pull"
  exit 1
fi

echo "==> Syncing runtime vars"
(cd "$PROJECT_DIR" && edgespark var set \
  "BLOOME_API_KEY=${BLOOME_API_KEY}" \
  "CLIENT_API_KEY=${CLIENT_API_KEY}")

echo "==> Syncing gateway code into EdgeSpark scaffold"
cp "$SOURCE_SRC" "$TARGET_SRC"

python3 - <<'PY' "$TARGET_SRC"
from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
text = p.read_text()

imports = [
    'import { vars } from "edgespark";',
    'import { installBloomeBridge } from "./bloome-bridge";',
]
for imp in reversed(imports):
    if imp not in text:
        text = imp + "\n" + text

marker = "// __EDGESPARK_INJECT_VARS__"
vars_lookup = 'try { const v = vars.get(key as RuntimeKey); if (v) return v; } catch(e) {}'
if marker in text:
    text = text.replace(marker, vars_lookup, 1)
elif vars_lookup not in text:
    raise SystemExit(f"Missing EdgeSpark vars injection marker in {p}")

if "installBloomeBridge(app);" not in text:
    text, count = re.subn(
        r"const\s+app\s*=\s*new\s+Hono\s*\(\s*\)\s*;",
        "const app = new Hono();\n\ninstallBloomeBridge(app);",
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"Could not find Hono app declaration in {p}")

p.write_text(text)
PY

echo "==> Patching EdgeSpark runtime VarKey"
python3 - <<'PY' "$TARGET_RUNTIME"
from pathlib import Path
import re
import sys
p = Path(sys.argv[1])
text = p.read_text()
old = 'export type VarKey = never;'
new = 'export type VarKey =\n  | "BLOOME_API_KEY"\n  | "CLIENT_API_KEY";'
if old in text:
    text = text.replace(old, new)
else:
    text = re.sub(r'export type VarKey =\n(?:\s*\| .*\n)*\s*;', new, text, count=1)
p.write_text(text)
PY

echo "==> Pulling generated types"
(cd "$PROJECT_DIR" && edgespark pull)

echo "==> Installing server deps"
(cd "$SERVER_DIR" && npm install)

echo "==> Deploying"
(cd "$PROJECT_DIR" && edgespark deploy)
