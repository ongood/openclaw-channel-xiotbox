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
  bash scripts/install_configure_xiotbox.sh \
    <GATEWAY_WSS_URL> <DEVICE_ID> <DEVICE_TOKEN> [API_BASE_URL] [TAG_OR_REPO] [ALLOW_NEW_CLIENT_IDENTITIES]

Examples:
  bash scripts/install_configure_xiotbox.sh \
  wss://socketd.odoo.games/ws/openclaw <DEVICE_ID> <DEVICE_TOKEN> https://api.xiotbox.com 4.0.8 1

  bash scripts/install_configure_xiotbox.sh \
    wss://socketd.odoo.games/ws/openclaw <DEVICE_ID> <DEVICE_TOKEN> - \
  https://github.com/xiotbox/openclaw-channel-xiotbox.git#4.0.8 0

Notes:
  - API_BASE_URL: pass '-' to keep existing config value (or leave empty).
- TAG_OR_REPO: can be '4.0.8' or full git URL.
MSG
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

GATEWAY_WSS_URL="${1:-}"
DEVICE_ID="${2:-}"
DEVICE_TOKEN="${3:-}"
API_BASE_URL="${4:-https://api.xiotbox.com}"
TAG_OR_REPO="${5:-4.0.8}"
ALLOW_NEW_CLIENT_IDENTITIES="${6:-1}"

if [ -z "$GATEWAY_WSS_URL" ] || [ -z "$DEVICE_ID" ] || [ -z "$DEVICE_TOKEN" ]; then
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export OPENCLAW_AUTO_EDIT="${OPENCLAW_AUTO_EDIT:-0}"
export OPENCLAW_SKIP_DOCTOR="${OPENCLAW_SKIP_DOCTOR:-1}"
export OPENCLAW_RESTART_GATEWAY="${OPENCLAW_RESTART_GATEWAY:-1}"

export XIOTBOX_GATEWAY_WSS="$GATEWAY_WSS_URL"
export XIOTBOX_DEVICE_ID="$DEVICE_ID"
export XIOTBOX_DEVICE_TOKEN="$DEVICE_TOKEN"
export XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES="$ALLOW_NEW_CLIENT_IDENTITIES"
if [ "$API_BASE_URL" != "-" ] && [ -n "$API_BASE_URL" ]; then
  export XIOTBOX_API_BASE="$API_BASE_URL"
fi

echo "[xiotbox-install] configured env:"
echo "  XIOTBOX_GATEWAY_WSS=$XIOTBOX_GATEWAY_WSS"
echo "  XIOTBOX_DEVICE_ID=$XIOTBOX_DEVICE_ID"
echo "  XIOTBOX_API_BASE=${XIOTBOX_API_BASE:-<keep-existing>}"
echo "  XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES=$XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES"
echo "  OPENCLAW_SKIP_DOCTOR=$OPENCLAW_SKIP_DOCTOR"
echo "  OPENCLAW_RESTART_GATEWAY=$OPENCLAW_RESTART_GATEWAY"

bash "$SCRIPT_DIR/update_openclaw_xiotbox.sh" "$TAG_OR_REPO"
