# Durable thread submission

Convex owns pending thread intent and ordered user submissions. The environment owns execution and
full conversation history. Cloud queue identity is a stable `queueId`. Initial lookup includes company, environment, and
thread ID; reassignment preserves `queueId`, so equal thread IDs on different environments remain
distinct. Existing environment-published `agentThreads` shells remain the discovery
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
Each message retains its issuer, whose authorization is rechecked before initial acceptance.
Accepted deliveries retain access to receipt reconciliation if permissions or project bindings
subsequently change. Issuers can still read and safely cancel their own saved work after losing
dispatch permission.

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
can then cancel the rejected head or increment its delivery attempt while retaining the same message and thread identity.
Unknown outcomes keep the original delivery identity. Retrying a canceled message appends it to
the queue, so it cannot preempt a later message already accepted by the environment.

A move is available only for unaccepted launches. It updates all pending submissions atomically,
requires a binding to the same cloud project, and explicitly selects the destination model. Local
worktree paths are not portable. Existing conversations are not movable through this queue.

## Visibility and startup latency

Pending submissions are presented by the ordinary conversation timeline and composer. Clients
adapt queue metadata into their existing thread view model while the environment shell is absent,
then reconcile messages by stable message ID as environment history arrives. Queue state adds
delivery status and recovery actions to that view; it does not select a separate conversation UI.
Registered destination metadata supplies offline model and workspace context without requiring an
environment connection before composing.

Client draft cleanup waits for a thread that is actually visible in the company-scoped sidebar,
not merely a raw environment shell. Queue placeholders remain until the canonical shell is
available. The cloud publisher subscribes to live events while initial and periodic reconciliation
run independently, closing the former startup window that could postpone new shells until the
15-second reconciliation interval. Snapshot scans re-read each shell under the live publication
mutation lock; reconciliation also refreshes the ID set before removing cloud rows.

The useful latency boundaries are local persistence, cloud enqueue acknowledgement, environment
acceptance, local durable delivery, shell publication, and provider start. Provider startup time
must not be reported as thread creation time.

## Boundaries

Queued prompts and attachments are cloud content; full environment conversation history is not
replicated by this feature. Reactive listings paginate actionable entries and retain delivered
summaries for seven days after their published shell is available. Delivered entries without a
replacement shell remain discoverable. Older delivered records and receipts remain available for
direct reconciliation without subscribing every client to the entire delivery history.

Roll out the Convex schema/functions, then environment workers, then clients. Old clients using
direct environment submission are outside cloud queue ordering; update every active surface before
relying on cross-device ordering. Local, relay and tunnel connections share the same cloud queue;
the transport used to read a running conversation does not change delivery ownership.

## Preview data migration

Deploy the backend before updated clients. For a preview deployment containing queue rows from
before the listing-expiration index, run `vp exec convex run threadQueue:migrateListing '{}'`
from `packages/backend` against that deployment. The internal migration backfills 128 rows per
batch and schedules the remaining batches. Existing message ownership and receipt identities are
preserved; ambiguous legacy lookups require a destination or stable queue ID.
