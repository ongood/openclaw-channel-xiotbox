/**
 * XiotBox Standalone Bridge (E2E-enabled)
 *
 * Bridges XiotBox Gateway (WSS) to OpenClaw Gateway (local WS operator API).
 * This bridge keeps the same E2E command/result envelope behavior as plugin mode.
 */

import WebSocket from 'ws';
import WSSClient from './wss_client.js';
import { OpenClawE2E } from './dist/src/e2e.js';
import { loadRuntimeConfig } from './dist/src/runtime_config.js';

const runtimeConfig = loadRuntimeConfig();
const { bridge, xiotbox } = runtimeConfig;

const GATEWAY_PORT = bridge.openclawPort;
const GATEWAY_HOST = bridge.openclawHost;
const GATEWAY_TOKEN = bridge.GATEWAY_TOKEN;
const AGENT_ID = bridge.agentId;

const XIOTBOX_CONFIG = {
  GATEWAY_WSS_URL: xiotbox.GATEWAY_WSS_URL,
  DEVICE_ID: xiotbox.DEVICE_ID,
  DEVICE_TOKEN: xiotbox.DEVICE_TOKEN,
  USE_QUERY_AUTH: xiotbox.USE_QUERY_AUTH,
  OUTBOX_MAX: xiotbox.OUTBOX_MAX,
  OUTBOX_TTL_MS: xiotbox.OUTBOX_TTL_MS,
  COMMAND_CACHE_TTL_MS: xiotbox.COMMAND_CACHE_TTL_MS,
  COMMAND_CACHE_MAX: xiotbox.COMMAND_CACHE_MAX,
  STREAMING: xiotbox.STREAMING,
  STREAM_THROTTLE_MS: xiotbox.STREAM_THROTTLE_MS,
  API_BASE_URL: xiotbox.API_BASE_URL,
  E2E_KEY_PATH: xiotbox.E2E_KEY_PATH,
  E2E_ROTATE: xiotbox.E2E_ROTATE,
  IDENTITY_KEY_PATH: xiotbox.IDENTITY_KEY_PATH,
  TRUST_PATH: xiotbox.TRUST_PATH,
  ALLOW_NEW_CLIENT_IDENTITIES: xiotbox.ALLOW_NEW_CLIENT_IDENTITIES,
};

// Prefer terminal stability over intermediate running snapshots.
// Some server deployments still launch the standalone bridge path rather than
// the channel runtime entrypoint, so disable bridge streaming here as well.
XIOTBOX_CONFIG.STREAMING = false;

if (!GATEWAY_TOKEN) {
  console.error('[Bridge] FATAL: GATEWAY_TOKEN is required in .env');
  process.exit(1);
}
if (!XIOTBOX_CONFIG.DEVICE_ID || !XIOTBOX_CONFIG.DEVICE_TOKEN) {
  console.error('[Bridge] FATAL: XIOTBOX_DEVICE_ID and XIOTBOX_DEVICE_TOKEN are required');
  process.exit(1);
}

let gatewayWs = null;
let xiotboxClient = null;
const e2e = new OpenClawE2E(XIOTBOX_CONFIG, console);

const pendingByReqId = new Map(); // reqId -> pending context
const pendingByRunId = new Map(); // runId -> pending context
const commandCache = new Map(); // commandId -> { ts, payload }

function normalizeTextPayload(payload) {
  if (typeof payload === 'string') return payload;
  return payload?.markdown || payload?.text || payload?.body || '';
}

function shouldSkipReply(text) {
  const trimmed = (text || '').trim();
  return !trimmed || trimmed === 'NO_REPLY' || trimmed.endsWith('NO_REPLY');
}

function pruneCommandCache() {
  const now = Date.now();
  for (const [commandId, entry] of commandCache.entries()) {
    if (now - entry.ts > XIOTBOX_CONFIG.COMMAND_CACHE_TTL_MS) {
      commandCache.delete(commandId);
    }
  }
  while (commandCache.size > XIOTBOX_CONFIG.COMMAND_CACHE_MAX) {
    const firstKey = commandCache.keys().next().value;
    commandCache.delete(firstKey);
  }
}

