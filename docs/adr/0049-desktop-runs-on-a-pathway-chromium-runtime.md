# Desktop runs on a Pathway Chromium runtime

The desktop app runs on Pathway's own Electron runtime, built inside a full Chromium tree so that Chrome's browser layer is compiled in. This mirrors the ChatGPT/Codex desktop app exactly. Pathway's app code stays an ordinary Electron app. Only the runtime underneath it changes.

Stock Electron includes Chromium's content layer and leaves out its browser layer. The browser layer is where the site information bubble, the certificate viewer, `chrome://settings` and per-site content settings live. Without it, Pathway's local browser cannot offer real site permissions, certificate details or site data management. Rebuilding them on top of stock Electron would only ever cover the small part Electron exposes.

**What Codex does.** We inspected ChatGPT 26.928.40906 on macOS:

- `Codex Framework.framework` is Chromium 154.0.8037.57. It contains Electron's sources (`third_party/electron/shell/...`) and Chrome's browser layer (`BrowserView`, `TabStripModel`, `OmniboxView`, `PageInfoBubble`, `certificate_viewer`).
- The `ChatGPT` executable loads the framework at runtime and calls `ChromeMain`. Every Chromium helper process is a direct child of the app process. There is no separate browser process, no frame streaming and no overlay window.
- Pages render as Electron webview guests (`owl_web_view_guest_delegate`) inside the app's own compositor, so app UI can draw over them.
- The packaged app is a normal Electron app (`app.asar`). `owl-electron-app.json` pins the runtime by name and archive hash (`"runtimeName": "owl"`, `runtimeArchiveSha`).

**Decision.** Pathway does the same, with no exceptions:

1. The runtime is Electron built inside a Chromium checkout with the browser layer linked in, shipped as a prebuilt archive.
2. The desktop app pins that archive by name and hash, and is packaged against it instead of stock Electron.
3. Browser tabs stay webview guests in the app process.
4. Pathway draws its own UI (tabs, address bar, site information, certificate card) from Chromium's real data. Where Pathway has no UI of its own, it opens Chrome's built-in pages, such as `chrome://settings/content/siteDetails`, in a Pathway tab, just as Codex does.
5. The runtime ships on macOS, Windows and Linux, the same platforms as the desktop app. There is no stock Electron fallback in releases once a platform's runtime is ready.
6. Every line of the runtime is Pathway's own code, built on the public Electron and Chromium sources. OpenAI's patches are private. We match their architecture and packaging, not their code, and nothing is copied out of the ChatGPT bundle.
7. Each runtime starts from the latest stable Electron and its Chromium, and tracks them from then on.

**Consequences.**

- Pathway owns a Chromium build on three platforms: build machines, CI, signing, notarization, and rebasing on every Electron and Chromium release. Chromium security releases ship about every four weeks. macOS builds run on a dedicated build Mac. Windows and Linux need their own build hosts, because Electron builds each platform natively.
- The desktop download grows. Codex's framework alone is 362 MB.
- Web and mobile do not change. Their browser is still the remote browser on the environment.
- Electron-only workarounds in the local browser are retired once the runtime lands, for example the Electron-session `clearSiteData` call.
