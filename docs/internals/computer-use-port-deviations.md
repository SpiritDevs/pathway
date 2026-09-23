# Computer Use port deviations

Pathway's Computer Use is a literal port of Synara's (see ADRs 0036–0045). Each line records one
place where the port intentionally differs from Synara, so a reviewer comparing the two can tell a
deliberate change from drift. Add a line whenever you diverge; remove it if the divergence goes away.

## P1 — native

- Cua patches rename Synara product strings to Pathway (`pathway_native_revision`, `pathway_browser_input_control`, `_pathway_foreground_observation_ms`, `PATHWAY_CUA_*_OBSERVATION_MS`, `PATHWAY_CURSOR_PREVIEW_PATH`, `pathway_cua_overlay_init`/`pathway_cua_focus_restore` stderr lines, `pathway.compact` theme, `pathway-browser-l7`, `PathwayCuaCursorPanel`); code is otherwise unchanged and `cuaDriverRelease.json` carries the recomputed patch checksums.
- `provision-cua-driver`, `cua-cache-key` and `cua-artifact-provenance` are Effect TypeScript under `scripts/` instead of `.mjs` under `apps/desktop/scripts/`.
- Synara's `build-timing` helper is dropped; timing comes from Effect spans and logs.
- A shared `scripts/lib/native-command.ts` runs child processes; it replaces `build-timing` in the Cua cache-key inputs.
- `provision-cua-driver` defaults to `apps/desktop/.electron-runtime/cua-driver` rather than `apps/desktop/resources/cua-driver`, matching Pathway's gitignored staging root.
- The pinned-rustc error also suggests `RUSTUP_TOOLCHAIN`, since CI scopes the pin to the Cua steps.
- `provenance.json` is written as compact JSON through the Schema encoder.
- `provisionCuaDriver` is callable in-process, so the desktop build stages Cua without spawning a second Node process.
- The Cua driver embeds an `Info.plist` (linked into `__TEXT,__info_plist` with `cargo rustc`) so its signing identifier stays `com.spiritdevs.pathway.cua.driver` through electron-builder's re-sign; Synara's identifier follows the binary's LC_UUID. macOS provenance records the identifier, staging rejects a driver that doesn't carry it (so pre-identifier and platform-less Mac artifacts are no longer reused), and the release verify step checks both nested identifiers in the packaged app.
- Reused Cua artifacts on every platform must record a sha256 for each file staged beside the driver, and staging writes only the verified bytes. Synara copies Windows and unpatched sidecars unchecked; Pathway rejects a changed, missing or unrecorded file and any legacy artifact without checksums.
- `cuaDriverRelease.json` is exported from `@spiritdevs/shared` as a subpath so scripts can import it directly.
- The `provision-cua` action drops Synara's Xcode 16.4 pin (the self-hosted fleet runner owns Xcode and the cache key fingerprints it) and its benchmark step, adds a `targets` input, and scopes `RUSTUP_TOOLCHAIN`/strip overrides to its own steps so other Rust builds keep stable.
- `cua-cache-key` prints the key through `Effect.log`; CI reads it from `GITHUB_OUTPUT`, never stdout.
- The `provision-cua` action pins `CARGO_INCREMENTAL=0` and `CARGO_TERM_COLOR=always` on its fingerprint and build steps, so the fingerprinted Cargo env is the same whether or not the caller ran `dtolnay/rust-toolchain`; `cua-release-cache` installs Rust with it, like `release`.
- The release build job timeout rises from 30 to 45 minutes to absorb a cold Cua build.
- The Swift helper lives in `native/pathway-helper/` as `pathway-helper`, not `apps/desktop/native/appsnap/` as `synara-appsnap-helper`; `AppSnap*` Swift identifiers become `PathwayHelper*`, and queue labels use `com.spiritdevs.pathway.*`.
- The helper drops watch mode and its pieces (OptionChordMonitor, CaptureFeedback, ExternalTriggerListener, WindowCapture, and the `triggered`/`captured`/`windows` events); `--watch`, `--output-dir`, `--excluded-bundle-id` and `--external-trigger` are now unknown arguments.
- The helper links without AVFoundation, which only the dropped capture feedback used.
- The helper embeds an `Info.plist` so its signing identifier stays `com.spiritdevs.pathway.helper` through electron-builder's re-sign; Synara's identifier follows the binary's LC_UUID.
- `build-pathway-helper` is Effect TypeScript under `scripts/`, stages to `apps/desktop/.electron-runtime/pathway-helper/pathway-helper`, and runs the native tests with `--native-tests`.
- The helper and Cua driver ship as `extraResources` under `Contents/Resources/{pathway-helper,cua-driver}/` rather than Synara's `Contents/Helpers` via `extraFiles`, following Pathway's staged prod-resources convention; both are listed in `mac.binaries` and `x64ArchFiles`.
- `build-desktop-artifact` stages Computer Use natives in-process into prod-resources (Cua on macOS and Linux, the helper on macOS only) instead of spawning the build scripts.
- `NSScreenCaptureUsageDescription` combines Computer Use with the existing SnapShots wording, and `NSAccessibilityUsageDescription` is new.
- Pathway has only the `production` and `cua` packaged flavors (no `canary`), defined in `@spiritdevs/shared/desktopFlavor`; development stays driven by the dev server URL rather than a flavor.
- The cua flavor's identity is `com.spiritdevs.pathway.cua`, "Pathway Cua", `pathway-cua://app`, user data `pathway-cua` and home `~/.pathway-cua`; the build stamps `pathwayDesktopFlavor` into the packaged package.json, and an unknown value stops startup.
- The cua flavor ignores a `PATHWAY_HOME` that resolves to the production home (`~/.pathway`), both in `DesktopEnvironment` and in the early Linux settings lookup, and pins its resolved home as the backend's `PATHWAY_HOME`; any other override still wins. Synara lets `SYNARA_HOME` outrank the flavor.
- Signed cua builds sign as `com.spiritdevs.pathway.cua` with the keychain group `<TEAM_ID>.com.spiritdevs.pathway.cua.webauthn` and require `PATHWAY_MACOS_CUA_PROVISIONING_PROFILE`, with no fallback to production's profile; the app accepts only the WebAuthn group matching its packaged flavor.
- There is no runtime flavor override (Synara's `requestedFlavor`, source-build marker and smoke user-data override); only a packaged artifact can be the cua flavor.
- The cua flavor publishes no update feed (`publish: null`), so the updater reports updates as unavailable rather than using Synara's scripted updates.
- `build-desktop-artifact --flavor cua` (or `PATHWAY_DESKTOP_FLAVOR`) writes to `release-cua`, overriding `--mock-updates`' `release-mock`; Windows refuses isolated flavors at option resolution and in `createBuildConfig`.
- The desktop renderer scheme now comes from `DesktopEnvironment.desktopScheme` rather than `getDesktopScheme(isDevelopment)`, and the server trusts the `pathway-cua://app` renderer origin.
- Before cua builds can sign in with OAuth, the Clerk instance's allowed redirect origins need `pathway-cua://app`; this is instance configuration, not repository code.
- Host code must use the renamed Cua wire keys (`pathway_native_revision`, `pathway_browser_input_control`, `_pathway_foreground_observation_ms`, `PATHWAY_CUA_*_OBSERVATION_MS`, …); Synara's `synara_*` names are not accepted.
