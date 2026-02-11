# OpenClaw 插件接手文档

> 仓库：`openclaw-channel-xiotbox`
> 角色：OpenClaw <-> XiotBox 网关桥接插件

## 1. 仓库定位

这个仓库是 OpenClaw 侧执行器，负责把 XiotBox 命令转成 OpenClaw runtime 调用，再把结果按 XiotBox 协议回传。

## 2. 关键文件

- 命令主流程：`src/channel.ts`
- E2E 实现：`src/e2e.ts`
- 运行时桥接：`src/runtime.ts`
- 发布产物：`dist/`（插件安装实际使用）
- 版本文件：`openclaw.plugin.json`、`package.json`

## 3. 当前关键约束

1. 回包加密目标必须绑定“本次请求的发送端 key/session”
2. 无法解析发送端 key 时必须 fail closed（不要返回不可解密 success）
3. identity trust 变化必须显式报错（`client_identity_changed`）

## 4. 多端漫游阶段策略

当前采用多信封思路（`e2e_multi`），保证同一消息可被不同客户端各自解密。

不要退化成服务端明文中转。

## 5. 发布规则（必须遵守）

每次插件改动后必须：

1. 更新 `src/`
2. 重新构建 `dist/`
3. 更新版本号
4. 打 tag 并推送远端

否则用户拉取 tag 后无法得到实际修复。

## 6. 快速验证

1. OpenClaw 收到加密请求可成功解密
2. 回包在 PC/iOS 都能被各自解密
3. 不出现持续 `client_identity_changed` 或大面积 `[Encrypted payload]`

