# MiMo 代码审核：openclaw-channel-xiotbox 3.0.2

> 审核时间：2026-05-05
> 审核人：MiMo

## 一、变更验证

### 1. ✅ `clearConnectedAtForInstance` 辅助函数

新增（[`channel.ts:143-148`](openclaw-channel-xiotbox/src/channel.ts:143)）：

```ts
function clearConnectedAtForInstance(accountId: string, instanceId: number): void {
  const current = activeGatewayAccounts.get(accountId);
  if (current?.instanceId === instanceId) {
    current.connectedAt = undefined;
  }
}
```

将 3.0.1 中 `disconnected` 事件的内联清理逻辑提取为独立函数，DRY 且语义清晰。instanceId 守卫正确保留。

### 2. ✅ `disconnected` 事件使用新辅助函数

[`channel.ts:2719-2729`](openclaw-channel-xiotbox/src/channel.ts:2719)：

```ts
client.on('disconnected', () => {
  log?.warn?.(`[XiotBox][${accountId}] Disconnected from Gateway`);
  clearConnectedAtForInstance(accountId, instanceId);  // ← 使用新函数
  updateGatewayStatus(ctx, accountId, { ... }, log);
});
```

### 3. ✅ `error` 事件补充 `connectedAt` 清理

[`channel.ts:2731-2741`](openclaw-channel-xiotbox/src/channel.ts:2731)：

```ts
client.on('error', (err: any) => {
  log?.error?.(`[XiotBox][${accountId}] Client error: ${err.message}`);
  clearConnectedAtForInstance(accountId, instanceId);  // ← 新增
  updateGatewayStatus(ctx, accountId, { ... }, log);
});
```

这正是 3.0.1 审核中建议的修复。

### 4. ✅ 版本同步

- [`package.json`](openclaw-channel-xiotbox/package.json:3): `"version": "3.0.2"` ✅
- [`openclaw.plugin.json`](openclaw-channel-xiotbox/openclaw.plugin.json:5): `"version": "3.0.2"` ✅

## 二、结论

3.0.2 正确修复了 3.0.1 审核中发现的唯一问题（`error` 事件未清除 `connectedAt`）。实现干净，提取辅助函数避免了代码重复。**3.0 线至此所有已知状态管理 bug 已清零。**

同意停止零散状态补丁，进入 3.1 架构迭代。

## 三、对后续迭代路线的反馈

### 3.1 vs 3.2 顺序

当前路线将 `defineBundledChannelEntry` 迁移（3.1）放在 `channel.ts` 模块化拆分（3.2）之前。两种顺序各有道理：

**先 3.1（当前方案）的优势**：
- 先确立正确的插件契约，后续拆分在正确的入口框架下进行
- 可以立即获得 OpenClaw 的 runtime 注入、setup 能力等基础设施
- 拆分时各模块可以直接使用 `ctx.channelRuntime` 等正式 API

**先 3.2 的优势**：
- 小文件更容易理解和迁移
- 每个模块可独立测试后再改入口

**建议**：维持当前顺序（3.1 → 3.2），但 3.1 迁移时应同时做最小拆分——至少将 `gateway-state.ts`（`activeGatewayAccounts`、`clearConnectedAtForInstance`、`updateGatewayStatus`、`stopActiveGatewayAccount`）和 `config.ts`（`resolveEffectiveConfig`、`buildConfig`、`getChannelConfig`）拆出，避免在 2800 行单体文件上做入口迁移。

### 3.3 数字员工治理

doctor / security / setup 三个 adapter 的优先级建议：

1. **setup adapter**（最高）：用户首次配置时的引导体验，直接影响可用性
2. **doctor adapter**（高）：连接诊断、E2E 密钥检查、配置验证，降低排障成本
3. **security adapter**（中）：DM 策略、权限边界，需要先完成权限模型设计

建议 3.3 拆分为 3.3a（setup + doctor）和 3.3b（security + 权限模型），避免单个版本承载过多设计决策。

### 3.4 测试工程

建议将 mock WSS server 测试提前到 3.2 中与模块化同步进行。拆出 `gateway-state.ts` 后，立即为其编写状态机测试，而不是等到 3.4。这样 3.2 的拆分质量有测试保障。
