#!/usr/bin/env bash
# Re-exec under bash when invoked as "sh script.sh ..." (common in Termux/BotDrop).
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "ERROR: bash is required for $0" >&2
  exit 1
fi
set -euo pipefail

usage() {
  cat <<'MSG'
Usage:
  bash scripts/bootstrap_xiotbox_termux.sh \
    <GATEWAY_WSS_URL> <DEVICE_ID> <DEVICE_TOKEN> \
    [XIOTBOX_API_BASE_URL] [TAG_OR_REPO] [ALLOW_NEW_CLIENT_IDENTITIES] \
    [MODEL_API_KEY] [MODEL_OR_FULL_MODEL]

Examples:
  # xiotbox only: install + config + start + verify
  bash scripts/bootstrap_xiotbox_termux.sh \
    wss://socketd.odoo.games/ws/openclaw <DEVICE_ID> <DEVICE_TOKEN>

  # xiotbox + deepseek model config
  bash scripts/bootstrap_xiotbox_termux.sh \
    wss://socketd.odoo.games/ws/openclaw <DEVICE_ID> <DEVICE_TOKEN> \
    https://api.xiotbox.com 2.0.9 1 <MODEL_API_KEY> deepseek-chat

Notes:
  - MODEL_API_KEY: pass '-' to skip model setup.
  - MODEL_OR_FULL_MODEL: default deepseek-chat.
  - This script always runs health check at the end.
MSG
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

GATEWAY_WSS_URL="${1:-}"
DEVICE_ID="${2:-}"
DEVICE_TOKEN="${3:-}"
XIOTBOX_API_BASE_URL="${4:-https://api.xiotbox.com}"
TAG_OR_REPO="${5:-2.0.9}"
ALLOW_NEW_CLIENT_IDENTITIES="${6:-1}"
MODEL_API_KEY="${7:--}"
MODEL_OR_FULL_MODEL="${8:-deepseek-chat}"

if [ -z "$GATEWAY_WSS_URL" ] || [ -z "$DEVICE_ID" ] || [ -z "$DEVICE_TOKEN" ]; then
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[xiotbox-bootstrap] step 1/3 install + channel config + gateway start"
OPENCLAW_AUTO_EDIT="${OPENCLAW_AUTO_EDIT:-0}" \
OPENCLAW_SKIP_DOCTOR="${OPENCLAW_SKIP_DOCTOR:-1}" \
OPENCLAW_RESTART_GATEWAY="${OPENCLAW_RESTART_GATEWAY:-1}" \
bash "$SCRIPT_DIR/install_configure_xiotbox.sh" \
  "$GATEWAY_WSS_URL" \
  "$DEVICE_ID" \
  "$DEVICE_TOKEN" \
  "$XIOTBOX_API_BASE_URL" \
  "$TAG_OR_REPO" \
  "$ALLOW_NEW_CLIENT_IDENTITIES"

model_checked=0
if [ -n "$MODEL_API_KEY" ] && [ "$MODEL_API_KEY" != "-" ]; then
  echo "[xiotbox-bootstrap] step 2/3 model config ($MODEL_OR_FULL_MODEL)"
  bash "$SCRIPT_DIR/configure_deepseek_termux.sh" "$MODEL_API_KEY" "$MODEL_OR_FULL_MODEL"
  model_checked=1
else
  echo "[xiotbox-bootstrap] step 2/3 skip model config (MODEL_API_KEY not provided)"
fi

echo "[xiotbox-bootstrap] step 3/3 health check"
if [ "$model_checked" -eq 1 ]; then
  CHECK_MODEL="${CHECK_MODEL:-1}" \
  CHECK_GATEWAY="${CHECK_GATEWAY:-1}" \
  CHECK_PLUGIN="${CHECK_PLUGIN:-1}" \
  bash "$SCRIPT_DIR/health_check_xiotbox.sh"
else
  CHECK_MODEL="${CHECK_MODEL:-0}" \
  CHECK_GATEWAY="${CHECK_GATEWAY:-1}" \
  CHECK_PLUGIN="${CHECK_PLUGIN:-1}" \
  bash "$SCRIPT_DIR/health_check_xiotbox.sh"
fi

echo "[xiotbox-bootstrap] done"
