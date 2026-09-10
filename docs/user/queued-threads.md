# Queued threads and messages

Sending saves your thread and message before its environment starts work. A queued thread stays in
Agent Threads when you leave the conversation or close the app. After cloud sync, you can reopen
it on another device.

**Waiting to sync** means the message is saved on this device and still needs a cloud connection.
Keep this device's application data until it finishes syncing. **Queued · Saved to cloud** means
Pathway Cloud has saved the message and its attachments. The selected environment can pick it up
when it reconnects, even if the sending app is closed.

A thread may show **Starting** after the environment accepts it while its workspace or agent is
being prepared. You can continue navigating during startup. Additional queued messages are
submitted in order as separate turns.

Open a queued thread to read its pending messages. You can edit or cancel a message until the
environment accepts it. Canceling the first message of an unstarted thread cancels its pending
follow-ups as well. Canceled messages remain available to retry; retrying places them at the end
of the queue. If a send's acknowledgement is uncertain, reconnect before changing that message
so Pathway can confirm whether it was accepted. If a prerequisite is missing, the thread stays saved with the reason and a
retry action. A connection failure does not discard your work.

## Move an unstarted thread

Use **Move to another environment** to change where an unstarted thread will run. Choose the
replacement environment, its directory for the same project, and an available provider and model.
The thread keeps its identity and saved messages and attachments. Once the move succeeds, the
original environment cannot accept that queued work.

A thread already accepted by its environment cannot be moved through this action. If acceptance
and a move happen at the same time, Pathway tells you which action succeeded. Existing conversation
history stored on an unavailable environment is not copied by moving queued work.

All clients and environments need a version that supports cloud queued delivery. An older
environment keeps the work queued until it is updated and connected.
