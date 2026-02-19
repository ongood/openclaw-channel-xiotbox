#!/usr/bin/env bash
# BotDrop/Termux/proot only:
# Upgrade OpenClaw safely in Android userspace and rebuild the openclaw wrapper.
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
  bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh [version]

Examples:
  # Upgrade to latest
  bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh
  bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh latest

  # Upgrade to a specific version
  bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh 2026.2.6
  bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh openclaw@2026.2.6

Notes:
  - This script is dedicated to BotDrop/Termux/proot environments.
  - It avoids `openclaw update` and performs the BotDrop-safe flow:
    stop gateway -> npm install -> patch koffi(Android) -> rebuild wrapper -> restart gateway.

Optional environment variables:
  - PREFIX (default: /data/data/app.botdrop/files/usr)
  - HOME (default: /data/data/app.botdrop/files/home)
  - OPENCLAW_RESTART_GATEWAY=0|1 (default: 1)
  - OPENCLAW_PATCH_KOFFI_ANDROID=0|1 (default: 1)
  - BOTDROP_STOP_MONITOR=0|1 (default: 1)
  - BOTDROP_RESTART_MONITOR=0|1 (default: 1)
  - OPENCLAW_GATEWAY_PID_FILE (default: $HOME/.openclaw/gateway.pid)
  - OPENCLAW_GATEWAY_LOG_FILE (default: $HOME/.openclaw/gateway.log)
MSG
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

TARGET="${1:-latest}"
if [[ "$TARGET" == openclaw@* ]]; then
  PACKAGE_SPEC="$TARGET"
elif [ -z "$TARGET" ] || [ "$TARGET" = "latest" ] || [ "$TARGET" = "openclaw" ]; then
  PACKAGE_SPEC="openclaw@latest"
else
  PACKAGE_SPEC="openclaw@$TARGET"
fi

PREFIX="${PREFIX:-/data/data/app.botdrop/files/usr}"
HOME="${HOME:-/data/data/app.botdrop/files/home}"

OPENCLAW_RESTART_GATEWAY="${OPENCLAW_RESTART_GATEWAY:-1}"
OPENCLAW_PATCH_KOFFI_ANDROID="${OPENCLAW_PATCH_KOFFI_ANDROID:-1}"
BOTDROP_STOP_MONITOR="${BOTDROP_STOP_MONITOR:-1}"
BOTDROP_RESTART_MONITOR="${BOTDROP_RESTART_MONITOR:-1}"
OPENCLAW_GATEWAY_PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-$HOME/.openclaw/gateway.pid}"
OPENCLAW_GATEWAY_LOG_FILE="${OPENCLAW_GATEWAY_LOG_FILE:-$HOME/.openclaw/gateway.log}"

MONITOR_TOUCHED=0

info() {
  printf '[botdrop-openclaw-upgrade] %s\n' "$*"
}

warn() {
  printf '[botdrop-openclaw-upgrade][WARN] %s\n' "$*" >&2
}

fail() {
  printf '[botdrop-openclaw-upgrade][ERROR] %s\n' "$*" >&2
  exit 1
}

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "on" ]
}

need_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd"
}

start_monitor_if_needed() {
  if [ "$MONITOR_TOUCHED" -ne 1 ] || ! is_truthy "$BOTDROP_RESTART_MONITOR"; then
    return 0
  fi

  if ! command -v am >/dev/null 2>&1; then
    return 0
  fi

  am start-foreground-service -n app.botdrop/app.botdrop.GatewayMonitorService >/dev/null 2>&1 \
    || am startservice -n app.botdrop/app.botdrop.GatewayMonitorService >/dev/null 2>&1 \
    || true
}

trap start_monitor_if_needed EXIT

prepare_env() {
  if [[ "$PREFIX" != /data/data/app.botdrop/files/usr* ]] && [[ "$HOME" != /data/data/app.botdrop/files/home* ]]; then
    warn "Current PREFIX/HOME do not look like BotDrop defaults."
    warn "PREFIX=$PREFIX"
    warn "HOME=$HOME"
  fi

  need_cmd node
  need_cmd npm
  need_cmd pkill

  [ -x "$PREFIX/bin/termux-chroot" ] || fail "termux-chroot not found: $PREFIX/bin/termux-chroot"
  [ -x "$PREFIX/bin/node" ] || fail "node not found: $PREFIX/bin/node"

  export PREFIX
  export HOME
  export PATH="$PREFIX/bin:$PATH"
  export TMPDIR="${TMPDIR:-$PREFIX/tmp}"
  export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
  export NODE_OPTIONS="--dns-result-order=ipv4first"

  mkdir -p "$TMPDIR" "$HOME/.openclaw"
}

stop_monitor_if_needed() {
  if ! is_truthy "$BOTDROP_STOP_MONITOR"; then
    return 0
  fi

  if ! command -v am >/dev/null 2>&1; then
    info "am command unavailable; skip stopping GatewayMonitorService"
    return 0
  fi

  MONITOR_TOUCHED=1
  am stopservice -n app.botdrop/app.botdrop.GatewayMonitorService >/dev/null 2>&1 || true
  info "Requested GatewayMonitorService stop"
}

