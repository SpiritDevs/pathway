# Issue tracker

> For maintainers. Using Pathway? See [docs/user/issues.md](../user/issues.md).

The tracker behind `/issues`. Why it is shaped this way — plain tables instead of the decider,
nullable `workspaceRoot`, triage as separate state, polling instead of Socket Mode — is argued in
[decisions/0006](./decisions/0006-issue-tracker.md). This page is the map: which seam is which, and
which direction each one points.

## A plain-table domain beside the projections

The tracker's tables live in the same `state.sqlite` as the projection tables and are written
directly, not derived from orchestration events. Migrations 041–046 and 056–061 own them:

| Migration | Adds                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| 041       | `issue_statuses`, `issue_labels`, `issues`, `issue_label_assignments`, `issue_events`, `issue_tracker_config` |
| 042       | `issue_milestones`, `issue_cycles`, `issue_todos`, `issue_relations`, `issue_comments`                        |
| 043       | nullable `projection_projects.workspace_root`                                                                 |
| 044       | `issue_views`                                                                                                 |
| 045       | `issue_enrichment_runs`, `issue_thread_links`                                                                 |
| 046       | `slack_channel_watches`, `slack_cursors`, `slack_outbound_posts`, `slack_processed_messages`                  |
| 056       | ordered Slack reaction routes and the channel-level automatic-investigation default                           |
| 057       | pinned work-model choices, channel auto-assignment, and durable multi-model audit claims                      |
| 059       | the release-cycle default for watched Slack channels                                                          |
| 060       | the first-class `review` status category                                                                      |
| 061       | nullable `issue_milestones.start_date` — a milestone becomes a bar, not a point                               |

[`IssueTrackerService.ts`][tracker] is the single writer. It is a write model _and_ the change feed:
every mutation writes an `issue_events` row and publishes a diff on the same path, which is what
makes the activity feed, the audit trail for agent writes, and the undo substrate one mechanism
rather than three. Deletes are soft (`deleted_at`), as `projection_projects` already does.

Nothing here enters [`decider.ts`][decider]. That aggregate exists for the agent turn lifecycle;
issue CRUD would bury it in commands and projector cases. The precedent for a plain-table domain
that streams to clients is `authAccessStream`.

Consequence worth knowing before you design against it: the tracker is **environment-scoped**.
Connecting to another machine's server is another tracker, with its own key prefix, statuses, and
Slack configuration. There is no cross-environment read.

## Stream over WS

Clients hold one subscription, `WsIssuesStreamRpc` ([rpc.ts][rpc]), carrying the
`IssuesStreamEvent` union from [issues.ts][contracts] — 16 tagged variants (`IssueUpserted`,
`IssueDeleted`, `StatusesChanged`, `LabelsChanged`, `MilestonesChanged`, `CyclesChanged`,
`ViewsChanged`, `IssueTodosChanged`, `IssueRelationsChanged`, `IssueCommentUpserted`,
`IssueCommentDeleted`, `EnrichmentRunChanged`, `IssueThreadLinksChanged`, `ConfigChanged`,
`SlackWatchesChanged`, `SlackStatusChanged`). Stage 4 shipped 14; the last two arrived with intake.

The shape is **replay then diffs**: subscribing to the PubSub happens first, then a snapshot is
read and emitted as a synthetic prefix of `…Changed` events plus one `IssueUpserted` per issue, and
the live subscription is concatenated behind it. So there is exactly one code path on the client —
[`state/issues.ts`][webstate] folds the same events whether they came from the opening replay or
from a live write. The folds are exhaustive switches with no `default:` on purpose: a new variant
should break the build in every one of them.

Because the opening replay carries `SlackStatusChanged`, there is no client caller for the
`slackGetStatus` RPC. That is deliberate, not an oversight.

## Milestone burn-up, by backward replay

`issues.milestoneHistory` is the one tracker read the stream cannot serve: the stream carries what is
true now, and a burn-up is the past. Nothing stores that past, so [`milestoneHistory.ts`][history]
reconstructs it. The calculation is pure and DOM-free, the house pattern (`issuesList.logic.ts`,
`providerUsageDisplay.ts`); the service method only gathers rows — the milestone, the live statuses,
today's rollup members, and those members' `field IN ('status','milestone')` rows through
`IssueEvents.listByIssuesAndFields` — and calls it.

