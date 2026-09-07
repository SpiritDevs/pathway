# Creating a worktree

On web and desktop, a new conversation appears in the sidebar as **Starting** as soon as you send its first message. You can open another conversation and return while it starts. Once the server confirms the conversation, its regular sidebar entry replaces the starting entry. If sending fails, your message returns to its draft for retry.

If you reload during a send, Pathway checks the connected environment before recovering the draft. A message that was never accepted becomes editable again, with its saved attachments and context. Messages already accepted by the server stay in their conversations.

On web and desktop, when you send the first message in a new worktree, a progress card appears beneath your message. It shows the current stage and checks off each completed stage:

- Preparing the workspace, including fetching the base branch when requested.
- Checking out files into the new worktree.
- Starting the project's setup script, or confirming that none is configured.

The active stage has a circular activity spinner. During checkout, a bar shows Git’s reported percentage. Until Git reports a percentage, the bar stays indeterminate.

Open **More details** to see the base branch, branch name at creation, workspace folder, and setup script. On web and desktop, this also shows live setup terminal output. Close the details to stop streaming that output into the card. Scrolling up in the output lets you read earlier lines without being pulled back to the end.

The card stays in the conversation after creation. If preparation fails or is interrupted, it shows the failed or stopped stage and leaves later stages incomplete. Local folders and existing worktrees show the usual thinking or working status without a workspace setup card.

**Worktree created** means the files are ready and the setup script has been started. The script runs in its terminal while the agent begins, so this status does not mean dependency installation or other script commands have finished.

While a new worktree is being prepared, choose **Cancel** to return the submitted message and attachments to a new compose draft. The provisional conversation is removed. Text you typed while cancellation was in progress is kept with the restored message. If you have queued follow-up messages, remove them before cancelling.

Choose **Work locally** to run the submitted message in the project's original folder instead. Pathway skips the remaining worktree setup and removes the worktree it created before starting the agent locally. Existing project folders and existing worktrees are never removed by these actions.

If checkout is already running, either action waits for it to finish safely before cleaning up. The buttons show that the action is in progress. Once the agent has started, preparation can no longer be cancelled or switched. If cleanup fails, the error stays visible and the agent is not started by the requested action.
