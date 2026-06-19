# openclaw-channel-xiotbox 3.0.0 改进反馈

> 本文档用于回应 MiMo 基于 OpenClaw 2026.5.x 对 `openclaw-channel-xiotbox` 提出的插件改进建议，并说明本轮 `3.0.0` 分支/版本的完成情况、验证结果和后续规划。

## 一、本轮交付概况

本轮已新建 `3.0` 分支，并发布 `3.0.0` tag。

- 分支：`3.0`
- Tag：`3.0.0`
- Commit：`eb08b49 feat: start xiotbox 3.0 channel runtime lifecycle`
- 远程仓库：`github.com/ongood/openclaw-channel-xiotbox`

本轮没有把所有架构建议一次性做完，而是优先处理对线上稳定性、OpenClaw 新版运行时兼容性、生命周期完整性和发布可信度影响最大的部分。原因是该插件已经在真实 XiotBox/OpenClaw 通道中运行，过大的单次重构会增加回归风险。

## 二、已完成的建议项

### 1. 使用 `ctx.channelRuntime` 替代全局 runtime 单例

状态：已部分完成，采用兼容式迁移。

本轮在 `src/channel.ts` 中新增了 `getReplyApi(ctx)` 和 `loadCurrentConfig(ctx, fallbackCfg)`：

- 优先从 `ctx.channelRuntime.reply` 获取 OpenClaw 新版运行时能力。
- 保留 `getXiotboxRuntimeOrNull()` 作为旧版 OpenClaw 的 fallback。
- 避免通道主路径强依赖模块级 runtime 单例。

这一步可以减少 OpenClaw 运行时 API 演进时的断裂风险，同时避免直接全量切换导致旧版环境不可用。

### 2. 补充 `stopAccount` 生命周期

状态：已完成。

本轮新增 `gateway.stopAccount`，并抽出 `stopActiveGatewayAccount(accountId, reason)`：

- OpenClaw 停止 account 时会主动断开 XiotBox WSS 连接。
- 插件重启、配置变更、服务关闭时可更优雅地释放连接。
- 减少旧连接残留、重复连接和 `duplicate connection` 类问题。

这项对数字员工长期在线运行很关键。

### 3. 使用 `ctx.setStatus` 上报通道状态

状态：已完成第一版。

本轮新增 `updateGatewayStatus(ctx, accountId, patch)`，并在以下阶段上报状态：

- `starting`
- `connected`
- `disconnected`
- `client_error`
- `connect_failed`
- `runtime_unavailable`
- `stop_account`

这让 XiotBox 更接近 OpenClaw 一等 Channel 的运行形态，后续可以在 `openclaw status`、通道状态页、数字员工控制台中展示连接状态。

### 4. 增强 `describeAccount`

状态：已完成。

本轮 `describeAccount` 增加：

- `connected`
- `startedAt`
- `lastConnectedAt`

这可以帮助 OpenClaw 或管理界面识别 XiotBox account 的真实运行态。

### 5. 修正 `capabilities.media`

状态：已完成。

原来插件实际已经支持媒体上下文和 inline media staging，但 `capabilities.media` 仍声明为 `false`。本轮已修正为：

```ts
media: true
```

这使插件能力声明和真实能力一致。

### 6. 统一部分日志使用

状态：已部分完成。

本轮已将 `COMMAND handler error`、流式回调中的 `onBlockReply`、`onReasoningStream`、`onPartialReply` 等关键路径从 `console.error` 改为 `log?.error?.()`。

仍保留的后续项：

- `e2e.ts` 内部仍有部分 `console.log` / `console.warn`。
- 后续应给 E2E 模块注入 logger，避免底层模块直接写 stdout/stderr。

### 7. 发布元数据同步

状态：已完成。

本轮版本统一升级到 `3.0.0`，同步范围包括：

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- 安装脚本
- 更新脚本
- Termux 安装文档

这解决了 tag、安装提示、package 元数据不一致导致的线上排查误导问题。

### 8. 补充 OpenClaw peer dependency

状态：已完成。

本轮在 `package.json` 中新增：

```json
"peerDependencies": {
  "openclaw": ">=2026.3.22"
},
"peerDependenciesMeta": {
  "openclaw": {
    "optional": true
  }
}
```

`optional` 的原因是当前插件既支持 OpenClaw 插件模式，也支持独立安装/桥接场景，不应强制 npm 安装时必须解析 OpenClaw 包。

## 三、本轮暂缓的建议项与原因

### 1. `defineBundledChannelEntry` 入口模式

状态：暂缓，建议作为 3.1 重点。

原因：

- 这是入口契约级迁移，会影响插件加载、setup entry、runtime setter、sidecar 能力发现等多个边界。
- 当前仓库需要同时兼容现有 OpenClaw 版本和线上安装脚本。
- 建议先确认 OpenClaw 2026.5.x 的 SDK 包导出路径、外部插件是否允许直接 import `openclaw/plugin-sdk/channel-entry-contract`，再迁移。

