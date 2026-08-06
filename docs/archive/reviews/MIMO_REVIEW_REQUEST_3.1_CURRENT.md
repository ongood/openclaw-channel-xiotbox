# XiotBox 3.1 当前迭代复审请求

> 面向 MiMo 的复审材料  
> 分支：`3.1`  
> 当前关键提交：`e5b645e refactor: split xiotbox gateway state and config`  
> 基线版本：`3.0.2`  
> 测试宿主：OpenClaw `2026.5.4 (325df3e)` / Node `24.14.0` / Linux `6.8.0-71-generic`

## 一、本轮目标

本轮 3.1 没有急于迁移 `defineBundledChannelEntry`，而是先按已批准的 3.1 执行计划完成两类工作：

1. 先做外部插件入口 Spike，验证 OpenClaw 2026.5.x 下 `defineBundledChannelEntry` 是否能被第三方扩展包安全使用。
2. 在不破坏 3.0.2 稳定性的前提下，先拆出 `gateway-state.ts` 和 `config.ts`，降低 `channel.ts` 单体复杂度，并补齐测试。

## 二、入口 Spike 结论

已新增：

- `docs/openclaw-entry-spike-3.1.md`
- `scripts/spike_openclaw_entry_3_1.mjs`
- `npm run spike:entry`

本地 Windows 插件工作区和线上 OpenClaw 服务器均得到一致结论：

```text
entrySpecifier: openclaw/plugin-sdk/channel-entry-contract
resolve: ERR_MODULE_NOT_FOUND
import: skipped: resolve failed
```

线上宿主环境验证：

```text
OpenClaw version: 2026.5.4 (325df3e)
Node version: 24.14.0
Plugin path: /root/.openclaw/extensions/xiotbox
Install mode: https://github.com/xiotbox/openclaw-channel-xiotbox.git#3.1
```

同时，当前手动入口回归通过：

```json
{
  "entryShape": {
    "id": "xiotbox",
    "name": "XiotBox Channel",
    "hasPlugin": true,
    "hasRegister": true
  },
  "calls": [
    { "type": "registerChannel", "hasPlugin": true },
    { "type": "registerTool", "id": "xiotbox_local_control", "optional": true },
    { "type": "registerTool", "id": "xiotbox_control", "optional": true }
  ],
  "runtimeInjected": true
}
```

当前判断：

- 不建议在 3.1 强行静态导入 `openclaw/plugin-sdk/channel-entry-contract`。
- 原因是外部扩展路径下不可解析，强迁移会导致插件无法加载。
- 3.1 继续保留手动入口，等 OpenClaw 暴露稳定外部 SDK 路径后，再做入口合约迁移。

请 MiMo 重点审核：这个结论是否充分，是否还需要补充其他 OpenClaw 2026.5.x 外部插件加载路径验证。

## 三、模块拆分改动

### 1. 新增 `src/gateway-state.ts`

已将 `activeGatewayAccounts` 和 `gatewayInstanceSeq` 从 `channel.ts` 中抽出，统一通过函数访问，避免直接操作模块级 Map。

当前导出函数：

- `nextGatewayInstanceId()`
- `registerGatewayAccount(accountId, state)`
- `getGatewayAccount(accountId)`
- `removeGatewayAccount(accountId, instanceId)`
- `stopGatewayAccount(accountId, reason)`
- `setConnectedAt(accountId, instanceId, timestamp)`
- `clearConnectedAt(accountId, instanceId)`
- `describeGatewayAccountState(accountId)`

对应测试：

- `test/gateway-state.test.mjs`

覆盖点：

- 注册和读取 active gateway account
- `connectedAt` 设置和清理
- 旧 instance 不能覆盖新 instance 状态
- 只允许匹配 instance 删除
- 并发 stop 幂等性
- instance id 递增

### 2. 新增 `src/config.ts`

已将配置解析、账号解析、agent/thread/session key 相关纯函数从 `channel.ts` 拆出。

核心内容：

- 默认常量：`DEFAULT_ACCOUNT_ID`、`DEFAULT_AGENT_ID`、`DEFAULT_THREAD_ID`、`CHANNEL_ID`
- 配置解析：`getChannelConfig()`、`buildConfig()`、`resolveEffectiveConfig()`
- session 工具：`normalizeThreadId()`、`normalizeAgentId()`、`buildSessionKey()`
- account 工具：`listAccountIds()`、`resolveDefaultAccountId()`、`resolveAccount()`
- thread/agent 映射：`readThreadAgentMapValue()`、`resolveThreadAgentId()`

对应测试：

- `test/config.test.mjs`

覆盖点：

- channel config 读取
- 默认值回退
- boolean/list/string/int 规范化
- session key 构建
- thread agent map 解析
- account/default account 解析
- `ctx.cfg > runtime > startupCfg` 优先级

请 MiMo 重点审核：

- `config.ts` 是否仍有不该保留的 runtime 耦合。
- `resolveEffectiveConfig()` 的优先级是否符合 OpenClaw 插件生命周期语义。
- `gateway-state.ts` 的状态函数是否足够覆盖后续 lifecycle/stopAccount 扩展。

## 四、OpenClaw 2026.5.4 元数据兼容修复

服务器安装 3.1 后，OpenClaw 2026.5.4 曾提示：

```text
registered incomplete metadata; filled missing docsPath
plugin must declare contracts.tools before registering agent tools
```

