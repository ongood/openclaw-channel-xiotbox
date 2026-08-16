import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDirectSender } from './direct-send.js';
import { registerActiveToolRun } from './tool-lifecycle.js';

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
  threadId?: string;
  agentId: string;
  parentRunId: string;
  traceId: string | null;
};

type ChildRun = {
  deviceId: string;
  bindingId: string;
  conversationId: string;
  parentAgentId: string;
  parentSessionKey?: string;
  childAgentId: string;
  parentRunId: string;
  childRunId: string;
  childSessionKey: string;
  threadId?: string;
  traceId: string | null;
  createdAt: number;
};

type SubagentStateFile = {
  version: 1;
  children: ChildRun[];
};

type AccountRegistration = {
  accountId: string;
  filePath: string;
  emit: (event: Record<string, unknown>) => void;
  logger?: any;
  stateReady: boolean;
};

type RegisterSubagentAccountOptions = {
  accountId?: string;
  deviceId: string;
  filePath?: string;
  emit: AccountRegistration['emit'];
  logger?: any;
};

type RegisterParentOptions = Omit<ParentRun, 'token'>;

const accounts = new Map<string, AccountRegistration>();
const activeParents = new Map<string, Map<symbol, ParentRun>>();
const childRuns = new Map<string, ChildRun>();
const childToolUnregisters = new Map<string, () => void>();
const pendingParentDeliveries = new Map<
  string,
  {
    deviceId: string;
    conversationId: string;
    threadId?: string;
    parentRunId: string;
    traceId: string | null;
  }
>();

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
    accountId: normalized(options.accountId) || 'default',
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
    threadId: parent.threadId,
    parentAgentId: parent.agentId,
    parentSessionKey: parent.sessionKey,
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
  // Register a tool run for the child session so that tool.call / tool.result
  // events are emitted to the Gateway with run_id=childRunId and parent_run_id.
  const toolUnregister = registerActiveToolRun({
    sessionKey: childSessionKey,
    agentId: childAgentId,
    emit: (kind, payload) => {
      emitChildEvent(record, kind, payload);
    },
  });
  childToolUnregisters.set(childKey(record.deviceId, childRunId), toolUnregister);
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

function logWake(message: string): void {
  try {
    console.error(`[xiotbox-subagent-wake] ${message}`);
  } catch {
    // ignore logging failures
  }
}

function extractAllAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as any;
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string' && message.content.trim()) {
      const text = message.content.trim();
      if (!isPlaceholderOnly(text)) parts.push(text);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
      .trim();
    if (text && !isPlaceholderOnly(text)) parts.push(text);
  }
  return parts.join('\n\n').trim();
}

// Requester-settle agent may produce a hollow "已推送" placeholder instead of
// the real summary. Filter it out so we don't send a useless notification.
const PLACEHOLDER_PATTERNS = [
  /^已推送/,
  /已完成汇总去重并主动发给你了/,
  /^Pushed\b/i,
  /^Delivered\b/i,
];

function isPlaceholderOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed));
}

export function handleSubagentParentAgentEnd(
  event: { runId?: string; messages?: unknown[]; success?: boolean },
  ctx: { runId?: string; sessionKey?: string },
): void {
  const runId = normalized(event?.runId || ctx?.runId);
  if (!runId.startsWith('announce:requester-settle:') || event?.success !== true) return;
  const sessionKey = normalized(ctx?.sessionKey);
  const pending = pendingParentDeliveries.get(sessionKey);
  if (!pending) return;
  const allText = extractAllAssistantText(Array.isArray(event?.messages) ? event.messages : []);
  // Skip placeholder-only responses so we don't send a hollow "已推送" message.
  if (!allText || allText === 'HEARTBEAT_OK' || isPlaceholderOnly(allText)) return;
  const account = accounts.get(pending.deviceId);
  const sender = getDirectSender(account?.accountId || 'default');
  const result = sender?.({
    text: allText,
    commandId: pending.parentRunId,
    threadId: pending.threadId,
    traceId: pending.traceId,
  });
  if (result?.delivered) {
    pendingParentDeliveries.delete(sessionKey);
    logWake(`settled parent result delivered session=${sessionKey}`);
  } else {
    logWake(`settled parent result delivery failed session=${sessionKey} error=${result?.error || 'sender unavailable'}`);
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
  if (!record) return;
  const emitted = emitChildEvent(record, 'subagent.completed', {
    child_session_key: record.childSessionKey,
    status: normalized(event?.outcome) || 'unknown',
    ended_at: Number.isFinite(Number(event?.endedAt)) ? Number(event?.endedAt) : undefined,
  });
  if (!emitted) return;
  // Unregister child tool run so the session map is cleaned up.
  const toolUnregister = childToolUnregisters.get(childKey(record.deviceId, record.childRunId));
  if (toolUnregister) {
    toolUnregister();
    childToolUnregisters.delete(childKey(record.deviceId, record.childRunId));
  }
  childRuns.delete(childKey(record.deviceId, record.childRunId));
  const parentSessionKey = requesterSessionKey || normalized(record.parentSessionKey);
  const hasPendingSibling = [...childRuns.values()].some(
    (candidate) =>
      candidate.deviceId === record.deviceId && candidate.parentRunId === record.parentRunId,
  );
  if (parentSessionKey && !hasPendingSibling) {
    pendingParentDeliveries.set(parentSessionKey, {
      deviceId: record.deviceId,
      conversationId: record.conversationId,
      threadId: record.threadId,
      parentRunId: record.parentRunId,
      traceId: record.traceId,
    });
  }
  if (!persistDevice(record.deviceId)) {
    childRuns.set(childKey(record.deviceId, record.childRunId), record);
  }
}

export function resetSubagentLifecycleForTest(): void {
  accounts.clear();
  activeParents.clear();
  childRuns.clear();
  childToolUnregisters.clear();
  pendingParentDeliveries.clear();
}
