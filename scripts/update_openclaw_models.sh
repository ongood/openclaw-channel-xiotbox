#!/usr/bin/env bash
# Re-exec under bash when invoked as "sh script.sh ...".
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "ERROR: bash is required for $0" >&2
  exit 1
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${1:-${ROOT_DIR}/.env.model}"
DRY_RUN="${DRY_RUN:-0}"
NO_VERIFY="${NO_VERIFY:-0}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: env file not found: ${ENV_FILE}" >&2
  echo "Copy ${ROOT_DIR}/.env.model.example to ${ROOT_DIR}/.env.model and fill values first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [ -n "${OPENCLAW_BIN:-}" ]; then
  OPENCLAW_CMD="${OPENCLAW_BIN}"
elif command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_CMD="$(command -v openclaw)"
elif [ -x "${HOME}/.openclaw/bin/openclaw" ]; then
  OPENCLAW_CMD="${HOME}/.openclaw/bin/openclaw"
else
  echo "ERROR: openclaw executable not found. Set OPENCLAW_BIN in .env.model." >&2
  exit 1
fi

if [ -n "${OPENCLAW_CONFIG_PATH:-}" ]; then
  CONFIG_PATH="${OPENCLAW_CONFIG_PATH}"
elif [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
  CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
else
  CONFIG_PATH="${HOME}/.openclaw/openclaw.json"
fi

MODELS_PAYLOAD_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-models.XXXXXX")"
DEFAULTS_PAYLOAD_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-defaults.XXXXXX")"
ALLOWLIST_PAYLOAD_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-allowlist.XXXXXX")"
ALLOWLIST_FINAL_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-allowlist-final.XXXXXX")"

cleanup() {
  rm -f "${MODELS_PAYLOAD_FILE}" "${DEFAULTS_PAYLOAD_FILE}" "${ALLOWLIST_PAYLOAD_FILE}" "${ALLOWLIST_FINAL_FILE}"
}
trap cleanup EXIT

python3 - "${MODELS_PAYLOAD_FILE}" "${DEFAULTS_PAYLOAD_FILE}" "${ALLOWLIST_PAYLOAD_FILE}" <<'PY'
import json
import os
import sys
from pathlib import Path

mode = os.environ.get("OPENCLAW_MODELS_MODE", "merge").strip()
set_default_model_raw = os.environ.get("OPENCLAW_SET_DEFAULT_MODEL", "false").strip().lower()
set_default_model = set_default_model_raw in {"1", "true", "yes", "on"}
primary = os.environ.get("OPENCLAW_PRIMARY_MODEL", "").strip()
fallbacks_json_raw = os.environ.get("OPENCLAW_FALLBACK_MODELS_JSON", "").strip()
fallbacks_csv_raw = os.environ.get("OPENCLAW_FALLBACK_MODELS", "").strip()
providers_raw = os.environ.get("OPENCLAW_PROVIDERS_JSON", "").strip()
sync_allowlist_raw = os.environ.get("OPENCLAW_SYNC_ALLOWLIST", "false").strip().lower()
allowlist_extra_json_raw = os.environ.get("OPENCLAW_ALLOWLIST_EXTRA_MODELS_JSON", "").strip()
allowlist_extra_csv_raw = os.environ.get("OPENCLAW_ALLOWLIST_EXTRA_MODELS", "").strip()
models_out = Path(sys.argv[1])
defaults_out = Path(sys.argv[2])
allowlist_out = Path(sys.argv[3])

if mode not in {"merge", "replace"}:
    raise SystemExit('ERROR: OPENCLAW_MODELS_MODE must be "merge" or "replace".')

if not providers_raw:
    raise SystemExit("ERROR: OPENCLAW_PROVIDERS_JSON is required.")
try:
    providers = json.loads(providers_raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"ERROR: OPENCLAW_PROVIDERS_JSON is invalid JSON: {exc}") from exc
if not isinstance(providers, dict) or not providers:
    raise SystemExit("ERROR: OPENCLAW_PROVIDERS_JSON must be a non-empty JSON object.")

for provider_id, provider in providers.items():
    if not isinstance(provider_id, str) or not provider_id.strip():
        raise SystemExit("ERROR: provider id must be non-empty string.")
    if not isinstance(provider, dict):
        raise SystemExit(f"ERROR: provider '{provider_id}' must be an object.")
    if not isinstance(provider.get("baseUrl"), str) or not provider["baseUrl"].strip():
        raise SystemExit(f"ERROR: provider '{provider_id}' requires baseUrl.")
    models = provider.get("models")
    if not isinstance(models, list) or not models:
        raise SystemExit(f"ERROR: provider '{provider_id}' requires non-empty models.")
    for idx, model in enumerate(models):
        if not isinstance(model, dict):
            raise SystemExit(f"ERROR: provider '{provider_id}' model[{idx}] must be an object.")
        model_id = model.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            raise SystemExit(f"ERROR: provider '{provider_id}' model[{idx}] missing id.")

models_payload = {
    "mode": mode,
    "providers": providers,
}
models_out.write_text(json.dumps(models_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

defaults_payload = {}
fallbacks: list[str] = []
if set_default_model:
    if "/" not in primary:
        raise SystemExit(
            'ERROR: OPENCLAW_PRIMARY_MODEL must be "provider/model" when OPENCLAW_SET_DEFAULT_MODEL=true.'
        )
    if fallbacks_json_raw:
        try:
            fallbacks = json.loads(fallbacks_json_raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"ERROR: OPENCLAW_FALLBACK_MODELS_JSON is invalid JSON: {exc}") from exc
    else:
        fallbacks = [part.strip() for part in fallbacks_csv_raw.split(",") if part.strip()]
    if not isinstance(fallbacks, list) or any(
        not isinstance(x, str) or "/" not in x for x in fallbacks
    ):
        raise SystemExit(
            'ERROR: fallback models must be "provider/model". '
            "Set OPENCLAW_FALLBACK_MODELS_JSON or OPENCLAW_FALLBACK_MODELS."
        )
    defaults_payload = {
        "primary": primary,
        "fallbacks": fallbacks,
    }
defaults_out.write_text(
    json.dumps(defaults_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
)

sync_allowlist = sync_allowlist_raw in {"1", "true", "yes", "on"}
allowlist_payload = {}
if sync_allowlist:
    for provider_id, provider in providers.items():
        for model in provider.get("models", []):
            model_id = str(model.get("id", "")).strip()
            if model_id:
                allowlist_payload.setdefault(f"{provider_id}/{model_id}", {})
    if set_default_model:
        allowlist_payload.setdefault(primary, {})
        for ref in fallbacks:
            allowlist_payload.setdefault(ref, {})
    if allowlist_extra_json_raw:
        try:
            allowlist_extra = json.loads(allowlist_extra_json_raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"ERROR: OPENCLAW_ALLOWLIST_EXTRA_MODELS_JSON is invalid JSON: {exc}"
            ) from exc
    else:
        allowlist_extra = [part.strip() for part in allowlist_extra_csv_raw.split(",") if part.strip()]
    if not isinstance(allowlist_extra, list) or any(
        not isinstance(x, str) or "/" not in x for x in allowlist_extra
    ):
        raise SystemExit(
            'ERROR: extra allowlist models must be "provider/model". '
            "Set OPENCLAW_ALLOWLIST_EXTRA_MODELS_JSON or OPENCLAW_ALLOWLIST_EXTRA_MODELS."
        )
    for ref in allowlist_extra:
        allowlist_payload.setdefault(ref, {})

allowlist_out.write_text(json.dumps(allowlist_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
PY

prepare_allowlist_payload() {
  local base_payload existing_allowlist_json current_default_json
  base_payload="$(cat "${ALLOWLIST_PAYLOAD_FILE}")"
  existing_allowlist_json="$("${OPENCLAW_CMD}" config get agents.defaults.models --json 2>/dev/null || echo '{}')"
  current_default_json="$("${OPENCLAW_CMD}" config get agents.defaults.model --json 2>/dev/null || echo '{}')"
  python3 - "${ALLOWLIST_FINAL_FILE}" <<'PY'
import json
import os
import sys

out_path = sys.argv[1]
base_payload_raw = os.environ.get("BASE_ALLOWLIST_PAYLOAD", "{}").strip() or "{}"
existing_payload_raw = os.environ.get("EXISTING_ALLOWLIST_JSON", "{}").strip() or "{}"
current_default_raw = os.environ.get("CURRENT_DEFAULT_MODEL_JSON", "{}").strip() or "{}"
allowlist_mode = os.environ.get("OPENCLAW_ALLOWLIST_MODE", "merge").strip().lower()
preserve_default_raw = os.environ.get("OPENCLAW_PRESERVE_DEFAULT_MODEL", "true").strip().lower()
preserve_default = preserve_default_raw in {"1", "true", "yes", "on"}

if allowlist_mode not in {"merge", "replace"}:
    raise SystemExit('ERROR: OPENCLAW_ALLOWLIST_MODE must be "merge" or "replace".')

def parse_obj(raw: str) -> dict:
    try:
        val = json.loads(raw)
    except Exception:
        return {}
    return val if isinstance(val, dict) else {}

base_payload = parse_obj(base_payload_raw)
existing_payload = parse_obj(existing_payload_raw)

if preserve_default:
    try:
        current_default = json.loads(current_default_raw)
    except Exception:
        current_default = {}
    refs = []
    if isinstance(current_default, str):
        refs = [current_default]
    elif isinstance(current_default, dict):
        primary = current_default.get("primary")
        if isinstance(primary, str):
            refs.append(primary)
        fb = current_default.get("fallbacks")
        if isinstance(fb, list):
            refs.extend([x for x in fb if isinstance(x, str)])
    for ref in refs:
        if "/" in ref:
            base_payload.setdefault(ref, {})

if allowlist_mode == "merge":
    final_payload = {**existing_payload, **base_payload}
else:
    final_payload = base_payload

with open(out_path, "w", encoding="utf-8") as f:
    f.write(json.dumps(final_payload, ensure_ascii=False, separators=(",", ":")))
PY
}

if [ "${DRY_RUN}" = "1" ] || [ "${DRY_RUN}" = "true" ]; then
  BASE_ALLOWLIST_PAYLOAD="$(cat "${ALLOWLIST_PAYLOAD_FILE}")" \
  EXISTING_ALLOWLIST_JSON="$("${OPENCLAW_CMD}" config get agents.defaults.models --json 2>/dev/null || echo '{}')" \
  CURRENT_DEFAULT_MODEL_JSON="$("${OPENCLAW_CMD}" config get agents.defaults.model --json 2>/dev/null || echo '{}')" \
  prepare_allowlist_payload
  echo "Dry run only. Nothing written."
  echo "Using env file: ${ENV_FILE}"
  echo "OpenClaw CLI: ${OPENCLAW_CMD}"
  echo "Config target: ${CONFIG_PATH}"
  echo ""
  echo "models payload:"
  cat "${MODELS_PAYLOAD_FILE}"
  echo ""
  echo ""
  if [ "$(cat "${DEFAULTS_PAYLOAD_FILE}")" != "{}" ]; then
    echo "agents.defaults.model payload:"
    cat "${DEFAULTS_PAYLOAD_FILE}"
  else
    echo "agents.defaults.model payload:"
    echo "{}"
    echo "(skip: OPENCLAW_SET_DEFAULT_MODEL is false)"
  fi
  if [ -s "${ALLOWLIST_FINAL_FILE}" ] && [ "$(cat "${ALLOWLIST_FINAL_FILE}")" != "{}" ]; then
    echo ""
    echo ""
    echo "agents.defaults.models payload (final):"
    cat "${ALLOWLIST_FINAL_FILE}"
  fi
  echo ""
  exit 0
fi

if [ -f "${CONFIG_PATH}" ]; then
  BACKUP_PATH="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "${CONFIG_PATH}" "${BACKUP_PATH}"
  echo "Backup created: ${BACKUP_PATH}"
else
  echo "Config not found yet: ${CONFIG_PATH} (OpenClaw will create it if needed)."
fi

"${OPENCLAW_CMD}" config set models "$(cat "${MODELS_PAYLOAD_FILE}")" --json
if [ "$(cat "${DEFAULTS_PAYLOAD_FILE}")" != "{}" ]; then
  "${OPENCLAW_CMD}" config set agents.defaults.model "$(cat "${DEFAULTS_PAYLOAD_FILE}")" --json
fi

BASE_ALLOWLIST_PAYLOAD="$(cat "${ALLOWLIST_PAYLOAD_FILE}")" \
EXISTING_ALLOWLIST_JSON="$("${OPENCLAW_CMD}" config get agents.defaults.models --json 2>/dev/null || echo '{}')" \
CURRENT_DEFAULT_MODEL_JSON="$("${OPENCLAW_CMD}" config get agents.defaults.model --json 2>/dev/null || echo '{}')" \
prepare_allowlist_payload

if [ -s "${ALLOWLIST_FINAL_FILE}" ] && [ "$(cat "${ALLOWLIST_FINAL_FILE}")" != "{}" ]; then
  "${OPENCLAW_CMD}" config set agents.defaults.models "$(cat "${ALLOWLIST_FINAL_FILE}")" --json
fi

echo "Updated:"
echo "- models"
if [ "$(cat "${DEFAULTS_PAYLOAD_FILE}")" != "{}" ]; then
  echo "- agents.defaults.model"
else
  echo "- agents.defaults.model (skipped)"
fi
if [ -s "${ALLOWLIST_FINAL_FILE}" ] && [ "$(cat "${ALLOWLIST_FINAL_FILE}")" != "{}" ]; then
  echo "- agents.defaults.models"
else
  echo "- agents.defaults.models (skipped)"
fi

if [ "${NO_VERIFY}" != "1" ] && [ "${NO_VERIFY}" != "true" ]; then
  echo ""
  echo "Verification:"
  "${OPENCLAW_CMD}" models status --plain
fi

echo ""
echo "Done."
