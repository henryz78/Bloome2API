#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-gateway-$(date +%Y%m%d-%H%M%S)}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CREATE_JSON="$(mktemp)"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || {
    echo "Missing required env: $name" >&2
    exit 1
  }
}

require_cmd bloome-cli
require_cmd python3
require_env BLOOME_API_KEY
require_env CLIENT_API_KEY

cd "$ROOT_DIR"

echo "==> Creating EdgeSpark project alias: $ALIAS"
bloome-cli edgespark project create --alias "$ALIAS" > "$CREATE_JSON"
cat "$CREATE_JSON"

readarray -t CREATE_FIELDS < <(python3 - <<'PY' "$CREATE_JSON"
import json, sys
p = json.load(open(sys.argv[1]))
scaffold = p.get("localScaffold") or {}
print(p.get("alias", ""))
print(p.get("projectId", ""))
print(p.get("baseUrl", ""))
print(p.get("apiKeySecretName", ""))
print(scaffold.get("dir", f'edgespark/{p.get("alias", "")}' ))
PY
)

ALIAS_FROM_CREATE="${CREATE_FIELDS[0]}"
PROJECT_ID="${CREATE_FIELDS[1]}"
BASE_URL="${CREATE_FIELDS[2]}"
SECRET_NAME="${CREATE_FIELDS[3]}"
PROJECT_DIR_REL="${CREATE_FIELDS[4]}"
PROJECT_DIR="$ROOT_DIR/$PROJECT_DIR_REL"

if [[ -z "$SECRET_NAME" ]]; then
  echo "Failed to read apiKeySecretName from create output" >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "==> Scaffold missing, generating it"
  bloome-cli edgespark project scaffold "$ALIAS_FROM_CREATE" --no-install
fi

echo "==> Pull smoke test"
bloome-cli secret call "$SECRET_NAME" -- bash -c '
  set -euo pipefail
  SECRET_NAME="$1"
  PROJECT_DIR="$2"
  export EDGESPARK_API_KEY="${!SECRET_NAME}"
  export EDGESPARK_PROJECT_ENVIRONMENT=production
  cd "$PROJECT_DIR"
  edgespark pull
' _ "$SECRET_NAME" "$PROJECT_DIR"

echo "==> Deploying gateway code"
bloome-cli secret call "$SECRET_NAME" -- bash -c '
  set -euo pipefail
  SECRET_NAME="$1"
  ROOT_DIR="$2"
  ALIAS="$3"
  BLOOME_API_KEY_VALUE="$4"
  CLIENT_API_KEY_VALUE="$5"
  export EDGESPARK_API_KEY="${!SECRET_NAME}"
  export BLOOME_API_KEY="$BLOOME_API_KEY_VALUE"
  export CLIENT_API_KEY="$CLIENT_API_KEY_VALUE"
  cd "$ROOT_DIR"
  ./scripts/deploy-edgespark.sh "$ALIAS"
' _ "$SECRET_NAME" "$ROOT_DIR" "$ALIAS_FROM_CREATE" "$BLOOME_API_KEY" "$CLIENT_API_KEY"

echo "==> Verifying deployment"
bloome-cli edgespark project verify "$ALIAS_FROM_CREATE"

echo "==> Acceptance checks"
HEALTH_URL="$BASE_URL/api/public/v1/health"
MODELS_URL="$BASE_URL/api/public/v1/models"

curl -fsS "$HEALTH_URL"
echo
curl -fsS -H "Authorization: Bearer $CLIENT_API_KEY" "$MODELS_URL" > /dev/null

set +e
NOAUTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$MODELS_URL")"
set -e

echo ""
echo "==> Done"
echo "alias: $ALIAS_FROM_CREATE"
echo "project_id: $PROJECT_ID"
echo "base_url: $BASE_URL"
echo "api_prefix: $BASE_URL/api/public/v1"
echo "models_without_key_status: $NOAUTH_STATUS"
if [[ "$NOAUTH_STATUS" != "401" ]]; then
  echo "warning: expected /models without key to return 401" >&2
fi

rm -f "$CREATE_JSON"
