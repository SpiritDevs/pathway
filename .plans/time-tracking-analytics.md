# Time tracking and analytics

Status: implemented and review findings fixed on 2026-09-08; deployment and live client verification have not been performed.
Date: 2026-09-08.

## Requested outcome

- Improve the existing Time Tracker view with a considered layout and useful analytics.
- Automatically attribute agent work in threads to its project.
- Attribute successful issue creation to its project using the greater of one minute or active composer time. Idle time is excluded.
- Place a tracker control beside the profile image in the top-right application bar. Clicking it opens a dropdown showing the activities currently being tracked.

## Verified starting point

- `packages/backend/convex/timeTracking.ts` stores private, account-owned sessions in Convex. It permits one running session per account across devices and measures manual duration using the server clock.
- Sessions currently contain a description, project key/name, timestamps, and duration. They do not identify a thread, issue, or automatic source.
- `apps/web/src/components/timeTracker/TimeTrackerView.tsx` selects projects using an environment ID plus local project ID. Logical project grouping across environments and worktrees needs a decision.
- Existing history is paginated. Day/week summaries have an explicit 2,000-session ceiling; automatic tracking may need different aggregation. See `docs/internals/shared-contacts-time.md`.
- Native Apple clients use `PathwayTimeModel.swift`; the design must account for this existing client as well as web and Electron.
- Provider runtime contracts include turn start and completion events. Timing through blocking requests, non-blocking questions, interruptions, retries, child agents, and environment outages still needs investigation.
- Issue creation has a main `NewIssueDialog.tsx` and `InlineSubIssueComposer.tsx`. Other creation paths must be inventoried before implementing attribution.

## Confirmed decisions

- Track concurrent agents independently, including multiple agents working on the same project. Their durations add together in the project total.
- Show elapsed activity alongside summed agent time so overlap remains visible. Eight agents working concurrently for 30 minutes produce eight sessions, four hours of agent work, and 30 minutes of elapsed activity.
- Do not apply the existing single-manual-timer restriction to automatic agent sessions. Manual timer concurrency remains undecided.
- Pause an agent's automatic timer while it is blocked waiting for permission or an answer. Resume when work continues. Non-blocking questions do not pause tracking while the agent continues working. Exclude blocked intervals from its recorded work duration.
- Record issue creation only when the creation operation is accepted. Credit the greater of one minute or active composer time, not one extra minute on top. Corey accepted this rule and then authorized implementation with subagents.

See [the concurrency decision](../docs/adr/0032-concurrent-agent-time-adds-to-project-totals.md).

## Adopted implementation defaults

These choices complete the authorized design where the interview did not settle a detail.

