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
BASE_URL="http://127.0.0.1:${SERVER_PORT}"

echo "==> GET ${BASE_URL}/v1/models"
curl -fsS "${BASE_URL}/v1/models"
echo

if [ -n "${KLING_API_TOKEN:-}" ] || { [ -n "${KLING_ACCESS_KEY:-}" ] && [ -n "${KLING_SECRET_KEY:-}" ]; }; then
  echo "==> POST ${BASE_URL}/v1/images/generations (Kling async smoke)"
  curl -fsS -X POST "${BASE_URL}/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "kling-v2-1",
      "prompt": "a small robot sitting on a wooden table",
      "async": true
    }'
  echo
else
  echo "跳过 Kling 任务提交测试：未配置 KLING_API_TOKEN 或 KLING_ACCESS_KEY/KLING_SECRET_KEY"
fi
