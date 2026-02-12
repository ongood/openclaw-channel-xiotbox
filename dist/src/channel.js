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
function getChannelConfig(cfg) {
    return cfg?.channels?.[CHANNEL_ID] || {};
}
function buildConfig(channelCfg) {
    return {
        GATEWAY_WSS_URL: channelCfg.GATEWAY_WSS_URL || process.env.XIOTBOX_GATEWAY_WSS || 'ws://localhost:9002/ws/openclaw',
        DEVICE_ID: channelCfg.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID,
        DEVICE_TOKEN: channelCfg.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN,
        USE_QUERY_AUTH: channelCfg.USE_QUERY_AUTH || false,
        OUTBOX_MAX: channelCfg.OUTBOX_MAX || 200,
        OUTBOX_TTL_MS: channelCfg.OUTBOX_TTL_MS || 5 * 60 * 1000,
        COMMAND_CACHE_TTL_MS: channelCfg.COMMAND_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS,
        COMMAND_CACHE_MAX: channelCfg.COMMAND_CACHE_MAX || DEFAULT_CACHE_MAX,
        STREAMING: channelCfg.STREAMING || false,
        STREAM_THROTTLE_MS: channelCfg.STREAM_THROTTLE_MS || DEFAULT_STREAM_THROTTLE_MS,
        API_BASE_URL: channelCfg.API_BASE_URL || process.env.XIOTBOX_API_BASE,
        E2E_KEY_PATH: channelCfg.E2E_KEY_PATH || process.env.XIOTBOX_E2E_KEY_PATH,
        E2E_ROTATE: channelCfg.E2E_ROTATE || process.env.XIOTBOX_E2E_ROTATE,
        IDENTITY_KEY_PATH: channelCfg.IDENTITY_KEY_PATH || process.env.XIOTBOX_IDENTITY_KEY_PATH,
        TRUST_PATH: channelCfg.TRUST_PATH || process.env.XIOTBOX_TRUST_PATH,
        ALLOW_NEW_CLIENT_IDENTITIES: channelCfg.ALLOW_NEW_CLIENT_IDENTITIES ?? process.env.XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES,
        HELLO_EXTRA: undefined,
    };
}
function normalizeTextPayload(payload) {
    if (typeof payload === 'string')
        return payload;
    return payload?.markdown || payload?.text || payload?.body || '';
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
    const rootDeviceId = root.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID;
    const rootDeviceToken = root.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN;
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
        isConfigured: (account) => Boolean((account?.config?.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID) &&
            (account?.config?.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN)),
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.config?.name || 'XiotBox',
            enabled: account.enabled,
            configured: Boolean((account.config?.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID) &&
                (account.config?.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN)),
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
                    catch (err) {
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
                    let lastText = '';
                    let lastStreamAt = 0;
                    let chunkSeq = 0;
                    const deliver = async (outPayload) => {
                        const replyText = normalizeTextPayload(outPayload);
                        if (!replyText)
                            return;
                        lastText = replyText;
                        if (!finalCfg.STREAMING)
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
                    const { queuedFinal } = await dispatchReply({
                        ctx: inboundCtx,
                        cfg: fullConfig,
                        replyResolver: null,
                        dispatcherOptions: {
                            deliver,
                        },
                    });
                    const finalText = normalizeTextPayload(queuedFinal) || lastText || '';
                    if (!shouldSkipReply(finalText)) {
                        const successPayload = {
                            command_id: cmdId,
                            status: 'success',
                            trace_id: traceId,
                            result: buildEncryptedResult(finalText, chunkSeq),
                        };
                        client.sendMessage('COMMAND_RESULT', successPayload);
                        setCached(cmdId, successPayload);
                    }
                    else {
                        // Still finalize to avoid hanging commands
                        const emptyPayload = {
                            command_id: cmdId,
                            status: 'success',
                            trace_id: traceId,
                            result: buildEncryptedResult('', chunkSeq),
                        };
                        client.sendMessage('COMMAND_RESULT', emptyPayload);
                        setCached(cmdId, emptyPayload);
                    }
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
            if (channelCfg.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID) {
                return { ok: true };
            }
            return { ok: false, error: 'Not configured' };
        },
    },
};
