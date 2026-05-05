# XiotBox Plugin Git Installation on BotDrop (Termux/proot)

This note documents what can be verified inside the `openclaw-channel-xiotbox`
repository for Git-based installation on BotDrop / Termux / proot environments,
and what still needs verification in the main OpenClaw CLI repository.

## 1. Review boundary

This review covers only the plugin repository:

- `openclaw-channel-xiotbox`

Confirmed facts:

1. The current workspace does not contain the OpenClaw CLI source repository.
2. The local environment may not have a working `openclaw` binary available for CLI source inspection.
3. Therefore, CLI-side `openclaw plugins install` parser/handler internals cannot be audited here at source level.

This document provides:

1. What can be verified in this plugin repository
2. Practical compatibility steps for Termux/proot
3. A checklist for follow-up review in the OpenClaw CLI repository

## 2. Git install path - verifiable facts in this repo

### 2.1 Plugin metadata and registration entrypoints

From `package.json`:

- `main`: `dist/index.js`
- `openclaw.extensions`: `./dist/index.js`
- `openclaw.channels`: `xiotbox`
- `openclaw.installDependencies`: `true`
- `openclaw.install.localPath`: `extensions/xiotbox`

From `openclaw.plugin.json`:

- plugin `id`: `xiotbox`
- `channels`: `xiotbox`
- `configSchema`: declared

From `index.ts`:

- default export `plugin`
- `register(api)` calls `api.registerChannel({ plugin: xiotboxPlugin })`

Conclusion:
The repository contains the required metadata and registration surfaces for OpenClaw plugin discovery and loading.

### 2.2 Git-install trigger path

From `scripts/update_openclaw_xiotbox.sh`:

- Directly calls `openclaw plugins install "$REPO"`
- Default plugin path: `~/.openclaw/extensions/xiotbox`
- Default config path: `~/.openclaw/openclaw.json`

## 3. Termux/proot compatibility review

### 3.1 Git dependency

- Risk: Termux/proot environments often do not include `git` by default.
- Current mitigation: installation/update scripts should preflight-check `git` and show Termux/apt install hints.

### 3.2 Paths and permissions

- Risk: `~/.openclaw` may not exist yet, or may not be writable in layered proot setups.
- Current mitigation: scripts should create parent directories and verify write access before install/update.

### 3.3 Node ecosystem dependencies

- Observed dependencies are primarily JavaScript-only (`@noble/curves`, `ws`, `dotenv`).
- No heavy native `node-gyp` dependency is expected in the normal plugin path.
- Low risk, but `node`, `npm`, and `python3` still need to exist.

### 3.4 Platform gating

- No restrictive `os` / `cpu` fields are present in `package.json`.
- No Termux/Android blocker was found in installation scripts in this repository.

### 3.5 Plugin discoverability

- `main + openclaw.extensions + default export register()` are present.
- If CLI-side discovery rules change, final verification must still happen in the main OpenClaw repository.

## 4. Suggested environment setup

### 4.1 Termux

```bash
pkg update
pkg install -y git nodejs-lts python ca-certificates openssl
```

### 4.2 Debian/Ubuntu inside proot-distro

```bash
apt-get update
apt-get install -y git nodejs npm python3 ca-certificates
```

Only install extra build tools if a dependency actually requires native compilation:

```bash
# Termux
pkg install -y clang make

# Debian/Ubuntu proot
apt-get install -y make g++
```

## 5. Installation examples

Direct Git install:

```bash
openclaw plugins install https://github.com/ongood/openclaw-channel-xiotbox.git#3.0.1
```

Or use the maintained helper script:

```bash
bash scripts/update_openclaw_xiotbox.sh 3.0.1
# or
bash scripts/update_openclaw_xiotbox.sh https://github.com/ongood/openclaw-channel-xiotbox.git#3.0.1
```

On Linux/systemd hosts, restart the gateway service after install/update:

```bash
systemctl restart openclaw-gateway
```

If the local gateway later reports `pairing required` or a pending `scope-upgrade`,
inspect and approve the pending request once:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

## 6. Recommended validation

```bash
openclaw plugins list
openclaw channels list
```

If CLI list commands are unavailable or fail, inspect config fallback state:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('~/.openclaw/openclaw.json').expanduser()
d = json.loads(p.read_text('utf-8'))
print('plugins.entries.xiotbox:', 'xiotbox' in ((d.get('plugins') or {}).get('entries') or {}))
print('plugins.installs.xiotbox:', 'xiotbox' in ((d.get('plugins') or {}).get('installs') or {}))
print('channels.xiotbox:', 'xiotbox' in (d.get('channels') or {}))
PY
```

## 6.1 Recommended OpenClaw config hygiene

For XiotBox-only local plugin trust, keep `plugins.allow` explicit and minimal:

```json
{
  "plugins": {
    "allow": ["xiotbox"],
    "entries": {
      "xiotbox": {
        "enabled": true
      }
    }
  }
}
```

Do not keep stale ids such as `openai`, `brave`, or `memory-core` in `plugins.allow`
unless those plugins are actually installed.

If XiotBox chat should be able to use web search/fetch, the agent allowlist must also
permit those tools. A minimal chat/search working example is:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["xiotbox_control", "web_search", "web_fetch"]
        }
      }
    ]
  }
}
```

If you want the `main` agent to inherit the global tool policy instead, remove
`agents.list[].tools.allow` entirely.

For a trusted "AI digital employee" deployment, OpenClaw 2026.4+ also needs the
core operating tools in the agent allowlist. The XiotBox plugin does not create
`exec`; OpenClaw creates it and then filters it through global/agent/provider
tool policies and the effective exec approval policy. If the allowlist only has
`xiotbox_control`, `web_search`, and `web_fetch`, then `exec` is correctly hidden.

Recommended controlled baseline:

```json
{
  "tools": {
    "exec": {
      "host": "auto",
      "security": "allowlist",
      "ask": "on-miss",
      "applyPatch": {
        "workspaceOnly": true
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "read",
            "write",
            "edit",
            "exec",
            "process",
            "web_search",
            "web_fetch",
            "xiotbox_control"
          ]
        }
      }
    ]
  }
}
```

Debug commands:

```bash
openclaw exec-policy show
openclaw approvals get --gateway
openclaw status
```

For a short trusted-lab test only, you can use:

```bash
openclaw exec-policy set --host auto --security full --ask off
```

## 7. Local-control note

The optional tool `xiotbox_local_control` is configured through `channels.xiotbox`.
That is separate from client-side direct local OpenClaw chat settings in XiotBox apps.

## 8. Still needs review in the OpenClaw CLI repository

Because the CLI source is not in this repository, these items still need verification in the main OpenClaw repo:

1. The actual implementation of `openclaw plugins install`
2. Git clone / checkout behavior and error mapping
3. Plugin directory selection logic
4. Package manager selection (`npm` / `pnpm` / `yarn`) and Termux fallback behavior
5. Final plugin scanning and manifest precedence rules
