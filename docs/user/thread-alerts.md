# Thread alerts

Thread alerts play a sound, show an OS notification, or both when an agent finishes, needs permission,
asks for input, or fails. They are available on desktop and web. Sign in to Pathway Cloud to use them.

## Turn alerts on

Click the bell beside a thread to enable all four alert types. Click again to disable them.
An enabled bell stays visible. A dotted bell means some alert types are enabled. An off bell appears
when you hover or focus the row.

Open the Alert Menu to change individual events. Right-click the bell, hold Control or Command while
hovering it, press Control or Command + Enter while it has keyboard focus, or long-press on touch.
Each event can inherit, be on, or be off. Use project defaults removes the thread's overrides.

Settings → Notifications contains the global defaults and project overrides. Project Settings also
has the project's alert choices. Each event follows the closest explicit choice, starting with the
thread, then the project, then the global default. Repository choices apply across matching worktrees
and environments. These choices sync across your devices.

All global alert types start off. Sound starts on, so enabling a thread bell is enough to request a
sound for its next eligible event. Browser audio may need a click or key press before it can play.
The command palette has Toggle alerts for current thread and Open Notifications settings. You can
assign a shortcut to Toggle alerts in Keybindings.

## Choose how this device alerts

Under This device, sound and OS notifications have separate switches. OS notifications start off.
Pathway asks for notification permission when you enable that switch. If permission is blocked,
allow Pathway in the browser's site permissions or your system's notification settings. Pathway keeps
your saved preference so you can restore permission later.

Choose a built-in sound, System default, or upload an MP3, WAV, M4A, OGG, or WebM file. Uploaded audio
must decode on this device, be at most 5 MB, and last no more than 10 seconds. Preview plays the chosen
sound; Remove deletes the uploaded file. If that file becomes unavailable, Pathway uses System
default. Browsers use the Pathway default tone when they cannot play a system alert sound.

Sound choices, uploaded audio, delivery switches, and quiet hours stay on this installation. OS
notifications are silent, with the sound switch controlling the audible cue. Test alert exercises
the enabled channels immediately without adding a tray entry or unread count.

## Quiet hours and missed activity

Set quiet hours by weekday and local start and end time. An overnight schedule belongs to the day
it starts. During quiet hours, events still enter the Notification Tray. Afterwards, Pathway sends
one summary of eligible events that remain unread. Reading the tray during quiet hours removes
those events from the summary.

A resumed or reconnected installation sends one catch-up summary instead of replaying individual
alerts. A new installation starts with the current history and does not alert for older events.
Enabling a policy does not make existing tray history eligible. Disabling a policy cancels its
pending alerts.

## Delivery and reading

Pathway stays silent when this installation is focused on the thread that produced the event.
Other devices can still alert. Browser tabs coordinate delivery, and each installation handles an
event at most once. Events arriving from one thread within three seconds produce one sound and one
OS notification that updates with the latest event and a count.

Snoozed threads can alert. Settled and archived threads keep their preferences but stay silent until
reopened. Deleting a thread removes its override. Muting alerts never removes tray history.

Clicking an individual OS notification opens its environment and thread. Opening a thread marks its
notifications read and removes them from the Notification Tray. Clicking a summary opens the tray
and marks its notifications seen. They stay unread until you open their threads.
Individual notifications show the thread title, event label, and project name. Their bodies exclude
prompts, commands, file paths, and agent output.

Web alerts require a running page. Closing the browser stops web delivery. OS notification controls
can suppress banners independently of Pathway. Use Test alert to check the current device's channels.
Mobile continues to use its existing push preferences.
