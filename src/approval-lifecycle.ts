type ApprovalKind = 'exec' | 'plugin';
type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

type ApprovalRequest = {
  id?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  request?: {
    agentId?: string | null;
    sessionKey?: string | null;
    runId?: string | null;
    turnSourceChannel?: string | null;
    turnSourceAccountId?: string | null;
    toolName?: string | null;
    toolCallId?: string | null;
    pluginId?: string | null;
    severity?: string | null;
    allowedDecisions?: readonly string[] | null;
  };
};

type ApprovalBinding = {
  token: symbol;
  accountId: string;
  deviceId: string;
  sessionKey: string;
  bindingId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  traceId: string | null;
};

type ApprovalAccount = {
  deviceId: string;
  emit: (event: Record<string, unknown>) => void;
};

type PendingApprovalEntry = {
  accountId: string;
  approvalId: string;
  approvalKind: ApprovalKind;
  binding: ApprovalBinding;
};

const accounts = new Map<string, ApprovalAccount>();
const activeBindings = new Map<string, Map<symbol, ApprovalBinding>>();
const pendingEntries = new Map<string, PendingApprovalEntry>();
const resolvingReviewers = new Map<string, string>();
let approvalResolverOverride: ((options: any) => Promise<void>) | null = null;

function normalized(value: unknown): string {
  return String(value || '').trim();
}

function normalizeAccountId(value: unknown): string {
  return normalized(value) || 'default';
}

function approvalKindOf(value: unknown): ApprovalKind | null {
  return value === 'exec' || value === 'plugin' ? value : null;
}

function approvalDecisionOf(value: unknown): ApprovalDecision | null {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny'
    ? value
    : null;
}

function resolveBinding(request: ApprovalRequest): ApprovalBinding | null {
  if (normalized(request?.request?.turnSourceChannel).toLowerCase() !== 'xiotbox') return null;
  const sessionKey = normalized(request?.request?.sessionKey);
  if (!sessionKey) return null;
  const candidates = [...(activeBindings.get(sessionKey)?.values() || [])];
  const sourceAccountId = normalized(request?.request?.turnSourceAccountId);
  const scoped = sourceAccountId
    ? candidates.filter((binding) => binding.accountId === sourceAccountId)
    : candidates;
  return scoped.length === 1 ? scoped[0] : null;
}

function allowedDecisions(request: ApprovalRequest, view: any): ApprovalDecision[] {
  const values = [
    ...(Array.isArray(view?.actions) ? view.actions.map((action: any) => action?.decision) : []),
    ...(Array.isArray(request?.request?.allowedDecisions)
      ? request.request.allowedDecisions
      : []),
  ];
  const result: ApprovalDecision[] = [];
  for (const value of values) {
    const decision = approvalDecisionOf(value);
    if (decision && !result.includes(decision)) result.push(decision);
  }
  return result.length ? result : ['deny'];
}

function emitApprovalEvent(
  entry: PendingApprovalEntry,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const account = accounts.get(entry.accountId);
  if (!account) throw new Error('xiotbox approval account unavailable');
  account.emit({
    event_id: `${entry.binding.runId}:approval:${entry.approvalId}:${kind}`,
    binding_id: entry.binding.bindingId,
    conversation_id: entry.binding.conversationId,
    kind,
    actor: { type: 'agent', id: entry.binding.agentId },
    run_id: entry.binding.runId,
    visibility: 'user',
    trace_id: entry.binding.traceId,
    payload,
  });
}

export function registerApprovalLifecycleAccount(options: {
  accountId: string;
  deviceId: string;
  emit: ApprovalAccount['emit'];
}): () => void {
  const accountId = normalizeAccountId(options.accountId);
  const registration = { deviceId: normalized(options.deviceId), emit: options.emit };
  accounts.set(accountId, registration);
  return () => {
    if (accounts.get(accountId) === registration) accounts.delete(accountId);
  };
}

