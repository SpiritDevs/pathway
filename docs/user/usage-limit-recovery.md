# Resume after a usage limit

When Claude or Codex stops because its allowance is exhausted, choose **Resume after reset** above the composer. The suggested time is one minute after the reported reset. You can change the date and time, or enter one when the provider does not report a reset.

If the reported reset time has already passed, there is nothing to wait for. The banner reads **Usage allowance reset** and offers **Resume now**, and the failed message's action changes from **Wait until …** to **Resume now**. Either one starts the same recovery straight away, with the thread's context and its unfinished children. Reset times such as "resets 11:50pm" count from when the failure happened, so a failure from yesterday evening is not shown as waiting for tonight.

Scheduling the main thread includes its unfinished children and nested subagents. The parent receives the task references, original assignments, and latest results so it can resume them through the provider's tools. If an existing child cannot resume, the parent can create a replacement using its task and available progress. Completed work is preserved. Children included in a parent timer show that recovery is managed by their parent.

The timer sends a continuation message when it fires. Pathway monitors the parent and child results. If work is still blocked, it uses the newly reported reset plus one minute, or waits one minute when no new reset is available. There are at most **three recovery attempts**. It stops early when the recovery turn and its children finish, and shows when further attention is needed.

Use **Change time** to move a pending timer or **Cancel recovery** to cancel future attempts. Cancelling recovery leaves already running work alone; use the thread's Stop control to stop that work. A new user message, manual stop, archive, deletion, or snooze supersedes the timer.

Recovery runs on the environment hosting the thread. Closing the web, desktop, or mobile client does not cancel it. If the environment is asleep or offline at the scheduled time, the pending timer runs when the environment returns. Recovery does not wake a sleeping computer. You can manage the timer from another connected device.

Automatic child recovery uses the provider's parent/subagent tools and reported lifecycle. The recovery message and child conversations show the actual outcome; scheduling a timer does not mean a child has already restarted. Other providers do not offer automatic usage recovery yet.
