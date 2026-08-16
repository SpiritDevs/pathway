# Cloud synchronization

> For maintainers. Using Pathway? See [docs/user](../user/).

Convex is the authority for company and issue data. Clients and Pathway servers keep durable local
replicas so issue work opens immediately, accepts offline edits, and converges after reconnect. The
architectural decision is [0007](./decisions/0007-convex-company-local-first-sync.md); company
authorization is described in [companies-and-permissions.md](./companies-and-permissions.md).

## Protocol surface

The sync API has five entry points:

| Function                | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `sync.bootstrap`        | Read a permission-filtered company snapshot in bounded pages.            |
| `sync.latestVersion`    | Subscribe to the small company sync head.                                |
| `sync.listChanges`      | Drain permission-filtered changes after a persisted cursor.              |
| `sync.applyOperations`  | Validate, deduplicate, and atomically apply one bounded operation batch. |
| `sync.reserveIssueKeys` | Lease the next immutable human issue-key numbers to an online client.    |

Clients subscribe only to `sync.latestVersion`. An advancing head is a signal to call
`sync.listChanges`; it is not a request to send a whole-company snapshot through a reactive query.

### Operation envelope

`SyncOperation` is a tagged, versioned union. Its issue variants mirror the issue domain commands
rather than exposing arbitrary entity patches. Every variant carries:

```text
protocolVersion
operationId
companyId
sourceClientOrEnvironmentId
authenticatedActor
localSequence
baseCompanyVersion
entityId
arguments
dependencyOperationIds
```

Domain IDs are client-generated UUIDv7 values. Relationships created offline can therefore refer to
stable IDs without a later remapping pass. Convex `_id` values stay inside the backend.

`operationId` is the idempotency key. `localSequence` preserves one outbox's submission order.
`baseCompanyVersion` detects a stale write but does not reject it by itself; valid stale writes use
the conflict policy below and retain overwrite detail in audit history. Dependencies are explicit so
the client can block a dependent operation without blocking unrelated work.

Convex accepts at most 25 operations and 512 KiB of arguments per call. Attachments and other file
bytes never travel in operation arguments. `sync.listChanges` returns at most 100 changes and also
stays below a configured byte ceiling; a page can therefore end before the row limit.

### Issue attachments

Convex authorizes and records issue attachment metadata, while UploadThing stores the bytes. A
member with `comments.create` prepares a public-read UploadThing upload against one visible issue,
uploads directly from the browser, and asks Convex to finalize it. Finalization downloads the
stored object server-side and verifies its size, MIME type, and SHA-256 checksum before the row
becomes `ready`. Only ready attachments uploaded by the acting member can enter a comment
operation, so the comment outbox never races the file upload.

`UPLOADTHING_TOKEN` is deployment configuration, like other provider credentials: set it on the
Convex deployment and never put it in a company vault or client bundle. Public-read is deliberate:
the returned URL is a bearer URL suitable for review evidence. Application code obtains it only
through `issueAttachments.urls`, which rechecks live company membership and `issues.read` on the
owning issue. Pending uploads expire after one hour and an hourly Convex cron deletes their
UploadThing objects and metadata.

For each accepted operation, one serializable Convex mutation:

1. verifies the human or service identity and its current company/team permissions;
2. returns the stored receipt when `operationId` was already applied;
3. validates domain invariants and dependencies;
4. applies authoritative entity changes and writes issue audit events;
5. appends full-entity changes or tombstones;
6. assigns a contiguous company version range; and
7. returns that accepted range.

Full-entity changes keep replica folding independent from backend patch history. Tombstones make
deletion durable and prevent an old update from recreating an entity implicitly.

## Cursors and authorization epochs

A cursor records the last contiguous company version included in confirmed local state. Changes and
operation receipts are stamped with a 90-day `retainUntil` target. No feed-pruning function or cron
is wired yet, so rows currently remain beyond that target; the only scheduled Convex job is pending
attachment cleanup.

Receipt expiry must never reopen the dedupe question: a durable outbox can hold an unacknowledged
send across a bootstrap and outlive its receipt. So every decided operation id also writes a compact,
permanently retained row recording only its terminal outcome — the accepted version range or the
rejection code. `applyOperations` consults the detailed receipt first and falls back to that ledger,
and any feed prune leaves the ledger alone.

`sync.listChanges` filters every payload against current company and team authorization. It advances
the cursor even when every change in the scanned range is filtered out; otherwise a client without
access to those records would stall permanently. Unauthorized payloads are never returned merely to
explain a version gap. `sync.bootstrap` applies the same predicate to the same row shapes, so a seed
and a drain never disagree about what an actor may hold.

Four visibility classes exist, not one:

