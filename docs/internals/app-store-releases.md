# App Store releases and Organizer backend

COR-106 and COR-107 add backend contracts and services on top of COR-100 Apple account custody and COR-101 managed Xcode. There is no client UI in this change. Use `@spiritdevs/contracts/releases` and `api.appleReleases`. All environment operations use the existing authenticated WebSocket route, including remote, relay and tunnel connections. Paths and Xcode processes always belong to the selected environment.

## Client integration

Use the same app target from Settings / Apple, the command palette and the project Releases view: `{ companyId, accountId, teamId, appId }`. Resolve a project's cloud app link with `api.appleIntegrations.projectLink`. That link is metadata, not permission to use the Apple account. The same contracts let mobile display release status without host-specific APIs.

| Environment RPC        | Input in addition to target                    | Result                                                                                         |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `releases.archive`     | `projectPath`, `scheme`, `version`, `platform` | Accepted `ReleaseJob`; archives and exports in a shared environment worker                     |
| `releases.localStatus` | None                                           | Environment ID/label, local archives and retained jobs for this exact app/account/company/team |
| `releases.subscribe`   | None                                           | `ReleaseUpdate` stream with `local` and `organizer` variants                                   |
| `releases.refresh`     | None                                           | Invalidates the brief cache and signals subscribed views to read again                         |
| `releases.prepare`     | `action`                                       | Immutable, pending `ReleaseIntent`; no upload or review request                                |
| `releases.execute`     | `intentId`                                     | Accepted job, only after consuming current Cloud approval                                      |
| `releases.cancel`      | `jobId`                                        | Job after its worker has stopped; does not undo an Apple operation already accepted            |

`platform` is `IOS`, `MAC_OS`, `TV_OS` or `VISION_OS`. `projectPath` is an absolute `.xcodeproj` or `.xcworkspace` on the environment. Build numbers are allocated automatically. Archive input never accepts a private key, an upload destination, an export-options file or a caller identity.

Mount one subscription while the Releases view is visible. Keep its latest `local` and `organizer` values independently. The stream sends local status followed by Apple metadata. Local job ticks carry no build/tester catalogue. Pending events coalesce by kind, so local progress cannot evict an Organizer refresh. Unsubscribe on close, account/app/environment switch or loss of visibility. `refresh` does no Apple work without a subscriber. Opening the view, explicit refresh and local job completion can request Apple data; there are no background Apple polling loops. To watch Apple's processing progress, the client offers Refresh. Every stream delivery repeats caller authorization.

The Organizer returns paginated ASC builds with marketing version, build number, processing state, expiry, upload date, beta review state and internal/external beta states; beta groups and testers; App Store versions with selected build and state; and review submissions. State strings remain Apple's values so new Apple states do not become false success labels. ASC dates are ISO strings or null. `fetchedAt` is epoch milliseconds. A successful snapshot caches for at most 30 seconds and is discarded with the final subscriber. Failed/malformed pages fail the read, rather than returning a partial list. Testers are app-wide, not a group membership editor.

`ReleaseJob` has `id`, `target`, `kind`, `state`, `phase`, optional byte `progress`, `archiveId`, `intentId`, Apple `resourceId`, a safe typed `error`, and creation/update times. States are `running`, `completed`, `failed`, `cancelled`, and `interrupted`. An upload completed with phase `uploaded-awaiting-processing` means the file was committed, not that Apple has processed or accepted it for testing. Upload bytes count successfully accepted parts. Notifications are coalesced to at most one per 350 ms, plus completion.

`LocalReleaseArchive` identifies a Pathway-created archive and exported IPA or Mac package. It includes immutable bundle/version/build metadata, SHA-256, byte size, environment ID/label, and environment-local paths. Pass its exact metadata into an upload action. The server checks the artifact before preparing and executing the upload. The library does not import arbitrary Xcode Organizer archives or expose local files through public URLs.

## Publishing consent

Publishing is disabled per connected Apple team and app by default. Only a signed-in human Cloud identity with account management permission can change the setting or confirm an action. An environment service identity cannot call these mutations successfully, regardless of its environment scopes. There is no `confirmed: true` RPC argument or environment-side enable/approve endpoint.

1. Read `api.appleReleases.settings(target)` to get `{ enabled, revision }`. Change it with `setEnabled({ ...target, enabled, expectedRevision })` from the client's authenticated Convex session. Stale revisions fail.
2. Agents or clients prepare an action through `releases.prepare`. Display the returned target, environment and complete action in a confirmation dialog. Preparation works while publishing is off, but confirmation and execution require it to be enabled.
3. Subscribe to `api.appleReleases.intent({ intentId })` for its immutable payload and state. After an explicit user click, call `api.appleReleases.confirm({ intentId })` from the client. Do not call it automatically or expose it as an agent tool. Dismiss/revoke with `api.appleReleases.cancel({ intentId })`.
4. Call `releases.execute` in the named environment. Cloud atomically consumes the approval before any outward-facing request. A replay, changed target, different environment, expired intent, changed key/account revision, revoked caller/approver permission or changed publishing policy fails closed. Disabling and re-enabling publishing invalidates old approvals.

Unused intents expire 15 minutes after preparation. Consumption starts a two-hour execution window; it does not permit replay. Each subsequent Apple mutation and multipart upload part checks the consumed grant again. Cancelling a consumed intent stops further operations at the next check. Cancelling the environment job aborts the current host/HTTP operation. Neither action retracts an already uploaded binary, assigned beta group, attached build or submitted review. After any ambiguous failure, inspect ASC status and prepare a new intent; writes are never automatically retried. Apple can accept an operation even when the response is lost.

