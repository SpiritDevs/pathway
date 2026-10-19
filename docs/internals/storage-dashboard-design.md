# Storage dashboard design

Status: implemented across the server, web, desktop, and native Apple client. Focused tests, package typechecks, and the native build pass. Interactive UI and live cleanup validation have not been performed.

## Objective

Expand the Archive area into a dashboard for storage across connected environments. Show archived, settled, and snoozed threads, filter environments with a multiselect, expose storage use and available capacity, and support manual and automatic cleanup before storage exhaustion disrupts environments.

## Agreed decisions

- Worktree reclamation and thread deletion are separate actions. Automatic storage cleanup preserves conversation history by default.
- Only archived or settled threads may qualify for automatic cleanup. Snoozed threads are protected. Users can mark any thread Keep worktree.
- Emergency cleanup always requires a user action. Critical storage never starts it automatically. It cannot touch running threads or bypass cleanup protections. If nothing qualifies, alert the user and explain the blockers.
- Each environment monitors and runs its enabled policy without an open dashboard. Shared defaults allow per-environment overrides. Unreachable environments show the last measurement and its age.
- Scheduled cleanup is opt-in, with a dropdown offering 7, 14, 30, or 60 days and 30 days suggested. The clock counts continuous archived or settled eligibility; resuming resets it.
- Warning defaults are 20 GB or 10% available; critical defaults are 10 GB or 5% available. Either threshold can trigger its level, and values are configurable.
- Reclamation removes the entire eligible worktree, including ignored files. Ignored files do not block removal. Uncommitted tracked changes, untracked non-ignored files, and unpublished commits remain protected. Enabling scheduled cleanup must communicate that ignored files will be deleted; Keep worktree protects folders that need to remain intact.
- Reclamation preserves the branch and conversation history. Resuming shows that the worktree was removed to free space and offers Recreate worktree before continuing; dependencies and generated files may need rebuilding.
- Show capacity cards, a persistent low-storage indicator outside the dashboard, and in-app notifications on threshold crossings. Offer OS notifications through existing preferences. Report recovery and avoid repeated alerts while the condition is unchanged.
- When a user selects an environment at critical storage, warn in the conversation view and offer one-click emergency cleanup there. Offer Clean up, Choose another environment, and Continue anyway. Cleanup preserves the draft and never submits the message itself.
- Offer Avoid critically low environments in Auto as an optional setting, off by default. When enabled, Auto excludes critically low environments from new placements while healthy eligible alternatives exist. If no suitable machine remains, show the warning and cleanup action. Never silently move an existing conversation.
- The conversation cleanup action shows estimated recoverable space before the click and requires no second confirmation. It reclaims the oldest eligible worktrees until measured free space exceeds both warning limits, bypassing the age schedule but retaining all other protections. Dashboard bulk cleanup retains its preview.
- Rename Archive to Storage & cleanup. Show environment capacity cards above a searchable thread table, with cleanup policies beside environment controls and a multiselect environment filter.
- Default rows include archived, settled, and snoozed threads. An All threads filter exposes active threads as protected. Worktrees no longer linked to a thread appear separately for manual review.
- Display worktree size and thread-data size separately. Identify shared storage rather than counting it repeatedly.
- Bulk cleanup previews selected rows grouped by environment, estimated recoverable space, and skipped-item reasons. Each environment rechecks eligibility before removal and reports progress independently. Offline environments are skipped for explicit retry, never silently queued for later deletion.
- Partial failures retain successful removals and show reclaimed space and failures per environment. Retry targets failed items. Cancellation stops before the next worktree and cannot restore removed worktrees. Keep a history of scheduled and manual cleanup.
- Scheduled tasks continue under existing scheduling rules on critically low machines. Report storage alerts without automatically starting emergency cleanup.
- Never reclaim a project's main checkout. Shared worktrees qualify only when every linked thread qualifies. Running agents, pending launches, and open terminals block removal; the environment enforces these checks immediately before deletion.
- Report capacity per volume, including system, Pathway data, and worktree volumes. Cleanup targets the volume under pressure. Sizes are estimates with measurement age; report measured free-space change after cleanup and never promise immediate database-space recovery from logical history deletion.
- Include projectless conversation history and working-folder sizes. Their working folders are excluded from scheduled and emergency cleanup because no Git branch can recreate their contents. Explicit manual deletion requires a preview.
- Existing temporary threads retain their delete-on-settlement behavior. Show the retention policy distinctly from worktree reclamation.

See [the storage cleanup decision](../adr/0033-storage-pressure-preserves-conversation-and-unique-work.md) and [glossary](glossary.md#thread-workspaces).

## Baseline behavior found before implementation

- Archive queries environments derived from visible projects and groups rows by project. This misses projectless conversations and has no environment filter.
- Snooze overlays active lifecycle. Settled status includes derived inactivity and merged-PR rules, so neither status proves a worktree is safe to remove.
- The existing day-based preference automatically settles threads; it is not a general cleanup schedule.
- Ordinary thread deletion and optional worktree removal are separate operations. Server-owned temporary workspaces have additional cleanup behavior and protections.
- Logical thread deletion does not establish how many database bytes are physically reclaimed.
- Targeted source searches found no environment capacity monitor or general disk-pressure cleanup policy.
- HostResourcesSnapshot currently reports CPU and memory. Auto placement uses CPU/memory eligibility and scoring; the web keeps a resolved draft destination stable. Storage checks must explicitly cover manual choices and existing-thread sends, not just Auto placement.
- Native Apple implements placement separately in Swift. This checkout has no apps/mobile directory. Scheduled tasks launch server-side, outside the interactive composer flow.
- Resource inspection uses orchestration-read scope and existing worktree removal uses orchestration-operate. The new cleanup path needs server-side eligibility guards rather than assuming the existing Git removal RPC enforces thread protections.

Source entry points: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/lib/archivedThreadsState.ts`, `packages/client-runtime/src/state/threadSettled.ts`, `apps/web/src/hooks/useThreadActions.ts`, `apps/server/src/orchestration-v2/ThreadWorkspaceService.ts`, and `apps/server/src/orchestration-v2/TemporaryThreadSettlement.ts`.

## Implementation choices

Use existing environment read/operate permissions with server-side scope checks. Unknown or stale storage remains visibly unknown and does not silently block work. Bound expensive scans and cache measurements; never recurse through external symlinks or count shared worktrees repeatedly. Revalidate the specific candidates shown to the user; newly discovered candidates need a new action. Deliver web and Electron's shared UI plus the separate native Apple client. Preserve all remote routing through typed environment RPCs.
