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
