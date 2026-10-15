# Stop and delegated tasks

The Stop button on web, desktop and iOS sends `run.interrupt` with `stopDelegatedTasks: true`. A plain `run.interrupt` (edit-and-restart, browser takeover, usage pause, `pathway_thread_interrupt`, remote environment interrupts) leaves delegated tasks alone.

A Stop does three things beyond the interrupt:

- In the same command, it drops every delegated-task wake the thread is still owed, not only the stopped run's. A run owes a wake while its cohort has a delivery in flight or one of its app-owned tasks has not delivered (`runsOwingDelegatedWakes`). A queued wake run is cancelled.
- Once the command commits, a `delegated-tasks.stop` effect runs `ThreadManagementService.stopDelegatedTasks`. A command holds only its own thread's lock, so the walk cannot run inside it.
- A run with a `run_interrupt_request` item cannot delegate. Its agent can still call tools until the provider stops it, and a late `delegate_task` would otherwise start a task the walk already passed.

`stopThread` stops one delegated task's thread. Its target is the live run, or else a finished run that is still owed a wake (`delegatedThreadStopTarget`). The target gets `run.interrupt` with `stopDelegatedTasks`, so that thread's own effect stops the level below it. A thread with no target has its tasks stopped directly, because a command with no events cannot commit. If the target finishes before the interrupt lands, the failed dispatch counts as stopped once nothing is left to target.

Command IDs derive from the Stop: `<commandId>:stop:<childThreadId>`, nesting per level. A retried effect or a repeated `task_cancel` with the same `clientRequestId` replays receipts and stops nothing twice. Every task is tried before the walk fails, and the effect retries with the worker's normal limit.

`task_cancel` calls `stopThread` on the task's child thread, even when the task has finished, so later runs in that thread stop too. The published result stays.

Not covered: delegations to another environment are remote threads, not subagent rows, so the walk does not reach them. Queued user messages in a stopped thread still start afterwards; Pathway has no held queue.