The replay runs **backwards**, from today's known-true members and categories, undoing `issue_events`
newest first. Forwards would be wrong: an issue created already assigned to a milestone writes a
`created` row with no milestone field, so a forward replay would never see it join.

The RPC returns **one point per day** (`{date, scope, started, completed}`), never raw events —
AGENTS.md names oversized websocket payloads as a known source of regressions. `started` is
cumulative and defined by exclusion (anything outside `backlog` / `unstarted` / `canceled`), so
`completed <= started <= scope`, `review` counts the day it lands, and a category added by a later
migration counts rather than silently dropping out of the series. Length is capped at
`MILESTONE_HISTORY_MAX_DAYS` (366): each day is computed from the present rather than from the day
before it, so clamping the start costs only the days it cuts and never the accuracy of the rest.

Two limitations, surfaced rather than papered over:

- **The log stores display names, not ids** (`IssueTrackerService.ts`, the `field: "status"` and
  `field: "milestone"` writes). A status renamed or deleted since is unmappable: it counts as
  unstarted and sets `approximate: true`. A renamed _milestone_ trips the same flag, because
  membership is reconstructed by comparing `before` / `after` against the milestone's current name.
  The chart renders a one-line footnote whenever the flag is set.
- **Only current members are visible.** An issue moved _out_ of the milestone is not in the member
  set and so vanishes from its own history — the series shows the shape the milestone has today, not
  the scope churn that got it there. Catching those needs a second, unindexed scan of
  `issue_events.before` across the whole table; not worth it until somebody misses it.

One asymmetry to know before trusting the two numbers side by side: the chart's `scope` counts every
rollup member, canceled included, while the `{done, total}` rollup the meters use
(`issueMilestoneProgressByMilestone`) leaves canceled out. A milestone with canceled work therefore
has a burn-up ceiling above the meter's denominator, and its completed line never reaches it.

Days are bucketed in the zone `today` was read in — the server's local one, threaded in as an input
so the function stays deterministic. UTC bucketing would have pushed this evening's work onto
tomorrow's point west of Greenwich, and tomorrow is off the end of the series, so the labelled last
point would have disagreed with the KPI tile beside it.

The series ends at today, never at the target date: an overdue milestone is what somebody opens the
chart for, and stopping at the target would hide everything finished since — all of it, for a target
that passed before the work was filed.

Milestone status (`upcoming` / `in-progress` / `completed` / `overdue`) is **derived, never stored**,
for the reason `issueCycleStatusOn` already gives: a stored copy would still read "in progress" the
morning after the milestone went overdue. `issueMilestoneStatusOn` takes a generic
`{done, total, started}` tally, so `review` counts as started-but-not-done without the contract
naming a category at all. `startDate > targetDate` is refused by the service on both create and
update, and the update check runs against the merged pair rather than the half a patch carries.

## Actor attribution

Every write on [`IssueTrackerService`][tracker] takes `(input, actor: IssueActor)`. There is no
ambient current-user; the caller says who it is.

```
IssueActor = { kind: "user" }                                  // the one human on this environment
           | { kind: "agent", provider: ProviderDriverKind }   // an MCP toolkit write
           | { kind: "system", source: "import" | "cycles" | "slack" | "automation" }
```

`user` carries no identity because this environment has exactly one person and nothing to tell them
apart by. `system` is a write the tracker made on somebody's behalf: CSV import, the lazy
carry-over when a cycle ends, Slack intake, and configured issue automation.

The actor is not decoration. It is load-bearing in two places: the activity feed renders it, and the
Slack poller uses `author.kind === "system"` as one of the two echo suppressors (below).

`IssueAssignee` is the same union minus `system`, and assignment records intent only — it surfaces
**Start work** rather than spawning a turn, so a kanban drag cannot launch three agents.

## Automation coordinator

