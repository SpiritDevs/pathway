# Cloud database I/O

The September 21, 2026 production incident exhausted the Convex team's spending
limit and disabled its deployments. The supplied usage snapshot attributed
154.44 GB of database I/O to Pathway, including 54.94 GB to
`agentThreads.reconcile`, 44.88 GB to `aiOrchestratorControls.environmentInbox`,
and 10.07 GB to `threadQueue.destinations`. Production Health insights for the
preceding 72 hours also reported 3,437 retried OCC events involving
`environmentRegistrations`; repeated claim writes were among the examples.

## Publisher reconciliation

Environment publishers send their current thread and captured-email IDs every
15 seconds. Reconciliation previously read every published document on every
tick, including large shell and message payloads, even when no IDs changed.

Each environment registration now stores an optional fingerprint and completion
time for each inventory. Authorization still runs on every invocation. An
unchanged inventory skips the full scan for five minutes. A changed inventory
scans immediately. A missing checkpoint also scans immediately, so existing
registrations need no data migration. A checkpoint is saved only when fewer
than 100 stale records remain in the current deletion batch; larger removals
continue draining on subsequent ticks. Periodic scans repair missed events.

These checkpoints are storage-only and do not advance the company change feed.
Thread and email upserts still publish ordinary content changes immediately.
Binding lookups use company, environment, and local-project index keys instead
of reading every binding on the environment.

The server's project publisher similarly skips unchanged metadata for five
minutes. Changed metadata publishes immediately, failed calls remain retryable,
and release clears the cache. Unbound projects refresh periodically so remote
assignment still converges. This part requires an updated environment server.

## Worker inbox and registration writes

An inbox request for one thread reads that thread and pending launches without
a thread ID, preserving launch cancellation recovery. It no longer reads the
environment's unrelated active and recent work. The broad inbox subscription
retains its existing active, recent, and pending selection.

Both forms reuse repeated chat, orchestrator, audience, and permission reads
within the current transaction. Sequence boundaries are still checked for each
work item, and later transactions always recheck current grants.

Claim calls publish worker-catalog changes immediately. Unchanged catalogs renew
once a minute, within the existing two-minute freshness window, instead of
rewriting their timestamp every poll. This reduces invalidations and contention
on the registration documents read by inboxes, destinations, and authentication.

## Destination and command reads

Queue destinations load active bindings, the projects those bindings reference,
and provider capabilities for active registrations. Revoked bindings, unrelated
projects, and capabilities for unregistered environments are excluded before
their documents are loaded. Command claims use company, target environment,
and state together in the index rather than filtering another company's rows.

## Validation and rollout

Focused regression tests use real `convex-test` database transactions with read
instrumentation. They cover idle and changed inventories, deletion batches,
periodic repair, current permissions, targeted inbox selection, launch stops,
shared authorization reads, destination metadata, catalog renewal, and server
publisher retry behavior. Document counts and serialized bytes in these tests
are regression indicators, not measurements of Convex's billed I/O.

The six affected test suites pass 258 tests. Backend and server typechecks and
targeted lint pass. The production deployment dry run validates the schema and
index changes; it does not activate the fix.

| Regression fixture                                                         | Observed reads after the fix                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unchanged inventory with 300 published threads or emails                   | No inventory documents; total returned document bytes below 5% of the initial scan |
| One targeted thread with 100 unrelated pending work records                | At most three work-record reads, including pending launch cancellation             |
| 21 work records sharing one conversation                                   | One conversation read; fewer than 15 company reads                                 |
| 100 projects with 99 revoked bindings and 100 unregistered capability rows | One binding and one capability record; under 25 KB of returned documents           |

Deploy the backend schema and functions together; the indexes use existing
fields and checkpoints are optional. Existing clients benefit from the backend
changes without a wire-contract change. After deployment and restoration of the
spending allowance, compare database bytes and calls over equal active periods
for the functions above, and check OCC insights again. Cumulative monthly totals
will not fall. Production savings remain unverified until this comparison runs.

