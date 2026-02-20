# OpenClaw XiotBox Channel

OpenClaw channel integration for XiotBox Gateway.

Supports two running modes:
1.  **Plugin Mode**: Installed via `openclaw plugins install`. Runs inside OpenClaw.
2.  **Bridge Mode**: Runs as a standalone process. Connects to OpenClaw Gateway via WebSocket.

## Mode 1: Plugin Mode (Recommended for simplicity)

Install directly into OpenClaw:

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.40
```

配置将在 OpenClaw 插件设置界面中进行。

### 插件配置（单账号，XiotBox 远程通道）

`xiotbox` 插件只读取 `channels.xiotbox` 顶层配置（单账号）：

```json
{
  "channels": {
    "xiotbox": {
      "enabled": true,
      "GATEWAY_WSS_URL": "wss://socketd.odoo.games/ws/openclaw",
      "DEVICE_ID": "REMOTE_DEVICE_ID",
      "DEVICE_TOKEN": "REMOTE_DEVICE_TOKEN",
      "API_BASE_URL": "https://api.xiotbox.com",
      "ALLOW_NEW_CLIENT_IDENTITIES": 1
    }
  }
}
```

### XiotBox 客户端本地直连模式（不是插件配置）

如果你的需求是“XiotBox App 与同机 OpenClaw 直接对话（跳过 Lite / 跳过 E2E）”，
配置应写在 **客户端设置**，只需要本地网关参数：

- `enableLocalOpenClawChat = true`
- `localOpenClawGatewayBaseUrl = http://127.0.0.1:18789`
- `localOpenClawGatewayToken = <token 或空>`
- `localOpenClawAgentId = main`

本地直连模式 **不需要**：
- `DEVICE_ID`
- `DEVICE_TOKEN`
- `API_BASE_URL`

### OpenClaw 调用 XiotBox 本地控制（可选工具）

插件已内置可选 agent tool：`xiotbox_local_control`。  
它会调用 XiotBox 客户端的本地控制入口：`POST http://127.0.0.1:17777/v1/action`。

先在 `channels.xiotbox` 配置本地控制参数：

```json
{
  "channels": {
    "xiotbox": {
      "LOCAL_CONTROL_BASE_URL": "http://127.0.0.1:17777",
      "LOCAL_CONTROL_TOKEN": "YOUR_LOCAL_CONTROL_TOKEN"
    }
  }
}
```

再在 agent 工具白名单里启用（它是 optional tool）：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "xiotbox_local_control"
          ]
        }
      }
    ]
  }
}
```

工具参数示例：

```json
{
  "action": "open_app",
  "params": {
    "package": "com.tencent.mm"
  }
}
```

```json
{
  "action": "tap",
  "params": {
    "x": 520,
    "y": 1480
  }
}
```

当前可用动作（与 XiotBox Android 本地控制服务对齐）：

1. `open_app`
2. `tap`
3. `type`
4. `swipe`
5. `long_press`
6. `click_text`
7. `get_screen`
8. `get_tree`
9. `wait_ui_change`
10. `get_notifications`
11. `get_app_info`
12. `open_accessibility_settings`

### OpenClaw 远程控制手机（小主机 OpenClaw -> 手机 XiotBox Control Agent）

目标：把 OpenClaw 常驻在小主机（Linux/Mac/PC），手机只做“执行器”，通过 **同一条 XiotBox 聊天 WSS** 增加 `control` 子协议来下发动作（不新增端口）。

这套链路适合解决 BotDrop/Termux 环境下 OpenClaw 网关不稳定的问题。

#### 手机端（XiotBox Android）

1. 登录 XiotBox。
2. 打开：`OpenClaw -> 设置 -> 远程控制代理 (WSS)`。
3. 点击“生成控制 Bot”，会得到一组 `device_id / device_token`（这是**控制执行器**的身份）。
4. 配置并启用：
   - `WSS URL`: `wss://socketd.odoo.games/ws/openclaw`（按你的部署为准）
   - `Scopes`: `control`
   - 开关：开启（会以前台服务常驻）
5. 打开系统无障碍并启用 `XiotBox Control`（否则 `tap/type/click_text/get_tree` 等会失败）。

#### 小主机（OpenClaw）

