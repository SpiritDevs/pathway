# Conversation archive and deletion

A conversation lifecycle fence and its work stop requests commit in the same Convex mutation. Pending environment commands and worker messages are cancelled. A claimed command is uncertain: a dispatch acknowledgment is never treated as termination.

The owning environment interrupts the exact assignment run, follows its app-owned subagent edges and completion wakes, and reports again after terminal projections arrive. Completed parents also have their completion-wake cohort stopped. Retained controls are retried on environment reconnect, thread events, and the existing control recovery timer. Late accepted delivery receipts create stopped follow-up assignments rather than reopening work. Missing dispatch receipts and unobservable native subagent termination remain pending.

Run-specific execution attribution keeps allowance and tool authorization associated with the current assignment when a thread has been reused by another conversation. Cancellation never intentionally targets the thread's arbitrary active run.

Archive remains visible in Archived conversations. Restoration is available after stop confirmation and does not restart cancelled work. Delete requires owner confirmation; its tombstone, messages and cancellation evidence are retained. The conversation disappears from the list only after the lifecycle reconciler sees all stop confirmations. No physical record purge is implemented.

Offline machines cannot receive an instantaneous stop. Cloud dispatch is fenced transactionally; already accepted local work may continue until the environment reconnects and confirms stopping. Native subagent interruption rows can be synthetic cascade projections, so they do not prove that an unobservable native worker exited. These cases remain explicitly pending rather than reporting success.
