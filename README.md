# OpenClaw XiotBox 插件

OpenClaw 插件，用于接入 XiotBox 网关，实现远程命令执行与会话交互。

## 功能特性

- ✅ **设备配对**：使用短期配对码安全接入 XiotBox 网关
- ✅ **实时通信**：WSS（WebSocket Secure）主通道，低延迟双向通信
- ✅ **命令执行**：接收并执行远程命令，回传结构化结果
- ✅ **心跳机制**：15 秒心跳保持在线状态，上报运行指标
- ✅ **断线重连**：指数退避 + 随机抖动，智能重连避免雪崩
- ✅ **内置命令**：`/help` `/status` `/ping` `/version` 等常用命令
- ✅ **安全保障**：TLS 加密、Token 认证、不记录明文凭证

---

## 安装

### 方法 1：使用 npm 安装

```bash
cd /path/to/openclaw/plugins
git clone https://github.com/ongood/openclaw-channel-xiotbox.git
cd openclaw-channel-xiotbox
npm install
```

### 方法 2：使用 OpenClaw 命令安装（如果支持）

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git
```

---

## 配置

### 首次配对

1. **在 XiotBox 客户端申请配对码**
   - 打开 XiotBox 客户端
   - 点击"OpenClaw"导航 → "添加设备"
   - 获取配对码（例如：`ABC123`，10 分钟有效）

2. **配置环境变量并启动插件**

   创建 `.env` 文件：
   ```bash
   GATEWAY_WSS_URL=wss://your-xiotbox-gateway.com/ws/openclaw
   PAIR_CODE=ABC123
   ```

   或直接设置环境变量：
   ```bash
   export GATEWAY_WSS_URL="wss://your-gateway.com/ws/openclaw"
   export PAIR_CODE="ABC123"
   npm start
   ```

3. **配对成功**
   - 插件会自动换取 `device_token` 并保存到 `config.json`
   - 后续启动无需再提供 `PAIR_CODE`

### 后续启动

配对成功后，直接启动即可：

```bash
npm start
```

插件会自动读取 `config.json` 中的设备凭证。

---

## 配置文件

### 环境变量（`.env` 文件或系统环境变量）

| 变量名 | 必需 | 说明 | 示例 |
|--------|------|------|------|
| `GATEWAY_WSS_URL` | ✅ | XiotBox Gateway WSS 地址 | `wss://gateway.example.com/ws/openclaw` |
| `PAIR_CODE` | 首次配对时必需 | 配对码（10 分钟有效）| `ABC123` |
| `GATEWAY_API_URL` | ❌ | Gateway API 地址（自动推断）| `https://gateway.example.com` |
| `COMMAND_TIMEOUT` | ❌ | 命令执行超时（毫秒，默认 300000）| `300000` |

### 持久化配置（`config.json`，自动生成）

```json
{
  "DEVICE_ID": "dev_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "DEVICE_TOKEN": "token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "GATEWAY_WSS_URL": "wss://your-gateway.com/ws/openclaw",
  "GATEWAY_API_URL": "https://your-gateway.com",
  "TENANT_ID": "1"
}
```

> ⚠️ **安全提示**：`config.json` 包含敏感凭证，请勿提交到 Git 仓库（已在 `.gitignore` 中排除）

---

## 使用

### 内置命令

插件支持以下内置命令（在 XiotBox 客户端会话页输入）：

| 命令 | 说明 | 示例输出 |
|------|------|----------|
| `/help` | 显示帮助信息 | 列出所有可用命令 |
| `/status` | 显示插件运行状态 | 运行时间、内存、CPU 等 |
| `/ping` | 测试连接 | `pong` |
| `/version` | 显示版本信息 | `openclaw-channel-xiotbox v1.0.0` |

### 自定义命令

所有非 `/` 开头的消息会作为自定义命令执行（当前示例使用 shell 执行，实际应调用 OpenClaw API）：

```bash
# 示例（在 XiotBox 客户端会话页输入）
echo Hello World
ls -la
node --version
```

> 📝 **注意**：自定义命令执行逻辑需要根据 OpenClaw 实际 API 调整（见 `executor.js`）

