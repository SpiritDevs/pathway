# Computer Use port deviations

Pathway ports Synara's Computer Use literally (see `docs/plans/computer-use-port.md`). Each line
records one intentional deviation: the Synara behaviour or test, what Pathway does instead, and why.

## P0 foundations

- `CUA_HOST_SOCKET_ENV` is now `PATHWAY_CUA_HOST_SOCKET`, not `SYNARA_CUA_HOST_SOCKET`. This is a product rename. The driver's `synara_native_revision` handshake field keeps its name, because the pinned native patch (`patchSha256` in `cuaDriverRelease.json`) emits it.
- `CuaTransportError` declares `effect` as a field, not a constructor parameter property. Pathway's `erasableSyntaxOnly` rejects parameter properties.
- The `cuaDriverProtocol` test points to the tool-classification matrix in `.repos/synara/docs/computer-use-cua/`. Pathway does not port that doc.
- `computerAudit.test` drops the `ServerReadThreadDiagnosticsInput` case. Pathway has no thread diagnostics RPC to decode.
- `ComputerAuditEntry.gatewayRequestId` is now `mcpRequestId`. Pathway exposes Computer through its MCP toolkit, not an agent gateway.
- Computer RPCs fail with a `ComputerError | EnvironmentAuthorizationError` union, not Synara's `WsRpcError`. Pathway has no shared RPC error, and scope checks raise `EnvironmentAuthorizationError`.
- `WsComputerRpcGroup` stays outside `WsRpcGroup` until P4 adds the server handlers and `RpcAuthorization` entries. Merging it earlier would require handlers that do not exist yet.
- The `WsPushComputerEvent` push channel is not ported. Pathway has no push channels, so `computer.subscribeEvents` is a stream RPC. `COMPUTER_WS_CHANNELS` is kept literally for parity.
- `ComputerControlMode` and `ComputerError` live in `computer.ts`, not `orchestration.ts`. This keeps Computer contracts self-contained.
- The `COMPUTER_PERMISSION_KINDS` AppSnap alias is dropped. `missingComputerAppSnapPermissions` is now `missingComputerHelperPermissions` with a local `ComputerHelperGrants` type. AppSnap is not ported, because SnapShot covers it.
- `SYNARA_DESKTOP_BUNDLE_ID_ENV` is now `PATHWAY_DESKTOP_BUNDLE_ID_ENV`, and the test bundle ids use `com.spiritdevs.pathway`. This is a product rename.
- The `frameTransport` and `computerFrame` tests use a local device-codec fixture instead of Synara's `deviceFrame` module. Device mirroring is not part of the port.
- The `computerBrowser` comments name `previewAutomation` and the Pathway preview browser, not `browserAutomation`. Pathway's in-app browser is the preview.
- The release-hotkey comment in `computer.ts` no longer cites the KWin and Hyprland plugin source paths. Those files are not vendored in Pathway.
- The `computer:operate` scope is a Pathway addition. It is part of the standard scopes, admins inherit it, and the pairing sheet offers it as "Use Computer". Pathway gates Computer on paired-client scopes, which Synara lacks.
- `ServerSettings.computer.accessPolicy` (`any-operator | scoped | admins-only`, default `scoped`) is a Pathway addition for multi-operator environments. It stays environment-local and never syncs through Pathway Cloud.
- `ServerSettings.computer.autonomy` (`supervised | per-task | auto | full-access`, default `per-task`) and `resolveComputerAutonomy` are Pathway additions. The stricter of the thread's runtime mode and the ceiling wins. The `supervised` level is new; it maps from `approval-required`.
- The OAuth token endpoint now derives its allowed scopes from `AuthEnvironmentScope` instead of a hardcoded list. Without this, `computer:operate` would have been rejected with `invalid_scope`.
- `computer:operate` is optional during token exchange. The server drops it when the pairing grant lacks it, rather than failing with `scope_not_granted`, so pairings from before the upgrade, or created without "Use Computer", still redeem. Those sessions cannot start Computer tasks under the `scoped` policy.
- Servers advertise the `computerOperateScope` descriptor capability. Clients request `computer:operate` only when it is advertised (`requestableEnvironmentScopes`), because older servers reject the whole token request with `invalid_scope`.

## P3 desktop host