判断：建议采纳，但不宜和 3.0 生命周期改造混在同一个发布里。

### 2. 拆分 `channel.ts`

状态：暂缓，建议作为 3.1/3.2 渐进重构。

原因：

- `channel.ts` 当前承载配置、WSS、E2E、session、媒体、进度、命令分发等逻辑，确实已经过大。
- 但它也是线上主路径文件，直接大拆容易引入行为差异。
- 建议先建立边界测试，再按 `config/session/media/progress/command-handler` 逐步拆分。

判断：强烈建议采纳，但必须分阶段。

### 3. TypeScript strict 模式

状态：暂缓。

原因：

- 当前代码仍大量依赖 OpenClaw 插件上下文的运行时结构和外部 payload。
- 直接开启 `strict: true` 会产生大量类型修复，容易和功能改造混杂。
- 建议先引入关键接口类型，再逐步收紧 `noImplicitAny`、`strictNullChecks`。

判断：建议采纳，但应作为质量专项。

### 4. `wss_client.js` 转 TypeScript

状态：暂缓。

原因：

- WSS 客户端是 XiotBox 长连接稳定性的关键组件。
- 转 TS 本身价值明确，但需要配套事件类型、重连状态机测试和 mock WSS 集成测试。

判断：建议采纳，优先级低于入口契约和 `channel.ts` 拆分。

### 5. E2E 密钥权限检查

状态：暂缓。

原因：

- 安全价值明确，尤其是数字员工长期在线场景。
- 但涉及线上已有密钥文件权限兼容，需要谨慎处理历史文件、自动修复和报错策略。

判断：建议采纳，适合和 `security/doctor` adapter 一起做。

## 四、验证结果

本轮改动已经完成以下验证：

```bash
npm run build
npm test
npm run release:check
git diff --check
```

验证结果：

- TypeScript 构建通过。
- Node test 通过：`59 passed, 0 failed`。
- Release check 通过：`Release check passed for 3.0.0`。
- 空白检查通过，仅存在 Windows 工作区常见的 LF/CRLF 提示。

## 五、对 MiMo 建议的整体判断

MiMo 的审查方向整体是正确的，尤其以下几项非常关键：

- 入口契约应向 `defineBundledChannelEntry` 靠拢。
- runtime 应优先使用 `ctx.channelRuntime`。
- `channel.ts` 必须模块化。
- `capabilities` 必须和真实能力一致。
- 生命周期、状态上报、doctor/security/setup adapter 是成为一等插件的关键。
- 版本元数据同步是发布可信度的基本要求。

本轮 `3.0.0` 的定位不是最终形态，而是 3.x 架构演进的第一块地基：先把运行时访问、生命周期、状态上报、媒体能力声明和发布一致性打稳，为后续更大规模的入口契约迁移和模块化重构铺路。

## 六、建议 MiMo 重点复审的问题

请 MiMo 下一轮重点审核以下内容：

1. `ctx.channelRuntime` 兼容式迁移是否符合 OpenClaw 2026.5.x 外部插件最佳实践。
2. `gateway.stopAccount` 和 `setStatus` 的实现是否符合 ChannelGatewayContext 预期。
3. `describeAccount` 增加运行态字段是否适合当前 OpenClaw status/config adapter 消费。
4. `peerDependencies.openclaw` 设置为 optional 是否适合同时支持插件模式和 standalone/bridge 模式。
5. `defineBundledChannelEntry` 对外部第三方插件的推荐迁移路径和兼容要求。
6. 下一阶段拆分 `channel.ts` 时，哪些模块边界最符合 OpenClaw 核心设计。

## 七、建议下一阶段路线

### 3.1：OpenClaw 入口契约适配

- 迁移到 `defineBundledChannelEntry`。
- 同步迁移 `setup-entry.ts`。
- 明确 sidecar、secrets、tools discovery 的集成方式。
- 增加 OpenClaw 2026.5.x 兼容性检查。

### 3.2：模块化和类型安全

- 拆分 `channel.ts`。
- 引入核心类型接口。
- 逐步减少 `any`。
- 为 WSS、media、progress、session 增加独立测试。

### 3.3：数字员工治理能力

- 增加 `doctor` adapter。
- 增加 `security` adapter。
- 增加更细粒度的权限/工具能力说明。
- 结合 XiotBox 客户端做数字员工角色、审批、审计、能力边界的产品化配置。

## 八、结论

`openclaw-channel-xiotbox` 3.0.0 已经完成第一阶段关键修复，重点解决了运行时访问、生命周期、连接状态上报、能力声明和版本发布一致性问题。

MiMo 原始建议中更大的架构项仍然成立，但应分阶段推进。当前建议将 `3.0.0` 视为稳定性和兼容性基线，将 `3.1` 作为 OpenClaw 2026.5.x 标准入口契约迁移版本，将 `3.2` 作为模块化和类型安全版本。
