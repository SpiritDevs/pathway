# Glossary

Project-specific vocabulary beyond the small glossary in `AGENTS.md`. Be opinionated: one canonical word per concept; alternates go under _Avoid_.

## Connected mail

**Mail account**:
One member's connected Gmail mailbox within a workspace. Its messages, drafts and sender knowledge are private to that member. The relay owns synchronization and encrypted OAuth credentials. See [connected mail architecture](connected-mail.md).

**Mail brain**:
The selected environment, provider instance and model that analyze a mail account. An optional backup environment has its own provider selection. Ingestion continues while analysis environments are offline.

**Bucket**:
A message's Priority or Noise classification, accompanied by a reason. A pending analysis status distinguishes provisional placement from completed analysis.

**Briefing**:
The model's concise summary of a Priority message, including concrete actions or deadlines. Promoting Noise to Priority requests a briefing.

**Sender rule**:
The owner's remembered bucket choice for an address within one mail account. Removing it lets subsequent analysis choose the bucket again.

**Sender knowledge**:
Private accumulated information about a sender within a mail account. It is separate from the shared contact directory; saving a contact copies only the explicitly confirmed contact fields.

## Time tracking

These terms describe [concurrent agent tracking](../adr/0032-concurrent-agent-time-adds-to-project-totals.md).

**Agent work time**:
The sum of tracked agent durations. Concurrent agents each contribute their own duration to the project total.

**Elapsed activity time**:
The duration covered by tracked activity, counting overlapping intervals once within the selected scope. Eight agents working simultaneously for 30 minutes yield 30 minutes of elapsed activity and four hours of agent work.

**Issue creation credit**:
The greater of one minute or measured active composer time, recorded when a human issue creation succeeds. Any minimum credit above measured time does not add elapsed activity.

## Agent questions

The following terms support the [Astra design record](../adr/0014-astra-questions-and-browser-scope.md). They describe the design under discussion, not shipped support.

**Question group**:
One identified set of questions raised together by an agent. It retains its originating environment, provider thread, and question order.

**Non-blocking question**:
A question the agent can leave open while continuing independent work. An unanswered question is an attention state, not proof that the turn is stopped.

**Message reply**:
An answer delivered as a user message to the provider thread that asked. For Codex async questions this steers active work or starts a follow-up after completion.

**RPC reply**:
An answer returned to an outstanding provider request. It depends on the original live request and cannot be resumed merely by preserving the question text.

**Browser host**:
The runtime that owns the automated browser, its live tabs, and its cookies. It may be on a different machine from the environment where the agent runs.

**Model manifest**:
A versioned data file used for model metadata and classification. It does not prove that an account or installed provider can use a model.

## Thread workspaces

The storage cleanup terms below describe the dashboard design in progress, not shipped behavior.

**Worktree reclamation**:
Removal of a thread's entire eligible worktree while preserving its branch and conversation history. It is distinct from deleting the thread.
_Avoid_: Delete thread, Clear history

**Emergency cleanup**:
User-initiated worktree reclamation to relieve critical storage pressure. Low storage never starts emergency cleanup automatically.
_Avoid_: Automatic pressure cleanup

**Keep worktree**:
A user-selected protection that excludes a thread's worktree from scheduled reclamation and emergency cleanup.

**Cleanup eligibility**:
Whether a worktree may be reclaimed under the selected policy and current protections. Archived or settled status alone does not establish eligibility; snoozed and running threads remain protected.

**Conversation**:
A thread without an attached project. Its environment owns its history and dedicated working folder;
the company selected at creation determines its visibility. Project attachment preserves its identity
and original folder.

**Temporary thread**:
A thread deleted on settlement, independently of project attachment. Temporary project threads use
dedicated worktrees. Keep conversation changes retention without moving files.

**Workspace move**:
The durable server workflow that moves an existing thread and the source checkout's tracked and untracked non-ignored changes into a new linked Git worktree. It is not a client-side sequence of Git calls.
_Avoid_: Worktree copy, Repo copy, Workspace switch

**Source checkout**:
The project's root checkout before a workspace move. Other threads may share it, so active work and running terminals there block the move.

**Target worktree**:
The new linked Git checkout created for the thread from the source checkout's exact `HEAD`.

**Transfer stash**:
The temporary Git stash identified by object id that carries dirty state from the source checkout to the target worktree. Pathway drops it only after the target accepts the changes and the thread rebind succeeds. It remains available if automatic recovery fails.

## Focuses

**Focus**:
A named, user-defined set of projects, optionally including projectless conversations, used to filter the Agent Threads view to one mindset (e.g. Work, Personal). A Focus is a filter, not a container: it scopes what the Agent Threads sidebar shows (thread list, pinned/snoozed/settled shelves, project dropdown, search) and nothing outside that view.
_Avoid_: Profile, Space, Tab, Category, Mindset

**All Focus**:
The built-in, always-first Focus that shows every project and thread — equivalent to today's unfiltered Agent Threads view. It cannot be deleted or edited.
_Avoid_: Default profile, Everything tab

**Active Focus**:
The Focus currently selected on this machine. Selection is per-machine and does not sync; Focus definitions do.

**Focus Strip**:
The horizontal row fixed to the bottom of the Agent Threads sidebar: the All Focus first, then user Focuses as small icons that shrink to colored dots and magnify on hover, then the notification badge and the Focus creator on the right.
_Avoid_: Tab bar, Dock

