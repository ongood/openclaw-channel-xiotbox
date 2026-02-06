#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-1.0.15}"
REPO="https://github.com/ongood/openclaw-channel-xiotbox.git#${TAG}"

EXT_DIR="${OPENCLAW_EXT_DIR:-$HOME/.openclaw/extensions/openclaw-channel-xiotbox}"
OLD_EXT_DIR="$HOME/.openclaw/extensions/xiotbox"
CFG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
BACKUP_PATH="${OPENCLAW_XIOTBOX_BACKUP:-$HOME/.openclaw/.xiotbox_channel_backup.json}"

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export BACKUP_PATH
  python3 - <<'PY'
import json
import os
import pathlib

p = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
data = json.loads(p.read_text("utf-8"))
plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
entries.pop("xiotbox", None)
entries.pop("openclaw-channel-xiotbox", None)
plugins["entries"] = entries
installs = plugins.get("installs") or {}
installs.pop("xiotbox", None)
installs.pop("openclaw-channel-xiotbox", None)
plugins["installs"] = installs
data["plugins"] = plugins

channels = data.get("channels") or {}
backup = channels.get("xiotbox")
if backup:
    backup_path = pathlib.Path(os.environ["BACKUP_PATH"]).expanduser()
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    backup_path.write_text(json.dumps(backup, ensure_ascii=False, indent=2))
    try:
        os.chmod(backup_path, 0o600)
    except OSError:
        pass

channels.pop("xiotbox", None)
data["channels"] = channels

p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print("cleaned config", p)
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
  python3 - <<'PY'
import json
import os
import pathlib
from datetime import datetime, timezone

p = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
data = json.loads(p.read_text("utf-8"))
plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
installs = plugins.get("installs") or {}

if "xiotbox" in entries and "openclaw-channel-xiotbox" not in entries:
    entries["openclaw-channel-xiotbox"] = entries["xiotbox"]
entries.pop("xiotbox", None)

inst = installs.get("openclaw-channel-xiotbox") or installs.get("xiotbox") or {}
installs.pop("xiotbox", None)
inst["source"] = inst.get("source") or "npm"
inst["spec"] = os.environ.get("REPO", inst.get("spec", ""))
inst["installPath"] = os.environ.get("EXT_DIR", inst.get("installPath", ""))
if "installedAt" not in inst or not inst["installedAt"]:
    inst["installedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
installs["openclaw-channel-xiotbox"] = inst

plugins["entries"] = entries
plugins["installs"] = installs
data["plugins"] = plugins
p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print("normalized plugins entries/installs", p)
PY
fi

openclaw doctor --fix || true
if [ "$install_rc" -ne 0 ]; then
  echo "openclaw plugins install exited with code $install_rc; config normalized."
fi

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export BACKUP_PATH
  export XIOTBOX_GATEWAY_WSS="${XIOTBOX_GATEWAY_WSS:-}"
  export XIOTBOX_DEVICE_ID="${XIOTBOX_DEVICE_ID:-}"
  export XIOTBOX_DEVICE_TOKEN="${XIOTBOX_DEVICE_TOKEN:-}"
  export XIOTBOX_API_BASE="${XIOTBOX_API_BASE:-}"
  export XIOTBOX_E2E_KEY_PATH="${XIOTBOX_E2E_KEY_PATH:-}"
  export XIOTBOX_E2E_ROTATE="${XIOTBOX_E2E_ROTATE:-}"
  export XIOTBOX_IDENTITY_KEY_PATH="${XIOTBOX_IDENTITY_KEY_PATH:-}"
  export XIOTBOX_TRUST_PATH="${XIOTBOX_TRUST_PATH:-}"
  export XIOTBOX_USE_QUERY_AUTH="${XIOTBOX_USE_QUERY_AUTH:-}"
  missing=$(python3 - <<'PY'
import json
import os
import pathlib

p = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
data = json.loads(p.read_text("utf-8"))
channels = data.get("channels") or {}
xiot = channels.get("xiotbox") or {}
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
if os.environ.get("XIOTBOX_USE_QUERY_AUTH"):
    xiot["USE_QUERY_AUTH"] = pick("USE_QUERY_AUTH", "XIOTBOX_USE_QUERY_AUTH")

channels["xiotbox"] = xiot
data["channels"] = channels
p.write_text(json.dumps(data, ensure_ascii=False, indent=2))

missing_keys = [k for k in ("GATEWAY_WSS_URL", "DEVICE_ID", "DEVICE_TOKEN") if not (xiot.get(k) or "").strip()]
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

echo "done"
