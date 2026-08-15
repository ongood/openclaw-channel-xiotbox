type ToolHookEvent = {
  toolName?: string;
  runId?: string;
  toolCallId?: string;
  error?: string;
  durationMs?: number;
  params?: Record<string, unknown>;
  result?: unknown;
};

type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
};

type ActiveToolRun = {
  token: symbol;
  agentId: string;
  runtimeRunId: string;
  emit: (kind: string, payload: Record<string, unknown>, occurrenceId: string) => void;
};

type RegisterActiveToolRunOptions = {
  sessionKey: string;
  agentId: string;
  emit: ActiveToolRun['emit'];
};

const activeRuns = new Map<string, Map<symbol, ActiveToolRun>>();

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

const SENSITIVE_KEY_RE =
  /secret|token|api[_-]?key|passw(?:or)?d|credential|authorization|auth\b|cookie|private[_-]?key|access[_-]?key|session[_-]?key/i;

const SENSITIVE_VALUE_RE =
  /sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[bporas]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{8,}|(?:secret|token|api[_-]?key|passw(?:or)?d|credential)\s*[=:]\s*\S+/i;

function normalized(value: unknown): string {
  return String(value || '').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}

function redactStringValue(value: string): string {
  return value.replace(SENSITIVE_VALUE_RE, '[redacted]');
}

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return truncate(redactStringValue(value), MAX_REDACT_STRING);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, MAX_REDACT_ARRAY_ITEMS)
      .map((item) => redact(item, depth + 1));
    if (value.length > MAX_REDACT_ARRAY_ITEMS) {
      items.push(`…${value.length - MAX_REDACT_ARRAY_ITEMS} more`);
    }
    return items;
  }
  if (typeof value === 'object') {
    if (depth >= MAX_REDACT_DEPTH) return '[…]';
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Redact then JSON-serialize for projection; undefined for empty/absent values. */
function projectText(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(redact(value), null, 2);
  } catch {
    text = String(value);
  }
  const trimmed = text.trim();
  if (!trimmed || trimmed === '{}' || trimmed === '[]' || trimmed === '""') {
    return undefined;
  }
  return truncate(text, maxChars);
}

/** Redacted first-line error summary; errors often carry secrets, so keep it short. */
function projectError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const redactedText = redactStringValue(String(error));
  const firstLine =
    redactedText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) || '';
  if (!firstLine) return undefined;
  return truncate(firstLine, MAX_ERROR_CHARS);
}

function resolveActiveRun(event: ToolHookEvent, ctx: ToolHookContext): ActiveToolRun | null {
  const sessionKey = normalized(ctx?.sessionKey);
  if (!sessionKey) return null;
  const sessionRuns = activeRuns.get(sessionKey);
  if (!sessionRuns?.size) return null;

  const agentId = normalized(ctx?.agentId);
  let candidates = [...sessionRuns.values()].filter((run) => !agentId || run.agentId === agentId);
  if (!candidates.length) return null;

  const runtimeRunId = normalized(ctx?.runId || event?.runId);
  if (runtimeRunId) {
    const exact = candidates.filter((run) => run.runtimeRunId === runtimeRunId);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    candidates = candidates.filter((run) => !run.runtimeRunId);
  }
  if (candidates.length !== 1) return null;
  if (runtimeRunId) candidates[0].runtimeRunId = runtimeRunId;
  return candidates[0];
}

function resolveToolCall(event: ToolHookEvent, ctx: ToolHookContext) {
  const activeRun = resolveActiveRun(event, ctx);
  const toolCallId = normalized(ctx?.toolCallId || event?.toolCallId);
  const toolName = normalized(event?.toolName || ctx?.toolName);
  if (!activeRun || !toolCallId || !toolName) return null;
  return { activeRun, toolCallId, toolName };
}

export function registerActiveToolRun(options: RegisterActiveToolRunOptions): () => void {
  const sessionKey = normalized(options.sessionKey);
  const agentId = normalized(options.agentId);
  if (!sessionKey || !agentId) return () => {};
  const token = Symbol('xiotbox-tool-run');
  const sessionRuns = activeRuns.get(sessionKey) || new Map<symbol, ActiveToolRun>();
  sessionRuns.set(token, { token, agentId, runtimeRunId: '', emit: options.emit });
  activeRuns.set(sessionKey, sessionRuns);
  return () => {
    const current = activeRuns.get(sessionKey);
    current?.delete(token);
    if (!current?.size) activeRuns.delete(sessionKey);
  };
}

export function handleBeforeToolCall(event: ToolHookEvent, ctx: ToolHookContext): void {
  const resolved = resolveToolCall(event, ctx);
  if (!resolved) return;
  const params = projectText(event?.params, MAX_PARAMS_CHARS);
  const payload: Record<string, unknown> = {
    tool_name: resolved.toolName,
    tool_call_id: resolved.toolCallId,
    runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
    status: 'running',
  };
  if (params !== undefined) payload.params = params;
  resolved.activeRun.emit('tool.call', payload, `tool:${resolved.toolCallId}:call`);
}

export function handleAfterToolCall(event: ToolHookEvent, ctx: ToolHookContext): void {
  const resolved = resolveToolCall(event, ctx);
  if (!resolved) return;
  const durationMs = Number(event?.durationMs);
  const failed = Boolean(normalized(event?.error));
  const result = failed ? undefined : projectText(event?.result, MAX_RESULT_CHARS);
  const error = failed ? projectError(event?.error) : undefined;
  const payload: Record<string, unknown> = {
    tool_name: resolved.toolName,
    tool_call_id: resolved.toolCallId,
    runtime_run_id: resolved.activeRun.runtimeRunId || undefined,
    status: failed ? 'failed' : 'completed',
    duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined,
  };
  if (result !== undefined) payload.result = result;
  if (error !== undefined) payload.error = error;
  resolved.activeRun.emit('tool.result', payload, `tool:${resolved.toolCallId}:result`);
}

export function resetActiveToolRunsForTest(): void {
  activeRuns.clear();
}
