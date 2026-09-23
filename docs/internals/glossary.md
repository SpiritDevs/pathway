# Glossary

Project-specific vocabulary beyond the small glossary in `AGENTS.md`. Be opinionated: one canonical word per concept; alternates go under _Avoid_.

## AI coordination

These terms describe the [orchestrator design in progress](../plans/pathway-ai-orchestrators.md), not shipped behavior.

**Orchestrator**:
A persistent AI contact with a name, persona, memory, and assigned roles and privileges. It coordinates and delegates work across its authorized scope, independently of the chats it participates in; it is distinct from the server orchestration engine.
_Avoid_: Thread as a synonym for the orchestrator's identity

**Personal orchestrator**:
A user's private assistant spanning their accessible companies, projects, and environments.

**Orchestrator avatar**:
The visual representation of an orchestrator's shared identity, configured by its owner or authorized managers and consistent across viewers. The [animated avatar design](../adr/0038-orchestrator-avatars.md) includes configurable appearance, work status, conversational expression, and silent click reactions. Viewer accessibility preferences can adapt presentation without changing the identity.

**Orchestrator personality**:
The orchestrator's shared settings for warmth, playfulness, energy, curiosity, and expressiveness. In the avatar design, these jointly shape conversational tone and avatar expression by default; advanced controls allow separate tuning for replies and animation.

**Project orchestrator**:
An orchestrator responsible for coordinating a project's work, which can be explicitly shared with other users. Its standing scope is its own project; participation in cross-project collaboration requires being brought into that collaboration.

**Orchestrator chat**:
A continuing exchange among human and orchestrator participants, either a direct message or a named group for a project or event. It is distinct from the existing environment-owned projectless Conversation and from delegated agent threads.

**Orchestrator DM**:
The ongoing direct chat between a user and one orchestrator, spanning individual tasks.

**Orchestrator group chat**:
A named chat with multiple participants, including multiple orchestrators, organized around a project, event, or other shared purpose.

**Group lead**:
The orchestrator responsible for unaddressed requests and consolidated updates in an orchestrator group chat. Participants can address another orchestrator directly without changing the lead.

**Orchestrator execution host**:
The eligible environment currently running an orchestrator's model. It can change without changing the orchestrator's identity, chats, or memory.

**Direction authority**:
Permission to assign work to an orchestrator within its configured role. It is separate from chat participation and from the action privileges the orchestrator holds.

**Orchestrator memory**:
Durable knowledge or preferences retained by an orchestrator beyond an individual model context. Memories have a visibility scope and can be inspected, corrected, deleted, or shared by the user; inferred observations retain their sources.

**Cross-project collaboration**:
A shared undertaking involving multiple projects and their orchestrators, with authorized access to relevant project context. Each project orchestrator retains responsibility for dispatching its project's work and requests dependent work from the other coordinators.

## Provider allowance

These terms describe [allowance controls in design](../plans/pathway-provider-allowance-budgets.md), applicable to ordinary agents and orchestrators.

**Provider allowance**:
A provider-reported account usage quota for a particular window and scope. It is distinct from a thread's context capacity, token count, or API-equivalent cost.

**Allowance window**:
The period to which a provider allowance applies, such as a session, week, or month, with its provider-reported reset boundary when available.

**Allowance budget**:
A user-assigned allocation in percentage points of a selected full provider allowance window for a body of work and its descendants. It is conservatively measured against observed account-wide consumption, including unrelated activity.

**Allowance guard**:
The control that gates an assignment and its descendants against an allowance budget across environments. It pauses work when the observed threshold is reached or reliable readings are unavailable; provider reporting delay can still cause overshoot.

## Tasks

**Task**:
A tracked unit of work, optionally belonging to a project, with a status, assignment, and history. The product view is **Tasks**; a child task is a **subtask**. Checklist items are lightweight steps within a task. Scheduled tasks are recurring automations and keep their qualified name.
_Avoid_: Issue, ticket, bug as the generic name for this feature. External trackers and actual defects may still use those terms.

Existing `/issues` links, `issue`/`issues` storage and protocol identifiers, permission keys, and `issues_*` MCP tool names remain stable for compatibility. Display labels, tool descriptions, and product documentation use task terminology.

**Bug report**:
In the [report-a-bug design](../plans/report-a-bug.md), a task describing unexpected Pathway behavior, accompanied by diagnostic evidence from the reporting client.

**Bug investigation**:
Optional agent research into a bug report that adds findings to the task. It may inspect code and attempt reproduction; implementing a fix is a separate action.

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

