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
