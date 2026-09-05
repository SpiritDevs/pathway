# Agent Threads on iOS

Active threads show the project above the thread title, with the branch and environment below it.
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
one hour, three hours, one day, or one week. Swipe left to reveal **Settle**, or continue swiping
all the way left to settle immediately. These actions sync through the thread's environment.

To bring a thread back, expand **Snoozed** and swipe left for **Wake**, or expand **Settled** and
swipe left for **Reopen**. If an action fails, the app shows an error and keeps the thread in place.
