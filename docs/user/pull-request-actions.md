# Pull request actions

In Source Control → Pull Requests, right-click a pull request row to refresh it, ask a question, explain it, start an agent review, fix findings, copy its link, or open it on GitHub or its source host. The menu also offers draft, ready for review, merge, close, reopen, and conflict actions when the pull request's state and your permissions allow them.

Choosing Merge, Squash, or Rebase from the row menu asks you to confirm that merge method. Closing a pull request also asks for confirmation.

Click a row to open its detail panel. Hold Ctrl or Cmd while clicking to open the pull request in your default external browser, using the same action as Open on GitHub. The current detail panel stays in place.

These shortcuts are available in the web and desktop pull request list.

A thread can track several pull requests. Pathway links pull requests it detects when a turn finishes, including links returned by PR creation commands. On web and desktop, you can also right-click a pull request link in a conversation and choose **Attach PR to thread**.

The thread's Version Control section stacks its linked pull requests. Each row shows its own status and offers **Merge** or **Ready** when the provider allows that action. Its action menu lets you open it on GitHub or its source host, copy its link, or **Unlink from thread**. Merging asks for confirmation. Links remain attached when you change branches; attaching a PR does not change the checkout or redirect commit and push actions.

When several PRs are linked, the thread list shows a multiple-PR icon and count. Hover over the thread or click that badge to see every PR. You can move into the card to open, merge, or unlink a PR. Open PRs are green, pending checks are amber, failed checks are red, and merged PRs are purple. While the thread is selected, all its linked PR statuses refresh automatically; other rows reuse the latest available status.

An idle thread settles automatically only after **all linked PRs are merged**. Open, closed without merging, and unknown statuses keep it active. Running work, pending approvals or input, and an explicit choice to keep the thread active take precedence. You can still settle a thread manually. Unlinking removes only that PR from the thread; it does not close or delete it on the provider, and automatic detection will not link it again. You can attach it again explicitly.

On iOS, tap the thread's PR badge to see links and individual statuses. Workspace → Source control and Pull requests show the linked PRs with merge and unlink actions. Pull to refresh the thread list to check statuses again. Environments that do not support PR details keep a neutral attachment badge.

## Keeping thread PR status current

The thread’s Version Control panel checks its PR status when you return to the thread or window, after an in-app push, and when the agent finishes a turn. It continues checking periodically while the PR row is open.

“Checking merge status…” means the latest result is still being checked, including when the host has not finished calculating mergeability. “Couldn’t refresh status” offers **Retry**. You can also choose **Refresh** from the PR row’s menu to check again. Merge and conflict-resolution actions are offered once the current check succeeds.
