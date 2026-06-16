# MiMo Code Review: XiotBox 3.1 Current Branch

> 审核对象：`3.1` 分支 commit `e5b645e`
> 基线版本：`3.0.2`
> 审核日期：2026-05-06
> 审核范围：入口 Spike、`gateway-state.ts`、`config.ts`、元数据兼容、测试覆盖

---

## 总评

**通过。** 本轮 3.1 改动质量扎实，模块拆分边界清晰，Spike 结论有据可依，元数据修复到位。72 个测试全部通过，服务器验证正常。建议在 3.1.0 发布前修补 1 个 P2 问题，其余为低优先级补充建议。

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 阻塞 | 0 | — |
| P1 建议修复 | 0 | — |
| P2 建议修补 | 1 | `stopGatewayAccount` 缺少 instanceId 保护 |
| P3 补充建议 | 3 | 测试补充、文档完善 |

---

## 逐项回答 7 个审核问题

### Q1: `defineBundledChannelEntry` 暂缓迁移的判断是否充分？

**结论：充分，同意暂缓。**

Spike 文档 [`openclaw-entry-spike-3.1.md`](openclaw-channel-xiotbox/docs/openclaw-entry-spike-3.1.md) 设计严谨：

- 5 个实验覆盖了外部包加载、`importMetaUrl` 解析、optional peer dependency 风险、sidecar/tools 发现、`register(api)` 兼容性
- 本地 Windows 和 OpenClaw 2026.5.4 Linux 宿主双重验证，结论一致：`ERR_MODULE_NOT_FOUND`
- 手动入口回归在两个环境均通过，确认当前路径稳定
- 决策规则清晰：不迁移，等 OpenClaw 暴露稳定外部 SDK 路径

**补充建议（P3）：** Spike 文档的 "Required Follow-Ups" 第 1 条提到 "If OpenClaw source is available locally, rerun with OPENCLAW_ENTRY_SPECIFIER pointing at the actual exported SDK path"。建议在 [`openclaw-entry-spike-3.1.md`](openclaw-channel-xiotbox/docs/openclaw-entry-spike-3.1.md:323) 的 Follow-Ups 中补充：当 OpenClaw 发布包含 `channel-entry-contract` 的稳定外部 SDK 包时，应在下一个 minor 版本重新执行此 Spike。

---

### Q2: `gateway-state.ts` 是否真正消除了 `activeGatewayAccounts` 的直接 Map 操作风险？

**结论：是，封装完整。**

[`gateway-state.ts`](openclaw-channel-xiotbox/src/gateway-state.ts) 的设计要点：

1. **Map 不可导出**：`activeGatewayAccounts` 是模块级 `const`（第 18 行），不通过 `export` 暴露，外部无法直接操作。

2. **`getGatewayAccount` 返回浅拷贝**（第 30-39 行）：
   ```ts
   return {
     instanceId: current.instanceId,
     startedAt: current.startedAt,
     connectedAt: current.connectedAt,
     stop: current.stop,
   };
   ```
   调用方拿到的是副本，修改 `connectedAt` 不会影响内部状态。`stop` 函数引用是共享的，但这是预期行为——调用方需要通过 `stop` 引用来触发停止。

3. **`registerGatewayAccount` 使用 spread**（第 27 行）：`{ ...state }` 确保外部传入的对象不会被内部引用。

4. **所有写操作都有 instanceId 守卫**：
   - [`setConnectedAt`](openclaw-channel-xiotbox/src/gateway-state.ts:61)：`current?.instanceId !== instanceId` → return false
   - [`clearConnectedAt`](openclaw-channel-xiotbox/src/gateway-state.ts:68)：同上
   - [`removeGatewayAccount`](openclaw-channel-xiotbox/src/gateway-state.ts:41)：同上

5. **`describeGatewayAccountState` 是纯读**（第 75-82 行）：返回快照对象，不修改内部状态。

6. **`channel.ts` 的使用方式正确**：
   - [`connected` 事件](openclaw-channel-xiotbox/src/channel.ts:2512)：`setConnectedAt(accountId, instanceId, Date.now())`
   - [`disconnected` 事件](openclaw-channel-xiotbox/src/channel.ts:2527)：`clearConnectedAt(accountId, instanceId)`
   - [`error` 事件](openclaw-channel-xiotbox/src/channel.ts:2539)：`clearConnectedAt(accountId, instanceId)`
   - [`describeAccount`](openclaw-channel-xiotbox/src/channel.ts:1499)：`describeGatewayAccountState(accountId)`

   所有调用都通过导出函数，没有直接访问 Map。

**无问题。**

---