- **Team-scoped records** are reachable through any attached team, and a record attached to no team
  is company-wide — only a company-scoped grant reaches it.
- **Company catalog** — company base statuses, company labels, company cycles, and milestones of
  company-wide projects — is attached to no team but reaches any actor holding `issues.read` in at
  least one team, because every team board resolves its issues against that vocabulary.
- **Company-domain records** — company, company settings, memberships, teams, team memberships,
  roles, and role assignments — are administration records delivered as a permission-filtered read
  cache. Administration of them is online-only; nothing about them ever enters the outbox. Every one
  of them is company-wide, so the first rule already says a team-scoped `members.read` sees no
  member rows at all, and that stays true. On top of it sits one narrow widening, **self
  visibility**: an active member always receives the `company` and `companySettings` singletons, and
  always receives the `membership`, `teamMembership`, and `roleAssignment` rows that are about
  _them_. Without it a member holding no administration switch replicates a company it cannot name,
  cannot find itself in, and has no `offlineAccessDays` budget to enforce against itself while
  disconnected. It widens nothing else: a foreign membership, a team, or a role still needs the
  kind's read switch at company scope. The subject of a row is read from its entity id where the id
  is the answer (a membership names itself; a team membership is the `${teamId}:${membershipId}`
  composite) and from the payload for a role assignment, whose id is minted — so a role-assignment
  _tombstone_ has no legible subject and is withheld. That is safe rather than merely tolerated:
  every role-assignment write bumps the authorization epoch, so the revoked client reseeds instead
  of waiting for a row it would not be shown. An environment identity is nobody's member and
  receives no self rows at all.
- **Owner-private rows** — private saved views — reach their owning membership and nobody else,
  whatever anyone's team or company grants. The owner binding is read from the entity's current
  state on every page, so a view that becomes private stops being delivered by its history too.
  Withholding history is not the same as taking a record away, so the update that turns a shared
  view private also writes one payloadless _departure_ tombstone addressed to the audience it drops.
  That row is filtered on its team scope alone — the owner gate would withhold it from exactly the
  replicas that already hold the view — and it discloses nothing, since those replicas have the id.

Each change page includes the company's current authorization epoch, and the authenticated bootstrap
path returns the epoch associated with its snapshot. Membership, role, team, and other visibility
changes increment it. On an epoch change, the client stops trusting the old permission-filtered
replica, purges records no longer visible, and performs the required permission-aware reseed. An
epoch is not a substitute for checking every query and mutation at the backend.

Once pruning is implemented, a cursor older than the surviving feed is expired. The client discards
its confirmed replica and performs a full paginated bootstrap. Pending operations remain in the
outbox and are rebased over the new confirmed snapshot before submission. Pruning must never remove
the permanent operation-decision ledger.

### The bootstrap walk order

A seed walks the replicated tables in the fixed order named by `BOOTSTRAP_ENTITY_ORDER`
(`packages/backend/src/sync/bootstrap.ts`), ascending by domain id within each table, and suspends
between pages in a cursor token that records exactly that position: company, snapshot version,
entity kind, last id consumed. The token is opaque to clients, checksummed against corruption rather
than signed, and refused outright when it names a kind this build does not walk — a refusal restarts
the seed, which is the safe outcome; silently accepting one would finish a seed that delivered
nothing.

Three rules govern that list, and each exists because breaking it fails quietly rather than loudly.

- **Append only.** Clients hold cursors across a deployment. Inserting a kind before the position an
  in-flight cursor already passed skips that whole table for that client — the walk never goes
  backwards — and the result is a replica quietly short one table. Appending is always safe: a
  cursor from the previous deployment resumes where it stopped and then walks on into the new kinds,
  and a client whose seed already finished is carried by the incremental feed instead.
- **Grow it together with the reader.** `readBootstrapRows`
  (`packages/backend/convex/lib/issueApply.ts`) switches exhaustively over the list with no
  `default`, so widening the list without teaching the reader is a compile error. The reverse is not
  checked, which is why the pairing is written down here.
- **Never seed a kind nothing appends.** A kind that a seed delivers but no mutation ever writes a
  change row for hands clients rows the incremental drain can never update or remove — worse than
  not seeding them. The company domain was appended only once `lib/companyApply` began appending its
  rows to the same feed, off the same company head.

Seeded rows carry the entity's own stamped version, or zero for a row written before its table
joined the feed. Zero is the value that cannot lose a later change: the seed's resume cursor is the
company head captured on the _first_ page, so anything written during or after the seed arrives on
the drain carrying a higher version and folds as an ordinary idempotent upsert. Reporting a version
a row has not actually reached is the failure mode, because a replica would then discard the real
change as stale.

## Local replica

