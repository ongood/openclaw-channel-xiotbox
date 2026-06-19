# OpenClaw Channel XiotBox 插件改进意见

> 基于 openclaw 最新核心代码（2026.5.x）对 `openclaw-channel-xiotbox` 插件的全面审查

---

## 一、架构层面改进

### 1.1 采用 `defineBundledChannelEntry` 入口模式 ⭐ 高优先级

**现状**: [`index.ts`](index.ts) 使用手动导出对象模式：
```ts
export default {
  id: 'xiotbox',
  name: 'XiotBox Channel',
  plugin: xiotboxPlugin,
  register(api) { ... },
};
```

**问题**: openclaw 核心已提供 [`defineBundledChannelEntry()`](openclaw/src/plugin-sdk/channel-entry-contract.ts:428) 统一入口函数（参见 telegram 的 [`index.ts`](openclaw/extensions/telegram/index.ts:1)），手动模式无法享受 sidecar 加载、工具发现、secrets 注入等框架能力。

**建议**: 迁移到标准入口模式：
```ts
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "xiotbox",
  name: "XiotBox",
  description: "XiotBox channel plugin for WSS device connectivity",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "xiotboxPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setXiotboxRuntime",
  },
});
```

同理，[`setup-entry.ts`](setup-entry.ts) 应使用 `defineBundledChannelSetupEntry`。

### 1.2 使用 `ctx.channelRuntime` 替代全局 runtime 单例 ⭐ 高优先级

**现状**: [`runtime.ts`](src/runtime.ts) 通过模块级全局变量传递 runtime：
```ts
let runtime: PluginRuntime | null = null;
export function setXiotboxRuntime(next: PluginRuntime): void { runtime = next; }
export function getXiotboxRuntime(): PluginRuntime { ... }
```

**问题**: 
- 类型为 `any`，丧失所有类型安全
- 全局可变状态，多实例场景下存在竞态风险
- 未使用 openclaw 提供的 [`ChannelRuntimeSurface`](openclaw/src/channels/plugins/channel-runtime-surface.types.ts:41) 类型

**建议**: 在 [`gateway.startAccount`](src/channel.ts:1622) 中使用 `ctx.channelRuntime`：
```ts
gateway: {
  startAccount: async (ctx: ChannelGatewayContext<ResolvedAccount>) => {
    const { cfg, log, abortSignal, channelRuntime } = ctx;
    // 使用 channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher
    // 而非 getXiotboxRuntime()?.channel?.reply?....
  },
}
```

### 1.3 拆分 `channel.ts` 单体文件 ⭐ 高优先级

**现状**: [`src/channel.ts`](src/channel.ts) 有 **2662 行**，包含：
- 配置解析（`buildConfig`, `getChannelConfig`）
- Session 管理（`resolveSessionStorePath`, `loadSessionStore`）
- 媒体处理（`stageInlineMediaPayload`, `buildInboundMediaContext`）
- 文本规范化（`normalizeTextPayload`, `normalizeReasoningPayload`）
- 工具信号检测（`detectToolSignals`, `extractToolSignalNames`）
- 进度追踪（`extractProgressSnapshot`, `buildProgressRunningText`）
- 控制模式管理（`isHardExitCommand`, `toolOnlyCounters`）
- E2E 加解密集成
- WSS 连接管理
- 命令分发逻辑

**建议**: 拆分为独立模块：
```
src/
├── channel.ts              # 主插件定义（~200行）
├── config.ts               # 配置解析与构建
├── session.ts              # Session store 与 usage snapshot
├── media.ts                # 媒体上下文构建与 inline media staging
├── text-normalize.ts       # 文本/推理 payload 规范化
├── tool-signals.ts         # 工具信号检测与名称提取
├── progress.ts             # 进度快照与流式事件构建
├── control-mode.ts         # 控制模式退出/计数器逻辑
├── command-handler.ts      # COMMAND 事件处理主逻辑
├── e2e.ts                  # E2E 加解密（已有）
├── runtime.ts              # Runtime 访问（需重构）
└── runtime_config.ts       # 运行时配置文件管理（已有）
```

