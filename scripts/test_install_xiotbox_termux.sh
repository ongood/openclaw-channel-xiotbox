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

REPO="${1:-https://github.com/xiotbox/openclaw-channel-xiotbox.git#4.0.13}"
CFG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
LOG_DIR="${OPENCLAW_TERMUX_LOG_DIR:-$HOME/.openclaw/logs}"

is_termux=0
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *"/com.termux/"* ]]; then
  is_termux=1
fi
is_proot=0
if [ -n "${PROOT_TMP_DIR:-}" ] || [ -n "${PROOT_DISTRO:-}" ] || [ -n "${PROOT_ROOTFS:-}" ]; then
  is_proot=1
fi

info() {
  printf '[termux-test] %s\n' "$*"
}

warn() {
  printf '[termux-test][WARN] %s\n' "$*" >&2
}

fail() {
  printf '[termux-test][ERROR] %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

show_hints() {
  cat >&2 <<'MSG'
Dependency hints for Termux/proot:
  pkg update
  pkg install -y git nodejs-lts python ca-certificates openssl

Inside Debian/Ubuntu proot rootfs:
  apt-get update
  apt-get install -y git nodejs npm python3 ca-certificates

Only if a plugin has native addons (node-gyp), add toolchain:
  pkg install -y clang make
  # or inside proot:
  apt-get install -y make g++
MSG
}

preflight() {
  info "repo=$REPO"
  [ "$is_termux" -eq 1 ] && info "Detected Termux."
  [ "$is_proot" -eq 1 ] && info "Detected proot."

  need_cmd openclaw || fail "openclaw command not found."
  need_cmd git || {
    [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ] && show_hints
    fail "git not found."
  }
  need_cmd node || {
    [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ] && show_hints
    fail "node not found."
  }
  need_cmd npm || {
    [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ] && show_hints
    fail "npm not found."
  }
  need_cmd python3 || fail "python3 not found."
}

verify_in_config() {
  if [ ! -f "$CFG_PATH" ]; then
    return 1
  fi
  CFG_PATH="$CFG_PATH" python3 - <<'PY'
import json
import os
import pathlib
import sys

cfg_path = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
raw = cfg_path.read_text("utf-8").strip()
data = json.loads(raw) if raw else {}

plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
installs = plugins.get("installs") or {}
channels = data.get("channels") or {}

ok = ("xiotbox" in entries) or ("xiotbox" in installs) or ("xiotbox" in channels)
sys.exit(0 if ok else 1)
PY
}

main() {
  preflight
  mkdir -p "$LOG_DIR"
  local ts
  ts="$(date '+%Y%m%d_%H%M%S')"
  local install_log="$LOG_DIR/openclaw_install_xiotbox_${ts}.log"

  info "Installing plugin via: openclaw plugins install $REPO"
  set +e
  openclaw plugins install "$REPO" >"$install_log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    fail "Install failed (rc=$rc). See log: $install_log"
  fi
  info "Install completed. log=$install_log"

  local listed=0
  if openclaw plugins list >"$LOG_DIR/openclaw_plugins_list_${ts}.log" 2>&1; then
    if grep -Eqi '(^|[^A-Za-z0-9_])xiotbox([^A-Za-z0-9_]|$)' "$LOG_DIR/openclaw_plugins_list_${ts}.log"; then
      listed=1
      info "plugins list contains xiotbox."
    else
      warn "plugins list did not show xiotbox. Checking config fallback."
    fi
  else
    warn "openclaw plugins list failed. Checking config fallback."
  fi

  if [ "$listed" -eq 0 ]; then
    verify_in_config || fail "xiotbox not found in plugin list nor config registry."
    info "xiotbox found in openclaw config registry."
  fi

  if openclaw channels list >"$LOG_DIR/openclaw_channels_list_${ts}.log" 2>&1; then
    if grep -Eqi '(^|[^A-Za-z0-9_])xiotbox([^A-Za-z0-9_]|$)' "$LOG_DIR/openclaw_channels_list_${ts}.log"; then
      info "channels list contains xiotbox."
    else
      warn "channels list does not contain xiotbox yet."
    fi
  else
    warn "openclaw channels list failed (non-fatal)."
  fi

  info "PASS: Git install + plugin discoverability checks completed."
}

main "$@"
