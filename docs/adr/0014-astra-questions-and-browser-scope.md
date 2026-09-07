# Astra questions and browser scope

Status: implemented scope with verification and external boundaries recorded in the [implementation report](../internals/astra-browser-verification-2026-09-07.md).
Date: 2026-09-07.
Evidence: [readiness audit](../internals/astra-readiness-audit-2026-09-07.md).

## Accepted product decisions

Corey selected these behaviors during the audit interview:

- A non-blocking question appears as a button and opens a question picker near the composer, similar to Codex. Normal conversation remains available while the agent continues working.
- Unanswered questions survive reconnects. An explicit answer after the agent finishes starts a follow-up turn in the same task.
- This effort covers a reliable Pathway browser, including remote use. Native desktop app control comes later.
- Web and native iOS must be able to use the browser without a connected Pathway desktop. A desktop-only automation host is insufficient.
- Pathway owns the remote model manifest. T3's implementation is a reference, not the production source of Pathway's model policy.
- When a new async question arrives, show the question button and count without opening the picker or taking typing focus.
- Browser scope includes recent T3 browser improvements, reliable new tabs and popups, screenshots and video capture, and agent-usable password-manager and passkey support. Apple Passwords/iCloud Keychain is the first requested system provider. An internal Pathway-account password vault is also required. Apple browser entitlement approval remains an external dependency.

The implementation uses an independent question button and picker with explicit submission. Closing the picker preserves the underlying question. Remaining interview questions below record policy choices that were not individually answered; Corey subsequently authorized implementation with reasonable defaults.

## Implementation boundaries

Corey authorized implementation after this interview. The async-question, manifest, environment-browser, and internal-vault boundaries below are implemented. Existing Apple Passwords integration remains incomplete; device-bound Touch ID configuration is a separate capability.

A question group has stable identity, originating environment and provider thread, its questions, lifecycle, and answer transport. Separate message replies from process-bound RPC replies. A question remaining unanswered does not, by itself, mean a turn is stopped.

For async Codex questions, save resolution and a user answer message atomically. Reuse existing active-turn steering and idle-turn start. Track delivery through durable receipts. Keep ordinary question RPCs and approvals on their existing provider response paths.

### Async-question implementation and evidence

Message-replied questions now have stable provider-thread/item identity, separate transport and blocking metadata, and durable pending state. Completed async messages produce question cards without pretending the provider turn has ended. Repeated delivery cannot reopen an answered group. Existing RPC providers keep their response transport and optional blocking, secret, custom-answer, and multi-select metadata.

Answer submission validates the complete group and commits one answer message with resolution and the delivery effect. The serialized command checks the original provider conversation before dispatch. It steers active work or starts a follow-up after completion. A definite no-active-turn rejection uses the same saved message for the follow-up; an arbitrary network error does not trigger another turn. Outbox failure or recovery with undelivered receipts reopens the question for an explicit retry. Pending questions survive reconnect and runtime recovery, and blocking requests retain priority in the task summary.

The focused backend suite passed 82 tests across the adapter, runtime recovery, turn control, runtime requests, model options, and async replay integration. Four replay scenarios cover active steering, an answer after completion, completion racing with steering, and a native subagent answer routed to the child conversation with no synthetic Pathway run. Duplicate notifications and repeated answers are included. The client/protocol suite passed 13 tests, including preservation of the JSON-RPC envelope id. Provider-originated resolution now matches that id and native thread, cancels only the corresponding request/card, and interrupts its continuation without sending an empty answer. This is code-level evidence, not live Codex, web, or iOS proof. Provider acceptance followed by a process crash before its receipt remains ambiguous; the UI exposes a retry instead of promising exactly-once delivery across that external boundary.

The manifest lives at `apps/server/src/provider/model-manifest.json` in SpiritDevs/pathway. It controls explicit current/legacy classification, with a bundled fallback, validated last-good disk cache, and hourly remote refresh. Unknown discovered models remain visible; existing main and utility defaults remain unchanged. Provider discovery determines account availability and model options. Never rewrite an existing task's model or the utility-generation default merely because metadata refreshed.

Browser execution belongs to an explicit host with stable tab and profile identity. Remote server ports need an authenticated connection path. Native app control and cookie import are separate scope decisions.

The [browser audit extension](../internals/browser-readiness-extension-2026-09-07.md) records credential, capture, and additional upstream findings. Password-manager and passkey support are in scope; they are not assumed to follow from cookie import or Pathway's Clerk sign-in. Recommend credential-mediated sign-in without raw secrets in model messages. Approval duration, account assignment, provider compatibility, and remote authenticator access remain open. Recording ownership must follow the browser host to support independent clients.

The independent web/iOS requirement means browser hosting must be available outside Electron. The implementation runs Chromium on the agent's environment, with authenticated frame streaming and input through the existing environment connection. This puts the browser beside remote loopback services. It does not by itself make those services directly reachable from the user's device. Desktop retains its local browser and provides an explicit environment-browser selector. Browser process lifetime, profile persistence, popup handling, and takeover ownership must survive client disconnects according to explicit policy.

