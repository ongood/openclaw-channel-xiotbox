# MiMo 路线图审核：XiotBox 3.1 – 3.4

> 审核时间：2026-05-05
> 审核人：MiMo

## 一、总体评价

路线图结构清晰、优先级合理、验收标准可操作。3.0.2 冻结 → 3.1 入口迁移+最小拆分 → 3.2 核心模块化+测试 → 3.3a/b 治理能力 → 3.4 工程门禁，节奏稳健。

**同意此路线图，以下是对各阶段的具体反馈。**

---

## 二、逐阶段反馈

### 3.1：OpenClaw 一等入口 + 最小结构拆分

**同意范围**。补充几点：

#### 2.1 `defineBundledChannelEntry` 迁移前的前置验证

在正式迁移前，建议先做一个**可行性验证 spike**（不合并，仅本地验证）：

1. 确认 OpenClaw 2026.5.x 的 `defineBundledChannelEntry` 是否支持从外部 npm 包加载（而非仅限 `extensions/` 目录下的内置插件）
2. 确认 `importMetaUrl` 解析在外部包场景下是否正确（参见 [`channel-entry-contract.ts:277-330`](openclaw/src/plugin-sdk/channel-entry-contract.ts:277) 的 `resolveBundledEntryModulePath`）
3. 确认 `openclaw` 作为 optional peer dependency 时，`defineBundledChannelEntry` 的 import 是否会导致构建失败

如果验证发现外部包不支持 `defineBundledChannelEntry`，则 3.1 应调整为：先推动 OpenClaw 核心支持外部插件入口，再做迁移。

#### 2.2 `gateway-state.ts` 拆分建议

建议包含以下内容：

```
gateway-state.ts
├── activeGatewayAccounts: Map<string, ActiveGatewayAccount>
├── gatewayInstanceSeq: number
├── clearConnectedAtForInstance(accountId, instanceId)
├── updateGatewayStatus(ctx, accountId, patch, log)
├── stopActiveGatewayAccount(accountId, reason)
├── registerGatewayAccount(accountId, instanceId, stopFn)
├── unregisterGatewayAccount(accountId, instanceId)
└── isCurrentInstance(accountId, instanceId)
```

关键点：`activeGatewayAccounts` 的所有读写都应通过 `gateway-state.ts` 导出的函数进行，`channel.ts` 不再直接操作 Map。这样状态机测试才能完整覆盖。

#### 2.3 `config.ts` 拆分建议

建议包含以下内容：

```
config.ts
├── getChannelConfig(cfg)
├── buildConfig(channelCfg)
├── resolveEffectiveConfig(ctx, startupCfg)
├── resolveAgentId(cfg)
├── resolveThreadAgentId(cfg, threadId)
├── resolveDefaultAccountId(cfg)
├── listAccountIds(cfg)
├── resolveAccount(cfg, accountId)
├── normalizeAccountId(value)
├── normalizeStrList(value, fallback)
├── normalizeThreadId(value)
├── normalizeAgentId(value)
└── buildSessionKey(agentId, deviceId, threadId, contextEpoch)
```

注意：`buildSessionKey` 和 `normalizeAgentId` 等函数目前被 `session.ts`（未来）和 `command-handler.ts`（未来）共同使用。放在 `config.ts` 中作为共享工具函数是合理的，但要避免循环依赖。

#### 2.4 `defineBundledChannelSetupEntry` 同步迁移

文档提到迁移 `defineBundledChannelSetupEntry`，这是正确的。当前 [`setup-entry.ts`](openclaw-channel-xiotbox/setup-entry.ts) 只有 3 行简单 re-export，迁移成本低。但要确认：

- `setup-entry.ts` 的 `openclaw.plugin.json` 中 `setupEntry` 字段是否需要同步更新
- setup 流程是否需要 `setChannelRuntime` 回调（当前未使用）

---

### 3.2：核心通道模块化 + mock WSS 测试

**同意范围**。补充几点：

#### 3.1 mock WSS server 设计建议

建议使用 Node.js 内置 `http` + `ws` 库搭建轻量 mock server，覆盖以下场景：

| 场景 | 测试点 |
|------|--------|
| 正常连接 | HELLO → HELLO_ACK → connected 事件 |
| 认证失败 | HELLO → AUTH_REQUIRED → 断开 |
| 心跳超时 | 连接后无 HEARTBEAT → 断开 |
| COMMAND 入站 | 收到 E2E 加密 COMMAND → 解密 → dispatch → COMMAND_RESULT |
| COMMAND 重发 | 相同 command_id → 返回缓存结果 |
| 断开重连 | disconnected → 自动重连 → connected |
| error 事件 | WebSocket error → connectedAt 清除 → 状态更新 |

#### 3.2 `command-handler.ts` 拆分边界

