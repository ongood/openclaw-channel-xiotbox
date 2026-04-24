# ClawHub Publishing Notes

This repository is now closer to ClawHub publication readiness, but this document intentionally treats the current state as "publication preparation" rather than "ready to publish immediately".

## What is already in place

- Stable plugin id: `xiotbox`
- Stable channel id: `xiotbox`
- Public display name confirmed as `XiotBox OpenClaw Channel`
- Public author / maintainer display confirmed as `OnGood`
- Existing local/path install workflow remains intact
- Existing bridge-mode workflow remains intact
- Public package metadata is present in `package.json`
- Manifest metadata is expanded in `openclaw.plugin.json`
- README now explains:
  - what the plugin does
  - how it is installed today
  - how it is configured
  - how to troubleshoot it

## What still needs confirmation before ClawHub publication

- Final short description for catalog display
- Final support URL and issue-handling policy
- Whether listing art or screenshots are needed for the first release

## Recommended follow-up before publishing

- Review examples for private endpoints and secrets.
- Review screenshots or future store assets, if ClawHub listing pages support them.
- Keep `README.md` engineering-heavy, but retain a stronger public-facing summary at the top.
- Confirm the minimum tested OpenClaw host version.
- Confirm whether a changelog file should be added before first public release.
- Keep the publish strategy on the current `2.0.x` line and release via a new tag.

## Important compatibility note

This repository has not been converted into a ClawHub-only install format.

The current local/path/source install behavior is intentionally preserved. Public publication should be additive to the existing install experience, not a replacement for it.

## Recommended publish gate

Consider the plugin ready to enter the "ClawHub publishing preparation" phase when:

- metadata is confirmed
- listing copy is confirmed
- examples are scrubbed for secrets
- a final build/test pass succeeds
- maintainers confirm that current path install behavior must remain supported after publication
- the listing highlights remote chat, device control, bridge mode, and multi-thread orchestration in a balanced way
