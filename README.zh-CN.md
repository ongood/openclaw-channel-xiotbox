<p align="center">
  <img src="docs/assets/xiotbox-logo.png" alt="XiotBox" width="112" />
</p>

<h1 align="center">XiotBox OpenClaw Channel</h1>

<p align="center">
  <strong>把 OpenClaw 接入 XiotBox 的 Channel 与设备控制插件。</strong><br />
  支持远程 Chat、Gateway WSS、可选本地/远程控制工具，以及独立 Bridge Mode。
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-18%2B-339933" />
  <img alt="OpenClaw" src="https://img.shields.io/badge/OpenClaw-Channel-555" />
  <img alt="Gateway" src="https://img.shields.io/badge/Gateway-WSS-1f6feb" />
  <img alt="Tools" src="https://img.shields.io/badge/Agent%20Tools-Optional-6f42c1" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-2ea043" />
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

`openclaw-channel-xiotbox` 是 OpenClaw 和 XiotBox 之间的正式集成层。它让 OpenClaw Agent 可以通过 XiotBox Gateway 进行远程会话，也可以按配置获得 XiotBox 本地或远程设备控制工具。

这个仓库的设计原则和 `dsh-channel-xiotbox` 类似：**不 fork OpenClaw 本体，而是在清晰的插件边界上接入 XiotBox。**

---

## 它在系统中的位置

```text
OpenClaw Agent
     │
     ▼
openclaw-channel-xiotbox
     │ WSS
     ▼
XiotBox Gateway
     │
     ├── XiotBox Client
     ├── MCP / Commander
     └── 远程设备与业务服务
```

插件既可以作为 OpenClaw 进程内插件运行，也可以用独立 Bridge Mode 运行。

---

## 主要能力

### XiotBox Chat Channel

让 OpenClaw Agent 通过 XiotBox Gateway 接收远程消息、返回回复并参与 XiotBox 会话体系。

### `xiotbox_control`

可选远程设备控制工具，用于把控制计划发送给 XiotBox 已连接设备。

### `xiotbox_local_control`

可选本地控制工具，用于调用 XiotBox 本机控制端点，例如：

```text
open_app
tap
type
swipe
click_text
get_screen
get_tree
```

### Bridge Mode

独立 Node.js 进程连接本机 OpenClaw Gateway 和远程 XiotBox Gateway，适合不希望把 XiotBox 连接逻辑直接放进 OpenClaw 插件进程的部署。

---

## 当前兼容范围

当前仓库声明的 OpenClaw Host 兼容范围：

```text
>=2026.7.1 <2026.9.0
```

源码/Bridge Mode：

```text
Node.js >= 18
```

当前仍支持：

- local path 安装；
- source checkout；
- linked development install；
- standalone bridge mode。

未来即使发布到公共插件目录，也不能把现有安装方式突然废掉。

---

## Plugin Mode

安装本地仓库：

```bash
openclaw plugins install ./openclaw-channel-xiotbox
```

开发 linked install：

```bash
openclaw plugins install -l ./openclaw-channel-xiotbox
```

安装或升级插件后，如果宿主环境不会自动 reload，需要明确重启 OpenClaw Gateway。

Linux/systemd 示例：

```bash
systemctl restart openclaw-gateway
```

插件源码更新和宿主进程重启是两个不同动作，不能把“文件更新成功”说成“运行时已升级”。

---

## Bridge Mode

源码运行：

```bash
git clone https://github.com/xiotbox/openclaw-channel-xiotbox.git
cd openclaw-channel-xiotbox
npm install
npm run build
npm start
```

Bridge Mode 配置放在：

```text
$OPENCLAW_HOME/xiotbox/config.json
$OPENCLAW_HOME/xiotbox/secret.json
```

普通配置和 secret 分开，真实 token 不应该进入仓库、Issue、PR 或普通聊天记录。

---

## Tool Policy

OpenClaw 的工具权限由 OpenClaw 自己的工具策略和审批体系决定。

