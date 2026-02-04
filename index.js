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
                DEVICE_TOKEN: channelCfg.DEVICE_TOKEN || process.env.XIOTBOX_DEVICE_TOKEN
            };

            if (!finalCfg.DEVICE_ID || !finalCfg.DEVICE_TOKEN) {
                const err = 'Missing XiotBox configuration (DEVICE_ID or DEVICE_TOKEN).';
                log?.error?.(`[XiotBox] ${err}`);
                throw new Error(err);
            }

            const client = new WSSClient(finalCfg);

            // Command Handling
            client.on('COMMAND', (payload) => {
                log?.info?.('[XiotBox] Received command:', payload);

                // Echo execution logic (can be replaced with actual agent logic)
                const cmdId = payload.command_id;
                if (cmdId) {
                    const text = payload.payload?.text || '';
                    const resultData = { output: `Executed: ${text}` };

                    if (text === '/ping') {
                        resultData.output = 'pong';
                    }

                    client.sendMessage('COMMAND_RESULT', {
                        command_id: cmdId,
                        status: 'success',
                        result: resultData
                    });
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