**Task creation credit**:
The greater of one minute or measured active composer time, recorded when a human task creation succeeds. Any minimum credit above measured time does not add elapsed activity.

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
One toggleable row-source in the calendar sidebar — a Calendar, or a work source such as Tasks, Milestones, Cycles, or Scheduled Tasks. Layer visibility is per-machine and per-company, like the Active Focus, and does not sync.
_Avoid_: Filter, Overlay, Track

**Grant**:
An explicit edge from one Calendar to one member, giving read-only access to all details. Created by the Calendar's owner or a holder of `company.manage`. A Grant widens beyond `calendar.sharing` but never past an Event marked private, and never substitutes for the grantee's own `calendar.read`.
_Avoid_: Share, ACL, Permission (reserve "permission" for `PermissionKey`)

**Link**:
The optional attachment from an Event to exactly one project, task, or thread. Stored as its own owned entity so a mirrored Event can carry one without mutating the mirror, and so it survives a disconnect and reconnect. Visible from both ends.
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

## Computer Use

These terms support the Computer Use design records ([0039](../adr/0039-computer-use-is-a-literal-mirror-of-synara.md), [0040](../adr/0040-computer-use-controls-the-environment-host.md)). They describe the design under discussion, not shipped support.

**Computer Use**:
An agent observing and driving desktop applications and a driver-owned browser through Pathway's `computer_*` tools. It is ported from Synara.
_Avoid_: Computer control (that is the name of the Settings toggle, not the feature), CUA (that is the driver).

**Controlled computer**:
The host machine of the environment running the thread. It is never the device of the client that started the task. Contrast with a SnapShot, which captures the client's computer.
_Avoid_: Local computer, this Mac.

**Computer Host**:
The process that owns the Cua driver child process, the native helper and the physical Escape monitor for one controlled computer. On macOS it is the Pathway desktop app. A headless server uses the standalone host, which has no native safety layer.

**Cua driver**:
The MIT-licensed native automation daemon (Cua AI, Inc.), pinned to one upstream commit and patched for Pathway. It is an implementation detail behind the Computer Host, not a user-facing name.
_Avoid_: CUA as a name for the feature.

**Computer access policy**:
The environment setting that decides which paired clients may start Computer tasks: Any operator, Scoped (the `computer:operate` scope, default) or Admins only. Watching, approving and Stop are never restricted by it. See [0041](../adr/0041-computer-access-is-an-environment-policy.md).

**Computer autonomy**:
The environment's ceiling on Computer oversight: Supervised, Per task (default), Auto or Full access. A thread's composer runtime mode maps onto the same levels, and the stricter of the two applies. The denylist, Stop and Escape, and the audit log hold at every level. See [0043](../adr/0043-computer-autonomy-is-an-environment-ceiling-over-thread-mode.md).
_Avoid_: Computer permission mode (runtime mode is the thread's setting; autonomy is the environment's).

**Denylist**:
The applications and system surfaces Computer Use always refuses: password managers, Keychain Access, Passwords, System Settings and SecurityAgent. No autonomy level overrides it.

## Dictation

**Dictation**:
The Pathway feature that turns the user's speech into text for insertion or copying. Its proposed behavior is recorded in [the dictation design](dictation-design.md).

**Hold-to-talk**:
Dictation recording that lasts while the user holds the activation shortcut. Releasing the shortcut finishes the recording.

**Locked recording**:
Dictation recording that continues without holding the activation shortcut, started by double-tapping the shortcut or selecting Record on the dictation bar. The user explicitly accepts or cancels the recording.
_Avoid_: Pinned recording

**Dictation bar**:
The compact desktop control that shows dictation activity. Its optional idle state reveals Record, Settings, and History controls on hover.

**Dictation history**:
The user's saved original recognition and cleaned dictation text on one desktop, distinct from agent thread history. Dictation history does not retain audio recordings or sync across desktops.

**Dictation dictionary**:
The user's account-synced collection of preferred spellings and explicit corrections, organized into named lists that all apply to dictation. Each desktop can use its last synced copy offline.

**Dictation cleanup**:
The optional AI step that removes fillers, repetitions, and spoken self-corrections from recognized speech while preserving its meaning and language.

## Queued submission

A cloud-saved user message and its attachment references, assigned to a thread and destination
environment. Its stable command identity allows delivery to resume after disconnection without
starting duplicate work. See [durable thread submission](durable-thread-queue.md).

## Queue acceptance

The atomic point at which an environment takes permanent delivery ownership of a queued
submission. Editing, cancellation, and reassignment are available before acceptance. Acceptance
is separate from durable local delivery and from provider startup.
