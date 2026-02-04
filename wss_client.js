const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * WSS 客户端
 * 负责与 XiotBox Gateway 的 WebSocket 连接管理
 */
class WSSClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.ws = null;
        this.seq = 0;  // 消息序列号
        this.reconnectDelay = 1000;  // 初始重连延迟 1 秒
        this.maxReconnectDelay = 60000;  // 最大重连延迟 60 秒
        this.heartbeatInterval = null;
        this.isManualDisconnect = false;  // 是否手动断开
    }

    /**
     * 连接到 Gateway
     */
    async connect() {
        return new Promise((resolve, reject) => {
            // 构建 WSS URL（附带设备凭证）
            const url = `${this.config.GATEWAY_WSS_URL}?device_id=${encodeURIComponent(this.config.DEVICE_ID)}&token=${encodeURIComponent(this.config.DEVICE_TOKEN)}`;

            console.log('[WSS] Connecting to gateway...');

            this.ws = new WebSocket(url, {
                headers: {
                    'User-Agent': `openclaw-xiotbox/${require('./package.json').version}`
                }
            });

            // 连接成功
            this.ws.on('open', () => {
                console.log('[WSS] Connection established');
                this.reconnectDelay = 1000;  // 重置退避延迟
                this.emit('connected');

                // 发送 HELLO（上报设备信息）
                this.sendHello();

                // 开始心跳
                this.startHeartbeat();

                resolve();
            });

            // 接收消息
            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.handleMessage(msg);
                } catch (err) {
                    console.error('[WSS] Failed to parse message:', err.message);
                }
            });

            // 连接关闭
            this.ws.on('close', (code, reason) => {
                console.log(`[WSS] Connection closed (code: ${code}, reason: ${reason || 'none'})`);
                this.emit('disconnected');
                this.stopHeartbeat();

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
        this.sendMessage('HELLO', {
            version: require('./package.json').version,
            capabilities: {
                commands: ['help', 'status', 'ping', 'version'],
                streaming: false,  // 暂不支持流式输出
                max_command_length: 10000
            },
            runtime: {
                platform: process.platform,
                arch: process.arch,
                node_version: process.version,
                hostname: require('os').hostname()
            }
        });

        console.log('[WSS] Sent HELLO');
    }

    /**
     * 开始心跳（15 秒间隔）
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.sendMessage('HEARTBEAT', {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                cpu: process.cpuUsage()
            });
        }, 15000);  // 15 秒心跳
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
        } else {
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
                // 触发命令事件（由 index.js 处理）
                this.emit('COMMAND', payload);
                break;

            case 'ERROR':
                console.error('[WSS] Server error:', payload);
                if (payload.code === 'REAUTH_REQUIRED') {
                    console.error('[WSS] Token invalid or revoked, please re-pair this device');
                    process.exit(1);
                }
                break;

            default:
                console.warn('[WSS] Unknown message type:', type);
        }
    }
}

module.exports = WSSClient;
