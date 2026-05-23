#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-${EDGESPARK_ALIAS:-gateway}}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-edgespark.sh"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

require_cmd bloome
require_cmd python3

: "${EDGESPARK_SECRET_NAME:?Missing EDGESPARK_SECRET_NAME, for example EDGESPARK_API_KEY__GATEWAY_20260523__2ED11CE1}"
: "${RESON_LLM_API_KEY:?Missing RESON_LLM_API_KEY}"
: "${CLIENT_API_KEY:?Missing CLIENT_API_KEY; ask the user for this value, do not generate it locally}"

export ALIAS
export DEPLOY_SCRIPT
export EDGESPARK_SECRET_NAME
export HOT_DEPLOY_ONLY="${HOT_DEPLOY_ONLY:-0}"
export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"
export RESON_LLM_API_KEY
export CLIENT_API_KEY

echo "==> Deploying $ALIAS through Bloome secret call"
bloome secret call "$EDGESPARK_SECRET_NAME" -- bash -c '
  set -euo pipefail
  export EDGESPARK_API_KEY="${!EDGESPARK_SECRET_NAME}"
  export EDGESPARK_PROJECT_ENVIRONMENT="${EDGESPARK_PROJECT_ENVIRONMENT:-production}"
  export BLOOME_API_KEY="$RESON_LLM_API_KEY"
  bash "$DEPLOY_SCRIPT" "$ALIAS"
'

if [[ -z "${BASE_URL:-}" ]]; then
  echo "==> Skipping post-deploy verification; set BASE_URL to enable it"
  exit 0
fi

require_cmd curl

echo "==> Post-deploy verification"
curl -fsS "$BASE_URL/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="ok", d; print("Health OK")'

curl -fsS -X POST "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":8}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("choices"), d; print("Chat OK")'
