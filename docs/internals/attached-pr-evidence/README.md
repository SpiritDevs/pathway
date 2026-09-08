# Attached pull request verification

These screenshots show the same isolated, signed-in web client and test thread at 1440 × 1000. The thread's stored branch is `main`, its worktree path is null, and it has the real GitHub PR #110 attached. That PR was already merged during verification.

- `before.png` uses the UI from main at `f48e8d4b0`. The attachment is a neutral badge, Version Control has no PR row, and the thread remains active.
- `after.png` uses this fix. Version Control shows `PR #110` as Merged, and the idle thread appears in Settled.

The browser pass verified that the new row opens PR #110's detail, detaching removes the row, and reattaching restores the merged state. The test thread kept its stored branch and checkout throughout. Open, pending, failed, and cancelled checks, stale-result rejection, lookup errors, shared refreshes, refresh cleanup, and settlement blockers have focused automated coverage. Native iOS was not changed or exercised.

The screenshots were captured from the actual application with Playwright in an isolated Chrome profile. The server used an isolated database with a project and thread created through the application APIs. GitHub state was read from the host, not mocked. No provider turn was launched.
