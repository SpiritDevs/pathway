# Apple accounts and App Store Connect

COR-100 ships Apple account management in Settings → Apple accounts and app linking in Project settings → App Store Connect, backed by Cloud metadata and environment RPCs. Apple ID authentication is deferred to COR-101. Import schemas from `@spiritdevs/contracts/apple` and cloud references from `api.appleIntegrations`.

An Apple account belongs to a Pathway user by default. A user can add several Apple IDs, each with several Developer teams. Tethering an account to a company shares it with that company. Each team has one replaceable ASC API key. Apple ID verification and team discovery are deferred to COR-101. Manually entered team metadata is not proof of Apple ID membership; validating an ASC key proves that key can list apps, not that its issuer matches a manually entered Developer team ID.

## Cloud calls for the UI engineer

Use the signed-in member's Convex identity for these calls. Account management and key connection must not go through the environment's service identity. Dates in cloud metadata are epoch milliseconds. IDs of Apple accounts and Pathway projects are cloud domain IDs, not Convex document IDs or environment-local project IDs.

`scope` is `{ kind: "user" }` or `{ kind: "company", companyId }`. Company account reads require `integrations.read`; changes require `integrations.manage`. Personal accounts are visible and manageable only by their owner. Only that owner may change scope, and changing company scope also checks both companies' permissions. Unlink projects before changing scope. An account with linked projects returns `apple-account-linked-projects`; stale revisions and duplicate accounts return `entity-conflict`. Creating an account or changing its scope enforces uniqueness by owner, normalized Apple ID email and destination scope in the same transaction. A conflicting tether or untether leaves the account unchanged.

| Call                     | Input                                                                  | Result                                                                                |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `listAccounts` query     | `{ companyId? }`                                                       | `AppleAccount[]`: personal accounts plus permitted accounts in the selected company   |
| `createAccount` mutation | `{ email, displayName, scope? }`                                       | `AppleAccount`; defaults to user scope                                                |
| `accountStatus` query    | `{ accountId, companyId? }`                                            | `AppleAccount`                                                                        |
| `updateAccount` mutation | `{ accountId, displayName, scope, expectedRevision }`                  | `AppleAccount`                                                                        |
| `removeAccount` mutation | `{ accountId, expectedRevision }`                                      | `null`; removes keys, leases, session records, teams and project links                |
| `listTeams` query        | `{ accountId, companyId? }`                                            | `{ accountId, teamId, name, type }[]`                                                 |
| `upsertTeam` mutation    | `{ accountId, teamId, name, type }`                                    | Team metadata; type is `individual`, `organization`, `enterprise`, or `unknown`       |
| `connect` action         | `{ accountId, teamId, issuerId, keyId, privateKey, expectedRevision }` | `AppleIntegration`; replaces the team's key after a successful live ASC app-list call |
| `revoke` mutation        | `{ accountId, teamId, expectedRevision }`                              | `AppleIntegration`; deletes the sealed key and increments its revision                |
| `removeTeam` mutation    | `{ accountId, teamId, expectedRevision }`                              | `null`; removes the team, sealed key and environment health/lease rows                |
| `status` query           | `{ accountId, teamId, companyId? }`                                    | `{ integration: AppleIntegration, environments: AppleEnvironmentHealth[] }`           |
| `linkProject` action     | `{ companyId, projectId, accountId, teamId, appId }`                   | `AppleProjectLink`; verifies the app exists under the selected key before saving      |
| `unlinkProject` mutation | `{ companyId, projectId }`                                             | `null`                                                                                |
| `projectLink` query      | `{ companyId, projectId }`                                             | `AppleProjectLink \| null`, subscribable from every client                            |

`listAccounts({ companyId })` still returns the caller's personal accounts when their active membership lacks `integrations.read`; company accounts are omitted. `accountStatus`, `listTeams` and `status` accept an optional `companyId`. Signed-in members are authorized against the account's scope; an environment identity must supply its registered company context, including for personal accounts.

`AppleAccount` is `{ id, email, displayName, scope, revision, createdAt, verifiedAt }`. `verifiedAt` stays null until COR-101 verifies the Apple ID. Initial key revision is 0; pass the current revision when connecting, revoking or removing a team. A stale revision returns `entity-conflict` and leaves current credentials unchanged. A rejected replacement also leaves the current key intact.

