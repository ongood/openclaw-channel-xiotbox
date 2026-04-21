# XiotBox OpenClaw Channel

XiotBox is an OpenClaw channel plugin that connects OpenClaw to a XiotBox Gateway over WSS and can optionally expose device-control tools to agents.

For public positioning, the plugin is best described as:

- a remote XiotBox chat channel for OpenClaw
- a XiotBox-backed device-control extension for agents
- a bridge-mode integration for external process deployments
- a building block for multi-thread task orchestration around remote device workflows

This repository is being prepared for future public distribution, but the current installation and runtime model remain unchanged:

- Existing local/path installs remain valid.
- Existing source checkout workflows remain valid.
- Existing bridge-mode workflows remain valid.
- No ClawHub-only install path is required by this repository.

## What This Plugin Provides

- A XiotBox channel for OpenClaw runtime chat delivery.
- Optional `xiotbox_control` tool for remote device-control plans.
- Optional `xiotbox_local_control` tool for local XiotBox control endpoints.
- Bridge mode for standalone process deployments that connect to a local OpenClaw Gateway.
- A practical foundation for multi-thread orchestration flows that combine remote chat, device control, and tool execution.

## Compatibility

- OpenClaw host: `>=2026.3.22`
- Node.js: `>=18` for source checkout / bridge-mode execution
- Current repository layout is still compatible with:
  - `openclaw plugins install <local-path>`
  - `openclaw plugins install <archive>`
  - local linked development installs
  - standalone bridge mode started with `npm start`

## Install

### Option A: Install from a local path or checked-out source

This is the current recommended development and path-install workflow.

```bash
openclaw plugins install ./openclaw-channel-xiotbox
```

If you prefer a linked development install:

```bash
openclaw plugins install -l ./openclaw-channel-xiotbox
```

After installation, restart the OpenClaw Gateway if your environment does not auto-restart plugins:

```bash
openclaw gateway restart
```

On Linux/systemd deployments that run `openclaw-gateway` as a service, restart the service explicitly after plugin upgrades:

```bash
systemctl restart openclaw-gateway
```

### Option B: Source checkout for bridge mode

```bash
git clone https://github.com/ongood/openclaw-channel-xiotbox.git
cd openclaw-channel-xiotbox
npm install
npm run build
```

Start bridge mode:

```bash
npm start
```

## Runtime Modes

### Plugin mode

Plugin mode runs inside OpenClaw and registers:

- the `xiotbox` channel
- the optional `xiotbox_local_control` tool
- the optional `xiotbox_control` tool

This is the normal mode when installed through `openclaw plugins install`.

### Bridge mode

Bridge mode runs as a standalone Node.js process and connects to a local OpenClaw Gateway. It is useful when XiotBox connectivity needs to be managed outside the in-process plugin runtime.

## Minimal Working Configuration

### Plugin mode

Minimal plugin-mode example in `openclaw.json`:

```json
{
  "channels": {
    "xiotbox": {
      "enabled": true,
      "GATEWAY_WSS_URL": "wss://gateway.example/ws/openclaw",
      "DEVICE_ID": "YOUR_DEVICE_ID",
      "DEVICE_TOKEN": "YOUR_DEVICE_TOKEN",
      "API_BASE_URL": "https://api.xiotbox.com"
    }
  }
}
```

This is enough for the remote XiotBox channel path in the common case.

### Bridge mode

Bridge mode uses files under `$OPENCLAW_HOME/xiotbox/`:

- `config.json` for non-secret configuration
- `secret.json` for secrets

Minimal `config.json`:

```json
{
  "xiotbox": {
    "GATEWAY_WSS_URL": "wss://gateway.example/ws/openclaw",
    "GATEWAY_API_URL": "https://api.xiotbox.com",
    "STREAMING": true,
    "PROGRESS_UPDATES": true
  },
  "bridge": {
    "enabled": true,
    "endpoint": "wss://gateway.example/ws/openclaw",
    "openclawHost": "127.0.0.1",
    "openclawPort": 18789,
    "agentId": "main"
  }
}
```

