# COR-96 review evidence — 14 September 2026

The original implementation is preserved in commit `84177271a1` on `orchestrator-worker-controls`, worktree `/Users/coreybaines/.pathway/worktrees/pathway/pathway-bfd62da1`. It was uncommitted when this review began and was committed during the review. This follow-up adds evidence and precise limitations without duplicating that implementation or merging other branches.

Runtime allowance was force-refreshed before substantive work: fresh account readings, 63% weekly usage, `canStart=true`, `shouldInterrupt=false`, no applicable guard. No extra allowance allocation or provider worker was launched.

## What the screenshots prove

All images render the production `WorkList` and `WorkerConversationControls` with production styles in Chromium. The surrounding page and backend are an explicit **component fixture**. Browser clicks and typing are real; subscription data, question escalation, acceptance, dispatch receipts and stop confirmation are simulated. These are not screenshots of a signed-in Cloud conversation or a live worker.

| Evidence                                            | Checked interaction/state                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Question and pending queue](01-question-queue.png) | Human escalation form and editable pending follow-ups                                   |
| [Steering](02-steering.png)                         | Select “Steer running turn”, enter instructions, submit `sendWork` with `mode: steer`   |
| [Editing](03-edit-queue.png)                        | Edit existing text; save carries original revision                                      |
| [Reordering](04-reordered.png)                      | Move second message up; action includes the complete pending ID set                     |
| [Removal](05-removed.png)                           | Remove edited item with incremented revision; row disappears                            |
| [Human answer queued](06-answer-queued.png)         | Answer retains question ID and field ID; form becomes disabled and says “Answer queued” |
| [Stop requested](07-stop-requested.png)             | Click requests stop; worker still says “Working”, with confirmation pending             |
| [Confirmed terminal state](08-stop-confirmed.png)   | Explicit fixture terminal update changes status to “Cancelled” and removes stop control |
| [Narrow layout](09-narrow.png)                      | 390 CSS pixel browser viewport; document width remains 390, no horizontal overflow      |
| [Accepted message](10-accepted.png)                 | Explicit acceptance freezes edit/remove controls for that message                       |
| [Durable dispatch](11-dispatched.png)               | Explicit dispatch update does not claim provider processing/completion                  |

The stop confirmation and delivery transitions were injected deliberately, not inferred from a click. Root stop does not prove every provider-native descendant stopped. Browser action payloads are retained in [browser-actions.json](browser-actions.json); assertion results in [browser-result.txt](browser-result.txt).

UI defect fixed during review: the human-answer field was a disabled single-line input after submission, clipping longer replies especially at narrow widths. It is now a wrapping, resizable multiline field. The complete browser pass and screenshots were regenerated after the fix. Native already uses a multiline `TextField` for this input; no parallel native edit was required.

The collaborative Preview tool failed to initialize, so issue attachment capture was unavailable. Images are committed locally and can be opened from this directory; no inaccessible temporary browser artifact is required. No push was performed.

## Reproduce

From the implementation worktree, start the isolated fixture:

```sh
node_modules/.bin/vp dev --config apps/web/evidence/cor96/vite.config.ts
```

Then run `python3 docs/internals/evidence/COR-96/capture.py` with `agent-browser` on PATH, or set `AGENT_BROWSER` to its executable. It uses its own `cor96-review` browser session and writes these images and action assertions. The fixture is under `apps/web/evidence/cor96`, outside production routing and TypeScript source inclusion. It does not authenticate, launch workers, touch the live database, or contact Cloud. Its simplified in-memory backend does not implement production authorization, durable receipts or race fencing; the tests below cover those separately.

## Validation and limits

Fresh checks in this continuation:

- `vp test run packages/backend/src/aiOrchestrators.test.ts apps/server/src/cloud/orchestratorControls.test.ts`: **77 passed**. Includes queue revision fences, authorization/audience boundaries, duplicate identities, answer priority, receipt recovery and stop state behavior.
- `vp test run apps/server/src/orchestration-v2/testkit/AsyncQuestions.integration.test.ts -t 'starts a same-conversation follow-up for an answer after completion'`: **2 passed**, 6 intentionally filtered out. Includes agent-authored answer provenance when resuming an idle conversation.
- Same replay file with `-t 'steers a native subagent question'`: **1 passed**, 7 intentionally filtered out. Recorded Codex protocol proves original child targeting in the replay, not a new live provider run.
- Browser assertion script covers steering, edits, removal, reordering, human answer payload, requested/terminal stop rendering, accepted-message freezing and narrow layout.
- Web package TypeScript check passed after the multiline-field fix. Targeted lint passed for the control component and new runtime/backend control files; `git diff --check` passed. Browser error output was empty on the final capture pass. No repo-wide check was run.

The earlier implementation handoff separately recorded 92 passing tests, backend/server/web typechecks, targeted lint and Swift syntax parsing. Those historical results are not counted as newly rerun checks here.

Signed-in Cloud/Electron verification remains unavailable: the documented development login file is absent and the isolated app's Cloud configuration was unavailable in the handoff. This review did not invent a signed-out product mode. Live provider execution, remote/relay/tunnel behavior, multi-device delivery races and native UI remain unverified.

## Earlier bounded native investigation

Using XcodeBuildMCP after checking session defaults, target `Pathway`, Debug, iPhone 17 Pro simulator `933A9E3C-BB72-4B51-848A-7DC94445C351`, retained `.pathway/ios-derived`:

