# Desktop Chromium runtime plan

This plan builds the runtime described in [ADR 0049](../adr/0049-desktop-runs-on-a-pathway-chromium-runtime.md): Electron built inside a full Chromium tree with Chrome's browser layer linked in, shipped as a pinned archive. It mirrors the ChatGPT/Codex "owl" runtime. Read the ADR first. This file covers decisions, layout, order, exit criteria and evidence. Each phase ends with something that runs.

## Decisions

Corey, 2026-10-03:

- **Platforms:** the eventual target is macOS, Windows and Linux. Corey's macOS ship scope (2026-10-07) moves macOS arm64 releases first; Windows and Linux stay on stock Electron, and `vp run dev` keeps npm Electron. macOS x64 is deferred.
- **Build host:** a dedicated build Mac for macOS. Windows and Linux get their own native build hosts, because Electron builds each platform on that platform.
- **Version:** start from the latest stable Electron and the Chromium it pins. Checked 2026-10-03: Electron **v44.5.1**, which pins Chromium **152.0.7977.130** and Node 24.21.0. The app ships Electron 41.5.0 (Chromium 146) today. The ChatGPT reference is on Chromium 154, ahead of any stable Electron.
- **Code:** all of it is Pathway's own, written against the public Electron and Chromium sources. The ChatGPT bundle is an architecture reference only. Nothing is copied, decompiled or linked from it.
- **Stopgap:** the stock-Electron site information dropdown and Clear site data shipped in `251ab4f8ce`. Phase 4 replaces them.

## Status

Tracked under COR-243, with one milestone per phase.

| Phase                         | macOS                                                                                                                                                                                                                                                                                                      | Windows                  | Linux                    | Notes                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------- |
| 0. Build hosts and CI         | Interim host: the fleet Mac Studio synced and built. Dedicated build Mac still needed.                                                                                                                                                                                                                     | Blocked: no host         | Blocked: no host         | `SpiritDevs/pathway-runtime` created (private). Remote cache deferred until dedicated hosts exist. |
| 1. Stock Electron from source | arm64 built from source; Pathway packaged against it and starts isolated, unsigned. The account-check stall came from a stale Clerk key in the test build (COR-253); sign-in on the runtime is not yet verified, and the build scripts have not yet run end to end. x64 waits for the dedicated build Mac. | Not started              | Not started              | Electron 44.5.1 upgrade in #270; pinned-archive packaging in #269                                  |
| 2. Chrome's browser layer     | macOS arm64 spike passed Gates 1–4 ([ADR 0050](../adr/0050-compose-chrome-profiles-with-electron-sessions.md)). Release blockers: COR-287, COR-288.                                                                                                                                                        | Pending                  | Pending                  | Chrome owns startup and real Profiles, one Profile per `persist:*` partition                       |
| 3. Runtime packaging          | macOS arm64 release wiring implemented; native identity reader implemented in pathway-runtime PR #2. Hosted archive pin and signed CI verification remain pending.                                                                                                                                         | Deferred; stock Electron | Deferred; stock Electron | COR-263 app work; archive hosting in COR-262                                                       |
| 4. Pathway UI on Chromium     | Not started                                                                                                                                                                                                                                                                                                | Not started              | Not started              |                                                                                                    |
| 5. Release cadence            | Not started                                                                                                                                                                                                                                                                                                | Not started              | Not started              |                                                                                                    |

## Reference

ChatGPT 26.928.40906, installed at `/Applications/ChatGPT.app` on Corey's MacBook:

- `Contents/Frameworks/Codex Framework.framework` is Chromium 154.0.8037.57 (362 MB). It holds Electron's sources (`third_party/electron/shell/...`) and Chrome's browser layer (`BrowserView`, `TabStripModel`, `OmniboxView`, `PageInfoBubble`, `certificate_viewer`).
- The `ChatGPT` executable loads the framework at runtime and calls `ChromeMain`. Renderer and service helpers are children of the app process.
- `Contents/Resources/app.asar` is a normal Electron app. `owl-electron-app.json` pins `runtimeName: "owl"` and a `runtimeArchiveSha`, and records that it was packaged from `codex-apps/electron`.
- `owl_web_view_guest_delegate` and `OWL_NATIVE_GLASS_*` strings show webview guests rendered in the app's own compositor, with native glass effects composited over them.

Reading strings, layout and process structure is fine. Copying anything out of the bundle is not.

## Where the code lives

**`SpiritDevs/pathway-runtime`** (new repository) owns the runtime:

- The `gclient` solution that pins Electron and Chromium.
- Pathway's patches to Chromium and Electron, kept as patch files the way Electron keeps its own.
- Pathway's runtime code: browser-layer wiring and the `pathway` main-process API.
- Per-platform `args.gn`, build scripts, packaging into runtime archives, and release CI that publishes each archive with its SHA-256.

