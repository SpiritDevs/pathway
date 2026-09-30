# WebSocket wire budget

What the server sends for the shell and thread subscriptions, how often, and
which paths are sized to stay cheap. Numbers come from a copy of a real desktop
install (477 active threads, 8 projects, a 2,688-item thread) measured on
2026-10-01.

## Delivery model

- Every RPC stream is delivered as `Chunk` frames. The client acks each chunk
  before the server writes the next one, so a slow client applies backpressure
  per stream. Live streams read from PubSub subscriptions with `takeAll`. Events
  that arrive while an ack is pending go out together in the next frame, which
  makes bursts coalesce to one frame per round trip.
- Each socket encodes its own frames. Two clients watching the same thread each
  pay one JSON encode per event. That is cheap next to the snapshot costs below.
- The PubSub behind thread events is unbounded. A client that stops acking holds
  its backlog in server memory. Delivery never stalls the orchestrator.

## Thread subscription (`orchestration.subscribeThread`)

- Live updates are domain events, not projections. Each `turn-item.updated`
  carries the whole item, so a streaming assistant message resends its text so
  far on every provider flush. Codex, for example, flushes every 50 ms.
- A resume with `afterSequence` replays only the missing events. The resume
  target check is a single-row existence query
  (`threadProjectionExists`, `apps/server/src/orchestration-v2/ThreadHistory.ts`).
  It no longer assembles the thread shell inside a transaction.
- A history page (`history: { limit }`) pages the turn items, and the
  orchestrator narrows `nodes`, `attempts` and `providerTurns` to what the
  following reference (`narrowHistoryPageSupport`):
  - the page's items and their node ancestry
  - subagents, plans and runtime requests
  - non-terminal work
  - the latest run

  Clients merge these arrays by id across pages, and live events upsert ids the
  client does not hold yet. The latest 50-item page of the 2,688-item thread
  went from 4.67 MB to 2.03 MB (2,472 nodes down to 111).

- `runs`, `providerThreads`, `checkpoints`, `checkpointScopes`, `subagents` and
  `contextTransfers` still ship whole. Web code reads them thread-wide: the
  Agents panel, the Diff panel turn list, relationship edges, latest and queued
  run state, and edit baselines.

## Shell subscription (`orchestration.subscribeShell`)

- The full shell snapshot is about 1.23 MB for 477 threads, roughly 2.6 KB per
  thread shell. A `thread.updated` delta is one shell. Deltas are coalesced per
  thread over 50 ms, and every domain event bumps the thread's `updatedAt`. A
  streaming thread therefore produces up to one shell delta per window.
- Initial frames:
  - A fresh subscribe sends the authoritative snapshot. When some repository
    identities have resolved, it also sends a marked copy of the snapshot
    (`resolvedRepositoryIdentityRoots`).
  - A resume (`afterSequence` within the replay window) sends only the marked
    copy. Clients merge it as a replacement when it is newer than their cache,
    and as an identity patch at the same sequence. That is what the old
    unmarked-plus-marked pair produced. One consequence: at the same sequence
    the resume no longer overwrites client drift that no event explains.
    Clients that predate the marker treat the frame as authoritative.
  - Result per resume: 2.46 MB before, 1.23 MB after.
- Enrichment refreshes: project enrichment re-resolves each root when its cache
  expires and republishes the result even when nothing changed. Each
  subscriber tracks the identities it already delivered, and only a changed
  identity reloads the shell and sends a marked snapshot
  (`enrichmentRefreshes`, `apps/server/src/orchestration-v2/ShellStream.ts`).
  Before this change, every re-resolution cost each subscriber a full shell
  load (about 145 ms p50) plus a 1.23 MB frame. The live traces showed 68 of
  these within 44 minutes on one desktop.
