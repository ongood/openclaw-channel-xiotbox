import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerActiveToolRun } from './tool-lifecycle.js';
import { getXiotboxRuntimeOrNull } from './runtime.js';

const MAX_CHILD_RUNS = 2000;
const CHILD_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SubagentHookContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

type SubagentSpawnedEvent = {
  runId?: string;
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  mode?: string;
  threadRequested?: boolean;
  resolvedModel?: string;
  resolvedProvider?: string;
};

type SubagentEndedEvent = {
  targetSessionKey?: string;
  targetKind?: string;
  reason?: string;
  runId?: string;
  endedAt?: number;
  outcome?: string;
};

type ParentRun = {
  token: symbol;
  deviceId: string;
  sessionKey: string;
  bindingId: string;
  conversationId: string;
  agentId: string;
  parentRunId: string;
  traceId: string | null;
};

type ChildRun = {
  deviceId: string;
  bindingId: string;
  conversationId: string;
  parentAgentId: string;
  childAgentId: string;
  parentRunId: string;
  childRunId: string;
  childSessionKey: string;
  traceId: string | null;
  createdAt: number;
};

type SubagentStateFile = {
  version: 1;
  children: ChildRun[];
};

type AccountRegistration = {
  filePath: string;
  emit: (event: Record<string, unknown>) => void;
  logger?: any;
  stateReady: boolean;
};

type RegisterSubagentAccountOptions = {
  deviceId: string;
  filePath?: string;
  emit: AccountRegistration['emit'];
  logger?: any;
};

type RegisterParentOptions = Omit<ParentRun, 'token'>;

const accounts = new Map<string, AccountRegistration>();
const activeParents = new Map<string, Map<symbol, ParentRun>>();
const childRuns = new Map<string, ChildRun>();
// 子会话 → 工具生命周期注销器（把子智能体的工具动作投影到父会话）。
const childToolRunUnregisters = new Map<string, () => void>();

function normalized(value: unknown): string {
  return String(value || '').trim();
}

