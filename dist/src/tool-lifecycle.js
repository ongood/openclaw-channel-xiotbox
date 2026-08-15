const activeRuns = new Map();
// ── Readonly permission ─────────────────────────────────────────────
// The Flutter client can send a per-session permission (full | readonly).
// Readonly blocks write/exec tools via the before_tool_call hook result.
const sessionPermissions = new Map();
const WRITE_TOOLS = new Set([
    'exec', 'bash', 'shell', 'terminal', 'process', 'command',
    'write', 'edit', 'patch', 'apply', 'code_execution',
]);
function bareToolName(toolName) {
    return toolName.split('__').pop() || toolName;
}
function isWriteTool(toolName) {
    return WRITE_TOOLS.has(bareToolName(toolName));
}
export function setSessionPermission(sessionKey, permission) {
    const key = normalized(sessionKey);
    if (!key)
        return;
    sessionPermissions.set(key, permission);
}
export function resetSessionPermissionsForTest() {
    sessionPermissions.clear();
}
// ── Redaction bounds ────────────────────────────────────────────────
// Tool params/result are projected to the chat UI, so they must never carry
// secrets. Redaction is key-based (sensitive field names), value-based (known
// secret formats and `key=value` credential strings), and size-bounded.
const MAX_REDACT_DEPTH = 6;
const MAX_REDACT_ARRAY_ITEMS = 50;
const MAX_REDACT_STRING = 500;
const MAX_PARAMS_CHARS = 4000;
const MAX_RESULT_CHARS = 12000;
const MAX_ERROR_CHARS = 300;
const SENSITIVE_KEY_RE = /secret|token|api[_-]?key|passw(?:or)?d|credential|authorization|auth\b|cookie|private[_-]?key|access[_-]?key|session[_-]?key/i;
const SENSITIVE_VALUE_RE = /sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[bporas]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{8,}|(?:secret|token|api[_-]?key|passw(?:or)?d|credential)\s*[=:]\s*\S+/i;
function normalized(value) {
    return String(value || '').trim();
}
function truncate(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength)}…[truncated]`;
}
function redactStringValue(value) {
    return value.replace(SENSITIVE_VALUE_RE, '[redacted]');
}
function redact(value, depth = 0) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'string') {
        return truncate(redactStringValue(value), MAX_REDACT_STRING);
    }
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (Array.isArray(value)) {
        const items = value
            .slice(0, MAX_REDACT_ARRAY_ITEMS)
            .map((item) => redact(item, depth + 1));
        if (value.length > MAX_REDACT_ARRAY_ITEMS) {
            items.push(`…${value.length - MAX_REDACT_ARRAY_ITEMS} more`);
        }
        return items;
    }
    if (typeof value === 'object') {
        if (depth >= MAX_REDACT_DEPTH)
            return '[…]';
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redact(entry, depth + 1);
        }
        return out;
    }
    return String(value);
}
/** Redact then JSON-serialize for projection; undefined for empty/absent values. */
function projectText(value, maxChars) {
    if (value === undefined || value === null)
        return undefined;
    let text;
    try {
        text = JSON.stringify(redact(value), null, 2);
    }
    catch {
        text = String(value);
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}' || trimmed === '[]' || trimmed === '""') {
        return undefined;
    }
    return truncate(text, maxChars);
}
/** Redacted first-line error summary; errors often carry secrets, so keep it short. */
function projectError(error) {
    if (error === undefined || error === null)
        return undefined;
    const redactedText = redactStringValue(String(error));
    const firstLine = redactedText
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) || '';
    if (!firstLine)
        return undefined;
    return truncate(firstLine, MAX_ERROR_CHARS);
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
    // readonly 会话：写/执行类工具直接 block，不投影运行中。
    const sessionKey = normalized(ctx?.sessionKey);
    if (sessionKey && sessionPermissions.get(sessionKey) === 'readonly') {
        if (isWriteTool(resolved.toolName)) {
            return { block: true, blockReason: 'readonly mode: write/exec tools are disabled' };
        }
    }
    const params = projectText(event?.params, MAX_PARAMS_CHARS);
    const payload = {
        tool_name: resolved.toolName,
        tool_call_id: resolved.toolCallId,
        runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
        status: 'running',
    };
    if (params !== undefined)
        payload.params = params;
    resolved.activeRun.emit('tool.call', payload, `tool:${resolved.toolCallId}:call`);
}
export function handleAfterToolCall(event, ctx) {
    const resolved = resolveToolCall(event, ctx);
    if (!resolved)
        return;
    const durationMs = Number(event?.durationMs);
    const failed = Boolean(normalized(event?.error));
    const result = failed ? undefined : projectText(event?.result, MAX_RESULT_CHARS);
    const error = failed ? projectError(event?.error) : undefined;
    const payload = {
        tool_name: resolved.toolName,
        tool_call_id: resolved.toolCallId,
        runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
        status: failed ? 'failed' : 'completed',
        duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
    };
    if (result !== undefined)
        payload.result = result;
    if (error !== undefined)
        payload.error = error;
    resolved.activeRun.emit('tool.result', payload, `tool:${resolved.toolCallId}:result`);
}
export function resetActiveToolRunsForTest() {
    activeRuns.clear();
}
