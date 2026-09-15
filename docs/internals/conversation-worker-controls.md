# Conversation replies and delegated work

This replaces the worker-control forms proposed in #173. Web and desktop use one conversation and one composer. Mobile UI work is deferred; optional wire fields preserve existing clients.

## Behavior

- Right-click a message or use its visible Reply action to quote it in the main composer. Quotes persist and remain readable across pagination, subject to the reader’s history boundary.
- Work summaries offer Message worker. Follow-ups target that assignment’s existing thread. Pending messages support edit, cancel, move earlier/later, and send to the active turn. No nested composer or data-entry form.
- Workers ask the owning orchestrator first. It can answer known questions or escalate them as normal messages. Human quoted replies carry durable question and field IDs. Multi-part answers accumulate until complete; they never expand work scope. Private questions stay in the original thread.
- The conversation keeps text, image previews and click-to-play video. Worker follow-up attachments reach the existing thread’s attachment store.
- Delivery statuses distinguish queued, accepted, delivered and failed. Accepted content is immutable. Revision fences reject stale edits/reorders. Receipt recovery does not depend on remaining allowance; new dispatch does.
- Every follow-up gets its own result record and exact run identity. Earlier findings are preserved. Existing inspection, thread continuation, reporting instructions and single-responder routing remain in use.
- Stop requests clear pending instructions; accepted work retains honest unconfirmed status until local recovery. Only supported Pathway-owned descendant questions are routed. Provider-native children have no independent steering API.

## Verification

Focused backend tests cover authorization, history, idempotency, queue ordering, stopped work, question routing and per-run results. Runtime tests cover origin/descendant checks, allowance, receipt recovery and resumable answers. Capture the actual web components in light/dark and narrow layouts, including a short reply/edit/send recording. Publish screenshots, video links and a short explanation via PlanLink; replace #173 only after the implementation is reviewable.
