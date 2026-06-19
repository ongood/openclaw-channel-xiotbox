# Release Prep Checklist

This checklist is for preparing the XiotBox plugin repository for a future public release without changing the current installation and runtime model.

## Completed in this preparation pass

- `openclaw.plugin.json` reviewed and expanded with release-safe metadata:
  - `name`
  - `description`
  - `version`
  - `uiHints`
  - richer `configSchema` descriptions
- `package.json` reviewed and expanded with public package metadata:
  - `homepage`
  - `repository`
  - `bugs`
  - broader keywords
  - Node.js engine requirement
- `README.md` rewritten into a release-oriented engineering document.
- Current install model explicitly documented as still supported:
  - local path install
  - linked dev install
  - source checkout
  - bridge mode
- No protocol changes were introduced in this prep pass.
- No runtime registration entry points were changed.

## Manual confirmation still required

- Confirm the final short catalog description used outside the repository README.
- Confirm the support / contact policy for public users.
- Confirm whether screenshots or store assets will be prepared before the first ClawHub listing.

## Items that should not be exposed publicly without review

- Real `DEVICE_TOKEN` examples
- Real `LOCAL_CONTROL_TOKEN` examples
- Internal gateway endpoints
- Internal device IDs
- Internal trust-store or key paths
- Environment-specific deployment scripts that assume private infrastructure

## Final checks before public release

- Review every example for real hostnames or secrets.
- Confirm README install examples match the actual supported install flow at release time.
- Confirm `openclaw.install.localPath` remains correct.
- Confirm `openclaw.install.minHostVersion` remains `>=2026.3.22` and matches tested host versions.
- Confirm `dist/` artifacts are up to date if release packaging depends on them.
- Confirm the release stays on the current `2.0.x` version line and is published via a new tag.
- Run:

```bash
npm install
npm run build
npm test
```

- Verify:

```bash
openclaw plugins install ./openclaw-channel-xiotbox
openclaw plugins list
openclaw plugins inspect xiotbox
```

- Verify an existing path-install workflow still works after the release-prep edits.
- Verify plugin mode and bridge mode both still load with unchanged runtime behavior.

## Out of scope for this prep pass

- Changing protocol design
- Reworking streaming behavior
- Reworking tool contracts
- Changing install resolver behavior
- Publishing, tagging, or pushing release artifacts
