# Messages

## Send while an agent is working

In **Settings → General → Queue or steer messages**, choose what the regular **Send** button and
Enter key do while an agent is already working:

- **Steer** sends the message immediately to adjust the active turn.
- **Queue** holds the message until the active turn finishes.

The hint beside the send button shows the shortcut for the other action. Press **Command+Enter** on
macOS or **Ctrl+Enter** on other platforms to use it without changing your preference.

## Edit your latest message

Hover over your most recent message and select the pencil to correct it. Pathway stops the current
task and opens the message in place. Sending the edited text removes the previous response and
turn activity, rolls the agent conversation back, and starts a replacement task.

Editing is available only for your latest message and only until that task changes files. Select
**Send** to restart the task with your corrected message, or press **Escape** to cancel.

## Continue from an agent response

On web and desktop, open an agent response's actions and select **Fork from this response** to
continue from that exact point in a side chat. The parent thread stays visible while the fork opens
as a tab in the right panel. Side chats stay out of the main thread sidebar; hover the parent thread
to see and reopen them. Additional forks open as peer tabs, and closing a side-chat tab permanently
deletes that side chat.

On mobile, the fork opens as a regular full-screen thread.

You can also choose **Side chat** from the web or desktop right panel. Pathway starts it from the
latest completed response, so it inherits the conversation up to that point without adding its
questions or answers to the parent thread. If the parent is still working, the side chat uses the
newest response that had already completed.
