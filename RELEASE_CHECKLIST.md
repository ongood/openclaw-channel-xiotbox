# XiotBox Plugin Release Checklist

Use this checklist whenever you prepare a new release of `openclaw-channel-xiotbox`.

## 1. Pre-flight checks

```bash
git status --short
git branch --show-current
```

- Confirm you are on the intended branch.
- Confirm the target release version (for example `2.0.16`).

## 2. Identifier consistency

These identifiers must stay aligned on every release:

- plugin id: `xiotbox`
- channel id: `xiotbox`
- install directory: `~/.openclaw/extensions/xiotbox`
- config keys:
  - `plugins.entries.xiotbox`
  - `plugins.installs.xiotbox`
  - `channels.xiotbox`

Files to verify:

- `openclaw.plugin.json`
- `index.ts`
- `dist/index.js`
- `package.json` (`openclaw.install.localPath`)
- `scripts/update_openclaw_xiotbox.sh`

## 3. Version synchronization

Update the release version consistently in:

- `package.json` -> `version`
- `package-lock.json` -> `version` and `packages[""].version`
- `openclaw.plugin.json` -> `version`
- `scripts/update_openclaw_xiotbox.sh` default `TAG`
- `scripts/install_configure_xiotbox.sh` default `TAG`
- `scripts/test_install_xiotbox_termux.sh` default Git tag
- `scripts/bootstrap_xiotbox_termux.sh` default `TAG`
- `README.md` examples that mention release tags

## 4. Build artifacts

```bash
npm install
npm run build
npm run release:check
```

Verify these artifacts exist and are fresh:

- `dist/index.js`
- `dist/src/channel.js`
- `dist/src/runtime.js`
- `dist/src/e2e.js`
- `dist/wss_client.js`

## 5. Basic repository checks

```bash
bash -n scripts/update_openclaw_xiotbox.sh
rg -n "\"id\": \"xiotbox\"|id: 'xiotbox'" openclaw.plugin.json index.ts dist/index.js
rg -n "extensions/xiotbox|plugins\\.entries\\.xiotbox|plugins\\.installs\\.xiotbox|channels\\.xiotbox" README.md package.json scripts/update_openclaw_xiotbox.sh
```

## 6. Recommended local upgrade validation

```bash
bash scripts/update_openclaw_xiotbox.sh <VERSION>
openclaw plugins list
openclaw channels list
openclaw doctor --fix
```

Checks:

- `plugins list` shows plugin id `xiotbox` and a loaded status
- `channels list` shows `XiotBox`
- `~/.openclaw/openclaw.json` no longer contains stale `openclaw-channel-xiotbox` keys

## 7. Commit, tag, and push

```bash
git add .
git commit -m "release: <VERSION>"
git tag -a <VERSION> -m "release <VERSION>"
git push origin HEAD
git push origin <VERSION>
```

Example:

```bash
git commit -m "release: 2.0.16"
git tag -a 2.0.16 -m "release 2.0.16"
git push origin HEAD
git push origin 2.0.16
```

## 8. Post-release confirmation

```bash
git show --no-patch --decorate <VERSION>
git tag -l | tail
```

- Confirm the tag points to the intended commit.
- Confirm the tag is visible on GitHub.
