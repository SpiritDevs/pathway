# Resumed clients send one catch-up summary

When a client resumes or reconnects, it sends one catch-up summary for subscribed Attention Events
that remain unread after that installation's last handled cursor. It does not replay individual
notifications or sounds. A new installation establishes its baseline without summarizing older
history. Quiet-hours delivery advances the same handled state, so an event cannot appear in both a
quiet-hours summary and a reconnect summary. Selecting the summary opens the Notification Tray.
