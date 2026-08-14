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
operation receipts remain available for 90 days.

`sync.listChanges` filters every payload against current company and team authorization. It advances
the cursor even when every change in the scanned range is filtered out; otherwise a client without
access to those records would stall permanently. Unauthorized payloads are never returned merely to
explain a version gap.

Each change page includes the company's current authorization epoch, and the authenticated bootstrap
path returns the epoch associated with its snapshot. Membership, role, team, and other visibility
changes increment it. On an epoch change, the client stops trusting the old permission-filtered
replica, purges records no longer visible, and performs the required permission-aware reseed. An
epoch is not a substitute for checking every query and mutation at the backend.

A cursor older than the retained feed is expired. The client discards its confirmed replica and
performs a full paginated bootstrap. Pending operations remain in the outbox and are rebased over
the new confirmed snapshot before submission.

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

An older incompatible client receives an explicit upgrade-required result before it can mutate
state. It must not fall back to the pre-cloud `issues.stream` or issue mutation RPCs, because those
paths cannot enforce the company authorization model. Local schema versions are decoded before use,
and an unknown or corrupt schema is quarantined rather than partially folded.

## Failure recovery

| Failure                                  | Recovery                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cursor predates the 90-day feed          | Discard confirmed state, bootstrap in pages, then rebase the durable outbox.                    |
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

Offline attachments keep local blob IDs in optimistic comments. On reconnect the client obtains an
authorized upload URL, uploads directly, finalizes permission-checked metadata, rewrites the pending
comment to the stable attachment ID, and only then submits it. Upload and finalize retries are
idempotent; unattached uploads are garbage-collected.

The existing tracker layout and server seams are mapped in [issue-tracker.md](./issue-tracker.md).
Cross-environment command records reuse this bounded protocol but do not carry thread content; see
[0008](./decisions/0008-cross-environment-agent-control.md).
