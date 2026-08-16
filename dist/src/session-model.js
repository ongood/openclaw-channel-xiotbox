/**
 * Session-scoped model override for channel-originated runs.
 *
 * The XiotBox client sends `metadata.model` (a `provider/model` ref) with a
 * message; the channel stores it per session and the `before_model_resolve`
 * hook applies it so the operator can pick a model like Codex's chat picker.
 *
 * In-memory only: the client re-sends the choice on each message, so a gateway
 * restart falls back to the configured default until the next message arrives.
 */
const sessionModelOverrides = new Map();
function normalize(value) {
    return String(value ?? '').trim();
}
export function setSessionModelOverride(sessionKey, modelRef) {
    const key = normalize(sessionKey);
    const ref = normalize(modelRef);
    if (!key)
        return;
    if (!ref) {
        sessionModelOverrides.delete(key);
        return;
    }
    sessionModelOverrides.set(key, ref);
}
export function getSessionModelOverride(sessionKey) {
    const key = normalize(sessionKey);
    return key ? sessionModelOverrides.get(key) : undefined;
}
/**
 * Splits a `provider/model` ref into the hook override shape. A bare model id
 * (no `/`) becomes a model-only override.
 */
function resolveModelOverride(ref) {
    const trimmed = normalize(ref);
    if (!trimmed)
        return undefined;
    const slash = trimmed.indexOf('/');
    if (slash > 0 && slash < trimmed.length - 1) {
        return {
            providerOverride: trimmed.slice(0, slash),
            modelOverride: trimmed.slice(slash + 1),
        };
    }
    return { modelOverride: trimmed };
}
export function handleBeforeModelResolve(_event, ctx) {
    const ref = getSessionModelOverride(ctx?.sessionKey);
    return ref ? resolveModelOverride(ref) : undefined;
}
export function resetSessionModelOverridesForTest() {
    sessionModelOverrides.clear();
}
