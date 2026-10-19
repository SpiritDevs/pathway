# Desktop window startup — 21 September 2026

The reported delay was **before the main window appeared** on an Apple M1. In three isolated launches per version, median process-spawn-to-main-window visibility fell from **9.577 seconds to 3.323 seconds**, a **6.254-second / 65.3% reduction**.

This measures the visible main window displaying the account-loading screen. It does not measure a signed-in dashboard, restored project data, or a usable composer. Backend recovery and required cloud authentication still run before the workspace is usable.

## Cause and change

The desktop's `pathway://app` protocol previously forwarded all requests, including the packaged HTML, scripts, styles, and fonts, through the local backend. Opening the renderer earlier during recovery still required the server's HTTP listener and application layers to finish initializing.

Packaged builds now serve the existing `apps/server/dist/client` assets through Electron's file loader. This retains the custom origin, Clerk bridge, CSP, MIME handling, and packaged ASAR support. See [Electron's protocol handler documentation](https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler) for the file-loader integration.

After the primary backend start publishes its endpoint and bootstrap credential, the desktop opens the renderer without waiting for HTTP readiness. API, OAuth, discovery, and WebSocket paths still reach the backend; data and commands retain the existing recovery gate. Development continues to use the Vite proxy. WSL preflight failures retain the existing splash and fallback flow. Closing and reopening the window during recovery works without marking the backend ready.

Opening before HTTP listen also exposed a bootstrap retry gap: wrapped transport failures were treated as HTTP 500 errors and not retried. Transport failures now retry, and desktop authentication bootstrap uses a bounded 60-second cold-boot budget. Web retains its 15-second budget. Actual HTTP 401, 403, and 500 responses still fail immediately.

## Measurement

Electron 41.5.0, arm64, on this Apple M1 Mac. Builds and checks were idle during the timed runs. No OS restart or filesystem-cache purge was performed. Runs alternated before/after, with a fresh isolated Pathway home and Electron profile each time.

| Run    | Before: main visible | After: main visible |
| ------ | -------------------: | ------------------: |
| 1      |             13.414 s |             3.439 s |
| 2      |              8.570 s |             3.264 s |
| 3      |              9.577 s |             3.323 s |
| Median |          **9.577 s** |         **3.323 s** |

The before build uses desktop source from `8b51fc048fbc755b78340512e1980a227258fd35`. Both variants use the same freshly built server and web assets, including the bootstrap retry fix, so this comparison isolates the desktop loading path. The harness uses packaged-mode path resolution with built artifacts in a directory; it is not a signed or installed release benchmark. Process start includes Electron/module loading. Window visibility is the native `show` event; a second marker confirms the renderer root and two animation frames. Screenshots were captured after those markers, outside the measured visibility interval.

The representative fixture was made with read-only `VACUUM INTO` from the live database. It retained 123,246 events and 287 non-deleted threads. Only the disposable copy was changed: project paths point to empty test repositories, project scripts are cleared, and active runs, provider sessions, and requests are stopped. No queued effects, enabled scheduled tasks, or launch workflows remained. No credentials or settings were copied. This retains history-decoding costs without resuming the user's work. Projection verification passed in all three read-only fixture checks; no recovery candidates remained.

The installed Nightly inspected during diagnosis was `0.0.42-nightly.20260920.163`. Its latest retained trace took approximately 18 seconds from desktop startup to main-window creation, including 1.1 seconds hydrating the shell environment. That historical endpoint starts later and ends earlier than the benchmark above, and is not used to calculate the improvement.

Raw harness, fixture, per-run JSON, logs, and screenshots are retained locally under the temporary `pathway-startup-20260921-4clqj2ov` directory. All six timed app processes exited cleanly through normal desktop shutdown. The installed application was not restarted or modified.

## Verification and scope

- 105 focused desktop protocol, environment, window, backend manager/pool, web bootstrap, and server readiness tests passed. They cover file loading with an unavailable backend, endpoint routing, malformed paths, duplicate window prevention, reopening during recovery, retry limits, and unchanged command gating.
- Desktop and web package type checks, scoped lint, and a production desktop build cover the changed code. The desktop build also builds its web/server dependencies.
- Runtime screenshots confirm the same account-loading UI is displayed in both versions. No production sign-in was automated.
- A separate longer launch reached the backend's normal readiness endpoint (`/.well-known/pathway/environment`, HTTP 200) after showing the window, then exited cleanly. An earlier direct unauthenticated session probe exceeded its harness budget despite successful backend-startup traces; authenticated workspace startup was not verified. These extra validation runs are excluded from the timing table.
- The bundled-asset path applies to packaged macOS, Windows, and Linux desktop builds. Runtime launch measurements cover macOS only. Browser, remote/relay, mobile, provider adapters, and wire contracts retain their existing behavior; the common web bootstrap transport retry also applies to web clients.
- A new desktop release is required to deliver this change. The installed Nightly has not been updated by this work.
