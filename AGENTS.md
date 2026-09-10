# AGENTS.md — xiotbox/openclaw-channel-xiotbox 强制规则

以下规则为**强制（MUST）**，任何 Agent / 贡献者在本仓库执行发布、部署相关操作前必须遵守，不得跳过、不得以任何理由豁免。

## 1. 版本号强制同步（版本纪律）

- **任何会发布 / 部署的插件代码或行为变更**（包括但不限于 `src/` 下源码修改、构建产物行为变化、配置默认值变化），合入 `main` 前必须同步升级 `package.json` 的版本号（遵循语义化版本）。
- 升级版本号时，**必须同步更新 `package.json` 与 `package-lock.json`**（推荐 `npm version <x.y.z> --no-git-tag-version`），两处版本必须一致。
- 仅修改文档（README / AGENTS.md 等）或纯注释的 PR 可不升版本号；一旦 diff 触及运行时代码或 dist 产物行为，即视为"会发布 / 部署的变更"。

## 2. 部署前强制重新构建（禁陈旧 dist）

- **部署（生产或任何运行环境）之前必须重新执行 `npm run build`**，禁止直接使用任何遗留的 `dist/` 产物上线。
- 构建后必须确认 `dist/` 构建产物**来自当前源码 / 当前版本**：
  - `dist/` 内容与当前 `src/` 源码对应（必要时 `npm run clean && npm run build` 全量重建）；
  - `package.json` 中 `version` 与本次部署提交的版本号一致；
  - 若 diff 中存在 `dist/` 变更但源码未变（或反之），必须查明原因，禁止夹带无法解释的产物差异。
- **禁止陈旧 `dist/` 上线**：`dist/` 产物落后于源码、版本号与部署提交不一致时，一律视为不合格构建，必须重建并重新确认后方可部署。

## 3. 提交纪律

- 发布类 PR 必须包含：版本号变更（`package.json` + `package-lock.json`）、因源码变更而重新生成的 `dist/` 构建产物，以及相关规则文件；**不得夹带与本变更无关的文件**。
