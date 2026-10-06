# Compose Chrome Profiles with Electron sessions

[ADR 0049](0049-desktop-runs-on-a-pathway-chromium-runtime.md) links Chrome's browser layer into Pathway's Electron runtime. Chrome assumes every browser context is a `Profile`, and Electron assumes every session is an `ElectronBrowserContext`, so the real question is who owns startup, contexts and permissions. The COR-256 source survey mapped the options, and the COR-257 macOS arm64 spike proved this one.

**Decision.**

1. **Startup.** The executable enters `ChromeMain` through `PathwayMainDelegate`. `ChromeBrowserMainParts` owns the browser process and the main loop. Electron's lifecycle runs as an extra part that starts Electron's main-process JavaScript. Electron keeps `AtomApplication`, native app and window behavior, and the single-instance lock. It holds one `EMBEDDER_APP` keep-alive in Chrome's registry and releases it after an accepted quit. Electron's sessions and Node shut down before Chrome destroys Profiles.
2. **Client ownership.** Chrome owns features, resources, `Local State`, `ProfileManager`, the system network context, OSCrypt, site isolation and WebUI. There is one content client per role. The Chrome-derived `PathwayContentBrowserClient` calls Electron's app hooks where Electron needs them: guests, window preferences, IPC, webRequest, protocols, downloads and permission callbacks. Chrome's policy and process locks stay authoritative. Electron's app preferences live in a separate `Electron Local State` file for now; that is spike data, not a design.
3. **Every session is a real Chrome Profile.** `<userData>` is the root Chrome fixes at startup. The default session is the Profile at `<userData>/Default`. Each `persist:<name>` partition is its own regular Profile at `<userData>/Pathway Partition <SHA256>`, the uppercase hex SHA-256 of `<name>`. `ElectronBrowserContext` becomes an adapter attached to the Profile through `ProfileSessionDelegate`, so Chrome services and navigation always see the actual Profile. Profiles start with fresh data. Stock Electron's root and `Partitions/<name>` data is not migrated yet.
4. **In-memory partitions are unsupported.** `session`, `BrowserWindow`, `WebContentsView` and `session.fromPath` reject named non-persistent partitions instead of silently persisting them. The empty partition is the default Profile.
5. **Chrome owns OSCrypt.** There is one async encryptor and one macOS keychain provider, both Chrome's. Electron's `safeStorage` delegates to them, and the app sets its keychain service and account names before Chrome initializes the provider. Profiles share the key but not their databases or settings. The desktop's own `safeStorage` data, saved environments and the connection catalog, uses the same key.
6. **Guests and WebUI stay apart.** Ordinary guests keep Electron's renderer lifecycle, IPC and preloads. Chrome WebUI runs in a pure Chrome renderer with no Node, preload, Electron frame IPC or startup payload. A guest navigating into WebUI swaps processes. Navigating back removes `chrome.send` and restores the guest's preload. There are no global WebUI bindings and no relaxed origin boundary.
7. **Chrome's own UI stays off.** `PathwayMainDelegate` adds `--no-startup-window`, `--no-first-run` and `--no-default-browser-check` in the browser process, so there is no startup Browser window, first-run flow or default-browser prompt. Chrome's `AppController` and main menu are not installed, because Electron owns the macOS application and its delegate. There is no Chrome `Browser` or `TabStripModel`, and no browser-window permission prompt. Settings guests have no Chrome autofill client, so five optional autofill flags are false for them.
8. **Permission precedence** (COR-288). An explicit Chrome content setting, set by the user or by managed policy, wins, whether Allow or Block. A setting still at its Chrome default defers to Pathway's deny-by-default policy through Electron's permission callbacks. Chrome's defaults match stock Chrome.
9. **The `pathway` module.** `require('electron').pathway` exists in the main process only. The runtime ships [`pathway.d.ts`][typings], which is canonical. [`PathwayRuntime.ts`](../../apps/desktop/src/preview/PathwayRuntime.ts) mirrors the part the desktop uses and must match it.
   - `siteInfo(webContents)` returns the committed main-frame origin, Chrome's security state, a connection summary, and cookie and storage usage. The certificate chain comes from the committed navigation, **leaf first**: no refetch, no invented root and no `verifiedAt`. Validity times are **milliseconds**. SHA-256 certificate and SPKI fingerprints are **uppercase colon hex**. Non-HTTPS pages return `certificate: null`.
   - `contentSettings.get`, `set` and `reset` take a partition and an origin and cover 20 types in that Profile's content settings. `get` returns effective values, `set` with `default` removes an override, and Chrome rejects unsupported pairs such as JavaScript Ask. Device types are Chrome's guard settings, not chooser grants. `downloads` covers automatic multiple downloads, and `midi` covers SysEx only. `storageAccess` is a setting on a pair of sites, so what `(origin, origin)` means still needs checking.
   - `clearSiteData(partition, origin)` runs Chrome's browsing-data remover and resolves after both its storage and cookie receipts. Other Profiles are untouched, and content settings are not reset.
   - `settingsUrl(origin)` returns Chrome's `siteDetails` URL for an HTTP(S) origin, or an empty string for invalid input.

