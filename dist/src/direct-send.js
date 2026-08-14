const directSenders = new Map();
export function registerDirectSender(accountId, fn) {
    const key = String(accountId || '').trim() || 'default';
    directSenders.set(key, fn);
    return () => {
        if (directSenders.get(key) === fn)
            directSenders.delete(key);
    };
}
export function getDirectSender(accountId) {
    const key = String(accountId || '').trim() || 'default';
    const exact = directSenders.get(key);
    if (exact)
        return exact;
    // Fallback for single-account deployments where the outbound target's
    // accountId spelling differs from the channel account registration.
    const values = [...directSenders.values()];
    return values.length === 1 ? values[0] : undefined;
}
