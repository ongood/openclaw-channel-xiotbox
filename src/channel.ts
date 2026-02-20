import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WSSClient from '../wss_client.js';
import { getXiotboxRuntime } from './runtime.js';
import { OpenClawE2E } from './e2e.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_MAX = 500;
const DEFAULT_STREAM_THROTTLE_MS = 500;
const DEFAULT_PROGRESS_THROTTLE_MS = 1500;
const DEFAULT_PROGRESS_MAX_UPDATES = 12;
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_AGENT_ID = 'main';
const DEFAULT_THREAD_ID = 'main';
const CHANNEL_ID = 'xiotbox';
const SESSION_STORE_CACHE_TTL_MS = 3000;
const CONTEXT_EPOCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_EPOCH_CACHE_MAX = 2000;

type SessionUsageSnapshot = {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  totalTokensFresh?: boolean;
  updatedAt?: number;
};

type SessionStoreCache = {
  storePath: string;
  mtimeMs: number;
  loadedAt: number;
  store: Record<string, any>;
};

type ContextEpochCacheEntry = {
  epoch: number;
  updatedAt: number;
};

type InboundMediaEntry = {
  path?: string;
  url?: string;
  type?: string;
};

type InboundMediaContextFields = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

type ProgressSnapshot = {
  status?: string;
  stage?: string;
  detail?: string;
  progressPercent?: number;
};

let sessionStoreCache: SessionStoreCache | null = null;
const contextEpochCache = new Map<string, ContextEpochCacheEntry>();

function normalizeAccountId(value?: string | null): string {
  const normalized = String(value || '').trim();
  return normalized || DEFAULT_ACCOUNT_ID;
}

function normalizeStrList(value: any, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const out = value.map((v) => String(v || '').trim()).filter(Boolean);
    return out.length ? out : fallback;
  }
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : fallback;
}

function normalizeThreadId(value?: string | null): string {
  const normalized = String(value || '').trim();
  return normalized || DEFAULT_THREAD_ID;
}

function normalizeContextEpoch(value?: any): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const epoch = Math.floor(parsed);
  return epoch > 0 ? epoch : 0;
}

function buildSessionKey(deviceId: string, threadId: string, contextEpoch: number = 0): string {
  const base = `xiotbox:${deviceId}:${normalizeThreadId(threadId)}`;
  return contextEpoch > 0 ? `${base}:ctx${contextEpoch}` : base;
}

function hasOwn(obj: any, key: string): boolean {
  return Boolean(obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key));
}

function contextEpochScopeKey(deviceId: string, threadId: string): string {
  return `${deviceId}:${normalizeThreadId(threadId)}`;
}

function pruneContextEpochCache(): void {
  const now = Date.now();
  for (const [key, entry] of contextEpochCache.entries()) {
    if (now - entry.updatedAt > CONTEXT_EPOCH_CACHE_TTL_MS) {
      contextEpochCache.delete(key);
    }
  }
  if (contextEpochCache.size <= CONTEXT_EPOCH_CACHE_MAX) return;
  const overflow = contextEpochCache.size - CONTEXT_EPOCH_CACHE_MAX;
  const oldest = [...contextEpochCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (let i = 0; i < overflow; i += 1) {
    const candidate = oldest[i];
    if (!candidate) break;
    contextEpochCache.delete(candidate[0]);
  }
}

function resolveInboundContextEpoch(params: {
  incoming: any;
  deviceId: string;
  threadId: string;
  traceId?: string | null;
  messageId?: string | null;
  log?: any;
}): { epoch: number; source: 'explicit' | 'fallback' | 'default' } {
  const { incoming, deviceId, threadId, traceId, messageId, log } = params;
  const scopeKey = contextEpochScopeKey(deviceId, threadId);
  const explicitValue = incoming?.context_epoch ?? incoming?.contextEpoch;
  const hasExplicitContextEpoch = hasOwn(incoming, 'context_epoch') || hasOwn(incoming, 'contextEpoch');
  const now = Date.now();

  if (hasExplicitContextEpoch) {
    const epoch = normalizeContextEpoch(explicitValue);
    contextEpochCache.set(scopeKey, { epoch, updatedAt: now });
    pruneContextEpochCache();
    return { epoch, source: 'explicit' };
  }

  const cached = contextEpochCache.get(scopeKey);
  if (cached) {
    cached.updatedAt = now;
    contextEpochCache.set(scopeKey, cached);
    if (cached.epoch > 0) {
      log?.warn?.(JSON.stringify({
        event: 'context_epoch_missing_fallback',
        trace_id: traceId || '',
        message_id: messageId || '',
        device_id: deviceId,
        thread_id: normalizeThreadId(threadId),
        context_epoch: cached.epoch,
      }));
    }
    return { epoch: cached.epoch, source: 'fallback' };
  }

  return { epoch: 0, source: 'default' };
}

function normalizePositiveInt(value: any): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.floor(parsed);
  return rounded >= 0 ? rounded : undefined;
}

function normalizeOptionalBoolean(value: any): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function resolveHomeDir(): string {
  const explicit = String(process.env.OPENCLAW_HOME || '').trim();
  const fallback = String(process.env.HOME || os.homedir() || process.cwd()).trim() || process.cwd();
  if (!explicit) return path.resolve(fallback);
  if (explicit === '~') return path.resolve(fallback);
  if (explicit.startsWith('~/') || explicit.startsWith('~\\')) {
    return path.resolve(path.join(fallback, explicit.slice(2)));
  }
  return path.resolve(explicit);
}

function expandUserPath(rawPath: string, homeDir: string): string {
  const normalized = String(rawPath || '').trim();
  if (!normalized) return normalized;
  if (normalized === '~') return homeDir;
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return path.join(homeDir, normalized.slice(2));
  }
  return normalized;
}

function resolveSessionStorePath(cfg: any): string {
  const homeDir = resolveHomeDir();
  const rawStore = String(cfg?.session?.store || '').trim();
  if (rawStore) {
    const withAgent = rawStore.includes('{agentId}')
      ? rawStore.split('{agentId}').join(DEFAULT_AGENT_ID)
      : rawStore;
    return path.resolve(expandUserPath(withAgent, homeDir));
  }

  const stateOverride = String(
    process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || '',
  ).trim();
  const stateDir = stateOverride
    ? path.resolve(expandUserPath(stateOverride, homeDir))
    : path.resolve(path.join(homeDir, '.openclaw'));
  return path.resolve(stateDir, 'agents', DEFAULT_AGENT_ID, 'sessions', 'sessions.json');
}

function loadSessionStore(storePath: string): Record<string, any> {
  try {
    const stat = fs.statSync(storePath);
    const mtimeMs = stat.mtimeMs || 0;
    const now = Date.now();
    if (
      sessionStoreCache &&
      sessionStoreCache.storePath === storePath &&
      sessionStoreCache.mtimeMs === mtimeMs &&
      now - sessionStoreCache.loadedAt < SESSION_STORE_CACHE_TTL_MS
    ) {
      return sessionStoreCache.store;
    }

    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = raw ? JSON.parse(raw) : {};
    const store =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, any>)
        : {};
    sessionStoreCache = {
      storePath,
      mtimeMs,
      loadedAt: now,
      store,
    };
    return store;
  } catch {
    return {};
  }
}

function resolveSessionUsageSnapshot(cfg: any, sessionKey: string): SessionUsageSnapshot | null {
  const normalizedSessionKey = String(sessionKey || '').trim();
  if (!normalizedSessionKey) return null;
  const storePath = resolveSessionStorePath(cfg);
  const store = loadSessionStore(storePath);
  const entry =
    store[normalizedSessionKey] ||
    store[normalizedSessionKey.toLowerCase()] ||
    store[normalizedSessionKey.toUpperCase()] ||
    null;
  if (!entry || typeof entry !== 'object') return null;

  const inputTokens = normalizePositiveInt(entry.inputTokens);
  const outputTokens = normalizePositiveInt(entry.outputTokens);
  const explicitTotal = normalizePositiveInt(entry.totalTokens);
  const totalTokens =
    explicitTotal ?? ((inputTokens ?? 0) + (outputTokens ?? 0) > 0 ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  if (totalTokens == null) return null;

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    contextTokens: normalizePositiveInt(entry.contextTokens),
    totalTokensFresh: entry.totalTokensFresh === true,
    updatedAt: normalizePositiveInt(entry.updatedAt),
  };
}

