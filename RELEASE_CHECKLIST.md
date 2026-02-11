# XiotBox 插件更新/发布清单

本文档用于每次更新 `openclaw-channel-xiotbox` 时执行固定动作，避免遗漏。

## 1. 开始前检查

```bash
git status --short
git branch --show-current
```

- 确保在正确分支（当前是 `1.0`）。
- 确保你知道本次目标版本号（例如 `1.0.25`）。

## 2. 代码与标识一致性

每次更新都要确认以下标识保持统一：

- plugin id: `xiotbox`
- channel id: `xiotbox`
- 安装目录: `~/.openclaw/extensions/xiotbox`
- 配置 key:
  - `plugins.entries.xiotbox`
  - `plugins.installs.xiotbox`
  - `channels.xiotbox`

重点检查文件：

- `openclaw.plugin.json`
- `index.ts`
- `dist/index.js`
- `package.json` (`openclaw.install.localPath`)
- `scripts/update_openclaw_xiotbox.sh`

## 3. 版本号同步

把版本号统一改成本次发布版本（示例 `1.0.25`）：

- `package.json` 的 `version`
- `scripts/update_openclaw_xiotbox.sh` 的默认 `TAG`
- `scripts/install_configure_xiotbox.sh` 的默认 `TAG`
- `scripts/test_install_xiotbox_termux.sh` 的默认 git tag
- `scripts/bootstrap_xiotbox_termux.sh` 的默认 `TAG`
- `README.md` 中安装/升级示例 tag

## 4. 构建产物

```bash
npm install
npm run build
```

确认以下产物存在并已更新：

- `dist/index.js`
- `dist/src/channel.js`
- `dist/src/runtime.js`
- `dist/src/e2e.js`
- `dist/wss_client.js`

## 5. 基础自检

```bash
bash -n scripts/update_openclaw_xiotbox.sh
rg -n "\"id\": \"xiotbox\"|id: 'xiotbox'" openclaw.plugin.json index.ts dist/index.js
rg -n "extensions/xiotbox|plugins\\.entries\\.xiotbox|plugins\\.installs\\.xiotbox|channels\\.xiotbox" README.md package.json scripts/update_openclaw_xiotbox.sh
```

## 6. 本地升级迁移验证（推荐）

```bash
bash scripts/update_openclaw_xiotbox.sh <VERSION>
openclaw plugins list
openclaw channels list
openclaw doctor --fix
```

检查点：

- `plugins list` 中插件 ID 为 `xiotbox`，状态 `loaded`
- `channels list` 中有 `XiotBox`
- `~/.openclaw/openclaw.json` 不再出现 `openclaw-channel-xiotbox` 旧键

## 7. 提交、打 tag、推送

```bash
git add .
git commit -m "release: <VERSION>"
git tag -a <VERSION> -m "release <VERSION>"
git push origin HEAD
git push origin <VERSION>
```

示例（发布 `1.0.25`）：

```bash
git commit -m "release: 1.0.25"
git tag -a 1.0.25 -m "release 1.0.25"
git push origin HEAD
git push origin 1.0.25
```

## 8. 发布后确认

```bash
git show --no-patch --decorate <VERSION>
git tag -l | tail
```

- 确认 tag 指向正确 commit。
- 在 GitHub 上确认 tag 已可见。