---

## 二、类型安全改进

### 2.1 消除 `any` 类型滥用 ⭐ 高优先级

**现状**: 整个插件大量使用 `any`：
- [`runtime.ts`](src/runtime.ts:1): `export type PluginRuntime = any;`
- [`channel.ts`](src/channel.ts:359): `function getChannelConfig(cfg: any)`
- [`channel.ts`](src/channel.ts:363): `function buildConfig(channelCfg: any)`
- [`index.ts`](index.ts:6): `type XiotboxPluginApi = { ... }` 自定义而非使用 SDK 类型
- 所有 tool 的 `execute` 参数都是 `any`

**建议**:
- 使用 [`ChannelPlugin`](openclaw/src/channels/plugins/types.plugin.ts:53) 泛型定义插件类型
- 使用 [`ChannelGatewayContext`](openclaw/src/channels/plugins/types.adapters.ts:238) 替代 `ctx: any`
- 使用 [`OpenClawConfig`](openclaw/src/config/types.openclaw.ts) 替代 `cfg: any`
- 使用 [`ChannelLogSink`](openclaw/src/channels/plugins/types.core.ts) 替代 `log?: any`
- Tool 的 `execute` 签名应使用 `AgentTool` 类型

### 2.2 启用 TypeScript 严格模式

**现状**: [`tsconfig.json`](tsconfig.json) 中 `strict: false`

**建议**: 设置 `strict: true`，逐步修复类型错误。这能捕获大量潜在的运行时 bug。

### 2.3 将 `wss_client.js` 转为 TypeScript

**现状**: [`wss_client.js`](wss_client.js) 是纯 JavaScript（462 行），无类型定义。

**建议**: 转为 `src/wss-client.ts`，为 `WSSClient` 类添加完整的类型注解，特别是事件类型和配置接口。

---

## 三、Channel Plugin 能力声明改进

### 3.1 修正 `capabilities` 声明

**现状**: [`channel.ts:1598`](src/channel.ts:1598)
```ts
capabilities: {
  chatTypes: ['direct'],
  reactions: false,
  threads: true,
  media: false,        // ← 实际处理了媒体！
  nativeCommands: false,
  blockStreaming: true,
  outbound: false,
},
```

**问题**: 插件实际实现了完整的媒体处理（[`stageInlineMediaPayload`](src/channel.ts:756)、[`buildInboundMediaContext`](src/channel.ts:923)），但声明 `media: false`。

**建议**: 设置 `media: true`，并考虑添加 `markdownCapable: true` 到 `meta` 中。

### 3.2 补充缺失的 adapter

对比 [`ChannelPlugin`](openclaw/src/channels/plugins/types.plugin.ts:53) 完整接口，以下 adapter 可以添加：

| Adapter | 优先级 | 说明 |
|---------|--------|------|
| `lifecycle` | 中 | 监听配置变更，自动重连 WSS |
| `doctor` | 中 | 配置校验与修复（检查 DEVICE_ID/TOKEN 有效性） |
| `heartbeat` | 低 | 连接健康检查探针 |
| `security` | 低 | 安全审计（E2E 密钥状态检查） |
| `streaming` | 低 | 正式声明流式能力 |

### 3.3 补充 `configSchema` 顶层字段

**现状**: [`openclaw.plugin.json`](openclaw.plugin.json) 有详细的 `channelConfigs.xiotbox.schema`，但缺少顶层 `configSchema` 字段（telegram 有此字段）。

**建议**: 添加顶层 `configSchema` 以支持框架级配置校验。

---

## 四、代码质量改进

### 4.1 统一日志使用

