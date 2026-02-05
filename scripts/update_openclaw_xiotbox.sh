#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-1.0.1}"
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
echo "done"
