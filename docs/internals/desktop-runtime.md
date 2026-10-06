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

Default packaging and `vp run dev` still use npm Electron. The macOS arm64 release job uses `--pinned-runtime --require-pathway-runtime` for stable and nightly builds. Windows and Linux stay on stock Electron. The guard rejects stock packaging and the official Electron download/API URLs before any build or backend deployment. With the committed pin unchanged, macOS releases intentionally stop with instructions to publish and pin the Pathway archive.

### Download authentication and hosting

`PATHWAY_RUNTIME_DOWNLOAD_TOKEN` is optional. When supplied, the downloader sends `Authorization: Bearer <token>` and `Accept: application/octet-stream`. It uses Fetch's redirect handling, which follows GitHub's redirect to the asset host without forwarding authorization across origins. The token is read as a redacted config value, and authorization headers are redacted from HTTP errors. Without the variable, the request headers are unchanged. Verified cache hits need no token.

Release CI mints a short-lived token with the existing `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` through `actions/create-github-app-token@v2`, limited to `SpiritDevs/pathway-runtime` with Contents read permission. No additional long-lived token secret is needed.

**One-time setup:** install the existing release GitHub App on `SpiritDevs/pathway-runtime`, or add that repository to its selected repositories. Ensure the installation permits Contents read and that the existing app secrets are available to the release job's production environment.

**Once hosting is decided:** publish an immutable macOS arm64 release archive from the runtime repository, then change only `archives.darwin-arm64.url` and `archives.darwin-arm64.sha256` in `apps/desktop/pathway-runtime.json` to that asset's URL and the SHA-256 of the exact downloaded ZIP. For a private GitHub release, use the asset's API `url` (`https://api.github.com/repos/SpiritDevs/pathway-runtime/releases/assets/<asset-id>`), rather than its `browser_download_url`; GitHub accepts the token and returns binary content or a redirect when asked for octet-stream ([GitHub release asset API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)). Keep the other platform pins unchanged and bump the runtime version when appropriate; its base Electron version must still match npm Electron.

### Bundle identity

Pinned packaging writes `Contents/Resources/pathway-runtime-app.json` outside the asar, before signing. The file has exactly two fields:

```json
{ "userDataDirName": "pathway", "legacyUserDataDirName": "Pathway (Alpha)" }
```

Stable and nightly share those names. The cua flavor stamps `pathway-cua` for both fields. The native runtime reads this file before Chrome starts; Chrome must choose the existing legacy directory under Application Support if present, otherwise the new directory. Desktop `resolveUserDataPath` reads the same file only when `"pathway" in Electron`, with the same legacy-exists rule. These stamped names win even if `VITE_DEV_SERVER_URL` is present at launch. Stock Electron's packaged development mode remains unchanged, and a runtime without a stamp keeps the existing development identity resolution.

Before either Clerk initialization or normal startup calls `app.setPath`, resolution compares `app.getPath('userData')` on the runtime with the resolved path and logs an error naming both if they differ. Setting the JS path cannot repair a Chrome Profile root fixed earlier; any drift is a native startup defect. The parallel native reader belongs in `pathway-runtime`; its integration must land before shipping.

### macOS signing and permission prompts

The existing Developer ID signing, provisioning profile, notarization and stapler verification remain in the release job. `mac.hardenedRuntime` is explicit. The main app's passkey entitlements and a separate `mac.entitlementsInherit` file both grant JIT, unsigned executable memory, library-validation bypass and audio input. The inherited file excludes the main app's application identifier, associated domains and passkey keychain groups. Camera, location and Bluetooth runtime capabilities are present in both files too.

Source inspection of the installed electron-builder 26.15.6 `MacTargetHelper.getOptionsForFile` and @electron/osx-sign 1.3.3 confirms that nested framework and helper signing uses the inherited file, with hardened runtime enabled; osx-sign signs enclosed components before the app. Frameworks inherit their host executable's capabilities ([Apple Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [electron-builder macOS options](https://www.electron.build/v26/docs/mac/)). CI checks the app and helper entitlements and runtime flags, verifies the entire signature with `codesign --verify --deep --strict`, and validates the stapled ticket. A signed runtime release has not yet been exercised; it waits on the hosted pin.

The packaged `Info.plist` supplies `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSLocationUsageDescription` (the macOS location key) and `NSBluetoothAlwaysUsageDescription`, plus the existing screen capture, accessibility and local network descriptions. Microphone copy covers dictation and websites. CI checks these website usage strings. They support macOS permission prompts ([Apple camera key](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription), [location key](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationusagedescription), [Bluetooth key](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)); they do not grant a website permission or prove hardware access. Camera, microphone, location and Bluetooth prompts still need validation on a signed build.

## The `pathway` module

The runtime adds a `pathway` module to `require("electron")` in the main process. `apps/desktop/src/preview/PathwayRuntime.ts` reads the browser API; `ElectronApp` also detects the module for startup identity. Both keep the same build compatible with stock Electron:

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

The macOS local-browser features are documented in [Browser work and agent questions](../user/browser-and-agent-questions.md#site-information-on-macos). Windows and Linux retain stock Electron's scheme-based connection information and Clear site data, without certificates or Site settings.

## Archive contents

electron-builder strips `resources/default_app.asar` and the `version` file only from the Electron it downloads itself. It ships a custom `electronDist` as-is.

- Pathway runtime archives must leave both files out.
- A pinned build against an official Electron zip still contains them. They are unused, because the app's own `app.asar` loads instead.
