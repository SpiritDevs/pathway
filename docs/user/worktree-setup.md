# Creating a worktree

When you send the first message in a new worktree, a progress card appears beneath your message. It shows the current stage and checks off each completed stage:

- Preparing the workspace, including fetching the base branch when requested.
- Checking out files into the new worktree.
- Starting the project's setup script, or confirming that none is configured.

Open **More details** to see the base branch, branch name at creation, workspace folder, and setup script. On web and desktop, this also shows live setup terminal output. Close the details to stop streaming that output into the card. Scrolling up in the output lets you read earlier lines without being pulled back to the end.

The card stays in the conversation after creation. If preparation fails or is interrupted, it shows the failed or stopped stage and leaves later stages incomplete. Local folders and existing worktrees skip the checkout stage.

**Worktree created** means the files are ready and the setup script has been started. The script runs in its terminal while the agent begins, so this status does not mean dependency installation or other script commands have finished. The native iOS card shows the same creation stages and workspace details; live terminal output is available on web and desktop.