XiotBox 插件不会因为 Agent 在 prompt 里说“我是管理员”就自动给它 `exec`、`write` 或设备控制权限。

如果 `agents.list[].tools.allow` 存在，它就是限制性 allowlist。例如只配置：

```text
xiotbox_control
web_search
web_fetch
```

意味着 `exec`、`read`、`write`、`edit` 等工具会被过滤掉。

完整 Digital Employee 工具权限建议：

```text
docs/digital-employee-permissions.md
```

---

## 安全配置

以下内容属于 secret 或安全敏感配置：

```text
DEVICE_TOKEN
LOCAL_CONTROL_TOKEN
E2E_KEY_PATH
IDENTITY_KEY_PATH
TRUST_PATH
bridge secret.json
```

不能把真实值提交到 Git。

远程设备控制还应该通过：

```text
SCOPES
CONTROL_ACTIONS
```

把能力限制到真正需要的最小范围。

---

## 和 Gateway 的关系

Gateway 负责远程连接、路由和会话控制面；这个插件负责把 OpenClaw 原生能力适配到 Gateway。

插件不应该重新实现：

- Gateway 的命令持久化；
- 会话 ownership；
- 用户/设备 ownership；
- 整个平台事件总线。

---

## 和 DSH Channel 的关系

```text
dsh-channel-xiotbox
= DSH ↔ XiotBox adapter

openclaw-channel-xiotbox
= OpenClaw ↔ XiotBox adapter
```

两个 Runtime 的模型、工具体系和原生能力不同，但接入 XiotBox 后应该尽量共享：

- Gateway 控制协议；
- 身份和 ownership 原则；
- E2E secure-channel；
- Agent governance；
- Digital Employee identity / memory / Skills。

不能因为换了 Runtime，就再造一套 XiotBox 平台。

---

## 故障排查

### 插件安装后看不到

检查：

- `openclaw.plugin.json` 是否存在；
- 安装路径是否正确；
- Gateway 是否需要重启。

### Channel 加载但无法连接

检查：

```text
GATEWAY_WSS_URL
DEVICE_ID
DEVICE_TOKEN
USE_QUERY_AUTH
```

### 出现 pairing / scope-upgrade

检查 OpenClaw pending approval：

```bash
openclaw devices list
```

批准明确的 request id：

```bash
openclaw devices approve <requestId>
```

权限升级必须基于实际 pending request，不靠猜“最新那个应该就是它”。

### Bridge 无法连接本机 OpenClaw

检查：

```text
bridge.openclawHost
bridge.openclawPort
bridge.GATEWAY_TOKEN
```

并确认本机 OpenClaw Gateway 真正在运行。

---

## 发布边界

当前仓库正在为更公开的分发方式做准备，但当前部署模型仍然有效。

发布前必须检查：

```text
docs/release/RELEASE_CHECKLIST.md
```

不能因为准备上公共 Catalog，就顺手修改现有协议、安装方式或运行模型。发布准备和协议重构应该分开。

---

## 核心原则

1. **OpenClaw 保持 OpenClaw，XiotBox 通过插件边界接入。**
2. **Gateway 是控制平面，插件是 Runtime adapter。**
3. **Tool 权限沿用宿主 Runtime 的正式权限体系。**
4. **Device Token、E2E Key、Trust Store 属于 secret。**
5. **远程设备控制默认最小权限。**
6. **Plugin Mode 和 Bridge Mode 都是正式部署方式。**
7. **插件更新与宿主重启必须分开报告状态。**

---

## 当前方向

`openclaw-channel-xiotbox` 的长期价值，是让 OpenClaw 成为 XiotBox 可以自由选择的一种 Agent Runtime，而不是把 XiotBox 产品架构绑死在 OpenClaw 上。

未来模型、Agent Runtime 和宿主产品都可能变化，但 Gateway、数字员工身份、Skills、治理和安全协议应该尽量保持稳定。这样 Runtime 是可替换执行层，而不是整个系统重新投胎一次。