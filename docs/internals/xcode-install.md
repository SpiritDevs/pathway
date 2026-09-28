# Xcode installation on an environment

COR-101 adds the Apple ID sign-in runtime and Xcode installer backend. Import the client schemas from `@spiritdevs/contracts/apple` and `@spiritdevs/contracts/xcode`. UI is separate work. All filesystem paths, free-space values, processes and administrator prompts refer to the environment's Mac, regardless of which client initiates the operation.

One `AppleIdSession` and one `XcodeInstall` instance live for the server's WebSocket route lifetime. They are shared by local, remote, relay and tunnel clients. Disconnecting a socket does not stop a job. The RPCs have the same transport on web, desktop and mobile; no Electron IPC or client-local native tooling is required.

## Authentication choice

We evaluated the [xcodes 2.1.0 CLI](https://github.com/XcodesOrg/xcodes/tree/2.1.0) as a managed helper. Its published `xcodes.zip` SHA-256 is `f1519afe934a513e85dd9b32fc872394becbbb6a41db15d9ac3926a09a891888`. Pinning and checking that asset solves distribution integrity, but not the credential contract. The [session service it pins](https://github.com/XcodesOrg/XcodesLoginKit/blob/929f9aac3140caf7b64cbb5385f4f645c5f9913d/Sources/XcodesLoginKit/AppleSessionService.swift) writes the password to Keychain after successful sign-in, including passwords passed through `XCODES_PASSWORD`. The CLI has no structured cookie-export/challenge API. Scraping terminal prompts, blocking Keychain calls or maintaining a fork would add failure modes.

Writing Apple's SRP and hashcash implementation ourselves would make Pathway responsible for cryptographic protocol changes. A Swift wrapper around XcodesLoginKit would avoid that, but needs a separately published native executable to bootstrap a Mac without Xcode.

The implementation instead pins [`@expo/apple-utils` 2.2.1](https://www.npmjs.com/package/@expo/apple-utils/v/2.2.1), with npm integrity recorded in the lockfile. It calls only `Auth.attemptLoginRequestAsync` for the SRP exchange. It does not call Expo's CLI login, credential cache, cookie-file, Keychain or interactive team-selection functions. A short-lived Node worker has an empty environment and private stdout/stderr. It performs the CPU work away from the server event loop. Its HTTP adapter sends requests back to Pathway's injected HTTP boundary. Each flow owns its own `tough-cookie` jar. Passwords travel to this worker in memory and disappear with its lifetime; JavaScript cannot promise memory zeroization.

Pathway handles trusted-device codes and SMS selection, validates the resulting session, and discovers Developer teams through `account/listTeams.action` when that endpoint exposes them. ASC provider IDs are never treated as Developer team IDs. Hardware security keys, federated identity-provider redirects, legacy two-step accounts and Apple's account-agreement screens are not automated. Apple may require those users to repair their account outside this flow.

## UI contract

After creating or choosing an Apple account in Cloud, sign in through the environment's `apple.id.*` RPCs. Offer Xcode installation after an `authenticated` state. The server does not start a download merely because an account connects.

Apple ID inputs use `{ companyId, accountId }`, with the account email taken from Cloud. `companyId` is the environment authorization context, including for a personal account.

| RPC                    | Additional input          | Result                                                                                        |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `apple.id.start`       | `password`                | Current session state after sign-in reaches a challenge or succeeds                           |
| `apple.id.complete`    | `flowId`, `code`          | Authenticated session state; an incorrect code returns a safe error and retains the challenge |
| `apple.id.requestCode` | `flowId`, `phoneNumberId` | SMS challenge for a phone in the current challenge's list                                     |
| `apple.id.cancel`      | `flowId`                  | Signed-out state, after invalidating the flow and revoking its session                        |
| `apple.id.signOut`     | None                      | Signed-out state                                                                              |
| `apple.id.status`      | None                      | Current session state                                                                         |
| `apple.id.subscribe`   | None                      | Live session-state stream, including the initial state                                        |

The state union is:

- `{ state: "signed-out" }`
- `{ state: "authenticating", flowId, expiresAt }`
- `{ state: "challenge", flowId, expiresAt, kind, destination, phoneNumbers }`
- `{ state: "authenticated", expiresAt }`
- `{ state: "expired" }`
- `{ state: "failed", error: { code, message, retryAfterSeconds } }`

Challenge `kind` is `trusted-device`, `sms` or `sms-choice`. `phoneNumbers` contains `{ id, destination }`; the destination is Apple's masked phone label. All watching clients see the challenge. One client's submission completes it for everyone. A stale flow ID is rejected. Challenges expire after ten minutes, aborting their worker. No password, code, cookies or challenge headers appear in stream values.

Every Xcode RPC also takes `{ companyId, accountId }` as its authorization context. This applies to selecting an existing Xcode and installing runtimes, even though those operations do not need an Apple download session.

| RPC                     | Additional input         | Result                                                             |
| ----------------------- | ------------------------ | ------------------------------------------------------------------ |
| `xcode.status`          | None                     | `XcodeStatus`                                                      |
| `xcode.subscribe`       | None                     | `XcodeUpdate`: initial inventory, then coalesced job snapshots     |
| `xcode.install`         | `versionId`, `platforms` | Accepted `XcodeJob`                                                |
| `xcode.cancel`          | `jobId`                  | Current job; may be `cancelling` until the worker exits            |
| `xcode.retry`           | `jobId`                  | Resumes the first unfinished step                                  |
| `xcode.approve`         | `jobId`                  | Starts the current admin step and opens macOS approval on the host |
| `xcode.select`          | `path`                   | Job selecting an installed Xcode                                   |
| `xcode.installRuntimes` | `path`, `platforms`      | Job downloading runtimes for that Xcode                            |

`XcodeUpdate` is `{ kind: "status", status: XcodeStatus }` initially and after job completion, or `{ kind: "job", job: XcodeJob | null }` for progress. Keep the last inventory when receiving a job update. This keeps the release and runtime catalogues out of download ticks.

`platforms` is an array of `iOS`, `watchOS`, and `tvOS`. Duplicates are removed. `versionId` is the catalogue's build ID, not a version label guessed by a client. `path` comes from `status.installed`. Runtime installation asks `xcodebuild` for its current compatible platform download; this API does not select arbitrary old runtime builds.

`XcodeStatus` contains:

- `host`: `mac` or `needs-mac`.
- `installed`: `{ path, version, build, beta, selected }[]`.
- `available`: `{ id, version, build, beta, downloadBytes, requiredBytes }[]`. Unknown archive size is `null`.
- `runtimes`: `{ id, platform, version, build, installed, available, downloadBytes }[]`. Apple catalogue candidates are filtered by host OS requirements. `xcodebuild` decides compatibility with the chosen Xcode.
- `disk`: `{ freeBytes, requiredBytes }`. Free space is the smaller of scratch and Applications volume availability. Required space includes the active job's runtime choices.
- `job`: the last accepted job in the requested account context, or `null`. Another account's job is never returned. The environment has one worker, so starting a job can return `busy` while another account's job runs.
- `error`: a safe inventory/catalogue error, or `null`. Useful inventory is retained when a catalogue cannot be loaded.

`XcodeJob` is `{ id, kind, account, versionId, path, platforms, state, steps, createdAt, updatedAt }`. `kind` is `install`, `select` or `runtimes`; `account` is always `{ companyId, accountId }`; `versionId` is null for jobs that do not need an Apple download session. Times are epoch milliseconds.

Job states are `running`, `needs-admin`, `needs-reauth`, `interrupted`, `failed`, `cancelling`, `cancelled`, and `completed`. Render `needs-admin` as **Needs admin approval on the Mac**. Calling `xcode.approve` is explicit consent to show the host prompt for that step. Remote clients never send an administrator password. The state stays `needs-admin` while the OS prompt and privileged operation are active. A second approval is rejected while one is in flight. After `needs-reauth`, complete Apple sign-in and call `xcode.retry`.

Every job has the same ordered step IDs: `check`, `download`, `expand`, `move`, `license`, `select`, `first-launch`, `runtimes`, `helpers`. Irrelevant steps are `skipped`. A step is `{ id, state, error, progress }`. Step states are `pending`, `running`, `needs-admin`, `completed`, `skipped`, `failed`, and `cancelled`. Download progress is `{ bytes, total, bytesPerSecond }`; progress is null for other steps. `total` may be null. Errors are `{ code, message }`, never raw process output or Apple response bodies.

All reads and subscriptions require `orchestration:read`. Every mutation, including approvals and cancellations, requires `orchestration:operate`. Both RPC groups use `auth/appleCaller.ts` to resolve the authenticated session identity and the same Cloud `authorizeRuntimeCaller` check before an operation and before returning data. Personal accounts are owner-only. Company accounts require current `integrations.read` or `integrations.manage` permission. Each streamed snapshot repeats this check; revocation ends the stream with an `AppleError`. Bootstrap sessions and old owner sessions without the verified Clerk subject fail closed. Job controls also match the persisted account context inside the serialized state transition, so another accessible account cannot authorize a guessed job ID. Cloud independently checks the environment registration and owner link before issuing or renewing a session lease.

RPC failures may be `EnvironmentAuthorizationError` (missing environment scope), `AppleError` (caller/account authorization or Cloud availability), or `XcodeError` (host/job failure). Step and inventory errors use the smaller `{ code, message }` shape.

## Host work and recovery

Xcode discovery inspects bundle metadata in Applications, Spotlight results and the selected developer directory. It normalizes symlinks and recognizes betas. Release metadata comes from xcodereleases.com; only HTTPS XIP URLs on Apple's developer download host are accepted. Current Apple platform metadata supplies runtime candidates. No `Simulator.app` path is used, including for Xcode 27.

A full install budgets 45 GiB plus 15 GiB for each selected runtime platform. The check covers both the scratch and destination filesystems and the release's minimum macOS version. This is conservative headroom, not a promise about Apple's future archive sizes.

The downloader obtains Apple download authorization with the connected account's cookies, writes a `.part` file, uses HTTP ranges, validates the published archive checksum when present, and renames only a completed archive. Thirty-second Cloud leases fence session reuse. Long downloads renew authorization without persisting cookies locally. Range requests are bounded by the lease expiry; a timeout after partial progress resumes from the bytes written. Revoked, rotated or expired sessions stop the download and request re-authentication.

`xip --expand` verifies the archive. Pathway checks the expanded build ID and code signature. A privileged `ditto` copy goes to a job-specific staging sibling before rename into Applications. Existing unrelated apps are not overwritten. The remaining host commands accept the license, change `xcode-select`, run first-launch tasks, download selected platforms, and run first-launch with `-checkForNewerComponents` to install current device support.

Jobs persist under the environment's configured `stateDir/xcode/job.json`, using a flushed temporary file and atomic rename. Scratch archives and expansion data live under `stateDir/xcode/<jobId>`. No work uses the live install's state directory by hard-coded path. Each state transition is saved before the next host mutation. Download byte counters are rebuilt from the partial file instead of writing every progress tick to disk.

On restart, running, cancelling and admin jobs become `interrupted`, with a retryable step error. Completed steps remain completed. Retrying preserves partial downloads; an interrupted expansion starts again in that job's scratch directory. The backend deliberately offers retry rather than automatically accepting licenses or reopening a Mac admin prompt after restart. A download or operation failure likewise preserves scratch for retry. Successful jobs remove their scratch. Starting a new job after a terminal job discards the previous job's scratch.

Privileged commands use a bounded root supervisor that records the child PID it spawned. Cancellation revokes a per-attempt approval marker and terminates the owned `osascript` process. The supervisor terminates its captured child; a filesystem notification waits for its lock to clear. On restart the old approval markers are revoked, so an old dialog cannot authorize a later attempt. A lock prevents a second privileged operation while an earlier operation drains. There are no process-name searches or password-fed `sudo` commands. Cancellation cannot roll back a completed license acceptance, selection, installed runtime, or OS package operation.

Job snapshot notifications are coalesced at 350 ms, fewer than three per second. The stream sends inventory initially and after completion; download ticks contain only the job. Each socket has a sliding one-item queue, so a slow client receives current state instead of a backlog. Status calls share a five-second host inventory cache and an hour-long release catalogue cache.

## Validation and remaining limits

Focused tests inject HTTP and process runners. They cover SRP requests, concurrent accounts, 2FA fan-out through the RPC, password/secret boundaries, sealed Cloud storage, revocation and expiry, scopes, state transitions, disk failure, restart/retry, cancellation, partial downloads, checksum completion, host discovery, admin marker recovery and snapshot coalescing. No test downloads Xcode, contacts Apple, runs Xcode tools or requests real admin elevation.

Real Apple sign-in, Xcode archive installation, macOS authorization prompts and device-package behavior still need a maintainer's integrated Mac pass. Apple uses undocumented authentication and Developer portal endpoints; upstream protocol changes can require an adapter update. Runtime catalogue availability does not establish compatibility with every Xcode version. A hard host crash during privileged work can leave an Applications staging sibling or admin lock that requires host inspection before retry. These paths must never be cleaned by pattern or by deleting unrelated Xcodes.

Deploy the additive Cloud schema/function changes before using the session RPCs. COR-100 migration 076 supplies the persisted Clerk subject used by these handlers; COR-101 adds no SQLite migration. No Cloud or relay deployment is part of this implementation. `apple.createApp` remains explicitly unsupported; it is separate from the `apple.id.*` download-session implementation.
