# OpenClaw XiotBox Channel

OpenClaw channel integration for XiotBox Gateway.

Supports two running modes:
1.  **Plugin Mode**: Installed via `openclaw plugins install`. Runs inside OpenClaw.
2.  **Bridge Mode**: Runs as a standalone process (like `feishu-openclaw`). Connects to OpenClaw Gateway via WebSocket.

## Mode 1: Plugin Mode (Recommended for simplicity)

Install directly into OpenClaw:

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0
```

配置将在 OpenClaw 插件设置界面中进行。

## Mode 2: Bridge Mode (Recommended for stability/media)

Run as a standalone service that bridges XiotBox to a local OpenClaw Gateway.

### Prerequisites
- Node.js >= 18
- OpenClaw Gateway running (default port `18789`)
- Gateway Token (from OpenClaw config)

### Installation

```bash
git clone https://github.com/ongood/openclaw-channel-xiotbox.git
cd openclaw-channel-xiotbox
npm install
```

### Configuration (.env)

Create a `.env` file:

```ini
# OpenClaw Gateway Connection
OPENCLAW_GATEWAY_HOST=127.0.0.1
OPENCLAW_GATEWAY_PORT=18789
GATEWAY_TOKEN=your_gateway_token_here
CLAWDBOT_AGENT_ID=main

# XiotBox Connection
XIOTBOX_GATEWAY_WSS=wss://your-xiotbox-server.com/ws/openclaw
XIOTBOX_DEVICE_ID=your_device_id
XIOTBOX_DEVICE_TOKEN=your_device_token
# Or use PAIR_CODE for first time setup if supported by wss_client
# PAIR_CODE=...
```

### Run

```bash
npm start
```

## Architecture

- **Plugin Mode**: `index.js` registers as an OpenClaw Channel Plugin.
- **Bridge Mode**: `bridge.js` connects to OpenClaw Gateway as an Operator Client.

## License

MIT