1. 安装插件（插件负责 XiotBox 通道 + tool）：

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.40
```

2. 配置 `channels.xiotbox`（这是**小主机 OpenClaw**的身份，用于发起 dispatch；与手机的 control-agent 身份不同）：

```json
{
  "channels": {
    "xiotbox": {
      "enabled": true,
      "GATEWAY_WSS_URL": "wss://socketd.odoo.games/ws/openclaw",
      "DEVICE_ID": "HOST_DEVICE_ID",
      "DEVICE_TOKEN": "HOST_DEVICE_TOKEN",
      "API_BASE_URL": "https://api.xiotbox.com",
      "SCOPES": ["chat"]
    }
  }
}
```

3. 在 agent 工具白名单里启用 `xiotbox_control`（它是 optional tool）：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "xiotbox_control"
          ]
        }
      }
    ]
  }
}
```

#### Tool：`xiotbox_control`

该 tool 会通过服务端下发动作给指定手机，并且**强制“先观测后操作”**：
- 对 `tap/swipe/long_press/click_text/type`：自动插入 `get_tree`（失败再 `get_screen`）再执行动作
- 对 `open_app/tap/swipe/long_press/click_text/type`：动作后自动插入 `wait_ui_change`

此外，tool 内置一个高层动作 `launch_app`（仅 tool 内部，手机端不需要新增原子能力）：
- 输入：`{ app_name, package?, strategy?, timeout_ms? }`
- 默认策略：回到桌面（优先手势 swipe-up）→ `get_tree` → `click_text(app_name)`（exact=true 再 exact=false）→ 翻页 `swipe` 重试 → 校验（`get_app_info`）
- 兜底：仅当 UI 点击失败且提供 `package` 时，才会调用 `open_app(package)` 再校验

注意：如果你在 `open_app` 里传了 `app_name`，且未显式设置 `force_open_app/direct`，tool 会把它当成“打开某 App”的意图，自动改用 `launch_app` 流程；只有 `open_app(package=...)` 才是直启。

四组可直接复用的 `plan` 示例（对应验收用例 1/2/3 + 去重用例）：

1. `launch_app`（仅 app_name，无 package；不应调用 open_app 兜底）

```json
{
  "device_id": "PHONE_CONTROL_DEVICE_ID",
  "plan": [
    { "action": "launch_app", "params": { "app_name": "设置" } }
  ]
}
```

2. 坐标操作闭环（先 `launch_app`，后续会自动在 `tap/type` 前插入观测，在每步后插入等待）

```json
{
  "device_id": "PHONE_CONTROL_DEVICE_ID",
  "plan": [
    { "action": "launch_app", "params": { "app_name": "设置", "package": "com.android.settings" } },
    { "action": "tap", "params": { "x": 520, "y": 1480 } },
    { "action": "type", "params": { "text": "hello" } }
  ]
}
```

3. 兜底触发（故意传一个找不到的 app_name，但提供 package；应触发 open_app(package) 兜底）

```json
{
  "device_id": "PHONE_CONTROL_DEVICE_ID",
  "plan": [
    { "action": "launch_app", "params": { "app_name": "__not_exists__", "package": "com.android.settings" } }
  ]
}
```

4. 去重验证（同一个 `action_id` 重放不得重复执行；第二次应返回去重结果）

```json
{
  "device_id": "PHONE_CONTROL_DEVICE_ID",
  "plan": [
    { "action": "tap", "action_id": "A", "params": { "x": 10, "y": 10 } },
    { "action": "tap", "action_id": "A", "params": { "x": 10, "y": 10 } }
  ]
}
```

不通过 OpenClaw 也可以直接跑脚本验收（复用同一份 tool 逻辑）：

```bash
XIOTBOX_API_BASE_URL=https://api.xiotbox.com \
XIOTBOX_DEVICE_ID=HOST_DEVICE_ID \
XIOTBOX_DEVICE_TOKEN=HOST_DEVICE_TOKEN \
node scripts/run_xiotbox_control_plan.mjs --device PHONE_CONTROL_DEVICE_ID --example 1
```

