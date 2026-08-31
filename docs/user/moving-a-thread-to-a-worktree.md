# Move an existing thread to a worktree

You can move an idle Agent Thread from its project folder into a new Git worktree. Open the
thread details panel and select the worktree icon beside the project-folder row, or run
`Move thread to a worktree` from the command palette.

Pathway shows a confirmation before changing the repository. The move includes every tracked and
untracked change in the project checkout, not only files changed by the selected thread. Ignored
files remain in the project folder. If terminal sessions are running in that checkout, the dialog
shows their count and offers `Stop terminals and move`.

After confirmation, the server saves the checkout changes, creates a worktree from the checkout's
current commit, restores the changes in the new worktree, moves the thread, and starts the
project's configured worktree setup action. The move continues if you close the panel, navigate
away, or disconnect. Reopen the thread to see its current phase or final result.

The move waits until this thread and every other thread sharing the project checkout have no active
or queued work. If the changes cannot be restored in the target worktree, Pathway removes the
incomplete target and restores the source checkout. When automatic restoration is not possible,
the result keeps and identifies the transfer stash so the changes can be recovered manually.

If the thread moved but the setup action could not start, use `Run setup again` in the result.