## Interview record and adopted defaults

The questions below are retained as the audit record. Under the subsequent implementation authorization, defaults remain unchanged; the manifest lives in SpiritDevs/pathway; unclassified discovered models remain visible; complete question groups require explicit submission; the first suggestion is preselected; closing the picker leaves the question pending. Browser profiles are per task, human control uses explicit takeover, and recordings capture one selected tab without audio. Apple provider integration and remote authenticator access remain unresolved. See the implementation report for tested behavior and remaining limits.

### Original questions

### Release and model metadata

1. Add Astra while keeping current defaults, or make it the default for new tasks? Preserve explicit existing task selections either way.
2. Should the remote manifest initially own only current/legacy labels and display metadata, or also catalogs and defaults for providers such as Claude?
3. Ownership answered: Pathway-owned manifest. Exact repository location and update workflow remain open; SpiritDevs/pathway with reviewed upstream updates is recommended.
4. If the runtime discovers a model absent from the manifest, show it as current/unknown or hide it under legacy? Recommendation: visible without a legacy label until explicitly classified.
5. When Astra is not available from a configured CLI, show an unavailable/update explanation or allow an advanced custom entry? A custom entry must not pretend access or borrow another model's capabilities.

### Question behavior

6. Answered: show the button and count; preserve typing focus. Open the picker only when selected.
7. When multiple groups arrive, should one popup list all groups or step through them oldest first? Should users be able to answer a newer group first?
8. Should users submit a complete question group together or answer each question independently? Recommendation: whole group initially, matching the provider payload and existing picker.
9. Should the first suggested answer be preselected? OpenAI's tool description expects preselection but explicitly requires submission. No timeout should submit it.
10. Is there a Dismiss question action? If so, should it send a message saying the user chose not to answer, or just resolve the UI state without starting work? Closing the popup should do neither.
11. Should questions raised by a subagent appear in the parent task's question button, its own task, or both? Delivery must target the subagent that asked.
12. If a provider/model changes, a task is interrupted, archived, forked, or rolled back while a question is open, which groups remain actionable? Recommendation: no automatic copying into forks; preserve history and make invalid origins explicit.
13. How should pending questions affect task badges, notifications, snooze, and settlement while work continues? Recommendation: an attention indicator alongside running state, not a blocked status.
14. Should submitted answers be visible in ordinary conversation and in the resolved question history? Recommendation: both through references to one saved answer, not duplicated records.
15. Should question drafts survive only navigation, or application restart as well? Secret answers should not be persisted as ordinary composer drafts without a specific policy.

### Browser ownership and remote use

16. For an agent running remotely, should Chromium run on that environment, on a connected desktop, or follow an explicit user choice? This determines the remote preview design.
17. Answered: web and native iOS must work without a connected desktop. The browser hosting and presentation/input transport must support that requirement.
18. Should named browser profiles and per-project defaults ship in this effort? Cookie import can follow separately.
19. When a person clicks inside an automated page, should that pause the agent, request takeover, or share control? Recommendation: preserve explicit takeover until a tested alternative is agreed.
20. Does closing a browser tab stop the task, stop browser automation only, or keep the tab running in the background? Hiding the panel should be a separate action.
21. Should the agent handle OAuth popups itself where possible, or always hand sign-in to the person? How should popup progress be visible from remote clients?
22. What existing browser failures matter most to Corey? A concrete example will guide the first integrated test after source fixes.

### Verification

23. Answered: isolated browser and iOS verification is authorized. The implementation used a worktree-local server and a separate iOS simulator.
24. Confirm the intended T3 fork if it differs from pingdotgg/t3code. The audit has verified that repository's relevant commits.

### Expanded browser interview

25. Answered: Apple Passwords/iCloud Keychain first, plus an internal password vault synchronized through the Pathway account.
26. Should account/site access be approved once and reusable until revoked, approved per fresh sign-in, or unattended for explicitly assigned accounts? Provider-required biometric/device interaction still applies.
27. Should video be silent, include optional tab audio, or also support microphone narration?
28. Should a recording capture one selected tab or follow the task across tabs and OAuth popups? Recommendation: one explicitly selected tab initially, with its target always visible.
29. Are viewport, full-page, and element screenshots all required in the first release? The audit proposes coverage for all three.

## Original work sequence

1. Settle model-default and metadata ownership choices. Verify Astra availability on intended provider instances.
2. Implement async question contracts, adapter mapping, durable answer delivery, recovery, and client popup behavior together with focused tests.
3. Adapt small browser correctness fixes for popup and debugger lifetimes, plus coordinate metadata and hidden rendering.
4. Implement the agreed remote browser ownership and Connect transport. Verify on a separate machine and native iOS as required.
5. Deliver the agreed password-manager and passkey integrations, profile policy, and screenshot/video improvements. Prove remote authentication feasibility before finalizing the host choice. Cookie import and native computer control remain separate decisions.

This sequence avoids coupling the model picker release to unrelated provider catalog migrations or an incidental Electron upgrade. It does not reduce the accepted requirement for reliable remote browser use.
