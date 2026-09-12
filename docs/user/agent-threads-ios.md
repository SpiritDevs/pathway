# Agent Threads on iOS

When starting a thread, tap the environment dropdown below the project name to choose where
it will run. The menu lists the environments linked to that project and marks the selected
environment with a checkmark. It remains available when the project has only one environment.

The new-thread composer keeps the workspace choice and base branch above the message field.
Tap **+** to open **Composer Options** for attachments, saved prompts, the agent and model,
access settings, and temporary threads. The sheet can expand for more room. Paste images
straight into the message field to attach them without replacing your text.

When a thread connects or reconnects, a status bubble above the composer shows that messages
are syncing. It temporarily replaces the file-change summary until the latest updates arrive.
You can still scroll to the latest message while reconnecting.

Active threads show the project above the thread title, with the branch and environment below it.
The branch stays on the left; the environment name sits on the right beside the provider logo.
The filter icon opens **Thread options**, with **Settings**, **Focus**, and **Filters** submenus.
Notifications and New Thread remain separate toolbar buttons.
Choose a Focus or create one from the Focus submenu. When a specific Focus is selected,
a separate target icon also opens the picker; choosing All threads hides that shortcut.
Edit, reorder, or delete Focuses in **Settings → Focus Views**.
Focus icons match desktop in the picker, selected Focus shortcut, and settings list.
The selected shortcut uses the Focus color. The Focus editor offers the same icon choices as desktop.
The project icon appears beside its name when it can be loaded from the environment. Missing,
unreachable, or unsupported images use a folder icon. Icons are shared across threads in the same
project and cached to avoid repeated downloads.
Pinned threads have a pin beside their last activity time. Working, attention, and error indicators
appear alongside attached pull requests in the details row. Tap anywhere on a row to open the thread.

The logo at the end of an active row identifies its AI provider. Codex, Claude, Cursor, Grok, and
OpenCode show their provider logos; other configured providers show initials. Provider identity
comes from the thread's environment, including when an instance has a custom name.

Snoozed and settled threads stay in their collapsible sections with compact rows.

Swipe right on an active thread to reveal **Pin** (or **Unpin**) and **Sleep**. Sleep lets you choose
one hour, three hours, one day, or one week in a bottom sheet. Tap **Cancel** or swipe the sheet
down to leave the thread awake. Swipe left to reveal **Settle**, or continue swiping
all the way left to settle immediately. These actions sync through the thread's environment.

To bring a thread back, expand **Snoozed** and swipe left for **Wake**, or expand **Settled** and
swipe left for **Reopen**. If an action fails, the app shows an error and keeps the thread in place.

You can paste a copied photo or screenshot from the attachment menu or directly into the message
field. The field also accepts image paste suggestions from the iOS keyboard when offered. Images
become attachments and leave your typed message intact. You can attach up to eight files; pasted
images must be under 10 MB. If an image cannot be read or uploaded, the app shows an error.

Image attachments appear as compact thumbnails with one corner button. Tap the cross to remove
an image. If its upload fails, a retry icon replaces the cross. Tap it to see the failure reason,
retry the upload, or cancel and remove the attachment using the alert.
