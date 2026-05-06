# OpenClaw Entry Contract Spike for XiotBox 3.1

> Status: in progress
>
> Goal: verify whether `defineBundledChannelEntry` / `defineBundledChannelSetupEntry` can be safely used by the external `openclaw-channel-xiotbox` plugin before changing the production entrypoint.

## Decision Rule

Do not migrate `index.ts` or `setup-entry.ts` until this spike has a clear answer.

- If the entry contract is importable and works for external packages, 3.1.0 may migrate to `defineBundledChannelEntry`.
- If it is not importable or only supports bundled OpenClaw extensions, keep the current manual entry and continue with minimal module extraction.
- If runtime injection differs from the current `register(api)` / `setXiotboxRuntime` flow, document the required adapter or OpenClaw core change before migrating.

## Environment

### Local Windows Workspace

- Date: 2026-05-05
- Repository: `openclaw-channel-xiotbox`
- Branch: `3.1`
- Baseline tag: `3.0.2`
- Node version: `v24.13.0`
- npm version: `11.6.2`
- OpenClaw version: not installed in this Windows plugin workspace (`openclaw` command not found)
- OS: Windows development workspace
- Install mode: local repository checkout
- Plugin path: `D:\github\xiot\openclaw-channel-xiotbox`

### OpenClaw Host Validation

- Date: 2026-05-06
- OpenClaw version: `2026.5.4 (325df3e)`
- Node version: `24.14.0`
- OS: Linux `6.8.0-71-generic` x64
- Install mode: Git branch install via `https://github.com/ongood/openclaw-channel-xiotbox.git#3.1`
- Plugin path: `/root/.openclaw/extensions/xiotbox`

Fill environment values with:

```bash
node -v
npm -v
openclaw --version
pwd
```

On Windows PowerShell:

```powershell
node -v
npm -v
openclaw --version
Get-Location
```

## Baseline Regression

Run before and after spike experiments:

```bash
npm run build
npm test
npm run release:check
node scripts/spike_openclaw_entry_3_1.mjs
```

Expected:

- Existing manual entry still registers the channel.
- Existing manual entry still registers optional tools in full registration mode.
- Existing `setXiotboxRuntime(api.runtime)` path still injects runtime.

## Experiment 1: External Package Loading

Question:

- Is `defineBundledChannelEntry` available to third-party external plugins?
- Does the OpenClaw plugin loader accept an entry returned by that helper outside bundled extensions?

Commands:

```bash
npm run build
node scripts/spike_openclaw_entry_3_1.mjs
```

Optional specifier override:

```bash
OPENCLAW_ENTRY_SPECIFIER="openclaw/plugin-sdk/channel-entry-contract" node scripts/spike_openclaw_entry_3_1.mjs
```

Result:

```text
resolve: ERR_MODULE_NOT_FOUND
import: skipped because resolve failed

OpenClaw host validation (2026.5.4):
resolve: ERR_MODULE_NOT_FOUND
import: skipped because resolve failed
```

Conclusion:

```text
Not importable in the current standalone plugin workspace or in the tested
OpenClaw 2026.5.4 external extension install path.

The plugin should not replace its current manual entry with a static
`openclaw/plugin-sdk/channel-entry-contract` import until one of these is true:

1. OpenClaw exposes a stable external SDK package/path.
2. The plugin declares a safe dev/runtime dependency that does not break bridge/standalone installs.
3. The entry migration uses a compatibility fallback that preserves the current manual entry.
```

## Experiment 2: importMetaUrl Resolution

Question:

- Does `import.meta.url` resolve correctly when the plugin is installed by path, git tag, npm, and inside `~/.openclaw/extensions/xiotbox`?
- Does it point at the compiled `dist/index.js` entry or the TypeScript source entry?

Commands:

```bash
node scripts/spike_openclaw_entry_3_1.mjs
```

Capture:

- `scriptImportMetaUrl`
- `distIndexUrl`
- resolved plugin root
- resolved plugin/runtime specifier paths, if the OpenClaw entry contract is importable

Result:

```text
scriptImportMetaUrl: file:///D:/github/xiot/openclaw-channel-xiotbox/scripts/spike_openclaw_entry_3_1.mjs
distIndexUrl: file:///D:/github/xiot/openclaw-channel-xiotbox/dist/index.js
repoRoot: /D:/github/xiot/openclaw-channel-xiotbox/

OpenClaw host validation (2026.5.4):
cwd: /root/.openclaw/extensions/xiotbox
repoRoot: /root/.openclaw/extensions/xiotbox/
scriptImportMetaUrl: file:///root/.openclaw/extensions/xiotbox/scripts/spike_openclaw_entry_3_1.mjs
distIndexUrl: file:///root/.openclaw/extensions/xiotbox/dist/index.js
```

Conclusion:

