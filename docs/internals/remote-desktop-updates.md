# Remote desktop updates

Desktop-managed environments update through their supervising Electron app. The server advertises `desktopAppUpdate` when it has a desktop telemetry control descriptor. Older hosts retain local-update instructions. Foreground and background-service update behavior is unchanged.

## Handoff

1. The client calls `server.updateServerWithProgress`, or the unary update RPC for hosts without progress support.
2. `DesktopAppUpdate` subscribes to update reports before sending `requestDesktopUpdate` through the inherited control pipe.
3. `DesktopRemoteUpdates` drives the existing desktop updater on its configured release channel. A completed download produces a preparation token bound to the downloaded version, with a five-minute expiry.
4. The server returns that token and version while it is still connected. The requested client version does not select the desktop artifact; the desktop update feed does.
5. After receiving the preparation result, the client arms its reconnect observer and calls `server.commitDesktopUpdate` with the same token. Both preparation and commit require orchestration operation access.
6. Desktop validates the token and downloaded version, stops its backend pool, and invokes Electron installation. Windows close only when Electron emits its updater-controlled quit event.
7. The client retains the token through the reconnect and only completes after lifecycle readiness reports the prepared version. Commit retries are bounded and reuse that token.

## Checking without updating

`server.checkForUpdate` reports the running version, any newer version, and that release's notes without changing anything. It needs only orchestration read access.

- Desktop-managed servers send `checkDesktopUpdate` through the control pipe. `DesktopRemoteUpdates` runs one updater check, joining a check already in flight, and answers with a single status report carrying the request id and no outcome. A disabled updater or failed check is an error, not "up to date".
- Other servers compare the npm `latest` tag of `@spiritdevs/pathway` with their own version and read notes from the matching GitHub release. Missing notes are not an error.

Both paths reduce notes with `@spiritdevs/shared/releaseNotes`.

## Recovery and ownership

Local and remote updater actions share one reservation. Duplicate commits cannot start a second install; a matching active install can be joined. Installation failures retain the reservation until backend restart attempts finish and preserve a failure report for reconnecting clients. Cancelling preparation does not cancel an install that has already committed.

A fresh preparation request reclaims an uncommitted download and invalidates its previous token. This lets clients recover immediately when a preparation response is lost; late commits or cancellation from the old request cannot affect its replacement. An installation that has already committed cannot be reclaimed.

The telemetry receiver is shared with resource monitoring. Creating another receiver for the update service would introduce competing readers on the same descriptor. Update progress travels over the existing authenticated environment connection, including Pathway Connect; it does not require a new public endpoint.

The shared client runtime owns operation state independently of the composer component. Chat and Connections render that state, including failure and retry. Native iOS checks and updates from the environment settings Version group. It treats a transport loss during `server.commitDesktopUpdate` as the handoff, then confirms the target version with `server.getConfig`.

## Validation

Focused tests cover desktop updater admission and recovery, server request correlation and authorization, inherited-pipe framing, and client commit/reconnect behavior. The pipe test uses real server services with simulated desktop reports; it does not install an application. Packaged macOS verification must separately exercise download, native installation, relaunch, and remote reconnection before claiming that entire flow has been verified.

## Sources

- Desktop coordinator: `apps/desktop/src/updates/DesktopRemoteUpdates.ts`
- Updater admission and recovery: `apps/desktop/src/updates/DesktopUpdates.ts`
- Server adapter: `apps/server/src/desktopUpdate/DesktopAppUpdate.ts`
- Client operation: `packages/client-runtime/src/state/server.ts`
- iOS check and update: `apps/pathway-ios/Pathway/shared/datalayer/PathwayEnvironmentUpdateModel.swift`
- Composer and Connections action: `apps/web/src/components/ServerUpdateAction.tsx`
