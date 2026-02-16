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
  bash scripts/configure_deepseek_termux.sh <API_KEY> [MODEL_OR_FULL_MODEL]

Example:
  bash scripts/configure_deepseek_termux.sh <API_KEY> deepseek-chat
  bash scripts/configure_deepseek_termux.sh <API_KEY> openrouter/deepseek/deepseek-chat

Environment (optional):
  OPENCLAW_CONFIG            Default: ~/.openclaw/openclaw.json
  OPENCLAW_AUTH_PROFILES     Default: ~/.openclaw/agents/main/agent/auth-profiles.json
  OPENAI_COMPAT_BASE_URL     Default: https://api.deepseek.com/v1
  OPENAI_COMPAT_API          Default: openai-completions
  WRITE_PROVIDER_CONFIG      Default: auto (auto=yes when provider is deepseek)
  BOTDROP_TEMPLATE_FILE      Default: /data/data/app.botdrop/shared_prefs/botdrop_config_template.xml
  SKIP_MODEL_VALIDATE        Default: 0 (set 1 to skip `openclaw models list` check)
  CLEAR_BOTDROP_TEMPLATE     Default: 1
  RESTART_GATEWAY            Default: 1
  OPENCLAW_GATEWAY_LOG       Default: ~/.openclaw/gateway.log
MSG
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

API_KEY="${1:-}"
MODEL_INPUT="${2:-deepseek-chat}"

if [ -z "$API_KEY" ]; then
  usage
  exit 1
fi

OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
OPENCLAW_AUTH_PROFILES="${OPENCLAW_AUTH_PROFILES:-$HOME/.openclaw/agents/main/agent/auth-profiles.json}"
OPENAI_COMPAT_BASE_URL="${OPENAI_COMPAT_BASE_URL:-https://api.deepseek.com/v1}"
OPENAI_COMPAT_API="${OPENAI_COMPAT_API:-openai-completions}"
WRITE_PROVIDER_CONFIG="${WRITE_PROVIDER_CONFIG:-auto}"
BOTDROP_TEMPLATE_FILE="${BOTDROP_TEMPLATE_FILE:-/data/data/app.botdrop/shared_prefs/botdrop_config_template.xml}"
SKIP_MODEL_VALIDATE="${SKIP_MODEL_VALIDATE:-0}"
CLEAR_BOTDROP_TEMPLATE="${CLEAR_BOTDROP_TEMPLATE:-1}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
OPENCLAW_GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-$HOME/.openclaw/gateway.log}"

is_truthy() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ "$v" = "1" ] || [ "$v" = "true" ] || [ "$v" = "yes" ] || [ "$v" = "on" ]
}

if [[ "$MODEL_INPUT" == */* ]]; then
  FULL_MODEL="$MODEL_INPUT"
else
  FULL_MODEL="deepseek/$MODEL_INPUT"
fi

PROVIDER="${FULL_MODEL%%/*}"
MODEL="${FULL_MODEL#*/}"
if [ -z "$PROVIDER" ] || [ -z "$MODEL" ] || [ "$PROVIDER" = "$MODEL" ]; then
  echo "error: invalid model: $MODEL_INPUT"
  exit 1
fi

should_write_provider=0
if [ "$WRITE_PROVIDER_CONFIG" = "auto" ]; then
  if [ "$PROVIDER" = "deepseek" ]; then
    should_write_provider=1
  fi
elif is_truthy "$WRITE_PROVIDER_CONFIG"; then
  should_write_provider=1
fi

if [ "$should_write_provider" -eq 0 ] && ! is_truthy "$SKIP_MODEL_VALIDATE" && command -v openclaw >/dev/null 2>&1; then
  tmp_models="$(mktemp)"
  if openclaw models list >"$tmp_models" 2>/dev/null; then
    if ! awk 'NF{print $1}' "$tmp_models" | grep -Fx "$FULL_MODEL" >/dev/null 2>&1; then
      echo "error: model not found in current OpenClaw: $FULL_MODEL"
      echo "hint: run 'openclaw models list | grep -i deepseek'"
      echo "hint: available deepseek-like models:"
      awk 'NF{print $1}' "$tmp_models" | grep -i 'deepseek' | head -n 20 || true
      rm -f "$tmp_models"
      exit 2
    fi
  fi
  rm -f "$tmp_models"
fi

export OPENCLAW_CONFIG
export OPENCLAW_AUTH_PROFILES
export API_KEY
export PROVIDER
export MODEL
export OPENAI_COMPAT_BASE_URL
export OPENAI_COMPAT_API
export WRITE_PROVIDER_CONFIG
python3 - <<'PY'
import json
import os
import pathlib
import uuid

cfg_path = pathlib.Path(os.environ["OPENCLAW_CONFIG"]).expanduser()
auth_path = pathlib.Path(os.environ["OPENCLAW_AUTH_PROFILES"]).expanduser()
api_key = os.environ["API_KEY"].strip()
provider = os.environ["PROVIDER"].strip()
model = os.environ["MODEL"].strip() or "deepseek-chat"
provider_base_url = (os.environ.get("OPENAI_COMPAT_BASE_URL") or "").strip()
provider_api = (os.environ.get("OPENAI_COMPAT_API") or "").strip() or "openai-completions"
write_provider_config = (os.environ.get("WRITE_PROVIDER_CONFIG") or "auto").strip().lower()

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
model_obj["primary"] = f"{provider}/{model}"

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

enable_provider_cfg = False
if write_provider_config in ("1", "true", "yes", "on"):
    enable_provider_cfg = True
elif write_provider_config == "auto" and provider == "deepseek":
    enable_provider_cfg = True

if enable_provider_cfg:
    models_cfg = cfg.get("models")
    if not isinstance(models_cfg, dict):
        models_cfg = {}
    providers_cfg = models_cfg.get("providers")
    if not isinstance(providers_cfg, dict):
        providers_cfg = {}
    provider_cfg = providers_cfg.get(provider)
    if not isinstance(provider_cfg, dict):
        provider_cfg = {}

    provider_cfg["baseUrl"] = provider_base_url or provider_cfg.get("baseUrl") or "https://api.deepseek.com/v1"
    provider_cfg["api"] = provider_api

    existing_models = provider_cfg.get("models")
    if not isinstance(existing_models, list):
        existing_models = []

    has_model = False
    for entry in existing_models:
        if isinstance(entry, dict) and str(entry.get("id", "")).strip() == model:
            has_model = True
            break
    if not has_model:
        existing_models.append(
            {
                "id": model,
                "name": model,
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 65536,
                "maxTokens": 8192,
            }
        )

    provider_cfg["models"] = existing_models
    providers_cfg[provider] = provider_cfg
    models_cfg["providers"] = providers_cfg
    if not isinstance(models_cfg.get("mode"), str):
        models_cfg["mode"] = "merge"
    cfg["models"] = models_cfg

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
    "provider": provider,
    "model": model,
    "key": api_key,
}
profiles[f"{provider}:{model}"] = profile
profiles[f"{provider}:default"] = profile

auth_path.write_text(json.dumps(auth_profiles, ensure_ascii=False, indent=2), encoding="utf-8")
try:
    os.chmod(auth_path, 0o600)
except OSError:
    pass

print(f"ok: model={provider}/{model}")
print(f"ok: config={cfg_path}")
print(f"ok: auth={auth_path}")
if enable_provider_cfg:
    print(f"ok: provider-config={provider} baseUrl={provider_base_url or 'https://api.deepseek.com/v1'} api={provider_api}")
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
