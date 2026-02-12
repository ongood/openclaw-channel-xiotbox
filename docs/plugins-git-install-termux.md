# XiotBox 插件 Git 安装在 BotDrop(Termux/proot) 的兼容性审查与落地

## 0. 审查边界（代码事实）

本次可直接审查的代码仓库是：`openclaw-channel-xiotbox`。

已确认事实：

1. 当前工作区中**没有** OpenClaw CLI 源码仓库。
2. 本机当前环境中 `openclaw` 命令不存在（无法本机反编译/反查 CLI 内部实现）。
3. 因此，`openclaw plugins install` 的内部实现链路（CLI parser/install handler）无法在本仓库内做源码级定位。

本文件将给出：

1. 在本仓库内可核实的插件识别与安装相关事实。
2. Termux/proot 下可执行的兼容补齐与验证脚本。
3. 需要在 OpenClaw CLI 主仓继续审查的清单。

## A. Git 安装链路（当前仓库可核实部分）

### A.1 插件元数据与识别入口

代码位置：`package.json`

- `main`: `dist/index.js`
- `openclaw.extensions`: `./dist/index.js`
- `openclaw.channels`: `xiotbox`
- `openclaw.installDependencies`: `true`
- `openclaw.install.localPath`: `extensions/xiotbox`

代码位置：`openclaw.plugin.json`

- 插件 `id`: `xiotbox`
- `channels`: `xiotbox`
- `configSchema` 已声明

代码位置：`index.ts`

- 默认导出 `plugin`
- `register(api)` 内调用 `api.registerChannel({ plugin: xiotboxPlugin })`

结论：从插件仓库自身看，具备被 OpenClaw 插件系统识别/注册所需的基本入口与元数据。

### A.2 Git 安装触发点（可核实）

代码位置：`scripts/update_openclaw_xiotbox.sh`

- 直接调用：`openclaw plugins install "$REPO"`
- 维护路径：默认 `~/.openclaw/extensions/xiotbox`
- 维护配置：默认 `~/.openclaw/openclaw.json`

## B. Termux/proot 兼容性逐项审查

### B.1 Git 相关

- 审查结果：原脚本未做 `git` 存在性预检。
- 风险：Termux/proot 常见缺少 git，安装失败信息不友好。
- 处理：已在脚本增加依赖预检与 Termux/apt 安装提示。

### B.2 路径与权限

- 审查结果：默认写 `~/.openclaw`，未提前检查可写性。
- 风险：proot 分层目录或权限异常会导致安装后落盘失败。
- 处理：已增加目录创建与可写性校验（插件目录父级、配置目录父级）。

### B.3 Node 生态编译依赖

- 审查结果：本插件依赖为 `@noble/curves`、`ws`、`dotenv`，未发现 `node-gyp` 原生 addon 依赖。
- 风险：低；仍需 Node/npm 存在。
- 处理：已在脚本预检 `node`、`npm`。

### B.4 平台判断/拦截

- 审查结果：未在 `package.json` 看到 `os/cpu` 限制字段。
- 审查结果：未发现阻断 `android` 平台的安装脚本。
- 风险：低。

### B.5 插件可识别性

- 审查结果：`main + openclaw.extensions + default export register()` 完整。
- 风险：若 CLI 扫描规则变化，需在 OpenClaw 主仓校验。
- 处理：新增验证脚本通过 `openclaw plugins list/channels list` 和配置回退校验。

## C. 已实施的最小修复

### C.1 更新脚本增强

文件：`scripts/update_openclaw_xiotbox.sh`

新增：

1. 支持直接传 `<git-repo>` 或 `tag` 两种参数。
2. Termux/proot 环境识别（`TERMUX_VERSION/PREFIX/PROOT_*`）。
3. 依赖预检：`openclaw/git/node/npm/python3`。
4. 目录可写性预检：`~/.openclaw/extensions`、`~/.openclaw`。
5. 失败时给出 Termux 与 proot 的安装命令提示。

### C.2 新增自动化验证脚本

