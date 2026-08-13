# 0006 — Issue tracker on /issues

Status: Accepted
Date: 2026-08-12
Shipped: stages 1–5, 2026-08-12. The staging section below is history; what actually landed and
where the seams are is [issue-tracker.md](../issue-tracker.md).

## Context

`/issues` is a placeholder. `apps/web/src/routes/issues.tsx` renders `PlaceholderWorkspacePage`
and `apps/web/src/components/issues/IssuesSidebar.tsx` is a 23-line stub whose copy promises
"issue filters, projects, and saved views". This record fills that promise with a Linear-shaped
tracker, and pins the choices that were not obvious.

Pathway already has most of the machinery. Persistence is Effect + SQLite under
`apps/server/src/persistence` with numbered migrations. Plain-table domains that stream to clients
already exist (`authAccessStream`, `packages/contracts/src/rpc.ts:938`), so a new domain does not
have to enter the orchestration decider. Manual ordering by fractional string key is already the
house pattern (`pin_order_key`, migration 038). `@dnd-kit/*`, `@legendapp/list`, and `lexical` are
already dependencies. `CodexTextGeneration.ts:189` runs `codex exec --sandbox read-only` in a
project `cwd`, which is exactly the shape needed to have a model investigate a repository.

The load-bearing tension is that Pathway's `project` is an environment-local record rooted at a
directory (`ProjectCreatedPayload.workspaceRoot: TrimmedNonEmptyString`), while a tracker wants a
planning container you can create by typing a name.

## Decision

### Where the data lives

New plain SQLite tables in the Pathway server's `state.sqlite`, alongside the projection tables. Not the
orchestration decider: that aggregate exists for agent turn lifecycle, and issue CRUD would drown
it in commands and projector cases. Clients read through a new RPC group in
`packages/contracts` and stay live through a stream RPC modelled on `authAccessStream`.

The tracker therefore belongs to the environment you are connected to. Connecting to a different
machine's server shows a different tracker. Accepted: there is no product database in this repo,
only Clerk identity and the relay, and building one is a larger project than the tracker.

Every mutation writes an `issue_events` row recording actor, field, before, and after. This is the
activity feed, the audit trail for agent writes, and the undo substrate. Deletes are soft
(`deleted_at`, as `projection_projects` already does).

### Projects

One Projects concept, not two. `workspaceRoot` becomes nullable so a project can be created from a
name alone, and a directory (and git) attached later.

A rootless project stays **visible everywhere**. When one is selected somewhere that needs a path —
the thread composer, git actions, file explorer — a modal prompts for directory and git setup and
the original action continues once it is set. Just-in-time promotion rather than hiding.

This is the largest piece of collateral work in the plan: 421 non-test references to
`workspaceRoot` across web, mobile, and server. Widening the type to `string | null` makes the
compiler enumerate them. The path-uniqueness invariant (`commandInvariants.ts:81`) must skip nulls.
`repositoryIdentity` is already optional, so "git optional" is largely true today.

### Entities

- **Issue** — key, title, description, status, priority, assignee, project, milestone, cycle, due
  date, `parent_id` (hierarchy, depth capped at 3), `sort_order` fractional key, `triage` state,
  soft delete.
- **Issue key** — one configurable prefix per environment with one counter (`PAT-1`, `PAT-2`).
  Project stays optional on an issue and keys survive a move between projects. This mirrors Linear,
  where the prefix comes from the team and project is a separate field.
- **Todos** — lightweight checklist rows on an issue (text, done, order). Distinct from sub-issues,
  which are real issues with their own status and roll up as `3/9`.
- **Labels** — flat, coloured, create-on-the-fly.
- **Relations** — blocking / blocked-by / related / duplicate, stored as directed pairs with
  inverses materialised.
- **Milestones** — named checkpoints with optional target dates, belonging to a project.
- **Cycles** — manually created named date ranges spanning everything. On end, unfinished issues
  move to the next cycle if one exists, otherwise to no cycle; the completed set freezes. No
  scheduler: this server sleeps.
- **Comments** — Lexical composer (`ComposerPromptEditor`) in, `ChatMarkdown` out. Attachments reuse
  the existing store with the id namespace widened to accept an issue segment alongside the thread
  segment, images-only for now.

### Statuses

Configured once per environment. Each status has name, colour, position, and one of six
categories: `backlog`, `unstarted`, `started`, `review`, `completed`, `canceled`. The category — not a
hand-maintained list — is what drives the Active/Backlog/All tabs, milestone and sub-issue progress
rollups, and what an agent means by "complete".

**Triage** is deliberately _not_ a status or a seventh category. It is separate state outside the
workflow: a triage item has no status, appears in no board or count, and accepting it assigns
status, project, and priority in one action.

### Views

- **List** (primary) — virtualized with `@legendapp/list`, grouped by status with collapsible
  headers and counts, `j`/`k` navigation, inline property popovers on the row, shift-click range
  select, bulk actions on the selection.