- Reports explain project effort using combined work, elapsed activity, agent work, manual timers, issue creation, project breakdowns, and daily trends. Billing, rates, targets, and exports are outside this change.
- Keep one manual timer per account. Agent sessions run independently alongside it. Combined work adds all sources; elapsed activity unions measured intervals.
- One independent thread run owns one agent session. Native subagents within that thread contribute within the parent rather than generating duplicate sessions. Queued/preparing time and post-turn waiting do not count. Tool execution counts while the run is working. Terminal states close the session.
- Automatic capture runs on the environment and survives client closure. Local SQLite stores the capture cursor, intervals, and publication state. First enablement starts at the current event boundary without historical backfill.
- A lost environment heartbeat stops visible extrapolation after 90 seconds. Restart recovery preserves known work and excludes unobserved downtime. Revisions make publication retries idempotent.
- Existing sessions can finalize after their project binding is revoked or project is removed, without changing the original owner or project. New sessions still require an active binding.
- Unbound publication attempts back off for five minutes while local capture continues. Pending indexes avoid scanning acknowledged completed history on each heartbeat.
- Automatic agent records belong to the active member who registered the environment. The current run model does not persist an initiating member identity. This is an explicit limitation, not a claim of per-person attribution on shared environments.
- Use canonical cloud project identity for automatic records and newly started bound manual timers. Unbound manual projects retain their environment/local identity. Existing history is not rewritten.
- Web and Apple issue composers count focused foreground interactions with a 30-second idle allowance. Backgrounding pauses immediately. Cancellation records nothing; submission failures retain the draft measurement. Successful create-more starts a fresh measurement. Measurement supports up to 256 intervals and 24 hours of active work.
- Human issue creation through the accepted cloud operation gets the one-minute baseline when composer measurements are absent. Environment automation, imports, comments, and edits do not receive synthetic human creation credit. Agent work used to create an issue is already counted in the agent session.
- The issue minimum is credited work, not fabricated elapsed time. Measured intervals contribute to elapsed activity; the extra minimum credit belongs to the creation day. Issues without a project appear under No project. Historical attribution stays with the original activity.
- Timers remain private account records. Existing completed-session deletion remains available; automatic timers follow the agent lifecycle rather than exposing a second independent stop state.
- The global web/Electron control is visible beside the profile menu and groups active/paused timers by project. The full tracker adds analytics and retains manual controls, retries, import, and pageable history. Apple clients show active sessions and analytics in their native tracker.
- Native manual starts use the same cloud project ID as automatic sessions. Native analytics refreshes use a changing time cutoff so manual-only work updates without database writes.
- Actual local day boundaries support daylight-saving transitions. Analytics uses bounded reads and explicitly marks unavailable totals rather than showing truncated totals. Complete history remains pageable.

## Delivery and verification boundaries

- Web and Electron share the new tracker, top bar control, and issue composers. Native Apple tracker and issue editor use the same cloud rules.
- This checkout has no React Native or Android client source. No Android UI parity is claimed.
- Agent capture consumes the common V2 lifecycle for Codex, Claude, Cursor, Grok, and OpenCode. Focused provider-independent lifecycle tests exercise the timing rules; live per-provider runs have not been performed.
- Registered environments publish through their existing authenticated cloud connection. Client-local, relay, and tunnel connections do not own capture. Live remote/network validation has not been performed.
- Backend schema/functions need deployment and environments need the updated server before automatic tracking is operational. No deployment, browser session, simulator launch, commit, push, or PR is implied by this implementation.

## Documentation approach

Record confirmed answers here as the interview progresses. Add accepted architectural decisions to `docs/adr/` and agreed vocabulary to `docs/internals/glossary.md`. Update shipped user documentation when behavior is implemented.

The invoked `grill-with-docs` skill refers to `/grilling` and `/domain-modeling`. Neither dependency was found in the local skill directories or plugin cache. This session uses a direct interview and explicit decision record.

## Focused verification

- Rebased JavaScript/TypeScript verification: 308 tests passed across 15 explicit files covering issue sync, contracts, composer timing, backend analytics, real startup recovery, and web tracker rendering. Regression cases cover startup request expiry and cancellation, project removal, and immutable session attribution.
- Package typechecks: server, backend, web, contracts, and client-runtime. These are scoped package checks, not a repository-wide run.
- Native production clock/model sources: ten Swift Testing tests passed in an isolated package with transport stubs. Production TimeModel and TimeView typechecked against the host SwiftUI SDK with surrounding application/transport stubs. Issue editor and clock parsed; the pure clock also compiled and ran in a standalone executable. Native regression tests check canonical manual project keys and changing analytics query cutoffs.
- Targeted lint passed with existing warnings for `prefer-array-find` in `syncApply.test.ts` and an unused `OrchestrationLayerLive` import inherited from main. Server typechecking reports existing Effect suggestions rather than errors. Formatting and `git diff --check` passed.
- No browser/computer-use verification or full Apple application build was performed. The native stub-based checks do not prove app integration or simulator/device behavior.
- No repository-wide checks or deployment were performed. Publication follows the scoped commit and rebase workflow; UI evidence awaits explicit browser permission.