**Consequences.**

- Each environment's preview partition ([`BrowserSession.ts`](../../apps/desktop/src/preview/BrowserSession.ts)) is a full regular Profile. Profiles load through the synchronous `ProfileManager::GetProfile` on the UI thread, and a load failure crashes the app.
- **The spike doesn't implement the precedence rule yet.** It lets Chrome's effective value win, defaults included. Only Ask and unmapped types reach Pathway's callbacks. Gate 4 reports geolocation's default as Allow, where stock Chrome asks, so any type whose default is Allow bypasses Pathway's allowlist today. Only Notifications Block → Allow was exercised. No mapped type's default has been audited, and managed policy was never exercised. COR-288 tracks all of this.
- **`clearSiteData` scope is an open decision before the runtime ships.** Today it clears storage and cache for the exact origin, but cookies for the whole registrable domain, sibling subdomains included. Only `127.0.0.1` was exercised, where the registrable domain falls back to the host. [#279](https://github.com/SpiritDevs/pathway/pull/279) already calls it, and the `cookieCount` the site panel shows (host and parent-domain cookies) doesn't match what Clear deletes.
- Users' existing Electron browsing data doesn't carry over until a reviewed migration exists.

**Not yet proven.**

- Signed-in use. The packaged app was only checked at its signed-out screen.
- Pathway setting `userData` from JavaScript after Chrome has fixed the Profile root. Both launches passed `--user-data-dir`, and [`DesktopApp.ts`](../../apps/desktop/src/app/DesktopApp.ts#L285) sets it later.
- Per-Profile memory, disk and startup cost.
- Data migration from stock Electron's layout, including the encryption key.
- Windows, Linux and macOS x64.
- ThinLTO and release builds.
- Signing and notarization.
- Managed policy.
- The native CommonJS lexer assertion on a literal Latin-1 character (COR-287), which blocks any release.
- That Chrome's menu, AppleScript, Dock-reopen and app-shim paths can never create a `Browser`. The profile picker and updater state are unverified.
- Other Chrome Settings pages, Safe Browsing, hardware and chooser grants, and permission subscriptions.

**Alternatives rejected** (from COR-256).

- **A merged `PathwayProfile : Profile` that holds Electron's session state.** It needs far more Chrome integration and rebasing, because `ProfileImpl` can't simply be subclassed. It is held in reserve for a measured blocker with native Profiles.
- **One Profile with several storage partitions.** Content settings are per Profile, so the partitions would share permissions.
- **Linking Chrome into Electron's unchanged context and client.** Chrome's services cast every context to `Profile`.
- **Pairing an Electron context with a Profile, through `Profile::FromBrowserContext` lookups or casts to the default Profile.** Other direct casts remain. Gate 2's Settings page crashed this way.
- **Forwarding both embedders' main parts intact.** Two owners would compete for startup and the main loop.
- **Reusing Electron's `Partitions/<name>` layout.** `ProfileManager` only accepts immediate children of its root.
- **Off-the-record Profiles for in-memory partitions.** Their services and settings can inherit from a parent Profile, so they aren't independent by default. This is deferred, not designed.
- **Removing the extension guest's `chrome://` guard.** Electron's guests aren't extension guests, and the guard isn't what makes WebUI safe.
- **A hidden Chrome `Browser` or `TabStripModel` to satisfy Chrome helpers.** It brings back the browser UI this decision keeps off.

**Evidence.** Gates 1–4 pass on macOS arm64. Two `<webview>` guests keep their cookies, storage, service workers and content settings apart across a restart. Chrome's `siteDetails` page changes a permission in one Profile only, and all six module functions pass. Unchanged Pathway, launched with `--user-data-dir`, reaches its signed-out screen on the same framework bytes. The records are in `pathway-runtime` at `9469952`: [Gate 1][gate1], [Gate 2][gate2], [Gate 3][gate3] and [Gate 4][gate4], with receipts, screenshots and the [patch inventory][patches] of 12 Chromium and 9 Electron patches.

[typings]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/typings/pathway.d.ts
[gate1]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/evidence/gate1-macos.md
[gate2]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/evidence/gate2-macos.md
[gate3]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/evidence/gate3-macos.md
[gate4]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/evidence/gate4-macos.md
[patches]: https://github.com/SpiritDevs/pathway-runtime/blob/9469952f58f034273471e273804b738fc458f79f/patches/README.md
