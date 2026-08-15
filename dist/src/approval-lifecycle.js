const accounts = new Map();
const activeBindings = new Map();
const recentBindings = new Map();
const pendingEntries = new Map();
const resolvingReviewers = new Map();
let approvalResolverOverride = null;
const RECENT_BINDING_TTL_MS = 2 * 60 * 60 * 1000;
function normalized(value) {
    return String(value || '').trim();
}
function normalizeAccountId(value) {
    return normalized(value) || 'default';
}
function approvalKindOf(value) {
    return value === 'exec' || value === 'plugin' ? value : null;
}
function approvalDecisionOf(value) {
    return value === 'allow-once' || value === 'allow-always' || value === 'deny'
        ? value
        : null;
}
function recentBindingKey(accountId, sessionKey) {
    return `${normalizeAccountId(accountId)}\u0000${sessionKey}`;
}
function pruneRecentBindings() {
    const now = Date.now();
    for (const [key, entry] of recentBindings) {
        if (entry.expiresAt <= now)
            recentBindings.delete(key);
    }
}
function resolveBindingBySession(sessionKey, accountId) {
    const account = normalizeAccountId(accountId);
    const active = [...(activeBindings.get(sessionKey)?.values() || [])].filter((binding) => binding.accountId === account);
    if (active.length === 1)
        return active[0];
    if (active.length > 1)
        return null;
    pruneRecentBindings();
    return recentBindings.get(recentBindingKey(account, sessionKey))?.binding || null;
}
function resolveBinding(request) {
    if (normalized(request?.request?.turnSourceChannel).toLowerCase() !== 'xiotbox')
        return null;
    const sessionKey = normalized(request?.request?.sessionKey);
    if (!sessionKey)
        return null;
    const sourceAccountId = normalizeAccountId(request?.request?.turnSourceAccountId);
    return resolveBindingBySession(sessionKey, sourceAccountId);
}
function allowedDecisions(request, view) {
    const values = [
        ...(Array.isArray(view?.actions) ? view.actions.map((action) => action?.decision) : []),
        ...(Array.isArray(request?.request?.allowedDecisions)
            ? request.request.allowedDecisions
            : []),
    ];
    const result = [];
    for (const value of values) {
        const decision = approvalDecisionOf(value);
        if (decision && !result.includes(decision))
            result.push(decision);
    }
    return result.length ? result : ['deny'];
}
function emitApprovalEvent(entry, kind, payload) {
    const account = accounts.get(entry.accountId);
    if (!account)
        throw new Error('xiotbox approval account unavailable');
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
export function registerApprovalLifecycleAccount(options) {
    const accountId = normalizeAccountId(options.accountId);
    const registration = { deviceId: normalized(options.deviceId), emit: options.emit };
    accounts.set(accountId, registration);
    return () => {
        if (accounts.get(accountId) !== registration)
            return;
        accounts.delete(accountId);
        for (const [key, entry] of recentBindings) {
            if (entry.binding.accountId === accountId)
                recentBindings.delete(key);
        }
    };
}
export function registerActiveApprovalBinding(options) {
    const sessionKey = normalized(options.sessionKey);
    const accountId = normalizeAccountId(options.accountId);
    if (!sessionKey || !accounts.has(accountId))
        return () => { };
    const token = Symbol('xiotbox-approval-binding');
    const bindings = activeBindings.get(sessionKey) || new Map();
    const binding = { ...options, token, sessionKey, accountId };
    bindings.set(token, binding);
    activeBindings.set(sessionKey, bindings);
    pruneRecentBindings();
    recentBindings.set(recentBindingKey(accountId, sessionKey), {
        binding,
        expiresAt: Date.now() + RECENT_BINDING_TTL_MS,
    });
    return () => {
        const current = activeBindings.get(sessionKey);
        current?.delete(token);
        if (!current?.size)
            activeBindings.delete(sessionKey);
    };
}
function buildPendingPayload(params) {
    const binding = resolveBinding(params?.request);
    const approvalId = normalized(params?.request?.id);
    const kind = approvalKindOf(params?.approvalKind);
    if (!binding || !approvalId || !kind)
        throw new Error('approval binding unavailable');
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
function parseApprovalExpiresAt(text, record) {
    const expiresAtMs = Number(record?.expiresAtMs);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > 0)
        return expiresAtMs / 1000;
    const expiresAt = Number(record?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
        return expiresAt > 10000000000 ? expiresAt / 1000 : expiresAt;
    }
    const match = text.match(/Expires in:\s*(\d+)\s*(s|m|h|d)\b/i);
    const unitSeconds = { s: 1, m: 60, h: 3600, d: 86400 };
    const ttlSeconds = match ? Number(match[1]) * unitSeconds[match[2].toLowerCase()] : 1800;
    return Date.now() / 1000 + ttlSeconds;
}
function parseOutboundApprovalMeta(payload) {
    const record = payload?.channelData?.execApproval;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (!text.includes('Approval required.') || !text.includes('Pending command:'))
            return null;
        const idMatch = text.match(/Full id:\s*`([^`\s]+)`/i);
        if (!idMatch)
            return null;
        const allowed = [];
        for (const match of text.matchAll(/\/approve\s+\S+\s+(allow-once|allow-always|deny)\b/g)) {
            const decision = approvalDecisionOf(match[1]);
            if (decision && !allowed.includes(decision))
                allowed.push(decision);
        }
        if (!allowed.length)
            return null;
        return {
            approvalId: idMatch[1],
            approvalKind: 'exec',
            allowedDecisions: allowed,
            agentId: '',
            sessionKey: null,
            state: null,
            expiresAt: parseApprovalExpiresAt(text),
        };
    }
    const approvalId = normalized(record.approvalId);
    if (!approvalId)
        return null;
    // Resolved payloads omit approvalKind (channelData.execApproval only carries
    // approvalId/approvalSlug/state); the pending entry owns the real kind.
    const approvalKind = approvalKindOf(record.approvalKind) ?? 'exec';
    const allowed = [];
    for (const value of Array.isArray(record.allowedDecisions) ? record.allowedDecisions : []) {
        const decision = approvalDecisionOf(value);
        if (decision && !allowed.includes(decision))
            allowed.push(decision);
    }
    return {
        approvalId,
        approvalKind,
        allowedDecisions: allowed.length ? allowed : ['deny'],
        agentId: normalized(record.agentId),
        sessionKey: normalized(record.sessionKey) || null,
        state: normalized(record.state) || null,
        expiresAt: parseApprovalExpiresAt(typeof payload?.text === 'string' ? payload.text : '', record),
    };
}
function findOutboundApprovalBinding(sessionKey, accountId, conversationId) {
    const account = normalizeAccountId(accountId);
    if (sessionKey) {
        const binding = resolveBindingBySession(sessionKey, account);
        if (binding)
            return binding;
    }
    // Delayed approval followups can omit sessionKey and arrive after dispatch
    // teardown. Merge active and recent bindings, then use the outbound target
    // conversation to disambiguate when the account has multiple conversations.
    pruneRecentBindings();
    const unique = new Map();
    for (const entry of recentBindings.values()) {
        if (entry.binding.accountId === account) {
            unique.set(entry.binding.sessionKey, entry.binding);
        }
    }
    for (const bindings of activeBindings.values()) {
        for (const binding of bindings.values()) {
            if (binding.accountId === account)
                unique.set(binding.sessionKey, binding);
        }
    }
    const byAccount = [...unique.values()];
    const normalizedConversationId = normalized(conversationId);
    if (normalizedConversationId) {
        const exact = byAccount.filter((binding) => binding.conversationId === normalizedConversationId);
        if (exact.length === 1)
            return exact[0];
        if (exact.length > 1)
            return null;
    }
    return byAccount.length === 1 ? byAccount[0] : null;
}
function parseResolvedDecision(text) {
    const match = text.match(/(?:✅\s*)?(?:Exec|Plugin) approval (allowed once|allowed always|denied)\./);
    if (!match)
        return null;
    if (match[1] === 'allowed once')
        return 'allow-once';
    if (match[1] === 'allowed always')
        return 'allow-always';
    return 'deny';
}
function parseResolvedBy(text) {
    const match = text.match(/Resolved by ([^.]+)\./);
    return match ? normalized(match[1]) || null : null;
}
function findApprovalAccount(accountId) {
    return accounts.get(normalizeAccountId(accountId)) || null;
}
/** Projects approval.requested from an outbound pending approval payload. Idempotent per approval id. */
export function projectOutboundApprovalRequested(params) {
    const meta = parseOutboundApprovalMeta(params.payload);
    if (!meta || meta.state === 'resolved')
        return false;
    if (pendingEntries.has(meta.approvalId))
        return false;
    const binding = findOutboundApprovalBinding(meta.sessionKey, params.accountId, params.conversationId);
    if (!binding || !findApprovalAccount(binding.accountId))
        return false;
    const entry = {
        accountId: binding.accountId,
        approvalId: meta.approvalId,
        approvalKind: meta.approvalKind,
        binding,
    };
    emitApprovalEvent(entry, 'approval.requested', {
        approval_id: meta.approvalId,
        approval_kind: meta.approvalKind,
        status: 'pending',
        allowed_decisions: meta.allowedDecisions,
        expires_at: meta.expiresAt,
        agent_id: meta.agentId || binding.agentId,
    });
    pendingEntries.set(entry.approvalId, entry);
    return true;
}
/** Projects approval.resolved from an outbound resolved approval payload. */
export function projectOutboundApprovalResolved(params) {
    const meta = parseOutboundApprovalMeta(params.payload);
    if (!meta || meta.state !== 'resolved')
        return false;
    const pending = pendingEntries.get(meta.approvalId);
    if (!pending)
        return false;
    const text = typeof params.payload?.text === 'string' ? params.payload.text : '';
    const decision = parseResolvedDecision(text);
    const resolvedBy = resolvingReviewers.get(meta.approvalId) ||
        parseResolvedBy(text);
    emitApprovalEvent(pending, 'approval.resolved', {
        approval_id: pending.approvalId,
        approval_kind: pending.approvalKind,
        status: 'resolved',
        decision: decision || undefined,
        resolved_by: resolvedBy || undefined,
    });
    pendingEntries.delete(meta.approvalId);
    resolvingReviewers.delete(meta.approvalId);
    return true;
}
/** Projects approval.resolved from a formatted followup with stripped channelData. */
export function projectOutboundApprovalResolvedText(params) {
    const text = typeof params.payload?.text === 'string' ? params.payload.text : '';
    const decision = parseResolvedDecision(text);
    const idMatch = text.match(/\bID:\s*`?([A-Za-z0-9-]+)`?/);
    if (!decision || !idMatch)
        return false;
    const pending = pendingEntries.get(idMatch[1]);
    if (!pending)
        return false;
    const resolvedBy = resolvingReviewers.get(pending.approvalId) || parseResolvedBy(text);
    emitApprovalEvent(pending, 'approval.resolved', {
        approval_id: pending.approvalId,
        approval_kind: pending.approvalKind,
        status: 'resolved',
        decision,
        resolved_by: resolvedBy || undefined,
    });
    pendingEntries.delete(pending.approvalId);
    resolvingReviewers.delete(pending.approvalId);
    return true;
}
/** Projects approval.expired from the forwarder's expiry notice text (no structured metadata). */
export function projectOutboundApprovalExpired(params) {
    const text = typeof params.payload?.text === 'string' ? params.payload.text : '';
    const match = text.match(/⏱️ (?:Exec|Plugin) approval expired\. ID: (\S+)/);
    if (!match)
        return false;
    const pending = pendingEntries.get(match[1]);
    if (!pending)
        return false;
    emitApprovalEvent(pending, 'approval.expired', {
        approval_id: pending.approvalId,
        approval_kind: pending.approvalKind,
        status: 'expired',
    });
    pendingEntries.delete(pending.approvalId);
    resolvingReviewers.delete(pending.approvalId);
    return true;
}
/**
 * Entry point for the channel outbound afterDeliverPayload hook. Projects
 * approval.requested / approval.resolved / approval.expired to the XiotBox
 * Gateway from delivered approval payloads. Never throws.
 */
export function handleOutboundApprovalPayload(params) {
    try {
        const meta = parseOutboundApprovalMeta(params.payload);
        if (meta) {
            if (meta.state === 'resolved') {
                projectOutboundApprovalResolved(params);
            }
            else {
                projectOutboundApprovalRequested(params);
            }
            return;
        }
        if (projectOutboundApprovalResolvedText(params))
            return;
        projectOutboundApprovalExpired(params);
    }
    catch {
        // Projection must never break outbound delivery.
    }
}
export const xiotboxApprovalCapability = {
    authorizeActorAction: () => ({
        authorized: false,
        reason: 'XiotBox approvals require the authenticated Gateway v2 endpoint.',
    }),
    resolveApproveCommandBehavior: () => ({ kind: 'ignore' }),
    native: {
        describeDeliveryCapabilities: ({ request }) => {
            const enabled = Boolean(resolveBinding(request));
            return {
                enabled,
                preferredSurface: 'origin',
                supportsOriginSurface: enabled,
                supportsApproverDmSurface: false,
            };
        },
        resolveOriginTarget: ({ request }) => {
            const binding = resolveBinding(request);
            return binding ? { to: binding.deviceId, threadId: binding.conversationId } : null;
        },
    },
    nativeRuntime: {
        eventKinds: ['exec', 'plugin'],
        availability: {
            isConfigured: ({ accountId }) => accounts.has(normalizeAccountId(accountId)),
            shouldHandle: ({ request }) => Boolean(resolveBinding(request)),
        },
        presentation: {
            buildPendingPayload,
            buildResolvedResult: ({ resolved, entry }) => {
                const pending = entry;
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
            buildExpiredResult: ({ entry }) => {
                const pending = entry;
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
            prepareTarget: ({ pendingPayload }) => ({
                dedupeKey: `xiotbox:${pendingPayload.approvalId}`,
                target: pendingPayload,
            }),
            deliverPending: ({ preparedTarget }) => {
                const pending = preparedTarget;
                const entry = {
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
export async function resolveApprovalFromGateway(options) {
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
    resolvingReviewers.set(approvalId, reviewerId);
    try {
        const resolveOptions = {
            cfg: options.cfg,
            approvalId,
            approvalKind,
            decision,
            channel: 'xiotbox',
            accountId,
            senderId: reviewerId,
            gatewayUrl: options.gatewayUrl,
            clientDisplayName: `XiotBox approval (${reviewerId})`,
        };
        if (approvalResolverOverride) {
            await approvalResolverOverride(resolveOptions);
        }
        else {
            const moduleName = 'openclaw/plugin-sdk/approval-gateway-runtime';
            const runtime = await import(moduleName);
            if (typeof runtime?.resolveApprovalOverGateway !== 'function') {
                throw new Error('OpenClaw approval resolver unavailable');
            }
            await runtime.resolveApprovalOverGateway(resolveOptions);
        }
    }
    catch (err) {
        resolvingReviewers.delete(approvalId);
        throw err;
    }
    // The resolver returning means OpenClaw accepted the decision. Resolution
    // followup text is not guaranteed to traverse this channel's deliver()
    // callback, so close the Gateway lifecycle here. A concurrent native or
    // outbound resolution projection wins by deleting the pending entry first.
    if (pendingEntries.get(approvalId) === pending) {
        emitApprovalEvent(pending, 'approval.resolved', {
            approval_id: approvalId,
            approval_kind: approvalKind,
            status: 'resolved',
            decision,
            resolved_by: reviewerId,
        });
        pendingEntries.delete(approvalId);
    }
    resolvingReviewers.delete(approvalId);
}
export async function handleGatewayApprovalResolve(options) {
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
    }
    catch (err) {
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
export function setApprovalResolverForTest(resolver) {
    approvalResolverOverride = resolver;
}
export function resetApprovalLifecycleForTest() {
    accounts.clear();
    activeBindings.clear();
    recentBindings.clear();
    pendingEntries.clear();
    resolvingReviewers.clear();
    approvalResolverOverride = null;
}
