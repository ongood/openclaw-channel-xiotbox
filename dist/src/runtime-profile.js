/**
 * OpenClaw runtime profile — explicit capability declaration (XIOT-BUG-0050a).
 *
 * This module is the single source of truth for the runtime profile the
 * channel publishes so the gateway and clients never have to *guess* what this
 * runtime can do. Every field below is pinned by `test/runtime-profile.test.mjs`.
 *
 * 0050a ships the declaration only. `contract_level` therefore stays in the
 * legacy/transition band — the runtime does NOT claim the v1 contract yet.
 * The canonical ACK/DELIVERED lifecycle, structured runtime rejection and
 * error normalization land in 0050b; nothing in this module may imply they
 * already exist.
 */
/**
 * Stable runtime kind. The gateway default is deliberately neutral
 * (XIOT-BUG-0001 / XIOT-BUG-0007), so this must be declared explicitly.
 */
export const OPENCLAW_RUNTIME_KIND = 'openclaw';
/** Version of the profile/capability schema this declaration uses. */
export const OPENCLAW_CAPABILITIES_VERSION = 1;
/**
 * Contract level for the 0050a increment. The runtime publishes an explicit
 * profile but has not yet implemented the v1 runtime lifecycle (canonical
 * ACK/DELIVERED, structured rejection), so v1 must NOT be claimed. `legacy`
 * is the pre-profile band; `transition` is the honest label for "explicit
 * profile present, v1 lifecycle pending".
 */
export const OPENCLAW_CONTRACT_LEVEL = 'transition';
/**
 * Binding registry lifecycle. `process_local` is the truthful value today:
 * the conversation binding registry (src/channel.ts) and the session model
 * override map (src/session-model.ts) are in-memory only — they reset on a
 * plugin restart and re-register on the next chat message. `persistent` would
 * require a durable store that does not exist yet; declaring it would be a
 * lie. The lifecycle is made explicit so the client knows that model
 * selection and session.* command routing lose their in-memory bindings
 * across a restart until re-registration.
 */
export const OPENCLAW_BINDING_REGISTRY_LIFECYCLE = 'process_local';
/**
 * The OpenClaw host exposes no static model catalog seam to the channel, so
 * the runtime publishes no model list. This is independent from model
 * selection: see OPENCLAW_BINDING_REGISTRY_CAN_SELECT below.
 */
export const OPENCLAW_MODEL_CATALOG_AVAILABLE = false;
/**
 * Independent of the model catalog: the binding registry supports per-session
 * model selection (`session.model.select` → setSessionModelOverride), so
 * `model_selection` stays true even though `model_catalog` is false.
 */
export const OPENCLAW_BINDING_REGISTRY_CAN_SELECT = true;
/**
 * Build the explicit OpenClaw runtime profile. Pure: no filesystem or network
 * access, so it is fully unit-testable and safe to call on every bot connect.
 *
 * `model_selection` is detected independently from `model_catalog`: a caller
 * that knows the binding registry lost its select seam can pass
 * `modelSelection: false`, while `model_catalog`/`models` stay untouched.
 */
export function buildOpenclawRuntimeProfile(options = {}) {
    const contractLevel = options.contractLevel ?? OPENCLAW_CONTRACT_LEVEL;
    // 0050a guard: the runtime must never claim the v1 contract before the
    // canonical ACK/DELIVERED lifecycle (0050b) exists. Fail loudly at the
    // declaration source rather than shipping a false claim.
    if (contractLevel === 'v1') {
        throw new Error('contract_level_v1_not_claimable');
    }
    const bindingRegistry = options.bindingRegistry ?? OPENCLAW_BINDING_REGISTRY_LIFECYCLE;
    const modelSelection = options.modelSelection ?? OPENCLAW_BINDING_REGISTRY_CAN_SELECT;
    return {
        runtime_kind: OPENCLAW_RUNTIME_KIND,
        capabilities_version: OPENCLAW_CAPABILITIES_VERSION,
        contract_level: contractLevel,
        conversation_create: true,
        workspace_context: false,
        e2e: {
            required_for_commands: true,
        },
        model_catalog: OPENCLAW_MODEL_CATALOG_AVAILABLE,
        // model_catalog=false ⇒ models=[] is an invariant of this module, not an
        // accident: with no catalog seam there is nothing to list.
        models: [],
        model_selection: modelSelection,
        openclaw: {
            binding_registry: bindingRegistry,
        },
    };
}
