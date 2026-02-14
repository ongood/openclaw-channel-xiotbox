import WSSClient from '../wss_client.js';
import { getXiotboxRuntime } from './runtime.js';
import { OpenClawE2E } from './e2e.js';
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_MAX = 500;
const DEFAULT_STREAM_THROTTLE_MS = 500;
const DEFAULT_ACCOUNT_ID = 'default';
const CHANNEL_ID = 'xiotbox';
function normalizeAccountId(value) {
    const normalized = String(value || '').trim();
    return normalized || DEFAULT_ACCOUNT_ID;
}
function normalizeStrList(value, fallback) {
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
function getChannelConfig(cfg) {
    return cfg?.channels?.[CHANNEL_ID] || {};
}
function buildConfig(channelCfg) {
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
        HELLO_EXTRA: undefined,
    };
}
/**
 * Robust text extraction:
 * - supports common fields (markdown/text/body/output_text/etc.)
 * - supports arrays: parts/content/messages
 * - supports nested objects recursively (safe depth + cycle guard)
 * - supports streaming/delta-like fields
 */
function normalizeTextPayload(payload) {
    if (typeof payload === 'string')
        return payload;
    if (!payload)
        return '';
    const acc = [];
    const visited = new WeakSet();
    const MAX_DEPTH = 6;
    const pushText = (v) => {
        if (!v)
            return;
        if (typeof v === 'string') {
            const s = v.trimEnd();
            if (s)
                acc.push(s);
            return;
        }
        if (typeof v === 'number' || typeof v === 'boolean') {
            acc.push(String(v));
            return;
        }
        // objects handled by walk
    };
    const walk = (obj, depth) => {
        if (!obj || depth > MAX_DEPTH)
            return;
        if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
            pushText(obj);
            return;
        }
        if (Array.isArray(obj)) {
            for (const it of obj)
                walk(it, depth + 1);
            return;
        }
        if (typeof obj !== 'object')
            return;
        if (visited.has(obj))
            return;
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
                }
                else {
                    pushText(v);
                }
            }
        }
        // 2) parts/content arrays
        if (Array.isArray(obj.parts))
            walk(obj.parts, depth + 1);
        if (Array.isArray(obj.content))
            walk(obj.content, depth + 1);
        // 3) common nested containers
        if (obj.content && typeof obj.content === 'object')
            walk(obj.content, depth + 1);
        if (obj.part && typeof obj.part === 'object')
            walk(obj.part, depth + 1);
        // 4) streaming/delta-ish
        // many providers use delta/content_delta/choices[].delta etc.
        if (obj.delta !== undefined)
            walk(obj.delta, depth + 1);
        if (obj.content_delta !== undefined)
            walk(obj.content_delta, depth + 1);
        if (Array.isArray(obj.choices))
            walk(obj.choices, depth + 1);
        if (obj.choice && typeof obj.choice === 'object')
            walk(obj.choice, depth + 1);
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
                if (typeof v === 'object' && v)
                    walk(v, depth + 1);
                else
                    pushText(v);
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
function shouldSkipReply(text) {
    const trimmed = (text || '').trim();
    if (!trimmed)
        return true;
    if (trimmed === 'NO_REPLY')
        return true;
    if (trimmed.endsWith('NO_REPLY'))
        return true;
    return false;
}
function isConfiguredCfg(cfg) {
    return listAccountIds(cfg).length > 0;
}
function listAccountIds(cfg) {
    const root = getChannelConfig(cfg);
    const rootDeviceId = root.DEVICE_ID;
    const rootDeviceToken = root.DEVICE_TOKEN;
    return rootDeviceId && rootDeviceToken ? [DEFAULT_ACCOUNT_ID] : [];
}
function resolveDefaultAccountId(cfg) {
    const ids = listAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
        return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] || DEFAULT_ACCOUNT_ID;
}
function resolveAccount(cfg, accountId) {
    const root = getChannelConfig(cfg);
    const resolvedAccountId = normalizeAccountId(accountId);
    return {
        accountId: resolvedAccountId,
        config: root,
        enabled: root.enabled !== false,
    };
}
function detectToolSignals(outPayload) {
    if (!outPayload || typeof outPayload !== 'object')
        return false;
    return Boolean(outPayload.tool_calls ||
        outPayload.toolCalls ||
        outPayload.tool_call ||
        outPayload.function_call ||
        outPayload.functionCall ||
        outPayload.action ||
        outPayload.actions ||
        outPayload.observation ||
        outPayload.observations ||
        outPayload.tool_result ||
        outPayload.toolResult);
}
function summarizeToolSignals(outPayload) {
    if (!outPayload || typeof outPayload !== 'object')
        return '';
    const names = [];
    const tc = outPayload.tool_calls || outPayload.toolCalls;
    if (Array.isArray(tc)) {
        for (const t of tc) {
            const name = t?.name || t?.tool || t?.tool_name || t?.function?.name;
            if (name)
                names.push(String(name));
        }
    }
    const fc = outPayload.function_call || outPayload.functionCall;
    if (fc?.name)
        names.push(String(fc.name));
    const act = outPayload.action;
    if (typeof act === 'string')
        names.push(act);
    const uniq = Array.from(new Set(names.map((s) => s.trim()).filter(Boolean)));
    if (!uniq.length)
        return '';
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
        threads: false,
        media: false,
        nativeCommands: false,
        blockStreaming: false,
        outbound: false,
    },
    reload: { configPrefixes: ['channels.xiotbox'] },
    config: {
        listAccountIds: (cfg) => listAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
        defaultAccountId: (cfg) => resolveDefaultAccountId(cfg),
        isConfigured: (account) => Boolean(account?.config?.DEVICE_ID && account?.config?.DEVICE_TOKEN),
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.config?.name || 'XiotBox',
            enabled: account.enabled,
            configured: Boolean(account.config?.DEVICE_ID && account.config?.DEVICE_TOKEN),
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
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
            const commandCache = new Map();
            const e2e = new OpenClawE2E(finalCfg, log);
            e2e.init();
            try {
                await e2e.refreshPeerKey();
            }
            catch (err) {
                log?.warn?.(`[XiotBox] E2E peer key not ready: ${err?.message || err}`);
            }
            finalCfg.HELLO_EXTRA = {
                e2e: e2e.helloPayload(),
                thread_id: e2e.threadId || undefined,
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
            const getCached = (cmdId) => {
                pruneCache();
                return commandCache.get(cmdId)?.payload || null;
            };
            const setCached = (cmdId, payload) => {
                pruneCache();
                commandCache.set(cmdId, { ts: Date.now(), payload });
            };
            client.on('COMMAND', async (payload) => {
                try {
                    const cmdId = payload?.command_id;
                    if (!cmdId)
                        return;
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
                    }
                    catch (err) {
                        const refreshErr = err?.message || 'e2e_peer_refresh_failed';
                        // Preserve service continuity for existing sessions:
                        // if a previously trusted key exists, keep using it for this command.
                        if (cachedPeerPublicKey) {
                            e2e.peerPublicKey = cachedPeerPublicKey;
                            e2e.peerKeyId = cachedPeerKeyId;
                            e2e.peerTrustError = refreshErr;
                            log?.warn?.(`[XiotBox] E2E peer key refresh failed, fallback to cached key: ${refreshErr}`);
                        }
                        else {
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
                    const threadId = incoming?.thread_id || e2e.threadId || '';
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
                    }
                    catch (_err) {
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
                    const buildEncryptedResult = (replyText, seq) => {
                        const e2eMulti = {};
                        let primaryEnv = null;
                        let primaryKeyId = '';
                        for (const peer of replyPeers) {
                            const envOut = e2e.encryptText(replyText, {
                                direction: 'p2c',
                                device_id: finalCfg.DEVICE_ID,
                                thread_id: threadId,
                                command_id: cmdId,
                                content_type: contentType,
                                chunk_seq: seq,
                                enc_v: e2e.encV,
                            }, {
                                publicKey: peer.publicKey,
                                keyId: peer.keyId,
                            });
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
                    const sessionKey = `xiotbox:${finalCfg.DEVICE_ID}`;
                    const inboundCtx = {
                        Body: text,
                        RawBody: text,
                        CommandBody: text,
                        From: payload?.from || 'xiotbox',
                        To: finalCfg.DEVICE_ID,
                        SessionKey: sessionKey,
                        AccountId: accountId,
                        MessageSid: cmdId,
                        TraceId: traceId,
                        ChatType: 'direct',
                        ConversationLabel: finalCfg.DEVICE_ID,
                        SenderId: payload?.from || 'xiotbox',
                        CommandAuthorized: true,
                        Provider: 'xiotbox',
                        Surface: 'xiotbox',
                        OriginatingChannel: 'xiotbox',
                        OriginatingTo: finalCfg.DEVICE_ID,
                        DeliveryContext: {
                            channel: 'xiotbox',
                            to: finalCfg.DEVICE_ID,
                        },
                    };
                    // OpenClaw dispatcher returns metadata and delivers actual reply payloads
                    // asynchronously via `deliver(payload, { kind })`.
                    let lastText = '';
                    let finalText = '';
                    const blockParts = [];
                    let lastStreamAt = 0;
                    let chunkSeq = 0;
                    let dispatchMeta = null;
                    const skipEvents = [];
                    // Signals to avoid "empty success"
                    let sawAnyDeliver = false;
                    let sawToolLikeDeliver = false;
                    let sawNonTextDeliver = false;
                    const deliver = async (outPayload, info) => {
                        const kind = info?.kind || 'block';
                        sawAnyDeliver = true;
                        const hasTool = detectToolSignals(outPayload);
                        if (hasTool)
                            sawToolLikeDeliver = true;
                        const replyText = normalizeTextPayload(outPayload);
                        const keysPresent = outPayload && typeof outPayload === 'object'
                            ? Object.keys(outPayload).sort()
                            : [String(typeof outPayload)];
                        log?.debug?.(`[XiotBox] deliver kind=${kind} text_len=${replyText.length} has_tool=${hasTool} keys=${JSON.stringify(keysPresent)} ${summarizeToolSignals(outPayload)}`);
                        if (!replyText) {
                            sawNonTextDeliver = true;
                            // Internal event / tool call / observation with no human text.
                            // Do not emit as chat bubble.
                            return;
                        }
                        lastText = replyText;
                        if (kind === 'block') {
                            blockParts.push(replyText);
                        }
                        else if (kind === 'final') {
                            finalText = replyText;
                        }
                        if (!finalCfg.STREAMING)
                            return;
                        // Only stream block replies to avoid leaking tool payloads to the chat UI.
                        if (kind !== 'block')
                            return;
                        const now = Date.now();
                        if (now - lastStreamAt < finalCfg.STREAM_THROTTLE_MS)
                            return;
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
                    // Prefer deterministic dispatch path that waits for all queued deliveries before finalizing.
                    const replyApi = runtime?.channel?.reply;
                    const createDispatcher = replyApi?.createReplyDispatcherWithTyping;
                    const finalizeCtx = replyApi?.finalizeInboundContext;
                    const dispatchFromConfig = replyApi?.dispatchReplyFromConfig;
                    if (createDispatcher && finalizeCtx && dispatchFromConfig) {
                        const { dispatcher, replyOptions, markDispatchIdle } = createDispatcher({
                            deliver,
                            onSkip: (_payload, info) => {
                                skipEvents.push({
                                    kind: String(info?.kind || 'unknown'),
                                    reason: String(info?.reason || 'unknown'),
                                });
                            },
                            onError: (err, info) => {
                                log?.warn?.(`[XiotBox] OpenClaw deliver error kind=${info?.kind || 'unknown'} err=${err?.message || err}`);
                            },
                        });
                        const finalized = finalizeCtx(inboundCtx);
                        dispatchMeta = await dispatchFromConfig({
                            ctx: finalized,
                            cfg: fullConfig,
                            dispatcher,
                            replyResolver: null,
                            replyOptions,
                        });
                        await dispatcher.waitForIdle();
                        markDispatchIdle();
                    }
                    else {
                        // Fallback for older runtimes.
                        const { queuedFinal, counts } = await dispatchReply({
                            ctx: inboundCtx,
                            cfg: fullConfig,
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
                    // IMPORTANT: Never send "success" with empty text as a normal reply,
                    // because downstream clients often render it as an empty bubble.
                    //
                    // If OpenClaw produced only tool/observation events with no human text,
                    // emit a small non-empty placeholder so users don't think the bot "didn't reply".
                    const toolOnlyPlaceholder = '（已执行操作步骤，无额外文字回复）';
                    if (!resolvedFinalText) {
                        const metaStr = dispatchMeta ? JSON.stringify(dispatchMeta) : 'null';
                        const skipsStr = skipEvents.length ? JSON.stringify(skipEvents) : '[]';
                        // If OpenClaw queued something but we got no text, treat as failure (bug/merge issue).
                        const queuedFinal = Boolean(dispatchMeta?.queuedFinal || (dispatchMeta?.counts?.final || 0) > 0);
                        // If we saw tool-like deliveries or non-text deliveries, it's likely tool-only.
                        const toolOnlyLikely = sawToolLikeDeliver || sawNonTextDeliver;
                        if (queuedFinal && !toolOnlyLikely) {
                            const failPayload = {
                                command_id: cmdId,
                                status: 'failed',
                                trace_id: traceId,
                                error: 'empty_reply_from_openclaw',
                                result: {},
                            };
                            log?.warn?.(`[XiotBox] empty reply (queuedFinal=true) cmdId=${cmdId} traceId=${traceId || ''} sawDeliver=${sawAnyDeliver} toolOnly=${toolOnlyLikely} meta=${metaStr} skips=${skipsStr}`);
                            client.sendMessage('COMMAND_RESULT', failPayload);
                            setCached(cmdId, failPayload);
                            return;
                        }
                        if (toolOnlyLikely) {
                            resolvedFinalText = toolOnlyPlaceholder;
                        }
                        else {
                            // No deliver at all / truly silent completion: still avoid empty bubble.
                            // Use a tiny placeholder to keep UX consistent.
                            resolvedFinalText = toolOnlyPlaceholder;
                            log?.debug?.(`[XiotBox] silent/empty completion -> placeholder cmdId=${cmdId} traceId=${traceId || ''} sawDeliver=${sawAnyDeliver} meta=${metaStr} skips=${skipsStr}`);
                        }
                    }
                    // If explicitly asked for NO_REPLY semantics, respect it, but still avoid empty bubble:
                    // - Here we interpret NO_REPLY as "do not show a normal chat bubble"
                    // - However downstream may not support it; safest is to return a tiny placeholder.
                    if (shouldSkipReply(resolvedFinalText)) {
                        resolvedFinalText = toolOnlyPlaceholder;
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
                }
                catch (err) {
                    const cmdId = payload?.command_id;
                    const traceId = payload?.trace_id || payload?.payload?.trace_id || null;
                    if (!cmdId)
                        return;
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
            client.on('CONTROL', async (payload) => {
                // This plugin is a XiotBox chat channel. Control commands are meant for XiotBox Control agents (phones),
                // not for the OpenClaw bot. Fail fast so the server doesn't keep retrying a mismatched delivery.
                try {
                    const cmdId = payload?.command_id;
                    if (!cmdId)
                        return;
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
                }
                catch (_err) {
                    // ignore
                }
            });
            client.on('connected', () => {
                log?.info?.(`[XiotBox][${accountId}] Connected to Gateway`);
                e2e.refreshPeerKey().catch((err) => {
                    log?.warn?.(`[XiotBox][${accountId}] E2E peer key refresh failed: ${err?.message || err}`);
                });
            });
            client.on('disconnected', () => {
                log?.warn?.(`[XiotBox][${accountId}] Disconnected from Gateway`);
            });
            client.on('error', (err) => {
                log?.error?.(`[XiotBox][${accountId}] Client error: ${err.message}`);
            });
            client.on('auth_required', (payload) => {
                log?.error?.(`[XiotBox][${accountId}] Gateway auth required (remote channel paused): ${payload?.message || payload?.code || 'REAUTH_REQUIRED'}`);
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
        probe: async ({ cfg }) => {
            const channelCfg = getChannelConfig(cfg);
            if (channelCfg.DEVICE_ID) {
                return { ok: true };
            }
            return { ok: false, error: 'Not configured' };
        },
    },
};
