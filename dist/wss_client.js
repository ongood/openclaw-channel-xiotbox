import WebSocket from 'ws';
import { EventEmitter } from 'events';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pkg;
try {
    pkg = require('./package.json');
}
catch (err) {
    pkg = require('../package.json');
}
/**
 * WSS 客户端
 * 负责与 XiotBox Gateway 的 WebSocket 连接管理
 */
class WSSClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.ws = null;
        this.seq = 0; // 消息序列号
        this.reconnectDelay = 1000; // 初始重连延迟 1 秒
        this.maxReconnectDelay = 60000; // 最大重连延迟 60 秒
        this.heartbeatInterval = null;
        this.isManualDisconnect = false; // 是否手动断开
        this.outbox = [];
        this.maxOutbox = config.OUTBOX_MAX || 200;
        this.outboxTtlMs = config.OUTBOX_TTL_MS || 5 * 60 * 1000;
        this.helloExtra = config.HELLO_EXTRA || {};
        // Default to chat only. Control scope should be enabled on the device that executes
        // control actions (e.g. XiotBox Android Control Agent), not on the host OpenClaw.
        this.scopes = Array.isArray(config.SCOPES) ? config.SCOPES : ['chat'];
        this.controlActions = Array.isArray(config.CONTROL_ACTIONS) ? config.CONTROL_ACTIONS : [];
        this.parseWarnWindowMs = 10000;
        this.parseWarnSuppressed = 0;
        this.lastParseWarnAt = 0;
    }
    /**
     * 连接到 Gateway
     */
    async connect() {
        return new Promise((resolve, reject) => {
            this.isManualDisconnect = false;
            // 构建 WSS URL（附带设备凭证）
            const url = this._buildWsUrl();
            console.log('[WSS] Connecting to gateway...');
            this.ws = new WebSocket(url, {
                headers: {
                    'User-Agent': `openclaw-xiotbox/${pkg.version}`,
                    ...(this.config.DEVICE_TOKEN ? { 'Authorization': `Bearer ${this.config.DEVICE_TOKEN}` } : {}),
                    ...(this.config.DEVICE_ID ? { 'X-Device-Id': this.config.DEVICE_ID } : {}),
                    ...(this.scopes.length ? { 'X-OpenClaw-Scopes': this.scopes.join(',') } : {}),
                }
            });
            // 连接成功
            this.ws.on('open', () => {
                console.log('[WSS] Connection established');
                this.reconnectDelay = 1000; // 重置退避延迟
                this.emit('connected');
                // 发送 HELLO（上报设备信息）
                this.sendHello();
                // 开始心跳
                this.startHeartbeat();
                // 发送离线期间积压的消息
                this.flushOutbox();
                resolve();
            });
            // 接收消息
            this.ws.on('message', (data, isBinary) => {
                this._onRawMessage(data, isBinary);
            });
            // 连接关闭
            this.ws.on('close', (code, reason) => {
                console.log(`[WSS] Connection closed (code: ${code}, reason: ${reason || 'none'})`);
                this.emit('disconnected');
                this.stopHeartbeat();
                this.ws = null;
                // 如果不是手动断开，则自动重连
                if (!this.isManualDisconnect) {
                    this.scheduleReconnect();
                }
            });
            // 连接错误
            this.ws.on('error', (err) => {
                console.error('[WSS] Connection error:', err.message);
                this.emit('error', err);
                // 如果还在连接阶段，reject Promise
                if (this.ws.readyState === WebSocket.CONNECTING) {
                    reject(err);
                }
            });
        });
    }
    /**
     * 断开连接（手动）
     */
    async disconnect() {
        this.isManualDisconnect = true;
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close(1000, 'Manual disconnect');
        }
    }
    /**
     * 计划重连（指数退避 + 抖动）
     */
    scheduleReconnect() {
        // 指数退避 + 随机抖动（避免集中重连）
        const jitter = Math.random() * 1000;
        const delay = Math.min(this.reconnectDelay + jitter, this.maxReconnectDelay);
        console.log(`[WSS] Reconnecting in ${Math.round(delay / 1000)}s...`);
        setTimeout(() => {
            this.connect().catch(err => {
                console.error('[WSS] Reconnect failed:', err.message);
            });
        }, delay);
        // 指数增长（1s -> 2s -> 4s -> 8s -> ... -> 60s）
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }
    /**
     * 发送 HELLO 消息（上报设备信息）
     */
    sendHello() {
        const payload = {
            version: pkg.version,
            capabilities: {
                commands: ['help', 'status', 'ping', 'version'],
                streaming: false, // 暂不支持流式输出
                max_command_length: 10000,
                control_actions: this.controlActions,
                scopes: this.scopes,
            },
            runtime: {
                platform: process.platform,
                arch: process.arch,
                node_version: process.version,
                hostname: os.hostname()
            }
        };
        // Merge so late-bound config.HELLO_EXTRA still works even if helloExtra was
        // initialized as an empty object at construction time.
        const extra = { ...(this.config?.HELLO_EXTRA || {}), ...(this.helloExtra || {}) };
        if (extra.thread_id) {
            payload.thread_id = extra.thread_id;
        }
        if (extra.e2e) {
            payload.e2e = extra.e2e;
        }
        this.sendMessage('HELLO', payload);
        console.log('[WSS] Sent HELLO');
    }
    setHelloExtra(extra) {
        this.helloExtra = extra || {};
    }
    /**
     * 开始心跳（15 秒间隔）
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.sendMessage('HEARTBEAT', {
                // Keep plugin_version fresh on server even when no reconnect/HELLO.
                version: pkg.version,
                runtime: {
                    platform: process.platform,
                    arch: process.arch,
                    node_version: process.version,
                    hostname: os.hostname()
                },
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                cpu: process.cpuUsage()
            });
        }, 15000); // 15 秒心跳
    }
    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    /**
     * 发送消息（统一信封格式）
     */
    sendMessage(type, payload) {
        const envelope = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type,
            ts: Date.now(),
            device_id: this.config.DEVICE_ID,
            seq: ++this.seq,
            trace_id: payload.trace_id || null,
            payload
        };
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(envelope));
        }
        else {
            // 缓存到队列，等重连后再发送
            this._enqueue(envelope);
            console.warn(`[WSS] Cannot send message: connection not open (state: ${this.ws ? this.ws.readyState : 'null'})`);
        }
    }
    /**
     * 处理接收到的消息
     */
    handleMessage(msg) {
        const { type, payload } = msg;
        switch (type) {
            case 'HEARTBEAT_ACK':
                // 心跳响应，静默处理
                break;
            case 'COMMAND':
                // 触发命令事件（由 channel 处理）
                this.emit('COMMAND', payload);
                break;
            case 'CONTROL':
                this.emit('CONTROL', payload);
                break;
            case 'ERROR':
                console.error('[WSS] Server error:', payload);
                if (payload.code === 'REAUTH_REQUIRED') {
                    console.error('[WSS] Token invalid or revoked, remote channel will pause until reconfigured');
                    // Do not terminate the whole OpenClaw gateway process.
                    // Remote XiotBox channel auth failure must not break local gateway APIs.
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.close(4001, 'XiotBox reauth required');
                    }
                    this.emit('auth_required', payload);
                }
                break;
            default:
                console.warn('[WSS] Unknown message type:', type);
        }
    }
    _onRawMessage(data, isBinary = false) {
        const text = this._extractJsonText(data, isBinary);
        if (!text)
            return;
        try {
            const msg = JSON.parse(text);
            if (!msg || typeof msg !== 'object') {
                this._warnParseIssue('non-object JSON payload', text);
                return;
            }
            this.handleMessage(msg);
        }
        catch (err) {
            this._warnParseIssue(`invalid JSON (${err.message})`, text);
        }
    }
    _extractJsonText(data, isBinary = false) {
        let text = '';
        if (typeof data === 'string') {
            text = data;
        }
        else if (Buffer.isBuffer(data)) {
            text = data.toString('utf8');
        }
        else if (Array.isArray(data)) {
            text = Buffer.concat(data).toString('utf8');
        }
        else if (data instanceof ArrayBuffer) {
            text = Buffer.from(data).toString('utf8');
        }
        else {
            this._warnParseIssue('unsupported frame payload type', typeof data);
            return null;
        }
        const trimmed = text.trim();
        if (!trimmed)
            return null;
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            this._warnParseIssue(isBinary ? 'binary non-json frame' : 'text non-json frame', trimmed);
            return null;
        }
        return trimmed;
    }
    _warnParseIssue(reason, payload) {
        const now = Date.now();
        const preview = String(payload || '').replace(/\s+/g, ' ').slice(0, 120);
        if (now - this.lastParseWarnAt >= this.parseWarnWindowMs) {
            if (this.parseWarnSuppressed > 0) {
                console.warn(`[WSS] Suppressed ${this.parseWarnSuppressed} non-JSON frame(s)`);
            }
            this.parseWarnSuppressed = 0;
            this.lastParseWarnAt = now;
            console.warn(`[WSS] Ignored inbound frame: ${reason}${preview ? `; preview="${preview}"` : ''}`);
            return;
        }
        this.parseWarnSuppressed += 1;
    }
    /**
     * 构建连接 URL（默认不在 query 中传 token，避免日志泄露）
     */
    _buildWsUrl() {
        const baseUrl = this.config.GATEWAY_WSS_URL;
        if (!this.config.USE_QUERY_AUTH) {
            return baseUrl;
        }
        try {
            const urlObj = new URL(baseUrl);
            urlObj.searchParams.set('device_id', this.config.DEVICE_ID);
            urlObj.searchParams.set('token', this.config.DEVICE_TOKEN);
            return urlObj.toString();
        }
        catch (err) {
            // fallback
            return `${baseUrl}?device_id=${encodeURIComponent(this.config.DEVICE_ID)}&token=${encodeURIComponent(this.config.DEVICE_TOKEN)}`;
        }
    }
    _enqueue(envelope) {
        const now = Date.now();
        this.outbox.push({ envelope, ts: now });
        // trim oldest
        while (this.outbox.length > this.maxOutbox) {
            this.outbox.shift();
        }
    }
    flushOutbox() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        const now = Date.now();
        const pending = this.outbox;
        this.outbox = [];
        for (const item of pending) {
            if (now - item.ts > this.outboxTtlMs)
                continue;
            try {
                this.ws.send(JSON.stringify(item.envelope));
            }
            catch (err) {
                // re-queue if send fails
                this._enqueue(item.envelope);
                break;
            }
        }
    }
}
export default WSSClient;
