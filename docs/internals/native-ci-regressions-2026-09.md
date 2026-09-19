# Native CI findings, 19 September 2026

[Native Apple run 35403744821](https://github.com/SpiritDevs/pathway/actions/runs/35403744821)
built and launched the iPhone app on the native Mac fleet. Its first lane exposed
stale UI-test navigation and an issue-drag crash before the run was cancelled.
The queued iPad and visionOS lanes did not run. These findings do not establish
a passing native suite; a fresh run at the corrected commit is required.

## Fixture navigation

- Email now defaults to connected Mail. The parity fixture seeds captured SMTP
  messages, so the tests explicitly select **SMTP capture** before asserting rows.
- Email settings moved into **Settings → workspace under Email → SMTP capture,
  tags & trusted senders**. A semantic workspace-link identifier distinguishes
  it from identically named workspace links under Tasks and Calendar. Rotation
  coverage follows the current route back to the inbox and verifies source,
  destination, row, action and orientation retention.
- The compact composer identifier belongs to its containing view. Conversation
  tests tap the actual **Message agent** button. Orchestrators closes with **Done**;
  task creation and editing use the current **New task** and **Edit task** labels.
- The isolated conversation fixture has an injected environment transport but no
  cloud client. Its notification subscription raises `NSURLErrorDomain -1009`.
  The failed return-to-latest test's accessibility dump (PID 90969) contains this
  alert over the conversation. Test setup dismisses only the exact known alert
  title and error text; other alerts remain failures. The return-to-latest test
  scrolls within the conversation and retains its working/idle and diff assertions.

## Issue drag callback isolation

At **2026-09-18 23:12:18 UTC**, app PID **92632** crashed during board dragging.
The crash preceded cancellation at approximately 23:13:49 UTC. Its faulting queue
was `com.apple.Foundation.NSItemProvider-callback-queue`, with the stack:
`_dispatch_assert_queue_fail` → Swift executor isolation check →
`closure #1 in static PathwayIssueDragPayload.load(from:perform:)`.
The native unit-test process PID **76217** hit the same callback at 23:07:06 UTC.

The payload and its Codable conformance are now explicitly nonisolated. A
nonisolated factory creates the Foundation completion, decodes the value outside
the UI actor, and delivers the drop action through `Task { @MainActor in ... }`.
This follows the existing image-paste callback pattern. A background-provider
regression complements the existing provider round-trip and drag UI tests.

Focused Foundation harness checks on Swift 6.3.2 and the Xcode Mac's Swift 6.2.4
used Swift 6, complete strict concurrency and `-default-isolation MainActor`:
the old source fails compilation for its isolated Decodable conformance; the
corrected source compiles and delivers an actual background-provider payload on
MainActor. Without the default-isolation flag, both versions pass the standalone
macOS harness; it is not a reproduction of the iPhone runtime crash. Swift syntax
checks and `git diff --check` pass. Full native validation remains pending.

## iPad follow-up

[Native Apple run 35406153951](https://github.com/SpiritDevs/pathway/actions/runs/35406153951)
at `ae845ea32` passed all 428 native unit tests, both layout/rotation tests and
all 11 issue UI tests on iPad, including the background-provider and drag checks.
All seven parity tests and four launch configurations also passed. The finalized
result reports 456 passed, two failed and zero skipped unique tests; the 33 UI
executions account for 31 passes and these two conversation failures:

- **Cancel** in the **Upload failed** dialog deliberately retains the attachment.
  The test now verifies that the attachment and draft survive cancellation,
  then explicitly chooses **Remove** before continuing its direct-paste checks.
- Completed assistant replies fold away, so the 12-entry history fixture leaves
  only six user rows plus the final reply. Its iPad conversation container is
  1066 points high. After Stop removes the activity footer, the return-to-latest
  control disappears; the captured accessibility log does not establish whether
  this is a near-bottom threshold crossing or a scroll jump. The long-history
  fixture now supplies 32 entries, and the idle expectation requires the control
  to exist and remain hittable with an empty value. The test never scrolls again
  after Stop, preserving coverage of working-to-idle position retention.

Both corrected conversation tests passed on iPhone at `7ee16bc9c` in
[the follow-up run](https://github.com/SpiritDevs/pathway/actions/runs/35408527166),
alongside all 428 unit executions and all nine Conversation UI tests. They do
not change production scrolling or attachment behavior. Full surface outcomes
are recorded by that workflow and the fleet verification record.
