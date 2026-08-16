import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerActiveToolRun } from './tool-lifecycle.js';
import { getXiotboxRuntimeOrNull } from './runtime.js';
const MAX_CHILD_RUNS = 2000;
const CHILD_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const accounts = new Map();
const activeParents = new Map();
const childRuns = new Map();
// 子会话 → 工具生命周期注销器（把子智能体的工具动作投影到父会话）。
const childToolRunUnregisters = new Map();
function normalized(value) {
    return String(value || '').trim();
}
function safeDeviceId(value) {
    return normalized(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'default';
}
export function resolveSubagentStatePath(deviceId) {
    const configuredHome = normalized(process.env.OPENCLAW_HOME);
    const openclawHome = configuredHome || path.join(os.homedir(), '.openclaw');
    return path.join(openclawHome, 'xiotbox', 'subagent-runs', `${safeDeviceId(deviceId)}.json`);
}
function childKey(deviceId, childRunId) {
    return `${deviceId}\n${childRunId}`;
}
function pruneDevice(deviceId, now = Date.now()) {
    const records = [...childRuns.entries()]
        .filter(([, record]) => record.deviceId === deviceId)
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
    for (const [key, record] of records) {
        if (now - record.createdAt > CHILD_RUN_TTL_MS)
            childRuns.delete(key);
    }
    const retained = [...childRuns.entries()]
        .filter(([, record]) => record.deviceId === deviceId)
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (retained.length > MAX_CHILD_RUNS) {
        const oldest = retained.shift();
        if (oldest)
            childRuns.delete(oldest[0]);
    }
}
function persistDevice(deviceId) {
    const account = accounts.get(deviceId);
    if (!account?.stateReady)
        return false;
    try {
        pruneDevice(deviceId);
        const state = {
            version: 1,
            children: [...childRuns.values()].filter((record) => record.deviceId === deviceId),
        };
        const dir = path.dirname(account.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = `${account.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, account.filePath);
        return true;
    }
    catch (err) {
        account.logger?.error?.(`[XiotBox] subagent state persist failed path=${account.filePath} error=${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
function loadDevice(deviceId, filePath) {
    for (const [key, record] of childRuns) {
        if (record.deviceId === deviceId)
            childRuns.delete(key);
    }
    try {
        if (!fs.existsSync(filePath))
            return true;
        const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (state?.version !== 1 || !Array.isArray(state.children))
            return false;
        for (const record of state.children) {
            const childRunId = normalized(record?.childRunId);
            const childSessionKey = normalized(record?.childSessionKey);
            if (record?.deviceId !== deviceId || !childRunId || !childSessionKey)
                continue;
            childRuns.set(childKey(deviceId, childRunId), { ...record, childRunId, childSessionKey });
        }
        pruneDevice(deviceId);
        return true;
    }
    catch {
        return false;
    }
}
export function registerSubagentLifecycleAccount(options) {
    const deviceId = normalized(options.deviceId);
    if (!deviceId)
        return () => { };
    const registration = {
        filePath: path.resolve(options.filePath || resolveSubagentStatePath(deviceId)),
        emit: options.emit,
        logger: options.logger,
        stateReady: false,
    };
    accounts.set(deviceId, registration);
    registration.stateReady = loadDevice(deviceId, registration.filePath);
    if (!registration.stateReady) {
        registration.logger?.error?.(`[XiotBox] subagent state invalid; lifecycle projection disabled path=${registration.filePath}`);
    }
    return () => {
        if (accounts.get(deviceId) === registration)
            accounts.delete(deviceId);
    };
}
export function registerActiveSubagentParent(options) {
    const sessionKey = normalized(options.sessionKey);
    const deviceId = normalized(options.deviceId);
    if (!sessionKey || !deviceId || !accounts.get(deviceId)?.stateReady)
        return () => { };
    const token = Symbol('xiotbox-subagent-parent');
    const parents = activeParents.get(sessionKey) || new Map();
    parents.set(token, { ...options, token, sessionKey, deviceId });
    activeParents.set(sessionKey, parents);
    return () => {
        const current = activeParents.get(sessionKey);
        current?.delete(token);
        if (!current?.size)
            activeParents.delete(sessionKey);
    };
}
function resolveParent(ctx) {
    const requesterSessionKey = normalized(ctx?.requesterSessionKey);
    if (!requesterSessionKey)
        return null;
    const candidates = [...(activeParents.get(requesterSessionKey)?.values() || [])];
    return candidates.length === 1 ? candidates[0] : null;
}
function emitChildEvent(record, kind, payload) {
    const account = accounts.get(record.deviceId);
    if (!account)
        return false;
    account.emit({
        event_id: `${record.parentRunId}:subagent:${record.childRunId}:${kind}`,
        binding_id: record.bindingId,
        conversation_id: record.conversationId,
        kind,
        actor: { type: 'subagent', id: record.childAgentId },
        run_id: record.childRunId,
        parent_run_id: record.parentRunId,
        visibility: 'user',
        trace_id: record.traceId,
        payload,
    });
    return true;
}
/** 把子智能体的工具动作投影到父会话（run_id = childRunId，actor=subagent）。 */
function emitChildToolEvent(record, kind, payload, occurrenceId) {
    const account = accounts.get(record.deviceId);
    if (!account)
        return;
    account.emit({
        event_id: `${record.childRunId}:tool:${occurrenceId}`,
        binding_id: record.bindingId,
        conversation_id: record.conversationId,
        kind,
        actor: { type: 'subagent', id: record.childAgentId },
        run_id: record.childRunId,
        parent_run_id: record.parentRunId,
        visibility: 'user',
        trace_id: record.traceId,
        payload,
    });
}
export function handleSubagentSpawned(event, ctx) {
    const parent = resolveParent(ctx);
    const childRunId = normalized(event?.runId || ctx?.runId);
    const childSessionKey = normalized(event?.childSessionKey || ctx?.childSessionKey);
    const childAgentId = normalized(event?.agentId);
    if (!parent || !childRunId || !childSessionKey || !childAgentId)
        return;
    const record = {
        deviceId: parent.deviceId,
        bindingId: parent.bindingId,
        conversationId: parent.conversationId,
        parentAgentId: parent.agentId,
        childAgentId,
        parentRunId: parent.parentRunId,
        childRunId,
        childSessionKey,
        traceId: parent.traceId,
        createdAt: Date.now(),
    };
    childRuns.set(childKey(record.deviceId, childRunId), record);
    if (!persistDevice(record.deviceId)) {
        childRuns.delete(childKey(record.deviceId, childRunId));
        return;
    }
    emitChildEvent(record, 'subagent.spawned', {
        child_session_key: childSessionKey,
        mode: normalized(event?.mode) || undefined,
        label: normalized(event?.label) || undefined,
        resolved_model: normalized(event?.resolvedModel) || undefined,
        resolved_provider: normalized(event?.resolvedProvider) || undefined,
        thread_requested: event?.threadRequested === true,
        status: 'running',
    });
    // 把子会话的工具动作也投影到父会话（run_id=childRunId），供父端展示子智能体时间线。
    childToolRunUnregisters.set(childKey(record.deviceId, childRunId), registerActiveToolRun({
        sessionKey: childSessionKey,
        agentId: childAgentId,
        emit: (kind, payload, occurrenceId) => emitChildToolEvent(record, kind, payload, occurrenceId),
    }));
}
function resolveChild(event, ctx) {
    const childRunId = normalized(event?.runId || ctx?.runId);
    const childSessionKey = normalized(event?.targetSessionKey || ctx?.childSessionKey);
    let candidates = [...childRuns.values()];
    if (childRunId)
        candidates = candidates.filter((record) => record.childRunId === childRunId);
    if (childSessionKey) {
        candidates = candidates.filter((record) => record.childSessionKey === childSessionKey);
    }
    return candidates.length === 1 ? candidates[0] : null;
}
function parentAgentIdFromSessionKey(sessionKey) {
    const raw = normalized(sessionKey);
    const match = /^agent:([^:]+):/i.exec(raw);
    if (!match?.[1])
        return '';
    return match[1].toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
function requestParentSupervisorWake(params) {
    const requesterSessionKey = normalized(params.requesterSessionKey);
    if (!requesterSessionKey)
        return;
    const requestHeartbeat = getXiotboxRuntimeOrNull()?.system?.requestHeartbeat;
    if (typeof requestHeartbeat !== 'function')
        return;
    try {
        requestHeartbeat({
            source: 'background-task',
            intent: 'immediate',
            reason: 'subagent-completed',
            ...(params.parentAgentId ? { agentId: params.parentAgentId } : {}),
            sessionKey: requesterSessionKey,
        });
    }
    catch {
        // Wake is best-effort; the projection below still completes.
    }
}
export function handleSubagentEnded(event, ctx) {
    if (normalized(event?.targetKind) !== 'subagent')
        return;
    const record = resolveChild(event, ctx);
    const requesterSessionKey = normalized(ctx?.requesterSessionKey);
    const parentAgentId = record?.parentAgentId || parentAgentIdFromSessionKey(requesterSessionKey);
    // Wake the parent supervisor session so it can review and relay the completed
    // result immediately instead of waiting for a scheduled poll or a user prompt.
    requestParentSupervisorWake({ requesterSessionKey, parentAgentId });
    if (!record)
        return;
    const emitted = emitChildEvent(record, 'subagent.completed', {
        child_session_key: record.childSessionKey,
        status: normalized(event?.outcome) || 'unknown',
        ended_at: Number.isFinite(Number(event?.endedAt)) ? Number(event?.endedAt) : undefined,
    });
    if (!emitted)
        return;
    childRuns.delete(childKey(record.deviceId, record.childRunId));
    const toolUnregister = childToolRunUnregisters.get(childKey(record.deviceId, record.childRunId));
    toolUnregister?.();
    childToolRunUnregisters.delete(childKey(record.deviceId, record.childRunId));
    if (!persistDevice(record.deviceId)) {
        childRuns.set(childKey(record.deviceId, record.childRunId), record);
    }
}
export function resetSubagentLifecycleForTest() {
    for (const unregister of childToolRunUnregisters.values())
        unregister();
    childToolRunUnregisters.clear();
    accounts.clear();
    activeParents.clear();
    childRuns.clear();
}
