#!/usr/bin/env bash
set -euo pipefail

INPUT="${1:-1.0.27}"
if [[ "$INPUT" == http://* || "$INPUT" == https://* || "$INPUT" == git@* || "$INPUT" == ssh://* || "$INPUT" == file://* ]]; then
  TAG=""
  REPO="$INPUT"
else
  TAG="$INPUT"
  REPO="https://github.com/ongood/openclaw-channel-xiotbox.git#${TAG}"
fi

NEW_PLUGIN_ID="xiotbox"
OLD_PLUGIN_ID="openclaw-channel-xiotbox"

EXT_DIR="${OPENCLAW_EXT_DIR:-$HOME/.openclaw/extensions/${NEW_PLUGIN_ID}}"
OLD_EXT_DIR="${OPENCLAW_OLD_EXT_DIR:-$HOME/.openclaw/extensions/${OLD_PLUGIN_ID}}"
CFG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
BACKUP_PATH="${OPENCLAW_XIOTBOX_BACKUP:-$HOME/.openclaw/.xiotbox_channel_backup.json}"
PLUGINS_BACKUP_PATH="${OPENCLAW_XIOTBOX_PLUGIN_BACKUP:-$HOME/.openclaw/.xiotbox_plugin_backup.json}"
OPENCLAW_WIPE_CHANNELS="${OPENCLAW_WIPE_CHANNELS:-0}"
OPENCLAW_SKIP_DOCTOR="${OPENCLAW_SKIP_DOCTOR:-auto}"
OPENCLAW_RESTART_GATEWAY="${OPENCLAW_RESTART_GATEWAY:-auto}"
OPENCLAW_GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-$HOME/.openclaw/gateway.log}"

is_termux=0
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *"/com.termux/"* ]]; then
  is_termux=1
fi

is_proot=0
if [ -n "${PROOT_TMP_DIR:-}" ] || [ -n "${PROOT_DISTRO:-}" ] || [ -n "${PROOT_ROOTFS:-}" ]; then
  is_proot=1
fi

