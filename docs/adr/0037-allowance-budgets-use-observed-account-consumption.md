---
status: accepted
---

# Allowance budgets use observed account consumption

Provider subscription allowance is exposed as account-wide quota snapshots, not exact per-assignment metering. Pathway therefore measures a user-selected allowance budget in percentage points of the full selected quota window and conservatively counts all observed account consumption, including unrelated work. This makes the stopping threshold understandable without claiming exact attribution or converting token counts into invented quota percentages. Ten percentage points is an illustrative allocation, not a default.

The assignment's orchestrator, threads, and subagents share a runtime guard across environments. Fallback to another account requires an allocation for that account. Pathway stops admitting work as the threshold approaches, requests interruption of managed active turns at the observed threshold, and pauses allowance-controlled work when reliable readings are unavailable. Delayed reporting and in-flight work can overshoot; this is not an exact provider-side spending cap.

Work remains paused for the user unless automatic resumption is explicitly specified with a timezone and allowance allocation. Provider resets do not renew the assignment's authorization. These controls apply to ordinary agents and orchestrators; see the [design and acceptance criteria](../plans/pathway-provider-allowance-budgets.md).