function getChannelConfig(cfg: any) {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

function buildConfig(channelCfg: any) {
  const progressThrottleMs = normalizePositiveInt(channelCfg.PROGRESS_THROTTLE_MS);
  const progressMaxUpdates = normalizePositiveInt(channelCfg.PROGRESS_MAX_UPDATES);
  const streamingEnabled = normalizeOptionalBoolean(channelCfg.STREAMING) ?? false;
  const blockStreamingEnabled =
    normalizeOptionalBoolean(channelCfg.BLOCK_STREAMING) ??
    normalizeOptionalBoolean(channelCfg.blockStreaming) ??
    streamingEnabled;
  return {
    GATEWAY_WSS_URL: channelCfg.GATEWAY_WSS_URL || 'ws://localhost:9002/ws/openclaw',
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
    // Default to chat only. Control scope should be explicitly enabled on the device that
    // *executes* control actions (e.g. XiotBox Android Control Agent), not on the host OpenClaw.
    SCOPES: normalizeStrList(channelCfg.SCOPES, ['chat']),
    CONTROL_ACTIONS: normalizeStrList(channelCfg.CONTROL_ACTIONS, []),
    HELLO_EXTRA: undefined as any,
  };
}

/**
 * Robust text extraction:
 * - supports common fields (markdown/text/body/output_text/etc.)
 * - supports arrays: parts/content/messages
 * - supports nested objects recursively (safe depth + cycle guard)
 * - supports streaming/delta-like fields
 */
function normalizeTextPayload(payload: any): string {
  if (typeof payload === 'string') return payload;
  if (!payload) return '';

  const acc: string[] = [];
  const visited = new WeakSet<object>();
  const MAX_DEPTH = 6;

  const pushText = (v: any) => {
    if (!v) return;
    if (typeof v === 'string') {
      const s = v.trimEnd();
      if (s) acc.push(s);
      return;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      acc.push(String(v));
      return;
    }
    // objects handled by walk
  };

  const walk = (obj: any, depth: number) => {
    if (!obj || depth > MAX_DEPTH) return;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      pushText(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const it of obj) walk(it, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;

    if (visited.has(obj)) return;
    visited.add(obj);

    // 1) direct/common fields
    const directKeys = [
      'markdown',
      'text',
      'body',
      'content_text',
      'output_text',
      'outputText',
      'message',
      'message_text',
      'reply',
      'answer',
      'final',
      'final_text',
    ];
    for (const k of directKeys) {
      if (obj[k] !== undefined) {
        const v = obj[k];
        // sometimes message is nested object; allow recursion
        if (typeof v === 'object' && v) {
          walk(v, depth + 1);
        } else {
          pushText(v);
        }
      }
    }

    // 2) parts/content arrays
    if (Array.isArray(obj.parts)) walk(obj.parts, depth + 1);
    if (Array.isArray(obj.content)) walk(obj.content, depth + 1);

    // 3) common nested containers
    if (obj.content && typeof obj.content === 'object') walk(obj.content, depth + 1);
    if (obj.part && typeof obj.part === 'object') walk(obj.part, depth + 1);

    // 4) streaming/delta-ish
    // many providers use delta/content_delta/choices[].delta etc.
    if (obj.delta !== undefined) walk(obj.delta, depth + 1);
    if (obj.content_delta !== undefined) walk(obj.content_delta, depth + 1);
    if (Array.isArray(obj.choices)) walk(obj.choices, depth + 1);
    if (obj.choice && typeof obj.choice === 'object') walk(obj.choice, depth + 1);

    // 5) if this object looks like a "typed segment", try common patterns
    // e.g. {type:'text', text:'...'} or {type:'output_text', text:{value:'...'}}
    if (obj.type && (obj.text !== undefined || obj.value !== undefined || obj.content !== undefined)) {
      walk(obj.text, depth + 1);
      walk(obj.value, depth + 1);
      // obj.content already handled above
    }

    // 6) last resort: try a few known subkeys that often carry text
    const fallbackKeys = ['value', 'raw', 'display', 'caption', 'title'];
    for (const k of fallbackKeys) {
      if (obj[k] !== undefined) {
        const v = obj[k];
        if (typeof v === 'object' && v) walk(v, depth + 1);
        else pushText(v);
      }
    }
  };

  walk(payload, 0);

  // Join with newline to avoid "sticking" blocks together.
  return acc
    .map((s) => String(s))
    .filter((s) => s.trim().length > 0)
    .join('\n')
    .trim();
}

function shouldSkipReply(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (trimmed === 'NO_REPLY') return true;
  if (trimmed.endsWith('NO_REPLY')) return true;
  return false;
}

function normalizeStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringField(record: any, keys: string[]): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of keys) {
    const value = normalizeStringValue(record?.[key]);
    if (value) return value;
  }
  return undefined;
}

function toUnknownArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeMediaEntry(entry: InboundMediaEntry | null | undefined): InboundMediaEntry | undefined {
  if (!entry) return undefined;
  const path = normalizeStringValue(entry.path);
  const url = normalizeStringValue(entry.url);
  const type = normalizeStringValue(entry.type);
  const normalizedPath = path || url;
  const normalizedUrl = url || path;
  if (!normalizedPath && !normalizedUrl) return undefined;
  return {
    path: normalizedPath,
    url: normalizedUrl,
    type,
  };
}

const MEDIA_PAYLOAD_KEYS = [
  'attachments',
  'files',
  'media',
  'media_items',
  'mediaItems',
  'attachment',
  'file',
  'image',
  'voice',
  'audio',
  'media_paths',
  'mediaPaths',
  'media_urls',
  'mediaUrls',
  'media_types',
  'mediaTypes',
  'media_path',
  'mediaPath',
  'media_url',
  'mediaUrl',
  'media_type',
  'mediaType',
];

function hasUsableMediaValue(value: any): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function hasMediaPayloadFields(container: any): boolean {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return false;
  for (const key of MEDIA_PAYLOAD_KEYS) {
    if (!hasOwn(container, key)) continue;
    if (hasUsableMediaValue(container[key])) return true;
  }
  return false;
}

function resolveMediaCarrier(incoming: any): any {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  if (hasMediaPayloadFields(incoming)) return incoming;
  const nested = incoming?.content;
  if (hasMediaPayloadFields(nested)) return nested;
  return incoming;
}

function hasInlineMediaMarker(item: any): boolean {
  return (
    hasOwn(item, 'file_name') ||
    hasOwn(item, 'fileName') ||
    hasOwn(item, 'name') ||
    hasOwn(item, 'mime_type') ||
    hasOwn(item, 'mimeType') ||
    hasOwn(item, 'content_type') ||
    hasOwn(item, 'contentType') ||
    hasOwn(item, 'media_type') ||
    hasOwn(item, 'mediaType') ||
    hasOwn(item, 'size_bytes') ||
    hasOwn(item, 'sizeBytes')
  );
}

function extensionFromMime(mimeType?: string): string {
  const mime = normalizeStringValue(mimeType)?.toLowerCase() || '';
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'application/pdf':
      return '.pdf';
    case 'text/plain':
      return '.txt';
    case 'text/markdown':
      return '.md';
    case 'text/x-python':
      return '.py';
    case 'application/json':
      return '.json';
    case 'audio/m4a':
      return '.m4a';
    case 'audio/wav':
      return '.wav';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/ogg':
      return '.ogg';
    default:
      return '';
  }
}

function readInlineMediaB64(item: any): string | undefined {
  const strict = readStringField(item, [
    'data_b64',
    'dataB64',
    'bytes_b64',
    'bytesB64',
    'file_b64',
    'fileB64',
  ]);
  const raw = strict || (() => {
    const generic = readStringField(item, ['base64', 'b64']);
    if (!generic) return undefined;
    return hasInlineMediaMarker(item) ? generic : undefined;
  })();
  if (!raw) return undefined;
  const dataUrlPrefix = /^data:[^;]+;base64,/i;
  if (dataUrlPrefix.test(raw)) {
    return raw.replace(dataUrlPrefix, '');
  }
  return raw;
}

function stageInlineMediaItem(item: any, params: { log?: any; traceId?: string | null; messageId?: string | null }): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const inlineB64 = readInlineMediaB64(item);
  if (!inlineB64) return false;
  try {
    const bytes = Buffer.from(inlineB64, 'base64');
    if (!bytes.length) return false;

    const fileName = readStringField(item, ['file_name', 'fileName', 'name']) || 'media.bin';
    const extFromName = path.extname(fileName);
    const mimeType = readStringField(item, ['mime_type', 'mimeType', 'content_type', 'contentType', 'media_type', 'mediaType']) || '';
    const ext = extFromName || extensionFromMime(mimeType) || '.bin';
    const stagedPath = path.join(
      os.tmpdir(),
      `xiotbox-inline-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`,
    );
    fs.writeFileSync(stagedPath, bytes);

    item.path = stagedPath;
    item.url = stagedPath;
    item.size_bytes = bytes.length;
    if (!item.mime_type && !item.mimeType && mimeType) {
      item.mime_type = mimeType;
    }
    return true;
  } catch (err: any) {
    params.log?.warn?.(JSON.stringify({
      event: 'inline_media_stage_failed',
      trace_id: params.traceId || '',
      message_id: params.messageId || '',
      error: err?.message || String(err),
    }));
    return false;
  }
}