### Q3: 并发 stop 幂等实现是否覆盖 OpenClaw reload/replace 场景？

**结论：基本覆盖，有一个 P2 边界情况需要修补。**

当前有**两层**幂等保护：

**第一层：[`gateway-state.ts` 的 `stopGatewayAccount`](openclaw-channel-xiotbox/src/gateway-state.ts:48-59)**
```ts
if (!current.stopPromise) {
  current.stopPromise = Promise.resolve(current.stop(reason));
}
await current.stopPromise;
```
多次调用 `stopGatewayAccount` 只会执行一次 `stop`，后续调用 await 同一个 promise。

**第二层：[`channel.ts` 的 `stopCurrent`](openclaw-channel-xiotbox/src/channel.ts:1564-1581)**
```ts
if (stopPromise) {
  return stopPromise;
}
stopPromise = (async () => { ... })();
return stopPromise;
```
即使 `stopCurrent` 被直接调用多次（如 `startAccount` 中的 `existing.stop('replaced_by_new_start')`），也只执行一次。

**OpenClaw reload 场景分析：**

- `startAccount` 被调用时，先通过 [`getGatewayAccount`](openclaw-channel-xiotbox/src/channel.ts:1538) 获取旧实例，然后调用 `existing.stop('replaced_by_new_start')`。这走的是 `stopCurrent` 函数引用，不经过 `stopGatewayAccount`。幂等由第二层保证。
- `stopAccount` 被调用时，走 [`stopGatewayAccount(accountId, 'stop_account')`](openclaw-channel-xiotbox/src/channel.ts:2597)。幂等由第一层保证。
- 如果 `startAccount` 和 `stopAccount` 并发：`startAccount` 调用 `existing.stop()` 直接停旧实例，`stopAccount` 调用 `stopGatewayAccount` 也会尝试停。由于两层幂等保护，不会重复执行。

**P2 问题：`stopGatewayAccount` 缺少 instanceId 保护**

[`stopGatewayAccount`](openclaw-channel-xiotbox/src/gateway-state.ts:48) 不接受 `instanceId` 参数，只按 `accountId` 查找。考虑以下时序：

1. 实例 A 注册（`stop: null`，第 1555 行的占位注册）
2. `stopGatewayAccount(accountId, 'reason')` 被调用，找到实例 A，发现 `stop` 为 null，直接 `delete`（第 52 行）
3. 实例 A 的 `startAccount` 继续执行，注册带 `stop: stopCurrent` 的版本（第 1582 行）

步骤 2 的 `delete` 会删除步骤 3 可能已经注册的新实例（如果时序恰好交错）。虽然在实践中这个窗口极小（步骤 1 到 3 之间是同步代码），但理论上存在竞态。

**建议修复：** 在 `stopGatewayAccount` 中增加 instanceId 参数，或在 `delete` 前检查当前 Map 中的 entry 是否仍是调用时获取的那个。最简方案：

```ts
export async function stopGatewayAccount(accountId: string, reason: string): Promise<void> {
  const current = activeGatewayAccounts.get(accountId);
  if (!current) return;
  if (!current.stop) {
    // 只有当 Map 中的 entry 仍然是我们获取的那个时才删除
    if (activeGatewayAccounts.get(accountId) === current) {
      activeGatewayAccounts.delete(accountId);
    }
    return;
  }
  if (!current.stopPromise) {
    current.stopPromise = Promise.resolve(current.stop(reason));
  }
  await current.stopPromise;
}
```

这个修复确保了：如果在 `get` 和 `delete` 之间有新实例注册（替换了 Map entry），不会误删新实例。

---

### Q4: `config.ts` 是否拆分得足够纯净？是否存在隐性耦合？

**结论：拆分纯净，有一处 runtime 依赖可接受。**

[`config.ts`](openclaw-channel-xiotbox/src/config.ts) 的依赖分析：

| 依赖 | 用途 | 影响 |
|------|------|------|
| `./runtime.js` → `getXiotboxRuntimeOrNull` | 仅用于 `resolveEffectiveConfig()` | 唯一外部依赖 |

**纯函数部分（无外部依赖）：**
- 所有 `normalize*` 函数（第 17-93 行）
- `getChannelConfig`、`buildConfig`（第 95-132 行）
- `resolveAgentId`、`readThreadAgentMapValue`、`resolveThreadAgentId`（第 134-168 行）
- `listAccountIds`、`resolveDefaultAccountId`、`resolveAccount`（第 170-193 行）
- `buildSessionKey`（第 58-66 行）

**唯一非纯函数：**
- [`resolveEffectiveConfig`](openclaw-channel-xiotbox/src/config.ts:195-197)：读取全局 runtime 单例

