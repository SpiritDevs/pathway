# Settling threads

Settle a thread when you are finished with it and want to move it out of your active list.

An idle thread with linked pull requests settles automatically when all of them are merged. An open, closed without merging, or unknown PR status keeps it active. Unlink a PR from the thread if it should no longer count toward settlement. The settled banner and sidebar use the same linked PR statuses. Once a PR is reported as merged, an older cached status does not keep it active or offer Merge again.

If the agent is still working, hold Control while hovering over **Settle** to reveal **Settle after completion**. Control-click the button to schedule the thread to settle only after the agent has returned its final response and no queued or background work remains. You can also choose **Settle after completion** from the thread action menu, including on touch devices.

While this is scheduled, a blue timer appears beside the thread controls and beside the working status in the sidebar. Click the blue timer in the thread controls, or Control-click **Settle** again, to cancel it.

If a thread is stuck showing work that has already finished, right-click it and choose **Force settle thread**. This cancels current and queued work, dismisses pending requests, stops its provider sessions and terminals, and moves it to Settled. You can also find it in the chat header action menu. It requires an environment that supports force settlement.

Choose **Un-settle thread** to return it to the active list. Cancelled work does not restart automatically.

[Temporary threads](conversations-and-temporary-threads.md) are deleted when settled and cannot be
un-settled. They skip inactivity settlement. Uncommitted changes or unpushed commits block automatic
settlement; manual settlement offers Review changes, Cancel, and Discard and delete. Settle after
completion keeps a temporary thread for review when a run fails or Git work remains unfinished.
