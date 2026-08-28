# Glossary

Project-specific vocabulary beyond the small glossary in `AGENTS.md`. Be opinionated: one canonical word per concept; alternates go under _Avoid_.

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
