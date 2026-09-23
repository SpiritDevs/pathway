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
- `ComputerManager.make({ backend, stateDir, approvals })` is scope-bound: control consent, the audit log and scroll gearing live under `stateDir` (memory-only without it), and closing the scope disposes the manager instead of calling `dispose()`.
- The manager drives approvals through a `ComputerManagerApprovals` option (`cancelThread`, `revokeTaskGrants`) that `ComputerApprovalGate` satisfies, instead of importing the global `computerApprovalGate`.
- The manager reads time from `Clock` instead of a `now` option, publishes `ComputerEvent`s on a `PubSub` read through `events` instead of `onEvent` listeners, and logs lease lifecycle with `Effect.logInfo`.
- Every manager method that did IO returns an `Effect`, including `actionResult`, the lease/background-control wrappers and targeting; guards and `beforeDispatch`/`foregroundWithRestore` hooks are `Effect`s, and `withUserPointTarget` takes an action returning an `Effect`.
- `withAgentActivity` and `browserCall` take a `DesktopSignal` instead of an `AbortSignal`, and a browser call is cancelled by interruption.
- Launch-window waits stop on interruption, the stream attach/detach chain is a `Deferred` tail, per-thread publishes serialise on a `Semaphore`, and timers are scoped fibers.
- The masked-activation shield label reads "Pathway is activating …" and shield ids come from `Random`.