export function registerActiveApprovalBinding(
  options: Omit<ApprovalBinding, 'token'>,
): () => void {
  const sessionKey = normalized(options.sessionKey);
  const accountId = normalizeAccountId(options.accountId);
  if (!sessionKey || !accounts.has(accountId)) return () => {};
  const token = Symbol('xiotbox-approval-binding');
  const bindings = activeBindings.get(sessionKey) || new Map<symbol, ApprovalBinding>();
  bindings.set(token, { ...options, token, sessionKey, accountId });
  activeBindings.set(sessionKey, bindings);
  return () => {
    const current = activeBindings.get(sessionKey);
    current?.delete(token);
    if (!current?.size) activeBindings.delete(sessionKey);
  };
}

function buildPendingPayload(params: any) {
  const binding = resolveBinding(params?.request);
  const approvalId = normalized(params?.request?.id);
  const kind = approvalKindOf(params?.approvalKind);
  if (!binding || !approvalId || !kind) throw new Error('approval binding unavailable');
  return {
    binding,
    approvalId,
    approvalKind: kind,
    payload: {
      approval_id: approvalId,
      approval_kind: kind,
      status: 'pending',
      allowed_decisions: allowedDecisions(params.request, params.view),
      expires_at: Number(params?.request?.expiresAtMs) || undefined,
      agent_id: normalized(params?.request?.request?.agentId) || binding.agentId,
      tool_name: normalized(params?.request?.request?.toolName) || undefined,
      tool_call_id: normalized(params?.request?.request?.toolCallId) || undefined,
      plugin_id: normalized(params?.request?.request?.pluginId) || undefined,
      severity: normalized(params?.request?.request?.severity) || undefined,
    },
  };
}

export const xiotboxApprovalCapability = {
  authorizeActorAction: () => ({
    authorized: false,
    reason: 'XiotBox approvals require the authenticated Gateway v2 endpoint.',
  }),
  resolveApproveCommandBehavior: () => ({ kind: 'ignore' }),
  native: {
    describeDeliveryCapabilities: ({ request }: any) => {
      const enabled = Boolean(resolveBinding(request));
      return {
        enabled,
        preferredSurface: 'origin',
        supportsOriginSurface: enabled,
        supportsApproverDmSurface: false,
      };
    },
    resolveOriginTarget: ({ request }: any) => {
      const binding = resolveBinding(request);
      return binding ? { to: binding.deviceId, threadId: binding.conversationId } : null;
    },
  },
  nativeRuntime: {
    eventKinds: ['exec', 'plugin'],
    availability: {
      isConfigured: ({ accountId }: any) => accounts.has(normalizeAccountId(accountId)),
      shouldHandle: ({ request }: any) => Boolean(resolveBinding(request)),
    },
    presentation: {
      buildPendingPayload,
      buildResolvedResult: ({ resolved, entry }: any) => {
        const pending = entry as PendingApprovalEntry;
        const decision = approvalDecisionOf(resolved?.decision);
        if (decision) {
          const resolvedBy = resolvingReviewers.get(pending.approvalId) || normalized(resolved?.resolvedBy);
          emitApprovalEvent(pending, 'approval.resolved', {
            approval_id: pending.approvalId,
            approval_kind: pending.approvalKind,
            status: 'resolved',
            decision,
            resolved_by: resolvedBy || undefined,
            resolved_at: Number(resolved?.ts) || undefined,
          });
        }
        pendingEntries.delete(pending.approvalId);
        resolvingReviewers.delete(pending.approvalId);
        return { kind: 'leave' };
      },
      buildExpiredResult: ({ entry }: any) => {
        const pending = entry as PendingApprovalEntry;
        emitApprovalEvent(pending, 'approval.expired', {
          approval_id: pending.approvalId,
          approval_kind: pending.approvalKind,
          status: 'expired',
        });
        pendingEntries.delete(pending.approvalId);
        resolvingReviewers.delete(pending.approvalId);
        return { kind: 'leave' };
      },
    },
    transport: {
      prepareTarget: ({ pendingPayload }: any) => ({
        dedupeKey: `xiotbox:${pendingPayload.approvalId}`,
        target: pendingPayload,
      }),
      deliverPending: ({ preparedTarget }: any) => {
        const pending = preparedTarget as ReturnType<typeof buildPendingPayload>;
        const entry: PendingApprovalEntry = {
          accountId: pending.binding.accountId,
          approvalId: pending.approvalId,
          approvalKind: pending.approvalKind,
          binding: pending.binding,
        };
        emitApprovalEvent(entry, 'approval.requested', pending.payload);
        pendingEntries.set(entry.approvalId, entry);
        return entry;
      },
    },
  },
};

