# Missing threads

If a shared thread entry cannot be found on its owning environment, Pathway keeps trying to load it.
This allows newly created threads to appear when their workspace takes longer than usual to prepare.

Choose **Stop loading** to cancel the load. You can then choose **Try again** or **Remove thread** if
you know the entry is stale. Removing the entry does not delete project files or the thread's
worktree, and Pathway always asks for confirmation first.