Minimal `secret.json`:

```json
{
  "xiotbox": {
    "DEVICE_ID": "YOUR_DEVICE_ID",
    "DEVICE_TOKEN": "YOUR_DEVICE_TOKEN"
  },
  "bridge": {
    "GATEWAY_TOKEN": "YOUR_GATEWAY_TOKEN"
  }
}
```

## Configuration Reference

The plugin config schema is intentionally permissive so existing deployments do not break. For release preparation, the options are grouped below for clarity.

### 1. Basic connectivity

| Key | Required | Sensitive | Purpose |
| --- | --- | --- | --- |
| `enabled` | Optional | No | Master enable/disable switch for the XiotBox channel. |
| `name` | Optional | No | Optional display name override. |
| `GATEWAY_WSS_URL` | Required for remote channel use | No | XiotBox Gateway WSS endpoint. |
| `API_BASE_URL` | Usually required | No | XiotBox HTTP API base URL. |
| `USE_QUERY_AUTH` | Optional | No | Enables query-string auth for gateways that require it. |

### 2. Identity and trust

| Key | Required | Sensitive | Purpose |
| --- | --- | --- | --- |
| `DEVICE_ID` | Required for remote channel use | No | XiotBox device identity. |
| `DEVICE_TOKEN` | Required for remote channel use | Yes | Secret paired with `DEVICE_ID`. |
| `E2E_KEY_PATH` | Optional | Yes | Path to end-to-end encryption key material. |
| `E2E_ROTATE` | Optional | Possibly | Key rotation policy or override. |
| `IDENTITY_KEY_PATH` | Optional | Yes | Path to local identity key material. |
| `TRUST_PATH` | Optional | Yes | Trust store / peer pinning material. |
| `ALLOW_NEW_CLIENT_IDENTITIES` | Optional | No | Auto-enroll newly seen client identities when enabled. |

### 3. Streaming output

| Key | Required | Sensitive | Purpose |
| --- | --- | --- | --- |
| `STREAMING` | Optional | No | Enables reply streaming. |
| `STREAM_THROTTLE_MS` | Optional | No | Throttle interval for streaming updates. |
| `PROGRESS_UPDATES` | Optional | No | Enables progress/status updates separate from the final reply. |
| `PROGRESS_THROTTLE_MS` | Optional | No | Throttle interval for progress events. |
| `PROGRESS_MAX_UPDATES` | Optional | No | Maximum number of progress events per request. |

### 4. Local control

| Key | Required | Sensitive | Purpose |
| --- | --- | --- | --- |
| `LOCAL_CONTROL_BASE_URL` | Optional | No | Base URL for the XiotBox local-control service. |
| `LOCAL_CONTROL_TOKEN` | Optional | Yes | Token required by the local-control endpoint. |
| `LOCAL_CONTROL_TIMEOUT_MS` | Optional | No | Timeout for local-control calls. |
| `CONTROL_ACTIONS` | Optional | No | Allowlist of exposed local control actions. |
| `SCOPES` | Optional | No | Scope filter for channel and control capabilities. |

### 5. Performance and reliability

| Key | Required | Sensitive | Purpose |
| --- | --- | --- | --- |
| `OUTBOX_MAX` | Optional | No | Maximum number of buffered outbound messages. |
| `OUTBOX_TTL_MS` | Optional | No | Time-to-live for queued outbound messages. |
| `COMMAND_CACHE_TTL_MS` | Optional | No | Retention window for command de-duplication. |
| `COMMAND_CACHE_MAX` | Optional | No | Maximum size of command de-duplication cache. |

### 6. Security-sensitive items

Treat the following as secrets or security-relevant material:

- `DEVICE_TOKEN`
- `LOCAL_CONTROL_TOKEN`
- `E2E_KEY_PATH`
- `IDENTITY_KEY_PATH`
- `TRUST_PATH`
- bridge-mode `secret.json`

