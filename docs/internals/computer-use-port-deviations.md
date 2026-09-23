# Computer Use port deviations

Pathway ports Synara's Computer Use literally (see `docs/plans/computer-use-port.md`). Each line
records one intentional deviation: the Synara behaviour or test, what Pathway does instead, and why.

## P0 foundations

- `CUA_HOST_SOCKET_ENV` is now `PATHWAY_CUA_HOST_SOCKET`, not `SYNARA_CUA_HOST_SOCKET`. This is a product rename. The driver's `synara_native_revision` handshake field keeps its name, because the pinned native patch (`patchSha256` in `cuaDriverRelease.json`) emits it.
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
- The Cua driver's signing identifier is `com.spiritdevs.pathway.cua.driver`.
- `cuaDriverRelease.json` is exported from `@spiritdevs/shared` as a subpath so scripts can import it directly.
- The `provision-cua` action drops Synara's Xcode 16.4 pin (the self-hosted fleet runner owns Xcode and the cache key fingerprints it) and its benchmark step, adds a `targets` input, and scopes `RUSTUP_TOOLCHAIN`/strip overrides to its own steps so other Rust builds keep stable.
- `cua-cache-key` prints the key through `Effect.log`; CI reads it from `GITHUB_OUTPUT`, never stdout.
- The release build job timeout rises from 30 to 45 minutes to absorb a cold Cua build.
- The Swift helper lives in `native/pathway-helper/` as `pathway-helper`, not `apps/desktop/native/appsnap/` as `synara-appsnap-helper`; `AppSnap*` Swift identifiers become `PathwayHelper*`, and queue labels use `com.spiritdevs.pathway.*`.
- The helper drops watch mode and its pieces (OptionChordMonitor, CaptureFeedback, ExternalTriggerListener, WindowCapture, and the `triggered`/`captured`/`windows` events); `--watch`, `--output-dir`, `--excluded-bundle-id` and `--external-trigger` are now unknown arguments.
- The helper links without AVFoundation, which only the dropped capture feedback used.
- The helper embeds an `Info.plist` so its signing identifier stays `com.spiritdevs.pathway.helper` through electron-builder's re-sign; Synara's identifier follows the binary's LC_UUID.
- `build-pathway-helper` is Effect TypeScript under `scripts/`, stages to `apps/desktop/.electron-runtime/pathway-helper/pathway-helper`, and runs the native tests with `--native-tests`.
