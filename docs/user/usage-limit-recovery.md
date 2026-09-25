# Resume after a usage limit

When Claude or Codex stops because its allowance is exhausted, choose **Resume after reset** above the composer. The suggested time is one minute after the reported reset. You can change the date and time, or enter one when the provider does not report a reset.

If the reported reset time has already passed, there is nothing to wait for. The banner reads **Usage allowance reset** and offers **Resume now**, and the failed message's action changes from **Wait until …** to **Resume now**. Either one starts the same recovery straight away, with the thread's context and its unfinished children. Reset times such as "resets 11:50pm" count from when the failure happened, so a failure from yesterday evening is not shown as waiting for tonight.

Scheduling the main thread includes its unfinished children and nested subagents. The parent receives the task references, original assignments, and latest results so it can resume them through the provider's tools. If an existing child cannot resume, the parent can create a replacement using its task and available progress. Completed work is preserved. Children included in a parent timer show that recovery is managed by their parent.

The timer sends a continuation message when it fires. Pathway monitors the parent and child results. If the parent or a child is still stopped by the usage limit, it uses the newly reported reset plus one minute, or waits one minute when no new reset is available. There are at most **three recovery attempts**. Recovery finishes as soon as the resumed turn completes without hitting the limit again. Children it restarted keep working, and a child the parent chose to leave stopped doesn't trigger another attempt. When further attention is needed, the banner says so.

Use **Change time** to move a pending timer or **Cancel recovery** to cancel future attempts. Cancelling recovery leaves already running work alone; use the thread's Stop control to stop that work. A new user message, manual stop, archive, deletion, or snooze supersedes the timer.

## Pause before the limit

When less than 10% of a usage window applies to the thread's model, a **Usage almost used up** banner appears above the composer. It shows how much is left and when that window resets. Dismissing it hides the warning for that thread and window until the window resets or the app reloads.

While the agent is working, choose **Pause until reset** from that banner, or from the **⋯** menu beside **Usage** in the thread details panel. The agent finishes its current step, such as a running command or subagent, and then stops. The thread stays paused until one minute after the tightest window resets, then continues where it stopped. The continuation works like a scheduled recovery, including its children and up to three attempts.

While a thread is pausing or paused, the banner shows the resume time. **Resume now** continues immediately, **Change time** moves the resume time, and **Cancel pause** leaves the thread stopped so you can send a message instead. The usage menu offers **Cancel pause** while the step finishes, then **Resume now**. If the turn finishes before the pause takes effect, there is nothing to resume and the pause ends. Sending or queueing a message ends the pause, and pausing is unavailable while messages are already queued. Pausing starts from web and desktop; on iPhone and iPad, a paused thread shows its resume time and offers **Resume now** and **Cancel pause**.

## Long pauses on Claude

Claude's prompt cache expires while a thread waits. When a Claude session with at least 100,000 tokens has been idle for more than 70 minutes, recovery compacts it with `/compact` before continuing, so the resumed turn does not re-read the whole conversation. This applies to paused threads and to recovery after a usage limit. If Claude asks whether to compact while resuming unattended, recovery answers yes. If compaction fails, recovery stops instead of resuming the whole conversation. The banner says so; compact the thread or send a message to continue.

## Where recovery runs

Recovery runs on the environment hosting the thread. Closing the web, desktop, or mobile client does not cancel it. If the environment is asleep or offline at the scheduled time, the pending timer runs when the environment returns. Recovery does not wake a sleeping computer. You can manage the timer from another connected device.

Automatic child recovery uses the provider's parent/subagent tools and reported lifecycle. The recovery message and child conversations show the actual outcome; scheduling a timer does not mean a child has already restarted. Other providers do not offer automatic usage recovery yet.