文件：`scripts/test_install_xiotbox_termux.sh`

流程：

1. 预检依赖
2. 执行 `openclaw plugins install <repo>`
3. 校验 `openclaw plugins list`
4. 校验 `openclaw channels list`
5. 若 list 不可用，回退检查 `~/.openclaw/openclaw.json` 的插件注册键

## D. BotDrop 可复制验收步骤

## D.1 前置依赖（Termux）

```bash
pkg update
pkg install -y git nodejs-lts python ca-certificates openssl
```

若在 `proot-distro` 的 Debian/Ubuntu rootfs：

```bash
apt-get update
apt-get install -y git nodejs npm python3 ca-certificates
```

仅当某个插件依赖原生编译（`node-gyp`）时，再补安装工具链：

```bash
# Termux
pkg install -y clang make

# Debian/Ubuntu proot rootfs
apt-get install -y make g++
```

## D.2 安装命令

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.32
```

或使用维护脚本（含预检与配置归一化）：

```bash
bash scripts/update_openclaw_xiotbox.sh 1.0.32
# 或
bash scripts/update_openclaw_xiotbox.sh https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.32
```

推荐在 BotDrop 直接使用参数化脚本（安装 + 配置 + 启动）：

```bash
bash scripts/install_configure_xiotbox.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.32 \
  1
```

推荐直接使用一条命令跑完整闭环（安装 + 配置 + 启动 + 验证）：

```bash
bash scripts/bootstrap_xiotbox_termux.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.32 \
  1 \
  <MODEL_API_KEY> \
  deepseek-chat
```

如果暂时不配置模型，传 `-` 即可：

```bash
bash scripts/bootstrap_xiotbox_termux.sh \
  wss://socketd.odoo.games/ws/openclaw \
  <DEVICE_ID> \
  <DEVICE_TOKEN> \
  https://api.xiotbox.com \
  1.0.32 \
  1 \
  -
```

参数说明：

1. `GATEWAY_WSS_URL`
2. `DEVICE_ID`
3. `DEVICE_TOKEN`
4. `API_BASE_URL`（传 `-` 表示保留旧值）
5. `TAG_OR_REPO`
6. `ALLOW_NEW_CLIENT_IDENTITIES`（建议稳定后改 `0`）

脚本默认行为（适合 Android）：

1. `OPENCLAW_AUTO_EDIT=0`
2. `OPENCLAW_SKIP_DOCTOR=1`
3. `OPENCLAW_RESTART_GATEWAY=1`
4. 自动修复无效 `gateway.bind`（例如旧值 `"all"`）为合法值（默认 `auto`）
5. Android 默认自动启用 `gateway.http.endpoints.chatCompletions.enabled=true`

可选环境变量：

1. `XIOTBOX_GATEWAY_BIND_DEFAULT=loopback|auto|lan|custom|tailnet`（默认 `auto`）
2. `XIOTBOX_ENABLE_CHAT_COMPLETIONS=0|1`（Android 默认 `1`，其它环境默认 `0`）

## D.2.1 DeepSeek 配置（不走 UI，防止覆盖手工配置）

```bash
bash scripts/configure_deepseek_termux.sh <API_KEY> deepseek-chat
```

默认会清理 BotDrop 模板缓存文件：
`/data/data/app.botdrop/shared_prefs/botdrop_config_template.xml`

默认也会把 `models.providers.deepseek` 写成 OpenAI 兼容配置：
1. `baseUrl=https://api.deepseek.com/v1`
2. `api=openai-completions`
3. 自动补一条 `deepseek-chat` 到 provider models

脚本默认会先校验模型是否存在于当前 `openclaw models list`。
如果不存在会直接报错并提示可用 deepseek-like 模型，避免运行时 `Unknown model`。
但 `deepseek/*` 默认走 provider 写入模式，不依赖预置模型列表。

如果你要使用完整模型名（例如 OpenRouter 路径）：

```bash
bash scripts/configure_deepseek_termux.sh <OPENROUTER_API_KEY> openrouter/deepseek/deepseek-chat
```

