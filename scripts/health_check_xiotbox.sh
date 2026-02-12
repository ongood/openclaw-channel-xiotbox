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

CFG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
CHECK_MODEL="${CHECK_MODEL:-1}"
CHECK_GATEWAY="${CHECK_GATEWAY:-1}"
CHECK_PLUGIN="${CHECK_PLUGIN:-1}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() {
  printf '[xiotbox-health][PASS] %s\n' "$*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

warn() {
  printf '[xiotbox-health][WARN] %s\n' "$*" >&2
  WARN_COUNT=$((WARN_COUNT + 1))
}

fail() {
  printf '[xiotbox-health][FAIL] %s\n' "$*" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "on" ]
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd python3; then
  echo "[xiotbox-health][FAIL] python3 not found." >&2
  exit 1
fi

if ! need_cmd openclaw; then
  echo "[xiotbox-health][FAIL] openclaw not found." >&2
  exit 1
fi

if [ ! -f "$CFG_PATH" ]; then
  fail "OpenClaw config not found: $CFG_PATH"
  echo "[xiotbox-health] summary: pass=$PASS_COUNT warn=$WARN_COUNT fail=$FAIL_COUNT"
  exit 1
fi

export CFG_PATH
cfg_eval="$(python3 - <<'PY'
import json
import os
import pathlib
import shlex

cfg_path = pathlib.Path(os.environ["CFG_PATH"]).expanduser()
raw = cfg_path.read_text("utf-8").strip()
data = json.loads(raw) if raw else {}

plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
installs = plugins.get("installs") or {}
channels = data.get("channels") or {}

entry_exists = "xiotbox" in entries
install_exists = "xiotbox" in installs
channel = channels.get("xiotbox")
channel_exists = isinstance(channel, dict)
channel_enabled = bool(channel.get("enabled", True)) if isinstance(channel, dict) else False

missing = []
for key in ("GATEWAY_WSS_URL", "DEVICE_ID", "DEVICE_TOKEN"):
    v = (channel or {}).get(key, "")
    if not str(v).strip():
        missing.append(key)

primary = ""
agents = data.get("agents")
if isinstance(agents, dict):
    defaults = agents.get("defaults")
    if isinstance(defaults, dict):
        model_obj = defaults.get("model")
        if isinstance(model_obj, dict):
            primary = str(model_obj.get("primary", "") or "").strip()

provider_has_model = False
provider = ""
model_id = ""
if "/" in primary:
    provider, model_id = primary.split("/", 1)
    models_cfg = data.get("models")
    if isinstance(models_cfg, dict):
        providers_cfg = models_cfg.get("providers")
        if isinstance(providers_cfg, dict):
            provider_cfg = providers_cfg.get(provider)
            if isinstance(provider_cfg, dict):
                arr = provider_cfg.get("models")
                if isinstance(arr, list):
                    for item in arr:
                        if isinstance(item, dict) and str(item.get("id", "")).strip() == model_id:
                            provider_has_model = True
                            break

vals = {
    "ENTRY_EXISTS": "1" if entry_exists else "0",
    "INSTALL_EXISTS": "1" if install_exists else "0",
    "CHANNEL_EXISTS": "1" if channel_exists else "0",
    "CHANNEL_ENABLED": "1" if channel_enabled else "0",
    "MISSING_REQUIRED": ",".join(missing),
    "PRIMARY_MODEL": primary,
    "PROVIDER_HAS_MODEL": "1" if provider_has_model else "0",
}

for k, v in vals.items():
    print(f"{k}={shlex.quote(v)}")
PY
)"
eval "$cfg_eval"

if is_truthy "$CHECK_PLUGIN"; then
  plugin_detected=0
  tmp_plugins="$(mktemp)"
  if openclaw plugins list >"$tmp_plugins" 2>&1; then
    if grep -Eqi '(^|[^A-Za-z0-9_])xiotbox([^A-Za-z0-9_]|$)' "$tmp_plugins"; then
      plugin_detected=1
      pass "plugins list includes xiotbox."
    else
      warn "plugins list does not include xiotbox; fallback to config registry check."
    fi
  else
    warn "openclaw plugins list failed; fallback to config registry check."
  fi
  rm -f "$tmp_plugins"

  if [ "$plugin_detected" -eq 0 ]; then
    if [ "$ENTRY_EXISTS" = "1" ] || [ "$INSTALL_EXISTS" = "1" ]; then
      pass "xiotbox exists in plugins config registry."
    else
      fail "xiotbox missing from plugins list and config registry."
    fi
  fi

  channel_detected=0
  tmp_channels="$(mktemp)"
  if openclaw channels list >"$tmp_channels" 2>&1; then
    if grep -Eqi '(^|[^A-Za-z0-9_])xiotbox([^A-Za-z0-9_]|$)' "$tmp_channels"; then
      channel_detected=1
      pass "channels list includes xiotbox."
    else
      warn "channels list does not include xiotbox; fallback to config check."
    fi
  else
    warn "openclaw channels list failed; fallback to config check."
  fi
  rm -f "$tmp_channels"

  if [ "$channel_detected" -eq 0 ]; then
    if [ "$CHANNEL_EXISTS" = "1" ]; then
      pass "channels.xiotbox exists in config."
    else
      fail "channels.xiotbox missing from config."
    fi
  fi

  if [ "$CHANNEL_ENABLED" = "1" ]; then
    pass "channels.xiotbox is enabled."
  else
    fail "channels.xiotbox is disabled."
  fi

  if [ -n "$MISSING_REQUIRED" ]; then
    fail "channels.xiotbox missing required keys: $MISSING_REQUIRED"
  else
    pass "channels.xiotbox required keys are present."
  fi
fi

if is_truthy "$CHECK_MODEL"; then
  if [ -z "$PRIMARY_MODEL" ]; then
    fail "agents.defaults.model.primary is empty."
  else
    pass "primary model configured: $PRIMARY_MODEL"
    model_available=0
    tmp_models="$(mktemp)"
    if openclaw models list >"$tmp_models" 2>&1; then
      if awk 'NF{print $1}' "$tmp_models" | grep -Fx "$PRIMARY_MODEL" >/dev/null 2>&1; then
        model_available=1
        pass "primary model exists in openclaw models list."
      else
        warn "primary model not in openclaw models list: $PRIMARY_MODEL"
      fi
    else
      warn "openclaw models list failed."
    fi
    rm -f "$tmp_models"

    if [ "$model_available" -eq 0 ]; then
      if [ "$PROVIDER_HAS_MODEL" = "1" ]; then
        pass "primary model found in models.providers.* custom provider config."
      else
        fail "primary model not discoverable from models list or provider config."
      fi
    fi
  fi
fi

if is_truthy "$CHECK_GATEWAY"; then
  if pgrep -f "openclaw.*gateway" >/dev/null 2>&1; then
    pass "gateway process is running."
  else
    fail "gateway process not found."
  fi

  tmp_health="$(mktemp)"
  if openclaw health >"$tmp_health" 2>&1; then
    pass "openclaw health passed."
  else
    warn "openclaw health returned non-zero. Check manually: openclaw health"
  fi
  rm -f "$tmp_health"
fi

echo "[xiotbox-health] summary: pass=$PASS_COUNT warn=$WARN_COUNT fail=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
