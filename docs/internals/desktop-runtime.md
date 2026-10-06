# Desktop runtime pin

The desktop app is moving onto the [Pathway runtime](glossary.md): Electron built inside a full Chromium tree, published as per-platform archives ([ADR 0049](../adr/0049-desktop-runs-on-a-pathway-chromium-runtime.md), [plan](../plans/desktop-chromium-runtime.md)). This page covers how this repository pins and consumes those archives.

## The pin file

`apps/desktop/pathway-runtime.json` records:

- `runtimeName` and `runtimeVersion`;
- `electronVersion`, the Electron release the runtime is built from;
- an archive URL and SHA-256 for each of `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64` and `linux-arm64`.

Until `pathway-runtime` publishes Pathway's own archives, the pin points at the official Electron release zips. Their hashes come from that release's `SHASUMS256.txt`.

`electronVersion` must equal the npm `electron` version in `apps/desktop/package.json`. The npm package still supplies types and the dev binary, and a test fails when the two drift. Bump them together.

## Packaging against the pin

`node scripts/build-desktop-artifact.ts --pinned-runtime` (or `PATHWAY_DESKTOP_PINNED_RUNTIME=true`) packages against the pinned archive instead of npm Electron:

- The script streams the archive into the gitignored `apps/desktop/.electron-runtime/archives` cache.
- It verifies the SHA-256 on every download and on every cache hit. On a mismatch it deletes the archive and stops.
- It passes the zip to electron-builder as `electronDist`, together with the pin's `electronVersion`.

Build arm64 and x64 separately; there is no universal archive.

Default packaging, dev launch and release CI still use npm Electron. They switch to the pin in [Phase 3](../plans/desktop-chromium-runtime.md#phase-3-runtime-packaging).

## Archive contents

electron-builder strips `resources/default_app.asar` and the `version` file only from the Electron it downloads itself. It ships a custom `electronDist` as-is.

- Pathway runtime archives must leave both files out.
- A pinned build against an official Electron zip still contains them. They are unused, because the app's own `app.asar` loads instead.
