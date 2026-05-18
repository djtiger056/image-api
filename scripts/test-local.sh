#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
if [ -f "$ROOT_DIR/local.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/local.env"
  set +a
fi
: "${SERVER_PORT:=18080}"
: "${JIMENG_SESSIONID:?JIMENG_SESSIONID 未配置}"
BASE_URL="http://127.0.0.1:${SERVER_PORT}"
echo "==> GET ${BASE_URL}/v1/models"
curl -fsS "${BASE_URL}/v1/models"
echo

echo "==> POST ${BASE_URL}/token/points"
curl -fsS -X POST "${BASE_URL}/token/points" \
  -H "Authorization: Bearer ${JIMENG_SESSIONID}" \
  -H "Content-Type: application/json" \
  -d '{}'
echo
