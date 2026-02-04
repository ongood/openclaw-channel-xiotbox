require('dotenv').config();
const WSSClient = require('./wss_client');

class XiotBoxChannel {
    constructor(openclaw) {
        this.openclaw = openclaw;
        this.client = null;
    }

    async onStart() {
        console.log('[XiotBox] Plugin starting...');

        // Load config from environment variables
        // These should be set in OpenClaw's running environment or .env file
        const config = {
            GATEWAY_WSS_URL: process.env.XIOTBOX_GATEWAY_WSS || 'ws://localhost:8069/ws/openclaw',
            DEVICE_ID: process.env.XIOTBOX_DEVICE_ID || 'unknown_device',
            DEVICE_TOKEN: process.env.XIOTBOX_DEVICE_TOKEN || 'unknown_token'
        };

        if (!config.DEVICE_ID || !config.DEVICE_TOKEN) {
            console.warn('[XiotBox] Missing required configuration (DEVICE_ID, DEVICE_TOKEN). Please check .env file.');
        }

        this.client = new WSSClient(config);

        // Handle commands received from WSS
        this.client.on('COMMAND', (payload) => {
            this._handleCommand(payload);
        });

        // Connect
        try {
            await this.client.connect();
        } catch (err) {
            console.error('[XiotBox] Failed to connect:', err);
        }
    }

    async onStop() {
        console.log('[XiotBox] Plugin stopping...');
        if (this.client) {
            await this.client.disconnect();
            this.client = null;
        }
    }

    /**
     * Handle commands from XiotBox backend
     */
    async _handleCommand(cmdPayload) {
        console.log('[XiotBox] Received command:', cmdPayload);

        // Ensure command has tracking info
        const cmdId = cmdPayload.command_id;
        if (!cmdId) return;

        // Execute command using OpenClaw's internal API if availble, or simple exec
        // Example: if cmdPayload is { text: "/ping" }
        // We can simulate an input to OpenClaw runner

        let resultData = {};
        let status = 'success';
        let error = null;

        try {
            // TODO: Integrate with OpenClaw's command executor
            // For now, we just echo back the received command as a placeholder execution

            // Simulating execution result
            if (cmdPayload && cmdPayload.payload && cmdPayload.payload.text) {
                const text = cmdPayload.payload.text;
                if (text === '/ping') {
                    resultData = { output: 'pong from xiotbox plugin' };
                } else {
                    resultData = { output: `Executed: ${text}` };
                }
            } else {
                resultData = { output: 'Empty command' };
            }

        } catch (e) {
            status = 'failed';
            error = e.message;
        }

        // Report result back to XiotBox (need to implement updateCommand in WSSClient)
        // Currently WSSClient.handleMessage only emits 'COMMAND'.
        // We need a way to send response back using `sendMessage`.

        // Extending WSSClient usage:
        if (this.client) {
            this.client.sendMessage('COMMAND_RESULT', {
                command_id: cmdId,
                status: status,
                result: resultData,
                error: error
            });
        }
    }
}

module.exports = XiotBoxChannel;