`removeTeam` requires the personal account's owner or `integrations.manage` in the account's company. It checks the team's revision before deleting anything. Unlink every project using that account and team first; otherwise removal returns `apple-account-linked-projects` and leaves all records unchanged. Removal deletes the `appleTeams` row, its sealed `appleIntegrationCredentials` record and all `appleEnvironmentLeases` rows, which also hold environment health. The Apple account, account sessions and other teams remain. Environment identities cannot remove teams.

`AppleIntegration` is `{ accountId, teamId, accountRevision, connected, revision, issuerId, keyIdSuffix, lastVerifiedAt }`. Only the last four key-ID characters are public. No Apple Developer team ID is inferred from the ASC issuer ID.

`AppleEnvironmentHealth` is `{ environmentId, connected, revision, leaseExpiresAt, lastVerifiedAt, error }`. Its `connected` means the environment holds a current lease, has an active company registration, and, for personal accounts, still has the owner's active relay link. The status query reads that link so unlinking immediately invalidates subscribed health; `error` carries the last failed verification or read. Clients should treat a passed `leaseExpiresAt` as disconnected; Convex subscriptions do not rerun merely because wall-clock time passes. A configured key can exist while no environment holds a lease. Metadata's `lastVerifiedAt` records connection-time verification; per-environment health records later successful ASC reads.

`AppleProjectLink` is `{ companyId, projectId, accountId, teamId, app: { id, name, bundleId }, linkedAt }`. Project readers can see the non-secret link even when they cannot access its personal Apple account. Linking or unlinking requires `projects.manage`; listing the link requires `projects.read`, with the existing project team rules. A link does not grant credential access. Only the selected app identity is stored in the cloud; apps, builds and beta-group lists are read live.

## Environment RPCs

These RPCs work through the existing authenticated WebSocket transport on local, relay and tunnel connections. They are registered in `WsRpcGroup`. `target` below is `{ companyId, accountId, teamId }`; `companyId` identifies this environment's authorization context even for a personal account.