Every persistence adapter exposes two logical layers:

- **Confirmed state** is the last permission-filtered Convex state at the persisted cursor.
- **Pending overlay** is the deterministic replay of durable outbox operations over confirmed
  state.

The rendered view is always confirmed state plus the pending overlay. Optimistic state is not copied
into confirmed tables, which lets an acknowledgement, rejection, authorization change, or full
bootstrap rebuild the visible result without guessing which fields came from the server.

Web and Electron use IndexedDB database `pathway:cloud-sync`. The mobile foundation uses the
existing mobile SQLite persistence layer. The Pathway server uses SQLite metadata and outbox tables
plus company-scoped issue replica tables. Electron protects its local sync key with secure storage;
server SQLite relies on the Pathway Home and operating-system trust boundary.

Startup proceeds in this order:

1. Decode the local schema; quarantine data that cannot be decoded.
2. Check the cached offline-access grant.
3. Render confirmed state plus the pending overlay immediately.
4. When online, authenticate and compare the authorization epoch.
5. Bootstrap or drain change pages, then submit pending operations by local sequence.
6. Retain acknowledged operations until the confirmed cursor includes their final accepted version.
7. Rebase all remaining optimistic operations after each confirmed change.

Offline access defaults to 30 days and can be set per company from zero through 90 days. Zero
disables offline opening. Successful authorization refreshes the grant; a new device cannot
bootstrap without a network connection. Administration of permissions, membership, integrations,
environments, and project bindings remains online-only.

## Conflict resolution

Convex commit order is the only ordering authority:

- Writes to different fields merge.
- For the same field, the later Convex-accepted operation wins.
- Client wall clocks never choose a winner.
- A stale-base overwrite records before and after values in issue audit history.
- A later delete emits a tombstone. Updating a deleted entity is rejected until an explicit
  restore.
- Fractional string order keys plus stable-ID tie-breaking make concurrent reorders deterministic.

This policy is field-wise at the domain-command boundary. It does not mean that arbitrary JSON
subtrees merge, and operations still fail when they violate current invariants.

## Issue-key leasing

Human issue keys are immutable and sequential per company. Stable domain IDs exist before keys, so
offline relationships do not depend on the display key.

While online, a client leases 25 issue numbers and requests another block when five remain. Leases
never overlap and unused numbers are never recycled; gaps are expected. A client that exhausts its
block while offline displays a local `Draft` key. Convex assigns a real key before accepting the
create operation, while the UUIDv7 issue ID stays unchanged.

## Compatibility and versioning

The protocol version is explicit in every operation and in bootstrap/change responses. Backend and
replica decoders support the current and immediately previous client protocol versions. Additive
optional fields are preferred within that window; a semantic or required-field change increments
the protocol version and supplies a migration or adapter.

The separate `SYNC_BOOTSTRAP_GENERATION` is currently 4. It changes when a complete seed contains
state that an older completed replica could have missed; generation 4 adds cloud projects. A mismatch
forces one full reseed of confirmed state on the upgraded replica while preserving its durable
outbox. Bumping it therefore creates a fleet-wide bootstrap event as upgraded clients and servers
reconnect.

An older incompatible client receives an explicit upgrade-required result before it can mutate
state. It must not fall back to the pre-cloud `issues.stream` or issue mutation RPCs, because those
paths cannot enforce the company authorization model. Local schema versions are decoded before use,
and an unknown or corrupt schema is quarantined rather than partially folded.

## Failure recovery

| Failure                                  | Recovery                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cursor predates the surviving feed       | Discard confirmed state, bootstrap in pages, then rebase the durable outbox.                    |
| Duplicate operation submission           | Return the stored receipt for `operationId`; never apply it twice.                              |
| Permission rejection                     | Remove only that operation's overlay, retain it in rejected changes, continue independent work. |
| Domain or invariant rejection            | Keep the operation and reason visible for edit, retry, or discard.                              |
| Missing or rejected dependency           | Mark dependent operations blocked; do not silently drop them.                                   |
| Authorization epoch changes              | Stop sending, purge inaccessible records, reseed, then reevaluate pending operations.           |
| Network loss during acknowledgement      | Resubmit the same operation IDs and rely on receipts for exactly-once application.              |
| Acknowledged operation not yet in cursor | Keep it durable but omit duplicate optimistic effect once its accepted result is known.         |
| Local schema cannot be decoded           | Quarantine the replica and rebuild confirmed state; preserve recoverable outbox records.        |
| Offline grant expires                    | Lock company data until a successful online authorization check.                                |

Explicit sign-out wipes the Clerk user's replicas, cached grants, pending blobs, and local
encryption keys only when the outbox is empty. With pending work, the user must sync first or
explicitly discard it. Leaving a company follows the same purge rule for data no longer authorized.