---

## 运行日志

插件会输出详细日志到控制台：

```
[XiotBox] OpenClaw Plugin starting...
[XiotBox] Version: 1.0.0
[Config] Loaded from file: /path/to/config.json
[XiotBox] Device ID: dev_12345678-1234-1234-1234-123456789abc
[XiotBox] Gateway: wss://gateway.example.com/ws/openclaw
[WSS] Connecting to gateway...
[WSS] Connection established
[WSS] Sent HELLO
[XiotBox] ✓ Connected to gateway
[XiotBox] Plugin running, press Ctrl+C to exit
[Command] Received: cmd_abc123 (type: chat)
[Command] Executing: /status
[Command] Success: cmd_abc123
```

---

## 排错

### ❌ 问题：连接失败

**现象**：
```
[WSS] Connection error: connect ECONNREFUSED
```

**排查**：
1. 检查 `GATEWAY_WSS_URL` 是否正确
2. 确认网络能访问 Gateway（尝试 `curl` 或 `ping`）
3. 检查防火墙是否放行 WSS 端口

---

### ❌ 问题：配对失败

**现象**：
```
[Pairing] Pairing failed: HTTP 401: Invalid or expired pair_code
```

**原因**：
- 配对码错误
- 配对码已过期（10 分钟有效期）

**解决**：
1. 重新在 XiotBox 客户端申请配对码
2. 立即执行配对（10 分钟内）

---

### ❌ 问题：认证失败（已配对设备）

**现象**：
```
[WSS] Server error: { code: 'REAUTH_REQUIRED' }
[WSS] Token invalid or revoked, please re-pair this device
```

**原因**：
- `device_token` 已被吊销（设备在 XiotBox 客户端被移除）
- `config.json` 被手动修改

**解决**：
1. 删除 `config.json`
2. 重新执行配对流程

---

### ❌ 问题：命令执行超时

**现象**：
```
[Command] Failed: cmd_abc123 命令超时（超过 300 秒）
```

**解决**：
- 调整 `COMMAND_TIMEOUT` 环境变量（毫秒）
- 优化命令执行逻辑

---

## 开发

### 项目结构

```
openclaw-channel-xiotbox/
├── index.js          # 主入口
├── wss_client.js     # WSS 客户端（连接管理、心跳、重连）
├── executor.js       # 命令执行器（内置命令 + 自定义命令）
├── config.js         # 配置管理（加载、保存、配对）
├── package.json      # 项目配置
├── .env.example      # 环境变量示例
├── .gitignore        # Git 忽略规则
└── README.md         # 本文件
```

### 修改自定义命令执行逻辑

编辑 `executor.js` 中的 `executeShell()` 方法：

```javascript
async executeShell(command) {
  // TODO: 替换为实际 OpenClaw API 调用
  // 示例：
  // const result = await openclaw.runPrompt(command);
  // return { text: result.output, json: result.metadata, logs: result.logs };
  
  // 当前使用 shell 执行作为示例
  const { stdout, stderr } = await execAsync(command, { timeout: this.timeout });
  return { text: stdout || stderr, json: {}, logs: stderr };
}
```

---

## 协议版本

- **WSS 协议版本**：v1
- **消息格式**：JSON（信封格式，包含 `id`, `type`, `ts`, `device_id`, `seq`, `trace_id`, `payload`）

### 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `HELLO` | 插件 → 网关 | 上报设备信息（版本、能力、运行环境）|
| `HEARTBEAT` | 插件 → 网关 | 心跳（15 秒间隔）|
| `HEARTBEAT_ACK` | 网关 → 插件 | 心跳响应 |
| `COMMAND` | 网关 → 插件 | 下发命令 |
| `ACK` | 插件 → 网关 | 命令确认（收到）|
| `RESULT` | 插件 → 网关 | 命令执行结果 |
| `ERROR` | 网关 → 插件 | 错误消息 |

---

## 许可证

MIT License

---

## 支持

- **问题反馈**：[GitHub Issues](https://github.com/ongood/openclaw-channel-xiotbox/issues)
- **文档**：[XiotBox 文档中心](https://docs.xiotbox.example.com)