# Focuses

A Focus filters the projects and threads shown in the Agent Threads sidebar. Use Focuses to switch
between sets such as Work and Personal without changing or moving the threads themselves. A Focus
is a filter, not a container. Pinned, snoozed, active, and settled states still belong to each thread.

The **All** tab always comes first in the Focus Strip at the bottom of the sidebar. It shows every
project and thread available in the current company scope. You cannot edit, reorder, or delete it.

## Create and manage Focuses

Select **Create Focus** at the right end of the Focus Strip, then choose a name, icon, color, and
projects. Right-click a Focus in the strip to edit it. Drag Focuses in the strip to change their
order. Connections grouped as one project in the project dropdown also appear as one project here.
Assigning that row applies the Focus to every connection in the group.

A project can belong to one Focus at a time. Selecting a project that already belongs to another
Focus shows **Moving from _Focus name_** and moves the project when you save. You can also assign a
project from the **Focus** section in its project menu. Choose **None** there to remove its Focus
assignment.

Deleting a Focus unlinks its projects. It does not delete projects or threads. The unlinked projects
remain available under **All**.

Focus names, icons, colors, order, and project assignments sync across your machines. The active
Focus does not sync. Each machine remembers its own selection.

## Company scope and search

Company scope applies before a Focus. If none of a Focus's projects are visible in the current
company, Pathway hides that Focus. If the active Focus becomes hidden or is deleted, Pathway switches
back to **All**.

Sidebar search stays global even when a Focus is active. Results are grouped by Focus, with the
active Focus first, followed by other Focuses and unassigned projects under **All**. Opening a result
switches to its Focus and opens the thread.

## Switch with the command palette or keyboard

Open the command palette and choose **Switch Focus…** to select a visible Focus or **All**. Use
`Mod+Alt+G` to cycle through visible Focuses and back to **All**. On macOS, the shortcut is `⌥⌘G`.

## Notifications

The bell in the Focus Strip opens the notification tray. Pathway adds an attention event when:

- an agent run finishes on an unsettled thread
- a thread needs approval
- a thread is waiting for your input
- a run fails

Opening the tray marks every notification as read on all your machines. Read notifications remain
for 7 days and unread notifications remain for 30 days. Pathway keeps at most 200 notifications per
user and removes the oldest records first when the limit is reached.