如果你要保留缓存：

```bash
CLEAR_BOTDROP_TEMPLATE=0 bash scripts/configure_deepseek_termux.sh <API_KEY> deepseek-chat
```

## D.3 一键测试脚本

```bash
bash scripts/test_install_xiotbox_termux.sh \
  https://github.com/ongood/openclaw-channel-xiotbox.git#1.0.32
```

## D.3.1 健康检查脚本（插件 + 模型 + gateway）

```bash
bash scripts/health_check_xiotbox.sh
```

可选参数（环境变量）：

1. `CHECK_PLUGIN=0` 跳过插件检查
2. `CHECK_MODEL=0` 跳过模型检查
3. `CHECK_GATEWAY=0` 跳过 gateway 检查

## D.4 验证插件被识别

```bash
openclaw plugins list
openclaw channels list
```

若 CLI list 命令异常，检查配置回退：

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('~/.openclaw/openclaw.json').expanduser()
d = json.loads(p.read_text('utf-8'))
print('plugins.entries.xiotbox:', 'xiotbox' in ((d.get('plugins') or {}).get('entries') or {}))
print('plugins.installs.xiotbox:', 'xiotbox' in ((d.get('plugins') or {}).get('installs') or {}))
print('channels.xiotbox:', 'xiotbox' in (d.get('channels') or {}))
PY
```

## D.5 启动后日志确认（示例）

> 具体启动命令依 OpenClaw CLI 版本而定。

```bash
openclaw start 2>&1 | tee /tmp/openclaw_start.log
grep -En "xiotbox|XiotBox|registerChannel|channel" /tmp/openclaw_start.log
```

若没有 `openclaw start` 子命令，请替换为你当前版本的启动命令并保留同样的 grep 检查。

## D.6 OpenClaw 调 XiotBox 本地控制（可选）

`xiotbox` 插件已提供 optional tool：`xiotbox_local_control`。

先在 `~/.openclaw/openclaw.json` 写入：

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

再把工具加入 agent allowlist（示例）：

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

可用动作：
1. `open_app`
2. `tap`
3. `type`
4. `open_accessibility_settings`

快速验证（OpenClaw 侧）：

```bash
openclaw message \
  --text "调用 xiotbox_local_control: action=open_app, package=com.tencent.mm"
```

## D.7 插件配置（单账号，仅远程 XiotBox 通道）

`xiotbox` 插件只读取 `channels.xiotbox` 顶层字段（`GATEWAY_WSS_URL + DEVICE_ID + DEVICE_TOKEN`）。
它不是客户端“本地直连 OpenClaw”配置。

```json
{
  "channels": {
    "xiotbox": {
      "enabled": true,
      "GATEWAY_WSS_URL": "wss://socketd.odoo.games/ws/openclaw",
      "DEVICE_ID": "REMOTE_DEVICE_ID",
      "DEVICE_TOKEN": "REMOTE_DEVICE_TOKEN"
    }
  }
}
```

客户端本地直连 OpenClaw（同机聊天）应在 XiotBox App 内配置：

1. `enableLocalOpenClawChat = true`
2. `localOpenClawGatewayBaseUrl = http://127.0.0.1:18789`
3. `localOpenClawGatewayToken = <token or empty>`
4. `localOpenClawAgentId = main`

本地直连不依赖 `DEVICE_ID/DEVICE_TOKEN/API_BASE_URL`。

## E. 仍需在 OpenClaw CLI 主仓完成的审查点

由于本仓库不含 CLI 源码，以下项待在 OpenClaw 主仓继续核实：

1. `openclaw plugins install` 的 parser/handler 入口文件与函数。
2. clone 实现细节（git 子进程参数、checkout、错误码映射）。
3. 插件目录选择算法与 workspace 根目录判定。
4. 依赖安装器选择（npm/pnpm/yarn）和 Termux 下 fallback。
5. 插件扫描 registry 的最终规则（manifest/package.json 优先级）。
