# Release Checklist

Use this checklist when preparing a new `openclaw-channel-xiotbox` release.

## 1. Confirm Scope

- Confirm the target version from `package.json` and `openclaw.plugin.json`.
- Confirm whether the release is source-only, package/tag-based, or intended for public catalog distribution.
- Do not mix release-prep documentation changes with protocol behavior changes in the same release unless the user explicitly asks for it.

## 2. Code and Build

- Update source files under `src/`.
- Rebuild `dist/` if installation or runtime uses built artifacts.
- Run the available checks:

```bash
npm install
npm run build
npm run release:check
```

## 3. Metadata

Keep these aligned:

- `package.json`
- `openclaw.plugin.json`
- `dist/` output where applicable
- README install examples

## 4. Runtime Smoke Test

- Install or link the plugin into the target OpenClaw host.
- Restart OpenClaw gateway if needed.
- Confirm the plugin connects to XiotBox Gateway.
- Confirm encrypted inbound requests can be decrypted.
- Confirm replies are decryptable by the XiotBox client.
- Confirm tool permissions are still constrained by OpenClaw policy.

## 5. Publish

Only after the checks above:

```bash
git status
git commit -m "release: <version>"
git tag -a <version> -m "release <version>"
git push
git push origin <version>
```

Adjust the branch and tag flow to the actual release channel.

