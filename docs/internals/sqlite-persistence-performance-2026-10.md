# SQLite persistence performance, October 2026

Measured against a `VACUUM INTO` snapshot of a heavy desktop database: 2.25 GB file, 462 threads,
185,920 events, 62,525 turn items. The largest thread has 2,688 turn items. Timings are warm medians
from `node:sqlite` 3.53 on an Apple Silicon Mac under load, through the real `ProjectionStoreV2` and
event store layers.

## The event log is not legacy

`orchestration_events` (961 MB) is the live application event source. Migration 052 moved V2 events
into it. Every row has `application_event_version = 2`. Projection rebuilds replay it. The empty
tables are the V1 `projection_*` tables and `orchestration_v2_events`. Dropping the log would make
projections unrebuildable, so no cleanup path drops it.

Its size comes from full-state events. Each `turn-item.updated`, `message.updated`, and
`node.updated` event stores the whole entity. Startup compaction keeps only the latest event per
entity. On the snapshot, superseded rows since the last startup totaled about 5.5 MB, so the log is
mostly a second copy of the latest projection state. Shrinking it would require projection
snapshots, which is a separate design.

## Changes

| Path                                                            | Before                 | After                               |
| --------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| Startup projection verify, same packaged build                  | 6.05 s                 | 0.8 ms                              |
| Startup projection verify, first run of a build                 | 6.05 s                 | Same sweep (3.9 s in the after run) |
| `latestAgentSequence(thread)`, busy thread / idle thread (cold) | 40 ms / 108 ms (1.4 s) | 0.0 ms                              |
| `readAgentEvents(thread)`, 1,000 rows                           | 102–114 ms             | 1.4 ms                              |
| `readByCommandId`                                               | 103 ms, table walk     | 0.0 ms                              |
| Thread history backlog count (`threadHistoryNeedsSnapshot`)     | 36 ms                  | 0.1 ms                              |
| `getThreadShell`, largest thread                                | 7.0 ms                 | 2.0 ms                              |
| `getShellSnapshot`, 462 threads                                 | 100 ms                 | 80 ms                               |
| Streamed Codex flush (node, message, and turn item events)      | 1.5 ms                 | 1.25 ms                             |

- **Event reads.** Without `ANALYZE` statistics, SQLite read one thread's or one command's events by
  walking the `(application_event_version, sequence)` index backward through the whole log. A unary
  `+` on the version filter keeps it on `(aggregate_kind, stream_id, sequence)` or `command_id`.
  `commitCommandIfThreadSequence` and `commitRejectedCommand` run this inside their write
  transactions, which block every other statement on the single connection.
- **Startup verify.** Whether a stored projection decodes changes only when the code changes.
  Migration 077 adds `orchestration_v2_projection_metadata.decode_verified_build`. After a clean
  decode sweep, a packaged build records `<version>+<channel>` there and skips the sweep on later
  startups. Rows written since then were encoded by the same build. Another build records its own
  name only after it sweeps. Source runs have no build name, so they always sweep. Incompatible
  projection schema changes still bump `ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION`. Structural
  checks, including sequence, schema version, and thread membership, still run on every startup.
- **Live shell.** Every connected shell stream calls `getThreadShell` for each active thread in each
  50 ms window. Migration 076 adds partial indexes for its pending-background and pull-request item
  lookups. These previously filtered every item of the thread. Their `WHERE` clauses must match
  the `ProjectionStore` queries exactly. A `CROSS JOIN` makes the `last_error` subquery start from
  the thread's session bindings instead of every session of the provider instance.
- **Turn item positions.** Updating an already placed item now takes one lookup instead of three
  statements.
- **PRAGMAs.** `synchronous = NORMAL` is corruption-safe in WAL and stops each commit from waiting
  on an fsync. It made no measurable difference on macOS APFS, where SQLite's fsync is cheap, but
  helps on Linux hosts. `cache_size = -32768` (32 MB) replaces the 2 MB default. `mmap_size` was
  measured and left off because it made no difference.

Migrations 076 and 077 took 0.86 s together on the snapshot, once.

## Left alone

- Streamed text writes the full entity again on each 50 ms flush. The snapshot showed about 1.3 ms
  per flush and little superseded data, so append-only deltas were not worth a schema change.
- Each event's projection write re-encodes the thread row to bump `updatedAt`. That is three encodes
  per flush. Coalescing them would need a batch `apply` API.
- `getShellSnapshot` still spends about 15 ms counting items per thread and most of the rest decoding
  thread payloads.
- `PRAGMA optimize` and `ANALYZE` were not enabled. Several indexes were shaped for the planner
  without statistics, so turning statistics on needs its own plan audit.
- `cloud/agentTimeTrackingStore.ts` filters `orchestration_events` by `stream_id` without
  `aggregate_kind = 'thread'`, which scans the whole log. That file is outside this change.
