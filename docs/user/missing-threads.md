# Missing threads

If a shared thread entry cannot be found on its owning environment, Pathway stops loading it and
asks whether you want to remove the stale entry. Removing the entry does not delete project files or
the thread's worktree.

While a thread is still connecting, choose **Stop loading** to cancel the load. You can then choose
**Try again** or **Remove thread**. Pathway always asks for confirmation before removing the entry.