> ⚠️ 本插件采用 **TS 开发 + dist 发布**。  
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
bash scripts/update_openclaw_xiotbox.sh 1.0.40
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
- 一键全流程（安装+配置+启动+验证）：`scripts/bootstrap_xiotbox_termux.sh`
- 健康检查：`scripts/health_check_xiotbox.sh`
- BotDrop 专用 OpenClaw 升级（命令行）：`scripts/upgrade_openclaw_for_botdrop_termux_proot.sh`

示例：

```bash
bash scripts/test_install_xiotbox_termux.sh \
  https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.39
```

推荐（Android/BotDrop）直接使用一键安装配置脚本：

```bash
bash scripts/install_configure_xiotbox.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.40 \
  1
```

推荐（可复现闭环）直接使用单条命令：

```bash
bash scripts/bootstrap_xiotbox_termux.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.40 \
  1 \
  <MODEL_API_KEY> \
  deepseek-chat
```

不配置模型（只验证 xiotbox + gateway）：

```bash
bash scripts/bootstrap_xiotbox_termux.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.40 \
  1 \
  -
```

说明：
- 该脚本会调用 `update_openclaw_xiotbox.sh` 完成重装与配置归一化。
- Android 默认跳过 `openclaw doctor --fix`，避免 `Gateway service install not supported on android` 干扰。
- Android 默认自动重启 gateway（可通过环境变量 `OPENCLAW_RESTART_GATEWAY=0` 关闭）。

### BotDrop 下命令行升级 OpenClaw（专用）

在部分 BotDrop/Termux/proot 环境中，`openclaw update` 可能与 Android wrapper 流程不一致。
建议使用专用脚本：

```bash
bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh
```

或指定版本：

```bash
bash scripts/upgrade_openclaw_for_botdrop_termux_proot.sh 2026.2.6
```

该脚本会按 BotDrop 安全流程执行：
1. 停 `GatewayMonitorService`（可选）
2. 停 gateway
3. `npm install -g openclaw@... --ignore-scripts --force`
4. Android 环境自动为 `koffi` 应用兼容 mock（可用 `OPENCLAW_PATCH_KOFFI_ANDROID=0` 关闭）
5. 重建 `openclaw` wrapper（termux-chroot + node）
6. 启动 gateway（可选）

### BotDrop 下仅命令行配置 DeepSeek（绕开 UI 覆盖问题）

如果 BotDrop Setup/Dashboard UI 会覆盖你手工改的 `~/.openclaw/openclaw.json`，直接使用：

```bash
bash scripts/configure_deepseek_termux.sh <API_KEY> deepseek-chat
```

该脚本会：
1. 写入 `~/.openclaw/openclaw.json` 的 `agents.defaults.model.primary=deepseek/<model>`
2. 写入 `~/.openclaw/agents/main/agent/auth-profiles.json`
3. 默认写入 `models.providers.deepseek`（`api=openai-completions` + `baseUrl=https://api.deepseek.com/v1`）
4. 默认删除 BotDrop 模板缓存（避免再次自动覆盖）
5. 默认重启 `openclaw gateway`
6. 对非 `deepseek/*` 模型，默认先校验模型是否存在于当前 `openclaw models list`，避免运行时 `Unknown model`

如果你的 OpenClaw 没有 `deepseek/deepseek-chat`，可以传完整模型名（示例）：

```bash
bash scripts/configure_deepseek_termux.sh <OPENROUTER_API_KEY> openrouter/deepseek/deepseek-chat
```

如果你想把任意 provider 当作 OpenAI 兼容端点强制写入（高级）：

```bash
WRITE_PROVIDER_CONFIG=1 OPENAI_COMPAT_BASE_URL='https://api.deepseek.com/v1' \
bash scripts/configure_deepseek_termux.sh <API_KEY> myproxy/deepseek-chat
```

如需保留模板缓存：

```bash
CLEAR_BOTDROP_TEMPLATE=0 bash scripts/configure_deepseek_termux.sh <API_KEY> deepseek-chat
```

### 从旧版本升级（openclaw-channel-xiotbox -> xiotbox）

```bash
bash scripts/update_openclaw_xiotbox.sh 1.0.40
openclaw plugins list
openclaw channels list
```

