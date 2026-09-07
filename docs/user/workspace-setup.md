# Recover from worktree creation failure

If a new thread cannot create its worktree, its workspace setup card shows **Retry** and
**Work locally**.

Choose **Retry** to try creating a fresh worktree from the same base branch. Choose
**Work locally** to continue in the project folder on the connected environment.
Both actions keep the original message and attachments in the same thread and start the agent
once workspace preparation finishes.

Recovery is available while this is the latest failed worktree creation and the agent has not
started. Failures after the worktree was created, such as a setup script failing to start, do
not offer these actions.
