#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'MSG'
Usage:
  bash scripts/configure_deepseek_termux.sh <DEEPSEEK_API_KEY> [MODEL]

Example:
  bash scripts/configure_deepseek_termux.sh sk-xxxx deepseek-chat

Environment (optional):
  OPENCLAW_CONFIG            Default: ~/.openclaw/openclaw.json
  OPENCLAW_AUTH_PROFILES     Default: ~/.openclaw/agents/main/agent/auth-profiles.json
  BOTDROP_TEMPLATE_FILE      Default: /data/data/app.botdrop/shared_prefs/botdrop_config_template.xml
  CLEAR_BOTDROP_TEMPLATE     Default: 1
  RESTART_GATEWAY            Default: 1
  OPENCLAW_GATEWAY_LOG       Default: ~/.openclaw/gateway.log
MSG
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

DEEPSEEK_API_KEY="${1:-}"
MODEL="${2:-deepseek-chat}"

if [ -z "$DEEPSEEK_API_KEY" ]; then
  usage
  exit 1
fi

OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
OPENCLAW_AUTH_PROFILES="${OPENCLAW_AUTH_PROFILES:-$HOME/.openclaw/agents/main/agent/auth-profiles.json}"
BOTDROP_TEMPLATE_FILE="${BOTDROP_TEMPLATE_FILE:-/data/data/app.botdrop/shared_prefs/botdrop_config_template.xml}"
CLEAR_BOTDROP_TEMPLATE="${CLEAR_BOTDROP_TEMPLATE:-1}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
OPENCLAW_GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-$HOME/.openclaw/gateway.log}"

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "on" ]
}

export OPENCLAW_CONFIG
export OPENCLAW_AUTH_PROFILES
export DEEPSEEK_API_KEY
export MODEL
python3 - <<'PY'
import json
import os
import pathlib
import uuid

cfg_path = pathlib.Path(os.environ["OPENCLAW_CONFIG"]).expanduser()
auth_path = pathlib.Path(os.environ["OPENCLAW_AUTH_PROFILES"]).expanduser()
api_key = os.environ["DEEPSEEK_API_KEY"].strip()
model = os.environ["MODEL"].strip() or "deepseek-chat"

cfg_path.parent.mkdir(parents=True, exist_ok=True)
if cfg_path.exists():
    raw = cfg_path.read_text("utf-8").strip()
    cfg = json.loads(raw) if raw else {}
else:
    cfg = {}

agents = cfg.get("agents")
if not isinstance(agents, dict):
    agents = {}
cfg["agents"] = agents

defaults = agents.get("defaults")
if not isinstance(defaults, dict):
    defaults = {}
agents["defaults"] = defaults

model_obj = defaults.get("model")
if not isinstance(model_obj, dict):
    model_obj = {}
defaults["model"] = model_obj
model_obj["primary"] = f"deepseek/{model}"

if not defaults.get("workspace"):
    defaults["workspace"] = "~/botdrop"

gateway = cfg.get("gateway")
if not isinstance(gateway, dict):
    gateway = {}
cfg["gateway"] = gateway

if not gateway.get("mode"):
    gateway["mode"] = "local"

auth = gateway.get("auth")
if not isinstance(auth, dict):
    auth = {}
gateway["auth"] = auth
if not auth.get("token"):
    auth["token"] = str(uuid.uuid4())

cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
try:
    os.chmod(cfg_path, 0o600)
except OSError:
    pass

auth_path.parent.mkdir(parents=True, exist_ok=True)
if auth_path.exists():
    raw = auth_path.read_text("utf-8").strip()
    auth_profiles = json.loads(raw) if raw else {}
else:
    auth_profiles = {}

if not isinstance(auth_profiles, dict):
    auth_profiles = {}
auth_profiles["version"] = 1

profiles = auth_profiles.get("profiles")
if not isinstance(profiles, dict):
    profiles = {}
auth_profiles["profiles"] = profiles

profile = {
    "type": "api_key",
    "provider": "deepseek",
    "model": model,
    "key": api_key,
}
profiles[f"deepseek:{model}"] = profile
profiles["deepseek:default"] = profile

auth_path.write_text(json.dumps(auth_profiles, ensure_ascii=False, indent=2), encoding="utf-8")
try:
    os.chmod(auth_path, 0o600)
except OSError:
    pass

print(f"ok: model=deepseek/{model}")
print(f"ok: config={cfg_path}")
print(f"ok: auth={auth_path}")
PY

if is_truthy "$CLEAR_BOTDROP_TEMPLATE"; then
  if [ -f "$BOTDROP_TEMPLATE_FILE" ]; then
    rm -f "$BOTDROP_TEMPLATE_FILE"
    echo "ok: removed BotDrop template cache $BOTDROP_TEMPLATE_FILE"
  else
    echo "ok: BotDrop template cache not found (skip)"
  fi
fi

if is_truthy "$RESTART_GATEWAY"; then
  if command -v openclaw >/dev/null 2>&1; then
    mkdir -p "$(dirname "$OPENCLAW_GATEWAY_LOG")"
    pkill -f "openclaw.*gateway" >/dev/null 2>&1 || true
    openclaw gateway run --force >>"$OPENCLAW_GATEWAY_LOG" 2>&1 &
    echo "ok: gateway restarted, log=$OPENCLAW_GATEWAY_LOG"
  else
    echo "warn: openclaw command not found, skip gateway restart"
  fi
fi

echo "done"