Replica-backed attachment intake is online-only today. The web composer prepares an UploadThing
upload, uploads bytes, finalizes permission-checked metadata, and only then enqueues the comment with
stable attachment IDs. Text comments can remain in the offline outbox, but the composer disables
attachments while offline; it does not retain local blob IDs for a later upload. Pending prepares
older than one hour are garbage-collected by the hourly attachment cron.

The existing tracker layout and server seams are mapped in [issue-tracker.md](./issue-tracker.md).
Cross-environment command records reuse this bounded protocol but do not carry thread content; see
[0008](./decisions/0008-cross-environment-agent-control.md).

### Agent Thread discovery

Each linked Pathway environment publishes its active and archived Agent Thread shells to the
company feed after proving that the shell's local project has an active environment binding. The
feed row keys a thread by `${environmentId}:${threadId}` so identical environment-local thread ids
cannot collide, and it carries both the owning environment and stable cloud project identity.
Startup and periodic reconciliation repair missed upserts and deletes; unchanged shells are no-ops.

The shell is deliberately redacted. It contains thread routing and list metadata, including title,
provider/model, runtime and interaction modes, branch/worktree metadata, run and request status,
timestamps, and item counts. `latestVisibleMessage` retains only its id, role, and update time.
Message text, turn items, transcript history, diffs, approvals, attachments, and file contents never
enter Convex.

A client with a company replica installs each active linked environment in the ordinary connection
registry. Until that relay session has a shell snapshot, the client renders the Convex project
bindings and Agent Thread shells. Opening a thread uses the owning environment id and local project
id, so the normal relay WebSocket becomes authoritative for thread detail and live message
streaming. A revoked registration is removed from the auto-installed catalog again.

## Remote orchestration dispatch

`delegate_task` remains local when `targetEnvironmentId` is absent. An explicit remote request may
also carry the target's local `targetProjectId`, the shared `cloudProjectId`, and a caller-supplied
single-use `connectGrantToken`. The server cannot mint that grant: `connectGrants.issue` accepts a
signed-in member actor, while the server's relay exchange produces an environment service actor.

The direct start-thread path calls the target's ordinary `orchestration.launchThread` RPC. Its
`commandId` is the environment-command id. `ThreadLaunchService` persists command receipts under
that id, so a launch that committed before its reply was lost and a later durable claimant using
the same id resolve to one thread and one set of launch side effects. The Convex fallback also uses
that value as `environmentCommands.issue.id`; identical resends are no-ops and conflicting reuse is
rejected by canonical argument comparison.

Each cloud-enabled, linked Pathway server also runs the target-side durable claimant. Discovery is
the environment-scoped `environmentCommands.claim` mutation itself, not the member-oriented list
query: the claimant asks for at most two commands with a 90-second claim, and Convex returns this
environment's oldest issued work first. Before any local side effect the claimant calls
`renewClaim({ companyId, commandId, claimGeneration, claimTtlMs })`; it renews every 30 seconds while
the work runs, abandons execution if that generation fence is refused, and finishes with
`reportStatus({ companyId, commandId, claimGeneration, state, result, error })`. Pending commands
canceled before the atomic claim are never returned. The current backend does not permit canceling
a claimed command, so there is no separate target-side cancellation transition to report; a future
backend transition surfaced as a lost/invalid claim already stops renewal and local execution.

The claimant invokes the local orchestration services directly. For `startThread`, the exact
`EnvironmentCommandId` becomes `ThreadLaunchService.launch.commandId`; message dispatch and
interrupt use it as their local command id too, with the message receipt derived as
`${EnvironmentCommandId}:message`. The same identity now spans member issuance, direct RPC,
durable claim, local receipt, restart redelivery, and terminal reporting. A reply lost after a
committed direct launch and a later Convex claim therefore converge on the existing thread, and a
server restart after local execution replays against the same receipt instead of launching twice.
Start commands resolve the target environment's active local binding from the authenticated sync
bootstrap because the current issue mutation leaves `bindingId` null; no local path is guessed.

The worker is fail-closed with the cloud-sync daemon: missing configuration, link material, or a
completed local bootstrap means it does not claim work. It runs no more than two commands at once,
waits with jitter between polls, polls quickly after successful work, and backs off further while
idle or after transport failures.

At present, `environmentCommands.issue` also accepts only a member actor. `apps/server` therefore
reports `member-cloud-authorization` as missing after direct delivery fails instead of presenting
its environment service token to a mutation that must reject it. Enabling production deferred
issuance requires a Convex authorization decision for environment actors acting on behalf of the
originating member; the routing and target idempotency seams do not require another change.
