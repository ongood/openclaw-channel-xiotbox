require('dotenv').config();
const WSSClient = require('./wss_client');

/**
 * XiotBox Channel Plugin Definition
 */
const xiotboxPlugin = {
    id: 'xiotbox',

    // Runtime lifecycle management
    runtime: {
        start: async (ctx) => {
            const { cfg, log } = ctx;
            log?.info?.('[XiotBox] Initializing XiotBox channel...');

            // Extract config: try channel-specific, then plugin root, then env
            const channelCfg = cfg?.channels?.xiotbox || {};

            const finalCfg = {
                GATEWAY_WSS_URL: channelCfg.GATEWAY_WSS_URL || process.env.XIOTBOX_GATEWAY_WSS || 'ws://localhost:8069/ws/openclaw',
                DEVICE_ID: channelCfg.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID,
                DEVICE_TOKEN: channelCfg.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN,
                USE_QUERY_AUTH: channelCfg.USE_QUERY_AUTH || false
            };

            if (!finalCfg.DEVICE_ID || !finalCfg.DEVICE_TOKEN) {
                const err = 'Missing XiotBox configuration (DEVICE_ID or DEVICE_TOKEN).';
                log?.error?.(`[XiotBox] ${err}`);
                throw new Error(err);
            }

            const client = new WSSClient(finalCfg);
            const cacheTtlMs = channelCfg.COMMAND_CACHE_TTL_MS || 10 * 60 * 1000;
            const cacheMax = channelCfg.COMMAND_CACHE_MAX || 500;
            const commandCache = new Map(); // cmdId -> { ts, payload }

            const _pruneCache = () => {
                const now = Date.now();
                for (const [id, entry] of commandCache.entries()) {
                    if (now - entry.ts > cacheTtlMs) {
                        commandCache.delete(id);
                    }
                }
                // 限制缓存大小
                while (commandCache.size > cacheMax) {
                    const firstKey = commandCache.keys().next().value;
                    commandCache.delete(firstKey);
                }
            };

            const _getCached = (cmdId) => {
                _pruneCache();
                return commandCache.get(cmdId)?.payload || null;
            };

            const _setCached = (cmdId, payload) => {
                _pruneCache();
                commandCache.set(cmdId, { ts: Date.now(), payload });
            };

            // Command Handling
            client.on('COMMAND', async (payload) => {
                log?.info?.('[XiotBox] Received command:', payload);

                // Echo execution logic (can be replaced with actual agent logic)
                const cmdId = payload.command_id;
                if (cmdId) {
                    const cached = _getCached(cmdId);
                    if (cached) {
                        client.sendMessage('COMMAND_RESULT', cached);
                        return;
                    }

                    const traceId = payload.trace_id || payload.payload?.trace_id || null;

                    // ACK
                    client.sendMessage('COMMAND_RESULT', {
                        command_id: cmdId,
                        status: 'acked',
                        trace_id: traceId,
                        result: {}
                    });

                    try {
                        const text = payload.payload?.text || payload.text || '';
                        const resultData = {
                            output: `Executed: ${text}`,
                            output_text: `Executed: ${text}`
                        };

                        if (text === '/ping') {
                            resultData.output = 'pong';
                            resultData.output_text = 'pong';
                        }

                        const resultPayload = {
                            command_id: cmdId,
                            status: 'success',
                            trace_id: traceId,
                            result: resultData
                        };

                        client.sendMessage('COMMAND_RESULT', resultPayload);
                        _setCached(cmdId, resultPayload);
                    } catch (err) {
                        const failPayload = {
                            command_id: cmdId,
                            status: 'failed',
                            trace_id: traceId,
                            error: err?.message || 'Execution failed',
                            result: {}
                        };
                        client.sendMessage('COMMAND_RESULT', failPayload);
                        _setCached(cmdId, failPayload);
                    }
                }
            });

            client.on('connected', () => {
                log?.info?.('[XiotBox] Connected to Gateway');
            });

            client.on('disconnected', () => {
                log?.warn?.('[XiotBox] Disconnected from Gateway');
            });

            client.on('error', (err) => {
                log?.error?.(`[XiotBox] Client error: ${err.message}`);
            });

            // Start connection
            await client.connect();

            // Return stop handler
            return {
                stop: async () => {
                    log?.info?.('[XiotBox] Stopping channel...');
                    await client.disconnect();
                }
            };
        }
    },

    status: {
        probe: async ({ cfg }) => {
            // Simple probe to check if config exists
            const channelCfg = cfg?.channels?.xiotbox || {};
            if (channelCfg.DEVICE_ID || process.env.XIOTBOX_DEVICE_ID) {
                return { ok: true };
            }
            return { ok: false, error: 'Not configured' };
        }
    }
};

module.exports = {
    id: 'xiotbox',
    name: 'XiotBox Channel',
    description: 'Integration with XiotBox Gateway via WebSocket.',
    register: (api) => {
        // Register the channel implementation
        api.registerChannel({ plugin: xiotboxPlugin });
    }
};
