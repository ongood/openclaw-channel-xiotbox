# OpenClaw XiotBox Channel

OpenClaw channel integration for XiotBox Gateway.

Supports two running modes:
1.  **Plugin Mode**: Installed via `openclaw plugins install`. Runs inside OpenClaw.
2.  **Bridge Mode**: Runs as a standalone process (like `feishu-openclaw`). Connects to OpenClaw Gateway via WebSocket.

## Mode 1: Plugin Mode (Recommended for simplicity)

Install directly into OpenClaw:

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.9
```

配置将在 OpenClaw 插件设置界面中进行。

> ⚠️ 本插件采用 **TS 开发 + dist 发布**（Feishu 路线）。  
> 运行时入口为 `dist/index.js`，`dist/` 已提交到仓库，`openclaw plugins install ...` 后无需额外 build。  
> 如果你在本地改了源码（`src/` 或 `index.ts`），请手动执行：
>
> ```bash
> npm install
> npm run build
> ```

### 插件升级（推荐）
OpenClaw CLI 不支持覆盖安装，升级请使用脚本自动清理并重装：

```bash
bash scripts/update_openclaw_xiotbox.sh 1.0.9
```

如果你的插件目录或配置文件不在默认路径，可通过环境变量指定：
`OPENCLAW_EXT_DIR` 与 `OPENCLAW_CONFIG`。脚本默认保留 `channels.xiotbox` 配置。
如需同时清理 `channels.xiotbox`，可设置 `OPENCLAW_WIPE_CHANNELS=1`。

脚本会自动备份并临时移除 `channels.xiotbox`，安装完成后再回填并补齐基础字段：
`GATEWAY_WSS_URL` / `DEVICE_ID` / `DEVICE_TOKEN`。若缺失会自动打开编辑器（默认 `nano`）。
如不希望自动打开编辑器，可设置 `OPENCLAW_AUTO_EDIT=0`。

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
# (socketd WS 默认端口通常为 9002，可按实际部署设置)
XIOTBOX_GATEWAY_WSS=wss://your-xiotbox-server.com:9002/ws/openclaw
XIOTBOX_DEVICE_ID=your_device_id
XIOTBOX_DEVICE_TOKEN=your_device_token
# Optional: HTTP API base (used for E2E peer key fetch)
# XIOTBOX_API_BASE=https://your-xiotbox-server.com
# Optional: E2E key storage path / rotation
# XIOTBOX_E2E_KEY_PATH=/var/lib/openclaw/xiotbox_e2e.json
# XIOTBOX_E2E_ROTATE=1
# 可选：如果网关只支持 query 认证，设置为 true
# USE_QUERY_AUTH=true
# Or use PAIR_CODE for first time setup if supported by wss_client
# PAIR_CODE=...
```

### Run

```bash
npm start
```

## Architecture

- **Plugin Mode**: `index.ts` registers as an OpenClaw Channel Plugin and dispatches to OpenClaw runtime.
- **Bridge Mode**: `bridge.js` connects to OpenClaw Gateway as an Operator Client.

## License

MIT
