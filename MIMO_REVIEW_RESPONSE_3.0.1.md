# openclaw-channel-xiotbox 3.0.1 对 MiMo 复审的修复回复

> 本文档用于回应 `MIMO_CODE_REVIEW_3.0.0.md` 对 `openclaw-channel-xiotbox@3.0.0` 的二次代码审核，并说明 `3.0.1` 已完成的修复、验证结果和仍需后续推进的事项。

## 一、本轮修复概况

MiMo 对 `3.0.0` 的复审指出了一个真实运行态 bug，以及三类质量问题：

- `describeAccount.connected` 在 WSS 断开后仍可能报告 `true`。
- `loadCurrentConfig` 的配置优先级与“减少全局单例依赖”的目标不一致。
- 新增辅助函数仍大量使用 `any`，类型收紧不足。
- `updateGatewayStatus` 完全吞掉异常，状态上报失败时不可观测。

本轮已经发布修复版本：

- 分支：`3.0`
- Tag：`3.0.1`
- Commit：`b70f873 fix: correct xiotbox runtime status reporting`
- 上一版本：`3.0.0 / eb08b49`

## 二、逐项回应 MiMo 审核意见

### 1. 修复 `describeAccount.connected` 假阳性

MiMo 发现的问题成立。

`3.0.0` 中 `describeAccount` 读取的是 `activeGatewayAccounts.get(accountId)?.connectedAt`，但 `client.on('disconnected')` 只调用了 `updateGatewayStatus(... connected: false)`，没有同步清理 `activeGatewayAccounts` 内部状态。因此 OpenClaw 状态快照虽然可能显示断开，但 `describeAccount` 仍可能报告：

```ts
connected: true
```

`3.0.1` 已修复：

```ts
client.on('disconnected', () => {
  const current = activeGatewayAccounts.get(accountId);
  if (current?.instanceId === instanceId) {
    current.connectedAt = undefined;
  }
  updateGatewayStatus(ctx, accountId, {
    running: true,
    connected: false,
    lastDisconnectedAt: Date.now(),
    lastStatusAt: Date.now(),
    detail: 'disconnected',
  }, log);
});
```

修复后，`describeAccount.connected` 和 `ctx.setStatus({ connected: false })` 的语义保持一致。

### 2. 修正配置解析优先级

MiMo 对 `loadCurrentConfig()` 的批评成立。

`3.0.0` 的优先级是：

```ts
runtime.loadConfig() > ctx.cfg > startupCfg
```

这会让全局 runtime 单例仍然位于主路径优先级最高的位置，与“优先使用 OpenClaw Gateway 上下文”的目标不一致。

`3.0.1` 已改为：

```ts
function resolveEffectiveConfig(ctx: GatewayContextLike, startupCfg: unknown): unknown {
  return ctx?.cfg ?? getXiotboxRuntimeOrNull()?.config?.loadConfig?.() ?? startupCfg;
}
```

新的优先级为：

```text
ctx.cfg > runtime.loadConfig() > startupCfg
```

这样 `ctx.cfg` 作为 `startAccount` 当前调用上下文的权威配置快照，会被优先使用；全局 runtime 仅作为旧版兼容 fallback。

同时函数名从 `loadCurrentConfig` 改为 `resolveEffectiveConfig`，避免误导。

### 3. 收紧新增辅助函数类型

MiMo 指出 `3.0.0` 的新增函数仍大量使用 `any`，这个评价准确。

`3.0.1` 没有直接 import OpenClaw 2026.5.x SDK 类型，原因是当前 package 中 `openclaw` 是 optional peer dependency，直接引用 OpenClaw SDK 类型可能导致第三方安装、bridge/standalone 场景构建失败。

因此本轮采用内部窄类型作为过渡：

```ts
type GatewayLogSink = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type GatewayContextLike = {
  accountId?: string | null;
  cfg?: unknown;
  channelRuntime?: {
    reply?: RuntimeReplySurface;
  } | null;
  getStatus?: () => Record<string, unknown>;
  setStatus?: (status: Record<string, unknown>) => void;
};

type GatewayStartContextLike = GatewayContextLike & {
  log?: GatewayLogSink;
  abortSignal?: AbortSignal;
};
```

`runtime.ts` 也新增了较窄的 `RuntimeReplySurface`：

```ts
export type RuntimeReplySurface = {
  dispatchReplyWithBufferedBlockDispatcher?: (args: Record<string, unknown>) => Promise<any>;
  createReplyDispatcherWithTyping?: (args: Record<string, unknown>) => any;
  finalizeInboundContext?: (ctx: unknown) => any;
  dispatchReplyFromConfig?: (args: Record<string, unknown>) => Promise<any>;
  [key: string]: unknown;
};
```

对应函数已从裸 `any` 改为这些内部类型：

- `getChannelRuntimeSurface(ctx: GatewayContextLike)`
- `getReplyApi(ctx: GatewayContextLike)`
- `resolveEffectiveConfig(ctx: GatewayContextLike, startupCfg: unknown)`
- `updateGatewayStatus(ctx: GatewayContextLike, ...)`
- `startAccount(ctx: GatewayStartContextLike)`
- `stopAccount(ctx: GatewayStartContextLike)`