**对多 agent/account/session 的影响评估：**

1. **多 agent**：[`resolveThreadAgentId`](openclaw-channel-xiotbox/src/config.ts:161) 已支持 `SESSION_AGENT_MAP` / `THREAD_AGENT_MAP` 映射，`normalizeAgentId` 做了安全规范化。无耦合问题。

2. **多 account**：[`listAccountIds`](openclaw-channel-xiotbox/src/config.ts:170) 当前只返回单 account（`DEFAULT_ACCOUNT_ID`），[`resolveAccount`](openclaw-channel-xiotbox/src/channel.ts:185) 总是返回 root config。这是当前单 account 模型的正确实现，未来扩展多 account 时需要修改这两个函数，但不影响现有接口签名。

3. **多 session**：[`buildSessionKey`](openclaw-channel-xiotbox/src/config.ts:58) 已包含 `agentId:deviceId:threadId:contextEpoch`，天然支持多 session 隔离。

4. **`resolveEffectiveConfig` 的 runtime 依赖**：这是唯一需要关注的点。如果未来多 account 需要不同 config source，全局 runtime 单例可能不够灵活。但对 3.1 范围来说，这是可接受的——OpenClaw 插件生命周期中 `ctx.cfg` 始终是第一优先级，runtime 只是 fallback。

**无阻塞问题。**

---

### Q5: `resolveEffectiveConfig()` 的配置优先级是否正确？

**结论：正确。**

```ts
export function resolveEffectiveConfig(ctx: ConfigContextLike, startupCfg: unknown): unknown {
  return ctx?.cfg ?? getXiotboxRuntimeOrNull()?.config?.loadConfig?.() ?? startupCfg;
}
```

优先级链：`ctx.cfg` > `runtime.loadConfig()` > `startupCfg`

| 优先级 | 来源 | 语义 |
|--------|------|------|
| 1（最高） | `ctx.cfg` | OpenClaw 宿主在每次 gateway 调用时注入的最新配置 |
| 2 | `runtime.loadConfig()` | 插件 runtime 层的配置（可能来自文件或环境变量） |
| 3（最低） | `startupCfg` | 插件启动时捕获的初始配置快照 |

这符合 OpenClaw 插件生命周期语义：
- 宿主配置（`ctx.cfg`）是最权威的，因为宿主可能在运行时更新配置
- Runtime 配置是插件自身的 fallback
- 启动配置是最后的保底

[`config.test.mjs` 第 89-96 行](openclaw-channel-xiotbox/test/config.test.mjs:89) 验证了 `ctx.cfg` 优先于 runtime：

```ts
setXiotboxRuntime({ config: { loadConfig: () => ({ source: 'runtime' }) } });
assert.deepEqual(
  resolveEffectiveConfig({ cfg: { source: 'ctx' } }, { source: 'startup' }),
  { source: 'ctx' }
);
```

**补充建议（P3）：** 当前测试只验证了 `ctx.cfg` 优先于 runtime 的场景。建议补充两个测试用例：
1. `ctx.cfg` 为 `undefined` 时，回退到 runtime
2. `ctx.cfg` 和 runtime 都为 `undefined` 时，回退到 `startupCfg`

---

### Q6: `contracts.tools` / `toolMetadata` 是否满足 OpenClaw 2026.5.x 元数据要求？

**结论：满足当前要求。**

**[`package.json`](openclaw-channel-xiotbox/package.json:93-98) 声明：**
```json
"contracts": {
  "tools": [
    "xiotbox_local_control",
    "xiotbox_control"
  ]
}
```

**[`openclaw.plugin.json`](openclaw-channel-xiotbox/openclaw.plugin.json:7-24) 声明：**
```json
"contracts": {
  "tools": ["xiotbox_local_control", "xiotbox_control"]
},
"toolMetadata": [
  {
    "id": "xiotbox_local_control",
    "name": "XiotBox Local Control",
    "description": "Optional local-control HTTP tool for trusted XiotBox device-control actions."
  },
  {
    "id": "xiotbox_control",
    "name": "XiotBox Control",
    "description": "Optional XiotBox control-plan tool for trusted device-control workflows."
  }
]
```

**验证结果：** 服务器安装后不再出现 `registered incomplete metadata; filled missing docsPath` 和 `plugin must declare contracts.tools before registering agent tools` 警告。

**与 OpenClaw 内置扩展对比：** 查看 [`openclaw/extensions/telegram/openclaw.plugin.json`](openclaw/extensions/telegram/openclaw.plugin.json)，Telegram 扩展的元数据非常简洁（只有 `configSchema`），没有 `contracts` 或 `toolMetadata`。这是因为 Telegram 不注册 agent tools。XiotBox 作为注册了可选 tools 的插件，需要声明 `contracts.tools`，当前声明粒度正确。