已补充：

- `docsPath`
- `contracts.tools`
- `toolMetadata`

涉及文件：

- `src/channel.ts`
- `package.json`
- `openclaw.plugin.json`

更新后服务器日志不再出现上述 `docsPath` / `contracts.tools` 警告。

请 MiMo 重点审核：

- `contracts.tools` 的声明粒度是否符合 OpenClaw 2026.5.x 对外部插件的预期。
- `toolMetadata` 是否还需要补充更严格的权限、安全、审计字段。

## 五、验证结果

本地已执行：

```bash
npm run build
npm test
npm run release:check
npm run spike:entry
git diff --check
```

结果：

```text
npm run build: passed
npm test: 72 passed, 0 failed
npm run release:check: passed
npm run spike:entry: manual entry regression passed, OpenClaw entry contract not importable
git diff --check: passed
```

服务器安装命令：

```bash
bash scripts/update_openclaw_xiotbox.sh https://github.com/xiotbox/openclaw-channel-xiotbox.git#3.1
cd ~/.openclaw/extensions/xiotbox
npm install --omit=dev
systemctl restart openclaw-gateway
```

服务器 `openclaw status` 当前结果：

```text
Gateway: reachable
Channels:
  XiotBox  ON  OK  configured
```

服务器关键日志：

```text
[gateway] http server listening (2 plugins: memory-core, xiotbox; 5.0s)
[xiotbox] [default] remote streaming config (STREAMING=true, BLOCK_STREAMING=true, PROGRESS_UPDATES=true)
[xiotbox] E2E x25519 backend: noble
[xiotbox] [default] Connected to Gateway
```

这说明：

- 插件能被 OpenClaw 2026.5.4 加载。
- XiotBox channel 能注册并显示在 Channels 表中。
- WSS 能连接到云端 Gateway。
- 3.1 的模块拆分没有破坏基础加载和连接链路。

## 六、当前仍需关注的非阻塞问题

### 1. `E2E peer key refresh failed: client_identity_missing`

服务器仍出现：

```text
[xiotbox] E2E peer key not ready: client_identity_missing
[xiotbox] [default] E2E peer key refresh failed: client_identity_missing
```

当前判断：

- 这不是 3.1 模块拆分或插件加载失败。
- 这更像是当前客户端身份/会话身份未建立时的 E2E key refresh 前置条件不足。
- WSS 已连接，channel 已 OK，所以它是 E2E 身份状态问题，不是基础 channel 注册问题。

建议后续在 3.2 或 3.3 中单独做 E2E identity 状态机梳理和 doctor 检查。

### 2. 安装后需要 `npm install --omit=dev`

线上曾出现：

```text
Cannot find package 'ws' imported from /root/.openclaw/extensions/xiotbox/dist/wss_client.js
```

执行：

```bash
cd ~/.openclaw/extensions/xiotbox
npm install --omit=dev
systemctl restart openclaw-gateway
```

后恢复正常。

这说明当前 git branch 安装流程仍依赖插件目录内依赖安装。后续建议：

- 优化 `scripts/update_openclaw_xiotbox.sh`，确保安装后依赖一定存在。
- 或改进 OpenClaw 插件安装流程对 git/path 插件的 dependency install 检查。
- 3.1.0 正式 tag 前应把这条加入发布/升级文档。

### 3. 版本号仍为 `3.0.2`

当前 `3.1` 分支仍保持 `package.json` 版本 `3.0.2`，原因是本轮还处于 3.1 开发分支验证阶段，未发布正式 `3.1.0` tag。

建议：

- MiMo 对当前 3.1 分支复审通过后，再统一 bump 到 `3.1.0`。
- `package.json`、`package-lock.json`、`openclaw.plugin.json` 和构建产物版本必须同步。
- 正式生产部署建议使用 `3.1.0` tag，不建议长期使用 branch 引用。

## 七、请 MiMo 本轮重点审核

1. `defineBundledChannelEntry` 暂缓迁移的判断是否充分。
2. `gateway-state.ts` 是否真正消除了 `activeGatewayAccounts` 的直接 Map 操作风险。
3. `gateway-state.ts` 的并发 stop 幂等实现是否覆盖 OpenClaw reload/replace 场景。
4. `config.ts` 是否拆分得足够纯净，是否存在会影响未来多 agent、多 account、多 session 的隐性耦合。
5. `resolveEffectiveConfig()` 的配置优先级是否正确。
6. `contracts.tools` / `toolMetadata` 是否满足 OpenClaw 2026.5.x 对第一阵营插件的元数据要求。
7. 是否同意在 3.1.0 前只做必要修补，不继续扩大重构范围。

## 八、建议下一步

如果 MiMo 复审通过，建议进入 3.1.0 收口：

1. 修复 MiMo 指出的 P0/P1/P2 问题。
2. 补充升级文档中的 `npm install --omit=dev` 或脚本自动安装依赖逻辑。
3. 版本统一 bump 到 `3.1.0`。
4. 运行完整验证：

```bash
npm run build
npm test
npm run release:check
npm run spike:entry
git diff --check
```

5. 打 tag 并推送：

```bash
git tag 3.1.0
git push origin 3.1
git push origin 3.1.0
```

如 MiMo 认为还有架构级风险，则继续在 `3.1` 分支修复，不提前发布正式 tag。
