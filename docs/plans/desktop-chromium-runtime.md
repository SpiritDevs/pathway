# Desktop Chromium runtime plan

This plan builds the runtime described in [ADR 0049](../adr/0049-desktop-runs-on-a-pathway-chromium-runtime.md): Electron built inside a full Chromium tree with Chrome's browser layer linked in, shipped as a pinned archive. It mirrors the ChatGPT/Codex "owl" runtime. Read the ADR first. This file covers decisions, layout, order, exit criteria and evidence. Each phase ends with something that runs.

## Decisions

Corey, 2026-10-03:

- **Platforms:** macOS, Windows and Linux. Every platform the desktop app targets moves to the runtime. None stays on stock Electron in releases.
- **Build host:** a dedicated build Mac for macOS. Windows and Linux get their own native build hosts, because Electron builds each platform on that platform.
- **Version:** start from the latest stable Electron and the Chromium it pins. Record both in Phase 1.
- **Code:** all of it is Pathway's own, written against the public Electron and Chromium sources. The ChatGPT bundle is an architecture reference only. Nothing is copied, decompiled or linked from it.
- **Stopgap:** the stock-Electron site information dropdown and Clear site data shipped in `251ab4f8ce`. Phase 4 replaces them.

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

- `apps/desktop/pathway-runtime.json` pins `runtimeName: "pathway"`, the runtime version, and per-platform and per-architecture archive URLs with their SHA-256 hashes.
- `scripts/build-desktop-artifact.ts` packages the app against the pinned archive instead of the npm `electron` binary. `vp run dev` launches the pinned runtime too.
- `.github/workflows/release.yml` gains Windows and Linux jobs. Today it packages only macOS arm64, on the self-hosted `fleet-macos-arm64` runners.

## Runtime interface

What `apps/desktop` sees:

- **Unchanged.** Every Electron API Pathway uses today keeps working, so the app runs on the runtime with no code changes until Phase 4.
- **Chrome's browser layer.** `chrome://` WebUI pages, such as `chrome://settings/content/siteDetails`, load in Pathway's webview guests. Per-site content settings and site data apply to the preview partitions (`persist:pathway-preview-*`).
- **A `pathway` main-process module** (names are settled in the Phase 2 ADR):
  - `siteInfo(webContents)`: origin, security state, connection summary, the certificate chain (PEM plus parsed fields), and cookie and storage usage.
  - `contentSettings.get` / `set` / `reset` for an origin in a partition.
  - `clearSiteData(partition, origin)` through Chrome's browsing-data remover.

How preview partitions map onto Chrome profiles is the main design question in Phase 2.

## Phase 0: build hosts and CI

- **macOS:** commission the dedicated build Mac as a self-hosted runner, for example with label `pathway-runtime-macos`.
- **Windows and Linux:** add native build hosts with the same shape.
- Every host needs:
  - well over 100 GB free per checkout, ideally 300 GB+ for several checkouts and caches;
  - 32 GB+ RAM, and as many cores as possible.
- Set up Electron's `build-tools` with a shared remote compile cache from day one. Rebuilds without a cache are not workable.

**Exit:** each host can `gclient sync` an Electron checkout and complete a cached rebuild.

## Phase 1: stock Electron from source, all platforms

- Check out the latest stable Electron and its pinned Chromium. Record both versions in this file.
- Build release archives for macOS (arm64 and x64), Windows (x64 and arm64) and Linux (x64 and arm64) with no changes.
- Package Pathway desktop against them through `pathway-runtime.json`. Run the desktop tests and launch the app on each platform.
- If moving to the latest Electron needs app changes, upgrade the npm `electron` dependency in its own PR first.

**Exit:** Pathway desktop runs unchanged on a self-built Electron on all three platforms. This proves toolchains, signing and packaging before any Chromium changes.

## Phase 2: link Chrome's browser layer

This is the unknown. Make Electron live inside Chrome's startup path, as Codex does: the app executable calls `ChromeMain`, with Electron's shell compiled in rather than replacing Chrome's browser main parts.

- Do macOS first, then Windows and Linux.
- Spike the integration points:
  - browser main parts;
  - profiles, and how preview partitions map to them;
  - how webview guests attach to a Chrome profile;
  - which Chrome UI stays suppressed so Pathway's own UI can replace it.
- Timebox the spike. Write what worked as ADR 0050 before building further.

**Exit:**

- a Pathway webview guest loads `chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.google.com` and changes there take effect;
- `siteInfo` returns a real certificate chain;
- the existing app works unchanged.

## Phase 3: runtime packaging

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