Do not commit real values for these items into source control.

## Optional Tools

### `xiotbox_local_control`

Optional agent tool that calls the XiotBox local-control HTTP endpoint.

Typical uses:

- `open_app`
- `tap`
- `type`
- `swipe`
- `click_text`
- `get_screen`
- `get_tree`

### `xiotbox_control`

Optional agent tool that dispatches remote device-control plans to a XiotBox-connected device.

This is the tool to use when OpenClaw should run on one host while a remote device acts as the control executor.

## Troubleshooting

### The plugin installs but does not show up in `openclaw plugins list`

- Confirm the repository contains `openclaw.plugin.json`.
- Confirm the install path still resolves to `extensions/xiotbox`.
- Restart the OpenClaw Gateway after install.

### The channel loads but does not connect

- Check `GATEWAY_WSS_URL`.
- Check `DEVICE_ID` and `DEVICE_TOKEN`.
- Check whether the target gateway expects `USE_QUERY_AUTH=true`.

### The local OpenClaw Gateway says `pairing required` or `scope-upgrade`

This can happen after the local OpenClaw control-side identity was previously approved
with only `operator.read`, but the current chat/control flow now needs higher scopes
such as `operator.write`, `operator.pairing`, `operator.admin`, or
`operator.talk.secrets`.

Typical symptoms:

- `gateway connect failed: GatewayClientRequestError: pairing required`
- `security audit: device access upgrade requested reason=scope-upgrade`
- local chat/control requests hang because the local gateway rejects the upgraded session

Check pending approvals:

```bash
openclaw devices list
```

Approve the latest pending local scope-upgrade request:

```bash
openclaw devices approve --latest
```

Or approve a specific request id:

```bash
openclaw devices approve <requestId>
```

Then reconnect or restart the local gateway:

```bash
systemctl restart openclaw-gateway
```

This approval should normally only be needed once per local control identity unless
the identity changes or the approved scope set is reset.

### Bridge mode starts but cannot reach OpenClaw

- Confirm the local OpenClaw Gateway is running.
- Confirm `bridge.openclawHost`, `bridge.openclawPort`, and `bridge.GATEWAY_TOKEN`.
- Confirm `$OPENCLAW_HOME/xiotbox/config.json` and `secret.json` are readable by the process.

### Local control tools fail

- Confirm `LOCAL_CONTROL_BASE_URL` and `LOCAL_CONTROL_TOKEN`.
- Confirm the XiotBox local-control service is running.
- Confirm the device-side accessibility / control prerequisites are enabled.

### Streaming output is unstable

- Keep `PROGRESS_UPDATES` separate from the main reply path.
- Adjust `STREAM_THROTTLE_MS` and `PROGRESS_THROTTLE_MS` conservatively before changing protocol behavior.
- Do not mix release-prep doc changes with protocol refactors in the same release candidate.

## Safety Notes

- This plugin runs trusted code inside or alongside OpenClaw.
- Device tokens and local-control tokens grant operational access and must be stored as secrets.
- If publishing publicly, review all examples for real endpoints, real tokens, or internal hostnames before release.
- If enabling remote device-control tools, restrict `SCOPES` and `CONTROL_ACTIONS` to the minimum needed.

## Release-Prep Notes

- The current path/source installation behavior is intentionally preserved.
- This repository is suitable for release preparation, but public catalog metadata should be confirmed before publication.
- See the following release-prep documents:
  - [RELEASE_PREP_CHECKLIST.md](./RELEASE_PREP_CHECKLIST.md)
  - [CLAWHUB_PUBLISHING_NOTES.md](./CLAWHUB_PUBLISHING_NOTES.md)

## Related Documents

- [CHAT_MEDIA_CONTRACT.md](./CHAT_MEDIA_CONTRACT.md)
- [TEST_PLAN.md](./TEST_PLAN.md)
- [docs/plugins-git-install-termux.md](./docs/plugins-git-install-termux.md)

## License

MIT
