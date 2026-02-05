#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-1.0.3}"
REPO="https://github.com/ongood/openclaw-channel-xiotbox.git#${TAG}"

EXT_DIR="${OPENCLAW_EXT_DIR:-$HOME/.openclaw/extensions/openclaw-channel-xiotbox}"
CFG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
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
data["plugins"] = plugins

if os.environ.get("OPENCLAW_WIPE_CHANNELS") == "1":
    channels = data.get("channels") or {}
    channels.pop("xiotbox", None)
    data["channels"] = channels

p.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print("cleaned config", p)
PY
fi

rm -rf "$EXT_DIR"
openclaw plugins install "$REPO"
openclaw doctor --fix

if [ -f "$CFG_PATH" ]; then
  export CFG_PATH
  export XIOTBOX_GATEWAY_WSS="${XIOTBOX_GATEWAY_WSS:-}"
  export XIOTBOX_DEVICE_ID="${XIOTBOX_DEVICE_ID:-}"
  export XIOTBOX_DEVICE_TOKEN="${XIOTBOX_DEVICE_TOKEN:-}"
  export XIOTBOX_API_BASE="${XIOTBOX_API_BASE:-}"
  export XIOTBOX_E2E_KEY_PATH="${XIOTBOX_E2E_KEY_PATH:-}"
  export XIOTBOX_E2E_ROTATE="${XIOTBOX_E2E_ROTATE:-}"
  export XIOTBOX_USE_QUERY_AUTH="${XIOTBOX_USE_QUERY_AUTH:-}"
  missing=$(python3 - <<'PY'
import json
import os
import pathlib

p = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
data = json.loads(p.read_text("utf-8"))
channels = data.get("channels") or {}
xiot = channels.get("xiotbox") or {}

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