A Chromium checkout is managed by `gclient` and is far too large for the pnpm monorepo, so it stays out of this repository.

**This repository** consumes the runtime:

- `apps/desktop/pathway-runtime.json` pins `runtimeName: "pathway"`, the runtime version, and per-platform and per-architecture archive URLs with their SHA-256 hashes. See [Desktop runtime pin](../internals/desktop-runtime.md).
- `scripts/build-desktop-artifact.ts --pinned-runtime` packages the app against the archive. macOS arm64 stable and nightly CI requires the Pathway runtime; `vp run dev` keeps npm Electron.
- `.github/workflows/release.yml` gains Windows and Linux jobs. Today it packages only macOS arm64, on the self-hosted `fleet-macos-arm64` runners.

## Runtime interface

What `apps/desktop` sees:

- **Unchanged.** Every Electron API Pathway uses today keeps working, so the app runs on the runtime with no code changes until Phase 4.
- **Chrome's browser layer.** `chrome://` WebUI pages, such as `chrome://settings/content/siteDetails`, load in Pathway's webview guests. Per-site content settings and site data apply to the preview partitions (`persist:pathway-preview-*`).
- **A `pathway` main-process module** (names are settled in [ADR 0050](../adr/0050-compose-chrome-profiles-with-electron-sessions.md)):
  - `siteInfo(webContents)`: origin, security state, connection summary, the certificate chain (PEM plus parsed fields), and cookie and storage usage.
  - `contentSettings.get` / `set` / `reset` for an origin in a partition.
  - `clearSiteData(partition, origin)` through Chrome's browsing-data remover.
  - `settingsUrl(origin)`: the `chrome://settings` site details URL for an origin.

Each preview partition is its own Chrome Profile. [ADR 0050](../adr/0050-compose-chrome-profiles-with-electron-sessions.md) records the mapping.

## Phase 0: build hosts and CI

- **macOS:** commission the dedicated build Mac as a self-hosted runner, for example with label `pathway-runtime-macos`.
- **Windows and Linux:** add native build hosts with the same shape.
- Every host needs:
  - well over 100 GB free per checkout, ideally 300 GB+ for several checkouts and caches;
  - 32 GB+ RAM, and as many cores as possible.
- One host per OS covers both architectures by cross-compiling, as Electron's own CI does: macOS arm64 builds x64, Windows x64 builds arm64, and Linux x64 builds arm64. Launching the second architecture still needs a device or VM.
- Toolchains for Chromium 152:
  - macOS: Xcode with the macOS 26.5 SDK.
  - Windows: Visual Studio 2026 and Windows 11 SDK 10.0.26100.7705.
- Set up Electron's `build-tools` with a shared remote compile cache from day one. Rebuilds without a cache are not workable. Electron's own remote build cluster only admits Electron org members, and a patched tree couldn't share its cache anyway. Point `rbeServiceAddress` at a REAPI backend we run or rent.

**Host audit, 2026-10-03:** none qualify.

- The fleet Mac Studio running Pathway (M2 Max, 32 GB) has 58 GiB free, and it is also the main CI runner.
- The second fleet Mac Studio's disk is unverified, and it serves iOS CI.
- No Windows or Linux build host exists. Actions Fleet doesn't support Windows, and its Linux agent has never run on a physical host.

**Exit:** each host can `gclient sync` an Electron checkout and complete a cached rebuild.

## Phase 1: stock Electron from source, all platforms

- Check out the latest stable Electron and its pinned Chromium. Record both versions in this file.
- Build release archives for macOS (arm64 and x64), Windows (x64 and arm64) and Linux (x64 and arm64) with no changes.
- Package Pathway desktop against them through `pathway-runtime.json`. Run the desktop tests and launch the app on each platform.
- If moving to the latest Electron needs app changes, upgrade the npm `electron` dependency in its own PR first.

**Exit:** Pathway desktop runs unchanged on a self-built Electron on all three platforms. This proves toolchains, signing and packaging before any Chromium changes.

**Interim macOS arm64 run, 2026-10-03.** Host: the fleet Mac Studio (M2 Max, 12 cores, 32 GB), shared with live Pathway. Full evidence is in `pathway-runtime/evidence/2026-10-03-macos.md`.

- **Timings:**
  - Shallow sync: 22 min.
  - Cold build: 4h 37m at 4–6 jobs under `nice`.
  - Warm rebuild: 60 s.
  - Dist zip: 50 s.
- **Sizes:**
  - Build root (checkout plus out dir): about 42 GiB, peaking at 44 GiB.
  - Runtime archive: 126.4 MB. That is the source-built dist zip (126.6 MB) minus `default_app.asar` and `version`. The official zip is 130.3 MB.
  - Packaged app: 216 MB zipped.
