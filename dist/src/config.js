import { getXiotboxRuntimeOrNull } from './runtime.js';
export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CACHE_MAX = 500;
export const DEFAULT_STREAM_THROTTLE_MS = 35;
export const DEFAULT_PROGRESS_THROTTLE_MS = 1500;
export const DEFAULT_PROGRESS_MAX_UPDATES = 12;
export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_AGENT_ID = 'main';
export const DEFAULT_THREAD_ID = 'main';
export const CHANNEL_ID = 'xiotbox';
export function normalizeAccountId(value) {
    const normalized = String(value || '').trim();
    return normalized || DEFAULT_ACCOUNT_ID;
}
export function normalizeStrList(value, fallback) {
    if (Array.isArray(value)) {
        const out = value.map((v) => String(v || '').trim()).filter(Boolean);
        return out.length ? out : fallback;
    }
    const raw = String(value || '').trim();
    if (!raw)
        return fallback;
    const parts = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    return parts.length ? parts : fallback;
}
export function normalizeThreadId(value) {
    const normalized = String(value || '').trim();
    return normalized || DEFAULT_THREAD_ID;
}
export function normalizeContextEpoch(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 0;
    const epoch = Math.floor(parsed);
    return epoch > 0 ? epoch : 0;
}
export function normalizeAgentId(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const safe = normalized
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 64);
    return safe || DEFAULT_AGENT_ID;
}
export function buildSessionKey(agentId, deviceId, threadId, contextEpoch = 0) {
    const base = `agent:${normalizeAgentId(agentId)}:xiotbox:${deviceId}:${normalizeThreadId(threadId)}`;
    return contextEpoch > 0 ? `${base}:ctx${contextEpoch}` : base;
}
export function normalizePositiveInt(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return undefined;
    const rounded = Math.floor(parsed);
    return rounded >= 0 ? rounded : undefined;
}
export function normalizeOptionalBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (value === 1)
            return true;
        if (value === 0)
            return false;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized))
            return true;
        if (['0', 'false', 'no', 'off'].includes(normalized))
            return false;
    }
    return undefined;
}
export function normalizeStringValue(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
export function getChannelConfig(cfg) {
    return cfg?.channels?.[CHANNEL_ID] || {};
}
export function buildConfig(channelCfg) {
    const progressThrottleMs = normalizePositiveInt(channelCfg.PROGRESS_THROTTLE_MS);
    const progressMaxUpdates = normalizePositiveInt(channelCfg.PROGRESS_MAX_UPDATES);
    const streamingEnabled = normalizeOptionalBoolean(channelCfg.STREAMING) ?? true;
    const blockStreamingEnabled = normalizeOptionalBoolean(channelCfg.BLOCK_STREAMING) ??
        normalizeOptionalBoolean(channelCfg.blockStreaming) ??
        streamingEnabled;
    return {
        GATEWAY_WSS_URL: channelCfg.GATEWAY_WSS_URL || 'ws://localhost:9002/ws/bot',
        DEVICE_ID: channelCfg.DEVICE_ID,
        DEVICE_TOKEN: channelCfg.DEVICE_TOKEN,
        USE_QUERY_AUTH: channelCfg.USE_QUERY_AUTH || false,
        OUTBOX_MAX: channelCfg.OUTBOX_MAX || 200,
        OUTBOX_TTL_MS: channelCfg.OUTBOX_TTL_MS || 5 * 60 * 1000,
        COMMAND_CACHE_TTL_MS: channelCfg.COMMAND_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS,
        COMMAND_CACHE_MAX: channelCfg.COMMAND_CACHE_MAX || DEFAULT_CACHE_MAX,
        STREAMING: streamingEnabled,
        BLOCK_STREAMING: blockStreamingEnabled,
        STREAM_THROTTLE_MS: channelCfg.STREAM_THROTTLE_MS || DEFAULT_STREAM_THROTTLE_MS,
        PROGRESS_UPDATES: channelCfg.PROGRESS_UPDATES !== false,
        PROGRESS_THROTTLE_MS: progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS,
        PROGRESS_MAX_UPDATES: progressMaxUpdates ?? DEFAULT_PROGRESS_MAX_UPDATES,
        API_BASE_URL: channelCfg.API_BASE_URL,
        E2E_KEY_PATH: channelCfg.E2E_KEY_PATH,
        E2E_ROTATE: channelCfg.E2E_ROTATE,
        IDENTITY_KEY_PATH: channelCfg.IDENTITY_KEY_PATH,
        TRUST_PATH: channelCfg.TRUST_PATH,
        ALLOW_NEW_CLIENT_IDENTITIES: channelCfg.ALLOW_NEW_CLIENT_IDENTITIES,
        SCOPES: normalizeStrList(channelCfg.SCOPES, ['chat']),
        CONTROL_ACTIONS: normalizeStrList(channelCfg.CONTROL_ACTIONS, []),
        HELLO_EXTRA: undefined,
    };
}
export function resolveAgentId(cfg) {
    const channelCfg = getChannelConfig(cfg);
    const configured = normalizeStringValue(channelCfg.SESSION_AGENT_ID) ||
        normalizeStringValue(channelCfg.AGENT_ID) ||
        normalizeStringValue(cfg?.agents?.defaults?.id) ||
        DEFAULT_AGENT_ID;
    return normalizeAgentId(configured);
}
export function readThreadAgentMapValue(map, threadId) {
    if (!map || typeof map !== 'object' || Array.isArray(map))
        return '';
    const normalizedThreadId = normalizeThreadId(threadId);
    const candidates = [
        normalizedThreadId,
        normalizedThreadId.toLowerCase(),
        threadId,
        '*',
        'default',
    ];
    for (const key of candidates) {
        const value = normalizeStringValue(map[key]);
        if (value)
            return value;
    }
    return '';
}
export function resolveThreadAgentId(cfg, threadId) {
    const channelCfg = getChannelConfig(cfg);
    const mapped = readThreadAgentMapValue(channelCfg.SESSION_AGENT_MAP, threadId) ||
        readThreadAgentMapValue(channelCfg.THREAD_AGENT_MAP, threadId) ||
        '';
    return normalizeAgentId(mapped || resolveAgentId(cfg));
}
export function listAccountIds(cfg) {
    const root = getChannelConfig(cfg);
    const rootDeviceId = root.DEVICE_ID;
    const rootDeviceToken = root.DEVICE_TOKEN;
    return rootDeviceId && rootDeviceToken ? [DEFAULT_ACCOUNT_ID] : [];
}
export function resolveDefaultAccountId(cfg) {
    const ids = listAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
        return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] || DEFAULT_ACCOUNT_ID;
}
export function resolveAccount(cfg, accountId) {
    const root = getChannelConfig(cfg);
    const resolvedAccountId = normalizeAccountId(accountId);
    return {
        accountId: resolvedAccountId,
        config: root,
        enabled: root.enabled !== false,
    };
}
export function resolveEffectiveConfig(ctx, startupCfg) {
    return ctx?.cfg ?? getXiotboxRuntimeOrNull()?.config?.loadConfig?.() ?? startupCfg;
}