升级脚本会自动执行一次性迁移：
- 旧目录 `~/.openclaw/extensions/openclaw-channel-xiotbox` -> 新目录 `~/.openclaw/extensions/xiotbox`
- 旧键 `plugins.entries.openclaw-channel-xiotbox` / `plugins.installs.openclaw-channel-xiotbox` -> `*.xiotbox`
- 若存在 `channels.openclaw-channel-xiotbox`，会与 `channels.xiotbox` 合并后统一写回 `channels.xiotbox`
- 若检测到无效 `gateway.bind`（如旧值 `"all"`），会自动修复为合法值（默认 `auto`）
- Android 环境默认会启用 `gateway.http.endpoints.chatCompletions.enabled=true`（可通过 `XIOTBOX_ENABLE_CHAT_COMPLETIONS=0` 关闭）

## Mode 2: Bridge Mode (Process Mode, E2E aligned)

Run as a standalone service that bridges XiotBox to a local OpenClaw Gateway.
Bridge mode now uses the same XiotBox E2E envelope flow as plugin mode
(`OGE2E1`, peer refresh, trust pinning, and `e2e_multi` fanout).

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

### Configuration (config.json + secret.json)

Bridge 模式不再依赖 `.env` 里的敏感环境变量，统一使用本地配置文件（默认路径基于 `OPENCLAW_HOME`）：

- 配置文件：`$OPENCLAW_HOME/xiotbox/config.json`（默认 `~/.openclaw/xiotbox/config.json`）
- 密钥文件：`$OPENCLAW_HOME/xiotbox/secret.json`

`config.json` 里包含非敏感字段（host/port/mode/flags），示例：

```json
{
  "xiotbox": {
    "GATEWAY_WSS_URL": "wss://your-xiotbox-server.com:9002/ws/openclaw",
    "GATEWAY_API_URL": "https://api.xiotbox.com",
    "USE_QUERY_AUTH": false,
    "COMMAND_TIMEOUT": 300000,
    "OUTBOX_MAX": 200,
    "OUTBOX_TTL_MS": 300000,
    "COMMAND_CACHE_TTL_MS": 600000,
    "COMMAND_CACHE_MAX": 500,
    "STREAMING": false,
    "STREAM_THROTTLE_MS": 500,
    "PROGRESS_UPDATES": true,
    "PROGRESS_THROTTLE_MS": 1500,
    "PROGRESS_MAX_UPDATES": 12,
    "API_BASE_URL": "https://api.xiotbox.com",
    "E2E_KEY_PATH": "",
    "E2E_ROTATE": "",
    "IDENTITY_KEY_PATH": "",
    "TRUST_PATH": "",
    "ALLOW_NEW_CLIENT_IDENTITIES": 1,
    "LOCAL_CONTROL_BASE_URL": "http://127.0.0.1:17777",
    "LOCAL_CONTROL_TIMEOUT_MS": 8000
  },
  "bridge": {
    "enabled": true,
    "endpoint": "wss://your-xiotbox-server.com:9002/ws/openclaw",
    "allowlist": ["127.0.0.1", "localhost", "::1"],
    "openclawHost": "127.0.0.1",
    "openclawPort": 18789,
    "agentId": "main"
  }
}
```

`secret.json` 里只保存敏感字段（token/密钥等），示例：

```json
{
  "xiotbox": {
    "DEVICE_ID": "your_device_id",
    "DEVICE_TOKEN": "your_device_token",
    "LOCAL_CONTROL_TOKEN": "your_local_control_token"
  },
  "bridge": {
    "GATEWAY_TOKEN": "your_gateway_token_here"
  }
}
```

> 注意：Bridge / 工具脚本不再从 `process.env` 读取任何 token/secret，敏感信息必须写入 `secret.json`。

为兼容旧部署，仅保留两项桥接相关 env 作为一次性迁移/临时覆盖（只在纯配置模块里读取）：

- `XIOTBOX_BRIDGE_ENABLED`
- `XIOTBOX_BRIDGE_ENDPOINT`

### Run

```bash
npm start
```

## Architecture

- **Plugin Mode**: `index.ts` registers as an OpenClaw Channel Plugin and dispatches to OpenClaw runtime.
- **Bridge Mode**: `bridge.js` connects to OpenClaw Gateway as an Operator Client and keeps E2E reply behavior aligned with plugin mode.

## Release Checklist

每次插件更新/发布请按：`RELEASE_CHECKLIST.md`

## License

MIT
