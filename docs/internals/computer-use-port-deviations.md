# Computer Use port deviations

Pathway ports Synara's Computer Use literally (see `docs/plans/computer-use-port.md`). Each line
records one intentional deviation: the Synara behaviour or test, what Pathway does instead, and why.

## P0 foundations

- `CUA_HOST_SOCKET_ENV` is now `PATHWAY_CUA_HOST_SOCKET`, not `SYNARA_CUA_HOST_SOCKET`. This is a product rename. The driver's handshake field is `pathway_native_revision`, matching the renamed native patches (see P1).
- `cuaRequest` returns an `Effect<T, CuaTransportError>`, not a Promise. `CuaTransportError` is a `Schema.TaggedErrorClass` with `message` and `effect` fields. The socket is scoped, so a timeout or interruption always closes it, and the timeout runs on the Effect clock. Framing, the byte budgets and the delivery verdicts are unchanged (ADR 0045).
- `cuaRequest` takes a `cancel` effect instead of an `AbortSignal`. When it completes, the call fails with a typed verdict. A call cancelled before it connects reports `Cancelled before dispatch.`; Synara used the "input already dispatched" message whenever the abort came after the call started.
- `FrameTransport.subscribe` returns a scoped `Effect` that removes the subscriber when its scope closes, instead of an unsubscribe function. Only server code subscribes, so no non-Effect adapter is needed.
- The `cuaDriverProtocol` test points to the tool-classification matrix in `.repos/synara/docs/computer-use-cua/`. Pathway does not port that doc.
- `computerAudit.test` drops the `ServerReadThreadDiagnosticsInput` case. Pathway has no thread diagnostics RPC to decode.
- `ComputerAuditEntry.gatewayRequestId` is now `mcpRequestId`. Pathway exposes Computer through its MCP toolkit, not an agent gateway.
- Computer RPCs fail with a `ComputerError | EnvironmentAuthorizationError` union, not Synara's `WsRpcError`. Pathway has no shared RPC error, and scope checks raise `EnvironmentAuthorizationError`.
- `WsComputerRpcGroup` stays outside `WsRpcGroup` until P4 adds the server handlers and `RpcAuthorization` entries. Merging it earlier would require handlers that do not exist yet.
- The `WsPushComputerEvent` push channel is not ported. Pathway has no push channels, so `computer.subscribeEvents` is a stream RPC. `COMPUTER_WS_CHANNELS` is kept literally for parity.
- `ComputerControlMode` lives in `computer.ts`, not `orchestration.ts`. This keeps Computer contracts self-contained.
- `ComputerError` is a Pathway type in `computer.ts`. Synara has none; it is a Computer-scoped copy of Synara's generic `WsRpcError` with the same fields.
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
- Peer environments request the standard scopes without `computer:operate`, even from targets that advertise it. A peer never drives another desktop; cross-environment work runs as an agent on the host, whose Computer calls stay local.

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
- The cua flavor ignores `PATHWAY_HOME` and always uses `~/.pathway-cua`, both in `DesktopEnvironment` and in the early Linux settings lookup, and pins that home as the backend's `PATHWAY_HOME`. Recognising every alias of the production home (relative paths, symlinks, case and separator variants) proved unreliable, and the flavor is packaged-only, so it has no dev override to preserve. Synara lets `SYNARA_HOME` outrank the flavor.
- Signed cua builds sign as `com.spiritdevs.pathway.cua` with the keychain group `<TEAM_ID>.com.spiritdevs.pathway.cua.webauthn` and require `PATHWAY_MACOS_CUA_PROVISIONING_PROFILE`, with no fallback to production's profile; the app accepts only the WebAuthn group matching its packaged flavor.
- There is no runtime flavor override (Synara's `requestedFlavor`, source-build marker and smoke user-data override); only a packaged artifact can be the cua flavor.
- The cua flavor publishes no update feed (`publish: null`), so the updater reports updates as unavailable rather than using Synara's scripted updates.
- `build-desktop-artifact --flavor cua` (or `PATHWAY_DESKTOP_FLAVOR`) writes to `release-cua`, overriding `--mock-updates`' `release-mock`; Windows refuses isolated flavors at option resolution and in `createBuildConfig`.
- The desktop renderer scheme now comes from `DesktopEnvironment.desktopScheme` rather than `getDesktopScheme(isDevelopment)`, and the server trusts the `pathway-cua://app` renderer origin.
- Before cua builds can sign in with OAuth, the Clerk instance's allowed redirect origins need `pathway-cua://app`; this is instance configuration, not repository code.
- Host code must use the renamed Cua wire keys (`pathway_native_revision`, `pathway_browser_input_control`, `_pathway_foreground_observation_ms`, `PATHWAY_CUA_*_OBSERVATION_MS`, …); Synara's `synara_*` names are not accepted.

## P2 server core

- Computer errors are `Schema.TaggedErrorClass`es in `computer/computerErrors.ts`. `ComputerLeaseError`, `CuaActionError`, `ComputerSpaceError`, and `ComputerDenylistError` subclass them and keep the parent's `_tag` and `name`, so `Effect.catchTag("ComputerBackendError")` still catches a lease refusal. Synara gave each subclass its own `name`.
- `ComputerBackend` methods return `Effect`s that fail with `ComputerOperationError`. `onEvent` is an optional `events` stream, `attachStream`/`detachStream` take no listener, and `ComputerBrowserCall` drops `signal`: cancellation is fiber interruption.
- `assertComputerClipboardWriteFits` is `computerClipboardWriteError`, which returns the error instead of throwing it.
- The desktop operation, delivery-mode, and task contexts are `Context.Reference`s instead of `AsyncLocalStorage`. A cancellation signal is a set of `Deferred`s rather than an `AbortSignal`, and every signal carries a reason.
- Aborting a desktop operation interrupts it and fails it with the abort reason. Synara relied on cooperative `throwIfAborted` checks, so its queue tests that let an operation ignore a close now expect the operation to fail with "closed".
- `DesktopOperationQueue` orders work with one FIFO and a conflict rule (exclusive conflicts with everything, scoped with its own key) instead of promise chains. An operation cancelled while waiting leaves the queue at once instead of holding its place until its turn.
- `modelImageBudget` and `uiTreeTargeting` are new `@spiritdevs/shared` subpath exports, copied verbatim.
- `ComputerApprovalGate` is a service that posts cards through a `ComputerApprovalRequester` service instead of taking a `publish` callback per call, and the per-call `signal` is fiber interruption.
- An approval wait is bounded (45 s) and returns `"pending"` instead of blocking until the user answers or the 5-minute timeout. The card stays open, and a late answer applies to the next call with the same `callKey` (per-call approvals) or to the rest of the turn (task and app grants). Synara waited the full timeout.
- A shared task card is cancelled only by the gate (Stop, turn change, timeout), never by one waiter leaving. In Synara, aborting the call that opened it cancelled it for every waiter.
- A task card that times out leaves no standing decline, so the next call asks again. Synara recorded the timeout as a decline for the rest of the turn.
- The gate adds per-app grants (`requestApp`) and `computerApprovalPolicy`, which maps a resolved autonomy level to the approvals ADR 0043 asks for. Synara had only task and per-call consent.
- The server `uiTreeTargeting` resolvers (point, semantic, unique text, window) return `Effect`s that fail with `ComputerTargetError` instead of throwing. `resolveComputerWindowTarget` succeeds with `undefined` when the window is not in the tree.
- `screenshotFrames` resolution and point/rect mapping return `Effect`s that fail with `ComputerTargetError`. The registry itself stays a synchronous class.
- `computerDenylist` matches executable paths with a pure last-segment helper instead of `node:path`, so Windows backslash paths are not split.
- `waitForControl` takes a `read` effect instead of an async function and an `AbortSignal`. Cancelling it is interrupting it, and elapsed time comes from `Clock`.
- `UnavailableComputerBackend` takes its failure time as epoch millis, and `makeUnavailableComputerBackend` reads it from `Clock`. It has no `events` stream because nothing ever changes.
- `waitForWindow` takes a `read` effect and optional `checkInputReady` effect; Stop is fiber interruption instead of an `AbortSignal`, and the 2 s budget interrupts a hung probe directly, so Synara's `withDesktopOperationSignal` wrapper is gone.
- `computerGeometry` (`requireWindowBounds`, `readPngDimensions`, `screenshotFromPng`) returns `Effect`s failing with `ComputerBackendError` instead of throwing; `WindowListChangeNotifier` emits and observes through `Effect`s, and the unused identity `unwrapDbusValue` is dropped.
- `scrollCalibration.decodePngLuma` is an `Effect` whose concurrent same-bytes callers share one detached decode (replacing the promise cache); rows yield with `Effect.yieldNow`, and the yield test now measures `unfilterToLuma` directly because Synara's passed without the yields.
- `ScrollGearingFile.load(directory)` takes the state directory (fixed file name `computer-scroll-gearing.json`, memory-only without one), decodes with Schema, writes serially via temp-file rename through Effect `FileSystem`, and `learn` returns an `Effect` that callers fork when they must not wait.
- `makeCursorActivity(publish)` is scope-bound and cleans up on scope close; its methods return `Effect`s and `during` wraps an `Effect` instead of a callback.
- Cua tuning env vars are renamed `PATHWAY_CUA_*` (TIMING_LOG, CONDITIONAL_SETTLE, ACTION_SETTLE_MS, CAPTURE_REUSE, PREVIEW_STILL_MS, MASKED_ACTIVATION, MASKED_APPS).
- `computerCallContext` and `modelDesktopObservation` replace AsyncLocalStorage with a `Context.Reference`; authority ends in `Effect.ensuring`, so a detached continuation loses it, and timing uses `Clock` and `Effect.logInfo` and records a failed leg's duration too.
- `ComputerEventInterests.subscribe(connectionKey, events)` filters a `Stream` instead of registering listeners, and takes an `onConnectionClose` hook in place of `wsConnectionSessions`.
- `computerVisibleUse` and `computerSpaceDesignation` read a local `ComputerVisibleUseMessage` type because `OrchestrationMessage` has no provenance fields (source, dispatchOrigin, asyncUserInput, skills, mentions); a message without `source` counts as native.
- `PATHWAY_DESKTOP_BUNDLE_ID_ENV` lives in `@spiritdevs/shared/computerGrants`; Synara's `desktopIdentity` flavor module is not ported in P2. Setup copy says "Pathway" and `npx @spiritdevs/pathway`, and backend errors are matched with `Schema.is` instead of `instanceof`.
- `makeStillFramePublisher` is a scope-bound factory whose loop is a forked fiber swapped in with the generation check; frames leave only through `emit`, `detach` interrupts an in-flight capture, and the follow-up publish owed to a deferred force runs in sequence rather than fire-and-forget.
- `makeComputerControlState(stateDir)` joins `computer-control.json` itself, serialises every write behind one semaphore instead of per-thread and global chains, decodes the file with Schema (unknown fields drop on the next save), and fails writes with `ComputerControlStateError`.
- The audit file reader cannot pass `O_NOFOLLOW`/`O_NONBLOCK` through Effect `FileSystem`; it refuses links with `readLink` before and after opening and checks the opened file's device and inode against the path.
- Audit entries carry `mcpRequestId` (was `gatewayRequestId`); `makeComputerAuditLog` is a scoped queue drained by one worker fiber, `record` never fails, timestamps come from `DateTime.now`, and closing the scope writes whatever is queued.
- `makeComputerSpaceBroker` is a factory whose `assert*` guards, `readSnapshot`, `assertActive` and `recheckDesignation` are `Effect`s, and `cuaSpaceInventory` fails with `ComputerSpaceError` instead of throwing.
- `FakeComputerBackend` methods return `Effect`s failing with `ComputerOperationError`; `onEvent` and the `attachStream` listener become one `events` stream (frames included) that `dispose` ends, hooks (`browser`, `waitForSettle`, `shield`) return `Effect`s, `emitFrame` is an `Effect` reading `Clock`, and `failNext`/`refuseMenuPath` take typed errors.
