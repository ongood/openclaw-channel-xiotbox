export type DirectSendParams = {
  text: string;
  threadId?: string | null;
  traceId?: string | null;
};

export type DirectSendResult = {
  delivered: boolean;
  commandId?: string;
  error?: string;
};

export type DirectSendFn = (params: DirectSendParams) => DirectSendResult;

const directSenders = new Map<string, DirectSendFn>();

export function registerDirectSender(accountId: string, fn: DirectSendFn): () => void {
  const key = String(accountId || '').trim() || 'default';
  directSenders.set(key, fn);
  return () => {
    if (directSenders.get(key) === fn) directSenders.delete(key);
  };
}

export function getDirectSender(accountId: string): DirectSendFn | undefined {
  const key = String(accountId || '').trim() || 'default';
  const exact = directSenders.get(key);
  if (exact) return exact;
  // Fallback for single-account deployments where the outbound target's
  // accountId spelling differs from the channel account registration.
  const values = [...directSenders.values()];
  return values.length === 1 ? values[0] : undefined;
}
