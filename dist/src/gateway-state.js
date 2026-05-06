const activeGatewayAccounts = new Map();
let gatewayInstanceSeq = 0;
export function nextGatewayInstanceId() {
    gatewayInstanceSeq += 1;
    return gatewayInstanceSeq;
}
export function registerGatewayAccount(accountId, state) {
    activeGatewayAccounts.set(accountId, { ...state });
}
export function getGatewayAccount(accountId) {
    const current = activeGatewayAccounts.get(accountId);
    if (!current)
        return undefined;
    return {
        instanceId: current.instanceId,
        startedAt: current.startedAt,
        connectedAt: current.connectedAt,
        stop: current.stop,
    };
}
export function removeGatewayAccount(accountId, instanceId) {
    const current = activeGatewayAccounts.get(accountId);
    if (current?.instanceId !== instanceId)
        return false;
    activeGatewayAccounts.delete(accountId);
    return true;
}
export async function stopGatewayAccount(accountId, reason) {
    const current = activeGatewayAccounts.get(accountId);
    if (!current)
        return;
    if (!current.stop) {
        activeGatewayAccounts.delete(accountId);
        return;
    }
    if (!current.stopPromise) {
        current.stopPromise = Promise.resolve(current.stop(reason));
    }
    await current.stopPromise;
}
export function setConnectedAt(accountId, instanceId, timestamp) {
    const current = activeGatewayAccounts.get(accountId);
    if (current?.instanceId !== instanceId)
        return false;
    current.connectedAt = timestamp;
    return true;
}
export function clearConnectedAt(accountId, instanceId) {
    const current = activeGatewayAccounts.get(accountId);
    if (current?.instanceId !== instanceId)
        return false;
    current.connectedAt = undefined;
    return true;
}
export function describeGatewayAccountState(accountId) {
    const current = activeGatewayAccounts.get(accountId);
    return {
        connected: Boolean(current?.connectedAt),
        startedAt: current?.startedAt ?? null,
        lastConnectedAt: current?.connectedAt ?? null,
    };
}