## Second pass: conversation lists and idle mail claims

This pass implements the first two follow-up opportunities. Heartbeat isolation,
worker wakeups, and compact queue headers remain separate work.

`aiOrchestrators.listChats` now skips unread-history and notification reads for
muted conversations, retains their current preview, and reuses the latest message
when it is also the notification source. Unmuting still counts the same unread
history; mute does not mark messages as read. Company-access checks are shared
across conversations within a single request, with current permissions checked
again on the next request. General unread scans for unmuted conversations remain;
compact unread metadata would require a separate design and compatibility plan.

`mailJobs.claim` now writes `lastClaimAt` when an account actually claims work.
The timestamp still advances for visited accounts in a group larger than the
25-account scan window, so accounts beyond that window remain reachable. Each
primary and backup query reads one extra account to detect overflow. Complete
idle groups no longer write timestamps; claim timing, lease expiry, backup
eligibility, and the ten-second polling interval are unchanged.

### Measured reductions

Identical local `convex-test` fixtures were run against saved pre-change functions
and the new functions. Conversation results were compared for equality. Mail
workers were staggered five seconds apart, with each worker polling every ten
seconds, to count real timestamp changes rather than simultaneous no-op patches.

| Fixture                                                                    | Before                                               | After                                       | Reduction                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| One muted conversation, 500 coordination messages of 2,000 text characters | 501 message reads; 1,158,079 total document bytes    | 1 message read; 3,211 bytes                 | 99.7% of returned document bytes                       |
| 20 conversations in one company                                            | 20 company + 20 membership reads; 27,069 total bytes | 1 company + 1 membership read; 13,902 bytes | 95% of those authorization reads; 48.6% of total bytes |
| One idle mail account, primary and backup polling for one minute           | 12 timestamp patches                                 | 0 patches                                   | 100% of idle bookkeeping writes                        |
| 25 idle mail accounts, primary and backup polling for one minute           | 300 timestamp patches                                | 0 patches                                   | 100% of idle bookkeeping writes                        |

At a ten-second idle polling interval, this removes up to 8,640 account timestamp
writes per day per worker for each account in a complete group. The muted-history
fixture avoids approximately 1.15 GB of returned document bytes per 1,000
comparable list executions. These are workload-conditional estimates, not a
forecast for the entire deployment or a measurement of billed database I/O.

The supplied production snapshot assigned 2.50 GB to `listChats` and 2.52 GB to
`mailJobs.claim`. Those totals also include necessary reads and active work, so
it would be incorrect to claim all 5.02 GB is eliminated. Reduced subscription
invalidations and retries may save additional I/O elsewhere, but are not measured
by the local fixtures. In particular, mail polling reads are largely unchanged.

Validation: 182 focused conversation and mail tests pass, including newly arrived
mail, primary/backup failover, account 26 beyond each scan window, unread counts
after unmuting, and membership revocation. Two additional before/after fixture
comparisons pass. Backend typechecking and targeted lint pass. No new schema
fields, indexes, or client changes are required for this second pass.
The combined production deployment dry run also passes; the changes have not
been activated in production.

## Deferred opportunities

- **Heartbeat invalidations:** registration documents still combine authority,
  capabilities, catalogs, and frequently changing presence timestamps. Splitting
  presence and catalog data from authority would reduce both read size and
  subscription invalidations. This spans several writers and readers and needs
  an explicit compatibility and migration plan.
- **Worker polling and queue headers:** claims and pending-inspection checks
  continue every ten seconds while idle. Lightweight work-availability wakeups
  need timed recovery for lease expiry and delayed work. Queue head subscriptions
  read complete queued messages to return a handful of IDs; compact delivery
  metadata could avoid repeatedly loading prompt bodies. Both changes need
  coverage for reconnects, retries, and older stored records.

Convex's [performance guidance](https://docs.convex.dev/understanding/best-practices/)
explains why indexed ranges and smaller subscription read sets matter.
