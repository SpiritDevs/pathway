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

## The `pathway` module

The runtime adds a `pathway` module to `require("electron")` in the main process. `apps/desktop/src/preview/PathwayRuntime.ts` is the only place the app reads it. It feature-detects the module on each call, so the same build runs on stock Electron:

| Local browser                      | On the runtime                                                                  | On stock Electron                                             |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Site information (`siteInfo` IPC)  | Chromium's security state, connection and certificate chain (PEMs stay in main) | The origin, and secure or not from its scheme; no certificate |
| Site settings (`openSiteSettings`) | Loads `chrome://settings/content/siteDetails` into a new tab beside the page    | Not offered                                                   |
| Clear site data (`clearSiteData`)  | Chrome's browsing-data remover for the tab's partition                          | The Electron session's `clearStorageData`                     |

Certificate validity times arrive in milliseconds since the epoch, and fingerprints as uppercase hex bytes separated by colons.

### Browser pages

Only the main process ever produces a `chrome://` address. `normalizePreviewUrl` stays http(s)-only, so the server, the remote browser, the address bar, agents and `window.open` can't reach a browser page.

- **Site settings.** The renderer opens a blank tab beside the page through `preview.open`, then calls `openSiteSettings(tabId, targetTabId)`. Main computes `pathway.settingsUrl(origin)` from the source tab's site and loads it into the new tab directly. No caller supplies the address, and it never goes through `normalizePreviewUrl`.
- **Tab state.** The desktop reports the settings page's URL like any other, and the server stores it. History skips it. A webview restored or recovered from that state opens blank instead.
- **Agents.** They drive websites and blank tabs only (`isWebPageUrl`):
  - The automation host refuses to navigate, read or drive a tab that shows a browser page. `PreviewAutomationBrowserPageError` tells the agent to open a website in a new tab instead.
  - Main also refuses page automation in its CDP control session, as a backstop. It checks before every command, because a page's own `history.back()` can return the tab to a browser page partway through an action.
  - `blob:` and `data:` documents aren't web pages either, so agents can't drive them. That is the deliberate default.
  - Users still use the settings page themselves.

User docs for site information, certificates and Site settings wait for [Phase 3](../plans/desktop-chromium-runtime.md#phase-3-runtime-packaging). Until then every shipped build runs stock Electron, which has no certificates or Site settings.

## Archive contents

electron-builder strips `resources/default_app.asar` and the `version` file only from the Electron it downloads itself. It ships a custom `electronDist` as-is.

- Pathway runtime archives must leave both files out.
- A pinned build against an official Electron zip still contains them. They are unused, because the app's own `app.asar` loads instead.
