# OpenClaw Plugin Handover Notes

> Repository: `openclaw-channel-xiotbox`
> Role: OpenClaw <-> XiotBox Gateway bridge plugin

## 1. Repository purpose

This repository implements the OpenClaw-side executor/bridge that converts XiotBox
commands into OpenClaw runtime calls and returns results using the XiotBox protocol.

## 2. Important files

- Main command flow: `src/channel.ts`
- E2E implementation: `src/e2e.ts`
- Runtime bridge: `src/runtime.ts`
- Build output used in installation: `dist/`
- Version metadata: `openclaw.plugin.json`, `package.json`
- BotDrop bootstrap entrypoint: `scripts/bootstrap_xiotbox_termux.sh`
- Health check helper: `scripts/health_check_xiotbox.sh`

## 3. Current hard constraints

1. Encrypted replies must be bound to the sender key/session of the current request.
2. If the sender key cannot be resolved, fail closed. Do not return undecryptable success payloads.
3. Identity-trust changes must surface explicit errors such as `client_identity_changed`.

## 4. Multi-client roaming strategy

The current implementation uses a multi-envelope strategy (`e2e_multi`) so the same
message can be decrypted independently by multiple clients.

Do not regress this into a server-side plaintext relay.

## 5. Release rules

Every functional plugin change must also include:

1. Updates in `src/`
2. A rebuilt `dist/`
3. A version bump
4. A new tag and remote push

Otherwise users who install by tag will not actually receive the intended fix.

## 6. Quick validation

1. OpenClaw can decrypt the inbound request successfully
2. Replies can be decrypted correctly on both PC and iOS clients
3. There are no recurring `client_identity_changed` errors or widespread `[Encrypted payload]` fallback output
