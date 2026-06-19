# MiMo 审核：3.1 最终执行计划（定稿版）

> 审核时间：2026-05-05
> 审核人：MiMo
> 状态：**已批准**

## 一、总体判断

**批准此最终执行计划。** 计划结构清晰、风险控制到位、验收标准可操作。

---

## 二、3.1-alpha Spike 审核

### 5 个验证维度：✅ 全部通过

| 维度 | 审核意见 |
|------|----------|
| 1. 外部包加载能力 | ✅ 覆盖 npm/path/git 三种安装方式，输出明确 |
| 2. importMetaUrl 解析 | ✅ 覆盖 Windows/Linux/Termux，输出实际路径 |
| 3. optional peer dependency | ✅ 覆盖构建和运行两个阶段，明确 fallback 需求 |
| 4. sidecar/secrets/tools | ✅ 覆盖 tool discovery、secrets 注入、setup entry |
| 5. register/runtime injection | ✅ 覆盖 register(api)、setXiotboxRuntime、ctx.channelRuntime 三个注入点 |

### 输出物格式：✅ 完整

`docs/openclaw-entry-spike-3.1.md` 模板覆盖了所有实验的记录格式，结论部分有明确的 yes/no 决策框。

### 补充建议

spike 实验中建议增加一个**回归对照**：在 spike 实验前后分别运行 `npm test`，确认实验过程不影响现有功能。

---

## 三、3.1.0 模块拆分审核

### `gateway-state.ts`：✅ 批准

函数命名最终版确认：

| 函数 | 职责 |
|------|------|
| `nextGatewayInstanceId()` | 递增实例序号 |
| `registerGatewayAccount(accountId, state)` | 注册/覆盖活跃实例 |
| `getGatewayAccount(accountId)` | 读取活跃实例 |
| `removeGatewayAccount(accountId, instanceId)` | 按 instanceId 匹配删除 |
| `stopGatewayAccount(accountId, reason)` | 幂等停止 |
| `setConnectedAt(accountId, instanceId, timestamp)` | 设置连接时间 |
| `clearConnectedAt(accountId, instanceId)` | 清除连接时间 |
| `describeGatewayAccountState(accountId)` | 返回连接状态快照 |

**关键规则确认**：
- `activeGatewayAccounts` 不导出 ✅
- 所有 instance guard 集中在本模块 ✅
- stop 幂等 ✅

### `config.ts`：✅ 批准

迁移函数清单完整。依赖规则正确：

- `config.ts` 不 import `channel.ts` ✅
- `config.ts` 不 import `gateway-state.ts` ✅
- `gateway-state.ts` 不 import `config.ts`（优先传入已 normalize 的 accountId）✅

### 依赖图：✅ 正确

```
index.ts → channel.ts
channel.ts → config.ts, gateway-state.ts, runtime.ts, e2e.ts, runtime_config.ts, wss_client.js
config.ts → runtime.ts (仅 resolveEffectiveConfig 需要)
gateway-state.ts → 无外部依赖
```

无循环依赖。

---

## 四、3.2 mock WSS 审核

8 个场景全部批准。第 8 个场景（重连期间 instance 被替换）的覆盖重点正确：

- old instance reconnect 不得污染 new instance 状态
- old instance 不得清理 new instance connectedAt

---

## 五、3.3b 权限模型原则审核

**批准以下原则**：

1. 审批员工替代人类审批：**默认禁止**
2. AI 员工不能默认拥有 owner/admin 权限
3. 审批记录必须区分 `human_approval` 和 `agent_delegated_approval`
4. agent approval 必须可审计、可撤销、可限制范围

前置问题清单完整，增加了第 5 个问题（AI 审批是否允许及边界）是正确的。

---

## 六、执行顺序确认

```
1. 开 3.1 分支
2. 写 docs/openclaw-entry-spike-3.1.md
3. 做 spike 实验，不动主入口
4. 根据 spike 结论决定是否迁移 defineBundledChannelEntry
5. 拆 gateway-state.ts
6. 拆 config.ts
7. 补测试
8. 构建验证
9. 发布 3.1.0
```

**确认批准，可以开工。**