export function stageInlineMediaPayload(incoming: any, params: { log?: any; traceId?: string | null; messageId?: string | null }): number {
  if (!incoming || typeof incoming !== 'object') return 0;
  const carrier = resolveMediaCarrier(incoming);
  if (!carrier || typeof carrier !== 'object') return 0;
  let stagedCount = 0;
  const collectionTargets = [
    carrier?.attachments,
    carrier?.files,
    carrier?.media,
    carrier?.media_items,
    carrier?.mediaItems,
  ];
  for (const target of collectionTargets) {
    for (const item of toUnknownArray(target)) {
      if (stageInlineMediaItem(item, params)) {
        stagedCount += 1;
      }
    }
  }

  const singularTargets = [
    carrier?.attachment,
    carrier?.file,
    carrier?.image,
    carrier?.voice,
    carrier?.audio,
  ];
  for (const target of singularTargets) {
    if (stageInlineMediaItem(target, params)) {
      stagedCount += 1;
    }
  }
  return stagedCount;
}

function parseMediaValue(item: any): InboundMediaEntry | undefined {
  if (item == null) return undefined;
  if (typeof item === 'string') {
    return normalizeMediaEntry({ path: item, url: item });
  }
  if (typeof item !== 'object' || Array.isArray(item)) return undefined;

  const path =
    readStringField(item, [
      'path',
      'local_path',
      'localPath',
      'file_path',
      'filePath',
      'media_path',
      'mediaPath',
      'absolute_path',
      'absolutePath',
      'staged_path',
      'stagedPath',
    ]) || readStringField(item, ['src', 'uri', 'href']);
  const url = readStringField(item, [
    'url',
    'media_url',
    'mediaUrl',
    'download_url',
    'downloadUrl',
    'file_url',
    'fileUrl',
    'remote_url',
    'remoteUrl',
  ]);
  const type = readStringField(item, [
    'mime_type',
    'mimeType',
    'content_type',
    'contentType',
    'media_type',
    'mediaType',
    'type',
  ]);

  return normalizeMediaEntry({ path, url, type });
}

function collectExplicitMediaEntries(incoming: any): InboundMediaEntry[] {
  const carrier = resolveMediaCarrier(incoming);
  const paths = toUnknownArray(carrier?.media_paths ?? carrier?.mediaPaths).map((value) =>
    normalizeStringValue(value),
  );
  const urls = toUnknownArray(carrier?.media_urls ?? carrier?.mediaUrls).map((value) =>
    normalizeStringValue(value),
  );
  const types = toUnknownArray(carrier?.media_types ?? carrier?.mediaTypes).map((value) =>
    normalizeStringValue(value),
  );

  const entries: InboundMediaEntry[] = [];
  const count = Math.max(paths.length, urls.length, types.length);
  for (let index = 0; index < count; index += 1) {
    const entry = normalizeMediaEntry({
      path: paths[index],
      url: urls[index],
      type: types[index],
    });
    if (entry) entries.push(entry);
  }

  const single = normalizeMediaEntry({
    path: readStringField(carrier, ['media_path', 'mediaPath']),
    url: readStringField(carrier, ['media_url', 'mediaUrl']),
    type: readStringField(carrier, ['media_type', 'mediaType']),
  });
  if (single) entries.push(single);

  return entries;
}

function collectStructuredMediaEntries(incoming: any): InboundMediaEntry[] {
  const carrier = resolveMediaCarrier(incoming);
  const collected: InboundMediaEntry[] = [];
  const fromLists = [
    carrier?.attachments,
    carrier?.files,
    carrier?.media,
    carrier?.media_items,
    carrier?.mediaItems,
  ];
  for (const list of fromLists) {
    for (const item of toUnknownArray(list)) {
      const entry = parseMediaValue(item);
      if (entry) collected.push(entry);
    }
  }

  const singular = [
    carrier?.attachment,
    carrier?.file,
    carrier?.image,
    carrier?.voice,
    carrier?.audio,
  ];
  for (const item of singular) {
    const entry = parseMediaValue(item);
    if (entry) collected.push(entry);
  }

  return collected;
}

