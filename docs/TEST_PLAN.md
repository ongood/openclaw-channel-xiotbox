# TEST_PLAN.md - xiotbox Quality and Regression Plan

> Type: CURRENT TEST STRATEGY · Last verified: 2026-08-09
> Owner: openclaw-channel-xiotbox maintainers

The commands and coverage layers below are normative. Individual pass results come from CI/test output and are not permanently guaranteed by this document.

## 1. Test Scope

| Module | File | Key logic | Test file | Status |
|------|------|-----------|-----------|--------|
| Tool-loop guard | `channel.ts` | `toolOnlyCounter`, `shouldSkipReply`, `isHardExitCommand`, `buildToolSummary` | `tool-only-fallback.test.mjs` | Passing |
| Media context mapping | `channel.ts` | `buildInboundMediaContext`, `stageInlineMediaPayload` | `media-context-mapping.test.mjs` | Passing |
| Session key / context epoch | `channel.ts` | `buildSessionKey`, `normalizeContextEpoch`, `resolveInboundContextEpoch`, `normalizeThreadId`, `normalizeAccountId` | `session-key.test.mjs` | Passing |
| Text extraction | `channel.ts` | `normalizeTextPayload` | `normalize-text.test.mjs` | Passing |
| Pure control-tool helpers | `xiotbox-control-tool.ts` | `normalizePlan`, `normalizeLaunchStrategy`, `extractForegroundPackage`, `extractRootBoundsFromTree`, `looksLikeLauncherPackage` | `control-tool-pure.test.mjs` | Passing |
| WSS auth / connection | `wss_client.js` | connect, auth handshake | - | Needs mock WSS |
| Message send/receive E2E | `e2e.ts` + `channel.ts` | inbound -> session -> outbound full path | - | Needs mock WSS |
| Disconnect / reconnect | `wss_client.js` | reconnect, heartbeat timeout | - | Needs mock WSS |

## 2. One-command Regression

```bash
npm test
# equivalent to: node --test test/*.test.mjs
```

## 3. Smoke Test Checklist

### P0 - required before merge

1. Login/auth flow: WSS connect -> device registration -> token validation (automation pending)
2. Message flow: inbound text -> agent processing -> outbound reply (automation pending)
3. Media handling: image/PDF/ZIP upload -> correct MediaContext mapping
4. Tool-loop guard: consecutive tool-only replies >= threshold -> automatic reset + warning
5. Session isolation: different `device + thread` combinations must resolve to different session keys

### P1 - required for regression

6. Hard-exit command recognition: `/stop`, exit-control phrases, and chat reset phrases behave correctly
7. Context epoch resolution: explicit / fallback / default sources are handled correctly
8. Control plan normalization: malformed plans degrade safely
9. Launcher detection: known launcher packages are recognized correctly
10. Text extraction: nested / streamed / multi-shape payloads are extracted correctly

### P2 - manual validation

11. Select/copy workflow on the target device
12. WSS reconnect after disconnect
13. SessionStore persistence across restart

## 4. Known Defects

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| BUG-001 | P2 | `media-context-mapping.test.mjs` originally depended on an undeclared dependency and required extra install after `npm ci` | Fixed |

## 5. Coverage Targets

- Pure-function unit test coverage: target >= 80%
- E2E automation: add once mock WSS infrastructure exists
- Merge gate: `npm test` must stay green
