# Glossary

> For maintainers. Using Pathway? See [docs/user](../user/).

This is a living glossary for Pathway. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Model Context Protocol](#model-context-protocol)
- [Checkpointing](#checkpointing)
- [Issue tracker](#issue-tracker)
- [Identity and onboarding](#identity-and-onboarding)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Model Context Protocol

#### Multi-round-trip request (MRTR)

An MCP `2026-07-28` request that can pause with `input_required`, let the client satisfy embedded input requests, and resume with opaque request state. Pathway currently advertises the protocol capability but does not use MRTR for email waits; email waits use MCP tasks instead.

#### MCP task

A durable, client-declared extension result for work that outlives one HTTP response. Pathway uses `io.modelcontextprotocol/tasks` for `email_wait_for`: the initial tool call returns full task state, `tasks/get`, `tasks/update`, and `tasks/cancel` manage it, and task updates can arrive on a subscription stream.

#### `subscriptions/listen`

The MCP `2026-07-28` POST operation that opens a stateless SSE notification stream. The first event acknowledges the exact filters the server accepted. Pathway only sends opted-in notification types, including email inbox resource updates and task-state updates.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Issue tracker

The plain-table domain behind `/issues`, written directly rather than derived from orchestration
events. See [issue-tracker.md][25] and [decisions/0006][26].

#### Issue key

The durable public name of an issue, `PAT-12`. One configurable prefix per environment with one
counter, in `issue_tracker_config`. Project is a separate field, so a key survives a move between
projects, and renaming the prefix does not rewrite keys already minted. Contrast **issue id**, the
internal row identifier that never appears in the UI.

#### Milestone

A named checkpoint **inside one project** (`projectId` is required), with an optional start date and
target date. Contrast a **cycle**, which spans everything and is a date range by definition: a
milestone is scope-boxed, a cycle is time-boxed. Its progress and its status
(`upcoming` / `in-progress` / `completed` / `overdue`, via `issueMilestoneStatusOn`) are always
**derived from its issues' status categories and today**, never stored. Its past is not stored
either — the burn-up is replayed backwards out of `issue_events` on demand. See
[issue-tracker.md][25] and [decisions/0006][26].

#### Triage

State outside the workflow, not a status and not a seventh status category. A triage item is an issue
with `triage` set and no meaningful status presence: it is excluded from every tab, board, and count
(`countTriageIssues` and `groupIssuesForTab` in [state/issues.ts][29] both filter it). **Accepting**
assigns status, project, and priority in one action and optionally fires enrichment; **rejecting**
is a soft delete that leaves `triage` set, so restoring returns it to the queue rather than to the
workflow. Slack intake is what fills it. See [IssueTrackerService.ts][27].

#### Enrichment run

One read-only investigation of an issue, owned by a row in `issue_enrichment_runs`: state, streamed
transcript, structured result, model, duration. The record belongs to the tracker and the process
belongs to [IssueEnrichmentEngine.ts][28], which reports back through a recorder bound to that run.
Deliberately **not a thread**, which is why threads needed no `hidden` flag. Fires on triage accept
and from the manual Investigate button, never on import.

#### Comment agent run

One agent run dispatched by mentioning an agent in an issue comment — `[@Claude](mention:agent:…)`.
Unlike an enrichment run it has **no table and no stream event of its own**: the whole record rides
its origin comment as the optional `agentRun` field and republishes through `IssueCommentUpserted`,
because a new `IssuesStreamEvent` tag would break older remote clients at decode. Same engine seam
as enrichment (`IssueCommentAgentEngine`, recorder-bound, never importing the tracker), but with
`canceled` as its own terminal state, retry-as-fresh-run, and the reply landing as an ordinary
attributed comment recorded on the run as `replyCommentId`. Dispatch is user-composer-only. See
[IssueTrackerService.ts][27] and [issue-tracker.md][25].

#### Thread link

One row of `issue_thread_links`: exactly one row per issue and thread pair, carrying the origin that
pair was created with — `start-work`, `manual`, or `mention`. Linking the same pair again keeps the
**strongest** origin (`start-work` > `manual` > `mention`) rather than overwriting it, so a mention
can never demote the link automation reads. `mention` links are written by the `IssueMentionLinker`
reactor from issue keys found in completed messages and validated against real issues; the other two
are explicit, from **Start new thread** and from the issues toolkit. Only `start-work` drives
automation — a `mention` is provenance. See [IssueTrackerService.ts][27] and [issue-tracker.md][25].

#### Rootless project

A project whose `workspaceRoot` is null — created from a name alone, with no directory attached. It
stays **visible everywhere**; a surface that genuinely needs a path prompts for one just in time and
then continues the original action. Enrichment is the one feature that simply refuses
(`rootless-project`), because there is nothing to read. See [decisions/0006][26].

#### Watch

One row of `slack_channel_watches`: a Slack channel the poller reads, its trigger combination
(emoji, every message, bot mention — any combination, all off meaning paused), and the project
and release cycle filed issues are tagged with. Distinct from the **cursor** (`slack_cursors`),
which is where reading resumed from, and from the **outbound registry**
(`slack_outbound_posts`), which is how the poller recognises the bot's own messages. See
[issue-tracker.md][25].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

### Identity and onboarding

Terms below describe this fork, where an account is required to open the app. Upstream Pathway
treats identity as an optional Pathway Connect concern. See [decisions/](./decisions/).

#### Account

The Clerk user. The only identity in the system, and the first user-scoped thing in a codebase
that is otherwise environment-scoped or client-scoped. Distinct from an **environment**, which is
a machine and its state, and from a **client**, which is one installed app. One account spans many
of each.

#### Auth gate

The single decision about whether a visitor may reach the app, made by
`resolveClerkAuthGateState` in `apps/web/src/components/clerk/authGate.logic.ts`. It has five
outcomes — `authenticated`, `loading`, `onboarding` (signed in, profile incomplete), `public`,
`redirect`. Not to be confused with the **primary
environment auth gate** (`resolveInitialServerAuthGateState`), which decides whether this client
may talk to a Pathway server. The two are independent: being signed in says nothing about being paired
to a server.

#### Profile

The user-scoped record of display name, avatar, account kind, and survey answers. Lives on the
Clerk user — native fields plus `unsafeMetadata` — not in `settings.json` and not in
localStorage, both of which are per-machine. See
[decisions/0003](./decisions/0003-profile-in-clerk-user.md).

#### Account kind

The discriminant of the profile: `individual` or `company`. Chosen in onboarding, and it selects
which branch of the step graph runs. A sum type, not a flag — the fields that follow differ
entirely by branch.

#### Onboarding

Ambiguous in this codebase; always qualify it.

**Profile onboarding** is the blocking, resumable stepper at `/onboarding` that collects the
profile after registration ([decisions/0004](./decisions/0004-onboarding-stepper.md)).

**Connect onboarding** is the pre-existing post-sign-in wizard in
`apps/web/src/components/cloud/ConnectOnboardingDialog.tsx` that publishes an environment and
connects devices. It runs inside the authenticated shell, so profile onboarding always precedes
it.

#### Company

An organization the account belongs to, modelled as a Clerk organization. Has identity and
membership independent of whoever created it. In v1 membership grants nothing — no shared
billing, visibility, or data — which is what makes email-domain matching an acceptable way to
offer it. See [decisions/0005](./decisions/0005-company-via-clerk-organizations.md).

#### Domain auto-join

Planned, not yet implemented (ships with the organizations change; see
[decisions/0005](./decisions/0005-company-via-clerk-organizations.md)). Offering a registering
user membership in an existing company when their verified email domain matches its verified
domain. Always **offered and opt-in**, never applied silently. Free and disposable mail domains
will be excluded, a check that only means anything server-side.

#### Pending session

A Clerk session that is authenticated but has an outstanding task, such as selecting an
organization. Eleven non-test call sites pass `treatPendingAsSignedOut: false` to keep such a
session from reading as signed out — including the auth gates themselves; enabling organizations
is what makes that state common rather than rare, and each site needs a deliberate answer before
that change lands.

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]
- [Issue tracker][25]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ./issue-tracker.md
[26]: ./decisions/0006-issue-tracker.md
[27]: ../../apps/server/src/issues/IssueTrackerService.ts
[28]: ../../apps/server/src/issues/IssueEnrichmentEngine.ts
[29]: ../../apps/web/src/state/issues.ts