这是保守但实际可落地的类型收紧。下一阶段如果确认 OpenClaw 对外 SDK 类型导出稳定，应再迁移到官方 `ChannelGatewayContext` / `ChannelRuntimeSurface` 类型。

### 4. `updateGatewayStatus` 不再完全吞异常

MiMo 指出 `catch (_err)` 完全静默会导致状态上报失败不可观测，这个意见成立。

`3.0.1` 已调整为：

```ts
function updateGatewayStatus(
  ctx: GatewayContextLike,
  accountId: string,
  patch: Record<string, unknown>,
  log?: GatewayLogSink,
): void {
  if (typeof ctx?.setStatus !== 'function') return;
  try {
    const current = typeof ctx.getStatus === 'function' ? ctx.getStatus() : {};
    ctx.setStatus({
      ...current,
      accountId,
      ...patch,
    });
  } catch (err) {
    log?.warn?.(`[XiotBox][${accountId}] status update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

状态上报失败不会中断 WSS 主链路，但会留下日志。

## 三、本轮未解决的问题

### 1. 尚未新增专门测试覆盖 `describeAccount.connected`

本轮已通过现有测试，但 MiMo 对测试覆盖的批评仍然成立。

现有 `59` 个测试主要覆盖：

- 文本规范化
- 媒体上下文映射
- session key/context epoch
- 工具-only fallback
- control tool 纯函数逻辑

它们没有直接覆盖：

- WSS connected/disconnected 事件后的 `describeAccount.connected`
- `updateGatewayStatus` 失败日志
- `getReplyApi` fallback 链
- `resolveEffectiveConfig` 优先级
- `stopAccount` 生命周期

原因是目前这些逻辑仍嵌在 `channel.ts` 的 `startAccount` 闭包和 WSS 客户端事件里，尚未拆成可直接单测的独立模块。

后续建议：

- 在 3.1 或 3.2 拆出 `gateway-state.ts` 或 `channel-state.ts`。
- 为 account runtime state 增加纯函数测试。
- 为 WSS 事件建立 mock client 集成测试。

### 2. 仍未直接采用 OpenClaw SDK 官方类型

`3.0.1` 使用内部窄类型，不等于最终类型方案。

原因：

- 当前插件需要兼容 OpenClaw 插件模式、bridge/standalone 模式和 Git tag 安装。
- `openclaw` 当前是 optional peer dependency。
- 如果直接 import OpenClaw 2026.5.x 源码中的 SDK 类型，可能影响旧版环境和外部构建。

后续建议：

- 在 `3.1` 迁移 `defineBundledChannelEntry` 时一并确认官方 SDK 类型的稳定导出路径。
- 若 OpenClaw 提供稳定 npm type export，则迁移到官方 `ChannelGatewayContext`。
- 若官方类型仍非外部稳定 API，则继续维持内部兼容类型，并减少 `any` 边界。

### 3. `channel.ts` 单体问题进一步突出

MiMo 指出 `channel.ts` 行数增长，这个判断也成立。

`3.0.1` 是 bugfix 和兼容性补丁，不适合同时做大拆分。下一阶段应把拆分作为明确工程目标，而不是继续在单体文件里累加状态逻辑。

建议拆分优先级：

1. `gateway-state.ts`：active account、connectedAt、status patch。
2. `config.ts`：配置解析、默认值、remote config。
3. `command-handler.ts`：COMMAND 处理主链路。
4. `progress.ts`：running/progress/streaming 文案和事件。
5. `session.ts`：session key、usage snapshot、context epoch。

## 四、验证结果

`3.0.1` 已执行：

```bash
npm run build
npm test
npm run release:check
git diff --check
```

结果：

- TypeScript 构建通过。
- Node test 通过：`59 passed, 0 failed`。
- Release check 通过：`Release check passed for 3.0.1`。
- 空白检查通过，仅有 Windows 工作区 LF/CRLF 提示。

## 五、发布信息

远程已推送：

```bash
git push origin 3.0
git push origin 3.0.1
```

升级命令：

```bash
bash scripts/update_openclaw_xiotbox.sh 3.0.1
systemctl restart openclaw-gateway
```

## 六、对 MiMo 下一轮审核的请求

请 MiMo 下一轮重点审核：

1. `connectedAt` 清理是否彻底解决 `describeAccount.connected` 假阳性。
2. `ctx.cfg > runtime.loadConfig() > startupCfg` 是否符合 OpenClaw Gateway 配置语义。
3. 内部窄类型作为 optional peer dependency 场景下的过渡方案是否合理。
4. `updateGatewayStatus` 的日志处理是否足够，是否需要进一步限制 `ctx.getStatus()` spread 范围。
5. 下一阶段迁移 `defineBundledChannelEntry` 时，外部插件应使用哪个稳定 SDK import 路径。

## 七、结论

MiMo 对 `3.0.0` 的复审准确指出了一个真实 bug 和几个工程质量缺口。`3.0.1` 已完成针对性修复：

- 状态假阳性已修复。
- 配置优先级已修正。
- 新增函数类型已初步收紧。
- 状态上报异常已可观测。
- 版本和 dist 已同步发布。

当前 `3.0.1` 可以作为 `3.0` 线的稳定修正版。后续应把 `defineBundledChannelEntry` 迁移、OpenClaw SDK 类型接入、`channel.ts` 模块化和 WSS 生命周期测试作为下一阶段硬性交付。
