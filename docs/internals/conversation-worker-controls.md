# Conversation replies and delegated work

This replaces the worker-control forms proposed in #173. Web and desktop use one conversation and one composer. Mobile UI work is deferred; optional wire fields preserve existing clients.

## Behavior

- Choose Reply from a message’s context menu to quote it in the main composer. The same menu is available through right-click and the keyboard-accessible menu button. Quotes persist and remain readable across pagination, subject to the reader’s history boundary.
- Work summaries offer Message worker. Follow-ups target that assignment’s existing thread. Pending messages support edit, cancel, move earlier/later, and send to the active turn. No nested composer or data-entry form.
- Workers ask the owning orchestrator first. It can answer known questions or escalate them as normal messages. Human quoted replies carry durable question and field IDs. Multi-part answers accumulate until complete; they never expand work scope. Private questions stay in the original thread.
- The conversation keeps text, image previews and click-to-play video. Worker follow-up attachments reach the existing thread’s attachment store.
- Conversation receipts use Sending, Delivered and Read independently of the worker delivery queue. Human receipts use visible-message read positions; orchestrator claims persist the specific reader identity. Group reader avatars appear once per reader, beneath their latest read outgoing message. Work delivery still distinguishes queued, accepted, delivered and failed. Accepted content is immutable. Unconfirmed delivery retries every 15 seconds after immediate retries; persisted accepted rows are replayed after a restart. Archiving pauses new delivery while still allowing receipt recovery. Revision fences reject stale edits/reorders. Receipt recovery does not depend on remaining allowance; new dispatch does.
- Every follow-up gets its own result record and exact run identity. Earlier findings are preserved. Existing inspection, thread continuation, reporting instructions and single-responder routing remain in use.
- Loaded history pages remain reactive, including delivery revisions and control permissions. Worker targets come from the assignment, and runtime answer provenance is overwritten at the client RPC boundary.
- Stop requests clear pending instructions, including those on completed assignments with active follow-ups; accepted work retains honest unconfirmed status until local recovery. Only supported Pathway-owned descendant questions are routed. Provider-native children have no independent steering API.

## Verification

Focused backend tests cover authorization, history, idempotency, queue ordering, stopped work, question routing and per-run results. Runtime tests cover origin/descendant checks, allowance, receipt recovery and resumable answers. Capture the actual web components in light/dark and narrow layouts, including a short reply/edit/send recording. Publish screenshots, video links and a short explanation via PlanLink; replace #173 only after the implementation is reviewable.