is_android=0
if [ -n "${ANDROID_ROOT:-}" ] || [[ "${HOME:-}" == /data/data/*/files/home* ]]; then
  is_android=1
fi

info() {
  printf '[xiotbox-install] %s\n' "$*"
}

warn() {
  printf '[xiotbox-install][WARN] %s\n' "$*" >&2
}

fail() {
  printf '[xiotbox-install][ERROR] %s\n' "$*" >&2
  exit 1
}

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "on" ]
}

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

show_termux_hints() {
  cat >&2 <<'MSG'
Termux/proot dependency hints:
  pkg update
  pkg install -y git nodejs-lts python ca-certificates openssl

If you are inside proot-distro (Debian/Ubuntu rootfs), install there:
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
  if [ "$is_termux" -eq 1 ]; then
    info "Detected Termux environment."
  fi
  if [ "$is_proot" -eq 1 ]; then
    info "Detected proot environment."
  fi
  if [ "$is_android" -eq 1 ]; then
    info "Detected Android userspace."
  fi

  need_cmd python3 || fail "python3 not found. This script requires python3."
  need_cmd openclaw || fail "openclaw command not found in PATH."
  need_cmd git || {
    if [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ]; then
      show_termux_hints
    fi
    fail "git not found. openclaw plugins install <git-repo> needs git."
  }
  need_cmd node || {
    if [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ]; then
      show_termux_hints
    fi
    fail "node not found."
  }
  need_cmd npm || {
    if [ "$is_termux" -eq 1 ] || [ "$is_proot" -eq 1 ]; then
      show_termux_hints
    fi
    fail "npm not found."
  }

  mkdir -p "$(dirname "$EXT_DIR")" "$(dirname "$CFG_PATH")" || fail "Cannot create plugin/config parent directories."
  [ -w "$(dirname "$EXT_DIR")" ] || fail "Plugin directory parent is not writable: $(dirname "$EXT_DIR")"
  [ -w "$(dirname "$CFG_PATH")" ] || fail "Config directory parent is not writable: $(dirname "$CFG_PATH")"
}

preflight

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export BACKUP_PATH
  export PLUGINS_BACKUP_PATH
  export NEW_PLUGIN_ID
  export OLD_PLUGIN_ID
  export OPENCLAW_WIPE_CHANNELS
  python3 - <<'PY'
import json
import os
import pathlib

cfg_path = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
raw = cfg_path.read_text("utf-8").strip()
data = json.loads(raw) if raw else {}

new_id = os.environ["NEW_PLUGIN_ID"]
old_id = os.environ["OLD_PLUGIN_ID"]
wipe_channels = os.environ.get("OPENCLAW_WIPE_CHANNELS", "0") == "1"

plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
installs = plugins.get("installs") or {}
channels = data.get("channels") or {}

new_entry = entries.get(new_id)
old_entry = entries.get(old_id)
merged_entry = None
if isinstance(old_entry, dict) and isinstance(new_entry, dict):
    merged_entry = {}
    merged_entry.update(old_entry)
    merged_entry.update(new_entry)
elif new_entry is not None:
    merged_entry = new_entry
elif old_entry is not None:
    merged_entry = old_entry

new_install = installs.get(new_id)
old_install = installs.get(old_id)
merged_install = None
if isinstance(old_install, dict) or isinstance(new_install, dict):
    merged_install = {}
    if isinstance(old_install, dict):
        merged_install.update(old_install)
    if isinstance(new_install, dict):
        merged_install.update(new_install)
elif new_install is not None:
    merged_install = new_install
elif old_install is not None:
    merged_install = old_install

new_channel = channels.get(new_id)
old_channel = channels.get(old_id)
merged_channel = None
if isinstance(old_channel, dict) or isinstance(new_channel, dict):
    merged_channel = {}
    if isinstance(old_channel, dict):
        merged_channel.update(old_channel)
    if isinstance(new_channel, dict):
        merged_channel.update(new_channel)
elif new_channel is not None:
    merged_channel = new_channel
elif old_channel is not None:
    merged_channel = old_channel

if merged_channel is not None and not wipe_channels:
    backup_path = pathlib.Path(os.environ["BACKUP_PATH"]).expanduser()
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    backup_path.write_text(json.dumps(merged_channel, ensure_ascii=False, indent=2))
    try:
        os.chmod(backup_path, 0o600)
    except OSError:
        pass

plugin_backup_payload = {}
if merged_entry is not None:
    plugin_backup_payload["entry"] = merged_entry
if merged_install is not None:
    plugin_backup_payload["install"] = merged_install
if plugin_backup_payload:
    plugin_backup_path = pathlib.Path(os.environ["PLUGINS_BACKUP_PATH"]).expanduser()
    plugin_backup_path.parent.mkdir(parents=True, exist_ok=True)
    plugin_backup_path.write_text(json.dumps(plugin_backup_payload, ensure_ascii=False, indent=2))
    try:
        os.chmod(plugin_backup_path, 0o600)
    except OSError:
        pass

entries.pop(new_id, None)
entries.pop(old_id, None)
installs.pop(new_id, None)
installs.pop(old_id, None)
channels.pop(new_id, None)
channels.pop(old_id, None)

plugins["entries"] = entries
plugins["installs"] = installs
data["plugins"] = plugins
data["channels"] = channels

cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print("prepared config", cfg_path)
PY
fi

rm -rf "$EXT_DIR" "$OLD_EXT_DIR"
set +e
openclaw plugins install "$REPO"
install_rc=$?
set -e

if [ -d "$OLD_EXT_DIR" ] && [ ! -d "$EXT_DIR" ]; then
  mkdir -p "$(dirname "$EXT_DIR")"
  mv "$OLD_EXT_DIR" "$EXT_DIR"
fi

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export REPO
  export EXT_DIR
  export PLUGINS_BACKUP_PATH
  export NEW_PLUGIN_ID
  export OLD_PLUGIN_ID
  python3 - <<'PY'
import json
import os
import pathlib
from datetime import datetime, timezone

cfg_path = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
raw = cfg_path.read_text("utf-8").strip()
data = json.loads(raw) if raw else {}

new_id = os.environ["NEW_PLUGIN_ID"]
old_id = os.environ["OLD_PLUGIN_ID"]

plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
installs = plugins.get("installs") or {}

def replace_exact_old_id(value):
    if isinstance(value, dict):
        return {k: replace_exact_old_id(v) for k, v in value.items()}
    if isinstance(value, list):
        return [replace_exact_old_id(v) for v in value]
    if isinstance(value, str) and value == old_id:
        return new_id
    return value

def normalize_entry(raw):
    # Canonicalize to minimal safe shape and keep only enabled flag.
    # This avoids carrying stale entry hint/id fields that trigger mismatch warnings.
    if isinstance(raw, dict):
        cleaned = replace_exact_old_id(raw)
        if "enabled" in cleaned:
            enabled = bool(cleaned.get("enabled"))
        elif "disabled" in cleaned:
            enabled = not bool(cleaned.get("disabled"))
        else:
            enabled = True
        return {"enabled": enabled}
    if isinstance(raw, bool):
        return {"enabled": raw}
    # Fallback to a minimal valid entry; avoids carrying unknown stale hints.
    return {"enabled": True}

old_entry = entries.pop(old_id, None)
backup_entry = None
backup_install = None
plugin_backup_path = pathlib.Path(os.environ["PLUGINS_BACKUP_PATH"]).expanduser()
if plugin_backup_path.exists():
    try:
        plugin_backup = json.loads(plugin_backup_path.read_text("utf-8"))
        if isinstance(plugin_backup, dict):
            backup_entry = plugin_backup.get("entry")
            backup_install = plugin_backup.get("install")
    finally:
        try:
            plugin_backup_path.unlink()
        except OSError:
            pass

if new_id not in entries:
    if old_entry is not None:
        entries[new_id] = normalize_entry(old_entry)
    elif backup_entry is not None:
        entries[new_id] = normalize_entry(backup_entry)
else:
    entries[new_id] = normalize_entry(entries.get(new_id))

old_install = installs.pop(old_id, None)
new_install = installs.get(new_id)
merged_install = {}
if isinstance(backup_install, dict):
    merged_install.update(backup_install)
if isinstance(old_install, dict):
    merged_install.update(old_install)
if isinstance(new_install, dict):
    merged_install.update(new_install)

if old_install is not None or new_install is not None or backup_install is not None:
    merged_install["source"] = merged_install.get("source") or "npm"
    merged_install["spec"] = os.environ.get("REPO", merged_install.get("spec", ""))
    merged_install["installPath"] = os.environ.get("EXT_DIR", merged_install.get("installPath", ""))
    if not merged_install.get("installedAt"):
        merged_install["installedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    installs[new_id] = merged_install

plugins["entries"] = entries
plugins["installs"] = installs
data["plugins"] = plugins

cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print("normalized plugins entries/installs", cfg_path)
PY
fi

should_skip_doctor=0
if [ "${OPENCLAW_SKIP_DOCTOR:-auto}" = "auto" ]; then
  if [ "$is_android" -eq 1 ]; then
    should_skip_doctor=1
  fi
elif is_truthy "${OPENCLAW_SKIP_DOCTOR:-}"; then
  should_skip_doctor=1
fi

if [ "$should_skip_doctor" -eq 1 ]; then
  info "Skipping 'openclaw doctor --fix' on this environment."
else
  openclaw doctor --fix || true
fi

if [ "$install_rc" -ne 0 ]; then
  warn "openclaw plugins install exited with code $install_rc; config normalized."
fi

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export BACKUP_PATH
  export NEW_PLUGIN_ID
  export OLD_PLUGIN_ID
  export OPENCLAW_WIPE_CHANNELS
  export XIOTBOX_GATEWAY_WSS="${XIOTBOX_GATEWAY_WSS:-}"
  export XIOTBOX_DEVICE_ID="${XIOTBOX_DEVICE_ID:-}"
  export XIOTBOX_DEVICE_TOKEN="${XIOTBOX_DEVICE_TOKEN:-}"
  export XIOTBOX_API_BASE="${XIOTBOX_API_BASE:-}"
  export XIOTBOX_E2E_KEY_PATH="${XIOTBOX_E2E_KEY_PATH:-}"
  export XIOTBOX_E2E_ROTATE="${XIOTBOX_E2E_ROTATE:-}"
  export XIOTBOX_IDENTITY_KEY_PATH="${XIOTBOX_IDENTITY_KEY_PATH:-}"
  export XIOTBOX_TRUST_PATH="${XIOTBOX_TRUST_PATH:-}"
  export XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES="${XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES:-}"
  export XIOTBOX_USE_QUERY_AUTH="${XIOTBOX_USE_QUERY_AUTH:-}"
  missing=$(python3 - <<'PY'
import json
import os
import pathlib

cfg_path = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
raw = cfg_path.read_text("utf-8").strip()
data = json.loads(raw) if raw else {}

new_id = os.environ["NEW_PLUGIN_ID"]
old_id = os.environ["OLD_PLUGIN_ID"]
wipe_channels = os.environ.get("OPENCLAW_WIPE_CHANNELS", "0") == "1"

channels = data.get("channels") or {}
existing_new = channels.get(new_id)
existing_old = channels.get(old_id)

xiot = {}
if isinstance(existing_old, dict):
    xiot.update(existing_old)
if isinstance(existing_new, dict):
    xiot.update(existing_new)

if not wipe_channels:
    backup_path = pathlib.Path(os.environ["BACKUP_PATH"]).expanduser()
    if backup_path.exists():
        try:
            backup = json.loads(backup_path.read_text("utf-8"))
            if isinstance(backup, dict):
                merged = {}
                merged.update(backup)
                merged.update(xiot)
                xiot = merged
        finally:
            try:
                backup_path.unlink()
            except OSError:
                pass


def pick(key: str, env: str):
    v = (os.environ.get(env) or "").strip()
    if v:
        return v
    return xiot.get(key) or ""


xiot.setdefault("enabled", True)
xiot["GATEWAY_WSS_URL"] = pick("GATEWAY_WSS_URL", "XIOTBOX_GATEWAY_WSS")
xiot["DEVICE_ID"] = pick("DEVICE_ID", "XIOTBOX_DEVICE_ID")
xiot["DEVICE_TOKEN"] = pick("DEVICE_TOKEN", "XIOTBOX_DEVICE_TOKEN")
if os.environ.get("XIOTBOX_API_BASE"):
    xiot["API_BASE_URL"] = pick("API_BASE_URL", "XIOTBOX_API_BASE")
if os.environ.get("XIOTBOX_E2E_KEY_PATH"):
    xiot["E2E_KEY_PATH"] = pick("E2E_KEY_PATH", "XIOTBOX_E2E_KEY_PATH")
if os.environ.get("XIOTBOX_E2E_ROTATE"):
    xiot["E2E_ROTATE"] = pick("E2E_ROTATE", "XIOTBOX_E2E_ROTATE")
if os.environ.get("XIOTBOX_IDENTITY_KEY_PATH"):
    xiot["IDENTITY_KEY_PATH"] = pick("IDENTITY_KEY_PATH", "XIOTBOX_IDENTITY_KEY_PATH")
if os.environ.get("XIOTBOX_TRUST_PATH"):
    xiot["TRUST_PATH"] = pick("TRUST_PATH", "XIOTBOX_TRUST_PATH")
if os.environ.get("XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES"):
    xiot["ALLOW_NEW_CLIENT_IDENTITIES"] = pick("ALLOW_NEW_CLIENT_IDENTITIES", "XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES")
if os.environ.get("XIOTBOX_USE_QUERY_AUTH"):
    xiot["USE_QUERY_AUTH"] = pick("USE_QUERY_AUTH", "XIOTBOX_USE_QUERY_AUTH")

channels[new_id] = xiot
channels.pop(old_id, None)
data["channels"] = channels
cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))

missing_keys = [k for k in ("GATEWAY_WSS_URL", "DEVICE_ID", "DEVICE_TOKEN") if not (str(xiot.get(k) or "").strip())]
print(",".join(missing_keys))
PY
  )

  if [ -n "$missing" ]; then
    echo "xiotbox config missing: $missing"
    if [ "${OPENCLAW_AUTO_EDIT:-1}" = "1" ] && [ -t 0 ]; then
      editor="${EDITOR:-nano}"
      if command -v "$editor" >/dev/null 2>&1; then
        "$editor" "$CFG_PATH"
      else
        echo "editor not found: $editor"
      fi
    else
      echo "edit config: $CFG_PATH"
    fi
  fi
fi

should_restart_gateway=0
if [ "${OPENCLAW_RESTART_GATEWAY:-auto}" = "auto" ]; then
  if [ "$is_android" -eq 1 ]; then
    should_restart_gateway=1
  fi
elif is_truthy "${OPENCLAW_RESTART_GATEWAY:-}"; then
  should_restart_gateway=1
fi

if [ "$should_restart_gateway" -eq 1 ] && [ "$install_rc" -eq 0 ]; then
  info "Restarting OpenClaw gateway."
  mkdir -p "$(dirname "$OPENCLAW_GATEWAY_LOG")" || true
  pkill -f "openclaw.*gateway" >/dev/null 2>&1 || true
  if openclaw gateway run --force >>"$OPENCLAW_GATEWAY_LOG" 2>&1 & then
    info "Gateway started. log=$OPENCLAW_GATEWAY_LOG"
  else
    warn "Failed to start gateway with 'openclaw gateway run --force'."
  fi
elif [ "$should_restart_gateway" -eq 1 ]; then
  warn "Skipping gateway restart because plugin install failed."
fi

if [ "$install_rc" -ne 0 ]; then
  exit "$install_rc"
fi

echo "done"