function getCachedResult(commandId) {
  pruneCommandCache();
  return commandCache.get(commandId)?.payload || null;
}

function setCachedResult(commandId, payload) {
  pruneCommandCache();
  commandCache.set(commandId, { ts: Date.now(), payload });
}

function buildEncryptedResult(ctx, replyText, seq) {
  const e2eMulti = {};
  let primaryEnv = null;
  let primaryKeyId = '';

  for (const peer of ctx.replyPeers) {
    const envOut = e2e.encryptText(
      replyText,
      {
        direction: 'p2c',
        device_id: XIOTBOX_CONFIG.DEVICE_ID,
        thread_id: ctx.threadId,
        command_id: ctx.commandId,
        content_type: ctx.contentType,
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
    content_type: ctx.contentType,
    chunk_seq: seq,
  };
}

function sendToXiotbox(commandId, status, traceId, result = {}, error = null) {
  if (!xiotboxClient) return;
  const payload = {
    command_id: commandId,
    status,
    trace_id: traceId || null,
    result,
  };
  if (error) payload.error = error;
  xiotboxClient.sendMessage('COMMAND_RESULT', payload);
}

function finalizeSuccess(ctx, text) {
  const finalText = text || '';
  const successPayload = {
    command_id: ctx.commandId,
    status: 'success',
    trace_id: ctx.traceId || null,
    result: buildEncryptedResult(ctx, finalText, ctx.chunkSeq),
  };
  sendToXiotbox(ctx.commandId, 'success', ctx.traceId, successPayload.result);
  setCachedResult(ctx.commandId, successPayload);
}

function finalizeFailed(ctx, errorCode) {
  const failPayload = {
    command_id: ctx.commandId,
    status: 'failed',
    trace_id: ctx.traceId || null,
    error: errorCode || 'bridge_failed',
    result: {},
  };
  sendToXiotbox(ctx.commandId, 'failed', ctx.traceId, {}, failPayload.error);
  setCachedResult(ctx.commandId, failPayload);
}

function deliverStreamChunk(ctx, text) {
  if (!XIOTBOX_CONFIG.STREAMING) return;
  const now = Date.now();
  if (now - ctx.lastStreamAt < XIOTBOX_CONFIG.STREAM_THROTTLE_MS) return;
  ctx.lastStreamAt = now;
  ctx.chunkSeq += 1;
  sendToXiotbox(ctx.commandId, 'running', ctx.traceId, buildEncryptedResult(ctx, text, ctx.chunkSeq));
}

function deletePendingCtx(ctx) {
  if (!ctx) return;
  if (ctx.reqId) pendingByReqId.delete(ctx.reqId);
  if (ctx.runId) pendingByRunId.delete(ctx.runId);
}

function connectToGateway() {
  console.log(`[Bridge] Connecting to OpenClaw Gateway at ws://${GATEWAY_HOST}:${GATEWAY_PORT}...`);
  gatewayWs = new WebSocket(`ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);

  gatewayWs.on('open', () => {
    console.log('[Bridge] Gateway socket opened');
  });

  gatewayWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleGatewayMessage(msg);
    } catch (err) {
      console.error('[Bridge] Failed to parse Gateway message:', err);
    }
  });

  gatewayWs.on('close', () => {
    console.warn('[Bridge] Gateway disconnected. Reconnecting in 3s...');
    setTimeout(connectToGateway, 3000);
  });

  gatewayWs.on('error', (err) => {
    console.error('[Bridge] Gateway error:', err.message);
  });
}

function handleGatewayMessage(msg) {
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('[Bridge] Received challenge, sending connect request...');
    gatewayWs.send(
      JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: 'xiotbox-bridge', version: '1.0.0', platform: 'bridge', mode: 'backend' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          auth: { token: GATEWAY_TOKEN },
          userAgent: 'xiotbox-bridge',
        },
      }),
    );
    return;
  }

  if (msg.type === 'res' && msg.id === 'connect') {
    if (msg.ok) {
      console.log('[Bridge] Gateway handshake successful');
    } else {
      console.error('[Bridge] Gateway handshake failed:', msg.error);
      process.exit(1);
    }
    return;
  }

  if (msg.type === 'res' && msg.id?.startsWith('cmd_')) {
    const ctx = pendingByReqId.get(msg.id);
    if (!ctx) return;
    if (!msg.ok) {
      console.error(`[Bridge] Agent request failed commandId=${ctx.commandId}:`, msg.error);
      finalizeFailed(ctx, msg.error?.message || 'agent_request_failed');
      deletePendingCtx(ctx);
      return;
    }
    const runId = msg.payload?.runId;
    if (!runId) {
      const instantText = normalizeTextPayload(msg.payload) || '';
      finalizeSuccess(ctx, instantText);
      deletePendingCtx(ctx);
      return;
    }
    ctx.runId = runId;
    pendingByRunId.set(runId, ctx);
    return;
  }

  if (msg.type === 'event' && msg.event === 'agent') {
    handleAgentEvent(msg.payload);
  }
}

function handleAgentEvent(payload) {
  const runId = payload?.runId;
  if (!runId) return;
  const ctx = pendingByRunId.get(runId);
  if (!ctx) return;

  if (payload.stream === 'assistant') {
    const data = payload.data || {};
    if (typeof data.text === 'string') {
      ctx.buffer = data.text;
    } else if (typeof data.delta === 'string') {
      ctx.buffer += data.delta;
    }
    if (ctx.buffer) {
      deliverStreamChunk(ctx, ctx.buffer);
    }
    return;
  }

  if (payload.stream === 'lifecycle' && payload.data?.phase === 'error') {
    const message = payload.data?.message || 'agent_runtime_error';
    console.error(`[Bridge] Agent run error commandId=${ctx.commandId}: ${message}`);
    finalizeFailed(ctx, message);
    deletePendingCtx(ctx);
    return;
  }

  if (payload.stream === 'lifecycle' && payload.data?.phase === 'end') {
    const finalText = ctx.buffer || '';
    console.log(`[Bridge] Agent run finished commandId=${ctx.commandId}`);
    if (shouldSkipReply(finalText)) {
      finalizeSuccess(ctx, '');
    } else {
      finalizeSuccess(ctx, finalText);
    }
    deletePendingCtx(ctx);
  }
}

async function handleXiotBoxCommand(payload) {
  const commandId = payload?.command_id;
  if (!commandId) return;

  const cached = getCachedResult(commandId);
  if (cached) {
    sendToXiotbox(commandId, cached.status, cached.trace_id, cached.result, cached.error || null);
    return;
  }

  const traceId = payload?.trace_id || payload?.payload?.trace_id || null;
  sendToXiotbox(commandId, 'acked', traceId, {});

  const incoming = payload?.payload || payload || {};
  const contentType = incoming?.content_type || incoming?.contentType || 'text/markdown';
  const threadId = incoming?.thread_id || e2e.threadId || '';

  const cachedPeerPublicKey = e2e.peerPublicKey || '';
  const cachedPeerKeyId = e2e.peerKeyId || '';
  try {
    await e2e.refreshPeerKey();
  } catch (err) {
    const refreshErr = err?.message || 'e2e_peer_refresh_failed';
    if (cachedPeerPublicKey) {
      e2e.peerPublicKey = cachedPeerPublicKey;
      e2e.peerKeyId = cachedPeerKeyId;
      e2e.peerTrustError = refreshErr;
      console.warn(`[Bridge] E2E peer refresh failed, fallback to cached key: ${refreshErr}`);
    } else {
      e2e.peerPublicKey = '';
      e2e.peerKeyId = '';
      e2e.peerTrustError = refreshErr;
    }
  }

  const env = (incoming?.magic === 'OGE2E1' ? incoming : incoming?.e2e) || null;
  if (!env || env.magic !== 'OGE2E1') {
    const failPayload = {
      command_id: commandId,
      status: 'failed',
      trace_id: traceId,
      error: 'e2e_required',
      result: {},
    };
    sendToXiotbox(commandId, 'failed', traceId, {}, failPayload.error);
    setCachedResult(commandId, failPayload);
    return;
  }

  let text = '';
  try {
    text = e2e.decryptText(env, {
      direction: 'c2p',
      device_id: XIOTBOX_CONFIG.DEVICE_ID,
      thread_id: threadId,
      command_id: commandId,
      content_type: contentType,
      chunk_seq: 0,
      enc_v: e2e.encV,
    });
  } catch (err) {
    const failPayload = {
      command_id: commandId,
      status: 'failed',
      trace_id: traceId,
      error: 'e2e_decrypt_failed',
      result: {},
    };
    sendToXiotbox(commandId, 'failed', traceId, {}, failPayload.error);
    setCachedResult(commandId, failPayload);
    return;
  }

  const replyPeers = e2e.collectReplyPeers(incoming);
  if (!replyPeers.length) {
    const failPayload = {
      command_id: commandId,
      status: 'failed',
      trace_id: traceId,
      error: e2e.peerTrustError || 'e2e_peer_missing',
      result: {},
    };
    sendToXiotbox(commandId, 'failed', traceId, {}, failPayload.error);
    setCachedResult(commandId, failPayload);
    return;
  }

  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
    const failPayload = {
      command_id: commandId,
      status: 'failed',
      trace_id: traceId,
      error: 'gateway_not_connected',
      result: {},
    };
    sendToXiotbox(commandId, 'failed', traceId, {}, failPayload.error);
    setCachedResult(commandId, failPayload);
    return;
  }

  const reqId = `cmd_${commandId}_${Date.now()}`;
  const ctx = {
    reqId,
    runId: '',
    commandId,
    traceId,
    contentType,
    threadId,
    replyPeers,
    chunkSeq: 0,
    lastStreamAt: 0,
    buffer: '',
  };
  pendingByReqId.set(reqId, ctx);

  gatewayWs.send(
    JSON.stringify({
      type: 'req',
      id: reqId,
      method: 'agent',
      params: {
        agentId: AGENT_ID,
        message: text,
        deliver: false,
        sessionKey: `xiotbox:${XIOTBOX_CONFIG.DEVICE_ID}`,
      },
    }),
  );
}

async function connectToXiotBox() {
  e2e.init();
  try {
    await e2e.refreshPeerKey();
  } catch (err) {
    console.warn(`[Bridge] E2E peer key not ready: ${err?.message || err}`);
  }

  XIOTBOX_CONFIG.HELLO_EXTRA = {
    e2e: e2e.helloPayload(),
    thread_id: e2e.threadId || undefined,
  };
  xiotboxClient = new WSSClient(XIOTBOX_CONFIG);
  xiotboxClient.setHelloExtra(XIOTBOX_CONFIG.HELLO_EXTRA);

  xiotboxClient.on('connected', () => {
    console.log('[Bridge] Connected to XiotBox Gateway');
    e2e.refreshPeerKey().catch((err) => {
      console.warn(`[Bridge] E2E peer key refresh failed: ${err?.message || err}`);
    });
  });
  xiotboxClient.on('disconnected', () => {
    console.warn('[Bridge] Disconnected from XiotBox');
  });
  xiotboxClient.on('error', (err) => {
    console.error('[Bridge] XiotBox client error:', err.message);
  });
  xiotboxClient.on('COMMAND', (payload) => {
    handleXiotBoxCommand(payload).catch((err) => {
      const commandId = payload?.command_id;
      const traceId = payload?.trace_id || payload?.payload?.trace_id || null;
      if (!commandId) return;
      const message = err?.message || 'bridge_command_error';
      console.error(`[Bridge] Command failed commandId=${commandId}: ${message}`);
      sendToXiotbox(commandId, 'failed', traceId, {}, message);
      setCachedResult(commandId, {
        command_id: commandId,
        status: 'failed',
        trace_id: traceId,
        error: message,
        result: {},
      });
    });
  });

  await xiotboxClient.connect();
}

async function main() {
  console.log('--- XiotBox OpenClaw Bridge Starting (E2E) ---');
  console.log(
    `[Bridge] remote streaming disabled (STREAMING=${XIOTBOX_CONFIG.STREAMING})`,
  );
  connectToGateway();
  await connectToXiotBox();
}

main().catch((err) => {
  console.error('[Bridge] FATAL:', err);
  process.exit(1);
});