function safeDeviceId(value: string): string {
  return normalized(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'default';
}

export function resolveSubagentStatePath(deviceId: string): string {
  const configuredHome = normalized(process.env.OPENCLAW_HOME);
  const openclawHome = configuredHome || path.join(os.homedir(), '.openclaw');
  return path.join(openclawHome, 'xiotbox', 'subagent-runs', `${safeDeviceId(deviceId)}.json`);
}

function childKey(deviceId: string, childRunId: string): string {
  return `${deviceId}\n${childRunId}`;
}

function pruneDevice(deviceId: string, now = Date.now()): void {
  const records = [...childRuns.entries()]
    .filter(([, record]) => record.deviceId === deviceId)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  for (const [key, record] of records) {
    if (now - record.createdAt > CHILD_RUN_TTL_MS) childRuns.delete(key);
  }
  const retained = [...childRuns.entries()]
    .filter(([, record]) => record.deviceId === deviceId)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  while (retained.length > MAX_CHILD_RUNS) {
    const oldest = retained.shift();
    if (oldest) childRuns.delete(oldest[0]);
  }
}

function persistDevice(deviceId: string): boolean {
  const account = accounts.get(deviceId);
  if (!account?.stateReady) return false;
  try {
    pruneDevice(deviceId);
    const state: SubagentStateFile = {
      version: 1,
      children: [...childRuns.values()].filter((record) => record.deviceId === deviceId),
    };
    const dir = path.dirname(account.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${account.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, account.filePath);
    return true;
  } catch (err) {
    account.logger?.error?.(
      `[XiotBox] subagent state persist failed path=${account.filePath} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function loadDevice(deviceId: string, filePath: string): boolean {
  for (const [key, record] of childRuns) {
    if (record.deviceId === deviceId) childRuns.delete(key);
  }
  try {
    if (!fs.existsSync(filePath)) return true;
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SubagentStateFile;
    if (state?.version !== 1 || !Array.isArray(state.children)) return false;
    for (const record of state.children) {
      const childRunId = normalized(record?.childRunId);
      const childSessionKey = normalized(record?.childSessionKey);
      if (record?.deviceId !== deviceId || !childRunId || !childSessionKey) continue;
      childRuns.set(childKey(deviceId, childRunId), { ...record, childRunId, childSessionKey });
    }
    pruneDevice(deviceId);
    return true;
  } catch {
    return false;
  }
}

export function registerSubagentLifecycleAccount(
  options: RegisterSubagentAccountOptions,
): () => void {
  const deviceId = normalized(options.deviceId);
  if (!deviceId) return () => {};
  const registration = {
    filePath: path.resolve(options.filePath || resolveSubagentStatePath(deviceId)),
    emit: options.emit,
    logger: options.logger,
    stateReady: false,
  };
  accounts.set(deviceId, registration);
  registration.stateReady = loadDevice(deviceId, registration.filePath);
  if (!registration.stateReady) {
    registration.logger?.error?.(
      `[XiotBox] subagent state invalid; lifecycle projection disabled path=${registration.filePath}`,
    );
  }
  return () => {
    if (accounts.get(deviceId) === registration) accounts.delete(deviceId);
  };
}

export function registerActiveSubagentParent(options: RegisterParentOptions): () => void {
  const sessionKey = normalized(options.sessionKey);
  const deviceId = normalized(options.deviceId);
  if (!sessionKey || !deviceId || !accounts.get(deviceId)?.stateReady) return () => {};
  const token = Symbol('xiotbox-subagent-parent');
  const parents = activeParents.get(sessionKey) || new Map<symbol, ParentRun>();
  parents.set(token, { ...options, token, sessionKey, deviceId });
  activeParents.set(sessionKey, parents);
  return () => {
    const current = activeParents.get(sessionKey);
    current?.delete(token);
    if (!current?.size) activeParents.delete(sessionKey);
  };
}

function resolveParent(ctx: SubagentHookContext): ParentRun | null {
  const requesterSessionKey = normalized(ctx?.requesterSessionKey);
  if (!requesterSessionKey) return null;
  const candidates = [...(activeParents.get(requesterSessionKey)?.values() || [])];
  return candidates.length === 1 ? candidates[0] : null;
}

function emitChildEvent(record: ChildRun, kind: string, payload: Record<string, unknown>): boolean {
  const account = accounts.get(record.deviceId);
  if (!account) return false;
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
function emitChildToolEvent(
  record: ChildRun,
  kind: string,
  payload: Record<string, unknown>,
  occurrenceId: string,
): void {
  const account = accounts.get(record.deviceId);
  if (!account) return;
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

export function handleSubagentSpawned(
  event: SubagentSpawnedEvent,
  ctx: SubagentHookContext,
): void {
  const parent = resolveParent(ctx);
  const childRunId = normalized(event?.runId || ctx?.runId);
  const childSessionKey = normalized(event?.childSessionKey || ctx?.childSessionKey);
  const childAgentId = normalized(event?.agentId);
  if (!parent || !childRunId || !childSessionKey || !childAgentId) return;
  const record: ChildRun = {
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
  childToolRunUnregisters.set(
    childKey(record.deviceId, childRunId),
    registerActiveToolRun({
      sessionKey: childSessionKey,
      agentId: childAgentId,
      emit: (kind, payload, occurrenceId) =>
        emitChildToolEvent(record, kind, payload, occurrenceId),
    }),
  );
}

function resolveChild(event: SubagentEndedEvent, ctx: SubagentHookContext): ChildRun | null {
  const childRunId = normalized(event?.runId || ctx?.runId);
  const childSessionKey = normalized(event?.targetSessionKey || ctx?.childSessionKey);
  let candidates = [...childRuns.values()];
  if (childRunId) candidates = candidates.filter((record) => record.childRunId === childRunId);
  if (childSessionKey) {
    candidates = candidates.filter((record) => record.childSessionKey === childSessionKey);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function parentAgentIdFromSessionKey(sessionKey?: string | null): string {
  const raw = normalized(sessionKey);
  const match = /^agent:([^:]+):/i.exec(raw);
  if (!match?.[1]) return '';
  return match[1].toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function logWake(message: string): void {
  try {
    console.error(`[xiotbox-subagent-wake] ${message}`);
  } catch {
    // ignore logging failures
  }
}

function requestParentSupervisorWake(params: {
  requesterSessionKey?: string | null;
  parentAgentId?: string;
}): void {
  const requesterSessionKey = normalized(params.requesterSessionKey);
  if (!requesterSessionKey) {
    logWake('no requesterSessionKey; skip wake');
    return;
  }
  const runtime = getXiotboxRuntimeOrNull();
  const requestHeartbeat = runtime?.system?.requestHeartbeat;
  if (typeof requestHeartbeat !== 'function') {
    logWake(`requestHeartbeat unavailable (runtime=${!!runtime}, system=${!!runtime?.system})`);
    return;
  }
  try {
    requestHeartbeat({
      // `notifications-event` is accepted as a targeted one-shot wake even
      // when the parent agent's recurring heartbeat is disabled. Older
      // OpenClaw 2026.8 builds do not grant that exception to background-task.
      source: 'notifications-event',
      intent: 'immediate',
      reason: 'wake',
      ...(params.parentAgentId ? { agentId: params.parentAgentId } : {}),
      sessionKey: requesterSessionKey,
    });
    logWake(`wake requested agent=${params.parentAgentId || ''} session=${requesterSessionKey}`);
  } catch (err) {
    logWake(`wake failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleSubagentEnded(event: SubagentEndedEvent, ctx: SubagentHookContext): void {
  logWake(
    `handleSubagentEnded targetKind=${event?.targetKind} runId=${event?.runId || ctx?.runId || ''} ` +
      `requesterSessionKey=${ctx?.requesterSessionKey || ''}`,
  );
  if (normalized(event?.targetKind) !== 'subagent') return;
  const record = resolveChild(event, ctx);
  const requesterSessionKey = normalized(ctx?.requesterSessionKey);
  const parentAgentId = record?.parentAgentId || parentAgentIdFromSessionKey(requesterSessionKey);
  // Wake the parent supervisor session so it can review and relay the completed
  // result immediately instead of waiting for a scheduled poll or a user prompt.
  requestParentSupervisorWake({ requesterSessionKey, parentAgentId });
  if (!record) return;
  const emitted = emitChildEvent(record, 'subagent.completed', {
    child_session_key: record.childSessionKey,
    status: normalized(event?.outcome) || 'unknown',
    ended_at: Number.isFinite(Number(event?.endedAt)) ? Number(event?.endedAt) : undefined,
  });
  if (!emitted) return;
  childRuns.delete(childKey(record.deviceId, record.childRunId));
  const toolUnregister = childToolRunUnregisters.get(childKey(record.deviceId, record.childRunId));
  toolUnregister?.();
  childToolRunUnregisters.delete(childKey(record.deviceId, record.childRunId));
  if (!persistDevice(record.deviceId)) {
    childRuns.set(childKey(record.deviceId, record.childRunId), record);
  }
}

export function resetSubagentLifecycleForTest(): void {
  for (const unregister of childToolRunUnregisters.values()) unregister();
  childToolRunUnregisters.clear();
  accounts.clear();
  activeParents.clear();
  childRuns.clear();
}