- **Versions:** the build reports Electron 44.5.1, Chrome 152.0.7977.130 and Node 24.21.0. The packaged framework is byte-identical to the source build.
- **Deviations from `release.gn`:**
  - `enable_dsyms=false`, `symbol_level=0` and `concurrent_links=1`, for the 32 GB RAM and disk limits.
  - `use_thin_lto=false`: GN rejects an explicit `concurrent_links` with ThinLTO.
  - `use_remoteexec=false` and `use_siso=false`, pending the remote cache (COR-245).
  - `mac_sdk_path`, pointing at the official SDK 26.5.

  Release archives must come from the dedicated host with ThinLTO and symbols.

## Phase 2: link Chrome's browser layer

This is the unknown. Make Electron live inside Chrome's startup path, as Codex does: the app executable calls `ChromeMain`, with Electron's shell compiled in rather than replacing Chrome's browser main parts.

- Do macOS first, then Windows and Linux.
- Spike the integration points:
  - browser main parts;
  - profiles, and how preview partitions map to them;
  - how webview guests attach to a Chrome profile;
  - which Chrome UI stays suppressed so Pathway's own UI can replace it.
- Timebox the spike. Write what worked as [ADR 0050](../adr/0050-compose-chrome-profiles-with-electron-sessions.md) before building further.

**Exit:**

- a Pathway webview guest loads `chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.google.com` and changes there take effect;
- `siteInfo` returns a real certificate chain;
- the existing app works unchanged.

## Phase 3: runtime packaging

**macOS arm64 ship scope, 2026-10-07 (COR-263).** The app stamps its release or cua identity outside the asar; desktop JS uses that stamp on the runtime, preserves the legacy-directory rule, and reports any mismatch with the native Profile root. Stable and nightly CI packages with `--pinned-runtime --require-pathway-runtime`, uses a Contents-read token minted from the existing release GitHub App for `SpiritDevs/pathway-runtime`, and retains signing and notarization. Framework/helper entitlements and website permission usage strings are configured and checked by CI. The user docs describe site information, Security, certificates, Site settings and Clear site data on macOS. `release-smoke.ts` checks manifests, lockfile and version metadata only; it has no Electron-binary assumption to change.

**Still pending:** install the release App on the runtime repository, publish the archive, pin the real darwin-arm64 URL, SHA-256 and Pathway runtime version in the same PR as the release guard, and prove the signed/notarized release and hardware prompts in CI. The native identity reader is implemented in [pathway-runtime PR #2](https://github.com/SpiritDevs/pathway-runtime/pull/2), and an explicit `--user-data-dir` wins over the stamp. The committed pin remains the official Electron ZIP; the release guard deliberately fails until its runtime version matches `^\d+\.\d+\.\d+-pathway\.\d+$` and the real archive is pinned. No app was packaged or launched for the app-side implementation. Development, Windows and Linux remain on stock Electron for this ship scope. See [Desktop runtime pin](../internals/desktop-runtime.md) for setup and the identity contract.

The remaining bullets describe the eventual cross-platform phase:

- Publish versioned runtime archives from `pathway-runtime` CI.
- Pin them in `apps/desktop/pathway-runtime.json`.
- Switch dev launch, desktop packaging and release CI to the pinned runtime.
- Handle signing and notarization for the new framework on each platform, plus crash reporting and symbol upload.
- Keep one switch back to stock Electron for local development only while the runtime matures. Releases never use it.

**Exit:** dev builds, packaged builds and release CI run on the pinned runtime on all three platforms.

## Phase 4: Pathway UI on Chromium

Build Pathway's own UI from the runtime's data, matching the ChatGPT reference screenshots side by side:

- **Site information dropdown** in the address bar: the site and a close button; a connection row opening a Security view; and **Site settings**, opening `chrome://settings/content/siteDetails?site=<origin>` in a new Pathway browser tab.
- **Security view:** back arrow, title and site; the connection status and explanation; and a **Certificate is valid** card that opens the certificate viewer.
- **Certificate viewer:** "Certificate Viewer: <name>", with General and Details tabs. General shows Issued To, Issued By, Validity Period, and SHA-256 fingerprints for the certificate and public key. Details shows the chain and fields.
- **Retire the stopgaps:** the Electron-session `clearSiteData` IPC and the fixed `ALLOWED_PREVIEW_PERMISSIONS` list in `apps/desktop/src/preview/BrowserSession.ts`.

**Exit:** screenshots of each piece beside the ChatGPT app on macOS, plus the same flows working on Windows and Linux.

## Phase 5: release cadence

- Track Electron stable and Chromium security releases, about every four weeks. Each bump is a runtime release followed by a pin update PR in this repository.
- Measure download and install size against stock Electron for every release, and keep a size budget.
- Keep the previous runtime archive pinned and available for rollback.

## Evidence

Each phase's PR records:

- the hosts used;
- build times, warm and cold;
- archive sizes;
- the Electron and Chromium versions;
- screenshots or short recordings of the exit criteria on every platform the phase covers.