function mergeMediaEntries(entries: InboundMediaEntry[]): InboundMediaEntry[] {
  const merged: InboundMediaEntry[] = [];
  const indexByKey = new Map<string, number>();

  for (const rawEntry of entries) {
    const entry = normalizeMediaEntry(rawEntry);
    if (!entry) continue;
    const key = `${entry.path || ''}|${entry.url || ''}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, merged.length);
      merged.push(entry);
      continue;
    }
    if (!merged[existingIndex]?.type && entry.type) {
      merged[existingIndex].type = entry.type;
    }
  }

  return merged;
}

export function buildInboundMediaContext(incoming: any): InboundMediaContextFields {
  const entries = mergeMediaEntries([
    ...collectExplicitMediaEntries(incoming),
    ...collectStructuredMediaEntries(incoming),
  ]);
  if (!entries.length) return {};

  const mediaPaths = entries.map((entry) => entry.path || '').filter(Boolean);
  if (!mediaPaths.length) return {};
  const mediaUrls = entries.map((entry) => entry.url || entry.path || '').filter(Boolean);
  const mediaTypes = entries.map((entry) => entry.type || '');

  const result: InboundMediaContextFields = {
    MediaPath: mediaPaths[0],
    MediaUrl: mediaUrls[0] || mediaPaths[0],
    MediaPaths: mediaPaths,
    MediaUrls: mediaUrls.length === mediaPaths.length ? mediaUrls : mediaPaths,
  };
  if (mediaTypes.some(Boolean)) {
    result.MediaTypes = mediaTypes;
    if (mediaTypes[0]) {
      result.MediaType = mediaTypes[0];
    }
  }
  return result;
}

function cloneConfig<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (typeof (globalThis as any).structuredClone === 'function') {
    return (globalThis as any).structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildTextOnlyConfig(cfg: any): any {
  const cloned = cloneConfig(cfg);
  if (!cloned || typeof cloned !== 'object') return cfg;
  const tools = cloned.tools && typeof cloned.tools === 'object' ? { ...cloned.tools } : {};
  tools.allow = undefined;
  tools.alsoAllow = undefined;
  tools.deny = ['*'];
  cloned.tools = tools;
  return cloned;
}

// ── Hard-exit patterns: user explicitly wants to leave tool/control mode ──
const HARD_EXIT_PATTERNS = [
  /^\/stop\b/i,
  /^\/exit\b/i,
  /^\/quit\b/i,
  /^\/chat\b/i,
  /^\/text\b/i,
  /退出控制/,
  /结束控制/,
  /停止操控/,
  /结束操控/,
  /停止控制/,
  /退出操控/,
  /退出操作/,
  /结束操作/,
  /切回聊天/,
  /恢复聊天/,
  /只聊天/,
  /仅聊天/,
  /stop\s*control/i,
  /exit\s*control/i,
  /back\s*to\s*chat/i,
];

function isHardExitCommand(text: string): boolean {
  const trimmed = (text || '').trim();
  return HARD_EXIT_PATTERNS.some((re) => re.test(trimmed));
}

// ── Consecutive tool-only counter (keyed by thread+sender) ──
const MAX_CONSECUTIVE_TOOL_ONLY = 3;
const TOOL_ONLY_COUNTER_TTL_MS = 10 * 60 * 1000; // 10 min
const FORCE_EXIT_TTL_MS = 10 * 60 * 1000; // 10 min

interface ToolOnlyEntry {
  count: number;
  updatedAt: number;
  fingerprint: string;
}

const toolOnlyCounters = new Map<string, ToolOnlyEntry>();
const forceExitCounters = new Map<string, number>();

function toolOnlyCounterKey(
  deviceId: string,
  threadId: string,
  senderId: string,
): string {
  return `${deviceId}:${normalizeThreadId(threadId)}:${senderId}`;
}

function forceExitKey(deviceId: string, threadId: string): string {
  return `${deviceId}:${normalizeThreadId(threadId)}`;
}

function isLikelyNonSubstantiveAck(text: string): boolean {
  const normalized = (text || '').trim();
  if (!normalized) return true;
  const compact = normalized
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。.!！?？,，;；:]/g, '');
  const exactAcks = new Set([
    '操作已完成',
    '操作完成',
    '已完成',
    '完成',
    'done',
    'ok',
    'okay',
    'success',
    'completed',
    '任务已完成',
    '处理完成',
  ]);
  if (exactAcks.has(compact)) return true;
  if (compact.length <= 12 && (compact.includes('操作已完成') || compact.includes('任务已完成'))) {
    return true;
  }
  return false;
}

function buildToolOnlyFingerprint(params: {
  branch: 'tool_only' | 'no_reply' | 'ack_only' | 'empty';
  text: string;
  toolNames: string[];
  sawControlToolSignal: boolean;
  sawInProgressSignal: boolean;
}): string {
  const compactText = (params.text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。.!！?？,，;；:]/g, '')
    .slice(0, 64);
  const uniqTools = Array.from(
    new Set(
      params.toolNames
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
  return [
    `b=${params.branch}`,
    `t=${compactText || '-'}`,
    `tools=${uniqTools.join(',') || '-'}`,
    `ctrl=${params.sawControlToolSignal ? '1' : '0'}`,
    `prog=${params.sawInProgressSignal ? '1' : '0'}`,
  ].join('|');
}

function incrementToolOnlyCounter(key: string, fingerprint: string): number {
  const now = Date.now();
  const existing = toolOnlyCounters.get(key);
  if (existing && now - existing.updatedAt < TOOL_ONLY_COUNTER_TTL_MS) {
    if (existing.fingerprint === fingerprint) {
      existing.count += 1;
    } else {
      existing.count = 1;
      existing.fingerprint = fingerprint;
    }
    existing.updatedAt = now;
    return existing.count;
  }
  toolOnlyCounters.set(key, { count: 1, updatedAt: now, fingerprint });
  return 1;
}

function resetToolOnlyCounter(key: string): void {
  toolOnlyCounters.delete(key);
}

function pruneToolOnlyCounters(): void {
  const now = Date.now();
  for (const [k, v] of toolOnlyCounters.entries()) {
    if (now - v.updatedAt > TOOL_ONLY_COUNTER_TTL_MS) {
      toolOnlyCounters.delete(k);
    }
  }
}

function scheduleForceExit(key: string): void {
  forceExitCounters.set(key, Date.now() + FORCE_EXIT_TTL_MS);
}

function consumeForceExit(key: string): boolean {
  const until = forceExitCounters.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    forceExitCounters.delete(key);
    return false;
  }
  forceExitCounters.delete(key);
  return true;
}

function pruneForceExitCounters(): void {
  const now = Date.now();
  for (const [k, until] of forceExitCounters.entries()) {
    if (now > until) {
      forceExitCounters.delete(k);
    }
  }
}

function isConfiguredCfg(cfg: any): boolean {
  return listAccountIds(cfg).length > 0;
}

function listAccountIds(cfg: any): string[] {
  const root = getChannelConfig(cfg);
  const rootDeviceId = root.DEVICE_ID;
  const rootDeviceToken = root.DEVICE_TOKEN;
  return rootDeviceId && rootDeviceToken ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveDefaultAccountId(cfg: any): string {
  const ids = listAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] || DEFAULT_ACCOUNT_ID;
}

function resolveAccount(cfg: any, accountId?: string) {
  const root = getChannelConfig(cfg);
  const resolvedAccountId = normalizeAccountId(accountId);
  return {
    accountId: resolvedAccountId,
    config: root,
    enabled: root.enabled !== false,
  };
}

function detectToolSignals(outPayload: any): boolean {
  if (!outPayload || typeof outPayload !== 'object') return false;
  return Boolean(
    outPayload.tool_calls ||
      outPayload.toolCalls ||
      outPayload.tool_call ||
      outPayload.function_call ||
      outPayload.functionCall ||
      outPayload.action ||
      outPayload.actions ||
      outPayload.observation ||
      outPayload.observations ||
      outPayload.tool_result ||
      outPayload.toolResult,
  );
}

function extractToolSignalNames(outPayload: any): string[] {
  if (!outPayload || typeof outPayload !== 'object') return [];
  const names: string[] = [];
  const tc = outPayload.tool_calls || outPayload.toolCalls;
  if (Array.isArray(tc)) {
    for (const t of tc) {
      const name = t?.name || t?.tool || t?.tool_name || t?.function?.name;
      if (name) names.push(String(name));
    }
  }
  const fc = outPayload.function_call || outPayload.functionCall;
  if (fc?.name) names.push(String(fc.name));
  const act = outPayload.action;
  if (typeof act === 'string') names.push(act);
  return Array.from(new Set(names.map((s) => String(s || '').trim()).filter(Boolean)));
}

function isLikelyControlToolName(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('xiotbox_control') ||
    normalized === 'control' ||
    normalized.endsWith('_control') ||
    normalized.includes('device_control') ||
    normalized.includes('android_control') ||
    normalized.includes('ios_control') ||
    normalized.includes('adb_control')
  );
}

const IN_PROGRESS_HINTS = [
  'running',
  'in_progress',
  'inprogress',
  'pending',
  'processing',
  'working',
  'executing',
  'queued',
  '进行中',
  '处理中',
  '执行中',
  '等待中',
];

function isLikelyInProgressText(text: string): boolean {
  const compact = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!compact) return false;
  return IN_PROGRESS_HINTS.some((hint) => compact.includes(hint));
}

function hasInProgressSignal(outPayload: any): boolean {
  if (!outPayload || typeof outPayload !== 'object') return false;
  const visited = new Set<any>();
  const stack: any[] = [outPayload];
  let depth = 0;
  while (stack.length && depth < 200) {
    depth += 1;
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const [rawKey, value] of Object.entries(current)) {
      const key = String(rawKey || '').toLowerCase();
      if (typeof value === 'string') {
        const checkable =
          key === 'status' ||
          key === 'state' ||
          key === 'phase' ||
          key === 'stage' ||
          key.endsWith('_status') ||
          key.endsWith('_state') ||
          key.includes('progress');
        if (checkable && isLikelyInProgressText(value)) {
          return true;
        }
      } else if (typeof value === 'number') {
        if (key.includes('progress') && value >= 0 && value < 100) {
          return true;
        }
      } else if (Array.isArray(value)) {
        for (const item of value) stack.push(item);
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return false;
}

function compactProgressText(value: any, maxLen: number = 80): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, Math.max(0, maxLen - 1))}…` : text;
}

function normalizeProgressPercent(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0 && value <= 1) return Math.round(value * 100);
    if (value >= 0 && value <= 100) return Math.round(value);
    return undefined;
  }

  if (typeof value === 'string') {
    const compact = value.trim();
    if (!compact) return undefined;
    const percentMatch = compact.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      const parsed = Number(percentMatch[1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
        return Math.round(parsed);
      }
      return undefined;
    }
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) {
      if (parsed >= 0 && parsed <= 1 && compact.includes('.')) {
        return Math.round(parsed * 100);
      }
      if (parsed >= 0 && parsed <= 100) {
        return Math.round(parsed);
      }
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    const current = normalizePositiveInt(
      (value as any).current ??
      (value as any).done ??
      (value as any).completed ??
      (value as any).step ??
      (value as any).processed,
    );
    const total = normalizePositiveInt(
      (value as any).total ??
      (value as any).max ??
      (value as any).steps ??
      (value as any).count,
    );
    if (current != null && total != null && total > 0) {
      const ratio = (current / total) * 100;
      const bounded = Math.max(0, Math.min(100, Math.round(ratio)));
      return bounded;
    }
  }
  return undefined;
}

function extractProgressSnapshot(outPayload: any): ProgressSnapshot | null {
  if (!outPayload || typeof outPayload !== 'object') return null;

  const snapshot: ProgressSnapshot = {};
  const visited = new Set<any>();
  const stack: any[] = [outPayload];
  let depth = 0;

  while (stack.length && depth < 250) {
    depth += 1;
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const [rawKey, value] of Object.entries(current)) {
      const key = String(rawKey || '').toLowerCase();
      const keyHasProgressHint =
        key.includes('progress') || key.includes('percent') || key.includes('pct');
      const keyIsStatus =
        key === 'status' ||
        key === 'state' ||
        key === 'phase' ||
        key.endsWith('_status') ||
        key.endsWith('_state');
      const keyIsStage =
        key === 'stage' ||
        key === 'step' ||
        key === 'task' ||
        key.endsWith('_stage') ||
        key.endsWith('_step');
      const keyIsDetail =
        key === 'detail' ||
        key === 'message' ||
        key === 'summary' ||
        key === 'title' ||
        key === 'reason' ||
        key.endsWith('_detail');

      if (snapshot.progressPercent == null && (keyHasProgressHint || key === 'current' || key === 'total')) {
        const percent = normalizeProgressPercent(value);
        if (percent != null) {
          snapshot.progressPercent = percent;
        }
      }

      if (typeof value === 'string') {
        const compact = compactProgressText(value);
        if (!compact) continue;

        if (!snapshot.status && (keyIsStatus || (keyHasProgressHint && isLikelyInProgressText(compact)))) {
          snapshot.status = compact;
          continue;
        }

        if (!snapshot.stage && keyIsStage) {
          snapshot.stage = compact;
          continue;
        }

        if (!snapshot.detail && keyIsDetail && compact.length <= 80) {
          snapshot.detail = compact;
          continue;
        }

        if (!snapshot.status && isLikelyInProgressText(compact) && compact.length <= 80) {
          snapshot.status = compact;
        }
      } else if (Array.isArray(value)) {
        for (const item of value) stack.push(item);
      } else if (value && typeof value === 'object') {
        if (snapshot.progressPercent == null && (key === 'progress' || keyHasProgressHint)) {
          const percent = normalizeProgressPercent(value);
          if (percent != null) {
            snapshot.progressPercent = percent;
          }
        }
        stack.push(value);
      }
    }
  }

  if (
    snapshot.status == null &&
    snapshot.stage == null &&
    snapshot.detail == null &&
    snapshot.progressPercent == null
  ) {
    return null;
  }

  return snapshot;
}

