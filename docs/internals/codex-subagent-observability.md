# Codex subagent observability

This change addresses the lifecycle and reporting findings from the September 2026 subagent audit. Readable task names are a separate change.

## Completion and event ordering

`CodexAdapterV2` handles every `subAgentActivity` kind explicitly. Completion or interruption from the parent settles the linked card and execution nodes. A registered child turn uses the same finalization path as native `turn/completed`. Repeated terminal activity cannot overwrite a failure or interruption, or stop a later activation. Resumed turns reopen the parent execution node and clear the previous result.

A completed parent retains its context while its children or background commands are running, or child turns await registration. Until registration supplies a parent link, pending child turns conservatively keep completed contexts eligible for late activity. Child and command completion handlers preserve that context while registration is pending.

Early child notifications are buffered until registration supplies their projection context. Registration drains them in order, including when a buffered notification registers a nested child. The buffer holds at most 256 notifications and 1 MiB of encoded payload. Oversized payloads are discarded; overflow evicts the oldest notifications and logs a warning. Ordinary token deltas do not scan or drain the registration buffer.

## Reported configuration and usage

`thread/settings/updated` supplies authoritative model and effort values. Updating or clearing effort preserves non-effort options such as service tier. Before a report arrives, a child thread uses its immediate parent's configuration as a default; activity-based roster records leave unreported model and options unset. Late spawn metadata can fill missing configuration, nickname, role, and prompt without resetting lifecycle state. The shared runtime mapper prefers a nonblank nickname for the Agents panel title.

Metadata exclusion applies only while a native thread has a pending or active foreground turn. A child that finishes a foreground turn can report settings and usage when its parent reactivates it as a subagent.

The adapter emits `app_thread.model_reported`, normalized to the narrow `thread.model-reported` domain event. Its payload contains only `modelSelection`. Server and shared client projections patch that field without replacing a thread's title, archive state, or other user-owned metadata. The existing native Apple client thread-patch handler accepts this payload shape.

Subagent `usage`, `activationCount`, `nickname`, and `role` fields are optional. Existing records and providers that omit them still decode. Codex increments the activation count for actual child turn starts, ignores duplicate turn starts, and max-merges its cumulative token counters. The client mapper preserves these values. Missing usage produces an unknown roster total instead of a partial sum presented as the full total.

Claude, Cursor, Grok, and OpenCode retain their existing lifecycle adapters. Their absent usage fields remain unknown; this change does not invent measurements for them. Web, Electron, and remote connections use the shared contracts. No transport origin or environment identity changes are involved.

## Correction to the idle-release finding

The session manager already refreshes the idle deadline on provider activity. A clock-driven regression verifies a child resuming just before the old deadline, remaining resident while work is pending, and being released only after a full idle window following completion. No new retention timeout is needed. A child that might resume after an entirely silent idle window cannot justify retaining its process indefinitely. Pending child registration now counts as background work, subject to the manager's existing maximum pin duration.

## Verification

Focused tests cover parent-only completion, completion after the parent settles, preservation of failed and interrupted states, early and nested notifications, bounded buffering, duplicate completion across a resume, cumulative usage, activation counts, immediate-parent model defaults, and late metadata. Persistence and client projection tests verify that reported configuration preserves unrelated thread metadata. Contract tests cover optional fields and invalid counters. Canonical Codex subagent replay scenarios continue to cover the older spawn protocol and continued conversations.

Verification uses protocol replay and event receipts. It does not require a live provider, browser, or device session.
