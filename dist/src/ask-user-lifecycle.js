// Projects OpenClaw ask_user questions to the XiotBox Gateway as answerable
// cards, and resolves them over the Gateway (question.resolve). Mirrors the
// approval lifecycle: the question arrives through the outbound payload's
// `channelData.askUser` envelope, and the answer is submitted through the
// OpenClaw question gateway runtime.
const accounts = new Map();
const activeBindings = new Map();
const recentBindings = new Map();
const pendingQuestions = new Map();
let askUserResolverOverride = null;
const RECENT_BINDING_TTL_MS = 2 * 60 * 60 * 1000;
function normalized(value) {
    return String(value || '').trim();
}
function normalizeAccountId(value) {
    return normalized(value) || 'default';
}
function recentKey(accountId, sessionKey) {
    return `${normalizeAccountId(accountId)}\u0000${sessionKey}`;
}
function pruneRecentBindings() {
    const now = Date.now();
    for (const [key, entry] of recentBindings) {
        if (entry.expiresAt <= now)
            recentBindings.delete(key);
    }
}
export function registerAskUserLifecycleAccount(options) {
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
export function registerActiveAskUserBinding(options) {
    const sessionKey = normalized(options.sessionKey);
    const accountId = normalizeAccountId(options.accountId);
    if (!sessionKey || !accounts.has(accountId))
        return () => { };
    const token = Symbol('xiotbox-ask-user-binding');
    const bindings = activeBindings.get(sessionKey) || new Map();
    const binding = { ...options, token, sessionKey, accountId };
    bindings.set(token, binding);
    activeBindings.set(sessionKey, bindings);
    pruneRecentBindings();
    recentBindings.set(recentKey(accountId, sessionKey), {
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
function findBinding(sessionKey, accountId, conversationId) {
    const account = normalizeAccountId(accountId);
    if (sessionKey) {
        const active = [...(activeBindings.get(sessionKey)?.values() || [])].filter((binding) => binding.accountId === account);
        if (active.length === 1)
            return active[0];
        if (active.length > 1)
            return null;
    }
    pruneRecentBindings();
    const unique = new Map();
    for (const entry of recentBindings.values()) {
        if (entry.binding.accountId === account)
            unique.set(entry.binding.sessionKey, entry.binding);
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
        const exact = byAccount.filter((b) => b.conversationId === normalizedConversationId);
        if (exact.length === 1)
            return exact[0];
        if (exact.length > 1)
            return null;
    }
    return byAccount.length === 1 ? byAccount[0] : null;
}
function emitEvent(entry, kind, payload) {
    const account = accounts.get(entry.accountId);
    if (!account)
        return;
    account.emit({
        event_id: `${entry.binding.runId}:ask_user:${entry.questionId}:${kind}`,
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
function parseOutboundAskUserMeta(payload) {
    const record = payload?.channelData?.askUser;
    if (!record || typeof record !== 'object' || Array.isArray(record))
        return null;
    const questionId = normalized(record.questionId);
    if (!questionId)
        return null;
    const optionValues = Array.isArray(record.optionValues)
        ? record.optionValues.map((value) => normalized(value)).filter(Boolean)
        : [];
    return { questionId, optionValues };
}
/** Projects ask_user.requested from an outbound question payload. Idempotent per question id. */
export function handleOutboundAskUserPayload(params) {
    try {
        const meta = parseOutboundAskUserMeta(params.payload);
        if (!meta)
            return;
        if (pendingQuestions.has(meta.questionId))
            return;
        const binding = findBinding(null, params.accountId, params.conversationId);
        if (!binding || !accounts.has(binding.accountId))
            return;
        const entry = {
            accountId: binding.accountId,
            questionId: meta.questionId,
            binding,
        };
        emitEvent(entry, 'ask_user.requested', {
            question_id: meta.questionId,
            status: 'pending',
            question: typeof params.payload?.text === 'string' ? params.payload.text : '',
            option_values: meta.optionValues.length ? meta.optionValues : undefined,
        });
        pendingQuestions.set(meta.questionId, entry);
    }
    catch {
        // Projection must never break outbound delivery.
    }
}
/** Resolves a pending question over the OpenClaw gateway, then projects the result. */
export async function resolveQuestionFromGateway(options) {
    const accountId = normalizeAccountId(options.accountId);
    const questionId = normalized(options.questionId);
    const optionValue = normalized(options.optionValue);
    const reviewerId = normalized(options.reviewerId);
    const pending = pendingQuestions.get(questionId);
    if (!questionId || !optionValue || !reviewerId) {
        throw new Error('invalid question resolution request');
    }
    if (!pending || pending.accountId !== accountId) {
        throw new Error('question is not pending for this XiotBox account');
    }
    try {
        if (askUserResolverOverride) {
            await askUserResolverOverride({
                cfg: options.cfg,
                questionId,
                optionValue,
                senderId: reviewerId,
                gatewayUrl: options.gatewayUrl,
                clientDisplayName: `XiotBox question (${reviewerId})`,
            });
        }
        else {
            const moduleName = 'openclaw/plugin-sdk/question-gateway-runtime';
            const runtime = await import(moduleName);
            const resolveOption = runtime?.questionGatewayRuntime?.resolveOption;
            if (typeof resolveOption !== 'function') {
                throw new Error('OpenClaw question resolver unavailable');
            }
            await resolveOption({
                cfg: options.cfg,
                questionId,
                optionValue,
                senderId: reviewerId,
                gatewayUrl: options.gatewayUrl,
                clientDisplayName: `XiotBox question (${reviewerId})`,
            });
        }
    }
    catch (err) {
        throw err;
    }
    emitEvent(pending, 'ask_user.resolved', {
        question_id: questionId,
        status: 'resolved',
        answer: optionValue,
        resolved_by: reviewerId,
    });
    pendingQuestions.delete(questionId);
}
export async function handleGatewayAskUserResolve(options) {
    const requestId = normalized(options.request?.request_id);
    try {
        await resolveQuestionFromGateway({
            accountId: options.accountId,
            questionId: options.request?.question_id,
            optionValue: options.request?.answer,
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
            error_code: 'ask_user_resolution_failed',
        });
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
export function setAskUserResolverForTest(resolver) {
    askUserResolverOverride = resolver;
}
export function resetAskUserLifecycleForTest() {
    accounts.clear();
    activeBindings.clear();
    recentBindings.clear();
    pendingQuestions.clear();
    askUserResolverOverride = null;
}