[`IssueAutomationCoordinator.ts`](../../apps/server/src/issues/IssueAutomationCoordinator.ts) is
the effect boundary between the plain tracker and agent work. It consumes the tracker's replay-safe
stream, observes opted-in Slack issues, and writes ordinary attributed tracker commands. Routing
and audit policy live in server settings; the chosen worker model and matched rule ids are pinned on
the issue so later settings changes cannot relabel work already assigned.

Linking the first `start-work` thread moves the card to the configured work status. The seed prompt
names the configured review destination, and the worker uses the issue toolkit to move the card
there only after implementation and verification are actually complete. Entering that status is
the audit boundary; a terminal provider turn alone is deliberately not one, because intermediate
questions and follow-ups also end turns.

Every selected auditor is a read-only text-generation run over the worktree. Claims are persisted
in `issue_automation_audits` under `(issue, review trigger, rule, auditor index)`, making stream
replay idempotent. Completed claims survive a restart; running claims are released at startup so a
process interruption cannot strand a card in review. Any changes-requested verdict moves the card
back to work and queues the combined findings onto the linked thread for each configured review
worker, in order; the original worker is the fallback. The last worker returns the card to review.
All passes move it to the explicit success status or the next status in workflow order. A bounded
remediation count prevents reviewer disagreement from creating an unbounded worker/auditor loop.

## Enrichment seam

[`IssueEnrichmentEngine`][enrichment] is a `Context.Service` that owns only the _process_: spawn the
configured model read-only in the project's directory (the `codex exec --sandbox read-only` shape
from `textGeneration/CodexTextGeneration.ts`) and parse a structured result out of it.

The tracker owns the _record_ — validating the request, writing the queued `issue_enrichment_runs`
row, and turning every transition into `EnrichmentRunChanged`.

The two halves talk through an `IssueEnrichmentRunRecorder` the tracker constructs and hands over,
bound to one run (`markRunning` / `appendTranscript` / `succeed` / `fail`). **This is the direction
that matters**: the tracker requires the engine, so the engine must never reach for
`IssueTrackerService` — that cycle would mean neither layer builds. Transcript appends are batched
into publish windows because a model emits tokens faster than a panel can paint them.

Refusals (`no-project`, `rootless-project`, `in-flight`, model resolution failure) are decided by
the tracker before the engine is reached, and are **tolerant**: triage accept still succeeds, with
`enrichmentRun: null` and the refusal sentence alongside it. The web mirror in `triage.logic.ts`
models only the first two so the checkbox can be disabled with a reason; the server is the
authority and its answer is surfaced either way.

## Slack seam

Three layers, because of the same acyclicity constraint:

- [`SlackApiClient`][api] — the only thing that talks to Slack. Plain HTTPS + JSON through the
  house HTTP idiom, no SDK. Calls are serialized through a ~1/sec queue, which includes image
  downloads.
- [`SlackIntakeEngine`][engine] — the seam between intake's records and its transport:
  `testConnection`, `listChannels`, `postIssueUpdate`, `notifyWatchesChanged`. The tracker requires
  this, so it calls _back_ into the tracker's `intakeCreateIssue` / `intakeAddComment` rather than
  holding its tag.
- [`SlackIntakePoller`][poller] — requires _both_, which is exactly why it is a third layer.
  Nothing requires the poller, so the poller may require everything. It is started with
  `forkParked`.

Reading is `conversations.history` per watched channel from a stored cursor, every
`SLACK_POLL_INTERVAL_MS` (30s), woken early by `SlackIntakeSignal` when the watch set changes. Not
Socket Mode: this server sleeps, and only a cursor catches up on what it slept through. Each
channel's pass is caught on its own, so one broken channel is one broken channel.

Two subtleties that are easy to undo by accident:

- **A cursor cannot see a reaction.** Adding an emoji to last week's message does not move it. So
  channels with reaction routes get a second bounded pass over recent history
  (`SLACK_REACTION_WINDOW_SECONDS` / `SLACK_REACTION_WINDOW_MESSAGES`), floored by a
  `reaction_scan_ts` that trails the main cursor.