stop_gateway() {
  info "Stopping OpenClaw gateway"

  local pid=""
  if [ -f "$OPENCLAW_GATEWAY_PID_FILE" ]; then
    pid="$(cat "$OPENCLAW_GATEWAY_PID_FILE" 2>/dev/null || true)"
  fi

  rm -f "$OPENCLAW_GATEWAY_PID_FILE"

  if [ -n "$pid" ]; then
    kill "$pid" >/dev/null 2>&1 || true
    pkill -TERM -P "$pid" >/dev/null 2>&1 || true
  fi

  pkill -TERM -f "openclaw.*gateway" >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL -f "openclaw.*gateway" >/dev/null 2>&1 || true
}

install_openclaw() {
  info "Installing $PACKAGE_SPEC"
  npm install -g "$PACKAGE_SPEC" --ignore-scripts --force
}

patch_single_koffi_index() {
  local koffi_index="$1"

  if [ ! -f "$koffi_index" ]; then
    return 0
  fi

  if grep -q "koffi native module not available on this platform" "$koffi_index" 2>/dev/null; then
    info "koffi Android mock already applied: $koffi_index"
    return 0
  fi

  if [ ! -f "$koffi_index.orig" ]; then
    cp "$koffi_index" "$koffi_index.orig"
    info "Backed up original koffi loader: $koffi_index.orig"
  fi

  cat > "$koffi_index" <<'EOF'
// Mock koffi module for platforms where native module is unavailable (e.g. Android/Termux)
module.exports = {
  load() {
    throw new Error("koffi native module not available on this platform");
  },
};
EOF

  info "Applied Android-safe koffi mock: $koffi_index"
}

patch_koffi_android_if_needed() {
  if ! is_truthy "$OPENCLAW_PATCH_KOFFI_ANDROID"; then
    info "Skipping koffi Android patch (OPENCLAW_PATCH_KOFFI_ANDROID=$OPENCLAW_PATCH_KOFFI_ANDROID)"
    return 0
  fi

  local node_platform=""
  node_platform="$("$PREFIX/bin/node" -p "process.platform" 2>/dev/null || true)"
  if [ "$node_platform" != "android" ]; then
    info "Node platform is '$node_platform'; skip koffi Android patch"
    return 0
  fi

  local base="$PREFIX/lib/node_modules/openclaw/node_modules"
  local found=0

  local candidates=(
    "$base/koffi/index.js"
    "$base/@mariozechner/pi-tui/node_modules/koffi/index.js"
  )

  local p=""
  for p in "${candidates[@]}"; do
    if [ -f "$p" ]; then
      found=1
      patch_single_koffi_index "$p"
    fi
  done

  if [ "$found" -eq 0 ]; then
    warn "koffi index.js not found under $base (skip Android patch)"
  fi
}

rebuild_wrapper() {
  local wrapper="$PREFIX/bin/openclaw"
  local bash_bin="$PREFIX/bin/bash"

  [ -x "$bash_bin" ] || fail "bash not found: $bash_bin"

  info "Rebuilding BotDrop-safe openclaw wrapper"

  cat > "$wrapper" <<EOF
#!$bash_bin
PREFIX="\$(cd "\$(dirname "\$0")/.." && pwd)"
ENTRY=""
for CANDIDATE in \\
  "\$PREFIX/lib/node_modules/openclaw/dist/cli.js" \\
  "\$PREFIX/lib/node_modules/openclaw/bin/openclaw.js" \\
  "\$PREFIX/lib/node_modules/openclaw/dist/index.js"; do
  if [ -f "\$CANDIDATE" ]; then
    ENTRY="\$CANDIDATE"
    break
  fi
done
if [ -z "\$ENTRY" ]; then
  echo "openclaw entrypoint not found under \$PREFIX/lib/node_modules/openclaw" >&2
  exit 127
fi
export SSL_CERT_FILE="\$PREFIX/etc/tls/cert.pem"
export NODE_OPTIONS="--dns-result-order=ipv4first"
exec "\$PREFIX/bin/termux-chroot" "\$PREFIX/bin/node" "\$ENTRY" "\$@"
EOF

  chmod 755 "$wrapper"
}

start_gateway_if_needed() {
  if ! is_truthy "$OPENCLAW_RESTART_GATEWAY"; then
    info "Skipping gateway restart (OPENCLAW_RESTART_GATEWAY=$OPENCLAW_RESTART_GATEWAY)"
    return 0
  fi

  info "Starting OpenClaw gateway"
  : > "$OPENCLAW_GATEWAY_LOG_FILE"
  openclaw gateway run --force >> "$OPENCLAW_GATEWAY_LOG_FILE" 2>&1 &
  local gw_pid="$!"
  echo "$gw_pid" > "$OPENCLAW_GATEWAY_PID_FILE"

  sleep 3
  if kill -0 "$gw_pid" >/dev/null 2>&1; then
    info "Gateway started (pid=$gw_pid)"
    return 0
  fi

  warn "Gateway failed to start, recent log:"
  tail -n 80 "$OPENCLAW_GATEWAY_LOG_FILE" >&2 || true
  return 1
}

print_version() {
  local ver=""
  ver="$(openclaw --version 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
  if [ -n "$ver" ]; then
    info "OpenClaw version: $ver"
  else
    warn "Failed to read OpenClaw version via openclaw --version"
  fi
}

main() {
  prepare_env
  info "Environment ready"
  info "PREFIX=$PREFIX"
  info "HOME=$HOME"

  stop_monitor_if_needed
  stop_gateway
  install_openclaw
  patch_koffi_android_if_needed
  rebuild_wrapper
  print_version
  start_gateway_if_needed

  info "Upgrade flow finished"
}

main