- The desktop Computer modules live in `apps/desktop/src/computer/` with Pathway's PascalCase file names (`CuaDriverHost.ts`, not `cuaDriverHost.ts`). This follows the desktop app's layout.
- The Cua runtime directories, their ownership marker and its schema are `pathway-cua-XXXXXX`, `.pathway-cua-runtime.json` and `pathway-cua-runtime`, not `synara-cua-*`. This is a product rename. Runtime directories left behind by Synara are not swept.
- `markCuaRuntimeDirectory` and `sweepOwnedCuaRuntimeDirectories` are Effects that read time from `Clock`, and the marker is encoded and decoded with Schema. The ownership checks are unchanged. The sweep's `now` option is dropped, because tests control time through `Clock`.
- `clearStaleCuaHostSocket` reads the platform from `HostProcessPlatform` and takes its filesystem and socket calls as an injectable `CuaHostSocketIo`. Synara's tests used `vi.mock` of `node:fs/promises` and `node:net` for the same seams. The 1s probe timeout runs on the Effect clock.
- `clearStaleCuaHostSocket` fails with a typed `CuaHostSocketError` (reason `live-listener | inconclusive | changed | non-socket | foreign`), or with `CuaHostSocketIoError` carrying the original Node error. Synara threw plain `Error`s. The messages are unchanged.
- `ComputerBinaries.ts` resolves `pathway-helper` and `cua-driver` in one place. Packaged apps use `Resources/pathway-helper/pathway-helper` and `Resources/cua-driver/cua-driver`; development uses P1's output under `apps/desktop/.electron-runtime/`. Synara resolved the AppSnap helper and driver separately in `main.ts`.
- `PathwayHelperProtocol.ts` keeps only the Computer messages of Synara's `parseAppSnapHelperMessage`. `triggered`, `captured` and `windows` are dropped with AppSnap capture, and JSON is decoded with Schema.
- The parser now accepts `release-held-input` replies. Synara's parser dropped them, so `releaseHeldInput` always resolved false. Synara ignored the result, so the fix changes nothing that users see.
- Native helpers run through `HelperProcess.ts` over `effect/unstable/process`, with `detached: false` to keep macOS TCC responsibility. stdin is a queue whose end is EOF, and stdout and stderr are read as lines on a supervisor fiber. Synara spawned each helper with `node:child_process` and `readline`.
- `stopHelper` ports `stopNativeHelper`: SIGTERM, SIGKILL after 1s, then a typed `HelperStopError` after another 1s. Timing runs on the Effect clock.
- AppSnap screenshot, window capture, watch and the Option-chord shortcut are not ported. Only the helper's Computer duties remain: permissions, the guide, held-input release, the Escape monitor, the shield and the frame tap. SnapShot already covers capture.
- `CuaDriverHost` replies carry the bare error message, without Synara's thrown-`Error` wrapping. The reply shapes and `effect` markers are unchanged.
- `CuaDriverHost` translates Synara's promise chains into detached Effect tasks that memoize their exit. Injected surfaces (`checkPermissions`, `setup`, `releaseHeldInput`, `inputMonitorState`, `activateInputMonitor`) are Effects, not promise-returning functions.
- `warmOnFirstTouch` is a host option, not a read of `SYNARA_CUA_WARM_ON_FIRST_TOUCH` inside the host. The desktop layer reads `PATHWAY_CUA_WARM_ON_FIRST_TOUCH`. The warm-up `it.each` over `"0"`/`"off"` becomes the absent and `false` option cases.
- `linuxAdmission` is an injectable host option. The Linux admission rules and their 11 Linux `describe` cases move to P8 with the other `linux*` files.
- The host spawns `cua-driver` through `HelperProcess`, not `node:child_process`.
- The host tests run on the fixture driver's push event channel, a skewable clock, captured logs and `waitForLog` barriers, split into one file per Synara `describe`. Synara polled with sleeps and spied on `console`.
- Synara's sleeps in the host tests become barriers: Escape cooldowns advance the clock, warm-up waits on `host.stop`, and the UTF-8 chunking case waits on a probe reply. One warm-up "no motion yet" check is weaker, because no barrier can prove an absence.
- The retirement and Escape tests send through a raw `cuaRequest` so replies keep their `effect` marker. A test that needs a request without a capability passes `capability: undefined` instead of writing raw bytes to the socket.
- Two host test requests (`get_screen_size` in retirement, the unconfirmed-crash `type_text` in Escape) wait 5s instead of 1s–2s. Real driver spawn exceeds the shorter bound when all eight host suites run in parallel.
- `ensureSpawned` caches the startup task only while it is still running. A startup that settles synchronously used to leave the finished task cached, so every later call reused a retired generation and got "Cancelled before dispatch". Synara's promise timing hid this bug.
- The standalone host and the desktop both use one capability, `PATHWAY_CUA_HOST_CAPABILITY`. Synara had a separate browser-host capability variable.
- The standalone host runs with `node` and `NodeRuntime.runMain`. A failed dispose on shutdown is logged, not turned into exit code 1.
- `EscapeKillSwitchMonitor`, `ComputerShield`, `ComputerFrameTap` and `ComputerHelper` are torn down by closing their scope, in addition to an explicit `dispose`.
- `EscapeKillSwitchMonitor` drops Synara's late-stdout-after-dispose case. The scope-owned reader stops before dispose returns, so the case cannot occur.
- `ComputerShield` no longer keeps a stale spawning promise after a failed spawn, so the next engage respawns. It also drops the `engageTimeoutMs` test seam, because the Effect clock controls time.
- `ComputerShield.stop` and `dispose` wait for a spawn still in flight. The late helper is stopped and its engage fails as `stopped`. Synara cleared the pending spawn without awaiting it, so a helper that landed after teardown could engage a shield and stay alive.
- `ComputerFrameTap` reports an unexpected helper exit through `onError` and marks the tap dead synchronously. It keys tasks with `cuaComputerTaskKey`. The renderer channel stays `computerPreview.frame` until P6 names the preload bridge.
- `ComputerDesktopLifecycle` takes a narrow power-monitor interface. `ElectronPowerMonitor.onSimpleEvent` gains `user-did-resign-active` and `user-did-become-active`.
- `ComputerEmergencyStopNotice` posts through `HttpClient` with an injected `{ httpBaseUrl, bearerToken }` endpoint, not Synara's shutdown token. A missing credential is retried like a failed post, and `[::1]` counts as loopback.
- `ComputerHelper` reports status as `unsupported | ready | error`, without AppSnap's capture states. `helperPath` is an `Option`, `helperSettingsPaneUrl` lives in the module, `onError` loses its `focusApp` flag, and the guide and cache timers run on the Effect clock.
- The desktop turns Computer on only on macOS and only with `PATHWAY_COMPUTER_USE=1`. Everywhere else `DesktopComputer` is an inert `Context.Reference` default, and backends start exactly as before. Synara always started the host on macOS.
- The host capability reaches the backend as `cuaHostCapability` in the desktop bootstrap envelope, not over Synara's inherited fd pipe. `PATHWAY_CUA_HOST_SOCKET` is set in the backend env only while a host listens, and an inherited value is scrubbed otherwise.
- The pool resumes the host in the primary's `configResolve` and suspends it in `onShutdown`. Synara resumed after spawn and suspended before stop from `main.ts`. `onShutdown` runs before the stop kills the process, so the order is the same.
- The host's `bundleId` is the desktop `appUserModelId` (`com.spiritdevs.pathway`, `.dev` in development), and the app bundle for setup comes from the reused `macPermissionAppBundle` in `snapShot/MacPermissionSetup.ts`.
- `MODEL_SCREEN_IMAGE_MAX_DIMENSION` (1536) is a local constant of `DesktopComputerHost.ts`. Pathway's shared package has no `modelImageBudget` module yet. `normalizeOverview` returns a new result instead of mutating the image part.
- The frame tap is ported and tested but not wired into the live host until P6 adds the renderer consumer. Sending JPEG frames to a renderer that drops them only costs IPC bandwidth.
- The Escape monitor stops local input but does not yet post the backend emergency-stop notice. P4 adds the `/api/desktop/computer/emergency-stop` route and forks `notifyBackendComputerEmergencyStop` from `onEscape`.
- The agent cursor style preference and its `desktop:computer-set-cursor-style` IPC are not wired, so the driver keeps its stock cursor. P6 adds the preference with the renderer control.
- The Computer parts of `appSnapIpc` (helper state, permission request and setup, the settings pane, the guide, and the state, error and guide pushes) are left to P6. The preload bridge and its contracts are renderer surfaces, and handlers without them are unreachable. The host drives setup itself through `startPermissionSetup`.
- `cuaFixtures/focusProbe` is ported. `electron`, `native`, `gateway`, `cancellation` and `live` wait for P4, because they drive `CuaComputerBackend`, `DesktopOperationQueue`, the agent gateway tools and `pngHeader` from the server.
- focusProbe runs on `spawnHelper`/`stopHelper` inside the caller's Scope, so closing the scope kills a probe that was never finished. `finish` is an Effect. When the binary is missing it returns `Option.none()`. A failed spawn is a typed `HelperSpawnError`, where Synara returned an empty report.
- focusProbe's 5s finish grace runs on the Effect clock. After it, `stopHelper` sends SIGTERM, then SIGKILL, and then fails; Synara sent SIGTERM and then waited with no limit. Stderr is capped at exactly 16,384 characters.
- focusProbe line parsing reuses `decodeHelperJsonLine`, and the baseline and analyzer drop the `as never`/`!` casts. The results are unchanged.
- `resolveFocusProbePath` moves Synara's electron.ts override into the module as `PATHWAY_CUA_FOCUS_PROBE`, falling back to `<resourcesPath>/focus-probe`. Pathway has no build step for `focus_probe.m` yet.