The three action shapes are:

```ts
{
  kind: ("upload", archiveId, artifactSha256, version, buildNumber, platform);
}
{
  kind: ("testflight", buildId, groupIds, locale, whatsNew, submitForReview);
}
{
  kind: ("app-store", buildId, versionId);
}
```

The TestFlight action writes “What to test” for the chosen locale, adds the build to the selected existing groups, and optionally submits it for beta review. Group assignment can make a build available, so it requires confirmation even when `submitForReview` is false. The App Store action attaches the selected build to an existing version, creates a review submission and item, then submits it. Build/group/version ownership is checked against the app before writes. Apple validates review metadata, agreements, export compliance and release eligibility. Creating apps, groups, testers and App Store versions is outside these contracts.

Reads require `orchestration:read`; archive, prepare, execute and cancel require `orchestration:operate`. COR-100's Cloud caller checks additionally require personal-account ownership or current company `integrations.read`/`integrations.manage`. Providers use the same preparation contract; none receives an exception to the confirmation gate. Typed RPC errors are `EnvironmentAuthorizationError`, `AppleError` or `ReleaseError`. Errors never contain upstream response bodies, process output, JWTs or keys.

## Host execution and leases

Cloud serializes allocation under a 30-second exclusive lease keyed by ASC app ID and marketing version. Both allocator actions verify access to the exact app using the current Cloud-held credential before any counter write. Cloud reads fresh builds and pending uploads, then an internal mutation rechecks caller authorization and account/key revisions before advancing the counter above both its saved value and Apple's observed value. Environment-supplied maxima are ignored. The lease is consumed by allocation. Failed/cancelled archives burn their number. Two environments, or two configured keys for the same app, share the counter. Existing dotted build numbers advance to the next first component. The allocator uses integers from 1 through 9999; a new marketing version is required after exhaustion. External tools do not participate in this lease, so their concurrent uploads can still conflict.

The worker runs `xcodebuild archive` with automatic development signing, the allocated `CURRENT_PROJECT_VERSION` and requested `MARKETING_VERSION`, followed by `-exportArchive` with `method=app-store-connect`, automatic signing and `destination=export`. Xcode build-number management is disabled at export so it cannot overwrite the Cloud allocation. Both invocations use `-allowProvisioningUpdates` and the ASC authentication-key arguments.

Apple documents that [automatic distribution uses cloud-managed certificates when no local distribution identity is present](https://developer.apple.com/help/account/certificates/cloud-managed-certificates). The host checks the current keychain identities and refuses a local distribution identity for the selected team. It never removes keychain entries or requests creation of a local distribution certificate. The API key needs access to cloud-managed distribution signing. Development signing during archive may create a development identity. A signing/export failure stays a failure; there is no certificate-minting fallback.

The key lives in a 0600 file within a 0700 temporary directory only while archive/export runs, and is removed in `finally` on success, failure or cancellation. The server uses its configured `stateDir/releases/keys` directory, never a hard-coded Pathway home. Startup recovery removes stale files from that dedicated key directory. A hard process/host crash can leave a temporary key until the next release-service initialization; normal finalizers cannot run after a power failure.

Credential and caller leases are renewed only during active work. A separate expiry deadline aborts work even if Cloud renewal hangs. Cloud waits have a 30-second timeout and stop immediately when the work signal aborts, including initial authorization, per-write approval and final authorization. Late responses cannot resume the worker or start another Apple write; an already dispatched Cloud mutation may still finish. Rotation, loss of account/environment custody, caller revocation or loss of approval stops work. The process boundary targets only the child it spawned. There are no process-name searches, background downloads or hidden uploads.

Upload uses Apple's [Build Upload API](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads): `buildUploads`, `buildUploadFiles`, the returned multipart PUT operations, then a file commit. The artifact is file-backed and streamed in Apple's exact byte ranges. Signed upload URLs receive only Apple's upload headers, never the ASC JWT; redirects are refused. The public contract contains the upload resource ID, not signed URLs.

Jobs and archive metadata persist atomically under `stateDir/releases/state.json`; archives/exports live under `stateDir/releases/archives/<jobId>`. One worker runs per environment and survives socket disconnects. Startup marks running jobs interrupted; it never replays publishing or spends a new number automatically. Completed archives remain available for a later confirmed upload. A failed archive may leave local diagnostic/build artifacts for inspection.

## Deployment and verification

Deploy the additive Convex tables/functions before using these RPCs: `appleReleasePolicies`, `appleReleaseIntents`, `appleBuildCounters`, and `appleReleases`. Updated generated API declarations are included. No new credentials, SQLite migration or relay endpoint are required. Cloud counters deliberately survive account/key removal so reconnecting cannot reset allocated numbers. Old intents cannot execute once their account/team is gone or its revision changes.

The review fixes also require a Convex function deployment: `acquireBuildLease` and `allocateBuildNumber` are now actions backed by internal mutations. Deploy these with the updated environment server, which calls them as actions. This revision adds no tables and changes no client release RPCs.

Focused tests mock ASC HTTP and `xcodebuild`; Cloud tests use Convex's in-memory test harness. They exercise approval denial/replay/expiry, environment isolation, policy revocation, concurrent allocation, pagination/cache, multipart ranges, review requests, temporary-key cleanup, worker cancellation/restart and lease loss. No Apple API operation, real archive/export/upload, dev server, browser, deployment or live userdata write is part of verification. A maintainer still needs a real Mac and Apple account pass to verify signing entitlements and Apple's acceptance of an exported binary.
