# Conversations and temporary threads

Choose **Conversation** at the bottom of the project picker to start without a project. Select a company and an environment first. A conversation appears in the normal thread list with a chat icon and the label **Conversation**. The agent can use tools and save files in its own working folder on that environment.

Before sending, choose the machine that will run the conversation from the environment selector in the composer’s bottom bar or the action palette’s **Environment** section. Once work begins, the conversation stays on that environment.

Conversations appear in **All** for their company. Enable **Conversations** when editing a Focus to include them there. Several Focuses can include conversations independently.

When you reopen a thread in the web or desktop app, it opens at the newest messages once its history has loaded. If you scroll up while it loads, your position is left alone.

## Attach a project

When all running and queued work has finished, choose **Attach project**. The project must belong to the same environment. Your thread and history stay together, and the original conversation folder remains available to the agent alongside the project workspace. After attachment, the thread follows the project's company and Focus.

Attachment is a one-time action. It does not change whether the thread is temporary.

## Temporary threads

Before sending the first message, use the **Temporary conversation** speech bubble icon at the top right beside the action palette button. A checkmark inside the icon means temporary mode is on; click again to turn it off. Both conversations and project threads can be temporary. A temporary project thread always gets a new dedicated Git worktree; a project that cannot create one cannot host a temporary thread.

Temporary threads skip inactivity settlement. Settling one deletes it immediately and cleans up its owned local working folders, worktree, and branch. A merged pull request can settle it automatically when no work is running or waiting and Git work is finished. Pushing to the default branch alone does not trigger deletion.

Pinning protects a temporary thread from automatic deletion after a PR merges. Snoozing does not. Archived temporary threads stay retained until you restore or explicitly delete them. Bulk settlement applies the same checks and, when needed, a separate warning naming each thread.

Uncommitted changes and unpushed commits block automatic settlement. Manual settlement offers **Review changes**, **Cancel**, and **Discard and delete** when Git work is unfinished. Committing alone does not preserve unpushed work. Files outside Git in a conversation's working folder are deleted without an additional warning. Remote branches and published artifacts remain.

**Settle after completion** remains available. A failed run or unfinished Git work keeps the thread available for review. Finished subagent threads are cleaned up with their temporary parent; active subagent work blocks settlement.

Cleanup runs on the owning environment even when clients disconnect. If local cleanup fails, a notice names the thread and environment and offers **Retry**. Pathway also keeps retrying automatically. Remote branches and published artifacts are not removed by Retry.

## Keep a temporary thread

Choose **Keep conversation** before settlement to make the thread permanent. Its files stay in place, including both folders if a project was attached. Settling a kept conversation retains it and its files. Normal thread deletion still cleans up its owned resources.

Deleting a kept conversation waits for active subagents to finish, then removes their app-owned thread history and owned resources with the parent. Keeping the parent does not leave hidden subagents holding its folders after deletion.

After the first message, a permanent thread cannot be made temporary. A thread made permanent through **Keep conversation** cannot become temporary again. Keep a temporary thread before creating a fork or side chat.
