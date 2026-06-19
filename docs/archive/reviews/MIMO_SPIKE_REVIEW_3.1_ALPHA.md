# MiMo 审核：3.1-alpha Spike 初步结果

> 审核时间：2026-05-06
> 审核人：MiMo
> 分支：`3.1` / commit `43c4125`

## 一、Spike 文档审核

### 文档结构：✅ 优秀

[`docs/openclaw-entry-spike-3.1.md`](openclaw-channel-xiotbox/docs/openclaw-entry-spike-3.1.md) 结构完整：

- Decision Rule 明确（不迁移直到有明确答案）
- Environment 信息完整
- 5 个实验维度全部覆盖
- 每个实验有 Commands / Result / Conclusion 三段式
- Final Decision 和 Required Follow-Ups 清晰

### 脚本质量：✅ 优秀

[`scripts/spike_openclaw_entry_3_1.mjs`](openclaw-channel-xiotbox/scripts/spike_openclaw_entry_3_1.mjs) 设计合理：

- `tryResolve` / `tryImport` 分离，安全处理 `ERR_MODULE_NOT_FOUND`
- `probeCurrentManualEntry` 用 mock api 验证 `register(api)` 流程
- 检查 `runtimeInjected` 确认 `setXiotboxRuntime` 被正确调用
- 支持 `OPENCLAW_ENTRY_SPECIFIER` 环境变量覆盖
- Decision hint 逻辑清晰

---

## 二、初步 Spike 结果分析

### 实验 1 结果：`ERR_MODULE_NOT_FOUND`

```
resolve: ERR_MODULE_NOT_FOUND
import: skipped because resolve failed
```

**分析**：这是预期结果。当前插件工作区没有安装 `openclaw` 包（它是 optional peer dependency），所以 `openclaw/plugin-sdk/channel-entry-contract` 无法解析。

**关键问题**：这**不等于** `defineBundledChannelEntry` 不支持外部插件。这只说明在**没有 OpenClaw 运行时的独立插件工作区**中无法直接 import。

需要区分两个场景：

| 场景 | 是否需要 import | 说明 |
|------|----------------|------|
| 插件独立构建（`npm run build`） | ❌ 不需要 | 入口代码在运行时由 OpenClaw 加载器执行，不在构建时 |
| OpenClaw host 加载插件 | ✅ 需要 | host 已安装 openclaw，import 路径可用 |
| bridge/standalone 模式 | ❌ 不需要 | 使用当前手动入口，不经过 OpenClaw 加载器 |

**结论**：`ERR_MODULE_NOT_FOUND` 在独立工作区是正常的。真正的问题是：

1. **构建时**：`tsc` 编译 `index.ts` 时如果包含 `import { defineBundledChannelEntry } from "openclaw/..."`，而 `openclaw` 不在 `node_modules` 中，TypeScript 编译会失败
2. **运行时**：在 OpenClaw host 中加载时，`openclaw` 包可用，import 成功

### 实验 5 结果：手动入口回归通过 ✅

```
registerChannel: hasPlugin=true
registerTool: xiotbox_local_control optional=true
registerTool: xiotbox_control optional=true
runtimeInjected: true
```

当前入口完全正常，作为迁移基线可靠。

---

## 三、下一步建议

### 方案 A：在 OpenClaw host 上重跑 spike（推荐）

在安装了 OpenClaw 2026.5.x 的服务器上：

```bash
cd ~/.openclaw/extensions/xiotbox  # 或 npm install 的路径
git fetch && git checkout 3.1
npm install
npm run spike:entry
```

预期结果：
- `resolve: ok`
- `import: ok`
- `hasDefineBundledChannelEntry: true`
- `hasDefineBundledChannelSetupEntry: true`

如果通过，还需要验证 `defineBundledChannelEntry({ importMetaUrl, channel })` 的完整调用链。

### 方案 B：构建时兼容策略（如果方案 A 通过但构建有问题）

如果 `tsc` 在没有 `openclaw` 包时编译失败，有三种解决路径：

**B1. 条件导入（推荐）**：

```ts
// index.ts
let entry: any;
try {
  const contract = await import('openclaw/plugin-sdk/channel-entry-contract');
  entry = contract.defineBundledChannelEntry({ ... });
} catch {
  // fallback to manual entry
  entry = { id: 'xiotbox', register(api) { ... } };
}
export default entry;
```

**B2. 动态 import + 类型声明**：

```ts
// 在项目中添加 openclaw 类型声明文件
// types/openclaw.d.ts
declare module 'openclaw/plugin-sdk/channel-entry-contract' {
  export function defineBundledChannelEntry(options: any): any;
  export function defineBundledChannelSetupEntry(options: any): any;
}
```

**B3. 只在 OpenClaw host 环境中使用新入口**：

保持 `index.ts` 为手动入口，新增 `index.openclaw.ts` 作为 `defineBundledChannelEntry` 入口，通过 `openclaw.plugin.json` 的 `extensions` 字段选择：

```json
{
  "extensions": ["./index.openclaw.ts"]
}
```

但这需要确认 OpenClaw 加载器是否支持条件入口选择。

### 方案 C：暂不迁移入口，先做模块拆分（保守）

如果 host-side spike 也遇到问题，按原计划只做 `gateway-state.ts` 和 `config.ts` 拆分，入口迁移推迟到 OpenClaw 核心提供稳定的外部插件 SDK。

---

## 四、Spike 文档小改建议

### 4.1 实验 1 结论需要补充区分

当前结论：

> Not usable in the current plugin workspace without an OpenClaw package/source path.

建议改为：

> Not importable in the current **standalone plugin workspace** without an OpenClaw package. This is expected because `openclaw` is an optional peer dependency. The entry contract may still work when loaded by an OpenClaw host that has the package installed. Host-side validation required.

### 4.2 实验 3 结论需要补充

当前结论只说了"风险真实"，建议补充：

> The risk is specifically at **TypeScript compile time** (`tsc`). If `index.ts` contains a static import from `openclaw/...`, the build will fail without the package. Solutions: (1) dynamic import, (2) type declaration file, (3) conditional entry file.

### 4.3 增加实验 6：TypeScript 编译兼容性

在 host-side spike 中，额外验证：

```bash
# 在 OpenClaw host 上
cd ~/.openclaw/extensions/xiotbox
npm run build  # tsc 是否能编译包含 openclaw import 的代码
```

如果 `tsc` 失败，需要在 `tsconfig.json` 中配置 `paths` 或添加类型声明。

---

## 五、总结

| 维度 | 评分 | 说明 |
|------|------|------|
| Spike 文档质量 | 5/5 | 结构完整，记录规范 |
| 脚本质量 | 5/5 | 安全、可复现、支持覆盖 |
| 初步结论准确性 | 4/5 | 结论正确但需要补充"standalone vs host"区分 |
| 下一步清晰度 | 5/5 | host-side validation 是正确的下一步 |

**当前状态**：3.1-alpha spike 在 standalone 工作区的结果符合预期，**不构成迁移阻塞**。需要在 OpenClaw host 上完成 host-side validation 后才能做出最终决策。

在等待 host-side 结果期间，可以并行开始 `gateway-state.ts` 和 `config.ts` 的拆分工作（这两个不依赖入口迁移决策）。
