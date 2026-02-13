type ControlToolOptions = {
  getConfig?: () => any;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

type JsonRpcResult = {
  ok: boolean;
  result?: any;
  error?: string;
};

function getChannelConfig(cfg: any) {
  return cfg?.channels?.xiotbox || {};
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeInt(value: any, fallback: number, { min, max }: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuid() {
  // Not cryptographically strong; good enough for request ids / action ids.
  return `act_${Date.now()}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
}

function jsonResult(payload: any) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function jsonRpcCall(
  baseUrl: string,
  path: string,
  params: any,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonRpcResult> {
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch_not_available' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: params || {} }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (_err) {
      return { ok: false, error: `invalid_json_response:${resp.status}` };
    }
    if (!resp.ok) {
      return { ok: false, error: data?.error?.message || data?.error || `http_${resp.status}` };
    }
    if (data?.error) {
      return { ok: false, error: data.error?.message || JSON.stringify(data.error) };
    }
    return { ok: true, result: data?.result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function isObject(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(value: any): string {
  return String(value || '').trim();
}

function normalizePlan(value: any): Array<{ action: string; params: any; ttl_ms?: number; wait_timeout_ms?: number; action_id?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ action: string; params: any; ttl_ms?: number; wait_timeout_ms?: number; action_id?: string }> = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const action = normalizeAction((item as any).action);
    if (!action) continue;
    out.push({
      action,
      params: isObject((item as any).params) ? (item as any).params : {},
      ttl_ms: (item as any).ttl_ms,
      wait_timeout_ms: (item as any).wait_timeout_ms,
      action_id: String((item as any).action_id || '').trim() || undefined,
    });
  }
  return out;
}

export function createXiotboxControlTool(options: ControlToolOptions = {}) {
  const supportedActions = [
    'open_app',
    'tap',
    'type',
    'swipe',
    'long_press',
    'click_text',
    'get_screen',
    'get_tree',
    'wait_ui_change',
    'get_notifications',
    'get_app_info',
    'open_accessibility_settings',
  ] as const;

  const observeBeforeActions = new Set(['tap', 'swipe', 'long_press', 'click_text', 'type']);
  const waitAfterActions = new Set(['open_app', 'tap', 'swipe', 'long_press', 'click_text', 'type']);

  return {
    name: 'xiotbox_control',
    description:
      'Control a XiotBox phone remotely via XiotBox Gateway (WSS control). Enforces observe-before-operate: auto inserts get_tree/get_screen before UI-changing actions and wait_ui_change after them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: {
          type: 'string',
          description: 'Target XiotBox device_id (the phone running XiotBox Control agent).',
        },
        plan: {
          type: 'array',
          description:
            'Array of steps: {action, params}. Tool will auto-insert get_tree/get_screen + wait_ui_change around UI actions.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: [...supportedActions] },
              params: { type: 'object', additionalProperties: true },
              ttl_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
              wait_timeout_ms: { type: 'integer', minimum: 500, maximum: 60000 },
              action_id: { type: 'string', description: 'Optional override for idempotency testing / replay.' },
            },
            required: ['action'],
          },
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Overall tool timeout in milliseconds.',
        },
        api_base_url: {
          type: 'string',
          description: 'Optional override. Defaults to channels.xiotbox.API_BASE_URL.',
        },
        poll_ms: {
          type: 'integer',
          minimum: 200,
          maximum: 5000,
          description: 'Status polling interval (ms).',
        },
      },
      required: ['device_id', 'plan'],
    },
    async execute(_id: string, rawParams: any) {
      const params = isObject(rawParams) ? rawParams : {};
      const targetDeviceId = String(params.device_id || '').trim();
      if (!targetDeviceId) {
        return jsonResult({ ok: false, error: 'missing_device_id' });
      }

      const plan = normalizePlan(params.plan);
      if (!plan.length) {
        return jsonResult({ ok: false, error: 'empty_plan' });
      }

      const cfg = options.getConfig?.() || {};
      const channelCfg = getChannelConfig(cfg);
      const apiBaseUrl = String(params.api_base_url || channelCfg.API_BASE_URL || process.env.XIOTBOX_API_BASE || '')
        .trim()
        .replace(/\/+$/, '');
      if (!apiBaseUrl) {
        return jsonResult({ ok: false, error: 'missing_api_base_url', message: 'Configure channels.xiotbox.API_BASE_URL' });
      }

      const sourceDeviceId = String(channelCfg.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID || '').trim();
      const sourceToken = String(channelCfg.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN || '').trim();
      if (!sourceDeviceId || !sourceToken) {
        return jsonResult({
          ok: false,
          error: 'missing_device_credentials',
          message: 'Configure channels.xiotbox.DEVICE_ID / DEVICE_TOKEN for device-auth control dispatch.',
        });
      }

      const pollMs = normalizeInt(
        params.poll_ms || process.env.XIOTBOX_CONTROL_POLL_MS,
        600,
        { min: 200, max: 5000 },
      );
      const httpTimeoutMs = normalizeInt(
        process.env.XIOTBOX_CONTROL_HTTP_TIMEOUT_MS,
        10000,
        { min: 1000, max: 60000 },
      );
      const overallTimeoutMs = normalizeInt(
        params.timeout_ms || process.env.XIOTBOX_CONTROL_TIMEOUT_MS,
        120000,
        { min: 1000, max: 600000 },
      );
      const defaultTtlMs = normalizeInt(
        process.env.XIOTBOX_CONTROL_DEFAULT_TTL_MS,
        20000,
        { min: 1000, max: 300000 },
      );
      const defaultWaitTimeoutMs = normalizeInt(
        process.env.XIOTBOX_CONTROL_DEFAULT_WAIT_TIMEOUT_MS,
        5000,
        { min: 500, max: 60000 },
      );

      const headers = {
        Authorization: `Bearer ${sourceToken}`,
        'X-Device-Id': sourceDeviceId,
      };

      const sessionId = `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const startedAt = Date.now();
      const deadlineAt = startedAt + overallTimeoutMs;

      const stepsOut: any[] = [];

      const dispatchAndWait = async (action: string, actionParams: any, ttlMs: number, forcedActionId?: string) => {
        const actionId = String(forcedActionId || '').trim() || uuid();
        const dispatch = await jsonRpcCall(
          apiBaseUrl,
          '/openclaw/device/control/dispatch',
          {
            target_device_id: targetDeviceId,
            action,
            params: isObject(actionParams) ? actionParams : {},
            ttl_ms: ttlMs,
            need_result: true,
            action_id: actionId,
            session_id: sessionId,
          },
          headers,
          httpTimeoutMs,
        );
        if (!dispatch.ok) {
          return { ok: false, action_id: actionId, error: dispatch.error || 'dispatch_failed' };
        }
        const commandId = String(dispatch.result?.command_id || '').trim();
        if (!commandId) {
          return { ok: false, action_id: actionId, error: 'missing_command_id' };
        }

        const pollDeadline = Math.min(Date.now() + ttlMs + 5000, deadlineAt);
        while (Date.now() < pollDeadline) {
          const statusRes = await jsonRpcCall(
            apiBaseUrl,
            '/openclaw/device/control/status',
            { command_id: commandId },
            headers,
            httpTimeoutMs,
          );
          if (statusRes.ok) {
            const status = String(statusRes.result?.status || '').trim().toLowerCase();
            if (status === 'success') {
              return {
                ok: true,
                command_id: commandId,
                action_id: actionId,
                status,
                result: statusRes.result?.result,
                error_message: statusRes.result?.error_message || '',
              };
            }
            if (status === 'failed' || status === 'timeout') {
              return {
                ok: false,
                command_id: commandId,
                action_id: actionId,
                status,
                result: statusRes.result?.result,
                error_message: statusRes.result?.error_message || statusRes.result?.error_code || status,
              };
            }
          }
          await sleep(pollMs);
        }
        return { ok: false, command_id: commandId, action_id: actionId, status: 'timeout', error_message: 'TIMEOUT' };
      };

      const maybeObserveBefore = async () => {
        const ttl = defaultTtlMs;
        const tree = await dispatchAndWait('get_tree', { max_depth: 8 }, ttl);
        stepsOut.push({ injected: true, action: 'get_tree', ...tree });
        if (tree.ok) return;
        // get_screen is a semantic snapshot (not pixels). Use max_items to cap payload size.
        const screen = await dispatchAndWait('get_screen', { max_items: 350 }, ttl);
        stepsOut.push({ injected: true, action: 'get_screen', ...screen });
      };

      const maybeWaitAfter = async (waitTimeoutMs: number) => {
        const ttl = Math.max(defaultTtlMs, waitTimeoutMs + 2000);
        const res = await dispatchAndWait('wait_ui_change', { timeout_ms: waitTimeoutMs }, ttl);
        stepsOut.push({ injected: true, action: 'wait_ui_change', ...res });
      };

      for (const step of plan) {
        if (Date.now() >= deadlineAt) {
          stepsOut.push({ ok: false, error: 'overall_timeout' });
          break;
        }
        const action = normalizeAction(step.action);
        if (!supportedActions.includes(action as any)) {
          stepsOut.push({ ok: false, action, error: 'ACTION_NOT_SUPPORTED' });
          continue;
        }

        if (observeBeforeActions.has(action)) {
          await maybeObserveBefore();
        }

        const ttlMs = normalizeInt(step.ttl_ms, defaultTtlMs, { min: 1000, max: 300000 });
        const execRes = await dispatchAndWait(action, step.params, ttlMs, step.action_id);
        stepsOut.push({ injected: false, action, ...execRes, params: step.params });

        if (waitAfterActions.has(action)) {
          const waitTimeoutMs = normalizeInt(step.wait_timeout_ms, defaultWaitTimeoutMs, { min: 500, max: 60000 });
          await maybeWaitAfter(waitTimeoutMs);
        }
      }

      const ok = stepsOut.every((s) => s && s.ok !== false);
      const durationMs = Date.now() - startedAt;
      options.logger?.info?.(
        `[XiotBox] xiotbox_control session=${sessionId} target=${targetDeviceId} steps=${stepsOut.length} ok=${ok} durationMs=${durationMs}`,
      );

      return jsonResult({
        ok,
        session_id: sessionId,
        device_id: targetDeviceId,
        duration_ms: durationMs,
        steps: stepsOut,
      });
    },
  };
}