**关于更严格的权限/安全/审计字段：** 当前 `toolMetadata` 只有 `id`/`name`/`description`，没有 `permissions`、`security`、`audit` 等字段。这在 3.1 范围内是足够的——OpenClaw 2026.5.4 没有要求这些字段。建议在 3.3（数字员工治理）中根据 OpenClaw 的 tool policy 机制补充。

**无阻塞问题。**

---

### Q7: 是否同意在 3.1.0 前只做必要修补，不继续扩大重构范围？

**同意。** 理由：

1. 本轮模块拆分（`gateway-state.ts` 83 行 + `config.ts` 198 行）已将 `channel.ts` 的核心状态管理和配置逻辑分离，降低了单体复杂度。
2. 测试从 59 增长到 72，新增模块有独立测试覆盖。
3. 服务器验证通过，WSS 连接正常，无回归。
4. 入口 Spike 结论明确，不需要在 3.1 做入口迁移。
5. 元数据兼容已修复。

**3.1.0 发布前只需：**
1. 修补 Q3 的 P2 问题（`stopGatewayAccount` instanceId 保护）
2. 版本 bump 到 `3.1.0`（`package.json`、`package-lock.json`、`openclaw.plugin.json` 同步）
3. 完整验证：`npm run build && npm test && npm run release:check && npm run spike:entry`

---

## 补充发现

### 发现 1：`startAccount` 双重注册（信息，非问题）

[`channel.ts` 第 1555 行](openclaw-channel-xiotbox/src/channel.ts:1555) 先注册 `stop: null` 的占位，第 1582 行再用 `stop: stopCurrent` 覆盖。这是有意设计——占位防止并发 `startAccount` 重复启动，后续覆盖添加实际 stop 函数。逻辑正确，但建议在第 1555 行加注释说明意图：

```ts
// 占位注册：防止并发 startAccount 重复启动，stop 将在下方覆盖
registerGatewayAccount(accountId, { instanceId, startedAt: Date.now(), stop: null });
```

### 发现 2：`getGatewayAccount` 返回 `stop` 函数引用（信息，非问题）

[`getGatewayAccount`](openclaw-channel-xiotbox/src/gateway-state.ts:30) 返回的浅拷贝包含 `stop` 函数引用。`startAccount` 通过 `existing.stop('replaced_by_new_start')` 调用它来停止旧实例。这是正确的——`stop` 函数的闭包捕获了正确的 `client` 和 `instanceId`，且 `stopCurrent` 内部有幂等保护。

### 发现 3：`config.test.mjs` 的 `resolveEffectiveConfig` 测试可补充（P3）

当前只测试了 `ctx.cfg` 优先场景。建议补充：

```ts
test('resolveEffectiveConfig falls back to runtime when ctx.cfg is undefined', () => {
  setXiotboxRuntime({ config: { loadConfig: () => ({ source: 'runtime' }) } });
  assert.deepEqual(resolveEffectiveConfig({}, { source: 'startup' }), { source: 'runtime' });
});

test('resolveEffectiveConfig falls back to startupCfg when both ctx.cfg and runtime are absent', () => {
  setXiotboxRuntime(null);
  assert.deepEqual(resolveEffectiveConfig({}, { source: 'startup' }), { source: 'startup' });
});
```

---

## 审核结论

| 项目 | 状态 |
|------|------|
| Q1: 入口 Spike 暂缓迁移 | ✅ 通过 |
| Q2: gateway-state.ts 封装完整性 | ✅ 通过 |
| Q3: 并发 stop 幂等 | ⚠️ P2 修补建议 |
| Q4: config.ts 拆分纯净度 | ✅ 通过 |
| Q5: resolveEffectiveConfig 优先级 | ✅ 通过 |
| Q6: 元数据兼容 | ✅ 通过 |
| Q7: 冻结重构范围 | ✅ 同意 |

**建议 3.1.0 发布前完成：**
1. 修补 `stopGatewayAccount` 的 instanceId 保护（P2）
2. 补充 `resolveEffectiveConfig` 的 fallback 测试（P3）
3. 版本 bump + 完整验证 + tag

**整体评价：** 3.1 分支的模块拆分策略正确，执行质量高。`gateway-state.ts` 和 `config.ts` 的边界清晰，依赖方向合理（`channel.ts` → `gateway-state.ts` / `config.ts` → `runtime.ts`），没有反向依赖。测试覆盖充分。可以进入 3.1.0 收口阶段。
