# Glossary

Project-specific vocabulary beyond the small glossary in `AGENTS.md`. Be opinionated: one canonical word per concept; alternates go under _Avoid_.

## Thread workspaces

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
A named, user-defined set of projects used to filter the Agent Threads view to one mindset (e.g. Work, Personal). A Focus is a filter, not a container: it scopes what the Agent Threads sidebar shows (thread list, pinned/snoozed/settled shelves, project dropdown, search) and nothing outside that view.
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