- First `build_run_sim`: failed in **25.8 seconds**, replacing the earlier unexplained 300-second timeout with a concrete compiler diagnostic.
- One minimal explicit-capture experiment: failed with the same diagnostic in **19.0 seconds**. The experiment was reverted; no speculative Swift change remains.
- Toolchain: Apple Swift **6.4**, `swiftlang-6.4.0.33.1`, arm64.
- `PathwayOrchestratorsModel.swift:182:15`: **“pattern that the region-based isolation checker does not understand how to check. Please file a bug”**, at `group.addTask { @MainActor [weak self] in` in `observeConversation`.

That task-group closure is already present at base `a26f42e0ed`; COR-96 adds methods elsewhere in the file. A base-only build was not run, so the failing source predates the change but a complete baseline build failure is not claimed. The original timeout's cause is not proven. No simulator app launched. Native build and runtime verification remain blocked; further compiler-workaround work is outside this bounded attempt. The diagnostic excerpt is retained in [native-build.txt](native-build.txt).

## Surface and dependency review

- Entry points: worker cards in conversation details/shared work; full-page/floating conversation uses shared web code. No independent worker controls exist in Settings, command palette or keybindings to update. Browser evidence targets the shared components, not the entire app shell.
- Clients: web/desktop share controls; SwiftUI has separate implementation; the follow-up below resolves native compilation, while integrated controls remain unverified. No separate Android orchestrator surface was found or verified.
- Contracts: original commit includes mailbox/action schemas and server/Cloud consumers. Nothing was deployed.
- Reverse states: edits have cancel; pending items can be removed/reordered; acceptance freezes mutation; stop request stays distinct from terminal cancellation; a new follow-up can resume an existing worker thread.
- Provider limits and COR-94/COR-95 integration points are detailed in [worker conversation internals](../../orchestrator-worker-conversations.md). No independent native child send/stop endpoint exists in COR-96, even when an adapter exposes child IDs or close capability.
- Documentation: original user-facing semantics remain in `docs/user/orchestrator-worker-conversations.md`; this evidence and integration detail are contributor-facing.

No merge, deployment, PR or push was performed by this continuation. Review performed with GPT-6 Astra through the Codex harness.

## Native compiler follow-up — 14 September 2026

Continued in the same worktree and branch, preserving `84177271a1` and `47a76d824f`. The earlier failure above is historical; this continuation resolves it. No web implementation, COR-94 attachments, or COR-95 selection code was changed.

The failing task-group closure combined explicit `@MainActor` isolation with the full stream-consumption body. Extracted that body into a private method on the existing `@MainActor` model, with child tasks awaiting it, matching `PathwayFocusModel`'s existing observer pattern. The three concurrent streams, weak task capture, structured cancellation, generation checks, pagination, mark-read mutation and per-stream error handling are retained. No unchecked Sendable conformance, detached task, polling or relaxed compiler setting was introduced.

XcodeBuildMCP `build_run_sim` **succeeded** with the retained derived data, Debug `Pathway`, iPhone 17 Pro / iOS 27.0, UDID `933A9E3C-BB72-4B51-848A-7DC94445C351`, Apple Swift 6.4. Tool-reported duration was **227.5 seconds**, including simulator startup/install/launch. The app launched as `com.spiritdevs.pathway`. No clean build, device/archive build, or base-only build is claimed.

[Native launch screenshot](12-native-launch.jpg) proves launch to the production configuration gate, **not worker-control interaction**. The screen reports missing `PATHWAY_CLERK_PUBLISHABLE_KEY`, `PATHWAY_CLERK_JWT_TEMPLATE`, and `PATHWAY_CONVEX_URL`. The documented development login file is also absent. Next step: supply the development Cloud identifiers and dedicated test credentials, run `node scripts/configure-pathway-ios.ts` (whose configuration check also requires `PATHWAY_RELAY_URL`), rebuild, then verify an authenticated worker conversation against updated Cloud and executing-environment code. Do not use production test authentication or bypass the Cloud requirement.

Accessibility `snapshot_ui` separately failed because its helper expects `/Applications/Xcode-beta.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework`, which does not exist in this Xcode installation. Screenshot capture worked. Semantic UI verification needs a compatible XcodeBuildMCP/AXe and Xcode pairing; no coordinate-based workaround or tooling install was attempted.

Provider-native limitations remain unchanged: no independent native-child mailbox send/stop endpoint; resumable child answers require the original exposed Pathway request, matching assignment origin and project, and exclude approvals. Durable dispatch is not provider completion, and a root stop does not prove every opaque provider child stopped. COR-94/COR-95 combined-feature integration, live providers, Cloud/Electron controls, remote/relay/tunnel and multi-device races remain unverified. See the existing provider matrix and integration handoff in [worker conversation internals](../../orchestrator-worker-conversations.md).

Focused native validation: `test_sim` selected only `PathwayTests/PathwayOrchestratorsObservationTests`, with parallel testing disabled, one simulator destination, and test timeouts enabled (30-second default / 60-second maximum). **2 test methods passed, 0 failed, 0 skipped**, including both parameterized cancellation/account-reset cases; tool duration **154.6 seconds**. Tests verify all three stream projections, message pagination/read acknowledgment, parent cancellation terminating child streams, and stale-generation values not restoring cleared state or issuing read mutations. This is an injected-stream model test, not live Cloud integration. `git diff --check` passed. No backend/web checks were repeated for this native-only extraction.

The successful build/test excerpts and reproducible tool arguments are retained in [native follow-up validation](native-followup.txt). Earlier tests and browser results above remain historical. COR-96 remains in progress for integrated verification. No push, PR, merge or deployment was performed. Follow-up by GPT-6 Astra through Codex.
