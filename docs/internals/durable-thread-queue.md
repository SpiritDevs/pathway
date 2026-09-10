# Durable thread submission

Convex owns pending thread intent and ordered user submissions. The environment owns execution and
full conversation history. Cloud queue identity is company plus thread ID, independent of its
current destination. Existing environment-published `agentThreads` shells remain the discovery
read model for accepted threads.

Clients persist an account-scoped outbox entry and attachment bytes before making network requests.
They upload attachments to Convex storage, register validated metadata, then enqueue the submission
with stable command and message IDs. A failed or uncertain enqueue keeps the local entry. An
acknowledged cloud write is distinguishable from local persistence in the UI.

The queue is a dedicated authenticated subscription, not transcript replication through the
company change feed. List queries expose summaries; opening a queue loads message content. Human
queries keep unpublished conversations private to the issuing membership. Published conversations
share their queue under existing environment read and dispatch permissions; controls require
environment control permission. Environment requests are restricted to their registered destination.
Each message retains its issuer, whose authorization is rechecked when queued work is accepted.

## Delivery and ownership

`environmentHead` subscriptions wake the environment worker on changes and reconnect. Only the
first outstanding submission in each thread is eligible. A read-only `prepare` supplies the payload
and cloud attachment URLs so prerequisites can be checked without claiming execution ownership.
Atomic `accept` rechecks the destination and revision after preparation. Reassignment, edits,
cancellation and acceptance therefore cannot succeed against the same stale version.

Acceptance is sticky. There is no expiring lease that can authorize another environment while a
previous owner might already be executing. The worker reuses stable orchestration command IDs and
receipts after a crash or lost acknowledgement. It acknowledges delivery only after the launch or
message is durably persisted locally; workspace preparation and provider startup run afterward.
A failure after acceptance retains ownership and becomes actionable rather than releasing a
possibly executing submission for reassignment.

A durable rejection receipt proves that a particular delivery did not execute. An explicit retry
can then increment its delivery attempt while retaining the same message and thread identity.
Unknown outcomes keep the original delivery identity. Retrying a canceled message appends it to
the queue, so it cannot preempt a later message already accepted by the environment.

A move is available only for unaccepted launches. It updates all pending submissions atomically,
requires a binding to the same cloud project, and explicitly selects the destination model. Local
worktree paths are not portable. Existing conversations are not movable through this queue.

## Visibility and startup latency

Client draft cleanup waits for a thread that is actually visible in the company-scoped sidebar,
not merely a raw environment shell. Queue placeholders remain until the canonical shell is
available. The cloud publisher subscribes to live events while initial and periodic reconciliation
run independently, closing the former startup window that could postpone new shells until the
15-second reconciliation interval.

The useful latency boundaries are local persistence, cloud enqueue acknowledgement, environment
acceptance, local durable delivery, shell publication, and provider start. Provider startup time
must not be reported as thread creation time.

## Boundaries

Queued prompts and attachments are cloud content; full environment conversation history is not
replicated by this feature. Queue metadata and delivered submissions are retained for reconciliation
and recovery. A future retention policy must preserve retries and must not recreate the handoff
gap by deleting a summary before a client receives its replacement. The metadata list currently
retains delivered rows, so pagination/retention needs review as usage grows.

Roll out the Convex schema/functions, then environment workers, then clients. Old clients using
direct environment submission are outside cloud queue ordering; update every active surface before
relying on cross-device ordering. Local, relay and tunnel connections share the same cloud queue;
the transport used to read a running conversation does not change delivery ownership.
