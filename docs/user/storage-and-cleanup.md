# Storage and cleanup

Open **Settings → Storage & cleanup** to see available disk space across your environments. Each environment shows its disks, their available capacity, and when Pathway last measured them. Offline environments show saved measurements with their age. Reconnect them to get current readings or run cleanup.

Use the environment dropdown to select several machines. The thread table starts with archived, settled, and snoozed conversations. Choose **All threads** to include active conversations, or search by title, branch, or folder. Thread details follow your selected company. Disk capacity always describes the whole machine.

## Understand the sizes

The worktree column estimates the space occupied by the whole folder, including dependencies, build output, and ignored files. Shared worktrees are identified and count once in a cleanup preview. Unmeasured folders show **Not measured** while Pathway works through its storage inventory.

The conversation estimate measures the conversation records. It excludes shared database pages, provider logs, and attachments. It is not an estimate of disk space that deleting the conversation would recover. Database files can retain free pages for reuse after records are deleted.

Other applications can change available space while cleanup runs. Cleanup history reports the measured change in available space, which can differ from the worktree estimate.

## Reclaim worktree space

Select worktrees and choose **Review cleanup**. The preview groups them by environment and shows estimated recovery and reasons for skipping protected items. Confirm removal to start. Every environment checks the worktree again before removing it.

Cleanup removes the entire eligible worktree, including ignored files such as local configuration and databases. It preserves the conversation and Git branch. Tracked changes, untracked files that are not ignored, and unpublished commits block removal. So do running agents, pending launches, open terminals, snoozed threads, and **Keep worktree** protection. Pathway never removes a project's main checkout. Every thread sharing a worktree must qualify.

Use the thread's action menu to select **Keep worktree** or **Allow worktree cleanup**. The same menu lets you unarchive, wake, or resume a thread. **Delete thread** is a separate action with its own confirmation.

After reclamation, the thread says that its worktree was removed to free space. Choose **Recreate worktree** before continuing work. Dependencies and generated files may need rebuilding.

Unlinked worktrees appear in a separate section for manual review. For a projectless working folder, use **Delete thread** to remove the conversation and its folder together. These folders are excluded from worktree reclamation because they do not have a Git branch from which to recreate their files. Temporary threads retain their existing policy of deleting the conversation on settlement.

## Schedule cleanup

Choose **Policy** on an environment card. Scheduled cleanup starts off. When you enable it, select **7, 14, 30, or 60 days**. Pathway counts continuous archived or settled eligibility; resuming work resets the clock. The environment saves your inactive-thread preference when you save the policy so it can identify settled threads without an open client.

Cleanup runs on that environment even when the dashboard is closed. Each environment keeps its own policy. **Cleanup defaults** saves a reusable template for your account on the current client. Apply those defaults to selected environments, or choose **Use saved defaults** in an environment's policy. Saving defaults does not enable cleanup on newly connected environments. Offline policy changes are skipped and must be retried explicitly.

## Respond to low storage

The default warning limits are **20 GB or 10% available**. The default critical limits are **10 GB or 5% available**. Either limit can trigger the corresponding warning. Adjust them in the environment's policy.

Pathway shows low-storage status outside this dashboard and alerts you when an environment crosses a threshold. When a conversation targets a critically low machine, it offers **Clean up**, **Choose another environment**, and **Continue anyway**.

The conversation cleanup action shows an estimate before you click. It reclaims the oldest eligible worktrees until available space exceeds both warning limits. It can bypass the scheduled age limit, but retains the other protections. It keeps your draft and does not send your message. Emergency cleanup always requires your click. Scheduled tasks continue under their existing scheduling rules.

**Avoid critically low environments in Auto** starts off. Enable it to prefer another eligible machine for new conversations when a healthy alternative exists. Existing conversations stay on their environment.

## Follow cleanup progress

Cleanup history records manual and scheduled runs for each environment. Successful removals stay completed even if another removal fails. Retry targets failed worktrees, and each retry gets another eligibility review. Offline environments are skipped; Pathway does not queue their deletion for a later reconnection.

**Cancel remaining** stops before the next worktree. It cannot restore worktrees already removed. If cleanup cannot recover enough space, use the remaining blockers and disk readings to decide what to clean up next.
