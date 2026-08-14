const activeRuns = new Map();
function normalized(value) {
    return String(value || '').trim();
}
function resolveActiveRun(event, ctx) {
    const sessionKey = normalized(ctx?.sessionKey);
    if (!sessionKey)
        return null;
    const sessionRuns = activeRuns.get(sessionKey);
    if (!sessionRuns?.size)
        return null;
    const agentId = normalized(ctx?.agentId);
    let candidates = [...sessionRuns.values()].filter((run) => !agentId || run.agentId === agentId);
    if (!candidates.length)
        return null;
    const runtimeRunId = normalized(ctx?.runId || event?.runId);
    if (runtimeRunId) {
        const exact = candidates.filter((run) => run.runtimeRunId === runtimeRunId);
        if (exact.length === 1)
            return exact[0];
        if (exact.length > 1)
            return null;
        candidates = candidates.filter((run) => !run.runtimeRunId);
    }
    if (candidates.length !== 1)
        return null;
    if (runtimeRunId)
        candidates[0].runtimeRunId = runtimeRunId;
    return candidates[0];
}
function resolveToolCall(event, ctx) {
    const activeRun = resolveActiveRun(event, ctx);
    const toolCallId = normalized(ctx?.toolCallId || event?.toolCallId);
    const toolName = normalized(event?.toolName || ctx?.toolName);
    if (!activeRun || !toolCallId || !toolName)
        return null;
    return { activeRun, toolCallId, toolName };
}
export function registerActiveToolRun(options) {
    const sessionKey = normalized(options.sessionKey);
    const agentId = normalized(options.agentId);
    if (!sessionKey || !agentId)
        return () => { };
    const token = Symbol('xiotbox-tool-run');
    const sessionRuns = activeRuns.get(sessionKey) || new Map();
    sessionRuns.set(token, { token, agentId, runtimeRunId: '', emit: options.emit });
    activeRuns.set(sessionKey, sessionRuns);
    return () => {
        const current = activeRuns.get(sessionKey);
        current?.delete(token);
        if (!current?.size)
            activeRuns.delete(sessionKey);
    };
}
export function handleBeforeToolCall(event, ctx) {
    const resolved = resolveToolCall(event, ctx);
    if (!resolved)
        return;
    resolved.activeRun.emit('tool.call', {
        tool_name: resolved.toolName,
        tool_call_id: resolved.toolCallId,
        runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
        status: 'running',
    }, `tool:${resolved.toolCallId}:call`);
}
export function handleAfterToolCall(event, ctx) {
    const resolved = resolveToolCall(event, ctx);
    if (!resolved)
        return;
    const durationMs = Number(event?.durationMs);
    resolved.activeRun.emit('tool.result', {
        tool_name: resolved.toolName,
        tool_call_id: resolved.toolCallId,
        runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
        status: normalized(event?.error) ? 'failed' : 'completed',
        duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
    }, `tool:${resolved.toolCallId}:result`);
}
export function resetActiveToolRunsForTest() {
    activeRuns.clear();
}