- **The dedupe fence is `slack_processed_messages`, not the cursor.** A cursor reset must not refile
  a channel. Relatedly, a new watch's first poll writes the cursor and files nothing.

The bot writes secrets nowhere near a log: the token lives at `<secretsDir>/slack-bot-token.bin`
(named once, in [`slackToken.ts`][token]), is read per cycle rather than at startup so a token saved
in settings starts working on the next pass, and is passed as a per-call argument — never held as
service state, never in a span or an error.

### Echo suppression

Outbound posts happen on comments and status changes only, always as a reply in the source thread,
always attributed. Nothing else crosses back. Two independent mechanisms keep the two sides from
looping, and both are real — do not delete one as redundant:

1. **Outbound → inbound.** Every post the bot makes is recorded in `slack_outbound_posts` by
   `(channelId, messageTs)` before the next cycle can read it, and the poller skips any ts in that
   registry. The record happens _after_ the post returns a ts (a ts that does not exist yet is not
   a message anything could read back); the window in between is covered by the separate
   bot-authored skip.
2. **Inbound → outbound.** A Slack reply becomes a comment authored by `system:slack`, and
   `handleCommentUpserted` returns early on any `system` author. Comment edits are also skipped —
   Slack has no notion of editing somebody else's message, so reposting would read as the person
   saying it twice.

The registry uses `DO NOTHING` on conflict. The intake ledger's processed-message upsert uses
`DO UPDATE SET issue_id = excluded.issue_id`, which is the riskier shape of the two.

## Known gaps

- **Deep backlog.** A pass walks at most `SLACK_MAX_HISTORY_PAGES` (10) pages. `conversations.history`
  is newest-first and `oldest` is an exclusive floor, so when the cap bites the cursor still jumps
  to the newest message of page 0 and the un-walked older tail is never read again. Catching up
  correctly needs an uncapped walk or a separate downward backfill cursor; the comment in
  [`SlackIntakePoller.ts`][poller] describing the next pass taking the next two thousand messages
  describes behaviour the code does not have.
- **Confirmation after a failed post.** If `chat.postMessage` fails after the issue row exists, the
  retry takes the `created: false` branch and returns before `confirmFiled`, so that issue never
  gets its confirmation reply.
- **Unbounded map.** The poller's `issueStates` gains an entry per issue seen on the stream and
  never evicts.
- **MCP coverage.** The issues toolkit includes attributed attachment reads through `issues_get`
  and `issues_get_attachment`, plus screenshot and recording evidence comments through
  `issues_comment_evidence`. There is no
  `triage_accept` / `triage_reject`, so agents can write issues but cannot work the triage queue.
- **Test composition.** `server.test.ts` still composes `SlackIntakeEngine.layerStub`; the real
  graph typechecks and is acyclic, but `SlackApiClient.layer` plus `forkParked` are never booted
  under test.
- **Milestone events.** Renames, date edits, and description edits on a milestone write no
  `issue_events` row: the log is keyed per issue, and the only milestone rows in it are
  `field: "milestone"` on an _issue_ whose assignment changed. So a milestone has no activity feed,
  and the burn-up cannot see the dates moving under it.
- **Mobile.** No issues surface at all, deliberately — the milestone settings page, overview,
  timeline, and detail page are web and desktop only, like everything else here. The RPC layer is
  shared, so the intended first slice there is read plus triage.

[tracker]: ../../apps/server/src/issues/IssueTrackerService.ts
[history]: ../../apps/server/src/issues/milestoneHistory.ts
[enrichment]: ../../apps/server/src/issues/IssueEnrichmentEngine.ts
[engine]: ../../apps/server/src/issues/slack/SlackIntakeEngine.ts
[poller]: ../../apps/server/src/issues/slack/SlackIntakePoller.ts
[api]: ../../apps/server/src/issues/slack/SlackApiClient.ts
[token]: ../../apps/server/src/issues/slack/slackToken.ts
[contracts]: ../../packages/contracts/src/issues.ts
[rpc]: ../../packages/contracts/src/rpc.ts
[webstate]: ../../apps/web/src/state/issues.ts
[decider]: ../../apps/server/src/orchestration/decider.ts