**现状**: 混合使用 `console.error`/`console.warn`/`console.log` 和结构化 `log?.info?.()`：
- [`channel.ts:2560`](src/channel.ts:2560): `console.error('[XiotBox] COMMAND handler error:', ...)`
- [`channel.ts:2332`](src/channel.ts:2332): `console.error('[STREAM] onBlockReply error:', err)`
- [`e2e.ts:171`](src/e2e.ts:171): `console.log('[E2E] Decrypt attempt: ...')`
- [`e2e.ts:192`](src/e2e.ts:192): `console.warn('[E2E] AAD mismatch, ...')`

**建议**: 全部使用 `log?.warn?.()` / `log?.error?.()` 结构化日志，避免直接写 stdout/stderr。E2E 模块应接收 logger 参数。

### 4.2 减少模块级可变全局状态

**现状**: [`channel.ts`](src/channel.ts) 中有大量模块级可变状态：
```ts
let sessionStoreCache: SessionStoreCache | null = null;          // L72
const contextEpochCache = new Map<string, ContextEpochCacheEntry>(); // L73
const activeGatewayAccounts = new Map<string, ActiveGatewayAccount>(); // L74
let gatewayInstanceSeq = 0;                                       // L75
const toolOnlyCounters = new Map<string, ToolOnlyEntry>();        // L1036
const forceExitCounters = new Map<string, number>();              // L1037
```

**问题**: 这些状态在插件重载或多实例场景下不会被正确清理。

**建议**: 将状态封装到 class 中（如 `XiotboxChannelState`），在 `startAccount` 时创建实例，`stopAccount` 时清理。

### 4.3 改进错误处理

**现状**: [`channel.ts:2559`](src/channel.ts:2559) 的 catch 块：
```ts
} catch (err: any) {
  console.error('[XiotBox] COMMAND handler error:', err?.message || err, err?.stack?.split('\n').slice(0, 3).join(' '));
```

**建议**: 
- 使用结构化日志记录完整错误上下文
- 区分可恢复错误和致命错误
- 考虑添加重试逻辑用于 transient 网络错误

### 4.4 `normalizeTextPayload` 递归深度保护

**现状**: [`normalizeTextPayload`](src/channel.ts:420) 使用 `MAX_DEPTH = 6` 的递归遍历，但没有对输入大小做限制。

**建议**: 添加输入大小上限检查（如 `payload` 字符串化后超过 1MB 则截断），防止恶意大 payload 导致内存问题。

---

## 五、功能增强建议

### 5.1 使用 `ChannelGatewayContext.setStatus` 报告连接状态

**现状**: 插件未使用 `ctx.setStatus()` 报告运行时状态。

**建议**: 在连接/断开/重连时调用 `setStatus()`：
```ts
ctx.setStatus({
  accountId,
  running: true,
  connected: true,
  lastConnectedAt: Date.now(),
});
```

这会让 `openclaw channels status` 显示正确的 XiotBox 连接状态。

### 5.2 支持 `stopAccount` 生命周期

**现状**: [`gateway`](src/channel.ts:1621) 只实现了 `startAccount`，没有 `stopAccount`。

**建议**: 实现 `stopAccount` 以支持优雅关闭：
```ts
gateway: {
  startAccount: async (ctx) => { ... },
  stopAccount: async (ctx) => {
    const existing = activeGatewayAccounts.get(ctx.accountId);
    if (existing?.stop) await existing.stop('stop_account');
  },
}
```

### 5.3 支持 `setup` adapter 实现 CLI 配置

**建议**: 实现 [`ChannelSetupAdapter`](openclaw/src/channels/plugins/types.adapters.ts:75)，让用户可以通过 `openclaw setup xiotbox` 交互式配置：
```ts
setup: {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    // 将用户输入的 GATEWAY_WSS_URL, DEVICE_ID, DEVICE_TOKEN 写入配置
  },
  validateInput: ({ cfg, accountId, input }) => {
    // 校验 URL 格式、token 非空等
  },
}
```

### 5.4 支持 `config` adapter 的 `describeAccount` 增强

