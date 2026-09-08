# Pull request actions

In Source Control → Pull Requests, right-click a pull request row to refresh it, ask a question, explain it, start an agent review, fix findings, copy its link, or open it on GitHub or its source host. The menu also offers draft, ready for review, merge, close, reopen, and conflict actions when the pull request's state and your permissions allow them.

Choosing Merge, Squash, or Rebase from the row menu asks you to confirm that merge method. Closing a pull request also asks for confirmation.

Click a row to open its detail panel. Hold Ctrl or Cmd while clicking to open the pull request in your default external browser, using the same action as Open on GitHub. The current detail panel stays in place.

These shortcuts are available in the web and desktop pull request list.

On web and desktop, right-click a pull request link in a conversation and choose **Attach PR to thread** to track it from that thread. The Version Control section shows a row that opens the attached pull request. While the thread is selected, its status and the sidebar badge refresh automatically, even when the checkout is on a different branch. Other sidebar rows reuse the latest available status. If the attachment matches the checkout’s pull request, Version Control shows one control for it. Open pull requests are green, pending checks are amber, failed checks are red, and merged pull requests are purple. If a status refresh fails, its tooltip explains the error.

A merged attached pull request settles an idle thread automatically. Running work, pending approvals or input, and an explicit choice to keep the thread active take precedence. Attaching a pull request does not switch the checkout or redirect commit and push actions. Detaching it returns the thread to tracking its checkout's pull request.

On iOS, the thread list resolves attached pull requests when it refreshes, including attachments made on another device. The badge shows their state and check results, and merged attachments use the same settlement rules. Pull to refresh to check again. Environments that do not support pull request details keep a neutral attachment badge.
