# Attached pull request verification

These screenshots show the same isolated, signed-in web client and test thread at 1440 × 1000. The thread's stored branch is `main`, its worktree path is null, and it has the real GitHub PR #110 attached. That PR was already merged during verification.

- `before.png` uses the UI from main at `f48e8d4b0`. The attachment is a neutral badge, Version Control has no PR row, and the thread remains active.
- `after.png` uses this fix. Version Control shows `PR #110` as Merged, and the idle thread appears in Settled.

The browser pass verified that the new row opens PR #110's detail, detaching removes the row, and reattaching restores the merged state. The test thread kept its stored branch and checkout throughout. Open, pending, failed, and cancelled checks, stale-result rejection, lookup errors, shared refreshes, refresh cleanup, and settlement blockers have focused automated coverage. The review pass verified detach and replacement while the Settled shelf was collapsed and the thread was not selected: both brought the row back to Active. Attaching PR #113 on its matching branch produced a single PR control. A 50-row subscription test proves that only the selected attachment refreshes periodically; environments without pull request support receive no detail requests.

Native iOS now resolves attached PR identity independently of its checkout, reflects state/check results in the badge, and invalidates lifecycle status when the attachment changes. Focused simulator tests cover those paths and existing cloud lifecycle behavior. The branch has pre-existing compilation errors in `PathwayAgentThreadModel.swift` (actor isolation in deinit) and `PathwayProjectIconTests.swift` (optional project IDs). The focused simulator run passed with temporary local workarounds for those two files; neither workaround is included in this PR. A clean native build remains blocked by those existing errors.

The screenshots were captured from the actual application with Playwright in an isolated Chrome profile. The server used an isolated database with a project and thread created through the application APIs. GitHub state was read from the host, not mocked. No provider turn was launched.