COMMAND 处理是 `channel.ts` 中最大的代码块（约 800 行，line 1827-2642）。建议拆分时保留 `channel.ts` 中的事件注册，但将处理逻辑委托给 `command-handler.ts`：

```ts
// channel.ts
client.on('COMMAND', async (payload) => {
  await handleCommand({ payload, client, ctx, e2e, finalCfg, ... });
});
```

`handleCommand` 内部再调用 `session.ts`、`progress.ts`、`media.ts` 等模块。

#### 3.3 `session.ts` 范围

```
session.ts
├── buildSessionKey(...)
├── resolveSessionStorePath(cfg, sessionKey)
├── loadSessionStore(storePath)
├── resolveSessionUsageSnapshot(cfg, sessionKey)
├── sessionStoreCache 管理
├── resolveInboundContextEpoch(...)
├── contextEpochCache 管理
└── pruneContextEpochCache()
```

#### 3.4 `progress.ts` 范围

```
progress.ts
├── extractProgressSnapshot(outPayload)
├── buildProgressRunningText(params)
├── buildProgressFingerprint(params)
├── buildRunningStreamEvents(params)
├── normalizeProgressPercent(value)
├── compactProgressText(value, maxLen)
├── hasInProgressSignal(outPayload)
├── isLikelyInProgressText(text)
└── IN_PROGRESS_HINTS 常量
```

---

### 3.3a：Setup + Doctor

**同意范围**。补充：

#### 4.1 setup adapter 最小实现

建议第一版只做配置验证和引导，不做交互式配置向导：

```ts
setup: {
  validateConfig: (account) => {
    const issues = [];
    if (!account.config?.DEVICE_ID) issues.push('Missing DEVICE_ID');
    if (!account.config?.DEVICE_TOKEN) issues.push('Missing DEVICE_TOKEN');
    if (!account.config?.GATEWAY_WSS_URL) issues.push('Missing GATEWAY_WSS_URL');
    return { ok: issues.length === 0, issues };
  },
}
```

交互式向导可以作为 3.3a 的后续迭代。

#### 4.2 doctor adapter 检查项

建议按优先级排列：

1. **P0**：DEVICE_ID / DEVICE_TOKEN 是否配置
2. **P0**：GATEWAY_WSS_URL 是否可达（TCP 连接测试）
3. **P1**：E2E 密钥文件是否存在、权限是否正确
4. **P1**：E2E peer key 是否已建立（refreshPeerKey 是否成功）
5. **P2**：WSS 连接状态（需要运行时上下文）
6. **P2**：session store 是否可读写

---

### 3.3b：Security + 数字员工权限模型

**同意单独拆出**。补充：

#### 5.1 权限模型设计前置问题

在写代码之前，需要先回答以下设计问题：

1. **权限粒度**：是按 tool 粒度（`xiotbox_control.launch_app` vs `xiotbox_control.click`）还是按 action 类粒度（`app_control` vs `ui_interaction`）？
2. **审批触发条件**：是基于 tool name 匹配，还是基于 action 参数分析（例如 `click` 坐标在敏感区域）？
3. **默认策略**：默认 allow 还是 default deny？建议 default deny + allowlist。
4. **多数字员工场景**：不同 agent 是否有不同权限？还是全局统一？

建议 3.3b 开始前先出一份设计文档，review 后再编码。

---

### 3.4：发布工程和质量门禁

**同意范围**。补充：

#### 6.1 release checklist 自动化

当前 [`scripts/release_check.mjs`](openclaw-channel-xiotbox/scripts/release_check.mjs) 已存在。建议扩展检查项：

- [ ] `package.json` version == `openclaw.plugin.json` version
- [ ] `dist/` 目录存在且是最新的
- [ ] `CHANGELOG.md` 包含当前版本条目
- [ ] `git tag` 与 `package.json` version 一致
- [ ] `npm test` 全部通过
- [ ] `npm run build` 无警告

#### 6.2 CHANGELOG 维护

建议从 3.1 开始维护 [`CHANGELOG.md`](openclaw-channel-xiotbox/CHANGELOG.md)（如果尚未有），格式参考 OpenClaw 核心的 changelog。

---

## 三、风险提示

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `defineBundledChannelEntry` 不支持外部 npm 包 | 3.1 入口迁移阻塞 | 先做 spike 验证，不通过则推动核心改动 |
| 拆分引入循环依赖 | 编译失败 | 拍前画模块依赖图，单向依赖 |
| mock WSS 不覆盖真实网络抖动 | 集成测试盲区 | 3.4 补充真实环境 smoke test |
| 权限模型设计分歧 | 3.3b 延期 | 先出设计文档再编码 |

---

## 四、结论

路线图整体批准。3.1 开始前建议先做 `defineBundledChannelEntry` 外部包可行性 spike，确认无阻塞后再正式开工。