- **Kanban** — columns are statuses, nothing else. Dragging within a column reorders; dragging
  across sets status and position in one write. Grouping in the list view is a read concern and can
  vary; ordering is one column.
- **Detail** — opens in `RightPanelSheet` at `/issues?issue=PAT-221`, keeping the list visible for
  triage. No separate full-page layout.
- **Filters** — chip bar (status, project, milestone, cycle, label, assignee, priority, due date).
  OR within a chip, AND across chips, no nesting or negation. Current filter + grouping + sort saves
  as a named view.
- **Left sidebar** — Triage (with pending count), My issues, Projects (expanding to milestones),
  Cycles, Labels, Saved views.

### Agents

Agents are first-class here. A new `issues` MCP toolkit follows
`apps/server/src/mcp/toolkits/preview/` (`tools.ts` + `handlers.ts`, registered as a Layer in
`McpHttpServer.ts`), so every provider adapter gets it.

Agents have **full write access, including completing and deleting**. Soft deletes and the
`issue_events` log are what make that recoverable; there is no approval gate.

Issue reads preserve attachment ownership: the structured result has an issue-level attachment
list and attachment ids on each complete comment, while the MCP response includes a bounded set of
actual image content blocks. Each image is labelled with its source comment body, author, and
timestamp. `issues_get_attachment` retrieves any listed image individually, so the eager response
can remain bounded without making later attachments inaccessible.

Browser verification is written through `issues_comment_evidence`. Screenshots cross the existing
Preview snapshot response. Recordings stay in the desktop artifact directory until the issue tool
reads them in bounded chunks over the Preview broker, caps them at 25 MB, and copies them into the
environment attachment store. This keeps evidence remote-safe without putting one large recording
inside a WebSocket frame. Issue comments remain the owner, and the issue attachment shelf remains
the aggregate view of those comment attachments.

Agents can be assignees. Assignment records intent and surfaces a "Start new thread" action that
creates and dispatches a fresh thread seeded with the issue's title, description, todos, links, and
images — it does not auto-spawn. The assignee constrains the provider; model, reasoning, and current
checkout versus new-worktree options and the worktree's base ref are selected before launch. A new
worktree follows the normal thread preparation path, including generated branch naming and
configured setup scripts. A stray kanban drag must not start three agents.

### Enrichment

A new TextGeneration operation beside commit-message and PR-content generation, running the
configured model as a read-only one-shot in the project's `cwd`. It returns a structured result —
restated problem, likely files, related issues, suggested labels and priority — recorded as a
comment from the agent that ran it. Priority and safe missing-field rewrites are applied as agent
writes; a generic integration title is automatic only while its latest writer is not the user.
It fires on triage accept and from a manual Investigate button. Never on bulk import. Skipped for
rootless projects.

Runs are owned by an `issue_enrichment_runs` table: state, streamed transcript, structured result,
model, duration. The Investigation tab renders that transcript live; the comment is the readable
handoff in Activity. A run is **not** a thread, so it cannot appear in the threads view by
construction — which is why no `hidden` flag was added to threads.

### Slack intake

Bot token in `secretsDir`. The server **polls** `conversations.history` per watched channel from a
stored cursor, roughly every 30s. Not Socket Mode and not a relay webhook: this server sleeps, and
polling from a cursor is the only transport that catches up on what it missed.

Trigger is configurable per channel, any combination of: ordered reaction routes, every message in
the channel, or a bot mention. Each channel can also assign a release cycle to every filed issue.
Each reaction route can inherit or override the channel's default project and
automatic-investigation policy; the first matching reaction wins. Slack thread replies attach as
comments via the stored source message ts. Automatic investigation files the issue into Triage
first and never accepts it.

