# TEST_PLAN.md — xiotbox 质量与回归测试计划

> 维护人：角色F（质量与回归负责人）
> 最后更新：2026-02-19

## 一、测试范围

| 模块 | 文件 | 关键函数/逻辑 | 测试文件 | 状态 |
|------|------|---------------|---------|------|
| 工具防循环 | channel.ts | toolOnlyCounter, shouldSkipReply, isHardExitCommand, buildToolSummary | tool-only-fallback.test.mjs | ✅ 35 pass |
| 媒体上下文映射 | channel.ts | buildInboundMediaContext, stageInlineMediaPayload | media-context-mapping.test.mjs | ✅ 9 pass |
| 会话键/上下文纪元 | channel.ts | buildSessionKey, normalizeContextEpoch, resolveInboundContextEpoch, normalizeThreadId, normalizeAccountId | session-key.test.mjs | ✅ 新增 |
| 文本提取 | channel.ts | normalizeTextPayload | normalize-text.test.mjs | ✅ 新增 |
| 控制工具纯函数 | xiotbox-control-tool.ts | normalizePlan, normalizeLaunchStrategy, extractForegroundPackage, extractRootBoundsFromTree, looksLikeLauncherPackage | control-tool-pure.test.mjs | ✅ 新增 |
| WSS 鉴权/连接 | wss_client.js | connect, auth handshake | — | 🔴 需 mock WSS |
| 消息收发 E2E | e2e.ts + channel.ts | inbound → session → outbound 全链路 | — | 🔴 需 mock WSS |
| 断线重连 | wss_client.js | reconnect, heartbeat timeout | — | 🔴 需 mock WSS |

## 二、一键回归

```bash
npm test
# 等价于: node --test test/*.test.mjs
```

## 三、冒烟用例清单

### P0 — 合入必过
1. **登录鉴权**：WSS 连接 → 设备注册 → token 校验（待自动化）
2. **收发消息**：文本消息 inbound → agent 处理 → outbound 回复（待自动化）
3. **媒体处理**：图片/PDF/ZIP 上传 → 正确映射 MediaContext（✅ 已覆盖）
4. **工具防循环**：连续 tool-only ≥3 次 → 自动 reset + 提示（✅ 已覆盖）
5. **会话隔离**：不同 device+thread → 不同 sessionKey（✅ 已覆盖）

### P1 — 回归必过
6. **硬退出命令**：/stop、退出控制 → 正确识别并重置（✅ 已覆盖）
7. **上下文纪元**：explicit/fallback/default 三种来源正确解析（✅ 已覆盖）
8. **控制工具 plan 规范化**：畸形输入 → 安全降级（✅ 已覆盖）
9. **启动器识别**：已知 launcher 包名 → 正确判定（✅ 已覆盖）
10. **文本提取**：嵌套/流式/多格式 payload → 正确拼接（✅ 已覆盖）

### P2 — 手动验证
11. **选择复制**：长按 → 选择文本 → 复制到剪贴板（需真机）
12. **断线重连**：WSS 断开 → 自动重连 → 会话恢复（需 mock WSS）
13. **记忆持久化**：sessionStore 写入/读取/跨重启恢复（需文件系统 mock）

## 四、已知缺陷

| ID | 严重度 | 描述 | 状态 |
|----|--------|------|------|
| BUG-001 | P2 | media-context-mapping.test.mjs 依赖未声明在 devDependencies，npm ci 后需额外 npm install | 已修复 |

## 五、覆盖率目标

- 纯函数单测覆盖率：>80%（当前约 70%，新增 3 个测试文件后达标）
- E2E 自动化：待 mock WSS 基础设施就绪后补充
- 合入门禁：`npm test` 全绿
