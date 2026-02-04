/**
 * XiotBox Standalone Bridge
 * 
 * Bridges XiotBox Gateway (via WSS) to OpenClaw Gateway (via Local WS).
 * Allows XiotBox devices to interact with OpenClaw Agents.
 */

require('dotenv').config();
const WebSocket = require('ws');
const WSSClient = require('./wss_client');

// Configuration
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || 18789;
const GATEWAY_HOST = process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN; // Required for bridge mode
const AGENT_ID = process.env.CLAWDBOT_AGENT_ID || 'main';

// XiotBox Config
const XIOTBOX_CONFIG = {
    GATEWAY_WSS_URL: process.env.XIOTBOX_GATEWAY_WSS || 'ws://localhost:8069/ws/openclaw',
    DEVICE_ID: process.env.XIOTBOX_DEVICE_ID,
    DEVICE_TOKEN: process.env.XIOTBOX_DEVICE_TOKEN
};

if (!GATEWAY_TOKEN) {
    console.error('[Bridge] FATAL: GATEWAY_TOKEN is required in .env');
    process.exit(1);
}

if (!XIOTBOX_CONFIG.DEVICE_ID || !XIOTBOX_CONFIG.DEVICE_TOKEN) {
    console.error('[Bridge] FATAL: XIOTBOX_DEVICE_ID and DEVICE_TOKEN are required');
    process.exit(1);
}

// Global state
let gatewayWs = null;
let xiotboxClient = null;
const pendingRequests = new Map(); // runId -> { commandId, ... }

// --------------------------------------------------------------------------
// OpenClaw Gateway Connection
// --------------------------------------------------------------------------

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
    // 1. Handshake Challenge
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
        console.log('[Bridge] Received challenge, sending connect request...');
        gatewayWs.send(JSON.stringify({
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
                userAgent: 'xiotbox-bridge'
            }
        }));
        return;
    }

    // 2. Connect Response
    if (msg.type === 'res' && msg.id === 'connect') {
        if (msg.ok) {
            console.log('[Bridge] Gateway Handshake Successful!');
        } else {
            console.error('[Bridge] Gateway Handshake Failed:', msg.error);
            process.exit(1);
        }
        return;
    }

    // 3. Agent Response (ack for req.agent)
    if (msg.type === 'res' && msg.id.startsWith('cmd_')) {
        const commandId = msg.id.substring(4); // remove 'cmd_'
        if (!msg.ok) {
            console.error(`[Bridge] Agent request failed for cmd ${commandId}:`, msg.error);
            sendToXiotbox(commandId, 'error', { output: `Agent Error: ${msg.error?.message}` });
        } else {
            // Store runId mapping if needed
            const runId = msg.payload?.runId;
            if (runId) {
                pendingRequests.set(runId, { commandId });
            }
        }
        return;
    }

    // 4. Agent Events (Output stream)
    if (msg.type === 'event' && msg.event === 'agent') {
        handleAgentEvent(msg.payload);
        return;
    }
}

function handleAgentEvent(payload) {
    const runId = payload.runId;
    const req = pendingRequests.get(runId);
    if (!req) return; // Unknown or expired request

    // Accumulate text or handle completion
    // For simplicity, we only reply on 'lifecycle:end' with full text
    // A robust implementation might stream updates back if XiotBox supports it.

    if (!req.buffer) req.buffer = '';

    if (payload.stream === 'assistant') {
        const d = payload.data || {};
        if (d.text) req.buffer = d.text; // Full text update
        else if (d.delta) req.buffer += d.delta; // Delta update
    }

    if (payload.stream === 'lifecycle' && payload.data?.phase === 'end') {
        // Run completed
        console.log(`[Bridge] Agent run finished for cmd ${req.commandId}`);
        const resultData = {
            output: req.buffer
        };

        // Check for media in the buffer or payload?
        // Feishu bridge checks `mediaUrls` in event data.
        // Let's simplified for now.

        sendToXiotbox(req.commandId, 'success', resultData);
        pendingRequests.delete(runId);
    }

    if (payload.stream === 'lifecycle' && payload.data?.phase === 'error') {
        console.error(`[Bridge] Agent run error for cmd ${req.commandId}`);
        sendToXiotbox(req.commandId, 'failed', { output: payload.data.message });
        pendingRequests.delete(runId);
    }
}

// --------------------------------------------------------------------------
// XiotBox Connection
// --------------------------------------------------------------------------

function connectToXiotBox() {
    xiotboxClient = new WSSClient(XIOTBOX_CONFIG);

    xiotboxClient.on('connected', () => {
        console.log('[Bridge] Connected to XiotBox Gateway');
    });

    xiotboxClient.on('disconnected', () => {
        console.warn('[Bridge] Disconnected from XiotBox');
    });

    xiotboxClient.on('error', (err) => {
        console.error('[Bridge] XiotBox Client Error:', err.message);
    });

    xiotboxClient.on('COMMAND', (payload) => {
        handleXiotBoxCommand(payload);
    });

    xiotboxClient.connect();
}

function handleXiotBoxCommand(payload) {
    console.log('[Bridge] Received XiotBox command:', payload);
    const commandId = payload.command_id;
    const text = payload.payload?.text || '';

    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
        sendToXiotbox(commandId, 'failed', { output: 'Bridge not connected to AI Gateway' });
        return;
    }

    // Forward to OpenClaw Agent
    const reqId = `cmd_${commandId}`;
    gatewayWs.send(JSON.stringify({
        type: 'req',
        id: reqId,
        method: 'agent',
        params: {
            agentId: AGENT_ID,
            message: text,
            deliver: false, // We handle delivery manually
            sessionKey: `xiotbox:${XIOTBOX_CONFIG.DEVICE_ID}` // Shared session for this device
        }
    }));
}

function sendToXiotbox(commandId, status, result) {
    if (xiotboxClient) {
        xiotboxClient.sendMessage('COMMAND_RESULT', {
            command_id: commandId,
            status: status,
            result: result
        });
    }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
    console.log('--- XiotBox OpenClaw Bridge Starting ---');
    connectToGateway();
    connectToXiotBox();
}

main();