**现状**: [`describeAccount`](src/channel.ts:1614) 返回信息较少。

**建议**: 增加连接状态、E2E 密钥状态、最后连接时间等信息：
```ts
describeAccount: (account) => ({
  accountId: account.accountId,
  name: account.config?.name || 'XiotBox',
  enabled: account.enabled,
  configured: Boolean(account.config?.DEVICE_ID && account.config?.DEVICE_TOKEN),
  connected: activeGatewayAccounts.has(account.accountId),
  lastConnectedAt: activeGatewayAccounts.get(account.accountId)?.startedAt ?? null,
}),
```

---

## 六、安全改进

### 6.1 E2E 密钥文件权限检查

**现状**: [`e2e.ts`](src/e2e.ts) 读写密钥文件时未检查文件权限。

**建议**: 在写入私钥文件时设置 `0o600` 权限（仅 owner 可读写），读取时验证权限未被放宽。

### 6.2 `DEVICE_TOKEN` 日志脱敏

**现状**: 配置对象可能在日志中被完整序列化。

**建议**: 在序列化配置时对敏感字段（`DEVICE_TOKEN`, `E2E_KEY_PATH` 内容等）进行脱敏。

---

## 七、测试改进

### 7.1 补充单元测试覆盖

**现状**: [`test/`](test/) 目录只有 5 个测试文件，且都是 `.test.mjs`（纯 JS）。

**建议**:
- 将测试转为 TypeScript（`.test.ts`）
- 补充以下关键路径的测试：
  - `normalizeTextPayload` 边界情况
  - `buildInboundMediaContext` 多种 payload 格式
  - `isHardExitCommand` 中英文命令
  - `extractProgressSnapshot` 各种进度格式
  - E2E 加解密往返测试
  - Session key 构建逻辑

### 7.2 添加集成测试

**建议**: 添加 mock WSS server 的集成测试，验证完整的 COMMAND 处理流程。

---

## 八、构建与发布改进

### 8.1 升级构建工具链

**现状**: 仅使用 `tsc` 编译。

**建议**: 考虑使用 `tsdown`（openclaw 核心使用的 [`tsdown.config.ts`](openclaw/tsdown.config.ts)）进行打包，获得 tree-shaking 和更小的输出。

### 8.2 补充 `peerDependencies`

**现状**: `package.json` 中没有声明对 openclaw 的 peer 依赖。

**建议**: 添加：
```json
"peerDependencies": {
  "openclaw": ">=2026.3.22"
}
```

### 8.3 版本同步

**现状**: `package.json` 和 `openclaw.plugin.json` 都硬编码版本号 `2.0.29`，需要手动同步。

**建议**: 在构建脚本中自动同步版本号，或使用单一版本源。

---

## 九、优先级排序

| 优先级 | 改进项 | 影响 |
|--------|--------|------|
| P0 | 采用 `defineBundledChannelEntry` 入口模式 | 框架兼容性 |
| P0 | 使用 `ctx.channelRuntime` 替代全局单例 | 类型安全 + 多实例 |
| P0 | 消除 `any` 类型 | 代码质量 |
| P1 | 拆分 `channel.ts` 单体文件 | 可维护性 |
| P1 | 启用 `strict: true` | 类型安全 |
| P1 | 实现 `stopAccount` | 生命周期完整性 |
| P1 | 修正 `capabilities.media` 声明 | 功能正确性 |
| P2 | 统一日志使用 | 可观测性 |
| P2 | 实现 `setup` adapter | 用户体验 |
| P2 | 实现 `lifecycle` adapter | 配置热更新 |
| P2 | 实现 `doctor` adapter | 诊断能力 |
| P3 | 将 `wss_client.js` 转 TypeScript | 类型安全 |
| P3 | 补充测试覆盖 | 代码质量 |
| P3 | E2E 密钥权限检查 | 安全性 |
| P3 | 使用 `setStatus` 报告连接状态 | 可观测性 |
