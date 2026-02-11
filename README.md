# OpenClaw XiotBox Channel

OpenClaw channel integration for XiotBox Gateway.

Supports two running modes:
1.  **Plugin Mode**: Installed via `openclaw plugins install`. Runs inside OpenClaw.
2.  **Bridge Mode**: Runs as a standalone process (like `feishu-openclaw`). Connects to OpenClaw Gateway via WebSocket.

## Mode 1: Plugin Mode (Recommended for simplicity)

Install directly into OpenClaw:

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.26
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
bash scripts/update_openclaw_xiotbox.sh 1.0.26
```

如果你的插件目录或配置文件不在默认路径，可通过环境变量指定：
`OPENCLAW_EXT_DIR` 与 `OPENCLAW_CONFIG`。默认安装目录为 `~/.openclaw/extensions/xiotbox`。

脚本会自动统一并迁移以下配置键（旧键会被删除）：
`plugins.entries.xiotbox` / `plugins.installs.xiotbox` / `channels.xiotbox`。

脚本会自动备份并临时移除渠道配置，安装完成后回填并补齐基础字段：
`GATEWAY_WSS_URL` / `DEVICE_ID` / `DEVICE_TOKEN`。若缺失会自动打开编辑器（默认 `nano`）。
如不希望自动打开编辑器，可设置 `OPENCLAW_AUTO_EDIT=0`。

如需忽略旧渠道配置回填（全新配置），可设置 `OPENCLAW_WIPE_CHANNELS=1`。

### BotDrop / Termux / proot 兼容安装

已提供专项文档与自动化脚本：

- 文档：`docs/plugins-git-install-termux.md`
- 一键测试：`scripts/test_install_xiotbox_termux.sh`
- 一键安装+配置+重启网关：`scripts/install_configure_xiotbox.sh`

示例：

```bash
bash scripts/test_install_xiotbox_termux.sh \
  https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.26
```

推荐（Android/BotDrop）直接使用一键安装配置脚本：

```bash
bash scripts/install_configure_xiotbox.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.26 \
  1
```

说明：
- 该脚本会调用 `update_openclaw_xiotbox.sh` 完成重装与配置归一化。
- Android 默认跳过 `openclaw doctor --fix`，避免 `Gateway service install not supported on android` 干扰。
- Android 默认自动重启 gateway（可通过环境变量 `OPENCLAW_RESTART_GATEWAY=0` 关闭）。

### BotDrop 下仅命令行配置 DeepSeek（绕开 UI 覆盖问题）

如果 BotDrop Setup/Dashboard UI 会覆盖你手工改的 `~/.openclaw/openclaw.json`，直接使用：

```bash
bash scripts/configure_deepseek_termux.sh <DEEPSEEK_API_KEY> deepseek-chat
```

该脚本会：
1. 写入 `~/.openclaw/openclaw.json` 的 `agents.defaults.model.primary=deepseek/<model>`
2. 写入 `~/.openclaw/agents/main/agent/auth-profiles.json`
3. 默认删除 BotDrop 模板缓存（避免再次自动覆盖）
4. 默认重启 `openclaw gateway`

如需保留模板缓存：

```bash
CLEAR_BOTDROP_TEMPLATE=0 bash scripts/configure_deepseek_termux.sh <DEEPSEEK_API_KEY> deepseek-chat
```

### 从旧版本升级（openclaw-channel-xiotbox -> xiotbox）

```bash
bash scripts/update_openclaw_xiotbox.sh 1.0.26
openclaw plugins list
openclaw channels list
```

升级脚本会自动执行一次性迁移：
- 旧目录 `~/.openclaw/extensions/openclaw-channel-xiotbox` -> 新目录 `~/.openclaw/extensions/xiotbox`
- 旧键 `plugins.entries.openclaw-channel-xiotbox` / `plugins.installs.openclaw-channel-xiotbox` -> `*.xiotbox`
- 若存在 `channels.openclaw-channel-xiotbox`，会与 `channels.xiotbox` 合并后统一写回 `channels.xiotbox`

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
# Optional: HTTP API base (required when WSS host is socketd domain)
# If not set and /openclaw/devices/e2e/peer_key returns 404, set this.
# XIOTBOX_API_BASE=https://your-odoo-api.com
# Optional: E2E key storage path / rotation
# XIOTBOX_E2E_KEY_PATH=/var/lib/openclaw/xiotbox_e2e.json
# XIOTBOX_E2E_ROTATE=1
# Optional: identity key (ed25519) + trust DB (pinned client identity)
# XIOTBOX_IDENTITY_KEY_PATH=/var/lib/openclaw/xiotbox_identity.json
# XIOTBOX_TRUST_PATH=/var/lib/openclaw/xiotbox_trust.json
# Optional: enroll additional client identity once (for multi-endpoint PC+iOS)
# Keep disabled by default; enable briefly during first pairing on a new endpoint.
# XIOTBOX_ALLOW_NEW_CLIENT_IDENTITIES=1
# Optional: x25519 backend (default uses noble JS implementation)
# XIOTBOX_FORCE_NOBLE_X25519=1
# If you want to try native x25519 when supported:
# XIOTBOX_PREFER_NATIVE_X25519=1
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

## Release Checklist

每次插件更新/发布请按：`RELEASE_CHECKLIST.md`

## License

MIT
