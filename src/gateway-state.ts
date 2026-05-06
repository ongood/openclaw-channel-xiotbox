export type ActiveGatewayAccount = {
  instanceId: number;
  startedAt: number;
  connectedAt?: number;
  stop: null | ((reason?: string) => Promise<void>);
};

type StoredGatewayAccount = ActiveGatewayAccount & {
  stopPromise?: Promise<void>;
};

export type GatewayAccountStateSnapshot = {
  connected: boolean;
  startedAt: number | null;
  lastConnectedAt: number | null;
};

const activeGatewayAccounts = new Map<string, StoredGatewayAccount>();
let gatewayInstanceSeq = 0;

export function nextGatewayInstanceId(): number {
  gatewayInstanceSeq += 1;
  return gatewayInstanceSeq;
}

export function registerGatewayAccount(accountId: string, state: ActiveGatewayAccount): void {
  activeGatewayAccounts.set(accountId, { ...state });
}

export function getGatewayAccount(accountId: string): ActiveGatewayAccount | undefined {
  const current = activeGatewayAccounts.get(accountId);
  if (!current) return undefined;
  return {
    instanceId: current.instanceId,
    startedAt: current.startedAt,
    connectedAt: current.connectedAt,
    stop: current.stop,
  };
}

export function removeGatewayAccount(accountId: string, instanceId: number): boolean {
  const current = activeGatewayAccounts.get(accountId);
  if (current?.instanceId !== instanceId) return false;
  activeGatewayAccounts.delete(accountId);
  return true;
}

export async function stopGatewayAccount(accountId: string, reason: string): Promise<void> {
  const current = activeGatewayAccounts.get(accountId);
  if (!current) return;
  if (!current.stop) {
    activeGatewayAccounts.delete(accountId);
    return;
  }
  if (!current.stopPromise) {
    current.stopPromise = Promise.resolve(current.stop(reason));
  }
  await current.stopPromise;
}

export function setConnectedAt(accountId: string, instanceId: number, timestamp: number): boolean {
  const current = activeGatewayAccounts.get(accountId);
  if (current?.instanceId !== instanceId) return false;
  current.connectedAt = timestamp;
  return true;
}

export function clearConnectedAt(accountId: string, instanceId: number): boolean {
  const current = activeGatewayAccounts.get(accountId);
  if (current?.instanceId !== instanceId) return false;
  current.connectedAt = undefined;
  return true;
}

export function describeGatewayAccountState(accountId: string): GatewayAccountStateSnapshot {
  const current = activeGatewayAccounts.get(accountId);
  return {
    connected: Boolean(current?.connectedAt),
    startedAt: current?.startedAt ?? null,
    lastConnectedAt: current?.connectedAt ?? null,
  };
}