```text
Local and host file URL resolution are predictable. The actual
`defineBundledChannelEntry({ importMetaUrl })` behavior still cannot be
validated because the OpenClaw entry contract is not importable from the tested
external extension path.
```

## Experiment 3: Optional Peer Dependency Risk

Question:

- Does importing `openclaw/...` fail when `openclaw` is only an optional peer dependency?
- Does build fail without a local OpenClaw package?
- Do we need a dynamic import, devDependency, or fallback entry?

Commands:

```bash
npm run build
node scripts/spike_openclaw_entry_3_1.mjs
```

Result:

```text
npm run build: passed
entry contract resolve: ERR_MODULE_NOT_FOUND

OpenClaw host validation (2026.5.4):
entry contract resolve: ERR_MODULE_NOT_FOUND
```

Conclusion:

```text
The optional peer dependency risk is real in both the standalone workspace and
the tested OpenClaw host extension path. A static import from
`openclaw/plugin-sdk/channel-entry-contract` would fail unless OpenClaw exposes
that contract through a stable package/source dependency visible to external
extensions.
```

## Experiment 4: Sidecar / Secrets / Tools Discovery

Question:

- Does the new entry contract preserve tool discovery?
- Are secrets/config injected before channel startup?
- Does setup entry load through the same contract?
- Are XiotBox tools visible to OpenClaw tool policy and security audit?

Commands:

```bash
openclaw status
openclaw security audit
openclaw plugins list
```

If OpenClaw provides a channel/plugin setup command:

```bash
openclaw setup xiotbox
```

Result:

```text
Windows workspace: not executed because the OpenClaw CLI is not installed.

OpenClaw host validation (2026.5.4):
- xiotbox loaded successfully after installing plugin dependencies.
- WSS channel connected successfully.
- Gateway log warning before 3.1 metadata patch:
  - channel "xiotbox" registered incomplete metadata; filled missing docsPath
  - plugin must declare contracts.tools before registering agent tools
```

Conclusion:

```text
Manual entry channel loading works on the host. 3.1 should add explicit
`docsPath` and `contracts.tools` metadata to satisfy OpenClaw 2026.5.4 plugin
contract checks before deeper entry migration work.
```

## Experiment 5: register(api) / setChannelRuntime Compatibility

Question:

- Does the new entry contract still call `register(api)`?
- Does `setXiotboxRuntime(api.runtime)` still run?
- Is runtime injection available before `gateway.startAccount`?
- Can `ctx.channelRuntime.reply` and the legacy runtime fallback coexist?

Current manual-entry regression command:

```bash
npm run build
node scripts/spike_openclaw_entry_3_1.mjs
```

Result:

```text
Current manual entry regression:

entryShape:
  id: xiotbox
  name: XiotBox Channel
  hasPlugin: true
  hasRegister: true

register calls:
  registerChannel: hasPlugin=true
  registerTool: xiotbox_local_control optional=true
  registerTool: xiotbox_control optional=true

runtimeInjected: true

OpenClaw host validation (2026.5.4):

entryShape:
  id: xiotbox
  name: XiotBox Channel
  hasPlugin: true
  hasRegister: true

register calls:
  registerChannel: hasPlugin=true
  registerTool: xiotbox_local_control optional=true
  registerTool: xiotbox_control optional=true

runtimeInjected: true
```

Conclusion:

```text
The current manual `register(api)` path still works and correctly calls
`setXiotboxRuntime(api.runtime)`. This is the compatibility baseline that any
entry-contract migration must preserve.
```

## Initial Local Observation

On the current development machine, `node_modules/openclaw` is not installed in this plugin workspace. That is expected because `openclaw` is configured as an optional peer dependency.

Implication:

- A static import from `openclaw/plugin-sdk/channel-entry-contract` may fail in local plugin builds unless OpenClaw exposes a stable package dependency or the plugin uses a fallback/dynamic import strategy.
- This must be resolved before replacing the current manual entry.

## Final Decision

```text
Current 3.1 decision: keep manual entry for now.

Reason: `defineBundledChannelEntry` is not importable in either the standalone
plugin workspace or the tested OpenClaw 2026.5.4 external extension install
path, while the manual entry regression passes in both environments.

3.1.0 should not migrate `index.ts` / `setup-entry.ts` to
`defineBundledChannelEntry` unless a later OpenClaw package/source path exposes a
stable external SDK contract. Continue with the approved minimal module
extraction (`gateway-state.ts`, `config.ts`) and metadata compatibility patches.
```

## Required Follow-Ups

```text
1. If OpenClaw source is available locally, rerun with OPENCLAW_ENTRY_SPECIFIER
   pointing at the actual exported SDK path.
2. Validate setup-entry behavior after the entry contract is importable.
3. Validate tools/secrets discovery through OpenClaw status/security audit after
   the 3.1 metadata patch is installed.
4. Do not change production index.ts/setup-entry.ts until the entry-contract
   result is positive or a fallback strategy is implemented.
```