function buildProgressRunningText(params: {
  toolNames: string[];
  snapshot: ProgressSnapshot | null;
  fallbackText?: string;
}): string {
  const uniqTools = Array.from(
    new Set(
      (params.toolNames || [])
        .map((name) => compactProgressText(name, 48))
        .filter(Boolean),
    ),
  );
  const snapshot = params.snapshot;
  const segments: string[] = [];

  if (snapshot?.stage) segments.push(snapshot.stage);
  if (snapshot?.status) segments.push(snapshot.status);
  if (snapshot?.progressPercent != null) segments.push(`${snapshot.progressPercent}%`);
  if (!segments.length && snapshot?.detail) segments.push(snapshot.detail);
  if (!segments.length && uniqTools.length) segments.push(uniqTools.join(', '));

  const fallbackText = compactProgressText(params.fallbackText, 80);
  if (!segments.length && fallbackText && isLikelyInProgressText(fallbackText)) {
    segments.push(fallbackText);
  }

  if (!segments.length) return '正在执行，请稍候…';
  return `正在执行：${segments.join(' · ')}`;
}

function buildProgressFingerprint(params: {
  kind: string;
  toolNames: string[];
  snapshot: ProgressSnapshot | null;
  fallbackText?: string;
}): string {
  const uniqTools = Array.from(
    new Set(
      (params.toolNames || [])
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
  const snapshot = params.snapshot;
  return [
    `k=${String(params.kind || '').trim() || '-'}`,
    `tools=${uniqTools.join(',') || '-'}`,
    `status=${(snapshot?.status || '').toLowerCase().trim() || '-'}`,
    `stage=${(snapshot?.stage || '').toLowerCase().trim() || '-'}`,
    `detail=${(snapshot?.detail || '').toLowerCase().trim() || '-'}`,
    `progress=${snapshot?.progressPercent ?? '-'}`,
    `text=${compactProgressText(params.fallbackText, 48).toLowerCase() || '-'}`,
  ].join('|');
}

function summarizeToolSignals(outPayload: any): string {
  const uniq = extractToolSignalNames(outPayload);
  if (!uniq.length) return '';
  return `tool=${uniq.join(',')}`;
}

export const xiotboxPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'XiotBox',
    selectionLabel: 'XiotBox Gateway',
    blurb: 'Connects XiotBox devices and dispatches messages to OpenClaw runtime.',
    order: 100,
  },
  capabilities: {
    chatTypes: ['direct'],
    reactions: false,
    threads: true,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
    outbound: false,
  },
  reload: { configPrefixes: ['channels.xiotbox'] },
  config: {
    listAccountIds: (cfg: any): string[] => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => resolveAccount(cfg, accountId),
    defaultAccountId: (cfg: any) => resolveDefaultAccountId(cfg),
    isConfigured: (account: any) =>
      Boolean(account?.config?.DEVICE_ID && account?.config?.DEVICE_TOKEN),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.config?.name || 'XiotBox',
      enabled: account.enabled,
      configured: Boolean(account.config?.DEVICE_ID && account.config?.DEVICE_TOKEN),
    }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, log } = ctx;
      const accountId = DEFAULT_ACCOUNT_ID;
      const finalCfg = buildConfig(getChannelConfig(cfg));

      if (!finalCfg.DEVICE_ID || !finalCfg.DEVICE_TOKEN) {
        const err = `Missing XiotBox configuration (DEVICE_ID or DEVICE_TOKEN) for account "${accountId}".`;
        log?.error?.(`[XiotBox][${accountId}] ${err}`);
        throw new Error(err);
      }

      const client = new WSSClient(finalCfg);
      const runtime = getXiotboxRuntime();
      const dispatchReply = runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;

      if (!dispatchReply) {
        const err = 'dispatchReplyWithBufferedBlockDispatcher not available in runtime.';
        log?.error?.(`[XiotBox] ${err}`);
        throw new Error(err);
      }

      const commandCache = new Map<string, any>();
      const e2e = new OpenClawE2E(finalCfg, log);
      e2e.init();
      try {
        await e2e.refreshPeerKey();
      } catch (err: any) {
        log?.warn?.(`[XiotBox] E2E peer key not ready: ${err?.message || err}`);
      }

      finalCfg.HELLO_EXTRA = {
        e2e: e2e.helloPayload(),
        thread_id: normalizeThreadId(e2e.threadId),
      };
      // Ensure the very first HELLO after connect carries E2E identity claim.
      // WSSClient captures HELLO_EXTRA during construction; update it explicitly.
      client.setHelloExtra(finalCfg.HELLO_EXTRA);

      const pruneCache = () => {
        const now = Date.now();
        for (const [id, entry] of commandCache.entries()) {
          if (now - entry.ts > finalCfg.COMMAND_CACHE_TTL_MS) {
            commandCache.delete(id);
          }
        }
        while (commandCache.size > finalCfg.COMMAND_CACHE_MAX) {
          const firstKey = commandCache.keys().next().value;
          commandCache.delete(firstKey);
        }
      };

      const getCached = (cmdId: string) => {
        pruneCache();
        return commandCache.get(cmdId)?.payload || null;
      };

      const setCached = (cmdId: string, payload: any) => {
        pruneCache();
        commandCache.set(cmdId, { ts: Date.now(), payload });
      };

      client.on('COMMAND', async (payload: any) => {
        try {
          const cmdId = payload?.command_id;
          if (!cmdId) return;

          const cached = getCached(cmdId);
          if (cached) {
            client.sendMessage('COMMAND_RESULT', cached);
            return;
          }

          const traceId = payload?.trace_id || payload?.payload?.trace_id || null;

          // ACK
          client.sendMessage('COMMAND_RESULT', {
            command_id: cmdId,
            status: 'acked',
            trace_id: traceId,
            result: {},
          });

          const incoming = payload?.payload || payload || {};

          // Always refresh client peer key before handling a command.
          // This avoids encrypting reply with stale key after mobile/desktop key rotation.
          const cachedPeerPublicKey = e2e.peerPublicKey || '';
          const cachedPeerKeyId = e2e.peerKeyId || '';
          try {
            await e2e.refreshPeerKey();
          } catch (err: any) {
            const refreshErr = err?.message || 'e2e_peer_refresh_failed';
            // Preserve service continuity for existing sessions:
            // if a previously trusted key exists, keep using it for this command.
            if (cachedPeerPublicKey) {
              e2e.peerPublicKey = cachedPeerPublicKey;
              e2e.peerKeyId = cachedPeerKeyId;
              e2e.peerTrustError = refreshErr;
              log?.warn?.(`[XiotBox] E2E peer key refresh failed, fallback to cached key: ${refreshErr}`);
            } else {
              e2e.peerPublicKey = '';
              e2e.peerKeyId = '';
              e2e.peerTrustError = refreshErr;
            }
          }

          const env = (incoming?.magic === 'OGE2E1' ? incoming : incoming?.e2e) || null;
          if (!env || env.magic !== 'OGE2E1') {
            const failPayload = {
              command_id: cmdId,
              status: 'failed',
              trace_id: traceId,
              error: 'e2e_required',
              result: {},
            };
            client.sendMessage('COMMAND_RESULT', failPayload);
            setCached(cmdId, failPayload);
            return;
          }

          const contentType = incoming?.content_type || incoming?.contentType || 'text/markdown';
          const threadId = normalizeThreadId(incoming?.thread_id || e2e.threadId);
          const contextEpochResolution = resolveInboundContextEpoch({
            incoming,
            deviceId: finalCfg.DEVICE_ID,
            threadId,
            traceId,
            messageId: cmdId,
            log,
          });
          const contextEpoch = contextEpochResolution.epoch;
          let text = '';
          try {
            text = e2e.decryptText(env, {
              direction: 'c2p',
              device_id: finalCfg.DEVICE_ID,
              thread_id: threadId,
              command_id: cmdId,
              content_type: contentType,
              chunk_seq: 0,
              enc_v: e2e.encV,
            });
          } catch (_err: any) {
            const failPayload = {
              command_id: cmdId,
              status: 'failed',
              trace_id: traceId,
              error: 'e2e_decrypt_failed',
              result: {},
            };
            client.sendMessage('COMMAND_RESULT', failPayload);
            setCached(cmdId, failPayload);
            return;
          }

          const replyPeers = e2e.collectReplyPeers(incoming);
          if (!replyPeers.length) {
            const failPayload = {
              command_id: cmdId,
              status: 'failed',
              trace_id: traceId,
              error: e2e.peerTrustError || 'e2e_peer_missing',
              result: {},
            };
            client.sendMessage('COMMAND_RESULT', failPayload);
            setCached(cmdId, failPayload);
            return;
          }

          const buildEncryptedResult = (
            replyText: string,
            seq: number,
            sessionUsage?: SessionUsageSnapshot | null,
            streamMeta?: {
              thinking?: string;
              progress?: string;
              lane?: string;
            },
          ) => {
            const e2eMulti: Record<string, any> = {};
            let primaryEnv: any = null;
            let primaryKeyId = '';
            for (const peer of replyPeers) {
              const envOut = e2e.encryptText(
                replyText,
                {
                  direction: 'p2c',
                  device_id: finalCfg.DEVICE_ID,
                  thread_id: threadId,
                  command_id: cmdId,
                  content_type: contentType,
                  chunk_seq: seq,
                  enc_v: e2e.encV,
                },
                {
                  publicKey: peer.publicKey,
                  keyId: peer.keyId,
                },
              );
              const envKeyId = peer.keyId || envOut?.key_id || '';
              if (!primaryEnv) {
                primaryEnv = envOut;
                primaryKeyId = envKeyId;
              }
              e2eMulti[envKeyId || `peer_${Object.keys(e2eMulti).length}`] = envOut;
            }
            const result: Record<string, any> = {
              e2e: primaryEnv,
              e2e_multi: e2eMulti,
              result_key_id: primaryKeyId,
              enc_v: e2e.encV,
              content_type: contentType,
              chunk_seq: seq,
            };
            if (streamMeta) {
              const metadata: Record<string, any> = {};
              if (typeof streamMeta.lane === 'string' && streamMeta.lane.trim()) {
                metadata.stream_lane = streamMeta.lane.trim();
              }
              if (typeof streamMeta.thinking === 'string' && streamMeta.thinking.trim()) {
                metadata.stream_thinking = streamMeta.thinking;
              }
              if (typeof streamMeta.progress === 'string' && streamMeta.progress.trim()) {
                metadata.stream_progress = streamMeta.progress;
              }
              if (Object.keys(metadata).length) {
                result.metadata = metadata;
              }
            }
            if (sessionUsage) {
              result.session_usage = {
                total_tokens: sessionUsage.totalTokens,
                input_tokens: sessionUsage.inputTokens,
                output_tokens: sessionUsage.outputTokens,
                context_tokens: sessionUsage.contextTokens,
                total_tokens_fresh: sessionUsage.totalTokensFresh,
                updated_at: sessionUsage.updatedAt,
              };
              result.session_total_tokens = sessionUsage.totalTokens;
            }
            return result;
          };

          const sessionKey = buildSessionKey(finalCfg.DEVICE_ID, threadId, contextEpoch);
          const senderId = payload?.from || 'xiotbox';
          const counterKey = toolOnlyCounterKey(
            finalCfg.DEVICE_ID,
            threadId,
            senderId,
          );
          const forceExitKeyValue = forceExitKey(finalCfg.DEVICE_ID, threadId);
          const fullConfig = runtime?.config?.loadConfig?.() ?? cfg;

          log?.debug?.(JSON.stringify({
            event: 'session_scope',
            trace_id: traceId || '',
            message_id: cmdId,
            device_id: finalCfg.DEVICE_ID,
            thread_id: threadId,
            context_epoch: contextEpoch,
            context_epoch_source: contextEpochResolution.source,
            session_key: sessionKey,
          }));

          // Periodic cleanup of stale counters
          pruneToolOnlyCounters();
          pruneForceExitCounters();

          // ── Auto-exit carry-over: enforce exit mode on next user message ──
          const shouldForceExit = consumeForceExit(forceExitKeyValue);
          if (shouldForceExit) {
            resetToolOnlyCounter(counterKey);
            log?.info?.(JSON.stringify({
              event: 'auto_exit_control_mode',
              trace_id: traceId,
              thread_id: threadId,
              message_id: cmdId,
              sender_id: senderId,
            }));
            text = `用户请求退出操控模式，请停止调用任何工具，仅用文字回复。用户消息：${text}`;
          }

          // ── Hard-exit: user explicitly wants to leave tool/control mode ──
          const hardExitRequested = !shouldForceExit && isHardExitCommand(text);
          if (hardExitRequested) {
            resetToolOnlyCounter(counterKey);
            scheduleForceExit(forceExitKeyValue);
            log?.info?.(JSON.stringify({
              event: 'hard_exit_command',
              trace_id: traceId,
              thread_id: threadId,
              message_id: cmdId,
              sender_id: senderId,
              input_text: text.slice(0, 80),
            }));
            // Hard-exit should be deterministic: do not rely on model/tool path for this turn.
            const hardExitChunkSeq = 1;
            const successPayload = {
              command_id: cmdId,
              status: 'success',
              trace_id: traceId,
              result: buildEncryptedResult(
                '已退出控制模式，已切回聊天模式。接下来仅进行文字对话；如需再次操控，请重新描述要执行的操作。',
                hardExitChunkSeq,
                resolveSessionUsageSnapshot(fullConfig, sessionKey),
              ),
            };
            client.sendMessage('COMMAND_RESULT', successPayload);
            setCached(cmdId, successPayload);
            return;
          }
          const forceTextOnly = shouldForceExit || hardExitRequested;
          const stagedInlineMediaCount = stageInlineMediaPayload(incoming, {
            log,
            traceId,
            messageId: cmdId,
          });
          if (stagedInlineMediaCount > 0) {
            log?.info?.(JSON.stringify({
              event: 'inline_media_staged',
              trace_id: traceId || '',
              message_id: cmdId,
              staged_count: stagedInlineMediaCount,
            }));
          }
          const inboundMediaCtx = buildInboundMediaContext(incoming);
          if (inboundMediaCtx.MediaPaths?.length) {
            log?.debug?.(JSON.stringify({
              event: 'inbound_media_mapped',
              trace_id: traceId || '',
              message_id: cmdId,
              media_count: inboundMediaCtx.MediaPaths.length,
              media_types: inboundMediaCtx.MediaTypes || [],
            }));
          }

          const inboundCtx = {
            Body: text,
            RawBody: text,
            CommandBody: text,
            From: senderId,
            To: finalCfg.DEVICE_ID,
            SessionKey: sessionKey,
            AccountId: accountId,
            MessageSid: cmdId,
            TraceId: traceId,
            ChatType: 'direct',
            ConversationLabel: `${finalCfg.DEVICE_ID}:${threadId}`,
            SenderId: senderId,
            CommandAuthorized: true,
            Provider: 'xiotbox',
            Surface: 'xiotbox',
            OriginatingChannel: 'xiotbox',
            OriginatingTo: finalCfg.DEVICE_ID,
            ...inboundMediaCtx,
            DeliveryContext: {
              channel: 'xiotbox',
              to: finalCfg.DEVICE_ID,
              threadId,
              contextEpoch,
            },
          };

          // OpenClaw dispatcher returns metadata and delivers actual reply payloads
          // asynchronously via `deliver(payload, { kind })`.
          let lastText = '';
          let finalText = '';
          const blockParts: string[] = [];
          let lastStreamAt = 0;
          let lastStreamText = '';
          let runningSnapshotText = '';
          let thinkingSnapshotText = '';
          let progressSnapshotText = '';
          let chunkSeq = 0;
          let lastProgressAt = 0;
          let progressUpdateCount = 0;
          let lastProgressFingerprint = '';
          let dispatchMeta: { queuedFinal?: boolean; counts?: Record<string, number> } | null = null;
          const skipEvents: Array<{ kind: string; reason: string }> = [];

          const mergeRunningSnapshot = (existingText: string, incomingText: string): string => {
            const oldText = String(existingText || '');
            const newText = String(incomingText || '');
            if (!newText) return oldText;
            if (!oldText) return newText;
            if (newText === oldText) return oldText;
            if (newText.startsWith(oldText)) return newText;
            if (oldText.startsWith(newText)) return oldText;

            const maxOverlap = Math.min(oldText.length, newText.length);
            for (let i = maxOverlap; i >= 1; i -= 1) {
              if (oldText.slice(oldText.length - i) === newText.slice(0, i)) {
                return oldText + newText.slice(i);
              }
            }
            return oldText + newText;
          };

          const emitRunningUpdate = (
            runningText: string,
            fingerprint: string,
            opts?: { force?: boolean },
          ) => {
            if (!finalCfg.PROGRESS_UPDATES) return;
            const textPayload = compactProgressText(runningText, 180);
            if (!textPayload) return;

            const now = Date.now();
            const isForce = opts?.force === true;
            if (!isForce) {
              if (progressUpdateCount >= finalCfg.PROGRESS_MAX_UPDATES) return;
              if (fingerprint && fingerprint === lastProgressFingerprint) return;
              if (now - lastProgressAt < finalCfg.PROGRESS_THROTTLE_MS) return;
            }

            progressUpdateCount += 1;
            lastProgressAt = now;
            if (fingerprint) lastProgressFingerprint = fingerprint;
            progressSnapshotText = textPayload;

            chunkSeq += 1;
            const stableText = runningSnapshotText || lastStreamText || '';
            client.sendMessage('COMMAND_RESULT', {
              command_id: cmdId,
              status: 'running',
              trace_id: traceId,
              result: buildEncryptedResult(stableText, chunkSeq, null, {
                progress: progressSnapshotText,
                thinking: thinkingSnapshotText,
                lane: 'progress',
              }),
            });
          };

          // Signals to avoid "empty success"
          let sawAnyDeliver = false;
          let sawToolLikeDeliver = false;
          let sawNonTextDeliver = false;
          let sawControlToolSignal = false;
          let sawInProgressSignal = false;
          const toolNamesSeen: string[] = [];
          // Prefer block streaming from runtime reply hooks when available.
          // Fallback runtimes still stream from `deliver(kind=block)`.
          let streamBlocksViaReplyOptions = false;

          const deliver = async (outPayload: any, info?: any) => {
            const kind = info?.kind || 'block';
            sawAnyDeliver = true;

            const hasTool = detectToolSignals(outPayload);
            if (hasTool) {
              sawToolLikeDeliver = true;
              // Collect tool names for summary
              const toolNames = extractToolSignalNames(outPayload);
              if (toolNames.length) {
                toolNamesSeen.push(...toolNames);
                if (toolNames.some((name) => isLikelyControlToolName(name))) {
                  sawControlToolSignal = true;
                }
              }
            }
            const payloadInProgressSignal = hasInProgressSignal(outPayload);
            if (payloadInProgressSignal) {
              sawInProgressSignal = true;
            }

            const replyText = normalizeTextPayload(outPayload);
            const replyLooksInProgress = Boolean(replyText && isLikelyInProgressText(replyText));
            if (replyLooksInProgress) {
              sawInProgressSignal = true;
            }
            const progressSnapshot = extractProgressSnapshot(outPayload);
            const shouldEmitProgressUpdate =
              kind !== 'final' &&
              (hasTool || payloadInProgressSignal || progressSnapshot != null || replyLooksInProgress) &&
              (!replyText || replyLooksInProgress);
            if (shouldEmitProgressUpdate) {
              emitRunningUpdate(
                buildProgressRunningText({
                  toolNames: toolNamesSeen,
                  snapshot: progressSnapshot,
                  fallbackText: replyText,
                }),
                buildProgressFingerprint({
                  kind,
                  toolNames: toolNamesSeen,
                  snapshot: progressSnapshot,
                  fallbackText: replyText,
                }),
              );
            }

            const keysPresent =
              outPayload && typeof outPayload === 'object'
                ? Object.keys(outPayload).sort()
                : [String(typeof outPayload)];

            log?.debug?.(JSON.stringify({
              event: 'deliver',
              trace_id: traceId || '',
              message_id: cmdId,
              kind,
              text_len: replyText.length,
              has_tool: hasTool,
              keys: keysPresent,
              tool_names: summarizeToolSignals(outPayload),
              control_tool_signal: sawControlToolSignal,
              in_progress_signal: sawInProgressSignal,
            }));

            if (!replyText) {
              sawNonTextDeliver = true;
              // Internal event / tool call / observation with no human text.
              // Do not emit as chat bubble.
              return;
            }

            lastText = replyText;
            if (kind === 'block') {
              if (!finalCfg.STREAMING || !streamBlocksViaReplyOptions) {
                blockParts.push(replyText);
              }
            } else if (kind === 'final') {
              finalText = replyText;
            }

            if (!finalCfg.STREAMING) return;

            // Only stream block replies to avoid leaking tool payloads to the chat UI.
            if (kind !== 'block') return;
            // When runtime onBlockReply is active, avoid duplicate running chunks.
            if (streamBlocksViaReplyOptions) return;

            const blockSnapshotText = mergeRunningSnapshot(
              runningSnapshotText,
              blockParts.join('\n'),
            );
            runningSnapshotText = blockSnapshotText;

            const now = Date.now();
            if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS) return;
            if (blockSnapshotText === lastStreamText) return;
            lastStreamAt = now;
            lastStreamText = blockSnapshotText;

            chunkSeq += 1;
            client.sendMessage('COMMAND_RESULT', {
              command_id: cmdId,
              status: 'running',
              trace_id: traceId,
              result: buildEncryptedResult(blockSnapshotText, chunkSeq, null, {
                thinking: thinkingSnapshotText,
                progress: progressSnapshotText,
                lane: 'text',
              }),
            });
          };

          const effectiveConfig = forceTextOnly ? buildTextOnlyConfig(fullConfig) : fullConfig;

          emitRunningUpdate('已接收指令，正在执行…', 'phase:accepted', { force: true });

          // Prefer deterministic dispatch path that waits for all queued deliveries before finalizing.
          const replyApi = runtime?.channel?.reply;
          const createDispatcher = replyApi?.createReplyDispatcherWithTyping;
          const finalizeCtx = replyApi?.finalizeInboundContext;
          const dispatchFromConfig = replyApi?.dispatchReplyFromConfig;

          if (createDispatcher && finalizeCtx && dispatchFromConfig) {
            streamBlocksViaReplyOptions = true;
            const { dispatcher, replyOptions, markDispatchIdle } = createDispatcher({
              deliver,
              onSkip: (_payload: any, info: any) => {
                skipEvents.push({
                  kind: String(info?.kind || 'unknown'),
                  reason: String(info?.reason || 'unknown'),
                });
              },
              onError: (err: any, info: any) => {
                log?.warn?.(
                  `[XiotBox] OpenClaw deliver error kind=${info?.kind || 'unknown'} err=${err?.message || err}`,
                );
              },
            });

            const runtimeReplyOptions = {
              ...replyOptions,
              disableBlockStreaming:
                typeof finalCfg.BLOCK_STREAMING === 'boolean'
                  ? !finalCfg.BLOCK_STREAMING
                  : undefined,
              onBlockReply: (payload: any) => {
                if (!finalCfg.STREAMING) return;
                const blockText =
                  typeof payload === 'string'
                    ? payload
                    : payload?.text || normalizeTextPayload(payload);
                if (!blockText) return;
                blockParts.push(blockText);
                const blockSnapshotText = mergeRunningSnapshot(
                  runningSnapshotText,
                  blockParts.join('\n'),
                );
                runningSnapshotText = blockSnapshotText;
                const now = Date.now();
                if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS) return;
                if (blockSnapshotText === lastStreamText) return;
                lastStreamAt = now;
                lastStreamText = blockSnapshotText;
                chunkSeq += 1;
                client.sendMessage('COMMAND_RESULT', {
                  command_id: cmdId,
                  status: 'running',
                  trace_id: traceId,
                  result: buildEncryptedResult(blockSnapshotText, chunkSeq, null, {
                    thinking: thinkingSnapshotText,
                    progress: progressSnapshotText,
                    lane: 'text',
                  }),
                });
              },
              onReasoningStream: (payload: any) => {
                if (!finalCfg.STREAMING) return;
                const reasoningText =
                  typeof payload === 'string'
                    ? payload
                    : payload?.text || payload?.thinking || normalizeTextPayload(payload);
                if (!reasoningText) return;
                thinkingSnapshotText = mergeRunningSnapshot(
                  thinkingSnapshotText,
                  reasoningText,
                );
                const now = Date.now();
                if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS) return;
                lastStreamAt = now;
                chunkSeq += 1;
                const stableText = runningSnapshotText || lastStreamText || '';
                client.sendMessage('COMMAND_RESULT', {
                  command_id: cmdId,
                  status: 'running',
                  trace_id: traceId,
                  result: buildEncryptedResult(stableText, chunkSeq, null, {
                    thinking: thinkingSnapshotText,
                    progress: progressSnapshotText,
                    lane: 'thinking',
                  }),
                });
              },
              onPartialReply: (payload: any) => {
                if (!finalCfg.STREAMING) return;
                const partialText = normalizeTextPayload(payload);
                if (!partialText) return;
                const partialSnapshotText = mergeRunningSnapshot(
                  runningSnapshotText,
                  partialText,
                );
                runningSnapshotText = partialSnapshotText;
                const now = Date.now();
                if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS) return;
                if (partialSnapshotText === lastStreamText) return;
                lastStreamAt = now;
                lastStreamText = partialSnapshotText;
                chunkSeq += 1;
                client.sendMessage('COMMAND_RESULT', {
                  command_id: cmdId,
                  status: 'running',
                  trace_id: traceId,
                  result: buildEncryptedResult(partialSnapshotText, chunkSeq, null, {
                    thinking: thinkingSnapshotText,
                    progress: progressSnapshotText,
                    lane: 'text',
                  }),
                });
              },
            };

            const finalized = finalizeCtx(inboundCtx);
            dispatchMeta = await dispatchFromConfig({
              ctx: finalized,
              cfg: effectiveConfig,
              dispatcher,
              replyResolver: null,
              replyOptions: runtimeReplyOptions,
            });

            await dispatcher.waitForIdle();
            markDispatchIdle();
          } else {
            // Fallback for older runtimes.
            const { queuedFinal, counts } = await dispatchReply({
              ctx: inboundCtx,
              cfg: effectiveConfig,
              replyResolver: null,
              dispatcherOptions: {
                deliver,
              },
            });
            dispatchMeta = { queuedFinal, counts };
            // Let queued microtasks flush `deliver()` at least once before we finalize.
            await Promise.resolve();
          }

          // Prefer finalText, then blocks (joined with newline), then lastText
          const blocksText = blockParts.join('\n');
          let resolvedFinalText = (finalText || blocksText || lastText || '').trim();

          // Determine if this reply is tool-only (no human text produced)
          const toolOnlyLikely = sawToolLikeDeliver || sawNonTextDeliver;
          const isToolOnlyReply = !resolvedFinalText && toolOnlyLikely;
          const isNoReply = resolvedFinalText ? shouldSkipReply(resolvedFinalText) : false;
          const isAckOnlyReply = resolvedFinalText
            ? isLikelyNonSubstantiveAck(resolvedFinalText)
            : false;
          const needsFallback = isToolOnlyReply || isNoReply || !resolvedFinalText || isAckOnlyReply;
          const shouldCountFallback = needsFallback && !sawInProgressSignal;
          const fallbackBranch: 'tool_only' | 'no_reply' | 'ack_only' | 'empty' = isToolOnlyReply
            ? 'tool_only'
            : isNoReply
              ? 'no_reply'
              : isAckOnlyReply
                ? 'ack_only'
                : 'empty';

          // ── Structured log helper ──
          const structuredLog = (level: 'debug' | 'info' | 'warn', event: string, extra?: Record<string, any>) => {
            const entry = {
              event,
              trace_id: traceId || '',
              thread_id: threadId || '',
              context_epoch: contextEpoch,
              session_key: sessionKey,
              message_id: cmdId,
              branch: needsFallback ? fallbackBranch : 'normal',
              should_count_fallback: shouldCountFallback,
              saw_control_tool_signal: sawControlToolSignal,
              saw_in_progress_signal: sawInProgressSignal,
              resolved_text_len: resolvedFinalText.length,
              tool_names: toolNamesSeen.slice(),
              ...extra,
            };
            log?.[level]?.(JSON.stringify(entry));
          };

          // Build a dynamic summary when only tool calls were executed (no human text).
          const buildToolSummary = (opts?: { inProgress?: boolean }): string => {
            const uniq = Array.from(new Set(toolNamesSeen.map(s => s.trim()).filter(Boolean)));
            if (opts?.inProgress) {
              if (uniq.length) {
                return `（正在执行: ${uniq.join(', ')}）`;
              }
              return '（正在执行操作，请稍候）';
            }
            if (uniq.length) {
              return `（已执行: ${uniq.join(', ')}）`;
            }
            return '（操作已完成）';
          };

          if (!resolvedFinalText) {
            // If OpenClaw queued something but we got no text, treat as failure (bug/merge issue).
            const queuedFinal = Boolean(dispatchMeta?.queuedFinal || (dispatchMeta?.counts?.final || 0) > 0);

            if (queuedFinal && !toolOnlyLikely) {
              const failPayload = {
                command_id: cmdId,
                status: 'failed',
                trace_id: traceId,
                error: 'empty_reply_from_openclaw',
                result: {},
              };
              structuredLog('warn', 'empty_reply_queued_final', {
                dispatch_meta: dispatchMeta,
                skip_events: skipEvents,
                saw_any_deliver: sawAnyDeliver,
              });
              client.sendMessage('COMMAND_RESULT', failPayload);
              setCached(cmdId, failPayload);
              return;
            }

            resolvedFinalText = buildToolSummary({
              inProgress: sawInProgressSignal,
            });
            structuredLog('info', 'tool_only_summary', {
              dispatch_meta: dispatchMeta,
              saw_any_deliver: sawAnyDeliver,
            });
          }

          // If explicitly asked for NO_REPLY semantics, still avoid empty bubble.
          if (shouldSkipReply(resolvedFinalText)) {
            resolvedFinalText = buildToolSummary({
              inProgress: sawInProgressSignal,
            });
            structuredLog('info', 'no_reply_to_summary');
          }

          // Ack-like final text is low-information for end users.
          // If tools were actually executed, show a concise tool summary instead.
          if (
            resolvedFinalText &&
            isLikelyNonSubstantiveAck(resolvedFinalText) &&
            toolNamesSeen.length > 0
          ) {
            resolvedFinalText = buildToolSummary();
            structuredLog('info', 'ack_only_to_tool_summary');
          }

          // ── Consecutive tool-only counter: auto-fallback after MAX_CONSECUTIVE_TOOL_ONLY ──
          if (shouldCountFallback) {
            const fallbackFingerprint = buildToolOnlyFingerprint({
              branch: fallbackBranch,
              text: resolvedFinalText,
              toolNames: toolNamesSeen,
              sawControlToolSignal,
              sawInProgressSignal,
            });
            const consecutiveCount = incrementToolOnlyCounter(counterKey, fallbackFingerprint);
            if (consecutiveCount >= MAX_CONSECUTIVE_TOOL_ONLY) {
              resetToolOnlyCounter(counterKey);
              scheduleForceExit(forceExitKeyValue);
              resolvedFinalText =
                buildToolSummary() +
                '\n\n⚠️ 连续多次仅执行操作未产生文字回复，已自动恢复正常对话模式。如需继续操控，请重新描述您的需求。';
              structuredLog('warn', 'consecutive_tool_only_auto_reset', {
                consecutive_count: consecutiveCount,
              });
            } else {
              structuredLog('debug', 'consecutive_tool_only_tick', {
                consecutive_count: consecutiveCount,
                fallback_fingerprint: fallbackFingerprint,
              });
            }
          } else if (needsFallback) {
            resetToolOnlyCounter(counterKey);
            structuredLog('info', 'fallback_counter_suppressed_in_progress');
          } else {
            // Normal text reply — reset the counter
            resetToolOnlyCounter(counterKey);
          }

          // Final success payload
          const sessionUsageSnapshot = resolveSessionUsageSnapshot(fullConfig, sessionKey);
          if (sessionUsageSnapshot) {
            structuredLog('debug', 'session_usage_snapshot', {
              session_total_tokens: sessionUsageSnapshot.totalTokens,
              session_input_tokens: sessionUsageSnapshot.inputTokens,
              session_output_tokens: sessionUsageSnapshot.outputTokens,
            });
          }

          chunkSeq += 1;
          const successPayload = {
            command_id: cmdId,
            status: 'success',
            trace_id: traceId,
            result: buildEncryptedResult(resolvedFinalText, chunkSeq, sessionUsageSnapshot, {
              thinking: thinkingSnapshotText,
              lane: 'final',
            }),
          };
          client.sendMessage('COMMAND_RESULT', successPayload);
          setCached(cmdId, successPayload);
        } catch (err: any) {
          const cmdId = payload?.command_id;
          const traceId = payload?.trace_id || payload?.payload?.trace_id || null;
          if (!cmdId) return;
          const failPayload = {
            command_id: cmdId,
            status: 'failed',
            trace_id: traceId,
            error: err?.message || 'Execution failed',
            result: {},
          };
          client.sendMessage('COMMAND_RESULT', failPayload);
          setCached(cmdId, failPayload);
        }
      });

      client.on('CONTROL', async (payload: any) => {
        // This plugin is a XiotBox chat channel. Control commands are meant for XiotBox Control agents (phones),
        // not for the OpenClaw bot. Fail fast so the server doesn't keep retrying a mismatched delivery.
        try {
          const cmdId = payload?.command_id;
          if (!cmdId) return;
          const traceId = payload?.trace_id || payload?.payload?.trace_id || null;
          const failPayload = {
            command_id: cmdId,
            status: 'failed',
            trace_id: traceId,
            error: 'CONTROL_NOT_SUPPORTED_ON_BOT',
            result: {},
          };
          client.sendMessage('COMMAND_RESULT', failPayload);
          setCached(cmdId, failPayload);
        } catch (_err) {
          // ignore
        }
      });

      client.on('connected', () => {
        log?.info?.(`[XiotBox][${accountId}] Connected to Gateway`);
        e2e.refreshPeerKey().catch((err: any) => {
          log?.warn?.(`[XiotBox][${accountId}] E2E peer key refresh failed: ${err?.message || err}`);
        });
      });

      client.on('disconnected', () => {
        log?.warn?.(`[XiotBox][${accountId}] Disconnected from Gateway`);
      });

      client.on('error', (err: any) => {
        log?.error?.(`[XiotBox][${accountId}] Client error: ${err.message}`);
      });

      client.on('auth_required', (payload: any) => {
        log?.error?.(
          `[XiotBox][${accountId}] Gateway auth required (remote channel paused): ${payload?.message || payload?.code || 'REAUTH_REQUIRED'}`,
        );
      });

      await client.connect();

      return {
        stop: async () => {
          log?.info?.(`[XiotBox][${accountId}] Stopping channel...`);
          await client.disconnect();
        },
      };
    },
  },
  status: {
    probe: async ({ cfg }: any) => {
      const channelCfg = getChannelConfig(cfg);
      if (channelCfg.DEVICE_ID) {
        return { ok: true };
      }
      return { ok: false, error: 'Not configured' };
    },
  },
};
