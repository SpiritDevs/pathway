# Focuses

A Focus filters the projects and threads shown in the Agent Threads sidebar. Use Focuses to switch
between sets such as Work and Personal without changing or moving the threads themselves. A Focus
is a filter, not a container. Pinned, snoozed, active, and settled states still belong to each thread.

The **All** tab always comes first in the Focus Strip at the bottom of the sidebar. It shows every
project and project thread available in the current company scope. You cannot edit, reorder, or delete it.

## Create and manage Focuses

Select **Create Focus** at the right end of the Focus Strip, then choose a name, icon, color, and
projects. Right-click a Focus in the strip to edit it. Drag Focuses in the strip to change their
order. Connections grouped as one project in the project dropdown also appear as one project here.
Assigning that row applies the Focus to every connection in the group.

A project can belong to one Focus at a time. Selecting a project that already belongs to another
Focus shows **Moving from _Focus name_** and moves the project when you save. You can also assign a
project from the **Focus** section in its project menu. Choose **None** there to remove its Focus
assignment.

**Conversations** appears in the strip when you have unarchived normal or temporary conversations. These
threads appear only in Conversations, including when All is selected. Sending the first message
in a new conversation switches to Conversations and brings the thread into view. Conversations
remain scoped to the company selected at creation. Attaching a project makes the thread follow
that project's Focus.

Deleting a Focus unlinks its projects. It does not delete projects or threads. The unlinked projects
remain available under **All**.

Focus names, icons, colors, order, and project assignments sync across your machines. The active
Focus does not sync. Each machine remembers its own selection.

## Company scope and search

Company scope applies before a Focus. If none of a Focus's projects are visible in the current
company and it does not include Conversations, Pathway hides that Focus. If the active Focus becomes hidden or is deleted, Pathway switches
back to **All**.

Sidebar search stays global even when a Focus is active. Results are grouped by Focus, with the
active Focus first, followed by other Focuses and unassigned projects under **All**. Opening a result
switches to its Focus and opens the thread.

## Switch with the command palette or keyboard

Open the command palette and choose **Switch Focus…** to select a visible Focus or **All**. Use
`Mod+Alt+G` to cycle through visible Focuses and back to **All**. On macOS, the shortcut is `⌥⌘G`.

On web and desktop, use a two-finger horizontal trackpad swipe over the sidebar's thread list to
slide between Focuses in strip order. The carousel wraps in both directions, including **All**.
Each swipe moves one Focus, even when the trackpad keeps scrolling with momentum. Vertical
scrolling still scrolls the thread list. The slide animation respects reduced-motion settings.

## Notifications

The bell in the Focus Strip toggles the notification tray open and closed. Pathway adds an attention event when:

- an agent run finishes on an unsettled thread
- a thread needs approval
- a thread is waiting for your input
- a run fails

**Clear all** removes all read and unread notifications from your account. It appears in the tray header whenever notifications are present.

Opening the tray marks notifications as seen on all your machines. Selecting a notification marks it as read. The bell is hidden when there are no notifications, shows a grey dot when all are read, a green dot when unread notifications have been seen, and a count for new unread notifications since the tray was last opened. Read notifications remain
for 7 days and unread notifications remain for 30 days. Pathway keeps at most 200 notifications per
user and removes the oldest records first when the limit is reached.

Starting a project thread from Conversations switches to the profile containing that project after the first successful send, or to All if the project has no profile.

Right-click the Conversations button to **Archive All** or **Delete All Chats** in the current conversation list. Deletion asks for confirmation and permanently removes their history. When no unarchived conversations remain, the button disappears and the sidebar returns to All. Archived chats remain available in Storage & cleanup.