**Focus Assignment**:
The link from a project to at most one Focus. Exclusive: a project belongs to zero or one Focus; unassigned projects appear only under the All Focus.

**Focus Creator**:
The corner popup anchored above the Focus Strip for creating or editing a Focus: name, Lucide icon picker, accent color, and an exclusive project checklist (ticking a project already in another Focus moves it, with a visible hint). Opened by the strip's "+" or by right-clicking a Focus tab (which adds a Delete button).

**Notification Tray**:
The popup opened from the Focus Strip's badge listing unread notifications grouped by Focus, active Focus first. Opening it zeroes the badge everywhere; clicking an entry switches to that thread's Focus and opens the thread.

**Attention Event**:
A thread state change that warrants the user's attention: an agent run finished on an unsettled thread, a pending approval, awaiting user input, or a failure. Attention events on threads produce notifications; settled threads do not.
_Avoid_: Alert, Ping

## Calendar

**Calendar View**:
The `/calendar` surface, in one of four modes: Day, Week, Month, and Timeline. The first three are a time grid; Timeline is a Gantt of projects, milestones, and cycles. One surface, one filter sidebar, one URL.
_Avoid_: Schedule, Agenda, Planner

**Event**:
A single dated thing on the time grid, with a start and end instant, its own IANA time zone, and an all-day flag. Either Pathway-owned (created here, editable) or mirrored (copied read-only from Google). An Event optionally carries one Link.
_Avoid_: Appointment, Meeting, Booking, Entry

**Occurrence**:
One expanded instance of a recurring Google event. Recurrence is expanded server-side into ordinary Events within the mirror window; Pathway-owned Events do not recur.
_Avoid_: Instance, Repeat, Series item

**Calendar**:
The container an Event belongs to and the unit of both sharing and revocation: a member's Pathway calendar, or one mirrored Google calendar. Deleting a Calendar row removes its Events everywhere they were replicated.
_Avoid_: Source, Feed

**Calendar Account**:
One connected Google account, owned by a member, holding the encrypted OAuth credential and owning many Calendars. Disconnecting it cascades to every Calendar, Event, and Grant beneath it.
_Avoid_: Connection, Provider, Integration

**Layer**:
One toggleable row-source in the calendar sidebar — a Calendar, or a work source such as Issues, Milestones, Cycles, or Scheduled Tasks. Layer visibility is per-machine and per-company, like the Active Focus, and does not sync.
_Avoid_: Filter, Overlay, Track

**Grant**:
An explicit edge from one Calendar to one member, giving read-only access to all details. Created by the Calendar's owner or a holder of `company.manage`. A Grant widens beyond `calendar.sharing` but never past an Event marked private, and never substitutes for the grantee's own `calendar.read`.
_Avoid_: Share, ACL, Permission (reserve "permission" for `PermissionKey`)

**Link**:
The optional attachment from an Event to exactly one project, issue, or thread. Stored as its own owned entity so a mirrored Event can carry one without mutating the mirror, and so it survives a disconnect and reconnect. Visible from both ends.
_Avoid_: Association, Tag, Reference

**Mirror Window**:
The rolling range of Google history copied into Convex — 90 days back, 365 days forward. Events outside it are not replicated and not rendered.
_Avoid_: Sync range, Horizon

## Thread alerts

**Alert Subscription**:
The global, project, or thread preference that determines whether an Attention Event is eligible for sound or operating-system notification delivery. It does not filter the Notification Tray. Global is explicitly enabled or disabled; project and thread subscriptions can inherit, enable, or disable.

**Effective Alert Subscription**:
The four resolved event choices for a thread after applying the global -> project -> thread cascade independently to completion, permission, user-input, and failure. The closest explicit value for each event wins, so a thread can have a mixed effective state.
_Avoid_: Bell state, Notification status

**Alert Menu**:
The popup for editing a thread's four event choices or restoring project defaults. Control/Command-hover, right-click, Control/Command+Enter on the focused bell, and long-press on touch open the same menu.
_Avoid_: Bell popup, Notification popup

**Alert Policy**:
The cloud-synced global, project, thread, and per-event choices that determine which Attention Events may interrupt the user. Repository-backed project policy uses stable repository identity across worktrees, environments, and client grouping modes. Non-repository project policy uses environment-scoped project identity. Alert Policy does not include a client's sound, OS-notification, or sound-file settings.

**Alert Delivery Settings**:
The device-local sound toggle, OS-notification toggle, and sound choice used after an Attention Event passes the Alert Policy.

**Quiet Hours**:
A device-local weekly schedule that suppresses sound and OS-notification delivery without filtering the Notification Tray.

**Quiet-hours Summary**:
One notification produced when Quiet Hours end. It groups subscribed Attention Events that remain unread by thread, plays at most one sound, and opens the Notification Tray instead of replaying each event.

**Event Acknowledgement**:
A cloud-synced record that marks one Attention Event read after the user selects its OS notification. It composes with the Notification Tray's all-read watermark without clearing unrelated events.

**Notifications Settings**:
The settings page for global thread-alert events, logical-project overrides, this client's delivery channels and sound, and this client's Quiet Hours.

## SnapShots

A **SnapShot** is a desktop window image attached to a draft with its application, window, capture
time, and available accessibility context. Capture happens on the desktop client's computer, even
when the thread runs in a remote environment. Pending captures stay on that computer until the
draft is saved or the user discards them. See [SnapShots](snap-shot.md) for delivery and provider
boundaries and [the user guide](../user/snap-shot.md) for setup.