| RPC                      | Input                                                          | Result                                                                                                    |
| ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apple.status`           | `target`                                                       | `{ integration, health }` for this environment                                                            |
| `apple.testConnection`   | `target`                                                       | Same status after a fresh, uncached ASC app-list call; ASC failures appear in `health.error`              |
| `apple.listApps`         | `target`                                                       | `{ id, name, bundleId }[]`                                                                                |
| `apple.listBuilds`       | `{ ...target, appId }`                                         | `{ id, version, buildNumber, processingState, expiresAt, uploadedDate }[]`                                |
| `apple.listBetaGroups`   | `{ ...target, appId }`                                         | `{ id, name, isInternalGroup }[]`                                                                         |
| `apple.registerBundleId` | `{ ...target, name, identifier, platform }`                    | `{ id, name, identifier, platform }`; platform is `IOS`, `MAC_OS`, or `UNIVERSAL`                         |
| `apple.createApp`        | `{ ...target, name, bundleId, sku, primaryLocale, platforms }` | Intended result is `{ id, name, bundleId }`; currently `not-implemented` from the COR-101 session service |

Build `version` is the marketing version from the included `preReleaseVersion`; `buildNumber` is ASC's build `version`. Marketing version, expiry and upload date may be null. ASC dates remain ISO strings. Pagination is followed internally; no cursor handling is required in the UI. A malformed page fails the whole read rather than returning incomplete data. Successful results cache for 30 seconds in each environment. The test-connection call bypasses that cache. Bundle registration is a write, is never cached, and has no automatic retry. If connectivity or rotation interrupts a write, it may already have reached Apple; reconcile the bundle identifier before retrying.

Writes require `orchestration:operate`; reads and test connection require `orchestration:read`. These environment scopes do not grant Apple account access. Every RPC also checks its authenticated caller in Cloud before using the runtime and before returning a successful result. Personal accounts require their owner; company accounts require the caller's active membership and `integrations.read` for reads or `integrations.manage` for writes in the target company. A host registered in multiple companies does not transfer those permissions between callers.

The server resolves the caller from the authenticated WebSocket session, never from RPC input. An owner Connect session uses `cloud-connect` and the linked Clerk subject in the server secret store. A peer session carries the acting member's opaque Cloud user ID. The auth layer retains the verified session on the upgrade request for Apple handlers to read. This avoids consuming DPoP proofs twice and keeps the shared RPC registration unchanged. Pairing/bootstrap sessions and missing Cloud identities fail closed. The environment-only `authorizeRuntimeCaller` Cloud query checks the host's proof-bound registration and account access, then resolves the caller and applies current member permissions. Existing WebSocket input and result shapes are unchanged.

Errors have `{ _tag: "AppleError", code, message, retryAfterSeconds }`. ASC 401, 403 and 429 map to `unauthorized`, `forbidden` and `rate-limited`; `Retry-After` accepts seconds or an HTTP date. No upstream error bodies, request headers, private keys or JWTs are returned. Cloud connect errors use Convex error data `{ code, message, retryAfterSeconds }`; authorization/conflict errors retain the existing backend `{ code, message }` shape.

## Apple ID session boundary for COR-101

`apple.id.start({ companyId, accountId, password })`, `apple.id.complete({ companyId, accountId, flowId, code })`, `apple.id.cancel({ companyId, accountId, flowId })`, and `apple.id.signOut({ companyId, accountId })` currently return `not-implemented`. `apple.id.status` and the `apple.id.subscribe` stream take `{ companyId, accountId }` and currently report `signed-out`. Account email comes from the account record. Password and 2FA inputs are neither retained nor forwarded to Cloud by this stub.

The session state union is:

- `{ state: "signed-out" }`
- `{ state: "challenge", flowId, expiresAt, destination }`
- `{ state: "authenticated", expiresAt }`
- `{ state: "expired" }`

COR-101 will own live challenge fan-out to watching clients, interactive Apple authentication, team discovery, sealed account session writes and lease-based retrieval, expiry and re-authentication. `appleAccountSessions` reserves encrypted storage with `accountId`, revision and expiry; it has no write/read credential endpoints yet. Cookies never belong in client responses, and passwords must never be persisted. `apple.createApp` is already routed to this stub, separately from bundle-ID registration.

Apple documents [bundle-ID registration](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-bundleids). Its current [Apps API reference](https://developer.apple.com/documentation/appstoreconnectapi/apps) lists reading and updating app records but no create-app endpoint. COR-100 therefore does not attempt an undocumented `POST /v1/apps`.

## Credential custody and deployment

The existing integration keyring seals the JSON credential with AES-256-GCM. AAD binds the immutable Apple account ID, team ID and issuer. `PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID` and `PATHWAY_INTEGRATION_CREDENTIAL_KEYS` are reused. Keep old envelope-encryption keys available for existing ciphertext. Public metadata and ciphertext occupy separate tables.

Environment credential retrieval uses the existing relay-issued, proof-bound Cloud identity and active company registration. Personal accounts additionally require an active `relayEnvironmentLinks` row for the account owner's Clerk subject and the environment. Company accounts require a registration in that exact company. Merely knowing an account or team ID grants nothing. Company registration revoke, owner unlink, account scope changes, account removal and key replacement/revoke are checked before reuse.

Each environment obtains an independent 30-second lease, so two environments can use a team concurrently. Every read checks Cloud before using its cached client and again before returning data. Rotation increments the key revision; scope changes increment the account revision. Both fence old leases. Expiry timers dispose idle clients within 30 seconds without polling. Disposal releases key/JWT/cache references and aborts requests; JavaScript cannot guarantee overwriting immutable string memory. Cloud unavailability fails closed. No `.p8` or Apple password is written to disk. Future COR-106 tool invocations that require a key path must create a 0600 temporary file and delete it in a finalizer; this change creates no such files.

Deploy the Convex schema and functions before using the new APIs. Six additive tables are introduced: `appleAccounts`, `appleTeams`, `appleIntegrationCredentials`, `appleEnvironmentLeases`, `appleAccountSessions`, and `appleProjectLinks`. No existing-data migration, local SQLite migration, new encryption configuration or relay deployment is needed when the integration keyring is already configured. No deployment is performed by this change.

The generated Convex API declarations and server RPC registration include the Apple endpoints. Web and desktop share the Settings → Apple accounts and Project settings → App Store Connect UI. Native mobile UI, provider adapters and Xcode tooling remain outside COR-100's scope.
