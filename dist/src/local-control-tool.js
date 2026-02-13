function getChannelConfig(cfg) {
    return cfg?.channels?.xiotbox || {};
}
function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/, '');
}
function normalizeTimeoutMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 8000;
    return Math.min(Math.max(Math.floor(parsed), 1000), 60000);
}
function jsonResult(payload) {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}
function resolveToolConfig(options, params) {
    const cfg = options.getConfig?.() || {};
    const channelCfg = getChannelConfig(cfg);
    const baseUrl = String(params?.base_url ||
        channelCfg.LOCAL_CONTROL_BASE_URL ||
        'http://127.0.0.1:17777').trim() || 'http://127.0.0.1:17777';
    const token = String(params?.token || channelCfg.LOCAL_CONTROL_TOKEN || '').trim();
    const timeoutMs = normalizeTimeoutMs(params?.timeout_ms ||
        channelCfg.LOCAL_CONTROL_TIMEOUT_MS ||
        8000);
    return {
        baseUrl: normalizeBaseUrl(baseUrl),
        token,
        timeoutMs,
    };
}
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function createXiotboxLocalControlTool(options = {}) {
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
    ];
    return {
        name: 'xiotbox_local_control',
        description: 'Call XiotBox local control API on this device (localhost). Actions: open_app, tap, type, swipe, long_press, click_text, get_screen, get_tree, wait_ui_change, get_notifications, get_app_info, open_accessibility_settings.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: {
                    type: 'string',
                    enum: [...supportedActions],
                    description: 'Action name supported by XiotBox local control server.',
                },
                params: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Action parameters.',
                },
                base_url: {
                    type: 'string',
                    description: 'Optional override. Defaults to channels.xiotbox.LOCAL_CONTROL_BASE_URL.',
                },
                token: {
                    type: 'string',
                    description: 'Optional override. Defaults to channels.xiotbox.LOCAL_CONTROL_TOKEN.',
                },
                timeout_ms: {
                    type: 'integer',
                    minimum: 1000,
                    maximum: 60000,
                    description: 'HTTP timeout in milliseconds.',
                },
            },
            required: ['action'],
        },
        async execute(_id, rawParams) {
            const params = isObject(rawParams) ? rawParams : {};
            const action = String(params.action || '').trim();
            if (!action) {
                return jsonResult({
                    ok: false,
                    error: 'missing_action',
                    message: 'action is required',
                });
            }
            const { baseUrl, token, timeoutMs } = resolveToolConfig(options, params);
            if (!token) {
                return jsonResult({
                    ok: false,
                    error: 'missing_token',
                    message: 'LOCAL_CONTROL_TOKEN is empty; configure channels.xiotbox.LOCAL_CONTROL_TOKEN.',
                    base_url: baseUrl,
                });
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(`${baseUrl}/v1/action`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        action,
                        params: isObject(params.params) ? params.params : {},
                    }),
                    signal: controller.signal,
                });
                const bodyText = await response.text();
                let body = bodyText;
                try {
                    body = JSON.parse(bodyText);
                }
                catch (_err) {
                    // Keep raw text fallback.
                }
                return jsonResult({
                    ok: response.ok,
                    status: response.status,
                    base_url: baseUrl,
                    action,
                    result: body,
                });
            }
            catch (err) {
                const message = err?.message || String(err);
                options.logger?.warn?.(`[XiotBox] local control call failed: ${message}`);
                return jsonResult({
                    ok: false,
                    error: 'request_failed',
                    message,
                    base_url: baseUrl,
                    action,
                });
            }
            finally {
                clearTimeout(timeout);
            }
        },
    };
}
