const accounts = new Map();
const activeBindings = new Map();
const READ_TOOLS = new Set(['memory_search', 'memory_get', 'memory_query', 'memory_recall']);
const SAVE_TOOLS = new Set(['memory_save', 'memory_set', 'memory_remember', 'remember']);
const DELETE_TOOLS = new Set(['memory_delete', 'memory_remove', 'memory_forget', 'forget']);
function normalized(value) {
    return String(value || '').trim();
}
function memoryActionFor(toolName) {
    // OpenClaw exposes MCP-backed memory tools with an `mcp__<server>__` prefix
    // (e.g. mcp__openclaw__memory_search); normalize to the bare tool name.
    const bare = toolName.split('__').pop() || toolName;
    if (READ_TOOLS.has(bare))
        return 'hit';
    if (SAVE_TOOLS.has(bare))
        return 'saved';
    if (DELETE_TOOLS.has(bare))
        return 'deleted';
    return null;
}
function bounded(value, maxLength = 200) {
    const text = normalized(value);
    return text ? text.slice(0, maxLength) : undefined;
}
function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function firstValue(source, keys) {
    for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null)
            return value;
    }
    return undefined;
}
function summarizeMemoryResult(result) {
    if (Array.isArray(result)) {
        const refs = result
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .slice(0, 20)
            .map((item) => summarizeRef(item))
            .filter((ref) => Object.keys(ref).length > 0);
        return { count: result.length, refs };
    }
    if (!result || typeof result !== 'object')
        return { refs: [] };
    const record = result;
    const arrayKey = ['hits', 'results', 'matches', 'items'].find((key) => Array.isArray(record[key]));
    const countKey = ['count', 'total', 'total_hits', 'match_count'].find((key) => numeric(record[key]) !== undefined);
    const items = arrayKey ? record[arrayKey] : [];
    const refs = items
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 20)
        .map((item) => summarizeRef(item))
        .filter((ref) => Object.keys(ref).length > 0);
    return {
        count: arrayKey ? items.length : numeric(record[countKey]),
        refs,
    };
}
function summarizeRef(item) {
    const ref = {};
    const id = bounded(firstValue(item, ['id', 'path', 'file', 'source_path', 'memory_id']));
    const source = bounded(firstValue(item, ['source', 'sourceType', 'corpus']), 100);
    const score = numeric(firstValue(item, ['score', 'relevance', 'distance']));
    if (id)
        ref.id = id;
    if (source)
        ref.source = source;
    if (score !== undefined)
        ref.score = score;
    return ref;
}
export function registerMemoryLifecycleAccount(options) {
    const accountId = normalized(options.accountId) || 'default';
    const registration = {
        deviceId: normalized(options.deviceId),
        emit: options.emit,
    };
    accounts.set(accountId, registration);
    return () => {
        if (accounts.get(accountId) === registration)
            accounts.delete(accountId);
    };
}
export function registerActiveMemoryBinding(options) {
    const sessionKey = normalized(options.sessionKey);
    const accountId = normalized(options.accountId) || 'default';
    if (!sessionKey || !accounts.has(accountId))
        return () => { };
    const token = Symbol('xiotbox-memory-binding');
    const bindings = activeBindings.get(sessionKey) || new Map();
    bindings.set(token, { ...options, token, sessionKey, accountId });
    activeBindings.set(sessionKey, bindings);
    return () => {
        const current = activeBindings.get(sessionKey);
        current?.delete(token);
        if (!current?.size)
            activeBindings.delete(sessionKey);
    };
}
function resolveBinding(event) {
    const sessionKey = normalized(event.sessionKey);
    if (!sessionKey)
        return null;
    const candidates = [...(activeBindings.get(sessionKey)?.values() || [])];
    const agentId = normalized(event.agentId);
    const scoped = agentId
        ? candidates.filter((binding) => binding.agentId === agentId)
        : candidates;
    return scoped.length === 1 ? scoped[0] : null;
}
function projectMemoryAction(params) {
    const action = memoryActionFor(params.toolName);
    if (!action)
        return;
    const binding = resolveBinding({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
    });
    if (!binding)
        return;
    const account = accounts.get(binding.accountId);
    if (!account)
        return;
    const toolCallId = normalized(params.toolCallId);
    const summary = summarizeMemoryResult(params.result);
    account.emit({
        event_id: `${binding.runId}:memory:${toolCallId || action}:${action}`,
        binding_id: binding.bindingId,
        conversation_id: binding.conversationId,
        kind: `memory.${action}`,
        actor: { type: 'agent', id: binding.agentId },
        run_id: binding.runId,
        visibility: 'user',
        trace_id: binding.traceId,
        payload: {
            tool_name: params.toolName,
            tool_call_id: toolCallId || undefined,
            status: 'completed',
            memory_action: action,
            count: summary.count,
            refs: summary.refs,
        },
    });
}
export function handleMemoryAgentEvent(event) {
    if (event.stream !== 'tool' || event.data?.phase !== 'result')
        return;
    if (event.data?.isError)
        return;
    const rawToolName = normalized(event.data?.name);
    const toolName = rawToolName.split('__').pop() || rawToolName;
    projectMemoryAction({
        sessionKey: event.sessionKey,
        agentId: event.agentId,
        toolName,
        toolCallId: event.data?.toolCallId,
        result: event.data?.result,
    });
}
export function handleMemoryAfterToolCall(event, ctx) {
    const rawToolName = normalized(event?.toolName);
    const toolName = rawToolName.split('__').pop() || rawToolName;
    if (!memoryActionFor(toolName))
        return;
    if (event?.error)
        return;
    projectMemoryAction({
        sessionKey: ctx?.sessionKey,
        agentId: ctx?.agentId,
        toolName,
        toolCallId: ctx?.toolCallId || event?.toolCallId,
        result: event?.result,
    });
}
export function resetMemoryLifecycleForTest() {
    accounts.clear();
    activeBindings.clear();
}
