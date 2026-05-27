#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-gateway}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${HOT_DEPLOY_ONLY:-0}" == "1" ]]; then
  export SKIP_VAR_SYNC=1
  export SKIP_PULL=1
  export SKIP_NPM_INSTALL="${SKIP_NPM_INSTALL:-1}"
fi
PROJECT_DIR="${EDGESPARK_PROJECT_DIR:-}"
if [[ -z "$PROJECT_DIR" ]]; then
  for candidate in "$ROOT_DIR/edgespark/$ALIAS" "$ROOT_DIR/../edgespark/$ALIAS"; do
    if [[ -f "$candidate/edgespark.toml" ]]; then
      PROJECT_DIR="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi
PROJECT_DIR="${PROJECT_DIR:-$ROOT_DIR/edgespark/$ALIAS}"
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
require_cmd python3

: "${EDGESPARK_API_KEY:?Missing EDGESPARK_API_KEY}"
if [[ "${SKIP_VAR_SYNC:-0}" != "1" ]]; then
  : "${PROVIDER_API_KEY:?Missing PROVIDER_API_KEY}"
  : "${CLIENT_API_KEY:?Missing CLIENT_API_KEY}"
fi
if [[ "${SKIP_NPM_INSTALL:-0}" != "1" ]]; then
  require_cmd npm
fi

export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"

if [[ ! -f "$SOURCE_SRC" ]]; then
  echo "Missing source file: $SOURCE_SRC"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/edgespark.toml" ]]; then
  echo "Missing EdgeSpark scaffold: $PROJECT_DIR/edgespark.toml"
  echo "Run: <cloud-cli> edgespark project create --alias $ALIAS"
  echo "If the scaffold is outside this repo, set EDGESPARK_PROJECT_DIR=/absolute/path/to/edgespark/$ALIAS"
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

if [[ "${SKIP_VAR_SYNC:-0}" != "1" ]]; then
  echo "==> Syncing runtime vars"
  runtime_vars=(
    "PROVIDER_API_KEY=${PROVIDER_API_KEY}"
    "CLIENT_API_KEY=${CLIENT_API_KEY}"
  )
  if [[ -n "${PROVIDER_BASE_URL:-}" ]]; then
    runtime_vars+=("PROVIDER_BASE_URL=${PROVIDER_BASE_URL}")
  fi
  if [[ -n "${ANTHROPIC_DEFAULT_MAX_TOKENS:-}" ]]; then
    runtime_vars+=("ANTHROPIC_DEFAULT_MAX_TOKENS=${ANTHROPIC_DEFAULT_MAX_TOKENS}")
  fi
  if [[ -n "${GEMINI_DEFAULT_MAX_TOKENS:-}" ]]; then
    runtime_vars+=("GEMINI_DEFAULT_MAX_TOKENS=${GEMINI_DEFAULT_MAX_TOKENS}")
  fi
  if [[ -n "${APP_DEV_MODE:-}" ]]; then
    runtime_vars+=("APP_DEV_MODE=${APP_DEV_MODE}")
  fi
  (cd "$PROJECT_DIR" && edgespark var set "${runtime_vars[@]}")
else
  echo "==> Skipping runtime vars sync"
fi

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
new = 'export type VarKey =\n  | "PROVIDER_BASE_URL"\n  | "PROVIDER_API_KEY"\n  | "CLIENT_API_KEY"\n  | "ANTHROPIC_DEFAULT_MAX_TOKENS"\n  | "GEMINI_DEFAULT_MAX_TOKENS"\n  | "APP_DEV_MODE";'
if old in text:
    text = text.replace(old, new)
else:
    text = re.sub(r'export type VarKey =\n(?:\s*\| .*\n)*\s*;', new, text, count=1)
p.write_text(text)
PY

if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  echo "==> Pulling generated types"
  (cd "$PROJECT_DIR" && edgespark pull)
else
  echo "==> Skipping generated types pull"
fi

if [[ "${SKIP_NPM_INSTALL:-0}" != "1" ]]; then
  echo "==> Installing server deps"
  (cd "$SERVER_DIR" && npm install)
else
  echo "==> Skipping server deps install"
fi

echo "==> Deploying"
(cd "$PROJECT_DIR" && edgespark deploy)
