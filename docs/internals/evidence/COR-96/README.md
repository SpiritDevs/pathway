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

## Bounded native investigation

Using XcodeBuildMCP after checking session defaults, target `Pathway`, Debug, iPhone 17 Pro simulator `933A9E3C-BB72-4B51-848A-7DC94445C351`, retained `.pathway/ios-derived`:

- First `build_run_sim`: failed in **25.8 seconds**, replacing the earlier unexplained 300-second timeout with a concrete compiler diagnostic.
- One minimal explicit-capture experiment: failed with the same diagnostic in **19.0 seconds**. The experiment was reverted; no speculative Swift change remains.
- Toolchain: Apple Swift **6.4**, `swiftlang-6.4.0.33.1`, arm64.
- `PathwayOrchestratorsModel.swift:182:15`: **“pattern that the region-based isolation checker does not understand how to check. Please file a bug”**, at `group.addTask { @MainActor [weak self] in` in `observeConversation`.

That task-group closure is already present at base `a26f42e0ed`; COR-96 adds methods elsewhere in the file. A base-only build was not run, so the failing source predates the change but a complete baseline build failure is not claimed. The original timeout's cause is not proven. No simulator app launched. Native build and runtime verification remain blocked; further compiler-workaround work is outside this bounded attempt. The diagnostic excerpt is retained in [native-build.txt](native-build.txt).

## Surface and dependency review

- Entry points: worker cards in conversation details/shared work; full-page/floating conversation uses shared web code. No independent worker controls exist in Settings, command palette or keybindings to update. Browser evidence targets the shared components, not the entire app shell.
- Clients: web/desktop share controls; SwiftUI has separate implementation but failed native compilation. No separate Android orchestrator surface was found or verified.
- Contracts: original commit includes mailbox/action schemas and server/Cloud consumers. Nothing was deployed.
- Reverse states: edits have cancel; pending items can be removed/reordered; acceptance freezes mutation; stop request stays distinct from terminal cancellation; a new follow-up can resume an existing worker thread.
- Provider limits and COR-94/COR-95 integration points are detailed in [worker conversation internals](../../orchestrator-worker-conversations.md). No independent native child send/stop endpoint exists in COR-96, even when an adapter exposes child IDs or close capability.
- Documentation: original user-facing semantics remain in `docs/user/orchestrator-worker-conversations.md`; this evidence and integration detail are contributor-facing.

No merge, deployment, PR or push was performed by this continuation. Review performed with GPT-6 Astra through the Codex harness.