export async function resolveApprovalFromGateway(options: {
  accountId: string;
  approvalId: string;
  approvalKind: string;
  decision: string;
  reviewerId: string;
  cfg: any;
  gatewayUrl?: string;
}): Promise<void> {
  const accountId = normalizeAccountId(options.accountId);
  const approvalId = normalized(options.approvalId);
  const approvalKind = approvalKindOf(options.approvalKind);
  const decision = approvalDecisionOf(options.decision);
  const reviewerId = normalized(options.reviewerId);
  const pending = pendingEntries.get(approvalId);
  if (!approvalId || !approvalKind || !decision || !reviewerId) {
    throw new Error('invalid approval resolution request');
  }
  if (!pending || pending.accountId !== accountId || pending.approvalKind !== approvalKind) {
    throw new Error('approval is not pending for this XiotBox account');
  }
  if (approvalResolverOverride) {
    await approvalResolverOverride({
      approvalId,
      approvalKind,
      decision,
      reviewerId,
      cfg: options.cfg,
      gatewayUrl: options.gatewayUrl,
      channel: 'xiotbox',
      accountId,
    });
    return;
  }
  const moduleName = 'openclaw/plugin-sdk/approval-gateway-runtime';
  const runtime = await import(moduleName);
  if (typeof runtime?.resolveApprovalOverGateway !== 'function') {
    throw new Error('OpenClaw approval resolver unavailable');
  }
  resolvingReviewers.set(approvalId, reviewerId);
  try {
    await runtime.resolveApprovalOverGateway({
      cfg: options.cfg,
      approvalId,
      approvalKind,
      decision,
      channel: 'xiotbox',
      accountId,
      senderId: reviewerId,
      gatewayUrl: options.gatewayUrl,
      clientDisplayName: `XiotBox approval (${reviewerId})`,
    });
  } catch (err) {
    resolvingReviewers.delete(approvalId);
    throw err;
  }
}

export async function handleGatewayApprovalResolve(options: {
  accountId: string;
  request: any;
  cfg: any;
  sendAck: (payload: Record<string, unknown>) => void;
}): Promise<{ ok: boolean; error?: string }> {
  const requestId = normalized(options.request?.request_id);
  try {
    await resolveApprovalFromGateway({
      accountId: options.accountId,
      approvalId: options.request?.approval_id,
      approvalKind: options.request?.approval_kind,
      decision: options.request?.decision,
      reviewerId: options.request?.reviewer_id,
      cfg: options.cfg,
      gatewayUrl: options.request?.openclaw_gateway_url,
    });
    options.sendAck({ request_id: requestId, status: 'accepted' });
    return { ok: true };
  } catch (err) {
    options.sendAck({
      request_id: requestId,
      status: 'rejected',
      error_code: 'approval_resolution_failed',
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function setApprovalResolverForTest(
  resolver: ((options: any) => Promise<void>) | null,
): void {
  approvalResolverOverride = resolver;
}

export function resetApprovalLifecycleForTest(): void {
  accounts.clear();
  activeBindings.clear();
  pendingEntries.clear();
  resolvingReviewers.clear();
  approvalResolverOverride = null;
}
