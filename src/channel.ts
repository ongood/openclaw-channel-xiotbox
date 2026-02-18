import WSSClient from '../wss_client.js';
import { getXiotboxRuntime } from './runtime.js';
import { OpenClawE2E } from './e2e.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_MAX = 500;
const DEFAULT_STREAM_THROTTLE_MS = 500;
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_THREAD_ID = 'main';
const CHANNEL_ID = 'xiotbox';

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

function buildSessionKey(deviceId: string, threadId: string): string {
  return `xiotbox:${deviceId}:${normalizeThreadId(threadId)}`;
}

function getChannelConfig(cfg: any) {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

function buildConfig(channelCfg: any) {
  return {
    GATEWAY_WSS_URL: channelCfg.GATEWAY_WSS_URL || 'ws://localhost:9002/ws/openclaw',
    DEVICE_ID: channelCfg.DEVICE_ID,
    DEVICE_TOKEN: channelCfg.DEVICE_TOKEN,
    USE_QUERY_AUTH: channelCfg.USE_QUERY_AUTH || false,
    OUTBOX_MAX: channelCfg.OUTBOX_MAX || 200,
    OUTBOX_TTL_MS: channelCfg.OUTBOX_TTL_MS || 5 * 60 * 1000,
    COMMAND_CACHE_TTL_MS: channelCfg.COMMAND_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS,
    COMMAND_CACHE_MAX: channelCfg.COMMAND_CACHE_MAX || DEFAULT_CACHE_MAX,
    STREAMING: channelCfg.STREAMING || false,
    STREAM_THROTTLE_MS: channelCfg.STREAM_THROTTLE_MS || DEFAULT_STREAM_THROTTLE_MS,
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
  /退出控制/,
  /停止操控/,
  /停止控制/,
  /退出操控/,
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
}

const toolOnlyCounters = new Map<string, ToolOnlyEntry>();
const forceExitCounters = new Map<string, number>();

function toolOnlyCounterKey(deviceId: string, threadId: string, senderId: string): string {
  return `${deviceId}:${normalizeThreadId(threadId)}:${senderId}`;
}

function forceExitKey(deviceId: string, threadId: string): string {
  return `${deviceId}:${normalizeThreadId(threadId)}`;
}

function incrementToolOnlyCounter(key: string): number {
  const now = Date.now();
  const existing = toolOnlyCounters.get(key);
  if (existing && now - existing.updatedAt < TOOL_ONLY_COUNTER_TTL_MS) {
    existing.count += 1;
    existing.updatedAt = now;
    return existing.count;
  }
  toolOnlyCounters.set(key, { count: 1, updatedAt: now });
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

function summarizeToolSignals(outPayload: any): string {
  if (!outPayload || typeof outPayload !== 'object') return '';
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

  const uniq = Array.from(new Set(names.map((s) => s.trim()).filter(Boolean)));
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
    blockStreaming: false,
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

          const buildEncryptedResult = (replyText: string, seq: number) => {
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
            return {
              e2e: primaryEnv,
              e2e_multi: e2eMulti,
              result_key_id: primaryKeyId,
              enc_v: e2e.encV,
              content_type: contentType,
              chunk_seq: seq,
            };
          };

          const sessionKey = buildSessionKey(finalCfg.DEVICE_ID, threadId);
          const senderId = payload?.from || 'xiotbox';
          const counterKey = toolOnlyCounterKey(finalCfg.DEVICE_ID, threadId, senderId);
          const forceExitKeyValue = forceExitKey(finalCfg.DEVICE_ID, threadId);

          log?.debug?.(JSON.stringify({
            event: 'session_scope',
            trace_id: traceId || '',
            message_id: cmdId,
            device_id: finalCfg.DEVICE_ID,
            thread_id: threadId,
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
            log?.info?.(JSON.stringify({
              event: 'hard_exit_command',
              trace_id: traceId,
              thread_id: threadId,
              message_id: cmdId,
              sender_id: senderId,
              input_text: text.slice(0, 80),
            }));
            // Rewrite the user text so OpenClaw sees a normal prompt, not the raw /stop
            text = '用户请求退出操控模式，请停止调用任何工具，仅用文字回复。';
          }
          const forceTextOnly = shouldForceExit || hardExitRequested;

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
            DeliveryContext: {
              channel: 'xiotbox',
              to: finalCfg.DEVICE_ID,
              threadId,
            },
          };

          // OpenClaw dispatcher returns metadata and delivers actual reply payloads
          // asynchronously via `deliver(payload, { kind })`.
          let lastText = '';
          let finalText = '';
          const blockParts: string[] = [];
          let lastStreamAt = 0;
          let chunkSeq = 0;
          let dispatchMeta: { queuedFinal?: boolean; counts?: Record<string, number> } | null = null;
          const skipEvents: Array<{ kind: string; reason: string }> = [];

          // Signals to avoid "empty success"
          let sawAnyDeliver = false;
          let sawToolLikeDeliver = false;
          let sawNonTextDeliver = false;
          const toolNamesSeen: string[] = [];

          const deliver = async (outPayload: any, info?: any) => {
            const kind = info?.kind || 'block';
            sawAnyDeliver = true;

            const hasTool = detectToolSignals(outPayload);
            if (hasTool) {
              sawToolLikeDeliver = true;
              // Collect tool names for summary
              const sig = summarizeToolSignals(outPayload);
              if (sig) {
                const match = sig.match(/^tool=(.+)$/);
                if (match) toolNamesSeen.push(...match[1].split(','));
              }
            }

            const replyText = normalizeTextPayload(outPayload);

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
            }));

            if (!replyText) {
              sawNonTextDeliver = true;
              // Internal event / tool call / observation with no human text.
              // Do not emit as chat bubble.
              return;
            }

            lastText = replyText;
            if (kind === 'block') {
              blockParts.push(replyText);
            } else if (kind === 'final') {
              finalText = replyText;
            }

            if (!finalCfg.STREAMING) return;

            // Only stream block replies to avoid leaking tool payloads to the chat UI.
            if (kind !== 'block') return;

            const now = Date.now();
            if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS) return;
            lastStreamAt = now;

            chunkSeq += 1;
            client.sendMessage('COMMAND_RESULT', {
              command_id: cmdId,
              status: 'running',
              trace_id: traceId,
              result: buildEncryptedResult(replyText, chunkSeq),
            });
          };

          const fullConfig = runtime?.config?.loadConfig?.() ?? cfg;
          const effectiveConfig = forceTextOnly ? buildTextOnlyConfig(fullConfig) : fullConfig;

          // Prefer deterministic dispatch path that waits for all queued deliveries before finalizing.
          const replyApi = runtime?.channel?.reply;
          const createDispatcher = replyApi?.createReplyDispatcherWithTyping;
          const finalizeCtx = replyApi?.finalizeInboundContext;
          const dispatchFromConfig = replyApi?.dispatchReplyFromConfig;

          if (createDispatcher && finalizeCtx && dispatchFromConfig) {
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

            const finalized = finalizeCtx(inboundCtx);
            dispatchMeta = await dispatchFromConfig({
              ctx: finalized,
              cfg: effectiveConfig,
              dispatcher,
              replyResolver: null,
              replyOptions,
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
          const needsFallback = isToolOnlyReply || isNoReply || !resolvedFinalText;

          // ── Structured log helper ──
          const structuredLog = (level: 'debug' | 'info' | 'warn', event: string, extra?: Record<string, any>) => {
            const entry = {
              event,
              trace_id: traceId || '',
              thread_id: threadId || '',
              session_key: sessionKey,
              message_id: cmdId,
              branch: needsFallback ? (isToolOnlyReply ? 'tool_only' : isNoReply ? 'no_reply' : 'empty') : 'normal',
              resolved_text_len: resolvedFinalText.length,
              tool_names: toolNamesSeen.slice(),
              ...extra,
            };
            log?.[level]?.(JSON.stringify(entry));
          };

          // Build a dynamic summary when only tool calls were executed (no human text).
          const buildToolSummary = (): string => {
            const uniq = Array.from(new Set(toolNamesSeen.map(s => s.trim()).filter(Boolean)));
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

            resolvedFinalText = buildToolSummary();
            structuredLog('info', 'tool_only_summary', {
              dispatch_meta: dispatchMeta,
              saw_any_deliver: sawAnyDeliver,
            });
          }

          // If explicitly asked for NO_REPLY semantics, still avoid empty bubble.
          if (shouldSkipReply(resolvedFinalText)) {
            resolvedFinalText = buildToolSummary();
            structuredLog('info', 'no_reply_to_summary');
          }

          // ── Consecutive tool-only counter: auto-fallback after MAX_CONSECUTIVE_TOOL_ONLY ──
          if (needsFallback) {
            const consecutiveCount = incrementToolOnlyCounter(counterKey);
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
              });
            }
          } else {
            // Normal text reply — reset the counter
            resetToolOnlyCounter(counterKey);
          }

          // Final success payload
          chunkSeq += 1;
          const successPayload = {
            command_id: cmdId,
            status: 'success',
            trace_id: traceId,
            result: buildEncryptedResult(resolvedFinalText, chunkSeq),
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