Sync is **two-way**. The bot posts to the source thread, attributed ("Corey: …", "Claude moved
PAT-12 to In Review"), on comments and status changes only. Outbound posts are recorded by message
ts and skipped by the poller — that registry is the entire echo-suppression story.

### Settings

The flat `SETTINGS_SECTION_LABELS` record (`settingsSearch.ts:22`) becomes four groups:

- **Workspace** — General, Appearance, Keybindings
- **Agents** — Providers, Source Control, Usage
- **Issues** — Statuses, Labels, Triage & Intake, Import, Enrichment
- **System** — Connections, Archive, Diagnostics

The icon map and search index are keyed off the same record and follow.

### Surfaces

Web and desktop only. **Mobile is deliberately deferred**, against the every-surface rule in
`AGENTS.md`. The RPC layer is shared, so mobile is later mostly UI work; the intended first slice
there is read plus triage, not kanban or settings.

## Staging

1. **Foundation** — tables, change log, stream RPC, list view with status grouping, right-sheet
   detail, settings IA restructure, Statuses and Labels pages, CSV import so 205 real issues land
   immediately.
2. **Structure** — nullable `workspaceRoot` and the attach-directory modal, milestones, cycles,
   sub-issues, todos, relations, due dates, comments.
3. **Views** — kanban, filter chips, saved views, bulk actions, keyboard navigation.
4. **Agents** — MCP toolkit, thread↔issue links, start-work, enrichment runs and transcript panel.
5. **Intake** — Slack polling, triage queue, two-way sync.

Each stage is independently useful. The tracker earns agent access by being good first.

## Consequences

- Issues are environment-scoped. Two machines mean two trackers, and no cross-environment view
  exists. If the tracker becomes the primary surface, this is the thing that forces a real backend.
- Nullable `workspaceRoot` touches every consumer of a project across three clients. Rootless
  projects that stay visible mean each of those sites needs the prompt path, not merely a filter.
- Agents can delete and complete. The change log and soft deletes make that reversible, but nothing
  prevents a bad sweep in the first place. If that bites, a per-toolkit confirmation gate is the
  smallest fix.
- Two-way Slack sync makes every sync bug visible to other people, and the ts registry is the only
  thing standing between a comment and a loop.
- Polling costs a Slack API call per watched channel per interval, forever, on a laptop.
- Enrichment spends provider tokens on a background action the user did not explicitly type. Triage
  accept is a deliberate trigger for exactly that reason.
- Two views, a filter builder, and a settings restructure land in a codebase that audits for
  performance regressions. The list must stay virtualized and the stream must send diffs, not
  snapshots.

## Amendment — planning with milestones (2026-08-13)

Milestones shipped above as "named checkpoints with optional target dates". That is enough to tag an
issue with one and enough to roll progress up, but not enough to plan: the only way to see a
milestone was to expand a project in the sidebar, which applied a filter. Giving them a settings
page, an overview with a timeline, and a detail page forced two choices the record above did not
make. Everything else stays as decided — milestones remain **project-scoped**, `projectId` stays
required, and there is no second entity beside them.

### A start date on the milestone, not a date-range entity

`issue_milestones` gains a nullable `start_date` (migration 061). A milestone with both dates is a
bar you can drag by either end; one with neither is a point, which is what every milestone created
before this was.

The alternative was to leave milestones as single-date checkpoints and express ranges with cycles,
which already have `startDate` / `endDate`. Rejected: cycles span everything and are time-boxed by
definition, milestones live inside one project and are scope-boxed, and a timeline of checkpoints
with no width cannot be dragged into shape.

Trade-offs taken knowingly:

- **Nullable, so every existing row is still valid** — but every consumer now has to decide what an
  undated milestone means. The timeline's answer is the "Unscheduled" tray, which doubles as the way
  back out: dragging a bar into it clears both dates.
- **`start_date` is a bare `TEXT` column with no `CHECK`**, exactly like `target_date`. The
  `YYYY-MM-DD` shape is enforced by `IssueDate` at the schema boundary on read and write, so a
  hand-written row can still fail decode later. Same risk as the column beside it, not a new one.
- **No `issue_events` row for a milestone's own dates.** The change log is keyed per issue and no
  milestone field change has ever been logged; adding one would need a milestone-scoped event
  concept that does not exist. The cost is that a milestone has no activity feed.

### Burn-up by backward replay, not a snapshot table

The chart is reconstructed on demand from `issue_events`, walking backwards from today's known-true
state, and served as one aggregated point per day.

The two alternatives both lose:

- **A nightly snapshot table** would be exact, but this server sleeps. There is no scheduler here —
  it is the same argument that made cycle carry-over lazy — so a laptop that was closed for a week
  writes a week of holes into the very series it exists to draw.
- **Shipping raw events to the client** and folding them there keeps the server simple and makes the
  payload unbounded, which AGENTS.md calls out directly.

Backwards rather than forwards is not a style preference: an issue created already assigned to a
milestone writes a `created` row with no milestone field, so a forward replay never sees it join and
would silently under-count the milestones people plan up front.

Trade-offs taken knowingly:

- **The log stores display names, not ids.** A status — or the milestone itself — renamed since is
  unmappable, so the reconstruction returns `approximate: true` and the chart says the history is
  partly a guess. Correctness here would mean logging ids as well as names, which is a change to
  every write path and to the activity feed's rendering, for a chart.
- **Issues moved off a milestone vanish from its history**, because the replay starts from the
  current member set. Catching them needs a second, unindexed scan of `issue_events.before`. The
  consequence is that scope churn reads smaller than it was; documented in
  [issue-tracker.md](../issue-tracker.md) rather than papered over.
- **The series is capped at 366 days.** Each day is computed from the present rather than from the
  day before it, so the cap costs only the days it removes — but a milestone older than a year has
  no visible beginning.

### Surfaces, unchanged

Still web and desktop. Mobile has no issue-tracker UI at all, so it has no milestone settings page,
overview, timeline, or detail page either; the RPC layer is shared, and read plus triage is still
the intended first slice there.
