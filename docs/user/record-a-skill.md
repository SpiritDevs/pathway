# Record a skill

Record a skill lets you show the agent a task once, then has it write a reusable skill from what
you did. You do the task yourself on the Mac. Pathway records the steps, and the agent turns them
into a skill it can find and follow later.

The recording always happens on the Mac that runs the environment, not on the device you are
typing on. Start it from a browser or another computer and the confirmation appears on the host
Mac. Someone has to be at that Mac to accept it and do the task.

Record a skill works in the web, desktop, and iOS apps when the environment is a Mac running the
Pathway desktop app and you are allowed to use Computer there. On iOS it controls that Mac; your
phone is never recorded.

## Before you start

Recording uses the same macOS permissions as Computer: **Accessibility** and **Input Monitoring**.
If either is missing, the recording fails and asks you to allow both for Pathway on the host Mac.

A recording belongs to a thread. In a new conversation, send a message first; Record a skill is
not available until the thread exists.

## Recording

1. Open the Add menu and choose **Record a skill**, or type `/record-skill`. On web and desktop,
   the command palette also has **Record a skill** for the open thread.
2. On the Mac, a window asks whether to start recording and names the Mac. Nothing is recorded
   until you choose **Start recording**. **Cancel** ends it with nothing saved.
3. Do the task. A small floating bar on the Mac shows that recording is on, how long it has run,
   and **Stop** and **Cancel** buttons. The composer shows the same state with its own Stop and
   Cancel.
4. Choose **Stop** to keep the recording, or **Cancel** to discard it.

While recording, Pathway notes the apps and windows you use, what you click, and the text you
type. Password fields, password managers, and System Settings are skipped. Don't do anything
sensitive while recording.

From the moment the confirmation appears until the recording ends, agents and other devices
can't click or type on that Mac through Computer, so only your own actions are recorded. They
can still look at the screen.

Recording stops by itself after 30 minutes, or once it reaches 32 MiB of recorded steps, and keeps
what it has. Locking the screen, putting the Mac to sleep, switching users, quitting Pathway, or
restarting its environment cancels it. Only one recording runs on a Mac at a time. While another
thread is recording, the composer says so and Record a skill is unavailable until it ends.

## Turning it into a skill

When a recording is saved, the composer offers **Create skill**. It adds a prompt to the end of
your current draft without sending it, so you can edit it first. The composer then shows
**Prompt added** until you send it. Send the message and the agent writes the skill, tells you
where it saved it, and lists the inputs it needs.

The recording files stay on the Mac; Pathway never sends them to your device. The prompt only
tells the agent where they are. To write the skill, though, the agent reads them on the Mac and
works from what they contain, so the steps, app names, and text it relies on reach the provider
and model you chose for that thread, just like anything else the agent reads. Discard a recording
you would not want that provider to see.

**Discard** deletes a saved recording. If its prompt is still in your draft unchanged, Discard
removes that prompt too and keeps the rest of your draft. If you edited the prompt, delete it
yourself, because it points at files that no longer exist.

A thread keeps one saved recording. Starting a new one replaces it: the saved recording is
deleted, and its unedited prompt leaves your draft the same way as with Discard. Creating the
skill does not delete the recording. It stays on the Mac, including across restarts, until you
discard it, record again in that thread, or delete the thread.

If you discard or replace the recording from another device, a device with the thread open
removes the unedited prompt from its draft within a few seconds.
